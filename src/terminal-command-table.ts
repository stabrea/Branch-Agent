import type { Runtime } from "./runtime.js";
import type { ReasoningEffort } from "./models.js";
import type { Conversation } from "./terminal-conversation.js";
import type { Route } from "./terminal-places.js";
import type { Words } from "./terminal-words.js";
import {
  choosePreset, exportConversation, historyLines, presetLines, readAttachment,
} from "./terminal-commands.js";

/**
 * Every slash command the terminal view understands, as one table: its name, other names, what it
 * does in the owner's words (a language key and its English), what it takes, and what it does.
 * The help list, the palette and the parser all read this table, so a command added here shows up
 * everywhere at once.
 */
export interface CommandContext {
  runtime: Runtime;
  conversation: Conversation;
  words: Words;
  say(kind: "note" | "warn" | "ok" | "bad" | "step", text: string): void;
  open(route: Route | string): void;
  theme(argument: string): Promise<void>;
  togglePane(tab?: string): void;
  lockdown(argument: string): void;
  switchSetting(name: string, value: string): void;
  resume(sessionId: string): void;
  sessions(): void;
  newConversation(): void;
  quit(): void;
  keys(): void;
}
export interface TerminalCommand {
  name: string;
  aliases: string[];
  key: string;
  english: string;
  args: string;
  run(context: CommandContext, argument: string): void | Promise<void>;
}

const command = (name: string, aliases: string[], args: string, english: string, run: TerminalCommand["run"]): TerminalCommand =>
  ({ name, aliases, args, key: `terminal.command.${name}`, english, run });
const onOff = (argument: string, current: boolean): boolean => (argument ? argument === "on" : !current);

function listModels(context: CommandContext): void {
  const { runtime, conversation } = context;
  const summary = runtime.models.summary(runtime.owner), active = conversation.model ?? summary.activePreset ?? summary.defaultPreset;
  for (const preset of summary.presets) context.say("note", `${preset.id === active ? "*" : " "} ${preset.id} — ${preset.name} · ${preset.model}`);
}
function chooseModel(context: CommandContext, argument: string): void {
  const { runtime, conversation } = context, models = runtime.models;
  if (!argument) return listModels(context);
  if (!models.presets.has(argument)) return context.say("warn", `No model called ${argument}. Use /model to list them.`);
  conversation.model = argument;
  if (conversation.sessionId) models.configureSession(runtime.owner, conversation.sessionId, { preset: argument });
  context.say("note", `[model set to ${models.presets.get(argument)!.name} for this conversation]`);
}
function think(context: CommandContext, argument: string): void {
  const { runtime, conversation } = context;
  const choice = argument === "default" ? null : argument;
  if (choice !== null && !["low", "medium", "high"].includes(choice)) return context.say("warn", "Use /think low, medium, high or default.");
  conversation.reasoning = choice as ReasoningEffort | null;
  if (conversation.sessionId) runtime.models.configureSession(runtime.owner, conversation.sessionId, { reasoning: conversation.reasoning });
  context.say("note", `[thinking set to ${choice ?? "the model's default"} for this conversation]`);
}
function skills(context: CommandContext): void {
  const list = context.runtime.store.skills.list(context.runtime.owner);
  if (!list.length) context.say("note", "No skills installed. Add a skill under Customize › Skills.");
  for (const skill of list) context.say("note", `${skill.activeVersion ? "*" : " "} ${skill.name} — ${skill.description}`);
}
function memory(context: CommandContext, argument: string): void {
  const { store, owner } = context.runtime;
  const facts = argument ? store.searchMemory(owner, argument) : store.list("memory", owner).slice(0, 20);
  if (!facts.length) context.say("note", argument ? "No saved facts match that." : "Nothing saved to memory yet.");
  for (const fact of facts) context.say("note", `- ${String(fact.data.text)} (${String(fact.data.source)})`);
}
async function attach(context: CommandContext, argument: string): Promise<void> {
  if (!argument) throw new Error("Name a file: /attach report.pdf");
  const attachment = await readAttachment(argument);
  context.conversation.attachments.push(attachment);
  context.say("note", `[${attachment.name} goes with your next message]`);
}
function toggle(name: "plan" | "verify" | "dryRun"): TerminalCommand["run"] {
  return (context, argument) => {
    const conversation = context.conversation, on = onOff(argument, conversation[name]);
    conversation[name] = on;
    const said = name === "plan" ? `a short plan first: ${on ? "on" : "off"}`
      : name === "verify" ? `a reviewer checks the answer: ${on ? "on" : "off"}` : `practice run: ${on ? "on, nothing is really changed" : "off"}`;
    context.say("note", `[${said}]`);
  };
}

export const TERMINAL_COMMANDS: TerminalCommand[] = [
  command("help", ["?"], "", "this list, and every key", (context) => context.keys()),
  command("model", ["models"], "[id]", "which model answers; /model on its own lists them", chooseModel),
  command("think", ["reasoning"], "<low|medium|high|default>", "how hard the model thinks in this conversation", think),
  command("preset", ["permissions"], "[name]", "when Branch checks with you before doing something", (context, argument) => {
    if (!argument) presetLines(context.runtime).forEach((line) => context.say("note", line));
    else context.say("note", choosePreset(context.runtime, argument));
  }),
  command("memory", [], "[words]", "facts it has saved", memory),
  command("skills", [], "", "skills installed here", skills),
  command("plan", [], "[on|off]", "turn a short plan first on or off", toggle("plan")),
  command("verify", [], "[on|off]", "turn a reviewer's check of the answer on or off", toggle("verify")),
  command("dry-run", ["practice"], "[on|off]", "turn practice mode on or off (nothing is really changed)", toggle("dryRun")),
  command("attach", ["image"], "<file>", "send a file or picture with your next message", attach),
  command("history", [], "", "this conversation so far", (context) =>
    historyLines(context.runtime, context.conversation.sessionId).forEach((line) => context.say("note", line))),
  command("export", ["save"], "[file]", "save this conversation as a Markdown file", async (context, argument) =>
    context.say("note", `[saved to ${await exportConversation(context.runtime, context.conversation.sessionId, argument || undefined)}]`)),
  command("new", ["clear", "reset"], "", "start a fresh conversation", (context) => context.newConversation()),
  command("sessions", ["resume"], "[id]", "earlier conversations; with a number, carry one on", (context, argument) =>
    argument ? context.resume(argument) : context.sessions()),
  command("go", ["open"], "<place>", "open a place or a Settings page by name: /go inbox finished", (context, argument) => context.open(argument)),
  command("inbox", [], "[tab]", "what needs you, what finished, and the history", (context, argument) => context.open(`inbox ${argument}`)),
  command("automations", ["cron"], "[tab]", "schedules, procedures and triggers", (context, argument) => context.open(`automations ${argument}`)),
  command("library", [], "[tab]", "memory, documents and what it made", (context, argument) => context.open(`library ${argument}`)),
  command("customize", ["tools"], "[tab]", "skills, specialists, plugins, connections and channels", (context, argument) => context.open(`customize ${argument}`)),
  command("settings", ["config"], "[page]", "the twelve Settings pages, by name", (context, argument) => context.open(`settings ${argument}`)),
  command("theme", ["skin"], "[name|light|dark|follow|list]", "the theme, shared with the window", (context, argument) => context.theme(argument)),
  command("default", [], "<id>", "the model every new conversation starts with", (context, argument) => {
    const { runtime } = context;
    if (!runtime.models.presets.has(argument)) return context.say("warn", `No model called ${argument}. Use /model to list them.`);
    runtime.models.configure(runtime.owner, { activePreset: argument });
    context.say("note", `[new conversations start with ${runtime.models.presets.get(argument)!.name}]`);
  }),
  command("switch", [], "<mouse|sidePane|oak> [on|off|when-needed]", "the terminal's own switches, which all start off", (context, argument) => {
    const [name = "", value = ""] = argument.split(/\s+/);
    context.switchSetting(name, value);
  }),
  command("pane", ["details"], "[activity|plan|files|memory]", "show or hide the side pane", (context, argument) => context.togglePane(argument)),
  command("lockdown", ["pause"], "[on|off]", "the one switch that makes everything wait for your yes", (context, argument) => context.lockdown(argument)),
  command("keys", [], "", "every key the view answers to", (context) => context.keys()),
  command("exit", ["quit"], "", "leave", (context) => context.quit()),
];

export function findCommand(name: string): TerminalCommand | undefined {
  const bare = name.replace(/^\//, "").toLowerCase();
  return TERMINAL_COMMANDS.find((entry) => entry.name === bare || entry.aliases.includes(bare));
}
/** The help list: the keys in one line, then one line per command. */
export function helpLines(words: Words): string[] {
  const rows = TERMINAL_COMMANDS.map((entry) => {
    const usage = `/${entry.name}${entry.args ? " " + entry.args : ""}`;
    return `${usage.padEnd(22)} ${words.t(entry.key, entry.english)}`;
  });
  return [words.t("terminal.keys.line", "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops the task · Ctrl+D leaves"), ...rows];
}
/** Runs one typed slash command; an unknown one is said so, never sent to the model. */
export async function runCommand(context: CommandContext, text: string): Promise<void> {
  const [name = "", ...rest] = text.trim().split(/\s+/);
  const found = findCommand(name);
  if (!found) return context.say("warn", `I do not know ${name}. Type /help for the list.`);
  try {
    await found.run(context, rest.join(" "));
  } catch (error) {
    context.say("bad", `[${error instanceof Error ? error.message : String(error)}]`);
  }
}
