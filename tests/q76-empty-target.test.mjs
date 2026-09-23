import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {discardTemp} from './temp-dir.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBranch} from '../dist/index.js';
import {addPolicyRule, readPolicy, savePolicy} from '../dist/policy.js';

/**
 * Q76: tools with empty targets refuse "Yes, always" (fix generalization)
 */

const scratch = (label) => mkdtemp(join(tmpdir(), `branch-${label}-`));

function scriptedModel(nextCall) {
  let count = 0;
  const model = {async complete() {
    const call = nextCall();
    if (!call || count++ > 10) return {content: 'done', toolCalls: []};
    return {content: '', toolCalls: [call]};
  }};
  return model;
}

async function boot(root, model) {
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider: model});
  const {store, runtime} = app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  return app;
}

async function harness(t, label) {
  const root = await scratch(label);
  const calls = [];
  const model = scriptedModel(() => calls.shift());
  const state = {app: await boot(root, model), calls, root};
  t.after(async () => { await state.app.close(); await discardTemp(root); });
  return state;
}

const waitingIn = (state, run) => state.app.runtime.approvals.questionFor(run.sessionId);

test('research.run with empty sources: target="" and noAlways=true, refuse "always"', async (t) => {
  const state = await harness(t, 'q76-research-empty');
  
  state.calls.push({id: 'c1', name: 'research.run', arguments: JSON.stringify({question: 'test'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  
  assert(asked, 'should ask');
  assert.equal(asked.tool, 'research.run');
  assert.equal(asked.target, '', 'target="" when no sources specified');
  assert.equal(asked.noAlways, true, 'noAlways=true for empty target');
  
  assert.throws(() => {
    state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint);
  }, /does not say|request does not/i, 'refuse "always" on empty target');
  
  state.app.runtime.approve(run.sessionId, 'allow', 'session', asked.fingerprint);
  const rules = readPolicy(state.app.store, state.app.runtime.owner).rules.filter(r => r.tool === 'research.run');
  assert.equal(rules.length, 0, 'session answer does not write a standing rule');
});

test('git.log with no path: target="" and noAlways=true, refuse "always"', async (t) => {
  const state = await harness(t, 'q76-git-log-no-path');
  
  state.calls.push({id: 'c1', name: 'git.log', arguments: JSON.stringify({folder: '/tmp/repo'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  
  assert(asked, 'should ask');
  assert.equal(asked.target, '', 'target="" when no path');
  assert.equal(asked.noAlways, true, 'noAlways=true for empty target');
  
  assert.throws(() => {
    state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint);
  }, /does not say|request does not/i);
});

test('git.log with path: target non-empty, noAlways unset, "always" allowed', async (t) => {
  const state = await harness(t, 'q76-git-log-with-path');
  
  state.calls.push({id: 'c1', name: 'git.log', arguments: JSON.stringify({folder: '/tmp/repo', path: 'src/main.ts'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  
  assert(asked, 'should ask');
  assert.equal(asked.target, 'src/main.ts', 'target includes specified path');
  assert.equal(asked.noAlways, undefined, 'noAlways unset for non-empty target');
  
  state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint);
  const rules = readPolicy(state.app.store, state.app.runtime.owner).rules.filter(r => r.tool === 'git.log');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].match, 'src/main.ts', 'rule on specific path');
});

test('git.commit no paths: target="" and noAlways=true, refuse "always"', async (t) => {
  const state = await harness(t, 'q76-git-commit-no-paths');
  
  state.calls.push({id: 'c1', name: 'git.commit', arguments: JSON.stringify({folder: '/tmp/repo', message: 'test'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  
  assert(asked, 'should ask');
  assert.equal(asked.target, '', 'target="" when no paths');
  assert.equal(asked.noAlways, true, 'noAlways=true for empty target');
  
  assert.throws(() => {
    state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint);
  }, /does not say|request does not/i);
});

/* Legion's ruling: "always" stays for a tool that could never name a target, since a rule on "*" is
   then a rule for the tool itself; it goes only where the target is empty but could have been set. */
async function withTool(t, label, tool) {
  const state = await harness(t, label);
  const {z} = await import('zod');
  state.app.registry.register({permission: 'channels.send', description: label, execute: async () => ({ok: true}), ...tool(z)});
  return state;
}

test('a tool that takes no target-bearing argument keeps "Yes, always", and the rule is the tool itself', async (t) => {
  const state = await withTool(t, 'q76-no-arguments', (z) => ({name: 'house.chime', parameters: z.object({}).strict()}));
  state.calls.push({id: 'c1', name: 'house.chime', arguments: '{}'});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  assert(asked, 'should ask');
  assert.equal(asked.target, '');
  assert.equal(asked.noAlways, undefined, '"Yes, always" is offered');
  state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint);
  const rules = readPolicy(state.app.store, state.app.runtime.owner).rules.filter((r) => r.tool === 'house.chime');
  assert.equal(rules.length, 1, 'a standing rule for the tool');
});

test('a tool whose path was left out gets no standing yes, though it declares no target of its own', async (t) => {
  const state = await withTool(t, 'q76-path-left-out', (z) => ({name: 'house.note', parameters: z.object({path: z.string().optional()}).strict()}));
  state.calls.push({id: 'c1', name: 'house.note', arguments: '{}'});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  assert(asked, 'should ask');
  assert.equal(asked.target, '');
  assert.equal(asked.noAlways, true);
  assert.throws(() => state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint), /does not say/);
});
