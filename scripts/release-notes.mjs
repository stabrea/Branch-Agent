/**
 * Drafts the next release notes from the checkpoint sections added since the last tag.
 *
 * A starting point, never the finished prose: it can say what changed, not which of it matters to
 * the person reading. The structure it fills in is written down in docs/release-notes-template.md.
 *
 *   node scripts/release-notes.mjs                  # since the newest tag
 *   node scripts/release-notes.mjs --since v0.14.0  # from a tag you name
 *   node scripts/release-notes.mjs --out notes.md   # into a file
 *
 * The checkpoint's headings are not in date order — waves were merged out of sequence — so "added
 * since the tag" is worked out by comparing the file with its contents at that tag, never by
 * reading the headings in order.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHECKPOINT = "docs/CHECKPOINT.md";

/**
 * The install paragraph. Every download name comes from the list the updater and the packaging
 * scripts use (src/desktop/release-assets.ts, read from the build), so a renamed download can never
 * leave the notes pointing at a file that is not there.
 */
export function installSection({ releaseAssets, checksumAssetName, appEntryName }) {
  const name = (platform, arch) => {
    const found = releaseAssets.find((asset) => asset.platform === platform && asset.arch === arch);
    if (!found) throw new Error(`No ${platform} ${arch} download is listed in release-assets.ts.`);
    return found.name;
  };
  const windows = name("win32", "x64");
  return [
    "**Install**",
    `Download \`${windows}\`, unzip it, and run \`${appEntryName("win32")}\`. From 0.7.3 onward the in-app update is silent. The checksum is in \`${checksumAssetName(windows)}\`.`,
    `On a Mac, download \`${name("darwin", "arm64")}\` (Apple silicon) or \`${name("darwin", "x64")}\` (Intel), unzip it, and move \`${appEntryName("darwin")}\` into your Applications folder.`,
    `On Linux, download \`${name("linux", "x64")}\`, unpack it, and run \`${appEntryName("linux")}\`.`,
    "Each download has its checksum beside it, in a file of the same name ending in `.sha256`.",
  ].join("\n");
}

/** The download names, from the build. The drafter is run from a built checkout. */
async function assetNames() {
  try {
    return await import("../dist/desktop/release-assets.js");
  } catch {
    console.error("Build Branch first (npm run build): the download names are read from the build.");
    process.exit(1);
  }
}

/** Git, as an argument list, so nothing here is ever handed to a shell to interpret. */
function git(...args) {
  const done = spawnSync("git", args, { encoding: "utf8" });
  if (done.status !== 0) return null;
  return done.stdout;
}

/** The newest tag this checkout knows about. */
function newestTag() {
  const listed = git("tag", "--list", "--sort=-v:refname");
  return listed?.split(/\r?\n/).find((line) => line.trim()) ?? null;
}

/** Every "## " section in one copy of the checkpoint, as heading to body. */
function sections(text) {
  const found = new Map();
  let heading = null;
  let body = [];
  for (const line of text.split(/\r?\n/)) {
    const hit = /^## (.+)$/.exec(line);
    if (!hit) { if (heading) body.push(line); continue; }
    if (heading) found.set(heading, body);
    heading = hit[1].trim();
    body = [];
  }
  if (heading) found.set(heading, body);
  return found;
}

/** Strips the wave, batch and audit markers a reader should never meet. */
const plain = (text) =>
  text
    .replace(/\s*\((?:batch\s*\d+[^)]*|wave\s*\d+)\)/gi, "")
    .replace(/^Batch\s+\d+\s*[-—–:]\s*/i, "")
    .replace(/\bA\d{4,5}\b/g, "")
    /* A bare "wave 7" inside a sentence cannot simply be deleted without breaking the grammar, so
       it becomes the thing the reader would have understood by it. */
    .replace(/\bwave\s*\d+\b/gi, "an earlier release")
    .replace(/\bbatch\s*\d+\b/gi, "an earlier pass")
    .replace(/\s{2,}/g, " ")
    .trim();

/** The first two or three sentences of a section, which is what a themed paragraph is made of. */
function opening(body) {
  const prose = body
    .join("\n")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph && !/^[|#-]/.test(paragraph));
  const first = prose[0] ?? "";
  return first.split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
}

/** A heading turned into the bold lead a person would use for it. */
function lead(heading) {
  const said = plain(heading);
  const capital = said.charAt(0).toUpperCase() + said.slice(1);
  return capital.endsWith(".") ? capital : `${capital}.`;
}

async function main() {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  const since = at("--since") ?? newestTag();
  if (!since) {
    console.error("No tag to compare with. Pass --since <tag>.");
    process.exit(1);
  }
  const before = git("show", `${since}:${CHECKPOINT}`);
  if (before === null) {
    console.error(`Could not read ${CHECKPOINT} at ${since}. Is that a tag in this checkout?`);
    process.exit(1);
  }

  const was = sections(before);
  const now = sections(readFileSync(CHECKPOINT, "utf8"));
  const added = [...now].filter(([heading]) => !was.has(heading));

  const out = [`## What changed in <version>`, ""];
  if (!added.length) out.push(`Nothing has been added to ${CHECKPOINT} since ${since}.`, "");
  for (const [heading, body] of added) {
    const sentences = opening(body);
    out.push(`**${lead(heading)}** ${plain(sentences)}`.trim(), "");
  }
  out.push(
    "**Also.** <the smaller things, one clause each, separated by semicolons>",
    "",
    "**Fixed.** <what used to go wrong, in plain words>",
    "",
    installSection(await assetNames()),
    "",
  );
  const draft = out.join("\n");

  const target = at("--out");
  if (target) {
    writeFileSync(target, draft);
    console.error(`Drafted ${added.length} theme(s) since ${since} into ${target}. Rewrite every paragraph by hand.`);
  } else {
    process.stdout.write(draft);
    console.error(`\n--- ${added.length} theme(s) since ${since}. A draft, not the prose. ---`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
