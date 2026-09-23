import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { runCommand } from "../dist/terminal-command-table.js";
import { Conversation } from "../dist/terminal-conversation.js";
import { loadWords } from "../dist/terminal-words.js";

/*
 * FQ-surfaces.attachments, the send itself: every file attached with /attach — a picture, a sound,
 * a video and a document — must reach the model on the next message with its kind and its file
 * reference, and a document's words must still be read in the way they were before it was given
 * a kind of its own. Checked on what the model was actually handed, not on a helper's return value.
 */

/** A PDF built by hand with one page that says "Hello there" (the same shape the reader tests use). */
function helloPdf(page = "BT /F1 12 Tf 72 720 Td (Hello there) Tj ET") {
  const content = Buffer.from(page, "latin1");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
  ];
  const head = Buffer.from(`%PDF-1.4\n${objects.join("\n")}\n4 0 obj << /Length ${content.length} >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
    + "trailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
  return Buffer.concat([head, content, tail]);
}

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const files = {
  "photo.png": png,
  "note.mp3": Buffer.from("ID3-SOUND-BYTES-SHOULD-NOT-BE-READ"),
  "clip.mp4": Buffer.from("ftyp-VIDEO-BYTES-SHOULD-NOT-BE-READ"),
  "report.pdf": helloPdf(),
  "legacy.doc": Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x41, 0x42, 0x43]),
  "letter.rtf": Buffer.from("{\\rtf1\\ansi RICH LETTER WORDS\\par}", "latin1"),
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-send-"));
  const seen = [];
  const provider = { name: "scripted", acceptsImages: true,
    async complete(request) { seen.push(request); return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = join(root, "files");
  await mkdir(folder, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(folder, name), bytes);
  const conversation = new Conversation(app.runtime, () => {}, 10);
  const said = [];
  const context = { runtime: app.runtime, conversation, words: loadWords("en"),
    say: (kind, text) => said.push([kind, text]) };
  return { app, seen, folder, conversation, context, said };
}

/** The user turn the model was handed for this prompt, from the provider's own request. */
function userTurn(seen, prompt) {
  for (const request of seen) {
    const turn = request.messages.filter((m) => m.role === "user").at(-1);
    if (turn && String(turn.content).startsWith(prompt)) return turn;
  }
  assert.fail(`the model never received a message starting "${prompt}"`);
}

test("every attached kind reaches the model with its type and reference, and a document is still read", async (t) => {
  const { seen, folder, conversation, context, said } = await setup(t);
  for (const name of Object.keys(files)) await runCommand(context, `/attach ${join(folder, name)}`);
  assert.equal(conversation.attachments.length, 6,said.map(([, text]) => text).join("\n"));

  await conversation.send("look at these");
  const turn = userTurn(seen, "look at these");
  const text = String(turn.content);

  const expected = [
    ["photo.png", "image", "image/png"],
    ["note.mp3", "audio", "audio/mpeg"],
    ["clip.mp4", "video", "video/mp4"],
    ["report.pdf", "document", "application/pdf"],
    ["legacy.doc", "document", "application/msword"],
    ["letter.rtf", "document", "application/rtf"],
  ];
  for (const [name, kind, mediaType] of expected) {
    const header = text.split("\n").find((line) => line.includes(name) && line.startsWith("--- attached"));
    assert.ok(header, `${name}: the model was told it was attached\n${text}`);
    assert.ok(header.includes(kind), `${name}: its kind (${kind}) went with it: ${header}`);
    assert.ok(header.includes(mediaType), `${name}: its media type (${mediaType}) went with it: ${header}`);
    assert.ok(text.includes(join(folder, name)), `${name}: its file reference went with it`);
  }

  assert.match(text, /Hello there/, "the PDF's words were read into the message, as a document was before");
  assert.match(text, /RICH LETTER WORDS/, "a rich-text document's words were read too");
  assert.doesNotMatch(text, /\\rtf1/, "the rich text was read by its reader, not pasted in raw");
  assert.equal(turn.images?.length, 1, "the picture went as a picture");
  assert.equal(turn.images[0].mediaType, "image/png");
  assert.equal(turn.images[0].data, png.toString("base64"));
  assert.doesNotMatch(text, /SOUND-BYTES|VIDEO-BYTES/, "a sound or a video is never decoded into words");
  assert.equal(conversation.attachments.length, 0, "the attachments went with that one message");
});

test("/attach says plainly that a readable document's words go with the next message", async (t) => {
  const { folder, context, said } = await setup(t);
  await runCommand(context, `/attach ${join(folder, "report.pdf")}`);
  const note = said.filter(([kind]) => kind === "note").map(([, text]) => text).join("\n");
  assert.match(note, /report\.pdf/);
  assert.match(note, /kept as document \(application\/pdf\)/);
  assert.match(note, /its words and reference go with your next message/);
});

/** The scanned page docs-memory-2 uses: a picture drawn on the page, and no words the reader can lift. */
const scannedPdf = helloPdf("q 200 0 0 100 72 600 cm /Im1 Do Q");

test("/attach of a scanned PDF says no words could be read, and the model gets its reference, not an empty body", async (t) => {
  const { seen, folder, conversation, context, said } = await setup(t);
  const scan = join(folder, "scan.pdf");
  await writeFile(scan, scannedPdf);
  await runCommand(context, `/attach ${scan}`);
  const note = said.filter(([kind]) => kind === "note").map(([, text]) => text).join("\n");
  assert.doesNotMatch(note, /its words and reference go/, "the owner is not told words go along when none were read");
  assert.match(note, /scan\.pdf/);
  assert.match(note, /kept as document \(application\/pdf\)/);
  assert.match(note, /no words could be read from it; only its reference goes with your next message/);

  await conversation.send("what does the scan say");
  const text = String(userTurn(seen, "what does the scan say").content);
  const block = text.slice(text.indexOf("--- attached document: scan.pdf"));
  assert.ok(block.startsWith("--- attached document: scan.pdf (application/pdf) at " + scan), text);
  const body = block.split("\n")[1];
  assert.match(body, /^\[not read into this message; the file is at the path above\]$/, `no empty body: ${JSON.stringify(body)}`);
  assert.match(block, /pictures of text/, "the reader's reason still goes with it");
});

test("/attach of a scanned PDF says so in French too", async (t) => {
  const { folder, context, said } = await setup(t);
  context.words = loadWords("fr");
  const scan = join(folder, "scan.pdf");
  await writeFile(scan, scannedPdf);
  await runCommand(context, `/attach ${scan}`);
  const note = said.filter(([kind]) => kind === "note").map(([, text]) => text).join("\n");
  assert.match(note, /scan\.pdf/);
  assert.match(note, /aucun mot n'a pu être lu/);
  assert.match(note, /seule sa référence part avec votre prochain message/);
});
