# Permissions and safety

## What this is for

Deciding how much your assistant may get on with by itself, where your passwords and keys live, what
happens when you want everything to stop, and the short list of things Branch will never do whatever
it is asked. Read this before you let it change anything.

## In one minute

- **Settings → When to check with me** has four choices. Until you pick one, nothing is checked.
- **Lockdown**, at the top of the rail, refuses commands outright and makes every other tool wait for your yes.
- **Settings → Secrets** is the locker. A value goes in and never comes out again in readable form.
- **Lock session** shuts the locker after a quiet spell without stopping the assistant answering.
- **Settings → Using your screen and keyboard** is off out of the box, and stays off until you say.

## When to check with me

**Settings → When to check with me** has four choices:

| Choice | What it means |
| --- | --- |
| **No approvals** | The starting point. Nothing is checked with you and nothing is refused. |
| **Ask before changes** | Reading is free. Anything that changes a file, runs a command or acts on a web page stops and waits for your yes. |
| **Just do it inside my workspace** | Writing files is fine. Running a command, and clicking or typing on a web page, wait for your yes; a website it has not used before is checked with you once and then remembered. |
| **Read only** | It may look at things and answer, but may not change a file, run a command or act on a web page. A refusal is explained in the answer; the task is not killed. |

**Pick one before you do anything else in this chapter.** Several other protections here only have
something to hold on to once you have chosen something other than *No approvals*.

## Rules

Each choice fills in a list of **rules** you can then edit. A rule says: for this tool, and for what
it would touch — a file path, the start of a command, or a website's address — the assistant **goes
ahead**, **checks with you**, or **is not allowed**. Rules are read from the top and the first one
that matches decides. A rule can be limited to tools that *change* something, so it never gets in the
way of reading. They are shown as plain sentences, not as code.

**Answering a question.** When a task stops for a yes, it appears under **Settings → Waiting for your
yes** and as a pause on the conversation. You can say yes just this once, yes for the rest of that
conversation, yes always, or no. *Yes always* is written back into your rules as a new rule at the
top, so you are not asked again. You can also decide a whole kind of thing at once, rather than one
question at a time.

**What is allowed right now**, in the pane on the right, lists every yes this conversation is
carrying, when it runs out, and a way to take it back.

**Ask me questions first** makes a long task ask you its questions before it starts rather than
stopping halfway through.

**A practice run** does the task for real but stops every tool that would change something: each one
reports what it *would* have done, and the task ends with a list of every intended action. Tools that
only read run normally, so the assistant still sees real information.

**How fast one conversation may work.** Two optional limits, both off by default: how many tools it
may use in a minute, and how many times it may go back to the model in a minute. Going past a limit
pauses the task with a plain message, waits, and carries on.

**Tasks you did not start yourself.** A task started by a schedule, by an incoming trigger, or by
another AI tool never gets more freedom than *Ask before changes*, and it cannot give itself a
permanent yes from inside the task. Worth knowing before you choose: nobody is sitting there to
answer for those tasks, so they stop and wait until you answer them in Settings.

**What the rules do not cover.** They apply to what the assistant decides to do on its own. A tool you
run yourself from this app is your own action and goes straight through.

## Lockdown: one switch

Lockdown sits at the top of the rail. Turning it on **refuses, without asking**, running a command
or a script, leaving a program running, using your screen and keyboard, borrowing your browser, your
other devices, handing work to another computer and steps that send to other apps: you are told
Lockdown is on instead of being asked. **Every other tool waits for your yes.** It also
switches off running a script, leaving a program running, using your screen and keyboard, borrowing
your browser, sending messages out, and telling other programs what happened. It also ends every
*"yes, just for this conversation"* you gave earlier, so nothing already agreed to carries on unasked.

Turning it off puts back **exactly** the settings that were there before — they are copied, untouched,
before anything is changed. Both moments go into the record of what the assistant was allowed to do.

Automations that start by themselves, a Trunk's routines and your personal connectors are off too,
whatever they were set to, and a switch you turn on while Lockdown is on stays off until you turn
Lockdown off. A task that was already working is stopped at its next step that Lockdown refuses.

One thing it does not switch off, because there is no switch to throw: a connection another AI tool
already has stays reachable, with every call through it waiting for your yes like any other.

Only the owner can turn it on or off, and it survives closing and reopening the app.

## Secrets

**Settings → Secrets** is a locker, kept per project. A value you put in is encrypted with a key held
outside the database, is never returned by any route, and is never shown again.

A command that needs a secret names it, and receives it as an environment variable of that one
command. Only the active project's secrets resolve; anything else is refused.

**Say which secret without saying the secret.** Anywhere a key is wanted you can write a reference —
`secret://default/DEPLOY_TOKEN` — instead of the key. Branch looks the real value up at the last
possible moment, as it goes into a request or a command, and only from the project that is active.

**One scrubber** remembers every value that has ever been looked up, for as long as the app is
running, and runs over everything on the way out: a tool's answer, the receipt that proves the answer
was not edited afterwards, every line in the activity log, the summary of a task, and the text of any
failure — including one sent back over the web interface. Where the value would have been you see
`[secret DEPLOY_TOKEN]`. The order matters and is deliberate: the answer is cleaned *before* its
receipt is signed, so a cleaned answer still passes its own check.

You can replace a secret and have the date recorded, be reminded when one is due, and see a list —
newest first — of every time a secret was taken out of the locker: which one, which project, which
task, what for and when. The values never appear there either.

**Signing in the ordinary way.** Branch can sign in to a service through its own page in your browser,
with the answer coming back only to this computer and the key going straight into the locker. Branch
never sees your password.

## Locking the app

**Lock session**, in your own menu at the foot of the rail, locks Branch now. **Settings** can also
lock it after a number of quiet minutes. While it is locked it keeps answering from what it already
knows, but will not take a saved password or key out of the locker for a new task.

Two things worth knowing before you turn it on. **Reading is not activity** — the app refreshes its
own screen every few seconds, so only *doing* something restarts the quiet period. And a locked app
cannot fetch a saved chat token, so a channel that has to reconnect while it is locked says it needs
attention until you unlock. At the default of never locking itself, neither applies.

## Personal details

Every message Branch sends to a chat or a mailbox is looked at first. Email addresses, phone numbers,
payment card numbers, bank account numbers and national id numbers are replaced with a plain note
such as `[card number hidden]`. You can choose to be warned instead, to have the message held back
altogether, or to switch the check off.

What Branch *reads* — your own files above all — is **not** rewritten unless you ask for it. Reading
your own address book should give you your own address book.

An optional content check can show an outgoing message to your model service's moderation route first.
It is off until you switch it on, and it never blocks a message when the check itself cannot run.

## People who share this computer

**Profiles** give somebody else a name and a PIN of four to eight digits. While their profile is
switched on, the conversation list, saved conversations and **Memory** are theirs and not yours, a
task they start is filed under their name, and the locker, projects, saved workflows, the waiting line
and your own shared copies are all refused in plain words — and so is every other part of Branch
that is yours alone: settings of every kind, approval rules, sign-ins, chat apps, devices, add-ons,
backups, updates and removing Branch. They are told *"This belongs to the owner. Switch back to the
owner's profile to use it."* Five wrong PINs in a row stop that profile accepting any for five minutes.

Out of the box, going back to your profile needs no PIN, so this keeps somebody out of your things
by default — no accident, no child exploring Settings — but it does not stop anybody at the keyboard
who decides to press "switch back". If you want it to, set **a PIN for switching back to you** under
**Settings → People** (off until you set one). Then switching back asks for your PIN, with the same
five-tries rule, and the window stays on their profile if Branch is closed and reopened: a real lock
against somebody at the keyboard. It is still not a lock against somebody who can open Branch's data
folder on this computer.

**Be honest about what this is:** separation on one computer, not separate accounts. There is no
syncing, and the assistant still works as the owner — it uses the owner's models and tools. Anyone who
can open the files on this machine can still read everything. The PIN keeps profiles apart; it does
not lock the data away. Profiles are deliberately left out of a backup, because a PIN belongs to this
computer.

## Using your screen and keyboard

**Settings → Using your screen and keyboard** is **off out of the box**, and while it is off every one
of these tools answers with one plain sentence instead of trying. Turned on, Branch can photograph a
window, list what is in it by name, press its buttons, type into its boxes, press a key, start a
program and use the clipboard. None of those counts as merely looking, so under *Ask before changes*
every single one stops and asks first. Photographing your screen is treated as a change on purpose.

While any of it is happening, a small notice sits on top of everything with a **Stop** button.
Pressing Stop cuts off the action in flight and refuses every later one in the same task.

Windows that are never photographed and never typed into: anything that looks like a password manager,
the Windows sign-in and permission prompts, and anything whose title mentions a password, a passkey,
signing in, unlocking or Windows Security. A picture of a whole screen is refused outright while such
a window is showing. The screen tools are never given the locker at all, so there is no path by which
a saved password could be typed.

The honest limits are in [What Branch is not](10-what-branch-is-not.md#using-your-screen-and-keyboard).

## Trust in what comes back

**Skills are scanned** before they can be enabled — for pasted secrets, instructions to send data
somewhere, and attempts to override your rules. A skill that trips the scan is refused, or installed
switched off with the findings shown, depending on which you choose.

**Every successful tool result carries a signed receipt**, so a result that was edited or invented
afterwards is caught. The receipts for this conversation appear in the pane on the right, in plain
language.

**Web pages arrive marked as untrusted**, with any line that reads like an instruction to the
assistant flagged. You can keep the text with warnings, replace the flagged lines with a notice, or
refuse the page outright. A document is read, never obeyed.

**An unchangeable record** of everything the assistant was allowed to do is kept, and can be saved as
a spreadsheet.

## What Branch will never do

- **Ask you for your password to another service, or see one.** Every sign-in happens on the service's
  own page, in your own browser.
- **Send anything about you to us.** There is no telemetry, no analytics and no crash reporting, and
  there never will be — which is why there is no setting to turn off.
- **Grant a tool that appeared later.** What is granted is what you named.
- **Type a saved secret onto your screen or into a window.** The screen tools are not given the locker.
- **Photograph a password window**, or take a whole-screen picture while one is showing.
- **Guess or break a password on a locked file.**
- **Open itself to the internet or to the network you happen to be on.** See
  [Reach it anywhere](05-reach-it-anywhere.md).
- **Give a stranger more freedom than you have.** A task from a chat app, a schedule or another tool
  is capped at *Ask before changes* once you have chosen a setting.

## Where to go next

- [Reach it anywhere](05-reach-it-anywhere.md) — the same rules, from your phone.
- [What Branch is not](10-what-branch-is-not.md) — what these protections do not cover.
