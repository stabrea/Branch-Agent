# Branch Agent for Obsidian

A small Obsidian plugin that asks your own Branch Agent about the note you are writing and puts the
answer in the note. It is not in Obsidian's community list; you copy it into your vault by hand.

Branch's own notes bridge (Settings → notes folder) is a different thing: it writes and reads
Markdown files in your vault without Obsidian running. This plugin is for asking from inside Obsidian.

## Installing

1. Copy this folder into your vault as `.obsidian/plugins/branch-agent/` (the three files
   `manifest.json`, `main.js` and this README).
2. In Obsidian, open **Settings → Community plugins**, turn off Restricted mode if it is on, and
   switch on **Branch Agent**.
3. In a terminal, run `branch token create --scope run --minutes 43200 --name obsidian` and copy the key
   it prints. A key lasts at most thirty days; make a new one when Obsidian says it has run out.
4. In **Settings → Branch Agent**, set the address (`http://127.0.0.1:3210` on the same computer,
   or your paired address from another device) and paste the key.

The key can start and read tasks and nothing else. Never paste the key the Branch window itself
uses.

## Using it

- **Ask Branch about this note** (command palette): type a question; the note goes with it as
  material to read, and the answer is put under the cursor as a quote block marked *Branch*. A
  second question about the same note carries on the same conversation.
- **Send the selection to Branch**: the selected text goes to Branch as a task and the answer is
  put under the selection.

If Branch stops to ask for a yes, answer it in the Branch app; the note says so.

## Taking it away

Switch the plugin off in Obsidian and delete the folder. Revoke the key with
`branch token revoke <id>`.
