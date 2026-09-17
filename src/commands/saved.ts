import type { Store } from "../store.js";
import { lookup } from "./catalog.js";
import { refusalFor } from "./execute.js";
import type { Access, Call, CommandHost, Reply } from "./handlers.js";
import type { Surface } from "./catalog.js";
import {
  blanksIn, countUse, fillPrompt, listPrompts, promptLibraryMode, readArguments, switchedOffSentence, type SavedPrompt,
} from "../prompt-library.js";

/**
 * Bucket 12 (family custom-commands, A0147): the owner's own commands, laid over the one shipped
 * table (catalog.ts) on every surface.
 *
 * - A saved prompt with a command (`/weekly`) answers to that name wherever the shipped commands are
 *   read: the window, the phone, the dashboard, both terminal views and the chat apps.
 * - It can only ever become the text of an ordinary message, so it asks of the key exactly what
 *   starting a task asks ("run"), never more, and a saved record cannot say otherwise.
 * - A shipped name always wins: a saved prompt cannot be given one (prompt-library.ts refuses it
 *   when it is saved), and this file only looks when the shipped table did not know the name.
 * - It follows its own switch (Automations › Procedures), not the shipped table's.
 *
 * `/prompts` (a shipped command, below) lists the saved prompts and the saved procedures, and with a
 * name shows one and puts it in the message box without sending it.
 */
export const savedCommandLevel = "run" as const;
const linePattern = /^\/([a-z][a-z0-9-]{0,31})(?:@[\w.-]+)?(?:\s+([\s\S]*))?$/i;

/** True when a name belongs to the shipped table on any surface, under any of its names. */
export const takenByCatalog = (name: string): boolean => lookup(name) !== undefined;

/** The saved prompt a typed line calls, or null (switch off, not a slash line, or no such command). */
export function savedCommandFor(store: Pick<Store, "get">, owner: string, line: string): { prompt: SavedPrompt; argument: string } | null {
  const match = linePattern.exec(line.trim());
  if (!match || takenByCatalog(match[1]!) || promptLibraryMode(store, owner) === "off") return null;
  const name = match[1]!.toLowerCase();
  const prompt = listPrompts(store, owner).find((entry) => entry.command === name);
  return prompt ? { prompt, argument: (match[2] ?? "").trim() } : null;
}

const promptsPattern = /^\/(?:prompts|procedures|workflows)(?:@[\w.-]+)?(?:\s+([\s\S]*))?$/i;
/**
 * `/prompts` is a shipped command, so it follows the *Typed commands* switch; with that switch off it
 * still answers while saved prompts are switched on, or the owner could not list their own commands.
 */
export function promptsLine(store: Pick<Store, "get" | "list">, owner: string, line: string): Reply | null {
  const match = promptsPattern.exec(line.trim());
  if (!match || promptLibraryMode(store, owner) === "off") return null;
  return promptsReply(store, owner, match[1] ?? "");
}

/** The message a saved command stands for, or the sentence saying what is missing. */
export function expandSaved(store: Pick<Store, "get" | "save">, owner: string, found: { prompt: SavedPrompt; argument: string }): { text: string } | { problem: string } {
  const { named, rest } = readArguments(found.argument);
  try {
    const text = fillPrompt(found.prompt.body, named, rest);
    countUse(store, owner, found.prompt.id);
    return { text };
  } catch (error) {
    return { problem: `/${found.prompt.command}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * For the surfaces that send the message themselves (both terminal views and the chat apps): the
 * finished text, the sentence saying what is missing, or null when the line is no saved command.
 */
export function savedLine(store: Pick<Store, "get" | "save" | "list">, owner: string, line: string): { text: string } | { problem: string } | { reply: string } | null {
  const listing = promptsLine(store, owner, line);
  if (listing) return { reply: listing.text };
  const found = savedCommandFor(store, owner, line);
  return found ? expandSaved(store, owner, found) : null;
}

/**
 * Carries a saved command out for a surface that goes through `executeCommand`: the page (or the
 * terminal) is told to send the finished text as the next message.
 */
export function runSavedCommand(host: CommandHost, input: { surface: Surface; line: string; access: Access }): (Reply & { command: string; refused?: true }) | null {
  const { store, owner } = host.runtime;
  const listing = promptsLine(store, owner, input.line);
  if (listing) return { command: "prompts", ...listing };
  const found = input.surface === "dashboard" ? null : savedCommandFor(store, owner, input.line);
  if (!found) return null;
  const command = found.prompt.command;
  const refused = refusalFor(savedCommandLevel, input.access, input.surface);
  if (refused) return { command, text: refused, refused: true };
  const expanded = expandSaved(store, owner, found);
  if ("problem" in expanded) return { command, text: expanded.problem };
  return { command, text: `Sending your saved prompt "${found.prompt.title}".`, client: { do: "send", text: expanded.text } };
}

/**
 * The owner's commands as rows of the `/` menu; "when needed" keeps them out of the menus. With
 * `withPrompts` (the shipped `/prompts` is not offered because *Typed commands* is off), a row for
 * `/prompts` comes first, so the saved ones can still be listed.
 */
export function savedCommandRows(store: Pick<Store, "get">, owner: string, withPrompts = false) {
  const mode = promptLibraryMode(store, owner);
  if (mode === "off") return [];
  const prompts = lookup("prompts")!;
  const head = withPrompts ? [{ name: prompts.name, aliases: [...prompts.aliases], key: prompts.key, english: prompts.english,
    args: prompts.args, level: prompts.level as string, bareLooks: false, listed: mode === "on", saved: true }] : [];
  return [...head, ...listPrompts(store, owner).filter((prompt) => prompt.command).map((prompt) => ({
    name: prompt.command, aliases: [] as string[], key: `prompts.saved.${prompt.command}`,
    english: prompt.description || prompt.title,
    args: blanksIn(prompt.body).map((blank) => `${blank}=…`).join(" ") || (/\{\{\s*input\s*\}\}/.test(prompt.body) ? "<words>" : ""),
    level: savedCommandLevel as string, bareLooks: false, listed: mode === "on", saved: true,
  }))];
}

/* ---------- /prompts: browse and load (A0147) ---------- */

interface ProcedureView { name: string; status: string; parameters: Record<string, { type: string; required?: boolean }>; steps: { tool: string }[] }
function procedures(store: Pick<Store, "list">, owner: string): ProcedureView[] {
  return store.list("procedures", owner).map((record) => {
    const state = record.data as { status?: string; definition?: Partial<ProcedureView> };
    return { name: String(state.definition?.name ?? record.id), status: String(state.status ?? "proposed"),
      parameters: state.definition?.parameters ?? {}, steps: state.definition?.steps ?? [] };
  });
}
function overview(store: Pick<Store, "get" | "list">, owner: string): string {
  const lines: string[] = [];
  const on = promptLibraryMode(store, owner) !== "off";
  const prompts = on ? [...listPrompts(store, owner)].sort((a, b) => a.group.localeCompare(b.group) || b.uses - a.uses) : [];
  if (!on) lines.push(switchedOffSentence);
  else if (!prompts.length) lines.push("No saved prompts yet. Write one in Automations › Procedures.");
  else lines.push("Your saved prompts:", ...prompts.map((p) => `  ${p.group ? `[${p.group}] ` : ""}${p.command ? `/${p.command} — ` : ""}${p.title}`));
  const saved = procedures(store, owner);
  lines.push(saved.length ? "Your saved procedures:" : "No saved procedures yet.");
  for (const entry of saved) lines.push(`  ${entry.name} (${entry.status}, ${entry.steps.length} steps${Object.keys(entry.parameters).length ? `, needs ${Object.keys(entry.parameters).join(", ")}` : ""})`);
  lines.push("Send /prompts <name> to look at one and put it in the message box.");
  return lines.join("\n");
}
function showProcedure(entry: ProcedureView): Reply {
  const inputs = Object.keys(entry.parameters);
  const ask = `Run my saved procedure "${entry.name}"${inputs.length ? ` with ${inputs.map((name) => `${name} = …`).join(", ")}` : ""}.`;
  const lines = [`${entry.name} (${entry.status})`, ...entry.steps.map((step, index) => `  ${index + 1}. ${step.tool}`),
    inputs.length ? `It needs: ${inputs.join(", ")}.` : "It needs no inputs.",
    entry.status === "verified" ? `To run it, send: ${ask}` : "It has not been checked yet; a procedure runs only once it is verified."];
  return { text: lines.join("\n"), client: { do: "fill", text: ask } };
}

// A function declaration, not a constant: handlers.ts reads it while this module may still be loading.
export function promptsCommand(call: Call): Reply {
  return promptsReply(call.host.runtime.store, call.host.runtime.owner, call.argument);
}

function promptsReply(store: Pick<Store, "get" | "list">, owner: string, argument: string): Reply {
  const wanted = argument.trim().replace(/^\//, "").toLowerCase();
  if (!wanted) return { text: overview(store, owner) };
  const on = promptLibraryMode(store, owner) !== "off";
  const prompt = on ? listPrompts(store, owner).find((p) => p.command === wanted || p.title.toLowerCase() === wanted) : undefined;
  if (prompt) {
    const blanks = blanksIn(prompt.body);
    return { text: [`${prompt.title}${prompt.command ? ` (/${prompt.command})` : ""}`, prompt.body,
      blanks.length ? `Fill in: ${blanks.join(", ")}.` : ""].filter(Boolean).join("\n"), client: { do: "fill", text: prompt.body } };
  }
  const procedure = procedures(store, owner).find((entry) => entry.name.toLowerCase() === wanted);
  if (procedure) return showProcedure(procedure);
  return { text: `There is no saved prompt or procedure called "${argument.trim()}". Send /prompts for the list.` };
}
