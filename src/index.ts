import { mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Store } from "./store.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceFiles, registerFiles } from "./files.js";
import { registerWorkspaceHistory } from "./workspace-history.js";
import { WorkspaceSearch, registerCodeSearch } from "./code-search.js";
import { CodeEditor, registerCodeEdit } from "./code-edit.js";
import { Runtime } from "./runtime.js";
import { DemoProvider } from "./demo.js";
import { Knowledge, registerKnowledge } from "./knowledge.js";
import { registerOrchestration } from "./orchestration-tools.js";
import { registerMemory } from "./memory.js";
import { MemoryRetrieval } from "./memory-retrieval.js";
import { MemoryHygiene } from "./memory-hygiene.js";
import { MemoryTransfer } from "./memory-export.js";
import { Scheduler, registerSchedules } from "./scheduler.js";
import { registerHistory } from "./history.js";
import { registerSessions } from "./sessions.js";
import { registerSkills } from "./skill-tools.js";
import { startMcpServer } from "./mcp-server.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { ModelRouter, type ModelPreset } from "./models.js";
import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { syncChatGPTPresets } from "./chatgpt-presets.js";
import { FileLockerKey, type LockerKeySource } from "./locker.js";
import { RunArtifacts } from "./artifacts.js";
import { BrowserProfiles } from "./integrations/browser-profiles.js";
import { ChannelRouter } from "./channels/router.js";
import { WebAccess, registerWeb } from "./integrations/web.js";
import { Hooks } from "./hooks.js";
import { Teams } from "./teams.js";
import { Triggers } from "./triggers.js";
import { Webhooks } from "./webhooks.js";
import { SkillRegistry } from "./registry-install.js";
import { Evaluation } from "./evaluation.js";
import { NeedsInputError, type ToolContext } from "./contracts.js";
import { defaultPreset } from "./providers.js";
import type { Provider } from "./contracts.js";
import { parseRetryPolicy, type RetryPolicyInput } from "./provider-retry.js";
import type { ReliabilityInput } from "./reliability.js";
import { DocumentLibrary, registerDocuments } from "./documents.js";
import { GitTools } from "./integrations/git.js";
import { GitRunner } from "./integrations/git-run.js";
import { registerGit } from "./integrations/git-tools.js";
import { jsonWriteProblem } from "./approvals.js";
import { audit } from "./audit.js";
import { DocumentRetriever, MemoryRetriever, Retrieval } from "./retrieval.js";
import { PracticeWorkspace } from "./practice-workspace.js";
import { ProviderPlugins } from "./provider-plugins.js";
import type { IssueAccess } from "./integrations/issue-tools.js";

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
  const lockerKey = options.lockerKey ?? new FileLockerKey(join(dataDir, "locker.key"));
  store.openLocker(lockerKey);
  // Screenshots and saved pages, and the saved sign-ins for the browser: both live beside the
  // private database, never in the person's workspace.
  const artifacts = new RunArtifacts(join(dataDir, "artifacts"));
  const browserProfiles = new BrowserProfiles(join(dataDir, "browser-profiles"), lockerKey);
  const registry = new ToolRegistry();
  files.scope = () => store.projects.active(options.owner ?? "local").folder;
  const history = store.openWorkspaceHistory(files, options.owner ?? "local");
  let documents: DocumentLibrary | undefined;
  const writeObserver = {
    before: (path: string, context: ToolContext) => history.before(path, context),
    after: async (path: string, context: ToolContext, token: unknown) => {
      const change = await history.change(path, token as Awaited<ReturnType<typeof history.before>>);
      if (context.runId) store.event(context.runId, "file.changed", { ...change });
      try { await documents?.refreshPath(context.owner, path, context.signal); } catch { /* indexing never fails a file change */ }
      const problem = await jsonWriteProblem((p) => files.read(p), path).catch(() => null);
      if (problem && context.runId)
        store.event(context.runId, "file.invalid_json", { path, problem,
          message: `${path} was saved, but it is not valid JSON: ${problem}` });
    },
  };
  registerFiles(registry, files, writeObserver);
  registerWorkspaceHistory(registry, history);
  registerCodeSearch(registry, new WorkspaceSearch(files));
  registerCodeEdit(registry, files, new CodeEditor(files, writeObserver));
  // Version control on this computer only; sending work to a server is switched on separately.
  const git = new GitTools(files, new GitRunner());
  registerGit(registry, git);
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
  runtime.artifacts = artifacts;
  const knowledge = new Knowledge(store, registry, runtime);
  // Facts are found by their words and, where the provider allows it, by meaning; the most useful come first.
  const memory = {
    retrieval: new MemoryRetrieval(store, runtime.models),
    hygiene: undefined as unknown as MemoryHygiene,
    transfer: new MemoryTransfer(store),
  };
  memory.hygiene = new MemoryHygiene(store, memory.retrieval);
  store.review.orderFacts = (factOwner, agent) => memory.retrieval.ranking(factOwner, agent).map((entry) => entry.record);
  registerMemory(registry, store, memory.retrieval);
  registerHistory(registry, store);
  registerSessions(registry, store);
  registerSkills(registry, store);
  documents = new DocumentLibrary(store, runtime.models, files);
  registerDocuments(registry, documents);
  runtime.documents = documents;
  registry.register({
    name: "user.ask", permission: "user.ask",
    description: "Stop and ask the person a question when you cannot proceed without their answer. The task pauses; their next message in this conversation is the answer.",
    parameters: z.object({ question: z.string().trim().min(1).max(2000) }).strict(),
    execute: async ({ question }) => { throw new NeedsInputError(question); },
  });
  registerKnowledge(registry, knowledge);
  // Working with several specialists at once, handing work over, and the shared scratch area.
  registerOrchestration(registry, runtime, knowledge);
  const web = new WebAccess(options.web ?? {}, globalThis.fetch, `BranchAgent/${String(createRequire(import.meta.url)("../package.json").version)}`);
  registerWeb(registry, web, (context, info) => { if (context.runId) store.event(context.runId, "content.flagged", info); });
  const channels = new ChannelRouter(store, runtime);
  const hooks = new Hooks(store, runtime.owner);
  const teams = new Teams(store, runtime.owner);
  const skillRegistry = new SkillRegistry(store, runtime.owner, web.policy);
  const evaluation = new Evaluation(store, runtime.owner);
  const triggers = new Triggers(store, runtime);
  const webhooks = new Webhooks(store, web.policy);
  runtime.notifyEvent = webhooks.notifier(runtime.owner);
  channels.deliveries.notifyEvent = webhooks.notifier(runtime.owner);
  store.onEvent((runId, kind, data) => hooks.fire(kind, runId, data));
  const scheduler = new Scheduler(store, runtime, (channel, chatId, text, key) => channels.deliver(channel, chatId, text, key));
  registerSchedules(registry, scheduler);
  const version = String(createRequire(import.meta.url)("../package.json").version);
  const userAgent = `BranchAgent/${version}`;
  const chatgpt = options.chatgpt;
  if (chatgpt) {
    await chatgpt.load();
    syncChatGPTPresets(runtime.models, chatgpt, (await chatgpt.status()).signedIn, userAgent);
  }
  // Nothing is shared with other AI tools until the owner turns it on in Settings.
  const mcpServer = await startMcpServer(registry, store, runtime, knowledge, files);
  // Documents and saved facts are both asked the same way, and the best answer is put first.
  const retrieval = new Retrieval(store, runtime.owner, runtime.models);
  retrieval.add(new DocumentRetriever(documents));
  retrieval.add(new MemoryRetriever(memory.retrieval));
  documents.reranker = (owner, query, passages, signal) => retrieval.order(owner, query, passages, signal);
  // A safe folder of made-up files to try things in before pointing the app at real work.
  const practice = new PracticeWorkspace(store, files);
  // Model connections a plugin brought; nothing is registered until a plugin is switched on.
  const providerPlugins = new ProviderPlugins(runtime.models, web.policy, globalThis.fetch, userAgent);
  let closing: Promise<void> | undefined;
  return {
    store,
    registry,
    runtime,
    files,
    knowledge,
    documents,
    /** Finding, tidying and moving saved facts. */
    memory,
    /** Documents and saved facts behind one interface, with the best answer put first. */
    retrieval,
    /** The practice workspace: made-up files to try tools on safely. */
    practice,
    /** Model connections plugins have brought. */
    providerPlugins,
    /**
     * Searching, reading and commenting on issues, once the launcher has loaded the integration
     * settings. It stays null while no tracker is set up.
     */
    issues: null as null | IssueAccess,
    git,
    scheduler,
    chatgpt,
    version,
    userAgent,
    mcpServer,
    artifacts,
    browserProfiles,
    /**
     * The live browser, once the launcher has loaded the integration settings, so Settings can
     * offer the sign-in-once window. It stays null when no browser is configured.
     */
    browser: null as null | { signIn(owner: string, name: string, url: string, timeoutMs?: number): Promise<{ name: string; cookies: number; sites: number }> },
    /** Secrets for host commands: only the active project's, never returned to the model. */
    secretsFor: async (context: ToolContext, names: string[]) => {
      const project = store.projects.active(context.owner).id;
      const values = await store.locker.resolve(context.owner, project, names);
      // The names only; a value never leaves the locker, and never reaches this record.
      for (const name of Object.keys(values))
        audit(store, context.owner, { action: "secret.used", actor: "a command you allowed", subject: `${name} (project ${project})`,
          reason: "A command this assistant ran needed it", source: context.source ?? "owner", runId: context.runId, outcome: "handed over" });
      return values;
    },
    channels,
    web,
    hooks,
    teams,
    skillRegistry,
    evaluation,
    triggers,
    webhooks,
    /** What integrations need to host messaging channels: the router and default-project secrets. */
    channelHost: {
      router: channels,
      git,
      /** A secret from whichever project is active right now, for GitHub's personal access token. */
      activeSecret: async (name: string) => {
        const project = store.projects.active(runtime.owner).id;
        const value = (await store.locker.resolve(runtime.owner, project, [name]))[name]!;
        audit(store, runtime.owner, { action: "secret.used", actor: "a connection you set up", subject: `${name} (project ${project})`,
          reason: "A service this assistant talked to needed it", outcome: "handed over" });
        return value;
      },
      secret: async (name: string) => (await store.locker.resolve(runtime.owner, "default", [name]))[name]!,
      web,
      hooks,
      files,
      artifacts,
      browserProfiles,
      context: (runId: string) => runtime.context({ runId }),
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
export * from "./artifacts.js";
export * from "./channels/router.js";
export * from "./channels/telegram.js";
export * from "./channels/discord.js";
export * from "./channels/slack.js";
export * from "./channels/whatsapp.js";
export * from "./channels/email.js";
export * from "./channels/mail-client.js";
export * from "./channels/ws-client.js";
export * from "./integrations/web.js";
export * from "./delegation.js";
export * from "./orchestration.js";
export * from "./orchestration-tools.js";
export * from "./reliability.js";
export * from "./skill-scan.js";
export * from "./receipts.js";
export * from "./content-guard.js";
export * from "./activity.js";
export * from "./memory-review.js";
export * from "./workspace-history.js";
export * from "./ignore.js";
export * from "./patch.js";
export * from "./code-search.js";
export * from "./code-edit.js";
export * from "./backup.js";
export * from "./health.js";
export * from "./openai-compat.js";
export * from "./streams.js";
export * from "./recipes.js";
export * from "./templates.js";
export * from "./network-policy.js";
export * from "./policy.js";
export * from "./approvals.js";
export * from "./hooks.js";
export * from "./ws.js";
export * from "./integrations/process-usage.js";
export * from "./skill-governance.js";
export * from "./teams.js";
export * from "./registry-install.js";
export * from "./evaluation.js";
export * from "./channels/deliveries.js";
export * from "./skill-document.js";
export * from "./scheduler.js";
export * from "./provider-retry.js";
export * from "./triggers.js";
export * from "./webhooks.js";
export * from "./ignore.js";
export * from "./integrations/git.js";
export * from "./integrations/git-run.js";
export * from "./integrations/git-tools.js";
export * from "./integrations/github.js";
export * from "./pricing.js";
export * from "./trace.js";
export * from "./diagnostics.js";
export * from "./memory-retrieval.js";
export * from "./memory-hygiene.js";
export * from "./memory-export.js";
export * from "./session-summary.js";
export * from "./working-session.js";
export * from "./audit.js";
export * from "./tool-categories.js";
export * from "./ask-first.js";
export * from "./practice-workspace.js";
export * from "./retrieval.js";
export * from "./provider-plugins.js";
export * from "./misc-api.js";
export * from "./integrations/linear.js";
export * from "./integrations/issue-context.js";
export * from "./integrations/issue-tools.js";
