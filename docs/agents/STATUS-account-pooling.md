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
- [ ] 1-2 core
- [ ] 3 surfaces
- [ ] 4-5 docs/locales/tests
- [ ] 6 merged
