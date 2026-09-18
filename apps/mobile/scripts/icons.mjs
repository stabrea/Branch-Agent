/**
 * The app icons and the launch mark, made from Branch's own KeepOak mark (public/assets) over the
 * theme's ground colour. The light mark sits on the dark ground, as in the window's sidebar.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativePalettes } from "../web/palette.js";
import { compose, readPng, trim, writePng } from "./png.mjs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..", "..");
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
const imageset = (files) => `${JSON.stringify({ images: files, info: { author: "xcode", version: 1 } }, null, 2)}\n`;

async function androidIcons(res, reversed, ground) {
  for (const [density, factor] of Object.entries(DENSITIES)) {
    const folder = join(res, `mipmap-${density}`);
    await put(join(folder, "ic_launcher.png"), writePng(compose(reversed, Math.round(48 * factor), 0.62, ground)));
    await put(join(folder, "ic_launcher_round.png"), writePng(compose(reversed, Math.round(48 * factor), 0.56, ground)));
    // The adaptive icon's front layer: the mark inside the 66% the launcher never crops.
    await put(join(folder, "ic_launcher_foreground.png"), writePng(compose(reversed, Math.round(108 * factor), 0.46, null)));
  }
}

/** The grey copy iOS tints itself: the mark's brightness, with its shape kept. */
function grey(image) {
  const data = Buffer.from(image.data);
  for (let at = 0; at < data.length; at += 4) {
    const value = Math.round(0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2]);
    data[at] = data[at + 1] = data[at + 2] = value;
  }
  return { ...image, data };
}

/**
 * Since iOS 18 Apple asks for three 1024 icons, not one: the ordinary one, one for a dark home screen
 * and a grey one the system tints itself. Only the ordinary one may be opaque; the other two leave the
 * ground clear so the system puts its own behind the mark (mac7/app-icon).
 */
async function iosIcons(assets, reversed, normal, ground) {
  const icon = join(assets, "AppIcon.appiconset");
  await put(join(icon, "AppIcon-512@2x.png"), writePng(compose(reversed, 1024, 0.62, ground), true));
  await put(join(icon, "AppIcon-dark.png"), writePng(compose(reversed, 1024, 0.62, null)));
  await put(join(icon, "AppIcon-tinted.png"), writePng(grey(compose(reversed, 1024, 0.62, null))));
  const launch = join(assets, "LaunchMark.imageset");
  await put(join(launch, "LaunchMark-light.png"), writePng(compose(normal, 360, 0.9, null)));
  await put(join(launch, "LaunchMark-dark.png"), writePng(compose(reversed, 360, 0.9, null)));
  await put(join(launch, "Contents.json"), imageset([
    { idiom: "universal", filename: "LaunchMark-light.png", scale: "3x" },
    { idiom: "universal", filename: "LaunchMark-dark.png", scale: "3x", appearances: [{ appearance: "luminosity", value: "dark" }] },
  ]));
  await rm(join(assets, "Splash.imageset"), { recursive: true, force: true });
}

export async function writeIcons(root = app) {
  const catalogue = await import(pathToFileURL(join(repo, "public", "theme-catalogue.js")).href);
  const { dark } = nativePalettes(catalogue, "forest");
  const reversed = trim(readPng(await readFile(join(repo, "public", "assets", "keepoak-mark-reversed.png"))));
  const normal = trim(readPng(await readFile(join(repo, "public", "assets", "keepoak-mark.png"))));
  const res = join(root, "android", "app", "src", "main", "res");
  if (existsSync(res)) await androidIcons(res, reversed, dark.ground);
  const assets = join(root, "ios", "App", "App", "Assets.xcassets");
  if (existsSync(assets)) await iosIcons(assets, reversed, normal, dark.ground);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeIcons();
  console.log("App icons and launch mark written.");
}
