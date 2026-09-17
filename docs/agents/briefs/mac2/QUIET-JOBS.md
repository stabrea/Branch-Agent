# mac2/quiet-jobs: background checks that only speak up when needed, and cost nothing when idle

Area `quiet-jobs`. Read `docs/agents/briefs/mac2/README.md`. **You own:** `src/scheduler.ts`, `src/monitors.ts`,
new `src/heartbeat.ts`, new `src/job-gate.ts`, their UI hooks in a new `public/heartbeat.js` (static allowlist in
`src/server.ts`), and tests. Do not edit `src/processes.ts` (mac1/processes owns it) — waking early when a
background command finishes is a follow-up; leave a clear TODO in your report.

1. **Heartbeat check-in:** every N minutes (default 30), only inside active hours and a timezone, work from one
   owner-editable checklist; skip the model call entirely when the list is empty; the model answers through a
   `heartbeat.respond({notify})` tool so a quiet check sends nothing; a small second opinion may decide whether a
   result is worth a notification. Study OpenClaw `src/infra/heartbeat-runner-*.ts`, `heartbeat-active-hours.ts`,
   `src/auto-reply/heartbeat.ts`; nanobot `nanobot/utils/evaluator.py` (MIT).
2. **Scheduled jobs gated by a script:** a job may carry a short owner-approved script (same rules as other programs:
   full path, argument list, limits, no network unless allowed) that runs first and prints
   `{"wakeAgent": bool, "data": …}`; the model is woken only when told, and gets `data`; a failing script backs off
   and pauses the job after repeated failures with a plain reason. Study NanoClaw
   `container/agent-runner/src/scheduling/task-script.ts`, `src/modules/scheduling/recurrence.ts` (MIT).
3. **Notify gate for existing "check" schedules:** they stop always delivering; deliver only when something changed
   or needs the owner.
4. **Health at a glance:** each automation shows healthy / failing / never run, run count, recent success rate and
   average duration (OpenHands `automation-health-badge.tsx`, MIT).
