/* The People page as the approved sample has it: the eyebrow above the one title, "+ Invite someone"
   in a dialog instead of a raw form, what each person may do from the grant Branch really holds
   them to, the Trunks / Projects / Daily allowance / PIN facts, Change look on the owner's card, and
   a way from Settings › Trunks & people to each person's card. Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-people-grown-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /\/(people-place|studio|strip)\.js/.test(message.location().url ?? "")) errors.push(message.text().slice(0, 200));
  });
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
    await page.locator("body.lx-ready").waitFor({ state: "attached" });
    await page.locator("#trunk-strip .strip-brand").waitFor({ state: "visible", timeout: 120000 });
  };
  const people = async () => {
    await page.evaluate(async () => (await import("/people-place.js")).showPeople());
    await page.locator(".people-page .person-card").first().waitFor();
  };
  return { call, page, errors, open, people };
}
const mayOf = (card) => card.locator(".person-may li").evaluateAll((items) => items.map((item) => `${item.dataset.kind}:${item.className}`));
const factsOf = (card) => card.locator(".person-facts").evaluate((list) => [...list.querySelectorAll("dt")].map((term) => `${term.textContent}=${term.nextElementSibling.textContent}`));

test("People opens on the eyebrow, the title and + Invite someone; the dialog checks, cancels and adds", async (t) => {
  const f = await fixture(t);
  await f.open();
  await f.people();
  const head = await f.page.locator(".people-page .shell-head > *").evaluateAll((nodes) => nodes.map((node) => `${node.tagName}:${node.textContent}`));
  assert.deepEqual(head.slice(0, 2), ["P:This computer", "H2:People"], "the eyebrow sits right above the one title");
  assert.equal(await f.page.locator(".people-page h1, .people-page h2").count(), 1, "one page title");
  assert.equal(await f.page.locator(".person-add, .people-page input").count(), 0, "no raw form on opening");
  const acts = await f.page.locator(".people-acts .shell-btn").allInnerTexts();
  assert.deepEqual(acts.map((text) => text.trim()), ["Invite someone", "A PIN for switching back to you"]);

  await f.page.locator("#people-invite").click();
  const dialog = f.page.getByRole("dialog", { name: "Invite someone" });
  await dialog.waitFor();
  assert.deepEqual(await dialog.getByRole("tab").allInnerTexts(), ["On this computer", "On their own device"]);
  await dialog.getByRole("button", { name: "Add them" }).click();
  assert.equal(await dialog.getByRole("alert").innerText(), "Write their name.");
  await dialog.getByLabel("Name").fill("Jo");
  await dialog.getByLabel("Their PIN, four to eight digits").fill("12");
  await dialog.getByRole("button", { name: "Add them" }).click();
  assert.equal(await dialog.getByRole("alert").innerText(), "A PIN is four to eight digits.");
  await f.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal((await f.call("/api/profiles")).profiles.length, 0, "cancelling adds nobody");

  const roleCalls = [];
  f.page.on("request", (request) => { if (/\/api\/profiles\/[^/]+\/role$/.test(new URL(request.url()).pathname)) roleCalls.push(request.url()); });
  await f.page.locator("#people-invite").click();
  await dialog.getByLabel("Name").fill("Jo");
  await dialog.getByRole("group", { name: "Role" }).getByRole("button", { name: "Child" }).click();
  assert.match(await dialog.locator(".studio-field small").innerText(), /May look things up and answer questions/);
  await dialog.getByLabel("Their PIN, four to eight digits").fill("4321");
  await dialog.getByRole("button", { name: "Add them" }).click();
  await dialog.waitFor({ state: "detached" });
  const jo = (await f.call("/api/profiles")).profiles.find((person) => person.name === "Jo");
  assert.ok(jo, "Jo is added");
  const card = f.page.locator(`.person-card[data-person="${jo.id}"]`);
  await card.waitFor();
  assert.equal(await card.locator(".shell-pill").innerText(), "Child", "with the role chosen in the dialog");
  assert.deepEqual(roleCalls, [], "added with the role in one call, so a failed second call cannot leave a Child as an Adult");
  assert.deepEqual(await mayOf(card), ["read:yes", "browse:no", "files:no", "commands:no", "message:no", "spend:no", "settings:no"]);
  assert.deepEqual(await factsOf(card), ["Trunks=None", "Projects=All of them", "Daily allowance=None", "PIN=Set"]);
  assert.deepEqual(f.errors, []);
});

test("each card lists what the grant really allows, the owner's card changes the look, and a person sees neither", async (t) => {
  const f = await fixture(t);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  await f.call(`/api/profiles/${sam.id}/role`, { role: "adult", categories: ["read", "files"], projects: ["garden"], dailySpendLimit: 2.5 });
  await f.open();
  await f.people();
  const owner = f.page.locator('.person-card[data-person="owner"]');
  assert.deepEqual(await mayOf(owner), ["read:yes", "browse:yes", "files:yes", "commands:yes", "message:yes", "spend:yes", "settings:yes"]);
  assert.deepEqual(await factsOf(owner), ["Trunks=All of them", "Projects=All of them", "Daily allowance=None", "PIN=Off"]);
  const card = f.page.locator(`.person-card[data-person="${sam.id}"]`);
  assert.deepEqual(await mayOf(card), ["read:yes", "browse:no", "files:yes", "commands:no", "message:no", "spend:no", "settings:no"],
    "a narrowed grant shows as narrowed, not as the role's full list");
  assert.deepEqual(await factsOf(card), ["Trunks=None", "Projects=garden", "Daily allowance=2.50", "PIN=Set"]);
  assert.equal(await card.getByRole("button", { name: "Change look" }).count(), 0);
  await owner.getByRole("button", { name: "Change look" }).click();
  await f.page.locator("#lx-page-appearance").waitFor({ state: "visible" });

  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await f.page.waitForFunction(() => document.documentElement.dataset.household === "on");
  await f.people();
  assert.equal(await f.page.locator("#people-invite, .people-acts").count(), 0, "no inviting for a household person");
  assert.equal(await f.page.getByRole("button", { name: "Change look" }).count(), 0);
  assert.deepEqual(await mayOf(f.page.locator(`.person-card[data-person="${sam.id}"]`)),
    ["read:yes", "browse:no", "files:yes", "commands:no", "message:no", "spend:no", "settings:no"]);
  assert.deepEqual(f.errors, []);
});

test("a person's own card ticks only what Branch enforces and names their own Trunks", async (t) => {
  const f = await fixture(t);
  for (const part of ["trunks", "rooms"]) await f.call("/api/trunks/switch", { part, mode: "on" });
  const scout = (await f.call("/api/trunks", { name: "Scout" })).trunk;
  const quill = (await f.call("/api/trunks", { name: "Quill" })).trunk;
  const ledger = (await f.call("/api/trunks", { name: "Ledger" })).trunk;
  const pip = (await f.call("/api/trunks", { name: "Pip" })).trunk;
  const kim = await f.call("/api/profiles", { name: "Kim", pin: "1234" });
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "5678" });
  // Kim is an Adult in a group that only lets its members look things up.
  await f.call("/api/people/settings", { mode: "on" });
  const family = await f.call("/api/people/groups", { name: "Family", members: [kim.id], categories: ["read"] });
  assert.equal(family.groups?.length, 1, JSON.stringify(family));
  await f.call("/api/trunks/rooms", { name: "Homework", members: [scout.id, quill.id], people: [kim.id] });
  await f.call("/api/trunks/rooms", { name: "Owner only", members: [ledger.id, pip.id], people: [] });
  // Sam is narrowed to read + files as an Adult, then made a Child from his card.
  await f.call(`/api/profiles/${sam.id}/role`, { role: "adult", categories: ["read", "files"] });
  await f.open();
  await f.people();
  const samCard = f.page.locator(`.person-card[data-person="${sam.id}"]`);
  await samCard.getByRole("group", { name: "What Sam may do" }).getByRole("button", { name: "Child" }).click();
  await f.page.waitForFunction((id) => document.querySelector(`.person-card[data-person="${id}"] .shell-pill`)?.textContent === "Child", sam.id);
  const onlyRead = ["read:yes", "browse:no", "files:no", "commands:no", "message:no", "spend:no", "settings:no"];
  const kimCard = f.page.locator(`.person-card[data-person="${kim.id}"]`);
  assert.deepEqual(await mayOf(kimCard), onlyRead, "the owner sees Kim's group narrowing");
  assert.deepEqual(await mayOf(samCard), onlyRead, "the owner sees the Child cap");
  const ownerSees = await factsOf(kimCard);
  assert.equal(ownerSees[0], "Trunks=Scout, Quill", "the Trunks in the rooms Kim was let into");

  for (const [person, pin] of [[kim, "1234"], [sam, "5678"]]) {
    await f.call("/api/profiles/switch", { profileId: person.id, pin });
    await f.page.reload();
    await f.page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
    await f.page.waitForFunction(() => document.documentElement.dataset.household === "on");
    await f.people();
    const own = f.page.locator(`.person-card[data-person="${person.id}"]`);
    assert.deepEqual(await mayOf(own), onlyRead, `${person.name}'s own card ticks only what Branch enforces`);
    const facts = await factsOf(own);
    if (person === kim) assert.deepEqual(facts, ownerSees, "Kim's own Trunks are the ones the owner's card lists, not room names");
    else assert.equal(facts[0], "Trunks=None", "Sam is in no room");
    await f.call("/api/profiles/switch", { profileId: null });
  }
  assert.deepEqual(f.errors, []);
});

test("Settings › Trunks & people leads to each person's card; French and a phone keep it whole", async (t) => {
  const f = await fixture(t, { width: 400, height: 860 });
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const ada = await f.call("/api/profiles", { name: "Ada", pin: "5678" });
  await f.open();
  await f.page.evaluate(async () => (await import("/app.js")).displayView("settings:trunks"));
  /* The list lives in the sample's "A person's card" section; a missing anchor fails here, not silently. */
  await f.page.locator("#lx-page-trunks #settings-person-card").waitFor({ state: "visible", timeout: 20000 });
  const row = f.page.locator(`#settings-person-card .settings-person[data-person="${sam.id}"]`);
  await row.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  assert.equal(await f.page.locator("#settings-person-card > .settings-people").count(), 1, "the people list is in A person's card");
  assert.deepEqual(await f.page.locator("#settings-person-card .settings-person b").allInnerTexts(), ["The owner", "Ada", "Sam"]);
  /* Choosing whose card draws the card anew, with nothing saved; the list comes back with it. */
  await f.page.evaluate(() => { document.getElementById("settings-person-card").dataset.before = "yes"; });
  await f.page.locator("#settings-person-pick").selectOption(ada.id);
  await f.page.locator("#settings-person-card:not([data-before])").waitFor({ state: "attached", timeout: 10000 });
  /* Put back in the same turn the card is drawn, not whenever the strip next refreshes. */
  assert.equal(await f.page.locator("#settings-person-card > .settings-people").count(), 1, "the list survives the card being drawn again");
  await row.click();
  const card = f.page.locator(`.person-card[data-person="${sam.id}"]`);
  await card.waitFor();
  await f.page.waitForFunction((id) => document.activeElement?.dataset.person === id, sam.id);

  await f.page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await f.people();
  await f.page.locator("#people-invite").click();
  const dialog = f.page.locator("#studio");
  await dialog.getByRole("tab", { name: "Sur son propre appareil" }).click();
  await dialog.getByText("La connexion depuis son propre appareil est désactivée", { exact: false }).waitFor();
  const untranslated = await f.page.evaluate(() => [...document.querySelectorAll("[data-t]")]
    .filter((node) => node.checkVisibility() && node.textContent.trim() === node.dataset.t).map((node) => node.dataset.t));
  assert.deepEqual(untranslated, []);
  await f.page.keyboard.press("Escape");
  assert.equal(await card.locator(".person-facts dt").first().innerText(), "Ses Trunks");
  const wide = await f.page.evaluate(() => [...document.querySelectorAll(".people-page, .person-card")]
    .filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.className));
  assert.deepEqual(wide, [], "nothing runs off the side at 400 px");
  assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll");
  assert.deepEqual(f.errors, []);
});
