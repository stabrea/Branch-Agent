/**
 * Bucket 15: a plugin somebody else wrote runs as its own program behind the wall.
 *
 * The first tests hand in a fake starter and only look at what would have been started. The macOS
 * tests start the plugin for real behind macOS's own sandbox (`/usr/bin/sandbox-exec`, which changes
 * nothing on the computer), with a web server on this computer standing in for the internet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { WalledPlugins, pluginWall, readAnswer } from "../dist/add-ons/walled-plugin.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { createBranch } from "../dist/index.js";
import { resultMarker } from "../dist/add-ons/walled-host.js";

const mac = { skip: process.platform !== "darwin" && "macOS's own sandbox is only on macOS" };

test("the wall for a plugin: no network unless its package named the address, and never a question", () => {
  const closed = pluginWall([], ["/data"]);
  assert.equal(closed.network, "none");
  assert.deepEqual(closed.unreadable, ["/data"]);
  assert.equal(closed.answer("network.site", "example.com"), "deny");
  assert.equal(closed.answer("sandbox.write", "/Users/me/file"), "deny", "a write outside its folder is refused, not asked");
  const open = pluginWall(["API.Weather.example"], []);
  assert.equal(open.network, "per-site");
  assert.equal(open.answer("network.site", "api.weather.example"), "allow");
  assert.equal(open.answer("network.site", "evil.example"), "deny");
  assert.deepEqual(open.granted("sandbox.write"), []);
  assert.deepEqual(open.keySites, {}, "no saved key ever reaches a plugin");
});

test("only the host's own last line is read as the answer", () => {
  assert.deepEqual(readAnswer(`noise${resultMarker}{"ok":true,"result":1}\n`), { ok: true, result: 1 });
  assert.throws(() => readAnswer("the plugin printed this and stopped"), /stopped without answering/);
});

test("what would be started: the system's sandbox, the plugin in a throwaway folder, no environment of Branch's", { skip: process.platform === "win32" && "the macOS wall is planned around this computer's own folders, which are not POSIX paths here" }, async (t) => {
  process.env.BRANCH_TEST_ONLY_SECRET = "do-not-pass";
  t.after(() => { delete process.env.BRANCH_TEST_ONLY_SECRET; });
  const started = [];
  const walled = new WalledPlugins({
    policy: () => ({ walled: true, hosts: [] }),
    unreadable: () => ["/branch-data"],
    wallDeps: { platform: "darwin", exists: async () => true, realpath: async (path) => path },
    spawn: async (start, limits) => {
      started.push({ start, limits, request: JSON.parse(await readFile(join(start.cwd, "request.json"), "utf8")),
        plugin: await readFile(join(start.cwd, "plugin.mjs"), "utf8") });
      return { status: "completed", exitCode: 0, stdout: `${resultMarker}{"ok":true,"result":"hi"}\n`, stderr: "", truncated: false, durationMs: 1 };
    },
  });
  const answer = await walled.ask("export default {}", [], { kind: "call", tool: "plugin.x.y", args: { a: 1 } });
  assert.equal(answer.result, "hi");
  const [{ start, limits, request, plugin }] = started;
  assert.equal(start.executable, "/usr/bin/sandbox-exec");
  const profile = start.args[start.args.indexOf("-p") + 1];
  assert.doesNotMatch(profile, /network-outbound/, "no network at all");
  assert.ok(start.args.some((arg) => /^-DHIDDEN_\d+=\/branch-data$/.test(arg)), "Branch's data folder is unreadable");
  assert.equal(start.args.at(-1), join(start.cwd, "host.mjs"));
  assert.ok(start.cwd.startsWith(tmpdir()) || start.cwd.startsWith("/private"), "a throwaway folder");
  assert.equal(start.env.BRANCH_TEST_ONLY_SECRET, undefined);
  assert.deepEqual(Object.keys(start.env).sort(), ["HOME", "NODE_USE_ENV_PROXY", "PATH", "TMPDIR"]);
  assert.deepEqual([limits.network, limits.job, limits.maxOutputBytes], [false, true, 1_000_000]);
  assert.deepEqual(request, { kind: "call", tool: "plugin.x.y", args: { a: 1 } });
  assert.equal(plugin, "export default {}");
  await assert.rejects(new WalledPlugins({ policy: () => ({ walled: true, hosts: [] }), unreadable: () => [],
    wallDeps: { platform: "darwin", exists: async () => false } }).ask("x", [], { kind: "describe" }), /sandbox-exec\) is missing/);
  await assert.rejects(new WalledPlugins({ policy: () => ({ walled: true, hosts: [] }), unreadable: () => [],
    wallDeps: { platform: "freebsd" } }).ask("x", [], { kind: "describe" }), /macOS and Linux only/);
});

async function localSite(t) {
  const hits = [];
  const server = createServer((request, response) => { hits.push(request.url); response.end("reached"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, url: `http://127.0.0.1:${server.address().port}/` };
}

const probe = (paths) => `import { readFile, writeFile } from "node:fs/promises";
const attempt = async (work) => { try { await work(); return "done"; } catch (error) { return "refused: " + (error.code ?? error.name); } };
export default { id: "probe", name: "Probe", permissions: ["files.read"], tools: [{
  name: "plugin.probe.try", description: "tries things", permission: "files.read",
  run: async ({ site }) => ({
    readData: await attempt(() => readFile(${JSON.stringify(paths.secret)}, "utf8")),
    writeData: await attempt(() => writeFile(${JSON.stringify(paths.planted)}, "x")),
    writeOwn: await attempt(() => writeFile("scratch.txt", "x")),
    web: await attempt(async () => { const r = await fetch(site, { signal: AbortSignal.timeout(3000) }); await r.text(); }),
    env: Object.keys(process.env).filter((name) => name.startsWith("BRANCH_")),
  }),
}], hooks: [{ event: "run.finished", run: async () => undefined }] };
`;

test("macOS for real: a walled plugin answers, but cannot read Branch's data, plant a file there, or reach the web", mac, async (t) => {
  const data = await mkdtemp(join(tmpdir(), "branch-walled-data-"));
  t.after(() => discardTemp(data));
  const secret = join(data, "locker.key"), planted = join(data, "planted.txt"), file = join(data, "probe.mjs");
  await writeFile(secret, "top secret");
  await writeFile(file, probe({ secret, planted }));
  process.env.BRANCH_TEST_ONLY_SECRET = "do-not-pass";
  t.after(() => { delete process.env.BRANCH_TEST_ONLY_SECRET; });
  const site = await localSite(t);
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: [] }), unreadable: () => [data], timeoutMs: 20_000 });
  const plugin = await walled.load("probe", file);
  assert.deepEqual([plugin.id, plugin.tools.map((tool) => tool.name), plugin.hooks.map((hook) => hook.event)], ["probe", ["plugin.probe.try"], ["run.finished"]]);
  assert.deepEqual(plugin.notes, ["It runs walled, with no internet."]);
  const result = await plugin.tools[0].run({ site: site.url }, { runId: "r1" });
  assert.equal(result.readData, "refused: EPERM", JSON.stringify(result));
  assert.equal(result.writeData, "refused: EPERM");
  assert.equal(result.writeOwn, "done", "its own scratch folder is writable");
  assert.match(result.web, /^refused/);
  assert.deepEqual(site.hits, [], "the web server never heard from it");
  assert.deepEqual(result.env, [], "none of Branch's environment went with it");
  await assert.rejects(readFile(planted), /ENOENT/);
});

test("macOS for real: code that differs from what was installed is not run, and a plugin that throws is a sentence", mac, async (t) => {
  const data = await mkdtemp(join(tmpdir(), "branch-walled-code-"));
  t.after(() => discardTemp(data));
  const file = join(data, "boom.mjs");
  await writeFile(file, "export default { id: 'boom', name: 'Boom', permissions: ['files.read'], tools: [{ name: 'plugin.boom.go', description: 'x', permission: 'files.read', run: async () => { throw new Error('it broke'); } }] };\n");
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update(await readFile(file, "utf8")).digest("hex");
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: [], sha256: fingerprint }), unreadable: () => [], timeoutMs: 20_000 });
  const plugin = await walled.load("boom", file);
  await assert.rejects(plugin.tools[0].run({}, { runId: "r" }), /The plugin said: it broke/);
  await writeFile(file, "export default { id: 'boom', name: 'Boom' }; // swapped\n");
  await assert.rejects(plugin.tools[0].run({}, { runId: "r" }), /not what it was when you installed it/);
  await assert.rejects(walled.load("boom", file), /not what it was when you installed it/);
});

test("macOS for real: only an address the package named gets past Branch's door, and never one on this computer", mac, async (t) => {
  const data = await mkdtemp(join(tmpdir(), "branch-walled-site-"));
  t.after(() => discardTemp(data));
  const file = join(data, "fetcher.mjs");
  /* ci-flakes-4: the stand-in gives each fetch 30 s, not 5. The door looks a named address up through
     this computer's own resolver, which on a busy macOS build machine took longer than 5 s, so the
     fetch was cut off and every answer read "refused" — nothing to do with the door. The reason is
     carried out now, so a future run says which fetch broke and why. */
  await writeFile(file, `export default { id: "fetcher", name: "Fetcher", permissions: ["web.read"], tools: [{ name: "plugin.fetcher.get", description: "x", permission: "web.read",
  run: async ({ url }) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); return r.status + " " + await r.text(); } catch (e) { return "refused: " + (e && e.name) + " " + (e && e.message); } } }] };\n`);
  const site = await localSite(t);
  // The door looks a named address up; names ending in ".invalid" never resolve (RFC 6761), so no site is reached.
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: ["api.weather.invalid", "127.0.0.1"] }), unreadable: () => [], timeoutMs: 120_000 });
  const plugin = await walled.load("fetcher", file);
  assert.deepEqual(plugin.notes, ["It runs walled and may reach only api.weather.invalid, 127.0.0.1."]);
  assert.match(await plugin.tools[0].run({ url: "http://api.weather.invalid/today" }, {}), /^403 api\.weather\.invalid could not be found/,
    "the named address was let through to be looked up");
  assert.match(await plugin.tools[0].run({ url: "http://evil.invalid/steal" }, {}), /^403 You have not allowed programs to reach evil\.invalid/);
  assert.match(await plugin.tools[0].run({ url: site.url }, {}), /^403 127\.0\.0\.1 points at this computer or a private network/,
    "naming this computer does not open it");
  assert.deepEqual(site.hits, []);
});

/* ------------------------------------------------------------------ fake-IP proxies (198.18.0.0/15) */

const posix = { skip: process.platform === "win32" && "the wall around programs is macOS and Linux only" };

/** One plain request through the door, the way a program behind the wall makes it; answers the status line. */
function throughDoor(proxy, url) {
  const door = new URL(proxy), target = new URL(url);
  const auth = Buffer.from(`${decodeURIComponent(door.username)}:${decodeURIComponent(door.password)}`).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = connect(Number(door.port), door.hostname, () => socket.write(
      `GET ${url} HTTP/1.1\r\nHost: ${target.host}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => resolve(text.split("\r\n")[0]));
    socket.on("error", reject);
  });
}

test("a walled plugin's door honours the owner's fake-IP proxy setting, through the real wall and door", posix, async (t) => {
  const site = await localSite(t);
  const port = Number(new URL(site.url).port);
  // A name server that answers the way a fake-IP proxy does, for both the owner's rules and the door.
  const answers = { "api.weather.test": ["198.18.0.5"], "mixed.weather.test": ["198.18.0.5", "93.184.216.34"] };
  const resolve = async (host) => answers[host] ?? [];
  const status = async (flag, host) => {
    // Wired as src/add-ons/index.ts wires it: the owner's network rules and the owner's setting.
    const policy = new NetworkPolicy({ fakeIpProxy: flag }, resolve);
    const walled = new WalledPlugins({
      policy: () => ({ walled: true, hosts: [host] }), unreadable: () => [],
      siteCheck: (target) => policy.assertAllowed(target, "a walled plugin"),
      fakeIpProxy: () => policy.settings().fakeIpProxy === true,
      wallDeps: { platform: "darwin", exists: async () => true, resolve,
        upstream: () => ({ host: "127.0.0.1", port, secure: false }) },
      spawn: async (start) => {
        const line = await throughDoor(start.env.HTTP_PROXY, `http://${host}/today`);
        return { status: "completed", exitCode: 0, stdout: `${resultMarker}${JSON.stringify({ ok: true, result: line })}\n`, stderr: "", truncated: false, durationMs: 1 };
      },
    });
    return (await walled.ask("export default {}", [host], { kind: "call" })).result;
  };
  assert.match(await status(false, "api.weather.test"), /^HTTP\/1\.1 403/, "refused while the setting is off");
  assert.deepEqual(site.hits, []);
  assert.match(await status(true, "api.weather.test"), /^HTTP\/1\.1 200/, "a name the proxy answers reaches the site once the owner said so");
  assert.deepEqual(site.hits, ["/today"]);
  assert.match(await status(true, "mixed.weather.test"), /^HTTP\/1\.1 403/, "an answer that mixes the range with a public address is refused");
  assert.deepEqual(site.hits, ["/today"], "nothing was dialled for the mixed answer");
});

test("the app hands a walled plugin's wall the owner's fake-IP proxy setting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-walled-fakeip-"));
  const on = await createBranch({ workspace: join(root, "on", "workspace"), dataDir: join(root, "on", "data"), web: { fakeIpProxy: true } });
  const off = await createBranch({ workspace: join(root, "off", "workspace"), dataDir: join(root, "off", "data") });
  t.after(async () => { await on.close(); await off.close(); await discardTemp(root); });
  const wall = on.addOns.walled.wallFor(["api.weather.test"]);
  assert.equal(typeof wall.siteCheck, "function", "the door asks the owner's network rules");
  assert.equal(typeof wall.fakeIpProxy, "function", "the door reads the owner's fake-IP proxy setting");
  assert.equal(wall.fakeIpProxy(), true);
  assert.equal(off.addOns.walled.wallFor(["api.weather.test"]).fakeIpProxy?.() ?? false, false, "off unless the owner switched it on");
});
