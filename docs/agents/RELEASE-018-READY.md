# 0.18.0 is prepared. What the coordinator does to publish it.

Everything below is the coordinator's to run. This branch (`mac7/release-018`) sets the version,
writes the notes and checks the path **without running any of it**. Nothing is tagged, nothing is
merged into `mac/cross-platform`, and no release exists.

- Version: **0.18.0** in `package.json`, `package-lock.json` (both entries),
  `integrations/agent-plugin/.claude-plugin/plugin.json`,
  `integrations/agent-plugin/.claude-plugin/marketplace.json`,
  `integrations/agent-plugin/.codex-plugin/plugin.json`.
- Notes: `docs/agents/briefs/release-notes-0.18.0.md`.
- Where things stand: `docs/CHECKPOINT.md`. What the product does: `docs/features.md`.

## Before anything else

**Run one full three-system round.** Nothing on this tree has had one — build-fast mode meant macOS
targeted files only. Windows on Legion and Linux on `branch-test-linux` through
`docs/agents/scripts/verify.sh`, plus the green PR check. Until that passes, 0.18.0 is prepared, not
ready. Do not skip it because the targeted runs were green; they were targeted.

## In order

1. **Merge `mac7/release-018` into `mac/cross-platform`.** This branch is cut from it and has been
   merged back up to date, so this is a fast-forward or a trivial merge.

2. **Move staging forward.** `wave2/integration` still sits at the 0.17.0 point and is 660 commits
   behind. Merge `mac/cross-platform` into it and push. Skipping this leaves staging permanently
   behind the trunk and the next release run will be worse.

3. **Open the pull request into `main`** from `wave2/integration` (this is how #104 was done: staging
   into `main`, not a release branch into `main`). Title as a Conventional Commit ending `(0.18.0)`,
   body = the release notes with the verification paragraph appended, the way #104 reads. Wait for the
   three-system check to go green, then merge it.

4. **Build the Windows download on Legion** and attach it to the release **before the tag exists**.
   `ssh` in, then
   `powershell -NoProfile -File docs/agents/scripts/desktop-bridge.ps1 -Run 'npm run package:desktop -- --release' -Wait`.
   Create the release first as a draft and upload `Branch-Agent-windows-x64.zip` with its `.sha256`.

   **This is the part CHECKPOINT used to get wrong.** The publish job no longer uses `--clobber`;
   `fix(package): never upload over a download already on the release` added a guard that keeps any
   asset already attached together with its checksum. So the hand-built Windows zip attached *before*
   the tag is kept, and does **not** need re-attaching afterwards. Attach the `.sha256` too — the job
   warns but does not fix a zip that arrives without one.

5. **Tag it.** `gh release create v0.18.0 --target <the merged main SHA> --title "Branch Agent 0.18.0"
   --notes-file docs/agents/briefs/release-notes-0.18.0.md`, or publish the draft from step 4 against
   that tag. The tag triggers `.github/workflows/package.yml`.

6. **Let `package.yml` finish.** It builds macOS arm64 and x64, Linux x64, the two no-questions
   installers, and the phone download `branch-agent-0.18.0.tgz` with its `.sha256`. Its publish job
   refuses the release if the tag and `package.json` disagree about the version — they agree, checked.
   It keeps the Windows zip from step 4 and uploads the rest.

7. **Rehearse the update.** 0.17.0 to 0.18.0 from the staging folder on Legion, which already holds
   0.17.0. Expect zero console windows and 0.17.0 kept as `install.previous`.

8. **Rewrite the ticks.** `(merged, ships in 0.18.0)` becomes `(0.18.0)` across the theme issues, then
   regenerate public issue #103 with `docs/agents/scripts/make_list.py`. Note that script still maps
   `merged` to `0.17.0*` at line 59 — change it to `0.18.0*` first or the counts come out wrong.

9. **Update `docs/CHECKPOINT.md`** with the published SHA, the release URL, the PR number, the
   three-system test counts and the rehearsal result, the way the 0.17.0 entry records them.

## Checked here, so you do not have to

- `scripts/pack-cli.mjs` and `scripts/package-desktop.mjs` exist; `package-desktop.mjs` writes
  `Install Branch Agent.cmd` on Windows and `install-branch-agent.sh` on macOS and Linux, which are
  the two scripts the publish job insists on.
- `npm pack` names the phone download from `package.json`, so it comes out
  `branch-agent-0.18.0.tgz` and matches the job's `branch-agent-${TAG#v}.tgz` check for tag `v0.18.0`.
- The Termux checksum publishing added on 18 September is wired end to end: the Linux runner writes
  `sha256sum "$name" > "$name.sha256"`, and `packaging/termux/install-branch-termux.sh` reads it with
  `cut -d " " -f 1` and refuses to install if it does not match. The formats agree.
- The workflow's four asset names match what the packaging scripts produce.

## Known rough edges in the release path

- **The notes could not be drafted by the script.** `node scripts/release-notes.mjs --since v0.17.0`
  prints "Nothing has been added to docs/CHECKPOINT.md since v0.17.0", because every build brief told
  builders not to edit `docs/CHECKPOINT.md`. The drafting step is only as good as checkpoint entries
  nobody was allowed to write. The 0.18.0 notes were written from the commit log instead. Either let
  builders add their own checkpoint line, or stop pretending the script drafts anything.
- **`docs/ROADMAP.md:15`** still says "0.17.0 (on staging already)". Stale, left alone deliberately —
  it was not in scope here.
- `docs/agents/scripts/publish-template.sh` is still the 0.15.0 script, kept as a shape rather than a
  thing to run. It has no hand-install step, which is why the owner's PC picks a release up through
  the in-app update rather than directly.
