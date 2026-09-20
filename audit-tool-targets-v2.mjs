#!/usr/bin/env node
/**
 * Audit which tools should declare targets but don't.
 * Strategy:
 * 1. Load all tools
 * 2. Check if explicit target/targets declared
 * 3. If not, check if policyTarget covers it
 * 4. If neither, mark as missing
 */

import { createBranch } from "./dist/index.js";
import { policyTarget } from "./dist/policy.js";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

function makePlausibleArgs(name) {
  const args = {};

  if (name.startsWith("files.") || name.startsWith("code.") || name.startsWith("workspace.")) {
    args.path = "example.txt";
  }
  if (name.startsWith("browser.") || name.startsWith("web.")) {
    args.url = "https://example.com";
  }
  if (name.startsWith("git.")) {
    args.folder = ".";
    args.path = "example.txt";
  }
  if (name.startsWith("shell.")) {
    args.program = "echo";
    args.args = [];
  }
  if (name.startsWith("remote.")) {
    args.program = "ls";
  }

  return args;
}

async function main() {
  const tmpDir = await mkdtemp(join(tmpdir(), "audit-"));
  const provider = { name: "scripted", async complete() { return { content: "OK", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(tmpDir, "workspace"),
    dataDir: join(tmpDir, "data"),
    provider,
  });

  const tools = app.registry.names();
  const context = { signal: { throwIfAborted: () => {} }, permissions: app.registry.permissions() };

  const hasDeclaredTargets = [];
  const coveredByConvention = [];
  const actuallyMissing = [];

  for (const name of tools) {
    try {
      const result = app.registry.targetsOf(name, {}, context);
      if (result !== null) {
        hasDeclaredTargets.push(name);
        continue;
      }

      const plausibleArgs = makePlausibleArgs(name);
      const target = policyTarget(name, plausibleArgs);

      if (target) {
        coveredByConvention.push(name);
        continue;
      }

      const permission = app.registry.permissionOf(name);
      const resourceTypes = [
        "files", "code", "git", "documents", "data", "media", "research",
        "browser", "web", "desktop", "remote", "shell", "processes",
      ];
      const actsOnResources = resourceTypes.some(type =>
        name.startsWith(type + ".") || permission?.startsWith(type + ".")
      );

      const readOnlyPermissions = [
        "user.ask", "memory.read", "history.read", "skills.read",
        "documents.read", "web.read", "browser.read", "schedules.read",
        "data.read", "research.read", "monitors.read", "brief.read",
        "scratch.read", "mcp.read", "process.read", "gitlab.read",
        "projects.read", "intents.read", "sources.read", "blocks.read",
        "nodes.read", "devices.read", "personal.read", "boards.read",
        "widgets.read", "installs.read", "heartbeat.respond",
        "permissions.read",
      ];
      const isReadOnly = readOnlyPermissions.some(p => permission === p);

      if (actsOnResources && !isReadOnly) {
        actuallyMissing.push(name);
      }
    } catch (e) {
      actuallyMissing.push(`${name} (threw)`);
    }
  }

  console.log(`\nTools with declared targets (target/targets): ${hasDeclaredTargets.length}`);
  console.log(hasDeclaredTargets.slice(0, 10).map(n => `  ${n}`).join("\n"));
  if (hasDeclaredTargets.length > 10) console.log(`  ... and ${hasDeclaredTargets.length - 10} more`);

  console.log(`\nTools covered by policyTarget convention: ${coveredByConvention.length}`);
  console.log(coveredByConvention.slice(0, 10).map(n => `  ${n}`).join("\n"));
  if (coveredByConvention.length > 10) console.log(`  ... and ${coveredByConvention.length - 10} more`);

  console.log(`\n>>> THIRD LIST (should declare but don't): ${actuallyMissing.length} <<<`);
  actuallyMissing.slice(0, 30).forEach(name => console.log(`  ${name}`));
  if (actuallyMissing.length > 30) {
    console.log(`  ... and ${actuallyMissing.length - 30} more`);
  }

  await app.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
