import { z } from "zod";
import { audit } from "../audit.js";
import { isReadOnlyPermission } from "../policy.js";
import type { Store } from "../store.js";

/**
 * mac7/chat-allowlist: what a task started by a chat message may use.
 *
 * This used to be a list of things taken away, which meant anything nobody had thought to name was
 * handed over — including the screen and keyboard, running code and stopping programs, and every
 * permission added after the list was written. It is now the other way round: a chat's task gets
 * the short list below and nothing else, so a permission added tomorrow is refused until somebody
 * decides otherwise.
 *
 * The short list is what a conversation needs to read and answer: ask the person a question, read
 * files, read what Branch remembers, and look something up on the web. Searching is not its own
 * permission — searching files is `files.read`, searching memory is `memory.read`, and searching
 * the web is `web.read`. Every one of them only looks: `isReadOnlyPermission` in src/policy.ts
 * holds for all four, and `tests/chat-allowlist.test.mjs` checks that it still does.
 */
export const chatSafePermissions = ["user.ask", "files.read", "memory.read", "web.read"] as const;

/**
 * Things a chat's task never gets, whatever the owner's settings say. Most of them the tools behind
 * them already refuse by where the task came from (`startedFromChat` in src/key-context.ts), so a
 * setting that promised them would be promising something that cannot happen; the rest are the ones
 * a chat must never have at all, because a chat app cannot prove who is typing. Commands on this
 * computer and on another are in the second group: a command can do anything the owner could.
 */
export const neverFromChat: readonly string[] = [
  "personal.read", "personal.write", "home.control", "brief.manage", "agents.manage",
  "skills.write", "skills.manage", "nodes.read", "nodes.run", "trunks.message",
  "shell.execute", "remote.execute", "channels.send",
];
/** Whether the owner may hand this one to a chat at all. The owner's own devices never are. */
export const grantableToChat = (permission: string): boolean =>
  !neverFromChat.includes(permission) && !permission.startsWith("devices.");

/** One line of the owner's list: who it is about, and what those chats may also use. */
export const ChatPermissionRuleSchema = z.object({
  /** The chat app this is about, or "*" for every one of them. */
  channel: z.string().trim().min(1).max(64).default("*"),
  /** The sender's id on that app, or "*" for everybody on it. */
  sender: z.string().trim().min(1).max(120).default("*"),
  /** The permission names those chats may also use, on top of the short list. */
  allow: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** Who this is, in the owner's words, so the list means something a year later. */
  note: z.string().trim().max(200).default(""),
}).strict();
export type ChatPermissionRule = z.infer<typeof ChatPermissionRuleSchema>;

/**
 * The owner's setting. `extras` is off on a fresh install, so a chat's task gets the short list and
 * nothing else until the owner turns it on. `rules` is not in the settings catalogue on purpose
 * (src/settings-kit/catalogue.ts): a whole-app preset or a settings file brought in from somewhere
 * else can turn the switch off, but can never write a line that hands a chat something new.
 */
export const ChatPermissionSettingsSchema = z.object({
  extras: z.boolean().default(false),
  rules: z.array(ChatPermissionRuleSchema).max(50).default([]),
}).strict();
export type ChatPermissionSettings = z.infer<typeof ChatPermissionSettingsSchema>;

const settingsKey = "chat-permissions";

export function readChatPermissionSettings(store: Store, owner: string): ChatPermissionSettings {
  const saved = ChatPermissionSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : ChatPermissionSettingsSchema.parse({});
}

/** Saves the switch, the list, or both; whatever is left out keeps the value it has. */
export function saveChatPermissionSettings(store: Store, owner: string, input: unknown): ChatPermissionSettings {
  const change = z.object({ extras: z.boolean().optional(), rules: z.array(ChatPermissionRuleSchema).max(50).optional() })
    .strict().parse(input ?? {});
  const next = ChatPermissionSettingsSchema.parse({ ...readChatPermissionSettings(store, owner), ...change });
  store.save("settings", owner, settingsKey, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "what a chat message's task may use",
    reason: next.extras
      ? `${next.rules.length} line(s) on top of the ${chatSafePermissions.length} a chat always has`
      : "the short list only",
    outcome: "saved",
  });
  return next;
}

/** Whether a line is about this sender on this app. "*" in either place means "any". */
const covers = (rule: ChatPermissionRule, channel: string, sender: string): boolean =>
  (rule.channel === "*" || rule.channel === channel) && (rule.sender === "*" || rule.sender === sender);

/**
 * What the owner has allowed this chat and this person on top of the short list. Nothing at all
 * while the switch is off, and never one of the names a chat may not have.
 */
export function chatExtraPermissions(settings: ChatPermissionSettings, channel: string, sender: string): string[] {
  if (!settings.extras) return [];
  const named = settings.rules.filter((rule) => covers(rule, channel, sender)).flatMap((rule) => rule.allow);
  return [...new Set(named)].filter(grantableToChat);
}

/**
 * What a task started from a chat may use, out of everything registered: the short list, plus
 * whatever the owner has allowed this chat and this person. A name that is not on either list is
 * refused, including every permission added to Branch after this was written.
 */
export function chatPermissionsOf(all: readonly string[], extra: readonly string[] = []): string[] {
  const allowed = new Set<string>([...chatSafePermissions, ...extra.filter(grantableToChat)]);
  return all.filter((permission) => allowed.has(permission));
}

/** Every permission on the short list only looks at things; asserted here so the list cannot drift. */
export const chatSafeListIsReadOnly = (): boolean => chatSafePermissions.every(isReadOnlyPermission);
