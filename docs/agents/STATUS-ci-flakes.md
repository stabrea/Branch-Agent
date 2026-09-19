# STATUS: CI flakes (mac7/ci-flakes)

Three tests failed in Checks run 35446096639 on `main` (same tree as trunk 926eb454). Find the root
cause of each, fix the product when it is a product bug, otherwise make the test wait for the
condition. Also any other test that failed more than once in the last 40 Checks runs.

## Findings
- governance "daily consolidation" (Windows, `2 !== 1` proposals): PRODUCT BUG. The server's
  scheduler checks every 5 s whether the daily consolidation is due, and it stays due until the
  cursor moves at the very end. A consolidation that outlasted one check was started a second time
  over the same tasks, staging every suggestion twice. Reproduced every time by running a manual
  consolidation and `scheduler.tick()` together.
- KOOK "pings carry the last number" (Linux, timed out): TEST TIMING. The test's pong budget was
  40 ms; answering "first" held the event loop longer than that, so the next beat closed the socket
  before any ping carried number 1 (diagnosed: link 0 got only `{s:2,sn:0}`, then a resume
  reconnect with sn=1). 9 of 75 local runs failed under load. Same shape as Guilded's 4fb8b60e.
- watcher "path-tracking watcher" (Windows, runs `2 !== 1`): TEST TIMING. 60 ms quiet time was a
  race with the test's own writes (the ignored node_modules folder and file sit between a.js and
  b.js and do not keep the burst open). Not reproduced locally (0 of 240); event trace shows all
  writes coalescing within ~20 ms here.
- Other repeats in the last 40 runs: guardrails "lifecycle hooks" failed twice on mac7/fast-ci
  (a3ec4c5a, 45783916), both before 943c4bfa (hooks take turns at the shell), already on trunk.
  The rest (NUL byte, Q2/Q6, allowlist, native desktop group, C11/I12) were broken intermediate
  commits, green on trunk since.

## Progress
- [x] governance: `MemoryReview.consolidate` is one at a time per person; a request while one runs
      shares it. New test forces the race (fails before: 2 proposals; passes after).
- [x] KOOK: pong budget 1000 ms in the test (heartbeat stays 30 ms); product 6 s unchanged.
- [x] watcher: test uses 400 ms quiet time (the AI-comments value) and waits two quiet times before
      asserting one run.
- [ ] loops after the fix
- [ ] merged into mac/cross-platform, CI run id
