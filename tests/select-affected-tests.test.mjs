import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parseNameStatus, selectImpact } from "../scripts/select-affected-tests.mjs";

const config = {
  budgetSeconds: 120,
  unknownTestSeconds: 30,
  always: ["tests/leak-guard.test.mjs"],
  ignored: ["docs/**", "**/*.md"],
  fullRequired: ["package-lock.json", ".github/workflows/**", "scripts/run-tests.mjs"],
  mappings: [
    {
      paths: ["src/remote/ssh-workspace.ts"],
      tests: ["tests/sandbox-remote.test.mjs"],
    },
    {
      paths: ["public/app.js", "public/layout.css"],
      tests: [
        "tests/calm-ui.test.mjs",
        "tests/composer-layout.test.mjs",
        "tests/composer-redraw.test.mjs",
        "tests/tool-targets-comprehensive-guard.test.mjs",
      ],
    },
  ],
};

const existing = new Set([
  "tests/leak-guard.test.mjs",
  "tests/sandbox-remote.test.mjs",
  "tests/calm-ui.test.mjs",
  "tests/composer-layout.test.mjs",
  "tests/composer-redraw.test.mjs",
  "tests/tool-targets-comprehensive-guard.test.mjs",
  "tests/new.test.mjs",
]);
const exists = (file) => existing.has(file);

test("name-status parsing preserves rename pairs and paths with spaces", () => {
  const parsed = parseNameStatus("M\0docs/a file.md\0R100\0old name.ts\0new name.ts\0D\0gone.ts\0");
  assert.deepEqual(parsed, [
    { status: "M", paths: ["docs/a file.md"] },
    { status: "R100", paths: ["old name.ts", "new name.ts"] },
    { status: "D", paths: ["gone.ts"] },
  ]);
});

test("documentation-only changes are explicitly classified without product tests", () => {
  const result = selectImpact([{ status: "M", paths: ["docs/testing.md"] }], { config, exists });
  assert.equal(result.classification, "docs-only");
  assert.deepEqual(result.tests, []);
  assert.equal(result.browserNeeded, false);
});

test("a mapped product change selects deterministic tests and always-on hygiene", () => {
  const result = selectImpact([{ status: "M", paths: ["src/remote/ssh-workspace.ts"] }], {
    config,
    exists,
    weights: { "tests/leak-guard.test.mjs": 2, "tests/sandbox-remote.test.mjs": 7 },
    browserTest: () => false,
  });
  assert.equal(result.classification, "narrow");
  assert.deepEqual(result.tests, ["tests/leak-guard.test.mjs", "tests/sandbox-remote.test.mjs"]);
  assert.equal(result.predictedSeconds, 9);
});

test("changed test files select themselves but cannot exceed the budget", () => {
  const narrow = selectImpact([{ status: "M", paths: ["tests/new.test.mjs"] }], {
    config,
    exists,
    weights: { "tests/leak-guard.test.mjs": 2, "tests/new.test.mjs": 10 },
    browserTest: () => true,
  });
  assert.equal(narrow.classification, "narrow");
  assert.equal(narrow.browserNeeded, true);
  assert.deepEqual(narrow.tests, ["tests/leak-guard.test.mjs", "tests/new.test.mjs"]);

  const over = selectImpact([{ status: "M", paths: ["tests/new.test.mjs"] }], {
    config,
    exists,
    weights: { "tests/new.test.mjs": 121 },
  });
  assert.equal(over.classification, "full-required");
  assert.match(over.reasons.join("\n"), /budget/i);
});

test("unknown product paths, empty diffs, deletes, and renames fail closed", () => {
  for (const changes of [
    [],
    [{ status: "M", paths: ["src/runtime.ts"] }],
    [{ status: "D", paths: ["src/remote/ssh-workspace.ts"] }],
    [{ status: "R100", paths: ["src/a.ts", "src/b.ts"] }],
  ]) {
    assert.equal(selectImpact(changes, { config, exists }).classification, "full-required");
  }
});

test("workflow, lockfile, and stale mappings require the exhaustive lane", () => {
  for (const file of [".github/workflows/checks.yml", "package-lock.json"]) {
    assert.equal(selectImpact([{ status: "M", paths: [file] }], { config, exists }).classification, "full-required");
  }
  const stale = selectImpact([{ status: "M", paths: ["src/remote/ssh-workspace.ts"] }], {
    config,
    exists: (file) => file !== "tests/sandbox-remote.test.mjs",
  });
  assert.equal(stale.classification, "full-required");
  assert.match(stale.reasons.join("\n"), /does not exist/i);
});

test("the checked-in impact map names only tests that still exist", () => {
  const checkedIn = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  const tests = [...checkedIn.always, ...checkedIn.mappings.flatMap((rule) => rule.tests)];
  for (const file of tests) assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, file);
});

test("panel styling and language edits have reviewed fast contracts", () => {
  const checkedIn = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  const browserTests = new Set(["tests/panels.test.mjs", "tests/grown-up-controls.test.mjs", "tests/glass-select.test.mjs", "tests/settings-grown.test.mjs"]);
  const options = { config: checkedIn, weights: {}, browserTest: (file) => browserTests.has(file) };
  const panels = selectImpact([{ status: "M", paths: ["public/panels.css"] }], options);
  assert.equal(panels.classification, "narrow");
  assert.equal(panels.browserNeeded, true);
  assert.ok(panels.tests.includes("tests/panels.test.mjs"));
  const words = selectImpact([{ status: "M", paths: ["public/locales/en.json"] }], options);
  assert.equal(words.classification, "narrow");
  assert.equal(words.browserNeeded, false);
  assert.ok(words.tests.includes("tests/locales-contract.test.mjs"));
  const settings = selectImpact([{ status: "M", paths: ["public/settings-grown.css"] }], options);
  assert.equal(settings.classification, "narrow");
  assert.equal(settings.browserNeeded, true);
  assert.deepEqual(settings.tests, ["tests/glass-select.test.mjs", "tests/grown-up-controls.test.mjs", "tests/leak-guard.test.mjs", "tests/settings-grown.test.mjs"]);
});

test("the isolated composer module has focused browser coverage inside the fast budget", () => {
  const checkedIn = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  const result = selectImpact([{ status: "M", paths: ["public/composer-grown.js"] }], {
    config: checkedIn,
    weights: { "tests/leak-guard.test.mjs": 2.327 },
  });
  assert.equal(result.classification, "narrow");
  assert.equal(result.browserNeeded, true);
  assert.deepEqual(result.tests, ["tests/composer-input-state.test.mjs", "tests/leak-guard.test.mjs"]);
  assert.ok(result.predictedSeconds < checkedIn.budgetSeconds);
});

test("calendar recurrence core has reviewed non-browser coverage inside the fast budget", () => {
  const checkedIn = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  const weights = JSON.parse(readFileSync(new URL("test-weights.json", import.meta.url), "utf8")).linux;
  const result = selectImpact([
    { status: "M", paths: ["src/recurrence.ts"] },
    { status: "M", paths: ["src/scheduler.ts"] },
    { status: "M", paths: ["src/never-break/resume.ts"] },
  ], { config: checkedIn, weights, browserTest: () => false });
  assert.equal(result.classification, "narrow");
  assert.equal(result.browserNeeded, false);
  assert.deepEqual(result.tests, [
    "tests/automation.test.mjs", "tests/leak-guard.test.mjs",
    "tests/never-break-journal.test.mjs", "tests/schedule-recurrence.test.mjs",
  ]);
  assert.ok(result.predictedSeconds < checkedIn.budgetSeconds);
});

test("recurrence slices use real weights and shared shell changes fail closed", () => {
  const checkedIn = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  const weights = JSON.parse(readFileSync(new URL("test-weights.json", import.meta.url), "utf8")).linux;
  const options = { config: checkedIn, weights };
  const cli = selectImpact([
    { status: "M", paths: ["src/schedule-cli.ts"] },
    { status: "M", paths: ["src/cli-completion.ts"] },
  ], options);
  assert.deepEqual(cli.tests, ["tests/auth-tracing-cli.test.mjs", "tests/leak-guard.test.mjs"]);
  assert.equal(cli.classification, "narrow");
  const blueprints = selectImpact([{ status: "M", paths: ["src/autonomy/blueprints.ts"] }], options);
  assert.deepEqual(blueprints.tests, ["tests/autonomy.test.mjs", "tests/leak-guard.test.mjs", "tests/schedule-recurrence.test.mjs"]);
  assert.equal(blueprints.classification, "narrow");
  const modules = selectImpact([
    { status: "M", paths: ["public/flow-editor.js"] },
    { status: "M", paths: ["public/locales/en.json"] },
    { status: "M", paths: ["public/locales/fr.json"] },
    { status: "M", paths: ["public/overview.js"] },
    { status: "M", paths: ["tests/flow-editor.test.mjs"] },
    { status: "M", paths: ["tests/p2-shell-ui.test.mjs"] },
  ], options);
  assert.equal(modules.classification, "narrow");
  assert.equal(modules.browserNeeded, true);
  assert.ok(modules.predictedSeconds < checkedIn.budgetSeconds);
  const ui = selectImpact([
    { status: "M", paths: ["public/app.js"] },
    { status: "M", paths: ["public/flow-editor.js"] },
    { status: "M", paths: ["public/index.html"] },
    { status: "M", paths: ["public/locales/en.json"] },
    { status: "M", paths: ["public/locales/fr.json"] },
    { status: "M", paths: ["public/overview.js"] },
    { status: "M", paths: ["tests/flow-editor.test.mjs"] },
    { status: "M", paths: ["tests/p2-shell-ui.test.mjs"] },
  ], options);
  assert.equal(ui.classification, "full-required");
  assert.equal(ui.browserNeeded, false);
  assert.ok(ui.predictedSeconds > checkedIn.budgetSeconds);
  assert.ok(ui.tests.includes("tests/flow-editor.test.mjs"));
  assert.ok(ui.tests.includes("tests/p2-shell-ui.test.mjs"));
});

test("the historical composer regression cannot receive a narrow green result", () => {
  const result = selectImpact([
    { status: "M", paths: ["public/app.js"] },
    { status: "M", paths: ["public/layout.css"] },
  ], {
    config,
    exists,
    weights: {
      "tests/leak-guard.test.mjs": 2,
      "tests/calm-ui.test.mjs": 119,
      "tests/composer-layout.test.mjs": 30,
      "tests/composer-redraw.test.mjs": 30,
      "tests/tool-targets-comprehensive-guard.test.mjs": 5,
    },
  });
  assert.equal(result.classification, "full-required");
  assert.ok(result.tests.includes("tests/calm-ui.test.mjs"));
  assert.ok(result.tests.includes("tests/tool-targets-comprehensive-guard.test.mjs"));
});
