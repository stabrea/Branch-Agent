import { homedir } from "node:os";
import { z } from "zod";
import { audit } from "../audit.js";
import { boundedFetch } from "../integrations/bounded-fetch.js";
import type { ToolRegistry } from "../registry.js";
import { applyFixes, plannedFixes, runAudit } from "./audit.js";
import { collectSnapshot, type SecurityApp } from "./collect.js";
import type { Runner } from "./file-access.js";
import { MalwareCheck, type MalwareCheckStatus } from "./malware-check.js";
import { saveSecurityCheckSettings, securityCheckSettings, type SecurityCheckSettings } from "./settings.js";
import type { AuditReport, FixResult } from "./types.js";
import { recordedWrite } from "../settings-kit/recorded-write.js"; // Q48
import type { ChangeOrigin } from "../settings-kit/history.js";

/**
 * The self-check as the running app holds it: the last report, the malware check, the read-only
 * tool that exists only while the audit switch is not off, and the run at start when it is on.
 */

export const securityToolName = "settings.security_check";

export interface SecurityServiceOptions {
  dataDir: string;
  /** Where Branch was told its launch settings are (BRANCH_INTEGRATIONS). */
  integrationsPath: () => string | null;
  /** The OSV address; tests hand in their own server. */
  osvEndpoint?: string;
  home?: string;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface SecurityState {
  settings: SecurityCheckSettings;
  report: AuditReport | null;
  malware: MalwareCheckStatus;
}

export class SecurityService {
  private last: AuditReport | null = null;
  readonly malware: MalwareCheck;
  constructor(private readonly app: SecurityApp & { registry: ToolRegistry }, private readonly options: SecurityServiceOptions) {
    const owner = app.runtime.owner;
    this.malware = new MalwareCheck({
      mode: () => securityCheckSettings(app.store, owner).malware,
      fetch: () => app.web.policy.guard(boundedFetch),
      ...(options.osvEndpoint ? { endpoint: options.osvEndpoint } : {}),
      onRefused: (pkg, advisories) => audit(app.store, owner, {
        action: "connection.changed", actor: "the malware check", subject: `${pkg.ecosystem} package ${pkg.name}`,
        reason: `The public list of harmful packages names it: ${advisories.map((advisory) => advisory.id).join(", ")}`.slice(0, 500),
        outcome: "refused",
      }),
    });
  }

  settings(): SecurityCheckSettings { return securityCheckSettings(this.app.store, this.app.runtime.owner); }

  /**
   * Saves the switches and adds or removes the assistant's tool to match. `record` is who changed
   * them when that is not the settings kit, which writes its own record (Q48).
   */
  configure(input: unknown, record?: ChangeOrigin): SecurityCheckSettings {
    const save = () => saveSecurityCheckSettings(this.app.store, this.app.runtime.owner, input);
    const saved = record ? recordedWrite(this.app.store, this.app.runtime.owner, record, ["security-check"], save) : save();
    this.syncTool();
    return saved;
  }

  state(): SecurityState {
    return { settings: this.settings(), report: this.last, malware: this.malware.status() };
  }

  /** Runs every check. `remoteEnabled` is whether the phone door is open, when the caller knows. */
  async check(remoteEnabled: boolean | null = null): Promise<AuditReport> {
    const snapshot = await collectSnapshot(this.app, {
      dataDir: this.options.dataDir, integrationsPath: this.options.integrationsPath(), remoteEnabled,
      home: this.options.home ?? homedir(), ...(this.options.run ? { run: this.options.run } : {}),
      ...(this.options.platform ? { platform: this.options.platform } : {}),
    });
    return (this.last = runAudit(snapshot));
  }

  /** Puts right what can be put right from here, then checks again. */
  async fix(ids: string[] = [], remoteEnabled: boolean | null = null): Promise<{ fixed: FixResult[]; report: AuditReport }> {
    const before = await this.check(remoteEnabled);
    const fixed = await applyFixes(plannedFixes(before, ids), this.options.platform ?? process.platform, this.options.run, this.options.env);
    return { fixed, report: await this.check(remoteEnabled) };
  }

  /** The read-only tool is there exactly while the audit switch is not off. */
  syncTool(): void {
    const registry = this.app.registry;
    registry.unregister(securityToolName);
    if (this.settings().audit === "off") return;
    registry.register({
      name: securityToolName, permission: "history.read", parameters: z.object({}).strict(),
      description: "Check this computer's Branch setup for security problems, in plain words.",
      execute: async () => {
        const report = await this.check();
        return { summary: report.summary, findings: report.findings.map(({ fixes: _fixes, ...rest }) => rest) };
      },
    });
  }

  /** On start: the tool to match the switch, and a first check when the switch is on. Never fails a start. */
  start(): void {
    this.syncTool();
    if (this.settings().audit === "on") void this.check().catch(() => undefined);
  }
}
