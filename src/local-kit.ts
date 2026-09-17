import { restoreLocalConnections, savedLocalConnections } from "./local-connections.js";
import { readRoom, type MachineRoom, type MemoryReaders } from "./local-fit.js";
import { readHardware } from "./local-hardware.js";
import { localModelsMode } from "./local-jobs.js";
import { RuntimeLauncher, type LauncherDeps, type RuntimeId } from "./local-launch.js";
import { LocalManager } from "./local-manage.js";
import { OneClick } from "./local-oneclick.js";
import { libraryFetch } from "./local-policy.js";
import type { StatFs } from "./local-files.js";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";

/**
 * Wave mac5 (local models): the pieces of the one-click flow for one running Branch, kept beside
 * its store so the web routes find them without anything new on the app object.
 */
export interface LocalKitOptions {
  store: Store;
  owner: string;
  models: ModelRouter;
  policy: NetworkPolicy | null;
  dataDir: string;
  /** Tests hand in fakes for every program, file system and network call. */
  launcher?: LauncherDeps;
  fetch?: typeof globalThis.fetch;
  library?: typeof globalThis.fetch;
  memory?: MemoryReaders;
  statfs?: StatFs;
  sleep?: (ms: number) => Promise<void>;
}
export interface LocalKit {
  options: LocalKitOptions;
  launcher: RuntimeLauncher;
  oneClick: OneClick;
  manager: LocalManager;
  library: typeof globalThis.fetch;
  room(): Promise<MachineRoom>;
  close(): void;
}

const kits = new WeakMap<Store, LocalKit>();
export function localKitFor(store: Store): LocalKit | undefined { return kits.get(store); }

export function createLocalKit(options: LocalKitOptions): LocalKit {
  const launcher = new RuntimeLauncher(options.launcher ?? {});
  const library = options.library ?? libraryFetch(options.policy);
  const room = async () => readRoom(await readHardware(), { platform: launcher.at.platform, ...(options.memory ?? {}) });
  const shared = { models: options.models, store: options.store, owner: options.owner, policy: options.policy,
    endpoint: (runtime: RuntimeId) => launcher.baseUrl(runtime), ...(options.fetch ? { fetch: options.fetch } : {}) };
  const oneClick = new OneClick({ ...shared, dataDir: options.dataDir, launcher, library, room,
    ...(options.statfs ? { statfs: options.statfs } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
  const manager = new LocalManager({ ...shared, dataDir: options.dataDir, launcher });
  const kit: LocalKit = {
    options, launcher, oneClick, manager, library, room,
    close: () => { oneClick.closeAll(); launcher.stopAll(); },
  };
  kits.set(options.store, kit);
  return kit;
}

/**
 * What Branch does with local models when it starts, by the switch: nothing when off; bring back
 * the local connections and carry on interrupted setups otherwise; and when on, also start the
 * runtime (Ollama or LM Studio) those connections use, if it is installed and stopped.
 */
export async function startLocalModels(options: LocalKitOptions): Promise<LocalKit> {
  const kit = createLocalKit(options);
  const mode = localModelsMode(options.store, options.owner);
  if (mode === "off") return kit;
  restoreLocalConnections({ models: options.models, store: options.store, owner: options.owner, policy: options.policy,
    endpoint: (runtime) => kit.launcher.baseUrl(runtime), ...(options.fetch ? { fetch: options.fetch } : {}) });
  void kit.oneClick.resume().catch(() => 0);
  if (mode === "on") {
    const wanted = new Set(savedLocalConnections(options.store, options.owner).map((record) => record.runtime));
    for (const runtime of wanted) if (runtime === "ollama" || runtime === "lm-studio") void kit.oneClick.wake(runtime).catch(() => undefined);
  }
  return kit;
}
