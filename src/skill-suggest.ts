import type { Store } from "./store.js";
import type { SkillOrigin } from "./registry-install.js";

/**
 * Suggestions without a marketplace. Branch reads the wording of the owner's recent tasks and says
 * which of the skills they already have switched off, or which skills a registry they follow
 * advertises, share words with that work. It is a plain word match on this computer: no model is
 * asked, nothing is sent anywhere, and nothing is installed or switched on by a suggestion.
 */
const ignoredWords = new Set(["about", "after", "again", "another", "anything", "because", "before", "could", "every", "first", "from", "have", "here", "into", "just", "like", "make", "more", "much", "need", "only", "over", "please", "should", "some", "than", "that", "their", "them", "then", "there", "these", "they", "this", "through", "used", "using", "very", "want", "what", "when", "where", "which", "while", "with", "would", "your"]);
const words = (text: string): string[] => [...new Set((text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((word) => !ignoredWords.has(word)))];
export interface SkillSuggestion { source: "installed" | "registry"; id: string; name: string; description: string; registry: string | null; tasks: number; matched: string[] }
interface CachedIndex { url: string; name: string; skills: { id: string; name: string; description: string; version: string | null }[] }

/** Skills worth a look, most useful first, from the last `days` of tasks. */
export function suggestSkills(store: Store, owner: string, options: { days?: number; limit?: number } = {}): { suggestions: SkillSuggestion[]; tasksRead: number } {
  const days = options.days ?? 14, limit = options.limit ?? 5;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const tasks = store.runsSince(owner, since, 60).map((run) => new Set(words(run.prompt)));
  const suggestions = candidates(store, owner).map((candidate) => {
    const terms = words(`${candidate.name} ${candidate.description}`);
    const matched = new Set<string>();
    let count = 0;
    for (const task of tasks) {
      const hits = terms.filter((term) => task.has(term));
      if (!hits.length) continue;
      count++;
      for (const hit of hits) matched.add(hit);
    }
    return { ...candidate, tasks: count, matched: [...matched].slice(0, 6) };
  }).filter((entry) => entry.tasks > 0);
  suggestions.sort((a, b) => b.tasks - a.tasks || b.matched.length - a.matched.length || a.name.localeCompare(b.name));
  return { suggestions: suggestions.slice(0, limit), tasksRead: tasks.length };
}

/** Skills the owner could turn on or install: their own switched-off ones, then registry listings. */
function candidates(store: Store, owner: string): Omit<SkillSuggestion, "tasks" | "matched">[] {
  const installed = store.skills.list(owner);
  const fromRegistry = new Set(store.list("settings", owner).filter((row) => row.id.startsWith("skill-origin:"))
    .map((row) => (row.data as unknown as SkillOrigin).skillId));
  const own = installed.filter((skill) => skill.activeVersion === null)
    .map((skill) => ({ source: "installed" as const, id: skill.id, name: skill.name, description: skill.description, registry: null }));
  const listings = store.list("settings", owner).filter((row) => row.id.startsWith("registry-index:"))
    .flatMap((row) => {
      const index = row.data as unknown as CachedIndex;
      return index.skills.filter((entry) => !fromRegistry.has(entry.id))
        .map((entry) => ({ source: "registry" as const, id: entry.id, name: entry.name, description: entry.description, registry: index.url }));
    });
  return [...own, ...listings];
}
