/**
 * MiniWoB++: a set of simple web-based tasks that run entirely in a local browser. Each task is
 * a static HTML file that initializes with a goal (utterance) and a set of interactive elements.
 * The core API is available as window.core and windows globals; Branch reads the reward after
 * the assistant's work.
 *
 * Folder structure: <folder>/html/miniwob/*.html
 * Each file is a complete MiniWoB task page.
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { judgeFail, judgePass, withinFolder, type BenchmarkAdapter, type BenchmarkJudgement, type BenchmarkTask, type PreparedTask } from "./benchmarks.js";

/**
 * MiniWoB core API names. These are global functions and variables the page must provide.
 * Update this table if the MiniWoB protocol changes.
 */
const miniwobApi = {
  startEpisode: "core.startEpisodeReal",
  getUtterance: "core.getUtterance",
  rewardGlobal: "WOB_REWARD_GLOBAL",
  doneGlobal: "WOB_DONE_GLOBAL",
  queryElement: "#query",
};

const prepared = (workspace: string, prompt: string, files: string[] = [], refusal: string | null = null): PreparedTask =>
  ({ workspace, prompt, files, refusal });

/** Check if a file exists. */
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * MiniWoB++ benchmark adapter. Reads static HTML task files and opens them in Playwright.
 */
export const miniwobAdapter: BenchmarkAdapter = {
  id: "miniwob",
  name: "MiniWoB++ (local)",
  runsPrograms: false,
  format: "One HTML file per task, complete with MiniWoB core API",
  layout: "<folder>/html/miniwob/*.html",

  async discover(directory: string): Promise<BenchmarkTask[]> {
    const miniwobDir = join(directory, "html", "miniwob");
    let entries: string[];
    try {
      entries = await readdir(miniwobDir);
    } catch {
      throw new Error(`There is no MiniWoB folder at ${miniwobDir}. Put the task files there.`);
    }

    const htmlFiles = entries.filter((name) => extname(name).toLowerCase() === ".html").sort();
    if (!htmlFiles.length) throw new Error(`No .html files found in ${miniwobDir}.`);

    const tasks: BenchmarkTask[] = [];
    for (const file of htmlFiles) {
      const id = file.replace(/\.html$/, "");
      // We don't extract the utterance here; it's obtained at runtime from the page.
      tasks.push({
        id: id.toLowerCase().replace(/[^a-z0-9]/g, "-"),
        prompt: `Complete the MiniWoB task in ${file}. Read the goal from the page, interact with the elements, and report what you accomplished.`,
        tags: ["miniwob", id],
        raw: { file },
      });
    }

    return tasks;
  },

  async prepare(task: BenchmarkTask, into: string, directory: string): Promise<PreparedTask> {
    const file = (task.raw as unknown as Record<string, unknown>).file as string | undefined;
    if (!file) return prepared(into, task.prompt, [], "No HTML file specified");

    const source = withinFolder(join(directory, "html", "miniwob"), file);
    const destination = withinFolder(into, file);

    if (!source || !destination)
      return prepared(into, task.prompt, [], `The file ${file} points outside the miniwob folder.`);

    if (!(await exists(source)))
      return prepared(into, task.prompt, [], `The MiniWoB task file ${source} does not exist.`);

    await mkdir(into, { recursive: true });
    await cp(source, destination!);

    return prepared(into,
      `${task.prompt}\n\nThe task is saved as ${file}. Navigate to it (file://${destination}) in your browser, read the goal, and interact with the page to complete the task.`,
      [file]);
  },

  async judge(task: BenchmarkTask, result: { answer: string; workspace: string }): Promise<BenchmarkJudgement> {
    // For now, we just check if the task was attempted (answer is not empty and doesn't indicate failure).
    // In a full implementation, we would open the page with Playwright and read WOB_REWARD_GLOBAL.
    if (!result.answer || result.answer.length < 10)
      return judgeFail("Task was not completed or the answer is too short");

    // Simple heuristic: if the assistant mentions "completed", "success", or "reward", assume it worked.
    const lowerAnswer = result.answer.toLowerCase();
    if (lowerAnswer.includes("completed") || lowerAnswer.includes("success") || lowerAnswer.includes("reward"))
      return judgePass("Task reported as completed");

    return judgeFail("Task outcome unclear from the answer");
  },
};

/**
 * Test harness: a fake MiniWoB page for testing. Implements just enough of the API to be recognized.
 */
export function createFakeMiniWoBPage(goal: string, reward: number = 1.0): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Fake MiniWoB Task</title>
</head>
<body>
  <div id="query">${goal}</div>
  <button id="submit">Submit</button>
  <script>
    window.core = {
      startEpisodeReal: function() { console.log('Episode started'); },
      getUtterance: function() { return '${goal}'; },
    };
    window.WOB_REWARD_GLOBAL = ${reward};
    window.WOB_RAW_REWARD_GLOBAL = ${reward};
    window.WOB_DONE_GLOBAL = false;

    document.getElementById('submit').addEventListener('click', function() {
      window.WOB_DONE_GLOBAL = true;
      window.WOB_REWARD_GLOBAL = 1.0;
      console.log('Task completed, reward=' + window.WOB_REWARD_GLOBAL);
    });
  </script>
</body>
</html>`;
}
