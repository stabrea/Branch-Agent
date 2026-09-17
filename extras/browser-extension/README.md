# Send to Branch — a browser extension for your own browser

A small, unsigned Manifest V3 extension that sends the page you are looking at — and anything you
have selected on it — to your own Branch Agent as a task.

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
what you want, and press **Send it**. The address is remembered in the extension's own storage; the
key is not, so you type it each session.

## Talking to Branch in the side panel

Open Chrome's side panel (the side panel button in the toolbar) and choose **Send to Branch**. Fill in
the same paired address and key under **Your paired Branch**, then write to Branch as you would in
the app: each answer appears under your message, and the next message carries on the same
conversation until you press **New conversation**. Tick **About this page** to send the page's address,
title and whatever you selected with your message; Chrome only lets the panel read a page after you
have pressed the extension's toolbar button on it once. If Branch stops to ask for a yes, answer it in
the Branch app.

## Taking it away

`chrome://extensions` → **Remove**. Then switch the setting back off in Branch.
