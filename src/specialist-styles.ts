import { z } from "zod";
import { isReadOnlyPermission } from "./policy.js";

/**
 * A specialist's working style. The same runtime carries out every task, but the style decides how
 * it goes about it: think-then-act with a visible line of reasoning, work to a plan, review without
 * changing anything, look things up and say where the answer came from, or write code. The style is
 * plain data on the specialist, so the owner picks one in Specialists and sees it on the task.
 */
export const specialistStyles = ["default", "react", "plan-execute", "critic", "researcher", "coder"] as const;
export const SpecialistStyleSchema = z.enum(specialistStyles);
export type SpecialistStyle = z.infer<typeof SpecialistStyleSchema>;

export interface StyleShape {
  /** Added to the specialist's own instructions. */
  instructions: string;
  /** Toolboxes opened before the first round, so the style never spends a round looking. */
  groups: readonly string[];
  /** A short line for the owner, shown on the specialist and on the task. */
  summary: string;
  /** Ask for a short plan first and work through it step by step. */
  plan: boolean;
  /** Each reply starts with one line of thinking, kept out of the answer. */
  scratch: boolean;
  /** Nothing that changes anything: every permission that can write is taken away. */
  readOnly: boolean;
}

const shapes: Record<SpecialistStyle, StyleShape> = {
  default: { instructions: "", groups: [], summary: "Works the ordinary way.", plan: false, scratch: false, readOnly: false },
  react: {
    instructions: "\n\nWork one step at a time. Begin every reply with a single line starting \"Thought:\" saying what you are about to do and why, then either use one tool or give the answer. Never write more than one Thought line in a reply.",
    groups: [], summary: "Thinks out loud one step at a time before each action.", plan: false, scratch: true, readOnly: false,
  },
  "plan-execute": {
    instructions: "\n\nWork to the plan you are given: do the step in front of you and nothing else, and say plainly what you did.",
    groups: [], summary: "Makes a short plan first and works through it step by step.", plan: true, scratch: false, readOnly: false,
  },
  critic: {
    instructions: "\n\nYou review work; you never change anything. Say what is right, what is wrong and what one change would help most. If you are asked to alter something, explain what should be altered instead of doing it.",
    groups: [], summary: "Reviews and comments; cannot change anything.", plan: false, scratch: false, readOnly: true,
  },
  researcher: {
    instructions: "\n\nLook things up before you answer, and say where every claim came from. End with a numbered list of the sources you used. If you could not find a source for something, say so rather than guessing.",
    groups: ["web", "research", "documents", "memory"], summary: "Looks things up and names its sources.", plan: false, scratch: false, readOnly: false,
  },
  coder: {
    instructions: "\n\nYou change code. Read before you write, make the change with code.patch or code.change_set so it is all-or-nothing and can be put back, and say what the project's check said afterwards.",
    groups: ["code", "git", "files"], summary: "Reads and changes code, one reversible change at a time.", plan: false, scratch: false, readOnly: false,
  },
};

export function styleShape(style: SpecialistStyle | undefined): StyleShape {
  return shapes[style ?? "default"] ?? shapes.default;
}

/** The permissions a style leaves a specialist with; a style may narrow them, never widen them. */
export function styledPermissions(style: SpecialistStyle | undefined, permissions: string[]): string[] {
  return styleShape(style).readOnly ? permissions.filter(isReadOnlyPermission) : permissions;
}

const thought = /^[ \t]*thought\s*:[ \t]*(.+?)[ \t]*$/im;

/**
 * Takes the one line of thinking off the front of a reply. The line is recorded against the task so
 * the owner can watch the assistant work; what is left is what the person is shown.
 */
export function takeScratch(text: string): { line: string; rest: string } | null {
  const match = thought.exec(text);
  if (!match || match.index > 200) return null;
  const line = match[1]!.slice(0, 500);
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { line, rest };
}
