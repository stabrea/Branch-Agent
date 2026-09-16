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
import { A2aServer } from "./a2a.js";
import { RemoteAgents, registerRemoteAgents } from "./a2a-client.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { ModelRouter, type ModelPreset } from "./models.js";
import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { syncChatGPTPresets } from "./chatgpt-presets.js";
import { FileLockerKey, type LockerKeySource } from "./locker.js";
import { SessionLock } from "./session-lock.js";
import { Moderation } from "./moderation.js";
import { PrivacyGuard } from "./privacy-guard.js";
import { OAuthConnections } from "./oauth.js";
import { RunArtifacts } from "./artifacts.js";
import { BrowserProfiles } from "./integrations/browser-profiles.js";
import { ChannelRouter } from "./channels/router.js";
import { WebAccess, registerWeb } from "./integrations/web.js";
import { Hooks } from "./hooks.js";
import { Teams } from "./teams.js";
import { Triggers } from "./triggers.js";
import { Webhooks } from "./webhooks.js";
import { SkillRegistry } from "./registry-install.js";
import { SkillPackages } from "./skill-packages.js";
import { Plugins } from "./plugins.js";
import { Evaluation } from "./evaluation.js";
import { SuiteRunner } from "./evaluation-runner.js";
import { NeedsInputError, type ToolContext } from "./contracts.js";
import { defaultPreset } from "./providers.js";
import type { Provider } from "./contracts.js";
import { parseRetryPolicy, type RetryPolicyInput } from "./provider-retry.js";
import type { ReliabilityInput } from "./reliability.js";
import { DocumentLibrary, registerDocuments } from "./documents.js";
import { MediaTools, registerMedia } from "./media.js";
import { GitTools } from "./integrations/git.js";
import { GitRunner } from "./integrations/git-run.js";
import { registerGit } from "./integrations/git-tools.js";
import { jsonWriteProblem } from "./approvals.js";
import { DataTables, registerData } from "./data-tools.js";
import { Research, registerResearch } from "./research.js";
import { Monitors, registerMonitors } from "./monitors.js";
import { MorningBrief, registerBrief } from "./brief.js";

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
  // One scrubber in front of the whole event log: no saved password or key can be written down.
  store.guardEvent = (data) => store.secrets.scrubber.deep(data);
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
  // Locking the app: after a quiet spell the locker stays shut until the owner unlocks it again.
  const sessionLock = new SessionLock(store, runtime.owner);
  store.secrets.gate = () => sessionLock.require();
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
  // Pictures, speech and what a video's headers say. Every one of these refuses in plain words
  // when the connected model has no such service, and keeps what it makes beside the database.
  const media = new MediaTools(store, files, runtime.models, web.policy, globalThis.fetch);
  media.artifacts = artifacts;
  registerMedia(registry, media);
  const channels = new ChannelRouter(store, runtime);
  // Personal details and, when the owner switches it on, a content check, either side of the model.
  const moderation = new Moderation({}, web.policy, web.policy.guard(globalThis.fetch),
    (reference) => store.secrets.fill(runtime.owner, "default", reference, { purpose: "content check" }));
  const privacy = new PrivacyGuard(store, runtime.owner, moderation);
  moderation.configure(privacy.settings().moderation);
  channels.outboundGuard = (text) => privacy.outbound(text);
  runtime.hideSecrets = (value) => {
    const scrubbed = store.secrets.scrubber.deep(value);
    // The privacy settings live in the database; a failure reported while the app is closing
    // must still go out scrubbed rather than throw a second time from inside the error path.
    try { return privacy.inbound(scrubbed); } catch { return scrubbed; }
  };
  // Signing in to outside services the ordinary way, with the answer coming back to this computer.
  const oauth = new OAuthConnections(runtime.owner, store.secrets, web.policy, web.policy.guard(globalThis.fetch));
  const hooks = new Hooks(store, runtime.owner);
  const teams = new Teams(store, runtime.owner);
  const skillRegistry = new SkillRegistry(store, runtime.owner, web.policy);
  // Skill packages people can hand to each other, and single-file plugins the owner switches on.
  const skillPackages = new SkillPackages(store, runtime.owner, registry, { store, policy: web.policy });
  skillPackages.replayRecipe = (recipe, _event, runId) => replayNamedRecipe(knowledge, store, runtime, recipe, runId);
  const packageProblems = skillPackages.restore();
  const plugins = new Plugins(store, runtime.owner, registry, join(dataDir, "plugins"));
  const pluginProblems = await plugins.restore();
  const evaluation = new Evaluation(store, runtime.owner);
  const triggers = new Triggers(store, runtime);
  const webhooks = new Webhooks(store, web.policy);
  runtime.notifyEvent = webhooks.notifier(runtime.owner);
  channels.deliveries.notifyEvent = webhooks.notifier(runtime.owner);
  store.onEvent((runId, kind, data) => hooks.fire(kind, runId, data));
  const scheduler = new Scheduler(store, runtime, (channel, chatId, text, key) => channels.deliver(channel, chatId, text, key));
  registerSchedules(registry, scheduler);
  // Figures, looking things up properly, watching pages, and the one message first thing.
  const deliverMessage = (channel: string, chatId: string, text: string, key: string) => channels.deliver(channel, chatId, text, key);
  const dataTables = new DataTables(files, web, writeObserver);
  registerData(registry, dataTables, artifacts);
  const research = new Research(store, web, files, documents, writeObserver);
  registerResearch(registry, research);
  const monitors = new Monitors(store, web, deliverMessage);
  registerMonitors(registry, monitors);
  const brief = new MorningBrief(store, monitors, documents, deliverMessage);
  registerBrief(registry, brief);
  scheduler.onTick.add(async (now) => { await monitors.tick(runtime.owner, now); await brief.tick(runtime.owner, now); });
  const version = String(createRequire(import.meta.url)("../package.json").version);
  const userAgent = `BranchAgent/${version}`;
  // Test suites kept as data, their history, and comparing one suite across model choices.
  const evaluationSuites = new SuiteRunner(store, runtime, version);
  scheduler.evaluations = evaluationSuites;
  const chatgpt = options.chatgpt;
  if (chatgpt) {
    await chatgpt.load();
    syncChatGPTPresets(runtime.models, chatgpt, (await chatgpt.status()).signedIn, userAgent);
  }
  // Nothing is shared with other AI tools until the owner turns it on in Settings.
  const mcpServer = await startMcpServer(registry, store, runtime, knowledge, files);
  // Talking to assistants elsewhere: answering them (A2A server) and handing them work (A2A client).
  const a2a = new A2aServer(store, runtime, registry, mcpServer, version);
  const remoteAgents = new RemoteAgents(store, runtime.owner, web.policy, globalThis.fetch);
  registerRemoteAgents(registry, remoteAgents);
  let closing: Promise<void> | undefined;
  return {
    store,
    registry,
    runtime,
    files,
    knowledge,
    documents,
    /** Making and reading pictures, speech and sound files. */
    media,
    /** Finding, tidying and moving saved facts. */
    memory,
    git,
    scheduler,
    chatgpt,
    version,
    userAgent,
    mcpServer,
    /** Answering assistants elsewhere over the agent-to-agent protocol. */
    a2a,
    /** Assistants elsewhere this one may hand work to. */
    remoteAgents,
    artifacts,
    browserProfiles,
    /**
     * The live browser, once the launcher has loaded the integration settings, so Settings can
     * offer the sign-in-once window. It stays null when no browser is configured.
     */
    browser: null as null | { signIn(owner: string, name: string, url: string, timeoutMs?: number): Promise<{ name: string; cookies: number; sites: number }> },
    /** Secrets for host commands: only the active project's, never returned to the model. */
    secretsFor: (context: ToolContext, names: string[]) =>
      store.secrets.resolve(context.owner, store.projects.active(context.owner).id, names,
        { runId: context.runId, purpose: "host command" }),
    /** References, replacement dates, the use audit and the shared scrubber. */
    secrets: store.secrets,
    /** Locking the app, by hand or after a quiet spell. */
    sessionLock,
    /** Signing in to outside services with the standard authorization-code flow and PKCE. */
    oauth,
    /** Personal details and the optional content check, either side of the assistant. */
    privacy,
    moderation,
    channels,
    /** Tables open for a task, reports already written, page watches, and the morning brief. */
    dataTables,
    research,
    monitors,
    brief,
    web,
    hooks,
    teams,
    skillRegistry,
    /** Skill packages: opening, installing and rebuilding the single file people share. */
    skillPackages,
    /** Installed packages whose tools could not be put back this time. */
    packageProblems,
    /** Single-file plugins from the data folder, off until the owner switches one on. */
    plugins,
    /** Plugins that were on but could not be loaded this time. */
    pluginProblems,
    evaluation,
    /** Suites kept as data: running them, their history, and comparing two model choices. */
    evaluationSuites,
    triggers,
    webhooks,
    /** What integrations need to host messaging channels: the router and default-project secrets. */
    channelHost: {
      router: channels,
      git,
      /** A secret from whichever project is active right now, for GitHub's personal access token. */
      activeSecret: async (name: string) =>
        (await store.secrets.resolve(runtime.owner, store.projects.active(runtime.owner).id, [name], { purpose: "integration" }))[name]!,
      secret: async (name: string) =>
        (await store.secrets.resolve(runtime.owner, "default", [name], { purpose: "channel" }))[name]!,
      web,
      hooks,
      files,
      artifacts,
      browserProfiles,
      context: (runId: string) => runtime.context({ runId }),
    },
    close: () => (closing ??= (async () => {
      plugins.stop();
      skillPackages.stop();
      try {
        await closeBranch(scheduler, runtime, store, channels);
      } finally {
        oauth.closeAll();
      }
    })()),
  };
}
/** Runs one of the owner's own verified recipes by name, for a skill package's event hook. */
async function replayNamedRecipe(knowledge: Knowledge, store: Store, runtime: Runtime, recipe: string, runId: string): Promise<void> {
  const match = store.list("procedures", runtime.owner).find((record) => {
    const state = record.data as unknown as { status?: string; definition?: { name?: string } };
    return state.definition?.name === recipe && state.status === "verified";
  });
  if (!match) throw new Error(`No verified recipe called "${recipe}"`);
  await knowledge.replayProcedure(runtime.context({ runId }), match.id);
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
export * from "./vault.js";
export * from "./pii.js";
export * from "./moderation.js";
export * from "./privacy-guard.js";
export * from "./session-lock.js";
export * from "./oauth.js";
export * from "./integrations/job-object.js";
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
export * from "./a2a.js";
export * from "./a2a-client.js";
export * from "./acp.js";
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
export * from "./skill-package.js";
export * from "./skill-packages.js";
export * from "./skill-http-tools.js";
export * from "./skill-suggest.js";
export * from "./skill-authoring.js";
export * from "./plugins.js";
export * from "./evaluation.js";
export * from "./evaluation-suites.js";
export * from "./evaluation-grading.js";
export * from "./evaluation-runner.js";
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
export * from "./local-models.js";
export * from "./local-hardware.js";
export * from "./local-routing.js";
export * from "./local-runtimes.js";
export * from "./trace.js";
export * from "./diagnostics.js";
export * from "./memory-retrieval.js";
export * from "./memory-hygiene.js";
export * from "./memory-export.js";
export * from "./citations.js";
export * from "./data-table.js";
export * from "./data-chart.js";
export * from "./data-tools.js";
export * from "./research.js";
export * from "./research-claims.js";
export * from "./monitors.js";
export * from "./brief.js";
export * from "./session-summary.js";
export * from "./working-session.js";
export * from "./media.js";
export * from "./media-audio.js";
export * from "./media-images.js";
export * from "./media-settings.js";
export * from "./media-video.js";
