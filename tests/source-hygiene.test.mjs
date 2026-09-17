/**
 * Three separate branches have now committed a source file containing a literal NUL byte, written
 * by hand into a template or a regular expression. Git then treats the file as binary: it stops
 * normalising line endings, `git diff` shows nothing useful, and a later merge conflicts on the
 * whole file instead of the few lines that changed. Each time it cost somebody an afternoon.
 *
 * A NUL in source is always a mistake here; the escape is what was meant every time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots = ["src", "public", "tests", "scripts", "docs"];
const endings = [".ts", ".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md"];

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (endings.some((end) => entry.name.endsWith(end))) found.push(path);
  }
  return found;
}

test("no source file carries a literal NUL byte", async () => {
  const offenders = [];
  for (const root of roots)
    for (const path of await sourceFiles(fileURLToPath(new URL("../" + root, import.meta.url)))) {
      const bytes = await readFile(path);
      const at = bytes.indexOf(0);
      if (at !== -1) offenders.push(`${path} at byte ${at}`);
    }
  assert.deepEqual(offenders, [],
    "these files contain a literal NUL, which makes git treat them as binary. Write the escape instead.");
});

/**
 * Nothing that looks like a real credential gets committed.
 *
 * GitHub scans public repositories for these for free and refuses the push. The moment this
 * repository went private that stopped: scanning is a paid feature on a private repository, so the
 * one protection that was actually working disappeared exactly when the owner took the step meant
 * to make things safer. This check replaces it and does not care whether the repository is public,
 * private, or on a laptop with no network at all.
 *
 * A test fixture that must look like a credential says so on its own line with the marker below.
 * That is deliberate: it costs a few words, and it means every exception is visible in the diff
 * rather than living in a list somewhere nobody reads.
 */
const notARealSecret = "not-a-real-secret";
const credentials = [
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, "an OpenAI-style key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic key"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "a GitHub personal access token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}/, "a fine-grained GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{32,}/, "a Telegram bot token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "a private key"],
];

test("nothing that looks like a real credential is committed", async () => {
  const offenders = [];
  for (const root of roots)
    for (const path of await sourceFiles(fileURLToPath(new URL("../" + root, import.meta.url)))) {
      const text = await readFile(path, "utf8");
      text.split("\n").forEach((line, at) => {
        if (line.includes(notARealSecret)) return;
        for (const [pattern, what] of credentials)
          if (pattern.test(line)) offenders.push(`${path}:${at + 1} looks like ${what}`);
      });
    }
  assert.deepEqual(offenders, [],
    `these lines look like real credentials. If one is a fixture, say "${notARealSecret}" on the line.`);
});
