// `npm test`: every test file, with the ones that start the whole desktop app run one at a time.
//
// Each desktop file starts Electron, the engine, its database and a window. Three of them at once on
// a four-processor Windows build machine took longer than two minutes just to say "Connected": in one
// run a file that got there needed 167 seconds while two others started beside it ran out of time.
// Nothing in the app was wrong, so the files are no longer started side by side. Everything else
// still runs three at a time.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const folders = ["tests", join("packages", "sdk", "test")];
const desktop = (file) => /^tests[\\/]desktop[^\\/]*\.test\.mjs$/.test(file);

/** Test files in a stable order, split into the ones that start the desktop app and the rest. */
export function testGroups(list = (folder) => readdirSync(folder)) {
  const files = folders.flatMap((folder) =>
    list(folder).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(folder, name)));
  return { shared: files.filter((file) => !desktop(file)), desktop: files.filter(desktop) };
}

function run(files, concurrency) {
  if (!files.length) return 0;
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...files], { stdio: "inherit" });
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { shared, desktop: apps } = testGroups();
  // Both groups always run, so one red run reports every failure.
  const statuses = [run(shared, 3), run(apps, 1)];
  process.exitCode = statuses.some((status) => status !== 0) ? 1 : 0;
}
