# Branch Agent — the web API

Written by `node scripts/write-api-docs.mjs` from the app's own input checks. Do not edit by hand.

Branch Agent's own web API. It runs on this computer only, and every request carries the session key the app printed when it started.

Version 0.14.0. The machine-readable description is at `GET /api/openapi.json`.

## runs

| Method | Address | What it is for |
| --- | --- | --- |
| `POST` | `/api/run` | Carry out one task and wait for the answer. |
| `GET` | `/api/runs/{runId}` | One task: what happened, what it said, and what it cost. |
| `GET` | `/api/runs/{runId}/inspect` | Look inside a task: rounds, tool calls, plan and verdicts. |
| `GET` | `/api/activity` | Tasks working now and the conversations they belong to. |
## sessions

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/sessions/{sessionId}` | One conversation with its messages. |
| `POST` | `/api/sessions/branch` | Start a separate conversation from a message in this one. |
| `GET` | `/api/sessions/{sessionId}/tree` | This conversation and everything branched from it. |
## memory

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/memory/list` | What the assistant has been asked to remember. |
| `POST` | `/api/memory/search` | Search the saved facts. |
## app

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/state` | One snapshot of everything the app's own screen shows. |
| `GET` | `/api/health` | Whether the app, its database and its model connection are well. |
| `GET` | `/api/openapi.json` | This description. |
## tools

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/tools` | Every tool the assistant has, with what each one needs. |
## projects

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/projects` | The projects work is grouped under. |
| `POST` | `/api/projects` | Save a project. |
## flows

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/flows` | Saved flows as boxes and arrows. |
| `POST` | `/api/flows` | Save a flow. |
| `POST` | `/api/flows/{flowId}/run` | Start a saved flow. |
## settings

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/policy` | The approval settings. |
| `POST` | `/api/policy` | Change the approval settings. |
| `GET` | `/api/lockdown` | Whether Lockdown is on. |
| `POST` | `/api/lockdown` | Turn Lockdown on or off. |
## compatibility

| Method | Address | What it is for |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | The OpenAI-shaped way in, for tools that already speak it. |
| `GET` | `/v1/models` | The model connections, in the OpenAI shape. |
