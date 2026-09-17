import type { Policy, PolicyRule } from "../policy.js";
import type { Store } from "../store.js";
import { readComfort } from "./settings.js";

/**
 * R17-S19: the browser's extra care. Each of these only ever tightens what the approval rules and
 * the browser already do; with every switch at its default nothing here changes anything.
 */

/** The browser steps that type, press, send a file or take over the owner's own browser. */
export const sensitiveBrowserTools = ["browser.click", "browser.fill", "browser.act", "browser.upload", "browser.borrow"] as const;

/**
 * With "confirm sensitive actions" on, each of those steps is asked about every time, before any
 * standing yes the owner gave — including a yes for one particular website. A refusal the owner
 * wrote still decides first, so a website the owner refused stays refused.
 *
 * Rules that name a website are looked at before the broad ones (src/policy.ts), so each question
 * is written twice: once naming any website, for a step on a page, and once broad, for a step
 * before any page is open.
 */
export function withBrowserConfirmation(policy: Policy, store: Pick<Store, "get">, owner: string): Policy {
  if (!readComfort(store, owner, "browser").confirmSensitive) return policy;
  const ask = (tool: string, named: boolean): PolicyRule => ({
    tool, match: "*", applies: "any", decision: "ask", remember: "never",
    ...(named ? { resource: { kind: "host" as const, pattern: "*" } } : {}),
  });
  const refusals = policy.rules.filter((rule) => rule.decision === "deny");
  const rest = policy.rules.filter((rule) => rule.decision !== "deny");
  const asks = sensitiveBrowserTools.flatMap((tool) => [ask(tool, true), ask(tool, false)]);
  return { ...policy, rules: [...refusals, ...asks, ...rest] };
}

export const uploadsBlocked = "Sending files to websites is switched off in Settings › Computer & browser.";

/** What the browser needs to know before each step. */
export interface BrowserCare {
  blockUploads: boolean;
  dialogs: "dismiss" | "accept";
}
export const browserCareDefaults: BrowserCare = { blockUploads: false, dialogs: "dismiss" };

export function browserCare(store: Pick<Store, "get">, owner: string): BrowserCare {
  const { blockUploads, dialogs } = readComfort(store, owner, "browser");
  return { blockUploads, dialogs };
}
