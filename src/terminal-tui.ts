import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Event, ImagePart, Run } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
// Wave 8: the terminal says what a round used and what it cost, as the web app already does.
import { estimateCost, formatCost, pricingTableInUse } from "./pricing.js";
import type { PendingApproval } from "./approvals.js";
import type { ReasoningEffort } from "./models.js";
import { LineEditor } from "./terminal-input.js";
import {
  paint, progressIndicator, resolveStyle, windowTitle, wrap, type TerminalStyle,
} from "./terminal-style.js";
import {
  attachedText, choosePreset, exportConversation, historyLines, presetLines, readAttachment,
  statusLine, type Attachment,
} from "./terminal-commands.js";

/**
 * The full terminal view: a status line that stays put, answers that stream in wrapped to the
 * window, one short row per step the assistant takes, and slash commands. It uses nothing but
 * Node's own readline and escape sequences, and it draws nothing at all when the terminal cannot
 * take it — `branch chat` falls back to the plain streaming view in that case.
 */
export interface TuiOptions {
  input?: Readable & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output?: Writable & { columns?: number; rows?: number };
  env?: NodeJS.ProcessEnv;
  signals?: EventEmitter;
  pollIntervalMs?: number;
}
export function startTui(runtime: Runtime, options: TuiOptions = {}): Promise<void> {
  return new Tui(runtime, options).start();
}

interface Step { label: string; tool: string; status: "working" | "done" | "failed"; detail: string }
interface ActiveRun { controller: AbortController; run?: Run; eventId: number; steps: Step[] }
const safe = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const helpText = [
  "/help                 this list",
  "/model [id]           which model answers; /model on its own lists them",
  "/preset [name]        when Branch checks with you before doing something",
  "/memory [words]       facts it has saved",
  "/skills               skills installed here",
  "/plan                 turn a short plan first on or off",
  "/verify               turn a reviewer's check of the answer on or off",
  "/dry-run              turn practice mode on or off (nothing is really changed)",
  "/attach <file>        send a file or picture with your next message",
  "/history              this conversation so far",
  "/export [file]        save this conversation as a Markdown file",
  "/new                  start a fresh conversation",
  "/exit                 leave",
  "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops the task · Ctrl+D leaves",
];

class Tui {
  private readonly input: TuiOptions["input"] & Readable;
  private readonly output: Writable & { columns?: number };
  private readonly signals: EventEmitter;
  private readonly style: TerminalStyle;
  private readonly editor: LineEditor;
  private readonly pollIntervalMs: number;
  private readonly echo: boolean;
  private sessionId: string | undefined;
  private model: string | undefined;
  private reasoning: ReasoningEffort | null | undefined;
  private plan = false;
  private verify = false;
  private dryRun = false;
  private details = false;
  private attachments: Attachment[] = [];
  private active: ActiveRun | undefined;
  private awaiting: PendingApproval | undefined;
  private awaitingPrompt = "";
  private queue: string[] = [];
  private busy = false;
  private closing = false;
  private footerLines = 0;
  private cursorUp = 0;
  private stream = "";
  private resolveDone: (() => void) | undefined;

  constructor(private readonly runtime: Runtime, options: TuiOptions) {
    const env = options.env ?? process.env;
    this.input = (options.input ?? process.stdin) as TuiOptions["input"] & Readable;
    this.output = options.output ?? process.stdout;
    this.signals = options.signals ?? process;
    this.style = resolveStyle(env, { columns: this.output.columns });
    this.pollIntervalMs = options.pollIntervalMs ?? 75;
    this.echo = !this.style.cursor && this.input.isTTY === true;
    this.editor = new LineEditor({
      submit: (text) => void this.submit(text),
      interrupt: () => this.interrupt(),
      quit: () => this.quit(),
      shortcut: (name) => this.shortcut(name),
      changed: () => this.redraw(),
    });
  }

  start(): Promise<void> {
    const done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.editor.attach(this.input);
    this.signals.on("SIGINT", this.onSignal);
    this.input.once("end", this.quit);
    this.write(windowTitle(this.style, "Branch Agent"));
    this.emit("Branch Agent — type a message and press Enter. /help lists what you can do here.");
    this.drawFooter();
    return done;
  }

  // ---- drawing -------------------------------------------------------------
  private get width(): number { return Math.max(24, this.style.columns); }
  private write(text: string): void { if (text) this.output.write(text); }
  /** Prints lines above the status line and the line being typed, then draws those again. */
  private emit(text: string): void {
    this.eraseFooter();
    for (const line of wrap(safe(text), this.width)) this.output.write(line + "\n");
    this.drawFooter();
  }
  private eraseFooter(): void {
    if (!this.style.cursor || !this.footerLines) return;
    if (this.cursorUp > 0) this.write(`\x1b[${this.cursorUp}B`);
    if (this.footerLines > 1) this.write(`\x1b[${this.footerLines - 1}A`);
    this.write("\r\x1b[0J");
    this.footerLines = 0;
    this.cursorUp = 0;
  }
  private promptLines(): string[] {
    const marker = this.awaiting ? "Answer (y/n/a/s)> " : "You> ";
    const [first = "", ...rest] = this.editor.text.split("\n");
    return [marker + first, ...rest.map((line) => "  … " + line)];
  }
  private drawFooter(): void {
    if (!this.style.cursor || this.closing) return;
    const status = statusLine(this.runtime, this.sessionId, this.model, this.width);
    const flags = [this.plan && "plan", this.verify && "verify", this.dryRun && "practice"].filter(Boolean).join(" ");
    const lines = [paint(this.style, "dim", `— ${status}${flags ? " · " + flags : ""} —`), ...this.promptLines()];
    this.write("\r\x1b[0J" + lines.join("\n"));
    this.footerLines = lines.length;
    this.placeCursor(lines.length);
  }
  /** Puts the cursor where the person is typing, rather than at the end of the drawn block. */
  private placeCursor(drawn: number): void {
    const before = this.editor.text.slice(0, this.editor.at).split("\n");
    const row = drawn - this.promptLines().length + before.length - 1;
    const column = (before.length === 1 ? (this.awaiting ? 18 : 5) : 4) + (before.at(-1)?.length ?? 0);
    this.cursorUp = drawn - 1 - row;
    if (this.cursorUp > 0) this.write(`\x1b[${this.cursorUp}A`);
    this.write("\r" + (column > 0 ? `\x1b[${column}C` : ""));
  }
  private redraw(): void {
    if (this.style.cursor) { this.eraseFooter(); this.drawFooter(); return; }
    if (this.echo) this.write("\r" + this.promptLines().join(" ") + " \x08");
  }
  /** Streams model text, wrapped, keeping the unfinished last line back until it is complete. */
  private streamDelta(text: string): void {
    this.stream += safe(text);
    const lines = wrap(this.stream, this.width);
    while (lines.length > 1) this.emit(lines.shift()!);
    this.stream = lines[0] ?? "";
  }
  private flushStream(): void {
    if (this.stream) { const text = this.stream; this.stream = ""; this.emit(text); }
  }

  // ---- keys ----------------------------------------------------------------
  private onSignal = (): void => this.interrupt();
  private interrupt(): void {
    this.queue = [];
    if (!this.active || this.active.controller.signal.aborted) {
      this.emit("[nothing is working right now; press Ctrl+D to leave]");
      return;
    }
    this.active.controller.abort(new Error("Cancelled by user"));
    this.emit("[stopping; waiting for the task to tidy up]");
  }
  private quit = (): void => {
    if (this.closing) return;
    this.closing = true;
    this.queue = [];
    this.active?.controller.abort(new Error("Cancelled by user"));
    this.eraseFooter();
    this.write(progressIndicator(this.style, "none") + windowTitle(this.style, "Branch Agent"));
    this.output.write("Goodbye.\n");
    this.finish();
  };
  private shortcut(name: string): void {
    if (name !== "ctrl+e") return;
    this.details = !this.details;
    const steps = this.active?.steps ?? this.lastSteps;
    this.emit(`[step details ${this.details ? "on" : "off"}]`);
    if (this.details) for (const step of steps) this.emit(`    ${step.tool} — ${step.detail || step.label} (${step.status})`);
  }
  private lastSteps: Step[] = [];

  // ---- input ---------------------------------------------------------------
  private async submit(text: string): Promise<void> {
    if (this.closing) return;
    this.redraw();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.awaiting) return this.answerApproval(trimmed);
    if (trimmed === "/exit") return this.quit();
    if (trimmed === "/new") {
      this.sessionId = undefined;
      this.emit("[new conversation; the next message starts it]");
      return;
    }
    if (trimmed.startsWith("/")) return this.command(trimmed);
    this.queue.push(trimmed);
    await this.drain();
  }
  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.closing) await this.execute(this.queue.shift()!);
    } finally {
      this.busy = false;
      this.drawFooterIfIdle();
    }
  }
  private drawFooterIfIdle(): void {
    if (!this.closing && this.style.cursor) { this.eraseFooter(); this.drawFooter(); }
  }

  // ---- slash commands ------------------------------------------------------
  private async command(text: string): Promise<void> {
    const [name, ...rest] = text.split(/\s+/);
    const argument = rest.join(" ");
    try {
      if (!(await this.simpleCommand(name!, argument)) && !this.modelCommand(name!, argument))
        this.emit(`I do not know ${name}. Type /help for the list.`);
    } catch (error) {
      this.emit(`[${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  /** The commands that only show something or flip a switch. */
  private async simpleCommand(name: string, argument: string): Promise<boolean> {
    if (name === "/help") { for (const line of helpText) this.emit(line); return true; }
    if (name === "/preset") {
      if (!argument) for (const line of presetLines(this.runtime)) this.emit(line);
      else this.emit(choosePreset(this.runtime, argument));
      return true;
    }
    if (name === "/plan" || name === "/verify" || name === "/dry-run") return this.toggle(name, argument);
    if (name === "/attach") {
      if (!argument) throw new Error("Name a file: /attach report.pdf");
      const attachment = await readAttachment(argument);
      this.attachments.push(attachment);
      this.emit(`[${attachment.name} goes with your next message]`);
      return true;
    }
    if (name === "/history") { for (const line of historyLines(this.runtime, this.sessionId)) this.emit(line); return true; }
    if (name === "/export") { this.emit(`[saved to ${await exportConversation(this.runtime, this.sessionId, argument || undefined)}]`); return true; }
    return this.knowledgeCommand(name, argument);
  }
  private toggle(name: string, argument: string): boolean {
    const on = argument ? argument === "on" : !(name === "/plan" ? this.plan : name === "/verify" ? this.verify : this.dryRun);
    if (name === "/plan") { this.plan = on; this.emit(`[a short plan first: ${on ? "on" : "off"}]`); }
    else if (name === "/verify") { this.verify = on; this.emit(`[a reviewer checks the answer: ${on ? "on" : "off"}]`); }
    else { this.dryRun = on; this.emit(`[practice run: ${on ? "on, nothing is really changed" : "off"}]`); }
    return true;
  }
  private knowledgeCommand(name: string, argument: string): boolean {
    const owner = this.runtime.owner;
    if (name === "/skills") {
      const skills = this.runtime.store.skills.list(owner);
      if (!skills.length) this.emit("No skills installed. Add SKILL.md documents in the app's Skills view.");
      for (const skill of skills) this.emit(`${skill.activeVersion ? "*" : " "} ${skill.name} — ${skill.description}`);
      return true;
    }
    if (name === "/memory") {
      const facts = argument ? this.runtime.store.searchMemory(owner, argument) : this.runtime.store.list("memory", owner).slice(0, 20);
      if (!facts.length) this.emit(argument ? "No saved facts match that." : "Nothing saved to memory yet.");
      for (const fact of facts) this.emit(`- ${String(fact.data.text)} (${String(fact.data.source)})`);
      return true;
    }
    return false;
  }
  private modelCommand(name: string, argument: string): boolean {
    const models = this.runtime.models, owner = this.runtime.owner;
    if (name === "/models" || (name === "/model" && !argument)) {
      const summary = models.summary(owner), active = this.model ?? summary.activePreset ?? summary.defaultPreset;
      for (const preset of summary.presets) this.emit(`${preset.id === active ? "*" : " "} ${preset.id} — ${preset.name} · ${preset.model}`);
      return true;
    }
    if (name === "/model") {
      if (!models.presets.has(argument)) { this.emit(`No model called ${argument}. Use /model to list them.`); return true; }
      this.model = argument;
      if (this.sessionId) models.configureSession(owner, this.sessionId, { preset: argument });
      this.emit(`[model set to ${models.presets.get(argument)!.name} for this conversation]`);
      return true;
    }
    if (name === "/think") {
      const choice = argument === "default" ? null : argument;
      if (choice !== null && !["low", "medium", "high"].includes(choice)) { this.emit("Use /think low, medium, high or default."); return true; }
      this.reasoning = choice as ReasoningEffort | null;
      if (this.sessionId) models.configureSession(owner, this.sessionId, { reasoning: this.reasoning });
      this.emit(`[thinking set to ${choice ?? "the model's default"} for this conversation]`);
      return true;
    }
    return false;
  }

  // ---- running a task ------------------------------------------------------
  private async execute(prompt: string): Promise<void> {
    const active: ActiveRun = { controller: new AbortController(), eventId: 0, steps: [] };
    this.active = active;
    const images = this.attachments.map((attachment) => attachment.image).filter((image): image is ImagePart => !!image);
    const text = prompt + attachedText(this.attachments);
    this.attachments = [];
    this.write(windowTitle(this.style, prompt.slice(0, 60)) + progressIndicator(this.style, "working"));
    const poll = setInterval(() => this.progress(active), this.pollIntervalMs);
    try {
      const run = await this.runtime.run({
        prompt: text, signal: active.controller.signal,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
        ...(images.length ? { images } : {}),
        ...(this.plan ? { plan: true } : {}), ...(this.verify ? { verify: true } : {}),
        ...(this.dryRun ? { dryRun: true } : {}),
        onStarted: (started) => { active.run = started; this.progress(active); },
        onTextDelta: (delta) => { this.progress(active); this.streamDelta(delta); },
      });
      this.sessionId = run.sessionId;
      this.progress(active);
      this.report(run, prompt);
    } catch {
      this.emit("[the task could not start or finish; run `branch logs` on it for details]");
    } finally {
      clearInterval(poll);
      this.lastSteps = active.steps;
      this.active = undefined;
      this.flushStream();
      this.write(progressIndicator(this.style, "none") + windowTitle(this.style, "Branch Agent"));
    }
  }
  /** What the person sees when a task stops, including the question it stopped on. */
  private report(run: Run, prompt: string): void {
    this.flushStream();
    if (run.status === "completed") {
      this.emit(paint(this.style, "green", "Assistant:"));
      this.emit(safe(run.output));
      // Wave 8: the terminal says what the task used, as the web app's meter already does.
      const used = usageLine(this.runtime.store, run);
      if (used) this.emit(paint(this.style, "dim", used));
      return;
    }
    const waiting = this.runtime.approvals.waiting(run.sessionId).at(-1);
    if (run.status === "needs_input" && waiting) return this.askApproval(waiting, prompt);
    if (run.status === "needs_input") { this.emit(safe(run.output)); return; }
    this.emit(paint(this.style, "yellow", `[task ${run.status}] ${safe(run.output).slice(0, 500)}`));
  }
  private askApproval(waiting: PendingApproval, prompt: string): void {
    this.awaiting = waiting;
    this.awaitingPrompt = prompt;
    this.emit(paint(this.style, "yellow", "[Branch needs your yes before it goes on]"));
    this.emit(`What: ${waiting.label}`);
    this.emit(`Tool: ${waiting.tool}`);
    if (waiting.target) this.emit(`Exactly: ${waiting.target}`);
    this.emit("Answer y (yes), n (no), a (yes, always) or s (yes, for this conversation), then Enter.");
  }
  /** y / n / a / s, answered through the same policy route the app's settings screen uses. */
  private async answerApproval(text: string): Promise<void> {
    const waiting = this.awaiting!, choice = text.trim().toLowerCase()[0];
    if (!choice || !"ynas".includes(choice)) { this.emit("Please answer y, n, a or s."); return; }
    this.awaiting = undefined;
    const decision = choice === "n" ? "deny" : "allow";
    const remember = choice === "a" ? "always" : choice === "s" ? "session" : choice === "n" ? "session" : waiting.remember;
    try {
      const answered = this.runtime.approve(waiting.sessionId, decision, remember);
      this.emit(`[noted: ${answered.decision === "allow" ? "go ahead" : "do not do that"} for ${answered.tool}${answered.target ? " on " + answered.target : ""}]`);
    } catch (error) {
      this.emit(`[${error instanceof Error ? error.message : String(error)}]`);
      return;
    }
    this.queue.push(this.awaitingPrompt);
    await this.drain();
  }
  /** New events since last time, as one short row each; Ctrl+E shows what is behind them. */
  private progress(active: ActiveRun): void {
    if (!active.run) return;
    for (const event of this.runtime.store.events(active.run.id)) {
      if (event.id <= active.eventId) continue;
      active.eventId = event.id;
      const row = stepRow(event, active.steps);
      if (row) this.emit(this.details ? `${row} — ${String(event.kind)}` : row);
    }
  }
  private finish(): void {
    this.editor.detach();
    this.input.removeListener("end", this.quit);
    this.signals.removeListener("SIGINT", this.onSignal);
    this.resolveDone?.();
    this.resolveDone = undefined;
  }
}

const cleanName = (value: unknown): string => String(value ?? "").replace(/[^a-zA-Z0-9_.:-]/g, "?").slice(0, 100);

/**
 * Wave 8: what a task used, in one line, for the terminal. Reported figures are what the service
 * itself counted; where it counted nothing, the estimate is named as an estimate rather than
 * passed off as the real number. Nothing at all is said when neither is known.
 */
export function usageLine(store: Store, run: Run): string | null {
  const used = store.usage(run.id);
  const at = (name: string): number => used[name] ?? 0;
  const reported = at("reportedInput") + at("reportedOutput");
  const estimated = at("estimatedInput") + at("estimatedOutput");
  if (!reported && !estimated) return null;
  const words = reported
    ? `${at("reportedInput")} in, ${at("reportedOutput")} out (counted by the service)`
    : `about ${at("estimatedInput")} in, about ${at("estimatedOutput")} out (an estimate)`;
  const cost = runCost(store, run, used);
  return `[tokens: ${words}${cost ? ` · ${cost}` : ""}]`;
}

/**
 * What one task cost, priced with whatever model actually answered. Where no price is on file for
 * that model, nothing is said at all rather than a figure nobody can stand behind.
 */
export function runCost(store: Store, run: Run, used: Record<string, number>): string | null {
  const model = store.events(run.id)
    .filter((event) => event.kind === "model.completed" && typeof event.data.model === "string")
    .map((event) => String(event.data.model)).at(-1);
  if (!model) return null;
  const { overrides } = pricingTableInUse(store, run.owner);
  const estimate = estimateCost(model, {
    input: used.reportedInput ?? used.estimatedInput ?? 0,
    output: used.reportedOutput ?? used.estimatedOutput ?? 0,
  }, overrides);
  return estimate.amount === null ? null : `${model} · ${formatCost(estimate)}`;
}
/**
 * One compact row per step, and nothing at all for events that are only interesting inside. Tool
 * results and error bodies never reach here: only the name of the tool and what it was asked to
 * touch, both of which the person already chose.
 */
export function stepRow(event: Event, steps: Step[]): string | undefined {
  const label = typeof event.data.label === "string" ? event.data.label.slice(0, 120) : "";
  const tool = cleanName(event.data.name);
  if (event.kind === "tool.started") {
    steps.push({ label: label || tool, tool, status: "working", detail: String(event.data.target ?? "") });
    return `  · ${label || tool}`;
  }
  if (event.kind === "tool.completed" || event.kind === "tool.failed") {
    const step = steps.findLast((entry) => entry.tool === tool && entry.status === "working");
    if (step) step.status = event.kind === "tool.failed" ? "failed" : "done";
    return `  ${event.kind === "tool.failed" ? "x" : "ok"} ${label || step?.label || tool}`;
  }
  if (event.kind === "policy.ask") return `  ? ${label || tool} is waiting for your yes`;
  if (event.kind === "tool.simulated") return `  ~ ${label || tool} (practice run; nothing was changed)`;
  if (event.kind === "model.retry_scheduled") return "  · the model is busy; trying again";
  if (event.kind === "run.steered") return "  · your note was added to the task";
  if (event.kind === "plan.created") return "  · a plan was written";
  return undefined;
}
