import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { z } from 'zod';
import { FeatureModeSchema } from '../feature-switches.js';
import type { Store } from '../store.js';
import { TakeOverBanner } from './linux-desktop-banner.js';

/**
 * FQ-execution.desktop: a Linux desktop the assistant and the owner can share.
 *
 * Screen control (`desktop.ts`) reaches this computer's own screen. This is a different desktop
 * entirely: a throwaway Linux one, drawn by Xvfb inside a container and served over VNC, so the
 * assistant never touches anything of the owner's own. The owner may still watch or take it over —
 * point any VNC viewer at the address this hands back, or press "Take over" on the notice
 * (`linux-desktop-banner.ts`) — and while they hold it, every assistant action here is refused
 * until they hand it back. Nothing is ever pulled: the container image must already be on this
 * computer, exactly as the browser sandbox works (`browser-container.ts`).
 */
export const settingsKey = 'linux-desktop';
export const LinuxDesktopSchema = z.object({
  /** The three-way switch. Off: `desktop.shared.*` refuse in one sentence. */
  mode: FeatureModeSchema.default('off'),
  /** The container image a shared desktop starts from. Nothing is ever pulled. */
  image: z.string().trim().min(1).max(200).default('branch-linux-desktop:latest'),
}).strict();
export type LinuxDesktopSettings = z.infer<typeof LinuxDesktopSchema>;
export const LinuxDesktopInputSchema = LinuxDesktopSchema.partial();

export function readLinuxDesktop(store: Pick<Store, 'get'>, owner: string): LinuxDesktopSettings {
  const saved = LinuxDesktopSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : LinuxDesktopSchema.parse({});
}
export function saveLinuxDesktop(store: Store, owner: string, input: unknown): LinuxDesktopSettings {
  const next = LinuxDesktopSchema.parse({ ...readLinuxDesktop(store, owner), ...LinuxDesktopInputSchema.parse(input ?? {}) });
  store.save('settings', owner, settingsKey, next);
  return next;
}

export const switchedOffMessage =
  'Branch is not allowed to start a shared Linux desktop. Turn on "Shared Linux desktop" in Settings first.';
export const sandboxRefusal = (reason: string): string => `The shared Linux desktop cannot be used: ${reason}`;
export const takenOverMessage =
  'You have taken over the shared desktop, so Branch has let go of it. Press "Hand back" on the notice, or call desktop.shared.release, before asking Branch to act in it again.';
export const notRunningMessage = 'No shared Linux desktop is running. Start one with desktop.shared.start first.';

// ---------------------------------------------------------------- the commands themselves

/** The virtual display every shared desktop draws to, and the port its VNC server listens on. */
export const display = ':1';
export const vncPort = 5900;

/** Xvfb's own argument list: a throwaway 1280x800 screen, listening on nothing but the display socket. */
export function xvfbArgv(): string[] {
  return [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'];
}
/** x11vnc's argument list: the same display, a fresh password each session, and no other listener. */
export function x11vncArgv(password: string): string[] {
  return ['-display', display, '-rfbport', String(vncPort), '-passwd', password, '-forever', '-shared', '-quiet'];
}
export type SharedDesktopAction =
  | { type: 'open'; app: string }
  | { type: 'type'; text: string }
  | { type: 'key'; chord: string };
/** xdotool's argument list for one action. Nothing here ever reaches a shell: it is one argv, run directly. */
export function xdotoolArgv(action: SharedDesktopAction): string[] {
  if (action.type === 'open') return ['spawn', action.app];
  if (action.type === 'type') return ['type', '--clearmodifiers', action.text];
  return ['key', '--clearmodifiers', action.chord];
}
/** The exact `docker run` line: nothing of this computer is shared in, and the VNC port stays local. */
export function dockerRunArgv(image: string, hostPort: number, password: string): string[] {
  const inner = `Xvfb ${xvfbArgv().join(' ')} & sleep 1 && x11vnc ${x11vncArgv(password).join(' ')}`;
  return ['run', '-d', '--rm', '--init', '--pull=never',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '1g', '--cpus', '1',
    '-p', `127.0.0.1:${hostPort}:${vncPort}`,
    image, 'sh', '-c', inner];
}
/** Runs one xdotool action inside the running container, against the desktop's own display. */
export function dockerExecArgv(containerId: string, action: SharedDesktopAction): string[] {
  return ['exec', '-e', `DISPLAY=${display}`, containerId, 'xdotool', ...xdotoolArgv(action)];
}
export function dockerStopArgv(containerId: string): string[] {
  return ['stop', containerId];
}
export function dockerImageInspectArgv(image: string): string[] {
  return ['image', 'inspect', image];
}

// ---------------------------------------------------------------- running it

/** Starts a program with an argument list (never a shell line), bounded by a time limit. */
export type ProgramRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;
export const runProgram: ProgramRunner = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});
/** True once something answers a TCP connection on the port (the VNC server has come up). */
export type Prober = (port: number) => Promise<boolean>;
export const probeTcp: Prober = (port) => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port, timeout: 1000 });
  const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
});
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface SharedDesktopInfo { host: string; port: number; display: string; password: string }
interface Session { id: string; host: string; port: number; password: string; control: 'agent' | 'user' }

/**
 * One shared Linux desktop per owner, started on first use. Whoever holds `control` is the only
 * one Branch will act for: the owner takes it with `takeOver` (the notice's button does the same),
 * and every `act` call is refused in the meantime, in words that say so plainly.
 */
export class LinuxDesktopSandbox {
  runner: ProgramRunner = runProgram;
  probe: Prober = probeTcp;
  port: () => Promise<number> = freePort;
  password: () => string = () => randomBytes(6).toString('hex');
  waitMs = 30_000;
  pauseMs = 300;
  private readonly sessions = new Map<string, Session>();
  private readonly banner: TakeOverBanner;
  constructor(private readonly store: Pick<Store, 'get' | 'save' | 'event'>, options: { banner?: TakeOverBanner } = {}) {
    this.banner = options.banner ?? new TakeOverBanner();
  }

  private settings(owner: string): LinuxDesktopSettings {
    return readLinuxDesktop(this.store, owner);
  }
  /** `store.event` keys its rows to a real run; a shared desktop outlives any one run, so writing
   * one down here is best-effort and never the reason a start, a take-over or a stop fails. */
  private log(id: string, kind: string, data: Record<string, unknown>): void {
    try { this.store.event(id, kind, data); } catch { /* no run to attach the record to; not fatal */ }
  }
  /** Whether the shared desktop is available at all right now, and why not when it is not. */
  async available(owner: string): Promise<{ ok: boolean; reason: string }> {
    const settings = this.settings(owner);
    if (settings.mode === 'off') return { ok: false, reason: switchedOffMessage };
    try { await this.runner('docker', dockerImageInspectArgv(settings.image), 15_000); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: sandboxRefusal('Docker is not installed on this computer.') };
      return { ok: false, reason: sandboxRefusal(`the image "${settings.image}" is not on this computer yet. Build or pull it yourself first.`) };
    }
    return { ok: true, reason: '' };
  }
  /** Starts a shared desktop for this owner, or hands back the one already running. */
  async start(owner: string): Promise<SharedDesktopInfo> {
    const existing = this.sessions.get(owner);
    if (existing) return { host: existing.host, port: existing.port, display, password: existing.password };
    const settings = this.settings(owner);
    if (settings.mode === 'off') throw new Error(switchedOffMessage);
    const check = await this.available(owner);
    if (!check.ok) throw new Error(check.reason);
    const port = await this.port();
    const password = this.password();
    let id = '';
    try { id = (await this.runner('docker', dockerRunArgv(settings.image, port, password), 30_000)).trim().split('\n').at(-1) ?? ''; }
    catch { throw new Error(sandboxRefusal('Docker could not start the container.')); }
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(sandboxRefusal('Docker did not say which container it started.'));
    for (const until = Date.now() + this.waitMs; Date.now() < until;) {
      if (await this.probe(port)) {
        this.sessions.set(owner, { id, host: '127.0.0.1', port, password, control: 'agent' });
        this.log(owner, 'shared-desktop.started', { port });
        // Best-effort: a computer with nowhere to show a window (a headless server) still shares
        // the desktop over VNC, it just has no local notice or "Take over" button of its own.
        await this.banner.show(() => this.takeOver(owner)).catch(() => undefined);
        return { host: '127.0.0.1', port, display, password };
      }
      await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
    }
    await this.runner('docker', dockerStopArgv(id), 15_000).catch(() => undefined);
    throw new Error(sandboxRefusal(`the desktop did not answer within ${Math.round(this.waitMs / 1000)} seconds.`));
  }
  /** Something done inside the shared desktop. Refused outright while the owner holds it. */
  async act(owner: string, action: SharedDesktopAction): Promise<{ ran: string }> {
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    if (session.control !== 'agent') throw new Error(takenOverMessage);
    await this.runner('docker', dockerExecArgv(session.id, action), 15_000);
    this.log(owner, 'shared-desktop.action', { type: action.type });
    return { ran: action.type };
  }
  /** The owner has pressed "Take over" (or called this directly): Branch lets go until it is handed back. */
  takeOver(owner: string): void {
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    session.control = 'user';
    this.log(owner, 'shared-desktop.taken-over', {});
  }
  /** The owner hands the desktop back. */
  release(owner: string): void {
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    session.control = 'agent';
    this.log(owner, 'shared-desktop.released', {});
  }
  /** Who holds it right now, for a caller that wants to ask rather than try and fail. */
  controlOf(owner: string): 'agent' | 'user' | 'none' {
    return this.sessions.get(owner)?.control ?? 'none';
  }
  async stop(owner: string): Promise<void> {
    const session = this.sessions.get(owner);
    if (!session) return;
    this.sessions.delete(owner);
    await this.runner('docker', dockerStopArgv(session.id), 15_000).catch(() => undefined);
    await this.banner.hide().catch(() => undefined);
    this.log(owner, 'shared-desktop.stopped', {});
  }
  /** Stops every shared desktop this launch started. */
  async close(): Promise<void> {
    const owners = [...this.sessions.keys()];
    for (const owner of owners) await this.stop(owner);
  }
}
