# What Branch is not

## What this is for

The honest list. Everything here is something Branch deliberately does not do, cannot do, or does only
partly — written down so you find out from us rather than from a task that quietly failed. Nothing in
this chapter is a promise to build it later.

## In one minute

- Branch is a **local** assistant for one person on one Windows computer. It is not a service.
- It is **not finished**. Parts of it are proved against stand-ins, not against live accounts.
- It never learns about you in the background, never sends anything to us, and has no shop.
- Where something is half-built, this handbook says so in the chapter it belongs to.

## The shape of the thing

**It is not a cloud service.** Branch runs on this computer. There is no account, no server of ours, no
syncing between machines. If the computer is asleep, Branch is asleep.

**It is not multi-user.** The lock on the web interface is single-owner access, not a tenancy system.
Profiles keep people's conversations and notes apart on one computer; they are not separate accounts,
there is no syncing, the assistant still works as the owner, and anyone who can open the files on this
machine can read everything. The PIN keeps profiles apart; it does not lock the data away.

**It is not a sandbox.** The workspace check is not an operating-system sandbox. A program the
assistant runs can reach other files, use the network and start more programs. On Windows a command is
held inside a job the system itself polices, so the memory and processor ceilings are real and
everything the command started is cleared up — but that is a ceiling, not a cage. Offline mode points
ordinary tools at a dead address so they fail fast; it is **not a firewall**, and a program that opens
its own connection is not stopped.

**A plugin is not sandboxed either.** It runs inside Branch with the same reach Branch has. Only use
plugin files you trust.

**Windows only.** The screen-and-keyboard tools, the job object, the Windows voices and the installer
all rest on Windows. There is no macOS or Linux build.

## What it will never do

- **See a password of yours.** Every sign-in happens on the service's own page, in your own browser.
- **Collect anything about you.** There is no telemetry client, no analytics and no crash reporting,
  which is why there is no setting to turn off.
- **Invent a cost.** A model with no published price on file reports *no price on file*, never $0.00.
- **Claim energy use.** It is always reported unavailable.
- **Guess or break a password** on a locked file.
- **Grant a tool that appeared after you agreed.** What is granted is what you named.
- **Type a saved secret onto your screen.** The screen tools are never given the locker.
- **Improve itself without your say-so.** A skill can propose a better version of itself; you see the
  lines that changed and try it as a practice run before it is kept. Unbounded self-modification is
  deliberately not offered. When you explicitly ask to change Branch Agent's source, Branch can
  prepare an isolated source worktree and a draft pull request; it does not edit the installed app,
  publish a release or merge the draft itself.
- **Run a marketplace.** Plugins come from a folder or one file on this computer, fingerprinted, with
  an explicit switch. There is no remote shop.

## Deliberately not built

**A second assistant engine inside the app.** One runtime. A second would double the surface that has
to be inspected, approved and audited, and would give you nothing you cannot already have: work that
genuinely belongs elsewhere is handed over to another assistant and the result read back.

**Google PaLM.** Retired by Google in favour of Gemini, so an adapter would have been dead on the day
it was written.

**Hosted cloud browser services.** Branch has no Browserbase-style account integration. It can,
when you switch it on, drive a browser in a Docker container or on a Playwright server you run
yourself (see "Browser sandbox" in the configuration guide); otherwise the browser runs on this computer.

**X / Twitter direct messages.** The endpoints need an elevated access tier applied for and paid for
per project. Shipping a connection that always fails would be worse than not shipping one.

**A code editor inside the app.** Documents and **Look inside** show code read-only with colouring,
which is what an assistant needs. You already have an editor; a second would be a worse one.

**A separate configurable intent pipeline.** Skills already decide what to do; a second competing way
to decide the same thing would just be a second thing to debug.

**A graph database for knowledge.** Knowledge bases do the same job on the database that is already
there, with nothing extra to run.

**Calling native libraries directly.** That would put unsandboxed native code inside the app. Anything
needing it is a program you run through the command tools.

**Driving an Android phone over USB.** Not a local Windows desktop assistant's job.

**A proxy in front of many providers.** The connections catalog reaches those services directly, with
no extra process to run.

**A browser side panel.** That is an extension, not part of a local app.

**Benchmarks that need a virtual computer.** OSWorld, WindowsAgentArena, AndroidWorld and the live
browser environments each need a Linux desktop, a throwaway Windows machine, an Android emulator, or a
live website whose contents change. Branch cannot make or roll back one, so a number from it would not
mean what the published numbers mean. They are listed by name with what each would need.

## Built, but only partly

Each of these is genuine and usable. Each has an edge that is honestly not there.

**Live spoken conversation.** Works, and only on OpenAI and Gemini connections. Tested against local
stand-ins speaking both services' documented shapes — **not** against the real services with real
sound. Treat *"Branch speaks the right language"* as what is proved.

**Model services.** All 38 have been tested against stand-ins of the service, not against live
accounts. Protocol tests do not establish that your account is ready.

**Routing to a model on this computer.** The rule includes a *"the local server is not answering"*
branch, but nothing checks the local server before a task starts, so a task sent to a local model that
does not answer falls back the ordinary way.

**The project map.** Names are found by pattern, not with a parser. A name inside a comment or a string
can be picked up, and something spread over several lines can be missed. Use a language server when you
need certainty.

**The reviewer pass.** It checks the finished answer in a pass of its own. It is not a second model on
its own context injecting notes into every turn.

**Working with several specialists.** They can run side by side on a shared budget and hand a piece of
work to a named one. They do not hand off to each other freely while running.

**Planning.** There is one plan builder, which asks for a short numbered plan you can edit. There is no
separate component that turns a design document into tasks.

**The fourteen shared-connection chat services.** Words only — no files, no voice notes, no buttons.
Microsoft Teams is two webhooks, not a full Teams app, so one-to-one chats, cards and file sharing are
out of reach. A WeCom group robot can be posted to but never asked. Matrix cannot read end-to-end
encrypted rooms. Meta must review your app before anyone outside your own team can message a page.

**Numbering things on a page.** Only things that are visible and that the page describes in the
ordinary way get a number. A control drawn on a canvas, or inside another page embedded in this one, is
invisible to it — and to every other browser tool here. Two things that are genuinely alike share a
number, and acting on it acts on the first.

**Borrowing the browser you already have open.** Chrome or Edge only, on this computer only, and only
when you started the browser yourself with that door open. Branch never starts it for you.

**Reading documents.** The older `.doc`, `.xls` and `.ppt` formats are not read, and neither are
OpenDocument presentations. A PDF that is pictures of text has no words to lift out. A heavily designed
page can come out in an odd order, because lines are rebuilt from where text sits on the page.

**Spreadsheets Branch writes.** Checked against this app's own reader. Opening one in Excel has not
been tested.

**Speech programs on this computer.** The transcript is read from what whisper.cpp or faster-whisper
prints, using the flags their own command lines document. This has not been run against a real
installation, so a build that names its flags differently refuses in plain words rather than silently
returning nothing.

**Cached prices.** A price for cached words can be recorded, but nothing fills in cached counts yet, so
it does not affect any figure today.

**Free web search.** The fallback reads a public results page rather than an interface meant for
programs. It is rate-limited by whoever runs it and on a busy day returns nothing at all. If search
matters to your work, pay for one of the services or run your own.

## Using your screen and keyboard

Switched off out of the box. Even switched on:

- **There is no global Escape key.** Stopping means the button on the notice, cancelling the task, or
  closing Branch. Branch does not listen to your keyboard while you are using it yourself.
- **A whole-screen picture cannot be censored.** Branch can refuse to take one, and does when a password
  window is showing, but it cannot black out part of a picture it has taken. Ask for one window.
- **Programs that draw themselves cannot be read.** Games, drawing programs, many desktop apps built
  from web pages: reading one comes back nearly empty and clicking falls back to guessing at a point.
- **Windows running as an administrator are invisible.** Branch runs as you.
- **Only whole screens, one at a time.** No regions, and no way to ask for all of them at once.
- **Nothing is recorded.** No screen recording, no replay, no watching continuously — only the one
  picture or reading you asked for.
- **The refusal list is deliberately clumsy.** An ordinary window that merely mentions a password, a
  passkey or signing in is refused too. That is the error worth making, but it does mean Branch will
  sometimes refuse something harmless.
- **Opening a file cannot be confirmed.** Windows picks the program and says nothing about what
  happened, so the answer says so and asks the assistant to look at the open windows instead.
- **It will not run a program out of your workspace.** Ticking *use my screen and keyboard* is not the
  same as saying *run programs from my workspace*. That has its own switch.

## How finished this is

Branch Agent is an early implementation. The local runtime, the web interface and the offline
demonstration run today; the complete requested capability set remains in development. The project's
own inventory counts individual acceptance criteria, most of which are not yet met, and that is not a
release-completeness percentage — it is a list of things still to do.

Protocol tests and local checks do not establish live account readiness. Procedure checks establish
their explicit assertions; they do not establish general intelligence or unrestricted self-improvement.
No claim of general intelligence, sentience or feature parity with anything is supported by any of it.

## Where to go next

- [Troubleshooting](08-troubleshooting.md) — when the thing that did not happen *should* have.
- [Start here](00-start-here.md) — the beginning.
