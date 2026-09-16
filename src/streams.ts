import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "./store.js";

/**
 * Ordered live activity over Server-Sent Events: every stored event of a run, in id order, from a
 * given point on, until the run has finished. Reconnecting clients pass the last id they saw.
 */
export async function streamRunEvents(store: Store, runId: string, response: ServerResponse, after = 0, options: { pollMs?: number; maxMs?: number } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 250, deadline = Date.now() + (options.maxMs ?? 150000);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
  response.flushHeaders();
  let last = after, closed = false;
  response.on("close", () => { closed = true; });
  while (!closed && Date.now() < deadline) {
    for (const event of store.events(runId).filter((e) => e.id > last)) {
      response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify({ id: event.id, kind: event.kind, data: event.data, createdAt: event.createdAt })}\n\n`);
      last = event.id;
    }
    const run = store.run(runId);
    if (!run || run.status !== "running") {
      response.write(`event: end\ndata: ${JSON.stringify({ status: run?.status ?? "unknown" })}\n\n`);
      break;
    }
    await delay(pollMs);
  }
  response.end();
}
