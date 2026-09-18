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
export function signPlan({ app, nested, identity, entitlements, keychain }) {
  const base = identity
    ? [
        "codesign", "--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements,
        ...(keychain ? ["--keychain", keychain] : []),
        "--sign", identity,
      ]
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

/**
 * The steps after the packager has made the bundle: sign, zip, notarise, staple, zip again.
 *
 * Three identities, in the order they are preferred. `APPLE_SIGNING_IDENTITY` is the paid Developer
 * ID, and only it may notarise. `MAC_SIGNING_SHA1` is the free self-made certificate: the same
 * hardened, timestamped signature, but never notarised, because Apple will not notarise a
 * certificate it did not issue. With neither, the bundle gets the ad-hoc seal, which Apple Silicon
 * needs to run it at all - and which pins the app's identity to a hash of its own contents, so every
 * update looks like a different app and the owner grants microphone, screen and accessibility again.
 */
export function macFinishPlan({ app, zip, nested, entitlements, env }) {
  const identity = env.APPLE_SIGNING_IDENTITY || env.MAC_SIGNING_SHA1 || null;
  const identitySource = env.APPLE_SIGNING_IDENTITY ? "developer-id" : env.MAC_SIGNING_SHA1 ? "self-signed" : "ad-hoc";
  // Only the self-made certificate lives in a keychain the build made itself; the paid identity is
  // looked up the way it always was, so that path stays exactly as it was.
  const keychain = identitySource === "self-signed" ? env.MAC_SIGNING_KEYCHAIN || null : null;
  // Notarising stays pinned to the paid variable: a self-signed build must sign and stop, never
  // hand `notarytool` a certificate Apple has never heard of and fail the whole release.
  const credentials = env.APPLE_SIGNING_IDENTITY ? notarizeCredentials(env) : null;
  const commands = [...signPlan({ app, nested, identity, entitlements, keychain }), zipCommand(app, zip)];
  if (credentials) {
    commands.push(["xcrun", "notarytool", "submit", zip, ...credentials, "--wait"]);
    commands.push(["xcrun", "stapler", "staple", app]);
    commands.push(["rm", "-f", zip]);
    commands.push(zipCommand(app, zip));
  }
  return { signed: Boolean(identity), notarized: Boolean(credentials), identitySource, commands };
}

/**
 * The command that prints the requirement macOS will enforce when it decides whether this app is
 * still the app a permission was granted to. `codesign` writes the requirement on one stream and its
 * own notes on the other, so the caller reads both together.
 */
export function macRequirementCommand(app) {
  return ["codesign", "-d", "-r-", app];
}

/** The `designated => ...` line out of whatever `codesign -d -r-` printed, without its label. */
export function macDesignatedRequirement(output) {
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^designated\s*=>\s*(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Is this build's identity the stable kind? The requirement must name the bundle identifier and the
 * signing certificate, and must not name a code directory hash: `cdhash` means the identity is the
 * contents, which change every build, so every permission the owner granted resets on the update.
 * A release that ships that is worse than no release, so this refuses rather than warns.
 */
export function macIdentityCheck(output) {
  const requirement = macDesignatedRequirement(output);
  if (!requirement) return { ok: false, requirement: null, reason: "codesign printed no designated requirement." };
  const named = new RegExp(`identifier\\s+"?${MAC_BUNDLE_ID.replace(/\./g, "\\.")}"?(\\s|$)`).test(requirement);
  if (requirement.includes("cdhash"))
    return { ok: false, requirement, reason: "the requirement pins a cdhash, so every update resets the owner's permissions." };
  if (!requirement.includes("certificate root"))
    return { ok: false, requirement, reason: "the requirement is not anchored to a signing certificate." };
  if (!named) return { ok: false, requirement, reason: `the requirement does not name ${MAC_BUNDLE_ID}.` };
  return { ok: true, requirement, reason: null };
}

/** One plain sentence for the person building, never a secret. */
export function macSigningNotice({ signed, notarized, identitySource }) {
  if (!signed) return "This Mac copy is not signed, so macOS will warn the first time it is opened (allow it under System Settings, Privacy & Security, Open Anyway). Its identity is its own contents, so an update asks for microphone, screen and accessibility permission again.";
  if (identitySource === "self-signed") return "This Mac copy is signed with the project's own certificate, so the permissions the owner grants are kept across updates. macOS still warns the first time it is opened: System Settings, Privacy & Security, Open Anyway.";
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
