import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRunner, locateGit } from '../dist/integrations/git-run.js';

/**
 * Q192: a repository's own filter and diff settings never make Branch's Git start a program.
 *
 * A repository the owner did not write (a downloaded or opened project, a folder a command wrote in)
 * can carry a clean/smudge/process filter or a diff textconv driver in its own local settings, and a
 * committed .gitattributes that selects it. Git would run that program — as the owner, outside any
 * wall — during an everyday status, diff or checkout. These tests plant such a driver and prove
 * Branch's Git runs none of it, while the owner's own global drivers keep working for a folder no
 * task touched.
 */

const installed = await locateGit();
const needsGit = { skip: installed ? false : 'Git is not installed on this computer' };

/** Git with none of Branch's hardening, so a test can show the planted program really does run. */
function plainGit(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(installed, args, { cwd, env: env ?? process.env, shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

/** A clean temporary HOME so no test ever reads or writes the owner's real global Git settings. */
async function cleanHome(t) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, 'branch-driver-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** A temporary repository whose own local config carries a driver that drops a marker file when run. */
async function repoWithDriver(t, home, plant) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-driver-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'project');
  await mkdir(repo, { recursive: true });
  const marker = join(root, 'MARKER');
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = async (args) => assert.equal(await plainGit(args, repo, env), 0, `setup: git ${args.join(' ')}`);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Outsider']);
  await git(['config', 'user.email', 'outsider@example.invalid']);
  await plant({ git, repo, marker });
  await writeFile(join(repo, 'a.dat'), 'first\n');
  await git(['add', '--', '.gitattributes', 'a.dat']);
  await git(['commit', '--message', 'planted']);
  // A working-tree change, so a later diff or status has to look at the file's content.
  await writeFile(join(repo, 'a.dat'), 'second\n');
  // The commit above may itself have run a clean filter; start each test with no marker present.
  await rm(marker, { force: true });
  return { root, repo, marker, home, env };
}

/** A runner that reads global settings from `home` (its own temp), exactly as Branch would on this owner's box. */
const runnerFor = (home) => new GitRunner({ env: { ...process.env, HOME: home } });
const ran = (marker) => existsSync(marker);

test('a planted clean filter runs during a plain diff (control)', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker, env } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat filter=evil\n');
  });
  assert.equal(ran(marker), false, 'nothing has run yet');
  await plainGit(['diff', '--name-only', 'HEAD'], repo, env);
  assert.equal(ran(marker), true, 'without hardening the planted clean filter really does run');
});

test('a planted clean filter never runs through Branch Git (status, diff, name-only)', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat filter=evil\n');
  });
  const runner = runnerFor(home);
  const run = (args) => runner.run({ cwd: repo, args }, AbortSignal.timeout(30000));
  const names = await run(['diff', '--name-only', 'HEAD']);
  await run(['status', '--porcelain=v1']);
  await run(['add', '--', 'a.dat']);
  assert.equal(ran(marker), false, 'the repository\'s own clean filter never starts a program');
  assert.equal(names.status, 'completed', 'the diff itself still completes');
  assert.match(names.stdout, /a\.dat/, 'and still reports the changed file');
});

test('a planted diff textconv never runs when Branch asks Git for diff text', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker, env } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'diff.evil.textconv', `sh -c 'touch "${marker}"; cat'`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat diff=evil\n');
  });
  // Control: a diff with text runs textconv without the hardening.
  await plainGit(['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', 'a.dat'], repo, env);
  assert.equal(ran(marker), true, 'without hardening the planted textconv really does run');
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  // A diff that produces text and does NOT itself pass --no-textconv (only --no-ext-diff, so it gets past
  // the pinned diff.external): the git-run layer must still neutralise the repository's textconv driver.
  const out = await runner.run({ cwd: repo, args: ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', 'a.dat'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the repository\'s own textconv driver never starts a program');
  assert.equal(out.status, 'completed', 'the diff itself still completes');
});

test('a planted smudge filter never runs when Branch Git writes the working tree', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker, env } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'filter.evil.smudge', `sh -c 'touch "${marker}"; cat'`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat filter=evil\n');
  });
  // Control: checkout runs smudge without the hardening.
  await plainGit(['checkout', 'HEAD', '--', 'a.dat'], repo, env);
  assert.equal(ran(marker), true, 'without hardening the planted smudge filter really does run');
  await rm(marker, { force: true });
  await writeFile(join(repo, 'a.dat'), 'third\n');

  const runner = runnerFor(home);
  await runner.run({ cwd: repo, args: ['checkout', 'HEAD', '--', 'a.dat'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the repository\'s own smudge filter never starts a program');
});

test('a driver pulled in through an included config file is neutralised too', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    // git config --file writes the driver into a separate file, correctly quoted, that local config includes.
    // The include path is absolute: a relative include resolves against .git/, not the repository root.
    await git(['config', '--file', join(repo, 'drv.inc'), 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`]);
    await git(['config', 'include.path', join(repo, 'drv.inc')]);
    await writeFile(join(repo, '.gitattributes'), '*.dat filter=evil\n');
  });
  const runner = runnerFor(home);
  await runner.run({ cwd: repo, args: ['diff', '--name-only', 'HEAD'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'a driver defined in an included file is neutralised the same way');
});

test('a filter name Branch cannot make safe fails closed, running no program', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  // A driver whose name carries "=", which "-c filter.<name>.clean=" cannot express: Git splits -c on
  // the first "=", so the neutraliser would miss it. Branch must refuse to run Git here instead.
  const { repo, marker, env } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'filter.we=rd.clean', `sh -c 'touch "${marker}"; cat'`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat filter=we=rd\n');
  });
  // Control: the awkwardly named driver really does run without the hardening.
  await plainGit(['diff', '--name-only', 'HEAD'], repo, env);
  assert.equal(ran(marker), true, 'without hardening the awkwardly named driver runs');
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  const outcome = await runner.run({ cwd: repo, args: ['diff', '--name-only', 'HEAD'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the awkwardly named driver never starts a program');
  assert.notEqual(outcome.status, 'completed', 'Branch refuses to run Git in that folder rather than run it unprotected');
});

test('the owner\'s own global driver still runs for a folder no task touched', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const marker = join(home, 'GLOBAL_MARKER');
  // A repository with NO driver of its own; only the owner's global one applies.
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-driver-plain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'project');
  await mkdir(repo, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
  const git = async (args) => assert.equal(await plainGit(args, repo, env), 0, `setup: git ${args.join(' ')}`);
  // The owner's global settings (their own git-lfs, say), which Branch must leave working. Set through
  // git config --global so the driver is quoted exactly as git itself would write it.
  await git(['config', '--global', 'user.name', 'Owner']);
  await git(['config', '--global', 'user.email', 'owner@example.invalid']);
  await git(['config', '--global', 'filter.ownerlfs.clean', `sh -c 'touch "${marker}"; cat'`]);
  await git(['init', '--initial-branch=main']);
  await writeFile(join(repo, '.gitattributes'), '*.dat filter=ownerlfs\n');
  await writeFile(join(repo, 'a.dat'), 'first\n');
  await git(['add', '--', '.gitattributes', 'a.dat']);
  await git(['commit', '--message', 'clean repo']);
  await writeFile(join(repo, 'a.dat'), 'second\n');

  const runner = runnerFor(home);
  await runner.run({ cwd: repo, args: ['diff', '--name-only', 'HEAD'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), true, 'a global driver the owner set is left working for a folder no task touched');
});

/**
 * Q192: a repository's own merge driver never makes Branch's Git start a program.
 *
 * git.ts merges a tried branch with `merge --no-ff --no-edit` (planMerge). A repository the owner did
 * not write can define a `merge.<name>.driver` in its own config and select it with a committed
 * `.gitattributes` `* merge=<name>`; Git would then run that program on the first file both sides
 * changed. These tests plant such a driver and prove Branch's Git runs none of it, while the owner's
 * own global merge driver keeps working for a folder no task touched.
 */

/** A temporary repository with two divergent branches whose content merge triggers the folder's own merge driver. */
async function repoWithMergeDriver(t, home, driverName, attrName) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-merge-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'project');
  await mkdir(repo, { recursive: true });
  const marker = join(root, 'MARKER');
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = async (args) => assert.equal(await plainGit(args, repo, env), 0, `setup: git ${args.join(' ')}`);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Outsider']);
  await git(['config', 'user.email', 'outsider@example.invalid']);
  // The driver drops a marker and reports a conflict, so a live driver is visible and never resolves silently.
  await git(['config', `merge.${driverName}.driver`, `sh -c 'touch "${marker}"; false'`]);
  await writeFile(join(repo, '.gitattributes'), `* merge=${attrName}\n`);
  await writeFile(join(repo, 'a.dat'), 'base\n');
  await git(['add', '--', '.gitattributes', 'a.dat']);
  await git(['commit', '--message', 'base']);
  // Two lines of work that change the same file, so merging one into the other is a content merge.
  await git(['checkout', '-b', 'other']);
  await writeFile(join(repo, 'a.dat'), 'theirs\n');
  await git(['commit', '--all', '--message', 'theirs']);
  await git(['checkout', 'main']);
  await writeFile(join(repo, 'a.dat'), 'ours\n');
  await git(['commit', '--all', '--message', 'ours']);
  await rm(marker, { force: true });
  return { repo, marker, env };
}

test('a planted merge driver never runs when Branch Git merges a branch', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker, env } = await repoWithMergeDriver(t, home, 'evil', 'evil');
  // Control: without the hardening, the folder's own merge driver really does run on the conflicting file.
  await plainGit(['merge', '--no-ff', '--no-edit', '-m', 'try', 'other'], repo, env);
  assert.equal(ran(marker), true, 'without hardening the planted merge driver runs');
  await plainGit(['merge', '--abort'], repo, env);
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  await runner.run({ cwd: repo, args: ['merge', '--no-ff', '--no-edit', '-m', 'try', 'other'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the repository\'s own merge driver never starts a program');
});

test('a merge driver name Branch cannot make safe fails closed, running no program', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  // "=" in the driver name defeats a "-c merge.<name>.driver=" pin (Git splits -c on the first "="),
  // so Branch refuses to run Git in the folder rather than run it with the driver still live.
  const { repo, marker, env } = await repoWithMergeDriver(t, home, 'we=rd', 'we=rd');
  await plainGit(['merge', '--no-ff', '--no-edit', '-m', 'try', 'other'], repo, env);
  assert.equal(ran(marker), true, 'without hardening the awkwardly named merge driver runs');
  await plainGit(['merge', '--abort'], repo, env);
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  const outcome = await runner.run({ cwd: repo, args: ['merge', '--no-ff', '--no-edit', '-m', 'try', 'other'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the awkwardly named merge driver never starts a program');
  assert.notEqual(outcome.status, 'completed', 'Branch refuses to run Git in that folder rather than run it unprotected');
});

test('a planted diff textconv never runs when Branch Git blames a file', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker, env } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'diff.evil.textconv', `sh -c 'touch "${marker}"; cat "$1"' -`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat diff=evil\n');
  });
  // Control: git blame runs textconv (which is on by default for blame) without the hardening.
  await plainGit(['blame', '--', 'a.dat'], repo, env);
  assert.equal(ran(marker), true, 'without hardening git blame runs the planted textconv');
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  const out = await runner.run({ cwd: repo, args: ['blame', '--', 'a.dat'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the repository\'s own textconv driver never starts a program through blame');
  assert.equal(out.status, 'completed', 'the blame itself still completes');
});

test('a planted diff textconv never runs when Branch Git annotates a file', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const { repo, marker, env } = await repoWithDriver(t, home, async ({ git, repo, marker }) => {
    await git(['config', 'diff.evil.textconv', `sh -c 'touch "${marker}"; cat "$1"' -`]);
    await writeFile(join(repo, '.gitattributes'), '*.dat diff=evil\n');
  });
  // Control: git annotate runs textconv (on by default) without the hardening.
  await plainGit(['annotate', '--', 'a.dat'], repo, env);
  assert.equal(ran(marker), true, 'without hardening git annotate runs the planted textconv');
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  const out = await runner.run({ cwd: repo, args: ['annotate', '--', 'a.dat'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), false, 'the repository\'s own textconv driver never starts a program through annotate');
  assert.equal(out.status, 'completed', 'the annotate itself still completes');
});

test('the owner\'s own global merge driver still runs for a folder no task touched', { ...needsGit }, async (t) => {
  const home = await cleanHome(t);
  const marker = join(home, 'GLOBAL_MERGE_MARKER');
  // A repository with NO merge driver of its own; only the owner's global one applies.
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-merge-plain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'project');
  await mkdir(repo, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
  const git = async (args) => assert.equal(await plainGit(args, repo, env), 0, `setup: git ${args.join(' ')}`);
  await git(['config', '--global', 'user.name', 'Owner']);
  await git(['config', '--global', 'user.email', 'owner@example.invalid']);
  await git(['config', '--global', 'merge.ownermerge.driver', `sh -c 'touch "${marker}"; false'`]);
  await git(['init', '--initial-branch=main']);
  await writeFile(join(repo, '.gitattributes'), '*.dat merge=ownermerge\n');
  await writeFile(join(repo, 'a.dat'), 'base\n');
  await git(['add', '--', '.gitattributes', 'a.dat']);
  await git(['commit', '--message', 'base']);
  await git(['checkout', '-b', 'other']);
  await writeFile(join(repo, 'a.dat'), 'theirs\n');
  await git(['commit', '--all', '--message', 'theirs']);
  await git(['checkout', 'main']);
  await writeFile(join(repo, 'a.dat'), 'ours\n');
  await git(['commit', '--all', '--message', 'ours']);
  await rm(marker, { force: true });

  const runner = runnerFor(home);
  await runner.run({ cwd: repo, args: ['merge', '--no-ff', '--no-edit', '-m', 'try', 'other'] }, AbortSignal.timeout(30000));
  assert.equal(ran(marker), true, 'a global merge driver the owner set is left working for a folder no task touched');
});
