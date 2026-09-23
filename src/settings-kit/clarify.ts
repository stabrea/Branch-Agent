import type { Store } from "../store.js";
import { settingsCatalogue, type FieldSpec, type SettingSpec } from "./catalogue.js";
import { acceptValue, changesFor, currentValue, type Value } from "./changes.js";

/**
 * Q50: a settings request in the owner's own words ("turn the wake word on", "switch off the
 * board") is matched against the catalogue before anything is planned. When the words fit more
 * than one setting, or none, the answer is one question for the owner and no plan at all. When they
 * fit exactly one, the answer is the exact before and after `changesFor` works out, with anything
 * already as asked left out.
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

const wordsOf = (text: string): string[] =>
  text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** The words that name a setting, with filler and bare numbers taken out. */
export function namingWords(request: string): string[] {
  return [...new Set(wordsOf(request).filter((word) => !filler.has(word) && !/^\d+$/.test(word)).map(stem))];
}

/** Words with accents taken out as well, so "arrête" is "arrete". */
const plainWords = (text: string): string[] => wordsOf(text.normalize("NFD").replace(/[̀-ͯ]/g, ""));

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
  const words = said.split(" ").filter(Boolean);
  const frenchNe = words.includes("ne") || /(^|[^a-z])n['’][a-z]/i.test(request);
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

/** Every field whose name, label or key holds each naming word; a value narrows it to fields that can hold it. */
export function candidatesFor(request: string, value?: unknown): Candidate[] {
  const words = namingWords(request);
  if (!words.length) return [];
  const all = settingsCatalogue.flatMap((spec) => spec.fields.map((field) => ({ spec, field })));
  const named = all.filter(({ spec, field }) => {
    const known = new Set(wordsOf(`${spec.key} ${spec.name} ${field.label} ${field.field}`).map(stem));
    return words.every((word) => known.has(word));
  });
  if (value === undefined || named.length < 2) return named;
  const holding = named.filter(({ field }) => valueFor(field, value) !== undefined);
  return holding.length ? holding : named;
}

const idOf = ({ spec, field }: Candidate): string => `${spec.key}.${field.field}`;
const nameOf = ({ spec, field }: Candidate): string => spec.fields.length > 1 ? `${spec.name}: ${field.label}` : spec.name;

function listed(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/** One question for the owner, naming what the words could mean. */
export function questionFor(request: string, found: readonly Candidate[]): string {
  if (!found.length) return `I could not find a setting that matches "${request.slice(0, 80)}". Which setting do you mean?`;
  const shown = found.slice(0, 5).map(nameOf);
  if (found.length > shown.length) return `That could be ${found.length} settings, such as ${listed(shown)}. Which one do you mean?`;
  return `That could be more than one setting. Do you mean ${listed(shown)}?`;
}

/** The one question for a request that says not to: nothing is planned until the owner says what they want. */
function negatedQuestion(store: Store, owner: string, found: readonly Candidate[]): string {
  const said = "Your words say not to, so nothing is planned.";
  if (!found.length) return `${said} Which setting do you mean, and what should it be?`;
  if (found.length === 1) {
    const [only] = found as [Candidate];
    return `${said} Should "${nameOf(only)}" change from ${String(currentValue(store, owner, only.spec, only.field))}, and to what?`;
  }
  return `${said} Should ${listed(found.slice(0, 5).map(nameOf))} change, and to what?`;
}

type Choice = { setting: string; name: string; value: Value };
type Preview = { setting: string; name: string; label: string; from: Value; to: Value; lessCareful: boolean; pinned: boolean };
export type Clarified =
  | { status: "ask"; question: string; choices: Choice[]; planned: false }
  | { status: "ready"; setting: string; preview: Preview[]; useTool: "settings.change" | "settings.loosen" }
  | { status: "unchanged"; setting: string; note: string; refused: string[] };

/**
 * What a request in the owner's words comes to: one question when it fits several settings or none
 * (nothing is planned then), otherwise the exact change for the one setting it fits.
 */
export function clarifyRequest(store: Store, owner: string, input: { request: string; value?: Value | undefined }): Clarified {
  const asked = input.value ?? spokenValue(input.request);
  const found = candidatesFor(input.request, asked);
  const choices = (list: readonly Candidate[]): Choice[] => list.slice(0, 20)
    .map((one) => ({ setting: idOf(one), name: nameOf(one), value: currentValue(store, owner, one.spec, one.field) }));
  if (negated(input.request)) return { status: "ask", question: negatedQuestion(store, owner, found), choices: choices(found), planned: false };
  if (found.length !== 1) return { status: "ask", question: questionFor(input.request, found), choices: choices(found), planned: false };
  const [only] = found as [Candidate];
  const setting = idOf(only), now = currentValue(store, owner, only.spec, only.field);
  if (asked === undefined)
    return { status: "ask", question: `What should "${nameOf(only)}" be? It is ${String(now)} now.`, choices: choices(found), planned: false };
  const to = valueFor(only.field, asked) ?? asked;
  const { changes, refused } = changesFor(store, owner, [{ key: only.spec.key, field: only.field.field, value: to }]);
  if (!changes.length)
    return { status: "unchanged", setting, refused, note: refused.length ? refused.join("; ") : `"${nameOf(only)}" is already ${String(now)}. Nothing needs changing.` };
  const preview = changes.map((change) => ({ setting: change.id, name: change.name, label: change.label, from: change.from, to: change.to,
    lessCareful: change.loosens, pinned: change.pinned }));
  return { status: "ready", setting, preview, useTool: preview.some((one) => one.lessCareful) ? "settings.loosen" : "settings.change" };
}
