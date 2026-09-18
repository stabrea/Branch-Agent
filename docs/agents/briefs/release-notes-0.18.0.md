## What changed in 0.18.0

**A word that starts a turn.** You can say a word instead of holding the Talk button. Nothing is
recorded before the word is heard, no sound leaves this computer, and the microphone is let go of the
moment the switch goes off. It ships off, and push-to-talk is still the default. On Windows the
computer's own speech engine does the listening. On a Mac, Branch installs nothing and bundles
nothing: it looks for a recording program you already have (`rec`, `sox` or `ffmpeg`), and a Mac
without one says so plainly, suggests `brew install sox` as something you might do, and leaves the
switch off. macOS itself will ask for the microphone the first time, and that question is yours to
answer.

**A saved sign-in, filled in and never shown.** Branch can fill a sign-in from the password manager
you already use. It never stores a password itself, and the value is never shown, printed, written to
a log, or given to the model. It fills by the website the page is actually on, not by whatever press
got there, so a redirect cannot carry it somewhere else. It ships off.

**Settings you can pin.** Pin any setting and a household person can see it but cannot change it.
Pinning is yours alone: a pinned setting refuses a change from every other way in, and no preset or
imported settings file can unpin one. It ships off.

**Other computers and your phone, as devices.** Pair another computer or a phone and say, per
ability, what it may do — camera, screen, microphone, running something. Each of those is asked about
every time rather than remembered. A device gets a clean environment with none of your keys, its own
safe folders, and a private line. Chat senders are refused at the device door outright. It ships off.

**Spending less on a model, without guessing.** Caching, cheaper routes for the small side questions,
and a clearer picture of what a task costs. A mixture of models is priced at its dearest member
rather than its cheapest, so the figure is never flattering. Local model servers are kept off the
proxy. Every part of it ships off.

**The comforts.** Keyboard shortcuts and vim keys, a status line, how and when Branch may notify you,
voice keys, browser care, a proxy and your own certificates, and controls for the terminal view. Each
one is a switch and each one ships off.

**It learns from what happened, not just from what you type.** Memory in blocks with a count of what
is kept, a timeline, search by meaning, lessons it drew, preferences taken from a chat, an expiry, and
memory read back to you before it is used. It can look over past conversations, write notes that
change a skill, and propose a new skill from experience. Nothing is remembered without you. The
meaning search has only been proved against a stand-in embedder, not a real one. It ships off.

**Flows, boards and the room around them.** A flow can be wound back to an earlier point, a procedure
can be checked before it runs, and there is a shared board, widgets, a waiting line, a focus view and
a way to ask for something to be installed. Only your own work reads the board, the widgets and a
flow's values. It ships off.

**More care around what runs.** Tool scripts, WebAssembly add-ons, one-time codes, an emergency stop,
a check of a command before it runs, a progress check, a record that shows if it has been tampered
with, and a repair for a damaged history. The command check now sees decoders, disguises and hidden
marks rather than only plain text. It ships off.

**Reaching further.** Other computers side by side, long-lived assistants that live on another
machine, using an app in the background, videos, a relay, `branch send` and pause, sharing work
through git, skill bundles, a USB trigger, notes and a place to compare two answers. Lockdown stops
all of it. The Docker, Nix and Termux packaging files exist but have never been built against the real
thing. It ships off.

**A great many more chat apps.** Bluesky, Reddit, Discourse, X direct messages, Twist, Mastodon,
Delta Chat, Keybase, MQTT, Nostr, SimpleX, XMPP, VK, QQ, Guilded, Revolt, Mumble, IRC, Twitch, Gotify,
iMessage, Teams, Webex, Synology Chat, Zalo, Flock, Pumble, Nextcloud Talk, SMS, ntfy, Pushover,
Threema and Home Assistant. One command sets any of them up, with a square code and a paste that is
checked. Branch can see and steer a running task from the chat app, and passes on typing, edits and
buttons only where the service really has them. Every one of them ships off.

**Also.** Several accounts per connection with key rotation; signing in from another device, groups
and sharing; add-ons in four formats, with a wall around a plugin and a malware check; your own
commands and saved prompts on every surface; a one-click model on this computer; Branch on iPhone and
Android; a Go client, React hooks and an app-builder kit; plain-language page tests you can accept and
run; a report that says whether a build got better and what stopped working; diagnosing, fixing and
re-running a failed command; a browser at `/dashboard`; a gateway that keeps Branch's address open and
restarts the engine; quiet background jobs; bringing chats and memory over from another assistant.
All off.

**Fixed.** Shutting the app down could hang for ever if a chat app was asked to stop in the moment
between two connections — ten of them had the same fault (Discord, Guilded, IRC, KOOK, Nostr, QQ,
Revolt, SimpleX, Slack and XMPP); a script that had already stopped left a pipe nobody was reading
and writing to it could bring the app down; a saved sign-in could be filled into a browser recording,
a sub-address, or a refusal the model gets to read, any of which would have written the password out
in clear; autofill judged a page by the press that got there rather than by the website it is on;
registering the tool that fixes a failed command was, by itself, creating the permission to run
commands on every machine it was registered on, and the loop's own fixes are now held against the
permissions of whoever called it; the wake listener could spin, crash, or go silent after the computer
was unlocked, and "when needed" could hold the microphone open; paths built for another system were
written in this system's style, which broke several things on Windows; a run socket whose far end went
quiet was never let go of; a tool call was counted twice, once at its start and once at its end.

**Node 24.14 or newer is now required.** The setting that sends Branch's own calls through a proxy
works by handing the proxy to Node, and Node only grew the way to do that in 24.14.0 — on the Node 25
line, in 25.4.0. On anything older you could set a proxy, see it saved, and have it cover nothing at
all, which on a work network is worse than no setting. So the supported range is now 24.14.0 or newer
on the 24 line, or 25.4.0 or newer on the 25 line. This was measured on real Nodes against a real
proxy, not read off a changelog. On an older Node the command line says so once and carries on:
everything except the proxy still works.

**A task started from a chat app now holds only a short list of permissions.** It used to hold
everything except a handful of named things, which meant anything nobody had thought to name was
handed over — the screen and keyboard, the clipboard, running code, stopping programs, and every
permission added after that list was written. A chat sender could run code on your computer. A chat's
task now holds four things only: asking you something, reading files, reading memory, and reading the
web. Nothing that can change anything, including permissions added later. To grant more, turn on the
switch under Customize → Chat apps and write a line naming the app, the person and what else they may
do. The switch ships off, your own devices and commands on any computer can never be in a line, and
the lines sit deliberately outside the settings catalogue so no preset or imported settings file can
write one. Your own paired chat account is a chat like any other and gets the same short list.

**A chat cannot approve a change unless you switch that on, for that one person.** Since the yes for
anything a line granted belongs in the window, an owner away from their computer could grant their
phone the right to write a file and then have no way to say yes to the write. So each line has its own
approvals tick, shipped off. Ticking it lets that one person, on that one app, answer y in the chat,
and only for what that same line granted. It is per line, not per person, so two lines never lend each
other their yes, and "yes, always" stays out of reach from a chat entirely. The card says plainly what
ticking it means: anyone who gets into that chat account, or who can pass themselves off as it, can
approve those changes, because a chat app cannot prove who is typing.

**Known, and not done.** The wake word cannot listen on a Mac unless you already have a recording
program (`sox` or `ffmpeg`); Branch will not install one for you. The phone app has no pairing screen,
and its notification and clipboard plugins are not wired. Pairing another computer with its key is
still command-line only, with no card. Mem0 and Honcho were tested against fake servers only, the
video services and the Docker, Nix and Termux packaging files have never been run or built against the
real thing, and meaning search has only seen a stand-in embedder. The learning core has never run
against a real model, so there is no head-to-head scoreboard against Hermes yet. The monthly spend
figure misses a video a still-running task is making. The malware check counts a result longer than
ten pages as clean.

**Install**
- **Windows:** download `Branch-Agent-windows-x64.zip`, unzip it, and run `Branch Agent.exe`. From
  0.7.3 onward the in-app update is silent. `Install Branch Agent.cmd` beside it does the whole thing
  without questions.
- **macOS:** download `Branch-Agent-macos-arm64.zip` for an Apple Silicon Mac or
  `Branch-Agent-macos-x64.zip` for an Intel one, unzip it and move `Branch Agent` to Applications.
  This copy is not yet signed by Apple, so the first time macOS will refuse to open it: open System
  Settings → Privacy & Security and choose "Open Anyway".
- **Linux:** download `Branch-Agent-linux-x64.tar.gz`, unpack it, and run `branch-agent` inside the
  folder. Keeping an API key needs a keyring (GNOME Keyring or KWallet); without one, Branch says so
  and asks you to set the model in the launch environment instead of storing the key in plain text.
- **macOS and Linux, without questions:** `sh install-branch-agent.sh`, published beside those two
  downloads.

Branch needs Node.js 24.14.0 or newer (on the Node 25 line, 25.4.0 or newer). Every download has its
checksum beside it, in a file of the same name ending `.sha256`.
