import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { mergeThreeWay } from "../dist/workspace-editor-merge.js";
import { discardTemp } from "./temp-dir.mjs";

/* FQ-workspace.markdown: a stale save in the code editor (A0098) is merged with the newer version
 * on disk when the two edits touch different lines, instead of being refused outright. */

test("mergeThreeWay: non-overlapping edits merge; an edit to the same line still returns null", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";
  const mine = "one\nTWO\nthree\nfour\nfive\n"; // changes line 2
  const theirs = "one\ntwo\nthree\nFOUR\nfive\n"; // changes line 4
  assert.equal(mergeThreeWay(base, mine, theirs), "one\nTWO\nthree\nFOUR\nfive\n");

  // Both sides append a different line at the end — still non-overlapping.
  assert.equal(
    mergeThreeWay("a\nb\n", "a\nb\nmine\n", "a\nb\ntheirs\n"),
    "a\nb\nmine\ntheirs\n",
  );

  // Same side unchanged from base: the other side's version wins outright.
  assert.equal(mergeThreeWay(base, base, theirs), theirs);
  assert.equal(mergeThreeWay(base, mine, base), mine);

  // Identical edits on both sides are not a conflict.
  assert.equal(mergeThreeWay(base, mine, mine), mine);

  // A real conflict: both sides change the same line (line 2) differently.
  const conflictingMine = "one\nMINE\nthree\nfour\nfive\n";
  const conflictingTheirs = "one\nTHEIRS\nthree\nfour\nfive\n";
  assert.equal(mergeThreeWay(base, conflictingMine, conflictingTheirs), null);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wsedit-merge-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir, provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/workspace-editor/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  await call("settings", { mode: "on" });
  return { call, workspace };
}
const read = (path) => `read?path=${encodeURIComponent(path)}`;

test("A0098 a stale save that touches a different line merges instead of being refused", async (t) => {
  const { call, workspace } = await fixture(t);
  await writeFile(join(workspace, "notes.md"), "# Title\n\nfirst line\nsecond line\n");
  const opened = await call(read("notes.md"));

  // Someone else saves a change to the second line while this session still has the file open.
  await writeFile(join(workspace, "notes.md"), "# Title\n\nfirst line\nSECOND LINE\n");

  // This session's edit only touches the first line, so the two do not conflict.
  const saved = await call("save", {
    path: "notes.md",
    content: "# Title\n\nFIRST LINE\nsecond line\n",
    opened: opened.body.opened,
    base: opened.body.content,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.merged, true);
  const onDisk = "# Title\n\nFIRST LINE\nSECOND LINE\n";
  assert.equal(saved.body.content, onDisk);
  assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), onDisk);

  // The checksum handed back opens the next save.
  const again = await call("save", { path: "notes.md", content: `${onDisk}more\n`, opened: saved.body.opened, base: onDisk });
  assert.equal(again.status, 200);
});

test("A0098 a stale save that touches the same line as the newer version is still refused", async (t) => {
  const { call, workspace } = await fixture(t);
  await writeFile(join(workspace, "notes.md"), "first\n");
  const opened = await call(read("notes.md"));
  await writeFile(join(workspace, "notes.md"), "changed by someone else\n");

  const stale = await call("save", { path: "notes.md", content: "mine\n", opened: opened.body.opened, base: opened.body.content });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you opened it/);
  assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), "changed by someone else\n");
});

test("A0098 a stale save with no base offered (an older client) still refuses exactly as before", async (t) => {
  const { call, workspace } = await fixture(t);
  await writeFile(join(workspace, "notes.md"), "one\ntwo\nthree\n");
  const opened = await call(read("notes.md"));
  await writeFile(join(workspace, "notes.md"), "one\nTWO\nthree\n");

  const stale = await call("save", { path: "notes.md", content: "ONE\ntwo\nthree\n", opened: opened.body.opened });
  assert.equal(stale.status, 409);
  assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), "one\nTWO\nthree\n");

  // A base that does not actually match the checksum it was opened at is ignored, not trusted.
  const lying = await call("save", { path: "notes.md", content: "ONE\ntwo\nthree\n", opened: opened.body.opened, base: "one\ntwo\nthree\nfour\n" });
  assert.equal(lying.status, 409);
});
