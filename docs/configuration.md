# Configuration

## Model provider

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

## Persistence and schedules

Run only one Branch Agent process per data directory. SQLite stores conversations, memory, procedures, specialists and schedules. Schedules execute while the process is running. Missed interval occurrences coalesce into one execution. Interrupted or failed tasks are recorded; external side effects are not automatically retried.

Local HTTP authorization is single-owner access, not a multi-user tenancy system. Built-in file restrictions are not an operating-system sandbox for separately configured programs.
