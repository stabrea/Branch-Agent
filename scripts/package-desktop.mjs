import { packager } from "@electron/packager";
import { copyFile, utimes } from "node:fs/promises";
import { join } from "node:path";

const paths = await packager({
  dir: ".",
  out: "release",
  name: "Branch Agent",
  executableName: "Branch Agent",
  icon: process.platform === "win32" ? "public/assets/keepoak.ico" : "public/assets/keepoak-mark.png",
  appBundleId: "com.branchagent.desktop",
  appCategoryType: "public.app-category.productivity",
  platform: process.platform,
  arch: process.arch,
  asar: false,
  overwrite: true,
  ignore: (path) =>
    path !== "" &&
    !/^\/(dist|public|node_modules)(\/|$)/.test(path) &&
    !/^\/(package\.json|package-lock\.json|LICENSE|THIRD_PARTY_NOTICES\.md|README\.md)$/.test(
      path,
    ),
  prune: true,
});
// Smart App Control blocks unsigned executables it has never seen. The packager rewrites the
// executable's icon and version resources, giving every build a brand-new hash. Until releases
// are code-signed, ship the stock Electron executable (a widely known hash) under the app name;
// window, tray and taskbar icons are set at runtime, so only the file icon in Explorer changes.
if (process.platform === "win32")
  for (const out of paths) {
    const target = join(out, "Branch Agent.exe");
    await copyFile("node_modules/electron/dist/electron.exe", target);
    await utimes(target, new Date(), new Date()); // Electron's file dates predate 1980, which ZIP cannot store
  }
console.log(paths.join("\n"));
