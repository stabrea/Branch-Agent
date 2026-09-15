# Configuration

## Model provider

### Desktop settings

The native app includes **Settings → Model connection** for selecting `demo`, `openai` or `anthropic`, the API base URL, model identifier and API key. Save, quit from the tray, and reopen to apply changes. Saving does not contact the provider; the next assistant task uses the selected connection.

Keys are protected using Electron's OS-backed key storage in `model-settings.json` beneath the desktop user-data directory. The settings API reports only whether a key exists. Leave the key field blank to retain it for the exact same provider and endpoint; changing either requires entering a key. Selecting the offline demonstration removes the saved key. This protection does not isolate a credential from every other process running as the same OS user.

If key protection is unavailable, the app declines to save new keys. If an existing connection cannot be read or unlocked, the app opens in demonstration mode with a recovery notice so it can be replaced in Settings. Linux's `basic_text` fallback is not used for storing keys.

An explicitly set `BRANCH_PROVIDER` makes launch environment configuration authoritative and disables saving model settings in the GUI. The other model variables then come from that environment. Remove `BRANCH_PROVIDER` to use the saved desktop connection.

### Launch environment

The application reads environment variables when it starts. It does not automatically load `.env` files. Set variables in the launching shell or your process manager.

| Variable | Meaning |
| --- | --- |
| `BRANCH_PROVIDER` | `demo` (default), `openai`, or `anthropic` |
| `BRANCH_ENDPOINT` | API base URL, for example `https://api.openai.com/v1` or `https://api.anthropic.com/v1` |
| `BRANCH_MODEL` | Model identifier accepted by that endpoint |
| `BRANCH_API_KEY` | API credential; keep outside source control |
| `BRANCH_WORKSPACE` | Directory exposed to built-in file tools; default `workspace` |
| `BRANCH_DATA_DIR` | Private database/token directory; default `.branch`, outside the workspace |
| `BRANCH_PORT` | Local web port, default `3210`; `0` selects an available port |
| `BRANCH_INTEGRATIONS` | Path to a trusted integration configuration JSON file |
| `BRANCH_MODEL_PRESETS` | Optional JSON list of named model presets (see below); overrides the single-provider variables |

### Model presets

Several models can be configured at once. Each preset names a provider, endpoint and model, and the environment variable that holds its key, so keys never enter the settings database:

```json
[
  { "id": "fast", "name": "Fast", "provider": "openai", "endpoint": "https://api.openai.com/v1", "model": "gpt-5-mini", "apiKeyEnv": "OPENAI_API_KEY" },
  { "id": "careful", "name": "Careful", "provider": "anthropic", "endpoint": "https://api.anthropic.com/v1", "model": "claude-sonnet-5", "apiKeyEnv": "ANTHROPIC_API_KEY", "reasoning": "high" }
]
```

The first preset is the default. **Settings → Models** chooses the workspace default, the default thinking effort (`low`, `medium`, `high`), the fallback order and how long a failed model rests. Each conversation can pick its own model and thinking effort above the composer. When a model answers with a retryable error (429, 5xx, connection failure) after its retries, Branch rests it for the cooldown and continues with the next preset in order; authentication and quota errors do not fall back. Every run records the preset that actually answered.

### ChatGPT plan sign-in

`node dist/cli.js login` (or **Settings → ChatGPT account** in the app) starts OpenAI's device-code sign-in: open the shown page, enter the code, and Branch receives tokens that are stored in `chatgpt-auth.json` inside the data directory, protected with the device key in the desktop app. Signing in registers `ChatGPT · GPT-5.5`, `GPT-5.6` and `GPT-5.4` presets and makes ChatGPT the default when the workspace was still on the offline demonstration. Requests carry the `originator: branch-agent` header and a `BranchAgent/<version>` user agent. Access through a ChatGPT plan is provided by OpenAI for its own tools and may change without notice.

### Updates

The packaged Windows app checks `https://api.github.com/repos/stabrea/Branch-Agent/releases/latest`, downloads `Branch-Agent-windows-x64.zip`, verifies it against the published `.sha256`, unpacks it next to the install, then restarts through a small script that mirrors the new files into place. A checkout installed from Git updates with `node dist/cli.js update` (`git pull --ff-only`, `npm ci`, `npm run build`).

The `openai` adapter uses Chat Completions; the `anthropic` adapter uses Messages. Compatibility depends on the configured server implementing the expected request, tool-call and usage formats. Remote model endpoints require HTTPS; loopback endpoints may use HTTP. API usage may incur the provider's charges.

### Temporary provider failures

Branch retries eligible failed model requests at most twice per model round. It waits 250 ms before the first retry and 500 ms before the second by default, honors a valid `Retry-After` minimum, and stops if the requested wait exceeds five seconds. Backoff can be cancelled. The configured provider, model and credential remain unchanged.

Only identified transient HTTP failures qualify. Authentication, permission, validation, recognized quota/billing failures, malformed completion responses and partial streams are not automatically retried. Ambiguous 429 responses without a usable retry hint remain failures. This distinction follows the providers' error categories: a 429 can mean a rate limit or an exhausted spending allowance. See [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes) and [Claude API errors](https://platform.claude.com/docs/en/api/errors).

Error-body classification is limited to 16 KiB and one second; raw provider error messages are not retained. An incomplete 429 classification does not qualify for a retry. Retry hints support nonnegative whole seconds and standard GMT HTTP dates; an unsupported or malformed hint stops automatic retry instead of triggering an earlier request.

Retries repeat the model request with its existing conversation and completed tool results. They do not rerun completed tools. Every attempt remains in the usage ledger and shares the run's step/token budget; missing provider usage remains explicitly unknown. The Activity view records scheduled retries, and the terminal displays the retry number and wait.

SDK callers can pass `retryPolicy` to `createBranch`: `maxRetries` accepts 0–2, and `baseDelayMs`/`maxDelayMs` accept 0–5000 with the base no larger than the maximum. Set `retryPolicy: { maxRetries: 0 }` to disable automatic retries. The desktop and CLI use the defaults above.

## Browser tools

Browser pages are isolated by owner and run. A multi-step navigation/fill/click workflow must occur within one run. Contexts close when that run completes; separate manual tool actions do not share a page. Up to eight contexts are permitted by default (`maxRuns` can set a limit up to 30).

Install the browser once:

```sh
npx playwright install chromium --only-shell
```

Create a configuration file, then set `BRANCH_INTEGRATIONS` to its path:

```json
{
  "browser": {
    "allowedOrigins": ["https://example.com"]
  }
}
```

Origins must match exactly, including port. Browser requests to other origins, HTTP redirects, downloads, WebSockets and service workers are blocked. Redirecting sites may therefore fail even when the final destination is otherwise allowed. Browser fill supports non-password fields; credentials need a dedicated integration. This browser uses a fresh profile, not your existing signed-in browser.

## Host command execution

Enable `shell.execute` by adding a `shell` section to the trusted integration JSON:

```json
{
  "shell": {
    "executables": {
      "node": { "path": "C:/Program Files/nodejs/node.exe" },
      "npm": {
        "path": "C:/Program Files/nodejs/node.exe",
        "args": ["C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"]
      }
    },
    "inheritEnv": ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH"],
    "timeoutMs": 30000,
    "maxOutputBytes": 8192
  }
}
```

Use actual absolute executable paths on your device. Windows `.cmd` and `.bat` launchers are not accepted; the npm example invokes its JavaScript entry point through Node. Arguments are passed as an array without shell expansion. For example, `{"executable":"npm","args":["test"],"cwd":"website"}` runs the configured alias in the workspace's `website` directory. `shell.execute` is a separate permission for delegated specialists.

This runs trusted programs on your computer. The checked working directory is not an OS sandbox: programs can access other files, use the network, and launch more programs. Only selected environment keys are passed; model and vault variables are excluded. `PATH` is empty unless explicitly selected as above. Runtime code supplied to an interpreter still has that interpreter's host access.

Only one foreground command runs at a time. Results include stdout, stderr, exit status, elapsed time, target and cleanup status. The default timeout is 30 seconds; configuration can allow up to 120 seconds, and individual calls can lower it. Captured output is capped at 8 KiB or the lower configured limit. Cancellation requests process-tree termination on Windows or process-group termination on POSIX. Escaped descendants can survive; the result records incomplete cleanup when observed. Interactive terminals, persistent background jobs and remote execution are separate pending capabilities.

## MCP tools

MCP supplies external tools through the official SDK. Configure exact server versions and explicit tool names:

```json
{
  "mcp": [
    {
      "id": "local-tools",
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/your-server.js"],
      "envKeys": [],
      "tools": ["lookup"],
      "expectedVersion": "1.0.0"
    }
  ]
}
```

For an HTTP server:

```json
{
  "mcp": [
    {
      "id": "remote-tools",
      "transport": "http",
      "url": "https://your-server.example/mcp",
      "bearerEnv": "MY_MCP_TOKEN",
      "tools": ["lookup"],
      "expectedVersion": "1.0.0"
    }
  ]
}
```

These are configuration examples, not supplied servers. Use the actual version and tool names advertised by your server. A mismatch prevents startup. Stdio programs are trusted executable code and are not sandboxed by the MCP connector. Only explicitly selected credential environment variables are passed in addition to SDK platform defaults. HTTP redirects are rejected.

The connector implements tool discovery and invocation. MCP resources, prompts, sampling and other assistants' internal learning or memory are separate capabilities. Newly advertised tools are not automatically granted.

## Conversation search

In **Memory → Search past conversations**, enter keywords and choose whether all or any must match. Results show an excerpt and the originating conversation's start time; **Read message** opens the source, with additional pages for long messages.

The assistant can use `history.search` and `history.read` with the separate `history.read` permission. Search uses a local SQLite full-text index over your user and assistant messages, with case-insensitive and Latin diacritic-insensitive matching. It excludes tool payloads, system instructions, other owners and the model's active conversation. Manual source reads from the interface use a separate audited action. Past messages are evidence to inspect, not new instructions.

Results are bounded and retrieved when requested; the feature does not automatically insert every conversation into the model prompt. No embedding service or extra dependency is required. Full-text retrieval alone does not establish a measured token saving.

### Saved conversations

The **Saved conversations** panel in Conversation lists recent histories and searches their user/assistant text using a case-insensitive literal substring. Results load 20 at a time. Open resumes that history; Duplicate creates a separate copy of the complete history. Later messages in a copy do not change the original. Files and saved memory remain shared.

Export saves a versioned JSON conversation archive. Import reads that archive into a new conversation without running recorded tools. Imported history is external content, not verified evidence that its claimed actions occurred. Import provenance remains visible in later copies and branches. Archives preserve message content and completed tool results; they do not transfer permissions, account credentials, execution logs, files or memory. Transcript text may itself contain sensitive information.

Archives support up to 1000 messages and 4 MiB of UTF-8 JSON. Unsupported versions, system-role instructions, malformed message fields and unmatched tool requests/results are rejected before writing. Recorded tool arguments must parse as JSON objects so provider adapters can resume them. An active source task must finish before export or duplication. Model context and run budgets still apply to a resumed history.

Authenticated library routes are `POST /api/sessions/search` with `{ "query": "", "offset": 0 }`, `GET /api/sessions/{id}/export`, `POST /api/sessions/{id}/duplicate` with `{}`, and `POST /api/sessions/import` with the archive itself. Conversation import accepts up to 4 MiB; memory import accepts up to 16 MiB. Other JSON endpoints retain their 64 KiB request limit. Empty manual-action sessions are excluded from the conversation list.

### Branch from a message

Open a historical message in **Memory**, then choose **Branch from here** to create a separate conversation through that message. **Open conversation** resumes the existing conversation instead. The branch shows its copied messages and lets you return to the original. Branching and conversation switches wait for an in-progress reply to finish.

A branch copies conversation history only. Workspace files and saved memory remain shared. Earlier tool results are retained as historical evidence; creating the branch does not execute those tools again. Later messages stay in their respective conversations, and the parent relationship persists across restarts.

Branch points must be user messages or assistant replies without tool requests. A prefix containing unfinished tool requests is rejected rather than silently repaired or replayed. Copying is atomic and limited to 1000 messages or 4 MiB through the selected point; choose an earlier point for a larger conversation. Model context and run budgets still apply when continuing the branch.

The `sessions.branch` tool requires both `sessions.branch` and `history.read` permissions. Its input is `{ "sessionId": "...", "messageId": 123 }`, using the stable message identifier returned by history retrieval. The authenticated `GET /api/sessions/{sessionId}` route returns the owner's messages and branch origin. If the interface cannot load a newly created branch, it retains the new ID and offers a retry without creating another branch.

## Memory facts

### Assistant identity

In **Settings**, set an assistant name and working instructions. The application remains named Branch Agent. Saving applies the identity to the next task, including the next turn in an existing conversation. A task already running keeps its starting identity through every model call and retry. Tool permissions remain unchanged.

Names are limited to 80 characters and instructions to 4000. Defaults are **Branch Agent** and empty instructions. The settings persist for the workspace owner. Concurrent edits use revision checks: a conflict keeps your draft, and **Reload saved identity** explicitly discards it to load current values. Background refreshes preserve unsaved text and focus; save/reload temporarily disable the form.

`POST /api/identity` accepts `{ "name": "Juniper", "instructions": "Keep answers concise", "expectedRevision": 0 }`. The authenticated state response exposes the current identity and revision. Every model-backed task records an `identity.applied` event containing its name and revision. Configured instructions count toward normal context/token limits; unchanged defaults add no extra identity block.

### Stored facts

In **Memory**, edit a fact and its source, then save the correction. Each editor retains the revision it opened; if another write changes that fact, saving reports a conflict and keeps your draft. Cancel reloads the latest saved value. Editors retain focus and cursor selection during background refreshes.

Each owner has a persistent capacity of 1–500 facts, defaulting to 500. The Memory panel displays the count and lets you change the limit. New additions and imports that exceed it are rejected; existing facts can still be corrected or deleted. Lowering the limit below the current count is rejected. Older databases migrate without dropping records, including whitespace-only facts accepted by earlier versions. Legacy stores above 500 keep their records, but require reducing their count before bounded export or new additions.

The `memory.update` tool requires `memory.write` and accepts `{ "id": "...", "text": "Corrected fact", "source": "Owner correction", "expectedRevision": 1 }`. Search returns the current revision. `memory.search` requires `memory.read` and returns up to 20 matching facts within 48 KiB of UTF-8 JSON. Queries use normalized, case-insensitive literal matching. A future model session sees a correction when it retrieves the fact through this tool.

**Export memory JSON** saves fact IDs, text, sources, source-run references, creation/update times and revisions. **Import memory JSON** merges the archive into the current owner: exact matching records are unchanged, new IDs are added, and a conflicting ID aborts the entire import. Archived source references are descriptive metadata and do not grant access to another owner's runs. Capacity settings are managed separately. These archives support up to 500 records and 16 MiB; malformed archives and unsupported versions are rejected.

The authenticated routes are `GET /api/memory/export`, `POST /api/memory/import` with the archive, and `POST /api/memory/capacity` with `{ "maxFacts": 500 }`. Desktop exports use a native Save dialog with a validated archive; browser exports download a JSON file.

## Persistence and schedules

`npm run chat` opens a streaming terminal session using the same provider, workspace, private state and integration variables. Ctrl+C or `/cancel` cancels the active run and returns to the prompt; a new request typed during execution cancels and drains that run before continuing the same conversation. `/new` starts a new conversation, and `/exit` shuts down. Partial text displayed before a cancelled/failed stream remains uncommitted; received provider usage and estimates still contribute to that run's accounting. Streaming is currently exposed through the terminal; the web/desktop conversation waits for the final result.

Run only one Branch Agent process per data directory. SQLite stores conversations, memory, procedures, specialists and schedules. Schedules execute while the process is running. Missed interval occurrences coalesce into one execution. Interrupted or failed tasks are recorded; external side effects are not automatically retried.

Local HTTP authorization is single-owner access, not a multi-user tenancy system. Built-in file restrictions are not an operating-system sandbox for separately configured programs.
