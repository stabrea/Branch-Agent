/**
 * Bucket 15: the small program that loads a walled plugin and answers one question. It is written
 * into the plugin's scratch folder beside a copy of the plugin and `request.json`, and runs behind
 * the wall (src/add-ons/walled-plugin.ts). It prints whatever the plugin prints, then one marked
 * line with the answer; Branch reads only that line.
 */
export const resultMarker = "\n@@branch-add-on-answer@@";

export const hostSource = `import { readFile } from "node:fs/promises";
const marker = ${JSON.stringify(resultMarker)};
const say = (value) => {
  let text;
  try { text = JSON.stringify(value); } catch { text = JSON.stringify({ ok: false, error: "the answer could not be written down" }); }
  process.stdout.write(marker + text + "\\n");
};
const safe = (value) => (value === undefined ? null : value);
try {
  const request = JSON.parse(await readFile(new URL("./request.json", import.meta.url), "utf8"));
  const loaded = await import(new URL("./plugin.mjs", import.meta.url).href);
  const plugin = loaded.default;
  if (!plugin || typeof plugin !== "object") throw new Error("the file does not export a plugin as its default export");
  const tools = Array.isArray(plugin.tools) ? plugin.tools : [];
  const hooks = Array.isArray(plugin.hooks) ? plugin.hooks : [];
  if (request.kind === "describe") {
    say({ ok: true, plugin: {
      id: String(plugin.id), name: String(plugin.name), description: String(plugin.description ?? ""),
      permissions: Array.isArray(plugin.permissions) ? plugin.permissions.map(String) : [],
      ...(typeof plugin.apiVersion === "number" ? { apiVersion: plugin.apiVersion } : {}),
      tools: tools.map((tool) => ({ name: String(tool.name), description: String(tool.description ?? ""),
        permission: String(tool.permission), ...(tool.input ? { input: tool.input } : {}),
        ...(tool.search && tool.search.label ? { search: { label: String(tool.search.label) } } : {}) })),
      hooks: hooks.map((hook) => String(hook.event)),
      providers: Array.isArray(plugin.providers) && plugin.providers.length > 0,
      channels: Array.isArray(plugin.channels) && plugin.channels.length > 0,
    } });
  } else if (request.kind === "call") {
    const tool = tools.find((entry) => String(entry.name) === request.tool);
    if (!tool || typeof tool.run !== "function") throw new Error("it has no tool called " + request.tool);
    const result = await tool.run(request.args ?? {}, { runId: request.runId, walled: true });
    say({ ok: true, result: safe(result) });
  } else if (request.kind === "hook") {
    for (const hook of hooks.filter((entry) => String(entry.event) === request.event))
      await hook.run({ event: request.event, runId: String(request.payload?.runId ?? ""), data: request.payload?.data ?? {} });
    say({ ok: true });
  } else {
    throw new Error("unknown question");
  }
} catch (error) {
  say({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 500) });
}
`;
