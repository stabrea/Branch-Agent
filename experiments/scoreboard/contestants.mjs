/**
 * How each contestant is given one task, and how its answer is read back.
 *
 * Every contestant gets the same prompt, the same folder, the same endpoint, the same model and the
 * same wall-clock deadline. What differs is only what the program itself is — which is the point.
 *
 * Two things are deliberately *not* equalised, because they cannot be:
 *
 * - **The tool surface.** Branch, OpenClaw and Hermes ship different built-in tools and different
 *   sandboxes. Each contestant records its own below, and the scoreboard prints it next to the
 *   score, because a task can be won by tooling rather than by judgement.
 * - **Each program's own internal limits** — how many rounds it will take, how big a reply it will
 *   ask for. Forcing these to one number would mean running three programs none of their owners
 *   ship. They are recorded instead.
 *
 * Every contestant is pointed at its own config and state directory under /workspace/bench, so none
 * of them reads or writes the owner's real settings, and none starts with the owner's history.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const BENCH = "/workspace/bench";

/** Branch's own record of its edit tools being refused, read from the run's database afterwards. */
async function branchEditCounts(dataDir) {
  const file = join(dataDir ?? "", "branch.sqlite");
  if (!dataDir || !existsSync(file)) return { failedEdits: null, edits: null };
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    const count = (kind) => db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE kind = ? AND json_extract(data, '$.name') IN ('files.edit','files.patch','files.write','code.patch','code.change_set')",
    ).get(kind).n;
    const result = { failedEdits: count("tool.failed"), edits: count("tool.started") };
    db.close();
    return result;
  } catch { return { failedEdits: null, edits: null }; }
}

/** The last line of stdout that parses as a JSON object, for programs that also log to stdout. */
function lastJson(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  // Some of them pretty-print, so fall back to the last balanced object in the whole stream.
  const start = text.lastIndexOf("\n{");
  if (start >= 0) { try { return JSON.parse(text.slice(start)); } catch { /* fall through */ } }
  try { return JSON.parse(text); } catch { return null; }
}

/** Shared by both Branch rows: the fixed build and the trunk build differ only in where they live. */
function branchContestant({ id, name, root, note, scriptsOn = false }) {
  return {
    id, name, root, note,
    toolSurface: scriptsOn
      ? "Branch's own built-in tools with the owner's \"run scripts\" switch ON (ships off), its workspace confined to BRANCH_WORKSPACE"
      : "Branch's own built-in tools, its workspace confined to BRANCH_WORKSPACE",
    limitsNote: "reply ceiling, run deadline and context window as that build ships them; up to 60 steps",
    invoke: ({ dir, prompt, model, endpoint, dataDir, timeoutSec }) => ({
      file: scriptsOn ? "/bin/sh" : process.execPath,
      // The same deadline every contestant gets, in the milliseconds this flag wants. The trunk
      // build is given it too and ignores it — see FINDINGS.md, F2 — which is the point of that row.
      args: scriptsOn
        ? ["-c", `"${process.execPath}" experiments/coding-bench/scripts-on.mjs && exec "${process.execPath}" dist/cli.js run --timeout ${timeoutSec * 1000} "$0"`, prompt]
        : ["dist/cli.js", "run", "--timeout", String(timeoutSec * 1000), prompt],
      cwd: root,
      env: {
        BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: dir,
        BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: endpoint, BRANCH_MODEL: model,
        BRANCH_API_KEY: "ollama-local-no-key",
      },
    }),
    parse: async ({ stdout, dataDir }) => {
      const edits = await branchEditCounts(dataDir);
      const json = lastJson(stdout);
      if (!json) return { answer: "", calls: null, usage: null, error: "Branch printed nothing that parsed as JSON", ...edits };
      const usage = json.usage ?? {};
      const reported = (usage.reports ?? 0) > 0 && (usage.reportedInput ?? 0) + (usage.reportedOutput ?? 0) > 0;
      // A run that did not complete has no answer: what Branch puts in `output` then is the reason
      // it stopped ("fetch failed", "No response for 60 seconds"). Handing that to a check as an
      // answer scores a transport failure as a wrong answer, and hides it from the harness's own
      // retry, which reads only the error. So a failed run's message goes where it belongs.
      const finished = json.run?.status === "completed";
      return {
        answer: finished ? String(json.run?.output ?? "") : "",
        calls: usage.attempts ?? null,
        usage: {
          input: reported ? usage.reportedInput ?? 0 : usage.estimatedInput ?? 0,
          output: reported ? usage.reportedOutput ?? 0 : usage.estimatedOutput ?? 0,
          basis: reported ? "reported" : "estimated",
        },
        // Branch says so itself; the harness does not have to guess from the text.
        error: finished ? null : `run status ${json.run?.status ?? "unknown"}: ${String(json.run?.output ?? "").slice(0, 300)}`,
        incompleteCalls: usage.incompleteCalls ?? 0,
        ...edits,
      };
    },
  };
}

export const contestants = [
  branchContestant({
    id: "branch",
    name: "Branch Agent 0.17.0 (+ the reply-ceiling fix)",
    root: `${BENCH}/branch`,
    note: "the b23532d9 tree with one line changed: the per-reply ceiling raised from 2048 to 8192, "
      + "because at 2048 a reasoning model never gets past its own thinking. See FINDINGS.md, F1.",
  }),
  branchContestant({
    id: "branch-trunk",
    name: "Branch Agent 0.17.0 (as on mac7/eval-honesty, b23532d9)",
    root: `${BENCH}/branch-trunk`,
    note: "unmodified. Run once over the task set to show what the fix above is a fix for — a "
      + "demonstration, not a contestant with a spread.",
  }),
  {
    id: "openclaw",
    name: "OpenClaw 2026.9.4 (3a9d69d)",
    toolSurface: "OpenClaw's embedded agent, --isolated (its ambient config ignored), tools rooted at --cwd",
    limitsNote: "exec defaults; --timeout passed to match the harness deadline",
    invoke: ({ dir, prompt, model, timeoutSec, dataDir }) => ({
      file: `${BENCH}/openclaw/node_modules/.bin/openclaw`,
      args: ["agent", "exec", "--isolated", "--auth-env-only", "--json",
        "--model", `ollama/${model}`, "--cwd", dir, "--state-dir", dataDir,
        "--timeout", String(timeoutSec), prompt],
      cwd: dir,
      env: {
        // All four of these, not just the config one. `--isolated` isolates the *config*; without
        // OPENCLAW_HOME and OPENCLAW_STATE_DIR the program still opens the owner's own
        // ~/.openclaw/state/openclaw.sqlite and writes to their plugin-skills folder, which was
        // observed happening before these were set. A contestant must leave the owner's
        // installation exactly as it found it, and must not inherit the owner's history as a start.
        OPENCLAW_HOME: `${BENCH}/openclaw/home`,
        OPENCLAW_STATE_DIR: dataDir,
        OPENCLAW_CONFIG_DIR: `${BENCH}/openclaw/config`,
        // Ollama needs no key; OpenClaw refuses to register the provider without one present.
        OLLAMA_API_KEY: "ollama-local-no-key",
        OLLAMA_HOST: "http://127.0.0.1:11434",
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      },
    }),
    parse: ({ stdout }) => {
      const json = lastJson(stdout.split("\n").filter((line) => !line.startsWith("[")).join("\n"));
      if (!json) return { answer: "", calls: null, usage: null, error: "OpenClaw printed no JSON envelope" };
      const usage = json.usage ?? {};
      return {
        answer: String(json.final ?? ""),
        calls: json.assistantTurns ?? null,
        // OpenClaw prints the provider's own counts in its envelope; nothing here is estimated.
        usage: { input: usage.input ?? 0, output: usage.output ?? 0, basis: "reported" },
        error: json.ok ? null : (json.error?.message ?? `status ${json.status}`),
      };
    },
  },
  {
    id: "hermes",
    name: "Hermes Agent v2026.9.14 (345cd2b0)",
    toolSurface: "Hermes's AIAgent with its default toolsets, run in the task folder as its cwd",
    limitsNote: "max_iterations 12; Hermes refuses any model whose window is under 64K, which is why "
      + "the whole board runs at a 65536-token window",
    invoke: ({ dir, prompt, model, endpoint, dataDir }) => ({
      file: `${BENCH}/hermes-venv/bin/python`,
      args: [`${BENCH}/hermes-driver.py`],
      cwd: dir,
      stdin: prompt,
      env: {
        HERMES_HOME: dataDir, HERMES_SRC: `${BENCH}/hermes`,
        BENCH_ENDPOINT: endpoint, BENCH_MODEL: model,
        BENCH_API_KEY: "ollama-local-no-key", BENCH_MAX_ROUNDS: "12",
      },
    }),
    parse: ({ stdout }) => {
      const marker = stdout.lastIndexOf("__HERMES_RESULT__");
      if (marker < 0) return { answer: "", calls: null, usage: null, error: "the Hermes driver printed no result line" };
      let json;
      try { json = JSON.parse(stdout.slice(marker + "__HERMES_RESULT__".length).trim()); }
      catch (error) { return { answer: "", calls: null, usage: null, error: `unreadable Hermes result: ${error.message}` }; }
      const usage = json.usage ?? {};
      return {
        answer: String(json.final ?? ""),
        calls: json.turns ?? null,
        usage: Object.keys(usage).length
          ? { input: usage.input ?? 0, output: usage.output ?? 0, basis: "reported" }
          : null,
        error: json.ok ? null : (json.error ?? "the Hermes turn did not complete"),
      };
    },
  },
];

/** Codex CLI, pointed at the same Ollama through its own `--oss` provider. */
contestants.push({
  id: "codex",
  name: "Codex CLI 0.155.1 (--oss, Ollama provider)",
  toolSurface: "Codex's own shell + apply_patch tools, sandbox workspace-write, approvals never (exec mode), CODEX_HOME inside /workspace/bench",
  limitsNote: "Codex has no metadata for a local model and says it falls back to defaults",
  invoke: ({ dir, prompt, model }) => ({
    file: `${BENCH}/codex/node_modules/.bin/codex`,
    args: ["exec", "--oss", "--local-provider", "ollama", "-m", model.includes(":") ? model : `${model}:latest`,
      "--json", "--skip-git-repo-check", "-s", "workspace-write", "-C", dir, prompt],
    cwd: dir,
    env: { CODEX_HOME: `${BENCH}/codex/home`, CODEX_OSS_BASE_URL: "http://127.0.0.1:11434/v1" },
  }),
  parse: ({ stdout }) => {
    let answer = "", error = null, input = 0, output = 0, turns = 0, edits = 0, failedEdits = 0, seen = false;
    for (const line of stdout.split("\n")) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      seen = true;
      const item = event.item ?? {};
      if (event.type === "turn.completed") { turns++; input += event.usage?.input_tokens ?? 0; output += event.usage?.output_tokens ?? 0; }
      if (event.type === "turn.failed") error = event.error?.message ?? "turn failed";
      if (event.type === "error") error = event.message ?? "error";
      if (event.type === "item.completed" && item.type === "agent_message") answer = String(item.text ?? "");
      if (event.type === "item.completed" && item.type === "file_change") { edits++; if (item.status === "failed") failedEdits++; }
    }
    if (!seen) return { answer: "", calls: null, usage: null, error: "Codex printed no JSON events" };
    return { answer, calls: turns, usage: { input, output, basis: "reported" }, error, edits, failedEdits };
  },
});

// The coding bench compares Branch with itself before and after the fixes on mac7/coding-gap.
contestants.push(
  branchContestant({ id: "branch-before", name: "Branch (mac/cross-platform 36ee8abb)", root: `${BENCH}/cg/before`,
    note: "trunk as it stood when the coding bench was written, unmodified" }),
  branchContestant({ id: "branch-after", name: "Branch (mac7/coding-gap)", root: `${BENCH}/cg/after`,
    note: "the same tree with the coding-gap fixes; see docs/agents/coding-bench.md" }),
  branchContestant({ id: "branch-after-scripts", name: "Branch (mac7/coding-gap, run-scripts switch on)", root: `${BENCH}/cg/after`,
    note: "branch-after with the one owner switch that ships off turned on, so it can run the tests", scriptsOn: true }),
);

export const contestantById = Object.fromEntries(contestants.map((one) => [one.id, one]));
