import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function glob(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

function matches(file, patterns) {
  return patterns.some((pattern) => glob(pattern).test(file));
}

function safePath(file) {
  return typeof file === "string" && file.length > 0 && !file.includes("\\") && !file.startsWith("/")
    && !file.split("/").includes("..");
}

/** Parse `git diff --name-status -z` without treating file names as shell text. */
export function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/.test(status)) throw new Error(`Unsupported git status: ${status || "<empty>"}`);
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (index + count > fields.length) throw new Error(`Incomplete git status record: ${status}`);
    changes.push({ status, paths: fields.slice(index, index + count) });
    index += count;
  }
  return changes;
}

function defaultBrowserTest(file) {
  const source = readFileSync(join(root, file), "utf8");
  return /from\s+["'](?:playwright|electron)["']|import\(\s*["'](?:playwright|electron)["']\s*\)|require\(["']electron["']\)/.test(source);
}

function requireFull(state, reason) {
  state.fullRequired = true;
  state.reasons.push(reason);
}

function inspectChange(change, config, state) {
  if (!change?.paths?.length || change.paths.some((file) => !safePath(file))) {
    requireFull(state, "The diff contains an invalid or unsafe path.");
    return;
  }
  for (const file of change.paths) state.changedFiles.add(file);
  if (/^[DRC]/.test(change.status)) {
    requireFull(state, `${change.status} changes require exhaustive validation: ${change.paths.join(" -> ")}`);
    return;
  }
  const file = change.paths.at(-1);
  if (matches(file, config.fullRequired)) {
    state.productChange = true;
    requireFull(state, `Exhaustive-only path changed: ${file}`);
    return;
  }
  if (matches(file, config.ignored)) return;
  state.productChange = true;
  if (/^(?:tests|packages\/sdk\/test)\/.*\.test\.mjs$/.test(file)) {
    state.selected.add(file);
    return;
  }
  const rules = config.mappings.filter((rule) => matches(file, rule.paths));
  if (!rules.length) {
    requireFull(state, `No reviewed test mapping exists for: ${file}`);
    return;
  }
  for (const rule of rules) for (const selected of rule.tests) state.selected.add(selected);
}

/** Select only reviewed, budgeted tests. Every uncertainty routes to the exhaustive lane. */
export function selectImpact(changes, options) {
  const { config } = options;
  const exists = options.exists ?? ((file) => existsSync(join(root, file)));
  const weights = options.weights ?? {};
  const browserTest = options.browserTest ?? defaultBrowserTest;
  const state = { reasons: [], changedFiles: new Set(), selected: new Set(), fullRequired: false, productChange: false };
  if (!changes.length) requireFull(state, "No changed files were found; refusing an empty green result.");
  for (const change of changes) inspectChange(change, config, state);
  if (state.productChange) for (const test of config.always) state.selected.add(test);
  const tests = [...state.selected].sort();
  for (const file of tests) {
    if (!safePath(file) || !exists(file)) {
      requireFull(state, `Selected test does not exist: ${file}`);
    }
  }
  const predictedSeconds = tests.reduce((total, file) => total + (weights[file] ?? config.unknownTestSeconds), 0);
  if (predictedSeconds > config.budgetSeconds) {
    requireFull(state, `Selected tests predict ${predictedSeconds}s, above the ${config.budgetSeconds}s budget.`);
  }
  const classification = state.fullRequired ? "full-required" : state.productChange ? "narrow" : "docs-only";
  const browserNeeded = classification === "narrow" && tests.some((file) => browserTest(file));
  return {
    classification,
    reasons: [...new Set(state.reasons)].sort(),
    changedFiles: [...state.changedFiles].sort(),
    tests,
    browserNeeded,
    predictedSeconds,
  };
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function runCli() {
  const base = argument("base");
  const head = argument("head");
  const output = argument("output") ?? "selected-tests.json";
  if (!base || !head || !/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error("Expected --base=<40-hex-sha> and --head=<40-hex-sha>.");
  }
  const config = JSON.parse(readFileSync(join(root, "tests", "test-impact.json"), "utf8"));
  const weights = JSON.parse(readFileSync(join(root, "tests", "test-weights.json"), "utf8")).linux ?? {};
  const diff = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", base, head], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = selectImpact(parseNameStatus(diff), { config, weights });
  writeFileSync(resolve(root, output), `${JSON.stringify(result.tests, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `classification=${result.classification}\nbrowser_needed=${result.browserNeeded}\npredicted_seconds=${result.predictedSeconds}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
