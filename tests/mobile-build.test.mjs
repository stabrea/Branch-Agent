// Building the phone apps (scripts/package-mobile.mjs): the exact commands, run through a fake so
// nothing is built or signed here, and one real Android build that runs only when an Android SDK is
// present and BRANCH_MOBILE_BUILD=1 is set (the mobile workflow sets it), and otherwise skips.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  KEYCHAIN, MOBILE, androidSdk, ensureKeystore, iosRuntimeInstalled, releaseKey, sha256File, xcodeArgs,
} from "../scripts/package-mobile.mjs";
import { brandProject, dropStoryboards } from "../apps/mobile/scripts/ios-project.mjs";
import { discardTemp } from "./temp-dir.mjs";

function fakeRunner(answers = {}) {
  const calls = [];
  const runner = async (file, args, options = {}) => {
    calls.push({ file, args, input: options.input, env: options.env });
    return answers[file] ?? "";
  };
  return { calls, runner };
}

test("a new signing key: its password goes to the Keychain on stdin and to keytool through the environment", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-mobile-key-"));
  t.after(() => discardTemp(home));
  const { calls, runner } = fakeRunner();
  await assert.rejects(ensureKeystore(runner, home, () => false), /ENOENT/, "keytool is faked, so there is no file to protect");
  const [keychain, keytool] = calls;
  assert.equal(keychain.file, "security");
  assert.deepEqual(keychain.args, ["-i"]);
  const password = /-w "([^"]+)"/.exec(keychain.input)[1];
  assert.ok(password.length >= 32);
  assert.match(keychain.input, new RegExp(`-a ${KEYCHAIN.account} -s ${KEYCHAIN.service}`));
  assert.equal(keytool.file, "keytool");
  assert.ok(keytool.args.includes("-storepass:env") && keytool.args.includes("-keypass:env"));
  assert.equal(keytool.env.BRANCH_ANDROID_KEYSTORE_PASSWORD, password);
  for (const call of calls) assert.equal(call.args.some((arg) => arg.includes(password)), false, `${call.file} would show the password`);
  assert.equal(keytool.args[keytool.args.indexOf("-keystore") + 1], join(home, ".branch-mobile-keystore", "branch-agent.jks"));
});

test("an existing key is read back from the Keychain, and a CI secret wins over it", async () => {
  const { calls, runner } = fakeRunner({ security: "s3cret\n" });
  const key = await ensureKeystore(runner, "/home/owner", () => true);
  assert.deepEqual(key, { store: "/home/owner/.branch-mobile-keystore/branch-agent.jks", password: "s3cret" });
  assert.deepEqual(calls[0].args, ["find-generic-password", "-a", KEYCHAIN.account, "-s", KEYCHAIN.service, "-w"]);
  const fromCi = await releaseKey({ BRANCH_ANDROID_KEYSTORE: "/ci/key.jks", BRANCH_ANDROID_KEYSTORE_PASSWORD: "x" }, "linux", () => assert.fail("no Keychain on CI"));
  assert.deepEqual(fromCi, { store: "/ci/key.jks", password: "x" });
  assert.equal(await releaseKey({}, "linux"), null, "without a key, Linux builds an unsigned APK");
  assert.equal(await releaseKey({ CI: "true" }, "darwin", () => assert.fail("CI never touches a Keychain")), null);
});

test("the iOS build is a target build, and leaves the asset catalog out only when no simulator runtime exists", async () => {
  const args = xcodeArgs("iphoneos", "/work");
  assert.deepEqual(args.slice(0, 9), ["-project", join(MOBILE, "ios", "App", "App.xcodeproj"), "-target", "App", "-configuration", "Release", "-sdk", "iphoneos", "SYMROOT=/work/build"]);
  assert.ok(args.includes("CODE_SIGNING_ALLOWED=NO"));
  assert.equal(args.includes("EXCLUDED_SOURCE_FILE_NAMES=Assets.xcassets"), false);
  assert.ok(xcodeArgs("iphonesimulator", "/work", false).includes("EXCLUDED_SOURCE_FILE_NAMES=Assets.xcassets"));
  const none = fakeRunner({ xcrun: JSON.stringify({ runtimes: [] }) });
  assert.equal(await iosRuntimeInstalled(none.runner), false);
  const some = fakeRunner({ xcrun: JSON.stringify({ runtimes: [{ platform: "iOS", isAvailable: true }] }) });
  assert.equal(await iosRuntimeInstalled(some.runner), true);
});

test("the Xcode project loses its storyboards and gains the share extension once", async () => {
  const text = await readFile(join(MOBILE, "ios", "App", "App.xcodeproj", "project.pbxproj"), "utf8");
  assert.equal(brandProject(text), text, "the committed project is already Branch's");
  assert.equal(/storyboard/i.test(text), false);
  assert.match(text, /productType = "com.apple.product-type.app-extension";/);
  assert.match(text, /PRODUCT_BUNDLE_IDENTIFIER = com.keepoak.branchagent.share;/);
  assert.equal(dropStoryboards("a\n\t\tX /* Main.storyboard in Resources */,\nb"), "a\nb");
});

test("a checksum file sits beside each output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-mobile-sum-"));
  t.after(() => discardTemp(dir));
  const file = join(dir, "Branch-Agent-android.apk");
  await (await import("node:fs/promises")).writeFile(file, "apk");
  const digest = await sha256File(file);
  assert.equal(await readFile(`${file}.sha256`, "utf8"), `${digest}  Branch-Agent-android.apk\n`);
  assert.equal(await androidSdk({ ANDROID_HOME: join(dir, "nowhere") }, async () => ""), null);
});

const sdk = await androidSdk();
test("the Android app builds", {
  skip: !sdk ? "no Android SDK on this machine" : process.env.BRANCH_MOBILE_BUILD !== "1" ? "set BRANCH_MOBILE_BUILD=1 to build" : false,
  timeout: 20 * 60_000,
}, async () => {
  if (!existsSync(join(MOBILE, "node_modules", "@capacitor", "android"))) assert.fail("run npm ci in apps/mobile first");
  const gradle = join(MOBILE, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
  await promisify(execFile)(gradle, ["--no-daemon", "assembleDebug"], {
    cwd: join(MOBILE, "android"), env: { ...process.env, ANDROID_HOME: sdk }, maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(existsSync(join(MOBILE, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk")));
});
