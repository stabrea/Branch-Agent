import { z } from "zod";
import { helpChapter, helpChapters } from "./help.js";
import type { ToolRegistry } from "./registry.js";

/**
 * What Branch knows about itself: its own handbook, searched by the words of a question, so "can you
 * keep running when I close the window?" or "what does Lockdown do?" is answered from what Branch
 * really does rather than from what a model guesses an assistant might do. It reads the eleven
 * chapters `help.ts` already serves to the Help window and nothing else, calls no model and changes
 * nothing. Like every tool it is not in the model's context until a question calls for it; the
 * settings themselves, with what each is set to now, are `settings.list` (src/settings-kit/tools.ts).
 */

export interface HelpPassage { chapter: string; heading: string; text: string }

const sectionLimit = 1200;
const stopWords = new Set(["the", "and", "for", "you", "your", "can", "how", "what", "does", "with", "this", "that", "are", "is", "do", "a", "an", "to", "of", "in", "on", "it", "i", "my", "me"]);

/** A chapter cut at its headings, each piece carrying the heading it sits under. */
function sections(title: string, markdown: string): HelpPassage[] {
  const out: HelpPassage[] = [];
  let heading = title, lines: string[] = [];
  const flush = () => { const text = lines.join("\n").trim(); if (text) out.push({ chapter: title, heading, text }); };
  for (const line of markdown.split("\n")) {
    const found = /^#{1,4}\s+(.*)$/.exec(line);
    if (found) { flush(); heading = found[1]!.trim(); lines = []; } else lines.push(line);
  }
  flush();
  return out;
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g)?.filter((word) => !stopWords.has(word)) ?? [];

/** The passages that share the most words with the question, best first: a word in the heading counts double, in the chapter's title once more. */
export function searchHandbook(question: string, limit = 5): { passages: HelpPassage[]; chapters: string[] } {
  const asked = [...new Set(wordsOf(question))];
  const all = helpChapters.flatMap((chapter) => { const found = helpChapter(chapter.id); return found ? sections(chapter.title, found.markdown) : []; });
  const scored = all.map((passage) => {
    const body = new Set(wordsOf(passage.text)), head = new Set(wordsOf(passage.heading)), title = new Set(wordsOf(passage.chapter));
    return { passage, score: asked.reduce((sum, word) => sum + (head.has(word) ? 2 : 0) + (title.has(word) ? 1 : 0) + (body.has(word) ? 1 : 0), 0) };
  }).filter((one) => one.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return {
    passages: scored.map(({ passage }) => ({ ...passage, text: passage.text.length > sectionLimit ? `${passage.text.slice(0, sectionLimit)}…` : passage.text })),
    chapters: helpChapters.map((chapter) => chapter.title),
  };
}

export function registerHelpSearch(registry: ToolRegistry): void {
  registry.register({
    name: "help.search", permission: "help.read",
    description: "Answer questions about Branch itself — what it is, what it can and cannot do, what a feature or setting is for, how to set something up — from its own handbook. Use it before guessing about Branch. For what a setting is set to now, use settings.list.",
    parameters: z.object({ question: z.string().trim().min(2).max(300) }).strict(),
    target: () => "Branch's own handbook",
    execute: async (input: { question: string }) => {
      const found = searchHandbook(input.question);
      return found.passages.length ? found
        : { passages: [], chapters: found.chapters, note: "Nothing in the handbook matched those words. Try other words, or name a chapter." };
    },
  });
}
