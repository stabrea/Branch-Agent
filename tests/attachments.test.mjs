import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Attachments, attachmentForWindow, attachmentLimits, kindOf, rangeWanted, shownInPage } from "../dist/attachments.js";
import { maxAttachmentsBytesPerTurn } from "../dist/contracts.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

/**
 * Owner item: a file a person attaches is kept, and the message keeps a reference to it.
 *
 * Until now a picture's bytes went to the model for one request and the conversation was left with
 * "[attached picture: dot.png]"; a sound became words and a video became a few stills, and both
 * originals were dropped. So a conversation could not show, afterwards, what it had been given.
 *
 * Everything here is local: a scripted model, files built in the test, and a server on a port of its
 * own.
 */

const owner = "local";
/** A real, tiny PNG (one pixel), a real WAV header with silence, and a small MP4-shaped file. */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function wav(seconds = 1, rate = 8000) {
  const data = Buffer.alloc(seconds * rate * 2);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(((i * 31) % 2000) - 1000, i);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(8), Buffer.from("a short film")]);
const markdown = Buffer.from("# Notes\n\nThe roof was fixed on Tuesday.\n", "utf8");

const attached = (name, mediaType, bytes) => ({ name, mediaType, data: bytes.toString("base64") });
const FOUR = [
  attached("photo.png", "image/png", png),
  attached("note.wav", "audio/wav", wav()),
  attached("clip.mp4", "video/mp4", mp4),
  attached("roof.md", "text/markdown", markdown),
];

async function branch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attachments-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Got them.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, host: new URL(server.url).host };
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const fetchFile = (query, extra = {}) =>
    fetch(`${server.url}/api/attachments/file?${query}`, { headers: { ...headers, ...extra } });
  return { app, root, server, headers, post, fetchFile };
}

test("four kinds of file attach to one message, and the conversation keeps what it was given", async (t) => {
  const { app, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Here is everything about the roof.", attachments: FOUR });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const sessionId = run.body.sessionId ?? app.store.sessions?.(owner)?.[0]?.id;
  assert.ok(sessionId, "the run says which conversation it is in");

  // Read back out of the store, not out of memory: this is what a reopened conversation would show.
  const message = app.store.messages(sessionId).find((one) => one.role === "user");
  assert.ok(message, "the person's own message is there");
  assert.equal(message.attachments?.length, 4, "all four files are kept with it");
  assert.deepEqual(message.attachments.map((one) => one.kind), ["picture", "sound", "video", "document"]);
  assert.deepEqual(message.attachments.map((one) => one.name), ["photo.png", "note.wav", "clip.mp4", "roof.md"]);
  assert.deepEqual(message.attachments.map((one) => one.mediaType),
    ["image/png", "audio/wav", "video/mp4", "text/markdown"], "each file's own type, as it arrived");
  assert.deepEqual(message.attachments.map((one) => one.bytes),
    [png.length, wav().length, mp4.length, markdown.length], "and its real size");
  for (const one of message.attachments) assert.match(one.id, /^[a-f0-9]{16}$/, "named by an id, never a path");
  assert.match(message.content, /roof\.md \(document\)/, "and the words say a file came with it");
});

test("each kept file comes back exactly, shown in the page or handed over as a download", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep these.", attachments: FOUR });
  const sessionId = run.body.sessionId;
  const refs = app.store.messages(sessionId).find((one) => one.role === "user").attachments;
  const sent = { "photo.png": png, "note.wav": wav(), "clip.mp4": mp4, "roof.md": markdown };

  for (const ref of refs) {
    const answer = await fetchFile(`session=${sessionId}&id=${ref.id}`);
    assert.equal(answer.status, 200, `${ref.name} comes back`);
    assert.equal(answer.headers.get("content-type"), ref.mediaType, "the type kept with the file");
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    assert.match(answer.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.equal(answer.headers.get("accept-ranges"), "bytes");
    const shown = shownInPage(ref.mediaType);
    assert.match(answer.headers.get("content-disposition") ?? "", new RegExp(`^${shown ? "inline" : "attachment"};`),
      `${ref.name} is ${shown ? "shown in the page" : "handed over as a download"}`);
    assert.ok(Buffer.from(await answer.arrayBuffer()).equals(sent[ref.name]), `${ref.name} is byte for byte what was sent`);
  }
  assert.equal(shownInPage("text/markdown"), false, "a document is never shown in the page itself");
  assert.equal(shownInPage("image/svg+xml"), false, "and nor is anything that could carry script");
});

test("a player can ask for part of a sound, and is told plainly when it asks past the end", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Listen to this.", attachments: [FOUR[1]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const whole = wav();

  const part = await fetchFile(`session=${sessionId}&id=${ref.id}`, { range: "bytes=100-199" });
  assert.equal(part.status, 206, "part of it, as a player asks");
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${whole.length}`);
  assert.equal(part.headers.get("content-length"), "100");
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(whole.subarray(100, 200)), "and it is the right part");

  const past = await fetchFile(`session=${sessionId}&id=${ref.id}`, { range: `bytes=${whole.length + 10}-` });
  assert.equal(past.status, 416, "asking past the end is refused, not answered with the wrong bytes");
  assert.equal(past.headers.get("content-range"), `bytes */${whole.length}`);

  // The reading itself, on its own: a whole file, the last bytes, and nonsense.
  assert.deepEqual(rangeWanted("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(rangeWanted("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(rangeWanted("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(rangeWanted("bytes=200-300", 100), "outside");
  assert.equal(rangeWanted("bytes=50-10", 100), "outside");
  assert.equal(rangeWanted("rows=1-2", 100), null, "something that is not a range is answered whole");
  assert.equal(rangeWanted(undefined, 100), null);
});

test("an id that names nothing, or a conversation that is not this one, gets the same plain refusal", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];

  for (const [what, query] of [
    ["an id nobody made", `session=${sessionId}&id=${"0".repeat(16)}`],
    ["an id that is not an id", `session=${sessionId}&id=${encodeURIComponent("../../kept.json")}`],
    ["a name that climbs out", `session=${encodeURIComponent("../..")}&id=${ref.id}`],
    ["a conversation this file is not in", `session=${"1".repeat(32)}&id=${ref.id}`],
    ["nothing at all", ""],
  ]) {
    const answer = await fetchFile(query);
    assert.equal(answer.status, 404, `${what} is refused`);
  }
});

test("somebody else at this computer cannot open the owner's attached file", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  assert.equal((await fetchFile(`session=${sessionId}&id=${ref.id}`)).status, 200, "the owner can open it");

  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const refused = await fetchFile(`session=${sessionId}&id=${ref.id}`);
  assert.ok(refused.status >= 400, `a household profile is refused (${refused.status})`);
  assert.notEqual(refused.status, 200, "and never handed the bytes");

  app.store.profiles.switch({ profileId: null });
  assert.equal((await fetchFile(`session=${sessionId}&id=${ref.id}`)).status, 200, "the owner still can");
});

test("handing a file back checks who is asking, before it looks anything up", async (t) => {
  const { app, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const parts = { profiles: app.store.profiles, attachments: app.attachments,
    temporaryConversation: (session) => app.store.sessionTemporary(session) };

  assert.ok((await attachmentForWindow(parts, { session: sessionId, id: ref.id })).bytes.equals(png),
    "the owner is handed the file");

  // Straight at the helper, with nothing in front of it: the guard inside it is the only thing deciding.
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(attachmentForWindow(parts, { session: sessionId, id: ref.id }),
    "somebody else at this computer is refused by the delivery itself");
  app.store.profiles.switch({ profileId: null });
});

test("the route is written down as the owner's, so it cannot quietly become anybody's", () => {
  assert.equal(ROUTES["/api/attachments/file"], "owner GET",
    "the one place that says who may ask for an attached file");
});

test("a real file, not a token one: a picture past the old 64 KiB ceiling goes through whole", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  // 300 KB of picture: far past the ordinary JSON ceiling, which is what made the stated limits
  // decoration until now, and small enough to keep the test quick.
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
  const sent = Buffer.concat([png, big]);

  const run = await post("/api/run", { prompt: "Keep this photo.", attachments: [attached("holiday.png", "image/png", sent)] });
  assert.equal(run.status, 200, `a 300 KB picture is accepted (${JSON.stringify(run.body).slice(0, 200)})`);
  const ref = app.store.messages(run.body.sessionId).find((one) => one.role === "user").attachments[0];
  assert.equal(ref.bytes, sent.length, "its real size is written down");

  const back = await fetchFile(`session=${run.body.sessionId}&id=${ref.id}`);
  assert.equal(back.status, 200);
  assert.ok(Buffer.from(await back.arrayBuffer()).equals(sent), "and it comes back byte for byte");
});

test("one message can only carry so much altogether, however it is divided", async (t) => {
  const { app } = await branch(t);
  // Two films: each is inside the 32 MB a film may be, and together they are past what one message may
  // carry. That is the difference between a per-kind limit and the budget for the whole turn.
  const half = Buffer.alloc(Math.ceil(maxAttachmentsBytesPerTurn / 2) + 1024);
  const twoHalves = [attached("a.mp4", "video/mp4", half), attached("b.mp4", "video/mp4", half)];

  await assert.rejects(app.attachments.keep("00000000-0000-4000-8000-00000000000a", twoHalves),
    /can add up to 32 MB/, "two files that each fit but together do not are refused");
  assert.equal(maxAttachmentsBytesPerTurn, 32 * 1024 * 1024, "the budget for one message");
});

test("a batch with one bad file in it leaves nothing behind", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-batch-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const store = new Attachments(root);
  const session = "00000000-0000-4000-8000-00000000000b";

  await assert.rejects(store.keep(session, [
    attached("good.png", "image/png", png),
    attached("also-good.md", "text/markdown", markdown),
    attached("nope.exe", "application/x-msdownload", Buffer.from("MZ")),
  ]), /does not take application\/x-msdownload/);

  const folder = join(root, session.replace(/[^a-z0-9]/gi, ""));
  const left = await readdir(folder).catch(() => []);
  assert.deepEqual(left, [], "not one byte of the two good files was written");
  assert.deepEqual(await store.list(session), [], "and nothing is claimed to be attached");
});

test("two messages attaching at once keep both sets of files", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-race-"));
  t.after(() => discardTemp(scratch));
  const store = new Attachments(join(scratch, "attachments"));
  const session = "00000000-0000-4000-8000-00000000000c";

  const [first, second] = await Promise.all([
    store.keep(session, [attached("one.png", "image/png", png)]),
    store.keep(session, [attached("two.md", "text/markdown", markdown)]),
  ]);

  const listed = await store.list(session);
  assert.equal(listed.length, 2, "both are there, neither wrote the other out of the listing");
  assert.ok(listed.some((one) => one.id === first[0].id));
  assert.ok(listed.some((one) => one.id === second[0].id));
});

test("the sweep works from a list taken before the app is ready, so later files are safe", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attachments-sweep-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  // Enough leftovers that the sweep is still working when the app is handed back.
  const attachmentsRoot = join(root, "data", "attachments");
  for (let i = 0; i < 400; i++) {
    const left = join(attachmentsRoot, `tmp-old${String(i).padStart(29, "0")}`);
    await mkdir(left, { recursive: true });
    await writeFile(join(left, "kept.json"), "[]", "utf8");
  }

  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  closing.push(() => app.close());

  // The slow path, which is the one that matters: a temporary conversation started the moment the app
  // is ready, while the sweep may still be running. Its folder was not on the list, so it survives.
  const session = "00000000-0000-4000-8000-00000000000e";
  const made = await app.attachments.keep(session, [attached("now.png", "image/png", png)], { temporary: true });
  await new Promise((resolve) => setTimeout(resolve, 1500)); // let any sweep still running finish
  assert.equal((await app.attachments.list(session, { temporary: true })).length, 1,
    "a file attached after readiness is not swept away");
  assert.ok((await app.attachments.read(session, made[0].id, { temporary: true })).bytes.equals(png));

  // And the leftovers really were cleared.
  const left = (await readdir(attachmentsRoot).catch(() => [])).filter((one) => one.startsWith("tmp-old"));
  assert.deepEqual(left, [], "every folder from before is gone");
});

test("the sweep decides what to remove before it gives up the thread, proved by when it looked", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-snap-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  mkdirSync(root, { recursive: true });
  for (const name of ["tmp-old-one", "tmp-old-two", "lasting-conversation"]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "kept.json"), "[]");
  }

  // The listing is held still by the test, so this proves *when* the decision was made rather than
  // how fast a disk happens to be.
  const looked = [];
  const store = new Attachments(root, (path) => { looked.push(path); return readdirSync(path); });

  const sweeping = store.sweepTemporary();
  // Nothing has been awaited yet: if the list were read on a later tick, this would still be 0.
  assert.equal(looked.length, 1, "it looked once, before it handed back a promise");
  assert.equal(looked[0], root);

  // A temporary conversation that begins now cannot be on a list that was taken a moment ago.
  mkdirSync(join(root, "tmp-begun-after"), { recursive: true });
  writeFileSync(join(root, "tmp-begun-after", "kept.json"), "[]");
  const swept = await sweeping;

  assert.equal(swept, 2, "only the two it had seen were removed");
  assert.equal(looked.length, 1, "and it did not look again afterwards");
  const left = readdirSync(root).sort();
  assert.deepEqual(left, ["lasting-conversation", "tmp-begun-after"],
    "the new conversation's folder and the lasting one are both untouched");
});

test("a media type that is not one is refused before it can become a header", async (t) => {
  const { app, post } = await branch(t);

  // Built rather than typed, so the characters that matter survive being written down.
  const headerSplit = "image/png" + String.fromCharCode(13, 10) + "X-Evil: 1";
  const withControl = "text/plain" + String.fromCharCode(0);
  for (const bad of [headerSplit, "image png", "image/", withControl, "  "]) {
    const answer = await post("/api/run", {
      prompt: "Keep this.",
      attachments: [{ name: "odd.png", mediaType: bad, data: png.toString("base64") }],
    });
    assert.ok(answer.status >= 400, `"${bad.replace(/[^ -~]/g, "?")}" is refused (${answer.status})`);
  }
  // And the store refuses it too, not only the route.
  await assert.rejects(app.attachments.keep("00000000-0000-4000-8000-00000000000f",
    [{ name: "odd.png", mediaType: headerSplit, data: png.toString("base64") }]));

  const good = await post("/api/run", { prompt: "This one is fine.", attachments: [attached("fine.png", "image/png", png)] });
  assert.equal(good.status, 200, "an ordinary media type still works");
});

test("a file too big for its kind, or of a kind Branch does not take, is refused by name", async (t) => {
  const { app } = await branch(t);
  const store = app.attachments;

  await assert.rejects(
    store.keep("session-one", [attached("huge.png", "image/png", Buffer.alloc(attachmentLimits.picture + 1))]),
    /Pictures up to 5 MB can be attached, so huge\.png was skipped/);
  await assert.rejects(
    store.keep("session-one", [attached("run.exe", "application/x-msdownload", Buffer.from("MZ"))]),
    /Branch does not take application\/x-msdownload files/);
  await assert.rejects(
    store.keep("session-one", [attached("empty.png", "image/png", Buffer.alloc(0))]),
    /empty\.png came through empty/);

  // The limits themselves, so the page and the server cannot drift apart silently.
  assert.equal(attachmentLimits.picture, 5 * 1024 * 1024);
  assert.equal(attachmentLimits.sound, 25 * 1024 * 1024);
  assert.equal(attachmentLimits.video, 32 * 1024 * 1024);
  assert.equal(attachmentLimits.document, 20 * 1024 * 1024, "the Documents panel's own limit, shared not copied");
  assert.equal(kindOf("image/png"), "picture");
  assert.equal(kindOf("audio/ogg; codecs=opus"), "sound");
  assert.equal(kindOf("video/webm"), "video");
  assert.equal(kindOf("application/pdf"), "document");
});

test("a conversation's files go when the conversation does", async (t) => {
  const { app, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  assert.ok((await app.attachments.read(sessionId, ref.id)).bytes.equals(png), "it is there to begin with");

  app.store.forgetSession(owner, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 50)); // the folder goes just after the rows do
  await assert.rejects(app.attachments.read(sessionId, ref.id), /not attached to this conversation/,
    "and nothing is left pointing at a file that is gone");
});

test("a temporary conversation's files are marked, and swept away after a stop at the wrong moment", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-tmp-"));
  t.after(() => discardTemp(scratch));
  const store = new Attachments(join(scratch, "attachments"));

  const kept = await store.keep("00000000-0000-4000-8000-000000000001", [FOUR[0]], { temporary: true });
  const folders = await readdir(join(scratch, "attachments"));
  assert.equal(folders.length, 1);
  assert.match(folders[0], /^tmp-/, "a temporary conversation's folder says so");
  assert.ok((await store.read("00000000-0000-4000-8000-000000000001", kept[0].id, { temporary: true })).bytes.equals(png));

  // A lasting conversation beside it must survive the sweep.
  await store.keep("00000000-0000-4000-8000-000000000002", [FOUR[0]]);
  assert.equal(await store.sweepTemporary(), 1, "one temporary folder swept");
  assert.deepEqual((await readdir(join(scratch, "attachments"))).filter((one) => one.startsWith("tmp-")), []);
  assert.equal((await readdir(join(scratch, "attachments"))).length, 1, "and the lasting one is untouched");
});

test("a folder that is really a link to somewhere else is not followed", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-link-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const outside = join(scratch, "elsewhere");
  const session = "00000000-0000-4000-8000-000000000004";
  const plain = session.replace(/[^a-z0-9]/gi, "");
  const id = "abcdef0123456789";

  // Somewhere outside the store, holding a file and a listing that names it in the ordinary way.
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, id), Buffer.from("not yours"), "utf8");
  await writeFile(join(outside, "kept.json"),
    JSON.stringify([{ id, kind: "document", mediaType: "text/plain", name: "secret.txt", bytes: 9 }]), "utf8");

  // The conversation's folder is a link to it. Nothing about the id is wrong; only where it leads is.
  await mkdir(root, { recursive: true });
  const linked = await symlink(outside, join(root, plain), "junction").then(() => true).catch(() => false);
  if (!linked) {
    t.skip("this computer does not allow making links");
    return;
  }
  await assert.rejects(new Attachments(root).read(session, id), /not attached to this conversation/,
    "the file is outside the store, so it is not opened");
});

test("a file that is not really inside the store is never opened", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-out-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const store = new Attachments(root);
  const session = "00000000-0000-4000-8000-000000000003";
  const kept = await store.keep(session, [FOUR[0]]);

  // A listing that has been tampered with to name a file outside the store is refused by the id check.
  await writeFile(join(root, session.replace(/[^a-z0-9]/gi, ""), "kept.json"),
    JSON.stringify([{ ...kept[0], id: "../../elsewhere" }]), "utf8");
  await assert.rejects(store.read(session, "../../elsewhere"), /not attached to this conversation/);
  await assert.rejects(store.read(session, kept[0].id), /not attached to this conversation/);
});
