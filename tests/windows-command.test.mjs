import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { startCall } from "../dist/windows-command.js";

/**
 * On Windows an npm-installed program (Codex, Gemini CLI, Copilot) is a .cmd launcher, which Node cannot start
 * without a shell. Branch reads the script out of npm's launcher and starts it with Node itself, so no argument goes
 * through cmd's quoting. Measured on the owner's Legion: `codex` was reported as not installed until this.
 */

const launcher = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-windows-command-"));
  t.after(() => discardTemp(root));
  return root;
}

test("an npm launcher on Windows is started as Node running its script, with the arguments untouched", async (t) => {
  const bin = await folder(t);
  await mkdir(join(bin, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  await writeFile(join(bin, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  await writeFile(join(bin, "codex.cmd"), launcher);
  const call = startCall("codex", ["exec", "--json", "Bash(node --test:*)"], { PATH: bin }, "win32");
  assert.equal(call.command, "node");
  assert.deepEqual(call.args, [join(bin, "node_modules", "@openai", "codex", "bin", "codex.js"), "exec", "--json", "Bash(node --test:*)"]);
});

test("a real program file is started as it is, and a name with nothing behind it is left for 'not installed'", async (t) => {
  const bin = await folder(t);
  await writeFile(join(bin, "claude.exe"), "");
  assert.deepEqual(startCall("claude", ["-p"], { PATH: bin }, "win32"), { command: join(bin, "claude.exe"), args: ["-p"] });
  assert.deepEqual(startCall("nothing-here", ["x"], { PATH: bin }, "win32"), { command: "nothing-here", args: ["x"] });
});

test("away from Windows the call is left exactly as asked", () => {
  assert.deepEqual(startCall("codex", ["exec"], { PATH: "/usr/bin" }, "linux"), { command: "codex", args: ["exec"] });
});
