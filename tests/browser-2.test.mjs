import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {BrowserProfiles} from '../dist/integrations/browser-profiles.js';
import {attach, attachRefusal, attachedAddressRefusal} from '../dist/integrations/browser-attach.js';
import {recordingEntries, recordingText, leaksIn} from '../dist/integrations/browser-trace.js';
import {registerComputer} from '../dist/integrations/computer.js';
import {parseResults, requestFor} from '../dist/integrations/web-search.js';
import {hostRefusalFor} from '../dist/integrations/desktop-config.js';
import {browserSkillNames, browserSkillPackage, browserSkillList} from '../dist/browser-skills.js';
import {readSkillPackage} from '../dist/skill-package.js';
import {inferToolGroup} from '../dist/catalog.js';
import {WorkspaceFiles} from '../dist/files.js';
import {RunArtifacts, ToolRegistry, Budget} from '../dist/index.js';

const key = {key: async () => Buffer.alloc(32, 9)};
const password = 'hunter2-super-secret';
const sessionToken = 'branch-session-token-zzz987654321';

const runContext = (runId, owner = 'test', extra = []) => ({
  owner, workspace: '.', runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(['browser.read', 'browser.interact', ...extra]), depth: 0,
});

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

const page = body => `<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`;
const routes = {
  '/': page('<p>home</p>'),
  '/form': page(`<form>
    <label for="who">Your name</label><input id="who" name="who">
    <label for="pw">Password</label><input id="pw" type="password" value="${password}">
    <button id="save" type="button">Save it</button>
    <a href="/">Back home</a></form><p id="echo">nothing</p>
    <script>document.getElementById("who").addEventListener("input",e=>{document.getElementById("echo").textContent="name is "+e.target.value})</script>`),
  // The button is renamed by script a moment after load, so the selector a task remembered breaks.
  '/renamed': page(`<button id="old-save">Save</button>
    <script>setTimeout(()=>{const b=document.getElementById("old-save");b.id="new-save";b.textContent="Save"},50)</script>`),
  '/rerender': page(`<div id="box"><button class="a">Alpha</button><button class="b">Beta</button></div>
    <button id="shuffle" onclick="document.getElementById('box').innerHTML='<button class=\\'b\\'>Beta</button><button class=\\'c\\'>Gamma</button><button class=\\'a\\'>Alpha</button>'">Shuffle</button>`),
  '/rows': page(`<table><tbody>
    <tr class="r"><td class="n">Rent</td><td class="v">1200</td><td class="d">2026-03-01</td></tr>
    <tr class="r"><td class="n">Power</td><td class="v">85</td><td class="d">2026-03-04</td></tr></tbody></table>`),
  '/upload': page('<input id="pick" type="file"><p id="got">nothing</p><script>document.getElementById("pick").addEventListener("change",e=>{document.getElementById("got").textContent="received "+e.target.files[0].name})</script>'),
  '/cookie': page('<p id="who">?</p><script>document.getElementById("who").textContent="cookie is "+document.cookie</script>'),
};

async function fixture() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(routes[path] ?? routes['/']);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {origin: `http://127.0.0.1:${server.address().port}`,
    stop: async () => { server.close(); await once(server, 'close'); }};
}

/** A browser, a workspace and a place for kept files, all in one scratch folder. */
async function harness(label, config = {}) {
  const root = await scratch(label);
  const workspace = join(root, 'workspace'), data = join(root, 'data');
  await mkdir(workspace, {recursive: true});
  await mkdir(data, {recursive: true});
  const {origin, stop} = await fixture();
  const browser = new BranchBrowser({allowedOrigins: [origin], ...config});
  browser.profiles = new BrowserProfiles(join(data, 'browser-profiles'), key);
  browser.artifacts = new RunArtifacts(join(data, 'artifacts'));
  browser.files = new WorkspaceFiles(workspace);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return {root, workspace, data, origin, browser, registry,
    close: async () => { await browser.close(); await stop(); await rm(root, {recursive: true, force: true}); }};
}

/** The registry hands a result back and throws when a tool refuses, so a refusal is a rejection. */
const ok = result => result;
const refusal = async (promise, pattern) => {
  await assert.rejects(() => promise, error => { assert.match(error.message, pattern); return true; });
};

test('a file is sent from the workspace and anything outside it is refused', async () => {
  const h = await harness('browser2-upload');
  try {
    await writeFile(join(h.workspace, 'note.txt'), 'inside the workspace');
    const context = runContext('run-upload');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/upload`}, context);
    ok(await h.registry.execute('browser.upload', {selector: '#pick', path: 'note.txt'}, context));
    const seen = ok(await h.registry.execute('browser.extract', {selector: '#got', limit: 1}, context));
    assert.match(seen.rows[0].text, /received note\.txt/);

    await refusal(h.registry.execute('browser.upload', {selector: '#pick', path: '../secret.txt'}, context),
      /Path denied/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('an element picture of a password box holds no readable password', async () => {
  const h = await harness('browser2-shot');
  try {
    const context = runContext('run-shot');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    const shot = ok(await h.registry.execute('browser.screenshot', {selector: 'form'}, context));
    // The runtime only shows the model a picture in this exact shape; the shape is the proof it can.
    assert.equal(shot.mediaType, 'image/png');
    assert.ok(shot.sha256 && shot.bytes > 0 && shot.path);
    const bytes = await readFile(shot.path);
    assert.equal(bytes.includes(Buffer.from(password, 'utf8')), false, 'no password bytes in the picture');
    // What the blacking-out really does is checked in the page itself.
    const blacked = ok(await h.registry.execute('browser.shape', {
      fields: {value: {selector: '#pw', attribute: 'value'}},
    }, context));
    assert.equal(blacked.rows[0].value, password, 'the value is still in the page; only the picture hides it');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('things on the page are numbered and keep their numbers when the page redraws itself', async () => {
  const h = await harness('browser2-marks');
  try {
    const context = runContext('run-marks');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/rerender`}, context);
    const first = ok(await h.registry.execute('browser.annotate', {}, context));
    const alpha = first.marks.find(mark => mark.name === 'Alpha');
    const beta = first.marks.find(mark => mark.name === 'Beta');
    assert.ok(alpha && beta, 'both buttons are numbered');
    assert.match(first.map, /^\[\d+\] button "Alpha"$/m);

    // The page throws its buttons away and draws them back in a different order, with a new one.
    ok(await h.registry.execute('browser.act', {action: 'click', name: 'Shuffle'}, context));
    const second = ok(await h.registry.execute('browser.annotate', {}, context));
    assert.equal(second.marks.find(mark => mark.name === 'Alpha').id, alpha.id, 'Alpha keeps its number');
    assert.equal(second.marks.find(mark => mark.name === 'Beta').id, beta.id, 'Beta keeps its number');
    const gamma = second.marks.find(mark => mark.name === 'Gamma');
    assert.ok(gamma && ![alpha.id, beta.id].includes(gamma.id), 'the new button gets a number of its own');

    // The labels are decoration: the page's own description never mentions them.
    const snapshot = ok(await h.registry.execute('browser.snapshot', {}, context));
    assert.equal(snapshot.accessibility.includes('branch-mark-layer'), false);
    ok(await h.registry.execute('browser.unmark', {}, context));
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('shaped extraction returns data in the shape asked for and refuses what does not fit', async () => {
  const h = await harness('browser2-shape');
  try {
    const context = runContext('run-shape');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/rows`}, context);
    const shaped = ok(await h.registry.execute('browser.shape', {
      rows: 'tr.r',
      fields: {name: {selector: '.n', required: true}, amount: {selector: '.v', type: 'number', required: true},
        due: {selector: '.d', type: 'date', required: true}},
    }, context));
    assert.deepEqual(shaped.rows, [
      {name: 'Rent', amount: 1200, due: '2026-03-01'},
      {name: 'Power', amount: 85, due: '2026-03-04'},
    ]);

    // Asking for a number where there are only words is refused by name rather than guessed at.
    await refusal(h.registry.execute('browser.shape', {
      rows: 'tr.r', fields: {amount: {selector: '.n', type: 'number', required: true}},
    }, context), /amount/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a renamed selector heals by name, the way that worked is recorded, and a hopeless one stops', async () => {
  const h = await harness('browser2-heal');
  const spans = [];
  h.browser.tracer = {start: (runId, kind, name, attributes) => {
    const row = {runId, kind, name, attributes, status: ''};
    spans.push(row);
    return {end: (status, _message, extra) => { row.status = status; Object.assign(row.attributes, extra); }};
  }};
  try {
    const context = runContext('run-heal');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/renamed`}, context);
    await h.registry.execute('browser.wait', {selector: '#new-save', timeoutMs: 3000}, context);
    // The selector the task remembered is gone; the name on the button still works.
    const healed = ok(await h.registry.execute('browser.act',
      {action: 'click', selector: '#old-save', name: 'Save'}, context));
    assert.equal(healed.foundBy, 'role');
    assert.equal(healed.attempts, 2);
    assert.deepEqual(healed.tried, ['selector', 'role']);
    assert.equal(spans.at(-1).attributes.foundBy, 'role');
    assert.equal(spans.at(-1).attributes.healed, true);

    await refusal(h.registry.execute('browser.act',
      {action: 'click', selector: '#nothing', name: 'Nowhere', mark: 99}, context),
      /after 4 tries \(selector, role, text, mark\)/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('the borrowed browser reuses its cookies, refuses a bank, and is let go without being closed', async () => {
  const h = await harness('browser2-cdp');
  // A headless Chromium this test starts itself, standing in for the owner's own browser.
  const port = 9411;
  const owned = await chromium.launchPersistentContext('', {headless: true, args: [`--remote-debugging-port=${port}`]});
  try {
    const seed = await owned.newPage();
    await seed.goto(`${h.origin}/cookie`);
    await seed.evaluate(() => { document.cookie = 'branch_borrowed=knows-me-4242; max-age=600; path=/'; });
    const before = owned.pages().length;

    h.browser.store = {get: () => ({data: {enabled: true, port, runId: 'run-borrow',
      grantedAt: new Date().toISOString()}}), save: () => undefined};
    const context = runContext('run-borrow');
    const borrowed = ok(await h.registry.execute('browser.borrow', {action: 'borrow'}, context));
    assert.equal(borrowed.using, 'your own browser');
    assert.ok(borrowed.version.length > 0);

    await h.registry.execute('browser.navigate', {url: `${h.origin}/cookie`}, context);
    const seen = ok(await h.registry.execute('browser.extract', {selector: '#who', limit: 1}, context));
    assert.match(seen.rows[0].text, /knows-me-4242/, 'the sign-in the owner already had is reused');

    // A bank is refused even though the origin list would otherwise allow it.
    h.browser.tracer = undefined;
    assert.match(attachedAddressRefusal('https://secure.chase.com/login') ?? '', /will not use your own browser/);
    assert.equal(attachedAddressRefusal(`${h.origin}/`), null);

    ok(await h.registry.execute('browser.borrow', {action: 'give back'}, context));
    // Letting go never closes the owner's browser, and never closes a tab of theirs.
    const after = await owned.newPage();
    await after.goto(`${h.origin}/`);
    assert.equal(owned.pages().filter(p => !p.isClosed()).length >= before, true, 'their tabs are still there');
    await after.close();
  } finally { await owned.close(); await h.close(); }
});

test('the switch for the owner\'s own browser is off by default, tied to one task, and runs out', () => {
  assert.match(attachRefusal({enabled: false, port: 9222, runId: '', grantedAt: ''}, 'r1') ?? '', /not allowed/);
  const fresh = {enabled: true, port: 9222, runId: 'r1', grantedAt: new Date().toISOString()};
  assert.equal(attachRefusal(fresh, 'r1'), null);
  assert.match(attachRefusal(fresh, 'r2') ?? '', /different task/);
  assert.match(attachRefusal({...fresh, grantedAt: new Date(Date.now() - 3.6e6).toISOString()}, 'r1') ?? '', /run out/);
  assert.match(hostRefusalFor('vault.bitwarden.com') ?? '', /money or passwords/);
  assert.match(hostRefusalFor('my-local-bank.example') ?? '', /looks like a bank/);
  assert.equal(hostRefusalFor('example.com'), null);
});

test('a kept recording exists, is a real archive, and holds no password and no key', async () => {
  const h = await harness('browser2-trace');
  try {
    const context = runContext('run-trace');
    ok(await h.registry.execute('browser.recording', {action: 'start'}, context));
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    // Typing a password is refused outright, so no password can reach a recorded step either.
    await refusal(h.registry.execute('browser.act',
      {action: 'fill', selector: '#pw', value: sessionToken}, context), /Password fields/);
    ok(await h.registry.execute('browser.act', {action: 'fill', selector: '#who', value: 'Jane'}, context));
    const kept = ok(await h.registry.execute('browser.recording', {action: 'keep'}, context));

    const bytes = await readFile(kept.path);
    const entries = recordingEntries(bytes);
    assert.ok(entries.has('trace.trace'), 'the recording really is a Playwright trace');
    assert.ok(bytes.length > 0 && kept.bytes === bytes.length);
    // The proof has to be against the unpacked text: a search of the packed bytes proves nothing.
    const text = recordingText(bytes);
    assert.ok(text.length > 100, 'the recording was unpacked, not searched while squashed');
    assert.equal(text.includes(password), false, 'no password value anywhere in the recording');
    assert.equal(text.includes(sessionToken), false, 'no key anywhere in the recording');
    assert.deepEqual(leaksIn(bytes, [password, sessionToken]), []);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('the shared way of saying "look at this, press that" goes to the page or to a window', async () => {
  const h = await harness('browser2-computer');
  const asked = [];
  const window = {
    read: async input => { asked.push(['read', input.window]); return {window: input.window, parts: []}; },
    click: async input => { asked.push(['click', input.window]); return {clicked: input.name}; },
    type: async input => { asked.push(['type', input.window]); return {typed: input.text}; },
  };
  registerComputer(h.registry, {page: h.browser, window});
  assert.equal(inferToolGroup('computer.look'), 'desktop', 'the new tools belong in a toolbox');
  try {
    const context = runContext('run-facade', 'test', ['desktop.view', 'desktop.control']);
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    const page = ok(await h.registry.execute('computer.look', {at: 'page'}, context));
    assert.equal(page.at, 'page');
    assert.ok(page.marks.some(mark => mark.name === 'Save it'), 'the page was numbered, not a window read');
    assert.equal(asked.length, 0, 'nothing went to the screen layer');

    const inWindow = ok(await h.registry.execute('computer.look', {at: 'window', window: 'Notepad'}, context));
    assert.equal(inWindow.at, 'window');
    assert.deepEqual(asked, [['read', 'Notepad']]);
    ok(await h.registry.execute('computer.type', {at: 'window', window: 'Notepad', name: 'Body', text: 'hello'}, context));
    assert.deepEqual(asked.at(-1), ['type', 'Notepad']);

    // A task that may use the browser but not the screen cannot reach a window through this.
    await refusal(h.registry.execute('computer.look', {at: 'window', window: 'Notepad'}, runContext('run-facade-2')),
      /desktop\.view/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('each search service is asked in its own way and its answer is read correctly', () => {
  const settings = {backend: 'brave', keySecret: 'BRAVE_KEY'};
  const brave = requestFor(settings, 'garden gates', 3, 'k-123');
  assert.equal(brave.method, 'GET');
  assert.match(brave.url, /api\.search\.brave\.com/);
  assert.equal(brave.headers['x-subscription-token'], 'k-123');
  assert.deepEqual(parseResults('brave', JSON.stringify({web: {results: [
    {title: 'Gates', url: 'https://example.com/g', description: 'About <b>gates</b>'},
  ]}})), [{title: 'Gates', url: 'https://example.com/g', snippet: 'About gates'}]);

  const tavily = requestFor({backend: 'tavily', keySecret: 'T'}, 'q', 2, 'k-9');
  assert.equal(tavily.method, 'POST');
  assert.equal(tavily.headers.authorization, 'Bearer k-9');
  assert.deepEqual(parseResults('tavily', JSON.stringify({results: [
    {title: 'T', url: 'https://example.com/t', content: 'body'},
  ]})), [{title: 'T', url: 'https://example.com/t', snippet: 'body'}]);

  assert.deepEqual(parseResults('exa', JSON.stringify({results: [{title: 'E', url: 'https://example.com/e'}]})),
    [{title: 'E', url: 'https://example.com/e', snippet: ''}]);
  assert.deepEqual(parseResults('serper', JSON.stringify({organic: [{title: 'S', link: 'https://example.com/s', snippet: 'x'}]})),
    [{title: 'S', url: 'https://example.com/s', snippet: 'x'}]);

  const searx = requestFor({backend: 'searxng', searxngUrl: 'http://127.0.0.1:8080/'}, 'q', 5, '');
  assert.equal(searx.url, 'http://127.0.0.1:8080/search?q=q&format=json');
  assert.deepEqual(parseResults('searxng', JSON.stringify({results: [{title: 'X', url: 'https://example.com/x', content: 'c'}]})),
    [{title: 'X', url: 'https://example.com/x', snippet: 'c'}]);

  assert.throws(() => requestFor({backend: 'searxng'}, 'q', 5, ''), /address of your SearXNG/);
  assert.throws(() => parseResults('brave', 'not json'), /not results/);
  // The free fallback still goes where it always went, so nothing already set up changes.
  assert.equal(requestFor({backend: 'duckduckgo'}, 'q', 5, '', 'http://127.0.0.1:1/lite/').url, 'http://127.0.0.1:1/lite/');
});

test('the three browser skills pack, read back, and describe steps the fixtures really support', async () => {
  assert.deepEqual(browserSkillNames.sort(),
    ['fill-a-form-from-a-document', 'search-and-summarise', 'watch-a-page-for-a-change']);
  for (const name of browserSkillNames) {
    const {manifest, files} = readSkillPackage(browserSkillPackage(name));
    assert.equal(manifest.name, name);
    assert.equal(manifest.format, 'branch-skill-package');
    assert.deepEqual(manifest.permissions, ['skills.read'], 'a skill of instructions asks for nothing else');
    assert.ok(files['SKILL.md'].length > 200);
  }
  assert.equal(browserSkillList().length, 3);

  // What "fill a form from a document" tells the assistant to do is run against the fixture form.
  const h = await harness('browser2-skills');
  try {
    const context = runContext('run-skill');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    const marks = ok(await h.registry.execute('browser.annotate', {}, context));
    const box = marks.marks.find(mark => mark.name === 'Your name');
    assert.ok(box, 'the skill\'s step 2 finds the numbered boxes it talks about');
    ok(await h.registry.execute('browser.act', {action: 'fill', mark: box.id, value: 'Jane Doe'}, context));
    const filled = ok(await h.registry.execute('browser.shape', {
      fields: {echo: {selector: '#echo', required: true}},
    }, context));
    assert.equal(filled.rows[0].echo, 'name is Jane Doe');
    // Step 6: the skill never submits, and the password box it is told to leave alone refuses.
    await refusal(h.registry.execute('browser.act',
      {action: 'fill', mark: marks.marks.find(m => m.name === 'Password').id, value: 'x'}, context),
      /Password fields/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('connecting to a browser that is not there says so in plain words', async () => {
  await assert.rejects(() => attach(9),
    /could not find a browser listening on door 9/);
});
