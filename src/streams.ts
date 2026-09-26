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

/**
 * Wave 7: everything happening on this computer, not just one task. The same ordered stream, read
 * across every task this person owns, so the Activity screen and anything written against the
 * client library can watch the whole workspace with one connection.
 *
 * `kinds` names the kinds of event wanted; an empty list means all of them. `after` is the last id
 * already seen, so a client that reconnects carries on rather than repeating itself.
 *
 * Q253: `scopeNow` answers whose records the window shows at this moment. When it stops naming the
 * `owner` the stream was opened for (the window switched to a household person, or back), nothing
 * more is written and the stream ends, so the window reconnects under whoever is there now.
 */
export async function streamOwnerEvents(
  store: Store, owner: string, response: ServerResponse,
  options: {
    after?: number; kinds?: readonly string[]; pollMs?: number; maxMs?: number;
    /** Most events one connection may be sent before it is closed. */
    maxEvents?: number;
    /** Takes any saved password or key back out before an event is sent (the runtime's own). */
    scrub?: <T>(value: T) => T;
    /** Whose records the window shows now (profiles.scope()); the stream ends once it is not `owner`. */
    scopeNow?: () => string;
  } = {},
): Promise<void> {
  // Nobody may ask to be held open longer than the ceiling, nor to be sent an unbounded number of
  // events: both are capped here, so one connection can never be made to run for ever.
  const pollMs = options.pollMs ?? 500;
  const maxMs = Math.min(Math.max(options.maxMs ?? 150000, 1000), 150000);
  const maxEvents = Math.min(Math.max(options.maxEvents ?? 2000, 1), 5000);
  const deadline = Date.now() + maxMs;
  const scrub = options.scrub ?? (<T>(value: T) => value);
  let sent = 0, moved = false;
  const scopeMoved = () => options.scopeNow !== undefined && options.scopeNow() !== owner;
  const wanted = new Set(options.kinds ?? []);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
  response.flushHeaders();
  // Starting from "everything so far" would replay a whole history, so with no `after` the stream
  // begins at the newest event and reports only what happens from now on.
  let last = options.after ?? (store.recentEvents(owner, 1)[0]?.id ?? 0);
  let closed = false;
  response.on("close", () => { closed = true; });
  response.write(`event: ready\ndata: ${JSON.stringify({ after: last, kinds: [...wanted] })}\n\n`);
  while (!closed && Date.now() < deadline) {
    if ((moved = scopeMoved())) break;
    // recentEvents comes back newest first, so it is turned round to keep the stream in order.
    const fresh = store.recentEvents(owner, 200).filter((event) => event.id > last).reverse();
    for (const event of fresh) {
      // Checked again before every event, not only once a poll, so nothing of the scope the stream
      // opened with goes out after the window has moved to somebody else.
      if ((moved = scopeMoved())) break;
      last = Math.max(last, event.id);
      if (wanted.size && !wanted.has(event.kind)) continue;
      // An event's own body can hold what a tool was asked to do, so it goes out through the same
      // scrubbing as everything else that leaves this computer.
      response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(scrub({ id: event.id, runId: event.runId, kind: event.kind, data: event.data, createdAt: event.createdAt }))}\n\n`);
      if (++sent >= maxEvents) { closed = true; break; }
    }
    if (closed || moved) break;
    await delay(pollMs);
  }
  response.write(`event: end\ndata: ${JSON.stringify({ after: last, sent, ...(moved ? { reason: "profile" } : {}) })}\n\n`);
  response.end();
}
