import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { buildDocx } from "../dist/document-docx.js";
import { readDocument } from "../dist/document-readers.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every new word the Edit-together card uses has English and real French", async () => {
  const source = await readFile(new URL("documents.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/\bt\("(documents\.coedit\.[a-zA-Z.-]+|field\.(?:find|replace-with|the-workspace-file-to-edit|version-number))"/g)]
    .map((m) => m[1]))];
  assert.ok(keys.length >= 14, `expected the co-edit card's own keys, got ${keys.length}`);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
});

/**
 * FQ-workspace.office: the owner and one other person, handed only a link and a code, editing the
 * same Word file. Each side sends a plain change; the server applies it to whatever was most
 * recently saved, so both sides' non-conflicting edits survive, and a change whose target text was
 * already edited away comes back saying so instead of silently doing nothing or clobbering the file.
 */
const discard = (base) => discardTemp(base).catch(() => undefined);
async function served(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-coedit-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(base, "data") });
  const server = await startServer(app, { dataDir: join(base, "data"), port: 0 });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discard(base);
  });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (path, body, method) => {
    const response = await fetch(server.url + path, body === undefined && !method
      ? { headers } : { method: method ?? "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, workspace, server, headers, call };
}
const form = (fields) => new URLSearchParams(fields).toString();

test("the owner starts a session on an existing file and a guest can read it with the right code only", async (t) => {
  const { workspace, server, call } = await served(t);
  await writeFile(join(workspace, "report.docx"), buildDocx([{ kind: "paragraph", text: "Draft status: pending" }], "Report"));
  const started = await call("/api/office-coedit", { path: "report.docx" });
  assert.equal(started.status, 200);
  assert.match(started.body.code, /^[0-9A-F]{6}$/);
  assert.equal(started.body.version, 1);
  assert.equal(started.body.kind, "docx");
  assert.equal(started.body.link, `/coedit/${started.body.id}`);

  const noCode = await fetch(`${server.url}${started.body.link}`);
  assert.equal(noCode.status, 200, "no code shows the code-entry page, not a refusal");
  assert.match(await noCode.text(), /Enter the code|name="code"/);

  const wrong = await fetch(`${server.url}${started.body.link}?code=ZZZZZZ`);
  assert.equal(wrong.status, 403, "a wrong code gives nothing away");

  const right = await fetch(`${server.url}${started.body.link}?code=${started.body.code}`);
  assert.equal(right.status, 200);
  const page = await right.text();
  assert.ok(page.includes("Draft status: pending"), "the guest sees the document's actual words");
  assert.ok(!/<script/i.test(page), "the guest page carries no scripts");
});

test("the owner's and the guest's non-conflicting edits both land, merged onto the latest save", async (t) => {
  const { workspace, server, call } = await served(t);
  await writeFile(join(workspace, "report.docx"), buildDocx([{ kind: "paragraph", text: "Draft status: pending" }], "Report"));
  const started = await call("/api/office-coedit", { path: "report.docx" });
  const id = started.body.id, code = started.body.code;

  // The owner changes one word...
  const ownerEdit = await call(`/api/office-coedit/${id}/edit`,
    { operations: [{ op: "replace-text", find: "pending", replaceWith: "in review", all: true }] });
  assert.equal(ownerEdit.status, 200);
  assert.equal(ownerEdit.body.changes, 1);
  assert.equal(ownerEdit.body.version, 2);

  // ...and the guest, who has not seen that change, edits a different phrase in the same sentence.
  const guestEdit = await fetch(`${server.url}/coedit/${id}/edit`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ code, find: "Draft status", replaceWith: "Report status" }), redirect: "manual",
  });
  assert.equal(guestEdit.status, 303, "the guest's browser is sent back to the document, not shown a raw result");
  assert.equal(guestEdit.headers.get("location"), `/coedit/${id}?code=${code}`);

  const downloaded = await fetch(`${server.url}/api/office-coedit/${id}/file`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(downloaded.status, 200);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  const read = readDocument(bytes, "report.docx");
  assert.ok(read.text.includes("Report status: in review"), `both edits should be in the merged file, got: ${read.text}`);

  const state = await call(`/api/office-coedit/${id}`, undefined);
  assert.equal(state.status, 200);
  assert.equal(state.body.version, 3, "one version bump per change that actually matched something");
  assert.equal(state.body.log.length, 2);
  assert.deepEqual(state.body.log.map((entry) => entry.participant), ["owner", "guest"]);
});

test("a change whose target text is already gone is reported, not silently dropped or forced through", async (t) => {
  const { workspace, call } = await served(t);
  await writeFile(join(workspace, "report.docx"), buildDocx([{ kind: "paragraph", text: "Draft status: pending" }], "Report"));
  const started = await call("/api/office-coedit", { path: "report.docx" });
  const id = started.body.id;
  await call(`/api/office-coedit/${id}/edit`, { operations: [{ op: "replace-text", find: "pending", replaceWith: "done", all: true }] });
  const stale = await call(`/api/office-coedit/${id}/edit`, { operations: [{ op: "replace-text", find: "pending", replaceWith: "something else", all: true }] });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.changes, 0, "the word was already changed, so nothing here matches it");
  assert.ok(stale.body.notes.some((note) => /Nothing matched/.test(note)));
  const state = await call(`/api/office-coedit/${id}`, undefined);
  assert.equal(state.body.version, 2, "a change with nothing to do does not bump the version");
});

test("a missing file starts blank, and only Word and spreadsheet files can be edited together", async (t) => {
  const { call } = await served(t);
  const blank = await call("/api/office-coedit", { path: "new-notes.docx" });
  assert.equal(blank.status, 200);
  assert.equal(blank.body.version, 1);
  const rejected = await call("/api/office-coedit", { path: "notes.txt" });
  assert.equal(rejected.status, 400);
});
