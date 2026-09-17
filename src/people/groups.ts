import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit.js";
import { toolCategories } from "../tool-categories.js";
import type { RoleGrant } from "../profile-roles.js";
import type { Store } from "../store.js";
import { lentOwner } from "./lending.js";

/**
 * Bucket 19: groups of people, and what the owner has shared with whom.
 *
 * A group ("the children", "guests") has members and limits. Being in a group can only take things
 * away: a person's tasks are held to their own grant and to every group they are in, whichever is
 * tighter (src/profile-roles.ts `effective`, which also refuses any widening).
 *
 * Sharing is written as relation tuples, the shape OpenFGA and Zanzibar-style services use —
 * `conversation:<id>` `viewer` or `driver` `profile:<id>` or `group:<id>#member` — so a list can be
 * exported to such a service or brought back from one. A driver may also send messages; a viewer
 * may only read. Only the owner writes tuples, and only about the owner's own conversations.
 */
const id = z.string().uuid();
export const GroupSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(40),
  members: z.array(id).max(8).default([]),
  /** The kinds a member may use at most; left out, the group does not narrow kinds. */
  categories: z.array(z.enum(toolCategories)).max(toolCategories.length).optional(),
  /** Projects a member may work in at most; empty means the group does not narrow projects. */
  projects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(24).default([]),
  /** Most a member may spend in a day; 0 means the group adds no limit. */
  dailySpendLimit: z.number().min(0).max(1000).default(0),
}).strict();
export type Group = z.infer<typeof GroupSchema> & { id: string };

export const shareRelations = ["viewer", "driver"] as const;
export type ShareRelation = (typeof shareRelations)[number];
export const TupleSchema = z.object({
  object: z.string().regex(/^conversation:[a-f0-9-]{36}$/),
  relation: z.enum(shareRelations),
  subject: z.string().regex(/^(profile:[a-f0-9-]{36}|group:[a-f0-9-]{36}#member)$/),
}).strict();
export type ShareTuple = z.infer<typeof TupleSchema>;
/** OpenFGA's own field names, for export and import. */
export const FgaTupleSchema = z.object({ user: z.string(), relation: z.enum(shareRelations), object: z.string() }).strict();

const groupsKey = "people-groups", tuplesKey = "people-shares";
/** The smaller of two daily limits, where 0 means "no limit". */
const tighterLimit = (a: number, b: number): number => (a > 0 && b > 0 ? Math.min(a, b) : a || b);

export class PeopleGroups {
  constructor(private readonly store: Store, private readonly owner: string) {}

  list(): Group[] {
    const saved = z.object({ groups: z.array(GroupSchema.required({ id: true })).max(20) })
      .safeParse(this.store.get("settings", this.owner, groupsKey)?.data ?? {});
    return saved.success ? saved.data.groups as Group[] : [];
  }
  save(input: unknown, known: readonly string[]): Group {
    const value = GroupSchema.parse(input);
    const unknown = value.members.filter((member) => !known.includes(member));
    if (unknown.length) throw new Error("A member of that group is not somebody on this computer");
    const group: Group = { ...value, id: value.id ?? randomUUID() };
    const others = this.list().filter((each) => each.id !== group.id);
    if (!value.id && others.length >= 20) throw new Error("At most 20 groups");
    if (value.id && others.length === this.list().length) throw new Error("No group with that id");
    this.store.save("settings", this.owner, groupsKey, { groups: [...others, group] });
    this.note(`group ${group.name}`, `${group.members.length} member(s)`);
    return group;
  }
  remove(groupId: string): boolean {
    const kept = this.list().filter((each) => each.id !== groupId);
    if (kept.length === this.list().length) return false;
    this.store.save("settings", this.owner, groupsKey, { groups: kept });
    this.writeTuples(this.tuples().filter((tuple) => tuple.subject !== `group:${groupId}#member`));
    this.note(`group ${groupId}`, "removed");
    return true;
  }
  groupsOf(profileId: string): Group[] {
    return this.list().filter((group) => group.members.includes(profileId));
  }
  /** Forgets a person everywhere: in every group and in every share. */
  forgetProfile(profileId: string): void {
    const groups = this.list().map((group) => ({ ...group, members: group.members.filter((m) => m !== profileId) }));
    this.store.save("settings", this.owner, groupsKey, { groups });
    this.writeTuples(this.tuples().filter((tuple) => tuple.subject !== `profile:${profileId}`));
  }

  /** The narrower ProfileRoles applies: the grant, held to every group the person is in. */
  narrow = (profileId: string, grant: RoleGrant): RoleGrant => this.groupsOf(profileId).reduce((current, group) => {
    const projects = !group.projects.length ? current.projects
      : current.projects.length ? current.projects.filter((p) => group.projects.includes(p)) : group.projects;
    // No project left in common means no project at all, which an empty list cannot say: allow no kind.
    const none = group.projects.length > 0 && projects.length === 0;
    const kinds = group.categories
      ? (current.categories ?? toolCategories).filter((kind) => group.categories!.includes(kind))
      : current.categories;
    return {
      ...current, projects: none ? current.projects : projects,
      ...(none ? { categories: [] } : kinds ? { categories: kinds } : {}),
      dailySpendLimit: tighterLimit(current.dailySpendLimit, group.dailySpendLimit),
    };
  }, grant);

  /* ---------- sharing ---------- */

  tuples(): ShareTuple[] {
    const saved = z.object({ tuples: z.array(TupleSchema).max(1000) }).safeParse(this.store.get("settings", this.owner, tuplesKey)?.data ?? {});
    return saved.success ? saved.data.tuples : [];
  }
  private writeTuples(tuples: ShareTuple[]): void {
    this.store.save("settings", this.owner, tuplesKey, { tuples });
  }
  /** Adds one share. The conversation must be the owner's own; the person or group must exist. */
  share(input: unknown, known: { profiles: readonly string[] }): ShareTuple {
    const tuple = TupleSchema.parse(input);
    const sessionId = tuple.object.slice("conversation:".length);
    // Integration review: a person's own conversation, lent while their task runs, is not the owner's to share.
    if (!this.store.ownsSession(this.owner, sessionId) || lentOwner(this.store, sessionId)) throw new Error("Only your own conversations can be shared");
    const [kind, rest] = tuple.subject.split(":") as [string, string];
    const subjectId = rest.replace(/#member$/, "");
    if (kind === "profile" ? !known.profiles.includes(subjectId) : !this.list().some((group) => group.id === subjectId))
      throw new Error("Nobody by that name is on this computer");
    const others = this.tuples().filter((t) => !(t.object === tuple.object && t.subject === tuple.subject));
    if (others.length >= 1000) throw new Error("At most 1000 shares");
    this.writeTuples([...others, tuple]);
    this.note(`${tuple.object} ${tuple.relation} ${tuple.subject}`, "shared");
    return tuple;
  }
  unshare(input: unknown): boolean {
    const tuple = TupleSchema.parse(input);
    const kept = this.tuples().filter((t) => !(t.object === tuple.object && t.subject === tuple.subject));
    if (kept.length === this.tuples().length) return false;
    this.writeTuples(kept);
    this.note(`${tuple.object} ${tuple.subject}`, "unshared");
    return true;
  }
  /** Whether a person has this relation to a conversation; a driver is also a viewer. */
  check(profileId: string, relation: ShareRelation, sessionId: string): boolean {
    const subjects = [`profile:${profileId}`, ...this.groupsOf(profileId).map((group) => `group:${group.id}#member`)];
    const enough: ShareRelation[] = relation === "viewer" ? ["viewer", "driver"] : ["driver"];
    return this.tuples().some((t) => t.object === `conversation:${sessionId}` && subjects.includes(t.subject) && enough.includes(t.relation));
  }
  /** The conversations shared with one person, with the strongest relation they have to each. */
  sharedWith(profileId: string): { sessionId: string; relation: ShareRelation }[] {
    const found = new Map<string, ShareRelation>();
    for (const t of this.tuples()) {
      const sessionId = t.object.slice("conversation:".length);
      if (!this.check(profileId, "viewer", sessionId)) continue;
      found.set(sessionId, this.check(profileId, "driver", sessionId) ? "driver" : "viewer");
    }
    return [...found].map(([sessionId, relation]) => ({ sessionId, relation }));
  }
  exportFga(): z.infer<typeof FgaTupleSchema>[] {
    return this.tuples().map((t) => ({ user: t.subject, relation: t.relation, object: t.object }));
  }
  importFga(input: unknown, known: { profiles: readonly string[] }): number {
    const rows = z.array(FgaTupleSchema).max(1000).parse(input);
    for (const row of rows) this.share({ object: row.object, relation: row.relation, subject: row.user }, known);
    return rows.length;
  }

  private note(subject: string, outcome: string): void {
    audit(this.store, this.owner, {
      action: "policy.changed", actor: this.owner, subject: subject.slice(0, 300),
      reason: "Who may see or join a conversation, or what a group of people may do", outcome,
    });
  }
}
