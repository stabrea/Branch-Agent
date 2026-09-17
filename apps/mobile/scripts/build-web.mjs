/**
 * Puts the phone app's page together in www/: the app's own screens (web/), and the pieces of
 * Branch's window they reuse, copied from public/ so the phone always carries the current design
 * (tokens, the 44 themes, the oak, the words, the fonts and the mark). Run by `npm run web` and by
 * scripts/package-mobile.mjs. The root project must have been built once (npm run build) for fonts.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..", "..");
const out = join(app, "www");
/** Files from Branch's window that the phone screens use, as [from public/, to www/]. */
export const REUSED = [
  ["tokens.css", "tokens.css"], ["style.css", "style.css"], ["theme-catalogue.js", "theme-catalogue.js"],
  ["theme-bridge.js", "theme-bridge.js"],
  ["grove.js", "grove.js"], ["i18n.js", "i18n.js"], ["locales", "locales"], ["fonts", "fonts"],
  ["assets/keepoak-mark.png", "assets/keepoak-mark.png"],
];

export async function buildWeb() {
  if (!existsSync(join(repo, "public", "fonts", "geist.woff2")))
    throw new Error("Build Branch first (npm run build in the repository root) so the fonts are in public/fonts.");
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "assets"), { recursive: true });
  for (const name of await readdir(join(app, "web"))) await cp(join(app, "web", name), join(out, name), { recursive: true });
  for (const [from, to] of REUSED) await cp(join(repo, "public", from), join(out, to), { recursive: true });
  await mkdir(join(out, "vendor"), { recursive: true });
  await cp(join(app, "node_modules", "jsqr", "dist", "jsQR.js"), join(out, "vendor", "jsqr.js"));
  await cp(join(app, "node_modules", "jsqr", "LICENSE"), join(out, "vendor", "jsqr-LICENSE.txt"));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Phone page written to ${await buildWeb()}`);
