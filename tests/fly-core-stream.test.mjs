import test from "node:test";
import assert from "node:assert/strict";
import { summarise } from "../experiments/fly-core/stream.mjs";

/**
 * Does the learning core actually get better with use? The synthetic stream in
 * experiments/fly-core/stream.mjs is run over five seeds and the averages are compared. The
 * margins asserted are well under what the stream shows (see experiments/fly-core/PLAN.md for the
 * measured table), so a failure here means learning has really stopped working, not noise.
 */
const summary = summarise([1, 2, 3, 4, 5]);
const blocks = summary.blocks;
const half = blocks.length / 2;
const late = (name, from, to, field = "success") =>
  blocks.slice(from, to).reduce((sum, block) => sum + block[name][field], 0) / (to - from);

test("L1 the core's picks improve over repeats", () => {
  const first = blocks[0].fly.success, settled = late("fly", half - 2, half);
  assert.ok(settled > first + 0.15, `success went from ${first} to ${settled}; learning should add at least 15 points`);
});

test("L2 the core beats no learning and a plain frequency counter once it has learned", () => {
  const fly = late("fly", half - 2, half);
  assert.ok(fly > late("none", half - 2, half) + 0.3, `fly ${fly} vs none ${late("none", half - 2, half)}`);
  assert.ok(fly > late("frequency", half - 2, half) + 0.25, `fly ${fly} vs frequency ${late("frequency", half - 2, half)}`);
  assert.ok(fly > late("similar-prompts", half - 2, half) + 0.15,
    `fly ${fly} vs Branch's current similar-request habit ${late("similar-prompts", half - 2, half)}`);
});

test("L3 when what used to work stops working, the core relearns", () => {
  const end = blocks.length;
  const fly = late("fly", end - 2, end);
  assert.ok(blocks[half].fly.success < 0.35, "right after the change the old habit fails, as it should");
  assert.ok(fly > 0.55, `and by the end it has recovered (${fly})`);
  for (const other of ["none", "frequency", "similar-prompts"])
    assert.ok(fly > late(other, end - 2, end) + 0.2, `fly ${fly} vs ${other} ${late(other, end - 2, end)} after the change`);
});
