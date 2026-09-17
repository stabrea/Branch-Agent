import { posix, win32 } from "node:path";

/**
 * Whether a folder is one a sync service copies to its servers and to the owner's other devices.
 * Branch's private folder holds the database, the key to saved passwords and every conversation, so
 * a copy of it in iCloud, Dropbox, OneDrive or Google Drive is a copy of all of that somewhere else.
 *
 * The idea (look for the service's name in the path) is OpenClaw's `isProbablySyncedPath` in
 * `src/security/audit-extra.sync.ts` (MIT); the per-system folder list is Branch's own.
 */

/** Names a sync service gives its folder, wherever it is. */
const serviceNames = ["icloud", "dropbox", "onedrive", "google drive", "googledrive", "my drive", "pcloud", "nextcloud", "insync"];

/** Folders under the home folder that each system's sync services use. */
const homeFolders: Record<string, string[]> = {
  darwin: ["Library/Mobile Documents", "Library/CloudStorage", "Dropbox", "Google Drive", "OneDrive", "Box", "pCloud Drive"],
  win32: ["OneDrive", "Dropbox", "Google Drive", "iCloudDrive", "Box", "pCloudDrive", "Nextcloud"],
  linux: ["Dropbox", "Google Drive", "OneDrive", "Nextcloud", "pCloudDrive", "Insync", "MEGA"],
};

const pathApi = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** True when `child` is `parent` or inside it, by the given system's rules. */
export function inside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  // macOS and Windows treat "Dropbox" and "dropbox" as the same folder; Linux does not.
  const fold = (value: string) => (platform === "linux" ? value : value.toLowerCase());
  const between = api.relative(fold(api.resolve(parent)), fold(api.resolve(child)));
  return between === "" || (!between.startsWith("..") && !api.isAbsolute(between));
}

/** The service's own name: macOS keeps them all under two folders whose names say nothing. */
function serviceLabel(root: string, path: string, api: typeof posix): string {
  const name = api.basename(root);
  if (name === "Mobile Documents") return "iCloud Drive";
  if (name !== "CloudStorage") return name;
  // The service's folder is the next one down, whatever case the path was written in.
  const next = path.slice(api.resolve(root).length).split(/[\\/]/).find(Boolean) ?? "";
  return next ? next.split("-")[0]! : "a cloud storage service";
}

/** Answers the sync service a path belongs to, or null. Pure: it looks at the words, not the disk. */
export function syncedService(
  path: string, home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {},
): string | null {
  const api = pathApi(platform);
  const roots = (homeFolders[platform] ?? homeFolders.linux!).map((folder) => api.join(home, folder));
  // Windows tells programs where OneDrive keeps its folder, including a work account's.
  for (const name of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"])
    if (platform === "win32" && env[name]) roots.push(env[name]!);
  for (const root of roots) if (inside(root, path, platform)) return serviceLabel(root, path, api);
  const segments = path.toLowerCase().split(/[\\/]+/);
  const named = serviceNames.find((service) => segments.some((segment) => segment === service || segment.startsWith(`${service}-`) || segment.startsWith(`${service} `)));
  return named ?? null;
}

/** macOS "Desktop & Documents" in iCloud: a path under either folder is copied when that is on. */
export function inIcloudDesktop(path: string, home: string, platform: NodeJS.Platform, icloudDesktopDocuments: boolean): boolean {
  if (platform !== "darwin" || !icloudDesktopDocuments) return false;
  return ["Desktop", "Documents"].some((folder) => inside(posix.join(home, folder), path, platform));
}

/** Places anyone signed in to this computer can write to. */
export function sharedPlace(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[a-z]:\\(users\\public|windows\\temp|temp)(\\|$)/i.test(path);
  return ["/tmp", "/private/tmp", "/var/tmp", "/Users/Shared", "/dev/shm"].some((root) => inside(root, path, platform));
}

/** The home folder itself, or the top of a drive: everything the owner has. */
export function wholeHome(path: string, home: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const resolved = api.resolve(path);
  if (platform === "win32" ? resolved.toLowerCase() === api.resolve(home).toLowerCase() : resolved === api.resolve(home)) return true;
  return platform === "win32" ? /^[a-z]:\\?$/i.test(resolved) : resolved === "/";
}
