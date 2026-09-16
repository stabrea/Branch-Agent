/**
 * Wave 8: the bridge to the owner's notes folder. It writes Markdown notes with Branch's own
 * numbers in the front matter, refuses any path that leaves the folder, never writes over a note
 * the owner has edited, and reads back only the notes they tagged for it.
 *
 * Every test works in a temporary folder. The owner's real vault is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ObsidianBridge, bodyOf, createBranch, hashIn, insideVault, noteFileName, saveObsidianSettings, untouched,
} from "../dist/index.js";

async function bridged(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-obsidian-"));
  const vault = join(root, "vault");
  await mkdir(vault, { recursive: true });
  /* A sibling folder whose name begins the same way, for the confinement test. */
  await mkdir(join(root, "vault-other"), { recursive: true });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await saveObsidianSettings(app.store, app.runtime.owner, { enabled: true, vault, folder: "Branch" });
  return { app, root, vault, bridge: new ObsidianBridge(app.store, app.runtime.owner) };
}
const NOTE = { kind: "memory", id: "9f2a71c4-0000-4000-8000-000000000001", title: "Bin day", body: "The bins go out on Tuesday.", tags: ["home"] };

test("O1 a note is written with Branch's own numbers in its front matter", async (t) => {
  const { bridge, vault } = await bridged(t);
  const written = await bridge.write(NOTE);
  assert.equal(written.written, true);
  assert.match(written.path, /Branch/);

  const text = await readFile(written.path, "utf8");
  assert.match(text, /^---\n/, "the note has no front matter");
  assert.match(text, /branch-id: 9f2a71c4-0000-4000-8000-000000000001/);
  assert.match(text, /branch-kind: memory/);
  assert.match(text, /branch-hash: [a-f0-9]{8,}/, "nothing says what Branch wrote, so nothing can be compared later");
  assert.match(text, /The bins go out on Tuesday\./);
  assert.match(text, /#branch/, "the note carries no tag, so Branch could never read it back");
  assert.match(text, /#home/);

  /* The file went into the subfolder the owner named, inside the vault and nowhere else. */
  const inside = await readdir(join(vault, "Branch"));
  assert.deepEqual(inside, [noteFileName(NOTE)]);
});

test("O2 a path that leaves the notes folder is refused, sibling folders included", async (t) => {
  const { vault, root } = await bridged(t);
  await assert.rejects(insideVault(vault, join("..", "secrets.md")), /outside the notes folder/i);
  await assert.rejects(insideVault(vault, join("..", "vault-other", "note.md")), /outside the notes folder/i,
    "a folder whose name merely starts the same way was treated as the vault");
  await assert.rejects(insideVault(vault, join(root, "elsewhere.md")), /outside the notes folder/i);
  /* Inside is still allowed, of course. */
  assert.ok((await insideVault(vault, join("Branch", "a.md"))).includes("Branch"));
});

test("O2 a note the owner has edited is never written over", async (t) => {
  const { bridge } = await bridged(t);
  const first = await bridge.write(NOTE);
  assert.equal(untouched(await readFile(first.path, "utf8")), true, "a note Branch just wrote does not look untouched");

  /* Branch writing again over its own untouched note is fine. */
  const again = await bridge.write({ ...NOTE, body: "The bins go out on Wednesday." });
  assert.equal(again.written, true);
  assert.equal(again.conflict, null);
  assert.match(await readFile(first.path, "utf8"), /Wednesday/);

  /* Now the owner writes in it themselves. */
  const mine = (await readFile(first.path, "utf8")) + "\n\nAnd the green bin is fortnightly. — me\n";
  await writeFile(first.path, mine, "utf8");
  assert.equal(untouched(mine), false, "a note the owner edited still looks untouched");

  const third = await bridge.write({ ...NOTE, body: "The bins go out on Thursday." });
  assert.equal(third.written, false, "Branch wrote over the owner's own words");
  assert.match(third.conflict, /\.branch-conflict\.md$/);
  assert.match(await readFile(first.path, "utf8"), /— me/, "the owner's own line is gone");
  assert.equal(/Thursday/.test(await readFile(first.path, "utf8")), false, "the new version landed in the owner's note");
  assert.match(await readFile(third.conflict, "utf8"), /Thursday/, "the new version is nowhere to be found");
});

test("O3 only the notes the owner tagged are read back", async (t) => {
  const { bridge, vault } = await bridged(t);
  await bridge.write(NOTE);
  await writeFile(join(vault, "My diary.md"), "# My diary\n\nToday I did nothing at all.\n", "utf8");
  await mkdir(join(vault, "Ideas"), { recursive: true });
  await writeFile(join(vault, "Ideas", "Shed.md"), "# Shed\n\nBuild one.\n\n#branch #home\n", "utf8");

  const read = await bridge.read();
  const titles = read.map((note) => note.title).sort();
  assert.deepEqual(titles, ["Bin day (9f2a71c4)", "Shed"], "the wrong notes came back");
  assert.equal(read.some((note) => /diary/i.test(note.title)), false, "an untagged note was read anyway");
  assert.match(read.find((note) => note.title === "Shed").text, /Build one\./);
});

test("O3 the bridge refuses to do anything until the owner has named a folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-obsidian-off-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bridge = new ObsidianBridge(app.store, app.runtime.owner);
  await assert.rejects(bridge.write(NOTE), /not set up/i);
  await assert.rejects(bridge.read(), /not set up/i);
  /* And it will not be switched on pointing at nothing. */
  await assert.rejects(saveObsidianSettings(app.store, app.runtime.owner, { enabled: true, vault: "" }), /in full/i);
  await assert.rejects(saveObsidianSettings(app.store, app.runtime.owner,
    { enabled: true, vault: join(root, "nowhere") }), /no folder/i);
});

test("O1 the words are recovered from a note, so a change can be told from no change", async (t) => {
  const { bridge } = await bridged(t);
  const written = await bridge.write(NOTE);
  const text = await readFile(written.path, "utf8");
  assert.equal(bodyOf(text), "The bins go out on Tuesday.", "the words could not be read back out of the note");
  assert.ok(hashIn(text), "the note carries no hash");
});
