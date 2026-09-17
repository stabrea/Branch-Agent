import type { Locator, Page } from 'playwright';
import { markAttribute } from './browser-marks.js';

/**
 * Websites are rewritten all the time, and a selector that worked last week often points at
 * nothing today. Rather than give up, an action is tried again a few different ways: by the exact
 * selector it was given, then by what the thing is called, then by the words showing on it, and
 * last by the number it was given when the page was described. Which way worked is written into
 * the task's trace, so a step that keeps healing can be fixed properly later.
 *
 * It never looks anywhere but the page it was already on, and it never tries more than a handful
 * of times; a thing that is genuinely gone is reported as gone.
 */
export const healingWays = ['selector', 'role', 'text', 'mark'] as const;
export type HealingWay = (typeof healingWays)[number];
/** Most ways one action may be tried before it is reported as a failure. */
export const maxHealingAttempts = 4;

export interface HealTarget {
  /** The selector the assistant asked for, when it gave one. */
  selector?: string | undefined;
  /** What the thing is called: the words on the button, the label of the box. */
  name?: string | undefined;
  /** The number the thing was given when the page was last described. */
  mark?: number | undefined;
}
export interface HealResult { locator: Locator; way: HealingWay; attempts: number; tried: HealingWay[] }
/**
 * What is known about the numbers this task handed out, so a number can be checked rather than
 * trusted. `keyOf` is the stable name the number was given to; `liveKey` is the stable name of
 * whatever wears it on the page right now. Left out, a number is only checked for being there.
 */
export interface MarkChecks {
  keyOf?: ((mark: number) => string | undefined) | undefined;
  liveKey?: ((mark: number) => Promise<string | null>) | undefined;
}
/** Why a number could not be used, in the owner's words. Empty when the number was fine. */
export async function markProblem(mark: number, count: number, checks: MarkChecks): Promise<string> {
  const handed = checks.keyOf?.(mark);
  if (checks.keyOf && handed === undefined)
    return `Number ${mark} was never given out on this page.`;
  if (count === 0) return `Number ${mark} is no longer on this page.`;
  if (count > 1) return `Number ${mark} is on more than one thing, so it was not used.`;
  const live = await checks.liveKey?.(mark);
  if (handed !== undefined && live !== undefined && live !== handed)
    return `Number ${mark} is now on a different thing from the one it was given to, so it was not used.`;
  return '';
}

/**
 * The ways worth trying for this target, in the order they are tried. A number is the one way whose
 * answer comes off an attribute the page itself could write, so it is the one way that is checked
 * rather than trusted: it must be worn by exactly one thing, and by the same thing it was handed
 * to. A page that moves a number onto something else, or puts it on two things at once, is trying
 * to steer the press, and the number is refused instead.
 */
function ways(target: HealTarget): { way: HealingWay; find: (page: Page) => Locator }[] {
  const plan: { way: HealingWay; find: (page: Page) => Locator }[] = [];
  if (target.selector) plan.push({ way: 'selector', find: page => page.locator(target.selector!).first() });
  if (target.name) {
    plan.push({ way: 'role', find: page => page.getByRole('button', { name: target.name!, exact: false }).first() });
    plan.push({ way: 'text', find: page => page.getByText(target.name!, { exact: false }).first() });
  }
  if (target.mark !== undefined)
    plan.push({ way: 'mark', find: page => page.locator(`[${markAttribute}="${target.mark}"]`) });
  return plan.slice(0, maxHealingAttempts);
}

/**
 * Finds the thing an action is about, trying each way in turn until one is really there. The
 * result says which way worked and how many were tried, so the trace can record it.
 */
export async function resolve(page: Page, target: HealTarget, timeoutMs = 2000,
  checks: MarkChecks = {}): Promise<HealResult> {
  const plan = ways(target);
  if (!plan.length) throw new Error('Say which thing to act on: a selector, its name, or its number from the page description');
  const tried: HealingWay[] = [];
  let note = '';
  for (const step of plan) {
    tried.push(step.way);
    const locator = step.find(page);
    const count = await locator.count().catch(() => 0);
    if (step.way === 'mark') {
      note = await markProblem(target.mark!, count, checks);
      if (note) continue;
    } else if (count === 0) continue;
    const ready = await locator.waitFor({ state: 'attached', timeout: timeoutMs }).then(() => true).catch(() => false);
    if (ready) return { locator, way: step.way, attempts: tried.length, tried };
  }
  throw new Error(`Nothing on this page matched, after ${tried.length} ${tried.length === 1 ? 'try' : 'tries'} `
    + `(${tried.join(', ')}). ${note ? `${note} ` : ''}`
    + 'Describe the page again and use the number of the thing you mean.');
}
