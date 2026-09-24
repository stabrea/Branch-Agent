/**
 * Asking Tailscale where this computer sits on its private network: where its program is looked
 * for, and how long the answer may take.
 *
 * Branch asks `tailscale status --json` as it starts, before its door listens, so the whole check has
 * a time limit that Branch keeps itself. When it runs out, the program still running is killed
 * outright, whatever it does with a request to stop, and nothing is confirmed. The program is looked
 * for where Tailscale installs it first, and on PATH last.
 *
 * Tailscale is never run here: every program asked is a stand-in shell script in a temporary folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { makeProbeTailscale, tailscaleBudgetMs, tailscaleCandidates } from "../dist/remote/tailscale.js";
import { decideListenHere } from "../dist/listen-address.js";

/** The stand-ins are shell scripts. Each test also has an outer limit, so a failure ends rather than hangs. */
const posixOnly = { skip: process.platform === "win32" ? "the stand-in programs are shell scripts" : false, timeout: 20_000 };
/** The time limit these tests hand the check: long enough for a busy computer to start a shell script. */
const budget = 1500;
/** The address Tailscale would report as this computer's. */
const ours = "100.101.102.103";
const running = (address) => JSON.stringify({ BackendState: "Running", Self: { HostName: "desk", TailscaleIPs: [address] } });
const quoted = (text) => `'${text.replace(/'/g, "'\\''")}'`;

/** A temporary folder. Afterwards every process a stand-in wrote down in it is ended, then it is removed. */
async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-tailscale-probe-"));
  t.after(async () => {
    for (const name of (await readdir(root)).filter((entry) => entry.endsWith(".pid"))) {
      const pid = Number((await readFile(join(root, name), "utf8")).trim());
      try { if (pid > 0) process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await discardTemp(root);
  });
  return root;
}

async function standIn(root, name, script) {
  const file = join(root, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

/** What `promise` gives within `ms`, or `late` when it has not given anything by then. */
const late = Symbol("still waiting");
function within(ms, promise) {
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(late), ms); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The process id a stand-in wrote down. */
async function pidIn(file) {
  for (let tries = 0; tries < 100; tries += 1) {
    const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
    if (pid > 0) return pid;
    await pause(30);
  }
  throw new Error(`the stand-in never wrote its process id to ${file}`);
}

/** Waits for a process to be gone for good: asking after it then fails with ESRCH. */
async function gone(pid, what) {
  for (let tries = 0; tries < 100; tries += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await pause(30);
  }
  assert.fail(what);
}

/* ---------- where the program is looked for ---------- */

test("Tailscale's program is looked for where Tailscale installs it first, and on PATH last", () => {
  assert.deepEqual(tailscaleCandidates("darwin", {}), [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
    "tailscale",
  ], "on a Mac the app's own program comes first, which is the only one there with just the app installed");
  assert.deepEqual(tailscaleCandidates("linux", {}),
    ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale", "tailscale"]);
  assert.deepEqual(tailscaleCandidates("win32", { ProgramFiles: "D:\\Apps", "ProgramFiles(x86)": "D:\\Apps (x86)" }),
    ["D:\\Apps\\Tailscale\\tailscale.exe", "D:\\Apps (x86)\\Tailscale IPN\\tailscale.exe", "tailscale"],
    "Windows looks in the Program Files folders this computer names");
  // With no such folder named, or one named that is not a whole path on a drive, the usual folders.
  for (const env of [{}, { ProgramFiles: "Apps", "ProgramFiles(x86)": ".\\Apps (x86)" }])
    assert.deepEqual(tailscaleCandidates("win32", env), [
      "C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale IPN\\tailscale.exe", "tailscale",
    ]);

  const wholePath = { darwin: posix.isAbsolute, linux: posix.isAbsolute, win32: (file) => /^[a-z]:\\/i.test(file) };
  for (const [platform, isWhole] of Object.entries(wholePath)) {
    const places = tailscaleCandidates(platform, {});
    assert.equal(places.at(-1), "tailscale", `${platform}: the search of PATH comes last`);
    assert.equal(places.filter((file) => !isWhole(file)).length, 1, `${platform}: every other place is a whole path`);
  }
});

test("the whole check is given a few seconds", () => {
  assert.ok(tailscaleBudgetMs >= 1000 && tailscaleBudgetMs <= 5000, `the time limit is ${tailscaleBudgetMs} ms`);
});

test("a place with no program is passed over at once, and the first program that answers is believed", posixOnly, async (t) => {
  const root = await folder(t);
  const first = await standIn(root, "first", `echo ${quoted(running(ours))}`);
  const second = await standIn(root, "second", `echo ${quoted(running("100.99.1.2"))}`);
  const probe = makeProbeTailscale({ candidates: [join(root, "not-here"), join(root, "nor-here"), first, second], budgetMs: 10_000 });
  const started = Date.now();
  const answer = await probe();
  assert.deepEqual([answer.running, answer.address], [true, ours], answer.message);
  assert.ok(Date.now() - started < 5000, `two empty places took ${Date.now() - started} ms of the time limit`);
});

/* ---------- the time limit ---------- */

test("a Tailscale program that ignores being asked to stop is killed at the time limit, nothing is confirmed, and no other place is tried", posixOnly, async (t) => {
  const root = await folder(t);
  const pidFile = join(root, "stubborn.pid");
  const stubborn = await standIn(root, "stubborn", `trap '' TERM\necho $$ > ${quoted(pidFile)}\nexec sleep 30`);
  const next = await standIn(root, "next", `touch ${quoted(join(root, "next-ran"))}\necho ${quoted(running(ours))}`);
  const answer = await within(budget + 1000, makeProbeTailscale({ candidates: [stubborn, next], budgetMs: budget })());
  assert.notEqual(answer, late, `the check was still waiting ${budget + 1000} ms after it began`);
  assert.deepEqual([answer.running, answer.address], [false, null], "nothing is confirmed");
  assert.match(answer.message, /did not answer in time/);
  await gone(await pidIn(pidFile), "the program that ignored being asked to stop was still running after the check gave up");
  // Time enough for a place tried after the limit to have run, had one been tried.
  await pause(1000);
  const ran = await readFile(join(root, "next-ran")).then(() => true, () => false);
  assert.equal(ran, false, "a further place was tried after the time limit");
});

test("a program left holding Tailscale's output cannot keep the check waiting past its time limit", posixOnly, async (t) => {
  const root = await folder(t);
  // Leaves a program running that holds the output open, then prints an answer that would confirm
  // this computer's address. An answer is whole only once the output closes, so it never is in time.
  const leaver = await standIn(root, "leaver",
    `sleep 30 &\necho $! > ${quoted(join(root, "left-behind.pid"))}\necho ${quoted(running(ours))}`);
  const answer = await within(budget + 1000, makeProbeTailscale({ candidates: [leaver], budgetMs: budget })());
  assert.notEqual(answer, late, `the check was still waiting ${budget + 1000} ms after it began`);
  assert.deepEqual([answer.running, answer.address], [false, null], "an answer that was not whole in time confirmed nothing");
  assert.match(answer.message, /did not answer in time/);
});

test("starting Branch waits no longer than the time limit for a slow Tailscale, and its 100.64 address keeps the door on this computer", posixOnly, async (t) => {
  const root = await folder(t);
  const slow = await standIn(root, "slow", `trap '' TERM\necho $$ > ${quoted(join(root, "slow.pid"))}\nexec sleep 30`);
  const decision = await within(budget + 1000, decideListenHere({
    where: "private-network", lockdown: false, token: "a".repeat(64),
    addresses: [{ address: "127.0.0.1", internal: true }, { address: ours, internal: false }],
    tailscale: makeProbeTailscale({ candidates: [slow], budgetMs: budget }),
  }));
  assert.notEqual(decision, late, `the door was still undecided ${budget + 1000} ms later`);
  assert.equal(decision.address, "127.0.0.1");
  assert.equal(decision.beyond, false);
  assert.ok(decision.refusal?.includes(ours), `the refusal names ${ours}: ${decision.refusal}`);
  assert.match(decision.refusal, /Tailscale does not report/);
});
