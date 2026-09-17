# Send to Branch — a browser extension for your own browser

A small, unsigned Manifest V3 extension that sends the page you are looking at — and anything you
have selected on it — to your own Branch Agent as a task. It also adds four right-click entries that
leave Branch a note about one thing on a page (see "Pointing at one thing" below).

It is not in any store and it is not signed. It is meant to be loaded by hand, into your own
browser, pointing at your own Branch. Nothing here should be published anywhere.

## Before you start

1. In Branch, open **Settings → Reaching Branch from other pages** and switch **the browser
   extension** on. It is off until you do.
2. Switch on **reaching Branch from your phone** (Settings) and pair once. Pairing gives you an
   address and a key.
3. That address and that key are what this extension uses. It refuses your computer's own address
   (`localhost`, `127.0.0.1`) on purpose: the key the app's own page uses on your computer is the
   whole of Branch's authority there, and an extension must not be able to borrow it.

## Loading it

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Press **Load unpacked** and choose this folder.
4. Pin **Send to Branch** to the toolbar.

## Using it

Open a page, press the extension, paste the paired address and key the first time, add a line about
what you want, and press **Send it**. The address is remembered in the extension's own storage. The
key is kept only in the browser's memory (`chrome.storage.session`): it is never written to disk,
pages cannot read it, and closing the browser forgets it, so you type it again each browser session.

## Pointing at one thing

First switch on page notes in Branch (it is off until you do; see "Pointing at a thing on a page"
in `docs/configuration.md`), and press **Send it** once in this browser session so the extension knows your paired
address and key.

Then right-click anything on a page and choose one of:

- **Branch: look at this** (inspect)
- **Branch: change this** (asks what to change)
- **Branch: lift this out** (asks what to do with it; you may leave it empty)
- **Branch: comment on this** (asks for your comment)

The extension sends Branch a cleaned copy of that one thing: its tag, the words on it, a short path
to find it again, a few of its styles, the boxes it sits inside, and its HTML with scripts, styles,
templates and text box contents taken out and every `value` attribute removed. It never asks a
field what it holds, so a password you typed is never read. The page address is sent without any
sign-in name, password or `#` part, and Branch removes anything in it that looks like a key before
keeping it. The note waits in Branch's list of page notes, where the assistant can read it with the
`browser.notes` tool. A small mark on the extension's button says whether it arrived; point at the
button to read why when it did not.

Pressing Cancel in the question sends nothing. The menu refuses your computer's own address just as
the popup does.

## What it is allowed to do, and why

| Permission | Why |
| --- | --- |
| `activeTab` | Read the address, title and selection of the tab you are on, only when you press the extension. |
| `scripting` | Run that one small read in the tab you pressed the extension on. |
| `storage` | Remember your paired address (on disk) and, for this browser session only, the key (in memory). |
| `contextMenus` | Add the four "Branch:" entries to the right-click menu. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | Asked for one address at a time — your paired Branch — the first time you send. Nothing is granted up front. |
| `content_scripts` on `http://*/*` and `https://*/*` | `content.js` has to be on the page already to know what you right-clicked. It only remembers that element, and reads a cleaned copy of it only when you pick a "Branch:" entry. Chrome lists this as being able to read pages you visit; it sends nothing on its own. |
| `background.service_worker` | `background.js` answers the right-click entries and sends the note to your paired Branch. |

## Taking it away

`chrome://extensions` → **Remove**. Then switch the setting back off in Branch.
