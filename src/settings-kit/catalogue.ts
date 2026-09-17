import { savePolicy } from "../policy.js";
import type { Store } from "../store.js";
import { saveLoopGuardSettings } from "../loop-guard.js";
import { saveFolderTrustSettings } from "../folder-trust.js";
import { saveReviewerSettings } from "../approval-reviewer.js";
import { saveSecurityCheckSettings } from "../security-audit/settings.js";
import { saveWallSettings, wallSettings } from "../sandbox.js";
import { saveKeychainSettings } from "../vault-sources.js";
import { retentionSettings, saveRetentionSettings } from "../retention.js";
import { eventLoopSettings, eventLoopWatch, saveEventLoopSettings } from "../event-loop-watch.js";
import { audit } from "../audit.js";
import { saveComfort, type ComfortCard } from "../comfort/settings.js";

/**
 * R17-S-A (understandable settings): the settings that can be put back to how they started, set
 * from a whole-app preset, and saved to or brought in from one file.
 *
 * This is an explicit list, not a sweep of the `settings` table. That table also holds things that
 * are not settings at all — Lockdown, the session lock, model connections, Keychain entries, people
 * and their devices, pairing codes, notes that a migration already ran — and putting any of those
 * "back to how it started" would lock the owner out or throw away their work. So only the fields
 * named here are ever read or written, and every one of them is a switch, a yes/no, a choice from a
 * short list or a bounded number. None of them can hold a secret.
 *
 * Every field also says which way is the less careful one, so a change that loosens safety or
 * reach can be shown apart and has to be confirmed on its own.
 */

/** Off, when needed, on — the three-way switch every feature has. */
export const switchPositions = ["off", "when-needed", "on"] as const;

/**
 * Which direction is the less careful one.
 *   reach    — turning it up lets Branch do or reach more (the screen, the Keychain, sending counts)
 *   guard    — turning it down takes a protection away (loop guard, the wall around programs)
 *   plain    — neither; a comfort or a convenience
 */
export type Guard = "reach" | "guard" | "plain";

export type FieldKind =
  | { type: "switch" }
  | { type: "yes-no" }
  /** Choices written from most careful to least careful. */
  | { type: "choice"; options: readonly string[] }
  | { type: "number"; min: number; max: number };

export interface FieldSpec {
  /** The field inside the saved record; a dot reaches one level in ("files.soul"). */
  field: string;
  label: string;
  /** The `data-t` key for the label. */
  t: string;
  kind: FieldKind;
  initial: string | number | boolean;
  guard: Guard;
}

export interface SettingSpec {
  key: string;
  name: string;
  /** The `data-t` key for the name. */
  t: string;
  /** Where the card lives (docs/places.md). */
  home: string;
  fields: FieldSpec[];
  /** Records that keep an older yes/no beside the switch have it kept in step. */
  keepsEnabled?: boolean;
  /**
   * A setting that has its own way of being saved uses it, so a copy kept in memory, a tool that
   * comes and goes, or the record of the change is never skipped (integration review).
   */
  write?: (store: Store, owner: string, patch: Record<string, unknown>) => void;
  /** A setting whose module reads a damaged record in its own way (the wall reads it as "on") is shown that way. */
  read?: (store: Store, owner: string) => Record<string, unknown>;
}

const sw = (field: string, label: string, t: string, guard: Guard): FieldSpec =>
  ({ field, label, t, kind: { type: "switch" }, initial: "off", guard });
const yesNo = (field: string, label: string, t: string, guard: Guard, initial = false): FieldSpec =>
  ({ field, label, t, kind: { type: "yes-no" }, initial, guard });
const one = (key: string, name: string, t: string, home: string, guard: Guard, extra: Partial<SettingSpec> = {}): SettingSpec =>
  ({ key, name, t, home, fields: [sw("mode", "Switch", "settings-kit.field.switch", guard)], ...extra });
const saveWall = (store: Store, owner: string, patch: Record<string, unknown>): void => {
  const next = saveWallSettings(store, owner, { ...wallSettings(store, owner), ...patch });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `The wall around programs: ${next.mode}, reach ${next.network}`,
    reason: "Changed from Settings: presets, reset or a settings file", outcome: "saved" });
};

const safety: SettingSpec[] = [
  {
    key: "policy", name: "When to check with me", t: "settings-kit.name.policy", home: "settings:permissions",
    fields: [
      { field: "preset", label: "How careful", t: "settings-kit.field.policy-preset", guard: "guard", initial: "off",
        kind: { type: "choice", options: ["read-only", "ask-before-changes", "workspace", "off"] } },
      { field: "unmatchedCommands", label: "A command no rule mentions", t: "settings-kit.field.unmatched", guard: "guard", initial: "ask",
        kind: { type: "choice", options: ["ask", "allow"] } },
    ],
    // The approval rules are worked out from the preset, so the preset is saved the way the card saves it.
    write: (store, owner, patch) => { savePolicy(store, owner, patch, "Changed from Settings: presets, reset or a settings file"); },
  },
  one("approval_reviewer", "A second look before approvals", "settings-kit.name.reviewer", "settings:permissions", "guard",
    { write: (store, owner, patch) => { saveReviewerSettings(store, owner, patch); } }),
  one("loop_guard", "Stopping repeated steps", "settings-kit.name.loop-guard", "settings:permissions", "guard",
    { write: (store, owner, patch) => { saveLoopGuardSettings(store, owner, patch); } }),
  one("folder_trust_mode", "Trusted folders", "settings-kit.name.folder-trust", "settings:permissions", "guard",
    { write: (store, owner, patch) => { saveFolderTrustSettings(store, owner, patch); } }),
  {
    key: "security-check", name: "Security self-check", t: "settings-kit.name.security-check", home: "settings:permissions",
    fields: [sw("audit", "Check by itself", "settings-kit.field.audit", "guard"),
      sw("malware", "Check add-ons for malware", "settings-kit.field.malware", "guard")],
    // The window hands in the service's own save, which also adds or takes away the check's tool.
    write: (store, owner, patch) => { saveSecurityCheckSettings(store, owner, patch); },
  },
  {
    key: "os-sandbox", name: "The wall around programs", t: "settings-kit.name.os-sandbox", home: "settings:computer",
    fields: [sw("mode", "Switch", "settings-kit.field.switch", "guard"),
      { field: "network", label: "What programs behind the wall may reach", t: "settings-kit.field.wall-network", guard: "guard",
        initial: "none", kind: { type: "choice", options: ["none", "limited", "per-site", "open"] } }],
    write: saveWall,
    read: (store, owner) => ({ ...wallSettings(store, owner) }),
  },
];

const reach: SettingSpec[] = [
  one("desktop-control", "Your screen and keyboard", "settings-kit.name.desktop", "settings:computer", "reach", { keepsEnabled: true }),
  one("keychain-entries", "Passwords from the Keychain", "settings-kit.name.keychain", "settings:secrets", "reach",
    { keepsEnabled: true, write: (store, owner, patch) => { saveKeychainSettings(store, owner, patch); } }),
  {
    key: "voice", name: "Voice", t: "settings-kit.name.voice", home: "settings:voice",
    fields: [sw("systemVoice", "Your computer's own voice", "settings-kit.field.system-voice", "reach"),
      yesNo("autoReadAloud", "Read replies aloud automatically", "settings-kit.field.read-aloud", "plain"),
      yesNo("keepAudioOnThisComputer", "Keep audio on this computer", "settings-kit.field.keep-audio", "guard"),
      yesNo("replyWithVoiceOnChannels", "Answer a voice note with a voice note", "settings-kit.field.voice-reply", "reach")],
  },
  one("media-programs", "Watching and saving videos", "settings-kit.name.video", "settings:models:media", "reach"),
  one("speech-engines", "Other speech services", "settings-kit.name.speech", "settings:voice", "reach"),
  one("execution-metrics", "Sending the counters", "settings-kit.name.counters", "settings:advanced", "reach", { keepsEnabled: true }),
  one("asks-analytics", "Counting how Branch is used", "settings-kit.name.analytics", "settings:data", "reach"),
  one("asks-answer-engine", "Quick answers from the web", "settings-kit.name.answers", "library:made", "reach"),
  one("asks-runtimes", "Other agents answering a conversation", "settings-kit.name.runtimes", "settings:models:connection", "reach"),
  one("asks-nodes", "Other computers running Branch", "settings-kit.name.nodes", "settings:computer", "reach"),
  one("move-in-switch", "Looking at other assistants' folders", "settings-kit.name.move-in", "settings:data", "reach"),
  one("memory-history", "Keeping the history of what it remembers", "settings-kit.name.memory-history", "library:memory", "reach"),
  one("pull-request-hook", "Pull requests from changes", "settings-kit.name.pull-requests", "settings:advanced", "reach"),
  one("skill-installs", "Installing skills from a file", "settings-kit.name.skill-installs", "customize:skills", "reach"),
  one("workspace-editor", "Code editor", "settings-kit.name.code-editor", "settings:advanced", "reach"),
  one("sdk-kit", "Tools for building on Branch", "settings-kit.name.sdk-kit", "settings:advanced", "reach"),
];

const comfort: SettingSpec[] = [
  one("local-models", "Models on this computer", "settings-kit.name.local-models", "settings:models:local", "plain", { keepsEnabled: true }),
  one("usage-report", "Usage report", "settings-kit.name.usage-report", "settings:data", "plain", { keepsEnabled: true }),
  one("event-loop-watch", "Whether Branch is keeping up", "settings-kit.name.event-loop", "settings:advanced", "plain",
    { write: (store, owner, patch) => { eventLoopWatch.follow(saveEventLoopSettings(store, owner, { ...eventLoopSettings(store, owner), ...patch })); } }),
  one("run-recording", "Recording each task", "settings-kit.name.recording", "inbox:history", "plain"),
  one("prompt-library", "Saved prompts", "settings-kit.name.prompts", "automations:procedures", "plain"),
  one("command-catalog", "The shared commands", "settings-kit.name.commands", "settings:general", "plain"),
  one("asks-project-board", "Project boards", "settings-kit.name.project-board", "settings:general", "plain"),
  one("fly-core", "What Branch learns from experience", "settings-kit.name.fly-core", "library:memory", "plain"),
  {
    key: "goal-undo", name: "Goals and going back", t: "settings-kit.name.goal-undo", home: "settings:data",
    // Working on until a goal is met is the assistant acting on its own; the snapshots are what lets you go back.
    fields: [sw("goal", "Keep working until a goal is met", "settings-kit.field.goal", "reach"),
      sw("snapshots", "Record the files before a task", "settings-kit.field.snapshots", "guard")],
  },
  {
    key: "reflection", name: "Looking back over conversations", t: "settings-kit.name.reflection", home: "library:memory",
    fields: [sw("reflection", "Looking back", "settings-kit.field.reflection", "plain"),
      sw("newSkills", "Writing new skills from experience", "settings-kit.field.new-skills", "reach")],
  },
  {
    key: "context-files", name: "The files you write", t: "settings-kit.name.context-files", home: "settings:general",
    fields: ["soul", "identity", "user", "agents", "tools", "sop", "memory", "heartbeat"].map((slot) =>
      sw(`files.${slot}`, `${slot.toUpperCase()}.md`, `settings-kit.field.file-${slot}`, "plain")),
  },
  {
    key: "retention", name: "How long conversations are kept", t: "settings-kit.name.retention", home: "settings:data",
    fields: [yesNo("enabled", "Offer to delete old conversations", "settings-kit.field.retention", "plain"),
      { field: "keepDays", label: "Older than this many days", t: "settings-kit.field.keep-days", guard: "plain",
        initial: 0, kind: { type: "number", min: 0, max: 3650 } }],
    write: (store, owner, patch) => { saveRetentionSettings(store, owner, { ...retentionSettings(store, owner), ...patch }); },
  },
];

/**
 * R17-S-C integration review: the comfort cards' switches and short lists (src/comfort/settings.ts),
 * saved through the cards' own checks. The proxy, the certificates, the browser's care and automatic
 * installing are not here and are on the never-touched list: no preset or file may set them.
 */
const viaComfort = (card: ComfortCard) => (store: Store, owner: string, patch: Record<string, unknown>): void => {
  saveComfort(store, owner, card, patch);
};
const comfortCards: SettingSpec[] = [
  { key: "comfort-keys", name: "Shortcuts", t: "comfort.keys.title", home: "settings:general", write: viaComfort("keys"),
    fields: [yesNo("vim", "Vim keys in the message box", "comfort.field.vim", "plain")] },
  { key: "comfort-display", name: "Status line and times", t: "comfort.display.title", home: "settings:appearance", write: viaComfort("display"),
    fields: [yesNo("timestamps", "A time on every message", "comfort.field.timestamps", "plain")] },
  { key: "comfort-notify", name: "Notifications and sound", t: "comfort.notify.title", home: "settings:notifications", write: viaComfort("notify"),
    fields: [
      { field: "method", label: "Where you are told", t: "comfort.field.method", guard: "plain", initial: "system", kind: { type: "choice", options: ["system", "window"] } },
      { field: "sound", label: "Sound", t: "comfort.field.sound", guard: "plain", initial: "off", kind: { type: "choice", options: ["off", "chime", "knock"] } },
    ] },
  { key: "comfort-files", name: "Ignore files", t: "comfort.files.title", home: "settings:general", write: viaComfort("files"),
    // Turning .gitignore off lets searches see more of the workspace (never a secret file).
    fields: [yesNo("respectGitignore", "Skip what .gitignore lists", "comfort.field.respectGitignore", "guard", true)] },
  { key: "comfort-mcp", name: "Tool servers' start-up time", t: "comfort.mcp.title", home: "customize:connections", write: viaComfort("mcp"),
    fields: [{ field: "startupTimeoutSeconds", label: "Seconds a server may take to start", t: "comfort.field.startupTimeoutSeconds",
      guard: "plain", initial: 10, kind: { type: "number", min: 1, max: 300 } }] },
];

export const settingsCatalogue: readonly SettingSpec[] = [...safety, ...reach, ...comfort, ...comfortCards];

/**
 * Records that are never touched from here, whatever a file or a preset names. The catalogue above
 * does not name them either; this list is the second lock, and the one a crafted file meets first.
 */
export const neverTouched: readonly RegExp[] = [
  /^lockdown$/, /^session-lock$/, /^model-connections/, /^local-model-connections$/, /^local-model-setups$/,
  /^secret/, /^credential/, /^people/, /^remote/, /pairing/, /^deferred:/, /^move-in:/,
  /^feature-switches-migration$/, /^webhook-addresses$/, /^sender-allowlist$/, /^telegram-setup$/,
  // Integration review: accounts, add-on lists and their wall, the leak guard, what is passed on to
  // programs, never-break and its gateway, tunnels and the launch file are never reached from here.
  /^accounts?(-|$)/, /^add-?ons?/, /leak/, /^knobs?/, /env/, /^never-break/, /gateway/, /tunnel/, /launch/,
  // R17-S-C integration review: the proxy and certificates, the browser's care, and updating by itself.
  /^comfort-(network|browser|update)/,
];

/** A field name that sounds like it could hold a secret is refused outright, whatever the catalogue says. */
export const secretShaped = /key|token|secret|password|passphrase|credential|cookie|auth/i;

/**
 * A setting whose name sounds like safety or reach. Should one of its fields ever be written down as
 * "plain", any move of it still counts as less careful (src/settings-kit/changes.ts, loosens).
 */
export const securityShaped =
  /sandbox|trust|polic|approv|review|guard|never|wall|add-?on|page-?note|web-?page|autonom|connector|tunnel|knob|env|leak|lock|keychain|desktop|remote|pair|secret|credential|account|people|gateway|launch|security|goal|skill|plan-act|orchestrat|permission/i;

/**
 * What a setting's field is, for anything that has to decide about it. Fails closed: a setting or
 * field that is not in the catalogue, or is on the never-touched list, is "blocked", including every
 * setting added after this was written.
 */
export type Classification = "blocked" | "plain" | "less-careful-when-raised" | "less-careful-when-lowered" | "less-careful-either-way";
export function classify(key: string, field: string): Classification {
  const spec = specFor(key);
  const found = spec?.fields.find((entry) => entry.field === field);
  if (!spec || !found || secretShaped.test(field)) return "blocked";
  if (found.guard === "plain") return securityShaped.test(key) ? "less-careful-either-way" : "plain";
  return found.guard === "reach" || found.kind.type === "choice" ? "less-careful-when-raised" : "less-careful-when-lowered";
}

export function specFor(key: string): SettingSpec | undefined {
  if (neverTouched.some((pattern) => pattern.test(key))) return undefined;
  return settingsCatalogue.find((spec) => spec.key === key);
}
