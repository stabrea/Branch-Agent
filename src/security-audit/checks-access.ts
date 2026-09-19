import { globMatches } from "../policy-resources.js";
import { channelsOn, check, listed, shellOn } from "./kit.js";
import type { PolicyRuleFact, SecurityCheck, SecuritySnapshot, Verdict } from "./types.js";

/** Saved secrets, the phone door, short-lived keys, and the approval rules. */

const inFile = (snapshot: SecuritySnapshot, pattern: RegExp): string[] =>
  (snapshot.integrations?.keyLikeValues ?? []).filter((where) => pattern.test(where));

const liveTokens = (snapshot: SecuritySnapshot) =>
  snapshot.tokens.filter((token) => !token.revoked && Date.parse(token.expiresAt) > Date.parse(snapshot.now));

export const secretChecks: SecurityCheck[] = [
  check("secrets.key-in-launch-settings", "secrets", "warn", "No passwords or keys are written in the launch settings file", (snapshot) => {
    const found = inFile(snapshot, /^(?!mcp\[\d+\]\.args|hooks\[\d+\]\.args)/);
    return found.length ? {
      detail: `The launch settings file has what looks like a real key or password at ${listed(found)}. Anyone who can read the file can use it.`,
      advice: "Save the value in Settings → Secrets and name it in the file instead (the fields ending in Env or Secret take a name, not the value).",
    } : null;
  }),
  check("secrets.key-in-server-arguments", "secrets", "warn", "No keys are passed to outside servers on their command line", (snapshot) => {
    const found = inFile(snapshot, /^mcp\[\d+\]\.args/);
    return found.length ? {
      detail: `A key-like value is part of how an outside server is started (${listed(found)}). Every program on this computer can see a command line while it runs.`,
      advice: "Hand it over with envKeys instead, which passes it privately to that one program.",
    } : null;
  }),
  check("secrets.key-in-hook-arguments", "secrets", "warn", "No keys are passed to your hooks on their command line", (snapshot) => {
    const found = inFile(snapshot, /^hooks\[\d+\]\.args/);
    return found.length ? {
      detail: `A key-like value is written into a hook's arguments (${listed(found)}), where other programs can see it while the hook runs.`,
      advice: "Have the hook read the key from its own settings instead.",
    } : null;
  }),
  check("secrets.used-while-locked", "secrets", "warn", "Saved passwords stay shut while Branch is locked", (snapshot) =>
    snapshot.sessionLock.secretsWhileLocked ? {
      detail: "Branch may still take saved passwords and keys out of the locker while it is locked.",
      advice: "Turn off \"use secrets while locked\" in Settings → Secrets.",
    } : null),
  check("secrets.never-locks", "secrets", "info", "Branch locks itself when you step away", (snapshot) =>
    snapshot.sessionLock.idleMinutes === 0 && (channelsOn(snapshot) || snapshot.remoteEnabled === true) ? {
      detail: "Branch never locks by itself, and people can reach it from outside this computer.",
      advice: "Choose a number of quiet minutes after which it locks, in Settings → Secrets.",
    } : null),
  check("secrets.trace-headers-in-clear", "secrets", "warn", "Keys for sending traces are kept in the locker", (snapshot) =>
    snapshot.traceExport.plainHeaders.length ? {
      detail: `The trace sending settings hold ${listed(snapshot.traceExport.plainHeaders)} written out in full rather than as a reference to a saved secret.`,
      advice: "Save the key as a secret and write secret://default/NAME in its place, in Settings → Advanced.",
    } : null),
  check("secrets.launch-settings-unreadable", "secrets", "info", "The launch settings file can be read", (snapshot) =>
    snapshot.integrations?.problem ? {
      detail: `${snapshot.integrations.problem} The checks that depend on it were skipped.`,
      advice: "Fix the file, or remove BRANCH_INTEGRATIONS if you no longer use it.",
    } : null),
];

const remoteOn = (snapshot: SecuritySnapshot) => snapshot.remoteEnabled === true;

export const remoteChecks: SecurityCheck[] = [
  check("remote.open-without-password", "remote", "critical", "Reaching Branch from your phone needs more than the address", (snapshot) =>
    remoteOn(snapshot) && snapshot.gatewayChain.length === 0 ? {
      detail: "Your phone can reach Branch now, and the only thing it must show is the local key — no pairing code and no known device.",
      advice: "In Settings → Computer, require pairing (and, better, a known device) before a phone gets in.",
    } : null),
  check("remote.no-pairing", "remote", "warn", "A phone has to be paired before it gets in", (snapshot) =>
    remoteOn(snapshot) && snapshot.gatewayChain.length > 0 && !snapshot.gatewayChain.includes("pairing") ? {
      detail: "Your phone can reach Branch, and pairing is not one of the steps it must pass.",
      advice: "Add pairing to the steps in Settings → Computer.",
    } : null),
  check("remote.no-known-device", "remote", "info", "Only phones you know can get in", (snapshot) =>
    remoteOn(snapshot) && snapshot.gatewayChain.length > 0 && !snapshot.gatewayChain.includes("device") ? {
      detail: "A phone does not have to be one you approved before, only to pass the other steps.",
      advice: "Add \"a known device\" to the steps in Settings → Computer.",
    } : null),
  check("remote.weak-when-turned-on", "remote", "info", "Turning on phone access would ask for more than the key", (snapshot) =>
    snapshot.remoteEnabled !== true && snapshot.gatewayChain.length === 0 ? {
      detail: "Reaching Branch from your phone is off, but if you turn it on, a phone will only need the local key.",
      advice: "Require pairing in Settings → Computer before you turn it on.",
    } : null),
  check("remote.many-devices", "remote", "info", "Only a few devices are approved", (snapshot) =>
    snapshot.knownDevices > 5 ? {
      detail: `${snapshot.knownDevices} devices are approved to reach Branch.`,
      advice: "Remove the ones you no longer use in Settings → Computer.",
    } : null),
  check("remote.no-auto-lock", "remote", "warn", "Branch locks itself while your phone can reach it", (snapshot) =>
    remoteOn(snapshot) && snapshot.sessionLock.idleMinutes === 0 ? {
      detail: "Your phone can reach Branch and Branch never locks by itself.",
      advice: "Choose a number of quiet minutes after which it locks, in Settings → Secrets.",
    } : null),
  check("remote.long-lived-keys", "remote", "warn", "Short-lived keys really are short-lived", (snapshot) => {
    const week = Date.parse(snapshot.now) + 7 * 86400000;
    const long = liveTokens(snapshot).filter((token) => Date.parse(token.expiresAt) > week);
    return long.length ? {
      detail: `${listed(long.map((token) => token.name))} still work${long.length === 1 ? "s" : ""} for more than a week.`,
      advice: "Take them back and make new ones that last only as long as the job: branch token revoke <id>.",
    } : null;
  }),
  check("remote.keys-that-start-tasks", "remote", "info", "No outside key can start a task unless you meant it to", (snapshot) => {
    const run = liveTokens(snapshot).filter((token) => token.scope === "run");
    return run.length ? {
      detail: `${listed(run.map((token) => token.name))} can start tasks, not only look.`,
      advice: "If a script only needs to look, make it a key with --scope read instead.",
    } : null;
  }),
];

/** bucket 19 (integration review): the page people sign in on from their own device. */
const peopleOn = (snapshot: SecuritySnapshot) => !!snapshot.people && snapshot.people.mode !== "off";

export const peopleChecks: SecurityCheck[] = [
  check("people.pin-alone-from-afar", "remote", "warn", "People signing in from their phones need more than a PIN", (snapshot) =>
    peopleOn(snapshot) && remoteOn(snapshot) && snapshot.people!.chain.every((step) => step === "pin") ? {
      detail: "Signing in from other devices is on, your phone door is open, and a PIN of four to eight digits is all a person must give.",
      advice: "In Settings → General, add a passkey to the checks everybody passes.",
    } : null),
  check("people.long-sign-in", "remote", "info", "A person's sign-in on another device ends within a day", (snapshot) =>
    peopleOn(snapshot) && snapshot.people!.sessionMinutes > 24 * 60 ? {
      detail: `A person who signs in from another device stays signed in for ${Math.round(snapshot.people!.sessionMinutes / 60)} hours.`,
      advice: "Choose a shorter sign-in in Settings → General, beside the people on this computer.",
    } : null),
  check("people.accounts-waiting", "remote", "info", "No identity service account is waiting for you", (snapshot) =>
    peopleOn(snapshot) && snapshot.people!.waiting > 0 ? {
      detail: `${snapshot.people!.waiting} account${snapshot.people!.waiting === 1 ? " has" : "s have"} signed in with an email address you linked and ${snapshot.people!.waiting === 1 ? "is" : "are"} waiting for you to confirm ${snapshot.people!.waiting === 1 ? "it" : "them"}.`,
      advice: "Confirm only the accounts you recognise, in Settings → General.",
    } : null),
];

const shellTool = (tool: string): boolean => ["shell.execute", "shell.session.run", "shell.*"].some((name) => globMatches(tool, name) || globMatches(name, tool));
const coversAll = (rule: PolicyRuleFact): boolean => rule.tool === "*" && rule.match === "*" && !rule.hasResource;
const firstAllowCovering = (rules: PolicyRuleFact[], later: PolicyRuleFact) =>
  rules.slice(0, rules.indexOf(later)).find((rule) =>
    rule.decision === "allow" && rule.match === "*" && !rule.hasResource && rule.applies === "any" && globMatches(rule.tool, later.tool));

function nothingAsked(snapshot: SecuritySnapshot): Verdict | null {
  const { preset, rules } = snapshot.policy;
  if (rules.some((rule) => rule.decision !== "allow") || !shellOn(snapshot)) return null;
  if (preset !== "off" && rules.length) return null;
  return {
    severity: channelsOn(snapshot) ? "critical" : "warn",
    detail: channelsOn(snapshot)
      ? "Nothing you start yourself is checked with you before a tool runs, the assistant can run programs, and people can message it from outside."
      : "Nothing you start yourself is checked with you before a tool runs, and the assistant can run programs on this computer.",
    advice: "Pick \"Ask before changes\" in Settings → Permissions.",
  };
}

export const approvalChecks: SecurityCheck[] = [
  check("approvals.nothing-asked", "approvals", "warn", "Something is checked with you before a program runs", nothingAsked),
  check("approvals.allow-everything", "approvals", "critical", "No rule lets everything through", (snapshot) => {
    const rule = snapshot.policy.rules.find((entry) => entry.decision !== "allow" || coversAll(entry));
    return rule && rule.decision === "allow" && rule.applies === "any" ? {
      detail: "An approval rule allows every tool on everything before any other rule is looked at, so no other rule ever applies.",
      advice: "Remove that rule, or move it to the end of the list, in Settings → Permissions.",
    } : null;
  }),
  check("approvals.commands-allowed", "approvals", "warn", "Programs are not run without asking", (snapshot) => {
    const rule = snapshot.policy.rules.find((entry) => shellTool(entry.tool) && entry.match === "*" && !entry.hasResource);
    return rule?.decision === "allow" && shellOn(snapshot) ? {
      detail: "A rule lets the assistant run any of its programs, with any arguments, without asking.",
      advice: "Change that rule to ask, or narrow it to the commands you trust, in Settings → Permissions.",
    } : null;
  }),
  check("approvals.commands-unboxed", "approvals", "warn", "Programs you allow are held to limits", (snapshot) =>
    snapshot.policy.rules.some((rule) => shellTool(rule.tool) && rule.decision === "allow" && rule.sandbox === "none") ? {
      detail: "A rule lets programs run without asking and with no box around them at all.",
      advice: "Choose \"no internet\" or \"limits only\" for that rule in Settings → Permissions.",
    } : null),
  check("approvals.unlisted-commands-allowed", "approvals", "warn", "A command no rule mentions still asks first", (snapshot) =>
    snapshot.policy.unmatchedCommands === "allow" && shellOn(snapshot) ? {
      detail: "A command that no rule says anything about runs without asking.",
      advice: "Set \"a command no rule covers\" back to ask, in Settings → Permissions.",
    } : null),
  check("approvals.refusal-never-reached", "approvals", "warn", "Every refusal rule can take effect", (snapshot) => {
    const shadowed = snapshot.policy.rules.filter((rule) => rule.decision === "deny" && firstAllowCovering(snapshot.policy.rules, rule));
    return shadowed.length ? {
      detail: `A rule refusing ${listed(shadowed.map((rule) => rule.tool))} comes after a rule that already allows it, and the first rule that matches wins.`,
      advice: "Move the refusal above the rule that allows it, in Settings → Permissions.",
    } : null;
  }),
  check("approvals.yes-kept-forever", "approvals", "info", "A yes to running a program is not kept for ever", (snapshot) =>
    snapshot.policy.rules.some((rule) => shellTool(rule.tool) && rule.decision === "ask" && rule.remember === "always") ? {
      detail: "When you say yes to a command, that yes is kept for good, not just for the conversation.",
      advice: "Set that rule to remember for the conversation only, in Settings → Permissions.",
    } : null),
  check("approvals.no-pace-with-channels", "approvals", "info", "Tasks from outside are paced", (snapshot) =>
    channelsOn(snapshot) && snapshot.policy.limits.toolCallsPerMinute === 0 && snapshot.policy.limits.modelRoundsPerMinute === 0 ? {
      detail: "People can message the assistant from outside and there is no limit on how fast a conversation may use tools.",
      advice: "Set a number of tool calls a minute in Settings → Permissions.",
    } : null),
];
