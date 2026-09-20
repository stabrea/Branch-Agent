/**
 * Switches the "fewer rounds" coding part on in a fresh data folder before a bench cell, for the
 * `branch-speed-on` row only. That row answers one question: how many times a coding task goes back
 * to the model with the part on, against the same build with it off (as it ships).
 *
 *   BRANCH_DATA_DIR=... BRANCH_WORKSPACE=... node experiments/coding-bench/fewer-rounds-on.mjs
 */
import { createBranch } from "../../dist/index.js";

const app = await createBranch({ dataDir: process.env.BRANCH_DATA_DIR, workspace: process.env.BRANCH_WORKSPACE });
app.coding.setMode("fewer-rounds", "on");
await app.close();
