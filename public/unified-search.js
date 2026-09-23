/**
 * FQ-collaboration.unified-search: wires the owner-only GET /api/search route (src/unified-search.ts)
 * into the command palette (Ctrl K / the top-bar "Search" box, public/shell.js), so a query that
 * matches nothing local — no place, setting or loaded conversation title — can still reach the words
 * inside an earlier conversation, a saved workflow, or the record of what the assistant was allowed
 * to do. A new file so the palette only needs one import and one call, rather than growing this
 * fetch-and-map logic inline where the other feature agents working the same window are also editing.
 */
import { api, displayView, openConversation } from "/app.js";

/** Shown after each remote result's title, so it reads as "Workflow — <snippet>" in the list. */
const KIND_HINTS = {
  conversation: "Conversation",
  workflow: "Workflow",
  repository: "What it was allowed to do",
};

/** A query this short is almost always still being typed; it is not worth a round trip yet. */
const MIN_QUERY_LENGTH = 2;

/** Opens whichever place already shows that result's source (src/unified-search.ts picks the link). */
function openResult(result) {
  if (result.kind === "conversation") {
    const sessionId = result.link.split("/").pop();
    displayView("chat");
    void openConversation(sessionId);
    return;
  }
  if (result.kind === "workflow") {
    displayView("automations");
    return;
  }
  // "repository": the record of what the assistant was allowed to do lives at the foot of Usage.
  displayView("usage");
}

/**
 * Palette entries for the owner's earlier conversations, saved workflows and audit record, source-
 * linked back to the place each one lives. Returns [] for a query too short to bother with, and
 * silently returns [] on any error — a signed-out window, a household profile, a network hiccup —
 * rather than interrupting someone who is still typing.
 */
export async function unifiedSearchEntries(query, signal) {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  let data;
  try {
    data = await api(`search?q=${encodeURIComponent(q)}`, undefined, "GET", signal);
  } catch {
    return [];
  }
  return (data.results ?? []).map((result) => ({
    label: result.title,
    hint: `${KIND_HINTS[result.kind] ?? result.kind} — ${result.snippet}`.slice(0, 140),
    run: () => openResult(result),
    // Lets the palette drop a conversation its own recent list already offers by its real title,
    // rather than repeating it under this generic one (src/unified-search.ts names conversation
    // results "Conversation <id>", not the conversation's own title).
    sessionId: result.kind === "conversation" ? result.link.split("/").pop() : undefined,
  }));
}
