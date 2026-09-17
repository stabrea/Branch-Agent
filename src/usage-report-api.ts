import type { IncomingMessage } from "node:http";
import type { createBranch } from "./index.js";
import { pricingSettings } from "./pricing.js";
import { saveUsageReportSettings, usageReport, usageReportSettings } from "./usage-report.js";
import { executionMetricsDeps, executionMetricsSettings, saveExecutionMetricsSettings, sendExecutionMetrics } from "./execution-metrics.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

/**
 * The routes behind the usage report (A0367) and sending the task counters to the owner's own
 * collector (A1751, `/api/usage/counters`). The report shows every person's tasks on this
 * computer, so only the owner may read it or change its switch.
 */
export async function usageReportRoute(
  app: Branch, request: IncomingMessage, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  app.store.profiles.requireOwner("The usage report");
  const owner = app.runtime.owner;
  const method = request.method ?? "GET";
  if (path === "/api/usage/counters") {
    if (method === "POST") return { counters: saveExecutionMetricsSettings(app.store, owner, await body()) };
    return { counters: executionMetricsSettings(app.store, owner) };
  }
  if (path === "/api/usage/counters/send" && method === "POST") {
    const outcome = await sendExecutionMetrics(executionMetricsDeps(app.store, owner, app.traceExport));
    return { ...outcome, counters: executionMetricsSettings(app.store, owner) };
  }
  if (path === "/api/usage/report/settings") {
    if (method === "POST") return { usageReport: saveUsageReportSettings(app.store, owner, await body()) };
    return { usageReport: usageReportSettings(app.store, owner) };
  }
  if (method !== "POST") return { usageReport: usageReportSettings(app.store, owner) };
  const { overrides } = pricingSettings(app.store, owner);
  return usageReport({
    store: app.store, owner, overrides,
    aggregate: (range, prices) => app.store.usageStore().aggregateUsage(range, "day", prices),
  }, await body());
}
