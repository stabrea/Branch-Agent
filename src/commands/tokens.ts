import type { Runtime } from "../runtime.js";
import { estimateTokens, textOnly } from "../contracts.js";
import { estimateCost, formatCost, pricingSettings } from "../pricing.js";

/**
 * `/tokens`: what fills the next request, the idea of Aider's `/tokens` (Apache-2.0) written for
 * Branch. It reuses the figures a task already writes before each round (the `context.budget`
 * event: instructions, the list of tools, the conversation, the room kept for the answer), so it
 * reports what Branch really measured rather than a second guess. A conversation with no task yet
 * is measured from its stored messages.
 */
export interface TokenReport {
  instructions: number;
  tools: number;
  conversation: number;
  answerRoom: number;
  limit: number;
  left: number;
  summary: number;
  messages: number;
  measured: "last task" | "stored messages";
  model: string;
  cost: string;
}

type Budget = { limit?: number; system?: number; catalog?: number; messages?: number; reserve?: number };
const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function lastBudget(runtime: Runtime, sessionId: string): Budget | null {
  const runs = runtime.store.runs(runtime.owner).filter((run) => run.sessionId === sessionId);
  for (const run of runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const found = runtime.store.events(run.id).filter((event) => event.kind === "context.budget").at(-1);
    if (found) return found.data as Budget;
  }
  return null;
}

export function tokenReport(runtime: Runtime, sessionId: string): TokenReport {
  const { summary, rows } = runtime.store.workingMessages(sessionId);
  const stored = estimateTokens(rows.map((row) => textOnly(row.message)));
  const budget = lastBudget(runtime, sessionId);
  const choice = runtime.models.plan(runtime.owner, sessionId).choice;
  const conversation = budget ? n(budget.messages) - n(budget.system) : stored;
  const instructions = n(budget?.system), tools = n(budget?.catalog), limit = n(budget?.limit) || 20000;
  const input = instructions + tools + Math.max(0, conversation);
  const { overrides } = pricingSettings(runtime.store, runtime.owner);
  return {
    instructions, tools, conversation: Math.max(0, conversation), answerRoom: n(budget?.reserve), limit,
    left: limit - input, summary: summary ? estimateTokens(summary) : 0, messages: rows.length,
    measured: budget ? "last task" : "stored messages", model: choice.model,
    cost: formatCost(estimateCost(choice.model, { input, output: 0 }, overrides)),
  };
}

const k = (count: number): string => (Math.abs(count) >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
export function tokenLines(report: TokenReport): string[] {
  const lines = [
    `What the next request carries (measured from the ${report.measured}, about ${k(report.limit)} tokens of room):`,
    `  instructions      ${k(report.instructions)}`,
    `  list of tools     ${k(report.tools)}`,
    `  conversation      ${k(report.conversation)} (${report.messages} messages${report.summary ? `, of which a summary of ${k(report.summary)}` : ""})`,
  ];
  if (report.answerRoom) lines.push(`  kept for answer   ${k(report.answerRoom)}`);
  lines.push(`  room left         ${k(report.left)}`);
  lines.push(`Sending it to ${report.model} would cost ${report.cost} before the answer.`);
  if (report.left < report.limit * 0.2) lines.push("It is nearly full: /compact folds the earlier part into a summary.");
  return lines;
}
