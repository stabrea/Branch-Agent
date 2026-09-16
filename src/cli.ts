#!/usr/bin/env node
import { resolve } from "node:path";
import { createBranch } from "./index.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPreset, presetsFromEnv } from "./providers.js";
import { ChatGPTAuth, FileTokenVault } from "./chatgpt-auth.js";
import { finishChatGPTSignIn, syncChatGPTPresets } from "./chatgpt-presets.js";
import { DemoProvider } from "./demo.js";
import { startServer } from "./server.js";
import { loadIntegrations } from "./integrations/bootstrap.js";
import { startTerminal } from "./terminal.js";
import { serveMcpStdio } from "./mcp-stdio.js";
import { serveAcpStdio } from "./acp.js";
import { healthReport } from "./health.js";
import { summaryLine } from "./evaluation-runner.js";
import { readFile, writeFile } from "node:fs/promises";

async function configuredApp(options: Parameters<typeof createBranch>[0]) {
  const app = await createBranch(options);
  try {
    const integrations = await loadIntegrations(
      app.registry,
      process.env.BRANCH_INTEGRATIONS,
      process.env,
      app.secretsFor,
      app.channelHost,
    );
    app.browser = integrations.hosted.browser ?? null;
    return {
      app,
      close: async () => {
        try {
          await integrations.close();
        } finally {
          await app.close();
        }
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function serve(
  app: Awaited<ReturnType<typeof createBranch>>,
  dataDir: string,
  close: () => Promise<void>,
): Promise<void> {
  const port = Number(process.env.BRANCH_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid BRANCH_PORT");
  const server = await startServer(app, { dataDir, port });
  console.log(
    `Branch Agent listening at ${server.url}\nProvider: ${app.runtime.provider.name}\nWorkspace: ${app.runtime.workspace}\nLocal session token (paste into browser): ${server.token}`,
  );
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void server
      .close()
      .finally(close)
      .catch((error) =>
        console.error(error instanceof Error ? error.message : String(error)),
      );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  if (command === "update") return updateCheckout();
  if (!["start", "run", "chat", "demo", "doctor", "login", "logout", "trigger", "backup", "restore", "eval", "mcp-serve", "acp-serve"].includes(command))
    throw new Error(
      "Usage: node dist/cli.js start | chat | run <prompt> [--dry-run] | demo | doctor [--probe] | login | logout | trigger <schedule-id> | backup <file> | restore <file> | mcp-serve | acp-serve | update",
    );
  const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace"),
    dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
  const presets = command === "demo" ? [defaultPreset(new DemoProvider())] : presetsFromEnv();
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(dataDir, "chatgpt-auth.json")), { userAgent: "BranchAgent" });
  const { app, close } = await configuredApp({ workspace, dataDir, presets, chatgpt });
  if (command === "start") {
    try {
      await serve(app, dataDir, close);
    } catch (error) {
      await close();
      throw error;
    }
    return;
  }
  try {
    if (command === "trigger") {
      const id = process.argv[3];
      if (!id) throw new Error("Provide a schedule id: node dist/cli.js trigger <schedule-id>");
      const run = await app.scheduler.trigger(app.runtime.owner, id, undefined, "local");
      console.log(JSON.stringify({ run, events: app.store.events(run.id) }, null, 2));
      if (run.status !== "completed") process.exitCode = 1;
    } else if (command === "login") await loginChatGPT(app);
    else if (command === "logout") {
      await app.chatgpt!.signOut();
      syncChatGPTPresets(app.runtime.models, app.chatgpt!, false, app.userAgent);
      console.log("Signed out of ChatGPT.");
    } else if (command === "chat") {
      await startTerminal(app.runtime);
      return;
    } else if (command === "mcp-serve") {
      await serveMcpStdio(app.mcpServer);
      return;
    } else if (command === "acp-serve") {
      await serveAcpStdio(app.runtime, app.store);
      return;
    }
    if (command === "doctor") {
      await printDoctor(app, dataDir);
      return;
    }
    if (command === "backup") {
      const target = process.argv[3];
      if (!target) throw new Error("Provide a file: node dist/cli.js backup <file>");
      await writeFile(target, JSON.stringify(app.store.backup(app.version)), { mode: 0o600 });
      console.log(`Backup written to ${target}. Secrets are not included; they stay on this device.`);
      return;
    }
    if (command === "eval") {
      await runEvaluation(app);
      return;
    }
    if (command === "restore") {
      const source = process.argv[3];
      if (!source) throw new Error("Provide a file: node dist/cli.js restore <file>");
      console.log(JSON.stringify(app.store.restore(JSON.parse(await readFile(source, "utf8")))));
      return;
    }
    await runOnce(app, command);
  } finally {
    await close();
  }
}
async function runOnce(
  app: Awaited<ReturnType<typeof createBranch>>,
  command: string,
): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const prompt = command === "demo"
    ? "Run the deterministic file write/read/verify fixture."
    : process.argv.slice(3).filter((word) => word !== "--dry-run").join(" ");
  if (!prompt)
    throw new Error('Provide a prompt: node dist/cli.js run "your request"');
  const run = await app.runtime.run({ prompt, ...(dryRun ? { dryRun: true } : {}) });
  console.log(JSON.stringify({
    run,
    usage: app.store.usage(run.id),
    events: app.store.events(run.id),
  }, null, 2));
  if (run.status !== "completed") process.exitCode = 1;
}
/** The value after a flag on the command line, for example `--suite everyday`. */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}
/**
 * `branch eval [--suite <id>] [--preset <id>] [--compare a,b] [--json]`. Without a suite it runs
 * the standard three-task suite, as it always has.
 */
async function runEvaluation(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const asJson = process.argv.includes("--json"), suite = flag("suite"), compare = flag("compare");
  if (compare) {
    const result = await app.evaluationSuites.compare({ suite: suite ?? "cost", presets: compare.split(",").map((part) => part.trim()).filter(Boolean) });
    if (asJson) return void console.log(JSON.stringify(result, null, 2));
    console.log(["model choice", "right", "accuracy", "mean ms", "tokens", "cost"].join("\t"));
    for (const row of result.rows)
      console.log([row.preset, `${row.passed}/${row.total}`, row.accuracy, row.meanMs, row.tokens, row.dollars === null ? "no price on file" : `$${row.dollars.toFixed(4)}`].join("\t"));
    return void console.log(`\nBest on this suite: ${result.best ?? "none"}`);
  }
  if (!suite) return void console.log(JSON.stringify(await app.evaluation.run(app.runtime), null, 2));
  const result = await app.evaluationSuites.run({ suite, ...(flag("preset") ? { preset: flag("preset")! } : {}) });
  if (asJson) return void console.log(JSON.stringify(result, null, 2));
  console.log(["task", "result", "score", "ms", "tokens", "why"].join("\t"));
  for (const task of result.tasks)
    console.log([task.id, task.skipped ? "skipped" : task.passed ? "passed" : "failed", task.score, task.ms, task.tokens, task.problem ?? ""].join("\t"));
  console.log(`\n${summaryLine(result)}`);
  if (!result.summary.total || result.summary.passed < result.summary.total) process.exitCode = 1;
}
async function loginChatGPT(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const auth = app.chatgpt!;
  const prompt = await auth.startDeviceLogin();
  console.log(`\nTo connect your ChatGPT account:\n\n  1. Open ${prompt.verificationUrl}\n  2. Enter this code: ${prompt.userCode}\n\nWaiting for you to finish in the browser...`);
  const status = await finishChatGPTSignIn(app.runtime.models, auth, app.runtime.owner, app.userAgent);
  console.log(`Signed in${status.email ? " as " + status.email : ""}. ChatGPT models are now available.`);
}
/** Refreshes a source checkout in place: pull, install exact dependencies, rebuild. */
function updateCheckout(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(root, ".git")))
    throw new Error("This copy was not installed from Git. Download the newest release from GitHub instead.");
  const steps: [string, string[]][] = [["git", ["pull", "--ff-only"]], ["npm", ["ci"]], ["npm", ["run", "build"]]];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  }
  console.log("Branch Agent is up to date. Restart it to use the new version.");
}
async function printDoctor(
  app: Awaited<ReturnType<typeof createBranch>>,
  dataDir: string,
): Promise<void> {
  const health = await healthReport(app, { probeProvider: process.argv.includes("--probe") });
  console.log(
    JSON.stringify(
      {
        health,
        node: process.version,
        sqlite: "opened",
        workspace: app.runtime.workspace,
        dataDir,
        provider: app.runtime.provider.name,
        modelPresets: [...app.runtime.models.presets.values()].map((preset) => ({
          id: preset.id, name: preset.name, provider: preset.provider.name, model: preset.model,
        })),
        registeredTools: app.registry.permissions(),
        networkProviderTested: false,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
