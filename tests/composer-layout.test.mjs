import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-composer-layout-"));
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

function getVisibleChildren(containerEl) {
  const cs = (el) => getComputedStyle(el);
  const children = Array.from(containerEl.children).filter((el) => {
    const style = cs(el);
    return (
      el.offsetParent !== null &&
      !el.hidden &&
      style.display !== "none" &&
      style.position !== "absolute" &&
      style.position !== "fixed" &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0
    );
  });
  return children;
}

function groupChildrenByRow(children) {
  const rows = [];
  for (const child of children) {
    const rect = child.getBoundingClientRect();
    const top = Math.round(rect.top);
    const bottom = Math.round(rect.bottom);

    let foundRow = false;
    for (const row of rows) {
      const rowTop = row[0].top;
      const rowBottom = row[0].bottom;
      // Check if this child's vertical span overlaps with the row's span
      if (!(bottom < rowTop || top > rowBottom)) {
        row.push({ el: child, top, bottom });
        foundRow = true;
        break;
      }
    }
    if (!foundRow) {
      rows.push([{ el: child, top, bottom }]);
    }
  }
  return rows;
}

test("composer layout at 1440×950: single row, ~48px height", async (t) => {
  const { page } = await fixture(t);

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    if (!composer) return { error: "No composer found" };

    function getVisibleChildren(containerEl) {
      const cs = (el) => getComputedStyle(el);
      const children = Array.from(containerEl.children).filter((el) => {
        const style = cs(el);
        return (
          el.offsetParent !== null &&
          !el.hidden &&
          style.display !== "none" &&
          style.position !== "absolute" &&
          style.position !== "fixed" &&
          el.offsetWidth > 0 &&
          el.offsetHeight > 0
        );
      });
      return children;
    }

    function groupChildrenByRow(children) {
      const rows = [];
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const top = Math.round(rect.top);
        const bottom = Math.round(rect.bottom);

        let foundRow = false;
        for (const row of rows) {
          const rowTop = row[0].top;
          const rowBottom = row[0].bottom;
          if (!(bottom < rowTop || top > rowBottom)) {
            row.push({ top, bottom, id: child.id || child.className });
            foundRow = true;
            break;
          }
        }
        if (!foundRow) {
          rows.push([{ top, bottom, id: child.id || child.className }]);
        }
      }
      return rows;
    }

    const children = getVisibleChildren(composer);
    const rows = groupChildrenByRow(children);
    const composerRect = composer.getBoundingClientRect();

    return {
      composerHeight: Math.round(composerRect.height),
      visibleChildCount: children.length,
      rowCount: rows.length,
      rows: rows.map((row, i) => ({
        rowNumber: i,
        childCount: row.length,
        topPosition: row[0].top,
        children: row.map(c => c.id)
      }))
    };
  });

  console.log(`Composer at 1440×950:`);
  console.log(`  Height: ${result.composerHeight}px (target ~48px)`);
  console.log(`  Visible children: ${result.visibleChildCount}`);
  console.log(`  Row count: ${result.rowCount} (target 1)`);
  for (const row of result.rows) {
    console.log(`    Row ${row.rowNumber}: top=${row.topPosition}, children=${row.childCount} (${row.children.join(", ")})`);
  }

  assert.equal(
    result.rowCount,
    1,
    `Expected composer children on 1 row, found ${result.rowCount}`
  );

  assert(
    result.composerHeight <= 60,
    `Expected composer height ~48px, got ${result.composerHeight}px (tolerance ±12px)`
  );
});

test("composer layout at 1024×700: single row, ~48px height", async (t) => {
  const { page } = await fixture(t);

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    if (!composer) return { error: "No composer found" };

    function getVisibleChildren(containerEl) {
      const cs = (el) => getComputedStyle(el);
      return Array.from(containerEl.children).filter((el) => {
        const style = cs(el);
        return (
          el.offsetParent !== null &&
          !el.hidden &&
          style.display !== "none" &&
          style.position !== "absolute" &&
          style.position !== "fixed" &&
          el.offsetWidth > 0 &&
          el.offsetHeight > 0
        );
      });
    }

    function groupChildrenByRow(children) {
      const rows = [];
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const top = Math.round(rect.top);
        const bottom = Math.round(rect.bottom);

        let foundRow = false;
        for (const row of rows) {
          const rowTop = row[0].top;
          const rowBottom = row[0].bottom;
          if (!(bottom < rowTop || top > rowBottom)) {
            row.push({ top });
            foundRow = true;
            break;
          }
        }
        if (!foundRow) {
          rows.push([{ top }]);
        }
      }
      return rows;
    }

    const children = getVisibleChildren(composer);
    const rows = groupChildrenByRow(children);
    const composerRect = composer.getBoundingClientRect();

    return {
      composerHeight: Math.round(composerRect.height),
      rowCount: rows.length
    };
  });

  console.log(`Composer at 1024×700: height=${result.composerHeight}px, rows=${result.rowCount}`);

  assert.equal(
    result.rowCount,
    1,
    `Expected composer children on 1 row, found ${result.rowCount}`
  );

  assert(
    result.composerHeight <= 60,
    `Expected composer height ~48px, got ${result.composerHeight}px`
  );
});

test("composer layout at 390×844: single row, ~48px height", async (t) => {
  const { page } = await fixture(t);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    if (!composer) return { error: "No composer found" };

    function getVisibleChildren(containerEl) {
      const cs = (el) => getComputedStyle(el);
      return Array.from(containerEl.children).filter((el) => {
        const style = cs(el);
        return (
          el.offsetParent !== null &&
          !el.hidden &&
          style.display !== "none" &&
          style.position !== "absolute" &&
          style.position !== "fixed" &&
          el.offsetWidth > 0 &&
          el.offsetHeight > 0
        );
      });
    }

    function groupChildrenByRow(children) {
      const rows = [];
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const top = Math.round(rect.top);
        const bottom = Math.round(rect.bottom);

        let foundRow = false;
        for (const row of rows) {
          const rowTop = row[0].top;
          const rowBottom = row[0].bottom;
          if (!(bottom < rowTop || top > rowBottom)) {
            row.push({ top });
            foundRow = true;
            break;
          }
        }
        if (!foundRow) {
          rows.push([{ top }]);
        }
      }
      return rows;
    }

    const children = getVisibleChildren(composer);
    const rows = groupChildrenByRow(children);
    const composerRect = composer.getBoundingClientRect();

    return {
      composerHeight: Math.round(composerRect.height),
      rowCount: rows.length
    };
  });

  console.log(`Composer at 390×844: height=${result.composerHeight}px, rows=${result.rowCount}`);

  assert.equal(
    result.rowCount,
    1,
    `Expected composer children on 1 row, found ${result.rowCount}`
  );

  assert(
    result.composerHeight <= 60,
    `Expected composer height ~48px, got ${result.composerHeight}px`
  );
});
