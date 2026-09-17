import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { agentPromptFrom } from "../providers/cli-agent.js";

/**
 * A0601: Codex's app-server as a backend. Where the owner has OpenAI's `codex` program installed and
 * signed in, Branch starts `codex app-server` and holds one turn with it over the app-server protocol
 * (the same protocol src/asks/app-server.ts speaks the other way round): initialize, a new thread
 * that may only read (`sandbox: read-only`, `approvalPolicy: never`), one turn with Branch's
 * transcript as the request, and the answer streamed back word by word.
 *
 * Codex is never allowed to change anything this way: its sandbox is read-only, and any approval it
 * asks for anyway is declined. Codex's own sign-in stays Codex's; Branch never sees it. The program
 * is started from its name with fixed arguments and no shell, with only what it needs to find itself
 * and its sign-in in its environment.
 */
export interface AppServerChild {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
  onExit(listener: (code: number | null, missing: boolean) => void): void;
  stop(): void;
}
export type StartAppServer = (command: string) => AppServerChild;

const passedThrough = ["PATH", "PATHEXT", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP", "CODEX_HOME"];

export const startCodexAppServer: StartAppServer = (command) => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of passedThrough) if (process.env[name]) env[name] = process.env[name];
  const child = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true, env });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const listeners: ((message: Record<string, unknown>) => void)[] = [];
  lines.on("line", (line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (parsed && typeof parsed === "object") for (const listener of listeners) listener(parsed as Record<string, unknown>);
  });
  child.stdin.on("error", () => undefined);
  return {
    send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); },
    onMessage: (listener) => { listeners.push(listener); },
    onExit: (listener) => {
      child.on("error", (error: NodeJS.ErrnoException) => listener(1, error.code === "ENOENT"));
      child.on("exit", (code) => listener(code, false));
    },
    stop: () => { child.kill(); },
  };
};

type Message = Record<string, unknown> & { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

/** One conversation turn with a Codex app-server, from the handshake to `turn/completed`. */
class Turn {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Message) => void>();
  private text = "";
  constructor(private readonly child: AppServerChild, private readonly request: CompletionRequest,
    private readonly done: (error: Error | null, text: string) => void, private readonly version: string) {
    child.onMessage((message) => this.receive(message as Message));
  }
  private ask(method: string, params: Record<string, unknown>): Promise<Message> {
    const id = this.nextId++;
    return new Promise((resolve) => { this.waiting.set(id, resolve); this.child.send({ id, method, params }); });
  }
  private receive(message: Message): void {
    if (typeof message.id === "number" && !message.method) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
      return;
    }
    // A question from Codex: approvals are always declined, anything else is not spoken here.
    if (message.id !== undefined && message.method) {
      const approval = /requestApproval$/.test(message.method);
      this.child.send(approval ? { id: message.id, result: { decision: "decline" } } : { id: message.id, error: { code: -32601, message: "Not supported" } });
      return;
    }
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.text += params.delta;
      this.request.onTextDelta?.(params.delta);
    }
    if (message.method === "item/completed") {
      const item = params.item as { type?: string; text?: string } | undefined;
      if (!this.text && item?.type === "agentMessage" && typeof item.text === "string") this.text = item.text;
    }
    if (message.method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
      if (turn?.status === "completed") this.done(null, this.text);
      else this.done(new Error(`Codex stopped without finishing: ${turn?.error?.message ?? turn?.status ?? "no reason given"}`), this.text);
    }
  }
  async start(): Promise<void> {
    const hello = await this.ask("initialize", { clientInfo: { name: "branch_agent", title: "Branch Agent", version: this.version }, capabilities: null });
    if (hello.error) throw new Error(`Codex refused to start: ${hello.error.message ?? "no reason given"}`);
    this.child.send({ method: "initialized" });
    const thread = await this.ask("thread/start", { approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const threadId = (thread.result?.thread as { id?: string } | undefined)?.id;
    if (!threadId) throw new Error(`Codex did not open a conversation: ${thread.error?.message ?? "no reason given"}`);
    const turn = await this.ask("turn/start", { threadId, input: [{ type: "text", text: agentPromptFrom(this.request), text_elements: [] }] });
    if (turn.error) throw new Error(`Codex refused the request: ${turn.error.message ?? "no reason given"}`);
  }
}

export class CodexAppServerProvider implements Provider {
  readonly name = "app-server:codex";
  constructor(private readonly command = "codex", private readonly start: StartAppServer = startCodexAppServer,
    private readonly version = "0", private readonly timeoutMs = 300_000) {}

  complete(request: CompletionRequest): Promise<Completion> {
    const child = this.start(this.command);
    return new Promise<Completion>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, text: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        child.stop();
        if (error) reject(error);
        else if (!text.trim()) reject(new Error("Codex answered with nothing at all."));
        else resolve({ content: text.trim(), toolCalls: [] });
      };
      const abort = (): void => finish(new Error("The request was stopped."), "");
      const timer = setTimeout(() => finish(new Error("Codex took too long and was stopped. Ask again, or pick another model."), ""), this.timeoutMs);
      timer.unref?.();
      request.signal.addEventListener("abort", abort, { once: true });
      child.onExit((code, missing) => finish(new Error(missing
        ? `"${this.command}" is not on this computer, so Branch cannot use Codex. Install it, or pick another model.`
        : `Codex stopped (${code ?? "killed"}) before it finished answering.`), ""));
      new Turn(child, request, finish, this.version).start().catch((error: Error) => finish(error, ""));
    });
  }
  modelsList(): null { return null; }
}
