/**
 * mac7/vault-autofill (R17-068): filling one of the owner's saved sign-ins into the page they are on.
 *
 * Nothing here calls a real password manager, a real Keychain or a real browser. The manager is a
 * fake runner that records the exact argument array it was handed; the page is a stand-in that
 * records which box it was asked to type into. Every fixture points the Bitwarden command at a name
 * inside a temporary folder that does not exist, so a stray code path could only ever fail to find
 * it — the owner's own vault is never asked anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  VaultAutofill, addressRefusal, autofillChatRefusal, autofillGuard, autofillLockdownRefusal, autofillOffRefusal,
  autofillShortLivedRefusal, autofillStartedElsewhereRefusal, autofillTrunkRefusal, readVaultAutofillSettings,
  saveVaultAutofillSettings, siteHolds, vaultAutofillKey, vaultAutofillTools,
} from "../dist/vault-autofill.js";
import { CredentialResolver, commandFor, saveCredentialSettings } from "../dist/credential-cli.js";
import { SecretScrubber } from "../dist/vault.js";
import { signInFillTools, switchedToolTiers } from "../dist/feature-switches.js";
import { classify, specFor } from "../dist/settings-kit/catalogue.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { ownerOnlyRead } from "../dist/short-lived-keys.js";
import { offLimitsToShortLivedKeys } from "../dist/server.js";
import { ToolRegistry } from "../dist/registry.js";
import { registerVaultAutofill } from "../dist/vault-autofill.js";
import { findLeaks, redactLeaksIn } from "../dist/leak-guard.js";
import { createBranch } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

/** The one value in these tests. It must never turn up anywhere but the page's password box. */
const THE_PASSWORD = "correct-horse-battery-staple-42";
const THE_CODE = "907142";
const OWNER = "local";

/** Just the tables this feature touches, with everything written down so a test can search it. */
function fakeStore() {
  const rows = new Map();
  const audits = [];
  const events = new Map();
  return {
    audits, eventRows: events,
    get: (table, owner, id) => rows.has(`${table}/${owner}/${id}`) ? { data: rows.get(`${table}/${owner}/${id}`) } : undefined,
    save: (table, owner, id, data) => { rows.set(`${table}/${owner}/${id}`, data); return { data }; },
    audit: { record: (owner, input) => audits.push({ owner, ...input }) },
    run: (runId) => (events.has(runId) ? { id: runId } : undefined),
    events: (runId) => events.get(runId) ?? [],
  };
}

/** A password manager that is not there: the command is a name inside a temporary folder. */
function fakeManager(root, answers = { password: THE_PASSWORD, totp: THE_CODE }) {
  const calls = [];
  const run = async (executable, args, timeoutMs) => {
    calls.push({ executable, args, timeoutMs });
    const field = args.includes("totp") ? "totp" : "password";
    return { code: 0, stdout: `${answers[field]}\n`, stderr: "" };
  };
  return { calls, run, command: join(root, "no-such-bw") };
}

/** A page that records which box it was asked to type into, and nothing about what went into it. */
function fakePage(url, { acrossSites = false, boxes = ["password", "code"] } = {}) {
  const typed = [];
  return {
    typed,
    where: async () => ({ address: url, acrossSites }),
    type: async (_context, box, label, value) => {
      if (!boxes.includes(box)) throw new Error(`the page has no ${box} box; it was asked for "${label}"`);
      typed.push({ box, label, length: value.length, matched: value === THE_PASSWORD || value === THE_CODE });
    },
  };
}

const context = (extra = {}) => ({
  owner: OWNER, workspace: "/tmp", runId: "11111111-1111-4111-8111-111111111111",
  signal: new AbortController().signal, budget: {}, permissions: new Set(), depth: 0, ...extra,
});

/** A whole feature, switched on, with one sign-in in the owner's book. */
async function fixture(t, { url = "https://example.com/login", page: pageOptions = {}, entry = {}, mode = "when-needed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-autofill-"));
  t.after(async () => { await discardTemp(root); });
  const store = fakeStore();
  const manager = fakeManager(root);
  saveCredentialSettings(store, OWNER, { enabled: true, services: ["bitwarden"], bitwardenCommand: manager.command });
  saveVaultAutofillSettings(store, OWNER, {
    mode, logins: [{ name: "shop", site: "example.com", service: "bitwarden", item: "My Shop", ...entry }],
  });
  const resolver = new CredentialResolver(store, OWNER, new SecretScrubber(), manager.run);
  const page = fakePage(url, pageOptions);
  const owners = [];
  const autofill = new VaultAutofill({
    store, owner: OWNER, page, read: (reference, use) => resolver.read(reference, use),
    requireOwner: (what) => { owners.push(what); },
  });
  return { root, store, manager, page, autofill, owners };
}

/** Everything this feature could have written the value into, as one string to search. */
const everythingWritten = (store, extra = []) =>
  JSON.stringify({ audits: store.audits, extra });

/* ───────────────────────────── the value goes nowhere but the page ───────────────────────────── */

test("the password reaches the page and nothing else: not the answer, an audit row, an event or a log", async (t) => {
  const { store, autofill, page, manager } = await fixture(t);
  const answer = await autofill.fill({ login: "shop" }, context());

  assert.deepEqual(page.typed, [{ box: "password", label: undefined, length: THE_PASSWORD.length, matched: true }],
    "the page was asked to type the password once");
  const said = JSON.stringify(answer);
  assert.ok(!said.includes(THE_PASSWORD), `the answer to the model carried the password: ${said}`);
  assert.deepEqual(Object.keys(answer).sort(), ["filled", "login", "note", "site", "url"]);
  assert.equal(answer.filled, "password");
  assert.equal(answer.site, "example.com");

  const written = everythingWritten(store, manager.calls);
  assert.ok(!written.includes(THE_PASSWORD), `the password was written down somewhere: ${written}`);
  assert.ok(store.audits.some((row) => row.action === "secret.used" && row.outcome === "filled"),
    "the moment was written into the record of what the assistant was allowed to do");
  assert.ok(store.audits.some((row) => String(row.subject).includes("example.com")), "the record names the site");
});

test("a box that is not there fails with a sentence of Branch's own, never the page's own message", async (t) => {
  const { autofill, store } = await fixture(t, { page: { boxes: [] } });
  await assert.rejects(() => autofill.fill({ login: "shop", label: "Mot de passe" }, context()), (error) => {
    assert.ok(!error.message.includes(THE_PASSWORD), "the refusal carried the password");
    // The stand-in's own message quotes the label it was given; that message must not be passed on.
    assert.ok(!error.message.includes("the page has no password box"), `the page's own words were passed on: ${error.message}`);
    assert.match(error.message, /could not find that box on example\.com/);
    return true;
  });
  assert.ok(!everythingWritten(store).includes(THE_PASSWORD));
});

test("the tool takes no value of its own, so nothing the model writes can be typed into a page", async (t) => {
  const { autofill } = await fixture(t);
  const registry = new ToolRegistry();
  registerVaultAutofill(registry, autofill);
  const [definition] = registry.descriptions(new Set(registry.permissions()), { diet: false });
  assert.equal(definition.name, "signin.fill");
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ["box", "label", "login"]);
  assert.deepEqual([...vaultAutofillTools], [...signInFillTools]);
  // No field the model could write a value into. "password" appears only as the name of a box to
  // fill and in the description; there is nothing it could put a value in.
  const fields = Object.keys(definition.parameters.properties);
  assert.ok(!fields.some((name) => /value|password|secret|code$/i.test(name)), `the tool offers a way in: ${fields}`);
  assert.equal(definition.parameters.additionalProperties, false, "anything else the model writes is refused");
  // Nothing the model can write reaches the page: the one word it may send is a name from the book.
  await assert.rejects(() => registry.execute("signin.fill", { login: "shop", value: THE_PASSWORD },
    context({ permissions: new Set(registry.permissions()), budget: { step: () => undefined } })), /nrecognized/);
});

test("the tool runs through the registry, with the permission an owner's own task really holds", async (t) => {
  const { autofill, page } = await fixture(t);
  const registry = new ToolRegistry();
  registerVaultAutofill(registry, autofill);
  assert.ok(registry.permissions().includes("signin.fill"), "the permission is one the registry hands to a task");
  const budget = { step: () => undefined };
  const answer = await registry.execute("signin.fill", { login: "shop" },
    context({ permissions: new Set(registry.permissions()), budget }));
  assert.equal(answer.filled, "password");
  assert.deepEqual(page.typed.map((one) => one.box), ["password"]);
  assert.ok(!JSON.stringify(answer).includes(THE_PASSWORD));
  // A task that was not given it is refused by the registry itself, before the tool runs at all.
  await assert.rejects(() => registry.execute("signin.fill", { login: "shop" },
    context({ permissions: new Set(), budget })), /Permission denied: signin\.fill/);
});

test("the leak guard finds nothing to hide in what the model is told, because there is nothing there", async (t) => {
  const { autofill } = await fixture(t);
  const answer = await autofill.fill({ login: "shop" }, context());
  assert.deepEqual(findLeaks(JSON.stringify(answer)), [], "the answer has nothing key-shaped in it");
  const guarded = redactLeaksIn(answer);
  assert.equal(guarded.kinds.size, 0, "the leak guard had nothing to hide");
  assert.deepEqual(guarded.value, answer, "the leak guard changed nothing, because nothing was there");
});

/* ───────────────────────────── the site has to be the saved item's own ───────────────────────────── */

test("a site holds only itself and what is under it, never a look-alike", () => {
  assert.equal(siteHolds("example.com", "example.com"), true);
  assert.equal(siteHolds("example.com", "accounts.example.com"), true);
  assert.equal(siteHolds("example.com", "EXAMPLE.COM."), true);
  for (const host of ["evil-example.com", "example.com.attacker.net", "notexample.com", "example.co"])
    assert.equal(siteHolds("example.com", host), false, `${host} must not count as example.com`);
});

test("a page on another site, an insecure page, and an address carrying a name and password are all refused", async (t) => {
  const entry = { name: "shop", site: "example.com", service: "bitwarden", item: "My Shop", code: false, note: "" };
  assert.match(addressRefusal(entry, "https://evil.test/login", false), /saved for example\.com/);
  assert.match(addressRefusal(entry, "http://example.com/login", false), /not on a secure address/);
  assert.match(addressRefusal(entry, "https://someone:pw@example.com/login", false), /name and password of its own/);
  assert.equal(addressRefusal(entry, "https://accounts.example.com/login", false), null);

  const { autofill, page, manager } = await fixture(t, { url: "https://evil.test/login" });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), /saved for example\.com/);
  assert.deepEqual(page.typed, [], "nothing was typed");
  assert.deepEqual(manager.calls, [], "the password manager was never even asked");
});

test("Branch never chooses the sign-in itself: an unknown name is a refusal naming what to add", async (t) => {
  const { autofill, manager } = await fixture(t);
  await assert.rejects(() => autofill.fill({ login: "bank" }, context()), /no saved sign-in called "bank"/);
  assert.deepEqual(manager.calls, []);
});

test("a page the task was taken to from another website is filled only at the address the owner wrote down", async (t) => {
  const hop = { page: { acrossSites: true } };
  const { autofill: strayed } = await fixture(t, { url: "https://example.com/somewhere", ...hop });
  await assert.rejects(() => strayed.fill({ login: "shop" }, context()), /taken to this page from another website/);

  const written = await fixture(t, {
    url: "https://example.com/login", ...hop, entry: { address: "https://example.com/login" },
  });
  assert.equal((await written.autofill.fill({ login: "shop" }, context())).filled, "password");

  const elsewhere = await fixture(t, {
    url: "https://example.com/other", ...hop, entry: { address: "https://example.com/login" },
  });
  await assert.rejects(() => elsewhere.autofill.fill({ login: "shop" }, context()), /taken to this page from another website/);
});

test("pressing Sign in on the site whose address was opened is not a hop, so the one-time code still fills", async (t) => {
  // The only sequence in which a code box exists: open the address, fill the password, press Sign in,
  // and the code box appears on a page of the same website. Pressing there is not untrusted content.
  const { autofill, page } = await fixture(t, { url: "https://example.com/two-factor", entry: { code: true } });
  await autofill.fill({ login: "shop" }, context());
  assert.equal((await autofill.fill({ login: "shop", box: "code" }, context())).filled, "code");
  assert.deepEqual(page.typed.map((one) => one.box), ["password", "code"]);
  assert.ok(page.typed.every((one) => one.matched));
});

test("the browser decides that hop by the website, not by the press, so a sign-in flow is not broken", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "integrations", "browser.ts"), "utf8");
  assert.match(source, /acrossSites: entry\.pressed && \(!host \|\| host !== entry\.typedHost\)/,
    "a press within the website whose address was opened is not counted as a hop");
  assert.match(source, /entry\.typedHost = new URL\(url\)\.hostname\.toLowerCase\(\)/, "an address sets the website");
});

/* ───────────────────────────── who may ask ───────────────────────────── */

test("it ships off, and refuses plainly until the owner turns it on", async (t) => {
  const store = fakeStore();
  const settings = readVaultAutofillSettings(store, OWNER);
  assert.equal(settings.mode, "off");
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.logins, []);
  assert.equal(autofillGuard(store, OWNER, context()), autofillOffRefusal);

  const { autofill, manager } = await fixture(t, { mode: "off" });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), new RegExp("not set up to fill"));
  assert.deepEqual(manager.calls, []);
});

test("a chat task, a short-lived key, a Trunk, a schedule and Lockdown are each refused", async (t) => {
  const { store, autofill, manager } = await fixture(t);
  const runId = context().runId;

  store.eventRows.set(runId, [{ kind: "run.started", data: { source: "channel" } }]);
  assert.equal(autofillGuard(store, OWNER, context()), autofillChatRefusal);
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), new RegExp("chat app cannot"));
  store.eventRows.delete(runId);

  store.eventRows.set(runId, [{ kind: "run.started", data: { source: "owner", shortLivedKey: true } }]);
  assert.equal(autofillGuard(store, OWNER, context()), autofillShortLivedRefusal);
  store.eventRows.delete(runId);
  // The same refusal, reached the other way: another computer's request is marked as it arrives.
  assert.equal(underShortLivedKey(() => autofillGuard(store, OWNER, context())), autofillShortLivedRefusal);

  assert.equal(autofillGuard(store, OWNER, context({ trunkKeys: { copyFromOwner: false, accounts: {} } })), autofillTrunkRefusal);
  assert.equal(autofillGuard(store, OWNER, context({ source: "schedule" })), autofillStartedElsewhereRefusal);
  store.eventRows.set(runId, [{ kind: "run.started", data: { source: "trigger" } }]);
  assert.equal(autofillGuard(store, OWNER, context()), autofillStartedElsewhereRefusal);
  store.eventRows.delete(runId);

  store.save("settings", OWNER, "lockdown", { on: true, since: null, before: {} });
  assert.equal(autofillGuard(store, OWNER, context()), autofillLockdownRefusal);
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), new RegExp("Lockdown is on"));
  assert.deepEqual(manager.calls, [], "not one of those refusals asked the password manager anything");
});

test("a household person is refused before anything is read", async (t) => {
  const { store, manager, page } = await fixture(t);
  const resolver = new CredentialResolver(store, OWNER, new SecretScrubber(), manager.run);
  const autofill = new VaultAutofill({
    store, owner: OWNER, page, read: (reference, use) => resolver.read(reference, use),
    requireOwner: (what) => { throw new Error(`${what} is for the owner only.`); },
  });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), /Filling a saved sign-in is for the owner only/);
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(page.typed, []);
});

/* ───────────────────────────── the password manager itself ───────────────────────────── */

test("Bitwarden is asked with an argument array, never a line for a shell, and never for the real vault", async (t) => {
  const { autofill, manager } = await fixture(t, { entry: { item: "My Shop 2" } });
  await autofill.fill({ login: "shop" }, context());
  assert.equal(manager.calls.length, 1);
  const [call] = manager.calls;
  assert.ok(Array.isArray(call.args), "the arguments are an array, never a line a shell takes apart");
  assert.deepEqual(call.args, ["--nointeraction", "--raw", "get", "password", "My Shop 2"],
    "an item name with a space in it is still one argument");
  assert.ok(call.executable.includes("no-such-bw"), `the fixture must not name a real command: ${call.executable}`);
  assert.ok(!["bw", "bws", "op", "security"].includes(call.executable), "no real password manager is ever named here");
  // And a name a shell would read as more than a name never gets as far as a command at all.
  const store = fakeStore();
  for (const item of ["My Shop; rm -rf /", "$(bw list items)", "`id`", "a|b", "a&b"])
    assert.throws(() => saveVaultAutofillSettings(store, OWNER, { logins: [{ name: "shop", site: "a.test", item }] }),
      /item name/, `${item} was accepted as an item name`);
});

test("the same item's one-time code is read the same way, and only when the owner said it holds one", async (t) => {
  const without = await fixture(t);
  await assert.rejects(() => without.autofill.fill({ login: "shop", box: "code" }, context()), /not marked as holding a one-time code/);
  assert.deepEqual(without.manager.calls, []);

  const { autofill, manager, page, store } = await fixture(t, { entry: { code: true } });
  const answer = await autofill.fill({ login: "shop", box: "code" }, context());
  assert.deepEqual(manager.calls[0].args, ["--nointeraction", "--raw", "get", "totp", "My Shop"]);
  assert.equal(answer.filled, "code");
  assert.deepEqual(page.typed, [{ box: "code", label: undefined, length: THE_CODE.length, matched: true }]);
  assert.ok(!everythingWritten(store, manager.calls).includes(THE_CODE), "the code was written down somewhere");

  const onePassword = await fixture(t, { entry: { code: true, service: "1password", item: "Private/Shop/password" } });
  await assert.rejects(() => onePassword.autofill.fill({ login: "shop", box: "code" }, context()), /Bitwarden only/);
});

test("commandFor still answers exactly as it did for a password, and adds only the one-time code", () => {
  const settings = { bitwardenCommand: "bw", onePasswordCommand: "op", enabled: true, services: [], timeoutMs: 10000 };
  assert.deepEqual(commandFor({ service: "bitwarden", item: "GitHub" }, settings),
    { executable: "bw", args: ["--nointeraction", "--raw", "get", "password", "GitHub"] });
  assert.deepEqual(commandFor({ service: "bitwarden", item: "GitHub", field: "totp" }, settings),
    { executable: "bw", args: ["--nointeraction", "--raw", "get", "totp", "GitHub"] });
  assert.deepEqual(commandFor({ service: "1password", item: "Private/GitHub/password" }, settings),
    { executable: "op", args: ["read", "--no-newline", "op://Private/GitHub/password"] });
  // The fourth case is refused rather than quietly read as a password: a caller that asked for a
  // code and got a password would type the wrong secret into the wrong box.
  assert.throws(() => commandFor({ service: "1password", item: "Private/GitHub", field: "totp" }, settings),
    /one-time code from Bitwarden only/);
});

test("the real wiring registers the tool: a launch with a browser really has signin.fill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-autofill-boot-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.ok(!app.registry.names().includes("signin.fill"), "with no browser there is nothing to fill");
  const configPath = join(root, "integrations.json");
  // A browser is made but never started: BranchBrowser opens Chromium only when a page is asked for.
  await writeFile(configPath, JSON.stringify({ browser: { allowedOrigins: ["https://example.com"] } }));
  const loaded = await loadIntegrations(app.registry, configPath, {}, app.secretsFor, app.channelHost);
  t.after(() => loaded.close());
  assert.ok(app.registry.names().includes("signin.fill"), "the tool is registered beside the browser tools");
  assert.equal(app.registry.permissionOf("signin.fill"), "signin.fill");
  // Still off, so a task is never offered it until the owner switches it on.
  assert.deepEqual(switchedToolTiers(app.store, app.runtime.owner, app.registry.names()).hidden.includes("signin.fill"), true);
});

/* ───────────────────────────── the switch, the settings and the words ───────────────────────────── */

test("the switch hides the tool while it is off and loads it when it is on", () => {
  const store = fakeStore();
  const available = ["signin.fill", "browser.fill"];
  assert.deepEqual(switchedToolTiers(store, OWNER, available).hidden, ["signin.fill"]);
  saveVaultAutofillSettings(store, OWNER, { mode: "when-needed" });
  assert.deepEqual(switchedToolTiers(store, OWNER, available).hidden, []);
  assert.deepEqual(switchedToolTiers(store, OWNER, available).preload, []);
  saveVaultAutofillSettings(store, OWNER, { mode: "on" });
  assert.deepEqual(switchedToolTiers(store, OWNER, available).preload.map((one) => one.name), ["signin.fill"]);
  // Lockdown wins over whatever was saved.
  store.save("settings", OWNER, "lockdown", { on: true, since: null, before: {} });
  assert.deepEqual(switchedToolTiers(store, OWNER, available).hidden, ["signin.fill"]);
});

test("the settings screen counts as reaching further, and two sign-ins cannot share a name", () => {
  assert.equal(classify(vaultAutofillKey, "mode"), "less-careful-when-raised");
  assert.ok(specFor(vaultAutofillKey), "the setting is in the catalogue");
  const store = fakeStore();
  assert.throws(() => saveVaultAutofillSettings(store, OWNER, {
    mode: "when-needed",
    logins: [{ name: "shop", site: "a.test", item: "A" }, { name: "shop", site: "b.test", item: "B" }],
  }), /same name/);
  // A site with a scheme or a path in it is not a site.
  assert.throws(() => saveVaultAutofillSettings(store, OWNER, { logins: [{ name: "shop", site: "https://a.test/x", item: "A" }] }));
});

test("the book of sign-ins is the owner's alone: a short-lived key may neither read it nor change it", () => {
  assert.ok(ownerOnlyRead("/api/vault-autofill/settings"), "a short-lived key may not read the book");
  assert.ok(offLimitsToShortLivedKeys("GET", "/api/vault-autofill/settings"));
  assert.match(offLimitsToShortLivedKeys("POST", "/api/vault-autofill/settings"), /cannot change which saved sign-ins/);
});

test("every word on the card has real French, and the reference explains the setting in plain words", async () => {
  const here = join(import.meta.dirname, "..", "public");
  const card = await readFile(join(here, "vault-autofill.js"), "utf8");
  const en = JSON.parse(await readFile(join(here, "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(here, "locales", "fr.json"), "utf8"));
  const keys = [...card.matchAll(/"(vault-autofill\.[a-z0-9.-]+)"/g)].map((hit) => hit[1]);
  assert.ok(keys.length > 10, "the card says what it means through keys");
  // The two password managers are called what they are called; every other word is really translated.
  const brands = ["vault-autofill.service.bitwarden", "vault-autofill.service.1password"];
  assert.deepEqual([...new Set(keys)].filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !brands.includes(key))), []);
  for (const key of ["settings-kit.name.vault-autofill"])
    assert.ok(en[key] && fr[key] && en[key] !== fr[key], `${key} needs English and real French`);

  const reference = await readFile(join(import.meta.dirname, "..", "docs", "configuration.md"), "utf8");
  assert.ok(!/Credential vault \(R17-068\): awaiting owner/.test(reference), "the design note is still there");
  for (const field of ["`enabled`", "`mode`", "`logins`", "`timeoutMs`"])
    assert.ok(reference.includes(field), `the reference never names ${field}`);
  assert.match(reference, /Filling a saved sign-in/);
});

/* ───────────────────────────── the old refusals stay ───────────────────────────── */

test("the browser's own typing tool still refuses a password box outright", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "integrations", "browser.ts"), "utf8");
  const refusals = source.match(/Password fields require a dedicated credential integration/g) ?? [];
  assert.equal(refusals.length, 2, "browser.fill and browser.act both still refuse a password box");
  assert.match(source, /if \(box === 'password' && kind !== 'password'\)/,
    "a password only ever goes into a real password box");
});
