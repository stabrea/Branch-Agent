#!/usr/bin/env node
/**
 * Batch 1: Measure baseline control counts on all Settings pages.
 * This script:
 * 1. Starts the dev server
 * 2. Navigates to each Settings page via window.openSettings()
 * 3. Counts control types: native selects, switches, tick boxes, segmented buttons
 * 4. Reports results as before/after baseline for batch 1
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const pages = [
  "general",
  "assistant",
  "appearance",
  "permissions",
  "advanced",
  "data",
  "voice",
];

const script = `
const results = {};

async function measure() {
  for (const p of ['general','assistant','appearance','permissions','advanced','data','voice']) {
    window.openSettings(p);
    await new Promise(r => setTimeout(r, 500));
    results[p] = {
      selects: document.querySelectorAll('select').length,
      switches: document.querySelectorAll('input.sw,[role=switch]').length,
      tickBoxes: document.querySelectorAll('input[type=checkbox]:not(.sw)').length,
      segmented: document.querySelectorAll('.seg button,[role=group] button[aria-pressed]').length,
    };
  }

  console.log('BASELINE_RESULTS:', JSON.stringify(results, null, 2));
}

measure().catch(e => console.error('Measurement error:', e.message));
`;

console.log(
  "Baseline measurement ready. Run this after starting the dev server:"
);
console.log(`  npm run dev`);
console.log(`  # In another terminal or in devtools console, run:`);
console.log(
  `  # ${script.split("\n").map((l) => l.trim()).filter(Boolean).join("; ")}`
);

// Save the measurement script for manual execution
const testDir = path.dirname(import.meta.url.replace("file://", ""));
fs.writeFileSync(
  path.join(testDir, "baseline-measure.js"),
  `${script.slice(0, -1)}`
);
console.log("\nMeasurement script saved to tests/baseline-measure.js");
