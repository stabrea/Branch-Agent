/**
 * The five benchmark formats Branch Agent can read from files on this computer. Each one reads the
 * published shape unchanged, so the owner downloads the dataset once, puts it in a folder, and
 * nothing is ever fetched by the program itself.
 *
 * SWE-bench needs the repository it names to be on this computer already; it says exactly where to
 * put it rather than cloning from the internet. GAIA, the code benchmarks and terminal-bench read
 * their own files. Web tasks are run against pages saved next to the dataset; a task that needs a
 * live website is refused by name, with the reason.
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parsePatch, applyHunks } from "./patch.js";
import { normaliseAnswer } from "./evaluation-scorers.js";
import { findBash, findGit, runBenchmarkCommand } from "./benchmark-shell.js";
import {
  field, judgeFail, judgePass, jsonlFiles, readJsonl, safeId, withinFolder,
  type BenchmarkAdapter, type BenchmarkJudgement, type BenchmarkResult, type BenchmarkTask, type PreparedTask,
} from "./benchmarks.js";

const exists = async (path: string): Promise<boolean> => !!(await stat(path).catch(() => null));
const prepared = (workspace: string, prompt: string, files: string[] = [], refusal: string | null = null): PreparedTask =>
  ({ workspace, prompt, files, refusal });

/** Every task in every `.jsonl` file of a folder, turned into tasks by one record reader. */
async function fromJsonl(
  directory: string, toTask: (raw: Record<string, unknown>, index: number) => BenchmarkTask | null,
): Promise<BenchmarkTask[]> {
  const tasks: BenchmarkTask[] = [];
  for (const path of await jsonlFiles(directory))
    for (const raw of await readJsonl(path)) {
      const task = toTask(raw, tasks.length);
      if (task) tasks.push(task);
    }
  return tasks;
}

/* ------------------------------------------------------------------ GAIA */

/**
 * GAIA: one `metadata.jsonl` of questions, some with a file attached, judged by exact match once
 * case, spacing and trailing punctuation are taken off — the benchmark's own rule.
 */
export const gaiaAdapter: BenchmarkAdapter = {
  id: "gaia", name: "GAIA", runsPrograms: false, format: "metadata.jsonl with Question, Final answer and file_name",
  layout: "<folder>/metadata.jsonl, and any attached files beside it",
  discover: (directory) => fromJsonl(directory, (raw, index) => {
    const question = field(raw, "Question", "question");
    if (!question) return null;
    const id = field(raw, "task_id", "id");
    return {
      id: safeId(id, `gaia-${index + 1}`), prompt: question,
      expected: field(raw, "Final answer", "final_answer", "answer") || undefined,
      tags: ["gaia", `level-${field(raw, "Level", "level") || "?"}`], raw,
    };
  }),
  async prepare(task, into, directory) {
    await mkdir(into, { recursive: true });
    const attachment = field(task.raw, "file_name", "file");
    if (!attachment) return prepared(into, task.prompt);
    const source = withinFolder(directory, attachment), destination = withinFolder(into, attachment);
    if (!source || !destination)
      return prepared(into, task.prompt, [], `This question names the file ${attachment}, which points outside ${directory}. A dataset may only name files inside its own folder.`);
    if (!(await exists(source)))
      return prepared(into, task.prompt, [], `This question comes with the file ${attachment}, and it is not in ${directory}. Put it there and run again.`);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    return prepared(into, `${task.prompt}\n\nThe file ${attachment} is in your workspace.`, [attachment]);
  },
  async judge(task, result) {
    if (!task.expected) return judgeFail("This question has no reference answer in the dataset, so it cannot be marked");
    const given = normaliseAnswer(lastLine(result.answer));
    return given === normaliseAnswer(task.expected)
      ? judgePass() : judgeFail(`The answer was "${given.slice(0, 120)}" and "${normaliseAnswer(task.expected).slice(0, 120)}" was expected`);
  },
};

/** GAIA answers are the last line of the reply; everything above it is the working. */
function lastLine(answer: string): string {
  const lines = answer.split("\n").map((line) => line.trim()).filter(Boolean);
  const final = lines.reverse().find((line) => /final answer\s*[:\-]/i.test(line));
  return final ? final.replace(/.*final answer\s*[:\-]\s*/i, "") : lines[0] ?? "";
}

/* ------------------------------------------------- APPS / MBPP / HumanEval */

/**
 * Code benchmarks: a JSONL of a prompt, the name of the thing to write, and the tests that decide
 * it. The tests are run as a program in the workspace, under the ordinary command limits.
 */
export const codeTasksAdapter: BenchmarkAdapter = {
  id: "code-tasks", name: "Code tasks (APPS, MBPP, HumanEval)", runsPrograms: true,
  format: "JSONL with prompt, entry_point, test (or test_list) and an optional language",
  layout: "<folder>/*.jsonl",
  discover: (directory) => fromJsonl(directory, (raw, index) => {
    const prompt = field(raw, "prompt", "text", "problem");
    if (!prompt) return null;
    const language = field(raw, "language") || "javascript";
    const entry = field(raw, "entry_point", "entry") || "solution";
    return {
      id: safeId(field(raw, "task_id", "id"), `code-${index + 1}`),
      prompt: `${prompt}\n\nWrite your answer to the file ${solutionFile(language)} in the workspace, exporting ${entry}.`,
      expected: field(raw, "canonical_solution") || undefined,
      tags: ["code", language], raw: { ...raw, language, entry_point: entry },
    };
  }),
  async prepare(task, into) {
    await mkdir(into, { recursive: true });
    const language = field(task.raw, "language");
    const stub = language === "python" ? "# write your answer here\n" : "// write your answer here\nexport {};\n";
    await writeFile(join(into, solutionFile(language)), stub);
    return prepared(into, task.prompt, [solutionFile(language)]);
  },
  judge: (task, result) => runCodeTests(task, result.workspace),
};

const solutionFile = (language: string): string => (language === "python" ? "solution.py" : "solution.mjs");

/** Writes the benchmark's tests beside the answer and runs them; a clean exit is a pass. */
async function runCodeTests(task: BenchmarkTask, workspace: string): Promise<BenchmarkJudgement> {
  const language = field(task.raw, "language");
  const list = Array.isArray(task.raw.test_list) ? (task.raw.test_list as unknown[]).map(String) : [];
  const body = field(task.raw, "test", "tests") || list.join("\n");
  if (!body) return judgeFail("This task ships no tests, so it cannot be marked");
  if (language === "python") return judgeFail("This is a Python task. Branch Agent runs the JavaScript ones; point at a JavaScript split, or run the Python tests yourself.");
  const file = "benchmark-tests.mjs";
  await writeFile(join(workspace, file), body);
  const outcome = await runBenchmarkCommand(process.execPath, [file], workspace);
  if (outcome.status !== "completed")
    return judgeFail(`The tests did not finish (${outcome.status})`, outcome.stderr.slice(0, 300));
  return outcome.exitCode === 0 ? judgePass() : judgeFail(`The tests failed`, (outcome.stderr || outcome.stdout).slice(0, 300));
}

/* ------------------------------------------------------------- SWE-bench */

/**
 * SWE-bench Lite and Verified: real bug reports from real repositories. The repository is never
 * fetched; it has to be in the benchmark folder's `repos` already, and the task is refused by name
 * when it is not, saying where to put it. The copy the assistant works in is a copy, so the
 * owner's own checkout is never touched.
 */
export const sweBenchAdapter: BenchmarkAdapter = {
  id: "swe-bench", name: "SWE-bench (Lite and Verified)", runsPrograms: true,
  format: "JSONL with instance_id, repo, base_commit, problem_statement and test_patch",
  layout: "<folder>/*.jsonl, and the repositories themselves in <folder>/repos/<owner>__<name>",
  discover: (directory) => fromJsonl(directory, (raw, index) => {
    const problem = field(raw, "problem_statement", "problem");
    if (!problem) return null;
    return {
      id: safeId(field(raw, "instance_id", "id"), `swe-${index + 1}`),
      prompt: `Fix this problem in the repository in your workspace. Change the source, not the tests.\n\n${problem}`,
      tags: ["swe-bench", safeId(field(raw, "repo"), "repo")], raw,
    };
  }),
  async prepare(task, into, directory) {
    const repo = field(task.raw, "repo");
    const source = withinFolder(join(directory, "repos"), repo.replace(/\//g, "__"));
    if (!source)
      return prepared(into, task.prompt, [], `This instance names the repository ${repo}, which points outside ${join(directory, "repos")}. A dataset may only name repositories inside its own folder.`);
    if (!(await exists(source)))
      return prepared(into, task.prompt, [], `The repository ${repo} is not on this computer. Put a copy at ${source} and run again. Nothing is downloaded for you.`);
    await mkdir(dirname(into), { recursive: true });
    await cp(source, into, { recursive: true });
    const commit = field(task.raw, "base_commit");
    const checkout = commit && (await exists(join(into, ".git")))
      ? await runBenchmarkCommand("git", ["checkout", "--force", commit], into) : null;
    const note = checkout && checkout.exitCode !== 0 ? `\n\nNote: this copy could not be moved to ${commit.slice(0, 12)}.` : "";
    return prepared(into, task.prompt + note, ["."]);
  },
  judge: (task, result) => runSweTests(task, result.workspace),
};

/** Puts the benchmark's own tests back over the assistant's work, then runs the named tests. */
async function runSweTests(task: BenchmarkTask, workspace: string): Promise<BenchmarkJudgement> {
  const patch = field(task.raw, "test_patch");
  if (patch) {
    const problem = await applyTestPatch(workspace, patch);
    if (problem) return judgeFail(problem);
  }
  // The tests are always run by this copy of Node. A dataset never says which program to start:
  // a downloaded file must not be able to choose what runs on this computer.
  const names = [...asList(task.raw.FAIL_TO_PASS), ...asList(task.raw.PASS_TO_PASS)];
  if (!names.length) return judgeFail("This instance names no tests to run, so it cannot be marked");
  const outcome = await runBenchmarkCommand(process.execPath, ["--test", ...names], workspace);
  if (outcome.status !== "completed") return judgeFail(`The tests did not finish (${outcome.status})`, outcome.stderr.slice(0, 300));
  return outcome.exitCode === 0 ? judgePass() : judgeFail("The benchmark's tests still fail", (outcome.stderr || outcome.stdout).slice(0, 300));
}

/** SWE-bench records name their tests as a list, or as a JSON string holding one. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

/** Applies the instance's `test_patch` exactly; a hunk that does not fit is said out loud. */
async function applyTestPatch(workspace: string, patch: string): Promise<string | null> {
  let files;
  try { files = parsePatch(patch); } catch (error) { return `The instance's test patch could not be read: ${error instanceof Error ? error.message : String(error)}`; }
  for (const file of files) {
    const path = join(workspace, file.path);
    const before = file.created ? null : await readFile(path, "utf8").catch(() => null);
    try {
      const after = applyHunks(file, before);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, after);
    } catch (error) { return `The instance's test patch does not fit ${file.path}: ${error instanceof Error ? error.message : String(error)}`; }
  }
  return null;
}

/* ------------------------------------------- WebVoyager / BrowserGym style */

/**
 * Web tasks in the WebVoyager and BrowserGym shape. A task whose page has been saved next to the
 * dataset as an ordinary file is run against that saved page; a task that points at a live website
 * is refused by name, because a score against today's version of a shopping site is not a score.
 */
export const webTasksAdapter: BenchmarkAdapter = {
  id: "web-tasks", name: "Web tasks (WebVoyager, BrowserGym)", runsPrograms: false,
  format: "JSONL with id, ques (or question), web (the address) and answer; pages saved in pages/",
  layout: "<folder>/*.jsonl, and the saved pages in <folder>/pages/<name>.html",
  discover: (directory) => fromJsonl(directory, (raw, index) => {
    const question = field(raw, "ques", "question", "intent", "goal");
    if (!question) return null;
    return {
      id: safeId(field(raw, "id", "task_id"), `web-${index + 1}`), prompt: question,
      expected: field(raw, "answer", "eval_answer") || undefined,
      tags: ["web", safeId(field(raw, "web_name", "site"), "site")], raw,
    };
  }),
  async prepare(task, into, directory) {
    await mkdir(into, { recursive: true });
    const page = field(task.raw, "page", "local_page") || `${task.id}.html`;
    const source = withinFolder(join(directory, "pages"), page), destination = withinFolder(into, page);
    if (!source || !destination)
      return prepared(into, task.prompt, [], `This task names the page ${page}, which points outside ${join(directory, "pages")}. A dataset may only name files inside its own folder.`);
    if (!(await exists(source)))
      return prepared(into, task.prompt, [], `This task needs the website ${field(task.raw, "web") || "it names"}, which is not saved here. Save the page as ${source} to run it, or leave it out: Branch Agent never opens a live benchmark site.`);
    await cp(source, join(into, page));
    return prepared(into, `${task.prompt}\n\nThe page is saved in your workspace as ${page}. Read it from there.`, [page]);
  },
  async judge(task, result) {
    if (!task.expected) return judgeFail("This task has no reference answer in the dataset, so it cannot be marked");
    return normaliseAnswer(result.answer).includes(normaliseAnswer(task.expected))
      ? judgePass() : judgeFail(`The answer does not contain "${task.expected.slice(0, 120)}"`);
  },
};

/* -------------------------------------------------------- terminal-bench */

/**
 * terminal-bench: one folder per task holding `task.md`, whatever files the task starts with, and
 * a `tests.sh` that decides it. The tests are kept out of the assistant's workspace until it has
 * finished, so it cannot read them while it works.
 */
export const terminalBenchAdapter: BenchmarkAdapter = {
  id: "terminal-bench", name: "terminal-bench", runsPrograms: true,
  format: "one folder per task, each with task.md and tests.sh",
  layout: "<folder>/<task name>/task.md and <folder>/<task name>/tests.sh",
  async discover(directory) {
    let names: string[];
    try { names = await readdir(directory, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()); }
    catch { throw new Error(`There is no folder at ${directory}. Put the terminal-bench tasks there first.`); }
    const tasks: BenchmarkTask[] = [];
    for (const name of names) {
      const brief = await readFile(join(directory, name, "task.md"), "utf8").catch(() => null);
      if (brief === null) continue;
      tasks.push({ id: safeId(name, `terminal-${tasks.length + 1}`), prompt: brief.trim(), tags: ["terminal-bench"], raw: { folder: name } });
    }
    if (!tasks.length) throw new Error(`No task.md found under ${directory}. Each task is its own folder with a task.md in it.`);
    return tasks;
  },
  async prepare(task, into, directory) {
    const source = join(directory, field(task.raw, "folder"));
    await mkdir(into, { recursive: true });
    const copied: string[] = [];
    for (const entry of await readdir(source)) {
      if (entry === "tests.sh" || entry === "task.md") continue;
      await cp(join(source, entry), join(into, entry), { recursive: true });
      copied.push(entry);
    }
    return prepared(into, task.prompt, copied);
  },
  async judge(task, result, directory) {
    const script = join(directory, field(task.raw, "folder"), "tests.sh");
    if (!(await exists(script))) return judgeFail("This task has no tests.sh, so it cannot be marked");
    const bash = await findBash();
    if (!bash) return judgeFail("terminal-bench tasks are marked by running their tests.sh, and there is no bash on this computer. Install Git for Windows, or set BRANCH_BASH to one.");
    await cp(script, join(result.workspace, "tests.sh"));
    const outcome = await runBenchmarkCommand(bash, ["tests.sh"], result.workspace);
    if (outcome.status !== "completed") return judgeFail(`The tests did not finish (${outcome.status})`, outcome.stderr.slice(0, 300));
    return outcome.exitCode === 0 ? judgePass() : judgeFail("The task's tests failed", (outcome.stderr || outcome.stdout).slice(0, 300));
  },
};

/** Every adapter the program has, by name. */
export const benchmarkAdapters: readonly BenchmarkAdapter[] = [
  sweBenchAdapter, gaiaAdapter, codeTasksAdapter, webTasksAdapter, terminalBenchAdapter,
];

export function findBenchmarkAdapter(id: string): BenchmarkAdapter {
  const found = benchmarkAdapters.find((adapter) => adapter.id === id);
  if (found) return found;
  throw new Error(`There is no benchmark called ${id}. There are: ${benchmarkAdapters.map((a) => a.id).join(", ")}.`);
}
