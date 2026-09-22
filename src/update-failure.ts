import { mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DiagnosticLog, diagnosticLogSettings, redactForLog } from "./diagnostic-log.js";
import { gatherReport, reportZip, type ReportItem, type ReportSources } from "./diagnostic-report.js";
import { reportSources, type DiagnosticContext } from "./diagnostic-api.js";

/**
 * Owner item 19: an update that did not go through says so in one plain sentence, with one file that
 * explains it for the owner to send us themselves (on Discord, say). Nothing here sends anything.
 *
 * The file is Report a problem's own zip (src/diagnostic-report.ts) of the items that explain an
 * update, plus the hand-over's own step-by-step log. Kept apart from the report files until the
 * selectable-item work there lands, when that log becomes one of its items.
 */
export const handlesUpdateFailurePath = (path: string): boolean => path === "/api/updates/failure" || path === "/api/updates/failure-report";

/** Where the hand-over writes each step (src/desktop/updater.ts, src/install/headless-update.ts). Read fresh. */
export const updateScratchDir = (): string => join(tmpdir(), "branch-agent-update");
const updateLogLines = 400;
/** Only the end of the log is read, however long it grew: it is only ever added to. */
const updateLogBytes = 256 * 1024;
const updateLogLineChars = 2000;

/** The last `updateLogBytes` of a file, read without loading the rest. */
export async function tailOf(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, updateLogBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // A cut through the first line leaves half a line: it is dropped rather than shown.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { await file.close(); }
}
/** Report a problem's items that explain an update, and nothing else. */
const updateItems = new Set(["about", "updates", "log", "crashes", "disk"]);

/** The last update's own steps, the end only, cleaned like every report item. */
export async function updateLogItem(): Promise<ReportItem> {
  const text = await tailOf(join(updateScratchDir(), "apply-update.log")).then(
    (log) => redactForLog(log.split(/\r?\n/).slice(-updateLogLines).map((line) => line.slice(0, updateLogLineChars)).join("\n")),
    () => "No update has written its steps on this computer since it last started.");
  return { id: "update-log", title: "What the last update did", why: "Each step the update took, in order, up to where it stopped.", text };
}

/** The newest update, when it did not go through (the hand-over put the version before back). */
export function lastUpdateFailure(dataDir: string): { fromVersion: string; toVersion: string; at: string } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(dataDir, "activation.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT from_version AS fromVersion, to_version AS toVersion, state, started_at AS startedAt, finished_at AS finishedAt FROM activations ORDER BY id DESC LIMIT 1").get() as
      { fromVersion: string; toVersion: string; state: string; startedAt: string; finishedAt: string | null } | undefined;
    if (!row || row.state !== "failed") return null;
    return { fromVersion: row.fromVersion, toVersion: row.toVersion, at: row.finishedAt ?? row.startedAt };
  } catch {
    return null; // no journal yet: nothing has been updated here
  } finally { db?.close(); }
}

/**
 * Report a problem's sources with everything the update file leaves out made inert: settings, tasks,
 * services and health are never read, and no name is looked up on the network. Only the items that
 * explain an update read anything.
 */
export function updateSources(sources: ReportSources): ReportSources {
  const nothing = () => ({});
  return { ...sources, health: async () => ({}), settings: nothing, services: nothing, events: nothing, resolve: null };
}

/** The update's file, saved beside the owner's other reports and handed back for the download. */
async function failureReport(ctx: DiagnosticContext): Promise<{ name: string; path: string; base64: string }> {
  const { app, dataDir } = ctx;
  const log = new DiagnosticLog({ dir: join(dataDir, "logs"), settings: () => diagnosticLogSettings(app.store, app.runtime.owner) });
  const items = (await gatherReport(updateSources(reportSources(ctx, log)))).filter((item) => updateItems.has(item.id));
  const zip = reportZip([...items, await updateLogItem()]);
  const folder = join(dataDir, "diagnostics");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = `branch-update-report-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  await writeFile(join(folder, name), zip, { mode: 0o600 });
  return { name, path: redactForLog(join(folder, name)), base64: zip.toString("base64") };
}

export async function updateFailureApi(ctx: DiagnosticContext, method: string, path: string): Promise<unknown> {
  // The owner's alone, checked here so the guard moves with the route.
  ctx.app.store.profiles.requireOwner("An update's problem report");
  if (method === "GET" && path === "/api/updates/failure") return { failure: lastUpdateFailure(ctx.dataDir) };
  if (method === "POST" && path === "/api/updates/failure-report") return failureReport(ctx);
  throw new Error("Use GET for /api/updates/failure and POST for /api/updates/failure-report");
}
