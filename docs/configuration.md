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

### Talking to it, and where the sound goes (wave 7)

**Talk** next to the message box is hold-to-talk: hold it, speak, let go. What you said is written out, put in the message box so you can see it, sent as an ordinary message, and the answer is read back to you. Press Talk again while it is talking and it stops. The four states it moves through (waiting, listening, working, reading aloud) live in `src/voice-talk.ts` and are tested on their own.

Three services can write out what you say, and Branch picks whichever one your settings point at: an OpenAI-shaped `/audio/transcriptions` (the Whisper shape, which most providers speak), Gemini's own route (the sound goes inline with the request), or **a speech program already installed on this computer** — whisper.cpp or faster-whisper. Branch never downloads a speech model for you: you point it at the program and its model file, and it checks the program is there before it tries. The transcript is read from what the program prints, using the flags whisper.cpp's and faster-whisper's own command lines document; this has not been run against a real installation, so a build that names its flags differently will refuse in plain words rather than silently return nothing. Three can read text aloud: the OpenAI-shaped `/audio/speech`, Gemini's speech route, and **the voices that come with Windows**, which need no key, no account and no internet. The Windows voice is driven by a short PowerShell script written to a temporary file and run with `-File` and no console window; the words are put in as a quoted string, so nothing in a reply can be run as a command.

- **Keep audio on this computer**: nothing containing sound may leave. Both cloud routes then refuse in plain words instead of sending anyway, and the refusal lives in the service itself, so the `voice.say` tool cannot go around it. The two sound tools in the media toolbox (`media.transcribe` and `media.speak`) read the same setting straight from your settings and refuse the same way, so a workspace sound file is not a way round it either. It also wins over "answer a voice note with a voice note": a spoken reply would be uploaded to the chat app, so with this on the words are sent instead.
- **Who writes out what you say** / **Who reads replies aloud**: pick a service, or leave it on "whatever suits".
- **Language**: a code such as `en` forces one; empty lets the service work it out.
- **Answer a voice note on a chat app with a voice note back**: off until you turn it on. Telegram is the one channel that can send sound back today, and the only one whose voice-note handling is covered by a test; the Discord and WhatsApp download paths are plumbing built to their documented shapes but not exercised here.

A voice note that arrives on **Telegram, Discord or WhatsApp** is written out and handled exactly like a typed message, and the reply quotes the transcript back ("You said (from your voice note): …") so you can see what was heard. The bytes are only fetched once the message has earned an answer, so a stranger cannot make Branch download anything, and a note over 20 MB is refused.

Costs are estimated the same honest way as everything else: published per-minute prices for writing out speech and per-thousand-character prices for reading aloud, with the date they were read, and **no figure at all** when there is no price on file or the length is unknown. A voice on this computer genuinely costs nothing, and reports zero. Where a task exists to record it against, the figure is written into that task's own record as a `voice.spoken` or `voice.transcribed` event; the message-box microphone and a voice note arriving on a chat app happen before any task starts, so their cost is reported in the answer and shown on screen rather than filed.

Routes: `GET /api/voice/plan` (which service would do the work, where the sound goes, and the prices), `GET|POST /api/voice/settings`, `GET /api/voice/voices` (the voices installed on this computer), `POST /api/voice/transcribe?seconds=<length>`, `POST /api/voice/speak`.

**Not built: live two-way voice calls** (the OpenAI Realtime WebSocket, audit A1212 and A2293). Branch checks every outbound address against its network policy before each request, and that policy has no hook for a WebSocket; a realtime session would either skip the check or need a new dependency, and this build refuses both. Hold-to-talk does the same job over the ordinary routes. There is no wake word and nothing listens unless you are holding the button.

### Which model does what (wave 7)

Type `/model` in the message box to see your connections, and `/model <name>` to change the one answering **this conversation only** — no restart, nothing else affected, and the next reply is charged at the new model's prices. `/model default` puts it back. The assistant can do the same for itself with the `models.switch` tool. The rail above the message box always names the model that will answer next.

**Settings → Which model does what** holds *routing profiles*. A profile is just data — a name and an order of connections — saved in `settings/model-profiles`, so you can read it, change it and hand it to someone else. Branch fills in four from the connections you actually have: **Cheap and fast** (whatever runs on this computer first, then the least expensive with a published price), **Best quality** (most expensive first, which is the only ranking that can be justified from published prices), **Private** (only connections on this computer; honestly empty until you set one up) and **Long context** (your own order — Branch cannot read how much a cloud model holds, so it does not pretend to). None is switched on until you pick one. When a profile does pick, the run records a `model.routed` event whose reason says which rule fired, for example *The "Cheap and fast" profile asked for alpha first, but it was not available, so beta took it* — that is the "why this model" line in the run inspector.

**Settings → Check your connections** asks each connection what it can do right now: whether its key still works, how many models it lists, and whether it offers speech, pictures and comparing passages. `branch doctor --probe` prints the same thing under `connections`. It costs nothing beyond one list-of-models request per connection.

**Signing in with Google for Gemini** (`src/gemini-signin.ts`) is built as far as it can honestly go: the standard code flow with PKCE through the existing sign-in machinery, and the resulting token sent to Gemini in the ordinary `Authorization: Bearer` header — never in the address. **But**: Google's Generative Language API accepts a signed-in person's token only for a Google Cloud project that has the API switched on, and it bills that project. Branch cannot check that from here without sending a real request, so the API key remains the ordinary way and nothing has been changed about it. To be plain about what exists today: the sign-in is written down in code and nothing else — there is no button for it on any screen and no route that turns it on, so a Gemini connection is still made with a key. Nothing else in Branch uses Google sign-in. One thing did change for everybody: a Gemini API key now travels in the `x-goog-api-key` header instead of a `?key=` query parameter on the chat and audio routes, so it cannot end up in a log there. The picture route still passes it as a query parameter; that belongs to another part of the app and was not touched here.

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

## Command line and terminal

`branch <command>` (or `node dist/cli.js <command>`) is the whole command line; `branch help` lists it. Nothing here needs the web app to be running.

**Talking in the terminal.** `branch chat` opens the full terminal view: a status line that stays put above what you type (which model is answering, how many tokens and how much money this conversation has used, and which approval preset is in force), answers wrapped to the window as they stream, and one short row for each step — `· Writing notes.txt` while it happens, `ok Writing notes.txt` when it is done. Press **Ctrl+E** to show or hide what is behind those rows. **Enter** sends, **Alt+Enter** adds another line to the same message, the **up arrow** brings back a message you already sent, **Ctrl+C** stops the task in hand without closing the terminal, and **Ctrl+D** leaves. It is drawn with Node's own readline and escape sequences; there is no extra package involved.

The commands inside it are `/help`, `/model [id]`, `/think <low|medium|high|default>`, `/preset [name]`, `/memory [words]`, `/skills`, `/plan`, `/verify`, `/dry-run`, `/attach <file>`, `/history`, `/export [file]`, `/new` and `/exit`. `/plan`, `/verify` and `/dry-run` switch on and off and apply to every message after that. `/attach` takes a picture (PNG, JPEG, WebP or GIF) as a picture and any other text file as words added to your next message. `/export` writes the conversation to a Markdown file in your workspace.

**When it stops to ask.** If your approval preset makes a task pause, the terminal shows the question with the tool and the exact file or command, and takes **y** (yes, remembered as the rule suggests), **n** (no), **a** (yes, always — written into your approval settings as a rule) or **s** (yes, for this conversation), then Enter. The answer goes through the same route as the app's **Settings → When to check with me** screen, and the task carries straight on.

**When the terminal cannot take it.** `branch chat` falls back to the plain streaming view when stdout is not a terminal, when you pass `--plain`, or when you set `NO_COLOR`. `FORCE_TTY=1` asks for the full view anyway (this is what the tests use), and `FORCE_TTY=0` asks for the plain one. With `NO_COLOR` set, or `TERM=dumb`, nothing writes a single escape sequence: no colour, no cursor movement, no window title and no progress indicator. `COLUMNS` and `LINES` override the window size. On a terminal that takes them, the window title follows the task in hand and Windows Terminal's taskbar progress indicator (OSC 9;4) turns on while a task is working; `BRANCH_TUI_DECORATIONS=0` turns just those two off.

**For scripts.** `branch run "..."` takes `--json` (every event as one JSON object per line on stdout, human wording on stderr), `--attach <file>` (repeatable), `--plan`, `--verify`, `--dry-run`, `--preset <off|ask-before-changes|workspace|read-only>`, `--save-preset <same names>`, `--budget <tokens>` and `--timeout <milliseconds>`. `--preset` uses that approval setting **for this one task** and puts your saved setting back afterwards, so a script cannot quietly change what you chose; `--save-preset` changes the saved setting and stays changed, and says so on stderr. The exit code is the contract:

| Code | Meaning |
| --- | --- |
| 0 | The task finished. |
| 2 | The task stopped to ask you something; `branch approve` answers it. |
| 3 | The task failed, was cancelled, or ran past `--timeout`. |
| 4 | The task ran out of the budget you gave it. |

`branch status` lists the tasks working now, the ones waiting for an answer, and the health summary (`--json` for the same thing as JSON). `branch logs <task id>` prints that task's timeline one line per step (`--json` for the stored events). `branch approve <task id> yes|no` answers a task that stopped to ask. It cannot answer just this once: the program run that stopped has already ended, so the answer is **saved as a standing rule** for that tool and that exact target and applies to every future task, not only this one. The command says so when it runs, and the rule can be changed under **Settings → When to check with me**. For a one-time yes, use the terminal view (`branch chat`) or the settings screen instead.

**Completion.** `branch completion bash` and `branch completion powershell` print a completion script. Write it to a file and load it from your shell profile (`source branch-completion.bash`, or `. .\branch-completion.ps1`). Nothing is installed for you and the script never runs a Branch command to work out its suggestions.

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

## Tables of figures

`data.load` opens a table for the length of one task: give it a workspace file (`.csv`, `.tsv`, `.json`, `.xlsx`), a public address, or pasted text. Up to 5000 rows, 64 columns and 500 characters a cell are kept; anything longer is cut and the answer says so. What comes back is the column names, what kind each column holds, the row count and a five-row preview as a Markdown table — never the whole file, so a big spreadsheet cannot fill the conversation. Up to eight tables can be open at once, and everything is dropped when the task finishes.

`data.describe` gives plain numbers for each column: how many rows are filled, how many are empty, how many different values, and for columns of numbers the smallest, largest, average and middle value. `data.query` answers a question with read-only SQL — one statement, starting with `SELECT` or `WITH`, run against a private in-memory copy of the open tables; anything else is refused. Yes/no columns are held as 1 and 0 there, so compare them as numbers. Both return a `markdown` field that the message column shows as a table.

`data.chart` draws a table as bars, a line or a pie and keeps it beside the task as an SVG file (`{ spec: { type, label, value, title, limit } }`). `data.export` saves a table into your workspace as `.csv` or `.xlsx`; the spreadsheet it writes is the same shape the documents library reads, so an exported file can be added straight back. Exports and research reports go through the same before-and-after as every other file the assistant writes, so each one keeps its previous bytes and has an Undo. The spreadsheet writer has been checked against this app's own reader; opening one in Excel has not been tested. The tools are `data.load`, `data.describe`, `data.query` and `data.chart` under `data.read`, and `data.export` under `data.write`.

## Looking a question up properly

`research.run` takes a question, a depth (`quick`, `standard` or `deep`) and optionally the addresses to read. Quick runs one search and reads up to two pages; standard three searches and six pages; deep six and twelve. Each page is fetched under the same network policy as the rest of web reading, and page text is treated as information, never instructions. The sentences that speak to the question are kept with the address and title they came from.

From `standard` upwards, sentences from different pages that are about the same thing are compared: a claim two or more sources state with the same figures is listed under **What the sources agree on**, and one where their figures differ is listed under **Where the sources disagree**, with each side quoted and numbered. If your document library has something about the question it is read too and cited as one of your own documents.

The report is written to `research/<question>.md` in your workspace with a numbered **Sources** list. Progress is recorded as it goes (`research.progress`, `research.skipped`, `research.flagged` for a page whose lines read like orders to the assistant, `research.finished`) so the pane on the right can show what it is reading. Everything read is saved after each page, so a run that stops on its budget can be carried on: ask the same question again and it picks up where it left off, and the report it writes says it was cut short. `research.list` lists what has been written. The tools are `research.run` under `research.run` and `research.list` under `research.read`; `GET /api/research` returns the same list for the reports panel.

## Watching a page or a search

`monitor.create` starts a watch: `{ url }` or `{ query }`, `every` (minutes, or `"30m"`, `"6h"`, `"1d"`; at least five minutes), an optional `label`, and `notifyVia` — either `"activity"`, which puts the news in your conversation list, or `{ channel, chatId }` to send it to a chat. The first look is taken straight away so the next change is a real change. Each check compares the words against what was seen last time and describes the difference in plain language: how many lines are new, how many are gone, and a few of each. Watches run on the same beat as schedules; one that cannot be read is tried again in an hour and never stops the others.

`monitor.list`, `monitor.check` (look now) and `monitor.remove` complete the set. Routes: `GET|POST /api/monitors`, `POST /api/monitors/{id}/check`, `DELETE /api/monitors/{id}`. `monitor.list` needs `monitors.read`; the rest need `monitors.manage`.

## The morning brief

One message first thing, assembled from what the app already holds: what is planned today, tasks left unfinished, documents added in the last day, watches that changed, and anything you asked to be reminded of. There is no calendar account and nothing is read aloud. Turn it on with `brief.configure` — `enabled`, `dailyAt` (24-hour local time), `timezone`, `deliverTo` (a channel chat, or nothing to leave it in the conversation list), `sections` (any of `schedules`, `tasks`, `documents`, `watches`, `reminders`) and `template`.

The template is ordinary text with `{{date}}`, `{{schedules}}`, `{{tasks}}`, `{{documents}}`, `{{watches}}` and `{{reminders}}` in it; a section you switch off leaves the message entirely, heading and all. `brief.preview` shows what would be sent without sending it, and `brief.send` sends it now. Routes: `GET /api/brief` (preview), `POST /api/brief` (settings), `POST /api/brief/send`. `brief.preview` needs `brief.read`; the other two need `brief.manage`.

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

## Why the assistant sometimes says it is opening a toolbox

The assistant has a lot of tools now, and the full list of them is sent to the model **every single
round** — not once per conversation. Left alone that list grows with every new feature and crowds
out the conversation itself.

So the tools are kept in labelled toolboxes: files, git, web, memory, documents, schedules, media,
messages, specialists, skills and a few more. At the start of a task the assistant opens the ones
the request obviously needs — "commit my changes and push" opens the git box — and leaves the rest
closed. A closed box costs one line, "git: 6 tools", instead of its full contents. If the assistant
finds it needs something from a closed box, it opens it, which is what it means when it says it is
opening a toolbox; that box then stays open for the rest of the conversation, and anything it has
just used stays in view for the next few rounds. Nothing is hidden from you and nothing new is
allowed: a box can only ever contain tools this task was already permitted to use.

You do not configure any of this. It shows up in the task's timeline as **catalog.preselected**
(which boxes were opened at the start), **catalog.expanded** (one opened mid-task) and
**catalog.size** (how many tools were described this round and what they weighed).

## How the assistant finds its tools

Toolboxes were the first answer to a growing tool list. They are still there, but the assistant no
longer relies on them, because a computer with a few connected servers on it can easily have a
thousand tools and no toolbox is small enough to carry that.

Each time the assistant works, every tool it is allowed to use is put in one of three places:

* **Carried** — about a dozen tools, with their full instructions, ready to use straight away.
* **Named** — a short list, one line each: the tool's name and eight words saying what it does.
* **Looked up** — everything else. Not in the message at all, and found by searching for it.

When the assistant needs something it is not carrying, it searches for it in its own words — "send
a message on Discord", "make a picture" — and what it finds becomes available for the rest of that
conversation. That is what it means when it says it is looking for a tool. It can only ever find
tools this task was already allowed to use: a tool your settings put out of reach is not in the
list at all, and reads exactly like a name that does not exist, so nothing is revealed by asking.

**It remembers what worked.** When a task finishes, the computer keeps one line about it: the shape
of what you asked (as scrambled word pairs, never the words themselves), which tools were looked
for, which were used, and whether it went well. From that it learns three habits — it carries the
tools that requests like yours have needed before, it carries tools that are nearly always used
together, and it stops naming tools nobody has touched for a month (those are still findable by
searching). It also keeps short notes: if a call fails because something was missing and the next
one works, or if the assistant is told outright that a tool needs the full path, that line is kept
and shown with the tool from then on. A note travels with its tool in every later message, so one
that reads like instructions to the assistant is refused rather than kept.

None of this leaves the computer. It is in the same private database as everything else and travels
with your backup. **Settings → Developer → How the assistant finds its tools** shows what was
carried, named and looked up last time, what that weighed, what was made ready before you asked and
why, and every note — with one button that forgets all of it. Your tools are untouched by that; only
what was learned about them is deleted.

Once a night the assistant works out a short line about how this is going — how many different
tools you use, what the tool list weighs in each message, and how often a search found something
worth using. That line is in the Developer card and in the diagnostics folder (`tools.json`).

Settings and routes:

* `toolBudgetTokens` (reliability settings, default 2,500) — the most the whole tool list may weigh
  in one message. Tools over the ceiling become a line in the list, then a search away.
* `GET /api/tools/catalog` — what the card shows. Read-only.
* `POST /api/tools/forget` `{"what":"history"|"notes"|"all"}` — deletes what was learned.
* `DELETE /api/tools/notes/<id>` — deletes one note.

The timeline adds **tools.searched** (what was looked for and what came back), **tools.described**
(tools loaded by exact name), **tools.noted** (a note kept) and **catalog.reindexed** (a server
connected while the task was working, and its tools went into the index). **catalog.size** now also
says how many tools were carried, named and looked up, and **catalog.preselected** lists anything
made ready from past tasks under `preloadedFromHistory`.

Alongside it, each round records a **context.budget** line: the size limit, what the instructions
cost, what the tool list cost, what the conversation costs, and the room held back for the answer.
Folding older turns into a summary is now decided on the conversation alone, so adding tools to the
product can never, by itself, cause a conversation to be folded away early. The point at which that
happens is worked out each round from what the tool list and the answer leave over, and it never
drops below the old fixed figure of 11,000.

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

## How Branch runs on this computer: installing, starting and reaching it from a phone

**Installing.** The release carries two files: `Branch-Agent-windows-x64.zip` and `Install Branch
Agent.cmd`. The script unpacks the zip with the `tar.exe` that ships with Windows (PowerShell's
`Expand-Archive` is the fallback) and then runs `dist/install/install-cli.js` *from inside the
unpacked app*, using the runtime the download already carries. Nothing has to be installed first and
nothing is downloaded by the installer itself. It copies the app to
`%LOCALAPPDATA%\Programs\Branch Agent`, keeps whatever was there in `…\Branch Agent.previous`,
writes a Start menu shortcut and (unless `--no-desktop-shortcut`) a desktop one through
`WScript.Shell`, writes `Uninstall Branch Agent.cmd` next to the app, and registers it under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BranchAgent` with a
`QuietUninstallString`. Only this person's own settings are touched, so no administrator prompt
appears and nothing has to be signed. Saved work from an older folder layout (`%LOCALAPPDATA%` or
`%APPDATA%` under `Branch Agent` or `branch-agent`) is copied across once, and never over a folder
that already holds a database. Uninstalling removes the program, the shortcuts, the sign-in entry
and the background task; conversations and files are left alone.

**Portable copies.** Put an empty `portable.txt` beside `Branch Agent.exe` and the app keeps its
state in `Branch Data\state` and its workspace in `Branch Data\workspace`, both next to the
program. Without the marker it uses the per-person application-data folder as before.
`BRANCH_DATA_DIR` and `BRANCH_WORKSPACE` still win over both.

**Starting with Windows.** *Settings → How Branch runs on this computer → Start Branch when I sign
in to Windows* writes one value, `Branch Agent`, into
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. With *Start quietly in the corner of the
taskbar* on, the command carries `--start-minimized` and the window stays hidden until the tray icon
is used. Switching it off deletes the value.

**Keeping Branch working with the window closed.** `branch daemon install | uninstall | status`, or
the switch in the same settings card, registers a Task Scheduler task called `Branch Agent daemon`
with `/SC ONLOGON /RL LIMITED`. The task runs `wscript.exe //B //Nologo` against a one-line launcher
that starts the engine with window style 0, so no console flashes up; the engine itself is
`dist/cli.js start` run through the app's own executable with `ELECTRON_RUN_AS_NODE=1`. While an
engine is running it leaves `running.json` in the data folder (port, process id, address). A later
launch of the window reads that note, checks the process still exists and that the port answers
`GET /api/state` with the session token from disk, and joins it instead of starting a second engine;
a note left behind by a crash is removed rather than trusted.

**Reaching Branch from a phone.** Off by default. `POST /api/deployment/remote` with
`{ "enabled": true }` asks `tailscale status --json` where this computer sits on its private network
and opens a *second* listener bound to that address alone. The address must be inside
`100.64.0.0/10`, which is the range Tailscale hands out; anything else, including `0.0.0.0`, is
refused. The loopback listener is untouched. While remote access is on, the Host and Origin checks
(one shared `hostAllowed` used by the request handler, the API authorisation and the WebSocket
upgrade) also accept the Tailscale address and name; nothing else is ever added.
`POST /api/deployment/remote/invite` makes one invitation: a link carrying only an identifier,
returned as a QR matrix drawn by `src/remote/qr.ts` (no dependency), plus a six-digit number that is
**not** in the link. The phone opens `/pair?id=…`, types the number, and `POST /api/pair` — the only
route exempt from the session token, and only on the remote listener — hands back the key. An
invitation lasts five minutes, works once, and dies after five wrong numbers.

**Safety copies and going back.** Before an update swaps any files, the updater calls its `backup`
hook, which writes the whole of the person's saved work to `update-backups/before-<time>-v<version>.json`
in the data folder and keeps the newest three. Both launches do this: a window running its own
engine writes the copy itself, and a window that joined a background engine asks that engine for it
with `POST /api/deployment/backup` and the session token, because the engine is the one that owns
the saved work. A failure there stops the update either way, and the engine's own sentence is what
the owner reads, followed by what to do about it — free some space on the drive, or move the data
folder somewhere Branch can write, then try again. When the reason is size, the sentence says the
limit (64 MiB). There is no way to skip the copy: an update with nothing to go back to is refused.
When a version starts for the first time its health report is recorded in `first-start.json`; if it
did not come up cleanly, the settings card offers *Put back the previous version's saved work*,
which reads the newest safety copy and restores it with `replaceExisting`. `POST /api/restore` is
unchanged and still refuses to write over a copy that already holds conversations.

**Updating while an engine works in the background.** The background engine holds the same program
files open as the window, so a hand-over would hit a locked file. Before the hand-over script is
written, the window reads `running.json`, asks that process to close (`taskkill /PID <pid> /T`, then
`/T /F` if it will not), waits a bounded time for it to go and removes the note. An engine that
still refuses is not treated as a failure: the hand-over script waits for the engine's process id
as well as the window's, and ends it itself before mirroring anything. Nothing new is started: the
hand-over still runs through the same hidden Windows Script Host launcher, and every tool is run
with no window.

**Checking a computer is ready.** `branch doctor --fix`, and the *Check and repair what I can*
button, look for Git, the private browser Branch uses to read pages, a free address on this
computer, and a writable files folder. With `--fix` it installs the browser
(`npx playwright install chromium --only-shell`); the rest come with a plain-language step, because
installing Git asks questions a script should not answer for someone.

Routes: `GET /api/deployment`, `POST /api/deployment/autostart`, `POST /api/deployment/daemon`,
`POST /api/deployment/remote`, `POST /api/deployment/remote/invite`, `GET /api/deployment/doctor`,
`POST /api/deployment/backup`, `GET /api/deployment/restore-points`,
`POST /api/deployment/restore-point`, and `POST /api/pair`. Interface files: `/deployment.js`,
`/pair` and `/pair.js`.
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
- **It will not run a program out of your workspace.** `desktop.open` opens documents. A workspace
  file that is itself a program — `.exe`, `.bat`, `.cmd`, `.ps1`, `.msi` and the like — is turned
  down, because ticking "use my screen and keyboard" is not the same as saying "run programs from
  my workspace". Running something has its own switch: the host-command tool.
- **Windows only.** All of it rests on Windows PowerShell 5.1, UI Automation and `user32`.
## The client library, issue context, and what the assistant was allowed to do (batch 19, wave 6)
### A client for scripts on this computer
`packages/sdk/` is a single file of plain JavaScript that talks to the Branch Agent already running
here. It installs nothing and is not published anywhere: point an `import` at
`packages/sdk/client.mjs`. TypeScript users get `packages/sdk/types.d.ts`, which is **generated**
from the app's own zod schemas by `node scripts/generate-sdk-types.mjs` (run it after
`npm run build`), so the types cannot promise something the app would refuse. The client covers
runs (start, `stream` over Server-Sent Events, `watch` over the run socket, steer, cancel, resume,
approve, receipts, activity), sessions, memory, documents, schedules, policy, the record below,
"ask me questions first", combined search and issue context; anything else goes through
`branch.get` / `branch.post`. It needs the local session key, which is the whole of the app's
security — see `packages/sdk/README.md` for three worked examples.
### Issues as context
`{"issues": {"github": true, "linear": {"tokenSecret": "LINEAR_API_KEY"}}}` in the integration
settings file switches on `issues.search`, `issues.get` (both behind `issues.read`) and
`issues.comment` (behind `issues.write`). GitHub reuses the token named in `git.github`; Linear
needs its own key saved in the active project's secrets. Neither key ever goes into a web address,
and both are scrubbed out of anything reported back.
`POST /api/issues/context {"url": "..."}` turns an issue address — a GitHub issue or pull-request
link, `owner/name#12`, or a Linear link or reference such as `ENG-214` — into a passage carrying
the title, description and up to ten comments, with the address as its citation and a line saying
the text was written by other people and is to be quoted, not obeyed. Pasting such an address into
the box you type in pulls that passage into the task. An issue is treated exactly like a web page:
before the assistant sees it, lines that read like orders aimed at it are flagged, taken out, or
the whole issue refused, according to the same `web.injection` setting (`warn`, `redact`, `block`)
that `web.fetch` obeys.
`github.open_pull_request` takes two more optional fields: `issue` (the issue it settles) and
`changes` (one line each). Given an issue it reads it first, then writes the description from a
shared template ending in `Closes owner/name#12`, so merging the pull request closes the issue.
### What the assistant was allowed to do
Every moment that widens or narrows what Branch Agent can reach is written into a dedicated
`audit` table: a question you answered, a saved password handed to a command (**by name only — the
value never reaches the record**), a change to the approval settings, a messaging account
connected or disconnected, something exported, and a switch to another project or into the
practice workspace. The table is append-only, enforced by the database itself: two SQLite triggers
refuse any attempt to change or remove a row, so nothing — not even Branch — can quietly rewrite
what happened.
`GET /api/audit` lists it newest first and accepts `action`, `source`, `from`, `to` and `limit`.
`GET /api/audit/export.csv` saves the same, with the same filters, as a spreadsheet file. The
diagnostics folder carries it as `allowed.json`, scrubbed the same way everything else there is.
The foot of the Usage screen shows it in plain language, with a count of each kind.
### Deciding approvals a kind of thing at a time
Tools are sorted into seven kinds — looking things up, changing files, running commands, using a
web page, messaging people, spending money and changing settings — from the permission each one
needs, with a small override list for the handful whose permission does not say enough. A tool
nobody anticipated counts as changing settings rather than as reading.
`GET /api/approvals/categories` lists the kinds with the tools in each and what that kind is
currently set to (null when the tools inside it disagree). `POST /api/approvals/categories`
`{"commands": "deny"}` saves it, expanding to one rule per tool — never a wildcard — through the
same `savePolicy` the hand-edited rule list uses. **Only the kinds named in the request change**:
a kind decided earlier stays decided, and every rule you wrote by hand and every standing yes
remembered from a question you answered is kept, ahead of the new rules, so a narrower rule you set
deliberately still wins. Because one kind can be dozens of tools, a policy may now hold up to 300
rules rather than 100 (`maximumPolicyRules` in `src/policy.ts`). Settings → When to check with me
shows it under the preset.
### Ask me questions first
With the toggle beside the box you type in switched on, Branch Agent comes back with up to five
short questions, each with what it would assume if you say nothing, before it starts. A short,
plain request skips this on its own, judged by the same rule that decides whether a task is worth
planning first, so "what is in this folder" never turns into a form.
`GET`/`POST /api/ask-first/settings` holds `askFirst` and `maxQuestions`.
`POST /api/ask-first {"prompt": "..."}` returns `{skipped, reason, questions}` — one model request,
or none at all when it is skipped. `POST /api/ask-first/answers` returns the request with the
answers written underneath it, which is what the task then gets.
### The practice workspace
`POST /api/practice {"practice": true}` makes a project called "Practice workspace" whose folder is
`practice-workspace` inside your workspace, writes four made-up files into it (a read-me, meeting
notes, a shopping list and an invoice spreadsheet) and a short demo conversation into your history,
then switches to it. `{"practice": false}` goes back to whatever project you were using before.
`GET /api/practice` says which you are in. The files are left behind either way, and a file you
changed is never overwritten by switching in again.
### One way of finding passages, and putting the best first
Your documents and your saved notes are both asked the same question through one `Retriever`
interface. What they find is merged and then put in order by a second pass. By default that pass
counts how much of your question each passage uses — it costs nothing, happens on this computer,
and gives the same order every time. Set `mode` to `model` and it instead asks the model once to
read the top twenty and pick the best five.
`GET`/`POST /api/retrieval` holds `mode` (`words` or `model`), `candidates` and `keep`.
`POST /api/retrieval/search {"query": "..."}` returns the passages with `reranked` and
`rerankCalls`, which is 0 for the word count and 1 for the model. The same ordering is used for the
passages put in front of an ordinary task.
### Model connections a plugin brings
A plugin may export `providers`, alongside the tools and hooks it already exports. Each is named
`plugin.provider.<id>` and is a factory that, given the address, the key and the model name the
owner chose, returns something that answers like every built-in connection. It is handed both the
network check to call and a fetch that makes that check itself, so an adapter that forgets to ask
is still held to the owner's address rules. (A plugin is still code running as part of the
assistant: only install files you trust.)
`GET /api/providers/plugins` lists the adapters plugins have brought. `POST /api/providers/plugins`
`{"driver": "plugin.provider.echo", "preset": "echo", "name": "Echo", "endpoint": "...", "model": "..."}`
makes a connection from one and puts it in the model list. Switching the plugin off takes both the
adapter and every model preset made from it away again. Nothing is registered until the owner
switches the plugin on, exactly as with a plugin's tools.

## Sharing a conversation, labels, workflows, the waiting line, days off and people here

**Sharing a copy.** `GET /api/sessions/:id/export?format=html` saves one conversation as a single
page. The page carries no scripts and asks for nothing from the internet: its colours are written
into it, so it opens anywhere and can do nothing. Before it is written, anything that looks like a
key, token or password is blanked out; `?contactDetails=1` also blanks out email addresses and
phone-like numbers, and `?toolResults=0` leaves out what the assistant's tools returned. The
response carries an `x-branch-share-receipt` header saying exactly how many messages went out, how
many were held back, and how much was blanked out. `POST /api/sessions/:id/share` makes the same
page into a link this app serves itself at `/share/<id>`: it needs the six-character code shown to
you once, works one time, and stops working at its expiry (`expiresInMinutes`, five minutes to a
week). Five wrong codes close a link for good, so a six-character code cannot be guessed at.
Nothing is published anywhere: the link only works on this computer, because the app listens
on this machine's own address. `GET /api/shares` lists them and
`POST /api/shares/:id/revoke` stops one. Shared copies belong to whoever is using the app: while
somebody else's profile is switched on they can share only their own conversations, never yours.

**Labels and project notes.** `POST /api/labels` sticks a short label on a conversation, a saved
procedure or a document (`{ target, targetId, label }`); `POST /api/labels/remove` takes it off and
`GET /api/labels` lists every label with how many things carry it. Labels are kept and matched in
lower case however they are typed, and there are at most twenty on one thing.
`POST /api/sessions/search` now takes `labels: [...]`, and only conversations carrying **every**
label are returned; an empty list means no filter. `POST /api/projects/notes` writes a note against
a project and `GET /api/projects/notes?project=<id>` reads them newest first. Labels and notes are
saved in the `labels` and `project_notes` tables and travel with the backup.

**Things that run themselves.** A workflow is a saved list of steps: `prompt` (ask the assistant),
`recipe` (replay a verified procedure), `tool` (use one tool), `approval` (stop and wait for you),
`wait` (stop until a time), and `branch` (look at the last answer and skip ahead when it does not
contain given words). Each step may have `retries` (up to five second tries) and a `timeoutMs`.
`POST /api/workflows` saves one, `GET /api/workflows` lists them, and
`POST /api/workflows/:id/run|pause|resume|remove` works it. Where each step got to is written down
in the `workflow_state` table as it happens, so closing the app in the middle loses nothing: a
workflow that was working is marked "stopped when the app closed" and carries on from the same
step. Resuming a workflow that is waiting on an approval is you saying yes, and only from your own
screen: the assistant's `workflows.resume` tool refuses a workflow that is waiting for you, so it
can never say yes on your behalf. The same five things are tools (`workflows.create`, `.list`,
`.run`, `.pause`, `.resume`) under the `workflows.manage` and `workflows.read` permissions. A
`tool` step, and every step inside a `recipe` step, goes through your approval settings exactly as
the assistant does mid-conversation: a step your settings allow simply runs, one they refuse fails
with the same plain refusal, and one they say to ask about stops the workflow where it is and waits
for you — `POST /api/workflows/:id/resume` is you saying yes, and it may carry
`{"remember":"always"}` to keep that yes as a standing rule. A yes that is not standing counts for
that workflow only. A workflow another app or a schedule set going is held to the same limits that
task would have been, so starting one is no way around them. Workflows are the owner's: they are
refused while somebody else's profile is switched on. **Weekly review** ships as an example: collect what finished, write the review, keep
it in memory, and send it on.

**The waiting line.** `POST /api/queue` puts a task in line instead of turning it away when as many
are already working as this computer is set to handle. What you ask for (`source: "owner"`) is
served before anything a schedule, a trigger or another app started. `GET /api/queue` shows what is
waiting with its position, `POST /api/queue/:id/cancel` takes a waiting task out of the line or
stops one that is working, and `POST /api/queue/settings` sets how many run at once (one to eight,
three by default). A conversation only ever has one task working, so its others wait their turn. A
task from the line runs as the owner, so the line is the owner's: it is refused while somebody
else's profile is switched on, and they start tasks the ordinary way instead. The line's "how many
at once" sits under the same ceiling as everything else: the whole app runs at most eight things at
a time, counted once across the line and the requests the app's own screen makes, so the two
together can never go past it.

**Days off and quiet hours.** `GET`/`POST /api/calendar` holds the country whose holidays to use,
your own days off, which weekdays you work, and quiet hours. A schedule created with
`daysOff: "skip"` moves on to its next turn when its moment lands on a holiday, a weekend or a day
you marked off; `daysOff: "shift"` moves it to the next working day instead; `"run"` (the default)
minds none of it. Nothing runs on the day it was held back, and the schedule records why under
`lastDayOff`. When quiet hours are on, messages made during them are held until the hours end
rather than arriving in the night. The holiday list is ordinary data: a few countries ship with the
app in `data/holidays.json`, a copy is put in your data folder on first use, and that copy is the
one that counts, so anything wrong or missing can simply be corrected there. It is plainly
incomplete and is not kept up to date for you.

**People who share this computer.** `POST /api/profiles` gives somebody else a name and a PIN of
four to eight digits (the PIN is stored only as a scrypt hash), `POST /api/profiles/switch` moves
between them and back to the owner (`{ profileId: null }`), and `POST /api/profiles/:id/remove`
removes one. Only the owner may add or remove people. Five wrong PINs in a row stop that profile
accepting any for five minutes. While somebody's profile is switched on, the conversation list,
saved conversations and the Memory view are theirs and not the owner's, a task they start is filed
under their name, and the secrets locker, projects, saved workflows, the waiting line, days off and
the owner's shared copies are all refused in plain words. **Be honest about what this is:** separation on one computer, not separate accounts. There
is no syncing, and the assistant still works as the owner: it uses the owner's models, tools and
settings, it draws on the facts the owner has it remember while answering somebody else, and
anything it decides to remember by itself during their task is filed under the owner, not them.
What a profile changes is which conversations and saved facts the screens show and which of the
owner's areas are refused — not who the assistant is while it works. Anyone who can open the files
on this machine can still read everything. The PIN keeps profiles apart; it does not
lock the data away. Profiles themselves are deliberately left out of the backup, because a PIN
belongs to this computer: restoring a backup elsewhere brings the conversations and facts back but
not the people, so add them again there and the records will be waiting. Continuing an interrupted
task, steering one, queuing a follow-up and pinning a skill to a conversation stay with the owner.

The panel under Schedules covers labels, workflows, the waiting line, days off, shared copies and
the people here. Filtering the rail's conversation list and Ctrl+K by label is left to the interface
work that owns those files.

The interface file `/collab.js` is served from the same local allowlist as the rest of the
interface, and its panel sits under Schedules.

## Rendering, looking inside a task, stepping in, the meter, the playground, the phone and languages

**Markdown and code.** `/markdown.js` builds real elements and never HTML strings, so anything the
model writes is shown, never run: a `<script>` in a reply appears as characters on the page. A
reply gets the whole renderer — headings, lists, tables, quotes, horizontal rules, bold, italic,
inline code, links and fenced code blocks, and a code block shows the language it was written in
and has a Copy button. A saved memory fact and a document search passage are one line each, so they
get `inlineNodes` only: bold, italic, inline code and links, with the search's own highlights left
intact. A link only opens if it is `http`, `https` or `mailto`; inside the desktop app it goes
through that app's own allowlist, elsewhere it opens a new tab.

**Look inside a task.** `GET /api/runs/:id/inspect` answers everything the panel shows in one call:
the task, how long it took, each model round (which model, how long, the size of the prompt, the
tokens in and out), each tool call (what went in, what came back, both clipped, and whether its
proof checked out), the plan it worked through, the reviewer's verdicts, anything you told it
mid-task, the questions it stopped on, the step-by-step timeline, usage and cost. The panel opens
from any run in Activity or from the row in a conversation that says what it worked with, and
**Save this as a file** writes the same answer out as JSON. `GET /api/runs/:id/timeline` and
`GET /api/runs/:id/receipts` still answer on their own.

**Stepping into a task.** While a task is working, a row appears above the message box with the
step it has reached and how long it has been going, fed by the run's WebSocket at
`/api/runs/:id/ws` and checked against `GET /api/activity` every second. **Pause** sends a steering
note telling it to hold; **Tell it something** sends your own note to `POST /api/runs/:id/steer`;
**Stop** calls `POST /api/runs/:id/cancel`. When the approval rules make a task stop and ask, the
question appears in the same place with **Yes, just now**, **Yes, for this conversation**, **Yes,
always** and **No**, each answered through `POST /api/policy/approve`. "Yes, always" is only
offered for a task you started yourself, and writes a rule into your settings.

**The meter.** Under the message box, a quiet bar shows how much of this conversation's room has
been used against the model's context window, and roughly what it has cost so far. Clicking it
opens the numbers: messages, tasks, words in, words out and the cost. A model with no price on
file is said so in words; it is never shown as costing nothing. On a phone the cost moves into the
popover so the bar still fits.

**Try things out.** Settings → Developer → Try things out lists every tool. `GET /api/tools/forms`
returns each tool's description and its JSON schema, and the screen builds the form from that.
**Run it** posts to `POST /api/tools/try`, which checks the same approval rules the assistant works
under: a tool your settings refuse comes back refused, a tool they say to ask about comes back as a
question and only runs after you say yes, and the result is shown exactly as the tool returned it.
Below that, one question can be put to two models using the evaluation route where that is
configured.

**On a phone.** `/manifest.webmanifest` and `/service-worker.js` make the page installable. The
worker keeps the app's own files (stylesheets, scripts, icons, the English words) so it opens
quickly and shows the app rather than a browser error when the connection drops. Nothing under
`/api/`, `/v1/` or `/webhooks/` is ever cached: your assistant is live or it is nothing, and an
unreachable computer puts a plain banner on the screen. The worker is never registered inside the
desktop app or when the page is opened with `?desktop=1`, and the desktop app never offers to
install itself.

**Languages.** Labels go through `t(key)` in `/i18n.js`, reading `/locales/en.json`. The rail, the
sections, the owner menu, the message box and the screens described above are covered; the older
section screens still carry their English copy in the markup and are the next thing to move.
`/locales/fr.json` is a machine draft and says so; a key it does not answer falls back to English
rather than leaving a blank. Markup carries the key in `data-t` (text) or `data-t-label`,
`data-t-placeholder`, `data-t-title` (attributes). The language is chosen in Settings → Appearance
and kept in this browser, not in the workspace. Dates and numbers are written with `Intl` in the
chosen language.

The files `/web-ui.js`, `/web-ui.css`, `/markdown.js`, `/i18n.js`, `/inspector.js`, `/live-run.js`,
`/token-meter.js`, `/playground.js`, `/service-worker.js`, `/manifest.webmanifest`,
`/locales/en.json`, `/locales/fr.json` and the app icons are served from the same local allowlist
as the rest of the interface.

## Knowledge bases (batch 24, wave 7)

A **knowledge base** is a name you give to whole folders or single files of your own work. It sits in
the **Knowledge** card at the bottom of **Documents**. Name one, point it at a folder inside your
workspace, and press **Create**; **Read it again** re-reads it after the files change. Each one shows
how many files and passages it holds, how many are matched by meaning, which model read it and when.

Reading a knowledge base cuts every file into passages. A Markdown file is cut at its headings, so a
passage never straddles two sections and each one carries the headings above it; everything else is
cut into overlapping windows of whole paragraphs (about 1500 characters with 200 of overlap). Word,
spreadsheet, web, table and plain-text files are read with the readers Branch already has — no new
file formats are added here, and a PDF is skipped rather than half-read. Passage names are worked out
from the file and the wording, so the same folder always produces the same passages with the same
names. Up to 20 folders or files per knowledge base, 400 files in total, 5 MB a file.

**What is sent where.** Passages are compared by meaning only if a model you have already connected
can do it. An OpenAI-shaped connection is asked at its `/embeddings` route; a Gemini connection at
`batchEmbedContents`; a model running on this computer through Ollama's own `/api/embeddings`, in
which case **nothing leaves this computer**. LM Studio speaks the OpenAI shape and is reached the same
way, also without leaving the machine. **Your question goes to the same place as your files:** matching
by meaning means the wording of each search — and the first 500 characters of a task when a knowledge
base is ticked **Use this when answering** — is sent to that same connection, unless the model is on
this computer, in which case nothing leaves it. The card says which of those is happening. If none of your
connections can do it, Branch says so in one sentence and the knowledge base still works by its words
alone. Every reading is kept here under a fingerprint of the passage and the model, so reading the
same folder twice costs nothing, and the cost of a first reading is charged to the task that asked for
it, exactly like a model answer. Background reading has no task to charge, so it is recorded as a
`knowledge.index.progress` event instead, and each knowledge base keeps a running total of how much
reading it has been charged for, shown on its card.

**What is never read.** A knowledge base can only point at folders and files inside your workspace,
and the same guard that protects every other file tool applies: anything that looks like a secret —
`.env` and `.env.*`, `.ssh`, `.aws`, anything named `credentials` or `secrets`, `id_rsa`,
`id_ed25519`, and `.pem`, `.key`, `.p12` and `.pfx` files — is refused, as is any path that leaves
the workspace or goes through a symbolic link or junction. Such a file is counted in the knowledge
base's note as one that could not be read, so nothing is dropped in silence, and its words are never
cut into passages or sent anywhere. Anything hidden by `.branchignore` is left out too.

**What a reading may cost.** `POST /api/knowledge/settings` holds two numbers. `maxIndexTokens`
(400,000 by default, which is roughly 1.5 MB of writing) is the most new reading one press of **Read
it again** may do. A larger one is refused in a sentence on the card instead of running up a bill you
did not ask for — or, with a model on this computer, an hour of work you did not ask for — and you
either point the knowledge base at fewer files or raise the number; **0** means no limit. Passages
already read never count towards it, so re-reading a folder nothing changed in is always allowed.
`compareAtMost` (50,000 by default) is the most stored passages one search will compare, so a search
always has a ceiling.

**How a search works.** The passages are narrowed with SQLite's full-text search where this build has
it, then ranked by BM25 worked out in Branch itself — so a rare word counts for far more than a common
one, and the ranking is the same on every build. That order and the order by meaning are combined with
reciprocal rank fusion, and the second pass from the reranking settings puts the best first. Every
result names its file, its heading path and its page where one was known. A knowledge base you tick
**Use this when answering** is put in front of every task with numbered sources, the way your own
documents already can be; an attached knowledge base is offered before the document library, and the
documents fall in behind it when it has nothing to say. Turning **Use my documents when answering**
off at the top of the panel turns knowledge bases off as well, so that one switch always means "put
none of my own writing in front of my tasks". A file that is too large or that no reader could turn
into text is counted in the knowledge base's note rather than passed over in silence.

**Where the vectors live.** In the same database as everything else, in a table called `vectors`, and
the comparison is done in TypeScript. That is comfortable up to roughly **50,000 passages in one
knowledge base**; past that a real vector database would be the right answer. The `VectorBackend`
interface in `src/vector-store.ts` exists for exactly that: an HTTP adapter (Qdrant, Chroma or
similar) would implement `upsert`, `removeDocument`, `removeCollection`, `search`, `count` and
`fingerprints` against the service's own REST API — `search` sending the query vector and the
collection name and returning `{ docId, chunkId, score }` best first, `fingerprints` returning the
chunk-to-fingerprint map that makes re-reading free — going through the existing network policy, and
be handed to `new KnowledgeBases(store, files, models, ledger, backend)`. Only the SQLite backend is
written today.

**In a backup.** The knowledge bases themselves — their names, the folders they point at and whether
each is in use — are in the whole-application backup (`kb_collections`). Their passages (`kb_chunks`,
`kb_search`), their vectors (`vectors`) and the store of readings (`embedding_cache`) are **not**: all
three are worked out again from your own files, so after a restore each knowledge base is there but
empty until you press **Read it again**. Leaving them out keeps a backup small; putting them in would
make it many times larger for something a button rebuilds.

**Saved facts.** Facts are compared by meaning as well as by their words through the same store of
readings, so nothing is ever read twice. A quiet pass runs at most once a day on the scheduler's beat:
it gives newly written facts their comparison by meaning and writes near-duplicates into the review
queue as suggested merges. It never deletes or changes a fact — you accept or ignore each suggestion
in **Memory**, the same as every other tidying suggestion. Settings live under `memory-consolidation`
(`enabled`, `everyHours`, `lastRunAt`).

Routes: `GET /api/knowledge` (the list, which model reads passages, and anything being read right
now), `POST /api/knowledge` with `{ name, sources }`, `POST /api/knowledge/reindex` with
`{ collection }`, `POST /api/knowledge/search` with `{ collection?, query, limit }`,
`POST /api/knowledge/ask` with `{ collection?, question }`, `POST /api/knowledge/attach` with
`{ collection, attached }`, `POST /api/knowledge/settings` with `{ maxIndexTokens?, compareAtMost? }`,
`POST /api/knowledge/source` with `{ collection, source }` or
`{ collection, remove }`, and `DELETE /api/knowledge/{id}`. The tools are `knowledge.collections`,
`knowledge.search` and `knowledge.ask` under `documents.read`, and `knowledge.create`,
`knowledge.add`, `knowledge.remove` and `knowledge.reindex` under `documents.write`. All seven sit in
the **documents** toolbox, not the memory one, because a knowledge base is a set of your own files.
The listing tool
is `knowledge.collections` rather than `knowledge.list`, because `knowledge.list` already means the
stored recipes and specialists.
## Traces, the counters page and the permission rules (batch 19, wave 7)
### There is no telemetry, and there never will be
Branch Agent collects nothing about you and sends nothing to the people who made it. There is no
"help us improve by sharing anonymous statistics" setting to turn off, because nothing is ever
collected in the first place. Everything on this page is about *you* choosing to send *your own*
traces to a tool *you* run. All of it is off until you switch it on, and the address is one you
type yourself. The diagnostics folder (Settings → Health) is written only when you press the
button, it now carries the last 200 steps with their names, timings and outcomes, and every value
in it has been through the same scrub as the rest of the folder.
### Spans: the shape of a task while it runs
Every task gets a trace of its own, and a step — a *span* — for the task itself, each round with
the model, each tool call and each sub-task. Each span points at the one above it, so the trace is
a tree rather than a list. The ids follow the W3C trace context standard, so a viewer you already
have understands them. They are written to a `spans` table beside the events, and every attribute
goes through the same scrubber as everything else, so a saved password or key cannot be in one.
`GET /api/tracing/spans` returns the newest spans; `?run=<id>` returns one task's. The newest
20 000 are kept and older ones are let go once per launch, so the table cannot grow without end.
When Branch hands work to another assistant, or sends a webhook, it puts the standard
`traceparent` header on the call, and when another assistant sends work here with that header the
task joins their trace instead of starting a new one. One piece of work across two assistants is
therefore one trace.
### Sending traces somewhere you run
`GET`/`POST /api/tracing/settings` holds `enabled` (false until you change it), `destination`
(`otlp`, `langfuse` or `langsmith`), `endpoint`, `headers`, `batchSize`, `retries` and
`serviceName`. Once it is on, each task sends its own steps as soon as it finishes, and
`POST /api/tracing/test` sends the last five so you can check the address before relying on it.
Turning sending on without an address is refused rather than half-done.
`includeErrors` adds the crashes Branch recorded — an uncaught failure in the engine, with the
stack scrubbed — to what goes out, which is the whole of "send crash reports to my own endpoint":
they go to *your* address and nowhere else, and there is no third-party crash service involved.
A header value may be `secret://<project>/<NAME>` instead of the key itself. The real value is
looked up from the locker at the moment of the call and is never in the settings, never in a log
and never in an error message. Every send — successful or not — is written into the record of what
the assistant was allowed to do, with the host it went to and how many steps went with it.
All three destinations speak plain JSON over HTTP; no library is installed for any of them. OTLP
posts to `/v1/traces` (and `/v1/metrics` for the counters), Langfuse to `/api/public/ingestion`,
LangSmith to `/runs/batch`, unless the address you typed already has a path of its own. A failed
send is tried again a couple of times with a growing pause, and the address rules are checked
before every single try.
**A collector on this computer needs one extra step.** Branch refuses private and local addresses
by default, so sending to `http://localhost:4318` is blocked until you allow private addresses —
`allowPrivateAddresses` in the `web` section of the integrations file, the same switch Web reading
uses. The refusal says so itself rather than leaving you to guess, and an address that is not
allowed is refused once rather than tried again and again. That default is deliberate: it is the
same rule that stops a web page reaching things on your own network.
These screens are the owner's own. While somebody else's profile is switched on, the steps, the
rules and the sending settings are all refused, exactly like the owner's secrets and saved
workflows.
### The counters page
`GET /api/metrics` answers in the plain text a monitoring tool scrapes, behind the same local key
as everything else: how many tasks there are and what state they are in, tokens in and out, the
estimated cost this month, tool calls and failures, how many conversations have been shortened, how
many steps have been recorded, and a histogram of how long tool calls take. Usage → **Health**
shows the same numbers in plain words. Queue depth is not reported: there is no single queue to
count, so a made-up number is left out rather than invented.
### Permission rules about one particular thing
A rule can now name what it is about as well as which tool it covers: a folder or file (`path`), a
website (`host`), a messaging account (`channel`) or a command (`command`). A rule with one of
these is looked at before the broader rules, so "never write anything under finance" beats "writing
files is fine". A rule without one covers whatever the tool would touch, which is exactly how every
rule written before this behaves — nothing you already had changes.
A folder rule covers everything inside it, so `finance` fits `finance/2026/q1.xlsx`. A website rule
covers the site and anything under it, so `example.com` fits `shop.example.com`. A command rule is
about the program being run, so `rm` fits `rm -rf something`. `*` still stands for any text.
Which kind a call counts as is worked out from what the call says it would touch, not from its
arguments: a bare website name is a website, and anything else is a folder or file. That means a
tool that reports what it touches through its own `target()` — as a tool with no plain `path`
argument is meant to — is covered by a folder rule like any other.
Browser clicking, typing and uploading go through these same rules with the website as the thing
they are about; they do not get a second set of their own.
Settings → When to check with me shows every rule as a sentence — "Ask before writing files under
finance", "Never allow browsing example.com" — with a button to take one away, a short form to add
one, and a **Try a decision out** box that says what would happen and which rule decided, without
saving or running anything.
`GET /api/rules` lists the rules with their sentences. `POST /api/rules/add` takes one rule,
`POST /api/rules/remove {"index": 0}` takes one away, and `POST /api/rules/test {"tool": "...",
"target": "..."}` answers with the decision and the sentence behind it.
### Yes for this conversation, and what it is tied to
"Yes, for this conversation" is a grant with an end: it lasts an hour, ends when the conversation
ends, and ends the moment you lock Branch. `GET /api/rules/allowed?session=<id>` lists what a
conversation is allowed to do right now and when each one runs out.
A yes is tied to the exact request it was given for. The approval card shows those exact words,
with any saved password or key already taken out, and the answer carries a fingerprint of them. If
the assistant changes so much as one character — the same file with different contents counts — the
old yes does not cover it and it has to ask again. `POST /api/policy/approve` accepts an optional
`fingerprint`; an answer whose fingerprint does not match what the task is waiting on is refused
with a plain message.
The same question also travels over the run's socket (`/api/runs/<id>/ws`) as a `policy.ask` event
carrying the question, those exact bytes and the fingerprint, so a phone or a chat channel watching
the socket sees what the app sees and can answer under the same binding.
### Wrong keys are counted
Five wrong local keys from the same place and that place is made to wait five minutes, with a plain
message saying so and a line in the record of what the assistant was allowed to do, filed under
"Somewhere kept getting the key wrong and was made to wait". The right key is checked first and
clears the count at once, so a stale tab in your own browser can never shut you out of your own app.
"The same place" means the address the connection itself came from. A header a caller writes for
itself, such as `x-forwarded-for`, is ignored: Branch has no proxy in front of it, so trusting one
would only let a single guesser pretend to be a thousand different places. On this computer's own
listener that makes every local program one place, which is the honest answer; the phone's listener
sees each device separately. The socket a running task streams over is not counted, so a wrong key
there is refused without being held against anyone.
