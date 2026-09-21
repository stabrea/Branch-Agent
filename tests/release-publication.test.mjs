import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { publishRelease, releaseFiles } from "../scripts/publish-release.mjs";

async function fixture(t, tag = "v1.2.3") {
  const root = await mkdtemp(join(tmpdir(), "branch-release-"));
  t.after(() => discardTemp(root));
  const downloads = join(root, "downloads"), source = join(root, "source");
  await mkdir(downloads, { recursive: true });
  await mkdir(join(source, "docs", "agents", "briefs"), { recursive: true });
  await writeFile(join(source, "docs", "agents", "briefs", `release-notes-${tag.slice(1)}.md`),
    "## What changed\n\nReviewed release notes.\n");
  for (const name of releaseFiles(tag)) await writeFile(join(downloads, name), name);
  return { tag, downloads, source };
}

function github(initial = null, failUpload = false) {
  let release = initial;
  const calls = [];
  const gh = async (args, { allowFailure = false } = {}) => {
    calls.push(args);
    const [area, action] = args;
    if (area === "release" && action === "view") {
      if (!release) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: JSON.stringify(release), stderr: "" };
    }
    if (area === "release" && action === "create") {
      release = { isDraft: true, assets: [] };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (area === "release" && action === "upload") {
      if (failUpload) return { code: 1, stdout: "", stderr: "upload failed" };
      for (const path of args.slice(5)) release.assets.push({ name: basename(path).replace(/[^A-Za-z0-9._-]/g, ".") });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (area === "release" && action === "edit") {
      release.isDraft = false;
      release.isLatest = args.includes("--latest");
      release.notesFile = args[args.indexOf("--notes-file") + 1];
      return { code: 0, stdout: "", stderr: "" };
    }
    if (allowFailure) return { code: 1, stdout: "", stderr: "unsupported" };
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, calls, release: () => release };
}

test("a complete tag publishes the reviewed notes as the latest non-draft release", async (t) => {
  const input = await fixture(t), fake = github();
  await publishRelease({ ...input, repo: "owner/repo", gh: fake.gh });
  assert.equal(fake.release().isDraft, false);
  assert.equal(fake.release().isLatest, true);
  assert.match(fake.release().notesFile, /release-notes-1\.2\.3\.md$/);
  assert.equal(fake.release().assets.length, releaseFiles(input.tag).length);
  assert.ok(!fake.calls.flat().includes("Downloads for v1.2.3."));
});

test("an incomplete local package never creates a release", async (t) => {
  const input = await fixture(t), fake = github();
  await unlink(join(input.downloads, "Branch-Agent-windows-x64.zip.sha256"));
  await assert.rejects(() => publishRelease({ ...input, repo: "owner/repo", gh: fake.gh }), /ENOENT|no such file/i);
  assert.equal(fake.release(), null);
});

test("a failed upload never publishes its draft", async (t) => {
  const input = await fixture(t), fake = github({ isDraft: true, assets: [] }, true);
  await assert.rejects(() => publishRelease({ ...input, repo: "owner/repo", gh: fake.gh }), /upload failed/i);
  assert.equal(fake.release().isDraft, true);
  assert.equal(fake.calls.some((args) => args[1] === "edit"), false);
});
