import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BranchBrowser,registerBrowser} from '../dist/integrations/browser.js';
import {ToolRegistry,Budget,createBranch} from '../dist/index.js';

const runContext = (runId, owner = 'test', signal = new AbortController().signal) => ({
  owner, workspace: '.', runId, signal, budget: new Budget(),
  permissions: new Set(['browser.read', 'browser.interact']), depth: 0,
});
async function fixtureServer(handler) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
function observeLaunch(hold = false) {
  const original = chromium.launch;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const probe = { ready, release, restore: () => { chromium.launch = original; }, browser: null, launches: 0 };
  chromium.launch = async (...args) => {
    probe.launches++;
    probe.browser = await original.apply(chromium, args);
    started();
    if (hold) await gate;
    return probe.browser;
  };
  return probe;
}

test('isolated browser completes form workflow and refuses destinations outside configured origins',async()=>{
  const server=createServer((_request,response)=>response.end('<!doctype html><title>Branch fixture</title><label>Name<input></label><label>Password<input type="PASSWORD"></label><button onclick="document.querySelector(\'p\').textContent=\'Hello \'+document.querySelector(\'input\').value">Greet</button><p></p>'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=new BranchBrowser({allowedOrigins:[origin]});const registry=new ToolRegistry();registerBrowser(registry,browser);
  const context={owner:'test',workspace:'.',runId:'test',signal:new AbortController().signal,budget:new Budget(),permissions:new Set(['browser.read','browser.interact']),depth:0};
  try{
    await registry.execute('browser.navigate',{url:origin},context);
    await registry.execute('browser.fill',{label:'Name',value:'Branch'},context);
    await registry.execute('browser.click',{role:'button',name:'Greet'},context);
    const snapshot=await registry.execute('browser.snapshot',{},context);
    assert.match(snapshot.accessibility,/Hello Branch/);
    await assert.rejects(registry.execute('browser.fill',{label:'Password',value:'not-a-real-secret'},context),/credential integration/);
    await assert.rejects(registry.execute('browser.navigate',{url:'https://example.com'},context),/allowed origin/);
    await assert.rejects(registry.execute('browser.fill',{label:'Name',value:'Denied'},{...context,permissions:new Set(['browser.read'])}),/Permission/);
  }finally{await browser.close();server.close();await once(server,'close');}
});

test('an allowed site cannot redirect the browser to an unlisted origin',async()=>{
  let forbiddenHits=0;
  const forbidden=createServer((_request,response)=>{forbiddenHits++;response.end('must not load');});
  forbidden.listen(0,'127.0.0.1');await once(forbidden,'listening');
  const forbiddenUrl=`http://127.0.0.1:${forbidden.address().port}`;
  const allowed=createServer((_request,response)=>{response.writeHead(302,{location:forbiddenUrl});response.end();});
  allowed.listen(0,'127.0.0.1');await once(allowed,'listening');
  const origin=`http://127.0.0.1:${allowed.address().port}`;
  const browser=new BranchBrowser({allowedOrigins:[origin]});
  const context={owner:'test',workspace:'.',runId:'test',signal:new AbortController().signal,budget:new Budget(),permissions:new Set(['browser.read']),depth:0};
  try{await assert.rejects(browser.navigate(origin,context));assert.equal(forbiddenHits,0);}
  finally{await browser.close();allowed.close();forbidden.close();await Promise.all([once(allowed,'close'),once(forbidden,'close')]);}
});

test('overlapping runs and owners submit their own form values and release bounded contexts', async () => {
  const saves = [];
  const {server, origin} = await fixtureServer((request, response) => {
    if (request.url.startsWith('/save')) saves.push(new URL(request.url, 'http://fixture').searchParams.get('name'));
    response.end('<label>Name<input name="name" form="form"></label><form id="form" action="/save"><button>Save</button></form>');
  });
  const probe = observeLaunch(), browser = new BranchBrowser({allowedOrigins: [origin], maxRuns: 3});
  const registry = new ToolRegistry(); registerBrowser(registry, browser);
  const a = runContext('A'), b = runContext('B'), otherOwner = runContext('A', 'other');
  try {
    await Promise.all([a,b,otherOwner].map(context => browser.navigate(origin, context)));
    await browser.fill('Name', 'Alice', a);
    await browser.fill('Name', 'Bob', b);
    await browser.fill('Name', 'Carol', otherOwner);
    assert.equal(probe.launches, 1);
    assert.equal(probe.browser.contexts().length, 3);
    await assert.rejects(browser.navigate(origin, runContext('overflow')), /active run limit/);
    for (const context of [a,b,otherOwner]) await browser.click('button', 'Save', context);
    assert.deepEqual(saves, ['Alice', 'Bob', 'Carol']);
    await registry.finishRun(a);
    assert.equal(probe.browser.contexts().length, 2);
    await browser.navigate(origin, runContext('replacement'));
    assert.equal(probe.browser.contexts().length, 3);
  } finally { await browser.close(); probe.restore(); server.close(); await once(server, 'close'); }
});

test('close drains a held real Chromium launch and prevents all later startup', async () => {
  const probe = observeLaunch(true), browser = new BranchBrowser({allowedOrigins: ['http://127.0.0.1']});
  const navigation = assert.rejects(browser.navigate('http://127.0.0.1', runContext('closing')), /closed/);
  try {
    await probe.ready;
    let closed = false;
    const closing = browser.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    probe.release();
    await Promise.all([navigation, closing, browser.close()]);
    assert.equal(probe.browser.isConnected(), false);
    await assert.rejects(browser.navigate('http://127.0.0.1', runContext('later')), /closed/);
    assert.equal(probe.launches, 1);
  } finally { probe.release(); await browser.close(); probe.restore(); }
});

test('cancellation drains pending startup without creating a run context', async () => {
  const probe = observeLaunch(true), browser = new BranchBrowser({allowedOrigins: ['http://127.0.0.1'], maxRuns: 1});
  const controller = new AbortController(), context = runContext('cancelled', 'test', controller.signal);
  const navigation = assert.rejects(browser.navigate('http://127.0.0.1', context), /closed|abort/i);
  try {
    await probe.ready;
    controller.abort();
    let drained = false;
    const cleanup = browser.closeRun(context).then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    probe.release();
    await Promise.all([navigation, cleanup]);
    assert.equal(probe.browser.contexts().length, 0);
  } finally { probe.release(); await browser.close(); probe.restore(); }
});

test('cancelling an idle run closes only its context and leaves another run usable', async () => {
  const {server, origin} = await fixtureServer((_request,response) => response.end('<label>Name<input></label>'));
  const probe = observeLaunch(), browser = new BranchBrowser({allowedOrigins: [origin]});
  const controller = new AbortController(), a = runContext('A', 'test', controller.signal), b = runContext('B');
  try {
    await Promise.all([browser.navigate(origin,a), browser.navigate(origin,b)]);
    controller.abort();
    await browser.closeRun(a);
    assert.equal(probe.browser.contexts().length, 1);
    await browser.fill('Name','Bob',b);
    assert.match((await browser.snapshot(b)).accessibility, /Bob/);
  } finally { await browser.close(); probe.restore(); server.close(); await once(server, 'close'); }
});

test('runtime completion and manual tool completion await browser run cleanup', async () => {
  const {server, origin} = await fixtureServer((_request,response) => response.end('<title>Lifecycle</title>'));
  const scratch = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'Codex-session-files');
  await mkdir(scratch, {recursive: true});
  const root = await mkdtemp(join(scratch, 'branch-browser-'));
  let calls = 0;
  const provider = { name: 'browser-fixture', async complete() {
    return calls++ ? {content: 'done', toolCalls: []} : {content: '', toolCalls: [
      {id: 'navigate', name: 'browser.navigate', arguments: JSON.stringify({url: origin})},
    ]};
  }};
  const app = await createBranch({workspace: join(root,'workspace'), dataDir: join(root,'data'), provider});
  const probe = observeLaunch(), browser = new BranchBrowser({allowedOrigins: [origin], maxRuns: 1});
  registerBrowser(app.registry, browser);
  try {
    const run = await app.runtime.run({prompt: 'visit'});
    assert.equal(run.status, 'completed');
    assert.equal(probe.browser.contexts().length, 0);
    assert.equal((await app.runtime.executeTool('browser.navigate', {url: origin})).title, 'Lifecycle');
    assert.equal(probe.browser.contexts().length, 0);
  } finally {
    await browser.close(); probe.restore(); await app.close();
    server.close(); await once(server, 'close'); await rm(root, {recursive: true, force: true});
  }
});
