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

### Conversation branches

Open a historical message in **Memory**, then choose **Branch from here** to create a separate conversation through that message. **Open conversation** resumes the existing conversation instead. The branch shows its copied messages and lets you return to the original. Branching and conversation switches wait for an in-progress reply to finish.

A branch copies conversation history only. Workspace files and saved memory remain shared. Earlier tool results are retained as historical evidence; creating the branch does not execute those tools again. Later messages stay in their respective conversations, and the parent relationship persists across restarts.

Branch points must be user messages or assistant replies without tool requests. A prefix containing unfinished tool requests is rejected rather than silently repaired or replayed. Copying is atomic and limited to 1000 messages or 4 MiB through the selected point; choose an earlier point for a larger conversation. Model context and run budgets still apply when continuing the branch.

The `sessions.branch` tool requires both `sessions.branch` and `history.read` permissions. Its input is `{ "sessionId": "...", "messageId": 123 }`, using the stable message identifier returned by history retrieval. The authenticated `GET /api/sessions/{sessionId}` route returns the owner's messages and branch origin. If the interface cannot load a newly created branch, it retains the new ID and offers a retry without creating another branch.

## Persistence and schedules

`npm run chat` opens a streaming terminal session using the same provider, workspace, private state and integration variables. Ctrl+C or `/cancel` cancels the active run and returns to the prompt; a new request typed during execution cancels and drains that run before continuing the same conversation. `/new` starts a new conversation, and `/exit` shuts down. Partial text displayed before a cancelled/failed stream remains uncommitted; received provider usage and estimates still contribute to that run's accounting. Streaming is currently exposed through the terminal; the web/desktop conversation waits for the final result.

Run only one Branch Agent process per data directory. SQLite stores conversations, memory, procedures, specialists and schedules. Schedules execute while the process is running. Missed interval occurrences coalesce into one execution. Interrupted or failed tasks are recorded; external side effects are not automatically retried.

Local HTTP authorization is single-owner access, not a multi-user tenancy system. Built-in file restrictions are not an operating-system sandbox for separately configured programs.
