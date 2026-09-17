import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";

/**
 * Several accounts per connection (GAPS row 40, the owner's request of 2026-09-17).
 *
 * What is written down here is only the list: labels, order, which one is pinned, caps, and how
 * the next one is chosen. A key or a sign-in never lives in this record: API keys and ChatGPT
 * tokens are in the locker, one locker project per connection or per account, and the installed
 * programs (claude, codex, gemini, copilot) keep their own sign-in in their own folder, which
 * Branch never opens. Backups copy this record and nothing else.
 *
 * The whole feature follows the owner's three-way switch and ships off. Off means one account per
 * connection, exactly as before.
 */
export const accountKinds = ["api-key", "chatgpt", "cli"] as const;
export type AccountKind = (typeof accountKinds)[number];
export const strategies = ["priority", "round-robin", "least-used"] as const;
export type Strategy = (typeof strategies)[number];

/** The account every connection already has: its first key, the old sign-in, the program's own folder. */
export const primaryAccount = "primary";
export const maxAccounts = 50;
const accountId = z.string().regex(/^(primary|[a-f0-9]{8})$/);
const poolId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);

export const AccountSchema = z.object({
  id: accountId,
  label: z.string().trim().min(1).max(60),
  pinned: z.boolean().default(false),
  disabled: z.boolean().default(false),
  /** US dollars per calendar month; null means no cap. Only API keys are charged. */
  monthlyCapUsd: z.number().min(0).max(100_000).nullable().default(null),
  /** Whether people sharing this computer may use it. Only an API key can be shared. */
  shared: z.boolean().default(false),
  createdAt: z.string().max(40),
}).strict();
export type Account = z.infer<typeof AccountSchema>;

export const PoolSchema = z.object({
  pool: poolId,
  kind: z.enum(accountKinds),
  strategy: z.enum(strategies).default("priority"),
  /**
   * Sign-in accounts only: let Branch share work between accounts and move on when one reaches its
   * plan limit. Off unless the owner turns it on after reading the terms line (docs/configuration.md).
   */
  autoSwitch: z.boolean().default(false),
  /** The account new work uses, when no conversation picked one. Null means the first in the list. */
  defaultAccount: accountId.nullable().default(null),
  accounts: z.array(AccountSchema).max(maxAccounts).default([]),
}).strict();
export type Pool = z.infer<typeof PoolSchema>;

export const AccountsSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  pools: z.array(PoolSchema).max(64).default([]),
}).strict();
export type AccountsSettings = z.infer<typeof AccountsSettingsSchema>;

const settingKey = "accounts";
type Reader = Pick<Store, "get">;

export function accountsSettings(store: Reader, owner: string): AccountsSettings {
  const saved = AccountsSettingsSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return saved.success ? saved.data : AccountsSettingsSchema.parse({});
}
export function saveAccountsSettings(store: Store, owner: string, value: AccountsSettings): AccountsSettings {
  const parsed = AccountsSettingsSchema.parse(value);
  store.save("settings", owner, settingKey, parsed);
  return parsed;
}
export const accountsMode = (store: Reader, owner: string): FeatureMode => accountsSettings(store, owner).mode;

/** The pool, created with its first account when it is asked for the first time. */
export function poolOf(settings: AccountsSettings, pool: string, kind: AccountKind, now = new Date()): Pool {
  const found = settings.pools.find((entry) => entry.pool === pool);
  if (found) return found;
  const created = PoolSchema.parse({
    pool, kind,
    accounts: [{ id: primaryAccount, label: primaryLabel(kind), shared: kind === "api-key", createdAt: now.toISOString() }],
  });
  settings.pools.push(created);
  return created;
}
export function primaryLabel(kind: AccountKind): string {
  return kind === "api-key" ? "First key" : kind === "chatgpt" ? "First sign-in" : "Your usual sign-in";
}
export const newAccountId = (): string => randomBytes(4).toString("hex");

/** Where one pool's extra API keys are kept: a locker project of its own (the locker holds 64 per project). */
export function keyProject(pool: string): string {
  return `acct-${createHash("sha256").update(pool).digest("hex").slice(0, 12)}`;
}
export const keyName = (account: string): string => `KEY_${account.toUpperCase()}`;
/** Each ChatGPT account's tokens sit in a locker project of their own. */
export const tokenProject = (account: string): string => `acct-chatgpt-${account}`;

/* ---------- the account a conversation chose ---------- */

const SessionChoiceSchema = z.record(poolId, accountId);
const sessionKey = (sessionId: string): string => `account-session:${sessionId}`;
export function sessionChoice(store: Reader, owner: string, sessionId: string): Record<string, string> {
  if (!sessionId) return {};
  const saved = SessionChoiceSchema.safeParse(store.get("settings", owner, sessionKey(sessionId))?.data ?? {});
  return saved.success ? saved.data : {};
}
export function saveSessionChoice(store: Store, owner: string, sessionId: string, pool: string, account: string | null): void {
  const choice = { ...sessionChoice(store, owner, sessionId) };
  if (account) choice[pool] = account; else delete choice[pool];
  store.save("settings", owner, sessionKey(sessionId), SessionChoiceSchema.parse(choice));
}
