/**
 * Shared helpers for never-break install chaos tests.
 * Used by never-break-install-chaos-1.test.mjs through -4.test.mjs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Updater } from "../dist/desktop/updater.js";
import { posixHandOverScript, posixRollbackScript } from "../dist/desktop/hand-over.js";
import { repairSwap, watchVerdict, readWatch, writeWatch } from "../dist/never-break/canary.js";
import {
  assertFormatReadable, dataOpenError, dataProblemSentence, DataTooNewError, formatOf, migrate, storeMigrations,
} from "../dist/never-break/migrations.js";
import { backupsToPrune, backupFileName, formatCopiesToPrune, writeUpdateBackup } from "../dist/install/update-backup.js";
import { GatewayConfigSchema, loadGatewayConfig, promoteGood, saveGatewayConfig } from "../dist/never-break/gateway-config.js";
import { openJournal } from "../dist/never-break/journal.js";
import { headlessUpdate } from "../dist/install/headless-update.js";
import { doctorFix } from "../dist/doctor-fix.js";
import { builtInSpeech } from "../dist/speech-engines.js";

/** The same small repeatable random source the first chaos round uses (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const exists = (path) => stat(path).then(() => true, () => false);

/** Windows will not delete an open database, so what a test opened is closed first, in one hook. */
const closers = new WeakMap();
export async function temp(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-install-chaos-${name}-`));
  const list = closers.get(t) ?? [];
  if (!closers.has(t)) {
    closers.set(t, list);
    t.after(async () => { for (const close of list.reverse()) await close(); });
  }
  list.push(async () => {
    // A test that made a folder unwritable must not leave it that way, or it cannot be tidied up.
    for (const entry of ["", "d", "w"]) await chmod(join(root, entry), 0o700).catch(() => undefined);
    await discardTemp(root, { tries: 80, pause: 100 });
  });
  return root;
}

/**
 * A refusal a person can act on: a real sentence, about Branch's own files, saying what to do —
 * and never the system's own words for what went wrong.
 */
export const systemWords = /SQLITE_|ENOENT|EACCES|EPERM|EPIPE|errno|\[object |undefined|disk image is malformed|file is not a database|attempt to write a readonly|database is locked|database disk image/i;
export function assertPlainRefusal(label, error) {
  assert.ok(error instanceof Error, `${label}: refused with something that is not an error`);
  const text = error.message;
  assert.ok(text.length >= 40, `${label}: the refusal is too short to act on: ${text}`);
  assert.match(text, /\.\s*$|\.\s/, `${label}: the refusal is not written as sentences: ${text}`);
  assert.doesNotMatch(text, systemWords, `${label}: the refusal uses the system's own words: ${text}`);
  // It must place the owner: say whose program this is about, or say where their work now stands.
  assert.match(text, /Branch|nothing was changed|version it had|your work|your saved work/i,
    `${label}: the refusal leaves the owner guessing what it is about and what state things are in: ${text}`);
}

/** Everything of the owner's that a start must not lose. */
export async function fingerprint(dataDir, workspace) {
  const app = await createBranch({ workspace, dataDir });
  try {
    const runs = app.store.runs("local").map((run) => `${run.prompt}|${run.status}`).sort();
    const memory = app.store.list("memory", "local").map((one) => JSON.stringify(one.data)).sort();
    const settings = app.store.list("settings", "local").map((one) => JSON.stringify(one.data)).sort();
    const messages = runs.length ? app.store.runs("local").flatMap((run) => app.store.messages(run.sessionId).map((m) => m.content)) : [];
    const format = formatOf(app.store.sqlite);
    return { runs, memory, settings, messages: messages.sort(), format };
  } finally { await app.close(); }
}

/** A data folder with real work in it: a finished conversation, something remembered, a setting. */
export async function ownersData(root) {
  const dataDir = join(root, "d"), workspace = join(root, "w");
  const app = await createBranch({ workspace, dataDir });
  await app.runtime.run({ prompt: "what the owner asked for", onTextDelta: () => undefined });
  app.store.save("memory", "local", "m1", { text: "the owner's cat is called Pepper" });
  app.store.save("settings", "local", "s1", { theme: "dark", tellMeFirst: true });
  await app.close();
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 }));
  await promoteGood(dataDir, GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 }));
  return { dataDir, workspace, before: await fingerprint(dataDir, workspace) };
}

/**
 * No change to the shape of the data is half-applied. The format is either one this build knows, or
 * a newer one that says this format can still read it — which is the promise that lets an owner go
 * back one release, so it counts as whole too.
 */
export function assertFormatWhole(label, format, list = storeMigrations) {
  const newest = list.at(-1).version;
  assert.ok(format.version >= 1, `${label}: the data has no format at all (${format.version})`);
  assert.ok(format.readableBy <= format.version, `${label}: the format says it needs a newer reader than it is`);
  if (format.version > newest)
    assert.ok(format.readableBy <= newest,
      `${label}: the data is at format ${format.version}, which this build cannot read (it needs ${format.readableBy})`);
}

/**
 * Starts Branch on this folder and answers what happened, holding it to the rules: it either starts
 * with everything still there, or refuses in a sentence a person can act on.
 */
export async function startOrRefuse(label, dataDir, workspace, before) {
  let app = null;
  try { app = await createBranch({ workspace, dataDir }); }
  catch (error) { assertPlainRefusal(label, error); return "refused"; }
  try {
    const now = { runs: app.store.runs("local").map((r) => `${r.prompt}|${r.status}`).sort(),
      memory: app.store.list("memory", "local").map((one) => JSON.stringify(one.data)).sort(),
      settings: app.store.list("settings", "local").map((one) => JSON.stringify(one.data)).sort(),
      format: formatOf(app.store.sqlite) };
    assertFormatWhole(label, now.format);
    if (before) {
      // Branch writes notes of its own on every start, so what must hold is that nothing of the
      // owner's went missing, not that the rows are identical.
      const kept = (was, now2, what) => {
        const missing = was.filter((one) => !now2.includes(one));
        assert.deepEqual(missing, [], `${label}: ${what} went missing: ${missing.join(" | ")}`);
      };
      kept(before.memory, now.memory, "what the owner asked Branch to remember");
      kept(before.settings, now.settings, "the owner's settings");
      kept(before.runs.map((r) => r.split("|")[0]), now.runs.map((r) => r.split("|")[0]), "the owner's conversations");
    }
    return "started";
  } finally { if (app) await app.close(); }
}

/** Nothing half-installed is left lying about in the data folder. */
export async function assertNothingHalfInstalled(label, dataDir) {
  const updates = await readdir(join(dataDir, "updates")).catch(() => []);
  assert.deepEqual(updates, [], `${label}: a copy taken for an update was left behind: ${updates.join(", ")}`);
  assert.equal(await exists(join(dataDir, "branch.sqlite.incoming")), false, `${label}: a half-written database was left behind`);
}

/** A fake release the updater can download, check and unpack without touching the network. */
export function fakeRelease(bytes, { checksum = "good" } = {}) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return async (url) => {
    const text = String(url);
    if (text.includes("releases/latest"))
      return Response.json({ tag_name: "v2.0.0", name: null, body: "", published_at: null,
        html_url: "https://example.invalid/releases/tag/v2.0.0",
        assets: [{ name: "app.tgz", browser_download_url: "https://example.invalid/app.tgz", size: bytes.length },
          { name: "app.tgz.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] });
    if (text.endsWith("app.tgz")) return new Response(bytes);
    if (checksum === "cut-off") return new Response(`${digest.slice(0, 30)}`);
    if (checksum === "unreachable") return new Response("nope", { status: 503 });
    if (checksum === "wrong") return new Response(`${"0".repeat(64)}  app.tgz\n`);
    return new Response(`${digest}  app.tgz\n`);
  };
}

/** What SQLite really hands back, message and number together, as its own tests would. */
export const sqliteError = (message, errcode) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: message });

/** Stamps a data folder as having been written by a Branch newer than this one. */
export function stampFromTheFuture(dataDir, ahead, readableBy = ahead) {
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
  try {
    db.prepare("UPDATE tasks SET status='running', output=''").run();
    db.exec("CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)");
    db.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, readable_by=excluded.readable_by")
      .run(ahead, readableBy, new Date().toISOString());
    db.exec(`PRAGMA user_version=${ahead}`);
  } finally { db.close(); }
}

/** A folder nobody may write in. Windows ignores the read-only mark on a folder, so chmod there makes nothing read-only. */
const everyone = "*S-1-1-0";
const icacls = (...args) => {
  const done = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { encoding: "utf8" });
  assert.equal(done.status, 0, `icacls ${args.join(" ")}: ${done.stdout}${done.stderr}`);
};

export async function makeReadOnly(dir) {
  if (process.platform === "win32") icacls(dir, "/deny", `${everyone}:(OI)(CI)(W,D,DC)`);
  else await chmod(dir, 0o500);
}

export async function makeWritable(dir) {
  if (process.platform === "win32") icacls(dir, "/remove:d", everyone);
  else await chmod(dir, 0o700);
}
