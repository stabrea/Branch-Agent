import { z } from "zod";
import type { createBranch } from "./index.js";
import { auditLabel } from "./audit.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

export const UnifiedSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
}).strict();

/**
 * One row from any of the three places this searches. `link` is always a route the app can open
 * on its own (a conversation, a saved workflow, or the record of what the assistant was allowed to
 * do) so a result never needs its own new page.
 */
export interface UnifiedSearchResult {
  kind: "conversation" | "workflow" | "repository";
  title: string;
  snippet: string;
  link: string;
}

/** How many rows each source may contribute, so one busy source cannot crowd out the other two. */
const perSourceLimit = 5;

/** True when every word of the query appears somewhere in the text, ignoring case. */
function matchesAllWords(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.length > 0 && words.every((word) => lower.includes(word));
}

/**
 * FQ-collaboration.unified-search: one query, fanned out to the searches Branch already has —
 * conversations (src/history.ts, the same full-text index the "history.search" tool uses),
 * saved workflows (src/workflows.ts), and the durable record of what the assistant was allowed to
 * do (src/audit.ts, which is what the app treats as its "repository" of collaboration events). No
 * new index or database is created here; this only reads what those three already keep.
 */
export function unifiedSearch(app: Branch, owner: string, rawQuery: string): UnifiedSearchResult[] {
  const { q } = UnifiedSearchQuerySchema.parse({ q: rawQuery });
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const results: UnifiedSearchResult[] = [];

  results.push(...conversationResults(app, owner, q));
  results.push(...workflowResults(app, owner, words));
  results.push(...repositoryResults(app, owner, words));
  return results;
}

/** Earlier conversations whose messages match the query, by the same search "history.search" uses. */
function conversationResults(app: Branch, owner: string, query: string): UnifiedSearchResult[] {
  const found = app.store.searchHistory(owner, { query, limit: perSourceLimit }, "");
  return found.map((row) => ({
    kind: "conversation" as const,
    title: `Conversation ${row.sessionId.slice(0, 8)}`,
    snippet: row.excerpt,
    link: `/api/sessions/${row.sessionId}`,
  }));
}

/** Saved workflows whose name, description or a step's output holds every word of the query. */
function workflowResults(app: Branch, owner: string, words: readonly string[]): UnifiedSearchResult[] {
  const results: UnifiedSearchResult[] = [];
  for (const workflow of app.workflows.list(owner)) {
    const stepOutputs = workflow.state.map((step) => step.output);
    const haystack = [workflow.name, workflow.description, ...stepOutputs].join(" ");
    if (!matchesAllWords(haystack, words)) continue;
    const matchedStep = workflow.state.find((step) => matchesAllWords(step.output, words));
    results.push({
      kind: "workflow",
      title: workflow.name,
      snippet: (matchedStep?.output || workflow.description || workflow.name).slice(0, 200),
      link: `/api/workflows/${workflow.id}`,
    });
    if (results.length >= perSourceLimit) break;
  }
  return results;
}

/** Entries from the audit record whose actor, subject, reason or label holds every word of the query. */
function repositoryResults(app: Branch, owner: string, words: readonly string[]): UnifiedSearchResult[] {
  const results: UnifiedSearchResult[] = [];
  for (const entry of app.store.audit.list(owner, { limit: 200 })) {
    const haystack = `${entry.actor} ${entry.subject} ${entry.reason} ${auditLabel(entry.action)}`;
    if (!matchesAllWords(haystack, words)) continue;
    results.push({
      kind: "repository",
      title: auditLabel(entry.action),
      snippet: entry.subject || entry.reason,
      // The audit record has no single-entry page; its list is the route the app already opens for it.
      link: "/api/audit",
    });
    if (results.length >= perSourceLimit) break;
  }
  return results;
}
