/**
 * Recounts Branch's edit attempts and refusals from each cell's own database, after a window.
 * Window 3 was started with a count that missed code.patch and code.change_set; the databases are
 * kept per cell, so the right numbers can be read back rather than the window run again.
 *
 *   node recount-edits.mjs <results.jsonl> <state-dir>  > fixed.jsonl
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [resultsPath, stateDir] = process.argv.slice(2);
const tools = "('files.edit','files.patch','files.write','code.patch','code.change_set')";
for (const line of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
  const row = JSON.parse(line);
  const file = join(stateDir, `${row.contestant}__${row.task}__r${row.repeat}`, "branch.sqlite");
  if (row.contestant.startsWith("branch") && existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    const count = (kind) => db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = ? AND json_extract(data, '$.name') IN ${tools}`).get(kind).n;
    row.edits = count("tool.started");
    row.failedEdits = count("tool.failed");
    row.nudges = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'model.empty_reply'").get().n;
    row.finish = db.prepare("SELECT data FROM events WHERE kind = 'run.finished' ORDER BY id DESC LIMIT 1").get()?.data ?? null;
    db.close();
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
