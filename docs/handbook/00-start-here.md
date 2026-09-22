# Start here

## What this is for

You have just installed Branch Agent, or you are about to. This chapter gets you from a download to
a first answer, and explains what you are looking at on the screen. You do not need to know anything
about programming, and you will never have to type a command to use Branch.

## In one minute

- Download the three Windows files from the release page, double-click **Install Branch Agent.cmd**, and open Branch.
- Connect a model — see [Connect a model](01-connect-a-model.md). Nothing useful happens until you do.
- Type what you want in the box at the bottom and press Enter.
- The left rail is where everything lives. The right pane tells you what is happening now.
- If anything looks wrong, [Troubleshooting](08-troubleshooting.md) starts with one button that checks
  and repairs most things.

## Installing

Go to the project's **latest release** page and download three files into the same folder:

- `Branch-Agent-windows-x64.zip`
- `Branch-Agent-windows-x64.zip.sha256`
- `Install Branch Agent.cmd`

Double-click **Install Branch Agent.cmd**. It checks that the download matches its published
checksum, refuses unsafe archive paths, then unpacks it and puts Branch Agent in your own
programs folder, adds it to the Start menu and to **Add or remove programs**, and keeps the version
that was there before in case you want it back. Nothing else has to be installed first, and the
installer downloads nothing.

Windows may show a blue **Windows protected your PC** box, because these downloads are not signed.
Choose **More info**, then **Run anyway**.

**Prefer not to install?** Unzip the download anywhere and start `Branch Agent.exe` directly. Put an
empty file called `portable.txt` beside it and Branch keeps all of your conversations and files in a
`Branch Data` folder next to the program, so the whole assistant travels on a memory stick.

**To remove it**, open **Add or remove programs**, find Branch Agent and choose **Uninstall**. Your
conversations and files are left exactly where they are.

## Your first task

When Branch opens for the first time, it asks one question — **How should Branch think?** — and
offers a few big choices:

1. **Use my ChatGPT plan.** Use the models that come with a plan you already pay for.
2. **Paste a key.** A key from any of the services Branch knows.
3. **Use the model on this computer.** Shown only when a model program such as Ollama is already
   running on this computer; nothing you type leaves it.
4. **Try it without an account.** One click, no cost, and no real answers — a short practice run so
   you can see the shape of things. The window says **Practice mode** until you choose one of the
   others.

After a sign-in or a key, **Test the connection** makes one real, tool-free request and shows you the
reply and how long it took. Nothing is added to your conversations. Then **Done, start chatting**.
Opening Branch when you sign in, and reaching it from your phone, are switches in Settings → General.
After your first task finishes, one line under the conversation offers both; it shows once.

Now type something in the box at the bottom and press Enter. A good first request is something small
and checkable: *"Write a file called hello.txt in my workspace saying hello, then read it back to me."*
You will see the answer, and a quiet row saying which tools it used.

## What the screen shows

| Where | What it is |
| --- | --- |
| The rail on the left | **New conversation**, your recent conversations, and **Settings** at the foot. **Inbox** appears here while something is waiting for you. |
| The middle column | The question **What do you want done?**, then the conversation itself: what you asked and what it answered. |
| The message box | One line that grows as you type. **+** on its left adds a document, a picture or a sound; the round button on its right sends (Enter), and becomes **Stop** while a task runs. With nothing in the conversation yet, the box sits under the question with three starting points (**Tidy a folder**, **Research something**, **Plan my week**) that only fill it in. |
| **More**, top right | Everything else, in plain words: ask me questions first, forget this conversation afterwards, attach a document or a picture, who should answer, the Activity, Plan, Files and Memory panel, Inbox, Automations, Library, Customize, Find anything, labels, what is allowed right now, Lockdown, Clear the view and Help. |
| The pane on the right | Slides in by itself while a task or a goal is running and shows what is running, anything you have said yes to for this conversation, and a goal's Resume and Stop; it goes away when the work finishes. |

That calm window is the default. If you would rather see every tab, meter and switch all the time,
turn on **Show everything** in Settings → Appearance (or at the foot of the More menu). The rest of
this section describes that full window.

The ten sections in the rail are **Conversation**, **Activity**, **Usage**, **Memory**, **Skills**,
**Specialists**, **Procedures**, **Schedules**, **Documents** and **Settings**. Each one opens on a
sentence saying what it is for, so you can find your way by reading rather than by guessing.

Two panes fold away when you want the room: press the icon beside the section name to fold the rail,
and the one on the far right to fold the context pane. On a narrow window — a phone, say — the rail
slides over the page instead of taking a column, and the context pane steps aside entirely.

## Keys worth knowing

| Key | What it does |
| --- | --- |
| **Ctrl+K** | Find anything: a section, a conversation, a project, a recipe, a skill, or an action |
| **Ctrl+N** | Start a new conversation |
| **Ctrl+,** | Open Appearance |
| **Ctrl+Shift+K** | Fold the pane on the right away and back |
| **Esc** | Close whatever is open; from the message box, step out without losing what you typed |

## Making it yours

**Settings → Appearance** (or **Change the appearance** in your own menu at the foot of the rail)
carries the look: **Forest** or **Daylight** or follow this computer, a highlight colour, text size,
spacing, lettering, **Keep things still**, and **Show the acorn**. Everything shows at once, and
**Save appearance** keeps it. The language lives on the same screen; English is the original and the
other languages are machine drafts.

**Settings → Assistant identity** gives your assistant a name and standing working instructions —
*"Keep answers short"*, *"Always show your sources"*. The application is still called Branch Agent;
this is what it calls itself when it answers you.

## Where to go next

- [Connect a model](01-connect-a-model.md) — services, keys, models on this computer, and cost.
- [Everyday tasks](02-everyday-tasks.md) — asking, files, documents, pictures, voice, talk mode.
- [Permissions and safety](04-permissions-and-safety.md) — read this before you let it change things.
- [What Branch is not](10-what-branch-is-not.md) — the honest list, so nothing surprises you later.
