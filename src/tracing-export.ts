import { z } from "zod";
import { audit } from "./audit.js";
import { errorText } from "./contracts.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import type { SpanRow } from "./tracing.js";
import { eventsToOtlpLogs, metricsToOtlp, spansToLangfuse, spansToLangsmith, spansToOtlp, type LogRecordInput, type MetricPoint } from "./tracing-shapes.js";

/**
 * Sending traces somewhere the owner chose. This is off until they turn it on, it only ever goes to
 * the one address they typed, it goes through the same address rules as everything else, and every
 * send is written into the record of what the assistant was allowed to do.
 *
 * The headers an endpoint needs (an API key, usually) are stored as `secret://project/NAME`
 * references, so the key itself is never in the settings, never in a log, and never in an error.
 */
export const traceDestinations = ["otlp", "langfuse", "langsmith"] as const;
export type TraceDestination = (typeof traceDestinations)[number];

const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,60}$/, "Header names look like x-api-key");
export const TraceExportSettingsSchema = z
  .object({
    /** Off until the owner turns it on. Nothing is ever sent while this is false. */
    enabled: z.boolean().default(false),
    destination: z.enum(traceDestinations).default("otlp"),
    /** Where to send them. Empty until the owner types one. */
    endpoint: z.string().trim().max(2000).default(""),
    /** Extra headers; a value may be a `secret://project/NAME` reference instead of the real key. */
    headers: z.record(headerName, z.string().max(500)).default({}),
    /** How many spans go in one send. */
    batchSize: z.number().int().min(1).max(500).default(100),
    /** How many times a failed send is tried again before it is given up on. */
    retries: z.number().int().min(0).max(5).default(2),
    /** The name this install shows up under in the tracing tool. */
    serviceName: z.string().trim().min(1).max(80).default("branch-agent"),
    /** Send the crashes recorded as error spans along with a finished task's own steps. */
    includeErrors: z.boolean().default(false),
  })
  .strict();
export type TraceExportSettings = z.infer<typeof TraceExportSettingsSchema>;

const settingsKey = "trace_export";
/** The owner's export settings, or the safe default (off, nowhere) when nothing is saved. */
export function traceExportSettings(store: Store, owner: string): TraceExportSettings {
  const saved = TraceExportSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : TraceExportSettingsSchema.parse({});
}

/** Saves the settings. Turning sending on without an address is refused rather than half-done. */
export function saveTraceExportSettings(store: Store, owner: string, input: unknown): TraceExportSettings {
  const value = TraceExportSettingsSchema.parse(input ?? {});
  if (value.enabled && !value.endpoint) throw new Error("Type the address to send traces to before turning this on");
  if (value.endpoint && !/^https?:\/\//i.test(value.endpoint)) throw new Error("The address must start with http:// or https://");
  store.save("settings", owner, settingsKey, value);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: `sending traces to ${value.enabled ? value.endpoint : "nowhere"}`,
    reason: value.enabled ? `Turned on, as ${value.destination}` : "Turned off", outcome: "saved",
  });
  return value;
}

/** Where one destination's spans go, and how its body is shaped. */
function bodyFor(destination: TraceDestination, rows: SpanRow[], service: { name: string; version: string }): unknown {
  if (destination === "langfuse") return spansToLangfuse(rows, service);
  if (destination === "langsmith") return spansToLangsmith(rows, service.name);
  return spansToOtlp(rows, service);
}
/** The path each destination expects on top of the address the owner typed. */
const paths: Record<TraceDestination, { traces: string; metrics: string; logs: string }> = {
  otlp: { traces: "/v1/traces", metrics: "/v1/metrics", logs: "/v1/logs" },
  langfuse: { traces: "/api/public/ingestion", metrics: "/api/public/ingestion", logs: "/api/public/ingestion" },
  langsmith: { traces: "/runs/batch", metrics: "/runs/batch", logs: "/runs/batch" },
};
/** The address a body is sent to: the owner's address, with the destination's path unless they gave one. */
export function endpointFor(settings: TraceExportSettings, what: "traces" | "metrics" | "logs"): URL {
  const base = new URL(settings.endpoint);
  const wanted = paths[settings.destination][what];
  if (base.pathname && base.pathname !== "/") return base;
  return new URL(wanted, base);
}

export interface ExportResult {
  sent: number;
  attempts: number;
  status: number | null;
  ok: boolean;
  error: string | null;
  endpoint: string;
}

export interface ExporterDeps {
  store: Store;
  owner: string;
  policy: Pick<NetworkPolicy, "assertAllowed">;
  version: string;
  /** Fills in `secret://project/NAME` header values at the moment of the call and nowhere earlier. */
  fillSecrets: (headers: Record<string, string>) => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  /** Waits between tries; replaced in tests so a retry does not take a real second. */
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The address rules refuse anything on this computer or the private network. That is right, but on
 * its own it does not tell the owner what to do about it, and a collector of their own is exactly
 * the case where the answer is "switch it on". So the refusal says which switch, by name.
 */
const privateAddressRefusal = /private|local|points at this computer/i;
export function refusalSentence(error: string, endpoint: string): string {
  if (!privateAddressRefusal.test(error)) return error;
  return `${error}. A tracing tool running on this computer, such as ${endpoint}, needs "Allow private addresses" switched on under Web reading in Settings (allowPrivateAddresses in the web section of the integrations file). Nothing else has to change.`;
}

export class TraceExporter {
  constructor(private readonly deps: ExporterDeps) {}

  settings(): TraceExportSettings {
    return traceExportSettings(this.deps.store, this.deps.owner);
  }

  /** Sends spans in batches. Does nothing at all, and says so, while sending is switched off. */
  async sendSpans(rows: SpanRow[], reason = "Traces were sent to the address you chose"): Promise<ExportResult[]> {
    const settings = this.settings();
    if (!settings.enabled) return [];
    const results: ExportResult[] = [];
    for (let at = 0; at < rows.length; at += settings.batchSize) {
      const batch = rows.slice(at, at + settings.batchSize);
      const body = bodyFor(settings.destination, batch, { name: settings.serviceName, version: this.deps.version });
      results.push(await this.post(settings, endpointFor(settings, "traces"), body, batch.length, reason));
    }
    return results;
  }

  /**
   * Batch 20 (wave 8): the task's own story as OpenTelemetry log records, sent to the same address
   * under the same switch. Only a collector that speaks OpenTelemetry has a place to put them;
   * Langfuse and LangSmith have no logs signal, so for those this does nothing and says so.
   */
  async sendLogs(rows: LogRecordInput[], reason = "A task's steps were sent to the address you chose"): Promise<ExportResult | null> {
    const settings = this.settings();
    if (!settings.enabled || settings.destination !== "otlp" || !rows.length) return null;
    const body = eventsToOtlpLogs(rows.slice(0, settings.batchSize), { name: settings.serviceName, version: this.deps.version });
    return this.post(settings, endpointFor(settings, "logs"), body, Math.min(rows.length, settings.batchSize), reason);
  }

  /** Sends the usage counters, in OTLP metrics shape, to the same place. */
  async sendMetrics(points: MetricPoint[], reason = "The usage counters were sent to the address you chose"): Promise<ExportResult | null> {
    const settings = this.settings();
    if (!settings.enabled) return null;
    const body = settings.destination === "otlp"
      ? metricsToOtlp(points, { name: settings.serviceName, version: this.deps.version })
      : { metrics: points };
    return this.post(settings, endpointFor(settings, "metrics"), body, points.length, reason);
  }

  /** One send, tried again on a failure, with the address rules checked before every try. */
  private async post(
    settings: TraceExportSettings, endpoint: URL, body: unknown, count: number, reason: string,
  ): Promise<ExportResult> {
    const send = this.deps.fetchImpl ?? globalThis.fetch;
    const wait = this.deps.sleep ?? pause;
    const headers = await this.deps.fillSecrets({ "content-type": "application/json", ...settings.headers });
    let attempts = 0, status: number | null = null, error: string | null = null;
    while (attempts <= settings.retries) {
      attempts += 1;
      try {
        try {
          await this.deps.policy.assertAllowed(endpoint, "trace address");
        } catch (refused) {
          // The address itself is not allowed. Trying again cannot change that, so say what to do
          // about it once rather than three times over with a growing pause.
          const sentence = refusalSentence(errorText(refused).slice(0, 200), endpoint.origin);
          return this.record({ sent: 0, attempts, status: null, ok: false, error: sentence, endpoint: endpoint.href }, reason);
        }
        const response = await send(endpoint.href, {
          method: "POST", headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000), redirect: "error",
        });
        status = response.status;
        if (response.ok) return this.record({ sent: count, attempts, status, ok: true, error: null, endpoint: endpoint.href }, reason);
        error = `The address answered ${response.status}`;
      } catch (e) {
        // A header value can be a key, so only the shape of the failure is kept, never the request.
        error = errorText(e).slice(0, 200);
      }
      if (attempts <= settings.retries) await wait(Math.min(2000, 200 * 2 ** (attempts - 1)));
    }
    return this.record({ sent: 0, attempts, status, ok: false, error, endpoint: endpoint.href }, reason);
  }

  /** Every send, good or bad, goes into the record of what the assistant was allowed to do. */
  private record(result: ExportResult, reason: string): ExportResult {
    audit(this.deps.store, this.deps.owner, {
      action: "data.exported", actor: this.deps.owner,
      subject: `${result.sent} span(s) to ${hostOf(result.endpoint)}`,
      reason: result.ok ? reason : `${reason}, but it did not arrive: ${result.error ?? "unknown"}`,
      outcome: result.ok ? "sent" : "failed",
    });
    return result;
  }
}

const hostOf = (href: string): string => { try { return new URL(href).host; } catch { return "an address"; } };
