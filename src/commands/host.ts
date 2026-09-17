import { createRequire } from "node:module";
import type { Runtime } from "../runtime.js";
import type { createBranch } from "../index.js";
import { healthReport } from "../health.js";
import type { CommandHost, GoalHost } from "./handlers.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;
const version = String(createRequire(import.meta.url)("../../package.json").version);

/**
 * What the commands can reach, from whatever the surface has: the whole app (the server, and the
 * terminal when Branch is open) or only the runtime. Goal mode is used when this copy has it
 * (mac2/goal-undo adds `goals` to the app); until then `/goal` says so in one sentence.
 */
export function commandHost(runtime: Runtime, app?: unknown): CommandHost {
  const full = app as (Partial<Branch> & { goals?: GoalHost }) | undefined;
  const whole = full?.store && full.runtime && full.channels;
  return {
    runtime, version,
    // Settings and permissions belong to the owner's own profile, whichever surface asks.
    requireOwner: (what) => runtime.store.profiles.requireOwner(what),
    ...(whole ? { health: () => healthReport(full as Branch) } : {}),
    ...(full?.goals ? { goals: full.goals } : {}),
  };
}
