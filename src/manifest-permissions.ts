import { z } from "zod";

/**
 * Batch 26 (wave 8): what an add-on's own manifest asks to be allowed to do, and what actually
 * holds it to that afterwards.
 *
 * Wave 4 built the first half: a skill package and a plugin both declare the permissions they need,
 * and the owner is shown that list before anything is switched on. What was missing was the second
 * half — the list did nothing. A tool could ask for a permission the owner never granted and still
 * join the catalog, and a declared web call could be sent to an address that was nowhere in the
 * manifest the owner read.
 *
 * This is that second half, and it is deliberately small: the grant is what the owner said yes to,
 * the tool set is narrowed to it, and an address outside the manifest is refused. Narrowing is the
 * enforcement — a tool that is not in the catalog cannot be called by anything, model or person.
 */
export const ManifestGrantSchema = z.object({
  /** The permissions the owner said yes to. A tool asking for anything else is left out. */
  permissions: z.array(z.string().trim().max(64)).max(32).default([]),
  /** The web addresses the manifest named. A call anywhere else is refused at the moment it is made. */
  hosts: z.array(z.string().trim().max(200)).max(32).default([]),
}).strict();
export type ManifestGrant = z.infer<typeof ManifestGrantSchema>;

/** What a manifest asks for, in the words the owner is shown before they say yes. */
export interface ManifestRequest {
  permissions: { permission: string; why: string }[];
  hosts: string[];
}

/** The grant an owner gives by approving a manifest exactly as it stands. */
export function grantAll(request: ManifestRequest): ManifestGrant {
  return ManifestGrantSchema.parse({
    permissions: [...new Set(request.permissions.map((entry) => entry.permission))],
    hosts: [...new Set(request.hosts)],
  });
}

/**
 * The tools that survive the owner's grant. A tool that asks for a permission the owner did not
 * grant is not registered at all, which is the whole enforcement: an unregistered tool cannot be
 * called, cannot be suggested, and does not appear in the catalog.
 */
export function narrowTools<T extends { permission: string }>(
  tools: readonly T[], grant: ManifestGrant,
): { kept: T[]; left: T[] } {
  const allowed = new Set(grant.permissions);
  return {
    kept: tools.filter((tool) => allowed.has(tool.permission)),
    left: tools.filter((tool) => !allowed.has(tool.permission)),
  };
}

/** The plain sentence for a tool that was left out, so the owner is never left guessing. */
export const narrowedSentence = (name: string, permission: string): string =>
  `"${name}" was left out because you did not allow "${permission}". Switch it off and install it again to change that.`;

/**
 * Refuses an address the manifest never named. It is checked at the moment of the call, not only
 * when the package is read, because a declared address can carry a value from the request in it.
 */
export function assertDeclaredHost(grant: ManifestGrant, target: URL, what: string): void {
  if (!grant.hosts.length) return;
  const host = target.hostname.toLowerCase();
  if (!grant.hosts.some((declared) => declared.toLowerCase() === host))
    throw new Error(`${what} tried to reach ${host}, which is not one of the addresses you were shown when you installed it. It was stopped.`);
}
