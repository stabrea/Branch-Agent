/**
 * Q135: the file a failed update hands the owner to send on is cleaned in the right order (#198, carried onto
 * #176's implementation): what a terminal would obey comes out first, then secrets line by line and over the
 * whole, and only then is anything shortened, keeping both ends of an overlong last line.
 */
import test from "node:test";
import assert from "node:assert/strict";
/** One newline, written by its number, because a literal one does not survive every editor. */
const newline = String.fromCharCode(10);
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { readableUpdateLog, updateLogItem, withoutControlCharacters } from "../dist/update-failure.js";

const secret = "sk-ant-api03-" + "x".repeat(48);

/** A log the way the hand-over writes one: the end is what matters, so that is where the trouble is. */
async function updateLog(t, lines) {
  const dir = await mkdtemp(join(tmpdir(), "branch-update-log-"));
  t.after(() => discardTemp(dir));
  await writeFile(join(dir, "apply-update.log"), lines.join("\n"), "utf8");
  return dir;
}
const escape = String.fromCharCode(27);

test("a label on one line and its value on the next is still found", () => {
  // Splitting decides what the redactor is allowed to read, exactly as shortening does. Cleaning
  // each line on its own cannot see a label above its value -- and that is not a contrived shape,
  // it is what a failed update writes when the update server refuses it: a pretty-printed 401 with
  // "cookie": on one line and the session on the next. Cleaning each line stops a cut hiding a
  // label from the redactor; cleaning the joined result stops a newline hiding one. Both are needed,
  // and a version with only the first of them let this through whole.
  const refusal = [
    "step 8: the update server refused us (401):",
    "  {",
    '    "cookie":',
    '      "session=9f8e7d6c5b4a39281706",',
    '    "authorization":',
    '      "Bearer abcdefghijklmnop1234"',
    "  }",
    "step 9: failed to move the folder",
  ].join(newline);
  const out = readableUpdateLog(refusal);

  assert.equal(out.includes("9f8e7d6c5b4a39281706"), false, `the session is gone (${out})`);
  assert.equal(out.includes("abcdefghijklmnop1234"), false, "and so is what came after the authorization line");
  assert.match(out, /step 9: failed to move the folder/, "and the step it stopped on is still readable");
});

test("a key whose label is cut out of the middle of a line does not leave its tail behind", () => {
  // The last line of an oversized log keeps both of its ends and drops the middle. Shortening it
  // before looking for secrets let the shortening decide what the redactor was allowed to read: a
  // key whose label sat in the discarded middle arrived with nothing beside it to recognise.
  // Measured on this exact shape before the order was changed: 24 characters of the key, in plain
  // sight, at the end of the one file the owner is told to send on.
  const tail = "ZZTAILOFTHEKEY9876543210";
  const key = "sk-ant-api03-" + "Q".repeat(2500) + tail;  // not-a-real-secret
  const line = "step 9: " + "filler ".repeat(600) + "authorization: Bearer " + key;
  const last = readableUpdateLog("step 1 fine" + String.fromCharCode(10) + "" + line).split(newline).at(-1);

  assert.equal(last.includes(tail), false, `the end of the key is gone (${last.slice(-80)})`);
  assert.equal(/Q{20}/.test(last), false, "and so is the middle of it");
  assert.match(last, /authorization: .removed./, "what is left says a key was there and was taken out");
});

test("a value the line limit cuts short does not leave the front of a key in plain sight", () => {
  // Every line but the last keeps its beginning and drops the rest. Cutting before looking for
  // secrets means the redactor is handed a value that has already lost its end, so the shape it
  // knows how to recognise is not there any more and what it does not recognise it leaves alone.
  // Measured at this exact offset before the order was changed: "apiKey=sk-proj-ab" survived, at
  // the end of the line, in the file the owner is told to send on.
  const line = "step 4: " + "z".repeat(1975) + "apiKey=sk-proj-abcdefghij1234567890 and then it stopped";  // not-a-real-secret
  const first = readableUpdateLog(line + "" + newline + "step 5 done").split(newline)[0];

  assert.equal(first.includes("sk-proj-"), false, `no part of the key is left (${first.slice(-40)})`);
  assert.match(first, /apiKey=/, "the line still says a key was there");
  assert.ok(first.length <= 2000, `and the line is still bounded (${first.length})`);
});
test("a secret with an escape sequence hidden inside it is still taken out", async (t) => {
  // The order is the whole finding. Looking for secrets *before* cleaning the text means an escape in the
  // middle of a key breaks the shape the redactor looks for, so the key goes through — and then the escape
  // is helpfully removed, leaving it in plain sight in the file the owner is told to send.
  //
  // Each of these is a case where nothing else would have caught it: a key with no label beside it, a path
  // with no `authorization:` in front of it, an address the escape splits in two.
  const broken = (text, at) => text.slice(0, at) + escape + "[0m" + text.slice(at);
  const key = "sk-ant-api03-A1b2C3d4E5f6G7h8I9j0KLMNOPQRSTUVWX";
  const dir = await updateLog(t, [
    `step 7: using ${broken(key, 25)}`,
    `at ${broken("C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "bishi" + String.fromCharCode(92) + "Documents", 12)}`,
    `mail ${broken("someone@example.com", 4)}`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes("KLMNOPQRSTUVWX"), false, `no part of the key survives (${item.text.slice(0, 160)})`);
  assert.equal(item.text.includes("G7h8I9j0"), false, "not even the half after the escape");
  assert.equal(item.text.includes("example.com"), false, "the address is gone whole");
  assert.equal(item.text.includes("some"), false, "including the half before the escape");
  assert.match(item.text, /step 9: failed to move the folder/, "and what went wrong is still readable");
});

test("a bare carriage return, which writes over the line before it, does not survive", async (t) => {
  // A carriage return on its own is not a newline: it sends the cursor back to the start of the line, so
  // what follows overwrites what was there. Keeping it because it looks like a line ending would let a
  // line hide another one in a file somebody opens.
  const carriageReturn = String.fromCharCode(13);
  const dir = await updateLog(t, [
    `step 4: everything is fine${carriageReturn}step 4: nothing is fine`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes(carriageReturn), false, "no bare carriage return reaches the file");
  assert.match(item.text, /everything is fine/, "both halves are still readable, one after the other");
  assert.match(item.text, /nothing is fine/);
});

test("a log with no newlines at all keeps a real ending, not the start of a piece of the middle", async (t) => {
  // Only the last 256 KiB of a log is read. When that whole window is one line, keeping its first 2,000
  // characters hands back the beginning of a fragment cut out of the middle of a file and calls it the
  // end of the update.
  const dir = await updateLog(t, [`the start of it all ${"x".repeat(400_000)} step 9: failed to move the folder`]);
  const item = await updateLogItem(dir);

  assert.match(item.text, /step 9: failed to move the folder$/, "where it stopped is the last thing in it");
  assert.ok(item.text.length <= 2000, `and it is still bounded (${item.text.length})`);
});

test("a long last line keeps both of its ends, so the step's name and its ending both survive", () => {
  const line = `[step 599] ${"y".repeat(5000)} and then it stopped`;
  const kept = readableUpdateLog(`[step 598] fine\n${line}`).split("\n").at(-1);
  assert.match(kept, /^\[step 599\]/, "which step it was");
  assert.match(kept, /and then it stopped$/, "and where it got to");
  assert.ok(kept.includes("[...]"), "with the missing middle said out loud");
  assert.ok(kept.length <= 2000);
});


test("what a terminal would obey is taken out of the file the owner is asked to send", async (t) => {
  // The hand-over script echoes what the shell and the archive tools said, so a name inside a downloaded
  // archive can put escape sequences in here. Colour is the harmless end; moving the cursor and writing
  // over what is above it is the other end, and this is the one file the owner is told to open and pass on.
  const dir = await updateLog(t, [
    "step 1: unpacking",
    `${escape}[31mstep 2: a name from the archive${escape}[0m`,
    `a bell${String.fromCharCode(7)} and a backspace${String.fromCharCode(8)} in the middle`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes(escape), false, "no escape sequences reach the file the owner opens");
  assert.equal(item.text.includes(String.fromCharCode(7)), false, "nor a bell");
  assert.equal(item.text.includes(String.fromCharCode(8)), false, "nor a backspace");
  assert.match(item.text, /step 2: a name from the archive/, "the words themselves are still there");
  assert.match(item.text, /step 9: failed to move the folder/, "and so is what went wrong");
  assert.match(item.text, /\n/, "newlines are not control characters for this purpose");
});

test("the end of the log is kept, because that is where an update stops", async (t) => {
  // Believing the opposite is easy: a check written against the first lines of a long log passes while
  // proving nothing, because those lines are exactly the ones that are dropped.
  const dir = await updateLog(t, [
    "the very first line, long ago",
    ...Array.from({ length: 900 }, (_unused, index) => `filler line ${index}`),
    "the last line, where it stopped",
  ]);
  const item = await updateLogItem(dir);
  const kept = item.text.split("\n");

  assert.equal(kept.length, 400, "four hundred lines, no more");
  assert.equal(kept.at(-1), "the last line, where it stopped");
  assert.equal(item.text.includes("the very first line, long ago"), false, "the beginning is what goes");
});

test("secrets, addresses and the owner's own folder do not reach the file either", async (t) => {
  const dir = await updateLog(t, [
    "authorization: Bearer sk-ant-api03-NOTAREALKEY-abcdefghijklmnop",
    'config {"apiKey":"sk-proj-abcdef1234567890"}',
    "owner email: someone@example.com",
    `a very long line: ${"x".repeat(6000)}`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes("sk-ant-api03-NOTAREALKEY"), false);
  assert.equal(item.text.includes("sk-proj-abcdef1234567890"), false);
  assert.equal(item.text.includes("someone@example.com"), false);
  assert.ok(Math.max(...item.text.split("\n").map((line) => line.length)) <= 2000,
    "and no single line runs away with the file");
  assert.match(item.text, /step 9: failed to move the folder/);
});

test("with no log at all it says so, rather than failing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-update-none-"));
  t.after(() => discardTemp(dir));
  const item = await updateLogItem(dir);
  assert.match(item.text, /No update has written its steps/);
});

test("taking control characters out keeps everything a person reads", () => {
  assert.equal(withoutControlCharacters(`a${escape}[1mb`), "ab");
  assert.equal(withoutControlCharacters("one\ttwo\nthree"), "one\ttwo\nthree", "tabs and newlines stay");
  assert.equal(withoutControlCharacters("plain words"), "plain words");
});


