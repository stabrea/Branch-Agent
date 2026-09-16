import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../contracts.js';

/**
 * One way of saying "look at this and press that", whether the thing is a web page or a window on
 * this computer. The assistant says which it means, and the request is handed to the browser tools
 * or to the screen tools accordingly. Nothing here does any work of its own: every request goes
 * through the very same method the underlying tool uses, so the same permission is asked for, the
 * same limits are counted, and the same refusals apply. Both sets of tools stay exactly as they
 * are for anything this shorter way does not cover.
 */
export const computerTargets = ['page', 'window'] as const;
const targetField = z.enum(computerTargets);
const windowName = z.string().trim().min(1).max(200);

export const ComputerLookSchema = z.object({
  at: targetField,
  /** Part of the name of the window to look at. Only for a window. */
  window: windowName.optional(),
}).strict();
export const ComputerPressSchema = z.object({
  at: targetField,
  /** Part of the name of the window. Only for a window. */
  window: windowName.optional(),
  /** What the thing is called: the words on the button, or the name the window gives it. */
  name: z.string().trim().min(1).max(300),
}).strict();
export const ComputerTypeSchema = ComputerPressSchema.extend({
  text: z.string().min(1).max(4000),
}).strict();

/** What the facade needs from each layer. Either may be missing; the other still works. */
export interface ComputerLayers {
  page?: {
    annotate(input: { draw: boolean; limit: number }, context: ToolContext): Promise<unknown>;
    act(input: { action: 'click' | 'fill'; name?: string | undefined; value?: string | undefined },
      context: ToolContext): Promise<unknown>;
    hostFor(context: Pick<ToolContext, 'owner' | 'runId'>): string;
  } | undefined;
  window?: {
    read(input: { window: string; limit: number }, context: ToolContext): Promise<unknown>;
    click(input: { window: string; name: string }, context: ToolContext): Promise<unknown>;
    type(input: { window: string; name?: string; text: string }, context: ToolContext): Promise<unknown>;
  } | undefined;
}

const missing = (at: string): Error => new Error(at === 'page'
  ? 'The browser is not switched on in this launch, so there is no page to work with.'
  : 'Using this computer\'s screen is not available in this launch, so there is no window to work with.');
const needWindow = (window: string | undefined): string => {
  if (!window) throw new Error('Say which window, by part of its name.');
  return window;
};
/**
 * The shorter way must never be a way round a permission. A tool carries one permission, so the
 * one it carries is the browser's; reaching a window through it needs the screen permission as
 * well, checked here against the very same list the registry checks.
 */
function needScreen(context: ToolContext, permission: 'desktop.view' | 'desktop.control'): void {
  if (!context.permissions.has(permission))
    throw new Error(`Working the windows on this computer needs the "${permission}" permission, which this task does not have.`);
}

/** Looks at whichever the assistant meant: the open page, or a window on this computer. */
async function look(layers: ComputerLayers, input: z.infer<typeof ComputerLookSchema>, context: ToolContext) {
  if (input.at === 'page') {
    if (!layers.page) throw missing('page');
    return { at: 'page', ...(await layers.page.annotate({ draw: false, limit: 60 }, context) as object) };
  }
  needScreen(context, 'desktop.view');
  if (!layers.window) throw missing('window');
  return { at: 'window', ...(await layers.window.read({ window: needWindow(input.window), limit: 150 }, context) as object) };
}

async function press(layers: ComputerLayers, input: z.infer<typeof ComputerPressSchema>, context: ToolContext) {
  if (input.at === 'page') {
    if (!layers.page) throw missing('page');
    return { at: 'page', ...(await layers.page.act({ action: 'click', name: input.name }, context) as object) };
  }
  needScreen(context, 'desktop.control');
  if (!layers.window) throw missing('window');
  return { at: 'window', ...(await layers.window.click({ window: needWindow(input.window), name: input.name }, context) as object) };
}

async function write(layers: ComputerLayers, input: z.infer<typeof ComputerTypeSchema>, context: ToolContext) {
  if (input.at === 'page') {
    if (!layers.page) throw missing('page');
    return { at: 'page', ...(await layers.page.act({ action: 'fill', name: input.name, value: input.text }, context) as object) };
  }
  needScreen(context, 'desktop.control');
  if (!layers.window) throw missing('window');
  return { at: 'window', ...(await layers.window.type({ window: needWindow(input.window), name: input.name, text: input.text }, context) as object) };
}

/** Registers the three shared tools. Whatever is not configured says so plainly when it is asked for. */
export function registerComputer(registry: ToolRegistry, layers: ComputerLayers): void {
  const where = (input: { at: string; window?: string | undefined }, context: ToolContext): string =>
    input.at === 'page' ? (layers.page?.hostFor(context) ?? '') : (input.window ?? '');
  registry.register({
    name: 'computer.look', permission: 'browser.read',
    description: 'Describe what is in front of you and number the things you can act on: say "page" for the open web page, or "window" with part of a window\'s name for a program on this computer.',
    parameters: ComputerLookSchema, target: where,
    execute: (input, context) => look(layers, input, context),
  });
  registry.register({
    name: 'computer.press', permission: 'browser.interact',
    description: 'Press something by its name, on the open web page or in a window on this computer. This may submit data or perform an external action.',
    parameters: ComputerPressSchema, target: where,
    execute: (input, context) => press(layers, input, context),
  });
  registry.register({
    name: 'computer.type', permission: 'browser.interact',
    description: 'Type into a box by its name, on the open web page or in a window on this computer. Password boxes are always refused.',
    parameters: ComputerTypeSchema, target: where,
    execute: (input, context) => write(layers, input, context),
  });
}
