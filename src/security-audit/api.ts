import { z } from "zod";
import { auditText } from "./audit.js";
import type { SecurityService } from "./service.js";
import { byCard } from "../settings-kit/recorded-write.js"; // Q48

/** The web routes behind the Settings card, and `branch security audit` on the command line. */

const FixRequestSchema = z.object({
  /** Only the repairs these checks offer; every repair on offer when left out. */
  ids: z.array(z.string().regex(/^[a-z-]+\.[a-z-]+$/)).max(100).default([]),
}).strict();

/**
 * Answers `/api/security-check…`, or undefined for any other address.
 * `remoteEnabled` is whether the phone door is open right now.
 */
export async function securityCheckApi(
  security: SecurityService, method: string, path: string, body: () => Promise<unknown>, remoteEnabled: boolean,
): Promise<unknown> {
  if (method === "GET" && path === "/api/security-check") return security.state();
  if (method !== "POST") return undefined;
  if (path === "/api/security-check/run") return { report: await security.check(remoteEnabled) };
  if (path === "/api/security-check/fix") {
    const { ids } = FixRequestSchema.parse((await body()) ?? {});
    return security.fix(ids, remoteEnabled);
  }
  if (path === "/api/security-check/settings") return security.configure(await body(), byCard("security-check"));
  return undefined;
}

/** `branch security audit [--fix] [--json]`. Answers the text to print and whether anything urgent is left. */
export async function securityAuditCommand(security: SecurityService, args: readonly string[]): Promise<{ text: string; urgent: boolean }> {
  if (args[0] !== "audit")
    throw new Error("Usage: branch security audit [--fix] [--json]\nChecks this computer's Branch setup for security problems; --fix puts right what it can.");
  const json = args.includes("--json");
  if (args.includes("--fix")) {
    const { fixed, report } = await security.fix();
    return { text: json ? JSON.stringify({ report, fixed }, null, 2) : auditText(report, fixed), urgent: report.summary.critical > 0 };
  }
  const report = await security.check();
  return { text: json ? JSON.stringify({ report }, null, 2) : auditText(report), urgent: report.summary.critical > 0 };
}
