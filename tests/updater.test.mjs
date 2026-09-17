import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { Updater, compareVersions } from "../dist/desktop/updater.js";

const run = promisify(execFile);
const windows = process.platform === "win32";

async function releaseFixture(t, { tag = "v0.3.0", tamper = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-"));
  t.after(() => discardTemp(root));
  const source = join(root, "Branch Agent-win32-x64");
  await mkdir(join(source, "resources"), { recursive: true });
  await writeFile(join(source, "Branch Agent Test.exe"), "new executable");
  await writeFile(join(source, "resources", "app.txt"), "new resources");
  const archive = join(root, "Branch-Agent-windows-x64.zip");
  if (windows)
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -LiteralPath '${source}' -DestinationPath '${archive}' -Force`]);
  else await writeFile(archive, "not a real archive");
  const bytes = await readFile(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const server = createServer((req, res) => {
    if (req.url === "/repos/stabrea/Branch-Agent/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        tag_name: tag, name: `Branch Agent ${tag}`, body: "Notes", published_at: "2026-09-15T00:00:00Z",
        html_url: "https://github.com/stabrea/Branch-Agent/releases/tag/" + tag,
        assets: [
          { name: "Branch-Agent-windows-x64.zip", browser_download_url: `${origin()}/download/app.zip`, size: bytes.length },
          { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: `${origin()}/download/app.sha256`, size: 96 },
        ],
      }));
    }
    if (req.url === "/download/app.zip") { res.writeHead(200, { "content-length": bytes.length }); return res.end(bytes); }
    if (req.url === "/download/app.sha256") {
      res.writeHead(200);
      return res.end(`${tamper ? "0".repeat(64) : digest}  Branch-Agent-windows-x64.zip\n`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const fetchViaFixture = (url, init) => fetch(url.replace("https://api.github.com", origin()), init);
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent Test.exe"), "old executable");
  return { root, installDir, fetchViaFixture, digest };
}

test("version comparison handles tags, prefixes and uneven lengths", () => {
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
  assert.equal(compareVersions("0.2.0-beta", "0.2.0"), 0);
});

test("check reports availability against the current version", async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t);
  const newer = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
  const status = await newer.check();
  assert.equal(status.phase, "available");
  assert.equal(status.release.latestVersion, "0.3.0");
  assert.match(status.message, /0\.3\.0/);
  const current = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.3.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch2"), fetch: fetchViaFixture });
  assert.equal((await current.check()).phase, "current");
  const unsupported = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.1.0", installDir: null, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch3"), fetch: fetchViaFixture });
  assert.equal(unsupported.status.phase, "unsupported");
  await assert.rejects(unsupported.install(), /installed app only/);
});

test("install downloads, verifies, unpacks beside the install and writes the hand-over script", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t);
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
  const { script, stagedDir } = await updater.install();
  assert.equal(updater.status.phase, "ready");
  assert.equal(await readFile(join(stagedDir, "Branch Agent Test.exe"), "utf8"), "new executable");
  assert.equal(await readFile(join(stagedDir, "resources", "app.txt"), "utf8"), "new resources");
  assert.ok(!stagedDir.startsWith(installDir), "staging never lands inside the install");
  const text = await readFile(script, "utf8");
  assert.match(text, /robocopy\.exe ".*unpacked.*" ".*installed" \/MIR/);
  assert.match(text, /robocopy\.exe ".*installed" ".*installed\.previous" \/MIR/, "previous version is kept");
  assert.match(text, /:restore[\s\S]*robocopy\.exe ".*installed\.previous" ".*installed" \/MIR/, "rollback path exists");
  assert.match(text, /start "" ".*installed\\Branch Agent Test\.exe"/);
  assert.match(text, /tasklist\.exe \/FI "PID eq %PID%" \/NH \/FO CSV/);
  assert.match(text, /%SystemRoot%\\System32\\find\.exe \/I "Branch Agent Test\.exe"/, "detects the running app by CSV listing with the system find");
  assert.match(text, /:drain[\s\S]*DRAIN% lss 15/, "waits for helper processes to exit");
  assert.match(text, /:wait[\s\S]*WAITED% lss 60[\s\S]*taskkill\.exe \/PID %PID% \/T \/F/, "ends the app itself if it does not close within the wait");
  assert.match(text, /app closed >>/, "logs when the app is gone");
  assert.match(text, /:copy[\s\S]*TRIES% lss 3/, "retries the copy before rolling back");
  assert.ok(!/\btimeout \/t/.test(text), "no timeout command; it fails without a console");
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "old executable", "install untouched until the script runs");
  await run("cmd.exe", ["/d", "/c", script, "999999", "stay"]).catch(() => undefined);
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "new executable");
  assert.ok(await stat(join(installDir, "resources", "app.txt")));
  assert.equal(await readFile(join(installDir + ".previous", "Branch Agent Test.exe"), "utf8"), "old executable", "previous version kept beside the install");
  assert.match(await readFile(join(root, "scratch", "apply-update.log"), "utf8"), /copying new version, attempt 1/, "log kept for diagnosis");
});

test("a checksum mismatch refuses to install", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t, { tamper: true });
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
  await assert.rejects(updater.install(), /did not match the published checksum/);
  assert.equal(updater.status.phase, "error");
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "old executable");
});
