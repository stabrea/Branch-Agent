/* The Windows console control counts and closes only what it started (tests/console-calibration.mjs). Stand-ins
   for the screen, the start and the close: no process is started and no window opens, on any system. */
import test from "node:test";
import assert from "node:assert/strict";
import { calibrate, ownedWindowSeen } from "./console-calibration.mjs";

const OWNED = 123;
/** A screen that shows `before` first, then `after` on every later look. */
function screen(before, after) {
  let looks = 0;
  return () => (looks++ === 0 ? before : after);
}
const run = (look, extra = {}) => {
  const closed = [];
  return calibrate({ look, start: () => OWNED, close: (pid) => closed.push(pid), wait: async () => {}, watchMs: 2000, ...extra })
    .then((result) => ({ ...result, closed }), (error) => ({ error, closed }));
};
const owner = { id: 10, name: "WindowsTerminal", parent: 4 };

test("the control counts the console it started, or the console host that console started", () => {
  assert.equal(ownedWindowSeen([{ id: OWNED, name: "cmd", parent: 50 }], OWNED), true);
  assert.equal(ownedWindowSeen([{ id: 124, name: "conhost", parent: OWNED }], OWNED), true);
  assert.equal(ownedWindowSeen([{ id: 999, name: "powershell", parent: 1 }], OWNED), false);
});

test("another program's console appearing meanwhile neither passes the control nor is closed by it", async () => {
  const result = await run(screen([owner], [owner, { id: 999, name: "powershell", parent: 1 }]));
  assert.equal(result.seen, false, "an unrelated console is not calibration");
  assert.deepEqual(result.others, ["powershell"], "it is reported, so a blind machine can be told from a filtered one");
  assert.deepEqual(result.closed, [OWNED], "only the control's own process tree is closed");
});

test("the control's own console is seen, and it alone is closed", async () => {
  const result = await run(screen([owner], [owner, { id: 999, name: "powershell", parent: 1 }, { id: 124, name: "conhost", parent: OWNED }]));
  assert.equal(result.seen, true);
  assert.deepEqual(result.closed, [OWNED]);
});

test("a look that fails still closes the control's own console, and only it", async () => {
  let looks = 0;
  const result = await run(() => { if (looks++ === 0) return [owner]; throw new Error("PowerShell could not start"); });
  assert.match(String(result.error), /PowerShell could not start/);
  assert.deepEqual(result.closed, [OWNED]);
});
