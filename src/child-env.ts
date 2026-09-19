/**
 * The environment a program Branch starts on the owner's behalf gets: a short allowlist of what a
 * program needs to find itself, its home, its language and a temporary folder — and nothing else.
 * Branch's own environment can hold model-service keys and vault variables; none of that is passed
 * on. Used by the voice, speech and media programs (ffmpeg, yt-dlp, the reading-aloud program);
 * commands and scripts build theirs from their own allowlists (src/integrations/shell-config.ts,
 * src/sandbox-backends.ts).
 */
const allowed = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM",
  "TMPDIR", "TMP", "TEMP",
  // Linux: finding the sound server and the desktop session a reading-aloud program talks to.
  "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS", "PULSE_SERVER",
  // Windows: what its own programs need to start at all.
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "PSMODULEPATH",
]);
const allowedName = (name: string): boolean => allowed.has(name.toUpperCase()) || /^LC_[A-Z]+$/.test(name);

/** Only the allowlisted variables of `source`, with their original spelling kept. */
export function cleanChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined && allowedName(name)) out[name] = value;
  return out;
}

/**
 * Inside the desktop app `process.execPath` is the app itself, not Node. Started to run a script
 * without this variable it opens a second copy of the app instead. Every place that starts this
 * program to run JavaScript adds what this returns to the child's environment; for any other
 * program, and outside the desktop app, it adds nothing.
 */
export function runAsNode(executable: string): Record<string, string> {
  return process.versions.electron && executable === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}
