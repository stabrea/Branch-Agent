import type { Message, ToolCall } from "./contracts.js";

/** Fill interrupted protocol gaps with uncertainty, without executing any tool. */
export function reconcileTranscript(messages: Message[], reason: string) {
  const repaired: Message[] = [];
  let pending: ToolCall[] = [];
  let added = 0;
  const flush = () => {
    for (const call of pending) {
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify({
          ok: false,
          status: "interrupted",
          outcome: "unknown",
          error: `No durable tool result was recorded (${reason}). Side effects may have occurred. Check actual state before retrying.`,
        }),
      });
      added++;
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role === "tool") {
      pending = pending.filter((call) => call.id !== message.toolCallId);
    } else {
      flush();
      if (message.role === "assistant")
        pending = [...(message.toolCalls ?? [])];
    }
    repaired.push(message);
  }
  flush();
  return { messages: repaired, added };
}
