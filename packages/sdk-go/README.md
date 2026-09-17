# The Branch Agent client for Go

One small package, standard library only, for talking to the copy of Branch Agent running on this
computer from your own Go program. It matches the JavaScript client in `packages/sdk` and the Python
client in `packages/sdk-python` group for group. Go 1.23 or later (it hands events back as a
range-over-func iterator).

It is not published anywhere. Use it from a checkout with a `replace` line in your own `go.mod`:

```sh
go mod edit -require github.com/stabrea/Branch-Agent/packages/sdk-go@v0.0.0 \
  -replace github.com/stabrea/Branch-Agent/packages/sdk-go=/path/to/Branch-Agent/packages/sdk-go
```

```go
import "github.com/stabrea/Branch-Agent/packages/sdk-go/branch"

client, err := branch.FromDataDir("/Users/you/Library/Application Support/BranchAgent", 0) // reads the session key
// or: client, err := branch.New("http://127.0.0.1:3210", sessionKey)
```

The session key is the whole of the app's security. The client only sends it over plain `http` to
this computer's own address (use `https` for anything else), never follows a redirect, ignores any
proxy set in the environment, and never prints it.

## Start a task, watch it, read the answer

```go
ctx := context.Background()
run, err := client.Runs.Start(ctx, "Summarise notes/meeting-notes.md in three lines", nil)
for event, err := range client.Runs.Stream(ctx, run["id"].(string), 0) {
	if err != nil {
		return err
	}
	fmt.Println(event.Kind)
}
finished, err := client.Runs.Get(ctx, run["id"].(string))
fmt.Println(finished["run"].(map[string]any)["output"])
```

Every answer is the app's own JSON as a `branch.Object` (`map[string]any`). The routes and what
each one takes are served by the app at `/api/openapi.json` and written out in `docs/api.md`.

## What is here

| Group | What it covers |
| --- | --- |
| `client.Runs` | Start, Get, Stream, Steer, Cancel, Resume, Approve, Receipts, Activity |
| `client.Sessions` | Get, Search, Summary, Export, FollowUp |
| `client.Memory` | Search, Export |
| `client.Documents` | List, Add, Search, Remove |
| `client.Schedules` | Get, Trigger |
| `client.Policy` | Get, Save, Approve, Categories |
| `client.Flows` | List, Get, Save, Run, ExportYAML, ImportYAML |
| on the client | State, Tools, OpenAPI, Audit, Action, Search |

Anything else goes through `client.Get`, `client.Post` or `client.Request`. `ExportYAML` and
`ImportYAML` need "Building on Branch" switched on in the app (Settings → Advanced).

## Errors

A refused request is a `*branch.Error` with `Status`, `Message` (the app's own wording, meant for a
person) and `Path`; use `errors.As`. An app that is not running gives `Status` 0. Nothing is retried.

## Tests

```sh
cd packages/sdk-go && go test ./...
```

`tests/sdk-go.test.mjs` also drives a real Branch Agent with this package and compiles every Go
snippet the app hands out.
