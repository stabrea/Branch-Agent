#!/usr/bin/env node
/**
 * Audit which tools should declare targets but don't.
 * Strategy:
 * 1. Load all tools
 * 2. For each tool, check if it has explicit target/targets
 * 3. If not, check if policyTarget (or resourceOf) would handle it
 * 4. If neither, check if the tool acts on something the rules judge
 * 5. Report the third-list: tools that should declare but don't
 */

import { createBranch } from "./dist/index.js";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

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
  const missingTargets = [];

  for (const name of tools) {
    try {
      // Try to call targetsOf - if it returns non-null, the tool has targets declared
      const result = app.registry.targetsOf(name, {}, context);
      if (result !== null) {
        hasDeclaredTargets.push(name);
      } else {
        // Tool doesn't declare targets
        // Check if this tool acts on something that the rules should judge

        // Get the permission to understand what the tool does
        const permission = app.registry.permissionOf(name);

        // Check if it's a file, code, git, documents, etc. tool (things that act on resources)
        const resourceTypes = [
          "files", "code", "git", "documents", "data", "media", "research",
          "browser", "web", "desktop", "remote", "shell", "processes",
        ];
        const actsOnResources = resourceTypes.some(type =>
          name.startsWith(type + ".") || permission?.startsWith(type + ".")
        );

        // Check if it's a read-only permission (those usually don't need targets)
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
          missingTargets.push(name);
        }
      }
    } catch (e) {
      // Tool threw - might have required parameters
      missingTargets.push(`${name} (threw on empty args)`);
    }
  }

  console.log(`\nTools with declared targets: ${hasDeclaredTargets.length}`);
  if (hasDeclaredTargets.length <= 20) {
    console.log(hasDeclaredTargets.map(n => `  ${n}`).join("\n"));
  } else {
    console.log(hasDeclaredTargets.slice(0, 10).map(n => `  ${n}`).join("\n"));
    console.log(`  ... and ${hasDeclaredTargets.length - 10} more`);
  }

  console.log(`\n>>> THIRD LIST (should declare but don't): ${missingTargets.length} <<<`);
  missingTargets.slice(0, 30).forEach(name => console.log(`  ${name}`));
  if (missingTargets.length > 30) {
    console.log(`  ... and ${missingTargets.length - 30} more`);
  }

  await app.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
