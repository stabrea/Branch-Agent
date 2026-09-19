/* Redesign phase 2 (panels): one side-panel switch with Browser and Terminal tabs inside, panes you can
   resize with Ctrl+B for the side list, the conversation's width and a see-through message box, hiding
   parts of the window (What's on screen), and a footer and message box that never clip. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { panelsWork } from "../dist/panels-work.js";

const ROOT = join(import.meta.dirname, "..");
const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

async function world(t, provider = quiet) {
  const root = await mkdtemp(join(tmpdir(), "branch-panels-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
/** A finished task that opened a page, took a picture, ran one command, was refused one and waits on a yes for another. */
async function seed(app) {
  const run = app.store.createRun(app.runtime.owner, "Compare the quotes");
  const session = run.sessionId;
  app.store.message(session, { role: "user", content: run.prompt });
  app.store.message(session, { role: "assistant", content: "", toolCalls: [
    { id: "c1", name: "browser.navigate", arguments: JSON.stringify({ url: "https://oakfield.example/prices" }) },
    { id: "c2", name: "browser.screenshot", arguments: "{}" },
    { id: "c3", name: "shell.execute", arguments: JSON.stringify({ executable: "node", args: ["compare.mjs", "a.txt"] }) },
    { id: "c4", name: "shell.execute", arguments: JSON.stringify({ executable: "rm", args: ["-rf", "old"] }) },
    { id: "c5", name: "shell.execute", arguments: JSON.stringify({ executable: "git", args: ["status"] }) },
  ] });
  const kept = await app.runtime.artifacts.write(run.id, "screenshot-test.png", "image/png",
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const ev = (kind, data) => app.store.event(run.id, kind, data);
  ev("tool.started", { name: "browser.navigate", id: "c1", label: "Using the browser" });
  ev("tool.completed", { name: "browser.navigate", id: "c1", result: { url: "https://oakfield.example/prices", title: "Price list" } });
  ev("tool.started", { name: "browser.screenshot", id: "c2", label: "Using the browser" });
  ev("tool.completed", { name: "browser.screenshot", id: "c2", result: { ...kept, url: "https://oakfield.example/prices" } });
  ev("tool.started", { name: "shell.execute", id: "c3", label: "Running a command" });
  ev("tool.completed", { name: "shell.execute", id: "c3", result: { exitCode: 0, stdout: "Northline is cheaper", stderr: "" } });
  ev("policy.denied", { name: "shell.execute", id: "c4", label: "Running a command", target: "rm -rf old" });
  ev("policy.ask", { name: "shell.execute", id: "c5", label: "Running a command", target: "git status" });
  ev("tool.started", { name: "memory.search", id: "c6", label: "Searching memory" });
  app.store.finish(run.id, "completed", "Northline is cheaper.");
  return { session, run, picture: kept.path };
}

/* ---------------------------------------------------------------- what Browser and Terminal read */

test("Browser and Terminal list what the conversation's tasks really did, newest last, with what came back", async (t) => {
  const { app } = await world(t);
  const { session, picture } = await seed(app);
  const work = panelsWork(app.store, app.runtime.owner, session);
  assert.equal(work.running, false);
  assert.deepEqual(work.terminal.entries.map((e) => [e.what, e.state]),
    [["node compare.mjs a.txt", "done"], ["rm -rf old", "refused"], ["git status", "waiting"]]);
  assert.equal(work.terminal.entries[0].output, "Northline is cheaper");
  assert.deepEqual(work.browser.entries.map((e) => [e.what, e.state]),
    [["https://oakfield.example/prices", "done"], ["https://oakfield.example/prices", "done"]]);
  assert.equal(work.browser.entries[0].output, "Price list", "the page's address is not said twice");
  assert.equal(work.browser.picture, picture, "the last picture the browser took");
  assert.ok(!JSON.stringify(work).includes("memory.search"), "other tools are left out");
  assert.deepEqual(panelsWork(app.store, "somebody-else", session).terminal.entries, [], "another owner's conversation is empty");
});

test("a key in a command line or in what it printed never reaches the Terminal tab", async (t) => {
  const { app } = await world(t);
  const run = app.store.createRun(app.runtime.owner, "Check the account");
  const typed = "AKIAIOSFODNN7EXAMPLE", printed = "sk-ant-api03-" + "x".repeat(40);
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [
    { id: "k1", name: "shell.execute", arguments: JSON.stringify({ executable: "aws", args: ["--key", typed, "s3", "ls"] }) },
  ] });
  app.store.event(run.id, "tool.started", { name: "shell.execute", id: "k1", label: "Running a command" });
  app.store.event(run.id, "tool.completed", { name: "shell.execute", id: "k1", result: { exitCode: 0, stdout: `your key is ${printed}` } });
  app.store.finish(run.id, "completed", "Done.");
  const [entry] = panelsWork(app.store, app.runtime.owner, run.sessionId).terminal.entries;
  const shown = JSON.stringify(entry);
  assert.ok(!shown.includes(typed), "the key typed on the command line is hidden");
  assert.ok(!shown.includes(printed), "the key the command printed is hidden");
  assert.match(entry.what, /^aws --key \[hidden key-like value: [^\]]+\] s3 ls$/);
  assert.match(entry.output, /^your key is \[hidden key-like value: [^\]]+\]$/);
});

test("a real task's command waiting on a yes shows in Terminal with the command it asked about", async (t) => {
  let round = 0;
  const provider = { name: "scripted", async complete() {
    round += 1;
    return round === 1 ? { content: "", toolCalls: [{ id: "call-1", name: "shell.execute", arguments: JSON.stringify({ executable: "node", args: ["--version"] }) }] }
      : { content: "done", toolCalls: [] };
  } };
  const { app } = await world(t, provider);
  await app.runtime.run({ prompt: "which node is this" }).catch(() => undefined);
  const [run] = app.store.runs(app.runtime.owner);
  const entries = panelsWork(app.store, app.runtime.owner, run.sessionId).terminal.entries;
  assert.deepEqual(entries.map((e) => [e.tool, e.what, e.state]), [["shell.execute", "node --version", "waiting"]]);
});

test("the route is the owner's: a short-lived key and a household person are refused it", async (t) => {
  const { app, root } = await world(t);
  const { session } = await seed(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const ask = (token) => fetch(new URL(`/api/panels/work?session=${session}`, server.url), { headers: { authorization: `Bearer ${token}` } });
  const mine = await ask(server.token);
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).terminal.entries.length, 3);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await ask(key)).status, 401, "a short-lived key cannot read the commands and what they printed");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await ask(server.token);
  assert.ok([400, 403].includes(household.status), `a household person is refused (${household.status})`);
  assert.doesNotMatch(await household.text(), /compare\.mjs/);
  app.store.profiles.switch({ profileId: null });
});

/* ---------------------------------------------------------------- source rules */

test("every part on the What's on screen list has its rule, and nothing that keeps a person safe is on it", async () => {
  const js = await readFile(join(ROOT, "public", "panels-hide.js"), "utf8");
  const css = await readFile(join(ROOT, "public", "panels.css"), "utf8");
  const ids = [...js.matchAll(/^\s+\["([a-z-]+)", "onscreen\.[a-zA-Z]+", "[^"]*", (?:'[^']*'|"[^"]*"), "[a-z]+"\],?$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 25, `found ${ids.length} parts`);
  for (const id of ids) assert.ok(css.includes(`:root[data-hide~="${id}"]`), `${id} has no rule in panels.css`);
  for (const never of ["lockbanner", "live-row", "live-stop", "live-ask", "policy-waiting", "settings-row", "rail-settings", "toast"])
    assert.ok(!new RegExp(`data-hide~="[a-z-]+"\\][^,{]*${never}`).test(css), `${never} can be hidden`);
});

test("the new settings have their defaults, ship off where they change behaviour, and refuse nonsense", async () => {
  const { PreferencesSchema } = await import("../dist/preferences.js");
  const plain = PreferencesSchema.parse({});
  assert.equal(plain.seeThrough, 30);
  assert.equal(plain.conversationWidth, "wide");
  assert.deepEqual(plain.hidden, []);
  assert.equal(plain.rightClickHide, false, "right-click › Hide this starts off");
  assert.throws(() => PreferencesSchema.parse({ seeThrough: 140 }));
  assert.throws(() => PreferencesSchema.parse({ hidden: ["<script>"] }));
});

/* ---------------------------------------------------------------- the window */

async function windowFixture(t, { width = 1440, height = 950, seeded = true } = {}) {
  const { app, root } = await world(t);
  const seededWith = seeded ? await seed(app) : null;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* The page's own security rules refusing something this work added (older files have two of their own). */
  page.on("console", (message) => { if (/Content Security Policy/.test(message.text()) && /panels/.test(message.location().url)) errors.push(message.text().slice(0, 120)); });
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("body.lx-ready").waitFor({ state: "attached" });
    await page.waitForFunction(() => globalThis.branchPanels && globalThis.branchOnscreen);
    errors.length = 0; // what failed before the key was given is the login page's business
  };
  await open();
  const conversation = async () => {
    await page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, seededWith.session);
  };
  const look = (patch) => page.evaluate(async (p) => (await import("/appearance.js")).changeAppearance(p), patch);
  return { app, page, call, errors, open, conversation, look, context, seeded: seededWith };
}
const paneShown = (page) => page.evaluate(() => document.body.classList.contains("lx-aside"));

test("one switch opens the side panel in the calm window, its tabs are inside it, and Terminal shows the command", async (t) => {
  const f = await windowFixture(t);
  await f.conversation();
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.everything), "off", "the calm window");
  await f.page.locator("#aside-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("lx-aside"));
  assert.equal(await f.page.locator("#aside-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(await f.page.evaluate(() => document.getElementById("lx-pane-tabs").closest("#context-panel") !== null), true, "the tabs live in the panel");
  assert.equal(await f.page.locator("main > header .lx-pane-tab").count(), 0, "no row of tab buttons in the title bar");
  await f.page.locator('#lx-pane-tabs [data-pane="terminal"]').click();
  await f.page.locator("#panels-terminal .panels-entry").first().waitFor();
  const text = await f.page.locator("#panels-terminal").innerText();
  assert.match(text, /\$ git status/);
  assert.match(text, /Waiting for your yes/);
  assert.match(text, /Refused/);
  assert.match(text, /Northline is cheaper/);
  await f.page.locator('#lx-pane-tabs [data-pane="terminal"]').click();
  assert.equal(await paneShown(f.page), true, "pressing the open tab again never closes the panel");
  await f.page.locator('#lx-pane-tabs [data-pane="browser"]').click();
  await f.page.locator("#panels-browser .panels-picture img").waitFor();
  assert.match(await f.page.locator("#panels-browser img").getAttribute("src"), /^data:image\/png;base64,/);
  const browserText = await f.page.locator("#panels-browser").innerText();
  assert.match(browserText, /oakfield\.example\/prices/);
  assert.match(browserText, /Opened the page/, "each browser step says what it did");
  assert.match(browserText, /Took a picture of the page/);
  await f.page.locator("#aside-toggle").click();
  await f.page.waitForFunction(() => !document.body.classList.contains("lx-aside"));
  assert.equal(await f.page.locator("#aside-toggle").getAttribute("aria-pressed"), "false");
  assert.deepEqual(f.errors, []);
});

test("More offers Browser and Terminal, and a household window offers neither", async (t) => {
  const f = await windowFixture(t);
  await f.conversation();
  await f.page.locator("#lx-more").click();
  await f.page.locator('#lx-more-menu [data-target="terminal"]').click();
  await f.page.waitForFunction(() => document.getElementById("context-panel").dataset.pane === "terminal" && document.body.classList.contains("lx-aside"));
  await f.page.evaluate(() => { document.documentElement.dataset.household = "on"; });
  assert.equal(await f.page.locator('#lx-pane-tabs [data-pane="terminal"]').isVisible(), false);
  assert.equal(await f.page.locator('#lx-pane-tabs [data-pane="browser"]').isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test("the full window has one panel button too, and its tabs never wrap or clip at any panel width", async (t) => {
  const f = await windowFixture(t);
  await f.look({ showEverything: true });
  await f.conversation();
  await f.page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  if (!(await paneShown(f.page))) await f.page.locator("#aside-toggle").click();
  for (const width of [260, 320, 420, 480, 560, 640]) {
    await f.page.evaluate((w) => document.documentElement.style.setProperty("--aside-w", `${w}px`), width);
    await f.page.waitForTimeout(80);
    const fit = await f.page.evaluate(() => {
      const tabs = document.getElementById("lx-pane-tabs");
      const buttons = [...tabs.querySelectorAll(".lx-pane-tab")].filter((b) => b.offsetParent);
      const tops = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
      const cut = [...tabs.querySelectorAll(".lx-words")].filter((w) => w.offsetParent && w.scrollWidth > w.clientWidth + 1).length;
      return { rows: tops.size, over: tabs.scrollWidth - tabs.clientWidth, count: buttons.length, cut };
    });
    assert.equal(fit.cut, 0, `a tab's name is cut short at ${width}px`);
    assert.equal(fit.rows, 1, `tabs wrap at ${width}px`);
    assert.ok(fit.over <= 1, `tabs clip at ${width}px`);
    assert.equal(fit.count, 6);
  }
  assert.deepEqual(f.errors, []);
});

test("the side list and side panel can be dragged, the width is kept, double-click resets, Ctrl+B folds the list", async (t) => {
  const f = await windowFixture(t);
  await f.conversation();
  await f.page.locator("#aside-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("lx-aside"));
  const handle = f.page.locator('.panels-rz[data-rz="aside"]');
  await handle.waitFor();
  const before = await f.page.evaluate(() => document.getElementById("context-panel").getBoundingClientRect().width);
  const box = await handle.boundingBox();
  await f.page.mouse.move(box.x + 5, box.y + 200);
  await f.page.mouse.down();
  await f.page.mouse.move(box.x - 120, box.y + 200, { steps: 6 });
  await f.page.mouse.up();
  const after = await f.page.evaluate(() => document.getElementById("context-panel").getBoundingClientRect().width);
  assert.ok(after > before + 90, `the panel grew (${before} → ${after})`);
  const stored = JSON.parse(await f.page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("branch-pane-widths:")) ?? "none"))).aside;
  assert.ok(Math.abs(stored - (before + 125)) <= 2, `kept in this browser (${stored})`);
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached" });
  await f.page.waitForFunction(() => globalThis.branchPanels);
  assert.equal(await f.page.evaluate(() => document.documentElement.style.getPropertyValue("--aside-w")), `${stored}px`, "kept after a reload");
  const rail = f.page.locator('.panels-rz[data-rz="rail"]');
  await rail.focus();
  await f.page.keyboard.press("ArrowRight");
  assert.ok(JSON.parse(await f.page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("branch-pane-widths:")) ?? "none"))).rail > 0, "the arrow keys move it");
  await rail.dblclick();
  assert.equal(JSON.parse(await f.page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("branch-pane-widths:")) ?? "none") || "{}")).rail, undefined, "double-click resets");
  await f.page.locator("#prompt").click();
  await f.page.keyboard.press("Control+b");
  await f.page.waitForFunction(() => document.body.classList.contains("no-rail"));
  await f.page.waitForFunction(() => document.querySelector('.panels-rz[data-rz="rail"]').hidden, null, { timeout: 3000 }); // no handle on a folded list
  await f.page.keyboard.press("Control+b");
  await f.page.waitForFunction(() => !document.body.classList.contains("no-rail"));
  assert.deepEqual(f.errors, []);
});

test("the conversation uses the width on a wide screen, and Comfortable brings the old column back", async (t) => {
  const f = await windowFixture(t, { width: 1600, height: 950 });
  await f.conversation();
  const width = () => f.page.evaluate(() => document.getElementById("chat").getBoundingClientRect().width);
  const dock = () => f.page.evaluate(() => document.getElementById("chat-form").getBoundingClientRect().width);
  assert.ok(await width() > 1000, `wide by default (${await width()})`);
  assert.ok(await dock() > 1000, "the message box grows with it");
  await f.look({ conversationWidth: "comfortable" });
  await f.page.waitForFunction(() => document.documentElement.dataset.convw === "comfortable");
  assert.ok(await width() <= 760);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  assert.deepEqual(f.errors, []);
});

test("See-through never goes past readable, and stays solid when things are kept still", async (t) => {
  const f = await windowFixture(t, { seeded: false });
  const alpha = () => f.page.evaluate(() => Number(document.body.style.getPropertyValue("--comp-a")));
  await f.look({ seeThrough: 0 });
  assert.equal(await alpha(), 1, "0 is solid");
  await f.look({ seeThrough: 100 });
  const clear = await alpha();
  assert.ok(clear < 1 && clear >= 0.45, `glass, within the limit (${clear})`);
  const readable = await f.page.evaluate(async () => {
    const box = document.getElementById("chat-form");
    const colour = getComputedStyle(box).backgroundColor;
    return /color-mix|srgb|rgba?\(/.test(colour);
  });
  assert.ok(readable, "the box's fill follows the setting");
  await f.look({ reduceMotion: true });
  assert.equal(await alpha(), 1, "Keep things still keeps it solid");
  assert.match(await f.page.locator("#panels-see-note").innerText().catch(() => ""), /^$|solid/);
  assert.deepEqual(f.errors, []);
});

test("hiding: a switch hides a part, all hidden leaves a gear, Lockdown's banner and Stop never hide", async (t) => {
  const f = await windowFixture(t);
  await f.conversation();
  await f.look({ hidden: ["recents"] });
  await f.page.waitForFunction(() => document.documentElement.dataset.hide === "recents");
  assert.equal(await f.page.locator('.rail-group[data-group="recents"]').isVisible(), false);
  const ids = await f.page.evaluate(() => globalThis.branchOnscreen.ids());
  await f.page.evaluate(() => { globalThis.lonely = 0; document.addEventListener("branch-everything-hidden", () => { globalThis.lonely += 1; }); });
  await f.look({ hidden: ids.slice(1) });
  await f.page.waitForTimeout(200);
  assert.equal(await f.page.evaluate(() => globalThis.lonely), 0, "not while one part still shows");
  await f.look({ hidden: ids });
  await f.page.locator("#panels-float-gear").waitFor();
  await f.page.waitForFunction(() => globalThis.lonely === 1);
  await f.look({ seeThrough: 40 });
  await f.page.waitForTimeout(200);
  assert.equal(await f.page.evaluate(() => globalThis.lonely), 1, "said once, not again on every change after");
  const shown = await f.page.evaluate(() => [...document.querySelectorAll("body *")]
    .filter((node) => node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && node.getBoundingClientRect().width > 0)
    .filter((node) => !node.closest("#panels-float-gear, #toast, .panels-rz, #lx-lockbanner, .sr-only") && !node.children.length)
    .map((node) => node.id || String(node.className?.baseVal ?? node.className) || node.tagName).slice(0, 8));
  assert.deepEqual(shown, [], "only the gear is left");
  /* Nothing on the list can take a safety part with it. */
  const taken = await f.page.evaluate(async () => {
    const { HIDE, NEVER_SELECTORS } = await import("/panels-hide.js");
    const never = NEVER_SELECTORS.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const settings = new Set(["lx-settings-row", "rail-settings"]);
    /* The whole side list holds Settings; while it is hidden the gear in the corner stands in for it. */
    return HIDE.flatMap(([id, , , selector]) => [...document.querySelectorAll(selector)]
      .filter((part) => never.some((node) => part.contains(node) && !(id === "side-list" && settings.has(node.id)))).map(() => id));
  });
  assert.deepEqual(taken, [], "no part on the list holds an approval, the Lockdown banner, Stop or Settings");
  await f.call("/api/lockdown", { on: true });
  await f.page.waitForFunction(() => !document.getElementById("lx-lockbanner").hidden, null, { timeout: 15000 });
  assert.equal(await f.page.locator("#lx-lockbanner").isVisible(), true, "the Lockdown banner shows with everything hidden");
  await f.page.locator("#panels-float-gear").click();
  await f.page.locator("#panels-onscreen").waitFor();
  await f.page.locator("#panels-show-all").click();
  await f.page.waitForFunction(() => !document.documentElement.dataset.hide);
  assert.equal(await f.page.locator("#panels-float-gear").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("right-click › Hide this is off until switched on, then hides with Undo", async (t) => {
  const f = await windowFixture(t);
  await f.conversation();
  const prevented = () => f.page.evaluate(() => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
    document.getElementById("lx-more").dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(await prevented(), false, "off: right-click is the browser's, as always");
  assert.equal(await f.page.locator(".panels-menu").count(), 0);
  await f.look({ rightClickHide: true });
  await f.page.locator("#lx-more").click({ button: "right" });
  await f.page.locator(".panels-menu").waitFor();
  assert.match(await f.page.locator(".panels-menu").innerText(), /More[\s\S]*Hide this/);
  await f.page.locator(".panels-menu button", { hasText: "Hide this" }).click();
  await f.page.waitForFunction(() => document.documentElement.dataset.hide === "more");
  assert.equal(await f.page.locator("#lx-more").isVisible(), false);
  await f.page.locator("#toast .panels-undo").click();
  await f.page.waitForFunction(() => !document.documentElement.dataset.hide);
  assert.equal(await f.page.locator("#lx-more").isVisible(), true);
  await f.page.locator("#prompt").click({ button: "right" });
  assert.equal(await f.page.locator(".panels-menu").count(), 0, "the text box keeps its own right-click");
  assert.deepEqual(f.errors, []);
});

test("footer, title bar and message box never clip at 1440, 1024 and 390, open or closed, and the box keeps its size", async (t) => {
  const f = await windowFixture(t);
  await f.conversation();
  for (const [width, height] of [[1440, 950], [1024, 700], [390, 844]]) {
    await f.page.setViewportSize({ width, height });
    for (const open of [false, true]) {
      const shown = await paneShown(f.page);
      if (shown !== open && await f.page.locator("#aside-toggle").isVisible()) await f.page.locator("#aside-toggle").click();
      await f.page.waitForTimeout(250);
      const report = await f.page.evaluate(() => {
        const clipped = (node) => node && node.checkVisibility() && (node.scrollWidth - node.clientWidth > 1);
        const box = document.getElementById("prompt").getBoundingClientRect();
        const over = [...document.querySelectorAll(".rail-foot, main > header, #chat-form, .lx-pane-head")].filter(clipped).map((n) => n.className || n.id);
        const panel = document.getElementById("context-panel");
        const pane = panel.checkVisibility() ? panel.getBoundingClientRect() : null;
        const covers = Boolean(pane && pane.left < box.right && pane.right > box.left && pane.top < box.bottom && pane.bottom > box.top);
        return { over, page: document.documentElement.scrollWidth - document.documentElement.clientWidth, prompt: box.height, promptW: box.width, covers };
      });
      assert.equal(report.covers, false, `${width} ${open ? "open" : "closed"}: the panel covers the text box`);
      assert.deepEqual(report.over, [], `${width} ${open ? "open" : "closed"}: ${report.over}`);
      assert.equal(report.page, 0, `${width}: the page scrolls sideways`);
      assert.ok(report.prompt >= 30 && report.promptW >= 120, `${width}: the text box collapsed (${report.prompt}x${report.promptW})`);
    }
  }
  /* #58: answering in the Terminal view leaves the message box as it was. */
  await f.page.setViewportSize({ width: 1440, height: 950 });
  if (!(await paneShown(f.page))) await f.page.locator("#aside-toggle").click();
  await f.page.locator('#lx-pane-tabs [data-pane="terminal"]').click();
  const before = await f.page.evaluate(() => document.getElementById("chat-form").getBoundingClientRect().height);
  await f.page.locator("#prompt").fill("yes, go ahead");
  await f.page.keyboard.press("Enter");
  await f.page.waitForFunction(() => document.querySelectorAll("#conversation .message").length >= 4, null, { timeout: 15000 });
  await f.page.waitForTimeout(600);
  const after = await f.page.evaluate(() => document.getElementById("chat-form").getBoundingClientRect().height);
  assert.ok(Math.abs(after - before) <= 2, `the box changed size after answering (${before} → ${after})`);
  assert.equal(await f.page.locator("#prompt").isVisible(), true);
  assert.deepEqual(f.errors, []);
});

test("on a phone the one switch is there and opens the floating panel with its tabs; hiding the switch hides it", async (t) => {
  const f = await windowFixture(t, { width: 390, height: 844 });
  await f.conversation();
  await f.page.locator("#aside-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("lx-aside"));
  assert.equal(await f.page.locator('#lx-pane-tabs [data-pane="terminal"]').isVisible(), true);
  await f.page.locator('#lx-pane-tabs [data-pane="terminal"]').click();
  await f.page.locator("#panels-terminal .panels-entry").first().waitFor();
  const inside = await f.page.evaluate(() => {
    const box = document.getElementById("context-panel").getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
  });
  assert.ok(inside, "the floating panel fits the phone");
  await f.page.keyboard.press("Escape");
  await f.page.waitForFunction(() => !document.body.classList.contains("lx-aside"));
  await f.look({ hidden: ["panel-button"] });
  await f.page.waitForFunction(() => document.documentElement.dataset.hide === "panel-button");
  assert.equal(await f.page.locator("#aside-toggle").isVisible(), false, "the person's choice wins over the calm window's own rule");
  assert.deepEqual(f.errors, []);
});

test("a panel closed long ago in the full window still opens from the switch in the calm window; widths are per person", async (t) => {
  const f = await windowFixture(t);
  /* What public/shell.js does at load for somebody who once closed the panel in the full window
     (a reload here would count as wrong key tries on the login page and lock the test out). */
  await f.page.evaluate(() => { localStorage.setItem("branch-aside", "closed"); document.body.classList.add("no-aside"); });
  await f.conversation();
  assert.equal(await f.page.evaluate(() => document.body.classList.contains("no-aside")), true, "the old choice is still written down");
  await f.page.locator("#aside-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("lx-aside"));
  assert.equal(await f.page.locator("#context-panel").isVisible(), true, "the panel shows");
  /* Widths: the owner's are not a household person's. */
  await f.page.waitForFunction(() => !document.querySelector('.panels-rz[data-rz="aside"]').hidden, null, { timeout: 5000 })
    .catch(async () => assert.fail(JSON.stringify(await f.page.evaluate(() => ({ cls: document.body.className, w: document.getElementById("context-panel").getBoundingClientRect().width, cols: getComputedStyle(document.body).gridTemplateColumns })))));
  await f.page.evaluate(() => document.querySelector('.panels-rz[data-rz="aside"]').focus());
  await f.page.keyboard.press("ArrowLeft");
  const mine = await f.page.evaluate(() => document.documentElement.style.getPropertyValue("--aside-w"));
  assert.ok(mine, "the owner's width is set");
  await f.page.evaluate(() => { document.documentElement.dataset.household = "on"; document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: false } })); });
  assert.equal(await f.page.evaluate(() => document.documentElement.style.getPropertyValue("--aside-w")), "", "a household person starts from the normal width");
  assert.deepEqual(f.errors, []);
});

test("on a phone, hiding the title bar (where the side list opens) leaves the gear, and it never covers the message box", async (t) => {
  const f = await windowFixture(t, { width: 390, height: 844 });
  await f.conversation();
  assert.equal(await f.page.locator("#panels-float-gear").count(), 0, "nothing extra while the title bar shows");
  for (const hidden of [["title-bar"], ["side-toggle", "more"], ["title-bar", "starters", "foot", "usage"]]) {
    await f.look({ hidden });
    await f.page.locator("#panels-float-gear").waitFor();
    const clash = await f.page.evaluate(() => {
      const gear = document.getElementById("panels-float-gear").getBoundingClientRect();
      const box = document.getElementById("chat-form").getBoundingClientRect();
      return gear.right > box.left && gear.left < box.right && gear.bottom > box.top && gear.top < box.bottom;
    });
    assert.equal(clash, false, `the gear sits clear of the message box (${hidden.join(", ")})`);
  }
  await f.look({ hidden: [] });
  await f.page.waitForFunction(() => !document.getElementById("panels-float-gear"));
  await f.page.setViewportSize({ width: 1440, height: 950 });
  await f.look({ hidden: ["title-bar"] });
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.locator("#panels-float-gear").count(), 0, "a wide window keeps Settings in the side list");
  assert.deepEqual(f.errors, []);
});

test("with achievements on, hiding everything earns \"It's lonely over here\" (phase2/delight)", async (t) => {
  const f = await windowFixture(t, { seeded: false });
  const lonely = async () => (await f.call("/api/delight/achievements")).list?.find((a) => a.id === "noticed:flag:lonely:1");
  assert.equal(await lonely(), undefined, "achievements are off, so there is no list");
  await f.call("/api/delight/settings", { achievements: { on: true } });
  await f.page.reload(); // the window reads the switch when it starts
  await f.page.locator("body.lx-ready").waitFor({ state: "attached" });
  await f.page.waitForFunction(() => globalThis.branchOnscreen);
  assert.equal((await lonely()).got, undefined, "not earned yet");
  await f.look({ hidden: await f.page.evaluate(() => globalThis.branchOnscreen.ids()) });
  await f.page.locator("#panels-float-gear").waitFor();
  let got = false;
  for (let tries = 0; !got && tries < 50; tries += 1) {
    got = Boolean((await lonely())?.got);
    if (!got) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(got, true, "hiding everything is noticed and earned");
  assert.equal((await lonely()).name, "It's lonely over here");
  assert.deepEqual(f.errors, []);
});
