/**
 * Nexus: the published function-calling set, where a question is right when the assistant asks for
 * the right function with the right arguments — not when its prose sounds right.
 *
 * It reads the shape the set is published in, from files already on this computer: JSON Lines with
 * the question, the functions that may be used, and the reference call written the way a person
 * writes one, `get_weather(city="Paris", units="metric")`. Several spellings of each field are
 * accepted, because the sets in the wild use `Input`/`Output`, `prompt`/`call` and
 * `question`/`reference` for the same three things.
 *
 * Marking looks first at the tool calls the task really made, and falls back to a call written out
 * in the answer. The function's name must be right; then every argument the reference names must
 * be there with the same value. Extra arguments are noted, not failed, because a set's reference
 * call rarely lists the ones that are optional.
 */
import { mkdir } from "node:fs/promises";
import {
  field, judgeFail, judgePass, jsonlFiles, readJsonl, safeId,
  type BenchmarkAdapter, type BenchmarkJudgement, type BenchmarkResult, type BenchmarkTask,
} from "./benchmarks.js";

/** One function call as the reference writes it. Arguments are compared as written-out text. */
export interface ParsedCall { name: string; arguments: Record<string, string> }

/** Everything between the outermost brackets, respecting quotes and brackets inside them. */
function inner(text: string, open: number): string | null {
  let depth = 0, quote = "";
  for (let i = open; i < text.length; i += 1) {
    const character = text[i]!;
    if (quote) { if (character === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) { depth -= 1; if (!depth) return text.slice(open + 1, i); }
  }
  return null;
}

/** Splits arguments on the commas that are at the top level, so a list inside one stays whole. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]!;
    if (quote) { if (character === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((piece) => piece.trim()).filter(Boolean);
}

/** Quotes and spaces off, so `"Paris"` and `Paris` are the same value. */
const plain = (value: string): string => value.trim().replace(/^["'`]|["'`]$/g, "").trim().toLowerCase();

/**
 * The first function call in a piece of text, or null. Arguments given by position are kept under
 * the numbers `0`, `1` and so on, so a reference that names them and one that does not still meet.
 */
export function parseCall(text: string): ParsedCall | null {
  const found = /([A-Za-z_][\w.]*)\s*\(/.exec(text);
  if (!found) return null;
  const body = inner(text, found.index + found[0].length - 1);
  if (body === null) return null;
  const args: Record<string, string> = {};
  pieces(body).forEach((piece, index) => {
    const named = /^([A-Za-z_]\w*)\s*=([\s\S]*)$/.exec(piece);
    if (named) args[named[1]!] = plain(named[2]!);
    else args[String(index)] = plain(piece);
  });
  return { name: found[1]!, arguments: args };
}

/** A tool call that really happened, written back out in the reference's own shape. */
function fromTrajectory(result: BenchmarkResult, name: string): ParsedCall | null {
  const call = (result.trajectory?.calls ?? []).find((one) => one.name.split(".").pop() === name.split(".").pop());
  if (!call) return null;
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(call.arguments))
    args[key] = plain(typeof value === "string" ? value : JSON.stringify(value));
  return { name: call.name, arguments: args };
}

/** The verdict for one question: the name first, then each argument the reference named. */
export function judgeCall(reference: ParsedCall, given: ParsedCall | null): BenchmarkJudgement {
  if (!given) return judgeFail(`Nothing called ${reference.name}; the reference call is ${describe(reference)}`);
  if (given.name.split(".").pop() !== reference.name.split(".").pop())
    return judgeFail(`It called ${given.name} and ${reference.name} was expected`);
  const wanted = Object.entries(reference.arguments);
  const wrong = wanted.filter(([key, value]) => given.arguments[key] !== value);
  if (!wrong.length) return judgePass();
  const score = Math.round(((wanted.length - wrong.length) / wanted.length) * 1000) / 1000;
  return {
    pass: false, score,
    reasons: wrong.map(([key, value]) =>
      given.arguments[key] === undefined
        ? `It did not give ${key}, which should have been ${value}`
        : `It gave ${key}=${given.arguments[key]} and ${key}=${value} was expected`),
  };
}

const describe = (call: ParsedCall): string =>
  `${call.name}(${Object.entries(call.arguments).map(([key, value]) => `${key}=${value}`).join(", ")})`;

/** The functions the question is allowed to use, however the set happened to write them down. */
function functionsOf(raw: Record<string, unknown>): string {
  const value = raw.Function ?? raw.function ?? raw.functions ?? raw.tools ?? raw.api ?? raw.apis;
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

export const nexusAdapter: BenchmarkAdapter = {
  id: "nexus", name: "Nexus function calling", runsPrograms: false,
  format: "JSONL with the question (Input, prompt or question), the functions on offer (Function, functions or tools) and the reference call (Output, call or reference)",
  layout: "<folder>/*.jsonl",
  async discover(directory) {
    const tasks: BenchmarkTask[] = [];
    for (const path of await jsonlFiles(directory))
      for (const raw of await readJsonl(path)) {
        const question = field(raw, "Input", "input", "prompt", "question", "query");
        const reference = field(raw, "Output", "output", "call", "reference", "answer", "ground_truth");
        if (!question || !reference) continue;
        tasks.push({
          id: safeId(field(raw, "id", "task_id", "sample_id"), `nexus-${tasks.length + 1}`),
          prompt: question, expected: reference, tags: ["nexus", "function-calling"], raw,
        });
      }
    if (!tasks.length) throw new Error(`No Nexus questions found in ${directory}. Each line needs a question and a reference call; see the layout above.`);
    return tasks;
  },
  async prepare(task, into) {
    await mkdir(into, { recursive: true });
    const functions = functionsOf(task.raw);
    const prompt = functions
      ? `${task.prompt}\n\nThese are the functions you may use:\n${functions.slice(0, 4000)}\n\nAnswer with the one call you would make, written as name(argument=value).`
      : `${task.prompt}\n\nAnswer with the one call you would make, written as name(argument=value).`;
    return { workspace: into, prompt, files: [], refusal: null };
  },
  async judge(task, result) {
    if (!task.expected) return judgeFail("This question has no reference call in the dataset, so it cannot be marked");
    const reference = parseCall(task.expected);
    if (!reference) return judgeFail(`The reference call "${task.expected.slice(0, 120)}" is not a call this reader understands`);
    return judgeCall(reference, fromTrajectory(result, reference.name) ?? parseCall(result.answer));
  },
};
