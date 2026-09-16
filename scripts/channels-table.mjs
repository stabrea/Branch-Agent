// The Connections table in docs/configuration.md is written from data/channels.json rather than by
// hand. Run this after changing that file: `npm run build && node scripts/channels-table.mjs`.
// tests/channels-2.test.mjs fails if the documentation and the data have drifted apart.
import { readFile, writeFile } from "node:fs/promises";
import { replaceChannelTable, renderChannelTable } from "../dist/index.js";

const docs = "docs/configuration.md";
const before = await readFile(docs, "utf8");
const after = replaceChannelTable(before, renderChannelTable());
if (after === before) { console.log("The Connections table is already up to date."); process.exit(0); }
await writeFile(docs, after);
console.log("The Connections table was rewritten from data/channels.json.");
