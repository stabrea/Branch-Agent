import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * The other half of attachments: in the window itself, a document is attached to a message instead of
 * being refused with "use the Documents panel", and the file goes with the message rather than being
 * read out and thrown away.
 *
 * Local only: a scripted model, a server on its own port, and a headless browser.
 */

const owner = "local";

async function windowWithBranch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-ui-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Read it.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const browser = await chromium.launch({ headless: true });
  closing.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((token) => sessionStorage.setItem("branch-token", token), server.token);
  await page.goto(server.url, { waitUntil: "domcontentloaded" });
  return { app, page, root, errors };
}

test("in the window: a document goes with the message, and the conversation keeps it", async (t) => {
  const { app, page, root, errors } = await windowWithBranch(t);
  const file = join(root, "roof.md");
  await writeFile(file, "# Roof\n\nFixed on Tuesday.\n", "utf8");

  await page.locator("#composer-media-file").setInputFiles(file);
  await page.locator("#composer-attachments").getByText("roof.md").waitFor({ timeout: 10000 });

  await page.locator("#prompt").fill("What does this say?");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.getByText("Read it.").first().waitFor({ timeout: 20000 });

  const sessionId = await page.locator("#conversation").getAttribute("data-session-id");
  assert.ok(sessionId, "the message started a conversation");
  const message = app.store.messages(sessionId).find((one) => one.role === "user");
  assert.equal(message.attachments?.length, 1, "the document went with the message");
  assert.equal(message.attachments[0].kind, "document");
  assert.equal(message.attachments[0].name, "roof.md");
  assert.equal(message.attachments[0].mediaType, "text/markdown");

  // And it can be opened again, as the file it was.
  const kept = await app.attachments.read(sessionId, message.attachments[0].id);
  assert.match(kept.bytes.toString("utf8"), /Fixed on Tuesday/);
  assert.deepEqual(errors, []);
});

test("reopening the conversation shows the file, and the visible control fetches the real bytes", async (t) => {
  const { app, page, root, errors } = await windowWithBranch(t);
  const file = join(root, "roof.md");
  const words = "# Roof\n\nFixed on Tuesday, by Sam.\n";
  await writeFile(file, words, "utf8");

  await page.locator("#composer-media-file").setInputFiles(file);
  await page.locator("#composer-attachments").getByText("roof.md").waitFor({ timeout: 10000 });
  await page.locator("#prompt").fill("What does this say?");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.getByText("Read it.").first().waitFor({ timeout: 20000 });
  const sessionId = await page.locator("#conversation").getAttribute("data-session-id");

  // Reload the window and open the saved conversation again — the way a person comes back to it.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(async (id) => {
    const app = await import("/app.js");
    await app.openConversation(id);
  }, sessionId);
  await page.locator(`[data-attachment]`).first().waitFor({ timeout: 20000 });

  // The card is really there, with the file's own name and size.
  const card = page.locator("[data-attachment]").first();
  await card.getByText("roof.md").waitFor();
  assert.match(await card.textContent(), /document/, "it says what kind of file it is");

  // And the visible control hands back the real bytes, fetched with the window's own key.
  const got = await page.evaluate(async () => {
    const id = document.querySelector("[data-attachment]").dataset.attachment;
    const session = document.getElementById("conversation").dataset.sessionId;
    const answer = await fetch(`/api/attachments/file?session=${session}&id=${id}`, {
      headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") },
    });
    return { status: answer.status, text: await answer.text() };
  });
  assert.equal(got.status, 200);
  assert.equal(got.text, words, "byte for byte what was attached");
  assert.deepEqual(errors, []);
  void app;
});

test("in the window: two films that each fit are refused together, before either is read", async (t) => {
  const { page, errors } = await windowWithBranch(t);

  // Both are inside the 32 MB a film may be; together they are past what one message may carry. The
  // page must say so before it reads the second one, not leave the server to refuse the upload.
  const outcome = await page.evaluate(async () => {
    const said = [];
    const toast = globalThis.toast;
    globalThis.toast = (message) => { said.push(String(message)); };
    const film = (name) => new File([new Uint8Array(17 * 1024 * 1024)], name, { type: "video/mp4" });
    const picker = document.getElementById("composer-media-file");
    const put = (file) => {
      const carrier = new DataTransfer();
      carrier.items.add(file);
      picker.files = carrier.files;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    };
    put(film("first.mp4"));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    put(film("second.mp4"));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    globalThis.toast = toast;
    return { said, chips: [...document.querySelectorAll("#composer-attachments .attachment")].map((one) => one.textContent) };
  });

  assert.equal(outcome.chips.filter((one) => one.includes("second.mp4")).length, 0,
    `the second film is not on the message (${outcome.chips.join(" | ")})`);
  assert.ok(outcome.said.some((one) => /add up to 32 MB/.test(one)),
    `and the page says why, in words a person can act on (${outcome.said.join(" | ")})`);
  assert.deepEqual(errors, []);
});

test("in the window: the chips are cleared once the message is sent", async (t) => {
  const { page, root, errors } = await windowWithBranch(t);
  const file = join(root, "notes.txt");
  await writeFile(file, "a note", "utf8");

  await page.locator("#composer-media-file").setInputFiles(file);
  await page.locator("#composer-attachments").getByText("notes.txt").waitFor({ timeout: 10000 });
  await page.locator("#prompt").fill("Keep this.");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.getByText("Read it.").first().waitFor({ timeout: 20000 });

  await page.locator("#composer-attachments").waitFor({ state: "hidden", timeout: 10000 });
  assert.deepEqual(errors, []);
});

/** A real one-pixel PNG, so the page sees a picture rather than a file it calls a picture. */
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

test("what was said is shown exactly once, whether or not a file came with it", async (t) => {
  const { app, page, root, errors } = await windowWithBranch(t);
  const file = join(root, "roof.md");
  await writeFile(file, "# Roof" + "\n\n" + "Fixed on Tuesday." + "\n", "utf8");

  // An ordinary message, nothing attached. This is the one that was rendered twice.
  await page.locator("#prompt").fill("Tell me about the roof.");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.getByText("Read it.").first().waitFor({ timeout: 20000 });
  const sessionId = await page.locator("#conversation").getAttribute("data-session-id");
  const plain = await page.locator(".message.user").first().textContent();
  assert.equal(plain.split("Tell me about the roof.").length - 1, 1,
    `an ordinary message says what was said once, not twice (${plain})`);

  // And a message that does carry a file keeps both: the words, once, and the card.
  // A file cannot be put on the next message while the assistant is still working — the page says so
  // in as many words (public/media.js) — and the reply appears on the screen a moment before the rest
  // of the turn finishes. So wait for the attach button to come back, which is what a person sees.
  await page.waitForFunction(() => !document.getElementById("composer-media")?.disabled, null, { timeout: 20000 });
  await page.locator("#composer-media-file").setInputFiles(file);
  await page.locator("#composer-attachments").getByText("roof.md").waitFor({ timeout: 10000 });
  await page.locator("#prompt").fill("And what does this say?");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator("[data-attachment]").first().waitFor({ timeout: 20000 });
  const withFile = await page.locator(".message.user").last().textContent();
  assert.equal(withFile.split("And what does this say?").length - 1, 1,
    `a message with a file says what was said once (${withFile})`);
  assert.match(withFile, /roof\.md/, "and the card is there beside the words");

  // A reply that carries a file must not lose its words either. Put one in the conversation the way
  // the store holds it, then reopen the conversation the way a person comes back to it.
  const ref = app.store.messages(sessionId).findLast((one) => one.role === "user").attachments[0];
  app.store.message(sessionId, { role: "assistant", content: "Here it is again.", attachments: [ref] });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(async (id) => {
    const app = await import("/app.js");
    await app.openConversation(id);
  }, sessionId);
  const reply = page.locator(".message.assistant").last();
  await reply.getByText("Here it is again.").waitFor({ timeout: 20000 });
  assert.match(await reply.textContent(), /roof\.md/, "the reply keeps its words and its card");
  assert.deepEqual(errors, []);
});

test("a picture goes with the message once: the page does not also send it to be looked at", async (t) => {
  const { page, root, errors } = await windowWithBranch(t);
  const file = join(root, "dot.png");
  await writeFile(file, onePixelPng);

  await page.locator("#composer-media-file").setInputFiles(file);
  await page.locator("#composer-attachments").getByText("dot.png").waitFor({ timeout: 10000 });

  // The page has two lists: what the model should look at, and what the message carries. A picture a
  // person attached belongs in the second only — the server derives the model's copy from it. Sending
  // it in both doubled its bytes, and four legal pictures came to more than a message may weigh.
  const sent = await page.evaluate(() => ({
    toLookAt: globalThis.branchAttachments().map((one) => one.name),
    carried: globalThis.branchAttachedFiles().map((one) => one.name),
  }));
  assert.deepEqual(sent.toLookAt, [], "the picture is not sent a second time to be looked at");
  assert.deepEqual(sent.carried, ["dot.png"], "it travels once, with the message");
  assert.deepEqual(errors, []);
});

test("a temporary conversation's file opens from its own card, like any other", async (t) => {
  const { app, page, root, errors } = await windowWithBranch(t);
  const file = join(root, "dot.png");
  await writeFile(file, onePixelPng);

  // Started as temporary, so its files are kept in the temporary folder. Nothing the page sends says
  // which folder to read from — the conversation itself decides (src/attachments.ts).
  // Temporary is one of the controls the calm window keeps out of sight; a person who wants it has
  // the full window on, so the test asks for the same window rather than reaching past the page.
  // There it is chosen from the message box's + menu (DG-175), as a person chooses it.
  await page.evaluate(async () => {
    const { applyAppearance, currentAppearance } = await import("/appearance.js");
    applyAppearance({ ...currentAppearance(), showEverything: true });
  });
  await page.locator("#lx-plus").click();
  await page.locator("#lx-plus-menu").getByRole("menuitem", { name: /^Temporary/ }).click();
  await page.waitForFunction(() => document.getElementById("temporary-toggle").checked);
  await page.locator("#composer-media-file").setInputFiles(file);
  await page.locator("#composer-attachments").getByText("dot.png").waitFor({ timeout: 10000 });
  await page.locator("#prompt").fill("Keep this for now.");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator("[data-attachment]").first().waitFor({ timeout: 20000 });

  const sessionId = await page.locator("#conversation").getAttribute("data-session-id");
  assert.equal(app.store.sessionTemporary(sessionId), true, "this really is a temporary conversation");

  // The visible control, pressed as a person presses it.
  await page.locator("[data-attachment] button").first().click();
  const shown = page.locator("[data-attachment] img").first();
  await shown.waitFor({ timeout: 20000 });
  assert.match(await shown.getAttribute("src"), /^blob:/, "the bytes came back and are on the page");
  assert.deepEqual(errors, []);
});
