/**
 * A change to the shape of the saved work, killed part-way through, for
 * tests/never-break-install-chaos-*.test.mjs (split into 4 parts). It is a whole process so the kill is a real one: the
 * database is left exactly as a power cut would leave it, not as a thrown error would.
 *
 * Arguments: <database> <step to be killed at> <round>. It never finishes, by design.
 */
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../dist/never-break/migrations.js";

const [path, killAt, round] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
const db = new DatabaseSync(path);
let step = 0;
const cutOff = () => { if (step++ === killAt) process.kill(process.pid, "SIGKILL"); };

/** The same change the test's "newer version" knows, one statement at a time so a kill can land inside it. */
const steps = [
  { version: 1, readableBy: 1, up: () => undefined, down: () => undefined },
  {
    version: 2, readableBy: 1,
    up: (database) => {
      for (const sql of [
        "ALTER TABLE notes ADD COLUMN extra TEXT",
        "UPDATE notes SET extra='moved'",
        "CREATE TABLE IF NOT EXISTS more(x TEXT)",
        "INSERT INTO more VALUES('filled in')",
      ]) { cutOff(); database.exec(sql); }
      cutOff();
    },
    down: (database) => database.exec("ALTER TABLE notes DROP COLUMN extra"),
  },
];

migrate(db, steps, { backupTo: null });
db.close();
console.log(`round ${round} finished without being cut off`);
process.exit(0);
