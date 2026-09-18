# React hooks for Branch Agent

Hooks around the plain client in `packages/sdk`, for a page of your own that talks to the copy of
Branch Agent running on this computer. The package has no dependencies: React is your page's own
(a peer dependency, React 18 or later), and nothing is published anywhere.

```sh
npm install /path/to/Branch-Agent/packages/sdk /path/to/Branch-Agent/packages/sdk-react
```

```jsx
import { BranchClient } from "@branch-agent/sdk";
import { BranchProvider, useBranchGet, useBranchRun } from "@branch-agent/sdk-react";

const client = new BranchClient({ url: "http://127.0.0.1:3210", token: sessionKey });

function Task() {
  const { start, cancel, events, output, status } = useBranchRun();
  const { data: health } = useBranchGet("/api/health", { everyMs: 10000 });
  return (
    <section>
      <p>{health?.ok ? "Branch is well" : "Checking Branch…"}</p>
      <button onClick={() => start("Summarise my meeting notes")}>Start</button>
      <button onClick={cancel}>Stop</button>
      <p>{status}: {events.length} steps</p>
      <pre>{output}</pre>
    </section>
  );
}

export const App = () => <BranchProvider client={client}><Task /></BranchProvider>;
```

| Hook | What it gives |
| --- | --- |
| `BranchProvider` | puts one client within reach of everything below it |
| `useBranch()` | that client, for any call (`branch.post(...)`, `branch.runs.steer(...)`) |
| `useBranchGet(path, { everyMs })` | `{ data, error, loading, refresh }`; pass `null` to read nothing yet |
| `useBranchRun()` | `{ runId, status, events, output, error, start, steer, cancel }` |

A page that has React under another name, or several copies, builds the hooks itself:
`import { createBranchHooks } from "@branch-agent/sdk-react/hooks"` and
`createBranchHooks(React)`. `createRunStore(client)` is the same task-following logic with no React
at all.

The session key is the whole of the app's security: keep it out of any page served to other people.

**Where the hooks can run.** Branch answers only requests addressed to itself and refuses any web
page on another address (`src/server.ts`, `hostAllowed`), and that is not loosened for this package.
So the hooks work in a desktop app (Electron), React Native, a page rendered on a server, or a
page in development behind a proxy that forwards to `127.0.0.1:3210` without passing on the
page's own `Origin`. A page opened from another web address in a browser is refused on purpose.

Tests: `node --test tests/sdk-react.test.mjs` (a small stand-in React, plus a real Branch Agent).
