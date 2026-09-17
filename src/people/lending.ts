import type { Store } from "../store.js";

/**
 * Bucket 19 (integration review): a person's own conversation is lent to the assistant while their
 * task runs (src/collab-server.ts `runForCurrentPerson` hands it to the owner's name and back). Each
 * such task writes down whose conversation it is (`run.started.lentTo`), so the lending is never
 * mistaken for the owner's own conversation: not by sharing, not by another person's key, and not
 * after a restart cut a task off in the middle, when the conversation is handed back at start.
 */
type Db = Pick<Store, "sqlite">;

/** The person's record name a conversation belongs to when it is lent, or null for the owner's own. */
export function lentOwner(store: Db, sessionId: string): string | null {
  const row = store.sqlite.prepare(`SELECT json_extract(e.data,'$.lentTo') AS lent FROM events e JOIN tasks t ON t.id=e.run_id
    WHERE t.session_id=? AND e.kind='run.started' AND json_extract(e.data,'$.lentTo') IS NOT NULL LIMIT 1`).get(sessionId);
  return typeof row?.lent === "string" ? row.lent : null;
}

/** Hands back every lent conversation still in the owner's name (a restart cut its task off). */
export function returnLentSessions(store: Store, owner: string): number {
  const rows = store.sqlite.prepare(`SELECT DISTINCT t.session_id AS sid, json_extract(e.data,'$.lentTo') AS lent FROM events e
    JOIN tasks t ON t.id=e.run_id JOIN sessions s ON s.id=t.session_id
    WHERE e.kind='run.started' AND s.owner=? AND json_extract(e.data,'$.lentTo') IS NOT NULL`).all(owner);
  let returned = 0;
  for (const row of rows) {
    if (typeof row.lent !== "string" || !row.lent.startsWith("profile:")) continue;
    store.reassignSession(String(row.sid), row.lent);
    returned += 1;
  }
  return returned;
}
