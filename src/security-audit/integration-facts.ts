import { readFile, stat } from "node:fs/promises";
import { findLeaks, looksLikeSecretValue } from "../leak-guard.js";
import type { ChannelFact, HookFact, IntegrationFacts, McpFact, ShellFact } from "./types.js";

/**
 * The launch settings file, read for the self-check. It is read loosely on purpose: the loader in
 * src/integrations/bootstrap.ts refuses a file it does not understand, and the check should still
 * be able to say what is in it. Defaults are the loader's own (pairing on, commands not boxed off
 * from the internet, a hook that times out asks).
 */

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose => (value && typeof value === "object" && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const texts = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === "string");

function mcpFacts(value: unknown): McpFact[] {
  return list(value).map((entry) => {
    const server = record(entry);
    return {
      id: text(server.id), transport: server.transport === "http" ? "http" : "stdio",
      command: text(server.command), args: texts(server.args), url: text(server.url), envKeys: texts(server.envKeys),
    };
  });
}
function shellFacts(value: unknown): ShellFact | null {
  if (value === undefined) return null;
  const shell = record(value);
  const executables = Object.entries(record(shell.executables)).map(([alias, entry]) =>
    ({ alias, path: text(record(entry).path), args: texts(record(entry).args) }));
  return {
    executables, netless: shell.netless === true, useJobObject: shell.useJobObject !== false,
    inheritEnv: shell.inheritEnv === undefined ? ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] : texts(shell.inheritEnv),
  };
}
function channelFacts(value: unknown): ChannelFact[] {
  return list(value).map((entry) => {
    const channel = record(entry);
    return {
      id: text(channel.id), type: text(channel.type),
      activation: channel.activation === "always" ? "always" : "mention",
      pairing: channel.pairing !== false, allowlist: texts(channel.allowlist),
      tls: channel.type !== "email" || [record(channel.imap).tls, record(channel.smtp).tls].every((tls) => tls !== false),
    };
  });
}
function hookFacts(value: unknown): HookFact[] {
  return list(value).map((entry) => {
    const hook = record(entry);
    return { id: text(hook.id), event: text(hook.event), executable: text(hook.executable),
      args: texts(hook.args), onTimeout: hook.onTimeout === "allow" ? "allow" : "ask" };
  });
}

const secretKeyName = /pass(word|wd)?|token|secret|api_?key|bearer|credential/i;
const namesASecret = /(Env|Secret|Secrets)$/;

/** Where in the file a string that looks like a real key or password was written. Values are never kept. */
export function keyLikeValues(value: unknown, where = "", depth = 0, found: string[] = []): string[] {
  if (depth > 12 || found.length >= 20) return found;
  if (typeof value === "string") {
    const key = where.split(/[.[\]]/).filter(Boolean).pop() ?? "";
    const named = secretKeyName.test(key) && !namesASecret.test(key) && looksLikeSecretValue(value);
    if (named || findLeaks(value).length) found.push(where || "(the whole file)");
  } else if (Array.isArray(value)) value.forEach((item, index) => keyLikeValues(item, `${where}[${index}]`, depth + 1, found));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) keyLikeValues(item, where ? `${where}.${key}` : key, depth + 1, found);
  return found;
}

const empty = (path: string, problem: string | null): IntegrationFacts => ({
  path, problem, mcp: [], shell: null, browser: null, channels: [], hooks: [], web: null, keyLikeValues: [],
});

/** Reads the file the same way the loader does (a file, at most 64 KiB), and never throws. */
export async function readIntegrationFacts(path: string): Promise<IntegrationFacts> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return empty(path, "The launch settings file named in BRANCH_INTEGRATIONS is not there.");
  if (info.size > 65536) return empty(path, "The launch settings file is larger than Branch will read.");
  let parsed: Loose;
  try { parsed = record(JSON.parse(await readFile(path, "utf8"))); }
  catch { return empty(path, "The launch settings file is not valid JSON, so Branch cannot read it."); }
  const browser = parsed.browser === undefined ? null : record(parsed.browser);
  const web = parsed.web === undefined ? null : record(parsed.web);
  return {
    path, problem: null, mcp: mcpFacts(parsed.mcp), shell: shellFacts(parsed.shell),
    browser: browser && { allowedOrigins: texts(browser.allowedOrigins),
      downloadTypes: browser.downloadTypes === undefined ? [] : texts(browser.downloadTypes) },
    channels: channelFacts(parsed.channels), hooks: hookFacts(parsed.hooks),
    web: web && { allowPrivateAddresses: web.allowPrivateAddresses === true,
      allowedHosts: web.allowedHosts === undefined ? null : texts(web.allowedHosts), injection: text(web.injection) || "warn" },
    keyLikeValues: keyLikeValues(parsed),
  };
}
