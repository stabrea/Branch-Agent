import { findLeaks } from "../leak-guard.js";

/**
 * R17-S10: environment variables the owner hands to commands, beyond the built-in safe list.
 *
 * This is the owner's decision alone, and it is never allowed to carry a secret: a name that says it
 * holds a key, a token, a password or a sign-in is refused when it is saved and again when a command
 * starts, and a value that looks like a key is left out even under an innocent name. Names that
 * change which code a program loads, where it sends its traffic or which settings file it reads are
 * refused too, because they would let a command run or reach something other than what was approved.
 * Every check ignores letter case, as Windows does.
 */
const secretWords = /(KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT|SIGN|SALT|DSN|OTP|BEARER|CONNECTION|DATABASE_URL|WEBHOOK)/i;

/** Families whose every member points at code, a service, sign-in details or a settings file. */
const loaderFamilies = new RegExp("^(" + [
  "LD_", "DYLD_", "GIT_", "NODE_", "NPM_", "YARN_", "PNPM_", "BUN_", "DENO_", "PYTHON", "PIP_", "UV_", "CONDA",
  "PERL", "RUBY", "GEM_", "BUNDLE_", "_?JAVA", "JDK_", "CLASSPATH", "MAVEN", "GRADLE", "CARGO_", "RUSTC", "RUSTUP",
  "DOTNET_", "COR_", "CORECLR_", "COMPLUS_", "ELECTRON_", "AWS_", "AZURE_", "GOOGLE_", "GCLOUD_", "CLOUDSDK_",
  "OPENAI_", "ANTHROPIC_", "BW_", "BWS_", "OP_", "VAULT_", "GH_", "GITHUB_", "DOCKER_", "KUBE", "SSH_", "SUDO_",
  "BASH", "ZSH", "ZDOTDIR", "LESS", "OPENSSL_", "SSL_", "CURL_", "WGET", "REQUESTS_", "GCONV_", "XDG_", "HG",
  "GO(?:FLAGS|PROXY|ROOT|TOOLCHAIN|ENV|PRIVATE|NOPROXY|NOSUMDB|INSECURE|EXPERIMENT|BIN|CACHE|MODCACHE)$",
].join("|") + ")", "i");

/** Single names that start programs, move the home or search path, or steer a shell. */
const loaderNames = /^(ENV|IFS|PS4|PROMPT_COMMAND|SHELLOPTS|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|SHELL|EDITOR|VISUAL|PAGER|MANPAGER|BROWSER|DISPLAY|XAUTHORITY|HOSTALIASES|RES_OPTIONS|LOCALDOMAIN|LOCPATH|NLSPATH|TERMINFO|INPUTRC|HISTFILE)$/i;

/** Words anywhere in a name that mean "a place to load from" or "a place to send to". */
const loaderParts = /(PATH|PROXY|_URL$|_URI$|_HOST$|_ENDPOINT|_OPTIONS$|_OPTS$|_FLAGS$|_CONFIG|_CONF$|RC$|_FILE$|_DIR$|_HOME$|_ROOT$|PRELOAD|_LIBRARY|_INCLUDE|_SOCK|_COMMAND$|_EXEC|WRAPPER|STARTUP|_HOOK|PROFILER|PLUGIN|REGISTRY|MIRROR|ASKPASS|_CA_|CA_BUNDLE)/i;

/** Why a name may not be passed through, in plain words, or null when it may. */
export function refusedEnvironmentName(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return `"${name.slice(0, 64)}" is not a variable name.`;
  if (secretWords.test(name)) return `${name} looks like it holds a key, password or sign-in, so it is never handed to commands.`;
  if (loaderFamilies.test(name) || loaderNames.test(name) || loaderParts.test(name))
    return `${name} changes which code a program loads or where it connects, so it is never handed to commands.`;
  return null;
}

/** A variable's value by name: exact on macOS and Linux, in any letter case on Windows. */
function valueOf(source: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return source[name];
  const upper = name.toUpperCase();
  return Object.entries(source).find(([key]) => key.toUpperCase() === upper)?.[1];
}

/** The extra variables for one command: allowed names only, present on this computer, with no key-like value. */
export function passedEnvironment(names: readonly string[], source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of names) {
    const same = platform === "win32" ? name.toUpperCase() : name;
    if (seen.has(same) || refusedEnvironmentName(name)) continue;
    seen.add(same);
    const value = valueOf(source, name, platform);
    if (typeof value !== "string" || !value || value.includes("\0")) continue;
    // The guard's built-in list, never the owner's exceptions: those only change what the model sees.
    if (findLeaks(`${name}=${value}`).length || findLeaks(value).length) continue;
    result[name] = value;
  }
  return result;
}

/** The command's environment with the owner's extras added; a name the launch already sets, in any case, stays as it was. */
export function withPassedEnvironment(base: NodeJS.ProcessEnv, passed: Record<string, string>): NodeJS.ProcessEnv {
  const taken = new Set(Object.keys(base).map((key) => key.toUpperCase()));
  const extra = Object.entries(passed).filter(([name]) => !taken.has(name.toUpperCase()));
  return { ...base, ...Object.fromEntries(extra) };
}
