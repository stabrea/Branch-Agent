import { z } from 'zod';
import type { Store } from '../store.js';

/**
 * Settings, input shapes and refusals for letting the assistant use the screen and keyboard of
 * this computer. Nothing here touches the screen: this file only says what may be asked for.
 *
 * The switch is off until the owner turns it on, and it is read again before every single action,
 * so turning it off stops work that is already under way.
 */
export const DesktopSettingsSchema = z.object({
  /** "Allow the assistant to use my screen and keyboard". Off until the owner turns it on. */
  enabled: z.boolean().default(false),
  /** Most screen actions one task may take before it has to stop and be asked again. */
  maxActionsPerRun: z.number().int().min(1).max(200).default(40),
}).strict();
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export const DesktopSettingsInputSchema = DesktopSettingsSchema.partial();
const settingsKey = 'desktop-control';

export function readDesktopSettings(store: Store, owner: string): DesktopSettings {
  const saved = DesktopSettingsSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : DesktopSettingsSchema.parse({});
}
export function saveDesktopSettings(store: Store, owner: string, input: unknown): DesktopSettings {
  const value = DesktopSettingsInputSchema.parse(input ?? {});
  const next = DesktopSettingsSchema.parse({ ...readDesktopSettings(store, owner), ...value });
  store.save('settings', owner, settingsKey, next);
  return next;
}

/** What the person is told when the switch is off. One plain sentence, no jargon. */
export const switchedOffMessage =
  'Branch is not allowed to use your screen and keyboard. Turn on "Allow the assistant to use my screen and keyboard" in Settings first.';
/** What the person is told when a task has already taken its allowance of screen actions. */
export const cappedMessage = (cap: number): string =>
  `This task has already used the screen ${cap} times, which is as many as it may. Start it again if you want it to carry on.`;

/**
 * Windows that are never photographed and never typed into: password managers, the Windows sign-in
 * and permission prompts, and anything that asks for a password. Matched against the title the
 * computer reports and the name of the program, never against what was asked for, so asking for
 * "Bit*" cannot slip past it.
 */
const refusedTitles = [
  /bitwarden/i, /1password/i, /keepass/i, /lastpass/i, /dashlane/i, /nordpass/i, /roboform/i,
  /enpass/i, /proton pass/i, /keeper password/i, /\bvault\b/i,
  /windows security/i, /windows hello/i, /credential/i, /\bsign in\b/i, /\bpassword\b/i,
  /\bpasskey\b/i, /authenticator/i, /\bunlock\b/i, /lock screen/i,
];
const refusedPrograms = [
  /^logonui$/i, /^consent$/i, /^credentialuibroker$/i, /^lockapp$/i, /^bitwarden/i,
  /^1password/i, /^keepass/i, /^dashlane/i, /^nordpass/i, /^authenticator/i,
];
export interface WindowInfo {
  handle: string;
  title: string;
  className: string;
  program: string;
  processId: number;
  minimised: boolean;
  width: number;
  height: number;
}
/** Why this window is out of bounds, or null when it may be used. */
export function refusalFor(window: Pick<WindowInfo, 'title' | 'program'>): string | null {
  if (refusedTitles.some((pattern) => pattern.test(window.title)))
    return `That window is called "${window.title}", which looks like a password or sign-in window, so Branch will not touch it.`;
  if (refusedPrograms.some((pattern) => pattern.test(window.program)))
    return `That window belongs to ${window.program}, which handles passwords, so Branch will not touch it.`;
  return null;
}

const windowMatch = z.string().trim().min(1).max(200);
export const DesktopScreenshotSchema = z.object({
  /** Part of the title of the window to photograph. Leave it out to photograph the whole screen. */
  window: windowMatch.optional(),
  /** Which screen to photograph when no window is named: 1 is the main one. */
  display: z.number().int().min(1).max(8).optional(),
}).strict();
export const DesktopWindowsSchema = z.object({
  action: z.enum(['list', 'focus', 'minimize', 'close']).default('list'),
  /** Part of the title of the window to act on; needed for everything but "list". */
  window: windowMatch.optional(),
}).strict();
export const DesktopReadSchema = z.object({
  window: windowMatch,
  /** Most parts of the window to describe; the rest are left out and the count says so. */
  limit: z.number().int().min(10).max(400).default(150),
}).strict();
export const DesktopClickSchema = z.object({
  window: windowMatch,
  /** The name of the button, box or link, exactly as `desktop.read` shows it. */
  name: z.string().trim().min(1).max(200).optional(),
  /** A place inside the window, in pixels from its top-left corner. Only when nothing is named. */
  point: z.object({ x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000) }).strict().optional(),
}).strict().refine((value) => Boolean(value.name) !== Boolean(value.point), 'Give either a name or a point, not both');
export const DesktopTypeSchema = z.object({
  window: windowMatch,
  /** The name of the box to type into; without it the window's first writable box is used. */
  name: z.string().trim().min(1).max(200).optional(),
  text: z.string().min(1).max(4000),
}).strict();
export const DesktopKeySchema = z.object({
  window: windowMatch,
  /** One key press such as "enter", "ctrl+s" or "alt+f4". */
  chord: z.string().trim().min(1).max(60),
}).strict();
export const DesktopOpenSchema = z.object({
  /** A program to start, such as "notepad". Give this or a file, not both. */
  app: z.string().trim().min(1).max(100).regex(/^[a-z0-9 ._-]+$/i, 'Use the plain name of a program').optional(),
  /** A file in your workspace to open with whatever program usually opens it. */
  path: z.string().trim().min(1).max(500).optional(),
}).strict().refine((value) => Boolean(value.app) !== Boolean(value.path), 'Give either a program or a file, not both');
export const DesktopClipboardSchema = z.object({
  action: z.enum(['read', 'write']),
  text: z.string().max(4000).optional(),
}).strict().refine((value) => (value.action === 'write') === (value.text !== undefined), 'Writing needs text; reading takes none');

/**
 * Files that are programs rather than documents. "Open this with whatever usually opens it" is
 * meant for a document, and the switch the owner ticked says "use my screen and keyboard", not
 * "run programs out of my workspace" — so these are turned down and pointed at the host-command
 * tool, which has a switch of its own.
 */
const runnableEndings = ['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.msi', '.scr', '.lnk', '.vbs', '.js', '.jse', '.wsf', '.hta', '.reg'];
export function runnableFile(path: string): string | null {
  const ending = runnableEndings.find((suffix) => path.toLowerCase().endsWith(suffix));
  return ending
    ? `A ${ending} file is a program, not a document, so Branch will not open it this way. Use the host-command tool if running something is really what is wanted.`
    : null;
}

/** Text that looks like it is standing in for a saved password, which is never typed. */
export function secretReferenceIn(text: string): string | null {
  if (/\{\{/.test(text)) return 'That text still has a {{placeholder}} in it, so Branch will not type it.';
  if (/\$env:[A-Z_]/i.test(text) || /%[A-Z][A-Z0-9_]{2,}%/.test(text))
    return 'That text points at a saved password or setting. Branch never types saved passwords for you.';
  return null;
}

const namedKeys: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  space: ' ', insert: '{INSERT}',
};
const modifiers: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+' };
/**
 * Turns "ctrl+s" into the form Windows expects. Only plain letters, digits, function keys and the
 * named keys above are allowed, so nothing else can be smuggled in as a key press.
 */
export function keyChord(chord: string): string {
  const parts = chord.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  const last = parts.pop();
  if (!last || parts.length > 3) throw new Error(`"${chord}" is not a key Branch knows how to press`);
  let prefix = '';
  for (const part of parts) {
    const symbol = modifiers[part];
    if (!symbol) throw new Error(`"${part}" is not a key Branch knows how to hold down`);
    prefix += symbol;
  }
  if (namedKeys[last]) return prefix + namedKeys[last];
  if (/^f([1-9]|1[0-2])$/.test(last)) return `${prefix}{${last.toUpperCase()}}`;
  if (/^[a-z0-9]$/.test(last)) return prefix + last;
  throw new Error(`"${chord}" is not a key Branch knows how to press`);
}
