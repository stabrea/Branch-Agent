# Wave 2 task: Git and GitHub for non-technical owners

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave2/git from origin/feat/assistant-runtime. Theme: git-integration (#84). No new UI screens (the shell is being redesigned elsewhere); tools, routes and docs only, plus the smallest possible additive settings entry for the GitHub token in the existing secrets/locker UI if one exists.

Read: src/integrations/shell*.ts (how commands run, timeouts, output limits), src/locker.ts / secrets handling, src/network-policy.ts, src/projects*.ts (project folders), src/contracts.ts.

Build:
1. `git.status`, `git.diff` (working tree or a range, size-capped), `git.log` (bounded), `git.branch` (list/create/switch), `git.commit` (message required; stages the given paths or all; refuses if nothing changed; never amends), `git.stash` is NOT included. All run the system git through the existing shell runner with a fixed executable path lookup (`where git`), inside the workspace or a project folder only, with `-c core.hooksPath=/dev/null`-equivalent disabled hooks and safe.directory handling. Plain-language error mapping ("Git is not installed on this computer", "This folder is not a repository", "There are unmerged changes").
2. `git.push` and `git.pull` are gated behind a separate permission `git.remote` that is off by default; pushing to a branch named main/master asks for confirmation through the existing user.ask flow.
3. GitHub (A0393, A0388): `github.createRepo` (private by default), `github.openPullRequest` (title, body, base, head), `github.listIssues` and `github.createIssue`, using the REST API through the network policy with a token stored in the locker under `github.token` (never logged; tests assert redaction in receipts and activity). No GitHub App; a personal access token the owner pastes.
4. Ignore-file access control (A0435): a `.branchignore` (gitignore syntax) in the workspace root that file tools and git tools both respect; document precedence with the secret patterns. Coordinate the format with the code-tools builder by using the same helper name `ignoreMatcher()` in src/ignore.ts (create it if it does not exist yet; keep it dependency-free).
5. Worktree helper (A2333): `git.worktree { action: "add" | "remove" | "list" }` creating worktrees only under a `.branch-worktrees` folder inside the workspace, so parallel experiments stay confined.

Tests (tests/git.test.mjs): initialise a temp repository with the system git, exercise status/diff/log/branch/commit; commit refuses with nothing staged; push refused without git.remote; a GitHub fake (node:http) receives createRepo/openPullRequest with the token header and the receipt shows the token redacted; .branchignore hides a file from files.read and git.diff; worktree add/list/remove confined; network policy blocks a non-github host.

Acceptance: G1 all tools gated and plain-language; G2 no token ever appears in logs, receipts or errors (tested); G3 push/pull off by default; G4 works when git is missing (clear message, no crash); G5 docs/configuration.md section; G6 existing shell tests pass.
