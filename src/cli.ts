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
  if (!["start", "run", "chat", "demo", "doctor", "login", "logout", "trigger"].includes(command))
    throw new Error(
      "Usage: node dist/cli.js start | chat | run <prompt> | demo | doctor | login | logout | trigger <schedule-id> | update",
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
    }
    if (command === "doctor") {
      printDoctor(app, dataDir);
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
  const prompt = command === "demo"
    ? "Run the deterministic file write/read/verify fixture."
    : process.argv.slice(3).join(" ");
  if (!prompt)
    throw new Error('Provide a prompt: node dist/cli.js run "your request"');
  const run = await app.runtime.run({ prompt });
  console.log(JSON.stringify({
    run,
    usage: app.store.usage(run.id),
    events: app.store.events(run.id),
  }, null, 2));
  if (run.status !== "completed") process.exitCode = 1;
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
function printDoctor(
  app: Awaited<ReturnType<typeof createBranch>>,
  dataDir: string,
): void {
  console.log(
    JSON.stringify(
      {
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
