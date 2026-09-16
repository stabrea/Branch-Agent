// Self-check of a packaged build: launch a staged copy with its own home, open every section,
// screenshot each one, and collect browser console errors. Usage: node walkthrough.tmp.mjs <installDir> <outDir>
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [install, outDir] = process.argv.slice(2);
const home = join(outDir, "home"), port = 9411;
await rm(home, { recursive: true, force: true }); await mkdir(home, { recursive: true });
const child = spawn(join(install, "Branch Agent.exe"), [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", env: { ...process.env, BRANCH_DESKTOP_HOME: home, BRANCH_PROVIDER: "demo" } });
child.unref();
let browser;
for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await delay(1000); } }
if (!browser) { console.log("could not connect"); process.exit(1); }
const page = browser.contexts()[0].pages().find((p) => /127\.0\.0\.1/.test(p.url())) ?? browser.contexts()[0].pages()[0];
page.setDefaultTimeout(20000);
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.getByText("Connected", { exact: true }).waitFor();
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
const report = [];
const shot = async (name) => { const file = join(outDir, `${name}.png`); await page.screenshot({ path: file, fullPage: false }); report.push({ name, file, errorsSoFar: errors.length }); };
await shot("01-home");
const views = await page.$$eval(".nav[data-view]", (els) => els.map((e) => e.getAttribute("data-view")));
for (const view of views) {
  const button = page.locator(`.nav[data-view="${view}"]`).first();
  if (!(await button.isVisible().catch(() => false))) continue;
  await button.click(); await delay(700);
  await shot(`10-${view}`);
}
// Settings sub-areas that shipped recently: sharing, voice, provider dropdown
for (const id of ["mcp-card", "voice-settings-form", "voice-live-vad", "provider-preset", "documents", "usage"]) {
  const el = page.locator(`#${id}`).first();
  const present = await el.count();
  report.push({ check: id, present: present > 0, visible: present ? await el.isVisible().catch(() => false) : false });
}
await writeFile(join(outDir, "report.json"), JSON.stringify({ views, errors, report }, null, 2));
console.log("views:", views.join(", "));
console.log("console errors:", errors.length, errors.slice(0, 10));
console.log("checks:", JSON.stringify(report.filter((r) => r.check)));
try { await browser.close(); } catch {}
const staged = install.replace(/\//g, "\\\\");
execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${staged}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" });
process.exit(0);
