/**
 * Filling `{{name}}` into a shape kept as data, and reading a value back out of one by a dotted
 * path. Used by the chat-service list, where each service's JSON shape is data, and by the
 * outbound webhooks, where the owner decides what shape their own endpoint is sent.
 */

/**
 * Reads a value out of posted JSON by a dotted path, so the shape of a post stays in the data.
 * Several paths separated by `|` are tried in turn, for services that put the same thing in
 * different places depending on who is in the chat.
 */
export function readPath(source: unknown, path: string): unknown {
  for (const option of path.split("|")) {
    let current: unknown = source;
    for (const part of option.split(".")) {
      if (Array.isArray(current)) { current = current[Number(part)]; continue; }
      if (!current || typeof current !== "object") { current = undefined; break; }
      current = (current as Record<string, unknown>)[part];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return undefined;
}

/** Fills `{{name}}` in a piece of text. A name with no value becomes an empty string. */
export function fill(text: string, values: Record<string, string | undefined>): string {
  return text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_.]*)\}\}/g, (_match, name: string) => values[name] ?? "");
}
/** Fills every string inside a JSON body, dropping keys a placeholder emptied (an absent reply id). */
function emptied(before: unknown, after: unknown): boolean {
  if (typeof before === "string") return /\{\{[a-zA-Z][a-zA-Z0-9_.]*\}\}/.test(before) && after === "";
  const isObject = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
  return isObject(before) && isObject(after) && Object.keys(before as object).length > 0
    && Object.keys(after as object).length === 0;
}
export function fillJson(node: unknown, values: Record<string, string | undefined>): unknown {
  if (typeof node === "string") return fill(node, values);
  if (Array.isArray(node)) return node.map((item) => fillJson(item, values));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const filled = fillJson(value, values);
    if (!emptied(value, filled)) out[key] = filled;
  }
  return out;
}

/** Every `{{name}}` a shape asks for, so a wording that asks for the impossible can be refused. */
export function templateNames(node: unknown, found = new Set<string>()): Set<string> {
  if (typeof node === "string") for (const match of node.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_.]*)\}\}/g)) found.add(match[1]!);
  else if (Array.isArray(node)) for (const item of node) templateNames(item, found);
  else if (node && typeof node === "object") for (const value of Object.values(node as Record<string, unknown>)) templateNames(value, found);
  return found;
}
/** Fills a shape from a whole document, so `{{run.id}}` reaches inside what is being announced. */
export function fillFrom(node: unknown, source: unknown): unknown {
  const values: Record<string, string> = {};
  for (const name of templateNames(node)) {
    const value = readPath(source, name);
    values[name] = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return fillJson(node, values);
}
