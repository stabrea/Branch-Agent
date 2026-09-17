/**
 * Two ways of marking an answer that are kinder than exact match, and just as repeatable.
 *
 * Exact match says nothing about an answer that is right but worded differently: "the Eiffel Tower"
 * against "Eiffel Tower" scores zero, and so does a sentence that contains the right answer inside
 * it. Token F1 and passage match are the two measures published question-answering sets use for
 * exactly that reason, and both are worked out here with no model and no library.
 *
 * Words are compared the way those sets compare them: lower case, punctuation dropped, the three
 * articles ("a", "an", "the") dropped, and runs of spaces collapsed. Dropping articles is a real
 * decision and it is tested: "the capital of France" and "capital of france" are the same answer.
 */

/** Words as the metrics below see them: lower case, no punctuation, no articles, in order. */
export function answerTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word && word !== "a" && word !== "an" && word !== "the");
}

/** How many of each word there are, so a word said twice counts twice. */
function counts(words: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const word of words) out.set(word, (out.get(word) ?? 0) + 1);
  return out;
}

/** Words in both, counted: two "of"s on one side and one on the other share one. */
function shared(left: readonly string[], right: readonly string[]): number {
  const have = counts(right);
  let total = 0;
  for (const [word, count] of counts(left)) total += Math.min(count, have.get(word) ?? 0);
  return total;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export interface TokenOverlap {
  /** The harmonic mean of the two below, from 0 to 1. This is the number to compare. */
  f1: number;
  /** Of the words the answer used, the share that belong. */
  precision: number;
  /** Of the words the reference used, the share the answer found. */
  recall: number;
  /** How many words the two have in common, counting repeats. */
  shared: number;
}

/**
 * Token F1: word order does not matter, extra words cost precision, missing words cost recall.
 *
 * Two answers with nothing but whitespace or punctuation between them score 1. Two empty answers
 * also score 1 — both said the same nothing — while one empty against one full scores 0.
 */
export function tokenF1(answer: string, expected: string): TokenOverlap {
  const given = answerTokens(answer), wanted = answerTokens(expected);
  if (!given.length && !wanted.length) return { f1: 1, precision: 1, recall: 1, shared: 0 };
  const common = shared(given, wanted);
  if (!common) return { f1: 0, precision: 0, recall: 0, shared: 0 };
  const precision = common / given.length, recall = common / wanted.length;
  return {
    f1: round((2 * precision * recall) / (precision + recall)),
    precision: round(precision), recall: round(recall), shared: common,
  };
}

export interface PassageMatch {
  /** Of the passage's words, the share the answer contains. 1 means the whole passage is there. */
  coverage: number;
  /** True when the passage's words appear in the answer in the same order, back to back. */
  verbatim: boolean;
  /** Which passage this is, when several were offered: the best one wins. */
  index: number;
}

/**
 * Passage match: does the answer carry the reference passage, rather than equal it. This is the
 * measure for "did it find the right piece of the document", where the answer is allowed to be a
 * longer sentence with the passage inside it.
 */
export function passageMatch(answer: string, passage: string): PassageMatch {
  const given = answerTokens(answer), wanted = answerTokens(passage);
  if (!wanted.length) return { coverage: 1, verbatim: true, index: 0 };
  const coverage = round(shared(wanted, given) / wanted.length);
  return { coverage, verbatim: runOf(given, wanted), index: 0 };
}

/** The best of several reference passages, so a question with more than one right source is fair. */
export function bestPassage(answer: string, passages: readonly string[]): PassageMatch {
  let best: PassageMatch = { coverage: 0, verbatim: false, index: 0 };
  passages.forEach((passage, index) => {
    const match = passageMatch(answer, passage);
    if (match.coverage > best.coverage || (match.coverage === best.coverage && match.verbatim && !best.verbatim))
      best = { ...match, index };
  });
  return best;
}

/** Whether `wanted` appears inside `given` as an unbroken run of words. */
function runOf(given: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length > given.length) return false;
  for (let start = 0; start + wanted.length <= given.length; start += 1)
    if (wanted.every((word, offset) => given[start + offset] === word)) return true;
  return false;
}
