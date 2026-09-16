# Branch Agent

An open-source personal assistant designed to assemble the capabilities you need, coordinate specialist agents, and improve through verified experience.

**Status: early implementation.** The local runtime, web interface and offline demonstration run today. The complete requested capability set remains in development; see the [feature inventory](docs/features.md) for evidence and gaps.

## Install the Windows app

Download `Branch-Agent-windows-x64.zip` from the [latest release](https://github.com/stabrea/Branch-Agent/releases/latest), unzip it anywhere, and start `Branch Agent.exe`. Open **Settings → ChatGPT account** to sign in with your ChatGPT plan, or **Settings → Model connection** to use an API key. **Settings → Updates** checks GitHub for a newer release and installs it with one click after verifying the published checksum.

## Run locally

Requires Node.js 24 and npm. Python 3.12 is optional for experiments.

```sh
npm ci
npm run demo
npm start
```

Sign in with a ChatGPT plan from the terminal with `node dist/cli.js login` (`logout` removes it). A source checkout updates itself with `node dist/cli.js update`. After `npm link`, the same commands are available as `branch chat`, `branch login` and `branch update`.

For an interactive terminal conversation, run `npm run chat`. Text streams as the provider sends it. Press Ctrl+C or type a revised request to interrupt the current task and continue the same conversation. `/new` starts a new conversation; `/exit` closes the terminal assistant.

For the native desktop application:

```sh
npm run desktop
```

It opens an authenticated native window automatically. Closing the window keeps the assistant in the tray; use **Quit** in the tray menu to stop it. To create a portable application folder for your current operating system, run `npm run package:desktop`. Windows packaging has been exercised locally; other platforms require their own verification. The packaged app updates itself from GitHub Releases; installers and code signing are pending.

In **Settings → ChatGPT account**, sign in on OpenAI's website with a short code to use the models that come with your ChatGPT plan; the sign-in is kept under the device's key protection and Branch identifies itself as Branch Agent. In **Settings → Model connection**, select a provider and enter its API base URL, model identifier and key. Quit and reopen to apply an API-key connection. Explicit launch environment configuration takes precedence.

Open the local address printed by `npm start` and paste its session token. The default provider is a deterministic demonstration that writes, reads and verifies a greeting. It does not interpret arbitrary requests. Configure a language model using [configuration.md](docs/configuration.md) for general assistance.

The tool workspace defaults to `workspace/`. Private state lives in `.branch/`, outside that workspace. Both directories are excluded from Git. Keep the session token private: it authorizes the local application's tools.

## Available now

- Conversations with persisted runs, tool traces and reported/estimated usage.
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
- A first-run setup that ends with a real test call: ChatGPT plan, API key or offline demonstration.
- Temporary conversations that never enter search, the library or memory and are discarded when you move on.
- "Forget what this conversation saved": preview and remove a conversation's own memory facts, keep the ones you edited, and stop that conversation from saving again on its own.
- Projects with their own instructions, preferred model and secrets; switch the active project to change all three.
- A secrets locker: values are encrypted with a key kept outside the database, reach a program only as environment variables of a host command in the active project, are scrubbed from its output, and are never shown again.
- Terminal commands `/models`, `/model <id>` and `/think <level>` that the web view respects.
- Telegram channel: message your assistant from a direct chat or a group, each chat with its own conversation; strangers pair with a six-digit code you approve; groups answer when mentioned or replied to.
- Web search and page reading, guarded against local and private addresses; pin a skill to a conversation; archive or purge stale memory by age; a live list of the tools that exist right now.
- Voice input and output: record audio messages to transcribe, read messages aloud with browser voice or OpenAI-compatible text-to-speech.
- Long conversations keep going: older turns are folded into a handoff summary automatically, recent turns stay, and the full history remains saved.
- When the assistant needs your answer it stops and asks; a banner and a notification take you straight to that conversation.
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
- Undo and learning control: every file change the assistant makes keeps the bytes before it with a readable diff and an Undo button; whole-workspace snapshots restore every file exactly; memories keep every earlier version, can be checkpointed with skill versions and put back exactly; the assistant can suggest what to remember after each task and, if you choose, must wait for your approval before saving memories on its own.
- Trust: skills are scanned for pasted secrets, data-sending instructions and rule overrides before they can be enabled (block or review policy); every successful tool result carries a signed receipt that catches edited or invented results; web pages arrive in a provenance envelope with instruction-like lines flagged, removed or refused by policy; delegated tasks can carry exit criteria the runtime checks; and a live activity line shows what the assistant is doing right now.
- Version control in plain language: see what changed, look back through saved versions, keep separate lines of work, save a version, and keep an experiment in a parallel copy that stays inside the workspace — using the Git already on your computer, with a clear message when it is missing. Sending work to a server is off until you turn it on, and going straight to the branch everyone shares asks you first. GitHub, with a token you paste in, can make a private repository, open a pull request and work with issues; the token never appears in Activity, receipts or errors. A `.branchignore` file hides anything else you would rather the assistant left alone.
- A delivery ledger for chat channels: replies and scheduled results wait while a chat app is unreachable, go out in order after reconnect, never duplicate, and dead letters can be retried from Settings.
- Delegation to specialists with shared budgets, depth and concurrency limits, per-child timeouts, cancellation that reaches children, answers checked against a requested schema, and fan-out that runs independent tasks together and chains dependent ones.
- Schedules: once, on an interval, or every day at a time in your timezone; tasks, reminders, or monitoring checks that remember the last result; results can be sent to a Telegram chat; each schedule keeps its run history; webhooks and `branch trigger` run one on demand.
- Usage and observability: daily aggregated token and cost tracking, run timelines showing tool calls and model interactions, optional token/cost budgets with pause enforcement, and CSV export of usage reports.
- Your own documents: add notes, web pages, tables, Word files and spreadsheets from your workspace or by dropping them in, search them and see the exact passages that match, and let the assistant quote them when it answers — with a switch to turn that off. Passages are ranked by the words in them and, when your model connection offers it, also compared by meaning.
- Optional MCP tools and browser automation through explicit configuration.
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
- **Reliable upgrades.** Check compatibility before activating updated components, with a way to return to a working version.

These describe the broader direction. Consult the feature inventory for each implementation's current scope.

## Get involved

Contributions can expand the capability inventory, improve task reliability, or supply representative evaluation cases.

- Start a [discussion](https://github.com/stabrea/Branch-Agent/discussions) about use cases or design decisions.
- Open an [issue](https://github.com/stabrea/Branch-Agent/issues) with a concrete proposal.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.
- See [ROADMAP.md](ROADMAP.md) for the proposed milestones.

## License

Branch Agent is licensed under the [MIT License](LICENSE). You may use, modify, distribute, and sell the software, including as part of a commercial product, subject to the license's notice requirements.
