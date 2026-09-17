/**
 * The macOS download: `Branch Agent.app`, zipped as `Branch-Agent-macos-<arch>.zip` with a checksum.
 *
 * Every decision is a pure function returning the exact commands that would run, so the tests can
 * check the plan on any computer. `package-desktop.mjs` runs the plans; nothing opens or launches the app.
 */
import { join } from "node:path";

export const MAC_BUNDLE_ID = "com.keepoak.branch-agent";
export const MAC_APP_NAME = "Branch Agent";
export const MAC_ARCHES = ["arm64", "x64"];

/** Exactly the names the updater looks for (see src/desktop/release-assets.ts). */
export function macAssetName(arch) {
  if (!MAC_ARCHES.includes(arch)) throw new Error(`There is no macOS download for ${arch}.`);
  return `Branch-Agent-macos-${arch}.zip`;
}

/** Extra Info.plist entries: the sentences macOS shows when it asks the owner for permission. */
export function macInfoExtras() {
  return {
    NSMicrophoneUsageDescription: "Branch Agent listens only when you press the microphone button, so you can talk to your assistant.",
    NSAudioCaptureUsageDescription: "Branch Agent listens only when you press the microphone button, so you can talk to your assistant.",
    NSScreenCaptureUsageDescription: "Branch Agent looks at your screen only when you ask it to help with what is on it.",
    NSHumanReadableCopyright: "Branch Agent by KeepOak. MIT licence.",
    LSMinimumSystemVersion: "13.0",
  };
}

/** What the packager is told for macOS; the rest of the options are shared with the other systems. */
export function macPackagerOptions({ arch, icon }) {
  return {
    platform: "darwin",
    arch,
    icon,
    appBundleId: MAC_BUNDLE_ID,
    appCategoryType: "public.app-category.productivity",
    extendInfo: macInfoExtras(),
  };
}

const ICON_SIZES = [16, 32, 128, 256, 512];

/** `.icns` from the square logo with the tools every Mac has: sips for each size, then iconutil. */
export function iconPlan(source, iconset, icns) {
  const commands = [];
  for (const size of ICON_SIZES) {
    for (const scale of [1, 2]) {
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
      const pixels = String(size * scale);
      commands.push(["sips", "-z", pixels, pixels, source, "--out", join(iconset, name)]);
    }
  }
  commands.push(["iconutil", "-c", "icns", iconset, "-o", icns]);
  return commands;
}

/** The permissions a hardened Electron app needs to run its JavaScript engine and use the microphone. */
export function entitlementsPlist() {
  const keys = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.device.audio-input",
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...keys.map((key) => `  <key>${key}</key>\n  <true/>`),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * Signing, inside out: frameworks and helpers first (each with everything inside it, since the
 * stock Intel Electron ships their inner programs unsigned), the app last. With no identity the
 * bundle gets an ad-hoc seal (`-`), which Apple Silicon needs to run it at all; macOS still warns.
 */
export function signPlan({ app, nested, identity, entitlements }) {
  const base = identity
    ? ["codesign", "--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity]
    : ["codesign", "--force", "--sign", "-"];
  return [...nested.map((path) => [base[0], "--deep", ...base.slice(1), path]), [...base, app]];
}

/**
 * Notarising, when credentials are present. Only a keychain profile name or an App Store Connect key
 * file path ever goes on the command line; no password does.
 */
export function notarizeCredentials(env) {
  if (env.APPLE_NOTARY_PROFILE) return ["--keychain-profile", env.APPLE_NOTARY_PROFILE];
  if (env.APPLE_API_KEY_PATH && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    return ["--key", env.APPLE_API_KEY_PATH, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  return null;
}

export function zipCommand(app, zip) {
  return ["ditto", "-c", "-k", "--keepParent", app, zip];
}

/** The steps after the packager has made the bundle: sign, zip, notarise, staple, zip again. */
export function macFinishPlan({ app, zip, nested, entitlements, env }) {
  const identity = env.APPLE_SIGNING_IDENTITY || null;
  const credentials = identity ? notarizeCredentials(env) : null;
  const commands = [...signPlan({ app, nested, identity, entitlements }), zipCommand(app, zip)];
  if (credentials) {
    commands.push(["xcrun", "notarytool", "submit", zip, ...credentials, "--wait"]);
    commands.push(["xcrun", "stapler", "staple", app]);
    commands.push(["rm", "-f", zip]);
    commands.push(zipCommand(app, zip));
  }
  return { signed: Boolean(identity), notarized: Boolean(credentials), commands };
}

/** One plain sentence for the person building, never a secret. */
export function macSigningNotice({ signed, notarized }) {
  if (!signed) return "This Mac copy is not signed, so macOS will warn the first time it is opened (allow it under System Settings, Privacy & Security, Open Anyway).";
  if (!notarized) return "This Mac copy is signed but not notarised, so macOS may still warn the first time it is opened.";
  return "This Mac copy is signed and notarised.";
}

/** The nested code inside a bundle that must be signed before the bundle itself. */
export function nestedCode(app, frameworkEntries) {
  const frameworks = join(app, "Contents", "Frameworks");
  return frameworkEntries
    .filter((name) => name.endsWith(".framework") || name.endsWith(".app"))
    .sort((a, b) => Number(a.endsWith(".app")) - Number(b.endsWith(".app")) || a.localeCompare(b))
    .map((name) => join(frameworks, name));
}
