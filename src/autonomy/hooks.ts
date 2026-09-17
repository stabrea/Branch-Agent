/**
 * R17-B: the two small hooks other files call, kept free of imports so the runtime and goal mode can
 * use them without pulling this whole folder in.
 *
 * `createBranch` makes one `Autonomy` per runtime and registers it here; the runtime then asks it
 * for the standing orders and instructions a task should be told about (nothing while those parts
 * are off).
 */
export interface PromptSource {
  instructionsFor(context: { agent?: string | undefined; source?: string | undefined }): string;
}

const sources = new WeakMap<object, PromptSource>();

export function registerPromptSource(runtime: object, source: PromptSource): void {
  sources.set(runtime, source);
}

/** What the runtime adds to a task's system message; an empty string when nothing applies. */
export function autonomyPrompt(runtime: object, context: { agent?: string | undefined; source?: string | undefined }): string {
  try {
    return sources.get(runtime)?.instructionsFor(context) ?? "";
  } catch {
    return ""; // a broken record must never stop a task from starting
  }
}
