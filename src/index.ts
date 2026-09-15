import { mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Store } from "./store.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceFiles, registerFiles } from "./files.js";
import { Runtime } from "./runtime.js";
import { DemoProvider } from "./demo.js";
import { Knowledge, registerKnowledge } from "./knowledge.js";
import { registerMemory } from "./memory.js";
import { Scheduler, registerSchedules } from "./scheduler.js";
import { registerHistory } from "./history.js";
import { registerSessions } from "./sessions.js";
import { registerSkills } from "./skill-tools.js";
import { createRequire } from "node:module";
import { ModelRouter, type ModelPreset } from "./models.js";
import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { syncChatGPTPresets } from "./chatgpt-presets.js";
import { defaultPreset } from "./providers.js";
import type { Provider } from "./contracts.js";
import { parseRetryPolicy, type RetryPolicyInput } from "./provider-retry.js";

export async function createBranch(options: {
  workspace: string;
  dataDir: string;
  provider?: Provider;
  /** Named model presets; the first is the default. Overrides `provider`. */
  presets?: ModelPreset[];
  /** ChatGPT account sign-in; when present and signed in, ChatGPT presets are registered. */
  chatgpt?: ChatGPTAuth;
  owner?: string;
  retryPolicy?: RetryPolicyInput;
}) {
  const retryPolicy = parseRetryPolicy(options.retryPolicy);
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
  const presets = options.presets ?? [defaultPreset(options.provider ?? new DemoProvider())];
  const runtime = new Runtime(
    store,
    registry,
    new ModelRouter(store, presets),
    workspace,
    options.owner ?? "local",
    retryPolicy,
  );
  const knowledge = new Knowledge(store, registry, runtime);
  registerMemory(registry, store);
  registerHistory(registry, store);
  registerSessions(registry, store);
  registerSkills(registry, store);
  registerKnowledge(registry, knowledge);
  const scheduler = new Scheduler(store, runtime);
  registerSchedules(registry, scheduler);
  const version = String(createRequire(import.meta.url)("../package.json").version);
  const userAgent = `BranchAgent/${version}`;
  const chatgpt = options.chatgpt;
  if (chatgpt) {
    await chatgpt.load();
    syncChatGPTPresets(runtime.models, chatgpt, (await chatgpt.status()).signedIn, userAgent);
  }
  let closing: Promise<void> | undefined;
  return {
    store,
    registry,
    runtime,
    files,
    knowledge,
    scheduler,
    chatgpt,
    version,
    userAgent,
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
export * from "./memory.js";
export * from "./identity.js";
export * from "./skills.js";
export * from "./models.js";
export * from "./chatgpt-auth.js";
export * from "./chatgpt-provider.js";
export * from "./chatgpt-presets.js";
export * from "./skill-document.js";
export * from "./scheduler.js";
export * from "./provider-retry.js";
