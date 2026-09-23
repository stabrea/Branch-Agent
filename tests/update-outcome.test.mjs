/**
 * Q55 in the updater: every status names the installed build (version, and the commit it was built
 * from or null), the offered release carries its own notes, and a failed update says the installed
 * version was kept until the next thing the updater does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Updater } from "../dist/desktop/updater.js";
import { ActivationJournal, lastActivation, settleActivation } from "../dist/never-break/activation.js";

const repo = "stabrea/Branch-Agent", name = "Branch-Agent-windows-x64.zip", tag = "v9.9.9";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const release = { tag_name: tag, name: "Branch Agent 9.9.9", body: "Faster start.\nFixed the Files view.", published_at: "2026-09-23T00:00:00Z",
  html_url: `https://github.com/${repo}/releases/tag/${tag}`, prerelease: false, draft: false,
  assets: [name, `${name}.sha256`].map((file) => ({ name: file, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${file}`, size: 100 })) };
/** GitHub answers the look-up; the download itself is refused, as a dropped connection would be. */
const github = async (url) => url.endsWith("/latest")
  ? { ok: true, status: 200, json: async () => release }
  : { ok: false, status: 503, body: null, headers: new Headers(), json: async () => ({}) };

async function make(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  t.after(() => discardTemp(root));
  return new Updater({ repo, currentVersion: "0.19.3", channel: "stable", installDir: join(root, "installed"),
    executableName: "Branch Agent.exe", assetName: name, scratchDir: join(root, "scratch"), platform: "win32", fetch: github, ...extra });
}

test("every status names the installed build, with its commit or null when none was recorded", async (t) => {
  const stamped = await make(t, { currentCommit: COMMIT });
  assert.deepEqual(stamped.status.installed, { version: "0.19.3", commit: COMMIT });
  const checked = await stamped.check();
  assert.deepEqual(checked.installed, { version: "0.19.3", commit: COMMIT }, "still there after a check");
  assert.equal(checked.release.notes, "Faster start.\nFixed the Files view.", "the offered release's own notes");
  const unstamped = await make(t);
  assert.deepEqual(unstamped.status.installed, { version: "0.19.3", commit: null });
  const unsupported = new Updater({ repo, currentVersion: "0.19.3", installDir: null, executableName: "x", assetName: name, scratchDir: "unused", currentCommit: null });
  assert.equal(unsupported.status.phase, "unsupported");
  assert.deepEqual(unsupported.status.installed, { version: "0.19.3", commit: null });
});

test("a failed install says the installed version was kept, and the next check clears it", async (t) => {
  const updater = await make(t);
  assert.equal((await updater.check()).outcome, null);
  await assert.rejects(updater.install());
  assert.equal(updater.status.phase, "error");
  assert.deepEqual(updater.status.outcome, { kept: "0.19.3" });
  assert.equal(updater.inProgress, false);
  assert.equal((await updater.check()).outcome, null, "a later check does not carry an old failure");
});

test("a hand-over that could not start gives the claim back and says what was kept", async (t) => {
  const updater = await make(t);
  await updater.check();
  const status = updater.failed("The update could not be started: no shell.");
  assert.equal(status.phase, "error");
  assert.equal(status.message, "The update could not be started: no shell.");
  assert.deepEqual(status.outcome, { kept: "0.19.3" });
  assert.equal(updater.inProgress, false);
  assert.equal(status.release.latestVersion, "9.9.9", "the offered release is still named");
});

test("the newest activation is read without writing, and an unconfirmed update settles as failed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  t.after(() => discardTemp(dataDir));
  assert.equal(lastActivation(dataDir), null, "nothing recorded, and no journal is created by looking");
  const path = join(dataDir, "activation.sqlite");
  const journal = new ActivationJournal(path);
  const entry = { kind: "update", target: join(dataDir, "app"), previous: null, candidate: null, launcher: null,
    executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] };
  journal.activated(journal.stage({ ...entry, fromVersion: "0.19.2", toVersion: "0.19.3" }));
  journal.stage({ ...entry, fromVersion: "0.19.3", toVersion: "9.9.9" });
  journal.close();
  assert.equal(settleActivation(path, "0.19.3"), "failed");
  assert.deepEqual(lastActivation(dataDir), { kind: "update", fromVersion: "0.19.3", toVersion: "9.9.9", state: "failed" });
});
