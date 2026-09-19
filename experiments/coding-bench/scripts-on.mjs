/**
 * Switches Branch's "run scripts" setting on in a fresh data folder before a bench cell, for the
 * `branch-after-scripts` row only. That row answers one question for the owner: what the switch
 * that ships off is worth on coding work. Everything else about the row is the branch-after build.
 *
 *   BRANCH_DATA_DIR=... BRANCH_WORKSPACE=... node experiments/coding-bench/scripts-on.mjs
 */
import { createBranch } from "../../dist/index.js";

const app = await createBranch({ dataDir: process.env.BRANCH_DATA_DIR, workspace: process.env.BRANCH_WORKSPACE });
app.store.save("settings", app.runtime.owner, "code-run", { enabled: true });
await app.close();
