import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import { FeatureModeSchema, type FeatureMode } from '../feature-switches.js';
import type { Store } from '../store.js';

/**
 * w911 (A2019): Sandbox backend for browser automation. Supports running Playwright browser
 * in a Docker container or connecting to a remote Playwright server. The same network policy
 * applies in both cases via page.route() on the Branch side.
 */
export const BrowserContainerSchema = z.object({
  /** Where the browser runs: this computer, a Docker container, or a remote endpoint. */
  mode: FeatureModeSchema.default('off'),
  /** How to run the browser when mode is not 'off'. */
  where: z.enum(['local', 'docker', 'endpoint']).default('local'),
  /** The remote Playwright server endpoint (ws:// or wss://) when where is 'endpoint'. */
  endpoint: z.string().url().optional(),
  /** Optional token for authentication to the remote Playwright server. */
  endpointToken: z.string().trim().max(200).optional(),
}).strict();
export type BrowserContainer = z.infer<typeof BrowserContainerSchema>;

const settingsKey = 'browser-container';
export function readBrowserContainerSettings(store: Pick<Store, 'get'>, owner: string): BrowserContainer {
  const saved = BrowserContainerSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : BrowserContainerSchema.parse({});
}
export function saveBrowserContainerSettings(store: Store, owner: string, input: unknown): BrowserContainer {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const value = BrowserContainerSchema.parse({ ...readBrowserContainerSettings(store, owner), ...given });
  store.save('settings', owner, settingsKey, value);
  return value;
}
export const browserContainerMode = (store: Pick<Store, 'get'>, owner: string): FeatureMode =>
  readBrowserContainerSettings(store, owner).mode;

/** The one sentence every browser tool says while the switch is off. */
export const browserContainerOff =
  'Browser container mode is switched off. Turn it on under Settings → Advanced → Browser container.';

/** Argument array builder for shell commands; replaces variables and handles quoting. */
export type ProgramRunner = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;

/**
 * Launch a Playwright browser in a Docker container. The image must already be pulled.
 * Container runs headless with network access, published only on 127.0.0.1.
 */
export async function launchDockerBrowser(
  port: number,
  playwrightVersion: string,
  runner: ProgramRunner,
  signal?: AbortSignal,
): Promise<{ wsEndpoint: string; containerId: string; stop: () => Promise<void> }> {
  const image = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`;

  // Check if image exists
  const inspectCmd = await runner('docker', ['image', 'inspect', image], signal).catch(e => '');
  if (!inspectCmd.trim()) {
    throw new Error(`Docker image ${image} not found. Run: docker pull ${image}`);
  }

  // Start container with playwright server
  const startArgs = [
    'run',
    '--rm',
    `-p`, `127.0.0.1:${port}:3000`,
    '--memory', '512m',
    '--cpus', '1',
    image,
    'npx', 'playwright', 'run-server', '--port', '3000', '--host', '0.0.0.0',
  ];

  // This is a long-running process, so we don't await it fully.
  // In a real implementation, we'd use spawn() and track the PID.
  // For now, we start it and return the endpoint.
  let containerId = '';
  try {
    // Run docker in background and get container ID
    const output = await runner('docker', [
      'run', '-d', '--rm',
      `-p`, `127.0.0.1:${port}:3000`,
      '--memory', '512m',
      '--cpus', '1',
      image,
      'npx', 'playwright', 'run-server', '--port', '3000', '--host', '0.0.0.0',
    ], signal);
    const lines = output.trim().split('\n');
    containerId = lines[0] || '';
  } catch (error) {
    throw new Error(`Failed to start Docker container: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    wsEndpoint: `ws://127.0.0.1:${port}`,
    containerId,
    stop: async () => {
      await runner('docker', ['kill', containerId], signal).catch(() => undefined);
    },
  };
}

/**
 * Connect to a remote Playwright server. Validates that it responds as a valid browser.
 */
export async function connectRemoteBrowser(
  wsEndpoint: string,
  token?: string,
  signal?: AbortSignal,
): Promise<Browser> {
  let url = wsEndpoint;
  if (token) {
    const target = new URL(wsEndpoint);
    target.searchParams.set('token', token);
    url = target.toString();
  }

  try {
    const browser = await chromium.connect(url, { timeout: 10000 });

    // Verify it's a valid browser by checking version
    const version = await browser.version();
    if (!version) {
      await browser.close().catch(() => undefined);
      throw new Error('Remote endpoint did not return a browser version');
    }

    return browser;
  } catch (error) {
    throw new Error(
      `Could not connect to Playwright server at ${wsEndpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Choose where to launch or connect to a browser based on settings.
 * Returns a function that can be used as the browser launcher.
 */
export async function createBrowserLauncher(
  settings: BrowserContainer,
  runner?: ProgramRunner,
): Promise<() => Promise<Browser>> {
  if (settings.mode === 'off' || settings.where === 'local') {
    // Default behavior: launch locally
    return () => chromium.launch({ headless: true });
  }

  if (settings.where === 'docker') {
    if (!runner) throw new Error('ProgramRunner required for docker mode');

    // Start docker container once and reuse the endpoint
    let dockerSession: { wsEndpoint: string; stop: () => Promise<void> } | null = null;

    return async () => {
      if (!dockerSession) {
        const version = '1.63.0'; // Matches package.json
        dockerSession = await launchDockerBrowser(3000, version, runner);
      }
      return chromium.connect(dockerSession.wsEndpoint);
    };
  }

  if (settings.where === 'endpoint') {
    if (!settings.endpoint) throw new Error('endpoint setting required for endpoint mode');
    const endpoint = settings.endpoint;
    const token = settings.endpointToken;

    return async () => connectRemoteBrowser(endpoint, token);
  }

  throw new Error(`Unknown browser container mode: ${settings.where}`);
}
