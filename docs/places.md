# Where things go

Branch Agent has five places and one window. Every feature, old or new, lives in exactly one of
them, and the owner should be able to guess which before looking. This page is the rule for
choosing, the list of homes, and how a new screen puts itself there. It was written with the
wave 9 redesign (`public/layout.js`, approved by the owner on 2026-09-16) and applies to every
builder on every machine.

## The rule, in one sentence each

| Place | It holds | Ask yourself |
| --- | --- | --- |
| **Conversation** | The work happening now, and what that one conversation is using | Is it only meaningful while a conversation is open? |
| **Inbox** | What needs the owner's decision, what finished, and the full record | Is it waiting for a yes, or reporting something that already happened? |
| **Automations** | Work that runs without being asked each time | Does it start on a schedule, a trigger, or as a saved procedure? |
| **Library** | What the assistant knows and what it has made | Is it knowledge, memory or an output the owner may want to open again? |
| **Customize** | What the assistant can do and who can reach it | Does it add an ability, a connection, or a way in? |
| **Settings** (a window, not a place) | How the app behaves on this computer | Would the owner set it once and rarely look again? |

Go down the table and stop at the first yes. If two places both seem right, the feature is
probably two things: split it, and link the two halves (the Usage report lives in Settings, the
live meter lives in the message box).

## The homes

A home is written `place:tab`, or `settings:page`, or `settings:models:tab`.

| Home | What belongs there |
| --- | --- |
| `inbox:needs` | Approvals waiting for a yes, suggested memory changes, anything a task stopped to ask |
| `inbox:finished` | Tasks and automation results from the last week, each with Look inside and Open the conversation |
| `inbox:history` | The whole record: every task, reports, comparing two tasks, the event log |
| `automations:scheduled` | Timed tasks, the waiting line, multi-step workflows, the heartbeat |
| `automations:procedures` | Saved procedures and flows, and their editor |
| `automations:triggers` | Incoming triggers and webhooks, outgoing webhooks, hooks |
| `library:memory` | Remembered facts, tidying, how much it keeps, import and export, checkpoints |
| `library:documents` | Documents, knowledge bases, the notes folder |
| `library:made` | Pictures, files and reports the assistant made |
| `customize:skills` | Installed skills, installing and sharing, suggestions, what happens when a skill looks risky |
| `customize:specialists` | Specialists and proposing new ones |
| `customize:plugins` | Plugins |
| `customize:connections` | MCP in both directions: servers the assistant uses, other AI tools using Branch |
| `customize:channels` | Chat apps, the phone, pages and the browser extension that reach Branch |
| `settings:general` | Starting with the computer, projects, labels, shared copies, people on this computer |
| `settings:assistant` | Name, picture, working instructions, persona |
| `settings:instructions` | The owner-written SOUL, IDENTITY, USER, AGENTS, TOOLS, SOP, MEMORY and HEARTBEAT files, with a real editor and preview |
| `settings:appearance` | Theme, light or dark, season, contrast, text size, spacing, lettering, language |
| `settings:notifications` | When Branch may interrupt, quiet hours, days off |
| `settings:models:connection` | Signing in to a provider, API keys, checking connections |
| `settings:models:defaults` | Which model does what, routing, fallbacks |
| `settings:models:local` | Models running on this computer |
| `settings:models:second` | Second opinion and debate |
| `settings:models:media` | Pictures and sound models |
| `settings:accounts` | Every sign-in and key, which one answers, and what happens when one runs low |
| `settings:voice` | Speaking and listening |
| `settings:permissions` | When to check with the owner, rules, limits, loop guards, trusted folders |
| `settings:computer` | Screen and keyboard, where scripts run, network reach, other computers, the browser, operating-system permissions |
| `settings:secrets` | Secrets, password managers, the Keychain list |
| `settings:data` | Usage and cost, how long things are kept, backup, snapshots, bringing things in from another assistant |
| `settings:advanced` | Health check, diagnostics, tracing, evaluation and studies, developer tools |
| `settings:about` | Version and updates |

Inside a conversation there are no homes to add to, only two surfaces with strict jobs:

- **The side pane** has four tabs and nothing else: Activity (the model, what it is doing, what is
  running, what is allowed), Plan (the to-do list), Files (receipts, pages to open), Memory (facts
  it used). A new conversation-only readout joins one of these four; it never adds a fifth.
- **The message box** holds only what changes the next message: the model, attachments, voice,
  temporary, ask-first, who answers. Anything else is a setting.

## Features on their way, and their homes

| Coming from | Home |
| --- | --- |
| Operating-system permissions screen (`mac2/desktop-ui`) | `settings:computer` |
| Keychain entries Branch may read (`mac2/desktop-ui`) | `settings:secrets` |
| Filling a saved sign-in into a page (`mac7/vault-autofill`, R17-068) | `settings:secrets`, beside the password managers it reads from |
| Loop guard, trusted folders (`mac2/guards`) | `settings:permissions` |
| Importing from another assistant (`mac2/move-in`) | `settings:data`, and offered once on first run |
| Heartbeat and quiet jobs (`mac2/quiet-jobs`) | `automations:scheduled`; its interruptions setting in `settings:notifications` |
| Undoing a goal (`mac2/goal-undo`) | The conversation: a message action and the Plan tab, no screen of its own |
| Live chat on channels (`mac2/chat-live`) | `customize:channels` |
| Persona, identity and "who the owner is" files (SOUL, IDENTITY, USER) | Edited in `settings:instructions`; `settings:assistant` may link there from the related assistant controls |
| A project's own instructions (AGENTS.md and its aliases) | Edited in `settings:instructions`; `settings:general` may link there from the related project |
| MEMORY.md | Edited in `settings:instructions`; `library:memory` shows the related remembered facts |
| HEARTBEAT.md | Edited in `settings:instructions`; `automations:scheduled` shows the jobs it wakes |
| SOP.md | Edited in `settings:instructions`; `automations:procedures` shows the procedures that use it |
| Suggested automations, the automation catalogue, standing orders, repeating in conversations and the limits on automatic work (`mac7/r17-b`) | `automations:scheduled`; the `/loop`, `/heartbeat`, `/subgoal`, `/bg`, `/handoff`, `/suggestions` and `/blueprint` commands live in the message box |
| Procedures that start themselves, with how much each may do on its own (`mac7/r17-b`) | `automations:procedures` |
| What an automation, a procedure or a standing order waits for your yes on (`mac7/r17-b`) | `inbox:needs` |
| "From now on" instructions (`mac7/r17-b`) | `settings:assistant` |
| Going back to an earlier step of a flow, and checks for saved procedures (`mac7/r17-h`) | `automations:procedures` |
| The shared board of cards (`mac7/r17-h`) | `automations:scheduled`, beside the waiting line: it is work waiting to be done (bucket 23's project board stays in `settings:general`, and the shared board lays its lanes over it) |
| Changing the waiting line, and what typing does while a task works (`mac7/r17-h`) | `automations:scheduled`; `/queue` and `/busy` live in the message box |
| Widgets the assistant built (`mac7/r17-h`) | `library:made`, beside the live tool pages they are made from |
| Focus view (`mac7/r17-h`) | `settings:appearance`; `/focus` lives in the message box |
| Requests for new packages and tool servers (`mac7/r17-h`) | `inbox:needs` |
| What installed skills need on this computer (`mac7/r17-b`) | `customize:skills` |
| Other computers side by side, using apps in the background, USB devices (`mac7/r17-i`) | `settings:computer` |
| Where Branch listens (`mac7/bind`) | `settings:computer` |
| Trunks on other computers (`mac7/r17-i`) | `customize:specialists`, beside the Trunks card |
| Making videos (`mac7/r17-i`) | `settings:models:media` |
| The chat relay, sending from a script and pausing chat apps (`mac7/r17-i`) | `customize:channels`; `/platform` lives in the message box |
| Sharing the assistant through git, skill bundles (`mac7/r17-i`) | `customize:skills` |
| Notes with rewriting (`mac7/r17-i`) | `library:documents` |
| Model arena (`mac7/r17-i`) | `settings:models:second` |
| TOOLS.md | `customize:skills` |
| DREAMS.md and other things the assistant writes for the owner | `library:made` |
| Cheaper and faster model routing | `settings:models:defaults` |
| Site skills for the browser | `customize:skills`, with browser access itself in `settings:computer` |
| Evaluation and studies | `settings:advanced` |
| Keep running through crashes and updates (`mac3/never-break`) | `settings:general` |
| Set up Telegram, step by step (`mac3/never-break`) | `customize:channels` |
| Set up any chat app: the one command, square codes and Check and save (`mac7/connect`) | `customize:channels`; the phone app shows it on its home screen, and the terminal view lists the command under Customize › Channels |
| Watching and saving videos, ffmpeg and yt-dlp (bucket 17) | `settings:models:media`; a video attachment in the message box |
| Other speech services and spoken commands (bucket 17) | `settings:voice` |
| What Branch learns from experience, the learning core (`mac2/fly-core-2`) | `library:memory`; its skill ideas open in `customize:skills` |
| Learning, deeper: memory blocks, the timeline, meaning search, lessons, preferences from Claude Code and Codex, expiring memories, note read-back, outside memory (R17-F) | `library:memory`; skill usage and merging in `customize:skills` |
| The wall around programs and keys at the network edge (`mac3/os-sandbox`) | `settings:computer`, beside "What can reach out"; its questions in `inbox:needs` |
| The dashboard in the browser (`mac3/web-dashboard`) | A page of its own at `/dashboard`, not a place; its switch in `customize:channels` |
| Typed commands, the same everywhere (`mac3/commands`) | The switch and "what works where" in `settings:general`; the `/` menu lives in the message box, because it changes the next message |
| Watching a task again: its recording, the path it took, saving it as a page or a workflow (bucket 13) | `inbox:history` |
| Whether Branch itself is keeping up, the event-loop watch (bucket 13) | `settings:advanced` |
| Working with other agents and tools: Agent Protocol, lent tools, fleet, handoff, project routing, flow search (`mac4/bucket-20`) | `customize:connections` |
| Ways of working (modes) and shared assistants (`mac4/bucket-20`) | `customize:specialists` |
| A conversation handed over from another device (`#handoff=<id>`) | Opens the conversation itself; no screen of its own |
| Building on Branch: the switch for the app-builder tools, and the clients for each language (bucket 21) | `settings:advanced` |
| Flows written out and read back as YAML files (bucket 21) | `automations:procedures` |
| Saved prompts, your own commands and the example tool server (bucket 12) | `automations:procedures`, beside saved procedures; the commands themselves live in the message box's `/` menu |
| Installing and removing skills with a written account, Agent Skills folders (bucket 12) | `customize:skills` |
| Several accounts per connection (`mac6/accounts`) | `settings:models:connection`, one Accounts card (ChatGPT's list inside the ChatGPT card); the account chip sits in the title bar beside the page name, because it only names and switches what the conversation's model uses |
| Signing in from other devices, groups and sharing a conversation (bucket 19) | `settings:general`, beside the people on this computer; a person's own page at `/people`, not a place |
| One-click models on this computer (`mac5/local-models`) | `settings:models:local`, inside the existing "Models on this computer" card; each finished setup appears as a connection in `settings:models:connection` |
| The smaller asks (`mac6/bucket-23`): project boards | `settings:general` |
| Counting how Branch is used, with consent (`mac6/bucket-23`) | `settings:data` |
| Other computers running Branch (`mac6/bucket-23`) | `settings:computer` |
| Other agents answering a conversation (`mac6/bucket-23`) | `settings:models:connection` |
| Quick answers, pages kept, long articles and live tool pages (`mac6/bucket-23`) | `library:made` |
| Bringing in new items from GitHub, mail and Telegram (`mac6/bucket-23`) | `library:documents` |
| A Hindsight memory server (`mac6/bucket-23`) | `library:memory` |
| Sending requests where they belong, the intent pipeline (`mac6/bucket-23`) | `customize:skills` |
| Steps for other apps, MCP examples and the app-server door (`mac6/bucket-23`) | `customize:connections` |
| Your devices: pairing other computers and the phone, each one's switches, who it is shared with (`mac7/nodes`) | `customize:channels`; the "which device" picker lives in the message box, because it changes the next message |
| Trunks, named assistants of the owner's own: the switches, the three-field create, Edit Trunk, rooms, bringing one in (R17-A) | `customize:specialists`, a card of its own after the specialist panels |
| The Trunks roster: each Trunk with its latest line and unread replies, and each room (R17-A) | The sidebar, a group above Recents that shows only while Trunks are switched on |
| Rooms where a Trunk asked for the owner (R17-A) | `inbox:needs` |
| A Trunk's routines (R17-A) | `automations:scheduled`, with the rest, their words starting `[Trunk @name]`; each Trunk's own list is in its editor |
| `@name` in the message box (R17-A) | The message box: the `@` menu, and the message goes to that Trunk's own conversation |
| Safety extras: tool scripts, WebAssembly add-ons, authenticator codes, the emergency stop by level, command checks, the progress check, the tamper-evident record, history repair (`mac7/r17-g`) | `settings:permissions`; the emergency stop sits beside Lockdown's rules there, and a question that needs a code is still answered in `inbox:needs` |
| The browser extension's side panel and the Obsidian plugin (`mac6/bucket-23`) | Outside the window; their instructions are in `extras/`, and the extension's switch stays in `customize:channels` |
| Starting from a preset, and putting settings back (R17-S-A) | `settings:general` |
| Which file does what, with editing of each file (R17-S-A) | `settings:general`, beside "How to work in this project"; each file's switch stays on its own card |
| Your settings in one file (R17-S-A) | `settings:data`, beside Backup |
| What to try after first run: say hello, watch me once, suggested automations (R17-S-A) | The conversation, straight under the first-run card; shown once |
| A description under every Settings control, and the scope chip on every Settings card (R17-S-A) | Every Settings page; added by `public/settings-describe.js`, nothing to place |
| Limits that used to be hidden (R17-S-B): summarising long conversations, sub-tasks and side jobs, thinking effort and service tier | `settings:models:defaults` |
| Most steps and most cost for one task, hiding key-like values (R17-S-B) | `settings:permissions` |
| Trying the model service again, how much a tool may say (R17-S-B) | `settings:advanced` |
| How commands run, the launch settings file as a card (R17-S-B) | `settings:computer` |
| Showing a model's thinking (R17-S-B) | `settings:appearance` |
| How much it remembers at the start, the note about you, where things are remembered (R17-S-B) | `library:memory` |
| Model for planning, choosing by difficulty, counting what the service says, keeping the cache warm (R17-E) | `settings:models:defaults` |
| OpenRouter company choice (R17-E) | `settings:models:connection` |
| Mixtures of models, which then appear in the model picker (R17-E) | `settings:models:second` |
| The round-by-round chart switch (R17-E); the chart itself sits inside the conversation meter's popover | `settings:appearance` |
| Coding polish (`mac7/r17-d`): its switches, formatters, shell snapshot, copies, rules, checks and CI lines | `settings:advanced`, one card beside the developer tools |
| A task's checklist (`mac7/r17-d`) | The side pane's Plan tab, under the to-do list |
| The `@` picker (`mac7/r17-d`) | The message box, the same menu as `/`, because it changes the next message |
| Keyboard shortcuts and vim keys, files searches skip (R17-S-C) | `settings:general` |
| The status line and a time on each message (R17-S-C) | `settings:appearance`; the line itself sits in the composer's foot row |
| Where you are told and the sound (R17-S-C) | `settings:notifications` |
| Updating by itself (R17-S-C) | `settings:about` |
| The push-to-talk key and the longest recording (R17-S-C) | `settings:voice` |
| How carefully the browser acts, the proxy and trusted certificates (R17-S-C) | `settings:computer` |
| How long a tool server may take to start (R17-S-C) | `customize:connections` |
| A word that starts a turn: the switch, the word, how sure it must be (`mac7/wake-pins`) | `settings:voice` |
| Settings you have pinned, and unpinning them (`mac7/wake-pins`) | `settings:permissions` |

When something new does not fit a row, apply the rule at the top and add a row here in the same
change.

## Reached from the Trunks strip, not one of the five places

These two screens are opened from the Trunks strip (phase 2). They are not homes for new features and
the terminal does not list them among its places.

| Screen | What it shows |
| --- | --- |
| `overview:here` | the Overview of this computer, one of your other computers or a Trunk (`public/overview.js`) |
| `household:people` | People on this computer, with faces (`public/people-place.js`) |

## Putting a new screen in its home

1. Build the card as the anatomy in `docs/design.md` says: `<section class="card" id="…">`, an
   `<h2>`, one sentence saying what it is for, controls, one filled button.
2. Give it its home: `data-home="settings:computer"`. `public/layout.js` moves it there when the
   page starts and whenever it is added later, so the card can live in `index.html` or be created
   by its own module. Do not edit `layout.js` to place a card, and do not append to another
   screen's element to get it on screen.
3. Every word has a `data-t` key with English and real French (`public/locales/`).
4. Colours only through tokens. No colour is written in any stylesheet but `public/tokens.css`,
   and a script that draws reads its colours from the page's tokens, so all 44 themes work.
5. It fits 400 px without sideways scrolling, and every control can be named.
6. Tests open it the way a person would, through `tests/places.mjs` (`openPlace`,
   `openSettingFor`), never by calling `branchLayout` directly.

A new place in the sidebar, a new Settings page, or a new pane tab needs the owner's approval
first. Four places and twelve pages is the point of the design.

## What the five references taught

The layout came from studying four desktop agents and KeepOak's own site. What each contributed,
so the next decision can lean on the same reasoning:

- **Claude desktop.** Abilities gathered under one Customize. Side panes open on demand inside a
  session instead of standing on every page. The model and permission mode sit in the message box.
- **Codex.** Automations deliver into a triage queue that the owner reviews, which is where Inbox
  comes from. Projects hold their threads. Its own issue tracker warns that projects and threads
  looking alike confuses people, so ours read differently.
- **Hermes Desktop.** A short Settings list of named pages, a status bar that shows the approval
  switch and how full the context is, and a failure card that names what failed with Retry,
  Switch provider and Open logs.
- **OpenClaw.** Settings with search at the top and changes that save as you go; pinned pages in
  the sidebar. Its open bug with a Home that meant nothing is why every place here has one
  sentence that says what it holds.
- **KeepOak.** The visual language only: glass panes over a pixel landscape, the 44 themes each in
  light and dark, the season of the year, condensed display type over a calm body face, copper
  as the one action colour. Branch carries the themes as finished colours
  (`public/theme-catalogue.js`) and draws its own oak (`public/grove.js`). **No KeepOak website
  source belongs in this repository**, which is public; the theme table is regenerated privately
  when KeepOak's themes change.

## Next, from the same research

Ideas that fit this layout, in the order they would help most. None is built yet; each needs the
owner's go before it starts.

1. **A status light on every project and conversation**: turning while it works, amber while it
   waits for a yes (Codex and OpenClaw both show state in the list).
2. **Approve, Revise or Reject on an automation's result** in `inbox:finished`, not only Look
   inside (Codex triage).
3. **The failure card**: when a task stops on an error, one card naming the layer that failed, with
   Retry, Switch model and Open the record (Hermes).
4. **Pin a tab to the sidebar**, so an owner who lives in Documents can reach it in one click
   without adding a place for everyone (OpenClaw).
5. **"While you were away" on the conversation's greeting**, the same summary Inbox shows, so
   the first thing seen after a night away is what happened.
6. **A theme of the owner's own**: pick four colours and every token is worked out, previewed
   live, and saved beside the 44.
