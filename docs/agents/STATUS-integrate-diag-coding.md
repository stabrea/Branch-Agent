# Integration status: mac7/diagnostics and mac7/coding-gap

Integrator: Claude (adversarial review, fix, merge into `mac/cross-platform`).
Worktrees: `/Volumes/512GB SSD/branch-wt/diagnostics`, `/Volumes/512GB SSD/branch-wt/coding-gap`.

## 1. mac7/diagnostics
- [x] Reviewed. Found and fixed (commit "fix(diagnostics): clean every provider's key…"):
  Google/Groq/xAI/HF/Telegram/Discord keys, short JWTs, whole Cookie/Basic header values, JSON cookies,
  credential query params (?key=, X-Amz-Signature=, #access_token=), other users' home folders
  (C:\Users\bob, /home/x, JSON-escaped), UNC shares, %40 emails, redactFields auth/session/sid/privateKey;
  JSON.parse crash notes no longer quote the text; engine log also runs runtime.hideSecrets.
- Checked and fine: nothing leaves without a click (issue link opens only on click, zip saved locally),
  crashReporter uploadToServer:false, owner-only (requireOwner + short-lived key + household refusals),
  no chat-app path reaches these routes, log bounded (5 files x maxMB/5; crash file 5 x 512 KB; 30 breadcrumbs).
- [ ] build + tsc + targeted tests on merged trunk
- [ ] merged into trunk, pushed, CI green

## 2. mac7/coding-gap
- [ ] not started

## Next step for a new session
Continue from the first unchecked box above.
