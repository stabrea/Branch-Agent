import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";

/**
 * An OpenAI-style chat endpoint so tools that speak that shape can talk to the assistant. The last
 * user message becomes the task; caller instructions travel with it; `x-branch-session` (or
 * metadata.session_id) continues a conversation. Streaming follows the chat.completion.chunk shape.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
const Part = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
const RequestSchema = z.object({
  model: z.string().max(200).optional(),
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant", "tool"]), content: z.union([z.string(), z.array(Part), z.null()]).optional() }).passthrough()).min(1).max(200),
  stream: z.boolean().optional(),
  user: z.string().max(200).optional(),
  metadata: z.object({ session_id: z.string().uuid().optional() }).passthrough().optional(),
}).passthrough();
export type OpenAIRequest = z.infer<typeof RequestSchema>;

const text = (content: OpenAIRequest["messages"][number]["content"]): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : "";

/** The task prompt: caller instructions (system/developer) first, then the last user message. */
export function promptFrom(request: OpenAIRequest): string {
  const instructions = request.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).filter(Boolean).join("\n");
  const user = [...request.messages].reverse().find((m) => m.role === "user");
  if (!user) throw new Error("The request needs a user message");
  const prompt = text(user.content).trim();
  if (!prompt) throw new Error("The last user message is empty");
  return instructions ? `Instructions from the calling program:\n${instructions.slice(0, 4000)}\n\n${prompt}` : prompt;
}

export function modelsList(app: Branch) {
  return { object: "list", data: [...app.runtime.models.presets.values()].map((p) => ({ id: p.id, object: "model", created: 0, owned_by: p.provider.name })) };
}

function sse(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
  response.flushHeaders();
}
const chunk = (id: string, model: string, created: number, delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

export async function chatCompletion(app: Branch, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
  const parsed = RequestSchema.parse(body);
  const prompt = promptFrom(parsed);
  const sessionHeader = request.headers["x-branch-session"];
  const sessionId = parsed.metadata?.session_id ?? (typeof sessionHeader === "string" && /^[a-f0-9-]{36}$/.test(sessionHeader) ? sessionHeader : undefined);
  const preset = parsed.model && app.runtime.models.presets.has(parsed.model) ? parsed.model : undefined;
  const created = Math.floor(Date.now() / 1000);
  let id = "", started = false;
  const begin = (runId: string) => { id = `chatcmpl-${runId}`; if (parsed.stream && !started) { started = true; response.write(chunk(id, preset ?? "branch", created, { role: "assistant", content: "" }, null)); } };
  if (parsed.stream) sse(response);
  const run = await app.runtime.run({
    prompt, ...(sessionId ? { sessionId } : {}), ...(preset ? { model: preset } : {}),
    onStarted: (r) => begin(r.id),
    onTextDelta: parsed.stream ? (piece) => { if (piece) response.write(chunk(id, preset ?? "branch", created, { content: piece }, null)); } : () => undefined,
  });
  const finish = run.status === "completed" ? "stop" : run.status === "budget_exceeded" ? "length" : "error";
  const usage = app.store.usage(run.id) as { estimatedInput?: number; estimatedOutput?: number };
  const branch = { run_id: run.id, session_id: run.sessionId, status: run.status };
  if (parsed.stream) {
    if (run.status !== "completed") response.write(chunk(id, preset ?? "branch", created, { content: run.output }, null));
    response.write(chunk(id, preset ?? "branch", created, {}, finish));
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: preset ?? "branch", choices: [], branch })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  const payload = {
    id: `chatcmpl-${run.id}`, object: "chat.completion", created, model: preset ?? "branch",
    choices: [{ index: 0, message: { role: "assistant", content: run.output }, finish_reason: finish }],
    usage: { prompt_tokens: usage.estimatedInput ?? 0, completion_tokens: usage.estimatedOutput ?? 0, total_tokens: (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0) },
    branch,
  };
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(payload));
}
