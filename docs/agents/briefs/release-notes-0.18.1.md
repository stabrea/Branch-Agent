## What changed in 0.18.1

**Please read this first if Branch runs things for you on its own.** Anything started from outside
the window — a schedule, a trigger, a message from a chat app, another program talking to Branch —
now asks you before it changes anything, even when approvals are set to "No approvals". It can
still read, look things up and prepare; it waits for your yes before it writes a file, runs a
command or changes a setting. If you had schedules or chat apps doing work unattended, they will now
pause and wait for you. The tasks you start yourself in the window behave exactly as before.

**A calmer window.** Branch now opens on one question, "What do you want done?", with the rest of
the app one click away under More. If you prefer the full window you had before, turn on
**Show everything**. The message box is now a single line that grows as you type, with a **+** for
attachments and tools and one round button that sends, or stops a task that is running. Menus and
pop-ups close the way you expect: on their own button, on Escape, or on a click anywhere else.
Running conversations show in Recents, and **Restart** now restarts Branch properly.

**Get Branch on your phone by scanning a code (Android).** Open "Get Branch on your phone" on your
computer, scan the code with an Android phone, and the Branch app installs. The app travels inside
your desktop download, so nothing comes from an app store. Every copy is signed with the same key,
so later versions install over the top. **iPhone:** not yet. Today the iPhone app can only be
installed from a Mac with Xcode, signed with your own Apple ID; installing it by scanning a code is
coming, and the page says so instead of pretending.

**Safer updates.** The first real test of updating found problems on Linux and Windows, and they
are fixed from this version on. On Ubuntu, an update no longer leaves Branch unable to start because
of a system permission it lost along the way. On Windows, an update that is cut off halfway (a
crash, a power cut) is put right the next time you sign in, instead of leaving a half-copied
program. An update never touches your conversations, settings, memory or schedules, and Branch keeps
the previous version beside the new one: if the new one will not start, you go back to the old one,
and it refuses to go back when that would lose work you did in the new one. A broken or interrupted
download changes nothing and says so in plain words.

**The KeepOak mark in the Windows taskbar.** Branch now shows its own oak mark in the taskbar, on
the Start menu and on a pinned taskbar shortcut, instead of a generic atom.

**Household profiles are properly limited.** When the window is switched to someone else's profile,
every owner-only part of Branch is refused — your chat apps, your keys, your locker, your
housekeeping — not just hidden. The title bar says whose profile it is ("Using Sam's profile ·
Switch back"). You can set an optional **owner PIN** so that switching back to you needs it; it is
off unless you turn it on.

**One click for a local model.** One button installs a program that runs AI models on your own
computer, and a model that fits your machine. It asks before it installs anything, checks what it
downloads, and keeps it all inside Branch's own folder, so removing Branch removes it too.

**Removing Branch keeps your data unless you say otherwise.** The new "remove Branch" section in
settings takes away the program and everything it installed. Your conversations and files stay
unless you choose to remove them as well.

**Live dictation.** Press Dictate, speak, and watch the words appear in the message box. It runs on
this computer and costs nothing. It is off until you turn it on.

**/learn and /adapt.** `/learn` draws a map of the code or documents in the open project and walks
you through them. `/adapt` looks at a task that stopped, names what it was missing, offers a fix,
and carries on once you agree.

**Quieter fixes.** A task that did nothing is no longer reported as a success. Models that "think"
before they answer (including Anthropic's) are read properly instead of failing. A reply that ran
out of room says so. Many smaller fixes to settings, voice, the Mac download and more.

**Faster, more reliable checks.** Every change is now tested on Windows, macOS and Linux in parallel
pieces, so a full check takes about a third of the time it did, and several tests that failed only
because a machine was slow were fixed.

## If you have 0.18.0 now

The **Update** button in 0.18.0 still uses 0.18.0's own way of updating, which has the problems
described above. The safest way from 0.18.0 to 0.18.1 is the **one-step installer** from this
release page, with Branch closed:

- **Windows:** download `Install Branch Agent.cmd` and double-click it.
- **macOS and Linux:** download `install-branch-agent.sh` and run `sh install-branch-agent.sh`.

It keeps your conversations, settings, memory and schedules. From 0.18.1 on, the Update button
itself is the fixed one.

## Known gaps, honestly

- **The Mac download is not signed.** Because of that, macOS asks again for microphone, screen
  recording and accessibility permission after each update. The fix is ready and switched off until
  a signing certificate is set up.
- **iPhone** still needs a Mac with Xcode to install (see above).
- **On Ubuntu 24.04**, a fresh download still needs the one `sudo` command in the docs before its
  window opens the first time (`chrome-sandbox`). Updates now carry that over by themselves.
- **Outside tasks now wait for you**, so anything you had running unattended will pause until you
  answer (see the top of these notes).
- **The scoreboard against other agents** is built and measured, but it does not show Branch ahead
  on enough tasks to claim a lead, so none is claimed.
- The Docker image works only with `--network host`.
