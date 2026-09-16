import { z } from "zod";
import { estimateCost, pricingSettings } from "./pricing.js";
import type { Store } from "./store.js";
import { categoryLabels, toolCategories, type ToolCategory } from "./tool-categories.js";

/**
 * What each person who shares this computer is allowed to have Branch do. A profile already keeps
 * one person's conversations and memory apart from another's; a role says what they may ask for.
 * There are three: the owner, who may do anything; an adult, who may do anything but change how
 * Branch is set up or spend money; and a child, who may look things up and nothing else.
 *
 * Alongside the role, a profile may be held to particular projects and to a daily spending limit.
 * A grant may only narrow what the role allows — nothing here can widen it.
 */
export const householdRoles = ["owner", "adult", "child"] as const;
export type HouseholdRole = (typeof householdRoles)[number];

/** What each role may have Branch do, in the same seven kinds the approval settings use. */
const roleCategories: Record<HouseholdRole, readonly ToolCategory[]> = {
  owner: toolCategories,
  adult: ["read", "files", "commands", "browse", "message"],
  child: ["read"],
};
export const roleLabels: Record<HouseholdRole, { label: string; description: string }> = {
  owner: { label: "Owner", description: "May do anything, including changing how Branch is set up and spending money." },
  adult: { label: "Adult", description: "May read, write files, run commands, use web pages and send messages. May not change how Branch is set up, and may not spend money." },
  child: { label: "Child", description: "May look things up and answer questions. Nothing that changes a file, runs a command, sends a message or spends money." },
};

export const RoleGrantSchema = z.object({
  role: z.enum(householdRoles).default("adult"),
  /** The kinds this person may use. Left out, the role's own list is used; it may only narrow it. */
  categories: z.array(z.enum(toolCategories)).max(toolCategories.length).optional(),
  /** Projects this person may work in. Empty means every project the owner has. */
  projects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(24).default([]),
  /** Most money this person's tasks may cost in a day; 0 means no limit. */
  dailySpendLimit: z.number().min(0).max(1000).default(0),
}).strict();
export type RoleGrant = z.infer<typeof RoleGrantSchema>;

/** The kinds a grant really allows: the role's list, narrowed by the grant's own if it has one. */
export function grantedCategories(grant: RoleGrant): ToolCategory[] {
  const allowed = roleCategories[grant.role];
  return grant.categories ? allowed.filter((kind) => grant.categories!.includes(kind)) : [...allowed];
}

/** Why this person may not have that done, in one plain sentence, or null when they may. */
export function grantRefusal(
  grant: RoleGrant, person: string,
  about: { category: ToolCategory; project: string; spentToday: number },
): string | null {
  if (!grantedCategories(grant).includes(about.category))
    return `${person} is set up as "${roleLabels[grant.role].label}" here, which does not cover ${categoryLabels[about.category].label.toLowerCase()}. The owner can change that in Settings.`;
  if (grant.projects.length && !grant.projects.includes(about.project))
    return `${person} is not set up to work in the project "${about.project}". The owner can add it in Settings.`;
  if (grant.dailySpendLimit > 0 && about.spentToday >= grant.dailySpendLimit)
    return `${person} has used up today's allowance of ${grant.dailySpendLimit.toFixed(2)}. It starts again tomorrow, or the owner can raise it in Settings.`;
  return null;
}

export class ProfileRoles {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private key(profileId: string): string { return `profile-role:${profileId}`; }
  /** One profile's grant; an adult with no limits until the owner says otherwise. */
  get(profileId: string): RoleGrant {
    const saved = RoleGrantSchema.safeParse(this.store.get("settings", this.owner, this.key(profileId))?.data ?? {});
    return saved.success ? saved.data : RoleGrantSchema.parse({});
  }
  save(profileId: string, input: unknown): RoleGrant {
    const next = RoleGrantSchema.parse({ ...this.get(profileId), ...(input as object ?? {}) });
    this.store.save("settings", this.owner, this.key(profileId), { ...next });
    return next;
  }
  /** Every profile's grant, for the profile cards on the People screen. */
  all(profileIds: readonly string[]): { profileId: string; grant: RoleGrant; categories: ToolCategory[] }[] {
    return profileIds.map((profileId) => {
      const grant = this.get(profileId);
      return { profileId, grant, categories: grantedCategories(grant) };
    });
  }

  /**
   * What one profile's tasks have cost today, worked out the same way the meter does: every task
   * filed under that profile whose day is today, priced at the model that answered it.
   */
  spentToday(scope: string, model: string, today = new Date().toISOString().slice(0, 10)): number {
    const { overrides } = pricingSettings(this.store, this.owner);
    let total = 0;
    for (const run of this.store.runs(scope)) {
      if (!run.createdAt.startsWith(today)) continue;
      const usage = this.store.usage(run.id);
      const input = usage.reportedInput || usage.estimatedInput || 0;
      const output = usage.reportedOutput || usage.estimatedOutput || 0;
      total += estimateCost(model, { input, output }, overrides)?.amount ?? 0;
    }
    return total;
  }
}
