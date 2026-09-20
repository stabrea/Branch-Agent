import type { Store } from "./store.js";

/**
 * mac7/smoke-fixes (B4): one task's trace, in one place.
 *
 * `branch trace <task id>` used to build this inside the terminal, against a database it had opened
 * itself — which meant it could not be run at all while the app window was open. The report and the
 * lines it prints live here now, so the running Branch can build the same report over
 * `GET /api/runs/:id/trace` and the terminal prints exactly the same words either way.
 *
 * Nothing here changes anything: it reads the spans a task already recorded.
 */
export interface TraceReport {
  runId: string;
  traceId: string;
  spans: number;
  kinds: string[];
  sending: { to: string; endpoint: string } | null;
  lastSend: { kind: string; at: string } | null;
}

export interface TraceSettings { enabled: boolean; destination: string; endpoint: string }

/** The trace of one task, or a plain sentence when nothing was recorded for it. */
export function traceReport(
  store: Pick<Store, "spans" | "events">, settings: TraceSettings, runId: string,
): TraceReport {
  const spans = store.spans.forRun(runId);
  if (!spans.length) throw new Error(`Nothing was recorded for the task ${runId}.`);
  const root = spans.find((span) => !span.parentSpanId) ?? spans[0]!;
  const sent = store.events(runId).filter((event) => event.kind === "trace.sent" || event.kind === "trace.send_failed");
  return {
    runId, traceId: root.traceId, spans: spans.length,
    kinds: [...new Set(spans.map((span) => span.kind))],
    sending: settings.enabled ? { to: settings.destination, endpoint: settings.endpoint } : null,
    lastSend: sent.at(-1) ? { kind: sent.at(-1)!.kind, at: sent.at(-1)!.createdAt } : null,
  };
}

/** The same report as the three lines a person reads. */
export function traceLines(report: TraceReport): string[] {
  return [
    `Trace ${report.traceId} — ${report.spans} step(s): ${report.kinds.join(", ")}`,
    report.sending
      ? `Sending is on, to ${report.sending.to} at ${report.sending.endpoint}.`
      : "Sending traces is off, so this trace has stayed on this computer.",
    report.lastSend
      ? `Last send: ${report.lastSend.kind === "trace.sent" ? "arrived" : "did not arrive"} at ${report.lastSend.at}.`
      : "This task's steps have not been sent anywhere.",
  ];
}
