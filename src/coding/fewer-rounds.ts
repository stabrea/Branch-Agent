import type { Store } from "../store.js";
import type { PreloadedTool } from "../tool-loading.js";
import { codingMode } from "./settings.js";

/**
 * mac7/speed — doing more in one round.
 *
 * On a hosted model a task's clock is very nearly (how many times it goes back to the model) times
 * (how long a round trip takes): measured on this branch, 88–94% of a coding task's wall time is
 * waiting for the model, and packing the same tool calls into fewer rounds cut one task from 1,958
 * ms to 928 ms. So this part is about rounds, not about making anything in Branch run faster.
 *
 * Three things, all switched together by the `fewer-rounds` coding part, which ships off:
 *
 *   - the tools a coding task always reaches for are loaded from the first round, so it never
 *     spends a round trip searching for `files.edit` before it can start;
 *   - the assistant is told, in one line, that it may ask for several independent things at once;
 *   - `files.read_many` reads several files in one call (registered by the part's own switch, so
 *     "when needed" leaves it a line in the index and "on" loads it from the first round).
 *
 * Like `read-first`, the behaviour is the same in "when needed" and "on" — there is no useful
 * middle setting for how a loop behaves. What the two modes really choose is the tier its tool
 * travels in, which is the ordinary meaning of the switch.
 */

/**
 * What a coding task reaches for, in the order it usually does. Measured before this existed: over
 * five ordinary coding requests, 41 of 60 of these were a search away rather than described, and
 * one request ("Add a --verbose flag … and document it in the README") was shown **none** of them.
 */
export const codingWorkingSet = [
  "files.read", "files.grep", "files.list", "files.glob", "files.edit", "files.write",
] as const;

/** Why they were loaded, in the words the run inspector shows beside a pre-loaded tool. */
const reason = "a coding task nearly always needs this, so it is here from the first round";

/** Whether the part is switched on at all. Both non-off modes switch the behaviour on. */
export const fewerRoundsOn = (store: Pick<Store, "get">, owner: string): boolean =>
  codingMode(store, owner, "fewer-rounds") !== "off";

/**
 * The coding tools to load before the first round, when this is coding work. "Coding work" is the
 * toolboxes the request already opened: if neither the files nor the code box is open, the request
 * was about something else and nothing is added. Only tools the task is actually allowed and that
 * are really registered are named, so a narrowed task cannot be handed one it may not use.
 */
export function codingPreload(
  store: Pick<Store, "get">, owner: string,
  open: readonly string[], available: readonly string[],
): PreloadedTool[] {
  if (!fewerRoundsOn(store, owner)) return [];
  if (!open.includes("code") && !open.includes("files")) return [];
  const here = new Set(available);
  return codingWorkingSet.filter((name) => here.has(name)).map((name) => ({ name, reason }));
}

/**
 * The one line the assistant is told. Deliberately short: the measurement that justifies it is
 * about round trips, and a paragraph here costs tokens on every single round.
 */
export const batchingNote =
  " When several things you need are independent of each other — reading four files, searching for "
  + "two different words — ask for them all in one go rather than one at a time. Each exchange with "
  + "you costs real time, so fewer, fuller turns finish the work sooner.";

/** That line, when the part is on; nothing at all when it is off. */
export const batchingInstructions = (store: Pick<Store, "get">, owner: string): string =>
  fewerRoundsOn(store, owner) ? batchingNote : "";

/** The most calls that may run at the same time, so one reply cannot open fifty things at once. */
export const parallelLimit = 8;

export interface CallLike { id: string; name: string; arguments: string }
export interface GroupingRules {
  /** Whether this tool only looks at things — `isReadOnlyPermission` of its permission. */
  readOnly(name: string): boolean;
  /** What the call would touch, in the form the rules match against. Two calls in one group never share one. */
  targetOf(call: CallLike): string;
  /** Tools that must run alone because they change what the next round is shown. */
  alone: readonly string[];
}

/**
 * Splits a reply's tool calls into runs that may go at the same time.
 *
 * A call may share a run only when it **only looks at things** (so nothing it does can depend on,
 * or be undone by, what another call in the run does), it is not one of the tools that change what
 * the next round is shown, and nothing else in the run is about the same thing. Everything else is
 * a run of its own, left exactly where it was, so a read and a later change never swap places and
 * the conversation reads as it always did.
 *
 * Distinct targets matter for more than tidiness: a "just this once" yes is remembered by tool and
 * target, so two calls about the same thing could race for one pass. They cannot be in one run.
 *
 * Nothing here decides whether a call is allowed. Every call still goes through its own journal
 * entry, its own loop guard, its own permission check, approval, wall and deadline, exactly as it
 * does one at a time; the only thing shared is the clock.
 */
export function parallelGroups<T extends CallLike>(calls: readonly T[], rules: GroupingRules): T[][] {
  const groups: T[][] = [];
  let open: T[] = [];
  const targets = new Set<string>();
  const flush = (): void => { if (open.length) groups.push(open); open = []; targets.clear(); };
  for (const call of calls) {
    const target = rules.targetOf(call);
    const shareable = rules.readOnly(call.name) && !rules.alone.includes(call.name)
      && !targets.has(target) && open.length < parallelLimit;
    if (!shareable) flush();
    if (!rules.readOnly(call.name) || rules.alone.includes(call.name)) { groups.push([call]); continue; }
    open.push(call);
    targets.add(target);
  }
  flush();
  return groups;
}
