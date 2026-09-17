# mac1/desktop-os: voice, hardware, permissions, completion and credentials on macOS and Linux

Rules: docs/agents/briefs/mac1/BUILD-MAC.md. Area name: `desktop-os`.

**You own:** `src/voice-tts.ts`, `src/local-hardware.ts`, `src/os-permissions.ts`,
`src/integrations/desktop-script.ts`, `src/cli-completion.ts`, `src/credential-cli.ts`,
`src/vault-sources.ts`, and their tests.

**Build:**
1. Read aloud with the system voice: macOS `say` (voices from `say -v ?`, write to a file with `-o`
   when a file is wanted), Linux `espeak-ng` or `spd-say` when present, and an honest "no system voice
   on this computer" otherwise. Never play sound in tests: fake executables only.
2. Hardware: macOS memory/cores from Node, graphics from `system_profiler SPDisplaysDataType -json`
   (Apple Silicon reports unified memory: say so plainly and treat it as shared); Linux from
   `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`, falling back to `lspci`.
   Parsers are pure functions tested with captured sample output for each platform.
3. Permissions page: on macOS explain Microphone, Screen Recording and Accessibility in plain words
   with the System Settings deep link (`x-apple.systempreferences:…`) — never trigger the prompt in
   tests; on Linux say which desktop features depend on the session (X11/Wayland).
4. Desktop scripting: macOS through `osascript` with arguments (never interpolated text), Linux
   through `xdotool` when present; otherwise a plain "not available on this computer".
5. Shell completion for `branch`: bash, zsh and fish scripts next to the PowerShell one, with an
   install hint per shell. Test by generating each script and checking every command appears.
6. Credential helpers: Bitwarden/1Password CLI lookups work with the POSIX executable names; the
   macOS Keychain (`security find-generic-password -w`) as a locker source behind the same
   `SecretProvider` contract, tested with a fake `security`.

**Acceptance:** M1 (voice, hardware, permissions, completion, credentials).
