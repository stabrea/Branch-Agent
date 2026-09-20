import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

/**
 * mac7/target-guard: every tool that can name a thing the owner's rules are meant to judge must say
 * what a call would touch.
 *
 * The bug this comes from: `files.read_many` named neither `target` nor `targets`. Its paths live in
 * `paths`, and `policyTarget` only reads a single `path` or `url`, so the call was judged with an
 * EMPTY target. A rule refusing `files.*` under `private/**` refused `files.read` of a file there
 * and let `files.read_many` of the very same file straight through. It passed every test it had,
 * because every test asked whether it behaved, not whether it was judged.
 *
 * So this does not test behaviour. It reads the shape of every registered tool's arguments, and a
 * tool whose arguments can name a file, a folder, a site, an account, a device or a person, and that
 * says nothing about what it touches, is an offender. A tool is an offender BY DEFAULT: the only way
 * out is TARGETLESS below, which costs somebody a written sentence.
 */

/**
 * Argument names that name a thing the rules judge. `path` and `url` are not here: `policyTarget`
 * reads those two itself, so a tool with only those is already judged.
 */
const NAMES_A_THING =
  /^(paths|file|files|file_path|file_paths|filepath|folder|folders|dir|directory|directories|urls|host|hosts|site|sites|domain|domains|account|accounts|device|devices|person|people|recipient|recipients|repo|repository|workspace|project|projects|target|targets|source|sources|destination|to|against|from_path|to_path)$/i;

/**
 * Tools that genuinely touch nothing the rules judge. Each one costs a sentence saying why. Adding
 * a name here is a decision somebody makes on purpose — that is the whole point of the list.
 */
const TARGETLESS = {
  "history.meaning": "`from` and `to` are dates bounding a search of conversations already kept, not places.",
  "learning.journey": "`from` and `to` are dates bounding a timeline, not places.",
  "memory.find": "`from` and `to` are dates bounding a search of facts already kept, not places.",
  "memory.put": "`source` is where a fact came from, written for a person to read; `project` is a name, not a folder.",
  "memory.update": "`source` is where a fact came from, written for a person to read, not a place to read from.",
  "projects.notes": "`project` is a project's name. The project's folder is judged when something opens it.",
  "labels.add": "`target` is a kind — conversation, procedure or document — beside `targetId`. Neither is a path.",
  "labels.list": "`target` is a kind, not a path.",
  "labels.remove": "`target` is a kind, not a path.",
  "knowledge.search": "`filter.files` narrows results inside a knowledge base already built; nothing is read from disk.",
  "context.read": "`file` is one of eight fixed instruction files by name, not a path the caller chooses.",
  "specialists.delegate": "`checks.files` is what the specialist's answer must account for. Every tool the specialist itself runs is judged on its own, with fewer permissions.",
};

/** Every argument name a tool's JSON Schema can carry, however deeply nested. */
function fieldNames(schema, found = new Set()) {
  if (!schema || typeof schema !== "object") return found;
  if (Array.isArray(schema)) { schema.forEach((one) => fieldNames(one, found)); return found; }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object")
      for (const name of Object.keys(value)) found.add(name);
    fieldNames(value, found);
  }
  return found;
}

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-targets-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return app;
}

/** Offenders, by the same reading the guard uses, so the guard and its proof cannot drift apart. */
function offendersIn(app) {
  const described = new Map(
    app.registry.descriptions(new Set(app.registry.permissions?.() ?? []), { diet: false })
      .map((tool) => [tool.name, tool.parameters]),
  );
  const offenders = [];
  for (const name of app.registry.names()) {
    const says = app.registry.declaresTarget(name);
    if (says.target || says.targets) continue;
    if (Object.hasOwn(TARGETLESS, name)) continue;
    const named = [...fieldNames(described.get(name) ?? {})].filter((field) => NAMES_A_THING.test(field));
    if (named.length) offenders.push(`${name}: names ${named.join(", ")} and says nothing about what it touches`);
  }
  return offenders.sort();
}

test("every tool that can name a thing the rules judge says what it touches", async (t) => {
  const app = await branch(t);
  assert.ok(app.registry.names().length > 100, "the registry is empty, so this test would prove nothing");
  assert.deepEqual(offendersIn(app), [],
    "these calls would be judged against an empty target, exactly as files.read_many was");
});

/**
 * The proof. A tool that names paths and says nothing must be CAUGHT — not waved through, and not
 * silently swallowed by a `catch`. Without this, the test above is green whether it works or not.
 */
test("the guard catches a new tool that names paths and says nothing", async (t) => {
  const app = await branch(t);
  assert.deepEqual(offendersIn(app), [], "start from clean, or this proof means nothing");

  app.registry.register({
    name: "fake.sweep", description: "A stand-in that reads many files and says nothing about them.",
    permission: "read", parameters: z.object({ paths: z.array(z.string()).max(5) }),
    execute: async () => ({}),
  });
  try {
    const caught = offendersIn(app);
    assert.ok(caught.some((one) => one.startsWith("fake.sweep:")),
      `the guard did not catch a tool with the shape of the original bug: ${JSON.stringify(caught)}`);
  } finally {
    app.registry.remove?.("fake.sweep");
  }
  assert.deepEqual(offendersIn(app), [], "the stand-in was not taken away again");
});

/** A tool that DOES say what it touches must not be reported, or the guard is just noise. */
test("a tool that says what it touches is not reported", async (t) => {
  const app = await branch(t);
  app.registry.register({
    name: "fake.tidy", description: "A stand-in that reads many files and names every one.",
    permission: "read", parameters: z.object({ paths: z.array(z.string()).max(5) }),
    targets: (args) => args.paths.map((path) => ({ kind: "file", value: path })),
    execute: async () => ({}),
  });
  try {
    assert.ok(!offendersIn(app).some((one) => one.startsWith("fake.tidy:")),
      "a tool that names its targets was reported anyway");
  } finally {
    app.registry.remove?.("fake.tidy");
  }
});

/** Nobody may empty the list by writing nothing in it. */
test("every tool excused from naming a target has a written reason", () => {
  const empty = Object.entries(TARGETLESS).filter(([, why]) => typeof why !== "string" || why.trim().length < 20);
  assert.deepEqual(empty.map(([name]) => name), [], "excused without a real reason");
});
