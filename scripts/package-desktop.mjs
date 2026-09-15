import { packager } from "@electron/packager";

const paths = await packager({
  dir: ".",
  out: "release",
  name: "Branch Agent",
  executableName: "Branch Agent",
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
console.log(paths.join("\n"));
