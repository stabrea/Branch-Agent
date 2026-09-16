## What changed in 0.16.0

**Talk to it, and interrupt it.** A live voice conversation now runs over a connection that stays open, so you can speak, hear the answer as it is spoken, and cut in mid-sentence. The conversation keeps a trace you can read afterwards, it closes when the app closes, and the sound itself is never kept on disk. If a tool needs your yes during a live call, the question is tied to the exact request that asked for it, so an answer can never be spent on a different one.

**You decide how much rope a tool gets.** An approval rule can now say how tightly a program Branch starts is held: in a box with no way out to the internet, in a box, or no box at all. The choice is shown on the approval card before you answer, and the result says which box the program actually ran in. A rule can only tighten what Settings already says, never loosen it: if you have switched the internet off for scripts, no rule opens it again.

**Your password manager, asked directly.** Branch can look a secret up in Bitwarden or 1Password through the command-line tool you already have signed in, rather than keeping a second copy of it. A locked app reads nothing.

**Everyone in the house gets a role.** A household profile now carries real grants: a child's profile is refused tools that spend money and projects it was not given, and it cannot get round that by coming in another way.

**Your own checks, before something happens.** A hook can now run *before* a tool call and stop it: it can refuse the call outright with a reason, or hold it and put the question to you. Commands fail closed, so a check that says nothing or falls over can never let something through by accident.

**Work split between workers.** A supervisor hands pieces of a goal to named workers and writes the single answer that comes back, a swarm works down one shared list and puts back anything nobody finished, and a specialist can hand work on with a reason, only to the people it is set up to hand to.

**Lockdown, and the small things.** A lockdown switch, answers kept and reused when the same question comes round again, defaults per project, conversations shown as a tree, and `branch watch` to run a saved procedure whenever a folder changes. Every screen was walked in both themes down to a 400-pixel window, and an inbound webhook address now ends in an unguessable word so a stranger cannot mint one.

**Honesty about what is done.** The ledger of finished work was verified row by row a second time and 48 rows were re-opened, because a test that only checks a name exists is not proof that anything works.

**Install**
Download `Branch-Agent-windows-x64.zip`, unzip it, and run `Branch Agent.exe`. From 0.7.3 onward the in-app update is silent. The checksum is in `Branch-Agent-windows-x64.zip.sha256`.
