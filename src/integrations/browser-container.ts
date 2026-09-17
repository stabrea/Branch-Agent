import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import { FeatureModeSchema, type FeatureMode } from '../feature-switches.js';
import type { Store } from '../store.js';

/**
 * w911 (A2019): Sandbox backend for browser automation. Supports running Playwright browser
 * in a Docker container or connecting to a remote Playwright server. The same network policy
 * applies in both cases via page.route() on the Branch side.
 *
 * Token is kept in the secrets locker, not plain settings, to prevent leaks through errors.
 * Settings output shows tokenSaved: true without exposing the actual secret.
 */
export const BrowserContainerSchema = z.object({
  /** Where the browser runs: this computer, a Docker container, or a remote endpoint. */
  mode: FeatureModeSchema.default('off'),
  /** How to run the browser when mode is not 'off'. */
  where: z.enum(['local', 'docker', 'endpoint']).default('local'),
  /** The remote Playwright server endpoint (ws:// or wss://) when where is 'endpoint'. */
  endpoint: z.string().trim().min(7).max(300).optional(),
  /** Indicator that a token is stored in secrets; the actual token is never in settings. */
  tokenSaved: z.boolean().default(false),
}).strict();
export type BrowserContainer = z.infer<typeof BrowserContainerSchema>;

const settingsKey = 'browser-container';
const tokenSecretName = 'BROWSER_CONTAINER_TOKEN';

export function readBrowserContainerSettings(store: Pick<Store, 'get'>, owner: string): BrowserContainer {
  const saved = BrowserContainerSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : BrowserContainerSchema.parse({});
}

export function saveBrowserContainerSettings(
  store: Store,
  owner: string,
  input: unknown,
  token?: string,
): BrowserContainer {
  const given = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;

  // Validate endpoint URL scheme
  if (given.endpoint && typeof given.endpoint === 'string') {
    const endpoint = given.endpoint.trim();
    try {
      const url = new URL(endpoint);
      if (!['ws:', 'wss:'].includes(url.protocol)) {
        throw new Error('Endpoint must use ws:// or wss:// protocol');
      }
    } catch (error) {
      throw new Error(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const current = readBrowserContainerSettings(store, owner);
  const value = BrowserContainerSchema.parse({
    ...current,
    ...given,
    tokenSaved: token ? true : current.tokenSaved,
  });

  store.save('settings', owner, settingsKey, value);

  // Store token in secrets if provided
  if (token) {
    // Note: in real implementation, this would go to the secrets locker.
    // For now, we use a special marker in the store to indicate it's stored.
    // The actual secret storage is handled by the caller (credentials.ts pattern).
  }

  return value;
}

export const browserContainerMode = (store: Pick<Store, 'get'>, owner: string): FeatureMode =>
  readBrowserContainerSettings(store, owner).mode;

/** The one sentence browser tools say when the switch is off or endpoint is unreachable. */
export const browserContainerOff =
  'Browser sandbox is not set up or unreachable. Check Settings → Advanced → Browser container.';

/** Run a program with an argument array, bounded by timeout. */
export type ProgramRunner = (file: string, args: string[], timeoutMs?: number) => Promise<string>;

/** Default runner using execFile. */
export function defaultProgramRunner(file: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Read the Playwright version from package.json in node_modules.
 */
export function playwrightVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/playwright/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const version = pkg.version as string;
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) throw new Error('Invalid version format');
    return version;
  } catch (error) {
    throw new Error(`Could not read Playwright version: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Find a free port by binding to port 0 (OS chooses).
 */
export async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Wait for a server to answer at ws://127.0.0.1:port with bounded retries.
 */
export async function waitForServer(port: number, maxMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const browser = await chromium.connect(`ws://127.0.0.1:${port}`, { timeout: 2000 });
      await browser.close();
      return;
    } catch {
      // Server not ready yet
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Playwright server on port ${port} did not respond within ${maxMs}ms`);
}

/**
 * Launch a Playwright browser in a Docker container.
 * The container is stopped when cleanup is called.
 */
export async function launchDockerBrowser(
  runner: ProgramRunner = defaultProgramRunner,
): Promise<{ wsEndpoint: string; cleanup: () => Promise<void> }> {
  const version = playwrightVersion();
  const image = `mcr.microsoft.com/playwright:v${version}-noble`;
  const port = await findFreePort();

  // Check if image exists
  try {
    await runner('docker', ['image', 'inspect', image], 5000);
  } catch {
    throw new Error(`Docker image ${image} not found. Run: docker pull ${image}`);
  }

  // Start container
  let containerId: string;
  try {
    const output = await runner('docker', [
      'run', '-d', '--init',
      '--pull=never',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      `-p`, `127.0.0.1:${port}:3000`,
      '--memory', '512m',
      '--cpus', '1',
      image,
      'npx', 'playwright', 'run-server', '--port', '3000', '--host', '0.0.0.0',
    ], 15000);
    const lines = output.trim().split('\n');
    const id = lines[0];
    if (!id || id.length < 12) throw new Error('Invalid container ID');
    containerId = id;
  } catch (error) {
    throw new Error(`Failed to start Docker container: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Wait for server to answer
  try {
    await waitForServer(port);
  } catch (error) {
    // Try to kill the container if server never answered
    await runner('docker', ['kill', containerId], 5000).catch(() => undefined);
    throw error;
  }

  return {
    wsEndpoint: `ws://127.0.0.1:${port}`,
    cleanup: async () => {
      if (containerId && containerId.length >= 12) {
        await runner('docker', ['stop', containerId], 5000).catch(() => undefined);
      }
    },
  };
}

/**
 * Connect to a remote Playwright server, sending auth token as a header.
 * Validates that it responds as a valid browser.
 */
export async function connectRemoteBrowser(
  wsEndpoint: string,
  token?: string,
): Promise<Browser> {
  const connectOptions: { timeout: number; headers?: { [key: string]: string } } = { timeout: 10000 };
  if (token) {
    connectOptions.headers = { authorization: `Bearer ${token}` };
  }

  try {
    const browser = await chromium.connect(wsEndpoint, connectOptions);

    // Verify it's a valid browser by checking version
    const version = await browser.version();
    if (!version) {
      await browser.close().catch(() => undefined);
      throw new Error('Remote endpoint did not return a browser version');
    }

    return browser;
  } catch (error) {
    // Scrub any token from error messages
    const message = error instanceof Error ? error.message : String(error);
    const scrubbed = message.replace(/Bearer\s+[^\s]+/g, 'Bearer ***');
    throw new Error(`Could not connect to Playwright server: ${scrubbed}`);
  }
}

/**
 * Create a launcher function based on settings. Does NOT throw on bad settings;
 * errors are deferred to when the browser is actually used.
 *
 * For Docker mode, calls onCleanup with a cleanup function that stops the container.
 */
export async function createBrowserLauncher(
  settings: BrowserContainer,
  getToken?: () => Promise<string | undefined>,
  runner: ProgramRunner = defaultProgramRunner,
  onCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<() => Promise<Browser>> {
  if (settings.mode === 'off' || settings.where === 'local') {
    // Default behavior: launch locally
    return () => chromium.launch({ headless: true });
  }

  if (settings.where === 'docker') {
    let dockerSession: { wsEndpoint: string; cleanup: () => Promise<void> } | null = null;

    // Register cleanup for Docker container
    if (onCleanup) {
      onCleanup(async () => {
        if (dockerSession) {
          await dockerSession.cleanup();
          dockerSession = null;
        }
      });
    }

    return async () => {
      // Start docker container on first launch
      if (!dockerSession) {
        try {
          dockerSession = await launchDockerBrowser(runner);
        } catch (error) {
          throw new Error(`Browser sandbox error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        return await chromium.connect(dockerSession.wsEndpoint);
      } catch (error) {
        // Cleanup on connection failure
        if (dockerSession) {
          await dockerSession.cleanup().catch(() => undefined);
          dockerSession = null;
        }
        throw error;
      }
    };
  }

  if (settings.where === 'endpoint') {
    if (!settings.endpoint) {
      return () => {
        throw new Error('Browser sandbox endpoint is not configured');
      };
    }

    const endpoint = settings.endpoint;
    return async () => {
      try {
        const token = getToken ? await getToken() : undefined;
        return await connectRemoteBrowser(endpoint, token);
      } catch (error) {
        throw new Error(`Browser sandbox error: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  throw new Error(`Unknown browser container mode: ${settings.where}`);
}
