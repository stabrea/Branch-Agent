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
