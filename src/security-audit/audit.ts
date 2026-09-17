import { approvalChecks, peopleChecks, remoteChecks, secretChecks } from "./checks-access.js";
import { fileChecks } from "./checks-files.js";
import { channelChecks, modelChecks } from "./checks-people.js";
import { addonChecks, commandChecks, webChecks } from "./checks-tools.js";
import { tightenPath, type Runner } from "./file-access.js";
import type { AuditReport, Finding, FixPlan, FixResult, SecurityCheck, SecuritySnapshot, Severity } from "./types.js";

/**
 * The security self-check: every named check, run over one snapshot, with the repairs it can make.
 * Running it changes nothing. Fixing only ever takes other people's access away from paths the check
 * itself found, and a path that became a link in between is left alone.
 */

export const securityChecks: readonly SecurityCheck[] = [
  ...fileChecks, ...secretChecks, ...remoteChecks, ...peopleChecks, ...approvalChecks,
  ...commandChecks, ...webChecks, ...addonChecks, ...modelChecks, ...channelChecks,
];

const order: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** Runs every check. A check that throws is reported as one that could not be run, never as a pass. */
export function runAudit(snapshot: SecuritySnapshot, checks: readonly SecurityCheck[] = securityChecks): AuditReport {
  const findings: Finding[] = [];
  const outcomes = checks.map((entry) => {
    let verdict;
    try { verdict = entry.decide(snapshot); }
    catch (error) {
      verdict = { severity: "info" as const, detail: `This check could not be run: ${error instanceof Error ? error.message : String(error)}`, advice: "Run the check again; if it keeps happening, send a diagnostic bundle." };
    }
    if (verdict) findings.push({ id: entry.id, title: entry.title, severity: verdict.severity ?? entry.severity,
      detail: verdict.detail, advice: verdict.advice, ...(verdict.fixes?.length ? { fixes: verdict.fixes } : {}) });
    return { id: entry.id, area: entry.area, title: entry.title, severity: entry.severity, ok: !verdict };
  });
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const count = (severity: Severity) => findings.filter((finding) => finding.severity === severity).length;
  return {
    checkedAt: snapshot.now, platform: snapshot.platform, findings, checks: outcomes,
    summary: { critical: count("critical"), warn: count("warn"), info: count("info"),
      passed: outcomes.filter((outcome) => outcome.ok).length, checks: outcomes.length },
  };
}

/** The repairs a report offers, optionally only those of the named checks, each path once. */
export function plannedFixes(report: AuditReport, ids?: readonly string[]): FixPlan[] {
  const plans = new Map<string, FixPlan>();
  for (const finding of report.findings)
    if (!ids?.length || ids.includes(finding.id))
      for (const plan of finding.fixes ?? []) if (!plans.has(plan.path)) plans.set(plan.path, plan);
  // Folders first, so a file inside a folder that was just closed is still reachable to fix.
  return [...plans.values()].sort((a, b) => (a.target === b.target ? a.path.localeCompare(b.path) : a.target === "folder" ? -1 : 1));
}

export async function applyFixes(
  plans: readonly FixPlan[], platform: NodeJS.Platform, run?: Runner, env?: NodeJS.ProcessEnv,
): Promise<FixResult[]> {
  const results: FixResult[] = [];
  for (const plan of plans) results.push(await tightenPath(plan, platform, run, env));
  return results;
}

const mark: Record<Severity, string> = { critical: "URGENT, not yet true:", warn: "FIX, not yet true:", info: "NOTE, worth a look:" };

/** The report as lines a person can read straight from the terminal. */
export function auditText(report: AuditReport, fixed: readonly FixResult[] = []): string {
  const { summary } = report;
  const lines = [summary.critical + summary.warn === 0
    ? `All ${summary.checks} security checks passed${summary.info ? `, with ${summary.info} note${summary.info === 1 ? "" : "s"}` : ""}.`
    : `${summary.checks} security checks: ${summary.critical} urgent, ${summary.warn} to fix, ${summary.info} note${summary.info === 1 ? "" : "s"}.`];
  for (const finding of report.findings) {
    lines.push(`${mark[finding.severity]} ${finding.title}`, `    ${finding.detail}`, `    → ${finding.advice}`);
  }
  for (const result of fixed) lines.push(`${result.outcome === "fixed" ? "FIXED " : "LEFT  "} ${result.path}: ${result.reason}`);
  if (!fixed.length && report.findings.some((finding) => finding.fixes?.length))
    lines.push("Run `branch security audit --fix` to let Branch put right what it can.");
  return lines.join("\n");
}
