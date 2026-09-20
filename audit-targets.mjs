#!/usr/bin/env node
/**
 * Audit all tools to find those that should declare targets but don't.
 * Classification:
 * 1. Has target or targets → declares
 * 2. policyTarget() returns non-empty → covered by convention
 * 3. Acts on path/url/host/account/device/person but doesn't declare → third list
 * 4. Genuinely targetless → okay
 */

import { ToolRegistry } from "./dist/registry.js";
import { policyTarget } from "./dist/policy.js";
import { z } from "zod";

// Load all tool registrations
const registry = new ToolRegistry();

// Import all tool modules that register tools
const toolModules = [
  "./dist/integrations/git-tools.js",
  "./dist/integrations/browser-tools.js",
  "./dist/integrations/desktop-tools.js",
  "./dist/integrations/issue-tools.js",
  "./dist/shell.js",
  "./dist/files.js",
  "./dist/data-tools.js",
  "./dist/autonomy/tools.js",
  "./dist/channels/catalog.js",
  "./dist/commands/catalog.js",
  "./dist/devices/tools.js",
  "./dist/flows-boards/tools.js",
  "./dist/knowledge-tools.js",
  "./dist/language-server-tools.js",
  "./dist/mcp-tools.js",
  "./dist/openapi-tools.js",
  "./dist/orchestration-tools.js",
  "./dist/plugin-catalog.js",
  "./dist/personal/tools.js",
  "./dist/web-tools.js",
  "./dist/local-catalogue.js",
];

// Try loading modules (some may not exist)
for (const module of toolModules) {
  try {
    const loaded = await import(module);
    if (loaded.register) {
      loaded.register(registry);
    }
  } catch (e) {
    // Ignore module load failures
  }
}

// Generate plausible arguments for a schema
function generatePlausibleArgs(schema) {
  try {
    const json = z.ZodType.prototype instanceof z.ZodType ?
      JSON.parse(JSON.stringify(schema)) :
      schema.toJSON ? schema.toJSON() : {};

    const args = {};
    const props = json.properties || {};

    for (const [key, prop] of Object.entries(props)) {
      if (prop.type === "string") {
        args[key] = key === "url" || key === "path" ? "example.txt" :
                    key === "host" || key === "hostname" ? "example.com" :
                    key === "file_path" ? "example.txt" :
                    key === "command" ? "echo test" :
                    "test";
      } else if (prop.type === "number") {
        args[key] = 1;
      } else if (prop.type === "boolean") {
        args[key] = false;
      } else if (prop.type === "array") {
        if (key === "paths" || key === "files" || key === "folders") {
          args[key] = ["example.txt"];
        } else if (key === "args") {
          args[key] = [];
        } else if (key === "hosts" || key === "hostnames") {
          args[key] = ["example.com"];
        } else {
          args[key] = [];
        }
      } else if (prop.type === "object") {
        args[key] = {};
      }
    }
    return args;
  } catch (e) {
    return {};
  }
}

// Classify each tool
const result = {
  declares: [],
  coveredByConvention: [],
  partialCoverage: [],
  shouldDeclare: [],
  genuinelyTargetless: [],
};

const context = { signal: { throwIfAborted: () => {} }, permissions: new Set() };

for (const name of registry.names()) {
  const tool = registry.tools?.get?.(name);
  if (!tool) continue;

  // Check if tool declares target or targets
  if (tool.target || tool.targets) {
    result.declares.push(name);
    continue;
  }

  // Generate plausible args and check if policyTarget covers it
  const plausibleArgs = generatePlausibleArgs(tool.parameters);
  const target = policyTarget(name, plausibleArgs);

  // Try to get all targets via targetsOf
  let targetsOf_result = null;
  try {
    targetsOf_result = registry.targetsOf(name, plausibleArgs, context);
  } catch (e) {
    // Tool threw on plausible args - means it needs better argument generation
  }

  if (target) {
    result.coveredByConvention.push({ name, target, targetsOf: targetsOf_result });
    continue;
  }

  // No policyTarget coverage - check if the schema has path-like fields that aren't being covered
  const json = tool.parameters.toJSON?.() || {};
  const props = json.properties || {};
  const pathLikeFields = Object.keys(props).filter(k =>
    k.includes("path") || k.includes("file") || k.includes("url") ||
    k.includes("host") || k.includes("account") || k.includes("device")
  );

  if (pathLikeFields.length > 0) {
    // Has resource-like fields but policyTarget doesn't cover them
    result.shouldDeclare.push({
      name,
      fields: pathLikeFields,
      targetsOf: targetsOf_result
    });
  } else {
    // No obvious resource-like fields
    result.genuinelyTargetless.push(name);
  }
}

console.log("\n=== AUDIT RESULTS ===\n");
console.log(`Declares target/targets: ${result.declares.length}`);
console.log(result.declares.slice(0, 10).join(", "), result.declares.length > 10 ? "..." : "");

console.log(`\nCovered by policyTarget convention: ${result.coveredByConvention.length}`);
console.log(result.coveredByConvention.slice(0, 5).map(t => t.name).join(", "),
           result.coveredByConvention.length > 5 ? "..." : "");

console.log(`\nPartial coverage (has plural/special fields not covered by policyTarget): ${result.partialCoverage.length}`);
result.partialCoverage.forEach(t => console.log(`  ${t.name}: ${t.fields.join(", ")}`));

console.log(`\n>>> THIRD LIST (should declare but don't): ${result.shouldDeclare.length} <<<`);
result.shouldDeclare.forEach(t => {
  console.log(`\n  ${t.name}`);
  console.log(`    Fields: ${t.fields.join(", ")}`);
  if (t.targetsOf === null) console.log(`    (targetsOf not declared)`);
});

console.log(`\nGenuinely targetless: ${result.genuinelyTargetless.length}`);
console.log(result.genuinelyTargetless.slice(0, 10).join(", "),
           result.genuinelyTargetless.length > 10 ? "..." : "");
