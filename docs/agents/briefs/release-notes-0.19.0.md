## What changed in 0.19.0

This is the big one for how Branch looks and feels, and it also closes several holes in the rules
that decide what the assistant is allowed to do. Read the two short lists at the end — **What you
will notice straight away** and **What is off until you turn it on** — before you start.

**Branch never spreads your work across your own plans.** If you have more than one personal
subscription with the same service, Branch will not quietly hop between them when one runs out of
room. Moving your work to another of your own identical plans because the first hit its limit is the
kind of thing the services' terms call getting round a limit, and none of them says in writing that
it is allowed — so Branch keeps to the plan you chose and tells you it has run out, rather than
putting your accounts at risk. It still moves between API keys, which you hold and pay for as you go,
and between accounts you mark **Kept separate** —
a work account beside a personal one, or somebody else in the house using their own. There is a new
tick box on each account, `/account separate <name>` in the terminal, and a one-time notice
explaining the change.

**A window built around one question.** The calm window from 0.18.1 is now the whole design, in the
approved shape: a small ring under the message box showing which connection has the least left and
when it refills, a glass list behind it with every connection, and a question at 95% offering to save
what a running task has done so far. Lists of choices are glass rather than the computer's own grey
boxes, icon-only buttons say what they do when you hover, and the window now fits a phone and a
tablet as well as a desk screen. **Slate is the new default look.** If you have ever picked a theme —
Forest included — yours is kept and nothing changes for you.

**How much the assistant may do, per conversation.** Beside Send there is a chip with four choices:
**Ask first**, **Plan**, **Auto** and **Full access**. It changes that one conversation only, your
saved setting is untouched, and a choice you are not allowed right now is greyed with the reason
rather than hidden. **New conversations you start in the window now begin on Ask first**; every
conversation from before this release keeps behaving exactly as it did, and you can set new ones back
to following your own setting under *When to check with me → New conversations start on*.

**More room to work.** One side-panel button opens Activity, Plan, Files, Memory and two new tabs:
**Browser** (the pages the assistant opened, with the last picture of each) and **Terminal** (the
commands it ran, what they printed, and the ones it was refused). The side list and the panel can be
dragged wider, double-click puts them back, and anything key-shaped in a command or its output is
hidden on screen. The terminal view has been redrawn in the same design language as the window.

**Trunks, rooms and people.** A strip along the side shows your Trunks with drawn faces; a studio
walks you through adding one, and two computers can be paired without touching a terminal — each
screen shows a check code and you tick that they match before anything is let in. In a conversation
you can choose which Trunk answers, or make a **room** where several answer together, and there are
Overview and People pages. On a phone the strip runs across the top instead.

**Settings you can actually find.** Settings are grouped by what you are trying to do, with
**Regular / Advanced / Technical** deciding how much is shown, and a search box that finds any of the
530 settings by name — including ones on pages not drawn yet, and in French. Appearance now sits
beside two live mirrors of your own window, one dark and one light. There is a new **Accounts** page,
and the assistant's own instruction files can be edited on Settings → Assistant, with undo of the last
save.

**Your voice.** Dictation now has a bar of its own while you speak, instead of a control tucked away,
and **Talk live** can open a view of its own — a circle that moves with the real sound, what each
side said as it is said, Mute, Show the chat, and End. Both are off until you turn them on, and Talk
live needs a connection that offers it (OpenAI or Google Gemini today).

**Coding that gets it right more often.** The assistant reads a file before it changes it (a switch,
off as shipped). An argument a tool does not take is dropped and the model told, instead of the whole
call being refused. A model running on your own computer gets longer to start its first reply, with a
line on screen saying it is still coming. And before Branch runs your project's tests it asks once
per folder — **Let Branch run this project's tests? Always for this folder / Once / No** — because
running your tests is running a program on your computer.

**When something goes wrong.** Settings → Advanced now has an **Activity log** (off, when needed, on
— off as shipped, with keys, tokens, addresses and folder names stripped as each line is written),
optional **crash notes** kept on this computer only and never sent anywhere, and **Report a problem**,
which gathers versions, health checks and recent activity, shows you every part so you can remove
any of it, and lets you save a zip or open a GitHub issue yourself. Nothing is sent until you press
Submit there.

**Just for fun, all off.** 505 achievements, a small forest creature in the corner, your own picture,
video or 3D object behind the glass, and a 3D version of the acorn and the pet. Every one of these
ships off and is counted on your own computer; nothing is sent anywhere.

## The safety fixes in this release

These are the ones worth knowing about, in plain words.

- **The rules now judge what a tool really does.** Some tools rename or tidy what they are given
  before they run. The permission check used to read the request as sent, so a rule like "never
  anything under finance" could miss an edit that named the same file a different way. Every layer —
  the assistant, workflows, another program over MCP, "Try a tool", the dry run — now checks the
  tool's own understanding of the call.
- **A rule about a folder now holds when something walks the whole disk.** Listing, searching,
  globbing, grepping, mapping a project, building a knowledge base: each entry is now weighed against
  your rules, and refused things are left out with one sentence saying so. A whole-folder Git action
  (a diff or a status of everything) is refused outright when a rule protects a folder inside, rather
  than showing you its lines.
- **A task started from outside keeps its limits when it is carried on.** A schedule, a trigger, a
  chat app, or another program talking to Branch over MCP, A2A or ACP: 0.18.1 made those wait for you
  before changing anything, but carrying one on — resuming it, answering its question, "do that
  again", a workflow's next step — quietly turned it back into your own task. It no longer does: the
  task's origin is written down when it starts and read back every time, so the hold, and a chat
  app's own refusals, follow it everywhere.
- **A malware check that could not finish is not "clean".** A lookup longer than ten pages now counts
  as not checked.
- **Two faults in 0.18.1 that stopped tasks dead.** On a ChatGPT plan, a task whose wording merely
  mentioned git failed in about three seconds with a raw "Provider HTTP 400" and ran nothing, because
  two of Branch's git tools described a path in a way that service refuses. And switching **X search**
  on left the assistant with no tools at all on any model, because one setting in it could not be
  written down in the form the services expect. Both are fixed, the rules they describe are unchanged,
  and a new check now walks every tool Branch shows a model and fails if either kind of thing comes
  back.
- **A household profile sees only its own accounts** in the accounts list.
- **Rooms and voice**: a yes given in a room ends the question without rewriting the rest of the
  conversation, a message between Trunks is read as the task that sent it rather than as you, a
  message whose task stops to ask now shows as waiting rather than failed, and the live voice view
  opens for a conversation that began before its setting was read.

## What you will notice straight away

1. **New conversations start on Ask first.** Older conversations are unchanged.
2. **Slate is the default look.** Any theme you picked before, Forest included, is kept.
3. **Anything started from outside asks first, and keeps asking** — including when it is carried on,
   resumed, or continued by another program over MCP, A2A or ACP.
4. **Branch will not move you between your own identical personal plans.** Mark an account
   *Kept separate* when it really belongs to someone else, or is your work one.
5. **`branch run` from a script, a schedule, a chat app or CI does not run your project's tests.** It
   says in one line that they were not allowed for that folder and carries on. `branch run
   --allow-tests` lets one task run them. Typed in a terminal, or in the window, you are still asked.
6. **A whole-workspace Git diff or status is refused** when one of your rules protects a folder
   inside it. Ask for the part you mean instead.
7. **Settings have moved**, into groups by task with Regular / Advanced / Technical. The search box
   finds anything by name.

## What is off until you turn it on

Everything new is switchable and ships off: read-before-changing, crash notes, the activity log,
dictation, the Talk live view, achievements, the pet, your own background, the 3D look. The side
panel's new tabs, the ring, the mode chip and the Trunks strip are part of the window and can be
hidden. Slate as the default and Ask first for new conversations are the two deliberate changes of
behaviour, both described above.

## If you have 0.18.1 now

Press **Update**. 0.18.1 is the first version with the fixed updater, so its Update button carries
your conversations, settings, memory and schedules across and keeps the previous version beside the
new one in case you want to go back.

## If you have 0.18.0 now

Use the **one-step installer** from this release page, with Branch closed — not the Update button,
which in 0.18.0 is still the old one with the problems described in the 0.18.1 notes.

- **Windows:** download `Install Branch Agent.cmd` and double-click it.
- **macOS and Linux:** download `install-branch-agent.sh` and run `sh install-branch-agent.sh`.

It keeps your conversations, settings, memory and schedules.

## Known gaps, honestly

- **The Mac download is not signed.** macOS therefore asks again for microphone, screen recording and
  accessibility permission after each update. The fix is ready and switched off until a signing
  certificate is set up.
- **iPhone** still needs a Mac with Xcode to install. Android installs by scanning a code.
- **On Ubuntu 24.04**, a fresh download still needs the one `sudo` command in the docs before its
  window opens the first time (`chrome-sandbox`). Updates carry it over by themselves.
- **The scoreboard against other agents** is built and measured, but it does not show Branch ahead on
  enough tasks to claim a lead, so none is claimed.
- The Docker image works only with `--network host`.

## How this release was checked

*(To be filled in before publishing from `docs/agents/STATUS-release-019.md`, which holds the counts:
the three-system CI runs, the Linux desktop, chaos and
install-torture counts, the macOS and Windows test counts, and the real-update test from 0.18.1 to
0.19.0 on Linux and Windows — the first run where the fixed updater is the one doing the work.)*
