# Your memory and knowledge

## What this is for

What your assistant remembers about you, where it keeps it, how to correct it, how to make it forget,
and how to give it whole folders of your own work to answer from. Also, plainly, what leaves this
computer and what never does.

## In one minute

- **Memory** holds everything it has been told to remember. Nothing there leaves this computer.
- **Something to remember** adds a note by hand; you can edit or delete any of them.
- **Tidy up** and **Repeats, disagreements and facts you never use** only ever *suggest*.
- **Documents → Knowledge** turns folders of your work into something it can quote with citations.
- Only two things ever leave: what you actually ask a model, and — if you switch it on — the text of
  passages sent to be compared by meaning.

## What it remembers

**Memory** lists everything your assistant has been told to remember, and everything you have already
talked about. Every note can be edited, corrected or deleted, and every edit keeps an exact earlier
version you can put back.

Each note says two things about itself:

- **What kind of thing it is** — a preference (how you like things done), a fact about a person, a
  fact about the world, a hint about how to do something, a project note, or a scribble the assistant
  made for itself while doing one job.
- **How long it is meant to last** — this conversation, this task, or long term. A scribble made
  during a job is cleared when the job ends unless you keep it.

Facts can also change over time. A newer fact about the same thing ends the older one at the moment
it became true, so the assistant can answer *what was true when* rather than only *what is true now*.

**How much it keeps** sets a ceiling of 1 to 500 notes, 500 by default.

## Saving, correcting and forgetting

**Something to remember** adds a note yourself. The assistant can also save notes on its own while it
works, and each conversation has its own switch for whether it may.

**What it learns** is a queue. After a task finishes, a separate bounded request may suggest notes or
skill notes; suggestions wait for you and nothing is written until you accept. You can also require
that *every* note the assistant makes becomes a suggestion rather than a write.

**Forget what this conversation saved to memory**, on any conversation, previews the notes that
conversation's tasks saved on their own — separately listing the ones you edited afterwards, which are
kept — removes them in one step, and stops that conversation from saving on its own again. You can
still save notes yourself from **Memory**.

**Tidy up** archives or purges notes not touched within a period you choose, and shows you what it
would do first.

## Repeats, disagreements and facts you never use

**Look for problems** reads your saved notes and changes nothing. It reports three things: the same
thing saved more than once, a newer note that disagrees with an older one about the same subject,
and — only when memory is nearly full — the notes that have been least useful.

**Turn them into suggestions** puts what it found into the **What it learns** queue. Nothing is
applied until you accept it. Accepting a repeat keeps the fullest wording and **sets the others
aside**; accepting a disagreement sets the older one aside with a note naming the newer; accepting a
rarely-used note sets that one aside.

**Set aside is not deletion.** Everything stays in the set-aside list with its reason, and **Bring
back** returns it.

How useful a note is combines three things: how recently it changed, how often the assistant has drawn
on it, and whether you stood behind it — you saved or corrected it yourself rather than a task saving
it. That same order decides which notes search returns first.

## Finding an earlier conversation

**Find an earlier conversation** searches everything you and the assistant have said, matching without
regard to capitals or accents. Results show an excerpt and when that conversation started, and
**Read message** opens the source. Tool results, system instructions and anybody else's conversations
are left out.

From any historical message you can **Branch from here**, which makes a separate conversation through
that message. The branch copies the conversation only — workspace files and saved notes stay shared —
and both conversations carry on independently.

**Saved conversations** lists your histories. Open resumes one, Duplicate makes a separate copy, and
you can save a conversation as a file and bring it back later, or save one as Markdown to read
anywhere.

## Knowledge bases

**Documents → Knowledge** gives a name to whole folders of your work and has them read once, cut into
passages that keep their headings, sheets, slides and pages.

A question then searches both ways at once — by the words you used and by what you meant — and every
answer says which file, heading and page it came from, as a numbered source.

Reading a folder again compares each file by its contents and leaves alone the ones that have not
changed, so a second reading of a large folder is quick. Every file that could not be read is kept
against the collection with the reason, never quietly skipped. Files that look like secrets are never
read in.

You can also ask it to turn a finished conversation into **fact cards** — a title, a few sentences,
which turn it came from, and how sure it is. Every card is a suggestion; nothing reaches a knowledge
base until you accept it.

## What leaves this computer

This is the honest list.

**Never leaves.** Your saved notes as a set. Your conversations. Your files. The contents of your
documents, except as described below. The figures on the **Usage** screen, which are worked out here
from your own tasks. There is no telemetry client, no analytics, no crash reporting and no opt-out to
configure, because nothing is collected in the first place.

**Leaves, because you asked it to.** Whatever you actually send to your model service: your message,
the relevant notes, the relevant document passages, and the tool results the task produced. That is
what a model service is.

**Leaves only if you switch it on.** *Comparing by meaning* sends the text of passages — and, if you
switch that on for memory, the text of your notes — to your model service's comparison route so they
can be ranked by meaning. Only the text is sent. Turning it off keeps everything here, and word search
still works. A model on this computer does this here too, using its own comparison route.

**Leaves only when you ask, each time.** Asking a model that can look at pictures to read a scanned
PDF sends those pages to your service. So does a live spoken conversation.

## Where to go next

- [Permissions and safety](04-permissions-and-safety.md) — the locker, and what Branch will never do.
- [Everyday tasks](02-everyday-tasks.md#documents) — adding a single document.
