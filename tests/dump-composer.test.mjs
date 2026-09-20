import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-composer-dump-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });
  return { page };
}

test("dump composer DOM and parent structure", async (t) => {
  const { page } = await fixture(t);

  const dump = await page.evaluate(() => {
    const form = document.querySelector('#chat-form');
    const cs = (el) => getComputedStyle(el);

    return {
      formChildCount: form.children.length,
      directChildren: Array.from(form.children).map(el => `${el.tagName}#${el.id}${el.className ? '.' + el.className.replace(/ /g, '.') : ''}`),
      modelChipParent: document.querySelector('#model-chip')?.parentElement?.id,
      promptParent: document.querySelector('#prompt')?.parentElement?.id,
      formRect: form.getBoundingClientRect(),
      formComputedDisplay: cs(form).display
    };
  });

  console.log(JSON.stringify(dump, null, 2));
});
