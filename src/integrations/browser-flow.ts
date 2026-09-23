import { z } from 'zod';
import type { ToolContext } from '../contracts.js';
import type { ToolRegistry } from '../registry.js';
import { ScreenshotSchema } from './browser-page.js';

/**
 * FQ-execution.browser: one page or action, as a step in a `browser.flow`. Kept small on purpose —
 * the four things a journey across a website is actually made of — rather than opening this tool
 * up to the whole browser surface.
 */
export const FlowStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().url().max(2000) }).strict(),
  z.object({ action: z.literal('click'), role: z.enum(['button', 'link']), name: z.string().min(1).max(300) }).strict(),
  z.object({ action: z.literal('fill'), label: z.string().min(1).max(300), value: z.string().max(4000) }).strict(),
  z.object({
    action: z.literal('wait'), text: z.string().min(1).max(300).optional(),
    selector: z.string().min(1).max(300).optional(), networkIdle: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
  }).strict(),
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;
export const FlowSchema = z.object({
  steps: z.array(FlowStepSchema).min(1).max(12),
  /** Passed straight through to each step's picture. */
  fullPage: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  // Kept as a separate pass, not a `.refine` on the step itself: `discriminatedUnion` needs each
  // option to stay a plain `ZodObject` so it can read the discriminator off its shape.
  value.steps.forEach((step, index) => {
    if (step.action === 'wait' && !step.text && !step.selector && !step.networkIdle)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index],
        message: 'Say what to wait for: some text, a selector, or networkIdle' });
  });
});

/** One step's report: what it did, the page it left the browser on, and the picture kept of it. */
export interface FlowStepReport {
  step: number;
  action: FlowStep['action'];
  url: string;
  screenshot: { path: string; bytes: number; sha256: string };
}

/** What the browser tool lends the flow runner: its own actions, called one after another. */
export interface FlowHost {
  navigate(url: string, context: ToolContext): Promise<{ url: string; title: string }>;
  click(role: 'button' | 'link', name: string, context: ToolContext): Promise<{ url: string; clicked: string }>;
  fill(label: string, value: string, context: ToolContext): Promise<{ filled: string }>;
  wait(options: { text?: string | undefined; selector?: string | undefined; networkIdle?: boolean | undefined; timeoutMs: number },
    context: ToolContext): Promise<{ waitedFor: string; url: string }>;
  screenshot(options: z.infer<typeof ScreenshotSchema>, context: ToolContext):
    Promise<{ path: string; bytes: number; sha256: string; mediaType: string; url: string }>;
}

/** Runs one step; the picture that follows it, in `runFlow`, is what reads the page it landed on. */
async function runStep(host: FlowHost, step: FlowStep, context: ToolContext): Promise<void> {
  if (step.action === 'navigate') { await host.navigate(step.url, context); return; }
  if (step.action === 'click') { await host.click(step.role, step.name, context); return; }
  if (step.action === 'fill') { await host.fill(step.label, step.value, context); return; }
  await host.wait(step, context);
}

/**
 * Runs a short, named sequence of pages and actions one after another in the task's own browser
 * window, taking a picture after every step. It is the very same window and the very same cookies
 * the whole way through — a `browser.profile` sign-in, or a cookie a page sets itself, from an
 * earlier step is still there on a later page. This is the difference from calling
 * navigate/click/screenshot by hand for every page: the owner asks for the journey once and gets
 * back a picture of each step of it, proof that the session carried rather than a claim that it did.
 */
export async function runFlow(host: FlowHost, input: z.infer<typeof FlowSchema>, context: ToolContext):
  Promise<{ steps: FlowStepReport[]; pages: number }> {
  const steps: FlowStepReport[] = [];
  const seen = new Set<string>();
  for (const [index, step] of input.steps.entries()) {
    await runStep(host, step, context);
    const picture = await host.screenshot({ fullPage: input.fullPage }, context);
    seen.add(picture.url);
    steps.push({ step: index + 1, action: step.action, url: picture.url,
      screenshot: { path: picture.path, bytes: picture.bytes, sha256: picture.sha256 } });
  }
  return { steps, pages: seen.size };
}

export function registerBrowserFlow(registry: ToolRegistry, host: FlowHost): void {
  registry.register({
    name: 'browser.flow', permission: 'browser.interact',
    description: 'Run a short, named journey across one or more pages in the task\'s own browser window — navigate, '
      + 'click, fill or wait, in order — taking a picture after every step, with the same signed-in session carried '
      + 'from page to page. Use this for a journey across more than one page instead of calling '
      + 'navigate/click/screenshot by hand for each one.',
    parameters: FlowSchema,
    execute: (input, context) => runFlow(host, input, context),
  });
}
