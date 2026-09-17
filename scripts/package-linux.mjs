/**
 * The Linux download: an unpacked folder with a menu entry and an icon, as
 * `Branch-Agent-linux-x64.tar.gz` with a checksum. Pure functions only; `package-desktop.mjs` runs them.
 */
export const LINUX_FOLDER = "Branch-Agent-linux-x64";
export const LINUX_EXECUTABLE = "branch-agent";

/** Exactly the name the updater looks for (see src/desktop/release-assets.ts). */
export function linuxAssetName(arch) {
  if (arch !== "x64") throw new Error(`There is no Linux download for ${arch}.`);
  return "Branch-Agent-linux-x64.tar.gz";
}

/** What the packager is told for Linux: a program name without spaces, so menus and shells agree. */
export function linuxPackagerOptions({ arch, icon }) {
  return { platform: "linux", arch, icon, executableName: LINUX_EXECUTABLE };
}

/**
 * The menu entry. Inside the download `Exec` and `Icon` name files in the same folder; given the
 * folder's full path it is the entry to copy into `~/.local/share/applications` (docs/configuration.md).
 */
export function desktopEntry({ version, folder = "." } = {}) {
  const at = (name) => (folder === "." ? name : `${folder}/${name}`);
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Branch Agent",
    "GenericName=Personal assistant",
    "Comment=Your own assistant that works on this computer",
    "Version=1.5",
    `X-Branch-Agent-Version=${version}`,
    `Exec="${at(LINUX_EXECUTABLE)}" %U`,
    `Icon=${at(`${LINUX_EXECUTABLE}.png`)}`,
    "Terminal=false",
    "Categories=Utility;Office;",
    "",
  ].join("\n");
}

/** Pack the folder into one archive whose top level is that folder. */
export function tarCommand({ releaseDir, folder, archive }) {
  return ["tar", "-czf", archive, "-C", releaseDir, folder];
}
