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
- [ ] merged into trunk, pushed, CI run id noted

**Verdict: MERGE WITH FIXES** (fixes above, applied). Stated plainly, not hidden: crash capture is the one
part that is not switchable. An engine crash note is always written locally, and the desktop app always
starts Electron's crash reporter with uploading off (a local crash folder, and Electron's small crash
helper process runs beside the app). Nothing is ever sent. "Report a problem" looks up three service names
(DNS only) when the owner presses Gather, skipped under Lockdown.

## 2. mac7/coding-gap
- [ ] adversarial review
- [ ] fixes + tests
- [ ] merged into trunk after diagnostics, pushed, CI run id noted

## Next step for a new session
Continue from the first unchecked box above.
