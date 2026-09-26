/**
 * An exported assistant never carries a saved key. Before a part of the file is written it is checked
 * against every value kept in the locker, in every project, whether or not Branch has used that value
 * since it started; then key-shaped text the locker never held is hidden the way the leak guard hides
 * it. Ordinary text comes through unchanged. While Branch is locked the export refuses and writes
 * nothing. Temp data, a scripted model, port 0; nothing leaves this process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { exportAgent, openAgent } from "../dist/agent-export.js";
import { findLeaks } from "../dist/leak-guard.js";
import { applyPiiGuard } from "../dist/pii.js";

const unlockFirst = "Unlock Branch first, so it can check the file for your saved keys.";
const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-export-secrets-"));
  t.after(() => discardTemp(root));
  return root;
}
const openBranch = (root) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
/** A value no leak-guard shape matches, so only the locker check can find it. */
const plainSentinel = (label) => `${label}-${randomBytes(9).toString("hex")}`;
const exportedActions = (app, owner) => app.store.audit.list(owner, { limit: 500 }).filter((entry) => entry.action === "data.exported").length;

/** Quotes each value in a remembered fact, a saved procedure and a specialist. */
function quoteEverywhere(app, owner, values) {
  const joined = values.join(" and ");
  app.store.save("memory", owner, "fact-keys", { text: `The deploy keys are ${joined}`, source: "Saved by workspace owner" });
  app.store.save("procedures", owner, "deploy", { version: 1, status: "proposed", history: [],
    definition: { name: "deploy", steps: values.map((value) => `curl -H 'x-deploy: ${value}' https://deploy.example.test/`) } });
  app.store.save("specialists", owner, "deployer", { name: "Deployer", instructions: `Deploy with ${joined}.` });
}

/**
 * Two different values under the same name in two projects, put in the locker and quoted, then Branch
 * closed and opened again on the same data, so this launch has looked neither of them up.
 */
async function plantedThenRestarted(t) {
  const root = await tempRoot(t);
  const first = await openBranch(root);
  const owner = first.runtime.owner;
  const values = [plainSentinel("plum"), plainSentinel("quince")];
  await first.store.secrets.put(owner, "default", "DEPLOY_TOKEN", values[0]);
  await first.store.secrets.put(owner, "client-work", "DEPLOY_TOKEN", values[1]);
  quoteEverywhere(first, owner, values);
  await first.close();
  const app = await openBranch(root);
  t.after(() => app.close());
  return { app, owner, values };
}

function carrying(opened, values) {
  return [...opened.files].filter(([, text]) => values.some((value) => text.includes(value))).map(([file]) => file);
}

test("after a restart, a locker value Branch has not used since is in no part of the file, from any project", async (t) => {
  const { app, owner, values } = await plantedThenRestarted(t);
  for (const value of values) assert.deepEqual(findLeaks(`The deploy keys are ${value}`), [], "the leak guard alone would not hide this value");
  const scrubberBefore = app.store.secrets.scrubber.size, usesBefore = app.store.secrets.audit(owner).length;

  const { bytes, manifest } = await exportAgent(app.store, owner, "test", { memory: true });
  const opened = openAgent(bytes); // every part matches the fingerprint written in the manifest
  assert.deepEqual(manifest.sections.map((section) => section.name), ["specialists", "procedures", "skills", "routing", "permissions", "memory"]);
  assert.deepEqual(carrying(opened, values), [], "no part carries a locker value");
  for (const file of ["memory.json", "procedures.json", "specialists.json"])
    assert.match(opened.files.get(file), /\[secret DEPLOY_TOKEN\]/, `${file} names the key where it stood`);
  assert.equal(app.store.secrets.scrubber.size, scrubberBefore, "checking the file does not teach this launch's scrubber anything");
  assert.equal(app.store.secrets.audit(owner).length, usesBefore, "checking the file is not a use of the key");
});

test("without memory (the market and git path) the procedures and specialists carry none of it either", async (t) => {
  const { app, owner, values } = await plantedThenRestarted(t);
  const { bytes } = await exportAgent(app.store, owner, "test", { memory: false });
  const opened = openAgent(bytes);
  assert.equal(opened.files.has("memory.json"), false);
  assert.ok(opened.files.has("procedures.json") && opened.files.has("specialists.json"));
  assert.deepEqual(carrying(opened, values), []);
});

test("a password-shaped locker value is hidden too, including one with a quote and a backslash", async (t) => {
  const root = await tempRoot(t);
  const app = await openBranch(root);
  t.after(() => app.close());
  const owner = app.runtime.owner;
  const password = "correct-horse-battery-9", awkward = `tr0ub"ador\\batt-${randomBytes(3).toString("hex")}`;
  for (const value of [password, awkward]) assert.deepEqual(findLeaks(`My password is ${value} today`), [], "not key-shaped");
  await app.store.secrets.put(owner, "default", "MAIL_PASSWORD", password);
  await app.store.secrets.put(owner, "home", "ROUTER_PASSWORD", awkward);
  // A longer value that holds a shorter one is taken out whole, under its own name.
  await app.store.secrets.put(owner, "default", "OLD_MAIL_PASSWORD", `${password}-2025x`);
  quoteEverywhere(app, owner, [password, awkward]);
  app.store.save("memory", owner, "fact-old", { text: `The old one was ${password}-2025x`, source: "Saved by workspace owner" });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  const escaped = JSON.stringify(awkward).slice(1, -1);
  assert.deepEqual(carrying(opened, [password, awkward, escaped]), [], "neither the value nor the way JSON writes it is in the file");
  const facts = JSON.parse(opened.files.get("memory.json"));
  assert.equal(facts.find((record) => record.id === "fact-keys").data.text, "The deploy keys are [secret MAIL_PASSWORD] and [secret ROUTER_PASSWORD]");
  assert.equal(facts.find((record) => record.id === "fact-old").data.text, "The old one was [secret OLD_MAIL_PASSWORD]");
});

test("a locker value holding an email address is taken out whole before personal details are masked", async (t) => {
  const root = await tempRoot(t);
  const app = await openBranch(root);
  t.after(() => app.close());
  const owner = app.runtime.owner;
  const tail = `Plum-${randomBytes(6).toString("hex")}`, value = `deploy+ci@example.com:${tail}`;
  await app.store.secrets.put(owner, "default", "SMTP_LOGIN", value);
  app.store.save("memory", owner, "fact-login", { text: `The mail login is ${value}`, source: "Saved by workspace owner" });
  const masked = (text) => applyPiiGuard(text, "mask").text; // what the window's route asks for
  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true, redact: masked })).bytes);
  assert.equal(opened.manifest.memoryRedacted, true);
  assert.deepEqual(carrying(opened, [tail]), [], "no part of the value is left beside a masked address");
  assert.match(opened.files.get("memory.json"), /The mail login is \[secret SMTP_LOGIN\]/);
});

test("a key-shaped value the locker never held is hidden in every part", async (t) => {
  const root = await tempRoot(t);
  const app = await openBranch(root);
  t.after(() => app.close());
  const owner = app.runtime.owner;
  const openAiStyle = `sk-Ab1${randomBytes(12).toString("hex")}`, gitHubStyle = `ghp_Zq7${randomBytes(18).toString("hex")}`;
  app.store.save("memory", owner, "fact-pasted", { text: `The model key is ${openAiStyle}`, source: "Saved by workspace owner" });
  app.store.save("procedures", owner, "push", { version: 1, status: "proposed", history: [], definition: { name: "push", steps: [`git push https://x:${gitHubStyle}@github.example.test/r.git`] } });
  app.store.save("specialists", owner, "helper", { name: "Helper", instructions: `Call the service with ${openAiStyle}` });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  assert.deepEqual(carrying(opened, [openAiStyle, gitHubStyle]), []);
  assert.match(opened.files.get("memory.json"), /\[hidden key-like value: OpenAI key\]/);
  assert.match(opened.files.get("specialists.json"), /\[hidden key-like value: OpenAI key\]/);
  assert.match(opened.files.get("procedures.json"), /\[hidden key-like value: (GitHub token|password in an address)\]/);
  for (const [file, text] of opened.files) assert.doesNotThrow(() => JSON.parse(text), `${file} still reads as JSON`);
});

test("ordinary text comes through unchanged: a commit id, a UUID, an address and a sentence", async (t) => {
  const root = await tempRoot(t);
  const app = await openBranch(root);
  t.after(() => app.close());
  const owner = app.runtime.owner;
  // A value under four characters is left alone, as everywhere else: it would match ordinary words.
  // That holds for one JSON writes longer too (o"k is written o\"k inside the file).
  await app.store.secrets.put(owner, "default", "SHORT_PIN", "the");
  await app.store.secrets.put(owner, "default", "SHORT_WORD", 'o"k');
  app.store.save("specialists", owner, "short", { name: "Short", instructions: 'Answer o"k when the backup is done.' });
  const ordinary = ["Release 527eba6fb944568c037793044a500cb3c6ad68ac went out on Tuesday.",
    "Ticket 3f2b8c1e-9d4a-4e6b-8f0a-1c2d3e4f5a6b is the one about the lease.",
    "The guide lives at https://docs.example.com/guide/start?page=2#top and http://localhost:8080/status.",
    "Water the plants before the password manager asks again; the key is under the mat."];
  app.store.save("memory", owner, "fact-plain", { text: ordinary.join(" "), source: "Saved by workspace owner" });
  app.store.save("procedures", owner, "plain", { version: 1, status: "proposed", history: [], definition: { name: "plain", steps: ordinary } });
  app.store.save("specialists", owner, "plain", { name: "Plain", instructions: ordinary[3] });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  for (const [file, text] of opened.files) assert.doesNotThrow(() => JSON.parse(text), `${file} still reads as JSON`);
  const memory = JSON.parse(opened.files.get("memory.json"));
  assert.equal(memory.find((record) => record.id === "fact-plain").data.text, ordinary.join(" "));
  assert.deepEqual(JSON.parse(opened.files.get("procedures.json")).find((record) => record.id === "plain").data.definition.steps, ordinary);
  const specialists = JSON.parse(opened.files.get("specialists.json"));
  assert.equal(specialists.find((record) => record.id === "plain").data.instructions, ordinary[3]);
  assert.equal(specialists.find((record) => record.id === "short").data.instructions, 'Answer o"k when the backup is done.');
});

test("while Branch is locked the export refuses in plain words and writes nothing", async (t) => {
  const root = await tempRoot(t);
  const app = await openBranch(root);
  t.after(() => app.close());
  const owner = app.runtime.owner;
  const before = exportedActions(app, owner);
  app.sessionLock.lock();
  await assert.rejects(async () => exportAgent(app.store, owner, "test", { memory: true }), { message: unlockFirst },
    "an empty locker is no reason to skip the check");
  const value = plainSentinel("damson");
  await app.store.secrets.put(owner, "default", "DEPLOY_TOKEN", value);
  quoteEverywhere(app, owner, [value]);
  await assert.rejects(async () => exportAgent(app.store, owner, "test", { memory: false }), { message: unlockFirst });
  await assert.rejects(async () => app.store.secrets.valuesToHide(owner), /is locked/, "the locker's own read waits for the unlock too");
  assert.equal(exportedActions(app, owner), before, "no export was written into the record");

  app.sessionLock.unlock();
  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  assert.deepEqual(carrying(opened, [value]), []);
  assert.equal(exportedActions(app, owner), before + 1);
});

test("over HTTP the owner gets the checked file; a locked Branch, a key and a household profile are refused", async (t) => {
  const root = await tempRoot(t);
  const app = await openBranch(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); });
  const owner = app.runtime.owner;
  const api = async (method, path, body, bearer = server.token) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const saved = plainSentinel("medlar"), pasted = `sk-Cd2${randomBytes(12).toString("hex")}`;
  const project = app.store.projects.active(owner).id;
  assert.equal((await api("POST", "/api/secrets", { project, name: "NAS_SENTINEL", value: saved })).status, 200);
  const now = new Date().toISOString();
  const imported = await api("POST", "/api/memory/import", { format: "branch-agent-memory", version: 1, exportedAt: now,
    records: [{ id: "fact-http", data: { text: `Staging uses ${saved}; the model key is ${pasted}`, source: "Saved by workspace owner" }, createdAt: now, updatedAt: now, revision: 1 }] });
  assert.equal(imported.status, 200);

  const done = await api("POST", "/api/agent-export", { sections: ["memory", "skills"] });
  assert.equal(done.status, 200);
  const opened = openAgent(Buffer.from(done.body.data, "base64"));
  assert.deepEqual(carrying(opened, [saved, pasted]), []);
  assert.match(opened.files.get("memory.json"), /Staging uses \[secret NAS_SENTINEL\]; the model key is \[hidden key-like value: OpenAI key\]/);

  const before = exportedActions(app, owner);
  assert.equal((await api("POST", "/api/lock")).status, 200);
  const locked = await api("POST", "/api/agent-export", { sections: ["memory", "skills"] });
  assert.equal(locked.status, 400);
  assert.equal(locked.body.error, unlockFirst);
  assert.equal(locked.body.data, undefined);
  assert.equal(exportedActions(app, owner), before);
  assert.equal((await api("POST", "/api/lock/unlock", {})).status, 200);

  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(owner, { name: `export-${scope}`, scope, minutes: 5 }).token;
    assert.equal((await api("POST", "/api/agent-export", { sections: ["skills"] }, key)).status, 401, `a ${scope} key`);
  }
  // Last: switching to a household profile is for the whole app.
  const person = (await api("POST", "/api/profiles", { name: "Sam", pin: "4321" })).body;
  assert.equal((await api("POST", "/api/profiles/switch", { profileId: person.id, pin: "4321" })).status, 200);
  assert.equal((await api("POST", "/api/agent-export", { sections: ["skills"] })).status, 400);
});
