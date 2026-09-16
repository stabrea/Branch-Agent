/**
 * Wave 7: the screens the earlier waves left as routes, and the observability leftovers.
 * What is allowed right now, approval buttons in a chat app, signing in with Google for Gemini,
 * label chips, markdown everywhere, "/model" without its module, comparing two tasks, saving a
 * trajectory, the live event feed, the month view and the metering export.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch, modelsUrl, probeProvider, googleRefusedSignIn } from "../dist/index.js";
import { GeminiProvider } from "../dist/providers/gemini.js";
import { startServer } from "../dist/server.js";

/** A workspace and a server, cleaned up when the test ends. */
export async function served(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-wave7-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, api, root };
}

/**
 * A connected browser page on the app. `block` names public files the browser must not get, so a
 * screen can be proven to still work when one of its modules is missing.
 */
export async function onPage(t, options = {}) {
  const { app, server, api, root } = await served(t, options.provider);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const file of options.block ?? []) await page.route("**" + file, (route) => route.abort());
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  if (await page.locator("#first-run").isVisible()) {
    await page.getByRole("button", { name: /Just look around/ }).click();
    await page.getByRole("button", { name: "Done, start chatting", exact: true }).click();
    await page.locator("#first-run").waitFor({ state: "hidden" });
  }
  return { app, server, api, page, errors, root };
}

/* ---------- G3: the Gemini sign-in honours the bearer flag ---------- */

test("G3 a signed-in Gemini connection is checked with an Authorization header, not the key header", () => {
  const key = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "AIza-test" });
  const signedIn = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "ya29-token", bearer: true });
  const withKey = modelsUrl(key);
  const withToken = modelsUrl(signedIn);
  assert.equal(withKey.headers["x-goog-api-key"], "AIza-test", "a key still goes in Google's key header");
  assert.equal(withKey.headers.authorization, undefined);
  assert.equal(withToken.headers.authorization, "Bearer ya29-token", "a sign-in token goes in the ordinary header");
  assert.equal(withToken.headers["x-goog-api-key"], undefined, "a sign-in token is never put in the key header");
  assert.equal(withToken.url, withKey.url, "both ask the same address");
});

test("G3 when Google refuses a sign-in the card says so plainly and keeps the key flow", async (t) => {
  const { app } = await served(t);
  app.runtime.models.register({
    id: "google-gemini", name: "Gemini (signed in with Google)", model: "gemini-2.5-flash",
    provider: new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "ya29-token", bearer: true }),
  });
  let sentHeaders = null;
  const refusing = async (_url, init) => { sentHeaders = init.headers; return new Response("{}", { status: 403 }); };
  const probe = await probeProvider(app.runtime.models, "google-gemini", app.web.policy, refusing);
  assert.equal(sentHeaders.authorization, "Bearer ya29-token");
  assert.equal(probe.signedIn, false);
  assert.equal(probe.signedInWithGoogle, true);
  assert.equal(probe.summary, googleRefusedSignIn, "the card repeats Google's answer in plain words");
  assert.match(probe.summary, /your own Google Cloud project/);
  assert.match(probe.fix, /Paste a Gemini API key/, "the ordinary key flow is still offered");
  assert.doesNotMatch(probe.summary, /403/, "no status code is put in front of the person");
});

test("G3 the Gemini card has a route that reports whether a sign-in is set up", async (t) => {
  const { api } = await served(t);
  const before = await api("GET", "/api/models/gemini-signin");
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.match(before.body.note, /Google Cloud project/);
  /* With no client id there is nothing to sign in to, and it says so rather than failing silently. */
  const refused = await api("POST", "/api/models/gemini-signin", { clientId: "", model: "gemini-2.5-flash" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /No Google sign-in is set up/);
  /* The model the owner typed is remembered even though the sign-in itself did not happen. */
  const after = await api("GET", "/api/models/gemini-signin");
  assert.equal(after.body.settings.model, "gemini-2.5-flash");
});

/* ---------- G6: "/model" and "/help" without public/model-profiles.js ---------- */

test("G6 the message box knows its own commands, so /model and /help work without the module", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /export function parseSlashCommand/, "the parser lives in app.js, not only in the module");
  assert.match(source, /switchModelWithoutModule/, "app.js can change the model on its own");
  const module = await readFile(new URL("../public/model-profiles.js", import.meta.url), "utf8");
  assert.match(module, /branchSlashCommand/, "the module is still the handler when it is loaded");
  assert.match(module, /presetName/, "profile cards read connection names rather than ids");
});

/* ---------- G5: markdown everywhere, and Appearance in French ---------- */

const markdownReply = "## What I did\n\nI read **two** files and found `answer = 42`.\n\n- one\n- two\n";
const scripted = { name: "scripted", async complete() { return { content: markdownReply, toolCalls: [] }; } };

test("G5 the Activity screen and the inspector render a reply as markdown, never as markup", async (t) => {
  const { page, errors } = await onPage(t, { provider: scripted });
  await page.locator("#prompt").fill("do the thing");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator('#conversation .markdown h2').first().waitFor();
  await page.locator('[data-view="runs"]').first().click();
  const card = page.locator("#runs-list .item").first();
  await card.locator(".markdown h2").waitFor();
  assert.equal(await card.locator(".markdown h2").textContent(), "What I did");
  assert.equal(await card.locator(".markdown strong").first().textContent(), "two");
  assert.equal(await card.locator(".markdown code").first().textContent(), "answer = 42");
  assert.equal(await card.locator(".markdown li").count(), 2, "the list is a real list");

  await card.getByRole("button", { name: "Look inside", exact: true }).first().click();
  const panel = page.locator("#inspect-panel");
  await panel.locator(".markdown h2").first().waitFor();
  assert.equal(await panel.locator(".markdown h2").first().textContent(), "What I did");
  assert.deepEqual(errors, []);
});

test("G5 Appearance is written in French when French is chosen", async (t) => {
  const { page, errors } = await onPage(t);
  await page.locator('[data-view="settings"]').first().click();
  assert.equal(await page.locator("#settings-form h2").textContent(), "Appearance");
  assert.equal(await page.locator("#accent-choices .choice").first().textContent(), "Copper");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.querySelector("#settings-form h2").textContent === "Apparence");
  assert.equal(await page.locator("#accent-label").textContent(), "Couleur de mise en avant");
  assert.equal(await page.locator("#accent-choices .choice").first().textContent(), "Cuivre");
  assert.equal(await page.locator("#text-size-label").textContent(), "Taille du texte");
  assert.equal(await page.locator("#settings-form button[data-t='appearance.save']").textContent(), "Enregistrer l'apparence");
  assert.deepEqual(errors, []);
});

test("G5 every key the page names has words in both languages", async () => {
  const dir = new URL("../public/", import.meta.url);
  const en = JSON.parse(await readFile(new URL("locales/en.json", dir), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", dir), "utf8"));
  const html = await readFile(new URL("index.html", dir), "utf8");
  const used = new Set([...html.matchAll(/data-t(?:-label|-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((key) => !(key in en));
  assert.deepEqual(missing, [], "these keys are named in the page but have no English words");
  const untranslated = Object.keys(en).filter((key) => !(key in fr));
  assert.deepEqual(untranslated, [], "these keys have no French words");
});

test("G6 typing /model with the models module blocked still lists the choices", async (t) => {
  const { page, errors } = await onPage(t, { block: ["/model-profiles.js"] });
  assert.equal(await page.evaluate(() => Boolean(globalThis.branchSlashCommand)), false, "the module really is absent");
  await page.locator("#prompt").fill("/model");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator("#toast").waitFor({ state: "visible" });
  assert.match(await page.locator("#toast").textContent(), /Type \/model followed by a name/);
  assert.equal(await page.locator("#prompt").inputValue(), "", "the command is not left in the box");
  assert.equal(await page.locator("#conversation").textContent(), "", "nothing was sent to the model");

  await page.locator("#prompt").fill("/help");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("/help"));
  assert.match(await page.locator("#toast").textContent(), /\/model — Change the model/);
  assert.deepEqual(errors, []);
});
