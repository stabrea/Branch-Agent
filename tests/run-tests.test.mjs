import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadWeights, onlyGroups, parseFilesFrom, parseShard, shareFiles, shards, testGroups, testProcessStatus } from "../scripts/run-tests.mjs";

test("npm test isolates browser and desktop files while keeping ordinary tests together", () => {
  const listing = {
    tests: ["desktop.test.mjs", "desktop-export.test.mjs", "memory-ui.test.mjs", "places.mjs", "mac2-desktop-ui.test.mjs"],
    [join("packages", "sdk", "test")]: ["client.test.mjs"],
  };
  const groups = testGroups((folder) => listing[folder], (file) =>
    /(?:mac2-desktop-ui|memory-ui)/.test(file) ? 'import { chromium } from "playwright";' : "");
  assert.deepEqual(groups.desktop, [join("tests", "desktop-export.test.mjs"), join("tests", "desktop.test.mjs")]);
  assert.deepEqual(groups.browser, [join("tests", "mac2-desktop-ui.test.mjs"), join("tests", "memory-ui.test.mjs")]);
  assert.deepEqual(groups.shared, [join("packages", "sdk", "test", "client.test.mjs")]);
  // The real folders: the four desktop files, and none of them among the rest.
  const real = testGroups();
  assert.deepEqual(real.desktop.map((file) => file.replace(/\\/g, "/")),
    ["tests/desktop-export.test.mjs", "tests/desktop-identity.test.mjs", "tests/desktop-settings.test.mjs", "tests/desktop-window.test.mjs", "tests/desktop.test.mjs"]);
  assert.equal(real.shared.some((file) => /^tests[\\/]desktop/.test(file)), false);
  assert.ok(real.browser.includes(join("tests", "glass-select.test.mjs")));
  assert.ok(real.browser.includes(join("tests", "settings-grown-1.test.mjs")));
  assert.equal(real.shared.some((file) => real.browser.includes(file)), false);
  assert.ok(real.shared.includes(join("tests", "run-tests.test.mjs")));
});

test("the shares the build machines run cover every test file exactly once, for any number of shares", () => {
  const groups = testGroups(), { shared, browser, desktop } = groups;
  const all = [...shared, ...browser, ...desktop];
  for (const platform of ["win32", "darwin", "linux", "unmeasured"]) {
    for (const total of [1, 2, 3, 4, 5, 6, 8]) {
      const shares = Array.from({ length: total }, (_, index) => shareFiles(groups, index, total, loadWeights(platform)));
      assert.equal(shares.length, total);
      const seen = shares.flat();
      assert.equal(seen.length, all.length, `${platform} ${total}: a file ran twice or not at all`);
      assert.deepEqual([...seen].sort(), [...all].sort());
    }
  }
});

test("every share gets an even part of the one-at-a-time files, not whatever the three-at-a-time ones leave (Q38)", () => {
  const file = (name) => join("tests", `${name}.test.mjs`);
  // One long three-at-a-time file fills one share, so packed together both browser files land on the other.
  const groups = { shared: ["heavy", "s2", "s3", "s4"].map(file), browser: ["b1", "b2"].map(file), desktop: [] };
  const weight = { heavy: 300, s2: 100, s3: 100, s4: 100, b1: 100, b2: 100 };
  const weights = Object.fromEntries(Object.entries(weight).map(([name, seconds]) => [`tests/${name}.test.mjs`, seconds]));
  const browsersIn = (share) => share.filter((f) => groups.browser.includes(f)).length;
  assert.deepEqual([0, 1].map((index) => browsersIn(shareFiles(groups, index, 2, weights))), [1, 1]);
  // The control: packed together, one share draws both, and their minutes run end to end.
  assert.deepEqual(shards([...groups.shared, ...groups.browser], 2, weights).map(browsersIn).sort(), [0, 2]);
});

test("shares are packed by measured time, not by counting files", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => join("tests", `${name}.test.mjs`));
  const weights = { "tests/a.test.mjs": 400, "tests/b.test.mjs": 100, "tests/c.test.mjs": 100, "tests/d.test.mjs": 100, "tests/e.test.mjs": 100 };
  const shares = shards(files, 2, weights);
  assert.deepEqual(shares[0], [files[0]]);
  assert.deepEqual(shares[1], files.slice(1));
  // A file never measured counts as the median, and the order stays the same from run to run.
  assert.deepEqual(shards([...files, join("tests", "new.test.mjs")], 2, weights), shards([...files, join("tests", "new.test.mjs")], 2, weights));
});

test("--shard names one share of the whole, and anything else is refused", () => {
  assert.deepEqual(parseShard([]), { index: 0, total: 1 });
  assert.deepEqual(parseShard(["--shard=2/5"]), { index: 1, total: 5 });
  for (const bad of ["--shard=0/5", "--shard=6/5", "--shard=1/0", "--shard=x"]) assert.throws(() => parseShard([bad]));
});

test("--files-from selects an explicit discovered subset and rejects stale or duplicate entries", () => {
  const groups = { shared: [join("tests", "a.test.mjs")], browser: [join("tests", "b.test.mjs")], desktop: [] };
  const read = () => JSON.stringify(["tests/b.test.mjs"]);
  assert.deepEqual(parseFilesFrom(["--files-from=selected.json"], groups, read), [join("tests", "b.test.mjs")]);
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups,
    () => JSON.stringify(["tests/missing.test.mjs"])), /not discovered/);
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups,
    () => JSON.stringify(["tests/a.test.mjs", "tests/a.test.mjs"])), /duplicate/);
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups, () => "{}"), /JSON array/);
});

test("a renamed or new file still runs, and a weight for a file that is gone changes nothing", () => {
  // The weights are only ever a guide to packing. A file renamed since they were measured is simply
  // unmeasured, so it counts as the median and lands in a share like any other; the old name is
  // never looked up. So stale weights cannot drop a file, and nobody has to refresh them to stay green.
  const files = ["a", "renamed", "c"].map((name) => join("tests", `${name}.test.mjs`));
  const weights = { "tests/a.test.mjs": 300, "tests/old-name.test.mjs": 900, "tests/c.test.mjs": 10 };
  for (const total of [1, 2, 3, 4]) {
    const shares = shards(files, total, weights);
    assert.deepEqual(shares.flat().sort(), [...files].sort(), `${total}: every file once, the stale name nowhere`);
  }
});

/** The shares the pick job lays out when the owner's computers have so many idle runners, from its own script. */
function sharesFor(workflow, legion, macmini, screens = "on", wsl = 0) {
  const script = workflow.jobs.pick.steps[0].run;
  const body = /node -e '([\s\S]*?)\n\s*' "/.exec(script)[1];
  const keepOff = /'(\^tests\/[^']*)'\s*$/.exec(script.trim())[1];
  const output = join(mkdtempSync(join(tmpdir(), "branch-pick-")), "out");
  const run = spawnSync(process.execPath, ["-e", body, String(legion), String(macmini), String(wsl), screens, keepOff], { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return { keepOff, rows: JSON.parse(readFileSync(output, "utf8").replace(/^matrix=/, "")).include };
}

test("the build machines run every share, 1 to N, on every system, so no share of the suite is dropped", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));
  for (const [legion, macmini, wsl] of [[0, 0, 0], [3, 0, 0], [0, 2, 0], [3, 2, 0], [1, 1, 0], [0, 2, 4], [0, 0, 2]]) {
    const { keepOff, rows } = sharesFor(workflow, legion, macmini, "on", wsl);
    assert.deepEqual([...new Set(rows.map((row) => row.os))].sort(), ["linux", "macos", "windows"], `${legion}/${macmini}: every system`);
    // Shares that split the suite between them: grouped by the machines they run on; each group covers 1..N.
    const groups = new Map();
    for (const row of rows.filter((row) => !row.only)) {
      const key = `${row.os} ${JSON.stringify(row.labels)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const [key, shares] of groups) {
      const total = shares[0].total;
      assert.ok(shares.every((share) => share.total === total), `${key}: every share names the same total`);
      assert.deepEqual(shares.map((share) => share.shard).sort((x, y) => x - y), Array.from({ length: total }, (_, i) => i + 1), `${key}: shares 1..${total}`);
    }
    // What an owner's computer leaves out, a hosted share of the same system runs, so nothing is dropped.
    for (const own of rows.filter((row) => row.own)) {
      assert.equal(own.exclude, keepOff, `${own.os}: the owner's computer leaves out exactly the desktop and uninstall tests`);
      assert.ok(rows.some((row) => row.os === own.os && row.only === keepOff && !row.own), `${own.os}: a hosted share runs what it leaves out`);
    }
    assert.equal(rows.filter((row) => row.own).length, legion + macmini + wsl, `${legion}/${macmini}/${wsl}: one share per idle runner`);
  }
  assert.deepEqual(workflow.jobs.verify.needs, ["test", "package"], "verify waits for every share and every package");
});

test("a test worker killed without an exit code names its signal and assigned files", () => {
  const messages = [];
  assert.equal(testProcessStatus({ status: null, signal: "SIGKILL" }, [join("tests", "slow.test.mjs")],
    (message) => messages.push(message)), 1);
  assert.match(messages[0], /terminated by SIGKILL/);
  assert.match(messages[0], /tests\/slow\.test\.mjs/);
  assert.equal(testProcessStatus({ status: 7, signal: null }, [], () => assert.fail("ordinary exits are silent")), 7);
});

test("the pick step is a shell script bash can read: nothing inside its quoted node program ends the quotes", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));
  const check = spawnSync("bash", ["-n"], { input: workflow.jobs.pick.steps[0].run, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("a train's Windows shares leave the browser files to Linux and macOS, and every share still gets a browser", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));
  for (const [legion, macmini] of [[0, 0], [3, 0], [0, 2]]) {
    const { rows } = sharesFor(workflow, legion, macmini, "off");
    for (const row of rows) {
      if (row.os === "windows") assert.equal(row.groups, "shared,desktop", `${legion}/${macmini}: ${JSON.stringify(row)}`);
      else assert.equal(row.groups, undefined, `${row.os} still runs every group`);
    }
    assert.ok(rows.some((row) => row.os === "linux") && rows.some((row) => row.os === "macos"), "the browser files still run on two systems");
    assert.ok(sharesFor(workflow, legion, macmini, "on").rows.every((row) => row.groups === undefined), "with screens on, Windows runs every group");
  }
  const steps = workflow.jobs.test.steps;
  assert.equal(steps.find((step) => /playwright install/.test(step.run ?? "")).if, undefined, "no share goes without a browser");
  assert.match(workflow.jobs.pick.steps[0].run, /refs\/heads\/main\|refs\/heads\/mac\/cross-platform\) echo on/, "the trunks keep the screens on Windows");
});

test("only the named test groups run, the rest left empty, and a misspelt group is refused", () => {
  const groups = { shared: ["tests/a.test.mjs"], browser: ["tests/b.test.mjs"], desktop: ["tests/desktop.test.mjs"] };
  assert.equal(onlyGroups(groups, undefined), groups);
  assert.deepEqual(onlyGroups(groups, "shared,desktop"), { shared: ["tests/a.test.mjs"], browser: [], desktop: ["tests/desktop.test.mjs"] });
  assert.throws(() => onlyGroups(groups, "shared,screens"), /Unknown test group "screens"/);
});
