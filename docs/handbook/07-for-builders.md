# For builders

## What this is for

Everything a person who writes software might want from Branch: the command line, a client library,
the app's own web description, letting other AI tools use Branch, letting Branch use theirs, plugins,
turning any documented web service into tools, and measuring how well it does.

**Nothing in this chapter is switched on by default, and none of it downloads anything.** Where a
program is needed, it is one you already have.

## In one minute

- `branch help` lists the whole command line. Nothing here needs the app to be open.
- `branch chat` is a full terminal conversation with a status line and approvals.
- **Settings → Sharing with other AI tools** lets Claude Desktop, Claude Code or Cursor ask Branch.
- **Settings → Developer** holds the tool playground, *Help with code*, and how tools are loaded.
- `GET /api/openapi.json` describes the routes, generated from the same checks the server uses.

## The command line

`branch <command>` is the whole command line, and `branch help` lists it.

**`branch chat`** opens a full terminal conversation: a status line that stays put above what you type
(which model is answering, how many words of context and how much money this conversation has used,
and which approval setting is in force), answers wrapped to the window as they stream, and one short
row per step. **Enter** sends, **Alt+Enter** adds a line, the **up arrow** brings a message back,
**Ctrl+E** shows or hides what is behind those rows, **Ctrl+C** stops the task without closing the
terminal, and **Ctrl+D** leaves.

Inside it: `/help`, `/model [id]`, `/think <low|medium|high|default>`, `/preset [name]`, `/memory`,
`/skills`, `/plan`, `/verify`, `/dry-run`, `/attach <file>`, `/history`, `/export [file]`, `/new` and
`/exit`.

When your approval setting makes a task pause, the terminal shows the question with the tool and the
exact file or command, and takes **y**, **n**, **a** (yes always) or **s** (yes for this conversation).

Other commands worth knowing: `branch run "..." --json` prints one result per line and exits with a
code a script can read; `branch doctor --fix` checks and repairs; `branch daemon install | uninstall |
status` keeps the engine working in the background; `branch backup <file>` and `branch restore <file>`;
`branch eval`, `branch study` and `branch trigger`.

## The app's own web interface, described

Branch has served `/api/*`, plus the OpenAI-shaped `/v1/chat/completions` and `/v1/models`, since the
beginning. What was missing was a description other programs could read.

- `GET /api/openapi.json` is an OpenAPI 3.1 description of the routes worth calling from outside. Every
  request shape in it is generated from the same checks the server uses, so it cannot drift from what
  the app will actually accept.
- The readable version is [docs/api.md](../api.md).
- Every operation says the session key is required, and what a missing or wrong one gets back. The web
  interface is not open to anything that has not been given the key the app printed when it started.
- A test asserts that every route the description names is really answered by the server.

Routes only the app's own screens use, and the ones that write their own answer, are left out on purpose.

**The session key is private.** Anyone holding it can use Branch as you.

## A client library

`packages/sdk` is a small dependency-free TypeScript client for the Branch Agent already running on
this computer. Its types are generated from the app's own checks, so they cannot go stale. Other
languages need no library of ours: the description above is enough to generate one.

For writing tests, `ScriptedProvider` and `ScriptedTools` are part of the package, so a plugin or skill
author can write tests with no model, no key and no network. A scripted model answers by *what it was
asked*, not by how many times it has been called, so one test cannot shift another's script.

## Logging from a program that embeds Branch

If your program runs Branch with `createBranch`, it can hand Branch's own story to the logger you already
use. Nothing is installed for this, and nothing is sent anywhere:

```ts
import { createBranch, bridgeLogs } from "branch-agent";

const app = await createBranch({ workspace, dataDir, provider });
const stop = bridgeLogs(app.store, console, { level: "info", kinds: ["tool.", "model."], prefix: "branch" });
// ... later
stop();
```

Any logger with `debug`, `info`, `warn` and `error` methods works — `console`, pino, winston, bunyan.
Each event becomes one line: failures at `error`, retries, stalls and limits at `warn`, streamed pieces
at `debug`, everything else at `info`. The fields are the same cut-down shape the diagnostics folder
uses — the task's number, the kind, the tool or model name, counts and outcomes — never a prompt, an
answer, a file or a key. A logger that throws is ignored, so logging can never break a task.

Two more ways to read the same story, without writing code:

- `GET /api/logs` answers one JSON object per line, for a log shipper that reads files or addresses.
- With sending traces on, each finished task also goes out as OpenTelemetry log records to your own
  collector (`/v1/logs`), next to its spans and, if you switch them on, the task counters.

## Other AI tools using Branch

Branch is itself a Model Context Protocol server, so another AI tool on the same computer can ask it to
do things. **Settings → Sharing with other AI tools** has the switch, the list of tools you are willing
to share, and ready-to-paste settings with a Copy button for Claude Desktop, Claude Code and Cursor.

**Nothing is shared until you switch it on.** Switching it on offers the tools that only read and leaves
everything else unticked and marked *can change things*; you tick those yourself. Asking Branch a
question in plain words is always available, because it goes through Branch's own permissions and budget
like any other task.

Two ways to connect: over the web interface on the same port as the app, or as a child program with
`branch mcp-serve`. Use the first when Branch is already open; the second starts a second copy against
the same records, so close the app first.

A connected tool also gets read-only access to what Branch remembers, your workspace listing, your
documents, recent tasks and recent conversations — each one scoped by your approval settings, so a
thing your settings would refuse is not listed and reading it by name answers *"unknown resource"*.
Your saved procedures appear as prompts with their blanks. **Every call becomes an ordinary Branch
task**, with the same signed receipt, and shows in **Activity** as *"Another AI tool used …"*.

A tool can ask *"what would this do?"* and get an answer without anything being run, written or opened.
And Branch can write down the exact tool list a connection was shown, with a fingerprint, so a later
disagreement about what was on offer can be settled.

**Branch is not an authorization server.** It issues no keys of its own, has no sign-in page for other
programs, and does not let a program register itself. If a tool asks you for a client id and secret for
Branch, there is none: paste the session key.

**Never on offer:** your saved passwords and keys in any form; writing through a read-only resource;
the owner-only parts of the app; and asking a connected tool to run a model for Branch.

## Branch using other people's tools

Somebody else's server becomes tools Branch may use. Set one up once in the connections file, or try one
first from **Settings → Sharing with other AI tools → Try a server**: give an address or the command that
starts it, see what it offers, fill in a form drawn from each tool's own shape, and run it once. Nothing
is registered and nothing is kept.

A server can be opened as Branch starts, or left until the first task actually needs one of its tools.
Either way the tools are searchable and callable from the first moment. Servers that need a sign-in are
signed in to in your own browser, with the key going straight into the locker.

**What Branch will not do as a client:** send your saved keys to a server they were not configured for;
follow a redirect; accept an oversized answer; or grant a tool that appeared later. What is granted is
what you named.

## Talking to assistants other people built

Two protocols, both off until you switch them on. One lets another assistant ask Branch for work — Branch
publishes a card saying who it is and what it can be asked for, and every such task becomes an ordinary
Branch task with the same signed receipts. The other lets a code editor start Branch and talk to it, with
`branch acp-serve`; when a step needs your yes, Branch asks the **editor**.

Branch can also hand work to an assistant elsewhere. The request carries the words of the task and nothing
else — no files, no secrets, nothing it has read.

**Read this before you switch either on:** because you did not start such a task, it never gets more
freedom than *Ask before changes*. But while you are still on *No approvals* — which is how Branch behaves
until you pick something else — there is nothing to hold a caller to. **Pick an approval setting first.**

## Tools from any documented service

Point Branch at an OpenAPI document and the operations in it become tools, with their inputs checked
before a call is made. Keys go in as references to the locker, never as literal values.

## Plugins

Drop a single `.mjs` file into the `plugins` folder beside your private data. It can add tools and react
to events; it cannot add screens. `GET /api/plugins` lists the files without loading any of them;
inspecting one shows what it would add; enabling one is an explicit switch that is remembered. On the
command line: `branch plugin list | enable <id> | disable <id>`.

A plugin may also bring a model connection or a chat service of its own. Registering one only makes it
available to connect.

**Be plain about the limits: a plugin is not sandboxed.** It runs inside Branch with the same reach over
this computer that Branch has. The only things holding it in bounds are the permission check every tool
goes through, and the fact that nothing is loaded until you switch it on. Only use plugin files you trust.
There is no remote shop; plugins come from a folder or one file on this computer, with the manifest and
the fingerprint of the code shown before anything is copied in, and a file that changes afterwards noticed.

## Help with code

**Settings → Developer → Help with code** is two checkboxes and two plain text areas, one line per
program. Name a language server you already have — `typescript-language-server`, `pyright`, `pylsp`,
`gopls`, `rust-analyzer` — and Branch will talk to it, which turns on diagnostics, go-to-definition,
references, hover and rename. Name a debug adapter you already have and Branch can run a file under it,
stopping on lines you name.

**Nothing is downloaded and nothing starts until you tick the switch.**

A rename works out the whole change across every file first and then goes through the same gate as any
other multi-file change: you see which files it touches, they all change or none of them do, and each
keeps its previous bytes.

Beside that, a **map of the project** puts the files most likely to hold your answer first, and risky
work can happen on a parallel copy inside the workspace whose difference you see before it comes back.

**What is only partly there:** the map finds names by pattern, not with a parser. A name written inside
a comment or a string can be picked up, and something spread over several lines can be missed. That is
the trade for needing no build step. When you need certainty, use a language server.

## The playground, and how tools are loaded

**Settings → Developer → Try things out** runs one tool by hand with a form built from its own
description, under your usual permission rules, and can ask two models the same question.

**Settings → Developer → How the assistant finds its tools** is read-only. It says in ordinary sentences
how many tools are installed, how many travelled with the last request in full, how many were named in
one line, how many were left to look up, and what that weighed against its allowance. Under that: what
the computer made ready before being asked and why, and the short things it has been told to remember
about a tool, each with a Delete button. Nothing on that card can change how the assistant behaves.

## Measuring it

Three different things, easy to mix up:

- **A suite** is a handful of *your own* tasks with the right answers written down — how you tell whether
  a change made the assistant better or worse at the work you actually do. Five ship, and you can write
  your own or turn a task you already ran into one.
- **A benchmark** is somebody else's published set of tasks. **Branch never downloads one.** You download
  the dataset yourself, put it in a folder, and point at that folder.
- **A study** is a written-down experiment: a benchmark or suite, a subset of its tasks, the model choices
  to try, how many repeats, and what it may cost. A study you stop carries on from where it was.

Twelve scorers decide a task **without a model**: exact match, contains, a pattern, a JSON shape, a number
within a tolerance, an address, a file that must exist or contain something, whether a tool was used with
particular arguments, a budget for rounds, time and money, and whether it actually finished. Only the
rubric scorer costs money, and it refuses to guess when no model is connected.

A **gate** is the bar a run has to clear, so a release script can stop when it is not. `branch eval --suite
<id> --gate '{"minAccuracy":0.9}'` exits 0 when the bar was cleared and 1 when it was not.

**Money is never invented.** A model with no price on file reports no amount, and energy is always reported
unavailable. One thing the figures leave out: a task graded by a rubric asks the model a second question,
and those words are not added to the task's own, so a judged suite costs roughly twice what its summary
shows.

Four rules hold for every benchmark that decides by running something: **you switch it on first**; a dataset
never chooses what runs; a dataset never points outside its own folder; and the same time, memory, processor
and output ceilings apply, with no way out to the internet.

**What is deliberately not supported:** OSWorld, WindowsAgentArena, AndroidWorld and the live browser
environments. Each needs a separate virtual computer or a live website whose contents change, so a number
from them would not mean what the published numbers mean. They are listed by name with what each would need,
rather than half-supported.

## Where to go next

- [Troubleshooting](08-troubleshooting.md) — the diagnostics folder is what to send with a bug report.
- [What Branch is not](10-what-branch-is-not.md) — the honest boundaries.
- The reference: [docs/configuration.md](../configuration.md) has every setting, route and switch.
