import test from "node:test";
import assert from "node:assert/strict";
import { GitHubAccess, repositoryName, repositoryPath } from "../dist/integrations/github.js";
import { registerGitHub } from "../dist/integrations/git-tools.js";
import { ToolRegistry } from "../dist/registry.js";

/**
 * GitHub allows neither "." nor ".." as an owner or a repository name, so a repository written that
 * way is refused before anything is sent. Names that only contain or start with a dot, such as an
 * organisation's ".github" repository, are real and still pass. Nothing here leaves this computer:
 * the network rules and the fetch are stand-ins.
 */
const allowAll = { assertAllowed: async () => {} };
const token = async () => "stand-in-token";

function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function githubTools(fetchImpl) {
  const registry = new ToolRegistry();
  registerGitHub(registry, new GitHubAccess({}, allowAll, token, fetchImpl));
  const context = {
    runId: "repository-names", workspace: "", depth: 0, signal: new AbortController().signal,
    permissions: new Set(["github.manage"]), budget: { step: () => undefined },
  };
  return { registry, context };
}

test("an owner or a repository name written as . or .. is refused", () => {
  const paths = ["..", ".", "../x", "x/..", "./x", "x/.", "../.."];
  assert.deepEqual(paths.filter((value) => repositoryPath.safeParse(value).success), [], "each of these should be refused");
});

test("a new repository cannot be named . or ..", () => {
  assert.deepEqual([".", ".."].filter((value) => repositoryName.safeParse(value).success), [], "each of these should be refused");
});

test("names that only contain or start with a dot still pass", () => {
  for (const value of ["owner/.github", "a.b/c.d", "my-org/repo.js"])
    assert.equal(repositoryPath.safeParse(value).success, true, `${value} is a real repository`);
  assert.equal(repositoryName.safeParse(".github").success, true);
});

test("the issue list refuses a repository written with .. before any request is made", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const { registry, context } = githubTools(fetchImpl);
  const refused = await registry.execute("github.issues", { repo: "x/.." }, context).then(() => null, (error) => error);
  assert.deepEqual(calls, [], "nothing may be sent for this repository");
  assert.match(String(refused?.message), /The owner and the name cannot be \. or \.\./);

  // The same tool with a real name that starts with a dot does reach the stand-in.
  const listed = await registry.execute("github.issues", { repo: "owner/.github" }, context);
  assert.equal(listed.repository, "owner/.github");
  assert.deepEqual(calls, ["GET /repos/owner/.github/issues"]);
});

/**
 * A tool's pattern cannot hold a lookahead (see wire-safe-patterns.test.mjs). The GitHub tools are
 * only offered once GitHub is set up, so that test never sees them; this one does.
 */
test("the GitHub tools the model is shown keep plain patterns, with no lookahead", () => {
  const { registry } = githubTools(recordingFetch().fetchImpl);
  const described = registry.descriptions(new Set(["github.manage"]), { diet: false });
  const patterns = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node))
      if (key === "pattern" && typeof value === "string") patterns.push(value);
      else walk(value);
  };
  described.forEach((tool) => walk(tool.parameters));
  const repo = described.find((tool) => tool.name === "github.issues")?.parameters.properties?.repo?.pattern;
  assert.ok(repo, "the repository pattern was not found, so this test would prove nothing");
  assert.deepEqual(patterns.filter((pattern) => /\((\?=|\?!|\?<=|\?<!)/.test(pattern)), []);
});
