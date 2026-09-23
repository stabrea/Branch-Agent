/**
 * Q45: the window's own choices are kept by the engine in the data folder, not in the page's browser
 * storage, which belongs to the page's address. The desktop app picks a new port each start, so a
 * choice kept only in the browser came back as the default after an update. These tests hold the
 * engine's record to its promises (a default when nothing is saved, only named and checked fields,
 * an import that only fills what is empty) and prove a choice survives a new address.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { importUiPreferences, patchUiPreferences, readUiPreferences, uiPreferencesApi, LEGACY_IMPORT, LIST_CAP } from "../dist/ui-preferences.js";

/** A fresh engine in a throwaway folder, closed before the folder is removed. */
async function freshBranch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-ui-prefs-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("nothing saved yet answers the defaults, and a change keeps only the fields it names", async (t) => {
  const app = await freshBranch(t);
  const owner = app.runtime.owner;
  assert.deepEqual(readUiPreferences(app.store, owner), { revision: 0, values: {}, imports: {} });

  patchUiPreferences(app.store, owner, { set: { railView: "trunks", asideOpen: false } });
  const next = patchUiPreferences(app.store, owner, { set: { focusView: true } });
  assert.deepEqual(next.values, { railView: "trunks", asideOpen: false, focusView: true }, "an older field is not put back");
  assert.equal(next.revision, 2);
  assert.deepEqual(patchUiPreferences(app.store, owner, { set: { focusView: null } }).values, { railView: "trunks", asideOpen: false });

  assert.throws(() => patchUiPreferences(app.store, owner, { set: { branchToken: "x" } }), "a field nobody named is refused");
  assert.throws(() => patchUiPreferences(app.store, owner, { set: { railView: "everything" } }), "a value outside the choices is refused");
  assert.throws(() => patchUiPreferences(app.store, owner, { set: { paneTab: "../../etc" } }));
  assert.deepEqual(readUiPreferences(app.store, owner).values, { railView: "trunks", asideOpen: false }, "a refused change changes nothing");
});

test("the import from browser storage only fills what is empty, drops what fails its check, and twice is once", async (t) => {
  const app = await freshBranch(t);
  const owner = app.runtime.owner;
  patchUiPreferences(app.store, owner, { set: { railView: "conversations" } });

  const offered = { railView: "trunks", asideOpen: false, paneTab: "files", focusView: "yes", secret: "sk-1" };
  const first = importUiPreferences(app.store, owner, true, { name: LEGACY_IMPORT, values: offered });
  assert.deepEqual(first.filled, ["asideOpen", "paneTab"]);
  assert.deepEqual(first.values, { railView: "conversations", asideOpen: false, paneTab: "files" }, "what the engine held wins");
  assert.ok(first.imports[LEGACY_IMPORT], "the import is written down");

  const again = importUiPreferences(app.store, owner, true, { name: LEGACY_IMPORT, values: offered });
  assert.deepEqual(again.filled, []);
  assert.deepEqual({ revision: again.revision, values: again.values }, { revision: first.revision, values: first.values });

  assert.deepEqual(importUiPreferences(app.store, "profile:somebody", false, { name: LEGACY_IMPORT, values: { focusView: true } }).values, {},
    "a household person's window never takes the storage everybody at this computer shared");
  assert.throws(() => importUiPreferences(app.store, owner, true, { name: "anything", values: {} }));
});

test("the side list's groups and the one-time lines are kept, and a list only grows by what a change adds, capped", async (t) => {
  const app = await freshBranch(t);
  const owner = app.runtime.owner;
  patchUiPreferences(app.store, owner, { set: { projectsOpen: false, inboxSeenAt: 1_700_000_000_000, calmTipSeen: true } });
  patchUiPreferences(app.store, owner, { add: { petTipsSeen: ["delight.tip.palette"] } });
  const both = patchUiPreferences(app.store, owner, { add: { petTipsSeen: ["delight.tip.mode"] } });
  assert.deepEqual(both.values.petTipsSeen, ["delight.tip.palette", "delight.tip.mode"], "a second window's addition keeps the first one's");
  assert.deepEqual(patchUiPreferences(app.store, owner, { add: { petTipsSeen: ["delight.tip.palette"] } }).values.petTipsSeen,
    ["delight.tip.mode", "delight.tip.palette"], "each entry is kept once");
  assert.equal(both.values.projectsOpen, false, "a list change leaves the other fields alone");

  const many = Array.from({ length: LIST_CAP }, (_, at) => `delight.tip.n${at}`);
  const capped = patchUiPreferences(app.store, owner, { add: { petTipsSeen: many } });
  assert.equal(capped.values.petTipsSeen.length, LIST_CAP, "a list never grows past its cap");
  assert.deepEqual(capped.values.petTipsSeen, many, "the oldest entries go first");

  assert.throws(() => patchUiPreferences(app.store, owner, { set: { petTipsSeen: [] } }), "a list is only added to, never replaced");
  assert.throws(() => patchUiPreferences(app.store, owner, { add: { petTipsSeen: ["../../etc"] } }), "an entry that fails its check is refused");
  assert.throws(() => patchUiPreferences(app.store, owner, { add: { railView: ["trunks"] } }), "only a list can be added to");
  assert.throws(() => patchUiPreferences(app.store, owner, { set: { inboxSeenAt: -1 } }));
  assert.throws(() => patchUiPreferences(app.store, owner, { add: { saveProgressAsked: Array(LIST_CAP + 1).fill("x") } }));

  const fresh = await freshBranch(t);
  const imported = importUiPreferences(fresh.store, fresh.runtime.owner, true, { name: LEGACY_IMPORT, values: {
    petTipsSeen: ["delight.tip.palette", "not a tip!", 5], saveProgressAsked: "not a list", recentsOpen: false, calmTipSeen: "1",
  } });
  assert.deepEqual(imported.values, { recentsOpen: false, petTipsSeen: ["delight.tip.palette"] }, "each entry is checked on the way in");
});

test("a conversation's name, pin or hidden row is kept only for the person's own conversation", async (t) => {
  const app = await freshBranch(t);
  const owner = app.runtime.owner;
  const mine = app.store.createSession(owner);
  const theirs = app.store.createSession("profile:somebody-else");
  const api = (method, path, body, isOwner = true) =>
    uiPreferencesApi({ store: app.store, owner, isOwner }, method, path, async () => body);
  const change = (mark) => api("POST", "/api/ui-preferences", { mark });

  assert.deepEqual((await api("GET", "/api/ui-preferences")).conversations, { names: {}, pinned: [], buried: [] });
  assert.deepEqual((await change({ id: mine, name: "  Taxes  ", pinned: true })).conversations,
    { names: { [mine]: "Taxes" }, pinned: [mine], buried: [] });
  await assert.rejects(change({ id: theirs, pinned: true }), /Conversation not found/, "somebody else's conversation is never labelled");
  await assert.rejects(change({ id: "no-such-conversation", buried: true }), /Conversation not found/);
  await assert.rejects(change({ id: mine, name: "x".repeat(121) }), "a name is bounded");
  await assert.rejects(change({ id: mine, colour: "red" }), "only a name, a pin or a hidden row");
  const both = await api("POST", "/api/ui-preferences", { mark: { id: mine, buried: true }, set: { railOpen: false } });
  assert.deepEqual(both.conversations.buried, [mine]);
  assert.equal(both.values.railOpen, false, "a label and a choice can travel together");
  assert.deepEqual((await change({ id: mine, name: null, pinned: false, buried: false })).conversations, { names: {}, pinned: [], buried: [] });

  /* The one-time import keeps only the person's own conversations, and only once. */
  const other = app.store.createSession(owner);
  const offered = { names: { [other]: "Kept", [theirs]: "Somebody else's", "../x": "bad" }, pinned: [other, theirs, 5], buried: "nope" };
  const imported = await api("POST", "/api/ui-preferences/import", { name: LEGACY_IMPORT, values: {}, conversations: offered });
  assert.deepEqual(imported.conversations, { names: { [other]: "Kept" }, pinned: [other], buried: [] });
  const again = await api("POST", "/api/ui-preferences/import", { name: LEGACY_IMPORT, values: {}, conversations: { buried: [mine] } });
  assert.deepEqual(again.conversations, imported.conversations, "a second import changes nothing");

  const household = await freshBranch(t);
  const theirOwn = household.store.createSession(household.runtime.owner);
  const asPerson = await uiPreferencesApi({ store: household.store, owner: household.runtime.owner, isOwner: false }, "POST",
    "/api/ui-preferences/import", async () => ({ name: LEGACY_IMPORT, values: {}, conversations: { pinned: [theirOwn] } }));
  assert.deepEqual(asPerson.conversations.pinned, [], "a household person's window never takes the shared storage");
});

/**
 * A signed-in window at `server`: the token is where a reload after signing in finds it. `legacy` is
 * what an older version left in this page's browser storage, there before the page first loads.
 * `imports` collects the answers to the one-time import.
 */
async function openWindow(browser, server, legacy = null) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(([token, left]) => {
    sessionStorage.setItem("branch-token", token);
    if (!left || sessionStorage.getItem("test-legacy-left")) return;
    for (const [key, value] of Object.entries(left)) localStorage.setItem(key, value);
    sessionStorage.setItem("test-legacy-left", "1");
  }, [server.token, legacy]);
  const page = await context.newPage();
  const errors = [], imports = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().endsWith("/api/ui-preferences/import")) imports.push(response.status()); });
  await page.goto(server.url);
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, context, imports };
}
/* The Inbox notes when it was first looked at (inboxSeenAt) as soon as it has drawn, which is a moment, not a choice;
   `choices` leaves it out so the comparisons below do not depend on when that happened. */
const saved = (server) => fetch(new URL("/api/ui-preferences", server.url), { headers: { authorization: `Bearer ${server.token}` } })
  .then((r) => r.json()).then((kept) => { const { inboxSeenAt, ...choices } = kept.values; return { ...kept, choices }; });
/** Asks `check` again until it holds, for up to five seconds. */
async function waitFor(check, what) {
  for (let tries = 0; tries < 50; tries++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(what);
}

test("a choice left in browser storage by an older version moves to the engine and comes back at a new address", async (t) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const root = await mkdtemp(join(tmpdir(), "branch-ui-prefs-window-"));
  const open = [];
  t.after(async () => {
    await browser.close();
    for (const close of open.reverse()) await close().catch(() => undefined);
    await discardTemp(root);
  });

  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  open.push(() => app.close());
  const first = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  open.push(() => first.close());
  const taxes = app.store.createSession(app.runtime.owner);
  app.store.sqlite.prepare("INSERT INTO messages(session_id,body) VALUES(?,?)").run(taxes, JSON.stringify({ role: "user", content: "About my taxes" }));
  /* What an older version left in this page's storage, found by the first start of this version. */
  const before = await openWindow(browser, first, {
    "branch-rail": "closed",
    "branch-focus-view": "1",
    "branch-first-run-next": "1",
    "branch-pet-tips-seen": JSON.stringify(["delight.tip.palette", "not a tip!"]),
    "branch-names": JSON.stringify({ [taxes]: "Taxes", "somebody-elses": "Not mine" }),
    "branch-pins": JSON.stringify([taxes, "somebody-elses"]),
    "branch-calm-tip": "1",
    "branch-group-recents": "closed", // folded before the workspace had a name
    "branch-save-progress-asked": JSON.stringify(["claude|me|week|2026-09-30"]),
    "branch-pet-hint-at": "1000",
    "branch-inbox-seen": "2000",
  });
  await waitFor(() => Promise.resolve(before.imports.length > 0), "the first start imports");
  assert.deepEqual(before.imports, [200]);
  assert.equal(await before.page.evaluate(() => document.body.classList.contains("no-rail")), true, "and shows what it brought");
  const older = { railOpen: false, focusView: true, firstRunNextSeen: true, petTipsSeen: ["delight.tip.palette"],
    calmTipSeen: true, saveProgressAsked: ["claude|me|week|2026-09-30"], petHintAt: 1000, recentsOpen: false };
  assert.deepEqual((await saved(first)).choices, older, "the older choices are now the engine's, and what fails its check is left out");
  assert.equal((await saved(first)).values.inboxSeenAt, 2000, "when the Inbox was last seen comes along too");
  assert.deepEqual((await saved(first)).conversations, { names: { [taxes]: "Taxes" }, pinned: [taxes], buried: [] },
    "only this person's own conversation keeps its labels");
  /* The import happens once: what lands in this page's storage later is only a copy, never imported. */
  await before.page.evaluate(() => localStorage.setItem("branch-rail-view", "trunks"));
  const imports = [];
  before.page.on("request", (request) => { if (request.url().endsWith("/api/ui-preferences/import")) imports.push(request); });
  const read = before.page.waitForResponse((r) => r.url().endsWith("/api/ui-preferences") && r.request().method() === "GET", { timeout: 120000 });
  await before.page.reload();
  await read;
  await before.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await before.page.waitForTimeout(300);
  assert.equal(imports.length, 0, "no second import is asked for");
  assert.deepEqual((await saved(first)).choices, older, "a second start imports nothing");
  /* A folded group is kept by the engine too. */
  await before.page.evaluate(() => document.querySelector('.group-head[data-toggle="projects"]').click()); // the side list is folded
  await waitFor(() => saved(first).then((kept) => kept.values.projectsOpen === false), "the folded group is saved");
  assert.deepEqual(before.errors, []);
  await before.context.close();
  for (const close of open.splice(0).reverse()) await close();

  /* An update: the same data folder, a new engine on a new port, so a new address with empty storage. */
  const updated = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  open.push(() => updated.close());
  const second = await startServer(updated, { dataDir: join(root, "data"), port: 0 });
  open.push(() => second.close());
  assert.notEqual(new URL(second.url).port, new URL(first.url).port);
  const after = await openWindow(browser, second);
  assert.equal(await after.page.evaluate(() => document.body.classList.contains("no-rail")), true, "the side list stays folded");
  assert.equal(await after.page.evaluate(() => localStorage.getItem("branch-rail")), "closed", "and this address keeps a copy");
  assert.equal(await after.page.locator('.group-head[data-toggle="projects"]').getAttribute("aria-expanded"), "false", "the group stays folded");
  /* The pinned, named conversation comes back too, even with this address's copy gone. */
  await after.page.evaluate(() => { localStorage.removeItem("branch-names"); localStorage.removeItem("branch-pins"); });
  await after.page.reload();
  await after.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await after.page.locator("#rail-list .rail-item", { hasText: "📌 Taxes" }).waitFor({ state: "attached", timeout: 30000 });
  await after.page.evaluate(() => document.querySelector('#rail-list .row-actions button[aria-label^="Pin"]').click());
  await waitFor(() => saved(second).then((kept) => kept.conversations.pinned.length === 0), "unpinning is saved to the engine");
  /* The engine's record answers, not this page's copy (a private window, or cleared storage, has none). */
  await after.page.evaluate(() => { localStorage.removeItem("branch-first-run-next"); globalThis.branchFirstRunDone(); });
  assert.equal(await after.page.locator("#first-run-next").count(), 0, "a line already shown once is not shown again after an update");

  await after.page.evaluate(() => document.getElementById("rail-toggle").click());
  await after.page.waitForFunction(() => !document.body.classList.contains("no-rail"));
  await assert.doesNotReject(async () => {
    for (let tries = 0; tries < 50 && (await saved(second)).choices.railOpen !== true; tries++) await after.page.waitForTimeout(100);
  });
  assert.deepEqual((await saved(second)).choices, { ...older, projectsOpen: false, railOpen: true }, "a change here is the engine's at once, and nothing else moves");
  assert.deepEqual(after.errors, []);
});

/** An engine and its server in a throwaway folder, with a headless browser, all closed afterwards. */
async function freshWindowSetup(t) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const root = await mkdtemp(join(tmpdir(), "branch-ui-prefs-window-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => {
    await browser.close();
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discardTemp(root);
  });
  return { browser, server, app };
}
const post = (server, path, body) => fetch(new URL(path, server.url), {
  method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});

test("a plain browser tab that signs in shows the kept choices without a reload", async (t) => {
  const { browser, server } = await freshWindowSetup(t);
  assert.equal((await post(server, "/api/ui-preferences", { set: { railOpen: false, projectsOpen: false } })).status, 200);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator("#login").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await page.evaluate(() => document.body.classList.contains("no-rail")), false, "before signing in the engine cannot be read");
  await page.locator("#token").fill(server.token);
  await page.locator("#login-form").evaluate((form) => form.requestSubmit());
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => document.body.classList.contains("no-rail"), undefined, { timeout: 10000 });
  assert.equal(await page.locator('.group-head[data-toggle="projects"]').getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => localStorage.getItem("branch-rail")), "closed", "this address keeps a copy");
  assert.deepEqual((await saved(server)).choices, { railOpen: false, projectsOpen: false }, "showing them saves nothing back");
  assert.deepEqual(errors, []);
});

/** Switches the engine to somebody else, the way the window's own who-is-using-Branch menu does. */
const switchTo = (page, profileId, pin) => page.evaluate(async ([id, code]) => {
  const { api, noteWindowProfile } = await import("/app.js");
  await api("profiles/switch", { profileId: id, ...(code ? { pin: code } : {}) });
  noteWindowProfile(id === null, { force: true });
}, [profileId, pin]);

test("switching person shows that person's own choices, never the owner's, and switching back brings the owner's", async (t) => {
  const { browser, server, app } = await freshWindowSetup(t);
  const sam = await (await post(server, "/api/profiles", { name: "Sam", pin: "2468" })).json();
  const { page, errors, imports } = await openWindow(browser, server);
  await waitFor(() => Promise.resolve(imports.length > 0), "the first start writes the import down even with nothing to bring");
  assert.deepEqual(imports, [200]);
  assert.deepEqual((await saved(server)).choices, {}, "drawing the window saves no defaults back");
  assert.ok((await saved(server)).imports["legacy-local-v1"]);
  const sections = page.locator('.group-head[data-toggle="sections"]');
  await page.locator("#rail-toggle").click();
  await waitFor(() => saved(server).then((kept) => kept.values.railOpen === false), "the owner's fold is saved");

  await switchTo(page, sam.id, "2468");
  await page.waitForFunction(() => !document.body.classList.contains("no-rail"), undefined, { timeout: 10000 });
  assert.equal((await saved(server)).forOwner, false, "the engine is on Sam's profile");
  await sections.evaluate((head) => head.click()); // the calm window keeps the group heads out of sight
  await waitFor(() => saved(server).then((kept) => kept.values.sectionsOpen === false), "Sam's fold is saved");
  assert.deepEqual((await saved(server)).choices, { sectionsOpen: false }, "Sam's record holds only Sam's choice");
  assert.equal(await page.evaluate(() => localStorage.getItem("branch-rail")), "closed", "Sam's window leaves the owner's copy alone");
  /* Sam's own conversation keeps Sam's label, read from the engine: Sam's window keeps no copy in this page's storage. */
  const homework = app.store.createSession(`profile:${sam.id}`);
  app.store.sqlite.prepare("INSERT INTO messages(session_id,body) VALUES(?,?)").run(homework, JSON.stringify({ role: "user", content: "Fractions" }));
  assert.equal((await post(server, "/api/ui-preferences", { mark: { id: homework, name: "Homework", pinned: true } })).status, 200);
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#rail-list .rail-item", { hasText: "📌 Homework" }).waitFor({ state: "attached", timeout: 30000 });
  assert.equal(await page.evaluate(() => localStorage.getItem("branch-pins")), null, "and no copy of it lands here");

  await switchTo(page, null);
  await page.waitForFunction(() => document.body.classList.contains("no-rail"), undefined, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.group-head[data-toggle="sections"]').getAttribute("aria-expanded") === "true",
    undefined, { timeout: 10000 });
  assert.deepEqual((await saved(server)).choices, { railOpen: false }, "the owner's record is untouched");
  assert.deepEqual(errors, []);
});

test("a choice the engine could not save says so", async (t) => {
  const { browser, server } = await freshWindowSetup(t);
  const { page, errors } = await openWindow(browser, server);
  await page.route("**/api/ui-preferences", (route) => (route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk full" }) })
    : route.continue()));
  const heard = page.evaluate(() => new Promise((done) => document.addEventListener("branch-ui-prefs-unsaved", function hear(event) {
    if (!event.detail.fields.includes("railOpen")) return;
    document.removeEventListener("branch-ui-prefs-unsaved", hear);
    done(event.detail);
  })));
  await page.locator("#rail-toggle").click();
  assert.deepEqual(await heard, { fields: ["railOpen"] }, "the fold is what could not be saved");
  await page.locator("#toast", { hasText: "could not be saved with your workspace" }).waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await page.evaluate(() => document.body.classList.contains("no-rail")), true, "the window keeps showing the choice");
  assert.deepEqual(errors, []);
});

test("an engine that does not answer at start is asked again, and its choices then show", async (t) => {
  const { browser, server } = await freshWindowSetup(t);
  assert.equal((await post(server, "/api/ui-preferences", { set: { railOpen: false } })).status, 200);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript((token) => sessionStorage.setItem("branch-token", token), server.token);
  let refused = 0;
  await context.route("**/api/ui-preferences", (route) => (route.request().method() === "GET" && refused++ === 0
    ? route.abort("connectionreset") : route.continue()));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => document.body.classList.contains("no-rail"), undefined, { timeout: 15000 });
  assert.equal(refused >= 2, true, "the first read was dropped and a later one answered");
  assert.deepEqual(errors, []);
});

test("switching from one household person to another, the way the People card does, shows the next person's choices", async (t) => {
  const { browser, server, app } = await freshWindowSetup(t);
  const sam = await (await post(server, "/api/profiles", { name: "Sam", pin: "2468" })).json();
  const alex = await (await post(server, "/api/profiles", { name: "Alex", pin: "1357" })).json();
  const { page, errors } = await openWindow(browser, server);
  await switchTo(page, sam.id, "2468");
  await page.waitForFunction(() => document.documentElement.dataset.household === "on", undefined, { timeout: 10000 });
  await page.locator("#rail-toggle").click();
  await waitFor(() => Promise.resolve(readUiPreferences(app.store, `profile:${sam.id}`).values.railOpen === false), "Sam's fold is saved");

  /* The People card switches, then the window's own refresh notices; nobody forces a profile event. */
  await page.evaluate(async (id) => { const { api } = await import("/app.js"); await api("profiles/switch", { profileId: id, pin: "1357" }); }, alex.id);
  await page.waitForFunction(() => !document.body.classList.contains("no-rail"), undefined, { timeout: 15000 });
  assert.deepEqual(readUiPreferences(app.store, `profile:${alex.id}`).values.railOpen, undefined, "Alex has nothing of Sam's");
  assert.equal(readUiPreferences(app.store, `profile:${sam.id}`).values.railOpen, false, "Sam's record is untouched");
  assert.deepEqual(errors, []);
});

test("the first entry of a list reaches the engine, and the next one keeps it", async (t) => {
  const { browser, server } = await freshWindowSetup(t);
  const { page, errors, imports } = await openWindow(browser, server);
  await waitFor(() => Promise.resolve(imports.length > 0), "the first start writes the import down");
  await page.evaluate(async () => {
    const { keepChoice, choicesSaved } = await import("/ui-prefs.js");
    keepChoice("branch-save-progress-asked", JSON.stringify(["claude|me|week|2026-09-30"]));
    await choicesSaved();
    keepChoice("branch-save-progress-asked", JSON.stringify(["claude|me|week|2026-09-30", "claude|me|day|2026-09-24"]));
    await choicesSaved();
  });
  assert.deepEqual((await saved(server)).values.saveProgressAsked, ["claude|me|week|2026-09-30", "claude|me|day|2026-09-24"]);
  assert.deepEqual(errors, []);
});

test("a choice made while the engine is read after signing in is not undone by the answer", async (t) => {
  const { browser, server } = await freshWindowSetup(t);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator("#login").waitFor({ state: "visible", timeout: 120000 });
  /* The read after signing in is held back a moment, and a choice is made meanwhile. */
  await page.route("**/api/ui-preferences", async (route) => {
    if (route.request().method() === "GET") await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  const reading = page.waitForRequest((request) => request.url().endsWith("/api/ui-preferences") && request.method() === "GET");
  await page.locator("#token").fill(server.token);
  await page.locator("#login-form").evaluate((form) => form.requestSubmit());
  await reading;
  await page.evaluate(async () => { const { keepChoice } = await import("/ui-prefs.js"); keepChoice("branch-aside", "closed"); });
  await waitFor(() => saved(server).then((kept) => kept.imports["legacy-local-v1"] !== undefined), "the read after signing in lands");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(async () => (await import("/ui-prefs.js")).choice("branch-aside")), "closed", "the window still shows it");
  await waitFor(() => saved(server).then((kept) => kept.values.asideOpen === false), "and the engine has it");
  assert.deepEqual(errors, []);
});
