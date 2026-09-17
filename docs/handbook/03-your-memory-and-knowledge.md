# Your memory and knowledge

## What this is for

What your assistant remembers about you, where it keeps it, how to correct it, how to make it forget,
and how to give it whole folders of your own work to answer from. Also, plainly, what leaves this
computer and what never does.

## In one minute

- **Memory** holds everything it has been told to remember. Nothing there leaves this computer.
- **Something to remember** adds a note by hand; you can edit or delete any of them.
- **Tidy up**, **Repeats, disagreements and facts you never use** and **What it has noticed by
  itself** only ever *suggest*.
- **Documents → Knowledge** turns folders of your work into something it can quote with citations, and
  can summarise one, map the names in it, describe the pictures in it, or tidy it up.
- **Refresh from recent conversations** writes up what was said as fact cards, and tells you what
  reading them would cost before it reads anything.
- Ask once and everything it remembers is also written out as Markdown in a **`memory` folder** you
  can read in any notes app, and kept up to date from then on. Do not edit it: it is rewritten each
  time from what it remembers.
- Only two things ever leave without your asking each time: what you actually ask a model, and — if you
  switch it on — the text of passages sent to be compared by meaning.

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

## What it has noticed by itself

Everything above starts with something you typed. This one does not.

**What it has noticed by itself** looks at the tasks that have already finished and points out three
kinds of thing:

- **A file you keep coming back to.** The same file opened while doing three separate jobs.
- **A name that keeps turning up.** A person, a project or a place named in three separate requests.
- **Something you put it right about.** A message of yours that began "no", "actually" or "I meant".

**Show what it has noticed** changes nothing whatever: it only looks. Each thing it found says, in
plain words, *what it was learned from* — how many jobs, when the last one was, and an example — so
you can see why it is being offered before you decide anything.

**Offer these as suggestions** puts them in the **What it learns** queue, next to everything else
waiting for you. They are still not remembered. Only accepting one saves it.

**Turning one down is the end of it.** If you reject a suggestion, that same thing is never offered
again, however many more times it happens. You do not have to keep saying no to it.

It never sends anything anywhere to do this. The whole of it is worked out on this computer from the
record of your own finished jobs, and only the *names* of files are looked at — never what is in
them.

## Refresh from recent conversations

Useful things get said in passing and then scroll away. **Refresh from recent conversations**, on
the Memory screen, reads your recent conversations again and writes up what is worth keeping as fact
cards for one of your knowledge bases. Once a card is accepted, it is searched and quoted like any
other passage, so something said in March can be answered in October — and the answer says
which knowledge base it came from.

Reading conversations does mean sending them to your model service, so you are told what that would
be first. **Show what this would cost** says how many conversations, how many turns, and roughly how
much text would be sent. Nothing is sent until you press the second button, and even then nothing
reaches your knowledge base: every card is a suggestion you accept or turn down.

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
base until you accept it. [Refresh from recent conversations](#refresh-from-recent-conversations)
does the same for the last few at once, and tells you what it would cost first.

When an accepted card is later used to answer something, the answer names the knowledge base it came
from as well as the card, so you can always tell a thing you told it from a thing it worked out.

### Asking only part of it

Sometimes the right answer is in a small corner of a large collection, and everything else in there
only gets in the way. Under the search box are two choices: **Only this kind of file** and **Only
files changed since**. Pick a kind, a date, or both, and the search happens only among the files that
fit. Two choices together narrow it further, not wider — a spreadsheet changed this year has to be
both.

If nothing at all fits what you picked, Branch tells you so in a sentence and stops there. It does
**not** quietly go and look everywhere else instead. That matters: an answer drawn from last year's
files when you asked about this year's is worse than no answer, because you would have no way of
knowing.

### Looking in a different order

Branch looks in several places for a passage: your documents, the things it remembers, your knowledge
bases, the map of names, and any text you pasted in for this one job. Normally it asks all of them at
once and puts the best answers first, and you never have to think about it.

If you want a particular collection searched in a particular order — the pasted text first, say, and
only two things from anywhere else — you can write that order down and give it a name. Each knowledge
base's card then has a **Look things up** box where you pick the named order to use for it. Leave it
on **the usual way** and nothing changes at all.

### Where the lists of numbers are kept

Matching by what you meant, rather than by the words you typed, works by keeping a long list of
numbers for every passage. Normally those live in the same place as everything else Branch keeps, and
you never need to think about them.

If you have a very large library they can grow bigger than everything else put together. **Where your
vectors are kept**, at the bottom of the Knowledge card, lets you put them in a file of your own
instead, on any drive — useful when the main drive is small, or when you would rather they were not
in your everyday backup.

Two things are safe about this. Changing it deletes nothing: what you already had stays where it was,
and the new place fills up the next time you press **Read it again**. And if the file cannot be
opened — the drive is unplugged, the folder is one you may not write to — Branch says so on the card
in one sentence and simply carries on using its own database. It will not sit there broken, and it
will not fail a search without telling you.

### What a whole collection says

**Summarise** reads a collection right through and gives you a few lines about what is in it, with a
numbered source under each one, so you can check any sentence against the file it came from. It is
kept until one of the files changes, so asking again costs nothing.

Without a model service connected you still get a summary — made from the headings and opening lines
rather than written — and it says so at the top, so you are never left guessing why it reads the way
it does.

### Pictures in a collection

A photograph or a screenshot has nothing in it to search until somebody says what it shows. If your
model service can look at pictures, **Describe pictures** has each one described once, in words, and
files the description with a link back to the picture. A photograph of a meter or a screenshot of an
error message then comes back from a search like anything else.

You are shown what it will cost before it starts, and each picture is described only once: the same
picture, even under another name, is recognised by its contents and costs nothing the second time. If
nothing you have connected can look at pictures, Branch says so plainly and sends nothing.

### The map of names

**Map** picks out the names a collection mentions — people, places, companies, products — and which
of them are mentioned together. Clicking a name shows its neighbours and the passages that link them.

Be careful how much you read into it. It is a *mentioned-with* map, not a statement of fact: two names
appearing in the same passage may be partners, rivals or a coincidence, and the map cannot tell which.
It is for finding your way to the right passages, and the passages are the evidence.

### Tidying up

A collection can be renamed, **merged** with another, or **split** so one folder becomes a collection
of its own. You can **save one out** as a plain folder of Markdown with a small file of details beside
it, keep that as a backup or move it to another computer, and **bring it back** later. The Memory
screen shows what each collection holds and what reading it has cost so far.

You can also set how long a collection may keep files and how large it may get. **Nothing is ever
removed by a limit.** A collection over one becomes a suggestion that says to save it out first. A
collection built over months should never quietly shrink because a number was crossed while nobody
was looking.

## Your notes, as files you can read

Everything Branch remembers can also be written into a **`memory` folder in your workspace** as
ordinary Markdown — one note per kind of fact, with a short README saying what the folder is. The real
store is still the database; this is a window onto it, so what Branch knows is readable in any editor
and by any notes app pointed at the same folder, Obsidian included.

Ask for it once, from the **Memory** screen, and the folder appears. After that Branch keeps it up to
date on its own, each time a task finishes. Until you ask, the folder is not created at all — nobody's
workspace should grow a folder they never asked for. Delete the folder and it stays deleted until you
ask again.

If one of your knowledge bases covers your whole workspace, it leaves this folder out. Otherwise
Branch would end up quoting its own notes back to you as though they were something you had written.

**Do not edit them.** They are written from scratch each time, so anything you type in would be gone
the next time they are written. Branch will not edit them either — if it tries, its own file tools
refuse and tell it to change the fact instead. To change what is in a note, change the fact on the
**Memory** screen and the note follows.

If you also use the **notes-folder bridge** — the separate setting that syncs tagged notes into an
Obsidian vault you name — give it a folder of its own rather than pointing it at this one. Two things
writing the same folder will not end well: the bridge does not know about the rule above, so a note it
syncs into the `memory` folder would be wiped the next time Branch writes these notes.

## Text for one job only

Sometimes you want to paste in three pages of a contract, ask four questions about it, and be done.
Putting that in a knowledge base would leave it there for good; leaving it in the conversation would
fill the space in front of every later turn with text that stopped mattering an hour ago.

So Branch can **hold text for one job**: it is cut into passages and searchable while that job runs,
and dropped the moment the job ends. It is never written to the database and never sent anywhere to be
compared by meaning. There is nothing to clean up afterwards, because there is nothing left.

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
PDF sends those pages to your service. So does a live spoken conversation. **Describe pictures** sends
the pictures themselves, which is why it shows the cost and waits for you. **Summarise** sends the
passages it is summarising, and **Map**, where you let a model do the picking out, sends passages too —
each of them a button you press, never something that happens on its own.

Writing your notes into the `memory` folder sends nothing anywhere: it is a file written on this
computer from a database on this computer. The same goes for text held for one job, which is searched
here by plain word matching.

## Where to go next

- [Permissions and safety](04-permissions-and-safety.md) — the locker, and what Branch will never do.
- [Everyday tasks](02-everyday-tasks.md#documents) — adding a single document.
