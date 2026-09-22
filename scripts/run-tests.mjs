// `npm test`: every test file, with browser and desktop-app files run one at a time.
//
// Each desktop file starts Electron, the engine, its database and a window. Three of them at once on
// a four-processor Windows build machine took longer than two minutes just to say "Connected": in one
// run a file that got there needed 167 seconds while two others started beside it ran out of time.
// Nothing in the app was wrong, so the files are no longer started side by side. Browser files have
// the same constraint: three Chromium windows can make a stable control stop answering for minutes.
// Ordinary non-browser files still run three at a time.
//
// `npm test -- --shard=2/6` runs the second of six shares. The build machines run one share each at
// the same time, so the whole suite no longer waits on one machine: on Windows it took 63 minutes. The shares are packed by how long each file took last time it was measured
// (tests/test-weights.json), not by counting files, because one file runs for seven minutes and
// hundreds finish in under a second. Every file lands in exactly one share; tests/run-tests.test.mjs
// holds that. With no --shard, every file runs here, as before.
//
// BRANCH_TEST_TIMINGS=<file> also writes how long each file took, which is where the weights come from.
// `--files-from=selected-tests.json` runs an explicit selector-produced subset and refuses any path
// that is not part of the discovered suite. It cannot be combined with sharding.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const folders = ["tests", join("packages", "sdk", "test")];
const desktop = (file) => /^tests[\\/]desktop[^\\/]*\.test\.mjs$/.test(file);
const browserImport = /^\s*(?:import\b[^\n]*from\s+["']playwright["']|(?:const|let|var)\b[^\n]*import\(["']playwright["']\))/m;
const here = fileURLToPath(new URL(".", import.meta.url));
const weightsFile = join(here, "..", "tests", "test-weights.json");
const posix = (file) => file.replace(/\\/g, "/");

/** Test files in a stable order, split by how much real browser machinery each starts. */
export function testGroups(list = (folder) => readdirSync(folder), read = (file) => readFileSync(file, "utf8")) {
  const files = folders.flatMap((folder) =>
    list(folder).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(folder, name)));
  const desktopFiles = files.filter(desktop);
  const browser = files.filter((file) => !desktop(file) && browserImport.test(read(file)));
  return { shared: files.filter((file) => !desktop(file) && !browser.includes(file)), browser, desktop: desktopFiles };
}

/** The measured seconds per file for this kind of computer, or an empty map. */
export function loadWeights(platform = process.platform, read = () => readFileSync(weightsFile, "utf8")) {
  try {
    return JSON.parse(read())[platform] ?? {};
  } catch {
    return {};
  }
}

/**
 * Pack the files into `total` shares of about equal time: longest first, each to the lightest share.
 * A file never measured (a new one) counts as the median, so it is not all piled onto one share.
 */
export function shards(files, total, weights = {}) {
  const known = Object.values(weights).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const cost = (file) => weights[posix(file)] ?? fallback;
  const order = [...files].sort((a, b) => cost(b) - cost(a) || (posix(a) < posix(b) ? -1 : 1));
  const shares = Array.from({ length: total }, () => ({ files: [], load: 0 }));
  for (const file of order) {
    const lightest = shares.reduce((best, share) => (share.load < best.load ? share : best));
    lightest.files.push(file);
    lightest.load += cost(file);
  }
  // Keep each share in the usual file order, so its output reads like a normal run.
  return shares.map((share) => files.filter((file) => share.files.includes(file)));
}

/** `--shard=2/5` → { index: 1, total: 5 }; no flag → the whole suite as one share. */
export function parseShard(argv) {
  const flag = argv.find((arg) => arg.startsWith("--shard="));
  if (!flag) return { index: 0, total: 1 };
  const match = /^--shard=(\d+)\/(\d+)$/.exec(flag);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total < 1 || index < 1 || index > total) throw new Error(`Bad ${flag}: expected --shard=<n>/<total>`);
  return { index: index - 1, total };
}

/** Read an explicit selector-produced subset and prove every entry belongs to the discovered suite. */
export function parseFilesFrom(argv, groups, read = (file) => readFileSync(file, "utf8")) {
  const flag = argv.find((arg) => arg.startsWith("--files-from="));
  if (!flag) return null;
  if (argv.some((arg) => arg.startsWith("--shard="))) throw new Error("--files-from and --shard cannot be combined");
  const file = flag.slice("--files-from=".length);
  const parsed = JSON.parse(read(file));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("--files-from must contain a JSON array of test paths");
  }
  const normalized = parsed.map(posix);
  if (new Set(normalized).size !== normalized.length) throw new Error("--files-from contains a duplicate test");
  const discovered = new Map([...groups.shared, ...groups.browser, ...groups.desktop].map((entry) => [posix(entry), entry]));
  return normalized.map((entry) => {
    const match = discovered.get(entry);
    if (!match) throw new Error(`Selected test was not discovered: ${entry}`);
    return match;
  });
}

function run(files, concurrency, timingsFile) {
  if (!files.length) return 0;
  const reporters = timingsFile
    ? ["--test-reporter=spec", "--test-reporter-destination=stdout",
      `--test-reporter=${pathToFileURL(join(here, "test-timings.mjs")).href}`, `--test-reporter-destination=${timingsFile}`]
    : [];
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...reporters, ...files], { stdio: "inherit" });
  return testProcessStatus(result, files);
}

/** Turn an otherwise silent worker death into a named, actionable CI failure. */
export function testProcessStatus(result, files, report = console.error) {
  if (typeof result.status === "number") return result.status;
  const reason = result.error
    ? `could not start: ${result.error.message}`
    : result.signal
      ? `was terminated by ${result.signal}`
      : "ended without an exit status or signal";
  report(`[test-runner] The test worker ${reason}. Assigned files:\n${files.map(posix).join("\n")}`);
  return 1;
}

function mergeTimings(target, parts) {
  const merged = {};
  for (const part of parts.filter((file) => existsSync(file))) {
    Object.assign(merged, JSON.parse(readFileSync(part, "utf8")));
    rmSync(part);
  }
  writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { index, total } = parseShard(argv);
  const groups = testGroups();
  const explicit = parseFilesFrom(argv, groups);
  const mine = new Set(explicit ?? shards([...groups.shared, ...groups.browser, ...groups.desktop], total, loadWeights())[index]);
  const shared = groups.shared.filter((file) => mine.has(file));
  const browsers = groups.browser.filter((file) => mine.has(file));
  const apps = groups.desktop.filter((file) => mine.has(file));
  console.log(explicit
    ? `Selected ${shared.length + browsers.length + apps.length} of ${groups.shared.length + groups.browser.length + groups.desktop.length} test files.`
    : `Share ${index + 1} of ${total}: ${shared.length + browsers.length + apps.length} of ${groups.shared.length + groups.browser.length + groups.desktop.length} test files.`);
  const timings = process.env.BRANCH_TEST_TIMINGS;
  const parts = timings ? [`${timings}.shared`, `${timings}.browser`, `${timings}.desktop`] : [];
  // Every group always runs, so one red run reports every failure.
  const statuses = [run(shared, 3, parts[0]), run(browsers, 1, parts[1]), run(apps, 1, parts[2])];
  if (timings) mergeTimings(timings, parts);
  process.exitCode = statuses.some((status) => status !== 0) ? 1 : 0;
}
