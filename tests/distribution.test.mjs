import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { applyDistribution, parseDistribution } from "../dist/distribution.js";
import { restoreConnections, savedConnections } from "../dist/connections-preset.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Store } from "../dist/store.js";
import { unixLayout } from "../dist/install/unix-install.js";
import { unixInstall } from "../dist/install/unix-install-cli.js";
import { databaseName } from "../dist/install/layout.js";

/**
 * FQ-operations.distribution: a custom distribution's branding and preset model connections
 * (src/distribution.ts). Reuses two settings the owner already edits by hand — the assistant's
 * display name (src/identity.ts) and saved model connections (src/connections-preset.ts) — so a
 * preset arrives exactly where "Settings, Add a connection" would have put it, and shows up in the
 * running app's own state on first launch. No key ever travels this way (only "ollama", a local,
 * keyless service in the shipped catalog, can actually answer without one being added afterwards).
 */
const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-distribution-"));
  // A generous retry budget: this machine runs several agents' test suites at once, and a closed
  // sqlite handle can take longer than temp-dir.mjs's default 600ms to let go under that load.
  t.after(() => discardTemp(root, { tries: 40, pause: 150 }));
  return root;
}

function scripted(name) {
  return { name, async complete() { return { content: `${name} answered`, toolCalls: [] }; } };
}

test("parseDistribution: a strict shape, branding and preset providers, never a key", () => {
  const dist = parseDistribution({
    format: "branch-agent-distribution", version: 1,
    branding: { name: "Acme Assistant" },
    providers: [{ id: "local-llama", provider: "ollama", model: "llama3" }],
  });
  assert.equal(dist.branding.name, "Acme Assistant");
  assert.equal(dist.providers[0].id, "local-llama");
  assert.throws(() => parseDistribution({ format: "wrong-format", version: 1 }));
  assert.throws(() => parseDistribution({
    format: "branch-agent-distribution", version: 1,
    providers: [{ id: "x", provider: "ollama", model: "m", apiKey: "sk-secret" }],
  }), "a key is never an accepted field");
});

test("applyDistribution: branding names the assistant once, never over an owner's own choice", () => {
  const store = new Store(":memory:"), owner = "local";
  const dist = parseDistribution({ format: "branch-agent-distribution", version: 1, branding: { name: "Acme Assistant" } });
  const lines = applyDistribution(store, owner, dist);
  assert.match(lines.join("\n"), /now named "Acme Assistant"/);
  assert.equal(store.get("settings", owner, "assistant-identity").data.name, "Acme Assistant");
  // An owner who has since renamed the assistant is never overwritten by a later distribution step.
  const again = applyDistribution(store, owner, parseDistribution({ format: "branch-agent-distribution", version: 1, branding: { name: "Someone Else's Brand" } }));
  assert.match(again.join("\n"), /already named "Acme Assistant".*not applied/);
  store.close();
});

test("applyDistribution: a preset provider is saved the way Settings saves one, and answers on the next launch", async () => {
  const store = new Store(":memory:"), owner = "local";
  store.openLocker({ key: async () => Buffer.alloc(32, 7) });
  const models = new ModelRouter(store, [{ id: "a", name: "A", provider: scripted("a"), model: "a-1" }]);
  const dist = parseDistribution({
    format: "branch-agent-distribution", version: 1,
    branding: { name: "Acme Assistant" },
    providers: [{ id: "local-llama", provider: "ollama", model: "llama3" }],
  });
  const lines = applyDistribution(store, owner, dist);
  assert.match(lines.join("\n"), /1 preset provider connection\(s\) were brought in: local-llama.*Add a key/s);
  assert.deepEqual(savedConnections(store, owner).map((c) => c.id), ["local-llama"]);
  assert.equal(models.presets.has("local-llama"), false, "writing the distribution's record never touches the running model list by itself");
  // The next launch rebuilds the model list from what was written down — the exact step
  // src/index.ts runs at every startup (restoreConnections), never the distribution step again.
  const restored = await restoreConnections({ models, locker: store.locker, owner, policy: new NetworkPolicy({}), store });
  assert.deepEqual(restored, ["local-llama"]);
  assert.ok(models.presets.has("local-llama"), "the saved connection came back on its own, with no key");
  const summary = models.summary(owner);
  assert.ok(summary.presets.some((preset) => preset.id === "local-llama" && preset.model === "llama3"), "the window's own model summary already lists it");
  // A second distribution apply never replaces a connection already set up, known or not.
  const repeat = applyDistribution(store, owner, parseDistribution({
    format: "branch-agent-distribution", version: 1,
    providers: [{ id: "local-llama", provider: "ollama", model: "a-different-model" }, { id: "x", provider: "not-a-real-service", model: "m" }],
  }));
  assert.match(repeat.join("\n"), /No preset provider .* was brought in/);
  assert.deepEqual(savedConnections(store, owner)[0].model, "llama3", "the first preset's model was not overwritten");
  store.close();
});

async function fakeApp(root) {
  const app = join(root, "Branch-Agent-linux-x64");
  const program = join(app, "branch-agent");
  const resources = join(app, "resources", "app");
  await mkdir(join(resources, "dist", "install"), { recursive: true });
  await writeFile(program, "#!/bin/sh\nexit 0\n");
  await chmod(program, 0o755);
  await writeFile(join(resources, "package.json"), JSON.stringify({ name: "branch-agent", version: "1.0.0" }));
  await writeFile(join(resources, "dist", "install", "install-cli.js"), "");
  await writeFile(join(app, "branch-agent.desktop"), "[Desktop Entry]\nName=Branch Agent\nExec=\"branch-agent\" %U\nIcon=branch-agent.png\n");
  return app;
}

test("a custom distribution: a distribution file beside the installer is brought in on a fresh install only", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  const distribution = join(root, "team.branch-distribution.json");
  await writeFile(distribution, JSON.stringify({ format: "branch-agent-distribution", version: 1, branding: { name: "Acme Assistant" } }));
  const ran = [], lines = [];
  const runBranch = async (launcher, args) => { ran.push([launcher, ...args]); };
  const source = await fakeApp(join(root, "v1"));
  await assert.rejects(unixInstall(["--source", source, "--distribution", join(root, "missing")], layout, () => {}, runBranch),
    /was not found, so nothing was installed/);
  await unixInstall(["--source", source, "--distribution", distribution], layout, (line) => lines.push(line), runBranch);
  assert.deepEqual(ran, [[layout.launcher, "apply-distribution", distribution]]);
  assert.match(lines.join("\n"), /Branch Agent 1\.0\.0 is installed in .*The distribution in .* was brought in/s);
  await writeFile(join(layout.dataDir, databaseName), "somebody's work");
  await unixInstall(["--source", source, "--distribution", distribution], layout, (line) => lines.push(line), runBranch);
  assert.equal(ran.length, 1, "a distribution that is already set up on this computer is never replaced");
  assert.match(lines.join("\n"), /already installed .* linked up again.*already set up on this computer/s);
});

test("--assistant and --distribution together both run, and both skip together once the computer is set up", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  const assistant = join(root, "team.branch-agent");
  const distribution = join(root, "team.branch-distribution.json");
  await writeFile(assistant, "pretend export");
  await writeFile(distribution, JSON.stringify({ format: "branch-agent-distribution", version: 1, branding: { name: "Acme Assistant" } }));
  const ran = [];
  const runBranch = async (launcher, args) => { ran.push(args[0]); };
  const source = await fakeApp(join(root, "v1"));
  await unixInstall(["--source", source, "--assistant", assistant, "--distribution", distribution], layout, () => {}, runBranch);
  assert.deepEqual(ran, ["import-agent", "apply-distribution"]);
});
