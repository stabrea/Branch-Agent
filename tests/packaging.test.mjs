import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  assetNameFor, checksumLine, includedInApp, needsAssetName, packagerOptions, parseArgs, windowsZipCommand, writeLinuxIcons,
} from "../scripts/package-desktop.mjs";
import * as mac from "../scripts/package-macos.mjs";
import * as linux from "../scripts/package-linux.mjs";
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
  const options = packagerOptions("linux", "x64", "public/assets/keepoak-mark.png");
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
  for (const [file, ...args] of mac.iconPlan("public/assets/keepoak-mark.png", iconset, join(root, "k.icns")))
    execFileSync(file, args, { stdio: "ignore" });
  const bytes = await readFile(join(root, "k.icns"));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "icns");
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
