import { mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Store } from "./store.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceFiles, registerFiles } from "./files.js";
import { registerWorkspaceHistory } from "./workspace-history.js";
import { Runtime } from "./runtime.js";
import { DemoProvider } from "./demo.js";
import { Knowledge, registerKnowledge } from "./knowledge.js";
import { registerMemory } from "./memory.js";
import { Scheduler, registerSchedules } from "./scheduler.js";
import { registerHistory } from "./history.js";
import { registerSessions } from "./sessions.js";
import { registerSkills } from "./skill-tools.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { ModelRouter, type ModelPreset } from "./models.js";
import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { syncChatGPTPresets } from "./chatgpt-presets.js";
import { FileLockerKey, type LockerKeySource } from "./locker.js";
import { ChannelRouter } from "./channels/router.js";
import { WebAccess, registerWeb } from "./integrations/web.js";
import { NeedsInputError, type ToolContext } from "./contracts.js";
import { defaultPreset } from "./providers.js";
import type { Provider } from "./contracts.js";
import { parseRetryPolicy, type RetryPolicyInput } from "./provider-retry.js";
import type { ReliabilityInput } from "./reliability.js";

export async function createBranch(options: {
  workspace: string;
  dataDir: string;
  provider?: Provider;
  /** Named model presets; the first is the default. Overrides `provider`. */
  presets?: ModelPreset[];
  /** ChatGPT account sign-in; when present and signed in, ChatGPT presets are registered. */
  chatgpt?: ChatGPTAuth;
  /** Key for the secrets locker; defaults to a private key file inside the data directory. */
  lockerKey?: LockerKeySource;
  /** Web reading settings (search endpoint, address allow/block lists). */
  web?: unknown;
  owner?: string;
  retryPolicy?: RetryPolicyInput;
  /** Stall, tool time and context-size limits for ordinary runs. */
  reliability?: ReliabilityInput;
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
  store.openLocker(options.lockerKey ?? new FileLockerKey(join(dataDir, "locker.key")));
  const registry = new ToolRegistry();
  const history = store.openWorkspaceHistory(files, options.owner ?? "local");
  registerFiles(registry, files, {
    before: (path, context) => history.before(path, context),
    after: async (path, context, token) => {
      const change = await history.change(path, token as Awaited<ReturnType<typeof history.before>>);
      if (context.runId) store.event(context.runId, "file.changed", { ...change });
    },
  });
  registerWorkspaceHistory(registry, history);
  const presets = options.presets ?? [defaultPreset(options.provider ?? new DemoProvider())];
  const runtime = new Runtime(
    store,
    registry,
    new ModelRouter(store, presets),
    workspace,
    options.owner ?? "local",
    retryPolicy,
    options.reliability,
  );
  const knowledge = new Knowledge(store, registry, runtime);
  registerMemory(registry, store);
  registerHistory(registry, store);
  registerSessions(registry, store);
  registerSkills(registry, store);
  registry.register({
    name: "user.ask", permission: "user.ask",
    description: "Stop and ask the person a question when you cannot proceed without their answer. The task pauses; their next message in this conversation is the answer.",
    parameters: z.object({ question: z.string().trim().min(1).max(2000) }).strict(),
    execute: async ({ question }) => { throw new NeedsInputError(question); },
  });
  registerKnowledge(registry, knowledge);
  const web = new WebAccess(options.web ?? {}, globalThis.fetch, `BranchAgent/${String(createRequire(import.meta.url)("../package.json").version)}`);
  registerWeb(registry, web, (context, info) => { if (context.runId) store.event(context.runId, "content.flagged", info); });
  const channels = new ChannelRouter(store, runtime);
  const scheduler = new Scheduler(store, runtime, (channel, chatId, text, key) => channels.deliver(channel, chatId, text, key));
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
    /** Secrets for host commands: only the active project's, never returned to the model. */
    secretsFor: (context: ToolContext, names: string[]) =>
      store.locker.resolve(context.owner, store.projects.active(context.owner).id, names),
    channels,
    web,
    /** What integrations need to host messaging channels: the router and default-project secrets. */
    channelHost: {
      router: channels,
      secret: async (name: string) => (await store.locker.resolve(runtime.owner, "default", [name]))[name]!,
      web,
    },
    close: () => (closing ??= closeBranch(scheduler, runtime, store, channels)),
  };
}
async function closeBranch(
  scheduler: Scheduler,
  runtime: Runtime,
  store: Store,
  channels?: ChannelRouter,
): Promise<void> {
  await channels?.detachAll();
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
export * from "./projects.js";
export * from "./locker.js";
export * from "./channels/router.js";
export * from "./channels/telegram.js";
export * from "./integrations/web.js";
export * from "./delegation.js";
export * from "./reliability.js";
export * from "./skill-scan.js";
export * from "./receipts.js";
export * from "./content-guard.js";
export * from "./activity.js";
export * from "./memory-review.js";
export * from "./workspace-history.js";
export * from "./backup.js";
export * from "./health.js";
export * from "./openai-compat.js";
export * from "./streams.js";
export * from "./channels/deliveries.js";
export * from "./skill-document.js";
export * from "./scheduler.js";
export * from "./provider-retry.js";
