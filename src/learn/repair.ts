/**
 * mac7/learn: reading a model's structured answer on the assumption that it is broken.
 *
 * The second of the three ideas taken from Understand Anything (MIT; see THIRD_PARTY_NOTICES.md).
 * Their `merge-batch-graphs.py` normalises ids, drops edges pointing at things that are not there
 * and flips inverted ones, on the plain assumption that a model asked for JSON returns damaged
 * JSON. That assumption is right, and Branch had no such pass. Written here from scratch, for the
 * one answer Branch asks a model for in this feature: the words on each stop of a tour.
 *
 * Nothing in this file throws on bad input. A model that returns prose, a fenced block, trailing
 * commas, a single object where a list was asked for, a number where a string was asked for, or
 * stops that do not exist, must not take the tour down with it — the tour already has its titles
 * and its citations before a model is asked anything, so the worst case is a stop keeping the words
 * the map gave it.
 */

/** JSON found inside whatever a model actually sent: fences, preamble, trailing commas and all. */
export function repairJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  let text = String(raw ?? "").trim();
  if (!text) return null;
  // A fenced block, with or without a language on the fence.
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  const direct = parse(text);
  if (direct !== undefined) return direct;
  // Otherwise the first balanced object or list in the text, with strings walked so a brace inside
  // one is not mistaken for structure.
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    const end = balanced(text, start, open, close);
    if (end < 0) continue;
    const found = parse(text.slice(start, end + 1));
    if (found !== undefined) return found;
  }
  return null;
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Trailing commas before a closing brace or bracket are the commonest single fault.
  try { return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")); } catch { return undefined; }
}
/** The index of the bracket closing the one at `start`, skipping brackets inside strings. */
function balanced(text: string, start: number, open: string, close: string): number {
  let depth = 0, inString = false, quote = "";
  for (let i = start; i < text.length; i += 1) {
    const character = text[i]!;
    if (inString) {
      if (character === "\\") { i += 1; continue; }
      if (character === quote) inString = false;
      continue;
    }
    if (character === '"' || character === "'") { inString = true; quote = character; continue; }
    if (character === open) depth += 1;
    else if (character === close) { depth -= 1; if (!depth) return i; }
  }
  return -1;
}

export interface RepairedWords { order: number; words: string }
export interface RepairReport { words: RepairedWords[]; dropped: number; note: string }

/**
 * The words a model wrote for each stop, matched back to the stops that actually exist.
 *
 * What is repaired: a single object where a list was asked for; the list under any of the names a
 * model reaches for; a whole answer numbered from zero when the tour numbers from one, judged over
 * the answer as a whole rather than per entry; a number sent as a string; an entry with no number at
 * all, taken in the order it arrived; words sent under `text`, `summary` or `description` instead
 * of `words`. What is dropped rather than guessed: a stop number that is not on the tour, a second
 * answer for a stop already answered, and empty words -- because putting a model's words on the
 * wrong stop is worse than leaving that stop with the plain sentence the map gave it.
 */
export function repairTourWords(raw: unknown, steps: number): RepairReport {
  const found = repairJson(raw);
  const holder = found && typeof found === "object" && !Array.isArray(found)
    ? (found as Record<string, unknown>) : null;
  const list = Array.isArray(found) ? found
    : holder ? (["steps", "stops", "tour", "items", "results"]
      .map((name) => holder[name]).find(Array.isArray) as unknown[] | undefined) ?? [holder] : [];
  /* Read first, decide the numbering second. A model that numbers from zero gets every stop wrong,
     not one, so the shift has to be judged over the whole answer rather than per entry. */
  const read: { order: number | null; words: string }[] = [];
  let dropped = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") { dropped += 1; continue; }
    const row = entry as Record<string, unknown>;
    const said = ["words", "text", "summary", "description", "paragraph", "body"]
      .map((name) => row[name]).find((value) => typeof value === "string" && value.trim());
    if (!said) { dropped += 1; continue; }
    const numbered = ["order", "step", "stop", "index", "n"].map((name) => row[name])
      .find((value) => typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)));
    const order = numbered === undefined ? null : Number(numbered);
    read.push({ order: order !== null && Number.isInteger(order) ? order : null, words: String(said).trim().slice(0, 1200) });
  }
  const given = read.map((row) => row.order).filter((order): order is number => order !== null);
  const zeroBased = given.length > 0 && Math.min(...given) === 0 && Math.max(...given) < steps;
  const words: RepairedWords[] = [];
  const seen = new Set<number>();
  for (const [at, row] of read.entries()) {
    const order = row.order === null ? at + 1 : zeroBased ? row.order + 1 : row.order;
    if (order < 1 || order > steps || seen.has(order)) { dropped += 1; continue; }
    seen.add(order);
    words.push({ order, words: row.words });
  }
  words.sort((a, b) => a.order - b.order);
  const note = !list.length ? "The model's answer could not be read at all, so the tour kept its own words."
    : dropped ? `${dropped} of the model's ${list.length} answer(s) did not fit the tour and were left out.`
      : "";
  return { words, dropped, note };
}
