#!/usr/bin/env node
/**
 * Proper audit: build valid arguments from zod schemas and check which tools
 * act on resources but don't declare targets.
 */

import { createBranch } from "./dist/index.js";
import { policyTarget } from "./dist/policy.js";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Generate a minimal valid value for a zod schema.
 * Returns null if the schema has required fields we cannot guess.
 */
function generateValidValue(schema, depth = 0) {
  if (depth > 5) return null; // Prevent infinite recursion

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return generateValidValue(schema._def.schema, depth + 1);
  }
  if (schema instanceof z.ZodString) return "test";
  if (schema instanceof z.ZodNumber) return 1;
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodArray) {
    const itemValue = generateValidValue(schema._def.type, depth + 1);
    return itemValue !== null ? [itemValue] : [];
  }
  if (schema instanceof z.ZodObject) {
    const obj = {};
    const shape = schema._def.shape();
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const val = generateValidValue(fieldSchema, depth + 1);
      if (val !== null || !(fieldSchema instanceof z.ZodOptional)) {
        obj[key] = val;
      }
    }
    return obj;
  }
  if (schema instanceof z.ZodEnum) {
    const values = schema._def.values;
    return values[0];
  }
  if (schema instanceof z.ZodLiteral) {
    return schema._def.value;
  }
  // Passthrough, union, etc. - try to get something
  try {
    const parsed = schema.safeParse({});
    if (parsed.success) return parsed.data;
  } catch {}
  return null;
}

/**
 * Check if a tool schema has path-like, url-like, or other resource fields.
 */
function hasResourceFields(schema) {
  if (!schema || !schema._def) return false;

  const shape = schema._def.shape?.() || {};
  const resourcePatterns = [
    "path", "paths", "file", "files", "folder", "folders",
    "url", "urls", "host", "hosts", "website",
    "file_path", "file_paths",
    "pattern", "patterns"
  ];

  return Object.keys(shape).some(key =>
    resourcePatterns.some(pattern => key.includes(pattern))
  );
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

  const withTargets = [];
  const coveredByConvention = [];
  const missing = [];
  const unGuessable = [];

  for (const name of tools) {
    // Try to build valid arguments
    let validArgs = null;
    try {
      validArgs = generateValidValue(app.registry.inventory().find(i => i.name === name)?.inputSchema ?? {}, 0);
      if (!validArgs) {
        // Could not generate valid args
        unGuessable.push(name);
        continue;
      }
    } catch (e) {
      unGuessable.push(name);
      continue;
    }

    // Check if declares targets
    try {
      const targets = app.registry.targetsOf(name, validArgs, context);
      if (targets !== null) {
        withTargets.push(name);
        continue;
      }
    } catch (e) {
      // targetsOf threw - might be validation error, but the tool tried to use parameters
      // This could mean it has targets logic but failed to parse
      // Skip this tool
      unGuessable.push(name);
      continue;
    }

    // No targets - check if policyTarget covers it
    const target = policyTarget(name, validArgs);
    if (target) {
      coveredByConvention.push(name);
      continue;
    }

    // No targets, no policyTarget - check if it acts on resources
    const permission = app.registry.permissionOf(name);

    // Check by permission name
    const resourcePermissions = [
      "files", "code", "git", "documents", "data", "media", "research",
      "browser", "web", "desktop", "remote", "shell", "process"
    ];
    const actsOnResources = resourcePermissions.some(p =>
      permission.startsWith(p + ".")
    );

    // Check if permission is read-only
    const readOnlyPerms = [
      "files.read", "code.read", "memory.read", "history.read",
      "documents.read", "web.read", "browser.read", "data.read",
      "research.read", "media.read", "process.read", "git.read",
      "gitlab.read", "projects.read", "intents.read", "sources.read",
      "blocks.read", "nodes.read", "devices.read", "personal.read",
      "boards.read", "widgets.read", "installs.read", "schedules.read",
      "mcp.read", "brief.read", "scratch.read", "skills.read",
      "user.ask", "heartbeat.respond", "permissions.read"
    ];
    const isReadOnly = readOnlyPerms.includes(permission);

    if (actsOnResources && !isReadOnly) {
      missing.push(name);
    }
  }

  console.log(`\n=== AUDIT RESULTS ===\n`);
  console.log(`Tools with declared targets: ${withTargets.length}`);
  console.log(`Tools covered by policyTarget: ${coveredByConvention.length}`);
  console.log(`Tools with required args we couldn't guess: ${unGuessable.length}`);
  console.log(`\n>>> THIRD LIST (should declare but don't): ${missing.length} <<<`);

  missing.forEach(t => console.log(`  ${t}`));

  if (unGuessable.length > 0 && unGuessable.length <= 20) {
    console.log(`\nUn-guessable tools (need hand-checking):`);
    unGuessable.slice(0, 20).forEach(t => console.log(`  ${t}`));
    if (unGuessable.length > 20) {
      console.log(`  ... and ${unGuessable.length - 20} more`);
    }
  }

  await app.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
