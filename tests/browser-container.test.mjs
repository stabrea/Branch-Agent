import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect as tcpConnect} from 'node:net';
import {once} from 'node:events';
import {readFileSync, readdirSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {discardTemp} from './temp-dir.mjs';
import {BranchBrowser} from '../dist/integrations/browser.js';
import {BrowserProfiles} from '../dist/integrations/browser-profiles.js';
import {
  BrowserContainerSchema, BrowserSandbox, connectEndpoint, dockerImage, dockerRunArgs, playwrightVersion,
  probeHttp, readBrowserContainer, startContainer, tokenName,
} from '../dist/integrations/browser-container.js';
import {loadIntegrations} from '../dist/integrations/bootstrap.js';
import {Budget, createBranch} from '../dist/index.js';
import {startServer} from '../dist/server.js';
import {NetworkPolicy} from '../dist/network-policy.js';

/**
 * w911 (A2019, A2172, A2042): the browser sandbox. Docker is never run: every Docker call goes to a
 * fake runner that records the exact argument list. The "remote" Playwright server is Playwright's
 * own launchServer on the loopback address, and every page is served by this file on 127.0.0.1.
 */
const cacheDir = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
  : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright');
const hasChromium = (() => { try { return readdirSync(cacheDir).some(name => name.startsWith('chromium')); } catch { return false; } })();
const noChromium = hasChromium ? false : 'headless Chromium is not installed';

const owner = 'owner-1';
const runContext = runId => ({
  owner, workspace: '.', runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(['browser.read', 'browser.interact']), depth: 0,
});
const memoryStore = (data = {}) => ({ get: (_table, _owner, key) => key === 'browser-container' ? {data} : undefined });
const noLocker = () => ({ list: () => [], resolve: async () => ({}) });
const tokenLocker = token => () => ({ list: () => [{name: tokenName}], resolve: async () => ({[tokenName]: token}) });
const fakeBrowser = (version = '1.0') => {
  const state = {closed: false};
  return {state, version: async () => version, close: async () => { state.closed = true; }, isConnected: () => true};
};

/** The allowed site, and a second site that must never be reached; both count what they are asked. */
async function sites() {
  const hits = {allowed: 0, forbidden: 0};
  const forbidden = createServer((request, response) => { hits.forbidden++; response.end('secret'); });
  forbidden.listen(0, '127.0.0.1'); await once(forbidden, 'listening');
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;
  const allowed = createServer((request, response) => {
    hits.allowed++;
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'set-cookie': `run=${request.url.slice(1) || 'none'}`});
    response.end(`<!doctype html><title>Allowed page</title><p id="out">waiting</p><script>
      fetch('${forbiddenOrigin}/steal').then(() => 'reached', () => 'refused')
        .then(result => { document.getElementById('out').textContent = result + '|' + document.cookie; });
    </script>`);
  });
  allowed.listen(0, '127.0.0.1'); await once(allowed, 'listening');
  const origin = `http://127.0.0.1:${allowed.address().port}`;
  const stop = async () => { for (const server of [allowed, forbidden]) { server.closeAllConnections(); server.close(); } };
  return {origin, forbiddenOrigin, hits, stop};
}

/** A Playwright server with a door in front that only lets a connection with the right token through. */
async function guardedServer(token) {
  const server = await chromium.launchServer({host: '127.0.0.1', headless: true});
  const target = new URL(server.wsEndpoint());
  const seen = [];
  const door = createServer((request, response) => response.end('Running'));
  door.on('upgrade', (request, socket, head) => {
    seen.push(request.headers.authorization ?? '');
    if (request.headers.authorization !== `Bearer ${token}`) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const upstream = tcpConnect(Number(target.port), '127.0.0.1', () => {
      const lines = [`GET ${target.pathname} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n'); upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  door.listen(0, '127.0.0.1'); await once(door, 'listening');
  return {endpoint: `ws://127.0.0.1:${door.address().port}/pw`, seen,
    stop: async () => { door.closeAllConnections(); door.close(); await server.close(); }};
}

const pageResult = async (browser, context) => {
  const {accessibility} = await browser.snapshot(context);
  return accessibility;
};
const waitForResult = async (browser, context) => {
  for (let i = 0; i < 50; i++) {
    const text = await pageResult(browser, context);
    if (!text.includes('waiting')) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('the page never finished');
};

test('A2019: the switch is off by default, bad addresses are refused, and a damaged setting refuses instead of running locally', async () => {
  assert.deepEqual(BrowserContainerSchema.parse({}), {mode: 'off', where: 'docker'});
  for (const endpoint of ['http://box:3000/', 'ws://user:pw@box:3000/', 'wss://box/pw?token=abc', 'not an address'])
    assert.equal(BrowserContainerSchema.safeParse({mode: 'on', where: 'endpoint', endpoint}).success, false, endpoint);
  assert.equal(BrowserContainerSchema.safeParse({mode: 'on', where: 'local'}).success, false);
  assert.equal(BrowserContainerSchema.safeParse({mode: 'on', token: 'x'}).success, false, 'a token is never a setting');
  const pick = (data, usesSignIn) => new BrowserSandbox(memoryStore(data), noLocker).pick(owner, usesSignIn);
  assert.equal(pick({}, false), null, 'off: this computer, exactly as before');
  assert.equal(pick({mode: 'when-needed', where: 'endpoint', endpoint: 'ws://127.0.0.1:9/'}, true), null,
    'when needed: a saved sign-in stays on this computer');
  const damaged = readBrowserContainer(memoryStore({mode: 'sometimes'}), owner);
  assert.equal(damaged, null);
  await assert.rejects(pick({mode: 'sometimes'}, false), /^Error: The browser sandbox cannot be used: the saved setting is damaged/);
  await assert.rejects(pick({mode: 'on', where: 'endpoint'}, true), /no server address is saved/,
    'on: even a task with a saved sign-in goes to the sandbox');
});

test('A2019: the Docker image tag is the installed Playwright version, read at run time', () => {
  const installed = JSON.parse(readFileSync(new URL('../node_modules/playwright/package.json', import.meta.url), 'utf8')).version;
  assert.equal(playwrightVersion(), installed);
  assert.equal(dockerImage(playwrightVersion()), `mcr.microsoft.com/playwright:v${installed}-noble`);
});

test('A2019: a missing image is refused with the docker pull line and nothing is started', async () => {
  const calls = [];
  const deps = {
    runner: async (file, args) => { calls.push([file, ...args]); throw Object.assign(new Error('No such image'), {code: 1}); },
    probe: async () => true, port: async () => 45123, version: () => '1.63.0', waitMs: 100, pauseMs: 1,
  };
  await assert.rejects(startContainer(deps),
    {message: 'The browser sandbox cannot be used: the Playwright image is not on this computer. Run `docker pull mcr.microsoft.com/playwright:v1.63.0-noble` yourself first. Check the browser sandbox setting, or switch it off.'});
  assert.deepEqual(calls, [['docker', 'image', 'inspect', 'mcr.microsoft.com/playwright:v1.63.0-noble']]);
  const missing = {...deps, runner: async () => { throw Object.assign(new Error('spawn docker ENOENT'), {code: 'ENOENT'}); }};
  await assert.rejects(startContainer(missing), /Docker is not installed on this computer/);
});

test('A2019: docker runs with the exact hardened arguments, the wait is bounded, and a silent container is stopped', async () => {
  const id = 'a'.repeat(64), calls = [];
  let probes = 0;
  const deps = {
    runner: async (file, args) => { calls.push([file, ...args]); return args[0] === 'run' ? `${id}\n` : ''; },
    probe: async port => { assert.equal(port, 45123); return ++probes >= 3; },
    port: async () => 45123, version: () => '1.63.0', waitMs: 5000, pauseMs: 1,
  };
  assert.deepEqual(await startContainer(deps), {wsEndpoint: 'ws://127.0.0.1:45123/', id});
  assert.equal(probes, 3);
  const run = ['docker', 'run', '-d', '--rm', '--init', '--pull=never', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '2g', '--cpus', '2', '--shm-size', '1g', '-p', '127.0.0.1:45123:3000', '--user', 'pwuser', '--workdir', '/home/pwuser',
    'mcr.microsoft.com/playwright:v1.63.0-noble', 'npx', '-y', 'playwright@1.63.0', 'run-server', '--port', '3000', '--host', '0.0.0.0'];
  assert.deepEqual(calls, [['docker', 'image', 'inspect', 'mcr.microsoft.com/playwright:v1.63.0-noble'], run]);
  assert.deepEqual(dockerRunArgs('img', '1.63.0', 45123), [...run.slice(1, 22), 'img', ...run.slice(23)]);
  assert.ok(!run.some(arg => arg === '-v' || arg === '--volume' || arg === '--mount' || arg === '--privileged'), 'no folder is shared');

  calls.length = 0;
  const silent = {...deps, probe: async () => false, waitMs: 60};
  await assert.rejects(startContainer(silent), /the container did not answer within 0 seconds/);
  assert.deepEqual(calls.at(-1), ['docker', 'stop', id], 'a container that never answered is stopped');
});

test('A2019: the readiness check answers true for a real Playwright server and false for a closed port', {skip: noChromium}, async () => {
  const server = await chromium.launchServer({host: '127.0.0.1', headless: true});
  const port = Number(new URL(server.wsEndpoint()).port);
  try { assert.equal(await probeHttp(port), true); } finally { await server.close(); }
  assert.equal(await probeHttp(port), false);
});

test('A2019: closing the browser tool closes the sandbox browser and stops its container by id', {skip: noChromium}, async t => {
  const server = await chromium.launchServer({host: '127.0.0.1', headless: true});
  const {origin, stop} = await sites();
  const id = 'b'.repeat(64), calls = [];
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.sandbox = new BrowserSandbox(memoryStore({mode: 'on', where: 'docker'}), noLocker);
  Object.assign(browser.sandbox, {
    runner: async (file, args) => { calls.push([file, ...args]); return args[0] === 'run' ? id : ''; },
    probe: async () => true, port: async () => 45124, version: () => '1.63.0', pauseMs: 1,
    // The "container" is a Playwright server on this computer, reached at the address Docker would give.
    connect: async (endpoint, options) => { assert.equal(endpoint, 'ws://127.0.0.1:45124/'); return chromium.connect(server.wsEndpoint(), options); },
  });
  t.after(async () => { await browser.close().catch(() => undefined); await server.close(); await stop(); });
  const opened = await browser.navigate(`${origin}/docker`, runContext('docker-run'));
  assert.equal(opened.title, 'Allowed page');
  assert.equal(calls.filter(call => call[1] === 'stop').length, 0, 'nothing is stopped while the task works');
  await browser.close();
  assert.deepEqual(calls.at(-1), ['docker', 'stop', id]);
  assert.equal(calls.length, 3, 'inspect, run, stop — nothing else');
});

test('A2019: the endpoint token travels as an Authorization header and never appears in a refusal', async () => {
  const token = 'tok-9f8e7d6c5b4a';
  let given;
  const echoing = async (endpoint, options) => {
    given = options;
    throw new Error(`browserType.connect: connect ECONNREFUSED ${endpoint}?token=${token} (Authorization: Bearer ${token})`);
  };
  const sandbox = new BrowserSandbox(memoryStore({mode: 'on', where: 'endpoint', endpoint: 'wss://sandbox.test:9443/pw'}), tokenLocker(token));
  sandbox.connect = echoing;
  const refused = await sandbox.pick(owner, false).then(() => null, error => error);
  assert.deepEqual(given.headers, {Authorization: `Bearer ${token}`});
  assert.equal(refused.message,
    'The browser sandbox cannot be used: Branch could not connect to wss://sandbox.test:9443: nothing answered at that address. Check the browser sandbox setting, or switch it off.');
  assert.ok(!refused.message.includes(token) && !String(refused.stack).includes(token));

  const silent = fakeBrowser('');
  await assert.rejects(connectEndpoint(async () => silent, 'ws://box:1/', undefined), /ws:\/\/box:1 did not answer as a browser/);
  assert.equal(silent.state.closed, true, 'a connection that is not a browser is closed again');
  const broken = {...fakeBrowser(), version: () => { throw new Error(`bad ${token}`); }};
  await assert.rejects(connectEndpoint(async () => broken, 'ws://box:1/', token), error => !error.message.includes(token) && /did not answer as a browser/.test(error.message));
  const noToken = new BrowserSandbox(memoryStore({mode: 'on', where: 'endpoint', endpoint: 'ws://box:1/'}), noLocker);
  noToken.connect = async (_endpoint, options) => { given = options; return fakeBrowser(); };
  await noToken.pick(owner, false);
  assert.equal(given.headers, undefined, 'no token saved: no header');
});

test('A2019: createBranch starts with a saved sandbox setting that cannot be reached, and browser.navigate refuses in one sentence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'branch-sandbox-start-'));
  const {origin, stop} = await sites();
  const provider = {name: 'scripted', async complete() { return {content: 'Done.', toolCalls: []}; }};
  // The fixture site is on this computer, so this launch's web policy lets private addresses through.
  const options = {workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider, web: {allowPrivateAddresses: true}};
  const first = await createBranch(options);
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const deadPort = closed.address().port; closed.close(); await once(closed, 'close');
  first.store.save('settings', first.runtime.owner, 'browser-container', {mode: 'on', where: 'endpoint', endpoint: `ws://127.0.0.1:${deadPort}/`});
  await first.close();
  const app = await createBranch(options);
  await mkdir(join(root, 'config'), {recursive: true});
  const config = join(root, 'config', 'integrations.json');
  await writeFile(config, JSON.stringify({browser: {allowedOrigins: [origin]}}));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await stop(); await discardTemp(root); });
  const browser = integrations.hosted.browser;
  const context = {...runContext('refused-run'), owner: app.runtime.owner};
  await assert.rejects(browser.navigate(origin, context),
    {message: `The browser sandbox cannot be used: Branch could not connect to ws://127.0.0.1:${deadPort}: nothing answered at that address. Check the browser sandbox setting, or switch it off.`});
  // Docker next, read at the next first launch; the fake runner says Docker is missing.
  app.store.save('settings', app.runtime.owner, 'browser-container', {mode: 'on', where: 'docker'});
  browser.sandbox.runner = async () => { throw Object.assign(new Error('spawn docker ENOENT'), {code: 'ENOENT'}); };
  await assert.rejects(browser.navigate(origin, {...context, runId: 'docker-run'}),
    {message: 'The browser sandbox cannot be used: Docker is not installed on this computer. Check the browser sandbox setting, or switch it off.'});
});

test('A2019: the owner saves the token into the locker, reads back only tokenSaved, and a short-lived run key cannot change it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'branch-sandbox-route-'));
  const provider = {name: 'scripted', async complete() { return {content: 'Done.', toolCalls: []}; }};
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider});
  const server = await startServer(app, {dataDir: join(root, 'data'), port: 0});
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = app.sessionTokens.create(app.runtime.owner, {name: 'script', scope: 'run', minutes: 5}).token;
  const call = (method, key, body) => fetch(`${server.url}/api/browser/container`, {method,
    headers: {authorization: `Bearer ${key}`, ...(body ? {'content-type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})}).then(async response => ({status: response.status, text: await response.text()}));
  const token = 'sandbox-token-5f4e3d';
  const saved = await call('POST', server.token, {mode: 'on', where: 'endpoint', endpoint: 'wss://sandbox.test/pw', token});
  assert.equal(saved.status, 200, saved.text);
  assert.ok(!saved.text.includes(token));
  assert.equal(JSON.parse(saved.text).tokenSaved, true);
  const read = await call('GET', server.token);
  assert.ok(!read.text.includes(token));
  assert.deepEqual(JSON.parse(read.text), {mode: 'on', where: 'endpoint', endpoint: 'wss://sandbox.test/pw', damaged: false,
    tokenSaved: true, image: `mcr.microsoft.com/playwright:v${playwrightVersion()}-noble`});
  assert.deepEqual(await app.store.secrets.resolve(app.runtime.owner, 'default', [tokenName], {purpose: 'test'}), {[tokenName]: token});
  assert.equal(JSON.stringify(app.store.get('settings', app.runtime.owner, 'browser-container')).includes(token), false);

  const refused = await call('POST', run, {mode: 'off', token: 'replaced-by-script'});
  assert.equal(refused.status, 401);
  assert.match(refused.text, /short-lived key/);
  assert.equal(readBrowserContainer(app.store, app.runtime.owner).mode, 'on', 'the run key changed nothing');
  assert.deepEqual(await app.store.secrets.resolve(app.runtime.owner, 'default', [tokenName], {purpose: 'test'}), {[tokenName]: token});

  const bad = await call('POST', server.token, {endpoint: 'http://sandbox.test/'});
  assert.notEqual(bad.status, 200);
  assert.equal(readBrowserContainer(app.store, app.runtime.owner).endpoint, 'wss://sandbox.test/pw');
  const removed = await call('POST', server.token, {token: null, mode: 'off'});
  assert.deepEqual([JSON.parse(removed.text).tokenSaved, JSON.parse(removed.text).mode], [false, 'off']);
});

test('A2172/A2042: through the endpoint path, a real connected Chromium loads an allowed page and refuses every other host', {skip: noChromium}, async t => {
  const token = 'door-token-1a2b3c';
  const remote = await guardedServer(token);
  const {origin, forbiddenOrigin, hits, stop} = await sites();
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.policy = new NetworkPolicy({blockedHosts: ['blocked.test'], allowPrivateAddresses: true});
  browser.sandbox = new BrowserSandbox(memoryStore({mode: 'on', where: 'endpoint', endpoint: remote.endpoint}), tokenLocker(token));
  t.after(async () => { await browser.close().catch(() => undefined); await remote.stop(); await stop(); });
  const context = runContext('endpoint-run');
  const opened = await browser.navigate(`${origin}/one`, context);
  assert.equal(opened.title, 'Allowed page');
  assert.deepEqual(remote.seen, [`Bearer ${token}`], 'one connection, carrying the token');
  assert.match(await waitForResult(browser, context), /refused\|run=one/, 'the page itself could not reach the other host');
  assert.equal(hits.forbidden, 0);
  await assert.rejects(browser.navigate(`${forbiddenOrigin}/`, context), /not an allowed origin/);
  const policed = new BranchBrowser({allowedOrigins: [origin, 'http://blocked.test']});
  policed.policy = browser.policy;
  policed.sandbox = new BrowserSandbox(memoryStore({mode: 'on', where: 'endpoint', endpoint: remote.endpoint}), tokenLocker(token));
  t.after(() => policed.close());
  await assert.rejects(policed.navigate('http://blocked.test/', runContext('policed')), /blocked\.test is on the blocked list/);
  assert.equal(hits.forbidden, 0);

  const wrong = new BranchBrowser({allowedOrigins: [origin]});
  wrong.sandbox = new BrowserSandbox(memoryStore({mode: 'on', where: 'endpoint', endpoint: remote.endpoint}), tokenLocker('wrong-token-000'));
  t.after(() => wrong.close());
  const refused = await wrong.navigate(origin, runContext('wrong-token')).then(() => null, error => error);
  assert.match(refused.message, /^The browser sandbox cannot be used: Branch could not connect to ws:\/\/127\.0\.0\.1:\d+: it turned the token down\./);
  assert.ok(!refused.message.includes('wrong-token-000'));
});

test('A2172/A2042: two tasks on one connected browser get two separate contexts, each under the network policy', {skip: noChromium}, async t => {
  const server = await chromium.launchServer({host: '127.0.0.1', headless: true});
  const {origin, hits, stop} = await sites();
  const connected = [];
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.policy = new NetworkPolicy({allowPrivateAddresses: true});
  browser.sandbox = new BrowserSandbox(memoryStore({mode: 'on', where: 'endpoint', endpoint: server.wsEndpoint()}), noLocker);
  browser.sandbox.connect = async (endpoint, options) => { const made = await chromium.connect(endpoint, options); connected.push(made); return made; };
  t.after(async () => { await browser.close().catch(() => undefined); await server.close(); await stop(); });
  const first = runContext('task-a'), second = runContext('task-b');
  await Promise.all([browser.navigate(`${origin}/a`, first), browser.navigate(`${origin}/b`, second)]);
  assert.equal(connected.length, 1, 'both tasks share one connection');
  assert.equal(connected[0].contexts().length, 2, 'each task has a context of its own on the connected browser');
  assert.match(await waitForResult(browser, first), /refused\|run=a$/m);
  assert.match(await waitForResult(browser, second), /refused\|run=b$/m, 'no cookie crossed between the tasks');
  assert.equal(hits.forbidden, 0);
  await browser.closeRun(first);
  assert.equal(connected[0].contexts().length, 1, 'finishing one task closes only its context');
});

test('A2019: when needed, a task using a saved sign-in stays on this computer and other tasks use the sandbox', {skip: noChromium}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'branch-sandbox-signin-'));
  const server = await chromium.launchServer({host: '127.0.0.1', headless: true});
  const {origin, stop} = await sites();
  const connected = [];
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.profiles = new BrowserProfiles(join(root, 'profiles'), {key: async () => Buffer.alloc(32, 7)});
  browser.sandbox = new BrowserSandbox(memoryStore({mode: 'when-needed', where: 'endpoint', endpoint: server.wsEndpoint()}), noLocker);
  browser.sandbox.connect = async (endpoint, options) => { const made = await chromium.connect(endpoint, options); connected.push(made); return made; };
  t.after(async () => { await browser.close().catch(() => undefined); await server.close(); await stop(); await discardTemp(root); });
  await browser.profiles.create(owner, 'shop');
  const signedIn = runContext('with-sign-in');
  await browser.useProfile('shop', signedIn);
  await browser.navigate(`${origin}/local`, signedIn);
  assert.equal(connected.length, 0, 'the saved sign-in never left this computer');
  await browser.navigate(`${origin}/remote`, runContext('plain'));
  assert.equal(connected.length, 1);
  assert.equal(connected[0].contexts().length, 1, 'only the plain task is on the sandbox browser');
});
