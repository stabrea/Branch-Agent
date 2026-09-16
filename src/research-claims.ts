/**
 * Turning pages into checkable claims. A page becomes a handful of sentences that actually answer
 * the question; sentences from different sources that talk about the same thing are grouped, and a
 * group is only reported as agreed when at least two sources say the same figures. Where the
 * figures differ the disagreement is reported rather than hidden behind whichever page came first.
 */
export interface Finding {
  url: string;
  title: string;
  text: string;
  /** The meaningful words in the sentence, for matching it against sentences from other pages. */
  terms: string[];
  /** The numbers the sentence states, normalised, so two sources can be compared on the facts. */
  values: string[];
}
const stopwords = new Set([
  "about", "after", "again", "against", "because", "been", "before", "being", "between", "both", "does", "doing",
  "during", "each", "from", "have", "having", "here", "into", "its", "itself", "just", "more", "most", "only",
  "other", "over", "same", "some", "such", "than", "that", "their", "them", "then", "there", "these", "they",
  "this", "those", "through", "under", "until", "very", "were", "what", "when", "where", "which", "while", "will",
  "with", "would", "your", "many", "much", "also", "however", "said", "says",
]);
const sentenceLimit = 320, minSentence = 30, perPage = 4;

/** The words worth matching on: four letters or more, not everyday filler, not a bare number. */
export function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]{3,}/gu) ?? []).filter((word) => !stopwords.has(word)))];
}
/** Figures a sentence states, with thousands separators and trailing units removed. */
export function values(text: string): string[] {
  return [...new Set((text.match(/-?\d[\d,]*(\.\d+)?/g) ?? []).map((value) => String(Number(value.replace(/,/g, "")))))]
    .filter((value) => value !== "NaN").sort();
}
const overlap = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  const shared = a.filter((word) => set.has(word)).length;
  return shared / Math.min(a.length, b.length);
};

/** Splits page text into sentences and keeps the few that speak to the question. */
export function findingsFrom(question: string, url: string, title: string, text: string): Finding[] {
  const wanted = terms(question);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= minSentence && line.length <= sentenceLimit * 2);
  const scored = sentences.map((sentence) => ({ sentence, score: overlap(wanted, terms(sentence)) }))
    .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, perPage);
  return scored.map(({ sentence }) => {
    const trimmed = sentence.length > sentenceLimit ? `${sentence.slice(0, sentenceLimit - 1)}…` : sentence;
    return { url, title, text: trimmed, terms: terms(trimmed), values: values(trimmed) };
  });
}

export interface Agreement { text: string; sources: string[] }
export interface Conflict { subject: string; sides: { url: string; text: string }[] }
/** Sentences from different pages that are about the same thing, at least two sources deep. */
export function groupFindings(findings: Finding[], threshold = 0.5): Finding[][] {
  const groups: Finding[][] = [];
  for (const finding of findings) {
    const home = groups.find((group) => group.some((member) => overlap(member.terms, finding.terms) >= threshold));
    if (home) home.push(finding); else groups.push([finding]);
  }
  return groups;
}
/**
 * What several sources back, and where they contradict each other. A group counts as agreed when
 * two or more different sources state the same figures; when their figures differ it is a conflict.
 */
export function agreements(findings: Finding[], crossCheck: boolean): { agreed: Agreement[]; conflicting: Conflict[] } {
  if (!crossCheck) return { agreed: [], conflicting: [] };
  const agreed: Agreement[] = [], conflicting: Conflict[] = [];
  for (const group of groupFindings(findings)) {
    const sources = [...new Set(group.map((finding) => finding.url))];
    if (sources.length < 2) continue;
    const byValues = new Map<string, Finding>();
    for (const finding of group) if (!byValues.has(finding.values.join("|"))) byValues.set(finding.values.join("|"), finding);
    const differing = [...byValues.values()].filter((finding) => finding.values.length);
    if (byValues.size > 1 && differing.length > 1)
      conflicting.push({ subject: subjectOf(group), sides: differing.slice(0, 3).map((finding) => ({ url: finding.url, text: finding.text })) });
    else
      agreed.push({ text: group.slice().sort((a, b) => a.text.length - b.text.length)[0]!.text, sources });
  }
  return { agreed: agreed.slice(0, 20), conflicting: conflicting.slice(0, 20) };
}
/** A short name for what a group is about: the words its sentences have in common. */
function subjectOf(group: Finding[]): string {
  const counts = new Map<string, number>();
  for (const finding of group) for (const word of finding.terms) counts.set(word, (counts.get(word) ?? 0) + 1);
  const shared = [...counts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([word]) => word);
  return shared.length ? shared.join(", ") : group[0]!.terms.slice(0, 4).join(", ");
}
