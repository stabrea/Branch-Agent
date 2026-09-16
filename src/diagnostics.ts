import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./contracts.js";
import type { Store } from "./store.js";
import { pricingTableInUse } from "./pricing.js";
import { auditLabel } from "./audit.js";

/**
 * Branch sends nothing anywhere. When something goes wrong and the owner wants help, they save a
 * diagnostics folder and pass it on by hand, so they can read every line of it first. Building the
 * folder therefore keeps only what is useful for diagnosis and drops everything else: secrets are
 * removed, and the contents of the files in the workspace never go in at all.
 */
export interface DiagnosticsBundle {
  folder: string;
  files: string[];
  events: number;
  createdAt: string;
}

/** Field names whose value is a secret whatever it looks like, checked before anything is kept. */
const secretName = /(api[-_]?key|^key$|token|secret|password|passphrase|authorization|bearer|credential|cookie)/i;
/** Values that look like a secret even under an innocent field name. */
const secretValue = [
  /\bBearer\s+\S+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
];
export const removed = "[removed]";

/** Replaces anything that looks like a key, token or bearer header inside a piece of text. */
export function scrubText(value: string): string {
  let out = value;
  for (const pattern of secretValue) out = out.replace(pattern, removed);
  return out;
}

/**
 * Event fields worth keeping. Everything else is dropped rather than scrubbed, so a field nobody
 * anticipated — a tool result, a file's contents, a diff, a prompt — can never reach the folder.
 */
const keptFields = new Set([
  "id", "name", "kind", "preset", "provider", "model", "reasoning", "status", "outcome", "phase",
  "index", "attempt", "afterMs", "count", "stalls", "action", "duration", "interrupted", "source",
  "sourceRunId", "childRunId", "parentRunId", "versionId", "existed", "added", "removed", "error",
  "memories", "skills", "unknownToolOutcomes", "unreadable", "from", "runId", "sessionId",
]);

/** One event reduced to its shape: names, counts and outcomes, with no payload and no secrets. */
export function redactEvent(event: Event): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    if (!keptFields.has(key)) continue;
    if (secretName.test(key)) { data[key] = removed; continue; }
    if (typeof value === "string") data[key] = scrubText(value).slice(0, 300);
    else if (typeof value === "number" || typeof value === "boolean") data[key] = value;
    // Objects and arrays are dropped: they are where results and file contents live.
  }
  return { id: event.id, runId: event.runId, kind: event.kind, at: event.createdAt, data };
}

const explanation = `What is in this folder

Branch Agent sends no usage data to anyone. This folder was written only because you asked for it,
and nothing leaves this computer unless you send it yourself.

  health.json   the same checks as the Health check button in Settings
  versions.json which version of Branch, Node.js and Windows this is
  events.json   the last events from your tasks: what ran, how it ended, and how long it took
  pricing.json  the model prices used to estimate costs, including any you corrected yourself
  allowed.json  what the assistant was allowed to do: approvals, secrets handed over, settings changed

What is deliberately missing: your messages, the assistant's replies, the contents of any file in
your workspace, tool results, API keys, tokens and passwords. Read the files before sharing them.
`;

async function writeJson(folder: string, name: string, value: unknown): Promise<string> {
  await writeFile(join(folder, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  return name;
}

/**
 * The record of what the assistant was allowed to do, the same as the Usage screen shows. Only
 * the shape of each moment goes in — what happened, when, and why — with every free-text field
 * put through the same scrub as everything else here.
 */
function allowedRecord(store: Store, owner: string): unknown {
  const entries = store.audit.list(owner, { limit: 200 }).map((entry) => ({
    at: entry.at, action: entry.action, means: auditLabel(entry.action), actor: scrubText(entry.actor).slice(0, 120),
    subject: scrubText(entry.subject).slice(0, 200), reason: scrubText(entry.reason).slice(0, 300),
    source: entry.source, outcome: entry.outcome,
  }));
  return { counts: store.audit.counts(owner), count: entries.length, entries };
}

/**
 * Writes the diagnostics folder and returns what went into it. `health` is the report from the
 * health check; it is passed in so this module never has to reach into the running app.
 */
export async function writeDiagnosticsBundle(
  store: Store,
  owner: string,
  dataDir: string,
  details: { health: unknown; version: string },
): Promise<DiagnosticsBundle> {
  const createdAt = new Date().toISOString();
  const folder = join(dataDir, "diagnostics", createdAt.replace(/[:.]/g, "-"));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const events = store.recentEvents(owner, 200).map(redactEvent);
  const files = [
    await writeJson(folder, "health.json", details.health),
    await writeJson(folder, "versions.json", {
      branch: details.version, node: process.version, platform: process.platform, arch: process.arch, createdAt,
    }),
    await writeJson(folder, "events.json", { count: events.length, events }),
    await writeJson(folder, "pricing.json", pricingTableInUse(store, owner)),
    await writeJson(folder, "allowed.json", allowedRecord(store, owner)),
  ];
  await writeFile(join(folder, "README.txt"), explanation, { mode: 0o600 });
  files.push("README.txt");
  return { folder, files, events: events.length, createdAt };
}
