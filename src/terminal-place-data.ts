import type { createBranch } from "./index.js";
import { readPolicy, policyPresets } from "./policy.js";
import { lockdownState } from "./lockdown.js";
import { assistantIdentity } from "./identity.js";
import { trunksFor } from "./trunks/index.js";
import type { Words } from "./terminal-words.js";
import { learnMode } from "./learn/settings.js"; // mac7/learn

/**
 * What each place and tab holds, read from the same stores the window's screens read. Every row is
 * a title and one plain line under it; nothing here changes anything. A row that can be opened
 * carries the conversation it belongs to.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export type PlaceApp = Pick<Branch, "store" | "runtime" | "triggers" | "webhooks" | "hooks" | "documents" | "artifacts"
  | "plugins" | "mcpConnections" | "channels" | "runQueue" | "version">;
export interface Row {
  title: string;
  detail?: string;
  tone?: "warn" | "ok" | "bad" | "muted" | undefined;
  sessionId?: string;
  /** A command the row stands for: pressing Enter on it runs this. */
  command?: string;
}
export type RowReader = (app: PlaceApp, words: Words) => Row[] | Promise<Row[]>;

const clip = (text: unknown, size = 90): string => {
  const flat = String(text ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > size ? flat.slice(0, size - 1) + "…" : flat;
};
const day = (iso: string): string => iso.slice(0, 16).replace("T", " ");
const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * mac7/learn: the map of each knowledge base, as rows rather than a picture. A terminal that tries
 * to draw a graph is worse than a list, so this says how big each map is and where it came from,
 * and Enter on a row runs `/learn`. Nothing here builds anything.
 */
function learnRows(app: PlaceApp): Row[] {
  const mode = learnMode(app.store, app.runtime.owner);
  if (mode === "off") return [];
  const rows = app.store.sqlite.prepare(`SELECT e.collection AS collection, COUNT(DISTINCT e.entity_id) AS things,
    (SELECT COUNT(*) FROM kb_relations r WHERE r.owner=e.owner AND r.collection=e.collection) AS links
    FROM kb_entities e WHERE e.owner=? GROUP BY e.collection ORDER BY things DESC LIMIT 12`)
    .all(app.runtime.owner) as { collection: unknown; things: unknown; links: unknown }[];
  return rows.map((row) => ({
    title: clip(String(row.collection)),
    detail: `${Number(row.things)} things · ${Number(row.links)} links · built from your files, no model`,
    tone: "muted" as const,
    command: `/learn documents ${String(row.collection)}`,
  }));
}
function needsYou(app: PlaceApp, words: Words): Row[] {
  const rows: Row[] = app.runtime.approvals.waiting().map((ask) => ({
    title: clip(ask.label || ask.tool), detail: `${ask.tool}${ask.target ? " · " + clip(ask.target, 60) : ""} · ${day(ask.askedAt)}`,
    tone: "warn" as const, sessionId: ask.sessionId,
  }));
  const seen = new Set(rows.map((row) => row.sessionId));
  const latest = new Set<string>();
  for (const run of app.store.runs(app.runtime.owner)) {
    if (latest.has(run.sessionId)) continue;
    latest.add(run.sessionId);
    if (run.status === "needs_input" && !seen.has(run.sessionId))
      rows.push({ title: clip(run.output || run.prompt), detail: day(run.updatedAt), tone: "warn", sessionId: run.sessionId });
  }
  for (const proposal of app.store.review.proposals(app.runtime.owner, "pending"))
    rows.push({ title: words.t("terminal.row.memorySuggestion", "A suggested change to what it remembers"),
      detail: clip((proposal as { data?: { text?: unknown } }).data?.text ?? ""), tone: "warn" });
  return rows;
}
function taskRows(app: PlaceApp, since: number): Row[] {
  return app.store.runs(app.runtime.owner)
    .filter((run) => Date.parse(run.updatedAt) >= since && run.status !== "running")
    .slice(0, 200)
    .map((run) => ({
      title: clip(run.prompt), detail: `${run.status.replace(/_/g, " ")} · ${day(run.updatedAt)}`,
      tone: run.status === "completed" ? "ok" as const : run.status === "failed" ? "bad" as const : "muted" as const,
      sessionId: run.sessionId,
    }));
}
function overviewRows(app: PlaceApp, words: Words): Row[] {
  const trunkChats = new Set((trunksFor(app.runtime)?.records.list() ?? []).map((trunk) => trunk.chatSessionId));
  const runs = app.store.runs(app.runtime.owner).filter((run) => !trunkChats.has(run.sessionId)).slice(0, 12);
  if (!runs.length) return [{ title: words.t("ov.calm", "Nothing waiting"),
    detail: words.t("ov.now.none", "Nothing is running right now."), tone: "ok" }];
  return runs.map((run) => ({ title: clip(run.prompt), detail: `${run.status.replace(/_/g, " ")} · ${day(run.updatedAt)}`,
    tone: run.status === "running" ? "ok" : run.status === "failed" ? "bad" : run.status === "needs_input" ? "warn" : "muted",
    sessionId: run.sessionId }));
}
function peopleRows(app: PlaceApp, words: Words): Row[] {
  const profiles = app.store.profiles.list();
  return [{ title: words.t("household.owner", "The owner"), detail: words.t("household.role.owner", "Owner"), tone: "ok" },
    ...profiles.map((profile) => {
      const grant = app.runtime.roles.get(profile.id);
      const role = words.t(`household.role.${grant.role}`, grant.role === "child" ? "Child" : "Adult");
      const used = profile.lastUsedAt ? day(profile.lastUsedAt) : words.t("household.never", "Has not used Branch yet");
      return { title: profile.name, detail: `${role} · ${used}` };
    })];
}
const recordRows = (app: PlaceApp, table: "schedules" | "procedures" | "specialists", name: string[]): Row[] =>
  app.store.list(table, app.runtime.owner).map((record) => {
    const data = record.data as Record<string, unknown>;
    const title = name.map((key) => data[key]).find((value) => typeof value === "string" && value) ?? record.id;
    return { title: clip(title), detail: clip([data.status, data.dueAt, data.description].filter(Boolean).join(" · ")) || record.id };
  });

function triggers(app: PlaceApp, words: Words): Row[] {
  const on = (enabled: boolean): string => enabled ? words.t("terminal.state.on", "on") : words.t("terminal.state.off", "off");
  return [
    ...app.triggers.list(app.runtime.owner).map((entry) => ({ title: clip(entry.name), detail: `${words.t("terminal.row.incoming", "Incoming")} · ${on(entry.enabled)}` })),
    ...app.webhooks.list(app.runtime.owner).map((entry) => ({ title: clip(entry.name), detail: `${words.t("terminal.row.outgoing", "Outgoing")} · ${entry.events.join(", ")} · ${on(entry.enabled)}` })),
    ...app.hooks.list().map((entry) => ({ title: entry.id, detail: `${words.t("terminal.row.hook", "Hook")} · ${entry.event} · ${on(entry.enabled)}` })),
  ];
}
async function made(app: PlaceApp): Promise<Row[]> {
  const kept = await app.artifacts.list(100);
  return kept.map((entry) => ({ title: clip((entry as { title?: string }).title ?? entry.path), detail: clip(entry.path) }));
}
async function plugins(app: PlaceApp, words: Words): Promise<Row[]> {
  const list = await app.plugins.list();
  return list.map((entry) => {
    const plugin = entry as unknown as { id?: string; name?: string; enabled?: boolean; description?: string };
    const state = plugin.enabled === false ? words.t("terminal.state.off", "off") : words.t("terminal.state.on", "on");
    return { title: clip(plugin.name ?? plugin.id), detail: clip(`${state}${plugin.description ? " · " + plugin.description : ""}`) };
  });
}
function channels(app: PlaceApp, words: Words): Row[] {
  const summary = app.channels.summary();
  return [...summary.channels.map((channel) => ({
    title: `${channel.id}`, detail: `${channel.kind} · ${String((channel.health as { state?: string }).state ?? "")}`,
    tone: (channel.health as { state?: string }).state === "connected" ? "ok" as const : "warn" as const,
  })), channelSetupRow(words)]; // mac7/connect
}
/** mac7/connect: the one command that sets up a chat app, shown where the chat apps are. */
function channelSetupRow(words: Words): Row {
  return { title: words.t("terminal.row.channel-setup", "Set up a chat app"),
    detail: words.t("terminal.row.channel-setup-detail", "leave this view and run: branch connect <app> (telegram, discord, slack…)"), tone: "muted" };
}

/** Every tab's rows, by its home. */
export const PLACE_ROWS: Record<string, RowReader> = {
  "overview:here": overviewRows,
  "household:people": peopleRows,
  "inbox:needs": needsYou,
  "inbox:finished": (app) => taskRows(app, Date.now() - WEEK),
  "inbox:history": (app) => taskRows(app, 0),
  "automations:scheduled": (app, words) => [
    ...recordRows(app, "schedules", ["name", "prompt"]),
    ...app.runQueue.list(app.runtime.owner).map((entry) => ({
      title: clip((entry as { prompt?: string }).prompt ?? entry.id), detail: words.t("terminal.row.waiting", "waiting its turn"),
    })),
  ],
  "automations:procedures": (app) => recordRows(app, "procedures", ["name", "title"]),
  "automations:triggers": triggers,
  "library:memory": (app) => app.store.list("memory", app.store.profiles.scope()).map((fact) => ({
    title: clip(fact.data.text), detail: clip(fact.data.source),
  })),
  "library:documents": (app) => [
    ...learnRows(app),
    ...app.documents.list(app.runtime.owner).map((entry) => ({
      title: clip(entry.name), detail: `${entry.fileType} · ${entry.status.replace(/_/g, " ")} · ${day(entry.updatedAt)}`,
      tone: entry.status === "failed" ? "bad" as const : undefined,
    })),
  ],
  "library:made": made,
  "customize:skills": (app, words) => app.store.skills.list(app.runtime.owner).map((skill) => ({
    title: skill.name, detail: clip(`${skill.activeVersion ? "" : words.t("terminal.state.off", "off") + " · "}${skill.description}`),
    tone: skill.activeVersion ? undefined : "muted" as const,
  })),
  "customize:specialists": (app) => recordRows(app, "specialists", ["name"]),
  "customize:plugins": plugins,
  "customize:connections": (app) => app.mcpConnections.health().map((server) => ({
    title: server.id, detail: `${server.state}${server.lastError ? " · " + clip(server.lastError, 60) : ""}`,
    tone: server.lastError ? "bad" as const : undefined,
  })),
  "customize:channels": channels,
};

/** How many things wait for the owner's yes, for the Inbox count on the tab row. */
export function needsCount(app: PlaceApp): number {
  const sessions = new Set(app.runtime.approvals.waiting().map((ask) => ask.sessionId));
  const latest = new Set<string>();
  for (const run of app.store.runs(app.runtime.owner)) {
    if (latest.has(run.sessionId)) continue;
    latest.add(run.sessionId);
    if (run.status === "needs_input") sessions.add(run.sessionId);
  }
  return sessions.size;
}
export const lockdownOn = (app: PlaceApp): boolean => lockdownState(app.store, app.runtime.owner).on;
export const assistantName = (app: PlaceApp): string =>
  clip(assistantIdentity(app.store, app.runtime.owner).name || "Branch", 24);
export function permissionRows(app: PlaceApp): Row[] {
  const current = readPolicy(app.store, app.runtime.owner).preset;
  return policyPresets().map((preset) => ({
    title: `${preset.id === current ? "● " : ""}${preset.label}`, detail: clip(preset.description, 120),
    tone: preset.id === current ? "ok" as const : undefined, command: `/preset ${preset.id}`,
  }));
}
