# Everyday tasks

## What this is for

The ordinary work: asking for something, handing over a file, getting a document read, showing it a
picture, speaking instead of typing, and watching a long job while it runs. This is the chapter you
will come back to.

## In one minute

- Type in the box at the bottom and press Enter. **Shift+Enter** adds a line.
- Attach a document, press the microphone to speak, or hold **Talk** and let go.
- **Look inside** on any answer shows every step it took and what each one cost.
- While it works you can **Ask it to wait**, **Tell it something**, or **Stop**.
- **Temporary** means the conversation leaves no trace at all.

## Asking for things

Write what you want in plain words. Branch works out which of its tools the job needs and uses them,
one step at a time, telling you what it did. Tool work appears as one quiet row — *"Worked with 2
tools · files list, files read"* — that opens in place when you press it.

Four suggestion chips sit under the greeting on a new conversation. They use your own saved recipes
when you have some, and stock prompts otherwise.

**Answers are rendered properly**: headings, lists, tables, links that open outside the app, and code
blocks with a copy button and the language written out. Nothing in an answer can become anything but
text on the page.

**Room in the conversation.** A quiet meter under the message box shows how much of the conversation's
room has been used and roughly what it has cost so far. When a conversation grows long, Branch folds
the older turns into a short summary — what we are doing, what was decided, what is still open, which
files were touched — keeps the recent turns as they are, and carries on. The complete history stays
saved and searchable. Any message you **pin** stays in front of the assistant however long the
conversation runs.

**Temporary** beside the message box, ticked before the first message, means the conversation never
enters search, the library or memory, and is discarded when you move on.

## Watching a task, and steering it

While something is working, a live row shows the current step and how long it has been going, with
three buttons: **Ask it to wait**, **Tell it something** and **Stop**. Telling it something puts your
note in front of its next step — *"Change of plan: use the 2024 figures"* — without starting over.

**Look inside** on any task opens the whole record: every time it asked the model and what that cost,
every tool call with what went in and what came back, its proof, the plan it worked through, what the
reviewer said, and anything you told it mid-task. **Save this as a file** keeps the lot as one file.

If it needs an answer from you it stops and asks. A banner and a notification take you straight to
that conversation, and your next message there is the answer.

**Activity** lists every task, newest first, with **Compare** to put two of them side by side and a
**Happening now** feed of what is going on this moment.

## Files

The assistant works inside a folder called your **workspace**. It can list files, read them, search
inside them, find one from part of its name, write them and change them exactly.

Every change keeps the bytes that were there before. **Activity** shows each change with **Show
change** and **Undo this change**, and a change that touched three files is undone three times, once
per file. **Settings → Workspace snapshots** keeps whole-workspace points you can put back exactly.

Put a file called `.branchignore` in your workspace to name things the assistant should skip; your
`.gitignore` is used when there is no `.branchignore`. Some things are always skipped: `node_modules`,
`.git`, `dist`, `release`, and anything whose name looks like a secret.

There is also a **practice workspace** of made-up files, one click each way from your real folder, so
you can try things without risking anything.

## Documents

**Documents** holds the files you want the assistant to be able to quote. Add one by typing where it
sits in your workspace, by choosing files, or by dragging them onto the panel — up to 20 MB each.

Branch reads all of these on this computer, with nothing extra installed: notes, Markdown, web pages,
tables, JSON, Word (`.docx`), spreadsheets (`.xlsx`), slide decks (`.pptx`), OpenDocument text and
spreadsheets (`.odt`, `.ods`), e-books (`.epub`), rich text (`.rtf`) and PDFs. Headings, sheets,
slides and pages are kept, so a quotation can say exactly where it came from.

**What cannot be read, plainly:** a PDF locked with a password (open it and save an unlocked copy
first); a PDF that is pictures of text, which has no words to lift out — it says so, and you can ask
for it to be read with a model that can look at pictures instead; the older `.doc`, `.xls` and `.ppt`
formats, and OpenDocument presentations (`.odp`). Anything with no reader is listed with the reason,
never quietly skipped.

**Answering from your documents** puts the three best passages in front of each task, each labelled
with the document it came from. It is on while your library has something in it, and you can switch
it off. **Search your documents** shows the exact passages that match, with the matching words
highlighted. **Ask about one file** answers a question about a single document and names the heading
and page each claim came from, and there is a box for comparing two versions of a file.

## Tables of figures

Ask it to open a table — from a file in your workspace, a public address, or pasted text — and it
shows you the column names, what kind of thing each column holds, how many rows there are and a
five-row preview. Never the whole file, so a big spreadsheet cannot swamp the conversation. From
there it can describe each column in plain numbers, answer questions with read-only SQL, draw the
table as bars, a line or a pie, and save it back into your workspace as a spreadsheet or a CSV.

## Pictures and sound

Show the assistant a picture by dropping it into the message box, and a model that can look at one
will describe it, read the words in it or write out a table it holds. A model that cannot say so
plainly rather than guessing. **Settings → Pictures and sound** says which connection makes pictures
and which handles sound.

Ask for a picture and you get one back, or hand it one of yours to change. It can write out what is
said in a recording with the times, and report what a video file contains.

## Speaking instead of typing

Three ways, in order of how much they ask of you:

**The microphone** beside the message box records a message and writes it out as text.

**Talk** is hold-to-talk: hold it, speak, let go. What you said is written out, put in the box so you
can see it, sent as an ordinary message, and the answer is read back to you. Press **Talk** again
while it is talking to stop it.

**Talk live** is a real conversation. Press it once and simply talk: your voice goes up as you speak,
the answer comes back as it is said, and pressing again cuts it off the way you would interrupt a
person. You can type while it is talking. Both sides land in the conversation as ordinary messages.

**What leaves this computer.** Three services can write out what you say — your own model service,
Gemini, or a speech program you have already installed here (whisper.cpp or faster-whisper). Three
can read replies aloud — your model service, Gemini, or **the voices that come with Windows**, which
need no key, no account and no internet. One switch, **Keep audio on this computer**, refuses every
cloud route outright, including from inside the tools, and including a live conversation.

**What is only partly there:** a live conversation needs a connection that offers one, and only
OpenAI and Gemini do today. On anything else the **Talk live** button does not appear at all and the
Voice screen says so. Branch has been tested against stand-ins speaking both services' documented
shapes, not against the real services with real sound. A live conversation is charged by the minute
and is more expensive than typing, so two limits in **Settings → Voice** stop it running away: how
many minutes one conversation may last (10 by default) and how much it may cost ($1.00 by default).
When either is reached it says one sentence out loud and stops, rather than going silent.

**The sound of a live conversation is not kept anywhere** — not in the database, not in a file, and
there is no setting that changes that.

There is no wake word. Nothing listens until you press the button.

## Where to go next

- [Your memory and knowledge](03-your-memory-and-knowledge.md) — so it remembers this next time.
- [Permissions and safety](04-permissions-and-safety.md) — deciding what it may do without asking.
- [Automate](06-automate.md) — having it do this on its own.
