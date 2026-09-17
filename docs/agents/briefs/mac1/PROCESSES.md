# mac1/processes: holding programs to limits, and ending them cleanly, on macOS and Linux

Rules: docs/agents/briefs/mac1/BUILD-MAC.md. Area name: `processes`.

**You own:** `src/integrations/job-object.ts`, `src/integrations/process-usage.ts`,
`src/integrations/shell-process.ts`, `src/integrations/shell-config.ts`, `src/processes.ts`,
`src/shell-session.ts`, `src/integrations/git-run.ts`, `src/stdio-rpc.ts`, `src/remote/ssh-workspace.ts`,
a new `src/integrations/posix-limits.ts`, and the tests that cover them (find with grep).

**Build:**
1. Today Windows programs sit in a job object (memory, processor, process-count limits; the whole
   tree ends together). On macOS and Linux build the equivalent from what ships: start each program
   as the leader of its own process group (`detached: true`), end the whole group (`process.kill(-pid)`,
   SIGTERM then bounded SIGKILL), apply limits with `ulimit`-style resource limits through a
   `/bin/sh -c 'ulimit -v … -t … -u …; exec "$0" "$@"'` wrapper built from an **argument array**
   (never user text in the script string), and read usage from `ps -o rss=,time= -g <pgid>` (macOS)
   or `/proc` (Linux). Where a limit is not available on the platform (for example `ulimit -v` on
   macOS), say so in the capability report instead of pretending.
2. `sandboxShape` composition must keep its property on every platform: a rule can only tighten,
   never loosen. Add a test that proves it for darwin and linux inputs.
3. Default shell: `zsh` on macOS, `$SHELL` or `bash` on Linux, PowerShell unchanged on Windows;
   quoting helpers per shell; the persistent terminal session works with a POSIX shell.
4. Everything that names `.exe`, `cmd.exe`, `powershell.exe`, `where` gets a POSIX branch
   (`which`/`command -v`, no extension).

**Tests:** fake executables for ps/sh; a real short-lived `node -e` child to prove the group kill ends
a grandchild (no window, no network); limit wrapper argument arrays; tighten-only property; shell
choice per platform with `platform` passed in.

**Acceptance:** M1 (processes and limits). Report any change needed in `src/code-run*.ts` or sandbox
files you do not own.
