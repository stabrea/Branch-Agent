import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { runCommand } from "../dist/terminal-command-table.js";
import { readAttachment, attachedText } from "../dist/terminal-commands.js";
import { loadWords } from "../dist/terminal-words.js";

/*
 * FQ-surfaces.attachments: one fixture that attaches an image, a sound, a video and a document to
 * a conversation through the real `/attach` terminal command (the surface the owner types into,
 * not a bare library call) and checks that all four keep the type and the file reference they
 * arrived with — nothing here quietly turns a video into words or a document into nothing.
 */

/** Stand-in bytes for each kind: not real media, just enough for the file's own kind to be told apart. */
const fixtures = {
  "photo.png": { bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), kind: "image", mediaType: "image/png" },
  "note.mp3": { bytes: Buffer.from("ID3-stand-in-mp3-bytes"), kind: "audio", mediaType: "audio/mpeg" },
  "clip.mp4": { bytes: Buffer.from("ftyp-stand-in-mp4-bytes"), kind: "video", mediaType: "video/mp4" },
  "report.pdf": { bytes: Buffer.from("%PDF-1.4-stand-in-bytes"), kind: "document", mediaType: "application/pdf" },
};

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  const files = join(root, "files");
  await mkdir(files, { recursive: true });
  for (const [name, entry] of Object.entries(fixtures)) await writeFile(join(files, name), entry.bytes);
  return { app, files };
}
function terminalContext(app, said) {
  const conversation = { sessionId: undefined, attachments: [], plan: false, verify: false, dryRun: false, temporary: false, reasoning: null };
  return {
    runtime: app.runtime, conversation, words: loadWords("en"),
    say: (kind, text) => said.push([kind, text]),
  };
}

test("readAttachment keeps the right kind, media type and file reference for each of the four", async (t) => {
  const { files } = await fixture(t);
  for (const [name, entry] of Object.entries(fixtures)) {
    const attachment = await readAttachment(join(files, name));
    assert.equal(attachment.name, name, `${name}: keeps its own name`);
    assert.equal(attachment.kind, entry.kind, `${name}: recognised as a ${entry.kind}`);
    assert.equal(attachment.mediaType, entry.mediaType, `${name}: keeps its media type`);
    assert.equal(attachment.path, join(files, name), `${name}: keeps a reference back to the file`);
    // The reference is real: reading it back gives exactly the bytes that were attached.
    assert.deepEqual(await readFile(attachment.path), entry.bytes, `${name}: the reference reads back the original bytes`);
  }
});

test("an image is also read in for the model; a sound, a video and a document are not misread as words", async (t) => {
  const { files } = await fixture(t);
  const image = await readAttachment(join(files, "photo.png"));
  assert.equal(image.image?.mediaType, "image/png");
  assert.equal(image.image?.data, fixtures["photo.png"].bytes.toString("base64"));
  assert.equal(image.text, undefined, "a picture does not also become text");

  for (const name of ["note.mp3", "clip.mp4", "report.pdf"]) {
    const attachment = await readAttachment(join(files, name));
    assert.equal(attachment.image, undefined, `${name}: not treated as a picture`);
    assert.equal(attachment.text, undefined, `${name}: its binary bytes are not decoded as text`);
  }
  // attachedText names every attachment by kind and reference, but a sound or a video file (or a
  // document no reader could open) never injects its raw binary into the next message.
  const all = await Promise.all(Object.keys(fixtures).map((name) => readAttachment(join(files, name))));
  const text = attachedText(all);
  for (const [name, entry] of Object.entries(fixtures))
    assert.ok(text.includes(`--- attached ${entry.kind}: ${name} (${entry.mediaType}) at ${join(files, name)} ---`), `${name}: named in the message`);
  assert.doesNotMatch(text, /stand-in-(mp3|mp4)-bytes|%PDF-1\.4-stand-in/, "no binary bytes were decoded as words");
});

test("/attach keeps all four kinds on the conversation at once, through the real terminal command", async (t) => {
  const { app, files } = await fixture(t);
  const said = [];
  const context = terminalContext(app, said);
  for (const name of Object.keys(fixtures)) await runCommand(context, `/attach ${join(files, name)}`);

  assert.equal(context.conversation.attachments.length, 4, "all four stayed attached together");
  const byKind = Object.fromEntries(context.conversation.attachments.map((a) => [a.kind, a]));
  assert.equal(byKind.image.mediaType, "image/png");
  assert.equal(byKind.audio.mediaType, "audio/mpeg");
  assert.equal(byKind.video.mediaType, "video/mp4");
  assert.equal(byKind.document.mediaType, "application/pdf");
  for (const kind of ["image", "audio", "video", "document"])
    assert.ok(byKind[kind].path.endsWith(Object.keys(fixtures).find((n) => fixtures[n].kind === kind)), `${kind}: kept its own reference`);

  // The command told the owner what happened, and said plainly which of the four are only kept by
  // reference (not read into the next message the way the picture and a text file would be).
  const notes = said.filter(([kind]) => kind === "note").map(([, text]) => text);
  assert.ok(notes.some((line) => line.includes("photo.png") && line.includes("goes with your next message")));
  assert.ok(notes.some((line) => line.includes("note.mp3") && line.includes("kept as audio (audio/mpeg)")));
  assert.ok(notes.some((line) => line.includes("clip.mp4") && line.includes("kept as video (video/mp4)")));
  assert.ok(notes.some((line) => line.includes("report.pdf") && line.includes("kept as document (application/pdf)")));
});

test("attaching a file that does not exist fails plainly, and nothing partial is left on the conversation", async (t) => {
  const { app, files } = await fixture(t);
  const said = [];
  const context = terminalContext(app, said);
  await runCommand(context, `/attach ${join(files, "missing.pdf")}`);
  assert.equal(context.conversation.attachments.length, 0);
  assert.ok(said.some(([kind]) => kind === "bad"));
});

test("a document whose words came back blank goes by reference, never as an empty body", () => {
  const text = attachedText([{ name: "scan.pdf", kind: "document", mediaType: "application/pdf", path: "/files/scan.pdf", text: " \n\t" }]);
  const lines = text.trim().split("\n");
  assert.equal(lines[0], "--- attached document: scan.pdf (application/pdf) at /files/scan.pdf ---");
  assert.equal(lines[1], "[not read into this message; the file is at the path above]");
});
