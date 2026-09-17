/**
 * r17-i (R17-082): the container image, the Nix flake and the Termux script, checked as text. Nothing
 * is built: no docker, no nix, no npm install. The Termux script is only syntax-checked and run up to
 * its first refusal, which comes before it does anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  containerFiles, dockerfilePath, dockerfileText, dockerignoreText, flakeText, nodeMajor, termuxScript, termuxScriptPath,
} from "../dist/install/container-files.js";
import { launcherMarker } from "../dist/install/unix-install.js";

const ROOT = join(import.meta.dirname, "..");

test("the files in the repository are exactly what src/install/container-files.ts writes", async () => {
  for (const [path, text] of Object.entries(containerFiles()))
    assert.equal(await readFile(join(ROOT, path), "utf8"), text, `${path} was edited by hand or not regenerated`);
  assert.ok(((await stat(join(ROOT, termuxScriptPath))).mode & 0o111) !== 0, "the Termux script can be run");
});

test("the image builds without scripts or browsers, runs without rights, and keeps no secret", () => {
  const text = dockerfileText();
  assert.match(text, new RegExp(`^FROM node:${nodeMajor}-bookworm-slim AS build$`, "m"));
  assert.match(text, /npm ci --no-audit --no-fund --ignore-scripts/);
  assert.match(text, /npm prune --omit=dev --ignore-scripts/);
  assert.match(text, /^USER branch$/m);
  assert.ok(text.indexOf("USER branch") > text.lastIndexOf("RUN "), "nothing runs as root after the user is set");
  assert.match(text, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/);
  assert.match(text, /^ENTRYPOINT \["node", "dist\/cli\.js"\]$/m);
  assert.doesNotMatch(text, /(KEY|TOKEN|SECRET|PASSWORD)=/i);
  assert.doesNotMatch(text, /curl|wget|\| *sh/);
  assert.doesNotMatch(text, /COPY \. /, "only named folders are copied");
  assert.doesNotMatch(text, /0\.0\.0\.0/, "the engine keeps listening on 127.0.0.1 only");
  for (const kept of [".git", ".env", ".env.*", ".branch", "node_modules", "workspace"])
    assert.ok(dockerignoreText().split("\n").includes(kept), `${kept} stays out of the build`);
  assert.equal(dockerfilePath, "packaging/docker/Dockerfile");
});

test("the flake reads the lock file, keeps no hash to go stale, and installs the branch command", () => {
  const text = flakeText();
  assert.match(text, /npmDeps = pkgs\.importNpmLock \{ npmRoot = \.\/\.; \};/);
  assert.match(text, /npmConfigHook = pkgs\.importNpmLock\.npmConfigHook;/);
  assert.doesNotMatch(text, /fakeHash|sha256-|npmDepsHash/);
  assert.match(text, new RegExp(`pkgs\\.nodejs_${nodeMajor}`));
  assert.match(text, /makeWrapper .*\/bin\/node \$out\/bin\/branch --add-flags \$out\/lib\/branch-agent\/dist\/cli\.js/);
  assert.match(text, /npmFlags = \[ "--ignore-scripts" \];/);
  for (const system of ["x86_64-linux", "aarch64-linux", "x86_64-darwin", "aarch64-darwin"]) assert.ok(text.includes(`"${system}"`));
  const opens = (text.match(/\{/g) ?? []).length, closes = (text.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, "braces balance");
});

test("the Termux script checks the download before installing and refuses anywhere but Termux", () => {
  const text = termuxScript();
  assert.match(text, /sha256sum "\$PACKAGE"/);
  assert.ok(text.indexOf("sha256sum") < text.indexOf("npm install -g"), "checked before installed");
  assert.match(text, /npm install -g --omit=dev --ignore-scripts/);
  assert.doesNotMatch(text, /curl|wget|sudo/);
  assert.equal(text.includes(launcherMarker), false, "npm writes the command; bucket 22's launcher marker is not claimed");
  const script = join(ROOT, termuxScriptPath);
  assert.equal(spawnSync("sh", ["-n", script]).status, 0, "the script parses");
  const elsewhere = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin", PREFIX: "/usr/local" }, encoding: "utf8" });
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /only for Termux|for Termux on Android/);
  const noFile = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin", PREFIX: "/data/data/com.termux/files/usr" }, encoding: "utf8" });
  assert.equal(noFile.status, 1);
  assert.match(noFile.stderr, /Name the branch-agent/);
  const wrong = spawnSync("sh", [script, "/etc/passwd"], { env: { PATH: "/usr/bin:/bin", PREFIX: "/data/data/com.termux/files/usr" }, encoding: "utf8" });
  assert.match(wrong.stderr, /not a branch-agent \.tgz/);
});
