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

### Provider catalog and testing

`GET /api/providers/catalog` returns a list of built-in provider presets: Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Perplexity, xAI, Cerebras, Ollama and LM Studio. Each preset includes the provider's base URL, well-known model identifiers and plain-language help text on where to obtain an API key or how to set up a local service. The desktop and web interface can use this catalog to guide model configuration.

`POST /api/providers/test` validates a provider endpoint and credentials with a tiny request, returning success or a plain-language reason (bad key, model not found, network blocked). Supply either a preset name or a custom endpoint, model and API key.

`GET /api/providers/local` probes for Ollama at `127.0.0.1:11434` and LM Studio at `127.0.0.1:1234`, lists available models for any local runtime that responds, and returns an empty list if neither is running. The probe uses a short timeout and does not go through the network policy (local detection must succeed even when private addresses are otherwise blocked).

### Models on this computer

**Settings → Models on this computer** manages Ollama and LM Studio directly, so a model can answer without anything leaving this machine and without any charge.

Routes, all under `/api/local-models`:

| Route | What it does |
| --- | --- |
| `GET /api/local-models` | Everything the card shows: whether Ollama is installed and its version, the models it holds (size, family, parameter size, whether each can be shown a picture), LM Studio's models and which is loaded, this computer's memory/cores/graphics card, the three recommended model sizes, downloads in progress, the routing rules, and the last thing that went wrong. |
| `GET /api/local-models/downloads` | Just the download list, for the progress bar. |
| `POST /api/local-models/pull` | `{ "model": "llama3.2:3b" }` starts a download and returns at once. |
| `POST /api/local-models/stop` | Stops a download that is still going. |
| `POST /api/local-models/remove` | Removes a downloaded model from this computer. |
| `POST /api/local-models/details` | What one model is, including how much text it can hold at once. |
| `POST /api/local-models/load` | Asks LM Studio to bring a model into memory. |
| `GET` / `POST /api/local-models/routing` | Reads and saves the per-task routing rules (`settings/routing`). |
| `POST /api/local-models/routing/preview` | Says which model would take a given task, and why, without running it. |

A download takes minutes, far longer than one web request may last, so `pull` starts it and the screen asks `downloads` how it is going. Each progress report is named `model.download.progress` and carries the runtime's own status, bytes so far, total bytes and a percentage.

**Recommendations by hardware.** Memory and processor cores come from Node; on Windows the graphics card is read once with `powershell Get-CimInstance Win32_VideoController` and remembered until restart. Three sizes are offered — small (about 2 GB, fast, good for notes), medium (about 5 GB, a steady all-rounder) and large (about 9 GB, slower but better at reasoning) — each marked as fitting this computer or not, with a plain reason.

**Routing rules** (`settings/routing`, off by default): `enabled`, `localForPrivate` (a task mentioning personal details stays here), `cloudForHard` (long or tool-heavy tasks go to the cloud model), `costCeilingDollars` (a simple task that would cost more than this in the cloud uses the free local model instead), and optional `localPreset` / `cloudPreset`. What you explicitly choose for a run or a conversation always wins; when routing does pick, the run records a `model.routed` event with the reason. The rule itself also has a "local server is not answering, use the cloud one" branch, but nothing probes the local server before a run yet: a task sent to a local model that does not answer falls back the ordinary way, through the connection's configured fallbacks and the provider cooldown. `POST /api/local-models/routing/preview` is the one caller that can set `localUp` today.

**Reading passages by meaning.** When the connected model is Ollama on this computer, document and memory search use Ollama's own `/api/embeddings` instead of the OpenAI-shaped route, one passage per request, and `text-embedding-3-small` is swapped for `nomic-embed-text`, which is what exists here.

**Addresses.** Like `GET /api/providers/local`, these requests do not go through the outbound network policy, because that policy refuses loopback addresses by design and a local runtime is nothing but a loopback address. Instead every address is checked to be `localhost`, `127.0.0.1` or `[::1]` with no credentials, query or fragment, and anything else is refused before a request is sent. Model names are checked against the shape Ollama accepts, so a name can never become a path.

### Updates

The packaged Windows app checks `https://api.github.com/repos/stabrea/Branch-Agent/releases/latest`, downloads `Branch-Agent-windows-x64.zip`, verifies it against the published `.sha256`, unpacks it next to the install, then restarts through a small script that mirrors the new files into place. A checkout installed from Git updates with `node dist/cli.js update` (`git pull --ff-only`, `npm ci`, `npm run build`).

The `openai` adapter uses Chat Completions; the `anthropic` adapter uses Messages. Compatibility depends on the configured server implementing the expected request, tool-call and usage formats. Remote model endpoints require HTTPS; loopback endpoints may use HTTP. API usage may incur the provider's charges.

### Temporary provider failures

Branch retries eligible failed model requests at most twice per model round. It waits 250 ms before the first retry and 500 ms before the second by default, honors a valid `Retry-After` minimum, and stops if the requested wait exceeds five seconds. Backoff can be cancelled. The configured provider, model and credential remain unchanged.

Only identified transient HTTP failures qualify. Authentication, permission, validation, recognized quota/billing failures, malformed completion responses and partial streams are not automatically retried. Ambiguous 429 responses without a usable retry hint remain failures. This distinction follows the providers' error categories: a 429 can mean a rate limit or an exhausted spending allowance. See [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes) and [Claude API errors](https://platform.claude.com/docs/en/api/errors).

Error-body classification is limited to 16 KiB and one second; raw provider error messages are not retained. An incomplete 429 classification does not qualify for a retry. Retry hints support nonnegative whole seconds and standard GMT HTTP dates; an unsupported or malformed hint stops automatic retry instead of triggering an earlier request.

Retries repeat the model request with its existing conversation and completed tool results. They do not rerun completed tools. Every attempt remains in the usage ledger and shares the run's step/token budget; missing provider usage remains explicitly unknown. The Activity view records scheduled retries, and the terminal displays the retry number and wait.

SDK callers can pass `retryPolicy` to `createBranch`: `maxRetries` accepts 0–2, and `baseDelayMs`/`maxDelayMs` accept 0–5000 with the base no larger than the maximum. Set `retryPolicy: { maxRetries: 0 }` to disable automatic retries. The desktop and CLI use the defaults above.

## Web reading

`web.search` and `web.fetch` are always available (permission `web.read`). Search uses a DuckDuckGo-lite style HTML endpoint; fetch returns readable page text with its title and final address after at most three redirects, and refuses non-text bodies. Every hop is checked before a request: loopback, private, link-local and `.local`/`.internal`/`localhost` destinations are refused, as are addresses with embedded credentials. In the integrations file, `web` accepts `searchEndpoint`, `allowedHosts`, `blockedHosts` (both match subdomains), `allowPrivateAddresses` (for deliberately local setups), `maxBytes` and `timeoutMs`.

`GET /api/tools` lists the tools that exist right now with their permission and readiness; closing an integration removes its tools from the list.

### Pinned skills and memory retention

Above the composer, **Pinned skill** keeps one enabled skill's full instructions in every turn of that conversation until unpinned (`GET|POST /api/sessions/:id/skill`). `POST /api/memory/hygiene {olderThanDays, action: "preview"|"archive"|"purge"}` reports or removes facts not updated within the period; archived facts are listed by `GET /api/memory/archive` and restored with `POST /api/memory/archive/:id/restore`.

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

Origins must match exactly, including port. Browser requests to other origins, HTTP redirects, WebSockets and service workers are blocked. Redirecting sites may therefore fail even when the final destination is otherwise allowed. Browser fill supports non-password fields; credentials go through a saved sign-in instead (below). Unless a saved sign-in is chosen, each task gets a fresh profile, not your existing signed-in browser.

Beyond `allowedOrigins`, `channel` and `maxRuns`, the browser section accepts:

| Setting | Default | What it does |
| --- | --- | --- |
| `maxActionsPerRun` | 80 | Most browser actions one task may take before it is stopped and told to report back. |
| `maxOriginsPerRun` | 5 | Most different websites one task may open. |
| `maxDownloadBytes` | 10485760 | Largest file a website may send that is kept. |
| `downloadTypes` | pdf, csv, txt, md, json, xml, png, jpg, jpeg, gif, webp, xlsx, docx, pptx, zip | File endings that may be saved. |

When a task passes one of the two caps it stops with a plain sentence telling the person what it was doing and asking them to decide, rather than carrying on.

### What the assistant can do with a page

`browser.navigate`, `browser.snapshot`, `browser.click` and `browser.fill` are as before. Added:

- `browser.screenshot { fullPage?, selector? }` takes a picture of the page. **Every password box is blacked out in the page before the shutter**, so a picture never holds the characters. The picture is written beside the private database (never into your workspace) and the result carries its path, size and checksum, which the ordinary tool receipt signs. When the model in use can look at pictures — an OpenAI-compatible vision model or a Claude model — the runtime passes it to the model as an image; when it cannot, the text snapshot is used instead and the picture is simply kept. Pictures are never written into the conversation, so they are not re-sent on every later turn.
- `browser.pdf` saves the current page as a PDF the same way.
- `browser.wait { text | selector | networkIdle, timeoutMs }` waits for something to appear or for the page to go quiet.
- `browser.extract { selector, fields?, limit? }` pulls rows out of a table or a repeated block of cards. Without `fields` a table row comes back as `column1`, `column2`…; with `fields` each column is named and given its own selector inside the row. At most 200 rows and 32 KB come back.
- `browser.upload { selector, path }` sends **one file from your workspace** to a file box on the page. The path goes through the same confinement `files.*` uses, so traversal, secret filenames and anything hidden by `.branchignore` are refused.
- Files a website sends land in `downloads/` inside your workspace, within the size and type limits above. A refused file is reported in the click's result with the reason, and nothing is written.
- `browser.tab { action: list | open | select | close, index? }` gives a task up to five tabs. Tabs the *website* opens by itself are still closed straight away.
- Message boxes (alert, confirm, prompt) are always dismissed, and the words are reported in the result of the action that caused them, so the assistant can tell you what the site said.

### Websites you stay signed in to

**Settings → Websites you stay signed in to** keeps named sign-ins. You press "Sign in once", a real browser window opens at the address you gave, and you sign in there yourself — Branch is not part of that and never sees your password. When you close the window, the cookies and site storage the website uses to remember you are saved to a file beside the private database, encrypted with AES-256-GCM under a key derived from this device's locker key. Nothing readable is written to disk, and the values are never returned by the HTTP API.

A task asks for one by name with `browser.profile { action: "use", name }`, which has to happen before it opens a page. `list`, `create` and `remove` are the other actions. A task that used a sign-in writes back what it learned when it finishes, so you stay signed in. The default is still a fresh profile.

Routes: `GET /api/browser/profiles`, `POST /api/browser/profiles` with `{ "name": "my-bank" }`, `POST /api/browser/profiles/remove`, `POST /api/browser/signin` with `{ "name": "my-bank", "url": "https://example.com/login" }`.

Under the "Just do it inside my workspace" approval preset, `browser.upload` asks first, alongside clicking, typing and opening a new website; taking a picture, waiting and pulling out rows count as reading and are never held up.

## Channels (Telegram)

Create a bot with @BotFather, then either save its token as the secret `TELEGRAM_BOT_TOKEN` in the default project or export it as an environment variable, and add to the integrations file:

```json
{ "channels": [{ "type": "telegram", "tokenSecret": "TELEGRAM_BOT_TOKEN", "activation": "mention", "pairing": true, "allowlist": [] }] }
```

`tokenEnv` names an environment variable instead of a secret. Each chat (direct or group) keeps its own conversation. A sender who is neither on the `allowlist` (Telegram user ids) nor approved receives a six-digit code; approve it in **Settings → Channels** or with `POST /api/channels/pairings/approve {code}`. With `pairing: false`, strangers are told the assistant is private. In groups, `activation: "mention"` answers only messages that mention the bot or reply to it; `"always"` answers everything. Channel tasks run with every tool permission except host command execution. `GET /api/channels` lists connected channels, pending and approved people.

### What every channel shares

`activation`, `pairing` and `allowlist` mean the same on every channel, and every channel uses the same delivery ledger, the same pairing codes and `POST /api/channels/link { channel, chatId, sessionId }`. Every credential is read from an environment variable of that name first, then from a secret of that name in the **default project's** locker; nothing is ever written into the connections file. Every outbound request goes through the network settings in `web`, including the chat sockets (checked as the matching `https://` address) and the mail servers (checked by host name). `GET /api/channels` reports each channel's `health` as `connected`, `reconnecting` or `needs attention` with a plain reason; **Settings → Channels** shows the same line and a **Check the connection** button. A secret never appears in that output, in an error message or in the log.

### Channels (Discord)

Create an application at discord.com/developers, add a bot, and turn on **Message Content Intent** — without it Discord delivers empty message text. Save the bot token as `DISCORD_BOT_TOKEN` and add:

```json
{ "channels": [{ "type": "discord", "tokenSecret": "DISCORD_BOT_TOKEN", "activation": "mention", "pairing": true, "allowlist": [] }] }
```

Messages arrive over Discord's gateway socket, which is kept alive with heartbeats, resumed after a short drop and reopened with a widening wait otherwise. `allowlist` holds Discord user ids and `chatId` is a Discord channel id. Direct messages always count as addressed; in a server channel the assistant answers a mention or a reply to one of its own messages. Replies go out over the REST API in pieces of at most 2000 characters, honouring `X-RateLimit-Remaining`/`X-RateLimit-Reset-After` and `429 retry_after`.

### Channels (Slack)

Create an app at api.slack.com/apps, turn on **Socket Mode**, and subscribe to `message.im` and `app_mention`. Save the bot token (`xoxb-…`) as `SLACK_BOT_TOKEN` and the app-level token (`xapp-…`) as `SLACK_APP_TOKEN`:

```json
{ "channels": [{ "type": "slack", "slackChannels": ["C0123456789"], "activation": "mention", "pairing": true, "allowlist": [] }] }
```

Socket Mode means Slack never needs to reach this computer. Every envelope is acknowledged immediately and an event id already seen is dropped, so a message Slack sends twice is answered once. Edits, joins and the assistant's own posts are ignored. `slackChannels`, when given, is the only list of Slack channel ids that will be answered; `allowlist` holds Slack user ids. Replies are posted into the thread the question came from, with markdown converted to Slack's own formatting (`**bold**` → `*bold*`, `*italic*` → `_italic_`, links → `<url|text>`, code fences untouched).

### Channels (WhatsApp)

WhatsApp pushes messages to a web address rather than holding a connection open, so Branch must be reachable from the internet. Save the Graph API access token as `WHATSAPP_TOKEN`, the app secret as `WHATSAPP_APP_SECRET`, and a word of your own choosing as `WHATSAPP_VERIFY_TOKEN`:

```json
{ "channels": [{ "type": "whatsapp", "phoneNumberId": "123456789012345", "pairing": true, "allowlist": [] }] }
```

Point Meta's webhook at `/webhooks/whatsapp/<channel id>` (`/webhooks/whatsapp/whatsapp` by default) and give it the same verify word. **The reverse proxy that exposes Branch must rewrite the `Host` header to the local bind address** (`127.0.0.1:<port>`), exactly as the schedule hook routes need: the server refuses any request whose `Host` is not its own, which is what stops a web page from reaching it through your browser. That route carries no session token, like the trigger routes: `GET` answers Meta's one-off `hub.challenge` as plain text when `hub.verify_token` matches, and `POST` is refused with 401 unless `X-Hub-Signature-256` is an HMAC-SHA256 of the exact bytes under the app secret. Text messages only; `allowlist` and `chatId` hold WhatsApp numbers in `wa_id` form. WhatsApp only allows a free-form reply within 24 hours of the person's last message: a later send is refused with "Outside WhatsApp's 24-hour reply window", so the delivery ledger holds it, retries it for about two and a half minutes, then parks it under **Messages still to send** for the owner to retry once the person writes again. When each person last wrote is remembered only while Branch is running, so after a restart the first reply to someone is attempted rather than held back.

### Channels (email)

Save the mailbox password as `EMAIL_PASSWORD` and give both servers:

```json
{ "channels": [{ "type": "email", "address": "you@example.com", "pollSeconds": 60,
  "imap": { "host": "imap.example.com", "port": 993, "user": "you@example.com" },
  "smtp": { "host": "smtp.example.com", "port": 465, "user": "you@example.com" },
  "pairing": true, "allowlist": ["someone@example.com"] }] }
```

Built on Node's own TLS with no mail library: a small IMAP4rev1 reader (`LOGIN`, `SELECT INBOX`, `SEARCH UNSEEN`, `FETCH`, `STORE \Seen`) looks for unread mail every `pollSeconds`, answers it, and marks it read so it is never answered twice; a small SMTP sender (implicit TLS, `AUTH PLAIN` then `AUTH LOGIN`, `8BITMIME`) sends the reply threaded onto the original with `In-Reply-To` and `References` and a `Re:` subject. `allowlist` holds sender addresses. `tls: false` on a server connects in the clear and upgrades with `STARTTLS` when the server offers it, which is only sensible for a mail server on this computer. **Plain text only**: attachments, HTML mail and multipart bodies are not read or sent, and quoted history below an "On … wrote:" line is trimmed from the question. An address longer than 60 characters is shortened to a stable `who:<hash>` handle, because a chat id may hold 64 characters; such an address therefore cannot be put on the `allowlist` by address, and has to pair with a code instead. The first look at the inbox does not hold up starting, so a mail server that is unreachable shows as **reconnecting** with the reason rather than stopping Branch.

## Voice

**Settings → Voice** configures speech input and output. Record audio messages to transcribe them to text (requires an OpenAI-compatible provider with an API key). Read messages aloud using your browser's built-in voice (free, offline) or the provider's text-to-speech endpoint (optional, higher quality). Voice settings include:

- **Read replies aloud automatically**: When enabled, assistant responses are read aloud when they arrive.
- **Voice**: Choose which voice the browser uses for speech synthesis. Available voices depend on your operating system and browser.
- **Speech speed**: Adjust how fast the browser reads aloud (range 0.5 to 2 times normal speed).
- **Use higher-quality voice from my provider**: When enabled and you have an OpenAI-compatible API key configured, the assistant uses the provider's text-to-speech endpoint instead of the browser voice.

Speech-to-text transcription requires an OpenAI-compatible provider with an API key. The ChatGPT plan sign-in does not provide an API key for audio endpoints; configure an API key in **Settings → Model connection** to use voice transcription. API routes: `POST /api/voice/transcribe` (binary audio input), `POST /api/voice/speak` (JSON text input, audio output), `GET|POST /api/voice/settings` (voice preferences).

## Projects and secrets

**Settings → Projects** keeps named projects, each with its own instructions (added to every task while it is active), a preferred model preset and its own secrets. The `default` project always exists. Switching the active project changes all three for new tasks; a conversation's own model choice still wins. API: `GET /api/projects`, `POST /api/projects`, `POST /api/projects/active`, `POST /api/projects/:id/remove`.

**Settings → Secrets** stores keys and tokens per project. Values are encrypted with AES-256-GCM using a random key in `locker.key` inside the data directory (never in the database), are never returned by the API or shown again, and are never placed in a model request. A host command names the secrets it needs (`shell.execute` with `secrets: ["DEPLOY_TOKEN"]`) and receives them as environment variables; only the active project's secrets resolve, anything else is refused, and the command's output is scrubbed of the values before it is recorded. API: `GET /api/secrets/:project`, `POST /api/secrets`, `POST /api/secrets/:project/:NAME/remove`.

### Saying which secret without saying the secret

Anywhere a setting or a tool wants a key, you can write a **reference** instead of the key itself: `secret://<project>/<NAME>`, for example `secret://default/DEPLOY_TOKEN`. Branch Agent only looks the real value up at the last possible moment — as it puts it in a request header, in a command's environment or in a model provider's key — and only from the project that is active. A reference pointing at another project is refused rather than quietly filled in from this one.

Every value that has ever been looked up is remembered by **one scrubber** for as long as the app is running, and that scrubber runs over everything on the way out: a tool's answer, the receipt that proves the answer was not edited afterwards, every line written to the activity log, the summary of a task, and the text of any failure — including the failure message sent back over the API. Where a value would have appeared you see `[secret DEPLOY_TOKEN]` instead. The order matters and is deliberate: the answer is cleaned **before** its receipt is signed, so a cleaned answer still passes its own check.

**Replacing a secret and being reminded.** `POST /api/secrets/:project/:NAME/rotate` with `{ "value": "the new one" }` writes the new value and records the day it happened; the reminder rhythm is kept, so a secret you set to be replaced every 90 days is due again 90 days later. Set `expiresInDays` when you save or replace a secret (0 means never remind). Anything due within a week, or overdue, appears as `secretReminders` in the app's state and under `reminders` in the audit.

**Who used what.** `GET /api/secrets/audit` lists, newest first, every time a secret was taken out of the locker: which secret, which project, which task, what for and when. Values never appear there either.

## Locking the app

The lock in the header now has a matching setting: after a number of quiet minutes Branch Agent locks itself, and while it is locked it will not take a saved password or key out of the locker for a new task. It keeps answering from what it already knows; only the locker is shut. Anything you do in your own app counts as activity and starts the quiet period again.

- `GET /api/lock` — whether it is locked, how long it has been quiet, and since when.
- `POST /api/lock` — lock it now. `POST /api/lock/unlock` — unlock it (your app's own session token is what proves it is you).
- `POST /api/lock/settings` — `{ "idleMinutes": 15, "secretsWhileLocked": false }`. `idleMinutes: 0` means it never locks itself, which is the default.

Two things worth knowing before you turn it on. **Reading is not activity**: the app refreshes its own screen every three seconds, so if merely looking counted, it would never lock itself; only doing something restarts the quiet period. And a locked app cannot fetch a saved bot token, so a chat channel that has to reconnect while it is locked will say it needs attention until you unlock. At the default of never locking itself, neither applies.

## Signing in to other services

Branch Agent can sign in to a service the ordinary way, without ever seeing your password: it opens the service's own sign-in page in your default browser, the service sends its answer back to a small page running on this computer only (`http://127.0.0.1:<port>/oauth/callback`), and the key that comes back goes straight into the locker. This is the standard OAuth 2.0 authorization-code flow with PKCE, so the same setting works for Google, Microsoft, GitHub, Slack and anything else that follows the standard.

`POST /api/connections/oauth/start` takes `{ id, label, authorizeUrl, tokenUrl, clientId, clientSecret?, scopes?, extra? }` and returns the address to open. `GET /api/connections/oauth/:id` says whether that connection is signed in and when its key runs out; `POST /api/connections/oauth/:id/cancel` abandons a sign-in that is still waiting. An answer that does not match the sign-in that was started is refused, which is what stops someone else finishing it for you. A key that has run out is renewed automatically before it is used. Nothing is provider-specific yet: there are no Google or Slack buttons in the app, only this flow underneath them.

## Personal details and the content check

**Going out.** Every message Branch Agent sends to a chat or a mailbox is looked at first. Email addresses, phone numbers, payment card numbers (checked with the same arithmetic a shop uses, so a lookalike number is left alone), bank account numbers (IBAN, likewise checked) and national id numbers are replaced with a plain note such as `[card number hidden]`. You can choose to be warned instead, to have the message held back altogether, or to switch the check off.

**Coming in.** What Branch Agent reads — your own files above all — is **not** rewritten unless you ask for it. That is the default and the reason for it is simple: reading your own address book should give you your own address book. Turning it on applies it to everything the assistant reads.

**The optional content check** shows an outgoing message to your model provider's moderation address first, when it has one that follows the OpenAI shape (`/moderations`). It is off until you switch it on, it never blocks a message when the check itself cannot run, and the key it needs is given as a reference such as `secret://default/OPENAI_API_KEY`.

`GET /api/privacy` and `POST /api/privacy` with `{ "pii": { "outbound": "mask" | "warn" | "block" | "off", "inbound": "off" | "mask" | "warn" | "block", "kinds": [...] }, "moderation": { "enabled": false, "endpoint": "...", "model": "...", "keyReference": "secret://default/OPENAI_API_KEY", "action": "block" } }`.

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

### Keeping a command in its lane

On Windows, a command is placed inside a **job object** before it does anything: Windows itself then holds the memory ceiling (`maxMemoryMb`) and the processor-time ceiling (`maxCpuSeconds`), and when Branch Agent lets the job go everything still inside it is killed, including programs the command started. That is a real cap rather than the once-a-second look Branch Agent otherwise takes, and it is the one thing that reliably clears up a runaway that has orphaned itself. No extra software is installed for this; where a job cannot be created, the older sampling is used instead and nothing else changes. Every result says which was used, in `isolation`: `job-object` or `sampling`.

Setting this up costs about a third of a second per command (measured: roughly 400 ms with a job against roughly 80 ms without, for a command that does nothing), because Windows has no way to make a job from the command line and a small helper has to be started for it. That is worth paying for a limit the system actually enforces, but if you run many very short commands and would rather have the milliseconds, `"useJobObject": false` in the `shell` settings goes back to sampling.

**No internet, best effort.** `"netless": true` in the `shell` settings, or `netless` on a single call, points the command at a dead address on this computer (`http://127.0.0.1:9`) through the usual proxy variables, so curl, git, npm, pip and anything else that respects them fail at once instead of reaching a website. Be clear about what this is: it is **not** a firewall. Blocking a single program properly on Windows needs administrator rights, which a desktop app should not ask for, so a program that ignores proxy settings and opens its own connection is not stopped. Use it to stop an ordinary tool phoning home by accident, not to contain something you do not trust.

The command's environment is built from nothing: only the variables named in `inheritEnv`, then the `env` you set, then the dead-address variables if the command is offline, then the secrets the call asked for. Nothing else from the host — no model keys, no vault variables, no `NODE_OPTIONS` — reaches the program, and the values of those secrets are taken back out of the output before it is recorded.

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

## Usage and observability

Access **Usage** in the left navigation to see your assistant's token consumption, estimated costs, and run performance. The interface shows:

- **Daily breakdown**: token usage (input/output), run count, failures, and estimated cost per day over the last 30 days
- **By model, by conversation and by where the task came from**: tokens and cost for each
- **Budget settings** (optional): set a monthly limit in tokens, in dollars, or both, and optionally pause new runs when the limit is reached; pass this as a `POST /api/usage/budget { maxMonthlyTokens?: number, maxMonthlyDollars?: number, pauseAtBudget: boolean }` request. At least one of the two limits must be present; the older tokens-only body still works
- **Run timeline**: click Activity → run → timeline (visible in the detail pane) to see a timestamped sequence of tool calls, model invocations, retries, and stalls for that specific run
- **CSV export**: download the current period's usage data as a CSV file for analysis in a spreadsheet. Its columns are `date,runs,toolCalls,tokensInput,tokensOutput,estimatedCostUsd,runsWithoutPrice,failures`; `estimatedCostUsd` is blank on a day where nothing had a price

Only terminal runs (completed, failed, cancelled, budget_exceeded, interrupted) are included in aggregates; running tasks are not counted until they finish. Estimated tokens come from the runtime; reported tokens come from the provider's response, when available.

### Prices and cost estimates

Branch keeps a table of published list prices per million tokens for the common models of each provider, with the date it was last checked (`pricedAt`). A task's cost is worked out once, from the tokens on its usage row and the model its last model round used — not once per round.

**A model with no price on file is never shown as costing nothing.** The estimate carries a confidence: `table` (Branch's own figure), `override` (yours) or `unknown` (none), and an unknown one has no amount at all and reads "no price on file" everywhere it appears — the summary card, every table, the CSV, a task's own line, and the receipts view. A model running on this computer is priced at zero on purpose, which is a different thing from having no price.

Correct or add a price under **Usage → Model prices**, or `POST /api/pricing { "overrides": { "gpt-4o": { "input": 2.5, "output": 10, "cached": 1.25 } } }` (dollars per million tokens, at most 200 entries, stored in `settings/pricing`). `GET /api/pricing` returns the table in use. Overrides win over the built-in table. Model names are matched exactly first, then after dropping a vendor prefix (`openai/gpt-4o`) and a date suffix (`claude-3-5-sonnet-20241022`). A cached-token price can be recorded, but nothing populates cached token counts yet, so it does not affect any figure today.

These are estimates for your own planning from published list prices. They are not a bill, they do not know about your discounts or free tiers, and they go stale when a provider changes its prices.

Setting a budget lets you control spending. When `pauseAtBudget` is enabled, the runtime refuses new tasks with a plain-language message; the dollar figure appears in it whenever a price is on file, and the per-task token refusal says what that task has cost so far. Budgets are per-month, calculated from the first run of each calendar month.

### Trace files

Off unless you turn it on, under **Settings → Diagnostics**. When on, each finished task is written as one JSON file named after the task in a folder you choose, in the OpenTelemetry shape (`resourceSpans → scopeSpans → spans`) that tracing viewers already read: one span for the task, and a child span for every model round and every tool call. `traceId` is the task's id as 32 hex characters and `spanId` is derived from the event id, so the same task always produces the same trace. Times come from the event timestamps, which have millisecond resolution.

**Branch writes files and nothing else. There is no network exporter, and no trace is sent anywhere.** Only the failure message of a failed tool travels into a span; tool arguments and results stay in the database.

The folder must be a full path inside your own user folder or inside the workspace. Anything else — another account, a system folder, a network share, a relative path — is refused, because a trace names the tools a task ran. Writing a trace never fails a task: a problem is recorded as a `trace.failed` event and the task stands.

Routes: `GET`/`POST /api/trace/settings` with `{ "enabled": boolean, "folder": string | null }` (stored in `settings/trace`; turning it on without a folder is refused), and `GET /api/runs/:id/trace`, which returns the same document on demand whether or not the setting is on.

### Diagnostics

**Branch sends no usage data to anyone.** There is no telemetry client, no analytics, no crash reporting and no opt-out to configure, because nothing is collected in the first place. Settings → Diagnostics says so on the screen.

When you want help with a problem, **Save a diagnostics folder** (`POST /api/diagnostics/bundle`) writes a timestamped folder under `diagnostics/` in the private data directory — plain files, no archive — so you can read it and pass it on by hand:

- `health.json` — the same checks as the Health check button
- `versions.json` — the Branch, Node.js and operating system versions
- `events.json` — the last 200 events across your tasks, reduced to names, counts, outcomes and timings
- `pricing.json` — the price table in use, including your corrections
- `README.txt` — what is in the folder and what is deliberately left out

Events are filtered by an allow-list of fields, so anything nobody anticipated is dropped rather than trimmed: tool arguments, tool results, file contents, diffs, your messages and the assistant's replies never enter the folder. Fields that are kept are also scrubbed for anything shaped like an API key, a bearer token or a long secret, and any field whose name looks like a credential is replaced with `[removed]`.

The connector implements tool discovery and invocation. MCP resources, prompts, sampling and other assistants' internal learning or memory are separate capabilities. Newly advertised tools are not automatically granted.

## Long conversations and questions for you

When a conversation's working context passes about 11,000 estimated tokens, Branch asks the model for a short handoff summary of the older turns (facts, decisions, file paths, open tasks, next step), keeps at least the six most recent turns plus everything from the current task, and continues with the summary in place. The run records a `context.compacted` event with sizes before and after; the summary is saved per conversation and reused; the complete transcript stays stored and searchable.

The `user.ask` tool lets the assistant stop when it cannot proceed without you. The task ends with status `needs_input`, an `attention.needed` event, and the question as its output. `/api/state` lists waiting conversations under `attention`; the app shows a banner and a system notification that open that conversation; on a channel the question is sent as the reply. Your next message in that conversation is the answer.

## Reliability

`createBranch({ reliability })` accepts `modelStallMs` (5 s to 10 min, default 60 s: a model call that streams nothing for this long is treated as stalled), `stallRecovery` (`retry` twice then fall back, `fallback`, or `fail`), `toolTimeoutMs` (default 90 s: a single tool call is stopped after this), and `toolResultChars` (default 12,000: longer tool results are clipped for the model; the full result stays in the task's trace). Events: `model.stalled`, `model.stall_recovery`, `tool.stalled`, `tool.result_clipped`, `context.shrunk`.

`POST /api/run` accepts `checks`: `mustMention` (phrases), `mustMatch` (a regular expression), `resultSchema` (the answer must be JSON of that shape), `files` (workspace files that must exist) and `maxRetries` (0 to 2, default 1). A missed check is recorded as `run.check_failed`, the model is told what was missing and tries again; when the allowance is used up the task fails with a plain reason.

A task marked interrupted (the app stopped while it was working) shows **Continue where it stopped**. `POST /api/runs/:id/resume` starts a new run in the same conversation from the saved transcript: no new prompt, nothing replayed, and tool calls whose outcome was never recorded are shown to the model as unknown so it checks before repeating them.

## Teams, linked chats, registries and evaluation

`POST /api/teams { name, purpose, members: [{ specialistId, role, brief }] }` creates a team with a room; `POST /api/teams/:id/run { prompt }` fans the task out to every member and appends answers to the room (`GET /api/teams/:id/room`). `POST /api/channels/link { channel, chatId, sessionId }` makes a chat continue an existing conversation. `POST /api/registry/browse { url }` and `POST /api/registry/install { url, skillId }` work with a `branch-skill-registry` JSON index; installed skills stay disabled until activated. `POST /api/evaluation` (empty body for the standard suite) or `branch eval` records accuracy, latency and cost; energy is reported unavailable.

## Test suites, their history, and comparing two models

Suites are plain JSON files in `data/evaluation/`, so you can read one and copy it. Five ship:
**everyday** (remember something, write a file and prove it, sum up a note, follow a procedure),
**tool-use** (search inside files, change a file with a patch, read a page in the browser),
**safety** (text copied from a page must not be able to give orders; a secret you hand over must not
come back out), **reliability** (a task is stopped after its first step on purpose and continued —
the stop is staged by the program, not a real crash) and **cost** (two questions that change
nothing, meant for comparing models). A task holds a `prompt`, `checks` that anyone can repeat,
`deny` (phrases the answer must not contain and files it must not create), an optional
`judge: { rubric, pass }`, `expected` (a reference answer shown to the judge), `requires` (tools that
must be installed, or the task is skipped rather than failed), `tags`, `timeoutMs` and `mode`.
Checks that can be settled without a model always decide the result; a judge is asked only when a
task has none, and what a task forbids is fatal either way.

`GET /api/evaluation/suites` lists them; `POST /api/evaluation/suites` saves one of your own and
`POST /api/evaluation/suites/remove { id }` deletes it. `POST /api/evaluation/suites/from-run
{ runId, suite, taskId?, checks? }` turns a task you already ran into a test — without checks of your
own, the answer it gave becomes the reference and its first line must show up again.
`POST /api/evaluation/run { suite, preset?, readOnly?, maxSteps?, maxTokens? }` runs one and records
per-task right/wrong, time, tokens, money from the price table, the model choice and the app version.
`GET /api/evaluation/history?suite=` returns every stored run newest first plus a trend series. A
task that passed in each of the three runs before this one and has just failed is listed under
`regressions`; fewer than three earlier runs never flags anything.
`POST /api/evaluation/compare { suite, presets: [a, b], allowChanges? }` runs the same suite against
each model choice and returns one table of accuracy, mean time and cost. A comparison only offers
the tools that change nothing unless you pass `allowChanges`, and every run stays inside the step
and token budget you give it. Money is never invented: a model with no price on file reports no
amount, and energy is always reported unavailable. One thing the figures leave out: a task graded by
a judge asks the model a second question, and those tokens are not added to the task's own, so a
judged suite costs roughly twice what its summary shows.

A suite can run on a schedule: `schedules.create` accepts `kind: "evaluation"` with `suite` and an
optional `preset`, alongside the usual `dailyAt`/`timezone`. The result is recorded as an ordinary
finished task, and a regression is announced to any webhook listening for `evaluation.regression`.

On the command line: `branch eval --suite <id> [--preset <id>] [--json]` prints a table of tasks and
exits non-zero when one fails; `branch eval --suite <id> --compare a,b` prints the comparison table.
`branch eval` with no suite still runs the original three-task standard suite.
The Usage screen has a card for picking a suite and running it.

## Skill governance and consolidation

`GET|POST /api/governance` holds `excludeAfterFailures`, `windowMinutes`, `recoveryAfterMinutes` and `demoteAfterFailures`. A skill with a repeating failure pattern is set aside (`skill.set_aside`, `skill.excluded` on later runs), gets one recovery trial after the cool-off (`skill.recovery_trial`, `skill.recovered`), and is demoted when failures pile up (`skill.demoted`); `POST /api/governance/set-aside/:skillId/restore` lets it back in. `POST /api/skills/:id/benchmark { baselineVersion, candidateVersion, tasks, seed }` records per-task outcomes and costs; `POST /api/skills/:id/draft { runId }` saves an inactive draft version from a task. `consolidateDaily` in the learning settings (or `POST /api/memory/consolidate`) digests completed tasks since a cursor into memory suggestions.

## Guardrails

Shell: `maxMemoryMb` (default 1024) and `maxCpuSeconds` (default 60) stop a command whose sampled usage passes the limit (reasons `memory_limit`, `cpu_limit`); results carry `usage.peakMemoryMb` and `usage.cpuSeconds`. Network: the `web` section accepts `allowedHosts`, `blockedHosts`, `allowedPaths` and `blockedPaths` (rules look like `api.github.com/repos/`); the same policy applies to web reading, browser navigation and MCP HTTP requests. Hooks: `hooks: [{ id, event, executable, args, failureThreshold, timeoutMs }]` in the integrations file, where `executable` names a shell alias; `GET /api/hooks`, `POST /api/hooks/:id/enable`. Streams: `GET /api/runs/:id/ws` (WebSocket; send the token as the second subprotocol after `bearer`). Channels: `POST /api/channels/test { channel, chatId }`.

## Memory over time, scopes and admission

`memory.put` accepts `entity`, `attribute` and `validFrom`; a newer fact for the same entity and attribute ends the earlier one at that moment. `memory.at { entity, attribute?, at? }` returns the facts true at a moment; `memory.timeline { entity }` lists them in order. Facts carry `scope`: `private` (default), `shared`, or `agent:<specialist id>`; delegated specialists see shared facts and their own only. `GET|POST /api/sessions/:id/memory-policy { remember }` controls whether a conversation may save memory on its own (forgetting a conversation denies it; allowing re-admits it). `POST /api/memory/hygiene { olderThanDays, action: preview | archive | purge }` and `GET /api/memory/archive` back the Tidy up controls in the Memory view.

## Recipes, templates and project folders

A recipe (`procedures.propose`) may declare `parameters` (`{ name: { type: "string" | "number" | "boolean", required, default, description } }`) and use `{{name}}` in step arguments, expectations and precondition paths; `procedures.verify` and `procedures.replay` take `inputs`, which are bound and checked before any step runs. `resultSchema` (the same JSON-Schema subset as delegation) is applied to the final step's result. `templates.export` / `GET /api/templates/:kind/:id` and `templates.import` / `POST /api/templates/import` move a specialist or recipe definition between installs without ids, evidence or secrets. A project's `folder` scopes every file tool to that folder inside the workspace while the project is active.

## Other programs and streams

`POST /v1/chat/completions` accepts the OpenAI chat shape with the local session token as the bearer token. The last user message becomes the task, system/developer messages travel as caller instructions, `model` may name a preset id, `x-branch-session` (or `metadata.session_id`) continues a conversation, and `stream: true` returns `chat.completion.chunk` events. Every response carries `branch.{run_id, session_id, status}`. `GET /v1/models` lists presets. `GET /api/runs/:id/stream?after=<id>` streams a run's events in order over Server-Sent Events until it ends.

## Follow-ups and background specialists

`POST /api/sessions/:id/followups { prompt }` queues a message for a busy conversation; queued messages run in order as soon as the current task finishes (`GET` lists them). `specialists.delegate` with `background: true` starts a child that keeps working after the parent finishes; the result stays on the child run and is recorded on the parent as `delegation.background_finished` and in `/api/state.background`.

## Backup, restore and health

`GET /api/backup` (Settings → Backup, `branch backup <file>`) exports every state table as plain rows; secrets are left out because their key never leaves the device. `POST /api/restore` or `branch restore <file>` loads a backup into a fresh install and refuses when the install already has state. `GET /api/health?probe=1` (Settings → Health check, `branch doctor --probe`) reports each dependency with a plain fix.

## Undo and workspace history

Every `files.write` keeps the file's previous bytes and records a `file.changed` event with a line diff. Activity shows each change with **Show change** and **Undo this change** (`POST /api/history/restore { versionId }`); `GET /api/history/files?path=` lists kept versions; the model has `files.history` and `files.restore`. Whole-workspace snapshots: `POST /api/history/snapshots { label }`, `GET /api/history/snapshots`, `POST /api/history/snapshots/:id/restore` (Settings → Workspace snapshots, tool `workspace.snapshot`). Limits: 500 files, 256 KiB per file, 16 MB per snapshot; `node_modules`, `.git`, `dist`, `release` and secret-named files are skipped.

## Looking through and changing code

Seven tools work inside the workspace (or the active project's folder), behind the same permissions as the other file tools. They need no settings and add no routes.

- `files.glob` (`files.read`) — lists files whose path matches patterns such as `src/**/*.ts`, saying when there are more than fit in one answer.
- `files.grep` (`files.read`) — searches inside files for a word or a regular expression, with the lines around each match, an optional file pattern, a capitals switch and a maximum file size; files that are not text are skipped and counted.
- `files.find` (`files.read`) — finds a file when you remember only part of its name, closest first.
- `workspace.map` (`files.read`) — a short map of the workspace: each file's size, what kind of file it is, and the main names (JavaScript, TypeScript, Python) or headings (Markdown) inside it. A file is read again only when it has changed.
- `files.patch` (`files.write`) — applies a unified diff to one or more files. Every part must fit the file exactly at the line it names; if any part does not, nothing at all is written and the reply says which file and which part. Deleting a file this way is refused.
- `files.edit` (`files.write`) — replaces an exact piece of text; if the text appears a different number of times than `expectedOccurrences` (1 by default) the change is refused rather than guessed.
- `files.validate` (`files.read`) — checks that a file still reads as valid (JSON by parsing it, JavaScript with this app's own Node in check-only mode, which never runs the file). Problems come back as a list to read, not as a failure. TypeScript is reported as not checked, because the TypeScript compiler is not carried at run time.

Ignored files: put a `.branchignore` in the workspace (or the project folder) and every one of these tools skips what it names; a `.gitignore` is used when there is no `.branchignore`. `node_modules`, `.git`, `dist`, `release`, `.branch` and secret-looking names are always skipped. Each file a patch or an edit changes keeps its previous bytes, so it has its own **Undo this change** in Activity (see *Undo and workspace history*); a patch that changed three files is undone three times, once per file. As with the other file tools, a file larger than 32 KiB cannot be changed.

## What it learns

`GET|POST /api/memory/settings` holds `review` (after each finished task a separate, bounded model call may suggest memories or skill notes; suggestions wait for you) and `requireApproval` (memory changes the model makes on its own become suggestions instead of writes). `GET /api/memory/proposals`, `POST /api/memory/proposals/:id/accept|reject`. Every memory edit or deletion keeps an exact earlier version: `GET /api/memory/versions?id=`, `POST /api/memory/versions/restore { id, revision }`. Checkpoints freeze every memory and each skill's active version: `GET|POST /api/memory/checkpoints`, `POST /api/memory/checkpoints/:id/restore`. Each conversation starts with a memory snapshot (up to 20 recent facts) that stays the same until a new conversation begins.

## Trust

**Skill scanning.** Every skill version is scanned when it is installed or updated. Findings are hardcoded secrets, instructions to send data somewhere, and attempts to override the assistant's rules. Policy `block` (default) refuses to save such a version; policy `review` installs it disabled, shows the findings, and enabling that version requires `acknowledge: true`. `GET|POST /api/skills/policy`; the Skills view has the same choice.

**Receipts.** Each successful tool result is hashed and signed with a key derived from the locker key. `GET /api/runs/:id/receipts` classifies every tool event (success, modified, forged, unsigned, failed, blocked, stalled). `POST /api/receipts/verify` with `{ runId, data }` (the event's data) says whether a result is still the one the runtime observed.

**Web content.** `web.fetch` returns `provenance` (source, url, fetchedAt, trust: untrusted) and `warnings` for lines that read like instructions to the assistant; `web.search` checks snippets the same way. The web setting `injection` is `warn` (keep the text, add warnings), `redact` (replace flagged lines with a notice) or `block` (refuse the page or drop the result). Every detection is a `content.flagged` event.

**Exit criteria for delegated tasks.** `specialists.delegate` and fan-out tasks accept `checks` (same shape as a run's checks); a miss fails the child with the reason and the parent sees it as unresolved with that evidence.

**Live activity.** `GET /api/activity` lists running tasks with what they are doing now and how each earlier step ended.

## Delivery ledger

Every message sent through a channel (a reply, a scheduled result) is recorded before it is sent, split into ordered chunks with a stable key. If the channel is unreachable the chunks wait and go out in order when it is back (on reconnect and every 10 seconds). Failed chunks back off from 5 seconds, doubling to 10 minutes; the fifth failure parks the chunk as a dead letter. `GET /api/channels` lists `outstanding` chunks; `POST /api/channels/deliveries/:id/retry` re-queues one. Settings → Channels shows the same list with **Try again**.

## Using Branch from other AI tools

Branch is itself a Model Context Protocol (MCP) server, so another AI tool on the same computer can ask it to do things. **Settings → Sharing with other AI tools** has the switch, the list of tools you are willing to share, and ready-to-paste settings with a Copy button for Claude Desktop, Claude Code and Cursor.

**What is shared, and when.** Nothing until you switch it on. Switching it on offers the tools that only read (their permission ends in `.read`) and leaves everything else unticked and marked *can change things*; you tick those yourself. `branch.ask` — asking Branch a question in plain words — is always available, because it goes through Branch's own permissions and budget like any other task. The saved choice lives in `settings/mcp-sharing` as `{ enabled, exposedTools }` and is read fresh on every call, so a change takes effect at once.

**Two ways to connect.** Over HTTP, at `/mcp` on the same port as the web interface: JSON-RPC 2.0 by `POST`, with your session key as `Authorization: Bearer …`, an optional `Mcp-Session-Id` header to keep one conversation across requests, `DELETE` to end that session (204) and `GET` refused (405). Responses carry `MCP-Protocol-Version`; `2025-06-18` is preferred and `2024-11-05` accepted. Or as a child program: `branch mcp-serve` speaks newline-delimited JSON-RPC on standard input and output, writes every message for a person to standard error, and stops cleanly when the other tool closes the connection.

Use HTTP when Branch is already open — that is what the Claude Code and Cursor snippets do. `mcp-serve` starts a second copy of Branch against the same records, so close the app first; the snippet sets `BRANCH_DATA_DIR` and `BRANCH_WORKSPACE` for the child, because it inherits the other tool's working directory rather than Branch's.

**Resources.** `memory://facts` (what Branch remembers) and `workspace://files` (the workspace listing) as JSON, plus the twenty most recent saved conversations as `conversation://<id>`, named after their first message and dated. Reading one returns the transcript as plain `role: text` lines in the order they were said, read-only: the most recent messages are kept and older ones dropped once the text passes 64 KiB. Temporary conversations are never listed, and a conversation belonging to someone else is not found.

**Prompts.** Your saved procedures, listed as `procedure:<id>` with the procedure's name.

**What is recorded.** Every `tools/call` becomes a task of its own, named "Another AI tool used …", with `run.started`, `tool.started` and `tool.completed`/`tool.failed` events carrying `source: "mcp"` and the same signed receipt as local work. They appear in Activity and under `GET /api/runs/:id/receipts`. At most four shared calls run at once and one connection may make 100 in total.

**Routes.** `GET /api/mcp/settings` returns `{ enabled, exposedTools, a2a, tools }`, where each tool carries `name`, `description`, `permission` and `changesThings`; `POST` the same `{ enabled, exposedTools, a2a }` to save it (unknown tool names are dropped). `GET /api/mcp/connection` returns this server's own address and key, the stdio command for this install, and the three configuration snippets.

## Talking to assistants other people built

Two protocols, both off until you switch them on: **A2A**, how assistants ask each other for work, and **ACP**, how a code editor talks to an assistant it starts itself.

### Answering another assistant (A2A)

The switch lives beside the one for other AI tools, in `settings/mcp-sharing` as `a2a`. While it is off, `/.well-known/agent.json` and `/a2a` answer `404` — not a refusal, but nothing at all, so this install does not advertise itself by accident.

**The card.** `GET /.well-known/agent.json` describes this assistant: its name, what it is, the address to send work to (`/a2a`), `authentication.schemes: ["bearer"]`, `capabilities.streaming: true`, and its skills. The skills are `branch.ask` — asking Branch for something in plain words, always offered — plus every tool you ticked in the shared list, so A2A never offers more than MCP does.

**Tasks.** JSON-RPC 2.0 by `POST` to `/a2a`, with your session key as `Authorization: Bearer …` (the same key as every other route; the server listens on this computer only). `tasks/send` runs one task and answers with it. `tasks/get` finds one started earlier — in memory only, so a restart forgets tasks that were still running. `tasks/cancel` stops one. `tasks/sendSubscribe` answers with a stream instead: a `submitted` state, then one state update for every step Branch records, then the answer as an artifact and a last update marked `final`.

A task is a plain Branch task: it shows in Activity with the same signed receipts, its events carry `source: "a2a"`, and an `a2a.task` event names the assistant that asked. Because you did not start it, it never gets more freedom than **Ask before changes** — a standing yes of yours does not travel to a stranger, so anything that would change a file, run a command or act on a web page stops and waits for you, and the caller is told the task is `input-required`. This works the same way as MCP, and so does its one gap: while you have chosen **No approvals** — which is how Branch behaves until you pick something else — there is nothing to hold a caller to, and it can use any of Branch's tools without stopping to ask. Pick an approval setting before you switch this on. Note too that the shared tool list shapes the card's skills but not what a task may do: `branch.ask` reaches the whole toolbox, within your approval setting.

**What does not cross.** Only written instructions. A message part that is a file, an image or anything other than text is refused with "Branch takes written instructions only". One calling assistant may start 20 tasks a minute (a `-32003` error and HTTP 429 past that), and a task is stopped after two minutes, like every other task. Name yourself with an `X-Branch-Agent` header so the allowance and the record are per caller — it is a name for the record, not a credential, so the allowance only holds honest callers apart.

### Handing work to an assistant elsewhere

`agents.remote { action: "add" | "list" | "remove" }` keeps the list. Adding one reads its card (give either the card address or the site it lives on) through the same address rules as web reading, so **an assistant on this computer or your own network is unreachable until you allow private addresses under Web reading**. A key that install gave you is stored beside the settings and never handed back out by any route.

`agents.ask { agent, task, timeoutMs }` sends one piece of work and waits. The request body contains the words of the task and nothing else — no files, no secrets, nothing the assistant has read. The wait is 60 seconds by default and 120 at most, one assistant can be asked 10 times a minute, and the answer is charged against the task's own token allowance. The call is an ordinary tool call, so it carries a receipt and shows in Activity as "Asking *name*, an assistant elsewhere".

**Routes.** `GET /api/agents/remote` lists them and `POST` the same path adds one (`{ cardUrl, key? }`); `POST /api/agents/remote/remove` takes `{ agent }` (an id or a name). `GET /api/agents/discover?targets=127.0.0.1:3211,example.local:3210` asks each address you type in — and only those; nothing is scanned or broadcast — for its card, and answers `{ found, refused }` with a plain reason for each one it could not reach. `GET /api/agents/pairing` returns `{ code, cardUrl, shareUrl }`; the share link is `branch://add-agent?card=…&key=…&code=…` and **carries this install's session key — the one key to everything Branch serves, not a pairing code of its own. Whoever holds it can do anything you can do here, so share it only with an install you would trust with your own account, and only over something private.** The other install adds you with `POST /api/agents/pair { link }`.

### Working inside a code editor (ACP)

`branch acp-serve` speaks the editor protocol as newline-delimited JSON-RPC on standard input and output; everything meant for a person goes to standard error, so the protocol stream stays clean, and it stops when the editor closes the connection. It answers `initialize` (protocol version 1), `session/new` (a real Branch conversation, so it is searchable afterwards), `session/prompt` — the answer streams back as `session/update` notifications with `agent_message_chunk` — and `session/cancel`.

When a step needs your yes, Branch asks the **editor**, with `session/request_permission` naming the step in plain words and offering `allow` and `reject`. Your answer goes straight to the approval rules and the turn carries on or stops, and the turn ends with `end_turn`, `refusal` or `cancelled`. Tasks from an editor carry `source: "acp"` and are capped the same way A2A tasks are. Attachments are refused here too.

For **Zed**, add this to `settings.json` (Zed: Open Settings), replacing the two paths with your own:

```json
{
  "agent_servers": {
    "Branch": {
      "command": "branch",
      "args": ["acp-serve"],
      "env": {
        "BRANCH_DATA_DIR": "C:/Users/you/AppData/Roaming/BranchAgent",
        "BRANCH_WORKSPACE": "C:/Users/you/Documents/Branch"
      }
    }
  }
}
```

From a source checkout use `"command": "node"` and `"args": ["C:/path/to/branch/dist/cli.js", "acp-serve"]`. Set the two paths explicitly, because the editor starts Branch in the editor's own folder, not Branch's. The editor starts a second copy of Branch against the same records, so close the app first — two copies cannot share one database. Any editor that speaks the same protocol works the same way.

## Delegation

`specialists.delegate` runs an evaluated specialist as a child task with the parent's budget and a subset of its permissions. Optional `resultSchema` (a small JSON-Schema subset: type, required, properties, items, enum, minimum/maximum, minLength, minItems) makes the child's JSON answer be checked; a mismatch comes back as `unresolved` with a reason and a `delegation.unresolved` event on the parent. Children stop after `timeoutMs` (1 to 120 seconds, default 120). At most four children run at once per parent and delegation depth is limited to three; cancelling the parent cancels its children.

`specialists.fanout` takes up to eight tasks, each naming a specialist and optionally `dependsOn` earlier task ids. Independent tasks run at the same time; dependent tasks run after their dependencies and receive those results in their prompt. Cycles and unknown ids are rejected before anything starts, and the merged outcome is recorded on the parent as a `delegation.fanout` event.

## Plans, reviewers and several specialists at once

Everything in this section is off until you turn it on, so a task behaves exactly as it always has unless you ask for one of these.

**Settings.** `GET|POST /api/orchestration` holds five switches, also shown in `/api/state.orchestration`: `autoPlan` (plan first when a task looks long or has several parts — over 600 characters, three or more bullets, or two or more "then"/"finally" style joins), `planApproval` (show the plan and wait for your yes before anything is done), `verify` (have a reviewer check the finished answer), `milestoneRounds` (write a "where we are" note every this many rounds; 0 turns it off) and `stuckAction` (`default`, `ask`, or `switch`). All default to off, and `milestoneRounds` to 0.

**A plan for one task.** `POST /api/run { prompt, plan: true }` asks the model for two to six numbered steps before any work starts. The steps are saved for the conversation and carried out in order: each one is given to the model on its own, and a step that comes back without the word its plan entry asked for is tried once more before the task stops. Events: `plan.created`, `plan.step.started`, `plan.step.retry`, `plan.step.finished`, `plan.completed`, and `plan.failed` when the model's plan cannot be read (the task then simply runs as usual). A planned task gets four extra rounds per step, up to forty.

**Approving and editing a plan.** With `planApproval` on, the task stops with status `needs_input` and the plan as its question (`plan.awaiting_approval`), the same way a question from the assistant does. `GET /api/runs/:id/plan` returns the plan; `POST /api/runs/:id/plan { steps }` replaces the steps and marks it approved (`plan.approved`); saying "go ahead" in the conversation also approves it. Your next message then carries it out. A plan being carried out by a task that stops early is dropped, so the next thing you ask is never answered by an abandoned plan, and a plan you were shown but walked away from is dropped as soon as you ask for something else. If the assistant stops in the middle of a plan to ask you something — an approval rule, for instance — the rest of the plan is not picked up again: your answer carries the conversation on as an ordinary task.

**Several specialists at once.** `delegate.parallel` runs up to six specialist branches together (at most four are in flight at a time, the same limit as other children). What is left of the task's token budget is split evenly between them, and a branch never costs the task more than its share. One branch failing leaves the others running unless `failFast` is true. The answers come back for the model to combine into one, and the whole thing is recorded as a `delegation.parallel` event. `delegate.handoff { specialist, brief }` hands the rest of a piece of work to a named specialist and brings its answer back, recorded as `delegation.handoff`.

**Steering a task that is working.** `POST /api/runs/:id/steer { text }` puts a note in front of the task's next round (`run.steered`, then `run.steer_applied` when the task reads it), and the note is kept in the conversation like any other message. This is not the same as a follow-up: `POST /api/sessions/:id/followups` queues a message to run *after* the current task finishes, while a steer reaches the task that is working now. Only a task that is still working can be steered.

**A reviewer pass.** `POST /api/run { prompt, verify: true }` (or the `verify` setting) has the model check its own finished answer, in a separate pass with no tools, against the task's declared `checks` and what it remembers about you. The reviewer answers `accept` or lists concrete fixes; fixes are applied and the answer is reviewed once more, at most twice in all. Events: `verify.started`, `verify.verdict` (the verdict and the fixes) and `verify.failed`. A reviewer whose answer cannot be read accepts, so this never blocks an answer.

**Long tasks.** With `milestoneRounds` set, a `run.milestone` event records a plain note of what has been done so far, built from the task's own events without asking the model anything; the newest note per conversation is kept for the context pane and for continuing after a restart. With `stuckAction` set to `ask` or `switch`, a task whose model has gone quiet twice stops and asks you, or moves to the next model, instead of trying the same thing a third time (`run.stuck`). `default` keeps the existing retry-then-fall-back behaviour.

**The shared scratch area.** `scratch.set { key, value }` and `scratch.read { key? }` are a small notepad shared by a task and every specialist working under it: at most 32 notes, 4,000 characters each and 64,000 in total. It is emptied when the task finishes. Reading is treated as looking, writing as a change, so an approval preset that asks before changes asks about `scratch.set`.

`GET /api/activity` carries the new state for anything that shows running tasks: `plan` (the steps, which one is running, whether it is waiting for you), `milestone` (the latest note) and `verdict` (what the reviewer said).

## Your documents

**Documents** in the sidebar holds the files you want the assistant to be able to quote. Add one by typing where it sits in your workspace, by choosing files, or by dragging them onto the panel — up to 20 MB each. Notes, Markdown, web pages, tables, JSON, Word files (`.docx`) and spreadsheets (`.xlsx`) are read. A PDF is listed as **Needs a PDF helper** and is not searched until there is one. Each document shows its size, how many passages it holds, and whether it is ready. **Read the file again** rebuilds a document from its workspace file. A file the assistant changes with `files.write` is indexed again straight away, so searches see the new wording immediately; comparing by meaning waits for the next **Read the file again**, so a file written repeatedly never waits on the provider. The document says which state it is in.

Text is split into passages of about 3000 characters with 400 characters of overlap, ending at a paragraph or sentence where one is near. Passages are indexed in SQLite full-text search and ranked with BM25, and the search box shows the matching words highlighted. Where this build of SQLite has no full-text search, the panel still finds passages by plain word matching and says nothing about ranking; a warning is printed once at startup.

If your model connection is an OpenAI-compatible one, its `/embeddings` route is also used (model `text-embedding-3-small` by default, changeable through `embeddingModel`): passages are sent in batches of at most 64, the answers are kept on this computer as vectors, and the two orderings — by wording and by meaning — are combined with reciprocal rank fusion. Without such a connection, or if the provider refuses, the document is still searchable by its words and the panel says so. Embedding requests go to the provider address only, under the same rule as every other provider call (HTTPS, or plain HTTP only on this computer).

**Use my documents when answering** puts the three best passages in front of each of your tasks, each labelled with the document it came from, the same way remembered facts are. It is on while your library has something in it and can be switched off. Specialists working on your behalf do not receive them, document text is marked as untrusted, and a retrieval that fails is recorded (`documents.retrieved`, `documents.retrieval_failed`) without stopping the task.

Routes: `GET /api/documents` (the library, the switch and the size limit), `POST /api/documents` with `{ path }`, `{ text }` or `{ name, content }` where `content` is the file's bytes base64-encoded, `DELETE /api/documents/{id}`, `POST /api/documents/search` with `{ query, limit }`, `POST /api/documents/reindex` with `{ id }`, and `GET|POST /api/documents/settings` (`useDocuments`, `embeddingModel`). The tools are `documents.search` and `documents.list` under `documents.read`, and `documents.add` and `documents.remove` under `documents.write`.

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

### Temporary conversations

Tick **Temporary** before the first message. Nothing from that conversation appears in conversation search, the saved-conversation library, exports, copies or branches, and its tasks cannot write long-term memory. Starting a new conversation (or `POST /api/sessions/:id/discard`) deletes its messages, tasks, events and usage. Any temporary conversation left behind by a crash is purged the next time Branch starts.

### Forgetting what a conversation saved

Open a conversation and choose **Forget what this conversation saved to memory**. The preview lists the facts its tasks saved on their own, and separately the ones you edited afterwards, which are kept. Confirming removes the listed facts in one step and records that this conversation must not save memory automatically again; `memory.put` from it is refused with a plain message, while you can still save facts yourself from the Memory view. API: `POST /api/memory/forget/preview {sessionId}`, `POST /api/memory/forget {sessionId, ids?}`.

### First-run setup

Until setup is marked done, the Conversation view opens with three doors: sign in with a ChatGPT plan, use an API key, or look around on the offline demonstration. **Test the connection** makes one real, tool-free completion through the model that will answer next and reports the reply and how long it took (`POST /api/models/test {preset?}`); nothing is added to your conversations. **Done, start chatting** records completion (`POST /api/onboarding {done: true}`).

### Stored facts

In **Memory**, edit a fact and its source, then save the correction. Each editor retains the revision it opened; if another write changes that fact, saving reports a conflict and keeps your draft. Cancel reloads the latest saved value. Editors retain focus and cursor selection during background refreshes.

Each owner has a persistent capacity of 1–500 facts, defaulting to 500. The Memory panel displays the count and lets you change the limit. New additions and imports that exceed it are rejected; existing facts can still be corrected or deleted. Lowering the limit below the current count is rejected. Older databases migrate without dropping records, including whitespace-only facts accepted by earlier versions. Legacy stores above 500 keep their records, but require reducing their count before bounded export or new additions.

The `memory.update` tool requires `memory.write` and accepts `{ "id": "...", "text": "Corrected fact", "source": "Owner correction", "expectedRevision": 1 }`. Search returns the current revision. `memory.search` requires `memory.read` and returns up to 20 matching facts within 48 KiB of UTF-8 JSON, most useful first, each with its `score`, `importance` and whether it matched by `words`, `meaning` or `both` — see **Matching facts by meaning** below. A future model session sees a correction when it retrieves the fact through this tool.

**Export memory JSON** saves fact IDs, text, sources, source-run references, creation/update times and revisions. **Import memory JSON** merges the archive into the current owner: exact matching records are unchanged, new IDs are added, and a conflicting ID aborts the entire import. Archived source references are descriptive metadata and do not grant access to another owner's runs. Capacity settings are managed separately. These archives support up to 500 records and 16 MiB; malformed archives and unsupported versions are rejected.

The authenticated routes are `GET /api/memory/export`, `POST /api/memory/import` with the archive, and `POST /api/memory/capacity` with `{ "maxFacts": 500 }`. Desktop exports use a native Save dialog with a validated archive; browser exports download a JSON file.

### Repeats, disagreements and facts you never use

In **Memory → Repeats, disagreements and facts you never use**, **Look for problems** reads your saved facts and changes nothing. It reports three things: the same thing saved more than once (the same words, or the same meaning when facts have been prepared for meaning matching), a newer fact that disagrees with an older one about the same subject, and — only when memory is nearly full, at nine tenths of your limit — the facts that have been least useful.

Two facts count as being about the same subject when they share an `entity` and `attribute`, or when the label before the first colon in their text matches. That label must be two or more words and must not be one that heads a list (`note`, `todo`, `task`, `reminder`, `idea`, `tip`, `question`, `fyi`), so "Note: buy milk" and "Note: call the dentist" are left alone, and so are two facts that each start "Address:". For details that change over time, give the fact an `entity` and `attribute` rather than relying on the label.

**Turn them into suggestions** writes what it found into the same **What it learns** queue the assistant's own suggestions use. Nothing is applied until you accept it. Accepting a repeat keeps one fact (with the fullest wording) and sets the others aside; accepting a disagreement sets the older fact aside with a note naming the newer one; accepting a rarely-used fact sets that one aside. **Set aside** is not deletion: every fact stays in the Memory view's set-aside list with the reason, and **Bring back** returns it. Which fact is newer comes from when it became true (`validFrom`), not from when it was typed.

How useful a fact is combines three things: how recently it changed, how often the assistant has drawn on it, and whether you stood behind it (you saved or corrected it yourself rather than a task saving it). That same order decides which facts search returns first and which facts go into the memory snapshot a new conversation starts with.

Routes: `GET /api/memory/tidy` (read only) and `POST /api/memory/tidy {}` (stage suggestions).

### Matching facts by meaning

`memory.search` matches the words in a fact using the database's own ranking, and — when the connected model also answers `/embeddings`, the same route the document library uses — compares facts by meaning as well. The two orders are combined with reciprocal rank fusion and then weighted by how useful each fact has been. Without a key, without an embeddings route, or with meaning turned off, word search stands alone; on a build of SQLite without full-text search, facts are matched plainly instead.

**Also match facts by meaning** turns it on or off per owner, and **Prepare facts for matching by meaning** sends your fact texts to the provider in batches of 64 so they can be compared. Only the text of a fact is sent; nothing else leaves this computer. Routes: `GET|POST /api/memory/retrieval {useEmbeddings, embeddingModel}`, `POST /api/memory/index {}`, and `POST /api/memory/search {query, limit}`.

### Facts as JSON Lines, conversations as Markdown

**Save facts to a file** downloads one fact per line — the format other assistants read and write — from `GET /api/memory/export?format=jsonl`. **Bring facts in from a file** posts `{"jsonl": "..."}` to `POST /api/memory/import`; a fact already saved under any identifier is counted, not copied, and unreadable lines are reported rather than failing the whole file. Up to 2000 lines and 16 MB at a time. The whole-archive JSON export and import are unchanged and still available at the same routes.

`GET /api/sessions/:id/export?format=markdown` saves one conversation as Markdown, with a heading per turn and a note for each tool the assistant used. The JSON export at the same path without `format` is unchanged.

## Long conversations: what is kept and what you pin

When a conversation grows past the fold-away threshold, the assistant is asked to summarise the older turns as a structured note: what we are trying to do, what was decided, what is still open, and which files were touched. The note is stored for the conversation and written out for the model to read back; if the model replies with plain text instead, that text is kept as before. `GET /api/sessions/:id/summary` returns `{summary, text, createdAt, pins, working}`.

**Pins** keep one message in front of the assistant however long the conversation runs. `POST /api/sessions/:id/pins {"messageId": 12, "pinned": true}` pins, `{"pinned": false}` unpins, and `GET /api/sessions/:id/pins` lists them. Only something you or the assistant said can be pinned — a tool result cannot be kept on its own, because it would be separated from the request that produced it. Pins are held against a message's lasting identity, so they survive the transcript repair that follows an interrupted task.

Each conversation also keeps a one-line note of what is going on in it: the last thing you asked for, the last file touched and the last step taken. It appears in the context pane under **What we are doing** and rides along with the running-task list at `GET /api/activity`.

## Showing the assistant a picture

`POST /api/run` accepts `images`: up to four entries of `{mediaType, data, name?}`, where `mediaType` is `image/png`, `image/jpeg`, `image/webp` or `image/gif` and `data` is the picture's bytes base64 encoded (a `data:` prefix is accepted and stripped). Each picture may be up to 5 MB.

The picture is handed to the model with that message only. The stored conversation keeps a short note — `[attached picture: square.png]` — and never the bytes, so a picture is not replayed on every later turn and does not count against the conversation's size. A model that cannot look at pictures says so plainly and the task stops with that message rather than quietly dropping the picture; the OpenAI-shaped and Anthropic adapters can both be shown one.

In the conversation, the picture button next to the message box attaches pictures and sound files, and files can also be dragged onto the message box. A picture becomes a chip you can remove and travels with the next message. A sound file is written out to words first (through `POST /api/voice/transcribe`) and the words are put into the message box, so you can read and edit them before sending.

## Pictures, sound and video

**Settings → Pictures and sound** holds three things: which model makes pictures (leave it empty to use whatever the connected provider usually uses), which folder in your workspace finished files are saved into (`media` by default), and your own corrections to the per-picture prices. API: `GET|POST /api/media/settings`.

The assistant has these tools, each of which asks first whether the connected provider can do the job and says so plainly when it cannot:

- `media.image` — make a picture from a description, or change one already in your workspace. OpenAI-shaped providers are asked at `/images/generations` and `/images/edits`; Gemini is asked for a picture through its own `generateContent` route. The finished picture is kept privately beside the assistant's own database, and also saved into your workspace when you give it a file name. The result carries a rough cost from the per-picture price table (about $0.04 for one 1024×1024 picture with the common models, checked 2026-09-16). The table covers that one size only, so a picture asked for at any other size reports no price rather than the wrong one, and a model that is not in the table is reported as unknown, never as free. A price you type in yourself is used for every size, because it is yours to mean what you like.
- `media.describe` — look at a picture in your workspace and say what it shows, read the words in it, or write out a table it holds. `media.compare` does the same for two pictures side by side. Both go through the same picture plumbing as an attached picture, so a model that cannot see says so before anything is read.
- `media.transcribe` — write out what is said in a sound file in your workspace, with the time each phrase was said when the provider offers times.
- `media.speak` — read text aloud into a sound file, in a voice you name.
- `media.trim` — cut a stretch of sound, between two times in seconds, out of a **WAV** file. This is done here in plain JavaScript; MP3, M4A, OGG and other squeezed formats need a converter, which is not part of this app, and are turned down in plain words.
- `media.info` — how long an MP4 video or a WAV sound file runs, what kind it is and how many tracks it carries, read from the file's own headers.

**What is deliberately not here.** The assistant does not make videos, and it cannot pull still frames out of one: that needs a video decoder this app does not ship, and no tool pretends otherwise. `media.info` exists so it can still reason about a video's length and shape. Sound editing is limited to trimming uncompressed WAV.

Reading a file is `media.read` and counts as looking, not changing; making a picture, speaking and trimming are `media.write` and are held to your approval rules like any other change. Each of those tools tells the approval rules the workspace path it would write (`media/poster.png`), so a rule about that folder fires on the path the file really gets rather than the bare name that was asked for. Every result is signed by the ordinary tool receipt, so what was made and where it was saved can be checked afterwards. A practice run reports what it would have made without calling the provider.

**Documents → Made by the assistant** lists the pictures the assistant has made or captured, newest first, with how big each is and where it is on this computer. API: `GET /api/artifacts?type=image` for the list and `GET /api/artifacts/file?path=…` for one file's bytes; both refuse anything outside the assistant's own artifacts folder.

## Schedules, delivery and triggers

A schedule is a reminder, a task, or a **check** (a task that receives its previous result and reports what changed). It repeats on an interval or **every day at** an `HH:MM` wall-clock time in an IANA `timezone`, computed correctly across daylight-saving changes. **Send the result to** a channel chat that has already talked to the assistant; the destination and message id are recorded on the schedule and in the run's events. Each schedule keeps its last 50 executions with status and what triggered them.

**Run now** in the Schedules view, `POST /api/schedules/:id/trigger`, or `node dist/cli.js trigger <schedule-id>` run a schedule immediately without moving its next due time. Tick **Allow a webhook to trigger this** to receive a per-schedule token; then `POST /hooks/<schedule-id>` with the header `x-branch-hook-token: <token>` and a JSON body (up to 16 KiB) runs it with the payload appended to the prompt. Webhooks use only that token, not the session token, and are refused with 401 otherwise.

## Triggers and webhooks

In the app these sit at the bottom of the **Schedules** screen, under *When something happens elsewhere* and *Let another app know*.

**Inbound triggers** let another app start a task here. A trigger has a name, the prompt to run, an optional conversation to run it in, and a rate limit (30 a minute by default). Creating one produces the web address `POST /api/triggers/:id/fire` and a 24-byte secret. A request proves itself with either a bearer token (`Authorization: Bearer <secret>`) or a signature over the exact request bytes (`X-Branch-Signature: sha256=<hex>`, HMAC-SHA256 with the same secret); anything else is refused with 401. The prompt may contain `{{payload}}` (the whole body as JSON) and `{{field.path}}` (one value out of it, for example `{{user.name}}`), filled in before the task starts. A body over 256 KiB is refused with 413, a trigger that is switched off with 403, and one over its limit with 429. Every attempt is written to the trigger's log with a short summary of the body, the task id and how it ended. The fire route is the only route that does not need the session token, because it carries its own secret.

**Outbound webhooks** tell another app when something happens here. A webhook has a name, a web address, an optional shared secret, and the list of events it wants: `run.completed`, `run.failed`, `schedule.fired`, `delivery.failed` (a chat message the delivery ledger gave up on), `trigger.fired`, and `approval.needed` (the assistant stopped to ask you something). Each delivery is a JSON POST carrying the event name, a timestamp and the ids involved — never the task's own text, which stays here and can be read over the authenticated API. When a secret is set, the exact body sent is signed into `X-Branch-Signature`. A delivery that fails is tried three times in all, pausing 5 seconds and then 10 seconds between tries; once five deliveries in a row have given up the webhook switches itself off with a reason, and **Turn back on** clears that. A delivery that succeeds resets the count. Sending is fire-and-forget: a refused address, a dead endpoint or a slow one never delays or fails the work that caused the event.

Two consequences worth knowing. Every task announces itself, including the short internal ones the assistant starts for itself (delegated helpers, the after-task review), so a busy install is chatty. And anything that does not end in success — a failure, a cancellation, an exhausted budget, or a stop to ask you a question — arrives as `run.failed` with the real outcome in its `status` field; a task that stopped to ask you something sends `approval.needed` as well.

Every outbound delivery goes through the shared network policy, so a webhook address on this computer or a private network is refused unless private addresses are allowed in the web settings.

Routes, all behind the local session token like the other owner-only settings: `GET /api/triggers`, `POST /api/triggers`, `GET /api/triggers/:id`, `GET /api/triggers/:id/log`, `POST /api/triggers/:id/rotate-secret`, `POST /api/triggers/:id/enabled` (body `{ "enabled": true }` or `false`), and `POST` or `DELETE /api/triggers/:id/remove`. The same shape for `/api/webhooks`, plus `POST /api/webhooks/:id/test` (send a test payload now, without retries) and `POST /api/webhooks/:id/enable`. A trigger's secret is returned to the owner so it can be copied into the other app; both secrets are kept in the private database alongside the rest of the settings.

## Version control and GitHub

The assistant can use the copy of **Git** already installed on this computer to look after your work: see what changed, look back through saved versions, keep separate lines of work, and save a version with a message. It finds Git itself the first time it needs it; if Git is not installed it says so plainly instead of failing in code. Everything happens inside your workspace, or inside the active project's folder, and a repository's own hooks are switched off so nothing hidden in a folder can run.

These tools come in three groups so you can allow them separately.

- `git.read` — `git.status` (what changed, which line of work, ahead or behind), `git.diff` (the changed lines, capped, either in the working folder or between two points such as `main..mine`), `git.log` (recent saved versions, bounded).
- `git.write` — `git.branch` (list, start or switch a line of work), `git.commit` (save a version; a message is required, it saves everything that changed unless you name paths, it refuses when nothing has changed, and it never rewrites a version you already saved), `git.worktree` (a parallel copy for an experiment, only ever inside `.branch-worktrees` in the repository, so experiments cannot spread elsewhere). Both groups are available as soon as Branch starts.
- `git.remote` — `git.push` and `git.pull`. **These are off until you turn them on.** Add a `git` block to the integrations file:

```json
{ "git": { "remote": true } }
```

Sending work to the branch everyone shares (`main` or `master`) stops and asks you first, in the same way the assistant asks any other question; answer yes and it goes ahead. Pulling only ever adds work cleanly on top of yours; it never merges over the top of your changes. A message that arrives from a chat app (Telegram) can read and change the copy on this computer but can never push or use GitHub.

**GitHub** needs a personal access token that you create on GitHub and paste in yourself. Save it in **Settings → Projects → Secrets** of the project you want it in, under the name `GITHUB_TOKEN` (secrets use environment-style names, so this is the stored name for what the GitHub API calls a token). Then switch GitHub on in the integrations file:

```json
{ "git": { "remote": true, "github": { "tokenSecret": "GITHUB_TOKEN" } } }
```

That registers `github.create_repo` (private unless you say otherwise), `github.open_pull_request`, `github.list_issues` and `github.create_issue`, all behind the `github.manage` permission. The token is read from whichever project is active at the moment of the call, is sent only in the request header, is never written into a web address, and is scrubbed out of anything reported back — it cannot appear in Activity, in a receipt, or in an error message. Every GitHub address goes through the same network policy as web reading, so an address that is blocked there is refused here too. There is no GitHub App and nothing is installed on your account.

**Hiding files from the assistant: `.branchignore`.** Put a file called `.branchignore` in the workspace root and list anything you would rather the assistant did not read, using the same syntax as `.gitignore` (one pattern per line, `#` for a comment, a trailing `/` for folders only, `!` to un-hide, `*` and `?` inside one name, `**` across folders). Files it hides disappear from `files.read`, `files.list` and `files.search`, a hidden folder can no longer be used as the working folder of a host command, and the Git tools respect it too: hidden files are left out of `git.status`, out of `git.diff`, and are never staged by `git.commit`.

Precedence, in order: the fixed secret patterns come first and cannot be overridden — `.env` files, `.ssh`, `.aws`, `.git`, anything named like credentials or secrets, and key files (`.pem`, `.key`, `.p12`, `.pfx`) are always refused, and a `!` line in `.branchignore` does **not** bring them back. `.branchignore` then hides more on top of that. Nothing inside a hidden folder can be un-hidden. The file is re-read whenever you change it, so there is nothing to restart.

## When to check with me: approval rules, practice runs and pace limits
Settings → **When to check with me** decides how much Branch Agent may get on with by itself. Until
you choose something, nothing changes: Branch Agent does whatever its tools allow, exactly as before.
**The four choices.**
- **No approvals** (the starting point). Nothing is checked with you and nothing is refused.
- **Ask before changes.** Reading is free. Anything that changes a file, runs a command or acts on a
  web page stops and waits for your yes.
- **Just do it inside my workspace.** Writing files is fine. Running a command, and clicking or
  typing on a web page, wait for your yes; a website Branch Agent has not used before is checked
  with you once and then remembered.
- **Read only.** Branch Agent may look at things and answer, but may not change a file, run a
  command or act on a web page. A refusal is explained in the answer; the task is not killed.
Each choice fills in a list of **rules**, which you can then edit. A rule says: for this tool
(`files.write`, `browser.*`, or `*` for everything), and for what it would touch (a file path, the
start of a command, or a website's address), Branch Agent **goes ahead**, **checks with you**, or
**is not allowed**. `*` in a pattern stands for any text; everything else is matched literally, and
matching ignores capital letters. Rules are read from the top and the first one that matches decides.
A rule can be limited to tools that *change* something, so it never gets in the way of reading.
**Answering a question.** When a task stops for a yes, it appears under *Waiting for your yes* in
the same Settings screen (and as the usual "needs input" pause on the conversation). You can say yes
just this once, yes for the rest of that conversation, yes always, or no. "Yes always" is written
back into your rules as a new rule at the top, so you are not asked again. After you answer, send
your next message in that conversation to carry on.
**Tasks you did not start yourself.** A task started by an inbound trigger, by a schedule or by
another AI tool over MCP never gets more freedom than *Ask before changes*, and it cannot give
itself a permanent yes from inside the run — the most it can be granted is a yes for that one
conversation. This only applies once you have chosen something other than *No approvals*.
Worth knowing before you choose: nobody is sitting there to answer for those tasks. Once you pick a
setting, a schedule or trigger that wants to change something stops and waits, and stays waiting
until you answer it in Settings. Branch Agent tells you it has: the pause appears under *Waiting for
your yes*, and an outbound webhook subscribed to `approval.needed` is sent at the same time, so an
unattended install can be told about it wherever you actually look.
**What the rules do not cover.** They apply to what the assistant decides to do on its own. A tool
you run yourself from this app (`POST /api/action`) is your own action and goes straight through.
**A practice run.** `POST /api/run` with `"dryRun": true`, or `node dist/cli.js run "..." --dry-run`,
runs the task for real but stops every tool that would change something: each one reports what it
*would* have done, and the task's events end with a `dryrun.report` listing every intended action.
Tools that only read run normally, so the assistant still sees real information.
**How fast one conversation may work.** Two optional limits, both per conversation and both off (0)
by default: how many tools may be used in a minute, and how many times it may go back to the model
in a minute. Going past a limit is not a failure — the task pauses, records `rate.paused` with a
plain message, waits for the window to clear, records `rate.resumed`, and carries on.
**A saved file that should be JSON.** When Branch Agent writes a file ending in `.json` that turns
out not to be valid JSON, a `file.invalid_json` warning is recorded with the reason. The file is
kept as written; nothing is undone.
Routes, behind the local session token: `GET /api/policy` (the saved policy, the presets to choose
from, and anything waiting for an answer), `POST /api/policy` with `{ "preset": "read-only" }`,
`{ "rules": [...] }` or `{ "limits": { "toolCallsPerMinute": 30 } }`, and `POST /api/policy/approve`
with `{ "sessionId": "...", "decision": "allow", "remember": "session" }`. Anything left out of a
`POST /api/policy` keeps its current value; sending your own rules marks the policy as your own.
## Persistence and schedules

`npm run chat` opens a streaming terminal session using the same provider, workspace, private state and integration variables. Ctrl+C or `/cancel` cancels the active run and returns to the prompt; a new request typed during execution cancels and drains that run before continuing the same conversation. `/new` starts a new conversation, and `/exit` shuts down. Partial text displayed before a cancelled/failed stream remains uncommitted; received provider usage and estimates still contribute to that run's accounting. Streaming is currently exposed through the terminal; the web/desktop conversation waits for the final result.

Run only one Branch Agent process per data directory. SQLite stores conversations, memory, procedures, specialists and schedules. Schedules execute while the process is running. Missed interval occurrences coalesce into one execution. Interrupted or failed tasks are recorded; external side effects are not automatically retried.

Local HTTP authorization is single-owner access, not a multi-user tenancy system. Built-in file restrictions are not an operating-system sandbox for separately configured programs.

## Appearance and the app shell

`GET /api/state` returns a `preferences` record and `POST /api/preferences` replaces it. The
record (`PreferencesSchema` in `src/preferences.ts`) holds `appearance` (`forest` or `daylight`),
`followSystem`, `accent` (`copper`, `leaf`, `earth`, `slate`, `ink`), `textSize`
(`small`/`medium`/`large`), `density` (`comfortable`/`compact`), `font` (`geist`/`system`),
`reduceMotion` and `showAcorn`. Every field has a default, so a record saved by an older version
still loads. Settings → Appearance changes all of them; each choice shows at once and Save keeps
it.

Every section (Conversation, Activity, Usage, Memory, Skills, Specialists, Procedures, Schedules,
Documents, Settings) is a row in the rail's "Sections" group on the left, so nothing hides behind a
drop-down. Below it, "Projects" lists the workspace folders (`POST /api/projects/active` switches
the active one) and "Recents" lists conversations from `POST /api/sessions/search`, grouped by day.
Each group folds and the choice is kept in this browser. Renaming, pinning and taking a
conversation off the Recents list are this browser's own labels, kept in local storage; they never
change the saved conversation, which stays in Settings → Saved conversations.

The owner row at the foot of the rail opens Settings and connections, Change the appearance, Lock
session, Check for updates and About. Ctrl+K opens a search box that jumps to a section, a saved
conversation, a project, a recipe, a skill, or an action such as starting a conversation or
checking for updates. Ctrl+N starts a conversation, Ctrl+, opens Appearance, and Esc closes
whatever is open.

The pane on the right reads the state you are already authenticated for: the active model from
`GET /api/state`, running tasks from `GET /api/activity`, the receipts of this conversation's last
tasks from `GET /api/runs/:id/receipts` translated into plain language, and recently saved memory.
It refreshes every five seconds while it is open and hides below 1180 px. The interface files
`/tokens.css`, `/shell.css`, `/shell.js`, `/context-pane.js` and `/appearance.js` are served from
the same local allowlist as the rest of the interface. See [design.md](design.md) for the tokens
and the layout.

## Skill packages, registry versions, plugins and suggestions

A **skill package** is one file (`.branchskill`) holding a `skill/` folder: `SKILL.md`, an optional
`tools.json` and an optional `hooks.json`. It is a zip built with Node's own compression, so no
extra software is needed. Inside it sits `branch-package.json`, the manifest: the skill's name, the
package version, who made it, what the package asks to be allowed to do, and a fingerprint
(SHA-256) of every file. Opening a package checks every fingerprint; if any file was changed after
it was made, or a file is present that the manifest does not list, nothing is installed.

`tools.json` describes web calls the skill may make: `{ "tools": [{ name, description, method,
url, headers, body, input, pick }] }`. `{{name}}` in the address or a header takes one of the
tool's declared inputs. `{{secret:NAME}}` in a header or the body takes a secret from your locker
in the active project: the value is fetched at the moment of the call, is never written into the
task's record, and is replaced with `[secret NAME]` in anything the assistant reads back. Every
address goes through the same network rules as the rest of Branch, and only the fields listed in
`pick` are kept from the answer. These tools are registered as `skill.<skill name>.<tool name>` and
need the `skills.http` permission. `hooks.json` is `{ "hooks": [{ event, recipe }] }`: when that
event happens, Branch runs one of **your own** verified recipes by that name. A package can never
bring a recipe of its own.

Routes: `POST /api/skills/package/inspect { file }` (base64; shows the manifest, the addresses, the
secrets it wants and the plain-language list of what it asks for, and installs nothing),
`POST /api/skills/package/install { file, approve }` (nothing happens unless `approve` is true; the
skill arrives switched off and is scanned like any other), `GET /api/skills/packages`, and
`POST /api/skills/:id/pack { author, packageVersion }` which builds a package from a skill you
have. On the command line: `branch skill pack <folder> [out.branchskill] --author "Your name"
[--package-version 1.0.0]` and `branch skill install <file.branchskill> [--approve]`.

**Registries, version 2.** A registry index may now say `"version": 2` and publish a `publicKey`
(base64 ed25519). Each listed skill may carry a `version`, a `changelog` and a `signature`, made
over the exact lines `branch-skill-registry`, the registry name, the skill id, the version and the
fingerprint. Branch labels every entry `checked`, `unsigned` or `invalid`; an `invalid` signature
stops the install, an unsigned entry is installed but plainly labelled as unsigned. Version 1
indexes still work exactly as before. `GET /api/registry/updates` asks the registries you installed
from whether a newer version exists and returns the changelog; `POST /api/registry/update
{ skillId }` saves the new version and switches to it, keeping the one you had;
`POST /api/registry/rollback { skillId }` puts that earlier version back.

**Help writing a skill.** `POST /api/skills/draft-from-runs { skillId, runIds }` reads two to six
tasks that went well and proposes one improved version, saved but not switched on.
`POST /api/skills/:id/test { version, examples }` runs the examples the skill lists under an
`## Examples` heading (one task per bullet) with that version in place and reports what each one
did; sending `examples` overrides the ones in the document. At most six examples are run, so a
longer list is cut short rather than refused.

**Plugins.** A developer can drop `<name>.mjs` into the `plugins` folder beside your private data.
The file's default export is a `BranchPlugin`: `{ id, name, description, permissions, tools, hooks }`.
A tool is `{ name: "plugin.<id>.<name>", description, permission, input, run(args, context) }`,
where `input` is the same `{ name: { type, required, description } }` shape a recipe uses, and the
permission must be one the plugin declared. A hook is `{ event, run(payload) }`. Plugins may add
tools and react to events; they may not add screens to the app. `GET /api/plugins` lists the files
without loading any of them; `POST /api/plugins/:id/inspect` loads one file to show what it would
add (which runs the code at the top of that file); `POST /api/plugins/:id/enable` and
`POST /api/plugins/:id/disable` switch it on and off, and the choice is remembered. On the command
line: `branch plugin list | enable <id> | disable <id>`. **Be plain about the limits:** a plugin is
not sandboxed. It runs inside Branch with the same reach over this computer that Branch has. The
only thing holding it in bounds is the permission check every tool goes through, and the fact that
nothing is loaded until you switch it on. Only use plugin files you trust.

**Suggestions without a marketplace.** `GET /api/skills/suggest` reads the wording of your tasks
from the last fourteen days and names skills you already have but have switched off, or skills
advertised by a registry you have browsed, whose words appear in that work. It is a plain word
match on this computer: no model is asked, nothing is sent anywhere, and a suggestion never
installs or switches anything on. The Skills screen shows all of the above, and the interface file
`/skills-extra.js` is served from the same local allowlist as the rest of the interface.

## Using this computer's screen and keyboard

Branch can look at what is on this computer's screen and work the windows on it. It is switched
off, and while it is off every one of these tools answers with one plain sentence instead of
trying. Turn it on in **Settings → Using your screen and keyboard**, which writes the setting
`desktop-control` for your owner record.

Routes: `GET /api/desktop/settings` returns `{ enabled, maxActionsPerRun }`; `POST` to the same
address changes either field. `enabled` is `false` and `maxActionsPerRun` is `40` until you say
otherwise. The setting is read again before every single action, so switching it off stops work
that is already under way rather than waiting for the task to finish.

The tools are `desktop.screenshot` (a picture of one window by part of its name, or of a whole
screen), `desktop.windows` (list the open windows, or bring one to the front, minimise it or close
it), `desktop.read` (everything in a window listed by name and kind, so the assistant works from
words rather than from pixels), `desktop.click`, `desktop.type`, `desktop.key`, `desktop.open`
(start a program, or open one of your workspace files with whatever usually opens it) and
`desktop.clipboard`. They sit behind three permissions — `desktop.view`, `desktop.control` and
`desktop.clipboard` — and none of the three counts as merely looking, so under **Ask before
changes** every single one stops and asks you first. Photographing your screen is treated as a
change on purpose.

How it works underneath: one Windows PowerShell script, written once into a private temporary
folder and called with `-File` so nothing is ever pasted into a command line, driving Windows' own
accessibility layer (UI Automation) and `user32`. Clicking and typing go through the accessibility
layer first — a button is pressed by its name, text is placed into a box directly — and fall back
to a real mouse click or key press only when the program offers nothing better. The script runs
through the same bounded runner the host-command tool uses, so it is stopped by time, by output
size, or the moment the task is cancelled. No new dependency; nothing is installed.

While any of this is happening a small notice sits on top of everything with a **Stop** button on
it. Pressing Stop ends that notice's own process, which Branch takes as "let go of the screen now":
the action in flight is cut off and every later one in the same task is refused. `POST
/api/runs/:id/cancel` does the same thing. Every action is written into Activity as
`desktop.action` with the name of the window it touched, alongside the ordinary signed receipt.

Windows that are never photographed and never typed into: anything whose title or program looks
like a password manager (Bitwarden, 1Password, KeePass, LastPass, Dashlane, NordPass, Proton Pass,
Roboform, Enpass, Keeper), the Windows sign-in and permission prompts (`LogonUI`, `consent`,
`CredentialUIBroker`, `LockApp`), and anything whose title mentions a password, a passkey, signing
in, unlocking or Windows Security. The check is made against the title Windows itself reports for
the window it found, never against what was asked for, so a wildcard cannot creep past it. A
picture of a whole screen is refused outright while such a window is showing, because a photograph
of the whole screen cannot hide part of itself. `desktop.type` also refuses text that still has a
`{{placeholder}}` in it or that points at an environment variable, and the screen tools are never
given the secrets locker at all, so there is no path by which a saved password could be typed.

### What this cannot do

- **There is no global Esc.** Stopping means the button on the notice, `POST /api/runs/:id/cancel`,
  or closing Branch. Branch does not listen to your keyboard while you are using it yourself, and
  building that would mean watching every key you press, which is a worse trade than it sounds.
- **A whole-screen picture cannot be censored.** Branch can refuse to take one, and does when a
  password window is showing, but it cannot black out part of a picture it has taken. Prefer asking
  for one window.
- **Programs that draw themselves cannot be read.** Games, drawing programs, many Electron apps and
  anything that paints into a canvas tell Windows' accessibility layer nothing useful.
  `desktop.read` will come back nearly empty and clicking will fall back to guessing at a point.
- **Windows running as an administrator are invisible.** Branch runs as you, so a program started
  with elevated rights cannot be read, clicked or photographed, and Windows gives no error worth
  repeating when that happens.
- **Only whole screens, and only one at a time.** `display` picks one of the screens Windows
  reports; there is no way to ask for a region, and no way to ask for all of them at once.
- **Windows moves under it.** A program can rebuild its own window between Branch finding it and
  Branch using it; Branch looks it up once more and tries again, and gives up plainly after that.
- **Nothing is recorded.** There is no screen recording, no replay of what was done, and no way to
  watch the screen continuously — only the one picture or reading you asked for.
- **The refusal list is deliberately clumsy.** Titles are matched loosely, so an ordinary window
  that merely mentions a password, a passkey or signing in — a web page about password managers, a
  document called "sign in flow" — is refused as well. That is the error worth making, but it does
  mean Branch will sometimes refuse a window that was perfectly harmless.
- **Opening a file cannot be confirmed.** `desktop.open` with a program name reports the program it
  started. Opening a *file* hands it to Windows, which picks the program and says nothing about
  what happened, so the answer says so and asks the assistant to look at the open windows instead.
- **Windows only.** All of it rests on Windows PowerShell 5.1, UI Automation and `user32`.
