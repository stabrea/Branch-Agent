/**
 * An exported assistant never carries a saved key. Before a part of the file is written it is checked
 * against every value kept in the locker, in every project, whether or not Branch has used that value
 * since it started; then key-shaped text the locker never held is hidden the way the leak guard hides
 * it. Each string in a part is checked on its own, for a value as it is, escaped once or twice,
 * URL-encoded, form-encoded or in base64, so every part still reads as JSON. Ordinary text comes
 * through unchanged. While Branch is locked the export refuses and writes nothing. Temp data, a
 * scripted model, port 0; nothing leaves this process.
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

const tempRoot = () => mkdtemp(join(tmpdir(), "branch-export-secrets-"));
const openBranch = (root) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
/**
 * Branch on a new temp folder. After the test it is closed and only then is the folder removed, in one
 * hook: `t.after` hooks run in the order they were added, and Windows will not remove an open database.
 */
async function openTemp(t) {
  const root = await tempRoot();
  const app = await openBranch(root);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
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
  const root = await tempRoot();
  const first = await openBranch(root);
  const owner = first.runtime.owner;
  const values = [plainSentinel("plum"), plainSentinel("quince")];
  await first.store.secrets.put(owner, "default", "DEPLOY_TOKEN", values[0]);
  await first.store.secrets.put(owner, "client-work", "DEPLOY_TOKEN", values[1]);
  quoteEverywhere(first, owner, values);
  await first.close();
  const app = await openBranch(root);
  t.after(async () => { await app.close(); await discardTemp(root); });
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
  const app = await openTemp(t);
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
  const app = await openTemp(t);
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
  const app = await openTemp(t);
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
  const app = await openTemp(t);
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
  const app = await openTemp(t);
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
  const root = await tempRoot();
  const app = await openBranch(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
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

test("a saved value inside a fact that is itself JSON text is taken out, and the fact still reads as JSON", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  const tag = randomBytes(3).toString("hex"), awkward = `tr0ub"ador\\batt-${tag}`;
  await app.store.secrets.put(owner, "home", "DB_PASSWORD", awkward);
  // A configuration saved as a fact: the value is escaped once inside the fact and once more in the file.
  const config = JSON.stringify({ db: { host: "db.internal.example.test", password: awkward } });
  app.store.save("memory", owner, "fact-config", { text: config, source: "Saved by workspace owner" });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  const once = JSON.stringify(awkward).slice(1, -1), twice = JSON.stringify(once).slice(1, -1);
  // The random tail too: the leak guard alone would hide only the start of the value, after "password".
  assert.deepEqual(carrying(opened, [awkward, once, twice, tag]), [], "the value is in no part, as it is, escaped once or escaped twice");
  const fact = JSON.parse(opened.files.get("memory.json")).find((record) => record.id === "fact-config");
  assert.deepEqual(JSON.parse(fact.data.text), { db: { host: "db.internal.example.test", password: "[secret DB_PASSWORD]" } });
});

test("a saved value written into an address or a form, URL-encoded or form-encoded, is taken out", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  const value = `p@ss/w0rd ${randomBytes(4).toString("hex")}!`;
  await app.store.secrets.put(owner, "default", "SITE_PASSWORD", value);
  const uri = encodeURIComponent(value), plus = uri.replace(/%20/g, "+"), form = new URLSearchParams({ pw: value }).toString().slice(3);
  assert.equal(new Set([value, uri, plus, form]).size, 4, "four different ways of writing the one value");
  const login = "https://intranet.example.test/login";
  app.store.save("memory", owner, "fact-login", { text: `Sign in at ${login}?user=sam&pw=${uri} or post user=sam&pw=${form} to ${login}.`, source: "Saved by workspace owner" });
  app.store.save("procedures", owner, "login", { version: 1, status: "proposed", history: [],
    definition: { name: "login", steps: [`curl -d 'user=sam&pw=${plus}' ${login}`] } });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  assert.deepEqual(carrying(opened, [value, uri, plus, form]), [], "the value is in no part, in any of those forms");
  const fact = JSON.parse(opened.files.get("memory.json")).find((record) => record.id === "fact-login");
  assert.equal(fact.data.text, `Sign in at ${login}?user=sam&pw=[secret SITE_PASSWORD] or post user=sam&pw=[secret SITE_PASSWORD] to ${login}.`);
  const steps = JSON.parse(opened.files.get("procedures.json")).find((record) => record.id === "login").data.definition.steps;
  assert.deepEqual(steps, [`curl -d 'user=sam&pw=[secret SITE_PASSWORD]' ${login}`]);
});

/** A part with every string set to one word: what is left is its names, numbers, true, false and null. */
const structure = (value) => typeof value === "string" ? "text" : Array.isArray(value) ? value.map(structure)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, structure(entry)])) : value;

test("saved values that are also JSON words or names leave every part readable, with its structure unchanged", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  app.store.save("specialists", owner, "deployer", { name: "Deployer", enabled: true, fallback: null, retries: 3,
    instructions: "Sign each release with the name on file." });
  app.store.save("procedures", owner, "deploy", { version: 1, status: "proposed", history: [],
    definition: { name: "deploy", steps: [{ tool: "shell.run", args: { dryRun: true, limit: null } }] } });
  app.store.save("memory", owner, "fact-flags", { text: "Deploys wait for a green build.", source: "Saved by workspace owner", promoted: true, validTo: null });
  app.store.save("settings", owner, "policy", { name: "careful", askFirst: true, limit: null });
  const before = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  await app.store.secrets.put(owner, "default", "FLAG", "true");
  await app.store.secrets.put(owner, "default", "EMPTY", "null");
  await app.store.secrets.put(owner, "home", "WHO", "name");

  const after = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  for (const [file, text] of after.files) {
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(text); }, `${file} still reads as JSON`);
    assert.deepEqual(structure(parsed), structure(JSON.parse(before.files.get(file))), `${file} keeps its names, numbers, true, false and null`);
  }
  const deployer = JSON.parse(after.files.get("specialists.json")).find((record) => record.id === "deployer").data;
  assert.equal(deployer.instructions, "Sign each release with the [secret WHO] on file.", "a string holding the value is still cleaned");
});

test("a value known only by the name beside it is still hidden when each string is checked on its own, short ones too", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  const password = `hunter-${randomBytes(3).toString("hex")}9`, basic = `dXNl${randomBytes(6).toString("hex")}7`;
  const aws = randomBytes(30).toString("base64"), shortOne = `${randomBytes(2).toString("hex")}x9`, shortTwo = `${randomBytes(2).toString("hex")}y8`;
  // "passwd: " and "password=" with a six-character value are both under sixteen characters.
  app.store.save("specialists", owner, "mailer", { name: "Mailer", password, headers: { Authorization: `Basic ${basic}` },
    aws_secret_access_key: aws, passwd: shortOne, steps: [`password=${shortTwo}`] });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: false })).bytes);
  assert.deepEqual(carrying(opened, [password, basic, aws, shortOne, shortTwo]), []);
  assert.deepEqual(JSON.parse(opened.files.get("specialists.json")).find((record) => record.id === "mailer").data, {
    name: "Mailer", password: "[hidden key-like value: password]",
    headers: { Authorization: "Basic [hidden key-like value: sign-in header]" },
    aws_secret_access_key: "[hidden key-like value: AWS secret key]",
    passwd: "[hidden key-like value: password]", steps: ["password=[hidden key-like value: password]"],
  });
});

/** Every part of the file reads as JSON. */
function everyPartParses(opened) {
  for (const [file, text] of opened.files) assert.doesNotThrow(() => JSON.parse(text), `${file} still reads as JSON`);
}

test("a saved value written in base64, on its own or behind a user name in a Basic header, is taken out", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  const value = `bk-${randomBytes(6).toString("hex")}`, base64 = (text) => Buffer.from(text).toString("base64");
  await app.store.secrets.put(owner, "default", "BACKUP_KEY", value);
  // "sam:" and "user:" put the value one and two bytes into a group of three, so each writes it differently.
  const bare = base64(value), sam = base64(`sam:${value}`), user = base64(`user:${value}`);
  for (const text of [bare, sam, user]) assert.deepEqual(findLeaks(`X-Backup-Auth: Basic ${text}`), [], "the leak guard alone would not hide it");
  app.store.save("memory", owner, "fact-backup", { text: `The backup token in base64 is ${bare}.`, source: "Saved by workspace owner" });
  app.store.save("specialists", owner, "backup", { name: "Backup", headers: { "X-Backup-Auth": `Basic ${sam}` } });
  app.store.save("procedures", owner, "backup", { version: 1, status: "proposed", history: [],
    definition: { name: "backup", steps: [`curl -H 'X-Backup-Auth: Basic ${user}' https://backup.example.test/`] } });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  everyPartParses(opened);
  assert.deepEqual(carrying(opened, [value, bare, sam, user]), [], "the value is in no part, in any of its base64 forms");
  const fact = JSON.parse(opened.files.get("memory.json")).find((record) => record.id === "fact-backup");
  assert.equal(fact.data.text, "The backup token in base64 is [secret BACKUP_KEY].");
  // Only the user name and the few characters shared with it or with the padding are left beside the name.
  const header = JSON.parse(opened.files.get("specialists.json")).find((record) => record.id === "backup").data.headers["X-Backup-Auth"];
  assert.match(header, /^Basic [A-Za-z0-9+/]{0,6}\[secret BACKUP_KEY\][A-Za-z0-9+/]{0,2}={0,2}$/);
  const step = JSON.parse(opened.files.get("procedures.json")).find((record) => record.id === "backup").data.definition.steps[0];
  assert.match(step, /^curl -H 'X-Backup-Auth: Basic [A-Za-z0-9+/]{0,7}\[secret BACKUP_KEY\][A-Za-z0-9+/]{0,2}={0,2}' https:\/\/backup\.example\.test\/$/);
});

test("a saved value in a tool call's arguments, kept as JSON text inside a step's JSON text, is taken out and both still read as JSON", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  const tag = randomBytes(4).toString("hex"), value = `s3"cr\\t-${tag}`;
  await app.store.secrets.put(owner, "default", "API_PASSWORD", value);
  const call = JSON.stringify({ tool: "http.request", arguments: JSON.stringify({ url: "https://api.example.test/login", pw: value }) });
  const once = JSON.stringify(value).slice(1, -1), twice = JSON.stringify(once).slice(1, -1), thrice = JSON.stringify(twice).slice(1, -1);
  assert.ok(call.includes(twice) && new Set([value, once, twice, thrice]).size === 4, "inside the step the value is escaped twice");
  app.store.save("procedures", owner, "login", { version: 1, status: "proposed", history: [], definition: { name: "login", steps: [call] } });
  app.store.save("memory", owner, "fact-call", { text: `The last call was ${call}`, source: "Saved by workspace owner" });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  everyPartParses(opened);
  assert.deepEqual(carrying(opened, [value, once, twice, thrice, tag]), [], "the value is in no part, however many times it was escaped");
  const step = JSON.parse(opened.files.get("procedures.json")).find((record) => record.id === "login").data.definition.steps[0];
  assert.deepEqual(JSON.parse(JSON.parse(step).arguments), { url: "https://api.example.test/login", pw: "[secret API_PASSWORD]" });
  const fact = JSON.parse(opened.files.get("memory.json")).find((record) => record.id === "fact-call");
  assert.deepEqual(JSON.parse(JSON.parse(fact.data.text.replace("The last call was ", "")).arguments).pw, "[secret API_PASSWORD]");
});

test("a saved value holding + / and = is taken out of an address where it is URL-encoded", async (t) => {
  const app = await openTemp(t);
  const owner = app.runtime.owner;
  const tag = randomBytes(4).toString("hex"), value = `Zk9${tag}+Yq/Xw7==`, encoded = encodeURIComponent(value);
  assert.match(encoded, /%2B.*%2F.*%3D%3D$/, "each of + / and = is written as its code");
  await app.store.secrets.put(owner, "default", "SIGNING_KEY", value);
  const address = `https://files.example.test/download?file=report.pdf&sig=${encoded}`;
  app.store.save("memory", owner, "fact-link", { text: `The report is at ${address}`, source: "Saved by workspace owner" });
  app.store.save("specialists", owner, "fetcher", { name: "Fetcher", start: address });

  const opened = openAgent((await exportAgent(app.store, owner, "test", { memory: true })).bytes);
  everyPartParses(opened);
  assert.deepEqual(carrying(opened, [value, encoded, tag]), [], "the value is in no part, as it is or URL-encoded");
  const fact = JSON.parse(opened.files.get("memory.json")).find((record) => record.id === "fact-link");
  assert.equal(fact.data.text, "The report is at https://files.example.test/download?file=report.pdf&sig=[secret SIGNING_KEY]");
});
