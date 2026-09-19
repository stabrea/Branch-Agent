import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { join } from "node:path";
import { DiagnosticLog, diagnosticLogSettings, logLevels, type Level } from "./diagnostic-log.js";
import { gatherReport, issueUrl, keptItems, reportZip } from "./diagnostic-report.js";
import { reportSources, type DiagnosticContext } from "./diagnostic-api.js";

/**
 * mac7/diagnostics: `branch report`. It shows every item of a problem report on screen, first to
 * last, so the owner reads exactly what would be shared. Nothing is sent: `--save` writes a zip,
 * and `--issue` prints a GitHub link to open yourself. `branch report log` reads the activity log.
 */
export const reportUsage = `branch report                       show everything a problem report would hold
branch report --without log,tasks   leave items out (use the names shown in [brackets])
branch report --save <file.zip>     save the report as a zip you can attach yourself
branch report --issue ["summary"]   print a link to a GitHub issue form (title and description only)
branch report log [--component x] [--level warn] [--task id]   read the activity log`;

const option = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

export async function reportCommand(ctx: DiagnosticContext, args: readonly string[], print: (line: string) => void): Promise<number> {
  const log = new DiagnosticLog({ dir: join(ctx.dataDir, "logs"), settings: () => diagnosticLogSettings(ctx.app.store, ctx.app.runtime.owner) });
  if (args[0] === "log") return printLog(log, args.slice(1), print);
  if (args.includes("--help")) { print(reportUsage); return 0; }
  const without = (option(args, "--without") ?? "").split(",").map((each) => each.trim()).filter(Boolean);
  const items = keptItems(await gatherReport(reportSources(ctx, log)), without);
  const save = option(args, "--save");
  if (save) {
    const target = resolve(save.endsWith(".zip") ? save : `${save}.zip`);
    await writeFile(target, reportZip(items), { mode: 0o600 });
    print(`Saved ${items.length} items to ${target}. Nothing was sent. Attach it to your report yourself.`);
    return 0;
  }
  if (args.includes("--issue")) {
    const summary = args.filter((each) => !each.startsWith("--") && each !== option(args, "--without")).join(" ");
    print("Open this link to fill in a GitHub issue. Nothing is sent until you press Submit there:");
    print(issueUrl(items, summary));
    return 0;
  }
  if (args.includes("--json")) { print(JSON.stringify(items, null, 2)); return 0; }
  for (const item of items) {
    print(`\n[${item.id}] ${item.title}`);
    print(`  ${item.why}`);
    for (const line of item.text.split("\n").slice(0, 40)) print(`  ${line}`);
    if (item.text.split("\n").length > 40) print(`  … (${item.text.split("\n").length - 40} more lines; --json shows everything)`);
  }
  print("\nThis is everything a report would hold. Nothing has been sent. Use --save to keep it as a zip, --without to leave items out.");
  return 0;
}

function printLog(log: DiagnosticLog, args: readonly string[], print: (line: string) => void): number {
  const level = option(args, "--level");
  if (level && !(logLevels as readonly string[]).includes(level)) { print(`The level must be one of: ${logLevels.join(", ")}.`); return 2; }
  const component = option(args, "--component"), task = option(args, "--task");
  const lines = log.read({
    ...(component ? { component } : {}), ...(level ? { level: level as Level } : {}), ...(task ? { task } : {}),
    limit: Number(option(args, "--limit") ?? 100) || 100,
  }).reverse();
  if (!lines.length) print("The activity log has nothing matching. It is off unless you turn it on: Settings › Advanced › Activity log.");
  for (const line of lines)
    print(args.includes("--json") ? JSON.stringify(line)
      : `${line.at}  ${line.level.padEnd(5)}  ${line.component.padEnd(12)}  ${line.message}${line.taskId ? `  (task ${line.taskId.slice(0, 8)})` : ""}${line.requestId ? `  (request ${line.requestId})` : ""}`);
  return 0;
}
