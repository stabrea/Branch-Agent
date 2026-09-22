import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { maximumHistory, maximumLinksFollowed, maximumPageBytes, maximumPages, maximumSnippet } from "../dist/wiki.js";

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
