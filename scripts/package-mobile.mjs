/**
 * Builds the phone apps into release/mobile/, ready to install, and publishes nothing.
 *
 *   node scripts/package-mobile.mjs [--android] [--ios] [--skip-web]
 *
 * Android: Branch-Agent-android.apk (signed with this computer's own key in ~/.branch-mobile-keystore,
 * whose password lives in the macOS Keychain) and Branch-Agent-android.aab for the Play Store later.
 * iOS (macOS only): Branch-Agent-ios.ipa, unsigned, for Sideloadly or AltStore to sign with the owner's
 * Apple ID, and Branch-Agent-ios-simulator.zip for the iOS Simulator. Every file gets a .sha256 beside it.
 * Each step that runs a program takes the runner as a parameter, so tests/mobile-build.test.mjs can
 * check the exact commands without running them.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MOBILE = join(repo, "apps", "mobile");
/** Where the finished files go; BRANCH_MOBILE_OUT keeps them outside the checkout (a build drive). */
export const OUT = process.env.BRANCH_MOBILE_OUT ?? join(repo, "release", "mobile");
export const KEYCHAIN = { service: "branch-mobile-keystore", account: "branch-agent" };
export const KEY_ALIAS = "branch-agent";

/** Runs a program with an argument list (never a shell string). `input` goes to its stdin. */
export function run(file, args, { cwd, env, input, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { err += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${basename(file)} stopped (${code}): ${err.slice(-400)}`))));
    child.stdin.end(input ?? "");
  });
}

/** Where the Android SDK is, from the environment or apps/mobile/android/local.properties, or null. */
export async function androidSdk(env = process.env, read = readFile) {
  for (const value of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) if (value && existsSync(join(value, "platforms"))) return value;
  const local = await read(join(MOBILE, "android", "local.properties"), "utf8").catch(() => "");
  const match = /^sdk\.dir=(.+)$/m.exec(local);
  return match && existsSync(join(match[1].trim(), "platforms")) ? match[1].trim() : null;
}

export async function sha256File(path) {
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  await writeFile(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
  return digest;
}

/**
 * The release key: made once on this computer, kept out of the repository, its password generated
 * and handed to the Keychain on stdin (never on a command line, never printed).
 */
export async function ensureKeystore(runner = run, home = homedir(), exists = existsSync) {
  const folder = join(home, ".branch-mobile-keystore");
  const store = join(folder, "branch-agent.jks");
  if (exists(store)) return { store, password: (await runner("security", ["find-generic-password", "-a", KEYCHAIN.account, "-s", KEYCHAIN.service, "-w"], { quiet: true })).trim() };
  const password = randomBytes(24).toString("base64url");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await runner("security", ["-i"], { quiet: true, input: `add-generic-password -U -a ${KEYCHAIN.account} -s ${KEYCHAIN.service} -l "Branch Agent Android signing key" -w "${password}"\n` });
  await runner("keytool", ["-genkeypair", "-keystore", store, "-storetype", "PKCS12", "-alias", KEY_ALIAS, "-keyalg", "RSA", "-keysize", "4096",
    "-validity", "10000", "-dname", "CN=Branch Agent, O=KeepOak", "-storepass:env", "BRANCH_ANDROID_KEYSTORE_PASSWORD", "-keypass:env", "BRANCH_ANDROID_KEYSTORE_PASSWORD"],
  { quiet: true, env: { ...process.env, BRANCH_ANDROID_KEYSTORE_PASSWORD: password } });
  await chmod(store, 0o600);
  return { store, password };
}

/** Puts the page and the native files together, then copies them into both native projects. */
export async function prepare(runner = run) {
  await runner(process.execPath, [join(MOBILE, "scripts", "build-web.mjs")], { cwd: MOBILE });
  await runner(process.execPath, [join(MOBILE, "scripts", "native-files.mjs")], { cwd: MOBILE });
  await runner(process.execPath, [join(MOBILE, "scripts", "icons.mjs")], { cwd: MOBILE });
  const capacitor = join(MOBILE, "node_modules", "@capacitor", "cli", "bin", "capacitor");
  await runner(process.execPath, [capacitor, "sync"], { cwd: MOBILE });
  // cap sync copies its own config beside the page; ours is made above and copied again here.
  await runner(process.execPath, [join(MOBILE, "scripts", "native-files.mjs")], { cwd: MOBILE });
}

export async function buildAndroid(sdk, key, runner = run) {
  const project = join(MOBILE, "android");
  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
  if (key?.password) Object.assign(env, { BRANCH_ANDROID_KEYSTORE: key.store, BRANCH_ANDROID_KEYSTORE_PASSWORD: key.password, BRANCH_ANDROID_KEY_ALIAS: KEY_ALIAS });
  const gradle = join(project, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  await runner(gradle, ["--no-daemon", "assembleRelease", "bundleRelease"], { cwd: project, env });
  const built = env.BRANCH_GRADLE_BUILD_DIR ? join(env.BRANCH_GRADLE_BUILD_DIR, "app") : join(project, "app", "build");
  const apk = join(built, "outputs", "apk", "release", key ? "app-release.apk" : "app-release-unsigned.apk");
  const aab = join(built, "outputs", "bundle", "release", "app-release.aab");
  const outputs = [[apk, "Branch-Agent-android.apk"], [aab, "Branch-Agent-android.aab"]];
  for (const [from, to] of outputs) await copyFile(from, join(OUT, to));
  if (key) await runner(join(sdk, "build-tools", await buildTools(sdk), "apksigner"), ["verify", "--print-certs", join(OUT, "Branch-Agent-android.apk")], { quiet: true, env });
  return outputs.map(([, to]) => join(OUT, to));
}

async function buildTools(sdk) {
  const { readdir } = await import("node:fs/promises");
  const versions = (await readdir(join(sdk, "build-tools"))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error("No Android build tools are installed.");
  return versions.at(-1);
}

/**
 * The xcodebuild arguments for one SDK. A target build needs no installed simulator or device. Without
 * an iOS Simulator runtime Xcode cannot compile the asset catalog, so it is left out and the icons are
 * added afterwards (addIcons); the launch screen then falls back to the system's plain colour.
 */
export function xcodeArgs(sdk, work, withCatalog = true) {
  return ["-project", join(MOBILE, "ios", "App", "App.xcodeproj"), "-target", "App", "-configuration", "Release", "-sdk", sdk,
    `SYMROOT=${join(work, "build")}`, `OBJROOT=${join(work, "obj")}`, "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=",
    ...(withCatalog ? [] : ["EXCLUDED_SOURCE_FILE_NAMES=Assets.xcassets"]), "build"];
}

/** True when an iOS Simulator runtime is installed (Xcode needs one to compile asset catalogs). */
export async function iosRuntimeInstalled(runner = run) {
  const listing = JSON.parse(await runner("xcrun", ["simctl", "list", "runtimes", "--json"], { quiet: true }).catch(() => "{}"));
  return (listing.runtimes ?? []).some((runtime) => runtime.platform === "iOS" && runtime.isAvailable);
}

/** The app icons alone (actool can make those without a runtime), merged into the built app. */
export async function addIcons(app, work, runner = run) {
  const out = join(work, "icons");
  await mkdir(out, { recursive: true });
  const plist = join(out, "partial.plist");
  await runner("xcrun", ["actool", join(MOBILE, "ios", "App", "App", "Assets.xcassets"), "--compile", out, "--platform", "iphoneos",
    "--minimum-deployment-target", "15.0", "--app-icon", "AppIcon", "--target-device", "iphone", "--target-device", "ipad",
    "--output-partial-info-plist", plist, "--output-format", "human-readable-text"], { quiet: true })
    // It still refuses the colour sets without a runtime, after writing the icons; those are all we need here.
    .catch((error) => { if (!existsSync(join(out, "AppIcon60x60@2x.png"))) throw error; });
  for (const name of ["AppIcon60x60@2x.png", "AppIcon76x76@2x~ipad.png"]) await copyFile(join(out, name), join(app, name));
  await runner("/usr/libexec/PlistBuddy", ["-c", `Merge ${plist}`, join(app, "Info.plist")], { quiet: true });
}

export async function buildIos(work, runner = run) {
  const ios = join(MOBILE, "ios", "App");
  const withCatalog = await iosRuntimeInstalled(runner);
  await runner("xcodebuild", xcodeArgs("iphoneos", work, withCatalog), { cwd: ios });
  const app = join(work, "build", "Release-iphoneos", "App.app");
  if (!withCatalog) await addIcons(app, work, runner);
  // A plain local signature carrying the entitlements (the shared app group), so the tool that
  // signs it with the owner's Apple ID knows the app and its share extension belong together.
  await runner("codesign", ["--force", "--sign", "-", "--entitlements", join(ios, "ShareExtension", "ShareExtension.entitlements"), join(app, "PlugIns", "ShareExtension.appex")]);
  await runner("codesign", ["--force", "--sign", "-", "--entitlements", join(ios, "App", "App.entitlements"), app]);
  const payload = join(work, "ipa");
  await rm(payload, { recursive: true, force: true });
  await mkdir(join(payload, "Payload"), { recursive: true });
  await runner("ditto", [app, join(payload, "Payload", "App.app")]);
  const ipa = join(OUT, "Branch-Agent-ios.ipa");
  await rm(ipa, { force: true });
  await runner("zip", ["-qry", ipa, "Payload"], { cwd: payload });
  await runner("xcodebuild", xcodeArgs("iphonesimulator", work, withCatalog), { cwd: ios });
  const simulator = join(OUT, "Branch-Agent-ios-simulator.zip");
  await rm(simulator, { force: true });
  await runner("ditto", ["-c", "-k", "--keepParent", join(work, "build", "Release-iphonesimulator", "App.app"), simulator]);
  return [ipa, simulator];
}

/** The signing key: from the environment (a CI secret), from this Mac's Keychain (never on CI), or none (unsigned). */
export async function releaseKey(env = process.env, platform = process.platform, make = ensureKeystore) {
  if (env.BRANCH_ANDROID_KEYSTORE && env.BRANCH_ANDROID_KEYSTORE_PASSWORD)
    return { store: env.BRANCH_ANDROID_KEYSTORE, password: env.BRANCH_ANDROID_KEYSTORE_PASSWORD };
  return platform === "darwin" && !env.CI ? make() : null;
}

async function main(argv) {
  const wantAndroid = !argv.includes("--ios"), wantIos = !argv.includes("--android");
  await mkdir(OUT, { recursive: true });
  if (!argv.includes("--skip-web")) await prepare();
  const made = [];
  const sdk = wantAndroid ? await androidSdk() : null;
  if (wantAndroid && !sdk) console.log("Android: skipped, no Android SDK found (set ANDROID_HOME).");
  if (sdk) made.push(...await buildAndroid(sdk, await releaseKey()));
  if (wantIos && process.platform !== "darwin") console.log("iOS: skipped, it builds on a Mac only.");
  if (wantIos && process.platform === "darwin") made.push(...await buildIos(join(process.env.BRANCH_MOBILE_WORK ?? join(repo, "build", "mobile-ios"))));
  for (const file of made) console.log(`${basename(file)}  ${await sha256File(file)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
