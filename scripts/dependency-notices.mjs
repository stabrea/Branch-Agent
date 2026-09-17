import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sections = [
  "# Third-party notices",
  "",
  "Branch Agent application code is MIT licensed. Distributed dependencies retain their own licenses and notices. This file collects notices from the pinned runtime dependency packages; their original files are also retained in the desktop package.",
  "",
  "Electron distributions additionally include LICENSE and LICENSES.chromium.html. Font notices accompany the generated files in public/fonts. Build dependencies are recorded in package-lock.json and retain notices in node_modules.",
  "",
];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue;
  const metadata = JSON.parse(
    await readFile(join(path, "package.json"), "utf8"),
  );
  const names = (await readdir(path)).filter((name) =>
    /^(license|licence|copying|notice)(\.|$)/i.test(name),
  );
  if (!names.length)
    throw new Error(`No top-level license notice for ${metadata.name}`);
  sections.push(
    `## ${metadata.name} ${metadata.version}`,
    "",
    `Declared license: ${metadata.license ?? "see notice"}`,
    "",
  );
  for (const name of names)
    sections.push(
      `### ${name}`,
      "",
      await readFile(join(path, name), "utf8"),
      "",
    );
}
// The hand-written section for source code adapted from other projects is not in any package;
// it is carried over from the current file so regenerating never drops it.
const adaptedHeading = "## Source code adapted from other projects";
const current = await readFile("THIRD_PARTY_NOTICES.md", "utf8").catch(() => "");
const adapted = current.indexOf(`\n${adaptedHeading}\n`);
if (adapted >= 0) sections.push(current.slice(adapted + 1).trimEnd(), "");
await writeFile("THIRD_PARTY_NOTICES.md", sections.join("\n").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, ""));
console.log("Collected notices from locked runtime dependencies.");
