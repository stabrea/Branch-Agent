/**
 * MiniWoB++ (A1726): small web tasks — "click the button", "enter the date" — that are plain HTML
 * files, so they run on this computer with nothing downloaded and no server of anybody else's.
 *
 * The owner keeps the benchmark's own `html` folder: the task pages in `html/miniwob`, and the
 * shared `core` and `common` folders beside them that every page loads. For each go at a task:
 *
 * 1. `prepare` copies the page, the files it names and the `core`/`common` folders into the task's
 *    folder in the workspace. Nothing outside the owner's `html` folder is ever copied.
 * 2. `live` serves that copy from a small server on 127.0.0.1 that lives only for this go, opens it
 *    in Branch's own browser, starts the episode in that page and reads the goal out of it. The goal
 *    goes into the prompt, and the very same page is handed to the task.
 * 3. After the task, the judge reads the reward out of that same page. It never looks at what the
 *    answer says, so an assistant that only claims success fails.
 */
import { cp, lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, relative, sep } from "node:path";
import {
  judgeFail, withinFolder,
  type BenchmarkAdapter, type BenchmarkBrowser, type BenchmarkJudgement, type BenchmarkTask, type LiveAttempt, type PreparedTask,
} from "./benchmarks.js";

/** The names MiniWoB++ pages use. Everything below reads them from here. */
export const miniwobNames = {
  /** How long an episode may last, in milliseconds; set before the episode starts. */
  maxTime: "core.EPISODE_MAX_TIME",
  startEpisode: "core.startEpisodeReal",
  /** The goal: a string, or an object with an `utterance` field, depending on the version. */
  getUtterance: "core.getUtterance",
  /** The reward with the time penalty, set when the episode ends. */
  reward: "WOB_REWARD_GLOBAL",
  /** The reward without the time penalty. */
  rawReward: "WOB_RAW_REWARD_GLOBAL",
  done: "WOB_DONE_GLOBAL",
  /** Where the page shows the goal, read when getUtterance gives nothing. */
  query: "#query",
} as const;
/** A task passes when the episode is over and its reward is above this. */
export const miniwobPassAbove = 0;
/** An episode gets an hour: a model thinks far slower than the ten seconds a page allows a person. */
const episodeMs = 60 * 60 * 1000;
/** The folders beside `miniwob` that the pages load at run time. */
const sharedFolders = ["core", "common"];
const taskFolder = "miniwob";

const prepared = (workspace: string, prompt: string, files: string[] = [], refusal: string | null = null): PreparedTask =>
  ({ workspace, prompt, files, refusal });
const exists = (path: string) => stat(path).then(() => true, () => false);

/** The relative files a page names in `src` and `href`; addresses with a scheme are left alone. */
export function pageAssets(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/gi)) {
    const value = match[1]!.trim();
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\")) continue;
    found.add(value);
  }
  return [...found];
}

/** Copies a folder without following links, so nothing outside the owner's folder comes along. */
async function copyConfined(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, filter: async (source) => !(await lstat(source)).isSymbolicLink() });
}

/** The page and every relative file it names, as paths inside `html`, or why they cannot be used. */
async function planCopy(html: string, file: string): Promise<{ files: string[] } | { refusal: string }> {
  const page = withinFolder(join(html, taskFolder), file);
  if (!page || relative(html, page).split(sep)[0] !== taskFolder) return { refusal: `The file ${file} points outside the miniwob folder.` };
  if (!(await exists(page))) return { refusal: `The MiniWoB task file ${page} does not exist.` };
  const files = [relative(html, page)];
  for (const asset of pageAssets(await readFile(page, "utf8"))) {
    const full = withinFolder(html, relative(html, dirname(page)), asset);
    if (!full) return { refusal: `The page ${file} names ${asset}, which is outside the MiniWoB folder. Nothing was copied.` };
    if (!(await exists(full))) return { refusal: `The page ${file} needs ${asset}, which is not in ${html}. Put the benchmark's core files there.` };
    if ((await lstat(full)).isSymbolicLink()) return { refusal: `The page ${file} names ${asset}, which is a link. Only real files are copied.` };
    files.push(relative(html, full));
  }
  return { files };
}

async function prepareTask(task: BenchmarkTask, into: string, directory: string): Promise<PreparedTask> {
  const file = typeof task.raw.file === "string" ? task.raw.file : "";
  if (!file) return prepared(into, task.prompt, [], "The task does not name its page.");
  const html = join(directory, "html");
  const plan = await planCopy(html, file);
  if ("refusal" in plan) return prepared(into, task.prompt, [], plan.refusal);
  const target = join(into, "html");
  for (const folder of sharedFolders)
    if (await exists(join(html, folder))) await copyConfined(join(html, folder), join(target, folder));
  for (const one of plan.files) {
    await mkdir(dirname(join(target, one)), { recursive: true });
    await cp(join(html, one), join(target, one));
  }
  const page = `html/${taskFolder}/${file}`;
  return prepared(into, `${task.prompt}\n\nA copy of the page is at ${page} in the task's folder.`,
    plan.files.map((one) => `html/${one.split(sep).join("/")}`));
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

/** A file under `root`, following no link out of it, or null. */
async function servedFile(root: string, url: string): Promise<string | null> {
  let path: string;
  try { path = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname); } catch { return null; }
  const full = path.includes("\0") ? null : withinFolder(root, `.${path}`);
  if (!full) return null;
  try {
    const real = await realpath(full);
    return withinFolder(root, relative(root, real)) === real && (await stat(real)).isFile() ? real : null;
  } catch { return null; }
}

/** Serves one prepared folder on 127.0.0.1, reading only, for as long as one go at a task lasts. */
export async function serveFolder(folder: string): Promise<{ origin: string; close(): Promise<void> }> {
  const root = await realpath(folder);
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
    void servedFile(root, request.url ?? "/").then(async (file) => {
      if (!file) { response.writeHead(404).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("The MiniWoB page server did not start"); }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Starts the episode in the page and hands back its goal. */
const startScript = `(() => {
  ${miniwobNames.maxTime} = ${episodeMs};
  ${miniwobNames.startEpisode}();
  const said = typeof ${miniwobNames.getUtterance} === "function" ? ${miniwobNames.getUtterance}() : "";
  const text = typeof said === "string" ? said : (said && typeof said.utterance === "string" ? said.utterance : "");
  return text || (document.querySelector(${JSON.stringify(miniwobNames.query)})?.textContent ?? "");
})()`;
const readScript = `({ reward: window.${miniwobNames.reward}, raw: window.${miniwobNames.rawReward}, done: window.${miniwobNames.done} })`;

/** The verdict from what the page says, with the threshold written into the reason. */
export function miniwobVerdict(state: { reward?: unknown; raw?: unknown; done?: unknown }): BenchmarkJudgement {
  const reward = typeof state.reward === "number" ? state.reward : Number.NaN;
  const said = `${miniwobNames.reward} = ${String(state.reward)}, ${miniwobNames.rawReward} = ${String(state.raw)}, ${miniwobNames.done} = ${String(state.done)}`;
  if (state.done !== true) return judgeFail(`The episode did not finish (${said}).`);
  if (!(reward > miniwobPassAbove)) return judgeFail(`The reward was not above ${miniwobPassAbove} (${said}).`);
  return { pass: true, score: Math.min(1, reward), reasons: [`The page gave a reward above ${miniwobPassAbove} (${said}).`] };
}

async function liveAttempt(task: BenchmarkTask, ready: PreparedTask, browser: BenchmarkBrowser, owner: string): Promise<LiveAttempt> {
  const server = await serveFolder(join(ready.workspace, "html"));
  let tab: Awaited<ReturnType<BenchmarkBrowser["benchmarkWindow"]>> | undefined;
  const close = async () => { await tab?.close().catch(() => undefined); await server.close(); };
  try {
    const address = `${server.origin}/${taskFolder}/${encodeURIComponent(String(task.raw.file))}`;
    tab = await browser.benchmarkWindow(owner, address);
    const goal = (await tab.evaluate<string>(startScript)).replace(/\s+/g, " ").trim();
    if (!goal) throw new Error(`The MiniWoB page ${String(task.raw.file)} started without a goal.`);
    const opened = tab;
    return {
      prompt: `${ready.prompt}\n\nThe page ${address} is already open in your browser and the task has started. `
        + `Do not open it again, which would start it over. Use the browser tools on the page as it is.\n\nGoal: ${goal}`,
      started: (runId) => opened.handTo(runId),
      judge: async () => miniwobVerdict(await opened.evaluate(readScript)),
      close,
    };
  } catch (error) { await close(); throw error; }
}

export const miniwobAdapter: BenchmarkAdapter = {
  id: "miniwob",
  name: "MiniWoB++",
  runsPrograms: false,
  format: "the benchmark's own HTML task pages, with its core and common folders",
  layout: "<folder>/html/miniwob/*.html, with <folder>/html/core and <folder>/html/common beside it",

  async discover(directory: string): Promise<BenchmarkTask[]> {
    const folder = join(directory, "html", taskFolder);
    let names: string[];
    try { names = await readdir(folder); }
    catch { throw new Error(`There is no MiniWoB folder at ${folder}. Put the benchmark's html folder there.`); }
    const pages = names.filter((name) => extname(name).toLowerCase() === ".html").sort();
    if (!pages.length) throw new Error(`No .html file in ${folder}.`);
    return pages.map((file) => ({
      id: file.slice(0, -5).toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      prompt: "Do the MiniWoB task in the web page that is open in your browser.",
      tags: ["miniwob"],
      raw: { file },
    }));
  },
  prepare: prepareTask,
  live: liveAttempt,
  /** Without the live page there is nothing to judge from; what the answer claims never counts. */
  async judge(): Promise<BenchmarkJudgement> {
    return judgeFail("A MiniWoB task is judged only from the reward in its own page, and there was no page to read.");
  },
};
