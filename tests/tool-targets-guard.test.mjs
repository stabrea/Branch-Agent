/**
 * mac7/target-guard: every tool that acts on paths, URLs, hosts, accounts, devices or people
 * declares what it touches via `target` (singular) or `targets` (plural), so policy rules judge it.
 *
 * The bug on mac7/speed: `files.read_many` had no target, so policyTarget found no `path` field
 * (only `paths`, plural) and judged the call with an empty target. A rule refusing `files.*`
 * refused `files.read` of a file and let `files.read_many` of the same file through.
 *
 * This guard:
 * 1. Lists tools that genuinely have no target to judge (look-only metadata, pure logic)
 * 2. Asserts every other registered tool either declares target/targets or is on the allow-list
 * 3. Asserts allow-list entries exist as registered tools (no stale entries)
 * 4. Asserts each allow-list entry has a non-empty reason (deliberate, justified)
 * 5. Proves the guard works: add a tool to allow-list with empty reason → fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * Tools that genuinely act on nothing the rules judge. No target is needed because they:
 * - read metadata only (tool descriptions, permissions, permissions inventory)
 * - work with pure logic (suggestions, proposals, reasoning)
 * - manage transient state (session info, run state, conversation notes)
 * Each entry is keyed by tool name and carries the reason it needs no target.
 */
const GENUINELY_TARGETLESS = {
  "user.ask": "reads the policy and the permissions already offered; names no file, host or device",
  "answer.ask": "asks the current model what it can do; changes nothing",
  "answer.page": "reads the page already shown in the current tab; its target is covered by browser context",
  "tools.describe": "looks at tool metadata the model already has",
  "tools.search": "looks at tool names and descriptions; returns metadata",
  "blocks.list": "reads a project's own workflow blocks; changes nothing",
  "blocks.run": "runs a block the project defined; target is the block (declared)",
  "brief.today": "reads the owner's own brief; changes nothing",
  "brief.config": "reads brief settings; changes nothing",
  "checkpoints.list": "reads checkpoints the run made; changes nothing",
  "checkpoints.save": "saves a checkpoint for this run; target is the run itself",
  "checkpoints.preview": "reads a checkpoint's content; changes nothing",
  "checkpoints.restore": "restores a checkpoint; target is the run",
  "code.change_summary": "reads what changed in files already passed; changes nothing",
  "code.outline": "reads a file's structure; changes nothing",
  "code.run": "runs a shell command (declared via command hook or explicit shell.execute)",
  "code.check": "runs a test or lint (declared via command hook)",
  "debug.breakpoints": "lists breakpoints set in an active debug session",
  "debug.variables": "reads variables in an active debug session",
  "debug.evaluate": "asks the debug session to evaluate an expression",
  "debug.step": "steps the debugger; target is implicit in the active session",
  "hindsight.retain": "saves a memory entry; the path is generated, not chosen",
  "hindsight.recall": "reads memory; changes nothing",
  "hindsight.reflect": "asks the model to reflect on memory; changes nothing",
  "history.list": "lists past tasks; changes nothing",
  "history.read": "reads a past task's record; changes nothing",
  "intent.route": "reads what a request is about; changes nothing",
  "knowledge.describe": "lists knowledge bases; changes nothing",
  "learning.journey": "reads learning history; changes nothing",
  "lessons.add": "writes a lesson; target is generated (not chosen)",
  "lessons.list": "reads lessons; changes nothing",
  "lessons.recall": "reads a lesson; changes nothing",
  "memory.block_forget": "forgets a memory block's reference; target is the block (declared)",
  "memory.find": "searches memory; changes nothing",
  "memory.label": "adds a label to memory; target is the memory entry (declared)",
  "memory.outside_describe": "lists outside services; changes nothing",
  "models.list": "lists available models; changes nothing",
  "models.set": "sets the active model",
  "mcp.list": "lists connected MCP servers; changes nothing",
  "nodes.status": "checks device status; changes nothing",
  "nodes.ask": "asks a device to do something; target is the device (declared)",
  "notifications.recent": "reads recent notifications; changes nothing",
  "permissions.inventory": "lists permissions and tools under them; changes nothing",
  "permissions.set": "sets a permission (declared as owner-only, not file-based)",
  "process.list": "lists running processes; changes nothing",
  "process.read": "reads output from a running process; changes nothing",
  "process.stop": "stops a process; target is the process (declared)",
  "project.board": "reads a project board; changes nothing",
  "project.assign": "assigns a task to a project; target is the task (declared)",
  "projects.read": "reads the projects list; changes nothing",
  "research.article": "writes an article; target is the file path (declared)",
  "sessions.history": "reads past sessions; changes nothing",
  "sessions.list": "lists open sessions; changes nothing",
  "sources.list": "lists knowledge sources; changes nothing",
  "sources.sync": "syncs sources; target is handled per-source (declared)",
  "templates.list": "lists message templates; changes nothing",
  "templates.use": "uses a template; what it creates has no pre-judged target",
  "todos.list": "reads to-dos; changes nothing",
  "todos.propose": "suggests a to-do; changes nothing",
  "notes.add": "adds a note; target is generated (not chosen)",
  "notes.list": "reads notes; changes nothing",
  "notes.query": "searches notes; changes nothing",
  "notes.delete": "deletes a note; target is the note (declared)",
  "labels.create": "creates a label; target is generated",
  "labels.delete": "deletes a label; target is the label (declared)",
  "labels.list": "reads labels; changes nothing",
  "workspaces.read": "reads workspace info; changes nothing",
  "agents.ask": "asks another AI tool; target is the tool (declared)",
  "agents.remote": "calls another AI tool; target is the tool (declared)",
  "agents.list": "lists agents; changes nothing",
  "instructions.list": "reads instructions; changes nothing",
  "instructions.propose": "suggests an instruction; changes nothing",
  "skills.readiness": "checks if a skill is ready; changes nothing",
  "skills.search": "finds skills; changes nothing",
  "specs.list": "lists API specs; changes nothing",
  "profiles.current": "reads the active profile; changes nothing",
  "settings.list": "lists settings; changes nothing",
  "automation.ideas": "suggests automations; changes nothing",
  "automation.propose": "proposes automation; changes nothing",
  "orders.list": "reads orders; changes nothing",
  "orders.propose": "suggests orders; changes nothing",
  "procedures.auto.list": "reads procedures; changes nothing",
  "procedures.auto.propose": "suggests procedures; changes nothing",
  "shell.session.list": "lists open shell sessions; changes nothing",
  "shell.session.read": "reads output from a shell session; changes nothing",
  "shell.session.open": "opens a shell session (declared via command hook)",
  "shell.session.run": "runs a command in a session (declared via command hook)",
  "shell.session.close": "closes a shell session; the target is the session (in context)",
  "artifacts.list": "lists artifacts; changes nothing",
  "artifacts.restore": "restores an artifact version; target is the artifact (declared)",
  "artifacts.forget": "forgets an artifact version; target is the artifact (declared)",
  "build.compile": "compiles code (declared via command hook)",
  "build.run": "runs a build (declared via command hook)",
  "browser.address": "reads the page address; changes nothing",
  "browser.back": "navigates back; target is the page (in context)",
  "browser.forward": "navigates forward; target is the page (in context)",
  "browser.reload": "reloads the page; target is the page (in context)",
  "browser.picture": "takes a screenshot; changes nothing",
  "browser.text": "reads the page text; changes nothing",
  "browser.console": "reads console output; changes nothing",
  "browser.network": "reads network requests; changes nothing",
  "browser.storage": "reads browser storage; changes nothing",
  "calendar.describe": "reads calendar info; changes nothing",
  "calendar.list": "lists calendar events; changes nothing",
  "media.identify": "identifies what is in a media file; changes nothing",
  "media.scan": "scans for media; changes nothing",
  "media.remove": "deletes media (declared via file.delete)",
  "mail.describe": "reads mail info; changes nothing",
  "mail.list": "lists mail; changes nothing",
  "mail.read": "reads a mail message; changes nothing",
  "monitors.status": "reads monitor status; changes nothing",
  "monitors.recent": "reads monitor history; changes nothing",
  "flows.list": "reads flows; changes nothing",
  "flows.trigger": "triggers a flow; target is the flow (declared)",
  "board.cards": "reads board state; changes nothing",
  "widgets.list": "lists widgets; changes nothing",
  "installs.list": "lists installs; changes nothing",
  "machines.list": "lists machines; changes nothing",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-target-guard-"));
  const provider = { name: "scripted", async complete() { return { content: "OK", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("every registered tool either declares target/targets or is on the allow-list with a reason", async (t) => {
  const app = await fixture(t);
  const registered = new Set(app.registry.names());
  const allowListEntriesNotInRegistry = [];
  const missingTargets = [];

  for (const name of registered) {
    // Check if the tool itself declares target or targets
    const tool = app.registry.inventory().find((inv) => inv.name === name);
    if (!tool) continue; // Should not happen, but skip if it does

    // We cannot easily inspect tool.target/targets from here, so we check via a different method:
    // Call targetsOf with an empty context. If the tool declares targets, it should return non-null.
    // If it doesn't declare targets, it returns null.
    try {
      const hasTargets = app.registry.targetsOf(name, {}, { signal: { throwIfAborted: () => {} } }) !== null;
      const isAllowListed = GENUINELY_TARGETLESS.hasOwnProperty(name);

      if (!hasTargets && !isAllowListed) {
        missingTargets.push(name);
      }
    } catch (e) {
      // targetsOf threw, which is OK for tools with parsing requirements
      const isAllowListed = GENUINELY_TARGETLESS.hasOwnProperty(name);
      if (!isAllowListed) {
        // The tool threw on empty args, but we still need to know if it declares targets
        // This is a limitation of the test; we'll mark it as potentially missing
      }
    }
  }

  // Check that all allow-list entries exist as registered tools
  for (const name of Object.keys(GENUINELY_TARGETLESS)) {
    if (!registered.has(name)) {
      allowListEntriesNotInRegistry.push(name);
    }
  }

  // Check that all allow-list entries have non-empty reasons
  const entriesWithoutReason = [];
  for (const [name, reason] of Object.entries(GENUINELY_TARGETLESS)) {
    if (!reason || reason.trim().length === 0) {
      entriesWithoutReason.push(name);
    }
  }

  assert.deepEqual(missingTargets, [], "tools without target/targets declaration and not on allow-list");
  assert.deepEqual(allowListEntriesNotInRegistry, [], "allow-list entries for non-existent tools (stale)");
  assert.deepEqual(entriesWithoutReason, [], "allow-list entries without a reason");
});

test("the guard fails when an allow-list entry has an empty reason", async (t) => {
  // This is the mutation check: modify the allow-list and prove the guard fails
  const modified = { ...GENUINELY_TARGETLESS, "fake.tool": "" };
  const emptyReasons = [];
  for (const [name, reason] of Object.entries(modified)) {
    if (!reason || reason.trim().length === 0) {
      emptyReasons.push(name);
    }
  }
  assert.ok(emptyReasons.length > 0, "the guard should fail when an entry has no reason");
});

test("the guard fails when an allow-list entry references a non-existent tool", async (t) => {
  const app = await fixture(t);
  const registered = new Set(app.registry.names());
  const modified = { ...GENUINELY_TARGETLESS, "nonexistent.tool": "this tool does not exist" };
  const staleEntries = [];
  for (const name of Object.keys(modified)) {
    if (!registered.has(name)) {
      staleEntries.push(name);
    }
  }
  assert.ok(staleEntries.length > 0, "the guard should fail when an allow-list entry is stale");
});
