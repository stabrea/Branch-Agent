import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Watching a folder and doing something whenever it changes. `branch watch <folder> <procedure>`
 * runs a saved procedure every time a file under that folder is written, waiting a moment first so
 * a save that touches ten files is one run and not ten. Nothing is watched until the person asks,
 * and stopping it (Ctrl+C, or the returned stop function) closes the watcher and waits for whatever
 * is running to finish, so nothing is left behind.
 */
export const WatchOptionsSchema = z.object({
  /** How long to wait after the last change before running, so a burst of saves is one run. */
  settleMs: z.number().int().min(10).max(60000).default(400),
  /** Names matching any of these are ignored: build output and the like. */
  ignore: z.array(z.string().min(1).max(80)).max(40).default(["node_modules", ".git", "dist", ".branch"]),
}).strict();
export type WatchOptions = z.infer<typeof WatchOptionsSchema>;

export interface WatchHandle {
  /** Closes the watcher and waits for a run already under way. */
  stop(): Promise<void>;
  /** How many times the action has been run. */
  readonly runs: number;
}

/** Whether a changed path is one of the things that never needs to set anything off. */
export function ignored(path: string, ignore: readonly string[]): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => ignore.includes(part)) || parts.some((part) => part.endsWith("~") || part.endsWith(".tmp"));
}

/**
 * Starts watching. `action` is whatever should happen on a change; it is never run twice at once —
 * a change arriving mid-run sets one more run going afterwards, and no more than one.
 */
export function watchFolder(
  folder: string,
  action: (reason: string) => Promise<void>,
  input: unknown = {},
  onError: (error: unknown) => void = () => undefined,
): WatchHandle {
  const options = WatchOptionsSchema.parse(input);
  const root = resolve(folder);
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let runs = 0;
  let watcher: FSWatcher | null = null;

  const fire = (reason: string): void => {
    if (stopped) return;
    if (running) { again = true; return; }
    runs += 1;
    running = action(reason)
      .catch(onError)
      .finally(() => {
        running = null;
        if (again && !stopped) { again = false; fire("more changes while it was working"); }
      });
  };
  const changed = (name: string): void => {
    if (stopped || ignored(name, options.ignore)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fire(`${name} changed`); }, options.settleMs);
    timer.unref?.();
  };
  watcher = watch(root, { recursive: true }, (_kind, name) => changed(String(name ?? "")));
  watcher.on("error", onError);

  return {
    get runs() { return runs; },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      watcher?.close();
      watcher = null;
      await running?.catch(() => undefined);
    },
  };
}
