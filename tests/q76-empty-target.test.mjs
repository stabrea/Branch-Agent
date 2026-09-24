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

test('a path of only spaces or invisible characters names nothing, so it gets no standing yes', async (t) => {
  for (const path of [' ', '\t', '​', ' ', '‍ ­']) {
    const state = await harness(t, 'q76-blank-path');
    state.calls.push({id: 'c1', name: 'git.log', arguments: JSON.stringify({folder: '/tmp/repo', path})});
    const run = await state.app.runtime.run({prompt: 'run'});
    const asked = waitingIn(state, run);
    assert(asked, `should ask for ${JSON.stringify(path)}`);
    assert.equal(asked.noAlways, true, JSON.stringify(path));
    assert.throws(() => state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint), /does not say/, JSON.stringify(path));
    assert.equal(readPolicy(state.app.store, state.app.runtime.owner).rules.filter((r) => r.tool === 'git.log').length, 0);
  }
});

test('branch approve on the command line writes no "*" rule for a call that left its target out', async (t) => {
  const {answerFromCommand} = await import('../dist/cli-run.js');
  const state = await harness(t, 'q76-cli-empty');
  state.calls.push({id: 'c1', name: 'git.log', arguments: JSON.stringify({folder: '/tmp/repo'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  assert(waitingIn(state, run), 'should ask');
  assert.throws(() => answerFromCommand(state.app.runtime, run.id, 'yes'), /does not say/);
  assert.equal(readPolicy(state.app.store, state.app.runtime.owner).rules.filter((r) => r.tool === 'git.log').length, 0);
});

test('branch approve on the command line keeps a standing yes for a tool that can name nothing', async (t) => {
  const {answerFromCommand} = await import('../dist/cli-run.js');
  const state = await withTool(t, 'q76-cli-no-arguments', (z) => ({name: 'house.chime', parameters: z.object({}).strict()}));
  state.calls.push({id: 'c1', name: 'house.chime', arguments: '{}'});
  const run = await state.app.runtime.run({prompt: 'run'});
  assert(waitingIn(state, run), 'should ask');
  const answered = answerFromCommand(state.app.runtime, run.id, 'yes');
  assert.equal(answered.rule, 'house.chime on anything');
  const rules = readPolicy(state.app.store, state.app.runtime.owner).rules.filter((r) => r.tool === 'house.chime');
  assert.deepEqual(rules.map((r) => r.match), ['*']);
});

test('a tool that names the chat or delivery it reaches gets no standing yes when that is left out', async (t) => {
  const state = await harness(t, 'q76-chat-arguments');
  for (const name of ['channels.digest', 'schedules.create', 'brief.configure', 'monitors.screen.create']) {
    assert.notEqual(state.app.registry.permissionOf(name), '', `${name} is registered here`);
    assert.equal(state.app.registry.noStandingTarget(name, ''), true, name);
  }
  const {z} = await import('zod');
  state.app.registry.register({name: 'house.tell', permission: 'channels.send', description: 'tell', execute: async () => ({ok: true}),
    parameters: z.object({channel: z.string(), chatId: z.string(), text: z.string()}).strict()});
  assert.equal(state.app.registry.noStandingTarget('house.tell', ''), true, 'channel and chatId name where it reaches');
  assert.equal(state.app.registry.noStandingTarget('house.tell', 'telegram:111'), false);
});

test('default-deny: on no target, only a tool with no arguments or one listed as targetless keeps a standing yes', async (t) => {
  const state = await harness(t, 'q76-default-deny');
  const {z} = await import('zod');
  const {targetlessTools} = await import('../dist/registry.js');
  const add = (name, parameters) => state.app.registry.register({name, permission: 'channels.send', description: name, execute: async () => ({ok: true}), parameters});
  add('plugin.mailer.send', z.object({to: z.string(), text: z.string()}).strict()); // a plugin names a recipient no rule knows
  add('outside.lookup', z.record(z.string(), z.unknown())); // an outside server's arguments cannot be read
  add('house.chime2', z.object({}).strict());
  assert.equal(state.app.registry.noStandingTarget('plugin.mailer.send', ''), true);
  assert.equal(state.app.registry.noStandingTarget('outside.lookup', ''), true);
  assert.equal(state.app.registry.noStandingTarget('house.chime2', ''), false, 'no arguments at all: the tool itself');
  const listed = Object.keys(targetlessTools).find((name) => state.app.registry.permissionOf(name));
  assert.ok(listed, 'a listed targetless tool is registered here');
  assert.equal(state.app.registry.noStandingTarget(listed, ''), false, `${listed} is targetless on purpose`);
});

test('a target that is itself a pattern never gets a standing yes, however it is written', async (t) => {
  const state = await harness(t, 'q76-pattern');
  for (const target of ['*', 'docs/*', '%2A', 'https%3A%2F%2F%2A']) assert.equal(state.app.registry.noStandingTarget('files.write', target), true, target);
  // The rule matcher reads only `*` as a pattern: `?` and `[` stay literal, so they keep their yes.
  for (const target of ['a?b', 'notes/[ab].md']) assert.equal(state.app.registry.noStandingTarget('files.write', target), false, target);
  // A command keeps a starred command as one exact command; only a bare `*` would be everything.
  assert.equal(state.app.registry.noStandingTarget('shell.execute', 'ls *.md'), false);
  assert.equal(state.app.registry.noStandingTarget('shell.execute', '*'), true);
  assert.equal(state.app.registry.noStandingTarget('files.write', 'notes/today.md'), false);
  state.calls.push({id: 'c1', name: 'files.write', arguments: JSON.stringify({path: '*', content: 'x'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  const asked = waitingIn(state, run);
  assert(asked, 'should ask');
  assert.equal(asked.noAlways, true);
  assert.throws(() => state.app.runtime.approve(run.sessionId, 'allow', 'always', asked.fingerprint), /does not say/);
  assert.equal(readPolicy(state.app.store, state.app.runtime.owner).rules.filter((r) => r.tool === 'files.write' && r.match === '*').length, 0);
});

test('an outside server tool keeps a standing yes only when its schema accepts nothing but {}', async (t) => {
  const state = await harness(t, 'q76-mcp-shapes');
  const {z} = await import('zod');
  const add = (name, inputSchema) => state.app.registry.register({name, permission: name, description: name, external: true,
    parameters: z.record(z.string(), z.unknown()), inputSchema, execute: async () => ({ok: true})});
  add('mcp.clock.now', {type: 'object', properties: {}, additionalProperties: false});
  add('mcp.clock.bare', {type: 'object'}); // accepts any key: could carry a recipient
  add('mcp.lent.fallback', {type: 'object', additionalProperties: true}); // a lent tool's fallback schema
  add('mcp.mail.any', {type: 'object', additionalProperties: false, anyOf: [{properties: {to: {type: 'string'}}}]});
  add('mcp.mail.send', {type: 'object', properties: {to: {type: 'string'}}});
  assert.equal(state.app.registry.noStandingTarget('mcp.clock.now', ''), false, 'closed and empty: takes nothing');
  for (const name of ['mcp.clock.bare', 'mcp.lent.fallback', 'mcp.mail.any', 'mcp.mail.send'])
    assert.equal(state.app.registry.noStandingTarget(name, ''), true, name);
});

test('branch approve on the command line writes no rule for a target that is a pattern', async (t) => {
  const {answerFromCommand} = await import('../dist/cli-run.js');
  const state = await harness(t, 'q76-cli-pattern');
  state.calls.push({id: 'c1', name: 'files.write', arguments: JSON.stringify({path: '*', content: 'x'})});
  const run = await state.app.runtime.run({prompt: 'run'});
  assert(waitingIn(state, run), 'should ask');
  assert.throws(() => answerFromCommand(state.app.runtime, run.id, 'yes'), /does not say/);
  assert.equal(readPolicy(state.app.store, state.app.runtime.owner).rules.filter((r) => r.tool === 'files.write').length, 0);
});

test('remote.run: a `*` in the computer part is a pattern, and so is a bare `*` command', async (t) => {
  const state = await harness(t, 'q76-remote-pattern');
  for (const target of ['*: ls', 'tow*: ls', 'tower: *', 'tower:  * ', '*', '%2A: ls'])
    assert.equal(state.app.registry.noStandingTarget('remote.run', target), true, target);
  for (const target of ['tower: ls', 'tower: ls *.md'])
    assert.equal(state.app.registry.noStandingTarget('remote.run', target), false, target);
});

test('a tool a connected program lends keeps no standing yes on its word that it takes nothing', async (t) => {
  const {ClientToolHub} = await import('../dist/interop/client-tools.js');
  const state = await harness(t, 'q76-lent-closed');
  const hub = new ClientToolHub(state.app.registry, state.app.store, state.app.runtime.owner);
  const sent = [];
  const name = hub.lend({client: 'mailer', call: async (_tool, args) => { sent.push(args); return 'ok'; }},
    {name: 'send', description: 'send', parameters: {type: 'object', properties: {}, additionalProperties: false}});
  assert.equal(state.app.registry.noStandingTarget(name, ''), true, 'nothing checks its calls against that schema');
});
