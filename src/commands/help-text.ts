import type { FeatureMode } from "../feature-switches.js";
import type { Words } from "../terminal-words.js";
import type { Surface } from "./catalog.js";
import { commandsFor } from "./settings.js";

/**
 * The `/help` list for one surface, written from the table: only what that surface can do with the
 * switch where it is. "When needed" lists the everyday commands and says how to see the rest.
 */
const intro: Record<Surface, string> = {
  window: "Commands you can type here:",
  phone: "Commands you can type here:",
  terminal: "Commands you can type here:",
  chat: "Things you can send me:",
  dashboard: "Commands this page understands:",
};

export function helpRows(surface: Surface, mode: FeatureMode, all = false, words?: Words): string[] {
  return commandsFor(surface, mode, all).map((command) => {
    const usage = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    return `${usage} — ${words ? words.t(command.key, command.english) : command.english}`;
  });
}

export function helpText(surface: Surface, mode: FeatureMode, all = false, words?: Words): string {
  const lines = [intro[surface], ...helpRows(surface, mode, all, words)];
  if (mode === "when-needed" && !all) lines.push("Send /help all for every command, or /help <question> to ask about Branch.");
  if (mode === "on" && surface !== "chat") lines.push("Send /help <question> to ask about Branch.");
  return lines.join("\n");
}
