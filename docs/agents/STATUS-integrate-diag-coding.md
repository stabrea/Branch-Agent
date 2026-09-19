# Integration status: mac7/diagnostics and mac7/coding-gap

Integrator: Claude (adversarial review, fix, merge into `mac/cross-platform`).
Worktrees (Legion, Windows): `C:/Users/bishi/Code/wt/diagnostics`, `C:/Users/bishi/Code/wt/coding-gap`.
(The first review pass ran on the Mac in `/Volumes/512GB SSD/branch-wt/...`.)

## 1. mac7/diagnostics
- [x] Reviewed. Found and fixed (commit "fix(diagnostics): clean every provider's key…"):
  Google/Groq/xAI/HF/Telegram/Discord keys, short JWTs, whole Cookie/Basic header values, JSON cookies,
  credential query params (?key=, X-Amz-Signature=, #access_token=), other users' home folders
  (C:\Users\bob, /home/x, JSON-escaped), UNC shares, %40 emails, redactFields auth/session/sid/privateKey;
  JSON.parse crash notes no longer quote the text; engine log also runs runtime.hideSecrets.
- Checked and fine: nothing leaves without a click (issue link opens only on click, zip saved locally),
  crashReporter uploadToServer:false, owner-only (requireOwner + short-lived key + household refusals),
  no chat-app path reaches these routes, log bounded (5 files x maxMB/5; crash file 5 x 512 KB; 30 breadcrumbs).
- [x] Second skeptical pass (Legion). Fixed in "fix(diagnostics): window errors follow the log switch…":
  - Every script error in the window was written to `crashes.jsonl` whatever the switch said (up to 20 per
    page load), so "off" was not off. Now a window error is an ordinary log line (off writes nothing; its
    quoted text is removed as for crashes). Test D18.
  - `issueUrl` did `JSON.parse` on the "about" item the window sends back; a hand-edited item made the
    request fail. Now read defensively. Test D19.
  - The `settings/diagnostic-log` setting was not in `docs/configuration.md`; section added (the checker
    passed only because the key names already occur elsewhere).
  - Confirmed: redaction tests D1/D3/D16/D17 assert the leaked text is absent (real tests); the new page
    script is on the static allowlist and loads (static-assets "answers 200" test); en and fr carry all 26 new keys.
- [x] build + tsc + targeted tests on merged trunk (trunk had not moved; merge was a no-op):
  diagnostics-log, short-lived-keys, household-profile, static-assets, index-structure, handbook, server,
  ui, shell-ui, calm-ui, cli — 105 pass, 0 fail.
- [x] merged into trunk and pushed: `mac/cross-platform` fast-forwarded 926eb454 -> cb4745e9; CI run 35448242701 was cancelled by the next trunk pushes (account-pooling, ci-flakes); the coding-gap push below carries it.

**Verdict: MERGE WITH FIXES** (fixes above, applied). Stated plainly, not hidden: crash capture is the one
part that is not switchable. An engine crash note is always written locally, and the desktop app always
starts Electron's crash reporter with uploading off (a local crash folder, and Electron's small crash
helper process runs beside the app). Nothing is ever sent. "Report a problem" looks up three service names
(DNS only) when the owner presses Gather, skipped under Lockdown.

## 2. mac7/coding-gap
- [x] Adversarial review of every claimed fix (patch placement, Codex patch form, whitespace-tolerant edits,
  refusal text, --timeout, empty-reply nudge, 2048 -> 4k -> 8k ceiling, code.check wording, change_set empty find).
- [x] Fixed in "fix(coding): a patch that fits more than one place is refused…" and "fix(coding): writing a file never runs it…":
  - **Silent misplacement (blocking):** a hunk with no line number (bare `@@`, every `*** Begin Patch` hunk)
    was put on the FIRST place its lines fitted; equidistant matches took the earlier one; a whitespace-only
    match was taken anywhere. Now: the named line wins if it fits; else an exact match strictly nearest to
    it; a hunk with no line number or a loose match must fit exactly one place; otherwise refused, listing
    the places. The Codex form's `@@ line` anchors were ignored; now honoured (stacked too).
  - A part that only adds lines went to the top of the file when it named no line, and past-the-end line
    numbers were clamped; now: end of file (the Codex form's meaning), refused when unclear or out of range.
  - Line endings: a mixed-ending file was rewritten wholesale by patches and tolerant edits; LF text sent for
    a CRLF file was reported as a "whitespace slip"; appends used LF in CRLF files. Now every line keeps its
    own ending, new lines take the file's usual one, and plain newlines against an all-CRLF file match exactly.
  - A patch matched ignoring indentation kept the model's indentation on added lines (spaces in a tab file);
    now re-indented to the file's, as edits already were.
  - `*** Update File: b/x` had its `b/` folder stripped (wrote the wrong file); now taken as written.
  - The empty-reply nudge fired on every empty reply (extra paid rounds for any provider), not only a reply
    that thought as claimed; now only when the reply had thinking.
  - **Permission hole (blocking):** with scripts on, every `code.patch` / `code.change_set` (files.write)
    ran `node --test` afterwards, i.e. executed test files the same patch had just written, without the
    code.execute permission. Now only `code.check` (code.execute) runs the stand-in; after a write only the
    owner's own configured check runs. The stand-in now honours the scripts' no-internet setting and runs
    Node as Node inside the desktop app (`ELECTRON_RUN_AS_NODE`; without it the packaged app would have
    started itself). Running tests stays OFF by default (coordinator decision; gated by the scripts switch).
  - 9 new tests (review: …) in tests/coding-gap-edits.test.mjs; empty-answer tests restored for replies with no thinking.
- Checked and fine: default reply ceiling stays 2048 and resets per run; --timeout default 2 min, capped at
  one day; the provider-facing schema of files.edit (a preprocess wrapper) still serialises correctly;
  catalog-diet width holds; consecutive user turns after a nudge match the existing check-failure nudge.
- Not changed, noted: `code.run` in the desktop app also starts `process.execPath` without
  ELECTRON_RUN_AS_NODE (pre-existing, not this branch).
- [x] build + tsc + targeted tests on the branch merged with the current trunk (diagnostics, account-pooling,
  ci-flakes; clean dist): 26 files, 300 tests, 299 pass, 0 fail, 1 platform skip; tests/automation.test.mjs
  alone 5/5. (shell-ui once failed at file load under concurrency on an earlier run and passed 24/24 alone
  and in both later full runs.)
- [x] merged into trunk and pushed (see the final report for the SHA and CI run).
- No audit ids are claimed by either branch, so there are none to mark VERIFIED/PARTIAL.

**Verdict: MERGE WITH FIXES** (two blocking problems found and fixed above: silent patch misplacement and
tests run by a files.write tool). No benchmark re-run (as instructed); the bench numbers in
docs/agents/coding-bench.md were measured before these fixes, which only make placement stricter.

## Next step for a new session
Both branches are merged. Nothing left here; check the trunk CI run for the coding-gap push.
