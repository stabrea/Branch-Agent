import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * mac7/phone-qr: where an installed Branch keeps its copy of the phone app.
 *
 * The signed Android app travels inside the desktop download, in `phone/` beside `dist/` and
 * `public/`. Nothing is published, so there is nowhere else it could come from: no store, no public
 * link, no release asset to fetch on first use. It is about 3.7 MB against a download of well over
 * 100 MB, and a copy that came with Branch needs no network and no trust in anything but the
 * download itself. `scripts/package-mobile.mjs` writes a `.sha256` beside every file it builds, and
 * that line travels too, so a damaged or swapped copy is refused rather than handed to a phone.
 */
export const phoneAppName = "Branch-Agent-android.apk";
/** The name the phone saves it under. */
export const phoneAppDownloadName = "Branch-Agent.apk";
/** For a builder or a throwaway Branch: a signed app somewhere else, with its `.sha256` beside it. */
export const phoneAppEnvName = "BRANCH_PHONE_APP";

/** This installed Branch's own folder: the one holding `dist/`, `public/` and `phone/`. */
export const appRoot = (): string => dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export interface PhoneAppFile { path: string; size: number; sha256: string; modified: number }
export type PhoneAppLookup = { file: PhoneAppFile; reason: null } | { file: null; reason: string };

export const missingReason = "This copy of Branch does not include the phone app yet.";
export const damagedReason = "The phone app inside Branch does not match its checksum, so it is not offered. Reinstall Branch to repair it.";

/** Where to look: the builder's own file when named, otherwise the copy that came with Branch. */
export function phoneAppPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = env[phoneAppEnvName]?.trim();
  return named ? named : join(root, "phone", phoneAppName);
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The digest written beside the file, in the two-space line `sha256sum` writes, or null. */
export async function expectedDigest(path: string): Promise<string | null> {
  const line = await readFile(`${path}.sha256`, "utf8").catch(() => "");
  const match = /^([a-f0-9]{64}) {2}(\S+)\s*$/.exec(line.trim());
  return match && match[2] === basename(path) ? match[1]! : null;
}

const checked = new Map<string, PhoneAppFile>();

/**
 * The phone app, checked against its checksum, or the plain reason it is not offered. The digest
 * is worked out once per file and kept until the file changes, so showing the card twice does not
 * read 3.7 MB twice.
 */
export async function findPhoneApp(root: string = appRoot(), env: NodeJS.ProcessEnv = process.env): Promise<PhoneAppLookup> {
  const path = phoneAppPath(root, env);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0 || !path.endsWith(".apk")) return { file: null, reason: missingReason };
  const known = checked.get(path);
  if (known && known.size === info.size && known.modified === info.mtimeMs) return { file: known, reason: null };
  const expected = await expectedDigest(path);
  if (!expected) return { file: null, reason: damagedReason };
  const sha256 = await sha256Of(path);
  if (sha256 !== expected) return { file: null, reason: damagedReason };
  const file = { path, size: info.size, sha256, modified: info.mtimeMs };
  checked.set(path, file);
  return { file, reason: null };
}
