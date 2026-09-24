import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";

/**
 * How to start an installed program without a shell. On Windows a program installed with npm (Codex, Gemini CLI,
 * Copilot) is a `.cmd` launcher, which Node cannot start with `shell: false`; going through `cmd.exe` instead would
 * put every argument through cmd's quoting. npm's launcher only ever runs `node <its script>`, so the script is read
 * out of it and started with Node directly. A real `.exe` (Claude Code's own installer) is started as it is.
 * Elsewhere, and for a name with no program behind it, the call is left as asked, so "not installed" is still said.
 */
export interface StartCall { command: string; args: string[] }

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * The launcher's script, as npm writes it: `"%dp0%\node_modules\...\bin\x.js"`, beside the launcher. The launcher is
 * a Windows file, so the script's folders are read the Windows way (`path.win32`), whatever system this is, and then
 * put under the launcher's own folder as this computer writes it. On Windows that is the address it always was; a
 * plain join elsewhere would keep the backslashes inside one file name, which is never the script.
 */
export function npmScriptOf(launcher: string): string | null {
  let text: string;
  try { text = readFileSync(launcher, "utf8"); } catch { return null; }
  const match = /"%dp0%\\([^"%]+\.(?:c|m)?js)"/i.exec(text);
  return match ? join(dirname(launcher), ...win32.normalize(match[1]!).split(win32.sep)) : null;
}

export function startCall(command: string, args: string[], env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): StartCall {
  if (platform !== "win32" || /[\\/]/.test(command) || /\.(exe|com)$/i.test(command)) return { command, args };
  const folders = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const folder of folders) {
    if (isFile(join(folder, `${command}.exe`))) return { command: join(folder, `${command}.exe`), args };
    const launcher = join(folder, `${command}.cmd`);
    if (!isFile(launcher)) continue;
    const script = npmScriptOf(launcher);
    if (!script || !existsSync(script)) continue;
    const bundled = join(folder, "node.exe");
    return { command: isFile(bundled) ? bundled : "node", args: [script, ...args] };
  }
  return { command, args };
}
