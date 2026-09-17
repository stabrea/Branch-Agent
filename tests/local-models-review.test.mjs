/**
 * Wave mac5 integration review (adversarial pass) of one-click local models. Every program, disk,
 * memory reader and network call is a stand-in: nothing is installed, started or downloaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Store } from "../dist/store.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { readGraphicsCard, useGraphicsReader } from "../dist/local-hardware.js";
import { useMemoryReaders } from "../dist/local-fit.js";
import { RuntimeLauncher, candidatePaths, runtimeChildEnv } from "../dist/local-launch.js";
import { downloadFile, modelsFolder, resolveUrl } from "../dist/local-files.js";
import { localRuntimeFetch } from "../dist/local-policy.js";
import { restoreLocalConnections } from "../dist/local-connections.js";
import { saveLocalModelsMode } from "../dist/local-jobs.js";
import { OneClick } from "../dist/local-oneclick.js";
import { LocalManager } from "../dist/local-manage.js";
import { localModelsApi } from "../dist/local-models-api.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const GB = 1024 ** 3;
const mac = { platform: "darwin", arch: "arm64", home: "/Users/sam", env: { PATH: "/usr/bin" } };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
async function scratch(t, label) {
  const base = join(tmpdir(), "branch-session-files");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `branch-${label}-`));
  return root;
}
const demoModels = (store) => new ModelRouter(store, [{ id: "demo", name: "Demo", provider: { name: "demo", complete: async () => ({ content: "", toolCalls: [] }) }, model: "demo" }]);
const ask = (provider) => provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 4, signal: AbortSignal.timeout(2000) });

test("V1 a short-lived key can look at local models but never switch them on, download, start or delete", async (t) => {
  useGraphicsReader(async () => ({ name: "Stand-in", memoryBytes: 8 * GB }));
  useMemoryReaders({ platform: "linux", readText: async () => "MemAvailable: 8388608 kB\n", run: async () => { throw new Error("no programs in tests"); } });
  t.after(() => { useGraphicsReader(() => readGraphicsCard()); useMemoryReaders(null); });
  const paths = [
    ["/api/local-models/switch", { mode: "on" }], ["/api/local-models/setup", { model: "qwen3-8b", quant: "Q4_K_M" }],
    ["/api/local-models/runtime/start", { runtime: "ollama" }], ["/api/local-models/pull", { model: "llama3.2:3b" }],
    ["/api/local-models/delete", { runtime: "llama-cpp", id: "x.gguf" }], ["/api/local-models/remove", { model: "llama3.2:3b" }],
  ];
  // Several refusals in a row trip the sign-in limiter, so each pair of paths gets its own Branch.
  for (let at = 0; at < paths.length; at += 2) {
    const root = await scratch(t, "local-keys");
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
    try {
      for (const scope of ["run", "read"]) {
        const key = app.sessionTokens.create(app.runtime.owner, { scope, minutes: 5 });
        const headers = { authorization: `Bearer ${key.token}`, "content-type": "application/json" };
        if (at === 0) assert.equal((await fetch(`${server.url}/api/local-models/downloads`, { headers })).status, 200, `a ${scope} key may look`);
        for (const [path, body] of paths.slice(at, at + 2)) {
          const refused = await fetch(`${server.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
          assert.equal(refused.status, 401, `a ${scope} key may not use ${path}`);
          assert.match((await refused.json()).error, /short-lived key cannot/, path);
        }
      }
      assert.equal(app.store.get("settings", app.runtime.owner, "local-models"), undefined, "the switch was never touched");
    } finally { await server.close(); await app.close(); await discardTemp(root); }
  }
});

test("V2 with the switch off the older Ollama routes behave as before", async (t) => {
  const root = await scratch(t, "local-off");
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  const pulled = [];
  const runtimes = { start: (model) => { pulled.push(model); return { started: model }; }, stop: () => ({}), remove: () => ({}), lmStudio: { load: () => ({}) } };
  const deps = { runtimes, store, models: demoModels(store), owner: "owner" };
  assert.deepEqual(await localModelsApi(deps, "POST", "/api/local-models/pull", async () => ({ model: "llama3.2:3b" })), { started: "llama3.2:3b" });
  assert.deepEqual(pulled, ["llama3.2:3b"]);
  await assert.rejects(() => localModelsApi(deps, "POST", "/api/local-models/setup", async () => ({ model: "qwen3-8b", quant: "Q4_K_M" })), /not set up|switched off/);
});

test("V3 a finished file of the right size is still checked against its hash before use", async (t) => {
  const root = await scratch(t, "local-hash");
  t.after(() => discardTemp(root));
  const good = Buffer.from("real model weights ".repeat(50));
  const target = join(root, "m.gguf");
  await writeFile(target, Buffer.alloc(good.length, 7));
  const sha256 = createHash("sha256").update(good).digest("hex");
  const fetch = async () => new Response(good, { status: 200 });
  await downloadFile({ url: resolveUrl("a/b", "m.gguf"), target, bytes: good.length, sha256, fetch });
  assert.deepEqual(await readFile(target), good, "the swapped file was replaced by the published one");
});

test("V4 a resumed download only appends when the library answers from the right byte", async (t) => {
  const root = await scratch(t, "local-range");
  t.after(() => discardTemp(root));
  const good = Buffer.from("0123456789".repeat(20));
  const target = join(root, "m.gguf");
  await writeFile(`${target}.partial`, good.subarray(0, 50));
  const wrong = async () => new Response(good, { status: 206, headers: { "content-range": `bytes 0-${good.length - 1}/${good.length}` } });
  await assert.rejects(() => downloadFile({ url: resolveUrl("a/b", "m.gguf"), target, bytes: good.length, fetch: wrong }), /did not match|start the download again/);
  await assert.rejects(() => stat(target), /ENOENT/);
  const right = async (url, init) => {
    assert.equal(init.headers.range, "bytes=50-");
    return new Response(good.subarray(50), { status: 206, headers: { "content-range": `bytes 50-${good.length - 1}/${good.length}` } });
  };
  await writeFile(`${target}.partial`, good.subarray(0, 50));
  await downloadFile({ url: resolveUrl("a/b", "m.gguf"), target, bytes: good.length, fetch: right });
  assert.deepEqual(await readFile(target), good);
});

test("V5 a download never writes through a link planted where the file goes", { skip: process.platform === "win32" }, async (t) => {
  const root = await scratch(t, "local-link");
  t.after(() => discardTemp(root));
  const outside = join(root, "outside.txt");
  await writeFile(outside, "keep me");
  const target = join(root, "models", "m.gguf");
  await mkdir(join(root, "models"));
  await symlink(outside, `${target}.partial`);
  const fetch = async () => new Response(Buffer.from("x".repeat(20)), { status: 200 });
  await assert.rejects(() => downloadFile({ url: resolveUrl("a/b", "m.gguf"), target, bytes: 27, fetch }), /link/);
  assert.equal(await readFile(outside, "utf8"), "keep me");
});

test("V6 the local fetch reaches only the one runtime address it was made for", async () => {
  let reached = 0;
  const base = async () => { reached++; return json({}); };
  const guarded = localRuntimeFetch(new NetworkPolicy({}), base, "http://127.0.0.1:11434");
  await guarded("http://127.0.0.1:11434/api/tags");
  assert.equal(reached, 1);
  for (const other of ["http://127.0.0.1:3210/api/run", "http://127.0.0.1:8080/v1/models", "http://localhost:11434/api/tags",
    "http://[::1]:11434/api/tags", "http://169.254.169.254/latest/meta-data", "http://127.0.0.1:11434.evil.example/api/tags"]) {
    await assert.rejects(() => guarded(other), (error) => error instanceof Error, other);
  }
  assert.equal(reached, 1, "nothing else was contacted");
  const none = localRuntimeFetch(new NetworkPolicy({}), base, () => null);
  await assert.rejects(() => none("http://127.0.0.1:8080/v1/models"), /not running/);
  assert.equal(reached, 1);
});

test("V7 llama.cpp and MLX listen on a fresh port on this computer, and only that port is used", async () => {
  const spawned = [];
  const launcher = new RuntimeLauncher({
    at: mac, exists: async (path) => path === "/opt/homebrew/bin/llama-server", run: async () => ({ stdout: "" }),
    spawn: (file, args) => { spawned.push([file, ...args]); return { pid: 1, stop() {} }; }, freePort: async () => 49321,
  });
  assert.equal(launcher.baseUrl("llama-cpp"), null, "nothing started, so no address");
  assert.equal(launcher.baseUrl("ollama"), "http://127.0.0.1:11434");
  await launcher.start("llama-cpp", { file: "/d/m.gguf", context: 8192 });
  assert.deepEqual(spawned[0], ["/opt/homebrew/bin/llama-server", "-m", "/d/m.gguf", "-c", "8192", "--host", "127.0.0.1", "--port", "49321", "--jinja"]);
  assert.equal(launcher.baseUrl("llama-cpp"), "http://127.0.0.1:49321");
  launcher.stopAll();
  assert.equal(launcher.baseUrl("llama-cpp"), null);
});

test("V8 a llama.cpp connection brought back at start sends nothing; the owner sets the model up again", async (t) => {
  const root = await scratch(t, "local-restore");
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  store.save("settings", "owner", "local-model-connections", { connections: [{ id: "local-llama-cpp-m", name: "M (runs on this computer)", runtime: "llama-cpp", model: "/d/m.gguf", contextLength: 8192 }] });
  let reached = 0;
  const fetch = async () => { reached++; return json({ choices: [{ message: { role: "assistant", content: "stolen" } }] }); };
  const models = demoModels(store);
  restoreLocalConnections({ models, store, owner: "owner", policy: new NetworkPolicy({}), fetch, endpoint: () => null });
  await assert.rejects(() => ask(models.presets.get("local-llama-cpp-m").provider), /not running/);
  assert.equal(reached, 0, "whatever else listens on 127.0.0.1:8080 hears nothing");
});

test("V9 programs start with a clean set of variables", () => {
  const env = runtimeChildEnv({
    PATH: "/usr/bin", HOME: "/Users/sam", OLLAMA_MODELS: "/Volumes/m", LD_LIBRARY_PATH: "/usr/local/cuda/lib64",
    ANTHROPIC_API_KEY: "sk-x", OPENAI_API_KEY: "sk-y", GITHUB_TOKEN: "g", HF_TOKEN: "h", DB_PASSWORD: "p", AWS_SECRET_ACCESS_KEY: "s",
    BRANCH_DATA_DIR: "/d", BRANCH_SESSION: "t", NODE_OPTIONS: "--require /tmp/x.js", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", LD_PRELOAD: "/tmp/x.so",
  }, { OLLAMA_HOST: "127.0.0.1:11434" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LD_LIBRARY_PATH", "OLLAMA_HOST", "OLLAMA_MODELS", "PATH"]);
  assert.equal(env.OLLAMA_HOST, "127.0.0.1:11434");
});

test("V10 only whole folders on the search path are looked in, never relative ones", () => {
  const linux = { platform: "linux", arch: "x64", home: "/home/sam", env: { PATH: ".:bin:/usr/bin::node_modules/.bin" } };
  assert.deepEqual(candidatePaths("ollama", linux), ["/usr/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama"]);
  const win = { platform: "win32", arch: "x64", home: "C:\\Users\\sam", env: { Path: "C:\\Tools;.\\bin;tools", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } };
  assert.deepEqual(candidatePaths("llama-cpp", win), ["C:\\Tools\\llama-server.exe"]);
});

test("V11 Windows asks NVIDIA's tool by its full path, not by a name any folder could answer", async () => {
  const asked = [];
  const exec = async (file) => { asked.push(file); throw new Error("not here"); };
  await readGraphicsCard(exec, "win32");
  assert.match(asked[0], /^[A-Z]:\\Windows\\System32\\nvidia-smi\.exe$/i);
});

test("V12 an MLX model typed by name is refused before downloading when the disk is too full", async (t) => {
  const root = await scratch(t, "local-mlx-disk");
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  saveLocalModelsMode(store, "owner", { mode: "when-needed" });
  const downloads = [];
  const library = async (url) => {
    const text = String(url);
    if (text.endsWith("/tree/main")) return json([{ type: "file", path: "model.safetensors", size: 50 * GB, lfs: { oid: "a".repeat(64), size: 50 * GB } }, { type: "file", path: "config.json", size: 2 }]);
    downloads.push(text);
    return new Response("{}");
  };
  const launcher = new RuntimeLauncher({ at: mac, exists: async (path) => path === "/opt/homebrew/bin/mlx_lm.server", run: async () => ({ stdout: "" }), spawn: () => ({ pid: 1, stop() {} }), freePort: async () => 50000 });
  const oneClick = new OneClick({
    store, owner: "owner", models: demoModels(store), policy: new NetworkPolicy({}), fetch: async () => { throw new Error("nothing local"); },
    dataDir: join(root, "data"), launcher, library, statfs: async () => ({ bavail: 10, bsize: GB }), sleep: async () => {},
    room: async () => ({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 60 * GB, graphicsLimitBytes: null, cores: 8, graphics: null, summary: "" }),
  });
  const job = await oneClick.begin({ name: "mlx-community/Big-Model-4bit", runtime: "mlx" });
  let done = job;
  for (let i = 0; i < 400 && !done.finishedAt; i++) { await new Promise((r) => setTimeout(r, 5)); done = oneClick.jobs.get(job.id); }
  assert.equal(done.stage, "failed");
  assert.match(done.message, /Not enough disk space/);
  assert.deepEqual(downloads, [], "nothing was downloaded");
});

test("V13 removing a downloaded file refuses names that point at the folder itself or above", async (t) => {
  const root = await scratch(t, "local-remove");
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  const launcher = new RuntimeLauncher({ at: mac, exists: async () => false, run: async () => ({ stdout: "" }), spawn: () => ({ pid: 1, stop() {} }) });
  const manager = new LocalManager({ store, owner: "owner", models: demoModels(store), policy: null, fetch: async () => { throw new Error("off"); }, dataDir: join(root, "data"), launcher });
  await mkdir(modelsFolder("llama-cpp", mac, join(root, "data")), { recursive: true });
  for (const id of [".", "..", "../x"]) await assert.rejects(() => manager.remove({ runtime: "llama-cpp", id }), /not a model Branch downloaded/, id);
});

test("V14 the model list does not present its hashes as checked by anyone but their source", async () => {
  const list = JSON.parse(await readFile(new URL("../data/local-models.json", import.meta.url), "utf8"));
  assert.match(list.$comment, /not re-checked/i);
});
