#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const finalTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertReleaseVersion(tag, version) {
  if (!finalTag.test(tag) || tag.slice(1) !== version)
    throw new Error(`Release tag ${tag} must match package version ${version} exactly.`);
}

export function trustedExactRun(payload, { sha, repo, branch = "mac/cross-platform" }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Release commit must be a full SHA-1.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Release repository is invalid.");
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const trusted = runs.filter((run) =>
    run.path === ".github/workflows/checks.yml" &&
    (run.event === "push" || run.event === "workflow_dispatch") &&
    run.head_branch === branch && run.head_sha === sha &&
    run.repository?.full_name === repo && run.head_repository?.full_name === repo);
  if (trusted.some((run) => !Number.isSafeInteger(run.id) || run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
    !Number.isFinite(Date.parse(run.created_at)))) return null;
  trusted.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) ||
    right.id - left.id || right.run_attempt - left.run_attempt);
  const newest = trusted[0];
  return newest?.status === "completed" && newest.conclusion === "success" ? newest : null;
}

async function main() {
  if (process.argv[2] === "--version") {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    assertReleaseVersion(process.argv[3] ?? "", manifest.version);
    return;
  }
  const [sha, repo] = process.argv.slice(2);
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const run = trustedExactRun(JSON.parse(input), { sha, repo });
  if (!run) process.exitCode = 1;
  else process.stdout.write(`${run.html_url ?? "Trusted exact Checks passed."}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
