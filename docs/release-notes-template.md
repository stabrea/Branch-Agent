# Release notes: the shape to write them in

This is the structure the 0.11 to 0.15 notes used, written down so the next ones read the same way.
`node scripts/release-notes.mjs` drafts a first version from the checkpoint entries added since the
last tag. **The draft is a starting point, never the finished prose** — it can tell you what changed,
but not which of it matters to the person reading.

## The rules

1. **Write for the owner, not for the project.** The reader is a person who uses Branch, not somebody
   who worked on it. Never say "wave", "batch", or an audit id.
2. **One bold lead per theme, then two to five sentences.** The bold phrase is what a person would
   call the thing — *"Talk to it."*, *"Memory that stays tidy."*, *"Models that run on this
   computer."* — not a component name.
3. **Four to eight themes.** More than that and nothing stands out. Group small things under
   **Also.**
4. **Say what is now possible, not what was implemented.** "Point the assistant at folders and it
   builds a searchable knowledge base" — not "added knowledge base indexing".
5. **Be honest inside the note itself.** If something works only on two connections, or is off by
   default, or has been tested against a stand-in rather than the real service, say so in the same
   sentence. A note that oversells is a support ticket later.
6. **A short Fixed section**, in plain words, for things that used to go wrong.
7. **The same Install block every time**, so the reader never has to look for it.
8. No emoji, no exclamation marks, no version numbers in the middle of sentences.

## The template

```markdown
## What changed in X.Y.Z

**<What a person would call it>.** Two to five sentences saying what is now possible, in the words the
screens use. Where it is limited, off by default, or proved against a stand-in rather than a live
service, say that here rather than leaving it to be discovered.

**<The next theme>.** As above.

**<Up to about eight in all.>**

**Also.** The smaller things, one clause each, separated by semicolons.

**Fixed.** What used to go wrong, in plain words; one clause each.

**Install**
Download `Branch-Agent-windows-x64.zip`, `Branch-Agent-windows-x64.zip.sha256` and
`Install Branch Agent.cmd` into the same folder, then run the installer. It verifies the checksum
before unpacking. From 0.7.3 onward the in-app update is silent.
```

## A worked example

From 0.13.0, which is a good one to copy the voice of:

> **Talk to it.** Hold the Talk button, speak, and hear the answer read back. Voice notes sent on
> Telegram, Discord or WhatsApp become messages with the transcript quoted. Reading aloud works
> offline with the Windows voices; "keep audio on this computer" refuses cloud speech everywhere.

Three sentences: what you do, where else it works, and the limit — in that order.

## Drafting one

```sh
npm run build
node scripts/release-notes.mjs                 # since the newest tag, to the screen
node scripts/release-notes.mjs --since v0.14.0 # from a tag you name
node scripts/release-notes.mjs --out notes.md  # into a file to edit
```

It reads the sections added to [CHECKPOINT.md](CHECKPOINT.md) since that tag — by comparing the file,
not by trusting the order of its headings, which is not chronological — turns each one into a themed
paragraph with its opening sentences, strips wave, batch and audit markers, and appends the Install
block. Then rewrite every paragraph by hand. The draft's job is to make sure nothing is forgotten.
