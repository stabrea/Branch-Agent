# Troubleshooting

## What this is for

What to press when something is not working, how to update safely and get the previous version back,
what to send to somebody who is helping you, and a list of the messages Branch shows and what each
one actually means.

## In one minute

- **Settings → Health check** checks everything Branch needs and tells you the fix for each.
- `branch doctor --fix` does the same from a terminal and repairs what it can.
- **Settings → Diagnostics → Save a diagnostics folder** is what to send with a bug report.
- **Settings → Updates** takes a safety copy of your work before it installs anything.
- The version that was there before is kept next to the new one.

## The health check

**Settings → Health check** reports each thing Branch depends on with a plain fix beside it. Run it
first: most problems are one missing piece and it will tell you which.

From a terminal, `branch doctor` does the same and `branch doctor --fix` repairs what it can.
`branch doctor --probe` also asks each of your model connections what it can do right now, which
costs nothing beyond one small request per connection.

## The diagnostics folder

**Settings → Diagnostics → Save a diagnostics folder** writes a dated folder of plain files — no
archive — so you can read it yourself before passing it on:

| File | What is in it |
| --- | --- |
| `health.json` | The same checks the Health check button runs |
| `versions.json` | The Branch, Node.js and operating system versions |
| `events.json` | The last 200 events across your tasks, reduced to names, counts, outcomes and timings |
| `pricing.json` | The price table in use, including your corrections |
| `README.txt` | What is in the folder and what is deliberately left out |

Events are filtered by a list of fields that are allowed through, so anything nobody anticipated is
dropped rather than trimmed. **Tool arguments, tool results, file contents, differences between file
versions, your messages and the assistant's replies never enter the folder.** What is kept is also
scrubbed for anything shaped like a key or a token.

**Branch sends no usage data to anyone**, so there is nothing to opt out of. This folder goes nowhere
until you send it.

## Updating, and getting the old version back

**Settings → Updates** checks for a newer release and installs it with one click after checking the
published checksum. **A safety copy of your work is taken first, and the last three are kept.**

The installer also keeps the whole previous version of the program beside the new one, in a folder
named `Branch Agent.previous` inside your programs folder. If an update goes wrong, that is where the
version that worked still is.

From a source checkout, `branch update` does the equivalent.

## When something did not happen

**A scheduled task did not run.** Branch has to be running. Turn on **Keep Branch working when the
window is closed** and **Start Branch when I sign in to Windows** in **Settings → How Branch runs on
this computer**. If the computer was asleep, the missed times become one task the next time Branch
looks — not one per missed slot — and nothing that failed is retried by itself.

**A reply never reached a chat.** Look under **Messages still to send** in **Settings → Channels**.
Replies wait in order while a chat app is unreachable and go out when it is back; after repeated
failures a message is parked there with **Try again** beside it.

**A task stopped halfway.** If the app stopped while it was working, the task shows **Continue where
it stopped**. That starts again from the saved transcript: no new prompt, nothing replayed, and any
tool whose outcome was never recorded is shown to the model as unknown so it checks before repeating
it.

**A task is waiting and you did not notice.** Look under **Settings → Waiting for your yes**. A task
started by a schedule, a trigger or another tool waits there until you answer, because nobody is
sitting there to answer for it.

**Only one copy at a time.** Run only one Branch Agent per data folder. If a second one cannot start,
the first is probably still running — in the tray, or in the background.

## What the messages mean

| What you see | What it means, and what to do |
| --- | --- |
| **Connect to begin** | No model is connected. See [Connect a model](01-connect-a-model.md). |
| **no price on file** | Branch has no published price for that model, so it refuses to invent one. Add yours under **Usage → Model prices**. A model on this computer correctly shows zero. |
| **needs attention** (a channel) | That chat connection is not working; the line beside it says why. **Check the connection** re-tests it. A locked app cannot fetch a saved chat token, so unlock first. |
| **reconnecting** (a channel) | The connection dropped and is coming back by itself. Nothing to do. |
| **Set up, not connected yet. It starts the first time a task needs it.** | A server you configured to open on demand. Normal. |
| **Needs a PDF helper** | That particular PDF is pictures of text, so there are no words to lift out. Ask for it to be read with a model that can look at pictures. Ordinary PDFs with real text are read here with nothing installed. |
| **This one needs your say-so first.** | Your approval rules want a yes for that tool. Answer it, or change the rule. |
| **Nothing extra is allowed in this conversation.** | No standing yes is in force here. It will ask before anything your rules cover. |
| **Outside WhatsApp's 24-hour reply window** | WhatsApp only allows a free reply within 24 hours of the person's last message. The reply is parked until they write again. |
| **You are offline.** | The phone or browser cannot reach your computer. The screen you are looking at still works; nothing new can happen until you are back. |
| **The live feed stopped.** | Open **Activity** again to start it. |
| **Comparing models is not switched on in this workspace.** | Two model connections are needed for that. |
| **Windows protected your PC** | Windows warning you the download is unsigned. **More info**, then **Run anyway**. |

## When an answer looks wrong

**Look inside** on the task shows every step: every time it asked the model and what that cost, every
tool call with what went in and what came back, its proof, the plan, and what the reviewer said. That
is almost always where the answer is.

**Activity → Compare** puts two tasks side by side, which is the fastest way to see what changed
between a run that worked and one that did not.

If a tool result looks like it was edited or invented, the receipts for the conversation — in the pane
on the right, and in full under the task — say so: every successful tool result is signed.

## When you want everything to stop

**Lockdown**, at the top of the rail, refuses commands and everything that reaches past the app
without asking, and makes every other tool wait for your yes. Turning it off puts back exactly the settings you had. See
[Permissions and safety](04-permissions-and-safety.md#lockdown-one-switch).

## Where to go next

- [Permissions and safety](04-permissions-and-safety.md) — most refusals are a rule doing its job.
- [Glossary](09-glossary.md) — if a word here was new.
- [What Branch is not](10-what-branch-is-not.md) — sometimes the answer is that it was never built.
