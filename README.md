# Branch Agent

An open-source personal assistant designed to assemble the capabilities you need, coordinate specialist agents, and improve through verified experience.

**Status: early implementation.** The local runtime, web interface and offline demonstration run today. The complete requested capability set remains in development; see the [feature inventory](docs/features.md) for evidence and gaps.

## Run locally

Requires Node.js 24 and npm. Python 3.12 is optional for experiments.

```sh
npm ci
npm run demo
npm start
```

For an interactive terminal conversation, run `npm run chat`. Text streams as the provider sends it. Press Ctrl+C or type a revised request to interrupt the current task and continue the same conversation. `/new` starts a new conversation; `/exit` closes the terminal assistant.

For the native desktop application:

```sh
npm run desktop
```

It opens an authenticated native window automatically. Closing the window keeps the assistant in the tray; use **Quit** in the tray menu to stop it. To create a portable application folder for your current operating system, run `npm run package:desktop`. Windows packaging has been exercised locally; other platforms require their own verification. Installers, signing and automatic updates are pending.

In desktop **Settings → Model connection**, select a provider and enter its API base URL, model identifier and key. The key is stored using the device's key protection. Quit and reopen to apply the connection. Explicit launch environment configuration takes precedence.

Open the local address printed by `npm start` and paste its session token. The default provider is a deterministic demonstration that writes, reads and verifies a greeting. It does not interpret arbitrary requests. Configure a language model using [configuration.md](docs/configuration.md) for general assistance.

The tool workspace defaults to `workspace/`. Private state lives in `.branch/`, outside that workspace. Both directories are excluded from Git. Keep the session token private: it authorizes the local application's tools.

## Available now

- Conversations with persisted runs, tool traces and reported/estimated usage.
- Interactive terminal chat with provider streaming, interruption and in-place redirection.
- A native desktop window and tray, with Forest and Daylight appearances saved across restarts.
- Desktop model setup with a protected saved key and recovery from invalid settings.
- OpenAI-compatible and Anthropic provider adapters.
- Workspace file tools, owner-scoped memory, versioned procedures and specialists.
- Full-text conversation search with bounded excerpts and links to source messages.
- Opt-in host commands with executable aliases, captured results and cancellation.
- Restricted delegation with shared step/token limits and cancellation.
- One-time and interval schedules while Branch Agent is running.
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
