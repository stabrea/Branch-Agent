import { mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Store } from "./store.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceFiles, registerFiles } from "./files.js";
import { Runtime } from "./runtime.js";
import { DemoProvider } from "./demo.js";
import { Knowledge, registerMemory, registerKnowledge } from "./knowledge.js";
import { Scheduler, registerSchedules } from "./scheduler.js";
import { registerHistory } from "./history.js";
import type { Provider } from "./contracts.js";

export async function createBranch(options: {
  workspace: string;
  dataDir: string;
  provider?: Provider;
  owner?: string;
}) {
  const workspace = resolve(options.workspace),
    dataDir = resolve(options.dataDir);
  const dataRelative = relative(workspace, dataDir);
  if (
    dataRelative === "" ||
    (!dataRelative.startsWith("..") && !isAbsolute(dataRelative))
  )
    throw new Error(
      "Private data directory must be outside the tool workspace",
    );
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const files = new WorkspaceFiles(workspace);
  await files.checked(".", true);
  const store = new Store(join(dataDir, "branch.sqlite"));
  const registry = new ToolRegistry();
  registerFiles(registry, files);
  const runtime = new Runtime(
    store,
    registry,
    options.provider ?? new DemoProvider(),
    workspace,
    options.owner ?? "local",
  );
  const knowledge = new Knowledge(store, registry, runtime);
  registerMemory(registry, store);
  registerHistory(registry, store);
  registerKnowledge(registry, knowledge);
  const scheduler = new Scheduler(store, runtime);
  registerSchedules(registry, scheduler);
  let closing: Promise<void> | undefined;
  return {
    store,
    registry,
    runtime,
    files,
    knowledge,
    scheduler,
    close: () => (closing ??= closeBranch(scheduler, runtime, store)),
  };
}
async function closeBranch(
  scheduler: Scheduler,
  runtime: Runtime,
  store: Store,
): Promise<void> {
  const schedulingStopped = scheduler.stop();
  await runtime.shutdown();
  await schedulingStopped;
  store.close();
}
export * from "./contracts.js";
export * from "./store.js";
export * from "./registry.js";
export * from "./runtime.js";
export * from "./demo.js";
export * from "./providers.js";
export * from "./knowledge.js";
export * from "./scheduler.js";
