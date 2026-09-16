import { z } from "zod";
import { errorText } from "./contracts.js";
import type { ModelRouter } from "./models.js";
import { looksMultiPart } from "./orchestration.js";
import type { Store } from "./store.js";

/**
 * "Ask me questions first". When something is switched on here, Branch Agent does not start on a
 * request straight away: it comes back with up to five short questions, each with a suggested
 * answer it would use if the person says nothing, and only starts once they have looked at them.
 * Short, plain requests skip this on their own, judged the same way the app decides whether a task
 * is worth planning first, so "what is in this folder" never turns into a form to fill in.
 */
export const AskFirstSettingsSchema = z.object({
  /** Ask questions before starting, unless a request is clearly short and plain. */
  askFirst: z.boolean().default(false),
  /** Most questions to come back with. */
  maxQuestions: z.number().int().min(1).max(5).default(5),
}).strict();
export type AskFirstSettings = z.infer<typeof AskFirstSettingsSchema>;

export const ClarifyingQuestionSchema = z.object({
  question: z.string().trim().min(3).max(300),
  /** What it would assume if the person does not answer. */
  suggested: z.string().trim().max(300).default(""),
}).strict();
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;

export const AskFirstRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(16000),
  /** Ask whatever the saved setting says; leaving it out uses the setting. */
  askFirst: z.boolean().optional(),
}).strict();
export const AnswersSchema = z.object({
  prompt: z.string().trim().min(1).max(16000),
  answers: z.array(z.object({
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().max(2000).default(""),
  }).strict()).max(5).default([]),
}).strict();

export interface AskFirstOutcome {
  /** True when nothing was asked, either because it is switched off or the request was plain. */
  skipped: boolean;
  reason: string;
  questions: ClarifyingQuestion[];
}

const instructions =
  "Before starting a task you ask the person a few short questions so you do not guess wrong. Reply with JSON only: {\"questions\":[{\"question\":\"one short question\",\"suggested\":\"what you would assume if they say nothing\"}]}. At most the number asked for, fewer when the request is already clear. Never ask something the request already answers. No prose.";

export function askFirstSettings(store: Store, owner: string): AskFirstSettings {
  const saved = AskFirstSettingsSchema.safeParse(store.get("settings", owner, "ask-first")?.data ?? {});
  return saved.success ? saved.data : AskFirstSettingsSchema.parse({});
}
export function saveAskFirstSettings(store: Store, owner: string, input: unknown): AskFirstSettings {
  const value = AskFirstSettingsSchema.parse({ ...askFirstSettings(store, owner), ...(input as object) });
  store.save("settings", owner, "ask-first", value);
  return value;
}

/**
 * Whether a request is worth asking about. The same judgement the app uses to decide whether a
 * task is worth planning first: a long request, a list of steps, or several "then"s.
 */
export function worthAsking(prompt: string): boolean {
  return looksMultiPart(prompt) || prompt.trim().length >= 120;
}

/** The questions to put to the person, or an empty list with the reason nothing was asked. */
export async function clarifyingQuestions(
  store: Store, models: ModelRouter, owner: string, input: unknown,
  signal: AbortSignal = AbortSignal.timeout(30000),
): Promise<AskFirstOutcome> {
  const value = AskFirstRequestSchema.parse(input);
  const settings = askFirstSettings(store, owner);
  const wanted = value.askFirst ?? settings.askFirst;
  if (!wanted) return { skipped: true, reason: "Ask me questions first is switched off", questions: [] };
  if (!worthAsking(value.prompt))
    return { skipped: true, reason: "This request is short and clear, so it was not worth asking about", questions: [] };
  const provider = models.plan(owner, "").candidates[0]?.provider;
  if (!provider) return { skipped: true, reason: "No model is connected", questions: [] };
  try {
    const completion = await provider.complete({
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: `At most ${settings.maxQuestions} questions.\n\nThe request:\n${value.prompt.slice(0, 6000)}` },
      ],
      tools: [], maxTokens: 700, signal,
    });
    const questions = readQuestions(completion.content).slice(0, settings.maxQuestions);
    return questions.length
      ? { skipped: false, reason: "", questions }
      : { skipped: true, reason: "There was nothing worth asking about", questions: [] };
  } catch (error) {
    return { skipped: true, reason: `The questions could not be prepared: ${errorText(error).slice(0, 200)}`, questions: [] };
  }
}
function readQuestions(content: string): ClarifyingQuestion[] {
  const body = /\{[\s\S]*\}/.exec(content)?.[0] ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  const raw = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const result = ClarifyingQuestionSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

/** The request with the answers written underneath it, which is what the task actually gets. */
export function promptWithAnswers(input: unknown): { prompt: string; added: number } {
  const value = AnswersSchema.parse(input);
  const given = value.answers.filter((entry) => entry.answer.length > 0);
  if (!given.length) return { prompt: value.prompt, added: 0 };
  const lines = given.map((entry) => `- ${entry.question} ${entry.answer}`).join("\n");
  return { prompt: `${value.prompt}\n\nAnswers to the questions you asked first:\n${lines}`.slice(0, 16000), added: given.length };
}
