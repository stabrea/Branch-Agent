/**
 * Writes docs/api.md from the app's own description of its web API.
 *
 * The routes and their request shapes live in src/api-openapi.ts, built out of the same zod schemas
 * the server checks requests against. This reads the built app, asks for the document, and writes
 * the readable version beside the other docs, so the page cannot drift from the app.
 *
 * Run it after `npm run build`.
 */
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openApiDocument, apiMarkdown } from "../dist/api-openapi.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "docs", "api.md");
await writeFile(target, apiMarkdown(openApiDocument(version)), "utf8");
console.log(`Wrote ${target}`);
