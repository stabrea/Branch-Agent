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
    // Q253: the stream follows who is at the window. Once the window is switched to someone whose run this is
    // not, it ends before anything more is sent; reconnecting asks the route again, which refuses.
    if (store.run(runId)?.owner !== store.profiles.scope()) {
      response.write(`event: end\ndata: ${JSON.stringify({ status: "switched" })}\n\n`);
      break;
    }
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
 */
export async function streamOwnerEvents(
  store: Store, owner: string, response: ServerResponse,
  options: {
    after?: number; kinds?: readonly string[]; pollMs?: number; maxMs?: number;
    /** Most events one connection may be sent before it is closed. */
    maxEvents?: number;
    /** Takes any saved password or key back out before an event is sent (the runtime's own). */
    scrub?: <T>(value: T) => T;
  } = {},
): Promise<void> {
  // Nobody may ask to be held open longer than the ceiling, nor to be sent an unbounded number of
  // events: both are capped here, so one connection can never be made to run for ever.
  const pollMs = options.pollMs ?? 500;
  const maxMs = Math.min(Math.max(options.maxMs ?? 150000, 1000), 150000);
  const maxEvents = Math.min(Math.max(options.maxEvents ?? 2000, 1), 5000);
  const deadline = Date.now() + maxMs;
  const scrub = options.scrub ?? (<T>(value: T) => value);
  let sent = 0;
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
    // Q253: whose events these are was fixed when the stream opened. Once the window is switched to someone
    // else, it ends before anything more is sent, and reconnecting opens a stream of the new person's own.
    if (store.profiles.scope() !== owner) break;
    // recentEvents comes back newest first, so it is turned round to keep the stream in order.
    const fresh = store.recentEvents(owner, 200).filter((event) => event.id > last).reverse();
    for (const event of fresh) {
      last = Math.max(last, event.id);
      if (wanted.size && !wanted.has(event.kind)) continue;
      // An event's own body can hold what a tool was asked to do, so it goes out through the same
      // scrubbing as everything else that leaves this computer.
      response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(scrub({ id: event.id, runId: event.runId, kind: event.kind, data: event.data, createdAt: event.createdAt }))}\n\n`);
      if (++sent >= maxEvents) { closed = true; break; }
    }
    if (closed) break;
    await delay(pollMs);
  }
  response.write(`event: end\ndata: ${JSON.stringify({ after: last, sent })}\n\n`);
  response.end();
}
