# Automate

## What this is for

Having your assistant start work without you: at a time you choose, when a page changes, when another
program asks, or as a saved set of steps you can repeat exactly. Also skills — pages of written
instructions that teach it how you like things done.

## In one minute

- **Schedules** runs something once, every so often, or at the same time each day.
- **Watches** tell you when a page or a search changes.
- **Procedures** are saved steps it can repeat exactly, with the answer you expect written beside them.
- **Flows** are the same idea drawn as boxes and arrows.
- **Skills** are pages of instructions — how you like a letter laid out, the steps for a monthly report.
- Branch has to be running for any of it to happen.

## Schedules

**Schedules → Set up a task** starts something on its own: once, on an interval, or at the same time
each day in your timezone. A schedule can be a task, a reminder, or a monitoring check that remembers
its last result.

The answer can be sent on to a chat you have already connected. Each schedule keeps its own run
history, so you can see what happened every time.

If the computer was asleep, the missed times become **one** task the next time Branch looks — not one
per missed slot — and nothing that failed is tried again by itself.

A schedule can also run a test suite, so you find out something has stopped working before you need it.

## The morning brief

One message first thing, put together from what the app already holds: what is planned today, tasks
left unfinished, documents added in the last day, watches that changed, and anything you asked to be
reminded of. There is no calendar account and nothing is read aloud. You choose the time, the timezone,
where it goes — a chat, or just your conversation list — which sections appear, and the wording. You
can preview it without sending it.

## Watching a page or a search

A watch looks at a page, or at a search, every so often — at least every five minutes — and tells you
what changed in plain language: how many lines are new, how many are gone, and a few of each. The
first look is taken straight away so the next change is a real change.

News can go into your conversation list or straight to a chat. A watch that cannot be read is tried
again in an hour and never stops the others.

## Procedures

**Procedures** are a saved set of steps your assistant can repeat exactly, with the answer you expect
written down beside it. Checking one does the steps for real; replaying one first makes sure
everything it needs is still where it was.

A procedure can take named inputs — *"which month"*, *"which folder"* — which are checked before
anything runs, and it can declare the shape its result has to have. Procedures and specialists travel
between installations as templates that never carry secrets.

**Important:** a saved procedure or workflow goes through your approval rules exactly like a live
task. Saving something does not pre-approve it.

## Flows

A **flow** is a job drawn as boxes and arrows, so you can see the shape of a long job rather than
reading it. Each box says what it reads and what it writes, arrows can turn on what the last box
found, a circle may be gone round only as many times as you allow, and a box can be another whole
flow. Flows survive a restart, other programs can start one, and a note goes out as each box
finishes.

Where a flow has got to is written down after every box, so **Carry this flow on** picks it up at
the box after the last one that finished rather than starting at the top. One thing to know: if the
app stops in the very moment between a box finishing and that note being written, that box is done
again when the flow is carried on. Nothing is lost and nothing is muddled — the box simply runs a
second time — so a box that must not happen twice is worth putting behind an approval.

## Specialists

**Specialists** are assistants that do one job and are allowed to touch only what that job needs — the
one that tidies your invoices cannot open your photographs. A new one has to pass the checks written
into it before you can switch it on.

Several can work on one job at once, sharing a budget and a small shared notepad that is emptied when
the job finishes. They come in different working styles: one thinks a line out loud before every step,
one plans its piece first, one reviews and cannot change anything, one looks things up and has to name
its sources, and one writes code.

You can also ask for a **short numbered plan** before anything is done, edit it, and then let it run.
That, a reviewer pass over the finished answer, and milestone notes on long jobs are all off until you
turn them on in Settings.

**What is only partly there:** the reviewer checks the finished answer in a pass of its own. It is not
a second model watching every turn as the work goes along.

## Skills

**Skills** are pages of written instructions your assistant can follow — how you like a letter laid
out, the steps for a monthly report. It knows the name of every skill you keep, and reads the one it
needs rather than carrying them all at once.

**A skill never grants permission to do anything**; your rules still decide that.

You can pin one skill to a conversation so its full instructions stay in front of the assistant for
every turn.

**Sharing a skill.** Save one as a single file and hand it to someone, or open one you were sent. Before
anything is installed you see exactly what it asks for — including the web addresses it may call and
which of your saved secrets it would use. Every file in the package is fingerprinted, so a package that
was changed after it was made installs nothing at all. A skill arrives switched off.

**When a skill looks risky** decides what happens when the scan finds a pasted secret, an instruction to
send data somewhere, or an attempt to override your rules: refuse it outright, or install it switched
off with the findings shown.

**Skills that earn their place.** A skill that keeps failing the same way is **set aside** and gets one
trial later; one that fails too often is demoted. Two versions can be measured against the same tasks,
and a better version can be drafted from a task that went well.

**Suggested better versions** shows you the lines that changed and tries the new version against your
last few tasks as a practice run where nothing is really done. Then you keep it or throw it away.
Nothing improves itself behind your back.

**Might have helped lately** reads the wording of your own recent tasks and names skills you already
have but have switched off. It is a plain word match on this computer: no model is asked, nothing is
sent anywhere, and a suggestion never installs or switches anything on.

## Triggers and hooks

Another program can start a flow or a schedule over the web, and small hooks can run when things
happen and switch themselves off if they keep failing. Both are in [For builders](07-for-builders.md).

## Where to go next

- [For builders](07-for-builders.md) — the command line, plugins, and starting things from elsewhere.
- [Permissions and safety](04-permissions-and-safety.md) — an unattended task waits for your yes, and
  nobody is sitting there to give it.
- [Troubleshooting](08-troubleshooting.md) — when something scheduled did not happen.
