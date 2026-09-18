/**
 * mac7/one-click (issue #107): the one button that installs the program that runs the models.
 *
 * Every program, file system and network call here is a stand-in. Nothing is installed on this
 * computer, `brew`, `winget`, `ollama` and every installer are never called, no model is
 * downloaded, and no window is opened. The tests assert the exact commands that would have run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Store } from "../dist/store.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { RuntimeLauncher } from "../dist/local-launch.js";
import { OneClick } from "../dist/local-oneclick.js";
import { saveLocalModelsMode, stages } from "../dist/local-jobs.js";
import { setLockdown } from "../dist/lockdown.js";
import { underShortLivedKey } from "../dist/key-context.js";
import {
  checksumFor, detectTools, fetchInstaller, installPlan, isInstallable, planFingerprint, planSize, runInstall,
} from "../dist/local-install.js";
import {
  installChatRefusal, installGuard, installLockdownRefusal, installOffRefusal, installShortLivedRefusal,
  installTrunkRefusal, oneButtonMode, saveOneButtonMode, sizeChoices,
} from "../dist/local-one-button.js";

const GB = 1024 ** 3;
const at = {
  darwin: { platform: "darwin", arch: "arm64", home: "/Users/sam", env: { PATH: "/usr/bin" } },
  linux: { platform: "linux", arch: "x64", home: "/home/sam", env: { PATH: "/usr/bin" } },
  win32: { platform: "win32", arch: "x64", home: "C:\\Users\\sam", env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } },
};
const noTools = { homebrew: null, winget: null };
const room = (over = {}) => ({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 20 * GB, graphicsLimitBytes: null, cores: 10,
  graphics: { name: "Apple M4", memoryBytes: null, sharedMemory: true }, summary: "", ...over });

async function scratch(label) {
  const base = join(tmpdir(), "branch-session-files");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `branch-${label}-`));
}

/* ------------------------------------------------------------------ the plan, on every system */

test("I1 each system is installed its own way, and every command is an argument list", () => {
  const brewOllama = installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null });
  assert.equal(brewOllama.via, "homebrew");
  assert.deepEqual(brewOllama.steps.map((step) => step.command), [["/opt/homebrew/bin/brew", "install", "ollama"]]);
  const brewStudio = installPlan("lm-studio", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null });
  assert.deepEqual(brewStudio.steps.map((step) => step.command), [["/opt/homebrew/bin/brew", "install", "--cask", "lm-studio"]]);
  assert.match(brewStudio.after, /Open LM Studio once/);

  const winget = "C:\\Users\\sam\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
  const wingetOllama = installPlan("ollama", at.win32, { homebrew: null, winget });
  assert.equal(wingetOllama.via, "winget");
  assert.deepEqual(wingetOllama.steps[0].command,
    [winget, "install", "--id", "Ollama.Ollama", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
  assert.equal(installPlan("lm-studio", at.win32, { homebrew: null, winget }).steps[0].command[3], "ElementLabs.LMStudio");

  const mac = installPlan("ollama", at.darwin, noTools);
  assert.equal(mac.via, "download");
  assert.deepEqual(mac.steps.map((step) => step.command), [
    ["/usr/bin/ditto", "-x", "-k", "{file}", "{unpacked}"],
    ["/usr/bin/codesign", "--verify", "--strict", "--deep", "{unpacked}/Ollama.app"],
    ["/usr/sbin/spctl", "--assess", "--type", "execute", "{unpacked}/Ollama.app"],
    ["/usr/bin/ditto", "{unpacked}/Ollama.app", "/Applications/Ollama.app"],
  ]);
  const linux = installPlan("ollama", at.linux, noTools);
  assert.deepEqual(linux.steps.map((step) => step.command), [["/bin/sh", "{file}"]], "the script is saved and run, never piped");
  assert.deepEqual(installPlan("ollama", at.win32, noTools).steps.map((step) => step.command), [["{file}"]]);

  for (const plan of [brewOllama, brewStudio, wingetOllama, mac, linux]) {
    for (const step of plan.steps) {
      assert.ok(Array.isArray(step.command) && step.command.length > 0);
      for (const part of step.command) assert.doesNotMatch(part, /[|&;><`$\n]/, `${part} looks like a shell line`);
    }
    assert.ok(plan.verify.length > 20, "every plan says how the download is checked");
  }
});

test("I2 what Branch cannot install safely it refuses, in plain words, with where to get it", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const plan = installPlan("lm-studio", at[platform], noTools);
    assert.equal(plan.via, "none");
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.fetch, null);
    assert.match(plan.instead, /lmstudio\.ai/);
  }
  assert.equal(isInstallable("llama-cpp"), false, "llama.cpp and MLX are never installed by Branch");
  assert.equal(isInstallable("mlx"), false);
  assert.equal(isInstallable("ollama"), true);
});

test("I3 a yes only ever agrees to the plan that was shown", () => {
  const mac = installPlan("ollama", at.darwin, noTools);
  const linux = installPlan("ollama", at.linux, noTools);
  assert.match(mac.fingerprint, /^[a-f0-9]{32}$/);
  assert.notEqual(mac.fingerprint, linux.fingerprint);
  assert.equal(planFingerprint(mac), mac.fingerprint, "the line is the plan's own facts, nothing else");
  const meddled = { ...mac, steps: [{ what: "x", command: ["/bin/sh", "-c", "curl x | sh"] }] };
  assert.notEqual(planFingerprint(meddled), mac.fingerprint);
  assert.match(planSize(mac), /GB$/);
  assert.match(planSize(installPlan("ollama", at.linux, noTools)), /MB$/);
});

test("I4 Homebrew and winget are looked for only where they really live", async () => {
  const seen = [];
  const exists = async (path) => { seen.push(path); return path === "/opt/homebrew/bin/brew"; };
  assert.deepEqual(await detectTools(at.darwin, exists), { homebrew: "/opt/homebrew/bin/brew", winget: null });
  assert.deepEqual(seen, ["/opt/homebrew/bin/brew"]);
  assert.deepEqual(await detectTools(at.linux, async () => false), { homebrew: null, winget: null });
  const win = await detectTools(at.win32, async (path) => path.endsWith("winget.exe"));
  assert.equal(win.winget, "C:\\Users\\sam\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe");
  assert.equal(win.homebrew, null);
});

/* ------------------------------------------------------------------ the download and its check */

test("I5 the publisher's checksum decides: a file that does not match is thrown away", async (t) => {
  const root = await scratch("install");
  t.after(async () => { await discardTemp(root); });
  const body = Buffer.from("#!/bin/sh\necho hello\n");
  const good = createHash("sha256").update(body).digest("hex");
  const list = `${good}  ./install.sh\n0000000000000000000000000000000000000000000000000000000000000000  ./other.zip\n`;
  assert.equal(checksumFor(list, "install.sh"), good);
  assert.throws(() => checksumFor(list, "missing.zip"), /not in the list of checksums/);

  const plan = installPlan("ollama", at.linux, noTools);
  const asked = [];
  const library = async (url) => {
    asked.push(url);
    if (url.endsWith("sha256sum.txt")) return new Response(list);
    return new Response(body, { headers: { "content-length": String(body.length) } });
  };
  const deps = { at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library, scratchDir: join(root, "dl") };
  const file = await fetchInstaller(plan, deps);
  assert.ok(file.endsWith("install.sh"));
  assert.ok(asked[0].endsWith("sha256sum.txt"), "the checksum is read before the file");

  const wrong = async (url) => url.endsWith("sha256sum.txt")
    ? new Response(`${"a".repeat(64)}  ./install.sh\n`) : new Response(body);
  await assert.rejects(fetchInstaller(plan, { ...deps, library: wrong, scratchDir: join(root, "bad") }),
    /did not match the checksum its publisher published/);
  assert.deepEqual(await readdir(join(root, "bad")), [], "nothing is left behind when it does not match");
});

test("I6 nothing is ever fetched from anywhere but the publisher", async (t) => {
  const root = await scratch("install-host");
  t.after(async () => { await discardTemp(root); });
  const plan = installPlan("ollama", at.linux, noTools);
  const elsewhere = { ...plan, fetch: { ...plan.fetch, checksums: "https://example.invalid/sha256sum.txt" } };
  await assert.rejects(fetchInstaller(elsewhere, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false,
    library: async () => { throw new Error("a test must never reach the internet"); }, scratchDir: join(root, "dl"),
  }), /only ever downloaded from its own publisher/);

  const redirected = async (url) => url.endsWith("sha256sum.txt")
    ? new Response(null, { status: 302, headers: { location: "http://ollama.com/plain" } }) : new Response("x");
  await assert.rejects(fetchInstaller(plan, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library: redirected, scratchDir: join(root, "dl2"),
  }), /only ever downloaded from its own publisher/, "a redirect off https is refused too");
});

test("I6b a real release redirect is followed: GitHub's signed asset address is ~900 characters", async (t) => {
  // Found on a real Ubuntu box: github.com sends a release download on to
  // release-assets.githubusercontent.com with a signed address about 900 characters long. A cap of
  // 400 refused it, so the whole download path — Linux, and a Mac or Windows with no package
  // manager — could never install anything. The cap stays, because an address is still bounded
  // input; it is just no longer shorter than the publisher's own.
  const root = await scratch("install-redirect");
  t.after(async () => { await discardTemp(root); });
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const sum = createHash("sha256").update(body).digest("hex");
  const signed = (name) =>
    `https://release-assets.githubusercontent.com/github-production-release-asset/658928958/${"a".repeat(40)}`
    + `?sp=r&sv=2018-11-09&sr=b&rscd=attachment%3B+filename%3D${name}&sig=${"b".repeat(60)}&jwt=${"c".repeat(600)}`;
  assert.ok(signed("install.sh").length > 700, "the stand-in is as long as the real thing");
  const library = async (url) => {
    if (url.startsWith("https://github.com/"))
      return new Response(null, { status: 302, headers: { location: signed(url.split("/").pop()) } });
    return new Response(url.includes("sha256sum.txt") ? `${sum}  ./install.sh\n` : body);
  };
  const plan = installPlan("ollama", at.linux, noTools);
  const file = await fetchInstaller(plan, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library, scratchDir: join(root, "dl"),
  });
  assert.ok(file.endsWith("install.sh"));

  // Still bounded, and still only the publisher's own hosts.
  const tooLong = async () => new Response(null, { status: 302, headers: { location: signed("x") + "d".repeat(4000) } });
  await assert.rejects(fetchInstaller(plan, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library: tooLong, scratchDir: join(root, "dl2"),
  }), /only ever downloaded from its own publisher/);
});

test("I7 a step that fails stops the rest and is reported honestly", async (t) => {
  const root = await scratch("install-run");
  t.after(async () => { await discardTemp(root); });
  const plan = installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null });
  const ran = [];
  const ok = await runInstall(plan, {
    at: at.darwin, exists: async () => true, library: async () => { throw new Error("no internet"); }, scratchDir: join(root, "x"),
    run: async (file, args) => { ran.push([file, ...args]); return { stdout: "" }; },
  });
  assert.deepEqual(ran, [["/opt/homebrew/bin/brew", "install", "ollama"]]);
  assert.equal(ok.installed, true);

  const failed = await runInstall(plan, {
    at: at.darwin, exists: async () => true, library: async () => { throw new Error("no internet"); }, scratchDir: join(root, "x"),
    run: async () => { throw Object.assign(new Error("exit 1"), { stderr: "No such keg" }); },
  });
  assert.equal(failed.installed, false);
  assert.match(failed.message, /could not install Ollama/);
  assert.match(failed.message, /No such keg/);
  assert.match(failed.message, /Nothing was left half-installed/);

  const refused = await runInstall(installPlan("lm-studio", at.linux, noTools), {
    at: at.linux, exists: async () => true, library: async () => { throw new Error("no"); }, scratchDir: join(root, "x"),
    run: async () => { throw new Error("a refused plan must run nothing"); },
  });
  assert.equal(refused.installed, false);
  assert.deepEqual(refused.ran, []);
});

/* ------------------------------------------------------------------ the switch and who may press */

async function world(t, { mode = "when-needed", install = "when-needed", programs = [], library } = {}) {
  const root = await scratch("button");
  const store = new Store(join(root, "branch.sqlite"));
  if (mode) saveLocalModelsMode(store, "owner", { mode });
  if (install) saveOneButtonMode(store, "owner", { mode: install });
  const here = [...programs];
  const ran = [];
  const launcher = new RuntimeLauncher({
    at: at.darwin,
    exists: async (path) => here.some((name) => path.endsWith(name)),
    run: async (file, args) => { ran.push([file, ...args]); return { stdout: "" }; },
    spawn: () => ({ pid: 1, stop: () => {} }),
    freePort: async () => 48081,
  });
  const models = new ModelRouter(store, [{ id: "demo", name: "Demo", provider: { name: "demo", complete: async () => ({ content: "", toolCalls: [] }) }, model: "demo" }]);
  const deps = {
    store, owner: "owner", models, policy: new NetworkPolicy({}), dataDir: join(root, "data"), launcher,
    fetch: async () => { throw new TypeError("fetch failed"); },
    library: library ?? (async () => { throw new Error("no internet in tests"); }),
    room: async () => room(), statfs: async () => ({ bavail: 200, bsize: GB }), sleep: async () => {},
  };
  const oneClick = new OneClick(deps);
  // One hook, in the order Node runs them: stop the setups and let them write their last line, then
  // close the database, then remove the folder. Closing first would fail on Windows every time.
  t.after(async () => {
    oneClick.closeAll();
    for (let tries = 0; tries < 300 && oneClick.jobs.unfinished().length; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    store.close();
    await discardTemp(root);
  });
  return { store, root, here, ran, oneClick };
}

test("I8 the switch ships off, and Lockdown holds it off whatever is saved", async (t) => {
  const w = await world(t, { install: null });
  assert.equal(oneButtonMode(w.store, "owner"), "off");
  assert.equal(installGuard(w.store, "owner", {}), installOffRefusal);
  saveOneButtonMode(w.store, "owner", { mode: "when-needed" });
  assert.equal(installGuard(w.store, "owner", {}), null);
  setLockdown(w.store, "owner", { on: true });
  assert.equal(oneButtonMode(w.store, "owner"), "off");
  assert.equal(installGuard(w.store, "owner", {}), installLockdownRefusal);
  setLockdown(w.store, "owner", { on: false });
  assert.equal(installGuard(w.store, "owner", {}), null);
});

test("I9 it is the owner's alone: a chat, a key, another computer, a Trunk and a schedule are refused", async (t) => {
  const w = await world(t);
  assert.equal(installGuard(w.store, "owner", { source: "channel" }), installChatRefusal);
  assert.equal(installGuard(w.store, "owner", { trunkKeys: {} }), installTrunkRefusal);
  assert.match(installGuard(w.store, "owner", { source: "schedule" }), /Only work you started yourself/);
  assert.equal(underShortLivedKey(() => installGuard(w.store, "owner", {})), installShortLivedRefusal);
  assert.equal(installGuard(w.store, "owner", {}, "person-7"), "Installing a program on this computer belongs to the owner. Switch back to the owner's profile to do it.");
  assert.equal(installGuard(w.store, "owner", {}), null, "the owner in the app window may");
});

test("I10 three sizes are offered, all able to use tools, with plain words and a suggestion", () => {
  const roomy = sizeChoices(room({ freeMemoryBytes: 40 * GB, totalMemoryBytes: 64 * GB }), "ollama");
  assert.equal(roomy.choices.length, 3);
  assert.deepEqual(roomy.choices.map((one) => one.size), ["small", "medium", "large"]);
  for (const choice of roomy.choices) {
    assert.equal(choice.tools, true, "a model that cannot use tools can only talk, so it is not offered");
    assert.ok(choice.guidance.length > 40, "each size says what it means here");
    assert.ok(choice.downloadBytes > 0);
  }
  const sorted = roomy.choices.map((one) => one.downloadBytes);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b), "small to large");
  assert.equal(roomy.recommended.fit, "well", "the suggestion is one that fits comfortably");
  const tiny = sizeChoices(room({ freeMemoryBytes: 2 * GB, totalMemoryBytes: 4 * GB }), "ollama");
  assert.ok(tiny.choices.length >= 1);
  assert.ok(tiny.recommended, "a small computer is still offered the smallest one");
});

/* ------------------------------------------------------------------ the button itself */

test("I11 the button installs nothing until the owner agrees to the exact plan it showed", async (t) => {
  const w = await world(t);
  const view = await w.oneClick.buttonPlan({});
  assert.equal(view.runner, "ollama");
  assert.equal(view.alreadyInstalled, false);
  assert.equal(view.install.via, "download", "no Homebrew in this stand-in world");
  assert.equal(view.refusal, null);
  assert.equal(view.choices.length, 3);

  const asked = await w.oneClick.buttonGo({ size: "small" });
  assert.equal(asked.needsAgreement.fingerprint, view.install.fingerprint);
  assert.match(asked.message, /press the button again/);
  assert.deepEqual(w.ran, [], "nothing at all was run");

  const stale = await w.oneClick.buttonGo({ size: "small", agreedPlan: "0".repeat(32) });
  assert.match(stale.message, /has changed since you looked/);
  assert.deepEqual(w.ran, []);
});

test("I12 after installing, Branch checks the program really arrived rather than claiming success", async (t) => {
  const body = Buffer.from("#!/bin/sh\ntrue\n");
  const sum = createHash("sha256").update(body).digest("hex");
  // A stand-in publisher: the checksum matches, and the "installer" does nothing at all.
  const library = async (url) => String(url).endsWith("sha256sum.txt")
    ? new Response(`${sum}  ./Ollama-darwin.zip\n`)
    : new Response(body, { headers: { "content-length": String(body.length) } });
  const w = await world(t, { programs: [], library });
  const view = await w.oneClick.buttonPlan({});
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan: view.install.fingerprint }),
    /still is not on this computer/, "a half-install is never called a success");
  const scratch = join(w.root, "data", "local-installers");
  assert.deepEqual(w.ran, [
    ["/usr/bin/ditto", "-x", "-k", join(scratch, "Ollama-darwin.zip"), join(scratch, "unpacked")],
    ["/usr/bin/codesign", "--verify", "--strict", "--deep", `${join(scratch, "unpacked")}/Ollama.app`],
    ["/usr/sbin/spctl", "--assess", "--type", "execute", `${join(scratch, "unpacked")}/Ollama.app`],
    ["/usr/bin/ditto", `${join(scratch, "unpacked")}/Ollama.app`, "/Applications/Ollama.app"],
  ], "the exact commands, with the downloaded file and the unpacked folder filled in under Branch's own folder");
  for (const command of w.ran) for (const part of command) assert.doesNotMatch(part, /[{}]/, "nothing is left unfilled");
});

test("I12b a program macOS does not accept is never put in Applications", async (t) => {
  const body = Buffer.from("not really a program");
  const sum = createHash("sha256").update(body).digest("hex");
  const library = async (url) => String(url).endsWith("sha256sum.txt")
    ? new Response(`${sum}  ./Ollama-darwin.zip\n`)
    : new Response(body, { headers: { "content-length": String(body.length) } });
  const root = await scratch("install-signature");
  t.after(async () => { await discardTemp(root); });
  const ran = [];
  const outcome = await runInstall(installPlan("ollama", at.darwin, noTools), {
    at: at.darwin, exists: async () => false, library, scratchDir: join(root, "dl"),
    run: async (file, args) => {
      ran.push([file, ...args]);
      if (file === "/usr/sbin/spctl") throw Object.assign(new Error("exit 3"), { stderr: "rejected: source=no usable signature" });
      return { stdout: "" };
    },
  });
  assert.equal(outcome.installed, false);
  assert.match(outcome.message, /Check the signature|Check macOS accepts it/, "the message names the step that stopped it");
  assert.match(outcome.message, /no usable signature/);
  assert.equal(ran.length, 3, "it stopped at the check");
  assert.equal(ran.some((command) => command.includes("/Applications/Ollama.app")), false,
    "nothing an unsigned download unpacked ever reaches Applications");
});

test("I13 with the program already there the button goes straight to the model, and says so", async (t) => {
  const w = await world(t, { programs: ["/opt/homebrew/bin/ollama"] });
  const view = await w.oneClick.buttonPlan({});
  assert.equal(view.alreadyInstalled, true);
  assert.equal(view.install, null, "nothing would be installed, so nothing is proposed");
  const answer = await w.oneClick.buttonGo({ size: "small" });
  assert.equal(answer.runner, "ollama");
  assert.ok(answer.chose, "it chose a size");
  assert.match(answer.message, /Setting up/);
  assert.deepEqual(w.ran, [], "nothing was installed: the program was already there");
});

test("I14 a short-lived key can neither flip the switch nor press the button", async () => {
  const { offLimitsToShortLivedKeys } = await import("../dist/server.js");
  assert.ok(stages.includes("installing"), "a setup can say it is installing the program");
  for (const path of ["/api/local-models/install/switch", "/api/local-models/one-button", "/api/local-models/one-button/plan"])
    assert.match(offLimitsToShortLivedKeys("POST", path), /short-lived key cannot/, path);
  assert.match(offLimitsToShortLivedKeys("POST", "/api/local-models/setup"), /short-lived key cannot/, "the older routes still are");
});
