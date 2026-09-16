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
import { startTui } from "./terminal-tui.js";
import { looksInteractive } from "./terminal-style.js";
import { completionScript, usageText } from "./cli-completion.js";
import {
  answerFromCommand, applyPreset, exitCodeFor, parseRunArgs, runForScripts, statusSnapshot,
  timelineLines, type RunFlags,
} from "./cli-run.js";
import { serveMcpStdio } from "./mcp-stdio.js";
import { healthReport } from "./health.js";
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
  // Printing a completion script or the command list needs no workspace, database or integrations.
  if (command === "completion") { console.log(completionScript(process.argv[3] ?? "")); return; }
  if (["help", "--help", "-h"].includes(command)) { console.log(usageText()); return; }
  if (!["start", "run", "chat", "status", "logs", "approve", "demo", "doctor", "login", "logout", "trigger", "backup", "restore", "eval", "mcp-serve"].includes(command))
    throw new Error(`${usageText()}\n\nI do not know the command "${command}".`);
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
      // The full view needs a terminal that can be drawn on; anything else gets the plain stream.
      const full = looksInteractive(process.env, process.stdout.isTTY) && !process.argv.includes("--plain");
      await (full ? startTui(app.runtime) : startTerminal(app.runtime));
      return;
    } else if (command === "status") { await printStatus(app); return; }
    else if (command === "logs") { printLogs(app); return; }
    else if (command === "approve") { printApproval(app); return; }
    else if (command === "mcp-serve") {
      await serveMcpStdio(app.mcpServer);
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
      console.log(JSON.stringify(await app.evaluation.run(app.runtime), null, 2));
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
/**
 * `branch run` and `branch demo`. With `--json` every event goes to stdout as one JSON object per
 * line while the task works, and the human wording goes to stderr, so a script can read one and a
 * person can watch the other. The exit code says what happened: see `exitCodeFor`.
 */
async function runOnce(
  app: Awaited<ReturnType<typeof createBranch>>,
  command: string,
): Promise<void> {
  const flags: RunFlags = parseRunArgs(process.argv.slice(3));
  if (command === "demo") flags.prompt = "Run the deterministic file write/read/verify fixture.";
  if (!flags.prompt) throw new Error('Provide a prompt: branch run "your request"');
  if (flags.preset) console.error(`[when to check with me: ${applyPreset(app.store, app.runtime.owner, flags.preset)}]`);
  const writer = {
    line: (value: unknown) => { if (flags.json) process.stdout.write(JSON.stringify(value) + "\n"); },
    note: (text: string) => console.error(text),
  };
  const run = await runForScripts(app.runtime, flags, writer);
  if (flags.json) {
    writer.line({ type: "run", run, usage: app.store.usage(run.id), exitCode: exitCodeFor(run.status) });
    writer.note(run.status === "completed" ? run.output : `[task ${run.status}] ${run.output}`);
  } else console.log(JSON.stringify({ run, usage: app.store.usage(run.id), events: app.store.events(run.id) }, null, 2));
  process.exitCode = exitCodeFor(run.status);
}
/** Tasks working now, questions waiting for an answer, and the health summary. */
async function printStatus(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const snapshot = statusSnapshot(app.runtime);
  const health = await healthReport(app, { probeProvider: false });
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ ...snapshot, health }, null, 2)); return; }
  console.log(`When to check with me: ${snapshot.approvalPreset}`);
  console.log(snapshot.running.length ? "Working now:" : "Nothing is working right now.");
  for (const run of snapshot.running) console.log(`  ${run.id} — ${run.prompt}`);
  for (const waiting of snapshot.waitingForYou) console.log(`  waiting for you: ${waiting.id} — ${waiting.question}`);
  console.log(health.ok ? "Everything checks out." : "Some checks need attention:");
  for (const check of health.items) console.log(`  ${check.ok ? "ok" : "x "} ${check.name}: ${check.summary}`);
}
function printLogs(app: Awaited<ReturnType<typeof createBranch>>): void {
  const runId = process.argv[3];
  if (!runId) throw new Error("Name a task: branch logs <task id>");
  if (process.argv.includes("--json")) {
    for (const event of app.store.events(runId)) process.stdout.write(JSON.stringify(event) + "\n");
    return;
  }
  for (const line of timelineLines(app.store, runId)) console.log(line);
}
function printApproval(app: Awaited<ReturnType<typeof createBranch>>): void {
  const [, , , id, answer] = process.argv;
  if (!id || !answer) throw new Error("Answer a task: branch approve <task id> yes|no");
  const result = answerFromCommand(app.runtime, id, answer);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(result)); return; }
  console.log(result.decision === "allow"
    ? `Noted: ${result.rule} may go ahead from now on. Run the task again to carry on.`
    : `Noted: ${result.rule} is not allowed from now on.`);
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
