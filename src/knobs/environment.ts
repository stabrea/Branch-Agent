import { findLeaks } from "../leak-guard.js";

/**
 * R17-S10: environment variables the owner hands to commands, beyond the built-in safe list.
 *
 * This is the owner's decision alone, and it is never allowed to carry a secret: a name that says it
 * holds a key, a token, a password or a sign-in is refused when it is saved and again when a command
 * starts, and a value that looks like a key is left out even under an innocent name. Names that
 * change how a program loads its code (LD_PRELOAD, DYLD_*, NODE_OPTIONS and the like) are refused
 * too, because they would let a command run something other than what was approved.
 */
const secretWords = /(KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT|SIGN|SALT|DSN|OTP|BEARER|CONNECTION|DATABASE_URL|WEBHOOK)/i;
const loaderNames = /^(LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|PYTHONPATH$|PYTHONSTARTUP$|PERL5LIB$|PERL5OPT$|RUBYOPT$|RUBYLIB$|BASH_ENV$|ENV$|PROMPT_COMMAND$|PS4$|IFS$|SHELLOPTS$|BASHOPTS$|GIT_|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|ELECTRON_)/i;

/** Why a name may not be passed through, in plain words, or null when it may. */
export function refusedEnvironmentName(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return `"${name.slice(0, 64)}" is not a variable name.`;
  if (secretWords.test(name)) return `${name} looks like it holds a key, password or sign-in, so it is never handed to commands.`;
  if (loaderNames.test(name)) return `${name} changes which code a program loads, so it is never handed to commands.`;
  return null;
}

/** The extra variables for one command: allowed names only, present on this computer, with no key-like value. */
export function passedEnvironment(names: readonly string[], source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    if (refusedEnvironmentName(name)) continue;
    const value = source[name];
    if (typeof value !== "string" || !value || value.includes("\0")) continue;
    if (findLeaks(`${name}=${value}`).length || findLeaks(value).length) continue;
    result[name] = value;
  }
  return result;
}
