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
and between accounts you mark **Kept separate** — a work account beside a personal one, or somebody
else in the house using their own. There is a new tick box on each account, `/account separate
<name>` in the terminal, and a one-time notice explaining the change.

**A window built around one question.** The calm window from 0.18.1 is now the whole design, in the
approved shape: a small ring under the message box showing which connection has the least left and
when it refills, a glass list behind it with every connection, and a question at 95% offering to save
what a running task has done so far. Lists of choices are glass rather than the computer's own grey
boxes, icon-only buttons say what they do when you hover, and the window now fits a phone and a
tablet as well as a desk screen. The message bar now follows the Grown Up sample directly: the model
is visible beside the mode, opens a real per-conversation picker, and the + menu reaches attachments,
Ask first, Temporary and the assistant choice without leaving the conversation. **Slate is the new
default look.** If you have ever picked a theme — Forest included — yours is kept and nothing changes
for you.

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

**Coding tasks that get to the point.** A coding task used to spend whole exchanges with the model
just looking for a tool. Over five ordinary coding requests, 14 of the 30 times it needed one of the
everyday file tools — read, search, list, find, change, write — that tool was not in front of it and
had to be fetched first, which costs a whole round trip and teaches the model nothing. Two things
change that. The first happens for everyone, with no switch: no single toolbox can take every place
on the list any more, so a request is never shown none of the tools its work needs. (That share-out
on its own takes the number from 17 to 14. The 17 was measured before this work, on the earlier
build, and was not measured again on the finished one.) The second is a new switch, **Doing more in
one go**: it puts the tools a coding task always needs in front of it from the start, tells it that
it may ask for several independent things at once, adds a way to read several files in one step, and
runs look-only calls at the same time. With it on, **1** of those 30 needs a search — and it is the
tools-in-front part alone that does that. Two of the sample requests also finished in fewer steps:
renaming something across a project went from 9 calls to 4, and fixing a range from 6 to 4. It ships
off. All of this was measured against a stand-in for the model rather than a live one, so the number
to trust is the work each removed exchange saves, not a promise about how fast your own task will be.

**A task that runs out of room now answers.** It used to end on nothing but "Maximum 12 model rounds
reached" — no answer, and no clue what it had spent those rounds on. It now gives the best answer it
has from the work it did and says in plain words where the rounds went. How many rounds a task may
take is yours to change: Settings → Advanced, **Times one task may go back to the model**, left empty
to keep what Branch was started with (12). A tool that arrives part-way through a task no longer
pushes another one off the list.

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
- **Three found before anyone had them.** The new many-file read named no target, so your rules
  judged it against nothing: a rule refusing file tools under a folder refused reading one file
  there and let the many-file read of that same file through. It now names every path it would read,
  and each one is judged. Separately, the line saying what a task is doing, and the record of what it
  reached for, were written for a whole reply before any of it ran — even with that part switched off
  — so a task stopped at its first step named the wrong thing; they are written beside each call now.
  And when one round held two calls that each needed your yes, both put a question up but only one
  could stop the task, leaving the other waiting to be answered for something no longer running: a
  call that will be asked about now runs on its own. None of the three reached a release.
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

Everything new is switchable and ships off: read-before-changing, **Doing more in one go**, crash
notes, the activity log, dictation, the Talk live view, achievements, the pet, your own background,
the 3D look. The side
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

- Linux: the 4,295-test suite passed; 200 chaos seeds and 200 installer-torture seeds passed; the
  desktop tests passed after applying Ubuntu's documented Chromium sandbox setup.
- macOS: the 4,295-test suite produced one load-sensitive learning-evaluation failure, which passed
  on its own and in three immediate repeated groups. Build and type checking passed.
- Windows: the packaged desktop group passed 8/8. The final Grown Up composer contracts passed 45/45
  locally, covering desktop, compact and phone geometry, real model selection, refresh persistence,
  menus, typing state, locales and the key-leak guard.
- The required affected-test gate passed the final composer pull request in 2 minutes 25 seconds. A
  broad or unknown change cannot use that lane without an exact successful exhaustive run. Release
  publication accepts the same successful exact-commit evidence rather than waiting for a second,
  duplicate 70-minute matrix.

The first real update from 0.18.1 to 0.19.0 can only be exercised after these downloads exist. That
post-publication test is therefore not claimed here.
