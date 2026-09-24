import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { addPolicyRule } from "../dist/policy.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { maximumHistory, maximumLinksFollowed, maximumOwnerBytes, maximumPageBytes, maximumPages, maximumSnippet } from "../dist/wiki.js";

/**
 * The linked wiki: pages with names, and links between them written `[[like this]]`.
 *
 * The thing worth proving is not that words can be saved — memory already saves words. It is that a
 * page may point at a page nobody has written yet, and that the link starts working the moment
 * somebody writes it; that two pages pointing at each other do not send a read round in circles; and
 * that correcting a page is something somebody decides to do and says why, with what the page used to
 * say still there afterwards.
 *
 * Everything here is local: a scripted model and a temporary data directory. No window opens.
 */

const owner = "local";

async function branch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-wiki-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Noted.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  return { app, wiki: app.wiki, root, closing };
}

async function served(t) {
  const { app, wiki, root, closing } = await branch(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const call = async (method, path, body) => {
    const answer = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  return { app, wiki, server, call };
}

test("wiki tools live in the memory toolbox instead of expanding every model round", async (t) => {
  const { app } = await branch(t);
  for (const name of ["wiki.read", "wiki.write", "wiki.search", "wiki.history"])
    assert.equal(app.registry.groupOf(name), "memory", `${name} belongs with the other saved knowledge tools`);
});

test("a page can point at one that does not exist yet, and the link starts working when it does", async (t) => {
  const { wiki } = await branch(t);
  wiki.write(owner, { title: "Roof", body: "Fixed on Tuesday.\n\nSee [[Gutters]] as well." });

  // Nobody has written Gutters. The link is still a link, and says so plainly.
  const before = wiki.read(owner, "Roof");
  assert.equal(before.links.length, 1);
  assert.deepEqual(before.links[0], { text: "Gutters", title: "Gutters", pageId: null, snippet: null },
    "the name as it was written, and nothing claimed about a page that is not there");

  // Now somebody writes it, and nothing about the Roof page changes.
  const gutters = wiki.write(owner, { title: "Gutters", body: "Cleared in autumn.\n\nThey feed the drain." });
  const after = wiki.read(owner, "Roof", { follow: true });
  assert.equal(after.links[0].pageId, gutters.page.id, "the link resolves, without the page being rewritten");
  assert.equal(after.links[0].title, "Gutters");
  assert.equal(after.links[0].snippet, "Cleared in autumn.", "the first paragraph, and only the first");
  assert.equal(after.page.version, 1, "the page that carries the link was never touched");

  // Asking without following brings back no snippet at all.
  assert.equal(wiki.read(owner, "Roof").links[0].snippet, null, "a snippet is something the read asked for");
});

test("a read follows links one hop, so two pages that point at each other do not go round", async (t) => {
  const { wiki } = await branch(t);
  wiki.write(owner, { title: "Roof", body: "It leaks over [[Kitchen]]." });
  wiki.write(owner, { title: "Kitchen", body: "The ceiling is stained.\n\nBecause of the [[Roof]]." });

  const reading = wiki.read(owner, "Roof", { follow: true });
  assert.equal(reading.links.length, 1);
  assert.equal(reading.links[0].snippet, "The ceiling is stained.");
  // The link is four plain facts. It carries no page of its own, so there is nowhere for a second hop
  // to happen and nothing for a circle to go round.
  assert.deepEqual(Object.keys(reading.links[0]).sort(), ["pageId", "snippet", "text", "title"]);
});

test("a name is matched however it is spelled, and the page keeps the spelling it was given", async (t) => {
  const { wiki } = await branch(t);
  const written = wiki.write(owner, { title: "Roof Repairs", body: "Sam did them." });

  assert.equal(wiki.read(owner, "roof repairs").page.id, written.page.id, "found by a different spelling");
  assert.equal(wiki.read(owner, "  ROOF   repairs ").page.id, written.page.id, "and through odd spacing");

  wiki.write(owner, { title: "Bills", body: "The one for [[ROOF repairs]] is paid." });
  const link = wiki.read(owner, "Bills").links[0];
  assert.equal(link.text, "ROOF repairs", "the link says exactly what was written");
  assert.equal(link.title, "Roof Repairs", "and names the page the way the page names itself");
  assert.equal(link.pageId, written.page.id);
});

test("a second page by the same name is refused, and the one already there is untouched", async (t) => {
  const { wiki } = await branch(t);
  const first = wiki.write(owner, { title: "Roof", body: "Fixed on Tuesday." });

  assert.throws(() => wiki.write(owner, { title: "roof", body: "Something else entirely." }),
    /already a page called "Roof"/, "a colliding name is refused, and the refusal says which page");

  assert.equal(wiki.count(owner), 1, "no second page was made");
  const still = wiki.read(owner, "Roof").page;
  assert.equal(still.id, first.page.id);
  assert.equal(still.body, "Fixed on Tuesday.", "and the words that were there are the words that are there");
  assert.equal(still.version, 1);
});

test("correcting a page is something somebody decides, and what it used to say is kept", async (t) => {
  const { wiki } = await branch(t);
  wiki.write(owner, { title: "Roof", body: "Fixed on Tuesday." });

  const corrected = wiki.write(owner, { title: "roof", body: "Fixed on Wednesday.", why: "Sam checked the invoice." });
  assert.equal(corrected.replaced, true);
  assert.equal(corrected.page.version, 2);
  assert.equal(corrected.page.title, "Roof", "the page keeps its own spelling");
  assert.equal(corrected.page.why, "Sam checked the invoice.");

  // Reading it now gives the new words.
  assert.equal(wiki.read(owner, "Roof").page.body, "Fixed on Wednesday.");
  // And what it used to say is still there, with the reason beside it.
  const earlier = wiki.history(owner, corrected.page.id);
  assert.equal(earlier.length, 1);
  assert.equal(earlier[0].version, 1);
  assert.equal(earlier[0].body, "Fixed on Tuesday.", "the words it used to say, kept whole");
});

test("a page keeps ten earlier versions, and says when the oldest is let go", async (t) => {
  const { wiki } = await branch(t);
  const page = wiki.write(owner, { title: "Roof", body: "Version 1." }).page;
  let dropped = null;
  for (let version = 2; version <= 13; version += 1)
    dropped = wiki.write(owner, { title: "Roof", body: `Version ${version}.`, why: `correction ${version}` }).oldestVersionDropped;

  const earlier = wiki.history(owner, page.id);
  assert.equal(earlier.length, maximumHistory, "ten, and no more");
  assert.equal(earlier[0].version, 12, "newest of the kept versions first");
  assert.equal(earlier.at(-1).version, 3, "and the oldest two are gone");
  assert.equal(dropped, 2, "the write said out loud which one it let go");
  assert.equal(wiki.read(owner, "Roof").page.body, "Version 13.");
});

test("a page longer than a page may be is refused before anything is written", async (t) => {
  const { wiki } = await branch(t);
  const tooMuch = "x".repeat(maximumPageBytes + 1);
  assert.throws(() => wiki.write(owner, { title: "Roof", body: tooMuch }), /32 KiB/);
  assert.equal(wiki.count(owner), 0, "nothing was written");

  // And a correction that would be too long leaves the page exactly as it was.
  wiki.write(owner, { title: "Roof", body: "Short." });
  assert.throws(() => wiki.write(owner, { title: "Roof", body: tooMuch, why: "trying" }), /32 KiB/);
  assert.equal(wiki.read(owner, "Roof").page.body, "Short.");
  assert.equal(wiki.history(owner, wiki.find(owner, "Roof").id).length, 0, "and nothing was kept either");
});

test("the wiki holds a thousand pages, and the thousand and first is refused with nothing written", async (t) => {
  const { wiki } = await branch(t);
  for (let number = 1; number <= maximumPages; number += 1)
    wiki.write(owner, { title: `Page ${number}`, body: "." });
  assert.equal(wiki.count(owner), maximumPages);

  assert.throws(() => wiki.write(owner, { title: "One too many", body: "." }), /already holds 1000 pages/);
  assert.equal(wiki.count(owner), maximumPages, "still a thousand");
  assert.equal(wiki.find(owner, "One too many"), undefined, "and the refused page is nowhere");

  // A correction to a page that is already there is not a new page, so it is not refused.
  const corrected = wiki.write(owner, { title: "Page 1", body: "Still here.", why: "it is allowed" });
  assert.equal(corrected.page.version, 2);
});

test("near the bound, a correction is weighed against the version it lets go", async (t) => {
  const { app, wiki } = await branch(t);
  const db = app.store.sqlite;

  // A page holding its ten kept versions. Each of them weighs its title and body: "Roof" and 4,096.
  const body = "x".repeat(4096);
  const each = "Roof".length + body.length;
  wiki.write(owner, { title: "Roof", body });
  for (let version = 2; version <= maximumHistory + 1; version += 1)
    wiki.write(owner, { title: "Roof", body, why: `correction ${version}` });
  const page = wiki.find(owner, "Roof");
  assert.equal(wiki.history(owner, page.id).length, maximumHistory, "it is holding its ten");

  // The wiki is put right up against its bound without 128 MB being written: one row's own counter is
  // set to the weight it would have. This is arithmetic the check does, so arithmetic is what it needs.
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO wiki_pages(id,owner,title,same_name,body,why,bytes,version,created_at,updated_at)
    VALUES('filler',?,'Filler','filler','.',NULL,?,1,?,?)`)
    .run(owner, maximumOwnerBytes - wiki.weight(owner) - each, now, now);
  const before = wiki.weight(owner);
  assert.equal(before, maximumOwnerBytes - each, "room for exactly the version that is about to be let go");

  // Too big by one byte, counting the version that goes: refused, and nothing at all is changed.
  // A page weighing one byte more than the two it is measured against: what it replaces plus what is
  // let go. The check sees `before + this - letGo`, so this is the first size that does not fit.
  const overBy = { title: "Roof", body: "y".repeat(each * 2 - "Roof".length + 1), why: "one too many" };
  assert.throws(() => wiki.write(owner, overBy), /may hold 128 MB altogether/);
  assert.equal(wiki.weight(owner), before, "not a byte was written");
  assert.equal(wiki.find(owner, "Roof").version, maximumHistory + 1, "the page is on the version it was");
  assert.equal(wiki.find(owner, "Roof").body, body, "with the words it had");
  assert.equal(wiki.history(owner, page.id).length, maximumHistory, "and its ten are all still there");

  // Exactly what fits once the oldest kept version goes: allowed, and the total is what was predicted.
  const fits = { title: "Roof", body: "z".repeat(each * 2 - "Roof".length), why: "this one fits" };
  const predicted = before + ("Roof".length + fits.body.length) - each;
  const written = wiki.write(owner, fits);
  assert.equal(written.replaced, true);
  assert.equal(written.oldestVersionDropped, 1, "the oldest kept version, the very first, is the one that went");
  assert.equal(wiki.weight(owner), predicted, "and the wiki weighs exactly what the check said it would");
  assert.equal(wiki.weight(owner), maximumOwnerBytes, "right up against the bound, and inside it");
  assert.equal(wiki.history(owner, page.id).length, maximumHistory, "still ten, one of them new");
});

test("a read brings back twenty-five links and says how many it left", async (t) => {
  const { wiki } = await branch(t);
  const names = Array.from({ length: 30 }, (_unused, index) => `Page ${index + 1}`);
  wiki.write(owner, { title: "Index", body: names.map((name) => `[[${name}]]`).join(" ") });
  for (const name of names) wiki.write(owner, { title: name, body: `About ${name}.` });

  const reading = wiki.read(owner, "Index", { follow: true });
  assert.equal(reading.links.length, maximumLinksFollowed, "twenty-five, not thirty");
  assert.equal(reading.linksNotFollowed, 5, "and it says how many it did not follow");
  assert.equal(reading.links[0].snippet, "About Page 1.");
});

test("a snippet is one paragraph, cut where it has to be", async (t) => {
  const { wiki } = await branch(t);
  const long = `${"word ".repeat(200).trim()}\n\nA second paragraph nobody asked for.`;
  wiki.write(owner, { title: "Long", body: long });
  wiki.write(owner, { title: "Short", body: "Look at [[Long]]." });

  const snippet = wiki.read(owner, "Short", { follow: true }).links[0].snippet;
  assert.equal(snippet.length, maximumSnippet, "cut to what fits beside a link");
  assert.ok(!snippet.includes("second paragraph"), "and it is the first paragraph only");
});

test("the wiki is the owner's: somebody else at this computer is refused by the routes themselves", async (t) => {
  const { app, call } = await served(t);
  assert.equal((await call("POST", "/api/wiki", { title: "Roof", body: "Fixed." })).status, 200);
  assert.equal((await call("GET", "/api/wiki/page?title=Roof")).status, 200);

  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.notEqual((await call("GET", "/api/wiki/page?title=Roof")).status, 200,
    "reading a page is the owner's");
  assert.notEqual((await call("POST", "/api/wiki", { title: "Theirs", body: "." })).status, 200,
    "and so is writing one");
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.wiki.count(app.runtime.owner), 1, "nothing of theirs was written");
});

test("the wiki is the owner's through the tools as well, not only through the routes", async (t) => {
  const { app } = await branch(t);
  const context = app.runtime.context({});
  const tools = [
    ["wiki.read", { title: "Roof" }],
    ["wiki.search", { query: "roof" }],
    ["wiki.history", { title: "Roof" }],
    ["wiki.write", { title: "Theirs", body: "." }],
  ];

  // The owner, at the window: everything works.
  await app.registry.execute("wiki.write", { title: "Roof", body: "Fixed on Tuesday." }, context);
  const read = await app.registry.execute("wiki.read", { title: "Roof" }, context);
  assert.equal(read.page.body, "Fixed on Tuesday.");

  // Somebody else at this computer. The routes never see a tool call, so the guard has to be here.
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  for (const [tool, args] of tools)
    await assert.rejects(app.registry.execute(tool, args, context), `${tool} is the owner's`);
  app.store.profiles.switch({ profileId: null });

  // A script's own key.
  for (const [tool, args] of tools)
    await assert.rejects(underShortLivedKey(() => app.registry.execute(tool, args, context)),
      /short-lived key cannot read or write the wiki/, `${tool} with a short-lived key`);

  // And a message from a chat app, which cannot prove who is typing.
  for (const [tool, args] of tools)
    await assert.rejects(app.registry.execute(tool, args, { ...context, source: "channel" }),
      /chat app cannot read or write the wiki/, `${tool} from a chat`);

  assert.equal(app.wiki.count(app.runtime.owner), 1, "and nothing of theirs was written");
});

test("following links declares every page it would hand back, so a refused page stays refused", async (t) => {
  const { app, wiki } = await branch(t);
  wiki.write(owner, { title: "Private", body: "The safe code is 1234." });
  wiki.write(owner, { title: "Index", body: "Everything worth knowing: [[Private]]." });
  addPolicyRule(app.store, owner, { tool: "wiki.*", match: "wiki/private", decision: "deny", remember: "always" });
  const context = app.runtime.context({});

  // What the rules are shown. Following a link reads the page it points at, so that page is named.
  assert.deepEqual(app.registry.targetsOf("wiki.read", { title: "Index", follow: true }, context),
    [{ kind: "read", path: "wiki/index" }, { kind: "read", path: "wiki/private" }]);

  const following = app.runtime.checkPolicy("wiki.read", { title: "Index", follow: true }, context);
  assert.equal(following.decision, "deny", "a piece of the refused page cannot come back through a link");
  assert.match(following.reason ?? "", /wiki\/private/, "and the refusal names the page that was refused");

  // Reading the index itself is untouched: the rule is about the private page, not about links.
  assert.notEqual(app.runtime.checkPolicy("wiki.read", { title: "Index", follow: false }, context).decision, "deny");
});

test("a correction is weighed by the name the page keeps, not the one the caller typed", async (t) => {
  const { app, wiki } = await branch(t);
  const db = app.store.sqlite;
  const bytesOf = (title) => Number(db.prepare("SELECT bytes FROM wiki_pages WHERE owner=? AND same_name=?")
    .get(owner, title.trim().replace(/\s+/g, " ").toLowerCase()).bytes);

  // The page's own name has two spaces in it; the alias below writes one, so it is shorter. Weighing
  // the caller's spelling would undercount, and a page bigger than a page may be would be stored.
  const kept = "Roof  Repairs";
  wiki.write(owner, { title: kept, body: "." });
  const fits = maximumPageBytes - Buffer.byteLength(kept, "utf8");
  assert.throws(() => wiki.write(owner, { title: "roof repairs", body: "x".repeat(fits + 1), why: "one too many" }),
    /32 KiB/, "measured by the name really kept, this is one byte too many");
  assert.equal(wiki.find(owner, kept).body, ".", "and nothing was written");

  const written = wiki.write(owner, { title: "roof repairs", body: "x".repeat(fits), why: "exactly what fits" });
  assert.equal(written.page.title, kept, "the page keeps its own name");
  assert.equal(bytesOf(kept), maximumPageBytes, "and what is stored weighs exactly what a page may weigh");

  // The other way round: an alias with more spaces than the name kept would overcount, and refuse a
  // correction that fits perfectly well.
  const door = "Front Door";
  wiki.write(owner, { title: door, body: "." });
  const room = maximumPageBytes - Buffer.byteLength(door, "utf8");
  const wide = wiki.write(owner, { title: "front    door", body: "y".repeat(room), why: "still fits" });
  assert.equal(wide.page.title, door);
  assert.equal(bytesOf(door), maximumPageBytes, "the longer spelling was never what was measured");
});

test("what a call would touch is worked out for the owner alone, so a refusal cannot name a page", async (t) => {
  const { app, wiki } = await branch(t);
  wiki.write(owner, { title: "Private", body: "The safe code is 1234." });
  wiki.write(owner, { title: "Index", body: "Everything worth knowing: [[Private]]." });
  addPolicyRule(app.store, owner, { tool: "wiki.*", match: "wiki/private", decision: "deny", remember: "always" });

  // A task as the runtime writes one down, started for somebody else at this computer.
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const started = (over) => {
    const run = app.store.createRun(app.runtime.owner, "a task");
    app.store.event(run.id, "run.started", { source: "owner", parentRunId: null, ...over });
    return app.runtime.context({ runId: run.id });
  };

  // Working out what the call would touch reads the owner's page to resolve its links. For anybody but
  // the owner that must not happen at all: the refusal itself would otherwise say the page's name.
  const theirs = started({ personProfileId: sam.id });
  assert.deepEqual(app.registry.targetsOf("wiki.read", { title: "Index", follow: true }, theirs),
    [{ kind: "read", path: "wiki/index" }], "only the name they typed themselves comes back");
  const judged = app.runtime.checkPolicy("wiki.read", { title: "Index", follow: true }, theirs);
  assert.doesNotMatch(judged.reason ?? "", /private/i, "and no refusal names a page they may not know exists");

  // The same at the policy boundary for a task a chat message started, and for a short-lived key.
  const fromChat = started({ source: "channel" });
  assert.deepEqual(app.registry.targetsOf("wiki.read", { title: "Index", follow: true }, fromChat),
    [{ kind: "read", path: "wiki/index" }], "a chat cannot prove who is typing, so it learns nothing either");
  assert.doesNotMatch(app.runtime.checkPolicy("wiki.read", { title: "Index", follow: true }, fromChat).reason ?? "", /private/i);

  const asOwner = started({});
  const withKey = underShortLivedKey(() => app.registry.targetsOf("wiki.read", { title: "Index", follow: true }, asOwner));
  assert.deepEqual(withKey, [{ kind: "read", path: "wiki/index" }], "a script's own key learns nothing either");

  // And the owner's own call is judged on everything it really reads, exactly as before.
  assert.deepEqual(app.registry.targetsOf("wiki.read", { title: "Index", follow: true }, asOwner),
    [{ kind: "read", path: "wiki/index" }, { kind: "read", path: "wiki/private" }]);
  assert.equal(app.runtime.checkPolicy("wiki.read", { title: "Index", follow: true }, asOwner).decision, "deny");
});

test("an owner's own task keeps its linked targets while the window is on somebody else", async (t) => {
  const { app, wiki } = await branch(t);
  wiki.write(owner, { title: "Private", body: "The safe code is 1234." });
  wiki.write(owner, { title: "Index", body: "Everything worth knowing: [[Private]]." });
  addPolicyRule(app.store, owner, { tool: "wiki.*", match: "wiki/private", decision: "deny", remember: "always" });

  const run = app.store.createRun(app.runtime.owner, "the owner's own task");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const context = app.runtime.context({ runId: run.id });

  // The owner has switched the window to somebody else's profile. Their task is still their task, and
  // reading the window here would quietly drop the linked page from what the rules are shown — the call
  // would then be allowed through and would hand back a piece of the very page the owner refused.
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });

  assert.deepEqual(app.registry.targetsOf("wiki.read", { title: "Index", follow: true }, context),
    [{ kind: "read", path: "wiki/index" }, { kind: "read", path: "wiki/private" }],
    "every page the read would reach is still named");
  const judged = app.runtime.checkPolicy("wiki.read", { title: "Index", follow: true }, context);
  assert.equal(judged.decision, "deny", "so the owner's own rule about the private page still refuses it");
  assert.match(judged.reason ?? "", /wiki\/private/, "and the refusal names it");
  app.store.profiles.switch({ profileId: null });
});

test("every wiki tool says what it touches, by page or by the whole wiki", async (t) => {
  const { app } = await branch(t);
  const context = { owner: app.runtime.owner, workspace: ".", runId: "targets", permissions: new Set(), depth: 0 };
  assert.equal(app.registry.targetOf("wiki.read", { title: "Roof Repairs", follow: false }, context), "wiki/roof repairs");
  assert.equal(app.registry.targetOf("wiki.write", { title: "Roof Repairs", body: "." }, context), "wiki/roof repairs");
  assert.equal(app.registry.targetOf("wiki.search", { query: "roof", limit: 20 }, context), "wiki");

  const writing = app.registry.targetsOf("wiki.write", { title: "Roof", body: "." }, context);
  assert.deepEqual(writing, [{ kind: "write", path: "wiki/roof" }], "a write says it writes, and where");
  const reading = app.registry.targetsOf("wiki.read", { title: "Roof", follow: false }, context);
  assert.deepEqual(reading, [{ kind: "read", path: "wiki/roof" }]);
  const searching = app.registry.targetsOf("wiki.search", { query: "roof", limit: 20 }, context);
  assert.deepEqual(searching, [{ kind: "read", path: "wiki", folder: true }],
    "a search reaches the whole wiki and says so, so a rule about the wiki can judge it");
});

test("wiki page targets keep policy syntax inside one page name", async (t) => {
  const { app, wiki } = await branch(t);
  const context = app.runtime.context({});
  const cases = [
    [".", "wiki/%2E"],
    ["..", "wiki/%2E%2E"],
    ["A/B", "wiki/a%2Fb"],
    ["A\\B", "wiki/a%5Cb"],
    ["*", "wiki/%2A"],
    ["%2F", "wiki/%252f"],
    ["Other/../Private", "wiki/other%2F..%2Fprivate"],
  ];

  const paths = cases.map(([title, expected]) => {
    const read = app.registry.targetOf("wiki.read", { title, follow: false }, context);
    assert.equal(read, expected, `${title} has one unambiguous read target`);
    assert.equal(app.registry.targetOf("wiki.write", { title, body: "." }, context), expected);
    assert.equal(app.registry.targetOf("wiki.history", { title }, context), expected);
    assert.deepEqual(app.registry.targetsOf("wiki.read", { title, follow: false }, context),
      [{ kind: "read", path: expected }]);
    return read;
  });
  assert.equal(new Set(paths).size, cases.length, "different normalized page names have different targets");

  wiki.write(owner, { title: "Index/..", body: "Read [[A/B]]." });
  wiki.write(owner, { title: "A/B", body: "One linked page." });
  assert.deepEqual(app.registry.targetsOf("wiki.read", { title: "Index/..", follow: true }, context), [
    { kind: "read", path: "wiki/index%2F.." },
    { kind: "read", path: "wiki/a%2Fb" },
  ], "followed pages use the same opaque target representation");
});

test("one page's approval never names a different page", async (t) => {
  const { app, wiki } = await branch(t);
  wiki.write(owner, { title: "Private", body: "one" });
  wiki.write(owner, { title: "Other/../Private", body: "two" });
  const context = app.runtime.context({});
  const args = { title: "Other/../Private", follow: false };
  addPolicyRule(app.store, owner, { tool: "wiki.*", match: "*", decision: "deny", remember: "always" });
  const before = app.runtime.checkPolicy("wiki.read", args, context);
  assert.equal(before.decision, "deny", "the broad owner rule has to refuse wiki reads first");
  addPolicyRule(app.store, owner, { tool: "wiki.*", match: "wiki/private", decision: "allow", remember: "always" });
  assert.equal(app.runtime.checkPolicy("wiki.read", { title: "Private", follow: false }, context).decision, "allow");
  assert.notEqual(app.runtime.checkPolicy("wiki.read", args, context).decision, "allow",
    "an approval for Private must not authorize a distinct page");
});
