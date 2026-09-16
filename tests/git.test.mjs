import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranch } from '../dist/index.js';
import { GitRunner, locateGit, explainGit } from '../dist/integrations/git-run.js';
import { GitTools } from '../dist/integrations/git.js';
import { registerGitRemote, registerGitHub } from '../dist/integrations/git-tools.js';
import { GitHubAccess } from '../dist/integrations/github.js';
import { NetworkPolicy } from '../dist/network-policy.js';
import { ignoreMatcher } from '../dist/ignore.js';

const TOKEN = 'ghp_fake_token_9f3ab2c7';
const installed = await locateGit();
const needsGit = { skip: installed ? false : 'Git is not installed on this computer' };

/** Git with none of the hardening, so a test can prove what the hardening actually prevents. */
function plainGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(installed, args, { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`))));
  });
}

async function fixture(t, provider) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-git-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private'), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const runner = new GitRunner();
  const run = async (args, cwd = app.runtime.workspace) => {
    const outcome = await runner.run({ cwd, args }, AbortSignal.timeout(30000));
    assert.equal(outcome.status, 'completed', `${args.join(' ')}: ${outcome.stderr}`);
    return outcome.stdout;
  };
  if (installed) {
    await run(['init', '--initial-branch=main']);
    await run(['config', 'user.name', 'Test Owner']);
    await run(['config', 'user.email', 'owner@example.invalid']);
  }
  return { app, root, run, context: () => app.runtime.context({ runId: 'fixture-run' }), file: (name, body) => writeFile(join(app.runtime.workspace, name), body) };
}

test('the ignore matcher follows gitignore syntax', () => {
  const matcher = ignoreMatcher('# comment\nbuild/\n*.log\nnotes/**/draft.md\n!keep.log\n');
  assert.equal(matcher.ignores('build', true), true);
  assert.equal(matcher.ignores('build/out.js'), true);
  assert.equal(matcher.ignores('deep/build/out.js'), true);
  assert.equal(matcher.ignores('server.log'), true);
  assert.equal(matcher.ignores('keep.log'), false);
  assert.equal(matcher.ignores('notes/a/b/draft.md'), true);
  assert.equal(matcher.ignores('notes/draft.md'), true);
  assert.equal(matcher.ignores('src/index.ts'), false);
});

test('git tools are registered with separate permissions and remote is off by default', async (t) => {
  const f = await fixture(t);
  const permissions = f.app.registry.permissions();
  assert.ok(permissions.includes('git.read') && permissions.includes('git.write'));
  assert.equal(permissions.includes('git.remote'), false);
  assert.equal(permissions.includes('github.manage'), false);
  assert.equal(f.app.runtime.context({ runId: 'r' }).permissions.has('git.remote'), false);
  assert.ok(f.app.registry.names().includes('git.status') && f.app.registry.names().includes('git.commit'));
  assert.equal(f.app.registry.names().includes('git.push'), false);
});

test('missing Git is explained, never crashes', async (t) => {
  const f = await fixture(t);
  const git = new GitTools(f.app.files, new GitRunner({ locate: async () => null }));
  await assert.rejects(git.status('.', AbortSignal.timeout(5000)), /Git is not installed on this computer/);
  assert.match(explainGit({ status: 'failed', stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }), /not a repository/);
  assert.match(explainGit({ status: 'failed', stdout: '', stderr: 'error: you have unmerged paths' }), /unmerged changes/);
  assert.match(explainGit({ status: 'timed_out', stdout: '', stderr: '' }), /took too long/);
});

test('status, diff, log, branch and commit work on a real repository', { ...needsGit }, async (t) => {
  const f = await fixture(t);
  const context = f.context();
  await f.file('readme.md', 'first\n');
  const before = await f.app.registry.execute('git.status', {}, context);
  assert.equal(before.clean, false);
  assert.deepEqual(before.changes, [{ path: 'readme.md', state: 'new' }]);

  const saved = await f.app.registry.execute('git.commit', { message: 'first version' }, context);
  assert.equal(saved.files.length, 1);
  assert.equal(saved.summary, 'first version');
  assert.equal((await f.app.registry.execute('git.status', {}, context)).clean, true);

  await f.file('readme.md', 'first\nsecond\n');
  const diff = await f.app.registry.execute('git.diff', {}, context);
  assert.deepEqual(diff.files, ['readme.md']);
  assert.match(diff.text, /\+second/);

  const log = await f.app.registry.execute('git.log', { limit: 5 }, context);
  assert.equal(log.versions.length, 1);
  assert.equal(log.versions[0].summary, 'first version');
  assert.equal(log.versions[0].author, 'Test Owner');

  const created = await f.app.registry.execute('git.branch', { action: 'create', name: 'try-something' }, context);
  assert.equal(created.created, true);
  const branches = await f.app.registry.execute('git.branch', { action: 'list' }, context);
  assert.equal(branches.current, 'try-something');
  assert.ok(branches.branches.includes('main'));
});

test('saving refuses when nothing changed and repository hooks never run', { ...needsGit }, async (t) => {
  const f = await fixture(t);
  const context = f.context();
  await f.file('one.txt', 'a\n');
  await f.app.registry.execute('git.commit', { message: 'start' }, context);
  await assert.rejects(f.app.registry.execute('git.commit', { message: 'again' }, context), /nothing to save/);

  const marker = join(f.app.runtime.workspace, 'hook-ran.txt');
  const hook = join(f.app.runtime.workspace, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\nexit 0\n`);
  await chmod(hook, 0o755);

  // Positive control: the same hook does fire when Git is run without the hardening.
  await f.file('two.txt', 'b\n');
  await f.run(['add', '--', 'two.txt']);
  await plainGit(['commit', '--message', 'control'], f.app.runtime.workspace);
  assert.ok((await readdir(f.app.runtime.workspace)).includes('hook-ran.txt'), 'the hook itself is runnable here');
  await rm(marker);

  await f.file('three.txt', 'c\n');
  await f.app.registry.execute('git.commit', { message: 'third' }, context);
  assert.equal((await readdir(f.app.runtime.workspace)).includes('hook-ran.txt'), false, 'the tool switches repository hooks off');
});

test('a folder pattern in .branchignore is respected by status and commit', { ...needsGit }, async (t) => {
  const f = await fixture(t);
  const context = f.context();
  await f.file('.branchignore', 'build/\n');
  await f.file('keep.txt', 'a\n');
  await mkdir(join(f.app.runtime.workspace, 'build'), { recursive: true });
  await writeFile(join(f.app.runtime.workspace, 'build', 'out.js'), 'noise\n');

  const status = await f.app.registry.execute('git.status', {}, context);
  assert.equal(status.changes.some((change) => change.path.startsWith('build')), false);
  const saved = await f.app.registry.execute('git.commit', { message: 'only what matters' }, context);
  assert.equal(saved.files.some((path) => path.startsWith('build')), false);
  assert.ok(saved.files.includes('keep.txt'));
  await assert.rejects(f.app.registry.execute('files.read', { path: 'build/out.js' }, context), /branchignore/);
});

test('.branchignore hides a file from files.read, files.list and git.diff', { ...needsGit }, async (t) => {
  const f = await fixture(t);
  const context = f.context();
  await f.file('open.txt', 'visible\n');
  await f.file('private-notes.txt', 'hidden\n');
  await f.app.registry.execute('git.commit', { message: 'start' }, context);
  await f.file('.branchignore', 'private-notes.txt\n!.env\n');
  await f.file('open.txt', 'visible again\n');
  await f.file('private-notes.txt', 'hidden change\n');

  await assert.rejects(f.app.registry.execute('files.read', { path: 'private-notes.txt' }, context), /branchignore/);
  assert.equal((await f.app.registry.execute('files.read', { path: 'open.txt' }, context)).content, 'visible again\n');
  const listed = (await f.app.registry.execute('files.list', { path: '.' }, context)).entries.map((entry) => entry.name);
  assert.equal(listed.includes('private-notes.txt'), false);
  assert.ok(listed.includes('open.txt'));

  const diff = await f.app.registry.execute('git.diff', {}, context);
  assert.deepEqual(diff.files, ['open.txt']);
  assert.equal(diff.text.includes('hidden change'), false);
  const status = await f.app.registry.execute('git.status', {}, context);
  assert.equal(status.changes.some((change) => change.path === 'private-notes.txt'), false);

  // A "!" line cannot bring the fixed secret patterns back.
  await f.file('.env', 'API_KEY=1\n');
  await assert.rejects(f.app.registry.execute('files.read', { path: '.env' }, context), /traversal or secret filename/);
});

test('parallel copies stay inside .branch-worktrees', { ...needsGit }, async (t) => {
  const f = await fixture(t);
  const context = f.context();
  await f.file('one.txt', 'a\n');
  await f.app.registry.execute('git.commit', { message: 'start' }, context);

  const added = await f.app.registry.execute('git.worktree_add', { name: 'experiment', branch: 'experiment' }, context);
  assert.equal(added.path, '.branch-worktrees/experiment');
  const listed = await f.app.registry.execute('git.worktree_list', {}, context);
  assert.deepEqual(listed.copies, [{ name: 'experiment' }]);
  assert.ok((await readdir(join(f.app.runtime.workspace, '.branch-worktrees'))).includes('experiment'));

  // The parallel copy is never swept into a saved version of the repository it came from.
  await f.file('two.txt', 'b\n');
  const saved = await f.app.registry.execute('git.commit', { message: 'more work' }, context);
  assert.deepEqual(saved.files, ['two.txt']);
  assert.equal((await f.app.registry.execute('git.status', {}, context)).changes.length, 0);

  await assert.rejects(f.app.registry.execute('git.worktree_add', { name: '../escape' }, context));
  await assert.rejects(f.app.registry.execute('git.worktree_add', { name: 'C:/elsewhere' }, context));
  const removed = await f.app.registry.execute('git.worktree_remove', { name: 'experiment' }, context);
  assert.equal(removed.removed, true);
  assert.deepEqual((await f.app.registry.execute('git.worktree_list', {}, context)).copies, []);
});

test('sending work needs the git.remote permission and asks before touching main', { ...needsGit }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.app.registry.execute('git.push', { remote: 'origin' }, f.context()), /Unknown tool/);
  registerGitRemote(f.app.registry, f.app.git);
  t.after(() => { f.app.registry.unregister('git.push'); f.app.registry.unregister('git.pull'); });

  const withoutPermission = f.app.runtime.context({ runId: 'r', permissions: ['git.read', 'git.write'] });
  await assert.rejects(f.app.registry.execute('git.push', { remote: 'origin' }, withoutPermission), /Permission denied: git.remote/);

  await f.file('one.txt', 'a\n');
  await f.app.registry.execute('git.commit', { message: 'start' }, f.context());
  await assert.rejects(f.app.registry.execute('git.push', { remote: 'origin' }, f.context()), /Shall I go ahead/);
});

test('being asked about main pauses the task the same way user.ask does', { ...needsGit }, async (t) => {
  const provider = { name: 'push-fixture', async complete() {
    return { content: '', toolCalls: [{ id: 'send', name: 'git.push', arguments: '{"remote":"origin"}' }] };
  } };
  const f = await fixture(t, provider);
  registerGitRemote(f.app.registry, f.app.git);
  await f.file('one.txt', 'a\n');
  await f.app.registry.execute('git.commit', { message: 'start' }, f.context());

  const run = await f.app.runtime.run({ prompt: 'Send my work up' });
  assert.equal(run.status, 'needs_input');
  assert.match(run.output, /Shall I go ahead/);
});

/** A stand-in for GitHub that records what it was sent. */
async function githubFake(t) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      const body = request.url.includes('/pulls')
        ? { number: 7, title: 'Tidy the notes', html_url: 'https://github.test/acme/notes/pull/7', state: 'open' }
        : request.url.includes('/issues') && request.method === 'GET'
          ? [{ number: 3, title: 'Something is off', state: 'open', html_url: 'https://github.test/acme/notes/issues/3' }]
          : request.url.includes('/issues')
            ? { number: 4, title: 'Please fix', html_url: 'https://github.test/acme/notes/issues/4' }
            : { full_name: 'acme/notes', html_url: 'https://github.test/acme/notes', private: true, default_branch: 'main' };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, base: `http://127.0.0.1:${server.address().port}/` };
}

test('GitHub tools send the token in the header and never leak it', async (t) => {
  const f = await fixture(t);
  const fake = await githubFake(t);
  const policy = new NetworkPolicy({ allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] });
  const github = new GitHubAccess({ apiBase: fake.base }, policy, async () => TOKEN);
  registerGitHub(f.app.registry, github);
  t.after(() => ['github.create_repo', 'github.open_pull_request', 'github.list_issues', 'github.create_issue'].forEach((name) => f.app.registry.unregister(name)));

  const context = f.app.runtime.context({ runId: 'github-run' });
  const repo = await f.app.registry.execute('github.create_repo', { name: 'notes' }, context);
  assert.equal(repo.repository, 'acme/notes');
  assert.equal(repo.private, true);
  assert.equal(JSON.parse(fake.seen[0].body).private, true, 'repositories are private by default');
  assert.equal(fake.seen[0].authorization, `Bearer ${TOKEN}`);

  const pull = await f.app.registry.execute('github.open_pull_request', { repo: 'acme/notes', title: 'Tidy the notes', base: 'main', head: 'tidy' }, context);
  assert.equal(pull.number, 7);
  const issues = await f.app.registry.execute('github.list_issues', { repo: 'acme/notes' }, context);
  assert.equal(issues.issues[0].number, 3);
  const raised = await f.app.registry.execute('github.create_issue', { repo: 'acme/notes', title: 'Please fix' }, context);
  assert.equal(raised.number, 4);

  const recorded = JSON.stringify([...f.app.store.events('github-run'), repo, pull, issues, raised]);
  assert.equal(recorded.includes(TOKEN), false, 'the token must never reach the event log or a result');
});

test('a real run records a signed receipt for GitHub work with no token in it', async (t) => {
  const fake = await githubFake(t);
  let calls = 0;
  const provider = { name: 'github-fixture', async complete(request) {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'make', name: 'github.create_repo', arguments: '{"name":"notes"}' }] };
    assert.equal(request.messages.at(-1).content.includes(TOKEN), false);
    return { content: 'The repository acme/notes is ready.', toolCalls: [] };
  } };
  const f = await fixture(t, provider);
  const policy = new NetworkPolicy({ allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] });
  registerGitHub(f.app.registry, new GitHubAccess({ apiBase: fake.base }, policy, async () => TOKEN));

  const run = await f.app.runtime.run({ prompt: 'Make me a private repository called notes' });
  assert.equal(run.status, 'completed');
  const events = f.app.store.events(run.id);
  const completed = events.find((event) => event.kind === 'tool.completed');
  assert.equal(completed.data.name, 'github.create_repo');
  assert.equal(completed.data.result.repository, 'acme/notes');
  assert.ok(completed.data.receipt?.mac, 'the result carries a signed receipt');
  assert.equal(JSON.stringify(events).includes(TOKEN), false, 'no token anywhere in the activity log');
  assert.equal(JSON.stringify(run).includes(TOKEN), false);
});

test('the network policy blocks a GitHub address that is not allowed', async (t) => {
  const f = await fixture(t);
  const policy = new NetworkPolicy({ allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] });
  const elsewhere = new GitHubAccess({ apiBase: 'https://not-github.example.com/' }, policy, async () => TOKEN);
  await assert.rejects(elsewhere.createRepo({ name: 'notes', private: true }), /not on the allowed list/);
  assert.equal(f.app.registry.names().includes('github.create_repo'), false);
});

test('a failing GitHub reply is explained without the token', async (t) => {
  const f = await fixture(t);
  const server = createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
      .end(JSON.stringify({ message: `Bad credentials for ${TOKEN}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const policy = new NetworkPolicy({ allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] });
  const github = new GitHubAccess({ apiBase: `http://127.0.0.1:${server.address().port}/` }, policy, async () => TOKEN);
  await assert.rejects(github.createIssue({ repo: 'acme/notes', title: 'x' }), (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    assert.match(error.message, /did not accept the token/);
    return true;
  });
  assert.ok(f.app);
});
