# STATUS: account pooling rule (mac7/account-pooling)

Owner decision (2026-09-19): Branch never rotates one person's use across their own identical
personal subscription plans to get around limits. Rotation only between API keys, and between
sign-in accounts explicitly marked "kept separate" (different owner: work vs personal, a household
person's own account).

## Plan
1. settings: `keptSeparate` per account; `poolingRule` version + pending notices; pure `rotationGroup` and migration.
2. pool-provider: shared() rotates only within the group; limit message suggests only allowed accounts.
3. manage/api: `keptSeparate` in update (owner-only, sign-in pools only); notice dismiss route; migration at start.
4. window (public/accounts.js), `/account separate|not-separate <name>`, locales en + fr.
5. docs/configuration.md + handbook; tests (table-driven).
6. self-review, merge trunk, retest, merge into mac/cross-platform, push.

## Progress
- [x] 1-2 core (21bf2901; finished here: limit sentence names only allowed accounts, own-plans wording,
      `firstChoice` shared by single() and rotationSet so both pick the same own account, id comparison,
      a never-saved list starts under the rule, a damaged record is not overwritten by the migration)
- [x] 3 surfaces (manage/api/command; `/account separate|not-separate <name>`; notice returned as locale key + service)
- [x] 4-5 docs/locales/tests: window (notice + Got it, Kept separate box, badge; the tick-box labels keep their
      box when the language is applied), en + fr, docs/configuration.md (terms decision item 2 rewritten, new
      keys), handbook chapter 01 section, tests/accounts-pooling.test.mjs P1-P7 + accounts-ui U3
- [x] 6a self-review: fixed a chain where a hand-picked own plan was replaced by the work account and the next
      limit then reached the owner's default plan (0bba5897, P8). Checked and closed: Trunks (sign-ins refused),
      household/short-lived keys (routes owner-only, /account refused; notice route added to the key table),
      schedules and background work (same pool provider, no other path picks an account), fallbacks between
      presets of one pool (shared per-pool state, same own account), ChatGPT presets are per model not per account.
      Remaining by design: the owner changing their default by hand changes which own plan a conversation falls
      back to; that is the owner's own choice, not Branch rotating.
- [x] 6b trunk merged in twice (last: 5040c7d7), rebuilt from an empty dist, 139 targeted tests green
      (accounts x4, static-assets, index-structure, handbook, short-lived-keys, household-profile, commands x2,
      polish-observability, governance); pushed to mac/cross-platform.

## Independent review (mac7/pooling-review, 2026-09-19)
- [x] Mutation check: removing each guard (rotationSet, the limit sentence's group, the conversation's
      kept pick, the API-key refusal, the read-only notice) fails a named test. The tests are real.
- [x] Fixed: a helper or background sub-task a conversation started had a conversation of its own, so it
      answered through the owner's default plan even when the conversation used another (own) plan that
      had run out. Model calls now carry the conversation at the top of the task's tree (P10).
- [x] Fixed: a model call a tool makes on the side (summary, document read) carried no conversation at
      all and went to the default plan. Tool runs are now marked with their conversation (P9).
- [x] Fixed: moved by hand onto an account kept separate after one own plan ran out, the conversation was
      later moved (sharing on) or pointed (sharing off) to the owner's other plan. The own plan now leaves
      the group for that conversation while another own plan is at its limit (`mayShare`, P11).
- Left for the owner: with a single sign-in (no list), a ChatGPT 429 carrying Retry-After still moves the
  task along the owner's own fallback order, which may list the Codex program signed in to a different
  ChatGPT plan. Branch cannot see which plan a program is signed in to.
