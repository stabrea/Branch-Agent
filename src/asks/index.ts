import { ImapClient } from "../channels/mail-client.js";
import type { Provider } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import type { Flows } from "../flows.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { Analytics } from "./analytics.js";
import { AnswerEngine, registerAnswerEngine, type AnswerWeb } from "./answer-engine.js";
import { AnswerPages, registerAnswerPages } from "./answer-pages.js";
import { ArticleWriter, registerArticleWriter } from "./article-writer.js";
import { AppBlocks, registerAppBlocks } from "./app-blocks.js";
import { Hindsight, registerHindsight } from "./hindsight.js";
import { IntentPipeline, registerIntentRoute } from "./intent-pipeline.js";
import { ProjectBoards, registerProjectBoard } from "./project-board.js";
import { AgentRuntimes } from "./runtimes.js";
import { registerSourceSync, SourceSync } from "./source-sync.js";
import { askMode, askParts, askTools, saveAskMode, type AskMode, type AskPart } from "./settings.js";

/**
 * Bucket 23 (wave mac6): the smaller asks — project boards, quick answers and kept pages, long
 * articles, the intent pipeline, bringing items in from other services, a Hindsight memory server,
 * steps for other apps, consented usage counts, live tool pages, other Branch computers and the
 * app-server protocol. `createBranch` makes one of these; the server hands it /api/asks/. Every part
 * ships off. See docs/configuration.md, "The smaller asks".
 */
export interface AsksDeps {
  runtime: Runtime; registry: ToolRegistry; web: AnswerWeb; files: WorkspaceFiles; flows: Flows;
  /** A fetch that follows the owner's network rules. */
  fetch: typeof fetch;
  /** A named secret from the locker, filled in at the moment it is needed. */
  secret: (name: string, purpose: string) => Promise<string>;
  /** Whether Telegram is connected as a chat channel right now. */
  telegramInUse: () => boolean;
  version: string;
}

export class Asks {
  readonly boards: ProjectBoards;
  readonly intents: IntentPipeline;
  readonly analytics: Analytics;
  readonly pages: AnswerPages;
  readonly answers: AnswerEngine;
  readonly articles: ArticleWriter;
  readonly sources: SourceSync;
  readonly hindsight: Hindsight;
  readonly blocks: AppBlocks;
  readonly runtimes: AgentRuntimes;
  private readonly registrars: Partial<Record<AskPart, () => void>>;

  constructor(private readonly deps: AsksDeps) {
    const { runtime, registry } = deps;
    const store = runtime.store, owner = runtime.owner;
    const provider = (): Provider | undefined => runtime.models.plan(owner, "").candidates[0]?.provider;
    this.boards = new ProjectBoards(store, owner, { flows: () => deps.flows.list().map((f) => ({ id: f.id, name: f.name })) });
    this.intents = new IntentPipeline(store, owner, provider);
    this.analytics = new Analytics(store, owner, deps.fetch);
    this.pages = new AnswerPages(store, owner);
    this.answers = new AnswerEngine(store, owner, deps.web, provider, this.pages);
    this.articles = new ArticleWriter({ store, owner, web: deps.web, files: deps.files, provider });
    this.sources = new SourceSync({ store, owner, files: deps.files, fetch: deps.fetch,
      secret: (name) => deps.secret(name, "bringing in new items"), imap: (server) => new ImapClient(server),
      telegramInUse: deps.telegramInUse });
    this.hindsight = new Hindsight(store, owner, deps.fetch, (name) => deps.secret(name, "the Hindsight memory server"));
    this.blocks = new AppBlocks(store, owner, deps.fetch, (name) => deps.secret(name, "a step for another app"));
    this.runtimes = new AgentRuntimes(store, owner, runtime.models, deps.version);
    this.registrars = {
      "source-sync": () => registerSourceSync(registry, this.sources),
      hindsight: () => registerHindsight(registry, this.hindsight),
      "app-blocks": () => registerAppBlocks(registry, this.blocks),
      "project-board": () => registerProjectBoard(registry, this.boards),
      "intent-pipeline": () => registerIntentRoute(registry, this.intents),
      "answer-engine": () => registerAnswerEngine(registry, this.answers),
      "answer-pages": () => registerAnswerPages(registry, this.pages),
      "article-writer": () => registerArticleWriter(registry, this.articles),
    };
    for (const part of askParts) this.sync(part);
    registry.onRunFinished(async () => { this.analytics.track("task.finished"); });
  }

  /** A part's tools are in the catalog exactly while its switch is not off. */
  private sync(part: AskPart): void {
    for (const name of askTools[part]) this.deps.registry.unregister(name);
    if (askMode(this.deps.runtime.store, this.deps.runtime.owner, part) !== "off") this.registrars[part]?.();
  }

  modes(): Record<AskPart, AskMode> {
    return Object.fromEntries(askParts.map((part) => [part, askMode(this.deps.runtime.store, this.deps.runtime.owner, part)])) as Record<AskPart, AskMode>;
  }

  /** Saves a switch and puts the part's tools in or takes them out at once. */
  setMode(part: AskPart, input: unknown): AskMode {
    const mode = saveAskMode(this.deps.runtime.store, this.deps.runtime.owner, part, input);
    this.sync(part);
    if (part === "runtimes") this.runtimes.follow(mode !== "off");
    this.analytics.track("feature.switched");
    return mode;
  }
}

export { askParts, askTools, askLabels } from "./settings.js";
