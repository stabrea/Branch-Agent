import type { Store } from "../store.js";
import { dictionary } from "../terminal-words.js";
import { settingPhrases, type SettingPhrase } from "./phrases.js"; // dogfood B20
import { settingsCatalogue, type FieldSpec, type SettingSpec } from "./catalogue.js";
import { acceptValue, changesFor, currentValue, rangeOf, type Range, type Value } from "./changes.js";
import type { ToolLister } from "../preset-moves.js";

/**
 * Q50: a settings request in the owner's own words ("turn the wake word on", "switch off the
 * board") is matched against the catalogue before anything is planned. When the words fit more
 * than one setting, the answer is one question for the owner and no plan at all. When they fit
 * exactly one, the answer is the exact before and after `changesFor` works out, with anything
 * already as asked left out. Dogfood B20: words that fit none are never answered with a question
 * that has nothing to choose from (`unmatched`, below).
 */

/**
 * Words and phrases that turn a request around or hold it back ("don't", "never", "no", "stop",
 * "wait", "hold on", "cancel", "nope", "nah", "never mind", and in French "pas", "jamais", "non",
 * "arrête", "annule", "attends", "pas maintenant"), with apostrophes and accents taken out. Each is
 * matched as whole words, so a setting's own "holds" or "waiting" is never "hold" or "wait". Any one
 * of them anywhere means asking, never planning: asking is always the careful answer.
 *
 * That over-asks now and then: "stop the learning" means off, the careful way, and it asks all the
 * same. That is accepted, since a question never changes anything.
 */
const cues = ["dont", "doesnt", "didnt", "shouldnt", "wont", "not", "never", "no", "stop", "wait", "hold", "cancel", "nope", "nah",
  "pas", "jamais", "non", "arrete", "arreter", "arretez", "annule", "annuler", "annulez", "attends", "attendez",
  "no longer", "hang on", "never mind", "pas maintenant"];
const cueWords = cues.filter((cue) => !cue.includes(" "));

/** Whether a padded run of plain words (" like this ") holds a cue as whole words. */
const holdsCue = (padded: string): boolean => cues.some((cue) => padded.includes(` ${cue} `));

/** Words that say what to do rather than which setting: they never pick a setting. */
const filler = new Set(("a an and any are be branch branchs can change could do dont enable disable for from have i in is it its " +
  "let make me my of off on please put set setting settings should so start stop switch the then this to turn up down use want " +
  "we when needed would you your yes no true false").split(" ").concat([...cueWords, "longer", "ne", "plus", "hang", "mind", "maintenant"]));

/** A crude stem, so "learning", "learns" and "learn" are one word. */
function stem(word: string): string {
  for (const end of ["ing", "es", "ed", "s"]) if (word.length > end.length + 3 && word.endsWith(end)) return word.slice(0, -end.length);
  return word;
}

/** Every mark people type as an apostrophe (straight, curly, the modifier letter, an acute or grave accent, a prime, and others). */
const apostropheMarks = "'\\u2018\\u2019\\u02BC\\u00B4\\u0060\\u2032\\uFF07\\u201B\\u02BB\\u02B9\\u2035\\uA78C\\u055A\\uFF40";
const apostrophes = new RegExp(`[${apostropheMarks}]`, "g");

/** Invisible format characters (zero-width joiners and spaces, soft hyphens) are taken out, and full-width letters read as plain ones. */
const wordsOf = (text: string): string[] =>
  text.replace(/\p{Cf}/gu, "").replace(apostrophes, "").normalize("NFKC").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The words that name a setting, with filler and bare numbers taken out. */
export function namingWords(request: string): string[] {
  return [...new Set(wordsOf(request).filter((word) => !filler.has(word) && !/^\d+$/.test(word)).map(stem))];
}

/** Words with accents taken out as well, so "arrête" is "arrete". */
const plainWords = (text: string): string[] => wordsOf(text.normalize("NFD").replace(/[̀-ͯ]/g, ""));

/** Variant of plainWords that replaces invisible characters with spaces, normalizes, then strips, to catch cues separated by only invisible characters. */
const plainWordsWithSpaces = (text: string): string[] => {
  const nfd = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Replace \p{Cf} (invisible format chars) with spaces, strip apostrophes before NFKC so accents+apostrophes are caught,
  // and again after it, since NFKC turns a double or triple prime (″ ‴ ‶ ‷ ⁗) into listed primes; then split
  const variant = nfd.replace(/\p{Cf}/gu, " ").replace(apostrophes, "").normalize("NFKC").replace(apostrophes, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return variant;
};

/** Setting names and labels that hold a cue themselves ("A command no rule mentions"): said whole, they only name a setting. */
const namesWithCues = [...new Set(settingsCatalogue.flatMap((spec) => [spec.name, ...spec.fields.map((field) => field.label)]))]
  .map((text) => plainWords(text).join(" ")).filter((phrase) => holdsCue(` ${phrase} `));

/**
 * Whether the words say not to, or might: any of the cues above, "do not", "no longer", and in French
 * "ne ... pas" or "n'... plus". A request like that is never planned as a change.
 */
export function negated(request: string): boolean {
  let said = ` ${plainWords(request).join(" ")} `;
  for (const phrase of namesWithCues) said = said.replaceAll(` ${phrase} `, " ");
  if (holdsCue(said)) return true;

  // Also check a variant where invisible characters and apostrophe marks become spaces,
  // to catch cues separated by only invisible characters (e.g., "don't‌turn" or "stop‏the")
  let saidVariant = ` ${plainWordsWithSpaces(request).join(" ")} `;
  for (const phrase of namesWithCues) saidVariant = saidVariant.replaceAll(` ${phrase} `, " ");
  if (holdsCue(saidVariant)) return true;

  const words = said.split(" ").filter(Boolean);
  const frenchNe = words.includes("ne") || new RegExp(`(^|[^a-z])n[${apostropheMarks}][a-z]`, "i").test(request.replace(/\p{Cf}/gu, ""));
  return frenchNe && words.includes("plus");
}

/** The value the words say, when they say one plainly: on, off, when needed. */
export function spokenValue(request: string): Value | undefined {
  const words = wordsOf(request);
  if (words.join(" ").includes("when needed")) return "when-needed";
  if (words.includes("off") || words.includes("disable")) return "off";
  if (words.includes("on") || words.includes("enable")) return "on";
  return undefined;
}

/** A value as this field can hold it; on and off stand for yes and no on a yes/no field. */
export function valueFor(field: FieldSpec, value: unknown): Value | undefined {
  const accepted = acceptValue(field, value);
  if (accepted !== undefined || field.kind.type !== "yes-no") return accepted;
  if (value === "on" || value === "yes") return true;
  if (value === "off" || value === "no") return false;
  return undefined;
}

export interface Candidate { spec: SettingSpec; field: FieldSpec }

/**
 * Every field whose name, label, key or words in the window hold each naming word, and every field a phrase people use
 * for it names (dogfood B20, src/settings-kit/phrases.ts); a value narrows it to fields that can hold it.
 */
export function candidatesFor(request: string, value?: unknown): Candidate[] {
  const words = namingWords(request);
  if (!words.length) return [];
  const all = everyField();
  const named = all.filter((one) => words.every((word) => knownWords(one).has(word)));
  const phrased = phrasedFor(request, all);
  // A phrase that holds every naming word is the closer reading ("computer use" is the screen and keyboard, not every
  // setting with "computer" in its name); otherwise the settings phrases name come first, then those the names fit.
  const exact = phrased.found.length > 0 && words.every((word) => phrased.holds.has(word));
  return narrowed(exact ? phrased.found : [...new Set([...phrased.found, ...named])], value);
}

const idOf = ({ spec, field }: Candidate): string => `${spec.key}.${field.field}`;
const nameOf = ({ spec, field }: Candidate): string => spec.fields.length > 1 ? `${spec.name}: ${field.label}` : spec.name;

function listed(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/** One question for the owner, naming what the words could mean. */
export function questionFor(request: string, found: readonly Candidate[]): string {
  const shown = found.slice(0, 5).map(nameOf);
  if (found.length > shown.length) return `That could be ${found.length} settings, such as ${listed(shown)}. Which one do you mean?`;
  return `That could be more than one setting. Do you mean ${listed(shown)}?`;
}

/** The one question for a request that says not to: nothing is planned until the owner says what they want. */
function negatedQuestion(store: Store, owner: string, found: readonly Candidate[]): string {
  const said = "Your words say not to, so nothing is planned.";
  if (found.length === 1) {
    const [only] = found as [Candidate];
    return `${said} Should "${nameOf(only)}" change from ${String(currentValue(store, owner, only.spec, only.field))}, and to what?`;
  }
  return `${said} Should ${listed(found.slice(0, 5).map(nameOf))} change, and to what?`;
}

type Choice = { setting: string; name: string; value: Value; range?: Range; note?: string };

/** A number's range and note, given with it wherever it is offered; nothing for a switch or a list. */
function numberFacts(field: FieldSpec): Pick<Choice, "range" | "note"> {
  const range = rangeOf(field);
  return range ? { range, ...(field.note ? { note: field.note } : {}) } : {};
}
/** The same in words, for the one question the owner is asked. */
function factsWords(field: FieldSpec): string {
  const range = rangeOf(field);
  if (!range) return "";
  return ` It can be from ${range.min} to ${range.max}${range.or ? `, or ${range.or}` : ""}.${field.note ? ` ${field.note}` : ""}`;
}
type Preview = { setting: string; name: string; label: string; from: Value; to: Value; lessCareful: boolean; looser?: string; pinned: boolean };
export type Clarified =
  | { status: "ask"; question: string; choices: Choice[]; planned: false }
  | { status: "ready"; setting: string; preview: Preview[]; useTool: "settings.change" | "settings.loosen" }
  | { status: "unchanged"; setting: string; note: string; refused: string[] }
  | { status: "elsewhere"; setting: string; where: string; note: string; planned: false }
  | { status: "none"; note: string; planned: false };

/**
 * What a request in the owner's words comes to: one question when it fits several settings (nothing
 * is planned then), otherwise the exact change for the one setting it fits. Words that fit none are
 * answered by `unmatched` below, which never plans either.
 */
export function clarifyRequest(store: Store, owner: string, input: { request: string; value?: Value | undefined }, tools?: ToolLister): Clarified {
  const asked = input.value ?? spokenValue(input.request);
  const found = candidatesFor(input.request, asked);
  if (!found.length) return unmatched(store, owner, input.request, asked);
  const choices = (list: readonly Candidate[]): Choice[] => list.slice(0, 20)
    .map((one) => ({ setting: idOf(one), name: nameOf(one), value: currentValue(store, owner, one.spec, one.field), ...numberFacts(one.field) }));
  if (negated(input.request)) return { status: "ask", question: negatedQuestion(store, owner, found), choices: choices(found), planned: false };
  if (found.length !== 1) return { status: "ask", question: questionFor(input.request, found), choices: choices(found), planned: false };
  const [only] = found as [Candidate];
  const setting = idOf(only), now = currentValue(store, owner, only.spec, only.field);
  if (asked === undefined)
    return { status: "ask", question: `What should "${nameOf(only)}" be? It is ${String(now)} now.${factsWords(only.field)}`, choices: choices(found), planned: false };
  const to = valueFor(only.field, asked) ?? asked;
  const { changes, refused } = changesFor(store, owner, [{ key: only.spec.key, field: only.field.field, value: to }], tools);
  if (!changes.length)
    return { status: "unchanged", setting, refused, note: refused.length ? refused.join("; ") : `"${nameOf(only)}" is already ${String(now)}. Nothing needs changing.` };
  const preview = changes.map((change) => ({ setting: change.id, name: change.name, label: change.label, from: change.from, to: change.to,
    lessCareful: change.loosens, ...(change.looser ? { looser: change.looser } : {}), pinned: change.pinned }));
  return { status: "ready", setting, preview, useTool: preview.some((one) => one.lessCareful) ? "settings.loosen" : "settings.change" };
}

/* ---------- dogfood B20: words that fit no setting, and whether a request is about settings at all ---------- */

let fields: Candidate[] | undefined;
/** Every field in the catalogue, made once, so one field is the same object everywhere below. */
function everyField(): Candidate[] {
  return fields ??= settingsCatalogue.flatMap((spec) => spec.fields.map((field) => ({ spec, field })));
}

const known = new Map<Candidate, Set<string>>();
/**
 * The words a field is known by: its key, name, label and field, and the words the window shows for its name and label
 * (the English of its `t` keys, which for a few cards differ from the name here: "How Branch gets your attention").
 */
function knownWords(one: Candidate): Set<string> {
  let words = known.get(one);
  if (!words) {
    const shown = dictionary("en");
    words = new Set(wordsOf(`${one.spec.key} ${one.spec.name} ${one.field.label} ${one.field.field} ${shown[one.spec.t] ?? ""} ${shown[one.field.t] ?? ""}`).map(stem));
    known.set(one, words);
  }
  return words;
}

/** A value narrows several fields to those that can hold it; one field, or none that can, is left as it is. */
function narrowed(found: Candidate[], value: unknown): Candidate[] {
  if (value === undefined || found.length < 2) return found;
  const holding = found.filter(({ field }) => valueFor(field, value) !== undefined);
  return holding.length ? holding : found;
}

/** Plain stemmed words with a space at each end, so a phrase is only ever found as whole words. */
const phraseOf = (text: string): string => ` ${wordsOf(text).map(stem).join(" ")} `;

/** The phrases people use for a setting (src/settings-kit/phrases.ts) that these words say. */
function saidFor(text: string): SettingPhrase[] {
  const said = phraseOf(text);
  return settingPhrases.filter((entry) => entry.says.some((phrase) => said.includes(phraseOf(phrase))));
}

/** The fields that the phrases these words say name, and the naming words those phrases hold. */
function phrasedFor(text: string, all: readonly Candidate[]): { found: Candidate[]; holds: Set<string> } {
  const said = phraseOf(text);
  const hits = settingPhrases.flatMap((entry) => entry.says.filter((phrase) => said.includes(phraseOf(phrase))).map((phrase) => ({ entry, phrase })));
  return { found: [...new Set(hits.flatMap(({ entry }) => all.filter((one) => idOf(one) === entry.setting)))],
    holds: new Set(hits.flatMap(({ phrase }) => namingWords(phrase))) };
}

type OwnersOwn = NonNullable<SettingPhrase["owners"]>;
/** A setting only the owner changes, at its own card, that these words name. */
export function ownersOwnFor(text: string): OwnersOwn | undefined {
  return saidFor(text).find((entry) => entry.owners)?.owners;
}
/** What Branch says about such a setting: who changes it, and where. */
export const ownersOwnNote = (own: OwnersOwn): string =>
  `"${own.name}" is changed only by the owner, in ${own.place} (${own.choices}). Branch cannot change it from a conversation, and settings.list does not list it.`;

/** A word held by more fields than this picks none of them out: "mode" is held by more than half the catalogue. */
const tellingAt = 8;
let holders: Map<string, number> | undefined;
/** Whether a word tells settings apart: some field holds it, and only a few do. */
function telling(word: string): boolean {
  if (!holders) {
    holders = new Map();
    for (const one of everyField()) for (const held of knownWords(one)) holders.set(held, (holders.get(held) ?? 0) + 1);
  }
  const count = holders.get(word) ?? 0;
  return count > 0 && count <= tellingAt;
}

/** The fields that share the most telling words with the request, and how many they share (none when no word is shared). */
function nearest(request: string, value?: unknown): { found: Candidate[]; shared: number } {
  const words = namingWords(request).filter(telling);
  const scored = everyField().map((one) => ({ one, shared: words.filter((word) => knownWords(one).has(word)).length }));
  const shared = Math.max(0, ...scored.map((entry) => entry.shared));
  return { found: shared ? narrowed(scored.filter((entry) => entry.shared === shared).map((entry) => entry.one), value) : [], shared };
}

/** One question naming the settings nearest to the words, when no setting holds all of them. */
function nearQuestion(near: readonly Candidate[]): string {
  const shown = near.slice(0, 5).map(nameOf);
  if (near.length > shown.length) return `No setting is called exactly that. It could be ${near.length} settings, such as ${listed(shown)}. Which one do you mean?`;
  return `No setting is called exactly that. Do you mean ${listed(shown)}?`;
}

/**
 * Dogfood B20: words that name no setting in the catalogue. The answer is never "which setting do you mean?" with
 * nothing to choose from. A setting only the owner changes is named, with where it is; otherwise the settings nearest
 * to the words are offered in one question (a near guess is only ever asked about, never planned); otherwise the
 * answer says plainly that there is no such setting. Nothing is planned in any of them.
 */
function unmatched(store: Store, owner: string, request: string, value: unknown): Clarified {
  const own = ownersOwnFor(request);
  if (own) return { status: "elsewhere", setting: own.name, where: own.where, note: ownersOwnNote(own), planned: false };
  const near = nearest(request, value).found, saysNot = negated(request), quoted = `"${request.slice(0, 80)}"`;
  if (!near.length) return { status: "none", planned: false, note: `${saysNot ? "Your words say not to, so nothing is planned. " : ""}${namingWords(request).length
    ? `No setting Branch can change matches ${quoted}, and settings.list will not find one either.`
    : `The words ${quoted} name no setting: pass the words for the setting itself, as the owner said them (such as "the wake word").`} Nothing was changed.` };
  const choices = near.slice(0, 20).map((one) => ({ setting: idOf(one), name: nameOf(one), value: currentValue(store, owner, one.spec, one.field) }));
  return { status: "ask", question: saysNot ? negatedQuestion(store, owner, near) : nearQuestion(near), choices, planned: false };
}

/** Words that name Branch's settings outright. */
const settingsNamed = new Set(["setting", "settings", "preference", "preferences"]);
/**
 * Dogfood B20: whether these words are about Branch's own settings, so a task can start with the settings tools in reach
 * rather than searching for them. They name settings outright, say a phrase people use for one, or turn on or off
 * something the catalogue names. "Turn on the lights" and "switch to the other branch" are not.
 */
export function talksAboutSettings(text: string): boolean {
  const words = wordsOf(text);
  if (words.some((word) => settingsNamed.has(word)) || saidFor(text).length) return true;
  const turning = (["turn", "switch", "toggle"].some((verb) => words.includes(verb)) && (words.includes("on") || words.includes("off")))
    || ["enable", "disable", "activate", "deactivate"].some((verb) => words.includes(verb));
  return turning && (candidatesFor(text).length > 0 || nearest(text).shared >= 2);
}

/** A settings.list search as words: split at spaces, filler taken out, crudely stemmed. Each is still found inside a row's text. */
export function listWords(search: string): string[] {
  return [...new Set(search.toLowerCase().split(/\s+/).filter((word) => word && !filler.has(word)).map(stem))];
}
