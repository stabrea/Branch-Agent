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
 * The ways worth trying for this target, in the order they are tried. A number is the one way whose
 * answer comes off an attribute the page itself could write, so it is the one way that insists on a
 * single match: two things wearing the same number means the page is trying to steer the press, and
 * the number is treated as not found rather than settled by taking whichever comes first.
 */
function ways(target: HealTarget): { way: HealingWay; find: (page: Page) => Locator; only?: true }[] {
  const plan: { way: HealingWay; find: (page: Page) => Locator; only?: true }[] = [];
  if (target.selector) plan.push({ way: 'selector', find: page => page.locator(target.selector!).first() });
  if (target.name) {
    plan.push({ way: 'role', find: page => page.getByRole('button', { name: target.name!, exact: false }).first() });
    plan.push({ way: 'text', find: page => page.getByText(target.name!, { exact: false }).first() });
  }
  if (target.mark !== undefined)
    plan.push({ way: 'mark', only: true, find: page => page.locator(`[${markAttribute}="${target.mark}"]`) });
  return plan.slice(0, maxHealingAttempts);
}

/**
 * Finds the thing an action is about, trying each way in turn until one is really there. The
 * result says which way worked and how many were tried, so the trace can record it.
 */
export async function resolve(page: Page, target: HealTarget, timeoutMs = 2000): Promise<HealResult> {
  const plan = ways(target);
  if (!plan.length) throw new Error('Say which thing to act on: a selector, its name, or its number from the page description');
  const tried: HealingWay[] = [];
  for (const step of plan) {
    tried.push(step.way);
    const locator = step.find(page);
    const count = await locator.count().catch(() => 0);
    if (step.only ? count !== 1 : count === 0) continue;
    const ready = await locator.waitFor({ state: 'attached', timeout: timeoutMs }).then(() => true).catch(() => false);
    if (ready) return { locator, way: step.way, attempts: tried.length, tried };
  }
  throw new Error(`Nothing on this page matched, after ${tried.length} ${tried.length === 1 ? 'try' : 'tries'} `
    + `(${tried.join(', ')}). Describe the page again and use the number of the thing you mean.`);
}
