# The Branch Agent client for Python

One small package, standard library only (`urllib` and `json`), for talking to the copy of Branch
Agent running on this computer from your own Python program. It matches the JavaScript client in
`packages/sdk` group for group. It is not on the package index yet: put the folder on your path, or
install it from here with `pip install ./packages/sdk-python`. Python 3.9 or later.

```python
from branch_agent import BranchClient, BranchError, from_data_dir

branch = from_data_dir("/Users/you/Library/Application Support/BranchAgent")   # reads the session key
# or: branch = BranchClient("http://127.0.0.1:3210", session_key)
```

The session key is the whole of the app's security. The client only sends it over plain `http` to
this computer's own address (use `https` for anything else), never follows a redirect, ignores any
proxy set in the environment, and never prints it.

## Start a task, watch it, read the answer

```python
run = branch.runs.start("Summarise notes/meeting-notes.md in three lines")
for event in branch.runs.stream(run["id"]):
    if event["kind"] == "tool.started":
        print("...", event["data"].get("label"))
finished = branch.runs.get(run["id"])
print(finished["run"]["output"])
```

`stream` reads the events as they happen and stops when the task does; pass `after=last_id` to
carry on where an earlier read stopped. (The JavaScript client can also watch over a socket; the
standard library has no socket client of that kind, so the Python client streams only.)

## Answer a question it stopped on

```python
waiting = branch.policy.get()["waiting"]
if waiting:
    branch.runs.approve(waiting[-1]["sessionId"], "allow", remember="session")
branch.runs.steer(run["id"], "Leave anything from last year alone.")
```

`remember` is `"never"`, `"session"` or `"always"`.

## Search what it knows

```python
for passage in branch.search("what did we agree about the invoice")["passages"]:
    print(passage["source"], passage["text"][:120])
notes = branch.memory.search("Northgate", limit=5)
entries = branch.audit(action="secret.used", limit=20)["entries"]
```

## What else is here

| Group | What it covers |
| --- | --- |
| `branch.runs` | start, get, stream, steer, cancel, resume, approve, receipts, activity |
| `branch.sessions` | get, search, summary, export, follow_up |
| `branch.memory` | search, export, index, settings, configure |
| `branch.documents` | list, add, search, remove, settings |
| `branch.schedules` | get, trigger |
| `branch.policy` | get, save, approve, categories, set_categories |
| on the client | `state`, `tools`, `audit`, `action`, `ask_first`, `with_answers`, `search`, `issue_context` |

Anything else goes through `branch.get(path)`, `branch.post(path, body)` or
`branch.request(method, path, body)`. The full list of routes is served by the app at
`/api/openapi.json` and written out in `docs/api.md`.

## Errors

A refused request raises `BranchError` with `status`, `message` (the app's own wording, meant for a
person) and `path`. An app that is not running gives `status` 0. Nothing is retried for you.

## Tests

```sh
python3 -m unittest discover -s packages/sdk-python/tests
```

They run against a fake server on `127.0.0.1`. `tests/sdk-python.test.mjs` (part of `npm test`)
runs them too, and drives a real Branch Agent with the client.
