import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import {
  assetNameFor, checksumLine, finishMac, includedInApp, signingRequired, needsAssetName, packagerOptions, parseArgs, windowsZipCommand, writeLinuxIcons, PACKAGE_ICON, macIconPlan,
} from "../scripts/package-desktop.mjs";
import { ICO_OUTPUT, ICO_SIZES, icoFrom, runningAsProgram } from "../scripts/prepare-icon.mjs";
import * as mac from "../scripts/package-macos.mjs";
import * as linux from "../scripts/package-linux.mjs";
import { builtOutputs, missingOutputs, pathInTarball } from "../scripts/pack-cli.mjs";
import { remoteName } from "../scripts/publish-release.mjs";
import { WINDOW_ICON_SIZE, isTemplateTrayIcon, trayIconScales, trayIconSize } from "../dist/desktop/icon-sizes.js";
import { LINUX_ICON_SIZES, iconFileName, iconFileSize } from "../dist/install/unix-icons.js";
import { readPng, scale } from "../apps/mobile/scripts/png.mjs";

const platforms = ["win32", "darwin", "linux"];

test("download names match the release table for every computer, and nothing else gets one", () => {
  const expected = {
    "win32 x64": "Branch-Agent-windows-x64.zip",
    "darwin arm64": "Branch-Agent-macos-arm64.zip",
    "darwin x64": "Branch-Agent-macos-x64.zip",
    "linux x64": "Branch-Agent-linux-x64.tar.gz",
  };
  for (const platform of [...platforms, "freebsd"])
    for (const arch of ["x64", "arm64", "ia32"])
      assert.equal(assetNameFor(platform, arch), expected[`${platform} ${arch}`] ?? null, `${platform} ${arch}`);
});

test("checksum files use the two-space sha256sum line with the bare name", () => {
  const digest = "a".repeat(64);
  assert.equal(checksumLine(digest, "Branch-Agent-macos-arm64.zip"), `${digest}  Branch-Agent-macos-arm64.zip\n`);
  assert.match(checksumLine(digest, "x.tar.gz"), /^([a-f0-9]{64})\b/);
});

test("Windows packaging options are the long-standing set", () => {
  const { ignore, ...rest } = packagerOptions("win32", "x64");
  assert.deepEqual(rest, {
    dir: ".", out: "release", name: "Branch Agent", executableName: "Branch Agent",
    icon: "public/assets/keepoak.ico", appCategoryType: "public.app-category.productivity",
    platform: "win32", arch: "x64", asar: false, overwrite: true, prune: true,
  });
  for (const kept of ["", "/dist", "/dist/cli.js", "/public/index.html", "/node_modules/zod", "/package.json", "/LICENSE", "/THIRD_PARTY_NOTICES.md", "/README.md", "/package-lock.json"])
    assert.equal(ignore(kept), false, kept);
  for (const dropped of ["/src", "/tests/a.mjs", "/docs", "/release", "/scripts/package-desktop.mjs", "/.env", "/distx"])
    assert.equal(ignore(dropped), true, dropped);
  assert.equal(includedInApp("/public"), true);
  assert.deepEqual(windowsZipCommand("release/Branch Agent-win32-x64", "release/Branch-Agent-windows-x64.zip"),
    ["C:\\Windows\\System32\\tar.exe", "-a", "-cf", "release/Branch-Agent-windows-x64.zip", "-C", "release", "Branch Agent-win32-x64"]);
});

test("macOS options carry the bundle id, the icon and the permission sentences", () => {
  const options = packagerOptions("darwin", "arm64", "release/build/keepoak.icns");
  assert.equal(options.platform, "darwin");
  assert.equal(options.arch, "arm64");
  assert.equal(options.appBundleId, "com.keepoak.branch-agent");
  assert.equal(options.icon, "release/build/keepoak.icns");
  assert.equal(options.name, "Branch Agent");
  assert.equal(options.asar, false);
  const info = options.extendInfo;
  assert.match(info.NSMicrophoneUsageDescription, /microphone/);
  assert.match(info.NSScreenCaptureUsageDescription, /screen/);
  for (const text of Object.values(info)) assert.doesNotMatch(String(text), /launchd|entitlement|TCC/i);
});

test("Linux options name the program without a space", () => {
  const options = packagerOptions("linux", "x64", PACKAGE_ICON);
  assert.equal(options.platform, "linux");
  assert.equal(options.executableName, "branch-agent");
  assert.throws(() => linux.linuxAssetName("arm64"), /no Linux download/);
  assert.throws(() => mac.macAssetName("ia32"), /no macOS download/);
});

test("the arch can be chosen, so one Mac makes both downloads", () => {
  assert.deepEqual(parseArgs([], "arm64"), { release: false, arch: "arm64" });
  assert.deepEqual(parseArgs(["--release", "--arch", "x64"], "arm64"), { release: true, arch: "x64" });
  assert.throws(() => parseArgs(["--arch"], "arm64"), /needs a value/);
  assert.equal(needsAssetName("win32", false), false, "a Windows app folder is still built on any arch");
  assert.equal(needsAssetName("win32", true), true);
  assert.equal(needsAssetName("darwin", false), true);
  assert.equal(needsAssetName("linux", false), true);
  assert.throws(() => parseArgs(["--arch", "--release"], "arm64"), /needs a value/);
});

test("the icon plan uses sips for every size and iconutil once", () => {
  const plan = mac.iconPlan("logo.png", "set.iconset", "out.icns");
  assert.equal(plan.length, 11);
  assert.deepEqual(plan[0], ["sips", "-z", "16", "16", "logo.png", "--out", join("set.iconset", "icon_16x16.png")]);
  assert.deepEqual(plan[9], ["sips", "-z", "1024", "1024", "logo.png", "--out", join("set.iconset", "icon_512x512@2x.png")]);
  assert.deepEqual(plan.at(-1), ["iconutil", "-c", "icns", "set.iconset", "-o", "out.icns"]);
});

test("without a signing identity the Mac copy is sealed ad hoc, zipped, and says macOS will warn", () => {
  const plan = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: ["A.app/F.framework", "A.app/H.app"], entitlements: "e.plist", env: {} });
  assert.deepEqual(plan.commands, [
    ["codesign", "--deep", "--force", "--sign", "-", "A.app/F.framework"],
    ["codesign", "--deep", "--force", "--sign", "-", "A.app/H.app"],
    ["codesign", "--force", "--sign", "-", "A.app"],
    ["ditto", "-c", "-k", "--keepParent", "A.app", "A.zip"],
  ]);
  assert.equal(plan.signed, false);
  assert.match(mac.macSigningNotice(plan), /not signed, so macOS will warn/);
});

test("with an identity the Mac copy is signed with the hardened runtime and notarised without a password", () => {
  const env = { APPLE_SIGNING_IDENTITY: "Developer ID Application: KeepOak (TEAM)", APPLE_NOTARY_PROFILE: "branch", APPLE_PASSWORD: "hunter2" };
  const plan = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: ["A.app/F.framework"], entitlements: "e.plist", env });
  assert.deepEqual(plan.commands, [
    ["codesign", "--deep", "--force", "--timestamp", "--options", "runtime", "--entitlements", "e.plist", "--sign", env.APPLE_SIGNING_IDENTITY, "A.app/F.framework"],
    ["codesign", "--force", "--timestamp", "--options", "runtime", "--entitlements", "e.plist", "--sign", env.APPLE_SIGNING_IDENTITY, "A.app"],
    ["ditto", "-c", "-k", "--keepParent", "A.app", "A.zip"],
    ["xcrun", "notarytool", "submit", "A.zip", "--keychain-profile", "branch", "--wait"],
    ["xcrun", "stapler", "staple", "A.app"],
    ["rm", "-f", "A.zip"],
    ["ditto", "-c", "-k", "--keepParent", "A.app", "A.zip"],
  ]);
  assert.ok(!JSON.stringify(plan).includes("hunter2"));
  assert.match(mac.macSigningNotice(plan), /signed and notarised/);
  const keyed = mac.notarizeCredentials({ APPLE_API_KEY_PATH: "k.p8", APPLE_API_KEY_ID: "ID", APPLE_API_ISSUER: "ISS" });
  assert.deepEqual(keyed, ["--key", "k.p8", "--key-id", "ID", "--issuer", "ISS"]);
  const signedOnly = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: [], entitlements: "e", env: { APPLE_SIGNING_IDENTITY: "X" } });
  assert.equal(signedOnly.notarized, false);
  assert.equal(signedOnly.commands.length, 2);
  assert.match(mac.macSigningNotice(signedOnly), /not notarised/);
});

test("the free certificate signs like the paid one but is never notarised", () => {
  // Three things at once: MAC_SIGNING_SHA1 takes the hardened path, the keychain the build made goes
  // on the command, and the notary profile sitting beside it is ignored, because Apple will not
  // notarise a certificate it did not issue and trying would fail the whole release.
  const env = { MAC_SIGNING_SHA1: "442C583281039E5DCA3FC0EE4A76924562FD1403", MAC_SIGNING_KEYCHAIN: "/t/s.keychain-db", APPLE_NOTARY_PROFILE: "branch" };
  const plan = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: ["A.app/H.app"], entitlements: "e.plist", env });
  assert.deepEqual(plan.commands, [
    ["codesign", "--deep", "--force", "--timestamp", "--options", "runtime", "--entitlements", "e.plist", "--keychain", "/t/s.keychain-db", "--sign", env.MAC_SIGNING_SHA1, "A.app/H.app"],
    ["codesign", "--force", "--timestamp", "--options", "runtime", "--entitlements", "e.plist", "--keychain", "/t/s.keychain-db", "--sign", env.MAC_SIGNING_SHA1, "A.app"],
    ["ditto", "-c", "-k", "--keepParent", "A.app", "A.zip"],
  ]);
  assert.equal(plan.signed, true);
  assert.equal(plan.notarized, false);
  assert.equal(plan.identitySource, "self-signed");
  assert.match(mac.macSigningNotice(plan), /kept across updates/);
  assert.doesNotMatch(mac.macSigningNotice(plan), /not notarised/);
  // Without a keychain of its own the pair is left out entirely, never passed as an empty argument.
  const noKeychain = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: [], entitlements: "e", env: { MAC_SIGNING_SHA1: "AB" } });
  assert.deepEqual(noKeychain.commands[0], ["codesign", "--force", "--timestamp", "--options", "runtime", "--entitlements", "e", "--sign", "AB", "A.app"]);
  // The paid identity still wins, and still notarises.
  const paid = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: [], entitlements: "e", env: { APPLE_SIGNING_IDENTITY: "Developer ID Application: KeepOak (TEAM)", MAC_SIGNING_SHA1: "AB", APPLE_NOTARY_PROFILE: "branch" } });
  assert.equal(paid.identitySource, "developer-id");
  assert.equal(paid.notarized, true);
  assert.ok(paid.commands[0].includes("Developer ID Application: KeepOak (TEAM)"));
  assert.ok(!paid.commands[0].includes("--keychain"));
  assert.equal(mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: [], entitlements: "e", env: {} }).identitySource, "ad-hoc");
});

test("the bundle identifier is half the app's identity and is pinned to its exact value", () => {
  // Changing it makes macOS treat the update as a different app and throws away every permission the
  // owner granted. It is not a name; it is part of the identity. Rename nothing here casually.
  assert.equal(mac.MAC_BUNDLE_ID, "com.keepoak.branch-agent");
  assert.equal(mac.macPackagerOptions({ arch: "arm64", icon: "i.icns" }).appBundleId, "com.keepoak.branch-agent");
});

test("a build whose identity would reset the owner's permissions is refused, not warned about", () => {
  assert.deepEqual(mac.macRequirementCommand("A.app"), ["codesign", "-d", "-r-", "A.app"]);
  const good = [
    "Executable=/x/Branch Agent.app/Contents/MacOS/Branch Agent",
    'designated => identifier "com.keepoak.branch-agent" and certificate root = H"442c583281039e5dca3fc0ee4a76924562fd1403"',
  ].join("\n");
  const checked = mac.macIdentityCheck(good);
  assert.equal(checked.ok, true);
  assert.equal(checked.reason, null);
  assert.match(checked.requirement, /^identifier "com\.keepoak\.branch-agent"/);
  // Exactly what an ad-hoc build of this app prints, captured from one. codesign comments the line
  // out because an ad-hoc seal is not a requirement anything can be held to, and the identity is the
  // app's own contents, so the next build is a different app to macOS.
  const adHoc = mac.macIdentityCheck([
    "Executable=/x/Branch Agent.app/Contents/MacOS/Branch Agent",
    '# designated => cdhash H"b1c5ae710ad3e59abfe30766fc5a5e0381cde28f"',
  ].join("\n"));
  assert.equal(adHoc.ok, false);
  assert.match(adHoc.reason, /resets the owner's permissions/);
  assert.match(adHoc.requirement, /^cdhash/);
  // A paid Developer ID anchors to Apple instead of to a certificate root and is just as stable, so
  // it passes too: refusing it would block the upgrade this whole check exists to make easy.
  const paid = mac.macIdentityCheck('designated => identifier "com.keepoak.branch-agent" and anchor apple generic and certificate leaf[subject.OU] = "TEAM"');
  assert.equal(paid.ok, true);
  // Neither anchor: nothing ties this signature to a certificate at all.
  const noAnchor = mac.macIdentityCheck('designated => identifier "com.keepoak.branch-agent"');
  assert.equal(noAnchor.ok, false);
  assert.match(noAnchor.reason, /not anchored/);
  const renamed = mac.macIdentityCheck('designated => identifier "com.keepoak.branch" and certificate root = H"44"');
  assert.equal(renamed.ok, false);
  assert.match(renamed.reason, /com\.keepoak\.branch-agent/);
  const silent = mac.macIdentityCheck("Executable=/x/Branch Agent.app/Contents/MacOS/Branch Agent\n");
  assert.equal(silent.ok, false);
  assert.equal(silent.requirement, null);
  // codesign does not always quote the identifier; both spellings are the same identity.
  assert.equal(mac.macIdentityCheck('designated => identifier com.keepoak.branch-agent and certificate root = H"44"').ok, true);
});

test("nested code is signed frameworks first, helpers next, and ignores loose files", () => {
  const nested = mac.nestedCode("X.app", ["Squirrel.framework", "Branch Agent Helper.app", "Electron Framework.framework", "notes.txt"]);
  assert.deepEqual(nested, [
    join("X.app", "Contents", "Frameworks", "Electron Framework.framework"),
    join("X.app", "Contents", "Frameworks", "Squirrel.framework"),
    join("X.app", "Contents", "Frameworks", "Branch Agent Helper.app"),
  ]);
  const entitlements = mac.entitlementsPlist();
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
});

test("the Linux menu entry names the program, the icon and the version", () => {
  const entry = linux.desktopEntry({ version: "0.16.0" });
  const lines = entry.trim().split("\n");
  assert.equal(lines[0], "[Desktop Entry]");
  for (const line of ["Type=Application", "Name=Branch Agent", 'Exec="branch-agent" %U', "Icon=branch-agent.png", "Terminal=false", "X-Branch-Agent-Version=0.16.0"])
    assert.ok(lines.includes(line), line);
  const installed = linux.desktopEntry({ version: "1.0.0", folder: "/home/me/Branch-Agent-linux-x64" });
  assert.ok(installed.includes('Exec="/home/me/Branch-Agent-linux-x64/branch-agent" %U'));
  assert.ok(installed.includes("Icon=/home/me/Branch-Agent-linux-x64/branch-agent.png"));
  assert.deepEqual(linux.tarCommand({ releaseDir: "release", folder: linux.LINUX_FOLDER, archive: "release/B.tar.gz" }),
    ["tar", "-czf", "release/B.tar.gz", "-C", "release", "Branch-Agent-linux-x64"]);
});

test("a real .icns is made with sips and iconutil", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-icns-"));
  t.after(() => discardTemp(root));
  const iconset = join(root, "k.iconset");
  await mkdir(iconset);
  for (const [file, ...args] of mac.iconPlan(PACKAGE_ICON, iconset, join(root, "k.icns")))
    execFileSync(file, args, { stdio: "ignore" });
  const bytes = await readFile(join(root, "k.icns"));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "icns");
  /* And it is the mascot inside, not only a well-formed file: the dock never takes its icon from the
     window, so this file is the whole of what an installed Branch shows there. */
  execFileSync("iconutil", ["-c", "iconset", join(root, "k.icns"), "-o", join(root, "back.iconset")], { stdio: "ignore" });
  const drawn = readPng(await readFile(join(root, "back.iconset", "icon_256x256.png")));
  assert.equal(drawn.width, 256);
  await isTheMascot(drawn, "the macOS .icns at 256");
});

/**
 * The real macOS build, checked by structure only, once `npm run package:desktop` has made it
 * (BRANCH_PACKAGED_APP points elsewhere). The app is never opened.
 */
const builtApp = process.env.BRANCH_PACKAGED_APP
  ?? join("release", `Branch Agent-darwin-${process.arch}`, "Branch Agent.app");
test("a built Mac bundle has the expected structure and Info.plist", { skip: process.platform !== "darwin" || !existsSync(builtApp) }, async (t) => {
  const contents = join(builtApp, "Contents");
  assert.ok(existsSync(join(contents, "MacOS", "Branch Agent")));
  assert.ok(existsSync(join(contents, "Resources", "app", "dist", "desktop", "main.js")));
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(contents, "Info.plist")], { encoding: "utf8" }));
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(info.CFBundleIdentifier, "com.keepoak.branch-agent");
  assert.equal(info.CFBundleName, "Branch Agent");
  assert.equal(info.CFBundleExecutable, "Branch Agent");
  assert.equal(info.CFBundleShortVersionString, manifest.version);
  const icon = await readFile(join(contents, "Resources", info.CFBundleIconFile));
  assert.deepEqual(icon, await readFile(join("release", "build", "keepoak.icns")), "the KeepOak icon replaced Electron's");
  // mac7/app-icon: the dock never takes its icon from the window, only from this file, so every size
  // a Mac asks for has to be in it — 1024 for a dock on a Retina screen down to 16 for a list.
  const unpacked = await mkdtemp(join(tmpdir(), "branch-icns-"));
  t.after(() => discardTemp(unpacked));
  execFileSync("iconutil", ["-c", "iconset", join(contents, "Resources", info.CFBundleIconFile), "-o", join(unpacked, "k.iconset")]);
  assert.deepEqual((await readdir(join(unpacked, "k.iconset"))).sort(),
    [16, 32, 128, 256, 512].flatMap((size) => [`icon_${size}x${size}.png`, `icon_${size}x${size}@2x.png`]).sort());
  const biggest = readPng(await readFile(join(unpacked, "k.iconset", "icon_512x512@2x.png")));
  assert.equal(biggest.width, 1024);
  assert.ok(biggest.data.some((byte) => byte !== 0), "the mark is really drawn, not an empty square");
  assert.equal(info.ElectronAsarIntegrity, undefined);
  assert.equal(info.NSMicrophoneUsageDescription, mac.macInfoExtras().NSMicrophoneUsageDescription);
  const helpers = (await readdir(join(contents, "Frameworks"))).filter((name) => name.endsWith(".app"));
  assert.ok(helpers.length >= 4 && helpers.every((name) => name.startsWith("Branch Agent Helper")), helpers.join(", "));
  const check = spawnSync("codesign", ["--verify", "--deep", "--strict", builtApp], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const zip = join("release", `Branch-Agent-macos-${process.arch}.zip`);
  const line = await readFile(`${zip}.sha256`, "utf8");
  assert.match(line, new RegExp(`^[a-f0-9]{64}  Branch-Agent-macos-${process.arch}\\.zip\\n$`));
  const listing = execFileSync("zipinfo", ["-1", zip], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.ok(listing.startsWith("Branch Agent.app/"));
});

// ---- mac7/packaging-real: the phone download cannot be packed out of an unbuilt folder ----
// Built for real on a Linux machine, `node scripts/pack-cli.mjs` with no dist/ on disk wrote a
// one-megabyte tarball containing only package.json, data, public and the licences. It installs
// cleanly and its `branch` command points at dist/cli.js, which is not in the file. The release
// workflow only escapes this because `npm run package:desktop` happens to build first.
test("packing refuses when the program has not been built, and only then", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(builtOutputs(manifest), ["dist/cli.js", "dist", "public"]);
  // An empty folder: every built path is missing, so the script has something to refuse.
  assert.deepEqual(missingOutputs(manifest, () => false), ["dist/cli.js", "dist", "public"]);
  // tsc ran but copy-fonts did not, so public/ is there and the command is not: still refused.
  assert.deepEqual(missingOutputs(manifest, (path) => path !== "dist/cli.js"), ["dist/cli.js"]);
  assert.deepEqual(missingOutputs(manifest, () => true), []);
  // `npm test` builds first, so this working folder is genuinely ready to be packed.
  assert.deepEqual(missingOutputs(manifest), []);
});

test("the packed name of the command is the one the tarball is checked for", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pathInTarball(manifest.bin.branch), "package/dist/cli.js");
});

// ---- mac7/packaging-real: the release publisher has to compare names the way GitHub stores them ----
// GitHub turns every character that is not a letter, a digit, a hyphen, an underscore or a dot into
// a dot, so "Install Branch Agent.cmd" is attached as "Install.Branch.Agent.cmd". Comparing the
// file's own name against the release therefore never matched for the two installer scripts, and a
// re-run tried to upload a name that was already there. The publisher's actual helper is exercised
// here so its comparison cannot drift away from the release logic.
test("the release publisher compares asset names the way GitHub writes them", () => {
  assert.equal(remoteName("Install Branch Agent.cmd"), "Install.Branch.Agent.cmd");
  // Everything else is already made of characters GitHub keeps, so nothing else moves.
  for (const kept of ["install-branch-agent.sh", "Branch-Agent-macos-arm64.zip", "Branch-Agent-linux-x64.tar.gz",
    "branch-agent-0.18.0.tgz", "branch-agent-0.18.0.tgz.sha256"])
    assert.equal(remoteName(kept), kept);
});

/** mac7/app-icon: one size for the window, the menu bar and the dock was wrong for all three. */
test("each place the mark appears asks for its own size, and only macOS wants a template", () => {
  assert.equal(WINDOW_ICON_SIZE, 512, "a taskbar had to stretch the 32 it used to get");
  assert.equal(trayIconSize("darwin"), 16, "the menu bar, in points");
  for (const platform of ["win32", "linux"]) {
    assert.equal(trayIconSize(platform), 32, "the notification area keeps the size it has always had");
    assert.deepEqual(trayIconScales(platform), [1]);
    assert.equal(isTemplateTrayIcon(platform), false);
  }
  assert.deepEqual(trayIconScales("darwin"), [1, 2], "a Retina menu bar gets real pixels, not a stretch");
  assert.equal(isTemplateTrayIcon("darwin"), true, "so the mark suits a light and a dark menu bar");
});

test("the packager really writes every icon size into the Linux download, under the names the installer looks for", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-linux-icons-"));
  t.after(() => discardTemp(root));
  const into = await writeLinuxIcons(root);
  assert.equal(into, join(root, "icons"));
  assert.deepEqual((await readdir(into)).sort(), LINUX_ICON_SIZES.map((size) => iconFileName(linux.LINUX_EXECUTABLE, size)).sort());
  for (const size of LINUX_ICON_SIZES) {
    const file = join(into, iconFileName(linux.LINUX_EXECUTABLE, size));
    // The installer only copies a name it recognises, so the two halves must agree exactly.
    assert.equal(iconFileSize(linux.LINUX_EXECUTABLE, iconFileName(linux.LINUX_EXECUTABLE, size)), size);
    const drawn = readPng(await readFile(file));
    assert.equal(drawn.width, size);
    assert.ok(drawn.data.some((byte) => byte !== 0), `${file} is really the mark, not an empty square`);
    await isTheMascot(drawn, file);
  }
});

test("the mark really shrinks to every size a Linux menu asks for", async () => {
  const mark = readPng(await readFile("public/assets/keepoak-mark.png"));
  assert.equal(mark.width, 1024, "the source is big enough for every size below");
  for (const size of LINUX_ICON_SIZES) {
    const small = scale(mark, size);
    assert.equal(small.width, size);
    assert.equal(small.height, size);
    assert.ok(small.data.some((byte) => byte !== 0), `${iconFileName("branch-agent", size)} is really drawn`);
  }
});

// ---- integrate/mac-fixes: a release that fails the identity check must not leave a download behind ----
// Built for real here with no certificate and --release: the check refused, loudly, but only after the
// ad-hoc bundle had already been zipped into release/, beside the checksum of the previous (signed)
// build. Anyone uploading release/ by hand would ship exactly the build the check exists to stop.
test("the identity check runs after signing and before anything is zipped", () => {
  const plan = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: ["A.app/H.app"], entitlements: "e", env: {} });
  const ran = [];
  const refuse = () => { ran.push("check"); throw new Error("the requirement pins a cdhash"); };
  assert.throws(() => finishMac(plan, { app: "A.app", release: true, required: true, run: (command) => ran.push(command[0]), check: refuse }), /cdhash/);
  assert.deepEqual(ran, ["codesign", "codesign", "check"], "signed, checked, and never zipped");

  // Before the owner has turned signing on, a release is unsigned exactly as it always was: it is
  // not checked, it is zipped, and it says plainly what that costs.
  ran.length = 0;
  const warned = [];
  finishMac(plan, { app: "A.app", release: true, required: false, run: (command) => ran.push(command[0]), check: refuse, warn: (line) => warned.push(line) });
  assert.deepEqual(ran, ["codesign", "codesign", "ditto"]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /unsigned/);
  assert.match(warned[0], /every update/);

  ran.length = 0;
  const signed = mac.macFinishPlan({ app: "A.app", zip: "A.zip", nested: [], entitlements: "e", env: { MAC_SIGNING_SHA1: "AB" } });
  finishMac(signed, { app: "A.app", release: false, run: (command) => ran.push(command[0]), check: () => ran.push("check") });
  assert.deepEqual(ran, ["codesign", "check", "ditto"], "a signed build is checked even when it is not a release");

  ran.length = 0;
  const quiet = [];
  finishMac(plan, { app: "A.app", release: false, required: true, run: (command) => ran.push(command[0]), check: () => ran.push("check"),
    warn: (line) => quiet.push(line) });
  assert.deepEqual(ran, ["codesign", "codesign", "ditto"], "a plain local build stays ad-hoc and unchecked, as before");
  assert.deepEqual(quiet, [], "and silent");
  assert.equal(signingRequired({ MAC_SIGNING_REQUIRED: "true" }), true);
  for (const value of [undefined, "", "false", "TRUE ", "1"]) assert.equal(signingRequired({ MAC_SIGNING_REQUIRED: value }), false, String(value));
});

test("the release workflow refuses a Mac release only once signing is switched on, and warns before then", async () => {
  const workflow = await readFile(join(".github", "workflows", "package.yml"), "utf8");
  const step = (name) => workflow.split(/\n\s*- /).find((block) => block.includes(`name: ${name}`)) ?? "";
  // The owner's switch is a repository variable, set beside the three secrets.
  assert.match(workflow, /MAC_SIGNING_REQUIRED: \$\{\{ vars\.MAC_SIGNING_REQUIRED == 'true' \}\}/);
  assert.match(workflow, /HAS_ANY_MAC_SIGNING_SECRET: \$\{\{ secrets\.MAC_SIGNING_P12_BASE64 != '' \|\| secrets\.MAC_SIGNING_P12_PASSWORD != '' \|\| secrets\.MAC_SIGNING_SHA1 != '' \}\}/);
  // Switched on with no certificate: refused, loudly.
  const refuse = step("Refuse to publish a Mac release with no signing certificate");
  assert.match(refuse, /if: runner\.os == 'macOS' && env\.MAC_SIGNING_REQUIRED == 'true' && env\.HAS_MAC_SIGNING_CERTIFICATE != 'true'/);
  assert.match(refuse, /::error::/);
  assert.match(refuse, /exit 1/);
  // A secret with no switch is a half-finished setup: refused, loudly.
  const half = step("Refuse a half-finished Mac signing setup");
  assert.match(half, /if: runner\.os == 'macOS' && env\.MAC_SIGNING_REQUIRED != 'true' && env\.HAS_ANY_MAC_SIGNING_SECRET == 'true'/);
  assert.match(half, /exit 1/);
  // Not switched on: the release goes ahead unsigned, with a warning in the job summary.
  const warn = step("Warn that the Mac copy is unsigned");
  assert.match(warn, /if: runner\.os == 'macOS' && env\.MAC_SIGNING_REQUIRED != 'true' && env\.HAS_ANY_MAC_SIGNING_SECRET != 'true'/);
  assert.match(warn, /GITHUB_STEP_SUMMARY/);
  assert.match(warn, /unsigned/);
  assert.doesNotMatch(warn, /exit 1/);
  // The build itself is told, so a lost or broken certificate still fails at the identity check.
  assert.match(step("Build the download"), /MAC_SIGNING_REQUIRED: \$\{\{ env\.MAC_SIGNING_REQUIRED \}\}/);
  const load = step("Load the signing certificate");
  assert.match(load, /base64 --decode > "\$RUNNER_TEMP\/branch-signing\.p12"/);
  assert.match(load, /rm -f "\$RUNNER_TEMP\/branch-signing\.p12"/);
  assert.doesNotMatch(load, /echo[^\n]*MAC_SIGNING_P12|set -x/, "the certificate and its passphrase are never printed");
  const remove = step("Remove the signing material");
  assert.match(remove, /if: always\(\)/);
  assert.match(remove, /security delete-keychain "\$RUNNER_TEMP\/branch-signing\.keychain-db"/);
  assert.match(workflow, /npm run package:desktop -- --release/);
});

test("a version tag cannot build or publish until fail-closed CI passed for that exact commit", async () => {
  const workflow = await readFile(join(".github", "workflows", "package.yml"), "utf8");
  const job = (name) => workflow.split(/\n(?=  [a-z-]+:\n)/).find((block) => block.startsWith(`  ${name}:\n`)) ?? "";

  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: read/);
  const gate = job("release-gate");
  assert.match(gate, /repos\/\$GH_REPO\/actions\/runs/);
  assert.match(gate, /for workflow in pr-fast\.yml checks\.yml/);
  assert.match(gate, /--arg path "\.github\/workflows\/\$workflow"/);
  assert.match(gate, /select\(\.path == \$path/);
  assert.match(gate, /head_sha="\$GITHUB_SHA"/);
  assert.match(gate, /if \[ "\$status" = completed \] && \[ "\$conclusion" = success \]/);
  assert.match(gate, /exit 1/);
  assert.match(job("android"), /needs: release-gate/);
  assert.match(job("build"), /needs: \[release-gate, android\]/);
  assert.match(job("publish"), /needs: \[release-gate, build\]/);
});


/* ---------- mac7/app-icon: the icon an installed Branch actually shows ---------- */

/** How far apart two same-sized pictures are, 0 being the same picture. */
function apart(one, other) {
  let total = 0;
  for (let at = 0; at < one.data.length; at++) total += Math.abs(one.data[at] - other.data[at]);
  return total / one.data.length;
}

/** The mascot and the mark it replaces, both at `size`, to say which a drawn icon really is. */
async function marks(size) {
  const [mascot, old] = await Promise.all([readFile(PACKAGE_ICON), readFile("public/assets/keepoak-mark.png")]);
  return { mascot: scale(readPng(mascot), size), old: scale(readPng(old), size) };
}

/** Fails when `drawn` is the old KeepOak mark rather than the mascot. */
async function isTheMascot(drawn, where) {
  const { mascot, old } = await marks(drawn.width);
  const toMascot = apart(drawn, mascot), toOld = apart(drawn, old);
  assert.ok(toMascot < toOld, `${where} is still the old mark (${toMascot.toFixed(1)} from the mascot, ${toOld.toFixed(1)} from the mark)`);
}

test("every installed icon is made from the one approved mascot, so the three platforms cannot drift apart", async () => {
  assert.ok(existsSync(PACKAGE_ICON), `${PACKAGE_ICON} is not in the repository`);
  const source = readPng(await readFile(PACKAGE_ICON));
  assert.ok(source.width >= 1024, `the source is ${source.width} wide; a Retina dock asks for 1024`);
  assert.equal(source.width, source.height, "an app icon is square");
  await isTheMascot(scale(source, 256), PACKAGE_ICON);
  /* Each platform names the same file, read from what the build really runs rather than from a call
     the test makes up: the macOS iconset commands, the Linux packager and the Windows .ico. */
  const plan = macIconPlan();
  const sips = plan.commands.filter(([tool]) => tool === "sips");
  assert.ok(sips.length >= 10, "every size a Mac asks for");
  for (const command of sips) assert.equal(command[4], PACKAGE_ICON, "a Mac icon size is drawn from something else");
  assert.equal(packagerOptions("linux", "x64", PACKAGE_ICON).icon, PACKAGE_ICON);

  /* And the old mark is named nowhere in the packaging, so no platform can quietly keep it. */
  const script = await readFile("scripts/package-desktop.mjs", "utf8");
  assert.doesNotMatch(script, /keepoak-mark/, "the packaging still reaches for the old mark somewhere");
  const windows = await readFile("scripts/prepare-icon.mjs", "utf8");
  assert.doesNotMatch(windows, /keepoak-mark/, "the Windows icon still reaches for the old mark");
});

test("the Windows icon holds every size Windows draws, and every one of them is the mascot", async () => {
  const ico = icoFrom(readPng(await readFile(PACKAGE_ICON)));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "an icon, not a cursor");
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length, "one entry per size");
  /* One 256 image is what shipped before: the Start menu, the taskbar and a file listing each ask
     for a different size, and Windows shrinking one big picture is where a blurry icon comes from. */
  assert.ok(ICO_SIZES.includes(16) && ICO_SIZES.includes(32) && ICO_SIZES.includes(256), "the sizes Windows really asks for");
  for (const [index, size] of ICO_SIZES.entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size, `entry ${index} says the wrong width`);
    assert.equal(ico[entry + 1] || 256, size, `entry ${index} says the wrong height`);
    assert.equal(ico.readUInt16LE(entry + 6), 32, "with its alpha kept");
    const at = ico.readUInt32LE(entry + 12), length = ico.readUInt32LE(entry + 8);
    assert.ok(at + length <= ico.length, `entry ${index} points past the end of the file`);
    const drawn = readPng(ico.subarray(at, at + length));
    assert.equal(drawn.width, size, `entry ${index} holds a picture of the wrong size`);
    await isTheMascot(drawn, `the Windows icon at ${size}`);
  }
});


/*
 * Codex review of `6c062291`: the Windows icon was never built, and every test I had written missed it.
 *
 * The entry guard compared `import.meta.url` with `file://` + `process.argv[1]`. On Windows the first
 * is `file:///C:/...` and the second makes `file://C:\...`: no slash before the drive letter and
 * backslashes throughout, so they can never be equal. The build ran the script, matched nothing, did
 * nothing, exited 0, and the packager shipped no Windows application icon at all.
 *
 * Six mutations passed over that without noticing, because every one of them called icoFrom directly
 * and not one of them ran the program. These three do.
 */
test("the Windows icon script knows when it is the program, by conversion and not by gluing strings", async () => {
  const here = join(import.meta.dirname, "..", "scripts", "prepare-icon.mjs");
  assert.equal(runningAsProgram(pathToFileURL(here).href, here), true, "its own path is recognised");
  assert.equal(runningAsProgram(pathToFileURL(here).href, join(import.meta.dirname, "other.mjs")), false,
    "another file being run is not this one");
  assert.equal(runningAsProgram(pathToFileURL(here).href, undefined), false, "and no program at all is not this one");

  /* The bug itself cannot be run on a Mac -- only Windows produces a `C:\` argv -- so the shape is
     held instead: the comparison must go through pathToFileURL, which knows about drive letters and
     separators, and must never be built by gluing `file://` onto a path. */
  const source = await readFile(here, "utf8");
  assert.match(source, /url === pathToFileURL\(resolve\(argv1\)\)\.href/,
    "the entry guard must compare a converted path; gluing file:// onto argv[1] is the bug this replaced");
});

test("running the Windows icon script as a program really writes an icon, and it has its alpha", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ico-"));
  t.after(() => discardTemp(root));
  const into = join(root, "keepoak.ico");
  assert.equal(existsSync(into), false, "the directory starts clean, so a stale file cannot pass for a new one");

  const ran = spawnSync(process.execPath, [join("scripts", "prepare-icon.mjs"), into],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(ran.status, 0, `the script failed: ${ran.stderr || ran.stdout}`);
  assert.equal(existsSync(into), true, "the script reported success and wrote nothing, which is the whole bug");

  const ico = await readFile(into);
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length, "every size Windows asks for");
  let transparent = 0;
  for (const [index, size] of ICO_SIZES.entries()) {
    const entry = 6 + index * 16;
    const drawn = readPng(ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8)));
    assert.equal(drawn.width, size);
    // A square icon with no transparent corner is a square icon: the mascot has to keep its alpha or
    // Windows draws it on a white tile.
    const corner = drawn.data[3];
    if (corner < 8) transparent += 1;
  }
  assert.equal(transparent, ICO_SIZES.length, "every size kept its transparent corner");
  assert.match(ran.stdout, /keepoak\.ico from/, "and it says what it made and from what");
});

test("the Windows icon script refuses to report success when it could not write the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ico-shut-"));
  t.after(() => discardTemp(root));
  // A file where a directory would have to be: writing inside it cannot work.
  const blocker = join(root, "blocker");
  await writeFile(blocker, "not a directory", "utf8");
  const ran = spawnSync(process.execPath, [join("scripts", "prepare-icon.mjs"), join(blocker, "keepoak.ico")],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.notEqual(ran.status, 0, "a build that cannot write the icon must not exit 0");
  assert.equal(existsSync(join(blocker, "keepoak.ico")), false);
});

/* The readback is its own claim: a write can succeed and still leave nothing behind. /dev/null takes
   every byte and keeps none, which is exactly that case and needs no trickery to arrange. */
test("a write that succeeds and keeps nothing is still a failure", { skip: process.platform === "win32" }, () => {
  const ran = spawnSync(process.execPath, [join("scripts", "prepare-icon.mjs"), "/dev/null"],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.notEqual(ran.status, 0, "the bytes went nowhere and the build was told everything was fine");
  assert.match(ran.stderr, /was not written|bytes, expected/, ran.stderr || ran.stdout);
});

test("the packager asks for the icon at the path the installer later reads", () => {
  assert.equal(ICO_OUTPUT, "public/assets/keepoak.ico");
  assert.equal(packagerOptions("win32", "x64").icon, ICO_OUTPUT, "the packager and the script must name one file");
});
