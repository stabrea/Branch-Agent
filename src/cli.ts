import { resolve } from "node:path";
import { createBranch } from "./index.js";
import { providerFromEnv } from "./providers.js";
import { DemoProvider } from "./demo.js";
import { startServer } from "./server.js";
import { loadIntegrations } from "./integrations/bootstrap.js";

async function configuredApp(options: Parameters<typeof createBranch>[0]) {
  const app = await createBranch(options);
  try {
    const integrations = await loadIntegrations(
      app.registry,
      process.env.BRANCH_INTEGRATIONS,
    );
    return {
      app,
      close: async () => {
        try {
          await integrations.close();
        } finally {
          app.close();
        }
      },
    };
  } catch (error) {
    app.close();
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
    `Branch listening at ${server.url}\nProvider: ${app.runtime.provider.name}\nWorkspace: ${app.runtime.workspace}\nLocal session token (paste into browser): ${server.token}`,
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
  if (!["start", "run", "demo", "doctor"].includes(command))
    throw new Error(
      "Usage: node dist/cli.js start | run <prompt> | demo | doctor",
    );
  const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace"),
    dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
  const provider = command === "demo" ? new DemoProvider() : providerFromEnv();
  const { app, close } = await configuredApp({ workspace, dataDir, provider });
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
    if (command === "doctor") {
      printDoctor(app, dataDir);
      return;
    }
    const prompt =
      command === "demo"
        ? "Run the deterministic file write/read/verify fixture."
        : process.argv.slice(3).join(" ");
    if (!prompt)
      throw new Error('Provide a prompt: node dist/cli.js run "your request"');
    const run = await app.runtime.run({ prompt });
    console.log(
      JSON.stringify(
        {
          run,
          usage: app.store.usage(run.id),
          events: app.store.events(run.id),
        },
        null,
        2,
      ),
    );
    if (run.status !== "completed") process.exitCode = 1;
  } finally {
    await close();
  }
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
