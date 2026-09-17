#!/usr/bin/env bash
# Run the full suite against one exact commit, in a worktree nobody is editing.
#
# Three suite runs were thrown away in one day because the tree changed underneath them: a rebuild,
# a commit, and an edit to four test files, each made in the same working copy the suite was reading.
# A contaminated run is worse than no run, because it looks like a result.
#
# Usage: docs/agents/scripts/verify.sh [commit-ish]        (default: wave2/integration)
set -e
MAIN=/c/Users/bishi/Documents/Codex/Branch-build
VERIFY=/c/Users/bishi/Documents/Codex/Branch-verify
WHAT="${1:-wave2/integration}"
LOG="C:/Users/bishi/AppData/Local/Temp/claude-session-files/verify-$(date +%H%M%S).log"

cd "$MAIN"
SHA=$(git rev-parse --short "$WHAT")
cd "$VERIFY"
git checkout -q --detach "$SHA"
git clean -qfd -e node_modules -e dist
rm -rf dist
npm run build >/dev/null 2>&1

# Prove the build is really this commit before trusting anything it says: a stale dist has hidden a
# change that was present in the source, and the symptom looked like a completely different bug.
node -e "process.exit(require('./package.json').version ? 0 : 1)"

node --test --test-concurrency=4 --test-timeout=120000 \
  $(ls tests/*.test.mjs | grep -v "desktop\|screen-control" | tr '\n' ' ') \
  packages/sdk/test/sdk.test.mjs > "$LOG" 2>&1 || true

echo "commit $SHA"
grep -aE "^ℹ (tests|pass|fail|skipped)" "$LOG"
echo "--- failures ---"
grep -a "^✖" "$LOG" | head -10
echo "log: $LOG"
