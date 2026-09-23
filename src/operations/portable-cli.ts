import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortableBinary, packagedSizeBytes } from "./portable-build.js";
import { measurePortableLaunch } from "./portable-launch.js";
import { currentHostTarget, declaredPortableTargets, matchTarget } from "./portable-targets.js";

/** src/operations/portable-cli.ts -> src/operations -> src -> project root. */
const packageRootHere = (): string => dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * `branch portable` — the owner-facing door onto FQ-operations.portable: build the single-file
 * executable for this computer's declared target, launch it for real, and print what it measured.
 */
export async function portableCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  const asJson = argv.includes("--json");

  if (sub === "targets") {
    const targets = declaredPortableTargets();
    if (asJson) {
      console.log(JSON.stringify({ targets, thisComputer: currentHostTarget(), supported: matchTarget() !== null }, null, 2));
      return 0;
    }
    console.log("Declared supported targets for the single-binary build:");
    for (const target of targets) console.log(`  ${target.platform}-${target.arch}  ${target.label}`);
    const here = currentHostTarget();
    console.log(`\nThis computer: ${here.platform}-${here.arch} ${matchTarget() ? "(supported)" : "(not declared — build will refuse)"}`);
    return 0;
  }

  if (sub !== "build" && sub !== undefined) {
    console.error("Usage: branch portable build [--out <folder>] [--json]  |  branch portable targets [--json]");
    return 1;
  }

  const outDir = flagValue(argv, "--out") ?? join(tmpdir(), `branch-portable-${Date.now()}`);
  const root = packageRootHere();

  const built = await buildPortableBinary({ root, outDir });
  if (!built.ok) {
    if (asJson) { console.log(JSON.stringify(built, null, 2)); return 1; }
    console.error(`Could not build the portable binary (${built.reason}).${built.detail ? ` ${built.detail}` : ""}`);
    return 1;
  }

  const diskBytes = await packagedSizeBytes(outDir);
  const report = await measurePortableLaunch({ binaryPath: built.binaryPath!, target: built.target!, diskBytes });

  if (asJson) {
    console.log(JSON.stringify({ ok: true, binaryPath: built.binaryPath, outDir, ...report }, null, 2));
    return 0;
  }
  console.log(`Packaged binary: ${built.binaryPath}`);
  console.log(`Target: ${report.target.label} (${report.target.platform}-${report.target.arch})`);
  console.log(`Cold start: ${report.coldStartMs} ms`);
  console.log(`Idle memory: ${report.idleMemoryMb.toFixed(1)} MB`);
  console.log(`Task memory: ${report.taskMemoryMb.toFixed(1)} MB`);
  console.log(`CPU time: ${report.cpuSeconds.toFixed(2)} s`);
  console.log(`Disk (binary + shipped program): ${(report.diskBytes / 1048576).toFixed(1)} MB`);
  return 0;
}
