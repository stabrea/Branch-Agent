/* The Dev update channel (src/desktop/dev-build.ts, src/desktop/updater.ts): like Hermes Desktop, the newest merged
   change is built on this computer. Stand-ins for git, npm, unpacking and the network: nothing is cloned, built,
   downloaded, installed or opened here. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Updater } from "../dist/desktop/updater.js";
import { devBranch, buildEnv } from "../dist/desktop/dev-build.js";
import { updatePlan, betaCheckEveryMs } from "../dist/comfort/auto-update.js";
import { buildInfo } from "../scripts/package-desktop.mjs";

const repo = "stabrea/Branch-Agent", assetName = "Branch-Agent-windows-x64.zip", exe = "Branch Agent.exe";
const NEW = "a".repeat(40), OLD = "b".repeat(40), COMMITTED = 1758600000, BUILT = `0.19.3-dev.${COMMITTED}`;

async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-dev-channel-"));
  t.after(() => discardTemp(root));
  const installDir = join(root, "installed"), sourceDir = join(root, "dev-source"), scratchDir = join(root, "scratch");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, exe), "the installed app");
  return { root, installDir, sourceDir, scratchDir };
}

/** A git and npm that answer like the real ones, write what a real build writes, and record every call. */
function fakeTools(where, { missing = [], head = NEW, headAfterReset = head, failOn = null, tamper = false, shared = OLD } = {}) {
  const calls = [];
  const run = async (file, args, options) => {
    const line = [file, ...args.filter((arg) => !arg.startsWith("credential.helper") && !arg.startsWith("core.askPass") && arg !== "-c")].join(" ");
    calls.push(line);
    if (args[0] === "--version") { if (missing.includes(file)) throw new Error("not found"); return "1.0"; }
    if (failOn && line.includes(failOn)) throw new Error(`${failOn} did not finish.`);
    if (line.startsWith("git ls-remote")) return `${head}\trefs/heads/${devBranch}\n`;
    if (line.startsWith("git clone")) { await mkdir(join(where.sourceDir, ".git"), { recursive: true }); return ""; }
    if (line.startsWith("git reset")) { // the committed tree: canonical's own version, the lockfile agreeing
      await writeFile(join(where.sourceDir, "package.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2" }));
      await writeFile(join(where.sourceDir, "package-lock.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2", packages: { "": { version: "0.19.2" } } }));
      return "";
    }
    if (line.startsWith("git merge-base")) { if (shared === null) throw new Error("git merge-base did not finish."); return `${shared}\n`; }
    if (line.startsWith("git show")) return `${COMMITTED}\n`;
    if (line.startsWith("git rev-parse")) return `${headAfterReset}\n`;
    if (line.startsWith("npm run package:desktop")) {
      await mkdir(join(options.cwd, "release"), { recursive: true });
      const zip = join(options.cwd, "release", assetName);
      await writeFile(zip, "a built app");
      const digest = createHash("sha256").update(tamper ? "something else" : "a built app").digest("hex");
      await writeFile(`${zip}.sha256`, `${digest}  ${assetName}\n`);
    }
    return "";
  };
  return { run, calls };
}
/** Unpacking the built zip: the app folder with the package identity the build was stamped with. */
const extract = (sourceDir) => async (_archive, into) => {
  const { version } = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8"));
  const app = join(into, "Branch Agent");
  await mkdir(join(app, "resources", "app"), { recursive: true });
  await writeFile(join(app, exe), "the new app");
  await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
};
const noNetwork = async (url) => { throw new Error(`the Dev channel must not call ${url}`); };
const updater = (where, tools, extra = {}) => new Updater({ repo, currentVersion: "0.19.3", channel: "dev", installDir: where.installDir,
  executableName: exe, assetName, scratchDir: where.scratchDir, platform: "win32", fetch: noNetwork, extract: extract(where.sourceDir),
  devRun: tools.run, devSourceDir: where.sourceDir, currentCommit: OLD, runOnceKey: "HKCU\\Software\\BranchTest\\RunOnce", ...extra });

test("Dev says plainly when git or Node is missing, and looks nothing up", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { missing: ["git", "npm"] });
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "error");
  assert.match(status.message, /git, npm were not found\. Install git and Node\.js/);
  assert.equal(tools.calls.some((call) => call.startsWith("git ls-remote")), false);
});

test("Dev offers the newest merged change when it is not the one running, read with git, not GitHub's web API", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "available");
  assert.equal(status.message, "A newer Dev build (change aaaaaaa) can be built and installed.");
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/${repo}.git refs/heads/${devBranch}`));
  const same = await updater(where, fakeTools(where, { head: OLD })).check();
  assert.equal(same.phase, "current");
  assert.equal(same.message, "You have the newest Dev build (change bbbbbbb).");
});

test("installing a Dev build clones, resets to the exact change, installs, builds, and hands over the built app", async (t) => {
  const where = await folders(t), tools = fakeTools(where), checked = [];
  const dev = updater(where, tools, { currentVersion: "0.19.4-beta.9", canary: async (_dir, version) => { checked.push(version); } });
  await dev.check();
  const { script, stagedDir } = await dev.install();
  assert.deepEqual(checked, [BUILT], "the new version's check expects the version the source was built as, not the running one");
  const build = tools.calls.filter((call) => !call.endsWith("--version") && !call.startsWith("git ls-remote"));
  assert.deepEqual(build, [
    `git clone --no-tags --single-branch --branch ${devBranch} https://github.com/${repo}.git ${where.sourceDir}`,
    `git reset --hard ${NEW}`, "git clean -fdx -e node_modules", "git rev-parse HEAD", `git merge-base ${OLD} ${NEW}`,
    "npm ci --no-audit --no-fund", `git show -s --format=%ct ${NEW}`, "npm run package:desktop -- --release",
  ]);
  const lock = JSON.parse(await readFile(join(where.sourceDir, "package-lock.json"), "utf8"));
  assert.deepEqual([lock.version, lock.packages[""].version], [BUILT, BUILT], "stamped like Beta: the package and its lockfile agree");
  assert.equal(dev.status.release.latestVersion, BUILT, "the update's record and the next start expect the built version");
  assert.match(await readFile(script, "utf8"), /robocopy/i, "the same hand-over as a downloaded release");
  assert.ok((await readdir(stagedDir)).includes(exe));
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", "nothing is swapped until the hand-over runs");
  const again = fakeTools(where);
  await updater(where, again).install();
  assert.ok(again.calls.some((call) => call.startsWith(`git fetch --no-tags origin ${devBranch}`)), "the next build fetches into the same clone");
  assert.equal(again.calls.some((call) => call.startsWith("git clone")), false);
});

test("a Dev build that fails, lands on another change, or comes out incomplete changes nothing", async (t) => {
  for (const [name, options, words] of [
    ["npm ci fails", { failOn: "npm ci" }, /npm ci did not finish/],
    ["the source is not the change looked up", { headAfterReset: OLD }, /did not arrive at the change that was looked up/],
    ["the build's checksum does not match", { tamper: true }, /came out incomplete/],
    ["the newest change does not contain the running one", { shared: "c".repeat(40) }, /does not include the version running now \(change bbbbbbb\), so installing it would go back/],
  ]) {
    const where = await folders(t), tools = fakeTools(where, options);
    const dev = updater(where, tools);
    await dev.check();
    await assert.rejects(dev.install(), words, name);
    assert.equal(dev.status.phase, "error", name);
    assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", name);
  }
});

test("Dev looks every five minutes and never builds and restarts by itself", () => {
  const saved = (releaseChannel) => ({ get: (table, _owner, key) =>
    (table === "settings" && key === "comfort-notify" ? { data: { autoUpdate: "install", releaseChannel } } : undefined) });
  const facts = { busyTasks: 0, updaterPhase: "available", now: new Date() };
  assert.equal(updatePlan(saved("beta"), "local", facts).step, "install", "the control: Beta with the same facts installs");
  assert.notEqual(updatePlan(saved("dev"), "local", facts).step, "install", "an available Dev build is only offered");
  assert.equal(betaCheckEveryMs, 5 * 60 * 1000);
});

test("every packaged build records the change it was made from", () => {
  assert.equal(buildInfo({ GITHUB_SHA: NEW }, () => "").commit, NEW);
  assert.equal(buildInfo({}, () => `${OLD}\n`).commit, OLD);
  assert.equal(buildInfo({}, () => "not a commit").commit, null);
});

test("each Dev build has its own version: later changes sort higher, and above the same line's Beta", async () => {
  const { compareVersions } = await import("../dist/desktop/updater.js");
  assert.equal(compareVersions(`0.19.3-dev.${COMMITTED + 60}`, BUILT), 1);
  assert.equal(compareVersions(BUILT, "0.19.3-beta.999"), 1, "switching back to Beta never offers the same line's older builds");
  assert.equal(compareVersions("0.19.3", BUILT), 1, "the Stable release of that line is newer than any of its Dev builds");
});

test("a running change the clone has never heard of cannot be compared, so the build goes on", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { shared: null });
  const dev = updater(where, tools);
  await dev.check();
  await dev.install();
  assert.ok(tools.calls.includes("npm run package:desktop -- --release"));
});

test("the build never sees the running app's own switches, and never waits on a password prompt", () => {
  const env = buildEnv({ PATH: "/usr/bin", HOME: "/Users/me", BRANCH_DATA_DIR: "/data", BRANCH_MOBILE_OUT: "/x", ELECTRON_RUN_AS_NODE: "1" }, "darwin");
  assert.deepEqual(Object.keys(env).filter((key) => /^(BRANCH|ELECTRON)_/.test(key)), []);
  assert.equal(env.HOME, "/Users/me");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  assert.equal(buildEnv({ Path: "C:/x" }, "win32").GCM_INTERACTIVE, "never");
});
