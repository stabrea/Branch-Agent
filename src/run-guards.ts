import { join, posix } from "node:path";
import { filePathOf } from "./activity.js";
import type { Message, ToolCall } from "./contracts.js";
import { discoverFolder, folderTrust, nothingFound, trustCappedPolicy, type FolderTrust } from "./folder-trust.js";
import { InstructionReader, TaskInstructions, instructionText } from "./instruction-files.js";
import { LoopGuard } from "./loop-guard.js";
import type { Policy } from "./policy.js";
import type { Store } from "./store.js";

/** Raised between rounds when the loop guard has decided the task should end. */
export class LoopStoppedError extends Error {
  override name = "LoopStoppedError";
}

interface RunState { loop: LoopGuard; notes: TaskInstructions }

/**
 * The one place the runtime calls for the three guards of wave mac2: the loop guard
 * (src/loop-guard.ts), the folder's own instructions (src/instruction-files.ts) and folder trust
 * (src/folder-trust.ts). Each task gets its own state, let go of when the task settles.
 */
export class RunGuards {
  private readonly runs = new Map<string, RunState>();
  private readonly reader: InstructionReader;
  private readonly asked = new Set<string>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly workspace: string) {
    this.reader = new InstructionReader(workspace);
  }

  /** The active project's folder, relative to the workspace ("" for the whole workspace). */
  private projectFolder(): string {
    try { return this.store.projects.active(this.owner).folder; } catch { return ""; }
  }
  /** How far the folder tasks work in is trusted. */
  trust(): FolderTrust {
    return folderTrust(this.store, this.owner, join(this.workspace, this.projectFolder()));
  }
  /** The approval setting with the folder's trust applied: an untrusted folder always asks. */
  policy(policy: Policy): Policy {
    return trustCappedPolicy(policy, this.trust());
  }

  private state(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      const allowed = (folder: string) => folderTrust(this.store, this.owner, join(this.workspace, folder)) === "trusted";
      state = { loop: new LoopGuard(), notes: new TaskInstructions(this.reader, allowed) };
      this.runs.set(runId, state);
    }
    return state;
  }
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * The workspace notes a task starts with, put in right after the opening instructions. A folder
   * not decided about yet is written down so the owner is asked. Never fails the task.
   */
  async opening(runId: string, messages: Message[], ids: (number | null)[]): Promise<void> {
    try {
      await this.noteUndecided(runId);
      const files = await this.state(runId).notes.opening(this.projectFolder());
      if (!files.length) return;
      const at = ids.findIndex((id) => id !== null), position = at < 0 ? messages.length : at;
      messages.splice(position, 0, { role: "system", content: instructionText(files, true) });
      ids.splice(position, 0, null);
      this.store.event(runId, "instructions.loaded", { files: files.map((file) => file.path) });
    } catch (error) {
      this.store.event(runId, "instructions.failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async noteUndecided(runId: string): Promise<void> {
    const folder = join(this.workspace, this.projectFolder());
    if (this.trust() !== "unknown" || this.asked.has(folder)) return;
    this.asked.add(folder);
    const found = await discoverFolder(folder);
    if (!nothingFound(found)) this.store.event(runId, "folder.trust_needed", { folder, ...found });
  }

  /**
   * One tool call with the loop guard around it. A refused call is answered without running; a
   * repeated one runs with a warning beside its result; a file in a folder not seen before brings
   * that folder's notes with it.
   */
  async call(runId: string, call: ToolCall, execute: () => Promise<unknown>): Promise<unknown> {
    const state = this.state(runId);
    const verdict = state.loop.check(call.name, call.arguments);
    if (verdict.kind === "block" || verdict.kind === "stop") {
      this.store.event(runId, verdict.kind === "stop" ? "loop.stopped" : "loop.blocked", { name: call.name, id: call.id, reason: verdict.reason });
      return { ok: false, error: verdict.reason };
    }
    const result = await execute();
    const repeated = state.loop.record(call.name, call.arguments, JSON.stringify(result) ?? "");
    const warning = verdict.kind === "warn" ? verdict.reason : repeated;
    if (warning) this.store.event(runId, "loop.warned", { name: call.name, id: call.id, reason: warning });
    const notes = await this.notesFor(runId, state, call);
    if (!warning && !notes) return result;
    const extra = { ...(warning ? { loopWarning: warning } : {}), ...(notes ? { folderInstructions: notes } : {}) };
    // Put first, so a long result that gets shortened still carries them.
    return result && typeof result === "object" && !Array.isArray(result) ? { ...extra, ...result } : { ...extra, result };
  }

  /** Ends the task, in one plain sentence, once the guard has decided it is going nowhere. */
  afterRound(runId: string): void {
    const loop = this.runs.get(runId)?.loop;
    if (loop?.stats().stopped) throw new LoopStoppedError(loop.stopReason());
  }

  private async notesFor(runId: string, state: RunState, call: ToolCall): Promise<string> {
    let args: unknown;
    try { args = JSON.parse(call.arguments); } catch { return ""; }
    const path = filePathOf(call.name, args);
    if (!path) return "";
    try {
      const files = await state.notes.touched(posix.join(this.projectFolder().replace(/\\/g, "/"), path));
      if (files.length) this.store.event(runId, "instructions.loaded", { files: files.map((file) => file.path), touched: path });
      return instructionText(files, false);
    } catch { return ""; }
  }
}
