#!/usr/bin/env node
/**
 * Real audit: Get tool definitions and properly check for missing targets.
 * This directly inspects the tool registration to see what args are needed.
 */

import { createBranch } from "./dist/index.js";
import { policyTarget } from "./dist/policy.js";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

/**
 * Try to construct valid arguments by examining a Zod schema.
 */
function tryValidArgs(schema) {
  try {
    // Try empty object
    const emptyResult = schema.safeParse({});
    if (emptyResult.success) return {};

    // Try with some defaults
    const withDefaults = {
      path: "test.txt",
      paths: ["test.txt"],
      url: "https://example.com",
      folder: ".",
      name: "test",
      message: "test",
      text: "test",
      input: "",
      command: "echo test",
      patch: "diff",
      file: "test.txt",
      files: ["test.txt"],
      args: [],
      program: "test",
    };

    const result = schema.safeParse(withDefaults);
    if (result.success) return result.data;

    // Try smaller subset
    const minimal = {
      path: "test.txt",
      folder: ".",
      url: "https://example.com",
    };
    const minResult = schema.safeParse(minimal);
    if (minResult.success) return minResult.data;

    return null;
  } catch {
    return null;
  }
}

async function main() {
  const tmpDir = await mkdtemp(join(tmpdir(), "audit-"));
  const provider = { name: "scripted", async complete() { return { content: "OK", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(tmpDir, "workspace"),
    dataDir: join(tmpDir, "data"),
    provider,
  });

  const allTools = app.registry.names();

  const results = {
    withTargets: [],
    coveredByPolicyTarget: [],
    missing: [],
    noValidArgsFound: [],
  };

  for (const name of allTools) {
    // Try to build valid args
    const inventory = app.registry.inventory().find(i => i.name === name);
    if (!inventory) continue;

    const permission = inventory.permission;

    // First check: does it declare targets?
    let hasTargets = false;
    try {
      // Try empty args
      const emptyTargets = app.registry.targetsOf(name, {}, {});
      if (emptyTargets !== null) {
        hasTargets = true;
        results.withTargets.push(name);
        continue;
      }
    } catch {
      // Might need valid args
    }

    // Second check: can we get valid args and check targetsOf?
    let validArgs = tryValidArgs(app.registry.inventory().find(i => i.name === name)?.inputSchema ?? {});

    if (!validArgs) {
      // Last attempt: try with minimal args based on name patterns
      if (name.includes("path") || name.startsWith("files.") || name.startsWith("code.")) {
        validArgs = { path: "test.txt", folder: "." };
      } else if (name.includes("url") || name.startsWith("web.") || name.startsWith("browser.")) {
        validArgs = { url: "https://example.com" };
      } else {
        validArgs = {};
      }
    }

    // Now check with valid args
    try {
      const targets = app.registry.targetsOf(name, validArgs, {});
      if (targets !== null) {
        results.withTargets.push(name);
        continue;
      }
    } catch {
      // Throws means it needs different args, skip
      results.noValidArgsFound.push(name);
      continue;
    }

    // Check policyTarget
    const target = policyTarget(name, validArgs);
    if (target) {
      results.coveredByPolicyTarget.push(name);
      continue;
    }

    // No targets, no policyTarget - check if acts on resources
    const isReadOnly = [
      "files.read", "code.read", "memory.read", "history.read",
      "documents.read", "web.read", "browser.read", "data.read",
      "research.read", "media.read", "process.read", "git.read",
      "gitlab.read", "projects.read", "intents.read", "sources.read",
      "blocks.read", "nodes.read", "devices.read", "personal.read",
      "boards.read", "widgets.read", "installs.read", "schedules.read",
      "mcp.read", "brief.read", "scratch.read", "skills.read",
      "user.ask", "heartbeat.respond", "permissions.read"
    ].includes(permission);

    const actsOnResources = [
      "files", "code", "git", "documents", "data", "media", "research",
      "browser", "web", "desktop", "remote", "shell", "process"
    ].some(p => permission.startsWith(p + "."));

    if (actsOnResources && !isReadOnly) {
      results.missing.push({ name, permission });
    }
  }

  console.log(`\n=== AUDIT RESULTS ===\n`);
  console.log(`With declared targets: ${results.withTargets.length}`);
  console.log(`Covered by policyTarget convention: ${results.coveredByPolicyTarget.length}`);
  console.log(`Could not generate valid args: ${results.noValidArgsFound.length}`);

  console.log(`\n>>> THIRD LIST (acts on resources, not covered, no targets): ${results.missing.length} <<<`);
  results.missing.forEach(t => console.log(`  ${t.name} (permission: ${t.permission})`));

  await app.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
