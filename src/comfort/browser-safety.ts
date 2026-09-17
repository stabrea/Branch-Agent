import { globMatches, type Policy, type PolicyRule } from "../policy.js";
import type { Store } from "../store.js";
import { readComfort } from "./settings.js";

/**
 * R17-S19: the browser's extra care. Each of these only ever tightens what the approval rules and
 * the browser already do; with every switch at its default nothing here changes anything.
 */

/** The browser steps that type, press, send a file or take over the owner's own browser. */
export const sensitiveBrowserTools = ["browser.click", "browser.fill", "browser.act", "browser.upload", "browser.borrow"] as const;

/**
 * With "confirm sensitive actions" on, each of those steps is asked about every time, whatever the
 * owner allowed before — including a yes for one website. Every refusal keeps deciding exactly
 * where it did, so turning this on can never make a refused step askable.
 *
 * Nothing is put in front of the owner's rules. Instead, just before each rule that would let one of
 * those steps through, the same rule is written again as a question for that step, so it sits in the
 * same place (src/policy.ts looks at rules naming a website first, then the broad ones, each in the
 * owner's order). A broad question for each step goes last, for a step no rule speaks about.
 */
export function withBrowserConfirmation(policy: Policy, store: Pick<Store, "get">, owner: string): Policy {
  if (!readComfort(store, owner, "browser").confirmSensitive) return policy;
  const question = (rule: Pick<PolicyRule, "match" | "applies" | "resource">, tool: string): PolicyRule => ({
    tool, match: rule.match, applies: rule.applies, decision: "ask", remember: "never",
    ...(rule.resource ? { resource: rule.resource } : {}),
  });
  const rules = policy.rules.flatMap((rule) => rule.decision !== "allow" ? [rule]
    : [...sensitiveBrowserTools.filter((tool) => globMatches(rule.tool, tool)).map((tool) => question(rule, tool)), rule]);
  const lastly = sensitiveBrowserTools.map((tool) => question({ match: "*", applies: "any" }, tool));
  return { ...policy, rules: [...rules, ...lastly] };
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
