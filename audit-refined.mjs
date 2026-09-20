#!/usr/bin/env node
/**
 * Refined audit: only flag tools whose schemas have resource fields but no targets.
 */

import { createBranch } from "./dist/index.js";
import { policyTarget } from "./dist/policy.js";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

/**
 * Check if a Zod schema has resource-like fields in its structure.
 */
function hasResourceFields(schema, visited = new Set()) {
  if (!schema) return false;
  if (visited.has(schema)) return false;
  visited.add(schema);

  const def = schema._def;
  if (!def) return false;

  // Check for resource-like field names
  if (def.shape) {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    const fieldNames = Object.keys(shape || {});
    const resourcePatterns = [
      "path", "paths", "file", "files", "folder", "source",
      "url", "urls", "host", "pattern", "patterns",
      "file_path", "file_paths", "document", "source_path"
    ];

    if (fieldNames.some(name =>
      resourcePatterns.some(pattern => name.includes(pattern))
    )) {
      return true;
    }

    // Recursively check nested schemas
    for (const field of Object.values(shape || {})) {
      if (hasResourceFields(field, visited)) return true;
    }
  }

  // Check inner schema for optional/default wrappers
  if (def.schema) {
    return hasResourceFields(def.schema, visited);
  }

  return false;
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
    withoutResourceFields: [],
    withResourcesAndTargets: [],
    withResourcesNoCoverage: [],
  };

  for (const name of allTools) {
    const inventory = app.registry.inventory().find(i => i.name === name);
    if (!inventory) continue;

    // Get the permission to understand what it does
    const permission = inventory.permission;

    // Skip clearly read-only or metadata tools
    if (permission.includes("read") || permission === "user.ask" ||
        permission === "heartbeat.respond" || permission.includes("list") ||
        permission.includes("describe") || permission.includes("search") ||
        permission.includes("status")) {
      results.withoutResourceFields.push({ name, reason: "read-only/metadata" });
      continue;
    }

    // Check if schema has resource fields by examining the JSON schema
    const inputSchema = inventory.inputSchema;
    const schemaProps = inputSchema?.properties || {};
    const schemaFieldNames = Object.keys(schemaProps);

    const resourcePatterns = [
      "path", "paths", "file", "files", "folder", "source",
      "url", "urls", "host", "pattern", "patterns",
      "file_path", "file_paths", "document", "source_path"
    ];

    const hasResourceField = schemaFieldNames.some(name =>
      resourcePatterns.some(pattern => name.includes(pattern))
    );

    if (!hasResourceField) {
      results.withoutResourceFields.push({ name, reason: "no resource fields" });
      continue;
    }

    // Has resource fields - check if it declares targets
    try {
      const targets = app.registry.targetsOf(name, {}, {});
      if (targets !== null) {
        results.withResourcesAndTargets.push(name);
        continue;
      }
    } catch {
      // Might need valid args, that's OK
    }

    // Check if policyTarget covers it with sample args
    const sampleArgs = {
      path: "test.txt",
      paths: ["test.txt"],
      url: "https://example.com",
      file: "test.txt",
      files: ["test.txt"],
      folder: ".",
      source: "test",
      pattern: "*",
    };

    const target = policyTarget(name, sampleArgs);
    if (target) {
      results.withResourcesAndTargets.push(name);
      continue;
    }

    // Has resource fields, no targets, no policyTarget coverage
    results.withResourcesNoCoverage.push(name);
  }

  console.log(`\n=== AUDIT RESULTS ===\n`);
  console.log(`Without resource fields: ${results.withoutResourceFields.length}`);
  console.log(`With resources AND targets/coverage: ${results.withResourcesAndTargets.length}`);

  console.log(`\n>>> THIRD LIST (resources, NO targets, NO policyTarget coverage): ${results.withResourcesNoCoverage.length} <<<`);
  results.withResourcesNoCoverage.forEach(t => console.log(`  ${t}`));

  await app.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
