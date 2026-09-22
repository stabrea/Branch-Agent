# Branch Agent owner finish line

Updated 2026-09-20 from `mac/cross-platform` at 0.19.0, the live GitHub state, the
Grown Up sample, `WHAT-IS-LEFT.md`, the design-gap register, feature-smoke reports,
and the status files under `docs/agents/`.

This is the numbered source of truth for the owner's requested outcome. Older handoffs
and status files are evidence, not instructions, and do not override this list.

## What "finished" means

Branch is finished only when the following are simultaneously true:

1. A non-technical owner can install, connect a permitted model, complete a real task,
   update, recover and uninstall on every supported surface without developer help.
2. Every shipped control and capability works in every state it exposes; unsupported or
   unverified behavior is labelled honestly instead of being presented as ready.
3. Branch can safely improve Branch through an isolated, reviewable pull request, but
   cannot silently replace its running installation, merge its own work or weaken its rules.
4. Claims of being better than another agent are backed by repeatable public evidence.
5. A release has no open critical/high defect, passes the complete acceptance matrix, is
   independently attributable to its publisher and can roll back without losing owner data.

"Perfect" is therefore a maintained quality bar, not a promise that defects can never exist.

## Already completed and protected

6. [x] Release 0.19.0 is live with desktop archives, installer scripts and SHA-256 files.
7. [x] Narrow pull requests use the fail-closed `verify-fast` gate; the real composer PR
   completed in 2m25s and a documentation PR in 8s.
8. [x] Releases may accept the exact commit's fast gate; broad, unknown or over-budget
   changes still require the exhaustive workflow.
9. [x] The Grown Up composer is isolated from shared layout files and matches the sample's
   48 px bar / 34 px controls on desktop, compact and phone layouts.
10. [x] Branch prepares its source in a separate worktree and can open a draft fork-to-upstream
    pull request without editing the running installation (PR #113).
11. [x] Account pooling no longer hops between one person's identical subscription plans.
12. [x] AI/Claude attribution watermarks were removed (PR #114).
13. [x] Multi-target policy checks, walk filtering, household limits, Lockdown propagation,
    read-before-edit, test permission prompts and major smoke-test defects have landed.

## Release reliability and distribution trust

14. [ ] Make `package.yml` publish the release after every required artifact and checksum
    passes. 0.19.0 finished packaging but remained a draft and needed manual publication.
15. [ ] Add a regression test that proves a successful tag becomes the latest non-draft
    release and a failed/incomplete package remains unpublished.
16. [ ] Make release notes come from the reviewed release-notes file rather than the generic
    `Downloads for vX` body.
17. [ ] Obtain two consecutive green exhaustive Windows/macOS/Linux runs on one exact trunk
    commit, then keep a nightly exhaustive run as the slow safety net.
18. [ ] Diagnose and remove the remaining machine-speed tests, unexplained Playwright click
    stall and silent process death. Do not merely widen timeouts.
19. [ ] Fix the remaining Windows CLI/TUI assertions: terminal title and Alt+Enter/history redraw.
20. [ ] Protect release tags and required checks from ordinary admin bypass; document the
    narrowly scoped emergency procedure and audit every use.
21. [ ] Code-sign Windows releases with a trusted publisher certificate. Checksums from the
    same release prove integrity, not publisher identity.
22. [ ] Turn on stable macOS certificate signing; add Developer ID notarisation when credentials
    are available. The 0.19.0 package reported the Mac archive as unsigned.
23. [ ] Publish provenance/attestation, dependency lock evidence and an SBOM for each artifact.
24. [ ] Test real updates from 0.18.1 to 0.19.0 and from 0.19.0 to the next candidate on Windows,
    macOS and Linux, including cut download, changed file, killed hand-over and rollback.
25. [ ] Verify install, repair, downgrade refusal, clean uninstall, keep-data uninstall and
    reinstall on each desktop OS.

## Known defects and incomplete proof on 0.19.0

26. [ ] Make the in-window `/api/health` check authenticated and require `response.ok`; today a
    401 resolves and can still be treated as connected. Recheck `/gateway/health` with the same rule.
27. [ ] Fix the terminal Permissions row so Lockdown off describes off, not "Lockdown is on."
28. [ ] Replace all "twelve Settings pages" strings with the real count or generate the wording
    from `SETTINGS_PAGES`; the product currently lists thirteen.
29. [ ] Turn raw schema/Zod failures into one plain sentence naming the bad field and accepted shape.
30. [ ] Let the read-only `branch status`, `branch logs` and `branch approve` paths work safely
    beside the running app, with authenticated routes and single-writer guarantees.
31. [ ] Exercise the remaining feature-smoke `NOT TESTED` rows rather than promoting source
    presence to proof: read-first on/off, remembered test approval, per-conversation modes, tidy,
    flows, undo/redo, replay, steer, resume-in-flight, room revoke, phone approval and plain TUI.
32. [ ] Resolve the 96 declared settings still parked in `NOT_IN_SEARCH.notYetReviewed`; index each
    real owner setting or record a specific reason it has no UI/search entry.
33. [ ] Give not-yet-drawn French settings real translated names rather than an English fallback.
34. [ ] Add mutation coverage for the unproved knowledge-graph/document-map/picture walk paths and
    any path-policy path that currently relies only on a neighboring test.
35. [ ] Clean stale status claims after their fixes land, so an old "BROKEN" report cannot be
    mistaken for current product state.

## One-to-one Grown Up design

36. [ ] Re-walk the approved sample against the actual 0.19.0 UI at 1440x950, 1024x700 and
    390x844 in light and dark. The existing 167-gap register predates later merges and the composer.
37. [ ] Preserve the completed composer exactly while the surrounding screen changes; keep the
    model chip, Ask first chip, microphone visibility rules, menu behavior and narrow layouts tested.
38. [ ] Rebase and adversarially review the unmerged control-factory work; convert the remaining
    live native selects, bare checkboxes and radios to the sample's dropdown, switch, segmented and
    choice-card vocabulary without losing dynamic options or multi-select behavior.
39. [ ] Finish the Settings shell: Back/Esc, title/version, on-page navigation, semantic heading
    order, mobile tabs, single-column sections, level card and exact sample spacing/copy.
40. [ ] Finish every Settings page and missing section, including Instructions & personality,
    Trunks & people, Chat apps & devices, Connections, Skills & plugins, Memory & library,
    Automations & inbox, Accounts, What's on screen and Achievements.
41. [ ] Write and verify hover-help copy for every owner-facing control in English and French.
    The last measured gap was 413 missing explanations.
42. [ ] Finish the conversation shell: computer title, Conversations/Trunks tabs, Overview,
    new-conversation picker, footer controls, owner row, open-conversation strip, search and guide.
43. [ ] Finish the Trunks rail/studio one-to-one: rail geometry, all tabs/colors/faces, start place,
    header preview, right-click menu, off-state add path and information button.
44. [ ] Finish the side panel one-to-one: named tabs, close/detach controls, real Browser view,
    typeable terminal, empty states and responsive resize behavior.
45. [ ] Finish People and Overview: real entry points, capability list, Trunks/projects/allowance/PIN,
    invitation flow, faces, change-look and layout.
46. [ ] Finish the acorn corner, pets, achievements, celebrations and owner backgrounds, including
    phone behavior and reduced-motion/accessibility variants.
47. [ ] Align Inbox, Automations, Library and Customize, plus the phone navigation and Trunks strip.
48. [ ] Align the usage ring/popover and mode picker placement, bars, totals, Lockdown entry,
    number keys and explanatory footer.
49. [ ] Build the sample's terminal/phone/tablet frames as real functional views, never stage dressing.
50. [ ] Remove sample-only fiction from shipped UI: frozen versions, fictional people, "sample",
    unsupported KeepOak claims and statements that no real action occurs.
51. [ ] Run visual regression, keyboard, screen-reader, zoom, high-contrast, reduced-motion and
    localization sweeps on every redesigned screen.

## Safe self-development

52. [ ] Complete the full bounded loop:
    request -> acceptance contract -> isolated worktree -> plan -> edit -> affected tests -> preview
    -> security review -> visible diff -> draft PR -> human merge -> canary update -> rollback.
53. [ ] Make Branch state the exact source commit, worktree, permissions, expected files, tests and
    definition of done before it changes itself.
54. [ ] Verify a real installed Branch can fulfill "remove this button" against its own source and
    produce a correct draft PR without changing the installed app or owner data.
55. [ ] Require a plain "why merge" section, risk description, verification evidence, screenshots
    for UI work and explicit unverified assumptions in every Branch-created PR.
56. [ ] Prove fork contributors, upstream maintainers, no-network work, interrupted work, restart,
    merge conflict, rejected test, secret-looking diff and denied path all fail safely.
57. [ ] Add canary installation into a separate data/profile location, health observation and
    automatic rollback; self-development must never replace the active copy directly.
58. [ ] Audit the two unique commits still visible on the old self-development branch against the
    merged PR so no safety fix was stranded or duplicated.

## Evidence-earned learning

59. [ ] Give every proposed memory, procedure or skill provenance: source tasks, owner, model,
    tools, permissions, cost, failures and exact version.
60. [ ] Compare candidate behavior against the current baseline on representative tasks and a
    separate holdout set; do not promote on its training examples.
61. [ ] Refuse promotion when evidence is missing, the candidate costs materially more, needs
    broader permissions or regresses any safety invariant.
62. [ ] Keep proposals inactive until owner approval; preserve prior versions, diff, audit history,
    quick rollback, quarantine, recovery trial and automatic demotion after repeated failures.
63. [ ] Test poisoning, contradictory corrections, stale evidence, cross-owner isolation, restore,
    export/import and concurrent promotion.

## Acceptance contracts and receipts

64. [ ] Before substantial work, record the requested outcome, constraints, allowed side effects,
    acceptance checks and which claims will remain unverified.
65. [ ] At completion, produce a structured receipt separating artifact, tests/observations,
    unverified assumptions, external effects, cost, retries, human intervention and rollback point.
66. [ ] Bind receipts to task/run ids, source revision, tool calls and artifact digests; make them
    exportable and independently checkable without exposing prompts or secrets.
67. [ ] Show partial, failed, cancelled and resumed work honestly; never turn "no assertion failed"
    or "file exists" into an end-to-end success claim.

## Measured competitor benchmark

68. [ ] Refresh the competitor matrix against current Hermes, Claude Code, Codex, OpenClaw and
    GrokBot versions, licenses, documented capabilities and allowed authentication paths.
69. [ ] Build reproducible task sets for coding, browser work, recovery, documents, automation,
    delegation, long-running work, permissions and mobile/remote control.
70. [ ] Use the same model, context window, hardware, time and permission budget where products allow;
    publish every unavoidable difference.
71. [ ] Measure completion, hidden-case correctness, human interventions, retries, wall time, total
    tokens/cost, permission violations, restart recovery and truthful self-reporting over multiple seeds.
72. [ ] Re-run the twelve-task coding bench after the landed coding fixes. The existing Qwen window
    produced at most 1/8 for every contestant and supports no superiority claim.
73. [ ] Give Hermes the context window it requires on a new isolated NAS VM, and keep every competitor
    installation/data directory separate from the owner's real agents.
74. [ ] Publish raw inputs, outputs, judges, environment manifests and confidence bounds; only claim
    a win when the predeclared rule is met.

## Capability portability

75. [ ] Import/export Agent Skills, MCP servers, project instructions and Branch capability bundles
    through a versioned manifest with hashes, origin and license metadata.
76. [ ] Show permission, network, secret, cost and platform differences before installation or update.
77. [ ] Pin versions, sandbox untrusted capabilities, verify signatures where present and retain a
    one-click rollback to the last working bundle.
78. [ ] Add compatibility fixtures for Claude/Codex/Hermes/OpenClaw conventions without copying
    proprietary internals or weakening Branch's rules.

## Owner-controlled remote execution

79. [ ] Turn remote work into an explicit job contract: named SSH host, repository/workspace,
    command/tool allowlist, resource/time budget, artifacts in/out and owner-visible cancellation.
80. [ ] Pin host identities, use narrow credentials from the local broker, redact receipts and never
    put vault values in model context, logs, environment dumps or PRs.
81. [ ] Survive disconnect, sleep, reboot and killed workers; resume from a checkpoint or report the
    exact incomplete boundary without repeating side effects.
82. [ ] Verify Windows, macOS, Linux VM and NAS execution, concurrent jobs, a hostile workspace,
    expired credentials, no capacity and rollback.

## Cross-platform, mobile and always-on acceptance

83. [ ] Run the desktop app, browser UI and CLI/TUI end to end on Windows, macOS arm64/x64 and Linux.
84. [ ] Verify the gateway/daemon survives window close, reboot, sleep/wake and killed process, and a
    connected Telegram Trunk continues answering within the owner's rules.
85. [ ] Android: test supported API levels in emulators plus a real phone installed by QR; cover
    signing continuity, permissions, files, camera/QR, backgrounding, reconnect, approval and update.
86. [ ] iOS: run Xcode simulator coverage and a real signed-device build; cover permissions, share
    extension, background/reconnect, approval, upgrade and provisioning-expiry behavior.
87. [ ] Verify responsive layouts and every owner action at phone width, including approvals,
    recovery, file transfer and readable error states.
88. [ ] Run chaos seeds, install-torture and update-torture on the exact release candidate, not an
    earlier nearby commit.
89. [ ] Have a non-technical tester install, connect a model and complete one real task without help;
    record confusion and repeat until the path succeeds unaided.

## Security, privacy and account boundaries

90. [ ] Re-run the built-in security profile and dependency audit on every candidate; add static,
    secret, dependency and artifact scanning to CI with reviewable suppressions.
91. [ ] Threat-model self-development, remote execution, learning promotion, capability import,
    updater and mobile pairing; verify each mitigation with an attack test.
92. [ ] Re-run household, short-lived-key, outside-task, Lockdown, path-rule and multi-target matrices
    for every new route/tool/UI surface.
93. [ ] Keep credentials behind the local Bitwarden/credential broker with narrow field retrieval,
    fresh-read validation, serialization and no secret retention.
94. [ ] Verify provider/account pooling obeys provider terms, never shares personal credentials and
    never uses account rotation to evade plan limits.
95. [ ] Add privacy-safe diagnostics retention/deletion/export tests and prove "Report a problem"
    sends nothing until the owner explicitly chooses.

## Architecture and maintainability

96. [ ] Continue behavior-preserving extraction of monoliths: current trunk is approximately
    `src/server.ts` 4,160 lines, `src/runtime.ts` 3,286, `src/index.ts` 1,989,
    `public/app.js` 2,190 and `public/layout.js` 1,517.
97. [ ] Split by owned domain and typed boundary; keep functions small, eliminate duplicate renderers
    and ensure each extracted module has focused tests before deleting the old path.
98. [ ] Remove dead probes, obsolete status scaffolding, abandoned branches and generated/source drift;
    never delete owner work without first proving it is obsolete and recoverable.
99. [ ] Audit dependency necessity, licenses and copied assets; retain provenance and use only code the
    project may lawfully redistribute.
100. [ ] Refresh architecture, API and contributor docs from current code, including the real trunk
     name, fast/slow checks, release publication and self-development boundaries.

## Backlog and governance cleanup

101. [ ] Reconcile issue #103 and audit issues #42/#55-#92 with 0.18-0.19 work. The current public
     tracker still says 601 released and 154 left from before the latest release and is stale.
102. [ ] Reconcile every non-merged remote branch by patch equivalence: merge reviewed unique work,
     supersede it explicitly or archive it with the reason. Do not equate "not an ancestor" with useful work.
103. [ ] Rebaseline the 167 design rows and the 785 capability rows so each requirement is counted
     once, has an owner/evidence link and cannot be closed by a test that does not exercise the feature.
104. [ ] Keep pull requests small and reviewable, with one problem, reason to merge, risks, affected
     tests, screenshots where relevant and rollback notes.
105. [ ] Close stale issues/branches only after their replacement commit and verification are linked.

## Final release gate

106. [ ] Exact candidate commit passes build/typecheck, fast selector, exhaustive three-OS CI twice,
     security checks, dependency audit, chaos, install/update torture and representative real-model smoke.
107. [ ] Exact candidate passes desktop/browser/CLI, Android real-device, iOS simulator/device,
     daemon/reboot/recovery, self-development, learning, receipt, portability and remote-job scenarios.
108. [ ] Zero open critical/high findings; every accepted lower finding has an owner-visible limitation,
     issue, mitigation and target release.
109. [ ] Artifacts are signed/attested, checksums independently verified, release notes honest, updater
     tested from the prior version and rollback/data preservation proven.
110. [ ] Only after the benchmark gate passes may the project say it is better than named competitors;
     otherwise publish the measured strengths, weaknesses and ties.

## Current next action

111. [ ] Fix 14-16 first: automatic publication and reviewed notes. Then finish the current exhaustive
     run and address its named failures before another product batch lands.
112. [ ] Add JEV as optional, owner-controlled typed decision support: off by default; bounded
     yes/pick/score inputs; state over stdin rather than process arguments; JEV-owned credentials;
     confidence gates and fallback instead of autonomous action; cross-platform adapter tests and
     measured benchmark evidence before it may influence routing, learning promotion or approvals.
113. [x] Re-certify existing teamwork on the integrated Grown Up head: durable named roles, fan-out,
     shared agent-room history after restart, in-room approvals, handoffs and the real room UI pass
     31/31 focused tests. Keep this evidence distinct from human membership in a private room.
114. [ ] Satisfy `collaboration.rooms` literally: add both human and agent members to one private room,
     enforce membership on history and artifacts, and prove refusal after removal. Agent-only Trunk
     rooms do not close this requirement.
115. [ ] Re-certify all 169 rows in `docs/features.json` against current code and exercised tests.
     Replace the stale 95 implemented / 14 partial / 1 external / 59 missing snapshot only from fresh
     evidence; do not turn source presence, neighboring tests or a renamed capability into completion.
