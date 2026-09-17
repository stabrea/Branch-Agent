import { readPath } from "../json-template.js";
import type { Recipe } from "./recipes.js";

/**
 * Checking what the owner pasted before it is saved, with the vendor's own read-only "who am I"
 * request. The fetch handed in has already been put behind the network settings. What was pasted is
 * never written into an error, a log or an answer: every message is scrubbed of it first.
 */
export class SetupRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type Values = Record<string, string>;
export type CheckResult = { ok: true; name: string | null } | { ok: false; reason: string } | { ok: null; reason: string };

/** A server address the owner typed: https only, no name or password inside, no query. */
export function cleanServer(text: string): string {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new SetupRefusal(400, "The server address must be a full address starting with https://."); }
  if (url.protocol !== "https:") throw new SetupRefusal(400, "The server address must start with https://.");
  if (url.username || url.password || url.search || url.hash) throw new SetupRefusal(400, "The server address must not carry a name, a password or anything after a ? or #.");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** Everything the recipe needs, present and in the right shape. Only names are ever said back. */
export function readValues(recipe: Recipe, input: Record<string, unknown>): Values {
  const values: Values = {};
  for (const field of recipe.fields) {
    const raw = typeof input[field.name] === "string" ? (input[field.name] as string).trim() : "";
    if (!raw) throw new SetupRefusal(400, `${field.what} is missing.`);
    if (raw.length > 400 || /[\r\n]/.test(raw)) throw new SetupRefusal(400, `${field.what} is not in the right shape.`);
    const value = field.kind === "url" ? cleanServer(raw) : raw;
    if (field.pattern && !new RegExp(field.pattern).test(value)) throw new SetupRefusal(400, `${field.what} is not in the right shape.`);
    values[field.name] = value;
  }
  for (const paste of recipe.paste) {
    const raw = typeof input[paste.secret] === "string" ? (input[paste.secret] as string).trim() : "";
    if (!raw) {
      if (paste.optional) continue;
      throw new SetupRefusal(400, `${paste.what} is missing.`);
    }
    if (raw.length > 4000 || /\s/.test(raw.replace(/ /g, ""))) throw new SetupRefusal(400, `${paste.what} does not look right. Paste it again, on its own.`);
    if (paste.pattern && !new RegExp(paste.pattern).test(raw)) throw new SetupRefusal(400, `${paste.what} does not look right. Paste it again, on its own.`);
    values[paste.secret] = raw;
  }
  return values;
}

/** Fills `{{name}}`; everything but the server is encoded, so a value cannot change the address's shape. */
export function fill(template: string, values: Values, encode: (text: string) => string = (text) => text): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new SetupRefusal(400, "Something the check needs is missing.");
    return name === "server" ? value : encode(value);
  });
}

function headersFor(check: NonNullable<Recipe["check"]>, values: Values): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, value] of Object.entries(check.headers ?? {})) headers[name] = fill(value, values);
  const secret = check.auth.secret ? values[check.auth.secret] ?? "" : "";
  const kind = check.auth.kind;
  if (kind === "bearer") headers.authorization = `Bearer ${secret}`;
  if (kind === "bot") headers.authorization = `Bot ${secret}`;
  if (kind === "oauth") headers.authorization = `OAuth ${secret}`;
  if (kind === "basic") headers.authorization = `Basic ${Buffer.from(`${fill(check.auth.user ?? "", values)}:${secret}`).toString("base64")}`;
  if (kind === "header" && check.auth.header) headers[check.auth.header] = secret;
  return headers;
}

function requestFor(check: NonNullable<Recipe["check"]>, values: Values): { url: string; init: RequestInit } {
  // Only the path kind may put a secret in the address, because that is how the vendor's API is written.
  const url = check.auth.kind === "path"
    ? fill(check.url, values, (text) => encodeURIComponent(text).replace(/%3A/g, ":")) // a bot token keeps its colon
    : fill(check.url, withoutSecrets(values), encodeURIComponent);
  const headers = headersFor(check, values);
  let body: string | undefined;
  if (check.body) {
    const filled = Object.fromEntries(Object.entries(check.body).map(([key, value]) => [key, fill(value, values)]));
    body = check.encoding === "form" ? new URLSearchParams(filled).toString() : JSON.stringify(filled);
    headers["content-type"] = check.encoding === "form" ? "application/x-www-form-urlencoded" : "application/json";
  }
  return { url, init: { method: check.method, headers, ...(body !== undefined ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(15_000) } };
}
/** Secrets are named in capitals, the owner's plain settings in lower case. */
function withoutSecrets(values: Values): Values {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !/^[A-Z]/.test(name)));
}

/** Takes every pasted value out of a sentence before it goes anywhere. */
export function scrub(text: string, values: Values): string {
  let said = text;
  for (const [name, value] of Object.entries(values))
    if (/^[A-Z]/.test(name) && value.length >= 4) said = said.split(value).join("…").split(encodeURIComponent(value)).join("…");
  return said.replace(/bot\d{5,15}:[A-Za-z0-9_-]+/g, "bot…");
}

/** Asks the vendor whether what was pasted works. */
export async function runCheck(recipe: Recipe, values: Values, fetcher: typeof fetch): Promise<CheckResult> {
  const check = recipe.check;
  if (!check) return { ok: null, reason: recipe.noCheck ?? "There is no check for this app." };
  const { url, init } = requestFor(check, values);
  const host = new URL(url).host;
  try {
    const response = await fetcher(url, init);
    const answer: unknown = await response.json().catch(() => null);
    const found = answer === null ? undefined : readPath(answer, check.ok);
    const good = response.ok && found !== undefined && found !== null && (check.okValue === undefined || found === check.okValue);
    if (!good) return { ok: false, reason: `${recipe.name} did not accept that (it answered ${response.status}). Check you copied the whole thing.` };
    const name = check.name && answer !== null ? readPath(answer, check.name) : undefined;
    return { ok: true, name: typeof name === "string" || typeof name === "number" ? String(name).slice(0, 80) : null };
  } catch (error) {
    return { ok: false, reason: scrub(`Could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`, values) };
  }
}
