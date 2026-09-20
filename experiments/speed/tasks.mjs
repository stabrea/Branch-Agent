/**
 * The scripted coding tasks the stopwatch runs. Each one is the same piece of work written two
 * ways: `perCall`, one tool call a round (what a model does when nothing tells it otherwise), and
 * `batched`, the same calls packed into as few rounds as the work allows (what Codex does).
 * The pair is the whole point: it says what packing calls together is worth, with the model's own
 * thinking time held equal.
 */
import { step, answer } from "./harness.mjs";

const read = (path) => ["files.read", { path }];
const edit = (path, find, replace) => ["files.edit", { path, find, replace }];

/** Fix an off-by-one after reading the file and its neighbours — the bench's first task, in shape. */
export const fixRange = {
  name: "fix-range",
  prompt: "range(1, 5) should include 5. Fix it in src/range.js and check the two files beside it.",
  perCall: [
    step([read("src/range.js")]),
    step([read("src/sum.js")]),
    step([read("src/mean.js")]),
    step([edit("src/range.js", "n < end", "n <= end")]),
    step([read("src/range.js")]),
    answer("range now includes the end."),
  ],
  batched: [
    step([read("src/range.js"), read("src/sum.js"), read("src/mean.js")]),
    step([edit("src/range.js", "n < end", "n <= end"), read("README.md")]),
    step([read("src/range.js")]),
    answer("range now includes the end."),
  ],
};

/** A wider change: read four files, edit two, look again. */
export const rename = {
  name: "rename",
  prompt: "Rename the helper in src/sum.js from sum to total everywhere it is used.",
  perCall: [
    step([read("src/sum.js")]),
    step([read("src/mean.js")]),
    step([read("src/range.js")]),
    step([read("README.md")]),
    step([edit("src/sum.js", "export const sum", "export const total")]),
    step([edit("src/mean.js", "import { sum }", "import { total }")]),
    step([read("src/mean.js")]),
    step([read("src/sum.js")]),
    answer("Renamed."),
  ],
  batched: [
    step([read("src/sum.js"), read("src/mean.js"), read("src/range.js"), read("README.md")]),
    step([edit("src/sum.js", "export const sum", "export const total"),
          edit("src/mean.js", "import { sum }", "import { total }")]),
    step([read("src/mean.js"), read("src/sum.js")]),
    answer("Renamed."),
  ],
};

export const tasks = [fixRange, rename];
