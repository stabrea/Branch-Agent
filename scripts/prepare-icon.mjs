/**
 * The Windows icon: one .ico holding the mascot at every size Windows asks for.
 *
 * Windows does not scale one big picture well. The Start menu, the taskbar, Alt+Tab and a file
 * listing each ask for a different size, and an .ico that holds only 256 leaves the small ones to a
 * blurry shrink. Every size below is drawn from the mascot with the repository's own PNG code, so a
 * release needs nothing installed -- the old version of this script ran Electron only to resize a
 * picture -- and the result can be read back by a test instead of looked at.
 *
 * Each entry is a whole PNG inside the .ico, which Windows has accepted since Vista.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPng, scale, writePng } from "../apps/mobile/scripts/png.mjs";

/** The sizes Windows draws an application at, smallest first. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** One .ico holding `sizes` of `source`, each as its own PNG. */
export function icoFrom(source, sizes = ICO_SIZES) {
  const images = sizes.map((size) => ({ size, png: writePng(scale(source, size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon, not cursor
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let at = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory[entry] = size === 256 ? 0 : size; // 0 means 256: the field is one byte
    directory[entry + 1] = size === 256 ? 0 : size;
    directory[entry + 2] = 0; // a PNG carries its own palette
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(at, entry + 12);
    at += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

/** Where the build looks for the Windows icon. */
export const ICO_OUTPUT = "public/assets/keepoak.ico";

/**
 * Whether this file is the program being run, rather than something another file imported.
 *
 * Gluing "file://" onto argv[1] is wrong, and wrong in a way that only shows on Windows, where
 * `import.meta.url` is `file:///C:/…` and argv[1] is `C:\…`: no slash before the drive letter and
 * backslashes throughout, so the two can never be equal. The build then ran this file, matched
 * nothing, did nothing, exited 0, and the packager shipped no Windows icon at all. pathToFileURL is
 * the conversion that knows about drive letters and separators, so it is the one to compare with.
 */
export const runningAsProgram = (url = import.meta.url, argv1 = process.argv[1]) =>
  Boolean(argv1) && url === pathToFileURL(resolve(argv1)).href;

/** Writes the .ico and reads it back, because a build that silently wrote nothing is the bug above. */
export async function writeIcoFile(source, into = ICO_OUTPUT) {
  const bytes = icoFrom(readPng(source));
  await writeFile(into, bytes);
  const written = await stat(into).catch(() => null);
  if (!written?.size) throw new Error(`${into} was not written; the Windows icon would be missing`);
  if (written.size !== bytes.length) throw new Error(`${into} is ${written.size} bytes, expected ${bytes.length}`);
  return bytes.length;
}

if (runningAsProgram()) {
  const { PACKAGE_ICON } = await import("./package-desktop.mjs");
  const into = process.argv[2] ?? ICO_OUTPUT;
  const size = await writeIcoFile(await readFile(PACKAGE_ICON), into);
  console.log(`${into} from ${PACKAGE_ICON}, ${ICO_SIZES.join(", ")} (${size} bytes)`);
}
