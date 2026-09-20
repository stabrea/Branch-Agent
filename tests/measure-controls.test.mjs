import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openSettings, showEverything } from "./places.mjs";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-controls-measure-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await showEverything(page);
  return { page, server };
}

test("measure controls in Settings window only", async (t) => {
  const { page } = await fixture(t);

  await openSettings(page);

  const result = await page.evaluate(() => {
    const root = document.querySelector("#settings-window");
    if (!root) return null;

    const rows = [...root.querySelectorAll("select, input[type=checkbox]:not([role=switch]), input[type=radio], [role=switch]")]
      .map(n => ({
        page: n.closest(".lx-page")?.dataset.page ?? "(none)",
        kind: n.tagName === "SELECT" ? "select"
            : n.getAttribute("role") === "switch" ? "switch"
            : n.type
      }));

    // Group by page and kind
    const byPage = {};
    const byKind = { select: 0, checkbox: 0, radio: 0, switch: 0 };

    rows.forEach(row => {
      if (!byPage[row.page]) byPage[row.page] = { select: 0, checkbox: 0, radio: 0, switch: 0 };
      byPage[row.page][row.kind]++;
      byKind[row.kind]++;
    });

    return { byPage, byKind, totalRows: rows.length };
  });

  console.log("\n=== CONTROL COUNTS (SETTINGS WINDOW ONLY) ===");
  console.log("By page:");
  for (const [page, counts] of Object.entries(result.byPage)) {
    console.log(`  ${page || "(none)"}: select=${counts.select} checkbox=${counts.checkbox} radio=${counts.radio} switch=${counts.switch}`);
  }
  console.log("\nTotals:");
  console.log(`  Select: ${result.byKind.select}`);
  console.log(`  Bare checkbox: ${result.byKind.checkbox}`);
  console.log(`  Radio: ${result.byKind.radio}`);
  console.log(`  Switch (role=switch): ${result.byKind.switch}`);
  console.log(`  Total: ${result.totalRows}`);

  // Keep these counts for later reference
  assert(result, "Settings window not found");
});
