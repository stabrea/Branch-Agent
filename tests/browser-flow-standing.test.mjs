import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBranch} from '../dist/index.js';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {addPolicyRule, readPolicy, savePolicy} from '../dist/policy.js';

/*
 * FQ-execution.browser (review of ab478310): "Yes, always" on a browser.flow question wrote the
 * standing rule browser.flow on "*", because the flow named no target, and a conversation yes kept as
 * (browser.flow, "") let a different flow through. The real app's gate, approve and checkPolicy are
 * used throughout; the browser's own actions are replaced by a recorder, so no browser is started.
 */

const docs = {steps: [{action: 'navigate', url: 'https://docs.example.com/guide'}, {action: 'click', role: 'link', name: 'Next'}]};
const shop = {steps: [{action: 'navigate', url: 'https://shop.example.com/cart'}, {action: 'click', role: 'button', name: 'Place order'}]};
const both = {steps: [{action: 'navigate', url: 'https://docs.example.com/guide'}, {action: 'navigate', url: 'https://shop.example.com/cart'}]};
// A flow that opens no page: on a window with nothing open it names no website at all.
const nowhere = {steps: [{action: 'click', role: 'button', name: 'Place order'}]};

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

/** A model that calls browser.flow with `next.args` and then says it is done, every task. */
function scriptedModel() {
  const model = {name: 'scripted', args: null, calls: 0, async complete() {
    return model.calls++ % 2 === 0
      ? {content: '', toolCalls: [{id: `c${model.calls}`, name: 'browser.flow', arguments: JSON.stringify(model.args)}]}
      : {content: 'done', toolCalls: []};
  }};
  return model;
}

/** The app on `root`, with a browser whose actions only write down what they would have done. */
async function boot(root, model, did) {
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider: model});
  const browser = new BranchBrowser({allowedOrigins: ['https://docs.example.com', 'https://shop.example.com']});
  let host = '';
  Object.assign(browser, {
    checkAddress: async () => {},
    hostFor: () => host,
    navigate: async (url) => { host = new URL(url).host; did.push(`navigate ${url}`); return {url, title: 'page'}; },
    click: async (role, name) => { did.push(`click ${name} on ${host}`); return {url: `https://${host}/`, clicked: name}; },
    fill: async (label) => { did.push(`fill ${label} on ${host}`); return {filled: label}; },
    screenshot: async () => ({path: 'shot.png', bytes: 1, sha256: 'x', mediaType: 'image/png', url: `https://${host}/`}),
  });
  registerBrowser(app.registry, browser);
  return app;
}

async function harness(t, label) {
  const root = await scratch(label);
  const model = scriptedModel(), did = [];
  const state = {app: await boot(root, model, did), model, did, root};
  state.reopen = async () => { await state.app.close(); state.app = await boot(root, model, did); };
  t.after(async () => { await state.app.close(); await rm(root, {recursive: true, force: true}); });
  return state;
}

/** One model turn that calls browser.flow with `args`, in `sessionId` when given. */
async function turn(state, args, sessionId) {
  state.model.args = args;
  state.model.calls = 0;
  return state.app.runtime.run({prompt: 'run the journey', ...(sessionId ? {sessionId} : {})});
}
const waitingIn = (state, run) => state.app.runtime.approvals.questionFor(run.sessionId);
const flowRules = (state) => readPolicy(state.app.store, state.app.runtime.owner).rules.filter(rule => rule.tool === 'browser.flow');

/**
 * The owner lets every single click and page through, and wants to be asked about browser.flow:
 * the flow's own question is the only thing that can stop a "Place order" click.
 */
function ownerRules(state) {
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.click', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});
}

test('(a) "Yes, always" on a docs flow never lets a later shop flow click "Place order" — in a new conversation or after a restart', async (t) => {
  const state = await harness(t, 'flow-always-docs');
  ownerRules(state);
  const first = await turn(state, docs);
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.tool, 'browser.flow');
  assert.equal(asked.target, 'docs.example.com', 'the flow is asked about on the website it declares');
  state.app.runtime.approve(first.sessionId, 'allow', 'always', asked.fingerprint);
  assert.deepEqual(flowRules(state).map(rule => rule.match), ['docs.example.com'], 'the standing yes names the docs site, not "*"');
  assert.equal((await turn(state, docs, first.sessionId)).status, 'completed');
  assert.deepEqual(state.did, ['navigate https://docs.example.com/guide', 'click Next on docs.example.com']);

  state.did.length = 0;
  const later = await turn(state, shop);
  assert.equal(later.status, 'needs_input', 'a new conversation is asked about the shop flow');
  assert.equal(waitingIn(state, later).tool, 'browser.flow');
  assert.equal(waitingIn(state, later).target, 'shop.example.com');
  assert.deepEqual(state.did, [], 'nothing on the shop site ran');

  await state.reopen();
  const restarted = await turn(state, shop);
  assert.equal(restarted.status, 'needs_input', 'after a restart too');
  assert.equal(waitingIn(state, restarted).target, 'shop.example.com');
  assert.deepEqual(state.did, [], '"Place order" was never clicked');
  // The kept rule still lets the docs flow it was given for through after the restart.
  assert.equal((await turn(state, docs)).status, 'completed');
});

test('(b) a conversation yes for one flow does not let a different flow with other targets through', async (t) => {
  const state = await harness(t, 'flow-session-yes');
  ownerRules(state);
  const first = await turn(state, docs);
  const asked = waitingIn(state, first);
  state.app.runtime.approve(first.sessionId, 'allow', 'session', asked.fingerprint);
  const same = state.app.store.createRun(state.app.runtime.owner, 'more', first.sessionId);
  const context = state.app.runtime.context({runId: same.id});
  assert.equal(state.app.store.run(same.id).sessionId, first.sessionId);
  // Callers that judge a call with no fingerprint (a task picked up again, a web page's own tool)
  // look up the kept answer by tool and target alone.
  assert.equal(state.app.runtime.checkPolicy('browser.flow', docs, context).decision, 'allow', 'the flow the yes was for');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', shop, context).decision, 'ask', 'a flow on another website is asked about');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', both, context).decision, 'ask', 'and so is one that adds a website');
  state.did.length = 0;
  const other = await turn(state, shop, first.sessionId);
  assert.equal(other.status, 'needs_input');
  assert.equal(waitingIn(state, other).target, 'shop.example.com');
  assert.deepEqual(state.did, []);
});

test('(b) a conversation yes for a flow that names no website answers only those very bytes', async (t) => {
  const state = await harness(t, 'flow-session-nowhere');
  ownerRules(state);
  const first = await turn(state, nowhere);
  const asked = waitingIn(state, first);
  assert.equal(asked.target, '');
  state.app.runtime.approve(first.sessionId, 'allow', 'session', asked.fingerprint);
  const same = state.app.store.createRun(state.app.runtime.owner, 'more', first.sessionId);
  const context = state.app.runtime.context({runId: same.id});
  const other = {steps: [{action: 'click', role: 'button', name: 'Delete account'}]};
  assert.equal(state.app.runtime.checkPolicy('browser.flow', other, context).decision, 'ask', 'looked up with no fingerprint');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', other, context, 'another-request').decision, 'ask');
});

test('(c) the flow question never offers or writes a rule broader than the websites it declares', async (t) => {
  const state = await harness(t, 'flow-no-star');
  ownerRules(state);
  // The owner's own rule for flows suggests keeping a yes for good.
  addPolicyRule(state.app.store, state.app.runtime.owner, {tool: 'browser.flow', match: '*', decision: 'ask', remember: 'always'});
  const kept = () => flowRules(state).filter(rule => rule.decision !== 'ask');
  // Two websites: the rule is kept for exactly that pair.
  const pair = await turn(state, both);
  const asked = waitingIn(state, pair);
  assert.equal(asked.target, '2 websites: docs.example.com, shop.example.com');
  assert.equal(asked.noAlways, undefined, 'a flow that names its websites may be given a standing yes');
  state.app.runtime.approve(pair.sessionId, 'allow', 'always', asked.fingerprint);
  assert.deepEqual(kept().map(rule => rule.match), ['2 websites: docs.example.com, shop.example.com']);
  const context = state.app.runtime.context({runId: state.app.store.createRun(state.app.runtime.owner, 'fresh').id});
  assert.equal(state.app.runtime.checkPolicy('browser.flow', both, context).decision, 'allow');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', shop, context).decision, 'ask', 'one of the pair alone is not covered');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', {steps: [
    {action: 'navigate', url: 'https://docs.example.com/guide'}, {action: 'navigate', url: 'https://evil.example.org/'},
  ]}, context).decision, 'ask', 'nor another pair');

  // No website: "Yes, always" is neither offered nor written, and the question is still waiting.
  const lost = await turn(state, nowhere);
  const blank = waitingIn(state, lost);
  assert.equal(blank.target, '');
  assert.equal(blank.noAlways, true, 'the card does not offer "Yes, always"');
  assert.equal(blank.remember, 'session', 'nor does the rule behind the question suggest keeping it for good');
  const before = flowRules(state).length;
  assert.throws(() => state.app.runtime.approve(lost.sessionId, 'allow', 'always', blank.fingerprint), /standing yes/);
  assert.throws(() => state.app.runtime.approve(lost.sessionId, 'deny', 'always', blank.fingerprint), /standing yes/);
  assert.equal(flowRules(state).length, before, 'no rule was written');
  assert.equal(kept().some(rule => rule.match === '*'), false);
  assert.equal(waitingIn(state, lost)?.fingerprint, blank.fingerprint, 'the refused answer left the question waiting');
  assert.throws(() => state.app.runtime.grantApproval('flow:step', {tool: 'browser.flow', target: '', label: 'a journey',
    source: 'owner', fingerprint: blank.fingerprint}, 'always'), /standing yes/, 'a saved workflow\'s yes is held to the same');
  assert.equal(flowRules(state).length, before);
  // A plain yes for this conversation still works.
  state.app.runtime.approve(lost.sessionId, 'allow', 'session', blank.fingerprint);
});

test('a browser.flow call that does not fit the tool is refused, not thrown, while its target is read', async (t) => {
  const state = await harness(t, 'flow-malformed');
  savePolicy(state.app.store, state.app.runtime.owner, {preset: 'ask-before-changes'});
  const context = state.app.runtime.context({runId: state.app.store.createRun(state.app.runtime.owner, 'bad').id});
  for (const sent of [{steps: 'nope'}, {steps: [{action: 'navigate', url: 'not a url'}]}, {}]) {
    assert.equal(state.app.registry.targetOf('browser.flow', sent, context), '');
    assert.equal(state.app.runtime.checkPolicy('browser.flow', sent, context).decision, 'deny');
  }
});

test('an owner rule allowing flows on *.example.com does not let a click on another website through, though the name of the pair ends in .example.com', async (t) => {
  const state = await harness(t, 'flow-pair-host-rule');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.flow', match: '*.example.com', decision: 'allow', remember: 'always'});
  const context = runtime.context({runId: store.createRun(runtime.owner, 'pair').id});
  assert.equal(runtime.checkPolicy('browser.flow', docs, context).decision, 'allow');
  assert.equal(runtime.checkPolicy('browser.flow', {steps: [
    {action: 'navigate', url: 'https://evil.example.org/'}, {action: 'click', role: 'button', name: 'Buy'},
    {action: 'navigate', url: 'https://docs.example.com/'},
  ]}, context).decision, 'ask', 'each website is weighed on its own: the click on evil.example.org is asked about');
});

// ------------------------------------------------------------------ FQ-execution.browser: once-only overrule

/**
 * A model that calls browser.flow with state.model.args, and when asked again, also calls
 * single-step browser.click with state.model.click arguments.
 */
function dualModel() {
  const model = {name: 'dual', args: null, click: null, calls: 0, async complete() {
    return model.calls++ % 2 === 0
      ? {content: '', toolCalls: [{id: `c${model.calls}`, name: 'browser.flow', arguments: JSON.stringify(model.args)}]}
      : {content: 'done', toolCalls: model.click ? [{id: `c${model.calls}`, name: 'browser.click', arguments: JSON.stringify(model.click)}] : []};
  }};
  return model;
}

test('(d) a flow step consumes its "Yes, just now" overrule and a retry then runs the flow; the yes does not cover a second identical click', async (t) => {
  const state = await harness(t, 'flow-just-now');
  state.model = dualModel();
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.click', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});

  state.model.click = {role: 'link', name: 'Next'};

  // First call asks about the flow step (the click on docs.example.com).
  const first = await turn(state, docs, 'flow-overrule');
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.tool, 'browser.flow');
  assert.equal(asked.target, 'docs.example.com');

  // User says "Yes, just now" — it should be a once-only overrule for that exact step.
  state.app.runtime.approve(first.sessionId, 'allow', 'never', asked.fingerprint);

  // Retry: the flow should run to completion, consuming the once-only overrule.
  state.did.length = 0;
  const second = await turn(state, docs, first.sessionId);
  assert.equal(second.status, 'completed', 'the flow ran to completion after "Yes, just now"');
  assert.deepEqual(state.did, ['navigate https://docs.example.com/guide', 'click Next on docs.example.com'],
    'the flow step executed successfully');

  // Third call: model calls single-step browser.click with the same arguments as the flow step.
  // This should NOT use the same "Yes" because the overrule is bound to the specific flow step,
  // not to just the tool and arguments.
  state.did.length = 0;
  const third = await turn(state, docs, first.sessionId);
  assert.equal(third.status, 'needs_input', 'the single-step click is asked about independently');
  const clickAsked = waitingIn(state, third);
  assert.equal(clickAsked.tool, 'browser.click');
  assert.equal(clickAsked.target, 'docs.example.com', 'the single-step click is judged on the same website');
  assert.deepEqual(state.did, [], 'the click was never executed, it was asked about first');
});

test('(d2) a yes for a flow step on shop.example.com does not cover the same click on docs.example.com', async (t) => {
  const state = await harness(t, 'flow-cross-host');
  state.model = dualModel();
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.click', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});

  // First flow is on shop.example.com
  const first = await turn(state, shop, 'cross-host');
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.target, 'shop.example.com');

  // User says "Yes, just now" to the shop flow.
  state.app.runtime.approve(first.sessionId, 'allow', 'never', asked.fingerprint);

  // Retry: shop flow runs.
  const second = await turn(state, shop, first.sessionId);
  assert.equal(second.status, 'completed');
  assert.deepEqual(state.did, ['navigate https://shop.example.com/cart', 'click Place order on shop.example.com']);

  // Second flow is on docs.example.com with the same click name.
  state.did.length = 0;
  const third = await turn(state, docs, first.sessionId);
  assert.equal(third.status, 'needs_input', 'the docs flow is asked about, not covered by the shop yes');
  const docsAsked = waitingIn(state, third);
  assert.equal(docsAsked.target, 'docs.example.com');
  assert.deepEqual(state.did, [], 'nothing on the docs site ran');
});
