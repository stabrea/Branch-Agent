# Glossary

## What this is for

One name per idea, so the same thing is called the same thing on every screen, in this handbook and in
the reference. If a word in the app is unfamiliar, it is here. The column on the right is the jargon
you may meet elsewhere — it should never reach you inside Branch.

## In one minute

- A **task** is one thing the assistant did. A **conversation** is a series of them.
- A **connection** is a model service this workspace can reach.
- A **toolbox** is a labelled group of tools. Branch opens the ones a task needs.
- A **note** is one thing Branch remembers. **Memory** holds notes.
- **Words of context** is the room a conversation has left.

## The words Branch uses

| Say | Never say | What it means |
| --- | --- | --- |
| **task** | run, job, execution | One thing the assistant did, from your request to its answer. **Activity** lists tasks. |
| **conversation** | session, thread | A series of tasks that share a history. Each chat, and each screen tab, keeps its own. |
| **connection** | provider, endpoint, base address | A model service this workspace can reach: a company's service, or a program on this computer. |
| **toolbox** | tool group, prefix, namespace | A labelled group of tools — files, git, web, memory, documents, schedules, media, messages and more. |
| **skill** | *the file name*, skill document | A page of written instructions the assistant can follow. Its file is *a skill file*. |
| **note** / **what it remembers** | memory record, fact row | One thing Branch has been told to remember. **Memory** holds notes. |
| **words of context** | tokens | The room a conversation has left before older turns are folded away. |
| **what is sent** | payload, request body | The thing that actually goes to a model service. |
| **live updates** | server-sent events, streaming | Things arriving as they happen rather than all at the end. |
| **signing in on their site** | OAuth, device flow | Signing in on a service's own page, so Branch never sees your password. |

## The rest of the vocabulary

**Approval rule.** A sentence saying that, for one tool and one thing it would touch, the assistant
goes ahead, checks with you, or is not allowed. See
[Permissions and safety](04-permissions-and-safety.md#rules).

**Benchmark.** Somebody else's published set of tasks, used so a number here can be put beside a number
in a paper. Branch never downloads one.

**Branch (from a message).** A separate conversation made through an earlier message, carrying on
independently. Files and notes stay shared.

**Channel.** A chat service your assistant is connected to — Telegram, Slack, email and the rest.

**Compacting.** Folding a long conversation's older turns into a short summary so it can keep going.
The full history stays saved and searchable.

**Context pane.** The pane on the right: the model, what we are doing, what is running now, what is
allowed right now, receipts, recently saved memory and three counts.

**Delivery ledger.** The list of messages waiting to go out through a chat app that is unreachable.
They go out in order, and never twice.

**Document.** A file you have given Branch so it can quote from it. **Documents** holds them.

**Flow.** A saved list of steps shown as boxes and arrows.

**Gate.** The bar a test run has to clear, so a release script can stop when it is not cleared.

**Knowledge base.** A named collection of whole folders of your work, read once and searchable by
words and by meaning, with every answer citing file, heading and page.

**Lockdown.** One switch that makes every tool wait for your yes and turns off everything that reaches
past the app. Turning it off puts back exactly the settings you had.

**Locker.** Where secrets live. A value goes in and never comes out again in readable form.

**Look inside.** The full record of one task: every model round, every tool call, the plan, the
reviewer's verdicts and anything you said mid-task.

**Owner.** You — the person this workspace belongs to. Other people who share the computer get a
**profile**, which is separation on one computer, not a separate account.

**Practice run.** A task that runs for real but stops every tool that would change something, so each
one reports what it *would* have done.

**Procedure** (also **recipe**). A saved set of steps the assistant can repeat exactly, with the answer
you expect written beside it.

**Profile** (routing). A name and an order of connections saying which connection answers which kind of
work — *Cheap and fast*, *Best quality*, *Private*, *Long context*.

**Project.** A named workspace with its own instructions, preferred model and secrets. Switching the
active project changes all three.

**Receipt.** The signature on a successful tool result, so a result that was edited or invented
afterwards is caught.

**Schedule.** Something your assistant starts on its own: once, every so often, or at the same time
each day.

**Secret.** A key or a password kept in the locker. You can name one without saying it, by writing
`secret://project/NAME` wherever a key is wanted.

**Set aside.** Where a note or a skill goes when it is taken out of use. It is not deletion: everything
stays in the set-aside list with its reason, and **Bring back** returns it.

**Snapshot** (workspace). A whole-workspace point you can put back exactly. A **checkpoint** is the
same idea for just the files one conversation changed.

**Specialist.** An assistant that does one job and is allowed to touch only what that job needs.

**Steering.** Telling a task something while it is still working, so it takes that into account without
starting over.

**Suite.** A handful of your own tasks with the right answers written down, so you can tell whether a
change made the assistant better or worse at the work you actually do.

**Study.** A written-down experiment: a benchmark or suite, which tasks, which models, how many
repeats, and what it may cost.

**Temporary conversation.** One that never enters search, the library or memory, and is discarded when
you move on.

**Trace.** The shape of what a task did, written as one file you can open in a tracing viewer. Off
unless you turn it on, and never sent anywhere.

**Trajectory.** A task's complete step-by-step record, saved as one file.

**Watch.** A page or a search Branch looks at every so often, telling you what changed.

**Workspace.** The folder the assistant's file tools can see. Your private state lives outside it.

## Where to go next

- [Start here](00-start-here.md) — if a word here sent you back to the beginning.
- The reference: [docs/configuration.md](../configuration.md) for every setting by name.
