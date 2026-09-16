import { mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Store } from "./store.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceFiles, registerFiles } from "./files.js";
import { registerWorkspaceHistory } from "./workspace-history.js";
import { WorkspaceSearch, registerCodeSearch } from "./code-search.js";
import { CodeEditor, registerCodeEdit } from "./code-edit.js";
import { CodeChanges, registerCodeChanges } from "./code-change.js";
import { registerHumanTasks } from "./deferred.js";
import { BackgroundProcesses, registerProcesses } from "./processes.js";
import { CodeRunner, registerCodeRun } from "./code-run.js";
import { CredentialResolver } from "./credential-cli.js";
import { OsPermissions, probeReader } from "./os-permissions.js";
import { Runtime } from "./runtime.js";
import { DemoProvider } from "./demo.js";
import { Knowledge, registerKnowledge } from "./knowledge.js";
import { registerOrchestration } from "./orchestration-tools.js";
import { registerOrchestrationModes } from "./orchestration-modes.js";
import { registerMemory } from "./memory.js";
import { MemoryRetrieval } from "./memory-retrieval.js";
import { MemoryHygiene } from "./memory-hygiene.js";
import { chooseForInjection } from "./memory-layers.js";
import { MemoryTidy, registerMemoryTidy, shipTidyProcedure } from "./memory-tidy.js";
import { memorySnapshotLimits } from "./memory-review.js";
import { catalogHealthTick } from "./tool-usage.js";
import { MemoryTransfer } from "./memory-export.js";
import { SqliteMemoryBackend } from "./memory-backend.js";
import { Scheduler, registerSchedules } from "./scheduler.js";
import { registerHistory } from "./history.js";
import { registerRunExport } from "./trajectory.js";
import { meteringTick } from "./metering.js";
import { pricingSettings } from "./pricing.js";
import { registerSessions } from "./sessions.js";
// Wave 8: conversations branched off other conversations, seen as a tree, and one answer carried back.
import { SessionTree, registerSessionTree } from "./session-tree.js";
import { lockedDown, lockdownRefusal } from "./lockdown.js";
import { registerSkills } from "./skill-tools.js";
import { startMcpServer } from "./mcp-server.js";
// Wave 7: opening other AI tools' servers only while a task needs them, and the two look-only
// tools that report what a call would do and how those connections are faring.
import { McpConnections, readLifecycleSettings } from "./mcp-lifecycle.js";
import type { CachedMcpTool } from "./integrations/mcp.js";
import { registerMcpTools } from "./mcp-tools.js";
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
import { ChannelConnectors, registerChannelTools } from "./channels/connectors.js";
import { WebAccess, registerWeb } from "./integrations/web.js";
import { Hooks } from "./hooks.js";
import { Teams } from "./teams.js";
import { Triggers } from "./triggers.js";
import { Webhooks } from "./webhooks.js";
import { recordUncaughtErrors } from "./tracing.js";
import { TraceExporter, traceExportSettings } from "./tracing-export.js";
import { SessionTokens } from "./session-tokens.js";
import { CommandSecrets } from "./vault-sources.js";
import { SkillRegistry } from "./registry-install.js";
import { SkillPackages } from "./skill-packages.js";
import { Plugins } from "./plugins.js";
import { Evaluation } from "./evaluation.js";
import { SuiteRunner } from "./evaluation-runner.js";
import { StudyRunner } from "./study.js";
import { NeedsInputError, type ToolContext } from "./contracts.js";
import { defaultPreset } from "./providers.js";
import { restoreConnections } from "./connections-preset.js";
import type { Provider } from "./contracts.js";
import { parseRetryPolicy, type RetryPolicyInput } from "./provider-retry.js";
import type { ReliabilityInput } from "./reliability.js";
import { DocumentLibrary, registerDocuments } from "./documents.js";
import { MediaTools, registerMedia } from "./media.js";
import { VoiceService, registerVoice } from "./voice-service.js";
import { LiveConversations } from "./realtime-voice.js";
import { registerModelSwitch } from "./model-switch.js";
import { GitTools } from "./integrations/git.js";
import { GitRunner } from "./integrations/git-run.js";
import { registerGit } from "./integrations/git-tools.js";
import { jsonWriteProblem } from "./approvals.js";
import { Flows, registerFlows } from "./flows.js";
import { PluginCatalog } from "./plugin-catalog.js";
import { SkillRevisions, registerSkillSync } from "./skill-revisions.js";
import { DataTables, registerData } from "./data-tools.js";
import { DocumentAnalysis, registerDocumentAnalysis } from "./document-analysis.js";
import { Research, registerResearch } from "./research.js";
import { Monitors, registerMonitors } from "./monitors.js";
// Wave 8: watching a rectangle of the screen for a change, off unless the owner asks twice.
import { ScreenWatches, registerScreenWatches } from "./screen-watch.js";
import { MorningBrief, registerBrief } from "./brief.js";
import { DesktopControl } from "./integrations/desktop.js";
import { registerDesktop } from "./integrations/desktop-tools.js";
import { registerComputer, type ComputerLayers } from "./integrations/computer.js";
import { audit } from "./audit.js";
import { DocumentRetriever, MemoryRetriever, Retrieval } from "./retrieval.js";
// Knowledge bases: whole folders read into passages, searched by words and by meaning at once.
import { KnowledgeBases } from "./knowledge-bases.js";
import { KnowledgeRetriever, registerKnowledgeBases } from "./knowledge-tools.js";
import { KnowledgeCards, registerKnowledgeCards } from "./knowledge-cards.js";
// Batch 20 (wave 8): writing Office files, a map of what a knowledge base mentions, summaries,
// pictures described in words, a Markdown mirror of what is remembered, and text held for one job.
import { DocumentAuthoring, registerDocumentAuthoring } from "./document-authoring.js";
import { GraphRetriever, KnowledgeGraph } from "./knowledge-graph.js";
import { KnowledgeSummaries } from "./knowledge-summary.js";
import { KnowledgeManagement } from "./knowledge-manage.js";
import { KnowledgePictures } from "./knowledge-pictures.js";
import { registerKnowledgeExtras, type KnowledgeParts } from "./knowledge-more.js";
import { MemoryMirror, readOnlyRefusal, registerMemoryMirror } from "./memory-mirror.js";
import { EphemeralDocuments, EphemeralRetriever, registerEphemeralDocuments } from "./memory-ephemeral.js";
import { CachedEmbeddings, asEmbeddings } from "./embeddings.js";
import { MemoryConsolidation } from "./memory-consolidate.js";
import { PracticeWorkspace } from "./practice-workspace.js";
import { ProviderPlugins } from "./provider-plugins.js";
import type { IssueAccess } from "./integrations/issue-tools.js";
// Wave 6 (collaboration and workflows): labels, durable workflows, the waiting line and days off.
import { registerLabels } from "./labels.js";
import { Workflows, registerWorkflows } from "./workflows.js";
// Wave 8: the to-do list, and reports saved in several forms.
import { Todos, registerTodos } from "./todos.js";
import { ObsidianBridge, registerObsidian } from "./obsidian.js";
import { RunQueue } from "./run-queue.js";
import { ExecutionLimit } from "./execution-limit.js";
import { CalendarSettingsStore } from "./calendar.js";
// Wave 7 (a coder's toolbox): the project map, language servers, debug adapters, plan branches,
// checkpoints with undo and redo, kept build outputs, agent export and OpenAPI-defined tools.
import { ProjectMap, registerProjectMap } from "./code-map.js";
import { LanguageServers } from "./language-server.js";
import { registerLanguageServers } from "./language-server-tools.js";
import { DebugAdapters, registerDebug } from "./debug-adapter.js";
import { registerCheckpoints } from "./checkpoints.js";
import { KeptArtifacts, registerKeptArtifacts } from "./build-artifacts.js";
import { OpenApiTools, registerOpenApiTools } from "./openapi-tools.js";

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
  // Points to come back to, the last change put back, and that change put forward again.
  registerCheckpoints(registry, store, history);
  // Files a task produced that are not text, kept version by version with their checksums.
  const keptArtifacts = new KeptArtifacts(join(dataDir, "kept"));
  registerKeptArtifacts(registry, keptArtifacts, files);
  registerCodeSearch(registry, new WorkspaceSearch(files));
  // The project map: built once, then kept up to date file by file, and ordered around a request.
  const projectMap = new ProjectMap(files);
  registerProjectMap(registry, projectMap);
  const editor = new CodeEditor(files, writeObserver);
  registerCodeEdit(registry, files, editor);
  // Multi-file changes: a whole patch or a set of edits, shown first, written all at once, and
  // followed by the check the owner set up for this project.
  const codeChanges = new CodeChanges(store, options.owner ?? "local", files, editor, workspace);
  registerCodeChanges(registry, codeChanges);
  // Language servers and debuggers the owner already has on this computer. Both are switched off
  // until they turn them on, both are started from a full address and never downloaded, and both
  // are held under the same job object as every other program the app starts.
  const languageServers = new LanguageServers(store, options.owner ?? "local", files);
  registerLanguageServers(registry, languageServers, codeChanges);
  const debugAdapters = new DebugAdapters(store, options.owner ?? "local", files);
  registerDebug(registry, debugAdapters);
  // Programs left running (a preview server, a watcher) and small scripts run on their own. Both
  // go through the same approval a host command does, and both are off until the owner sets them up.
  const processes = new BackgroundProcesses(store, options.owner ?? "local", workspace);
  registerProcesses(registry, processes);
  store.onSessionClosed((sessionId) => { void processes.closeSession(sessionId); });
  // Batch 20 (wave 8): a language server or a program being debugged that a task started goes when
  // that task is over, the same way a program started in a conversation goes when it closes. The
  // owner can keep either running instead, with a switch in Settings under Developer.
  //
  // "A task" means a task in a conversation. Pressing a tool's own button is one short task per
  // press, so tearing down at the end of one of those would stop the debugger between "start it"
  // and "what is this name"— the opposite of what was asked for. A press is left alone, and closing
  // the app still stops everything.
  const startedInAConversation = (runId: string): boolean => {
    const run = store.run(runId);
    return !!run && store.messages(run.sessionId).length > 0;
  };
  store.onRunFinished((runId) => {
    if (!startedInAConversation(runId)) return;
    void languageServers.closeRun(runId).catch(() => undefined);
    void debugAdapters.closeRun(runId).catch(() => undefined);
  });
  registerCodeRun(registry, new CodeRunner(store, options.owner ?? "local", workspace));
  // Version control on this computer only; sending work to a server is switched on separately.
  const git = new GitTools(files, new GitRunner());
  registerGit(registry, git);
  // This computer's screen and keyboard. The tools are always here so they can explain themselves,
  // but every one of them refuses until the owner turns the switch on in Settings.
  const desktop = new DesktopControl(store, { artifacts });
  // Batch 26 (wave 8): Windows has switches of its own under Privacy & security, and a refusal
  // there looks like nothing happening at all. The screen is probed by asking for the window list;
  // the microphone and the camera are read out of what the person already chose.
  const osPermissions = new OsPermissions(probeReader(() => desktop.probe()));
  desktop.permissions = osPermissions;
  registerDesktop(registry, desktop);
  // Wave 7: one short way of saying "look at this, press that" for both a web page and a window.
  // The page half is filled in later, if and when a browser is configured for this launch.
  const computer: ComputerLayers = { window: desktop };
  registerComputer(registry, computer);
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
  // Batch 26 (wave 8): the owner's own password manager, asked at the call boundary and only when
  // they have switched it on. It waits for the same unlock the locker does.
  const credentials = new CredentialResolver(store, runtime.owner, store.secrets.scrubber);
  credentials.gate = () => sessionLock.require();
  store.secrets.credentials = credentials;
  // Batch 20 (wave 8): a password fetched by a command of the owner's own, behind the same lock.
  const commandSecrets = new CommandSecrets(store, runtime.owner, store.secrets.scrubber);
  commandSecrets.gate = () => sessionLock.require();
  store.secrets.sources.push(commandSecrets);
  const knowledge = new Knowledge(store, registry, runtime);
  // Facts are found by their words and, where the provider allows it, by meaning; the most useful come first.
  const memory = {
    retrieval: new MemoryRetrieval(store, runtime.models),
    hygiene: undefined as unknown as MemoryHygiene,
    tidy: undefined as unknown as MemoryTidy,
    backend: new SqliteMemoryBackend(store),
    transfer: new MemoryTransfer(store),
  };
  memory.hygiene = new MemoryHygiene(store, memory.retrieval);
  memory.tidy = new MemoryTidy(store, memory.hygiene, memory.retrieval);
  registerMemoryTidy(registry, memory.tidy);
  // "Tidy my memory" arrives as a recipe the owner can look at and check, like any other.
  try { shipTidyProcedure(store, runtime.owner); } catch { /* an older store simply keeps what it has */ }
  // What goes in front of a task is taken layer by layer in the documented order and budget: what
  // is happening now, then the job in hand, then everything the assistant knows for good.
  store.review.orderFacts = (factOwner, agent) =>
    chooseForInjection(memory.retrieval.ranking(factOwner, agent).map((entry) => entry.record), memorySnapshotLimits).records;
  registerMemory(registry, store, memory.retrieval);
  registerHistory(registry, store);
  registerSessions(registry, store);
  const sessionTree = new SessionTree(store.sqlite);
  registerSessionTree(registry, store, sessionTree);
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
  // Handing something to the person and carrying on: the plainest deferred tool call there is.
  registerHumanTasks(registry);
  registerKnowledge(registry, knowledge);
  // Working with several specialists at once, handing work over, and the shared scratch area.
  registerOrchestration(registry, runtime, knowledge);
  // Batch 26 (wave 8): a supervisor over named workers, a swarm over one shared list, and a router
  // that sorts a request to the one specialist it belongs to.
  registerOrchestrationModes(registry, runtime, knowledge);
  const web = new WebAccess(options.web ?? {}, globalThis.fetch, `BranchAgent/${String(createRequire(import.meta.url)("../package.json").version)}`);
  registerWeb(registry, web, (context, info) => { if (context.runId) store.event(context.runId, "content.flagged", info); });
  // A paid search service's key comes out of the locker for the one request and is written down
  // nowhere else: the settings file only ever holds the name of the secret, never its value.
  web.searchKey = async (name: string) => {
    const project = store.projects.active(runtime.owner).id;
    const value = (await store.secrets.resolve(runtime.owner, project, [name], { purpose: "web search" }))[name]!;
    audit(store, runtime.owner, { action: "secret.used", actor: "the search service you chose", subject: `${name} (project ${project})`,
      reason: "Searching the web needed it", outcome: "handed over" });
    return value;
  };
  // Batch 19 (wave 7): the model services the owner added from the catalog are built again from
  // what was written down, with each key taken out of the locker, so they survive a restart.
  await restoreConnections({
    models: runtime.models, locker: store.locker, owner: runtime.owner, policy: web.policy, store,
  });
  // Pictures, speech and what a video's headers say. Every one of these refuses in plain words
  // when the connected model has no such service, and keeps what it makes beside the database.
  // A service that describes itself in OpenAPI becomes tools, one per operation the owner allows.
  const openApiTools = new OpenApiTools(registry, { store, policy: web.policy, files });
  registerOpenApiTools(registry, openApiTools);
  // Batch 20 (wave 8): the services the owner turned into tools are built back from what was
  // written down, so they survive a restart. Nothing is fetched; each key still comes from the
  // locker at the moment of the call.
  openApiTools.restore(runtime.owner);
  const media = new MediaTools(store, files, runtime.models, web.policy, globalThis.fetch);
  media.artifacts = artifacts;
  registerMedia(registry, media);
  // Wave 7: one place that turns speech into words and words into speech, whichever service does
  // the work, plus switching model in one conversation. Voice notes on chat apps come through here.
  const voice = new VoiceService(store, runtime.models, web.policy, web.policy.guard(globalThis.fetch));
  // Wave 8: live conversations. Every connection that stays open leaves a span and a line in the
  // record of what the assistant was allowed to do — the host and the path only, never the whole
  // address, because a key can travel in the query string.
  const live = new LiveConversations({ store, runtime, models: runtime.models, policy: web.policy, owner: runtime.owner });
  // A live conversation belongs to one task. When that task finishes for any reason, the
  // conversation and the socket it holds finish with it rather than being left open.
  registry.onRunFinished(async (context) => { if (context.runId) live.stop(context.runId, "The task ended"); });
  web.policy.watchSockets = (record, outcome, reason) => {
    const span = runtime.tracer.start(record.runId ?? "", "delivery", `live connection to ${record.host}`, {
      host: record.host, path: record.pathname, what: record.what, outcome,
    });
    span?.end(outcome === "refused" ? "error" : "ok", reason);
    audit(store, runtime.owner, {
      action: "network.connected", actor: runtime.owner, subject: `${record.host}${record.pathname}`,
      reason: record.what, source: "owner", runId: record.runId, outcome,
    });
  };
  registerVoice(registry, voice, store);
  registerModelSwitch(registry, store, runtime.models);
  media.voice = voice;
  const channels = new ChannelRouter(store, runtime);
  channels.transcribeVoice = async (clip) => (await voice.transcribe(runtime.owner, clip)).text;
  channels.speakReply = async (text) => {
    const settings = voice.settings(runtime.owner);
    // "Keep audio on this computer" wins over every other voice choice, including this one: a
    // spoken reply made here would still be uploaded to the chat app, and the Voice screen tells
    // the owner nothing containing sound leaves. The words are sent instead, as they always are.
    if (!settings.replyWithVoiceOnChannels || settings.keepAudioOnThisComputer) return null;
    const spoken = await voice.speak(runtime.owner, { text: text.slice(0, 1500), voice: "", speed: 1 });
    return { bytes: spoken.bytes, mediaType: spoken.mediaType };
  };
  // Personal details and, when the owner switches it on, a content check, either side of the model.
  const moderation = new Moderation({}, web.policy, web.policy.guard(globalThis.fetch),
    (reference) => store.secrets.fill(runtime.owner, "default", reference, { purpose: "content check" }));
  const privacy = new PrivacyGuard(store, runtime.owner, moderation);
  moderation.configure(privacy.settings().moderation);
  // Wave 8 (the long tail): while Lockdown is on, nothing is sent out of a messaging account at all.
  channels.outboundGuard = async (text) =>
    lockedDown(store, runtime.owner)
      ? { text: "", blocked: true, reason: lockdownRefusal }
      : privacy.outbound(text);
  runtime.hideSecrets = (value) => {
    const scrubbed = store.secrets.scrubber.deep(value);
    // The privacy settings live in the database; a failure reported while the app is closing
    // must still go out scrubbed rather than throw a second time from inside the error path.
    try { return privacy.inbound(scrubbed); } catch { return scrubbed; }
  };
  // Spans are written straight to their own table rather than through the event log, so the same
  // scrubber is put in front of them explicitly: no attribute can carry a saved password or key.
  runtime.tracer.scrub = (value) => runtime.hideSecrets(value);
  // Locking Branch ends every "yes, for this conversation" as well as closing the secrets locker,
  // and lets go of anything an integration was holding on the owner's behalf — above all a browser
  // of theirs a task had borrowed.
  const releaseOnLock: (() => Promise<unknown>)[] = [];
  sessionLock.onLock = () => {
    runtime.approvals.forgetAll();
    // Wave 8: a connection that stays open would otherwise outlive the lock. Every live
    // conversation ends, and every outbound socket with it.
    live.closeAll("Branch was locked");
    for (const release of releaseOnLock) void release().catch(() => undefined);
  };
  // Signing in to outside services the ordinary way, with the answer coming back to this computer.
  const oauth = new OAuthConnections(runtime.owner, store.secrets, web.policy, web.policy.guard(globalThis.fetch));
  const hooks = new Hooks(store, runtime.owner);
  const teams = new Teams(store, runtime.owner);
  const version = String(createRequire(import.meta.url)("../package.json").version);
  const userAgent = `BranchAgent/${version}`;
  // Wave 7: one finished task's full record, in the documented trajectory shape.
  registerRunExport(registry, store, version);
  const skillRegistry = new SkillRegistry(store, runtime.owner, web.policy);
  // Skill packages people can hand to each other, and single-file plugins the owner switches on.
  const skillPackages = new SkillPackages(store, runtime.owner, registry, { store, policy: web.policy });
  skillPackages.replayRecipe = (recipe, _event, runId) => replayNamedRecipe(knowledge, store, runtime, recipe, runId);
  const packageProblems = skillPackages.restore();
  // Model connections a plugin brought; nothing is registered until a plugin is switched on, so
  // this has to exist before the plugins the owner already chose are loaded back.
  const providerPlugins = new ProviderPlugins(runtime.models, web.policy, globalThis.fetch, userAgent);
  const plugins = new Plugins(store, runtime.owner, registry, join(dataDir, "plugins"));
  plugins.providers = providerPlugins;
  // Chat services a plugin brought, registered the same way a model connection is: available to
  // connect, never connected on the plugin's own say-so.
  const lockerSecret = (purpose: string) => async (name: string) =>
    (await store.secrets.resolve(runtime.owner, "default", [name], { purpose }))[name]!;
  const channelConnectors = new ChannelConnectors(channels, web.policy, lockerSecret("channel"), globalThis.fetch);
  plugins.channels = channelConnectors;
  // Where plugins come from: a folder or one file on this computer, shown in full before it is
  // copied in, with its fingerprint kept so a file that changes later is noticed.
  const pluginCatalog = new PluginCatalog(store, runtime.owner, join(dataDir, "plugins"));
  // Drafts of better versions of a skill, tried against real tasks as a practice run first.
  const skillRevisions = new SkillRevisions(store, runtime.owner);
  registerSkillSync(registry, store, files);
  const pluginProblems = await plugins.restore();
  const evaluation = new Evaluation(store, runtime.owner);
  const triggers = new Triggers(store, runtime);
  const webhooks = new Webhooks(store, web.policy);
  // One trace crosses the boundary: a delivery and a question to another assistant both carry the
  // traceparent of the task behind them.
  webhooks.traceparentFor = (runId) => runtime.tracer.traceparent(runId);
  // A webhook's signing key lives in the locker with the other secrets, named rather than copied.
  webhooks.secretFor = lockerSecret("webhook");
  // Wave 8: while Lockdown is on, no note about what happened reaches another program either.
  const notify = webhooks.notifier(runtime.owner);
  const guardedNotify: typeof notify = (event, payload) => {
    if (!lockedDown(store, runtime.owner)) notify(event, payload);
  };
  runtime.notifyEvent = guardedNotify;
  channels.deliveries.notifyEvent = guardedNotify;
  store.onEvent((runId, kind, data) => hooks.fire(kind, runId, data));
  // Batch 26 (wave 8): the owner's own checks get a say before a tool call goes ahead, and may only
  // make the answer stricter — hold it for a yes, or refuse it.
  runtime.askHooks = (runId, about) => hooks.decide(runId, about);
  const scheduler = new Scheduler(store, runtime, (channel, chatId, text, key) => channels.deliver(channel, chatId, text, key));
  registerSchedules(registry, scheduler);
  // Figures, looking things up properly, watching pages, and the one message first thing.
  const deliverMessage = (channel: string, chatId: string, text: string, key: string) => channels.deliver(channel, chatId, text, key);
  const dataTables = new DataTables(files, web, writeObserver);
  registerData(registry, dataTables, artifacts);
  // Writing Word, spreadsheet, slide, Markdown and web-page files, and changing Word and
  // spreadsheet files in place with every untouched part kept byte for byte.
  registerDocumentAuthoring(registry, new DocumentAuthoring(files, dataTables, artifacts, writeObserver));
  // Asking a question of one document, and holding two up against each other. Tables inside a
  // document are opened as figures, so the spreadsheet tools above can be pointed straight at them.
  const documentAnalysis = new DocumentAnalysis(files, dataTables, runtime.models);
  registerDocumentAnalysis(registry, documentAnalysis);
  const research = new Research(store, web, files, documents, writeObserver);
  registerResearch(registry, research);
  const monitors = new Monitors(store, web, deliverMessage);
  registerMonitors(registry, monitors);
  // Wave 8: watching one rectangle of the screen for a change. Off unless the owner switches it on
  // AND has using the screen switched on; the picture is never kept, only a fingerprint of it.
  const screenWatches = new ScreenWatches(store, (region) => desktop.captureRegion(region),
    () => desktop.enabled(runtime.owner), deliverMessage);
  registerScreenWatches(registry, screenWatches);
  const brief = new MorningBrief(store, monitors, documents, deliverMessage);
  registerBrief(registry, brief);
  // Sending on the assistant's own initiative: one message to several chats, and the brief on demand.
  registerChannelTools(registry, channels, brief, store.profiles);
  scheduler.onTick.add(async (now) => { await monitors.tick(runtime.owner, now); await brief.tick(runtime.owner, now); });
  // Wave 7: once a night, a plain-language look at how the assistant is finding its tools.
  scheduler.onTick.add(async (now) => { catalogHealthTick(store, runtime.owner, now); });
  // Test suites kept as data, their history, and comparing one suite across model choices.
  const evaluationSuites = new SuiteRunner(store, runtime, version);
  scheduler.evaluations = evaluationSuites;
  // Wave 7: written-down experiments — a benchmark or suite across several model choices, run
  // several at a time, checkpointed so a stopped study carries on rather than starting again.
  const studies = new StudyRunner(store, runtime);
  // Wave 6: labels and project notes, durable workflows, the waiting line, and days off and quiet hours.
  registerLabels(registry, store.labels);
  const workflows = new Workflows(store, runtime, knowledge);
  registerWorkflows(registry, workflows);
  // The same workflows seen as boxes and arrows, with a way in over HTTP and a note sent out as
  // each box finishes.
  const flows = new Flows(store, runtime.owner, workflows);
  flows.notifyEvent = guardedNotify;
  registerFlows(registry, flows);
  // Wave 8: a plain list of what is still to be done — the assistant's plan and the owner's own
  // items in one place, with a due day handed on to the schedules rather than timed here.
  const todos = new Todos(store.sqlite);
  registerTodos(registry, todos, runtime.owner);
  // Wave 8: the owner's notes folder, written into and read back from. A folder bridge, not an
  // Obsidian plugin: Obsidian keeps ordinary Markdown in an ordinary folder.
  const obsidian = new ObsidianBridge(store, runtime.owner);
  registerObsidian(registry, obsidian);
  // One count of what is working at once, shared by the web routes and the waiting line.
  const executions = new ExecutionLimit();
  const runQueue = new RunQueue(store, runtime, executions);
  // Whenever anything finishes — a task from the line or a request from the app's own screen — the
  // line is looked at again, so a task never sits waiting for room that is already there.
  executions.onRoom = () => {
    try { runQueue.drain(runtime.owner); } catch { /* the line must never break a finished request */ }
  };
  // Batch 20 (wave 8): a study's cells are work like any other, so they take places from the same
  // count. The study runs its first cell on the place it already holds, so it can never be starved.
  studies.executions = executions;
  const calendar = new CalendarSettingsStore(store, dataDir);
  await calendar.seed();
  scheduler.calendar = calendar;
  channels.deliveries.holdUntil = (at) => calendar.holdUntil(runtime.owner, at);
  const chatgpt = options.chatgpt;
  if (chatgpt) {
    await chatgpt.load();
    syncChatGPTPresets(runtime.models, chatgpt, (await chatgpt.status()).signedIn, userAgent);
  }
  // Nothing is shared with other AI tools until the owner turns it on in Settings.
  const mcpServer = await startMcpServer(registry, store, runtime, knowledge, files);
  mcpServer.documents = { list: (who: string) => documents.list(who) as unknown[] };
  // Somebody else's AI-tool server is opened only when a task first needs it, and closed when that
  // task ends. Each household profile keeps its own settings for how long and how many.
  const mcpConnections = new McpConnections(store, () => store.profiles.scope());
  registry.onRunFinished(async (context) => mcpConnections.releaseRun(context.runId));
  registerMcpTools(registry, store, files.base, mcpConnections);
  // Talking to assistants elsewhere: answering them (A2A server) and handing them work (A2A client).
  const a2a = new A2aServer(store, runtime, registry, mcpServer, version);
  const remoteAgents = new RemoteAgents(store, runtime.owner, web.policy, globalThis.fetch);
  remoteAgents.traceparentFor = (runId) => runtime.tracer.traceparent(runId);
  registerRemoteAgents(registry, remoteAgents);
  // Documents and saved facts are both asked the same way, and the best answer is put first.
  const retrieval = new Retrieval(store, runtime.owner, runtime.models);
  retrieval.add(new DocumentRetriever(documents));
  retrieval.add(new MemoryRetriever(memory.retrieval));
  documents.reranker = (owner, query, passages, signal) => retrieval.order(owner, query, passages, signal);
  // Knowledge bases. Reading passages is charged to the task that asked for it, exactly the way a
  // model answer is; background reading has no task, so it is recorded as an event instead.
  // Batch 20 (wave 8): every passage sent to a provider that is not on this computer goes through
  // the owner's network rules, exactly as every other provider call does. A reader running here is
  // reached directly, because those rules refuse local addresses on purpose.
  const guardedFetch = web.policy.guard(globalThis.fetch);
  documents.embeddingFetch = guardedFetch;
  memory.retrieval.embeddingFetch = guardedFetch;
  const knowledgeBases = new KnowledgeBases(store, files, runtime.models,
    { charge: (runId, tokens) => store.addUsage(runId, tokens, 0, undefined, false) }, undefined, guardedFetch);
  knowledgeBases.reranker = (owner, query, passages, signal) => retrieval.order(owner, query, passages, signal);
  registerKnowledgeBases(registry, knowledgeBases, store, runtime.models);
  // What was said in a conversation, written up as fact cards the owner can accept into a
  // knowledge base. Accepting one indexes it exactly like a passage from a file.
  registerKnowledgeCards(registry, new KnowledgeCards(store, knowledgeBases, runtime.models));
  store.review.acceptCard = (cardOwner, card) => knowledgeBases.addCard(cardOwner, card.collection,
    { title: card.title, body: card.body, source: card.sourceTurn });
  retrieval.add(new KnowledgeRetriever(knowledgeBases));
  // A summary of a whole knowledge base, a map of the names it mentions, pictures described in
  // words, and the housekeeping: renaming, merging, splitting, saving out and bringing back.
  const knowledgeGraph = new KnowledgeGraph(store, knowledgeBases, runtime.models);
  const knowledgeSummaries = new KnowledgeSummaries(store, knowledgeBases, runtime.models);
  const knowledgeManagement = new KnowledgeManagement(store, knowledgeBases, knowledgeSummaries);
  const knowledgePictures = new KnowledgePictures(store, knowledgeBases, files, runtime.models);
  const knowledgeParts: KnowledgeParts = { bases: knowledgeBases, graph: knowledgeGraph,
    summaries: knowledgeSummaries, management: knowledgeManagement, pictures: knowledgePictures,
    cards: new KnowledgeCards(store, knowledgeBases, runtime.models) };
  registerKnowledgeExtras(registry, knowledgeParts, store);
  // One hop through that map is another way of finding passages, beside words and meaning.
  retrieval.add(new GraphRetriever(knowledgeGraph, knowledgeBases));
  // Text pasted in for one job: searchable while the job runs, gone the moment it ends.
  const taskText = new EphemeralDocuments();
  registerEphemeralDocuments(registry, taskText);
  retrieval.add(new EphemeralRetriever(taskText));
  // What the assistant remembers, mirrored into the workspace as Markdown it may read but not change.
  const memoryMirror = new MemoryMirror(store, files);
  registerMemoryMirror(registry, memoryMirror);
  files.readOnly = (path) => (memoryMirror.owns(path) ? readOnlyRefusal : "");
  // And a knowledge base never reads those notes back in: they are the assistant's own writing.
  knowledgeBases.skip = (path) => memoryMirror.owns(path);
  // Saved facts are read through the same store of already-read passages, so nothing is sent twice.
  memory.retrieval.wrapEmbedder = (embedder) => new CachedEmbeddings(asEmbeddings(embedder), knowledgeBases.cache);
  const consolidation = new MemoryConsolidation(store, memory.retrieval, memory.hygiene);
  // Facts written during a task are compared by meaning as soon as it finishes, never during it.
  registry.onRunFinished(async (context) => { await consolidation.embedNew(context.owner).catch(() => undefined); });
  // Notes a task made only for itself go when the task ends, unless the owner asked to keep one.
  registry.onRunFinished(async (context) => { try { store.clearTaskScratch(context.owner, context.runId); } catch { /* nothing to clear */ } });
  const documentContext = documents;
  // A knowledge base the owner ticked is put in front of a task first; documents follow. Turning
  // "Use my documents when answering" off deliberately turns both off, so one switch means one thing.
  runtime.documents = {
    contextFor: async (owner, prompt, signal) => {
      if (documentContext.settings(owner).useDocuments === false) return null;
      return (await knowledgeBases.contextFor(owner, prompt, signal).catch(() => null))
        ?? documentContext.contextFor(owner, prompt, signal);
    },
  };
  // Finding a tool by meaning, through the same reader and the same store of already-read
  // passages as everything else: a tool description that has not changed is never read twice.
  // The switch is checked in the runtime at the moment of the search, so this seam being here
  // does not by itself send anything anywhere.
  runtime.toolMeaning = {
    embed: async (texts, runId) => {
      const reader = knowledgeBases.embeddings(runtime.owner);
      if (!reader) return [];
      // Charged to the task that searched, the same way its model answers are, so the owner can
      // see what finding tools by meaning actually costs instead of it being spent out of sight.
      const vectors = await reader.embedFor(runId, [...texts], AbortSignal.timeout(20_000));
      return vectors.map((vector) => Array.from(vector));
    },
  };
  scheduler.onTick.add(async (now) => { await consolidation.tick(runtime.owner, now); });
  // Wave 7: the month's usage written out as a spreadsheet, into a folder of the owner's own
  // workspace, on the schedule they set. Nothing leaves this computer.
  scheduler.onTick.add(async (now) => {
    await meteringTick({
      store, owner: runtime.owner, workspace: files.root,
      overrides: () => pricingSettings(store, runtime.owner).overrides,
    }, now);
  });
  // A safe folder of made-up files to try things in before pointing the app at real work.
  const practice = new PracticeWorkspace(store, files);
  // Sending traces out. Off until the owner turns it on; the headers an endpoint needs are kept as
  // secret:// references and filled in only at the moment of the call.
  const traceExport = new TraceExporter({
    store, owner: runtime.owner, policy: web.policy, version,
    fillSecrets: (headers) =>
      store.secrets.fill(runtime.owner, store.projects.active(runtime.owner).id, headers, { purpose: "sending traces" }),
  });
  // Short-lived, scoped keys for anything that is not the app window. The master session key is
  // never one of these; see src/session-tokens.ts.
  const sessionTokens = new SessionTokens(store.sqlite, store);
  const stopWatchingErrors = recordUncaughtErrors(store.spans, runtime.owner, (value) => runtime.hideSecrets(value));
  // A finished task's spans go out on their own once sending is on; the exporter itself does
  // nothing at all while it is off, so this stays quiet until the owner turns it on.
  runtime.exportSpans = async (runId) => {
    const settings = traceExportSettings(store, runtime.owner);
    if (!settings.enabled) return;
    const spans = store.spans.forRun(runId).filter((span) => span.endedAt !== null);
    if (!spans.length) return;
    const crashes = settings.includeErrors ? store.spans.recent(runtime.owner, 50).filter((span) => span.kind === "error") : [];
    const results = await traceExport.sendSpans([...spans, ...crashes], "A finished task's steps were sent to the address you chose");
    // Batch 20 (wave 8): the same send carries the task's own story as OpenTelemetry log records,
    // tied to the trace by its id, so a collector shows the words beside the shape.
    const root = spans.find((span) => !span.parentSpanId) ?? spans[0];
    await traceExport.sendLogs(store.events(runId).map((event) => ({
      runId, kind: event.kind, createdAt: event.createdAt, data: event.data,
      ...(root ? { traceId: root.traceId, spanId: root.spanId } : {}),
    }))).catch(() => null);
    const failed = results.find((result) => !result.ok);
    store.event(runId, failed ? "trace.send_failed" : "trace.sent",
      failed ? { error: failed.error } : { spans: spans.length, endpoint: failed ? "" : settings.destination });
  };
  let closing: Promise<void> | undefined;
  return {
    store,
    registry,
    runtime,
    /** Wave 8: the shape conversations make when one is branched off another, and carrying an answer back. */
    sessionTree,
    files,
    knowledge,
    documents,
    /** Making and reading pictures, speech and sound files. */
    media,
    /** Writing speech out and reading text aloud, whichever service does the work. */
    voice,
    /** Wave 8: live conversations — talking and being cut off, over a connection that stays open. */
    live,
    /** Finding, tidying and moving saved facts. */
    memory,
    /** Documents and saved facts behind one interface, with the best answer put first. */
    retrieval,
    /** Named sets of folders and files, read into passages and searched by words and by meaning. */
    knowledgeBases,
    /** Wave 8: summaries, the map of names, pictures in words, and knowledge-base housekeeping. */
    knowledgeParts,
    /** Wave 8: what the assistant remembers, written into the workspace as Markdown. */
    memoryMirror,
    /** Wave 8: text held for one job only. */
    taskText,
    /** The nightly pass that gives new facts a comparison by meaning and suggests merges. */
    consolidation,
    /** The practice workspace: made-up files to try tools on safely. */
    practice,
    /** Model connections plugins have brought. */
    providerPlugins,
    /** Chat services plugins have brought, and the channels connected from them. */
    channelConnectors,
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
    /** Other AI tools' servers, opened only while a task needs one and closed when it ends. */
    mcpConnections,
    /** Answering assistants elsewhere over the agent-to-agent protocol. */
    a2a,
    /** Assistants elsewhere this one may hand work to. */
    remoteAgents,
    artifacts,
    /** The screen and keyboard of this computer, and the switch that has to be on to use them. */
    desktop,
    /** What Windows itself allows: the microphone, the camera and taking hold of windows. */
    osPermissions,
    browserProfiles,
    /**
     * The live browser, once the launcher has loaded the integration settings, so Settings can
     * offer the sign-in-once window. It stays null when no browser is configured.
     */
    browser: null as null | { signIn(owner: string, name: string, url: string, timeoutMs?: number): Promise<{ name: string; cookies: number; sites: number }> },
    /** Secrets for host commands: only the active project's, never returned to the model. */
    secretsFor: async (context: ToolContext, names: string[]) => {
      const project = store.projects.active(context.owner).id;
      const values = await store.secrets.resolve(context.owner, project, names,
        { runId: context.runId, purpose: "host command" });
      // The names only; a value never leaves the locker, and never reaches this record.
      for (const name of Object.keys(values))
        audit(store, context.owner, { action: "secret.used", actor: "a command you allowed", subject: `${name} (project ${project})`,
          reason: "A command this assistant ran needed it", source: context.source ?? "owner", runId: context.runId, outcome: "handed over" });
      return values;
    },
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
    /** Where plugins came from, with the fingerprint each one had when it was accepted. */
    pluginCatalog,
    /** Drafted better versions of a skill: the changed lines, the trial, and the owner's answer. */
    skillRevisions,
    evaluation,
    /** Suites kept as data: running them, their history, and comparing two model choices. */
    evaluationSuites,
    /** Wave 7: written-down experiments over suites and benchmarks, with checkpoints and resume. */
    studies,
    triggers,
    webhooks,
    /** Wave 6: saved workflows, the waiting line for tasks, and days off with quiet hours. */
    workflows,
    runQueue,
    /** How much may be going on at once, counted once for the whole app. */
    executions,
    calendar,
    /** The same workflows as boxes and arrows, for the API and the picture in Procedures. */
    flows,
    /** Wave 8: the things still to be done, written down where the owner can see them. */
    todos,
    /** Wave 8: notes written into the owner's own notes folder, and the tagged ones read back. */
    obsidian,
    /** Wave 8: watches on one rectangle of the screen, off unless the owner switches them on. */
    screenWatches,
    /** Multi-file changes and the check the owner set up for this project. */
    codeChanges,
    /** The project map, for the screens that show it and for the tests. */
    projectMap,
    /** Services turned into tools from their own OpenAPI description. */
    openApiTools,
    /** Files a task produced that are not text, kept version by version. */
    keptArtifacts,
    /** Language servers and debuggers the owner set up; both stop when the app closes. */
    languageServers,
    debugAdapters,
    /** Programs left running, and the switch that stops them all when the app closes. */
    processes,
    /** What integrations need to host messaging channels: the router and default-project secrets. */
    channelHost: {
      router: channels,
      git,
      /** A secret from whichever project is active right now, for GitHub's personal access token. */
      activeSecret: async (name: string) => {
        const project = store.projects.active(runtime.owner).id;
        const value = (await store.secrets.resolve(runtime.owner, project, [name], { purpose: "integration" }))[name]!;
        audit(store, runtime.owner, { action: "secret.used", actor: "a connection you set up", subject: `${name} (project ${project})`,
          reason: "A service this assistant talked to needed it", outcome: "handed over" });
        return value;
      },
      secret: async (name: string) =>
        (await store.secrets.resolve(runtime.owner, "default", [name], { purpose: "channel" }))[name]!,
      web,
      hooks,
      files,
      artifacts,
      browserProfiles,
      computer,
      store,
      tracer: runtime.tracer,
      onLock: (release: () => Promise<unknown>) => { releaseOnLock.push(release); },
      context: (runId: string) => runtime.context({ runId }),
      // Whether another person's server is started as Branch starts or only when a task really
      // needs it, and what it last said its tools are, so they can be listed either way.
      mcp: {
        connectWhen: () => readLifecycleSettings(store, store.profiles.scope()).connect,
        cache: {
          read: (id: string) =>
            ((store.get("settings", runtime.owner, `mcp-tools:${id}`)?.data as { tools?: CachedMcpTool[] } | undefined)?.tools) ?? [],
          write: (id: string, tools: CachedMcpTool[]) =>
            void store.save("settings", runtime.owner, `mcp-tools:${id}`, { tools, at: new Date().toISOString() }),
        },
        connections: mcpConnections,
      },
    },
    /** Sending traces and counters to an address the owner chose; off until they turn it on. */
    traceExport,
    /** Batch 20 (wave 8): short-lived keys for a script, an extension or the SDK. */
    sessionTokens,
    close: () => (closing ??= (async () => {
      stopWatchingErrors();
      // Wave 8: a connection that stays open must not outlive the app either.
      live.closeAll("Branch closed");
      plugins.stop();
      skillPackages.stop();
      mcpServer.close();
      await mcpConnections.closeAll();
      // Nothing the assistant left running outlives the app.
      await processes.stopAll().catch(() => undefined);
      await languageServers.stopAll().catch(() => undefined);
      await debugAdapters.stopAll().catch(() => undefined);
      try {
        await closeBranch(scheduler, runtime, store, channels, desktop);
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
  desktop?: { close(): Promise<void> },
): Promise<void> {
  await desktop?.close().catch(() => undefined);
  await channels?.detachAll();
  const schedulingStopped = scheduler.stop();
  await runtime.shutdown();
  await schedulingStopped;
  store.close();
}
export * from "./contracts.js";
export * from "./store.js";
export * from "./registry.js";
export * from "./catalog.js";
// Wave 7 (tool loading): the tiers, the searchable index, and what past tasks taught.
export * from "./tool-loading.js";
export * from "./tool-index.js";
export * from "./tool-usage.js";
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
export * from "./policy-resources.js";
export * from "./approvals.js";
// Batch 19 (wave 7): spans, sending traces out, the metrics page and the auth rate limit.
export * from "./tracing.js";
export * from "./tracing-shapes.js";
export * from "./tracing-export.js";
export * from "./metrics.js";
export * from "./auth-limits.js";
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
// Wave 7 (benchmarks and experiments): scorers, gates, benchmark adapters, studies, and the
// deterministic test doubles a plugin author writes their own tests with.
export * from "./evaluation-scorers.js";
export * from "./evaluation-run.js";
export * from "./benchmarks.js";
export * from "./benchmark-adapters.js";
export * from "./benchmark-shell.js";
export * from "./study.js";
export * from "./tool-evaluations.js";
export * from "./testing.js";
export * from "./channels/deliveries.js";
export * from "./channels/catalog.js";
export * from "./channels/webhook-chat.js";
export * from "./channels/meta-graph.js";
export * from "./channels/matrix.js";
export * from "./channels/signal-cli.js";
export * from "./channels/connectors.js";
export * from "./channels/docs-table.js";
export * from "./json-template.js";
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
export * from "./integrations/gitlab.js";
export * from "./integrations/desktop.js";
export * from "./integrations/desktop-tools.js";
export * from "./integrations/desktop-config.js";
export * from "./integrations/desktop-banner.js";
export * from "./pricing.js";
export * from "./local-models.js";
export * from "./local-hardware.js";
export * from "./local-routing.js";
export * from "./local-runtimes.js";
export * from "./trace.js";
export * from "./diagnostics.js";
export * from "./memory-retrieval.js";
export * from "./memory-layers.js";
export * from "./memory-tidy.js";
export * from "./memory-evaluation.js";
export * from "./memory-backend.js";
export * from "./memory-hygiene.js";
export * from "./memory-consolidate.js";
export * from "./embeddings.js";
export * from "./vector-store.js";
export * from "./chunking.js";
export * from "./bm25.js";
export * from "./knowledge-bases.js";
export * from "./knowledge-cards.js";
export * from "./knowledge-tools.js";
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
// Batch 20 (wave 7) — orchestration, second pass.
export * from "./specialist-styles.js";
export * from "./code-change.js";
export * from "./deferred.js";
export * from "./processes.js";
export * from "./code-run.js";
export * from "./credential-cli.js";
export * from "./sandbox.js";
export * from "./os-permissions.js";
export * from "./profile-roles.js";
export * from "./replay.js";
export * from "./orchestration-modes.js";
export * from "./flows.js";
// Wave 8: the to-do list, reports in three forms, and artifacts out of a reply.
export * from "./todos.js";
export * from "./reports.js";
export * from "./artifact-pages.js";
export * from "./dashboards.js";
export * from "./obsidian.js";
export * from "./embeds.js";
export * from "./screen-watch.js";
export * from "./plugin-catalog.js";
export * from "./skill-revisions.js";
export * from "./media.js";
export * from "./voice.js";
export * from "./voice-stt.js";
export * from "./voice-tts.js";
export * from "./voice-talk.js";
export * from "./voice-service.js";
export * from "./realtime.js";
export * from "./realtime-openai.js";
export * from "./realtime-gemini.js";
export * from "./realtime-voice.js";
export * from "./realtime-socket.js";
export * from "./voice-api.js";
export * from "./model-profiles.js";
export * from "./model-switch.js";
export * from "./provider-probe.js";
export * from "./trajectory.js";
export * from "./gemini-signin.js";
export * from "./media-audio.js";
export * from "./media-images.js";
export * from "./media-settings.js";
export * from "./media-video.js";
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
// Wave 6 (collaboration and workflows).
export * from "./labels.js";
export * from "./conversation-share.js";
export * from "./workflows.js";
export * from "./run-queue.js";
export * from "./execution-limit.js";
export * from "./calendar.js";
export * from "./profiles.js";
// Wave 7 (a coder's toolbox).
export * from "./code-scanners.js";
export * from "./code-map.js";
export * from "./stdio-rpc.js";
export * from "./language-server.js";
export * from "./language-server-tools.js";
export * from "./debug-adapter.js";
export * from "./checkpoints.js";
export * from "./build-artifacts.js";
export * from "./openapi.js";
export * from "./openapi-tools.js";
export * from "./agent-export.js";
// Wave 7 (Branch as a first-class MCP citizen, both ways round).
export * from "./mcp-policy.js";
export * from "./mcp-snapshots.js";
export * from "./mcp-lifecycle.js";
export * from "./mcp-apps.js";
export * from "./mcp-workbench.js";
export * from "./integrations/mcp-oauth.js";
// Wave 8 (the long tail in "other"): the app's own OpenAPI description, keeping answers to
// identical requests, whole sets of questions at once, Lockdown, the shape branched conversations
// make, what each project has cost, and watching a folder.
export * from "./api-openapi.js";
// The owner's handbook, which the app serves to itself so Help opens beside the screen you are on.
export * from "./help.js";
export * from "./request-cache.js";
export * from "./batch-inference.js";
export * from "./lockdown.js";
export * from "./session-tree.js";
export * from "./project-ledger.js";
export * from "./watch.js";
// Batch 20 (wave 8): writing and changing documents, and the rest of what this batch added.
export * from "./document-package.js";
export * from "./document-write.js";
export * from "./document-docx.js";
export * from "./document-xlsx.js";
export * from "./document-pptx.js";
export * from "./document-edit.js";
export * from "./document-authoring.js";
export * from "./knowledge-graph.js";
export * from "./knowledge-summary.js";
export * from "./knowledge-manage.js";
export * from "./knowledge-pictures.js";
export * from "./knowledge-more.js";
export * from "./memory-mirror.js";
export * from "./memory-ephemeral.js";
// Batch 20 (wave 8): short-lived keys, the sources a saved password can come from, one list of who
// may message the assistant, the chain a phone must satisfy, and coding assistants as a model.
export * from "./session-tokens.js";
export * from "./vault-sources.js";
export * from "./channels/allowlist.js";
export * from "./remote/gateway-auth.js";
export * from "./providers/cli-agent.js";
export * from "./cli-attach.js";
export * from "./cli-completion.js";
export * from "./cli-run.js";
