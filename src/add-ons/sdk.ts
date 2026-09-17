import type { BranchPlugin } from "../plugins.js";

/**
 * Bucket 15 (A2274): the version of the add-on interface this copy of Branch offers.
 *
 * A plugin or an add-on package may say which version it was written for (`apiVersion`). One
 * written for a newer interface than this copy offers is refused in a sentence rather than loaded
 * half-working; one that says nothing is taken as version 1, which is what every plugin written
 * before the number existed was written for.
 *
 * Version 1 is what `BranchPlugin` in src/plugins.ts describes: tools (each named
 * `plugin.<id>.<name>` and needing one declared permission), event hooks, model connections and chat
 * services — plus, from bucket 15, a tool may say it is a search source (`search`). A plugin that
 * runs in its own walled program gets tools, hooks and search sources; model connections and chat
 * services need Branch's own process and are left out there, with a sentence.
 *
 * Plugin authors test with the doubles in src/testing-doubles.ts, which the package also exports.
 */
export const addOnApiVersion = 1;

export function checkApiVersion(declared: unknown, what: string): void {
  if (declared === undefined || declared === null) return;
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1)
    throw new Error(`${what} gives an interface version Branch cannot read.`);
  if (declared > addOnApiVersion)
    throw new Error(`${what} was written for add-on interface ${declared}, and this copy of Branch offers ${addOnApiVersion}. Update Branch to use it.`);
}

/**
 * What a plugin file exports as its default, checked the way Branch will check it. Returning the
 * same object keeps a plugin file one plain `export default definePlugin({ ... })`.
 */
export function definePlugin<T extends BranchPlugin>(plugin: T): T {
  checkApiVersion(plugin.apiVersion, `The plugin ${String(plugin.id)}`);
  return plugin;
}
