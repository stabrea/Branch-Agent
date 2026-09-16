# Branch Agent

An open-source personal assistant designed to assemble the capabilities you need, coordinate specialist agents, and improve through verified experience.

**Status: early implementation.** The local runtime, web interface and offline demonstration run today. The complete requested capability set remains in development; see the [feature inventory](docs/features.md) for evidence and gaps.

## Install the Windows app

Go to the [latest release](https://github.com/stabrea/Branch-Agent/releases/latest) and download two files into the same folder: `Branch-Agent-windows-x64.zip` and `Install Branch Agent.cmd`. Double-click `Install Branch Agent.cmd`. It unpacks the download, puts Branch Agent in your own programs folder, adds it to the Start menu and to **Add or remove programs**, and keeps the version that was there before in case you want it back. Nothing else has to be installed first.

Windows may show a blue "Windows protected your PC" box, because these downloads are not yet signed. Choose **More info**, then **Run anyway**.

Prefer not to install? Unzip the download anywhere and start `Branch Agent.exe` directly. Put an empty file called `portable.txt` beside it and Branch keeps all of your conversations and files in a `Branch Data` folder next to the program, so the whole assistant travels on a memory stick.

To remove Branch Agent, open **Add or remove programs**, find Branch Agent and choose **Uninstall**. Your conversations and files are left where they are.

Once it is open:

- **Settings → ChatGPT account** signs in with your ChatGPT plan; **Settings → Model connection** uses an API key instead.
- **Settings → How Branch runs on this computer** turns on *Start Branch when I sign in to Windows*, *Keep Branch working when the window is closed* (so timed jobs and chat replies still happen), and *Reach Branch from my phone*.
- **Settings → Updates** checks GitHub for a newer release and installs it with one click after checking the published checksum. A safety copy of your work is taken first, and the last three are kept.

### Reaching Branch from your phone

Branch never opens itself to the internet or to the network you happen to be on. Your phone reaches it over [Tailscale](https://tailscale.com), a private network you sign in to on both devices. Install Tailscale on this computer and on the phone, sign both in, then turn on **Reach Branch from my phone**. Press **Show the square code for my phone**, point the phone's camera at it, and type the six numbers shown on the computer. The numbers are good for a few minutes and for one phone.

If something is not working, `branch doctor --fix` checks what Branch needs and repairs what it can.

## Run locally

Requires Node.js 24 and npm. Python 3.12 is optional for experiments.

```sh
npm ci
npm run demo
npm start
```

Sign in with a ChatGPT plan from the terminal with `node dist/cli.js login` (`logout` removes it). A source checkout updates itself with `node dist/cli.js update`. `branch doctor --fix` checks that everything Branch needs is in place and repairs what it can. `branch daemon install | uninstall | status` keeps the engine working in the background from the moment you sign in to Windows, with no window. After `npm link`, the same commands are available as `branch chat`, `branch login` and `branch update`.

For an interactive terminal conversation, run `npm run chat`. Text streams as the provider sends it. Press Ctrl+C or type a revised request to interrupt the current task and continue the same conversation. `/new` starts a new conversation; `/exit` closes the terminal assistant.

- **A terminal worth using.** `branch chat` draws a status line (model, tokens, cost, when it checks with you), wraps answers to the window, shows one short row per step, and understands `/model`, `/preset`, `/plan`, `/verify`, `/dry-run`, `/attach`, `/history`, `/export` and more. Enter sends, Alt+Enter adds a line, the up arrow brings a message back, Ctrl+C stops the task and Ctrl+D leaves. When a task pauses for a yes, answer it right there with y, n, a or s. It uses nothing but Node's own readline, and falls back to the plain streaming view when the terminal cannot take it. For scripts, `branch run --json` prints the events as JSON Lines and exits 0, 2, 3 or 4; `branch status`, `branch logs <task id>` and `branch approve <task id> yes|no` round it out, and `branch completion bash|powershell` writes a completion script. See [the command line section](docs/configuration.md#command-line-and-terminal).

For the native desktop application:

```sh
npm run desktop
```

It opens an authenticated native window automatically. Closing the window keeps the assistant in the tray; use **Quit** in the tray menu to stop it. When a background engine is already running (see `branch daemon install`), the window joins it rather than starting a second one. To create a portable application folder for your current operating system, run `npm run package:desktop`; on Windows it also writes `release/Install Branch Agent.cmd`, the unsigned installer described above. The packaged app updates itself from GitHub Releases; code signing is still pending.

In **Settings → ChatGPT account**, sign in on OpenAI's website with a short code to use the models that come with your ChatGPT plan; the sign-in is kept under the device's key protection and Branch identifies itself as Branch Agent. In **Settings → Model connection**, select a provider and enter its API base URL, model identifier and key. Quit and reopen to apply an API-key connection. Explicit launch environment configuration takes precedence.

Open the local address printed by `npm start` and paste its session token. The default provider is a deterministic demonstration that writes, reads and verifies a greeting. It does not interpret arbitrary requests. Configure a language model using [configuration.md](docs/configuration.md) for general assistance.

The tool workspace defaults to `workspace/`. Private state lives in `.branch/`, outside that workspace. Both directories are excluded from Git. Keep the session token private: it authorizes the local application's tools.

## Available now

- Conversations with persisted runs, tool traces and reported/estimated usage.
- Replies render as markdown: headings, lists, tables, links that open outside the app, and code blocks with a copy button and the language written out. Saved notes and document passages, which are one line each, keep the inline formatting (bold, italic, inline code, links). Nothing rendered anywhere can become markup.
- "Look inside" any task: every model round with its size and cost, every tool call with what went in and came back, its proof, the plan, the reviewer's verdicts and anything you said mid-task — and the whole thing saved as one file.
- Step into a task while it works: a live row with the current step and elapsed time, and Pause, "Tell it something" and Stop; a question it stops on is answered in the conversation itself.
- A quiet meter under the message box showing how much of the conversation's room has been used and roughly what it has cost, with the numbers behind it.
- Settings → Developer → Try things out: run one tool by hand with a form built from its own description, under your usual permission rules.
- Installable on a phone: the app's own files are kept on the device, with a clear banner when your computer cannot be reached. Never registered inside the desktop app.
- Labels come from a language file rather than being written into the page: the rail, the sections, the owner menu, the message box and every screen above are covered, with English as the source and a French machine draft alongside it. Dates and numbers follow the language you choose, and a missing translation falls back to English.
- Interactive terminal chat with provider streaming, interruption and in-place redirection.
- A native desktop window and tray, with Forest and Daylight appearances saved across restarts.
- Desktop model setup with a protected saved key and recovery from invalid settings.
- OpenAI-compatible and Anthropic provider adapters, plus ChatGPT plan sign-in through OpenAI's device-code route.
- Named model presets with a workspace default, per-conversation choice, thinking-effort control and ordered fallback with cooldowns; every run records the model that actually answered.
- Multi-provider support: built-in presets for Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Perplexity, xAI, Cerebras, and local Ollama and LM Studio; native Gemini adapter with streaming and tool calls; provider test endpoint and automatic local runtime detection.
- One-click updates from GitHub Releases with checksum verification, and `branch update` for source checkouts.
- Bounded retries for temporary provider failures, preserving completed tool work and attempt accounting.
- Workspace file tools, owner-scoped memory, versioned procedures and specialists.
- Full-text conversation search with bounded excerpts and links to source messages.
- Conversation branches from earlier messages, with separate subsequent histories.
- Searchable saved conversations with resume, duplication and JSON export/import.
- Editable memory facts with revision checks, per-owner capacity and JSON export/import.
- Saved facts stay tidy: repeats, newer facts that disagree with older ones and never-used facts are found and offered as suggestions you accept or reject; an accepted one is set aside where it can be brought back, never deleted.
- Facts are found by their words and, where the model offers it, by meaning, with the most useful facts first; JSON Lines export and import that never makes a second copy, and conversations saved as Markdown.
- A long conversation keeps a structured note of it — what we are doing, what was decided, what is still open, files touched — and any message you pin stays in front of the assistant.
- Show the assistant a picture when the model can look at one; a model that cannot says so plainly.
- A first-run setup that ends with a real test call: ChatGPT plan, API key or offline demonstration.
- A practice workspace of made-up files to try tools on safely, one click each way from your real folder; an unchangeable record of everything the assistant was allowed to do, saveable as a spreadsheet; approvals decided a kind of thing at a time; "ask me questions first" before a long task; issues from GitHub and Linear pulled into a task from their address, with a pull-request description that closes the issue; and a dependency-free client in `packages/sdk/` for scripts on this computer, with types generated from the app's own input checks.
- Temporary conversations that never enter search, the library or memory and are discarded when you move on.
- "Forget what this conversation saved": preview and remove a conversation's own memory facts, keep the ones you edited, and stop that conversation from saving again on its own.
- Projects with their own instructions, preferred model and secrets; switch the active project to change all three.
- A secrets locker: values are encrypted with a key kept outside the database, reach a program only as environment variables of a host command in the active project, are scrubbed from its output, and are never shown again.
- Say which secret without saying the secret: write `secret://project/NAME` anywhere a key is wanted, and the real value is only ever looked up at the moment of the call, then taken back out of every answer, log line, receipt and failure message. Replace a secret with the date recorded, be reminded before one goes stale, and see which task used which secret.
- Sign in to other services the ordinary way: their own page in your browser, the answer coming back only to this computer, the key straight into the locker, and renewed by itself when it runs out. Branch Agent never sees the password.
- Lock the app after a quiet spell: it keeps answering from what it knows but will not open the locker until you unlock it.
- Personal details — email addresses, phone numbers, card and bank numbers, national id numbers — are hidden in messages that leave this computer, and left exactly as they are in the files you ask it to read. An optional content check can hold a message back.
- Commands on Windows run inside a job the system itself polices: the memory and processor ceilings are real, and everything the command started is cleared up afterwards. An offline mode points ordinary tools at a dead address so they fail fast instead of reaching the internet.
- Approval rules with three ready-made settings — ask before changes, work freely in the workspace, or read only — plus a practice run that changes nothing and per-conversation pace limits.
- Terminal commands `/models`, `/model <id>` and `/think <level>` that the web view respects.
- Telegram channel: message your assistant from a direct chat or a group, each chat with its own conversation; strangers pair with a six-digit code you approve; groups answer when mentioned or replied to.
- Discord, Slack, WhatsApp and email too: the same pairing, the same approved-people list and the same waiting queue on every one. Discord and Slack hold a connection open and come back by themselves when it drops; WhatsApp sends to a web address it has signed; email is checked every minute and answered in the same email conversation. Each one says in the Channels screen whether it is connected, reconnecting, or needs you to look at it.
- Web search and page reading, guarded against local and private addresses; pin a skill to a conversation; archive or purge stale memory by age; a live list of the tools that exist right now.
- Voice input and output: record audio messages to transcribe, read messages aloud with browser voice or OpenAI-compatible text-to-speech.
- Talk to it and hear it back: hold the Talk button, speak, and the answer is read aloud. What you say can be written out by your provider, by Gemini, or by a speech program on this computer; replies can be read by a voice that comes with Windows, which needs no key and works offline. One switch keeps every recording on this computer, and voice notes on Telegram, Discord and WhatsApp are written out and answered like typed messages.
- Change the model mid-conversation with `/model`, and name your own routing profiles ("cheap and fast", "best quality", "private") that say which connection answers which kind of work, with fallbacks and a plain sentence saying why this model answered.
- Thirty-eight model services you might already pay for — OpenAI, Azure OpenAI, Anthropic, Gemini, Vertex AI, Mistral, Groq, OpenRouter, Together, Fireworks, DeepSeek, xAI, Perplexity, Cohere, Cerebras, SambaNova, Hugging Face, GitHub Models, Cloudflare, AWS Bedrock, Ollama, LM Studio, vLLM, llama.cpp, LocalAI, Jan, Moonshot, Zhipu, Qwen and more — written down as data rather than code, so pasting a key is the whole setup. Branch checks the key by using it before saving it, keeps it in the secrets locker, says what each service can and cannot do, and refuses to send picture or tool work to a model that cannot do it, naming one that can. Every service has been tested against a fake of itself, not against a live account.
- Long conversations keep going: older turns are folded into a handoff summary automatically, recent turns stay, and the full history remains saved.
- When the assistant needs your answer it stops and asks; a banner and a notification take you straight to that conversation.
- Installing and running on a Windows PC without any signed installer: an unsigned bootstrapper puts Branch in your own programs folder with Start menu and Add/Remove Programs entries, keeps the previous version, brings older data along, supports a fully portable copy, can start with Windows, can keep working with the window closed, and can be reached from your phone over Tailscale with a scan-and-type invitation.
- Installable single-file skills (SKILL.md) with retained versions, activation, rollback and disable; the model sees only skill metadata until it opens one.
- Configurable assistant name and working instructions, applied consistently within each task.
- Opt-in host commands with executable aliases, captured results and cancellation.
- Reliability for ordinary tasks: declared completion checks with bounded retries, stall detection for silent model calls and stuck tools, clipping and shrinking that keep long tasks inside the context limit, and Continue where it stopped after a restart without repeating anything.
- Teams, linked chats and registries: specialists can form a durable team with roles and a shared room; a Telegram chat can continue the very conversation open on your screen; skills can be installed from a registry you point at, fingerprint-checked and disabled until you activate them; a fixed evaluation suite measures accuracy, latency and cost; and after an interruption an action with an unknown outcome is not repeated until the assistant has checked.
- Skills that earn their place: a skill that keeps failing the same way is set aside and gets one trial later; one that fails too often is demoted; two versions can be benchmarked on the same tasks; a better version can be drafted from a task that went well; and once a day the assistant can look over what happened and suggest what to remember.
- Guardrails: host commands are stopped when they use too much memory or processor time; one network policy with host and path rules covers web reading, the browser and MCP servers; small hooks can run when things happen and switch themselves off if they keep failing; run events stream over REST, SSE or WebSocket; channels have a test message button.
- Memory that understands time and who may see it: facts about a person or thing can change over time and the assistant can answer what was true when; facts can be private, shared with specialists, or a specialist's own; each conversation has a switch for whether it may save memory on its own; old facts can be set aside and brought back.
- Reusable recipes and templates: recipes take named inputs that are checked before anything runs and can declare the shape their result must have; specialists and recipes travel between installs as templates that never carry secrets; each project can keep its files in its own folder.
- Works with other programs and keeps running: an OpenAI-style endpoint (`/v1/chat/completions`, `/v1/models`) and live event streams; type while a task is still working and the message waits its turn; specialists can keep working in the background; one-file backup and restore; a health check that says what is wrong and what to do; another app can start a task here through its own signed web address, and can be told when a task finishes, a schedule runs, or the assistant stops to ask you something.
- Works with other programs and keeps running: an OpenAI-style endpoint (`/v1/chat/completions`, `/v1/models`) and live event streams; type while a task is still working and the message waits its turn; specialists can keep working in the background; one-file backup and restore; a health check that says what is wrong and what to do.
- Sharing with other AI tools: another assistant on the same computer (Claude Desktop, Claude Code, Cursor) can ask Branch to do things, read its memory, workspace files and past conversations, and reuse its saved procedures — over the web address it already serves or by starting `branch mcp-serve`. Nothing is shared until you switch it on in Settings, you tick exactly which of Branch's own tools they may use (the ones that can change things start unticked), and every request they make is recorded in Activity with the same signed receipt as your own work.
- Working with assistants other people built: Branch can publish a card saying who it is and what it can be asked for, and take work from another assistant over the agent-to-agent protocol — every such task becomes an ordinary Branch task with the same signed receipts, and — once you have chosen an approval setting — is held to "Ask before changes" because you did not start it. It can hand a piece of work to an assistant elsewhere too, sending only the words of the task and never a file or a secret. Code editors such as Zed can start `branch acp-serve` and talk to it directly, with any step that needs your yes put to you in the editor. All of it is off until you switch it on.
- Undo and learning control: every file change the assistant makes keeps the bytes before it with a readable diff and an Undo button; whole-workspace snapshots restore every file exactly; memories keep every earlier version, can be checkpointed with skill versions and put back exactly; the assistant can suggest what to remember after each task and, if you choose, must wait for your approval before saving memories on its own.
- Trust: skills are scanned for pasted secrets, data-sending instructions and rule overrides before they can be enabled (block or review policy); every successful tool result carries a signed receipt that catches edited or invented results; web pages arrive in a provenance envelope with instruction-like lines flagged, removed or refused by policy; delegated tasks can carry exit criteria the runtime checks; and a live activity line shows what the assistant is doing right now.
- Version control in plain language: see what changed, look back through saved versions, keep separate lines of work, save a version, and keep an experiment in a parallel copy that stays inside the workspace — using the Git already on your computer, with a clear message when it is missing. Sending work to a server is off until you turn it on, and going straight to the branch everyone shares asks you first. GitHub, with a token you paste in, can make a private repository, open a pull request and work with issues; the token never appears in Activity, receipts or errors. A `.branchignore` file hides anything else you would rather the assistant left alone.
- A delivery ledger for chat channels: replies and scheduled results wait while a chat app is unreachable, go out in order after reconnect, never duplicate, and dead letters can be retried from Settings.
- Delegation to specialists with shared budgets, depth and concurrency limits, per-child timeouts, cancellation that reaches children, answers checked against a requested schema, and fan-out that runs independent tasks together and chains dependent ones.
- Working through a plan, and getting more than one specialist on a job: ask for a short numbered plan you can edit before anything is done, run several specialists at once on a share of the same budget, hand a piece of work to a named specialist, send a note to a task that is already working, have the answer checked by a reviewer before you see it, and see a plain "where we are" note on a long task. All of it is off until you switch it on.
- Schedules: once, on an interval, or every day at a time in your timezone; tasks, reminders, or monitoring checks that remember the last result; results can be sent to a Telegram chat; each schedule keeps its run history; webhooks and `branch trigger` run one on demand.
- Usage and observability: daily aggregated token and cost tracking, run timelines showing tool calls and model interactions, optional token/cost budgets with pause enforcement, and CSV export of usage reports.
- Costs in money, traces, and a privacy promise: real dollar estimates from a built-in price table you can correct, shown wherever tokens are shown and never as a made-up $0.00 for a model with no price on file; optional OpenTelemetry-shaped trace files written to a folder you choose; and a Diagnostics section that says Branch sends no usage data to anyone and saves a readable, secret-free folder you can share by hand.
- Your own documents: add notes, web pages, tables, Word files and spreadsheets from your workspace or by dropping them in, search them and see the exact passages that match, and let the assistant quote them when it answers — with a switch to turn that off. Passages are ranked by the words in them and, when your model connection offers it, also compared by meaning.
- Knowledge bases: give a name to whole folders of your work and have them read once, cut into passages that keep their headings and pages. A question then searches both ways at once — by the words you used and by what you meant — and every answer says which file, heading and page it came from. `knowledge.ask` reads the best passages and answers with numbered sources. Reading is done by whichever model you already connected, and a model on this computer keeps every word here.
- An app shell you can find your way around: one rail holds new conversation, search, every section as a row, your project folders and your conversations by day (rename, pin or take one off the list by hovering), with your own menu at the foot; the conversation reads as one column of messages where tool work is a quiet row you can open; the pane on the right tells you which model is answering, what is running, what the last tools actually did and what is in memory; Ctrl+K finds any section, conversation or action; and Appearance lets you set the theme (Forest, Daylight, or follow this computer), the highlight colour, text size, spacing, lettering, stillness and whether the acorn shows.
- Figures, looking things up, and the morning message: open a table from a file, an address or pasted text and see what is in it, ask it questions in plain SQL, draw it as a simple picture and save it back as a spreadsheet; look a question up properly across several pages and get a numbered report with the quotes it rests on and where the sources disagree; watch a page or a search and be told in plain words what changed; and one message first thing that gathers what is planned, what is unfinished, what arrived and what changed.
- Looking through and changing code: list files by pattern, search inside them with the lines around each match, find a file from part of its name, and see a short map of what each file holds. Changes are exact — a set of changes either fits every file perfectly or nothing is written, an ambiguous text replacement is refused rather than guessed, and every changed file can still be undone one by one. A `.branchignore` (or your `.gitignore`) keeps files out of all of it.
- Skills people can actually share, and plugins for developers: save a skill as one file and hand it to someone, or open one you were sent and see exactly what it asks for before anything is installed — including the web addresses it may call and which of your saved secrets it would use, with those secret values never shown to the model. Registries can sign what they publish, tell you when a newer version exists, and let you take it in one step and go back if it is worse. Branch can draft a better version of a skill from several tasks that went well, run a skill's own examples and report how they went, and point out skills you already have, switched off, whose words match your recent work. Developers can add tools and event handlers with a single plugin file that stays off until you switch it on.
- Models that run on this computer: Branch looks at your memory, processor and graphics card and suggests a model size that will actually feel right, downloads it with a progress bar, shows what each one is and removes the ones you are done with, and works with LM Studio too. You can have it choose task by task — a note with personal details in it stays on this computer, a long fiddly job goes to the cloud model, and a simple job uses the free one here rather than paying for it.
- Pictures, sound and what a video says about itself: ask for a picture and get one back (or hand it one of yours to change), have it look at a picture and describe it, read out the words in it or write out a table it holds, write out what is said in a recording with the times, read text aloud into a sound file, and trim a WAV clip — all through whichever model you connected, with a plain refusal when that model cannot do the job. Attach pictures and sound files straight onto the message box, and find everything the assistant has made under Documents. It does not make videos and cannot pull still frames out of one; it says so and tells you how long the video runs instead.
- Optional MCP tools and browser automation through explicit configuration.
- Browser work a non-technical owner can trust: sign in to a website once by hand and Branch stays signed in (the cookies are encrypted on this computer and it never sees your password); screenshots with every password box blacked out first, shown to models that can look at pictures; waiting, pulling rows out of tables, sending one of your files to a page and keeping files a page sends in `downloads/`; tabs and message boxes handled; and a per-task cap on actions and on how many websites one task may open.
- Using this computer's screen and keyboard, only when you switch it on: Branch can photograph a window, list what is in it by name, press its buttons, type into its boxes, press a key, start a program and use the clipboard. The switch is off out of the box, each action stops and asks under "Ask before changes", a notice with a Stop button sits on top of everything while it works, there is a cap on how much one task may do, password managers and sign-in windows are never photographed or typed into, and every action is written down with the name of the window it touched.
- Sharing, things that run themselves, and people who share the computer: save a conversation as one read-only page with anything that looks like a key blanked out and a receipt of exactly what went out, or hand out a link this app serves itself that needs a code, works once and expires; stick labels on conversations, procedures and documents and filter by them; write notes against a project; save a list of steps the app works through on its own, with second tries, a pause for your approval and a pick-up-where-it-stopped after a restart (a Weekly review ships ready to run); let tasks wait their turn in a line instead of being turned away, with what you asked for going first; tell schedules to skip a holiday or move to the next working day, and hold messages until quiet hours are over; and give a family member their own name and PIN so their conversations stay theirs and your secrets stay yours.
- Separate Python accounting and released neural-model experiments.

Provider protocol fixtures and local tests do not establish live account readiness. Procedure checks establish their explicit assertions; they do not establish general intelligence or unrestricted self-improvement.

## Development checks

```sh
npx playwright install chromium --only-shell
npm test
python -m unittest discover -s experiments -p 'test_*.py'
npm run doctor
```

See [architecture](docs/architecture.md), [experiments](docs/experiments.md), and [contributing](CONTRIBUTING.md).

## The idea

Give Branch Agent an outcome. Branch Agent should organize the work, select suitable tools and specialists, and bring their results back into one conversation.

For example, a request to build a website could involve design, implementation, testing, and deployment. Branch Agent's role would be to coordinate those steps, respect the access you grant, and verify the result.

## What we want to build

- **One assistant, extensible capabilities.** Add tools and specialist agents through documented interfaces.
- **Teams assembled for the task.** Create or reuse specialists when they improve the outcome.
- **Learning with evidence.** Turn useful experience into reusable procedures, and test changes before relying on them.
- **Controlled access.** Keep credentials outside model conversations and grant access only where needed.
- **Efficient execution.** Load relevant context on demand and measure the total cost of successful work.
- **Tools kept in labelled boxes.** Only the tools a task plausibly needs are described to the model each round; the rest cost one line until they are opened.
- **Reliable upgrades.** Check compatibility before activating updated components, with a way to return to a working version.
- **Proof it still works.** Ready-made sets of tasks you can run at any time to see how many the assistant gets right, how long it takes, what it costs, and whether anything that used to work has stopped.
- **Traces you can read, rules you can read.** Every task keeps the shape of what it did, and you can send those to a tracing tool of your own — nothing is ever collected about you or sent to us. Permission rules can be about one folder, one website or one command, and are shown as plain sentences you can try out before saving.

These describe the broader direction. Consult the feature inventory for each implementation's current scope.

## Get involved

Contributions can expand the capability inventory, improve task reliability, or supply representative evaluation cases.

- Start a [discussion](https://github.com/stabrea/Branch-Agent/discussions) about use cases or design decisions.
- Open an [issue](https://github.com/stabrea/Branch-Agent/issues) with a concrete proposal.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.
- See [ROADMAP.md](ROADMAP.md) for the proposed milestones.

## License

Branch Agent is licensed under the [MIT License](LICENSE). You may use, modify, distribute, and sell the software, including as part of a commercial product, subject to the license's notice requirements.
