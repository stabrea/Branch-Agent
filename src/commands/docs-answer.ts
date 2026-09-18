import { Bm25 } from "../bm25.js";
import { helpChapter, helpChapters } from "../help.js";

/**
 * `/help <question>`: an answer from Branch's own handbook (docs/handbook), the idea of Aider's
 * `/help` (Apache-2.0) written for Branch. The handbook is cut into its sections, the sections that
 * best match the question are found by word ranking, and the model is asked to answer from those
 * passages alone, with no tools, in a conversation that is not kept. When no model can answer, the
 * passages themselves are the answer, so the command is useful with no model set up at all.
 */
export interface Passage { chapter: string; heading: string; text: string }

let cached: Passage[] | null = null;
/** Every section of every chapter, read once. */
export function handbookPassages(): Passage[] {
  if (cached) return cached;
  const passages: Passage[] = [];
  for (const chapter of helpChapters) {
    let markdown = "";
    try { markdown = helpChapter(chapter.id)?.markdown ?? ""; } catch { continue; }
    for (const part of markdown.split(/\n(?=##\s)/)) {
      const heading = /^#+\s+(.+)$/m.exec(part)?.[1]?.trim() ?? chapter.title;
      const text = part.replace(/^#+\s+.+$/m, "").trim();
      if (text) passages.push({ chapter: chapter.title, heading, text });
    }
  }
  cached = passages;
  return passages;
}

/** The few sections that best match a question, best first. */
export function findPassages(question: string, limit = 3, passages = handbookPassages()): Passage[] {
  const index = new Bm25(passages.map((passage, at) => ({ id: String(at), text: `${passage.heading} ${passage.text}` })));
  return index.rank(question, limit).map((hit) => passages[Number(hit.id)]!);
}

const quote = (passage: Passage, room: number): string =>
  `[${passage.chapter} › ${passage.heading}]\n${passage.text.slice(0, room)}`;

/** The passages written out plainly, for when no model answers. */
export function passagesText(found: Passage[]): string {
  return found.map((passage) => quote(passage, 600)).join("\n\n");
}

/** Asks the model a question with no tools; answers its text, or "" when nothing came back. */
export type AskQuietly = (prompt: string) => Promise<string>;

export async function answerFromHandbook(question: string, ask: AskQuietly | null): Promise<string> {
  const found = findPassages(question);
  if (!found.length) return "The handbook says nothing about that. Open Help (the ? in the window) to read it from the start.";
  const where = `From the handbook: ${[...new Set(found.map((passage) => passage.chapter))].join(", ")}.`;
  if (!ask) return `${passagesText(found)}\n\n${where}`;
  const prompt = [
    "Answer the question using only the handbook passages below. If they do not answer it, say so in one sentence.",
    "Be brief and plain. Do not use tools.",
    found.map((passage) => quote(passage, 3000)).join("\n\n"),
    `Question: ${question.slice(0, 2000)}`,
  ].join("\n\n");
  try {
    const answer = (await ask(prompt)).trim();
    return answer ? `${answer}\n\n${where}` : `${passagesText(found)}\n\n${where}`;
  } catch {
    return `${passagesText(found)}\n\n${where}`;
  }
}
