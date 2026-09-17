// mac7/connect: the "Setting up a chat app" table in docs/configuration.md is written from
// data/channel-setup.json rather than by hand. Run this after changing that file:
// `node scripts/channel-setup-table.mjs`. tests/channel-setup.test.mjs fails if the two drift apart.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const START = "<!-- channel-setup-table:start -->", END = "<!-- channel-setup-table:end -->";
const turnOn = { guided: "yes, and switched on from it", file: "yes; then one line in the connections file", switch: "yes; switched on from it" };

function install(recipe) {
  const app = recipe.app;
  if (!app) return "nothing to install";
  const linux = [app.flatpak && `Flathub \`${app.flatpak}\``, app.snap && `Snap \`${app.snap}\``].filter(Boolean).join(" or ");
  return `Windows: ${app.winget ? `winget \`${app.winget}\`` : "download page"}; Mac: ${app.brew ? `cask \`${app.brew}\`` : "download page"}; Linux: ${linux || "download page"}`;
}
const shown = (url) => url.replace("{{manifest}}", "…").replace("{{server}}", "<server>").replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, "<token>");
function pasted(recipe) {
  const secrets = recipe.paste.map((paste) => `\`${paste.secret}\`${paste.optional ? " (optional)" : ""}`).join(", ") || "nothing";
  return recipe.fields.length ? `${secrets}; plus ${recipe.fields.map((field) => field.name).join(", ")}` : secrets;
}

/** The table's lines, from the recipes, in the file's order. */
export function renderSetupTable(book) {
  const rows = book.recipes.map((recipe) => [
    `${recipe.name} (\`${recipe.id}\`)`,
    turnOn[recipe.turnOn],
    install(recipe),
    recipe.create?.url ? `\`${shown(recipe.create.url)}\`${recipe.create.prefilled ? " (pre-filled)" : ""}` : "none (plain steps)",
    pasted(recipe),
    recipe.check ? `${recipe.check.method} \`${shown(recipe.check.url)}\`` : "none",
  ]);
  return ["| Channel | One command? | Install source per OS | Bot or app page | What is pasted back | Check |",
    "| --- | --- | --- | --- | --- | --- |", ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

/** The docs with the table between the markers replaced. */
export function replaceSetupTable(docs, table) {
  const start = docs.indexOf(START), end = docs.indexOf(END);
  if (start < 0 || end < start) throw new Error("docs/configuration.md has lost its channel-setup-table markers");
  return `${docs.slice(0, start + START.length)}\n\n${table}\n\n${docs.slice(end)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const book = JSON.parse(await readFile(join(root, "data", "channel-setup.json"), "utf8"));
  const file = join(root, "docs", "configuration.md");
  const before = await readFile(file, "utf8");
  const after = replaceSetupTable(before, renderSetupTable(book));
  if (after === before) console.log("The chat app setup table is already up to date.");
  else { await writeFile(file, after); console.log("The chat app setup table was rewritten from data/channel-setup.json."); }
}
