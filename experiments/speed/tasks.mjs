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

/**
 * The same shape again, but over a project big enough that the tools themselves take real time.
 * On small files a tool call is a millisecond or two and running calls one after another costs
 * nothing worth measuring; this is the row that says what running them together is worth. Its
 * `seed` builds a 300-file project, so a grep over it is tens of milliseconds rather than one.
 */
export const searchProject = {
  name: "search-project",
  prompt: "Find where the version, the defaults, the exports and the helpers live in this project.",
  seed: async (workspace) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(workspace, "src"), { recursive: true });
    for (let n = 0; n < 300; n++)
      await writeFile(join(workspace, "src", `f${n}.js`),
        `// file ${n}\nexport const version = "1.0.${n}";\nexport const defaults = { n: ${n} };\n`.repeat(40));
  },
  perCall: [
    step([["files.grep", { query: "version", path: "src" }]]),
    step([["files.grep", { query: "defaults", path: "src" }]]),
    step([["files.grep", { query: "export", path: "src" }]]),
    step([["files.grep", { query: "file", path: "src" }]]),
    answer("Found them."),
  ],
  batched: [
    step([["files.grep", { query: "version", path: "src" }], ["files.grep", { query: "defaults", path: "src" }],
          ["files.grep", { query: "export", path: "src" }], ["files.grep", { query: "file", path: "src" }]]),
    answer("Found them."),
  ],
};

export const tasks = [fixRange, rename, searchProject];
