/**
 * R17-A: the Trunks screens, opened the way a person opens them, at 400 px wide, in a headless
 * browser against a scratch workspace. Every word is behind a key with real French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { brain } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the Trunks screens has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("trunks.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(trunks\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 80, `only ${keys.length} keys`);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/trunks.js" type="module"><\/script>/);
});

const rules = [({ last, system }) => {
  const text = last?.content ?? "";
  if (text.startsWith("[Room") && /\nYou are Ada \(@ada\)/.test(system)) return "I can do it. @you which day?";
  if (text.startsWith("[Room")) return "(pass)";
  return null;
}];

test("the card, the three-field create, Edit Trunk, a room, the roster and @ in the message box, with nothing scrolling sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain(rules) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const until = async (check) => { for (let i = 0; i < 200 && !(await check()); i++) await page.waitForTimeout(50); };

  await openPlace(page, "customize:specialists");
  const card = page.locator("#trunks-card");
  await card.waitFor();
  assert.equal(await card.locator("h2").innerText(), "Trunks");
  assert.equal(await page.evaluate(() => document.getElementById("trunks-card").parentElement.id), "specialists");
  assert.equal(await page.locator("#trunks-switch-trunks").inputValue(), "off");
  assert.equal(await page.locator("#trunks-create").count(), 0, "nothing but the switch while it is off");
  assert.equal(await page.locator("#trunks-rail").count(), 0);
  await page.locator("#trunks-switch-trunks").selectOption("on");
  await page.locator("#trunks-create").waitFor();

  // Three fields.
  await page.locator("#trunks-new-name").fill("Ada");
  await page.locator("#trunks-new-title").fill("Planner");
  await page.locator("#trunks-new-description").fill("Plans trips");
  await page.getByRole("button", { name: "Create the Trunk" }).click();
  await page.locator('#trunks-list [data-trunk]').first().waitFor();
  await app.trunks.introduced();
  assert.equal(app.trunks.records.list()[0].handle, "ada");
  assert.equal(await wide(), false, "no sideways scrolling in Customize");

  // Edit Trunk opens every field.
  await page.getByRole("button", { name: "Edit Trunk" }).click();
  await page.locator("#trunks-edit-instructions").waitFor();
  for (const id of ["name", "title", "description", "model", "reasoning", "instructions", "style", "permissions", "skills", "mcp", "channels", "section"])
    assert.equal(await page.locator(`#trunks-edit-${id}`).count(), 1, id);
  assert.equal(await page.locator("#trunks-edit-commands").isChecked(), false, "commands start off");
  await page.locator("#trunks-edit-instructions").fill("Always ask about the budget.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await until(async () => app.trunks.records.list()[0].instructions === "Always ask about the budget.");
  assert.equal(app.trunks.records.list()[0].instructions, "Always ask about the budget.");
  assert.equal(await wide(), false, "no sideways scrolling in the editor");

  // The roster sits above Recents, with the unread introduction.
  const railRow = page.locator('#trunks-rail [data-trunk]');
  await railRow.first().waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => document.getElementById("trunks-rail").nextElementSibling?.dataset.group), "recents");
  assert.match(await railRow.first().innerText(), /Ada/);
  assert.equal(await railRow.first().locator(".rail-badge").innerText(), "1");
  await page.locator("#rail-toggle").click();
  await page.locator("#rail-view-trunks").click();
  assert.equal(await railRow.first().isVisible(), true, "the Trunks tab shows the real roster");
  assert.equal(await page.locator('.rail-group[data-group="recents"]').isVisible(), false, "the two lists do not compete");
  await page.keyboard.press("Escape");

  // A room: two Trunks, one @you raises "needs you".
  await app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  await page.locator("#trunks-switch-rooms").selectOption("on");
  await page.locator("#trunks-room-name").waitFor();
  await page.locator("#trunks-room-name").fill("Trip");
  for (const box of await page.locator('input[id^="trunks-room-pick-"]').all()) await box.check();
  await page.getByRole("button", { name: "Open a room" }).click();
  await page.locator("#trunks-room-message").waitFor();
  await page.locator("#trunks-room-message").fill("Where shall we go?");
  await page.locator("#trunks-room").getByRole("button", { name: "Send", exact: true }).click();
  const room = app.trunks.rooms.list()[0];
  await app.trunks.rooms.settled(room.id);
  await page.locator("#trunks-room").getByRole("button", { name: "Close the room" }).click();
  // The sidebar is folded away at this width, so it is slid open first, as a person would.
  if (!(await page.locator('#trunks-rail [data-room]').first().isVisible())) await page.locator("#rail-toggle").click();
  await page.locator('#trunks-rail [data-room]').first().click();
  await page.locator("#trunks-room").getByText("@ada: I can do it. @you which day?").waitFor();
  await page.locator("#trunks-room").getByRole("button", { name: "Reply to @ada" }).click();
  assert.equal(await page.locator("#trunks-room-message").inputValue(), "@ada ");
  assert.equal(await wide(), false, "no sideways scrolling with a room open");
  await openPlace(page, "inbox:needs");
  await page.locator("#trunks-needs-card").waitFor();
  assert.equal(await page.locator("#trunks-needs-card h2").innerText(), "Rooms that need you");

  // "@" in the message box offers the Trunks; "@ada …" goes to Ada.
  await openPlace(page, "chat");
  await page.locator("#prompt").click();
  await page.locator("#prompt").pressSequentially("@ad");
  await page.locator("#trunks-mentions [data-handle='ada']").waitFor();
  await page.locator("#prompt").press("Enter");
  assert.equal(await page.locator("#prompt").inputValue(), "@ada ");
  await page.locator("#prompt").pressSequentially("hello there");
  await page.locator("#prompt").press("Enter");
  const ada = app.trunks.records.list().find((trunk) => trunk.handle === "ada");
  await until(async () => app.store.messages(ada.chatSessionId).some((m) => m.content === "hello there"));
  assert.ok(app.store.messages(ada.chatSessionId).some((m) => m.content === "hello there"), "the message went to Ada's own conversation");
  assert.equal(await wide(), false, "no sideways scrolling in the conversation");
});
