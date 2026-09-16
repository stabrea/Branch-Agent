# The Branch Agent client

A single file of plain JavaScript for talking to the copy of Branch Agent running on this
computer. It installs nothing, depends on nothing, and is not published anywhere: point an
`import` at the file and it works.

```js
import { BranchClient } from "../packages/sdk/client.mjs";
```

TypeScript users get types from `types.d.ts`, which is generated from the app's own input checks
by `node scripts/generate-sdk-types.mjs` — so what the types say a request may contain is what the
app will actually accept. Run the generator again after changing a schema in `src/`.

## Connecting

Branch Agent listens only on this computer's own address and requires the local session key it
wrote into its data folder the first time it started.

```js
const branch = new BranchClient({ url: "http://127.0.0.1:3210", token: sessionKey });
```

A script running on the same machine can read that key rather than being handed it:

```js
import { fromDataDir } from "../packages/sdk/client.mjs";
const branch = await fromDataDir("C:/Users/you/AppData/Roaming/BranchAgent");
```

The key is the whole of the app's security. Do not put it in a file other programs can read, do
not send it anywhere, and do not use this client to reach a Branch Agent you do not own.

## Three examples

### 1. Ask it something and wait for the answer

```js
const run = await branch.runs.start({ prompt: "Summarise notes/meeting-notes.md in three lines" });

for await (const event of branch.runs.stream(run.id)) {
  if (event.kind === "tool.started") console.log("…", event.data.label);
  if (event.kind === "end") break;
}

const finished = await branch.runs.get(run.id);
console.log(finished.run.output);
```

`stream` reads the events over a long-lived reply, starting from the beginning; pass
`{ after: lastId }` to pick up where an earlier read stopped. `branch.runs.watch(run.id)` does the
same thing over a socket instead, if you would rather hold one connection open.

### 2. Answer a question it stops on, and steer it while it works

When the owner's approval settings say a task must ask first, the task pauses and waits.

```js
const run = await branch.runs.start({ prompt: "Tidy up the invoices folder" });

const { waiting } = await branch.policy.get();
if (waiting.length) {
  const question = waiting.at(-1);
  console.log(question.question);
  await branch.runs.approve(question.sessionId, "allow", "session");
}

await branch.runs.steer(run.id, "Leave anything from last year alone.");
```

`remember` is `"never"`, `"session"` (the rest of this conversation) or `"always"` (written into
the approval settings as a standing rule).

### 3. Search what it knows, and read back what it was allowed to do

```js
// Documents and saved notes together, best answer first.
const { passages, reranked } = await branch.search("what did we agree about the invoice");
for (const passage of passages) console.log(`${passage.source}: ${passage.text.slice(0, 120)}`);

// Every moment that widened or narrowed what the assistant could reach.
const { entries } = await branch.audit({ action: "secret.used", limit: 20 });
for (const entry of entries) console.log(entry.at, entry.subject, entry.outcome);
```

## What else is here

| Group | What it covers |
| --- | --- |
| `branch.runs` | start, get, stream, watch, steer, cancel, resume, approve, receipts, activity |
| `branch.sessions` | get, search, summary, export, followUp |
| `branch.memory` | search, export, index, settings, configure |
| `branch.documents` | list, add, search, remove, settings |
| `branch.schedules` | get, trigger |
| `branch.policy` | get, save, approve, categories, setCategories |
| on the client | `state`, `tools`, `audit`, `action`, `askFirst`, `withAnswers`, `search`, `issueContext` |

Anything not covered goes through `branch.get(path)`, `branch.post(path, body)` or
`branch.request(method, path, body)`, which carry the key and turn a refusal into a `BranchError`
with the app's own plain-language message on it.

## Errors

Every failed request throws a `BranchError` with `status` (what the app answered), `message` (the
app's own wording, meant to be shown to a person) and `path`. Nothing is retried for you: a task
that failed halfway should be looked at, not run again blindly.
