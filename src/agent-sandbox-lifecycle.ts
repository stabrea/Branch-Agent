import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, cp, rm, rename, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import { wallNetworks, type WallNetwork } from "./sandbox.js";
import { audit } from "./audit.js";

/**
 * FQ-operations.sandbox-lifecycle: create, snapshot, stop and restore a configured agent sandbox.
 *
 * A sandbox is a real folder on this computer (never inside the owner's own workspace) plus a
 * declared network reach and a declared list of the model services it may call. Nothing runs inside
 * a sandbox yet, so nothing enforces those two today: they are recorded for when a sandbox runs.
 * They are settled the moment the sandbox is created and never move afterwards — not when it is stopped,
 * not when it is restored. Snapshotting copies the sandbox's files and writes the policy that was
 * declared for it alongside them; restoring refuses if what is on disk no longer says what the
 * sandbox itself says, so a snapshot that was tampered with cannot quietly loosen what a restored
 * sandbox may reach.
 *
 * Kept deliberately small: no real container or VM is started (see tests/sandbox-remote.test.mjs
 * for why a fake is the only honest way to test one of those anyway). This is the local adapter —
 * a folder Branch owns fully — with the lifecycle a heavier backend would still need to offer.
 */

const NameSchema = z.string().trim().min(1).max(80);
const ProviderIdSchema = z.string().trim().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/, "A model service id is lowercase, letters, digits and dashes");
export const NetworkPolicySchema = z.enum(wallNetworks);
export const InferencePolicySchema = z.object({
  /** Every model service this sandbox is declared to call. Recorded only: nothing runs inside a sandbox yet. */
  providers: z.array(ProviderIdSchema).min(1).max(16),
}).strict();
export type InferencePolicy = z.infer<typeof InferencePolicySchema>;

const CreateSchema = z.object({
  name: NameSchema,
  network: NetworkPolicySchema,
  inference: InferencePolicySchema,
}).strict();
const IdSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict();
const SnapshotSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120).optional(),
}).strict();
const RestoreSchema = z.object({
  id: z.string().trim().min(1).max(64),
  snapshotId: z.string().trim().min(1).max(64),
}).strict();

export interface AgentSandboxSnapshot {
  id: string;
  label: string;
  createdAt: string;
}
export interface AgentSandboxRecord {
  id: string;
  name: string;
  status: "running" | "stopped";
  network: WallNetwork;
  inference: InferencePolicy;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  snapshots: AgentSandboxSnapshot[];
}

export class AgentSandboxLifecycleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const SETTINGS_ID = "agent-sandboxes";
interface StateShape { sandboxes: AgentSandboxRecord[] }
const StateSchema = z.object({ sandboxes: z.array(z.any()).default([]) }).catchall(z.unknown());

function readState(store: Store, owner: string): StateShape {
  const saved = store.get("settings", owner, SETTINGS_ID)?.data;
  const parsed = StateSchema.safeParse(saved ?? {});
  return { sandboxes: parsed.success ? (parsed.data.sandboxes as AgentSandboxRecord[]) : [] };
}
function writeState(store: Store, owner: string, state: StateShape): void {
  store.save("settings", owner, SETTINGS_ID, { sandboxes: state.sandboxes as unknown as Record<string, unknown>[] });
}

/** Where every sandbox's files live: a folder of Branch's own, never the owner's workspace. */
export function agentSandboxesRoot(store: Store): string {
  return join(store.folder, "agent-sandboxes");
}
/**
 * A sandbox's folder, rebuilt from its id under agentSandboxesRoot — never taken from a saved path.
 * An id (or snapshot id) that is not one plain folder name directly inside that root is refused, so
 * an edited record cannot point a copy or a delete at anything outside Branch's own folder.
 */
function oneFolderUnder(parent: string, name: string): string {
  const root = resolve(parent);
  const dir = resolve(root, name);
  const rel = relative(root, dir);
  if (!rel || isAbsolute(rel) || rel.startsWith("..") || /[\\/]/.test(rel) || rel !== name)
    throw new AgentSandboxLifecycleError(409, "That sandbox's saved record does not name a folder inside Branch's own sandbox folder; nothing was changed");
  return dir;
}
function sandboxDir(store: Store, id: string): string { return oneFolderUnder(agentSandboxesRoot(store), id); }
function workspaceDir(store: Store, id: string): string { return join(sandboxDir(store, id), "workspace"); }
function asideDir(store: Store, id: string): string { return join(sandboxDir(store, id), "workspace.previous"); }
function snapshotDir(store: Store, id: string, snapshotId: string): string {
  return oneFolderUnder(join(sandboxDir(store, id), "snapshots"), snapshotId);
}
function manifestPath(store: Store, id: string, snapshotId: string): string {
  return join(snapshotDir(store, id, snapshotId), "manifest.json");
}

function findOrThrow(state: StateShape, id: string): AgentSandboxRecord {
  const found = state.sandboxes.find((s) => s.id === id);
  if (!found) throw new AgentSandboxLifecycleError(404, "No agent sandbox with that id");
  return found;
}

export function listAgentSandboxes(store: Store, owner: string): AgentSandboxRecord[] {
  return readState(store, owner).sandboxes;
}

export async function createAgentSandbox(store: Store, owner: string, input: unknown): Promise<AgentSandboxRecord> {
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) throw new AgentSandboxLifecycleError(400, parsed.error.issues[0]?.message ?? "That sandbox could not be understood");
  const id = randomUUID();
  const now = new Date().toISOString();
  const record: AgentSandboxRecord = {
    id, name: parsed.data.name, status: "running",
    network: parsed.data.network, inference: parsed.data.inference,
    workspace: workspaceDir(store, id), createdAt: now, updatedAt: now, snapshots: [],
  };
  await mkdir(record.workspace, { recursive: true });
  const state = readState(store, owner);
  state.sandboxes.unshift(record);
  writeState(store, owner, state);
  audit(store, owner, {
    action: "policy.changed", actor: owner,
    subject: `Agent sandbox "${record.name}" created`.slice(0, 300),
    reason: `Network ${record.network}; model services: ${record.inference.providers.join(", ")}.`,
    outcome: "saved",
  });
  return record;
}

export async function stopAgentSandbox(store: Store, owner: string, input: unknown): Promise<AgentSandboxRecord> {
  const { id } = IdSchema.parse(input);
  const state = readState(store, owner);
  const record = findOrThrow(state, id);
  if (record.status === "stopped") throw new AgentSandboxLifecycleError(409, "That sandbox is already stopped");
  record.status = "stopped";
  record.updatedAt = new Date().toISOString();
  writeState(store, owner, state);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: `Agent sandbox "${record.name}" stopped`.slice(0, 300),
    reason: `Network ${record.network} and its model services stay declared while it is stopped.`, outcome: "saved",
  });
  return record;
}

/** Copies the sandbox's files as they are now, plus the policy it was created with, under a new snapshot id. */
export async function snapshotAgentSandbox(store: Store, owner: string, input: unknown): Promise<AgentSandboxRecord> {
  const { id, label } = SnapshotSchema.parse(input);
  const state = readState(store, owner);
  const record = findOrThrow(state, id);
  const workspace = workspaceDir(store, record.id);
  await recoverWorkspace(store, record.id);
  const snapshotId = randomUUID();
  const dir = snapshotDir(store, id, snapshotId);
  await mkdir(dir, { recursive: true });
  if (existsSync(workspace)) await cp(workspace, join(dir, "files"), { recursive: true });
  else await mkdir(join(dir, "files"), { recursive: true });
  const createdAt = new Date().toISOString();
  // The declared policy travels with the snapshot, so a restore can check the sandbox still says
  // what the snapshot remembers it saying, instead of trusting the sandbox record alone.
  await writeFile(manifestPath(store, id, snapshotId), JSON.stringify({
    network: record.network, inference: record.inference, label: label ?? "", createdAt,
  }, null, 2), "utf8");
  record.snapshots.unshift({ id: snapshotId, label: label ?? "", createdAt });
  record.updatedAt = createdAt;
  writeState(store, owner, state);
  return record;
}

/**
 * Restores a sandbox's files from one of its snapshots. Refuses if the network or model-service
 * policy written into that snapshot no longer matches what the sandbox itself declares — the one
 * check that makes "preserving its declared policies" something restoring can actually fail.
 */
export async function restoreAgentSandbox(store: Store, owner: string, input: unknown): Promise<AgentSandboxRecord> {
  const { id, snapshotId } = RestoreSchema.parse(input);
  const state = readState(store, owner);
  const record = findOrThrow(state, id);
  const found = record.snapshots.find((s) => s.id === snapshotId);
  if (!found) throw new AgentSandboxLifecycleError(404, "No snapshot with that id on this sandbox");
  const manifestRaw = await readFile(manifestPath(store, id, snapshotId), "utf8").catch(() => null);
  if (!manifestRaw) throw new AgentSandboxLifecycleError(410, "That snapshot's files are no longer on disk");
  const manifest = JSON.parse(manifestRaw) as { network: WallNetwork; inference: InferencePolicy };
  const sameProviders = manifest.inference?.providers?.length === record.inference.providers.length
    && manifest.inference.providers.every((p, i) => p === record.inference.providers[i]);
  if (manifest.network !== record.network || !sameProviders)
    throw new AgentSandboxLifecycleError(409, "This snapshot's declared network or model services no longer match the sandbox; restoring was refused rather than quietly change what it is declared to reach");

  const workspace = workspaceDir(store, record.id);
  const filesDir = join(snapshotDir(store, id, snapshotId), "files");
  await recoverWorkspace(store, record.id);
  const tempDir = join(sandboxDir(store, record.id), `workspace.restoring-${randomUUID()}`);
  try {
    await mkdir(tempDir, { recursive: true });
    if (existsSync(filesDir)) await cp(filesDir, tempDir, { recursive: true });
    await swapInDirectory(tempDir, workspace, asideDir(store, record.id));
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  // Restoring brings the files back; it does not start a stopped sandbox.
  record.workspace = workspace;
  record.updatedAt = new Date().toISOString();
  writeState(store, owner, state);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: `Agent sandbox "${record.name}" restored`.slice(0, 300),
    reason: `Restored to snapshot "${found.label || found.id}" and left ${record.status}; network ${record.network} and its model services were carried over unchanged.`,
    outcome: "saved",
  });
  return record;
}

interface SwapOps {
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
}

/**
 * Puts a fully copied folder in place of `target` without a moment where the old files are already
 * gone and the new ones not yet there: the old folder is moved aside first, the new one is renamed
 * in, and only then is the old one deleted. If renaming the new one in fails, the old one goes back.
 */
export async function swapInDirectory(fresh: string, target: string, aside: string, ops: SwapOps = { rename, rm }): Promise<void> {
  await ops.rm(aside, { recursive: true, force: true });
  const hadTarget = existsSync(target);
  if (hadTarget) await ops.rename(target, aside);
  try {
    await ops.rename(fresh, target);
  } catch (error) {
    if (hadTarget) await ops.rename(aside, target);
    throw error;
  }
  await ops.rm(aside, { recursive: true, force: true });
}

/** After a crash between the two renames above, the old files are still aside: put them back. */
async function recoverWorkspace(store: Store, id: string): Promise<void> {
  const workspace = workspaceDir(store, id), aside = asideDir(store, id);
  if (!existsSync(workspace) && existsSync(aside)) await rename(aside, workspace);
}

// ------------------------------------------------------------------------------- the HTTP door

export function handlesAgentSandboxLifecyclePath(path: string): boolean {
  return path === "/api/agent-sandboxes" || /^\/api\/agent-sandboxes\/(stop|snapshot|restore)$/.test(path);
}

export async function agentSandboxLifecycleApi(
  store: Store, owner: string, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<unknown>,
): Promise<unknown> {
  const get = request.method === "GET", post = request.method === "POST";
  try {
    if (path === "/api/agent-sandboxes") {
      if (post) return { sandbox: await createAgentSandbox(store, owner, await readBody(request)) };
      if (get) return { sandboxes: listAgentSandboxes(store, owner) };
      throw new AgentSandboxLifecycleError(405, "Only reading and creating are possible here.");
    }
    if (post && path === "/api/agent-sandboxes/stop") return { sandbox: await stopAgentSandbox(store, owner, await readBody(request)) };
    if (post && path === "/api/agent-sandboxes/snapshot") return { sandbox: await snapshotAgentSandbox(store, owner, await readBody(request)) };
    if (post && path === "/api/agent-sandboxes/restore") return { sandbox: await restoreAgentSandbox(store, owner, await readBody(request)) };
  } catch (error) {
    if (error instanceof z.ZodError) throw new AgentSandboxLifecycleError(400, error.issues[0]?.message ?? "That request could not be understood");
    throw error;
  }
  throw new AgentSandboxLifecycleError(404, "Unknown address");
}
