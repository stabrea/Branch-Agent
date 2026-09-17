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

`node dist/cli.js login` (or **Settings → ChatGPT account** in the app) starts OpenAI's device-code sign-in: open the shown page, enter the code, and Branch receives tokens that are stored in `chatgpt-auth.json` inside the data directory, protected with the device key in the desktop app. Signing in registers `ChatGPT · GPT-5.6 Sol (light)`, `GPT-5.6 Terra`, `GPT-5.6 Luna` and `GPT-5.5` presets (models `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`; plain `gpt-5.6` and `gpt-5.4` are refused for a ChatGPT account) and makes ChatGPT the default, with Sol first and the others as fallbacks, when the workspace was still on the offline demonstration. Requests carry the `originator: branch-agent` header and a `BranchAgent/<version>` user agent. Access through a ChatGPT plan is provided by OpenAI for its own tools and may change without notice.

### Provider catalog and testing

`GET /api/providers/catalog` returns a list of built-in provider presets: Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Perplexity, xAI, Cerebras, Ollama and LM Studio. Each preset includes the provider's base URL, well-known model identifiers and plain-language help text on where to obtain an API key or how to set up a local service. The desktop and web interface can use this catalog to guide model configuration.

`POST /api/providers/test` validates a provider endpoint and credentials with a tiny request, returning success or a plain-language reason (bad key, model not found, network blocked). Supply either a preset name or a custom endpoint, model and API key.

`GET /api/providers/local` probes for Ollama at `127.0.0.1:11434` and LM Studio at `127.0.0.1:1234`, lists available models for any local runtime that responds, and returns an empty list if neither is running. The probe uses a short timeout and does not go through the network policy (local detection must succeed even when private addresses are otherwise blocked).

### Which model services work (wave 7)

Every model service Branch knows about is written down in `data/providers.json`, not in code. Each
line says which wire shape the service speaks, where it lives, how it wants to be shown a key, what
it can do, and where it publishes its prices. Correct that file and the Settings list, this table
and the setup route all change together; adding a service that speaks a shape Branch already knows
needs no code at all.

Routes:

- `GET /api/connections/catalog` — the whole catalog, with the date the prices were checked.
- `POST /api/connections/from-preset` — `{ provider, key, extras, model?, name? }`. Branch checks
  the key by using it *before* anything is saved, puts the key in the secrets locker under the
  project `model-connections`, registers the connection, and answers with the models it found. The
  key never appears in the answer, in an error message or in the log. The connection itself — its
  name, the service, the model and the boxes you filled in, never the key — is written down under
  the setting `model-connections`, so it is still there the next time Branch starts. A connection
  whose key has since been taken out of the locker by hand is quietly left out rather than half
  built.
- `POST /api/connections/forget` — `{ id }`. Takes one connection away for good: out of the model
  list, out of the written-down record, and its key out of the locker. Exactly the one named, never
  everything whose name begins the same way, and never the last connection you have.

The table below is generated from `data/providers.json` by `npm run docs:providers`. Do not edit it
by hand; edit the data file and run that command.

<!-- providers:start -->

Branch knows 38 model services. Every one of them has been tested against a fake of the
service, not against the real one, so treat this as "Branch speaks the right language", not as
"this was tried on a live account". Addresses and prices were last checked on 2026-09-16.

| Service | Where it runs | Speaks | What it can do | What you have to fill in |
| --- | --- | --- | --- | --- |
| AWS Bedrock | in the cloud | Bedrock | conversation, pictures in, tools, as it types | The AWS region your models are enabled in; Your AWS access key id |
| Anthropic | in the cloud | Anthropic | conversation, pictures in, tools, as it types | just a key |
| Azure OpenAI | in the cloud | Azure | conversation, pictures in, tools, fixed format, as it types, compare passages | Your Azure resource name; The name you gave the deployment |
| Baidu Qianfan | in the cloud | OpenAI | conversation, tools, as it types, compare passages | just a key |
| Cerebras | in the cloud | OpenAI | conversation, tools, fixed format, as it types | just a key |
| Cloudflare Workers AI | in the cloud | OpenAI | conversation, tools, as it types, compare passages, pictures out | Your Cloudflare account id |
| Cohere | in the cloud | Cohere v2 | conversation, tools, fixed format, as it types, compare passages | just a key |
| DeepSeek | in the cloud | OpenAI | conversation, tools, fixed format, as it types | just a key |
| Doubao (Volcengine Ark) | in the cloud | OpenAI | conversation, pictures in, tools, as it types, compare passages | just a key |
| Fireworks AI | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages, pictures out | just a key |
| GitHub Models | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages | just a key |
| Google Gemini | in the cloud | Gemini | conversation, pictures in, tools, fixed format, as it types, compare passages, live conversation | just a key |
| Google Vertex AI | in the cloud | Gemini | conversation, pictures in, tools, fixed format, as it types | Your Google Cloud project id; The region your project uses |
| Groq | in the cloud | OpenAI | conversation, tools, fixed format, as it types, speech | just a key |
| Hugging Face Inference | in the cloud | OpenAI | conversation, tools, as it types | just a key |
| Jan | on this computer | OpenAI | conversation, tools, as it types | just a key |
| LM Studio | on this computer | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages | just a key |
| LiteLLM proxy | on this computer | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages | just a key |
| LocalAI | on this computer | OpenAI | conversation, tools, as it types, compare passages, speech, pictures out | just a key |
| MiniMax | in the cloud | OpenAI | conversation, tools, as it types | just a key |
| Mistral | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages | just a key |
| ModelScope | in the cloud | OpenAI | conversation, tools, as it types | just a key |
| Moonshot (Kimi) | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types | just a key |
| Ollama | on this computer | Ollama | conversation, pictures in, tools, as it types, compare passages | just a key |
| OpenAI | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages, speech, pictures out, live conversation | just a key |
| OpenAI (Responses API) | in the cloud | OpenAI Responses | conversation, pictures in, tools, fixed format, as it types | just a key |
| OpenRouter | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types | just a key |
| Perplexity | in the cloud | OpenAI | conversation, as it types | just a key |
| Portkey | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types | just a key |
| Qwen (Alibaba DashScope) | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages | just a key |
| SambaNova | in the cloud | OpenAI | conversation, pictures in, tools, as it types | just a key |
| Something else that speaks OpenAI's shape | in the cloud | OpenAI | conversation, tools, as it types | The address the service gave you |
| Together AI | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages, pictures out | just a key |
| Voyage AI | in the cloud | OpenAI | compare passages | just a key |
| Zhipu GLM | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, compare passages | just a key |
| llama.cpp | on this computer | OpenAI | conversation, tools, fixed format, as it types, compare passages | just a key |
| vLLM | on this computer | OpenAI | conversation, tools, as it types | just a key |
| xAI (Grok) | in the cloud | OpenAI | conversation, pictures in, tools, fixed format, as it types, pictures out | just a key |

Services that need something more than a key, or that do not publish a list of their models:

- **AWS Bedrock** — Signs each request with your AWS keys rather than sending them. The secret access key is the key you paste in; the access key id and region go in the boxes above.
- **Azure OpenAI** — Needs your resource name and the name you gave the deployment; the model is chosen by the deployment, not by the model name.
- **Baidu Qianfan** — Baidu's Qianfan in its OpenAI-compatible mode. Billed in yuan; Branch keeps no price on file.
- **Cloudflare Workers AI** — Needs your Cloudflare account id as well as a token. Model names start with @cf/.
- **Cohere** — Cohere speaks its own shape rather than OpenAI's. Nothing extra to fill in.
- **Doubao (Volcengine Ark)** — ByteDance's Ark service. The model name is usually an endpoint id you created there. Billed in yuan; Branch keeps no price on file.
- **Google Vertex AI** — Needs a project id and a region, and a sign-in token rather than an API key. Branch does not fetch that token for you: paste one from `gcloud auth print-access-token`. Tokens expire after about an hour.
- **MiniMax** — A Chinese service, billed in yuan. Branch keeps no price on file for it.
- **ModelScope** — Alibaba's model hub in its OpenAI-compatible mode. Branch keeps no price on file for it.
- **Perplexity** — Answers questions with sources of its own. It does not publish a list of models, so Branch cannot check the key without using it.
- **Portkey** — A gateway that sits in front of other services and speaks OpenAI's shape. Which model answers depends on the configuration you set up there.
- **Qwen (Alibaba DashScope)** — Alibaba's DashScope in its OpenAI-compatible mode. Billed in yuan; Branch keeps no price on file.
- **Something else that speaks OpenAI's shape** — For a service Branch does not know about yet. Paste its address; it must be an https address, or a plain http one on this computer.
- **Voyage AI** — Compares passages only; it does not hold conversations, so it cannot be a connection that answers you. Use it for searching your own documents.
- **Zhipu GLM** — A Chinese service, billed in yuan. Branch keeps no price on file for it.

<!-- providers:end -->

### Two things Branch deliberately does not do

**One runtime, not several.** Branch runs a single assistant runtime. A second one inside the same
app would double the surface that has to be inspected, approved and audited, and would give you
nothing you cannot already have: when a task genuinely belongs to a different agent, Branch hands it
over across A2A or ACP (see the interoperability section) and reads the result back. So "pick which
agent engine runs this" is not a setting, and there is no plan for one.

**No Google PaLM.** Google retired the PaLM API in favour of Gemini, so an adapter for it would be
dead on the day it was written. Use the `gemini` entry for a Google AI Studio key, or `vertex-ai`
for a Google Cloud project.

### Models on this computer

**Settings → Models → On this computer** sets a model up with one click, through Ollama, LM Studio, llama.cpp's `llama-server` or (on a Mac with Apple silicon) MLX's `mlx_lm.server`, so a model can answer without anything leaving this machine and without any charge.

**The switch** (`settings/local-models`, `mode`): `off` (the default: every route that changes something refuses in one sentence, and nothing is restored at start), `when-needed` (one click works; at start Branch rebuilds the local connections and carries on setups that were interrupted), `on` (the same, and at start Branch also starts Ollama or LM Studio for your local connections when it is installed and not already running).

**What one click does** (`POST /api/local-models/setup`, with `{ "model": "qwen3-8b", "quant": "Q4_K_M" }` from the list, or `{ "name": "qwen3:8b" }`, and an optional `runtime`):

1. Picks the program: the one asked for, or the first installed of Ollama, LM Studio, llama.cpp, MLX. Branch only looks for programs where they are normally installed (`candidatePaths` in `src/local-launch.ts`). **It never installs one**: when none is there, the answer is `needsRuntime` with each program's official page.
2. Judges the fit on **free** memory (`vm_stat` on a Mac, `MemAvailable` on Linux, Node's figure on Windows), the graphics (a card's own memory, or on Apple silicon the shared memory, capped by `sysctl iogpu.wired_limit_mb` when the owner set it), and the room for words: weights × 1.1 + the model's key/value cache for that context + 256 MB. The largest context from 32,768 down to 4,096 that fits well is chosen. A size that will not fit is refused unless `force` is sent.
3. Checks the disk that will hold the model (`fs.statfs` on Ollama's `OLLAMA_MODELS` or `~/.ollama/models`, LM Studio's `~/.lmstudio/models`, or Branch's own `local-models/` folder), keeping 2 GB spare.
4. Starts Ollama (`ollama serve`) or LM Studio (`lms daemon up`, `lms server start --port 1234`) if it is installed and not answering. On Linux, when Ollama is a system service, Branch says `sudo systemctl start ollama` instead of starting a second copy.
5. Downloads with progress: Ollama's `/api/pull`; LM Studio's `POST /api/v1/models/download` and its `/download/status/:job_id`; for llama.cpp and MLX, Branch fetches from Hugging Face itself, keeping a `.partial` file and asking only for the rest with `Range`, following each redirect by hand under the network rules, and checking the published SHA-256 before the file is put in place.
6. Loads it with the chosen context: for Ollama, a copy named `<model>-branch<N>k` with `num_ctx` set (it shares the weights, so it takes no disk space) is created and warmed; for LM Studio, `POST /api/v1/models/load` with `context_length`; llama.cpp and MLX are started with the file on a free port on this computer that the system picks at each start (`llama-server -m … -c … --host 127.0.0.1 --port <free> --jinja`, `mlx_lm.server --model … --host 127.0.0.1 --port <free>`). Their connections only talk to that port, and send nothing after a restart until the model is set up again. Programs start without Branch's own settings, keys, tokens or `NODE_OPTIONS` in their environment. A short-lived key cannot flip the switch, download, delete, or start or stop a program.
7. Asks one small question, then adds the connection `local-<program>-<model>` named "… (runs on this computer)", written down in `settings/local-model-connections`.

Every step is written down in `settings/local-model-setups`, so the screen can follow it and a setup still open when Branch closed carries on when it opens. Stopping one (`/setup/stop`) keeps what was downloaded for next time.

Routes, all under `/api/local-models`:

| Route | What it does |
| --- | --- |
| `GET /api/local-models` | Everything the card shows, including `mode` and, under `oneClick`, free memory, the programs and whether each is installed, the list sized for this computer, setups, what is loaded and what is downloaded. |
| `POST /api/local-models/switch` | `{ "mode": "off" \| "when-needed" \| "on" }`. |
| `POST /api/local-models/offers` | `{ "runtime": … }`: the list, with a fit and a context per size, for that program. |
| `POST /api/local-models/search` | `{ "runtime", "query" }`. Hugging Face's search for LM Studio (GGUF), llama.cpp (GGUF) and MLX. Ollama's library has no search API, so for Ollama the query is looked up as an exact name in its registry, with its download size. |
| `POST /api/local-models/setup`, `/setup/stop` | One click, and stopping it. |
| `POST /api/local-models/unload` | `{ "runtime", "id" }`: Ollama `keep_alive: 0`, LM Studio `POST /api/v1/models/unload` with the instance id, or stopping the llama.cpp or MLX server Branch started. |
| `POST /api/local-models/delete` | `{ "runtime", "id" }`: removes a downloaded model (and Ollama's sized copies, and the connection that used it) and says how much space it freed. LM Studio offers no delete route, so that one is refused with where to do it. |
| `POST /api/local-models/runtime/start`, `/runtime/stop` | Starts an installed program; stops LM Studio's server or a program Branch started itself. |
| `GET /api/local-models/downloads`, `POST /pull`, `/stop`, `/remove`, `/details`, `/load` | The earlier Ollama download routes and LM Studio load, kept for scripts; the changing ones also obey the switch. |
| `GET` / `POST /api/local-models/routing` | Reads and saves the per-task routing rules (`settings/routing`). |
| `POST /api/local-models/routing/preview` | Says which model would take a given task, and why, without running it. |

**The list** is `data/local-models.json`: ten models, most in two or three sizes (Q4_K_M, Q8_0, F16, or gpt-oss's own MXFP4), each with its Ollama tag, Hugging Face GGUF file and SHA-256, and MLX repository where one exists, their sizes, whether it can use tools (a model that cannot is shown with a warning), and the figures the memory estimate needs. Sizes and hashes were read from the registries on 2026-09-17.

**Graphics memory.** Windows asks `nvidia-smi.exe` first; otherwise the name still comes from `Get-CimInstance Win32_VideoController`, and the memory from the driver's 64-bit `HardwareInformation.qwMemorySize` registry value, because `AdapterRAM` is a 32-bit field that reports no more than 4 GB. The `AdapterRAM` figure is still used when the registry has nothing larger. The older three-size advice (`recommendations`) is still in the answer for scripts.

**macOS and Linux.** On a Mac the graphics are read once from `system_profiler SPDisplaysDataType -json`. A Mac with Apple silicon has no separate video memory: its graphics share the computer's own memory, and the summary says so ("Apple M4 graphics, which share that memory"). Branch cannot ask Metal for its default graphics limit without native code, so unless `iogpu.wired_limit_mb` is set it plans with free memory. MLX is offered only on Apple silicon. On Linux `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` is asked first; without it, `lspci` gives the card's name, and for an AMD card `rocm-smi --showmeminfo vram --json` or the driver's `/sys/class/drm/card*/device/mem_info_vram_total` gives the memory. Anything unexpected simply means "no card reported".

**Routing rules** (`settings/routing`, off by default): `enabled`, `localForPrivate` (a task mentioning personal details stays here), `cloudForHard` (long or tool-heavy tasks go to the cloud model), `costCeilingDollars` (a simple task that would cost more than this in the cloud uses the free local model instead), and optional `localPreset` / `cloudPreset`. What you explicitly choose for a run or a conversation always wins; when routing does pick, the run records a `model.routed` event with the reason. The rule itself also has a "local server is not answering, use the cloud one" branch, but nothing probes the local server before a run yet: a task sent to a local model that does not answer falls back the ordinary way, through the connection's configured fallbacks and the provider cooldown. `POST /api/local-models/routing/preview` is the one caller that can set `localUp` today.

**Reading passages by meaning.** When the connected model is Ollama on this computer, document and memory search use Ollama's own `/api/embeddings` instead of the OpenAI-shaped route, one passage per request, and `text-embedding-3-small` is swapped for `nomic-embed-text`, which is what exists here.

**Addresses.** Every call to a program on this computer is first checked to be `localhost`, `127.0.0.1` or `[::1]` with no credentials, query or fragment, then against the owner's network rules — allowed and blocked hosts and paths all apply, so blocking `127.0.0.1` stops it — with only the blanket refusal of local addresses left out, since a local runtime is nothing but a local address (`src/local-policy.ts`). Local connections are rebuilt at start with that same check rather than with the ordinary provider rules, which would refuse them. Calls to Hugging Face and Ollama's registry go through the ordinary network policy in full. Model names are checked against the shape each program accepts, so a name can never become a path.

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

### Where "search the web" actually goes

`web.search` goes to whichever service the `web.search` block names. Whatever is chosen, the request still goes through the same network settings every other outbound call goes through.

| `backend` | Needs | Honest note |
| --- | --- | --- |
| `duckduckgo` (default) | nothing | A scrape of a public results page. No promises attached, rate-limited by whoever runs it, and on a busy day it returns nothing at all. Fine for the occasional look; not for work that depends on search. |
| `searxng` | `searxngUrl` | Your own SearXNG, on your own machine or network. Nothing is shared with anyone else. |
| `brave` | `keySecret` | Brave Search. |
| `tavily` | `keySecret` | Tavily, built for assistants. |
| `exa` | `keySecret` | Exa, good at finding pages by meaning. |
| `serper` | `keySecret` | Serper, which fetches Google results. |

`keySecret` names a secret in the locker — the key itself never goes into the settings file. A paid service chosen without its key refuses with a sentence saying which secret to save.

The free fallback reads a public results page rather than an interface meant for programs, which is something DuckDuckGo's terms of service do not invite. Branch asks for one page per search, identifies itself honestly in its user agent, and follows no link from the results by itself — but scraping is still their call, not ours, and they may stop answering at any time. If search matters to your work, pay for one of the services above or run a SearXNG of your own. Nothing here overrides a site's `robots.txt`: `web.fetch` and the browser only ever open an address a person or a task has asked for by name.

```json
{ "web": { "search": { "backend": "tavily", "keySecret": "TAVILY_API_KEY" } } }
```

`searchEndpoint` still sets the address the free fallback uses, so anything already set up keeps working.

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

### Numbering the things on a page

Guessing at selectors is how browser tasks go wrong. `browser.annotate { draw?, limit? }` numbers everything on the page you can press or type into, draws a small red label beside each one, and hands back a short list such as `[3] button "Save"`. The assistant can then say "press 3".

A number belongs to the *thing*, not to its place. It is worked out from what the thing is, what it is called, and the kinds of boxes it sits inside — never from its position — so a page that throws its contents away and draws them again keeps its numbers, and a genuinely new thing gets a new one. The numbers last for one task and are forgotten when the task ends.

The labels live in their own box marked as decoration, so they never turn up in `browser.snapshot` or in anything `browser.extract` pulls out. `browser.unmark` takes them off again before a picture or a saved page.

**A number is checked, not trusted.** The number is written onto the thing as an attribute, which
is something the page itself could also write, so before a number is acted on three things are
checked: that it was really given out by this task, that exactly one thing on the page is wearing
it, and that the thing wearing it is still the *same* thing it was given to — worked out again from
what it is, what it is called and the kinds of boxes it sits inside. A page that quietly moves a
number from the Save button onto something else gets a plain refusal naming the number, and nothing
is pressed. The four refusals read: "Number 4 was never given out on this page", "Number 4 is no
longer on this page", "Number 4 is on more than one thing, so it was not used", and "Number 4 is now
on a different thing from the one it was given to, so it was not used".

**The honest limits:** only things that are visible and that the page describes in the ordinary way are numbered. A control drawn entirely on a canvas, or inside another page embedded in this one, is invisible to this and to every other browser tool here. And because a number comes from what a thing is and is called, two things that are genuinely alike — the same kind of button, the same words, the same surroundings — end up sharing a number; acting on that number is then **refused** ("Number 4 is on more than one thing"), because taking whichever came first is exactly how a press lands on the wrong thing. Say which one with a selector, or narrow the page first.

### Data in the shape you asked for

`browser.shape { rows?, fields, limit? }` reads the page into an exact shape. Each field says where to read it (`selector`, or `attribute` for something like a link's address), and what kind of thing it is: `text`, `number`, `boolean`, `date` or `url`. `rows` names the repeated block — a table row, a card — and without it the page is read once.

What comes back has already been checked. A field marked `required` that is missing, or a number that is really words, makes the whole call a refusal that names the failing field, so the assistant fixes its request instead of acting on a guess. A field not marked required comes back as `null` rather than invented.

### Actions that heal themselves

Websites are rewritten constantly and remembered selectors rot. `browser.act { action: click | fill | check, selector?, name?, mark?, value? }` tries up to four ways in order: the exact selector, the thing's name as a button, the words showing on it, then its number from `browser.annotate`. The result says which way worked (`foundBy`) and how many were tried, and the same goes into the task's trace with `healed: true` when it was not the selector — so a step that keeps healing shows up and can be fixed properly.

It never looks at a different page and never tries more than four ways. A thing that is genuinely gone is reported as gone, naming every way that was tried. A number is the one way whose answer comes off something the page could have written itself, so it is the one way that is checked rather than trusted (above); when the check fails, the refusal says which of the four reasons it was, and nothing is pressed. Typing into a password box is refused here as everywhere else.

### Using the browser you already have open

Branch normally uses a fresh browser that no website knows you in. **Settings → Websites you stay signed in to → Letting Branch use the browser you already have open** lets it work in *your* browser instead, so everything you are signed in to already knows you.

**The plain risk:** while this is on, anything that browser is signed in to — your email, your files, your accounts — is something Branch could open. Three things hold it back, and you should read all three before turning it on:

- It is on for **one task**, named by its task number, and it **turns itself off after fifteen minutes**. A different task has to ask again. Leaving the task number empty does not open it to everything: the first task that borrows takes the switch for itself, and the next one has to ask again. Locking Branch gives the browser back straight away.
- Banks, brokers, password managers and webmail are **always refused** — email is on the list because a mailbox is how every other account is taken back. The refusal applies not only when Branch is asked to open one, but on **every single request its tab makes**, so a link followed inside the page is refused too. The list sits beside the one the screen-and-keyboard control uses for windows; that one matches window titles, which a website name would never trip, so a list of website names was added next to it. Anything whose name contains "bank", "vault" or "password" is refused as well.
- Branch opens **a new tab of its own** and closes only that tab. Your own tabs are never watched, never redirected and never closed; when the task ends Branch stops listening rather than shutting anything down. Your cookies are never copied into a saved sign-in.

To use it, close Chrome or Edge and start it yourself with `--remote-debugging-port=9222`, then put that number on the settings card and tick the switch. The task asks with `browser.borrow { action: "borrow" }` and gives it back with `{ action: "give back" }`.

Routes: `GET /api/browser/attach`, `POST /api/browser/attach` with `{ "enabled": true, "port": 9222, "runId": "…" }`. `extraRefusedHosts` is your own list of further websites your browser may never be pointed at; it is added to the built-in list of banks and password sites, and nothing you can put there takes one off that list.

**The honest limits:** this only works with Chrome or Edge, only on this computer, and only when you started the browser with that door open — Branch never starts it for you and never opens one you can see. A browser started the ordinary way cannot be borrowed.

### Keeping a recording of a task

`browser.recording { action: "start" }` then `{ action: "keep" }` writes a Playwright trace beside the task's other files. Open it in Playwright's trace viewer to watch what happened step by step.

What goes in: the steps taken and a picture of the window at each one. What deliberately does not: **a copy of the page's own markup**. A password box carries its contents in the markup even when it looks blacked out on screen, so markup snapshots are switched off outright. On top of that, password boxes are **emptied before every step** while a recording is being made, because the recorder writes down a description of whatever a step points at and that description would otherwise carry the contents with it. So if a website had already filled a password box on the page, a recording clears it.

This is checked by unpacking the recording and searching the readable text inside — searching the packed file would prove nothing, because everything inside it is squashed.

A recording photographs **every tab in the window it is made in**, so a recording and borrowing your own browser are never on at the same time: whichever you ask for second is refused with a sentence saying why. A recording is only ever made in a browser of Branch's own.

### One way of saying "look at this, press that"

`computer.look`, `computer.press` and `computer.type` take `at: "page"` or `at: "window"` and hand the work to the browser tools or to the screen-and-keyboard tools. Both underlying sets stay exactly as they are; this is a shorter way of saying the common thing, not a replacement.

Nothing is bypassed: each one goes through the very method the underlying tool uses, so the same limits are counted and the same refusals apply. Reaching a window needs the screen permission **as well**, checked separately, so a task allowed to browse cannot reach your windows through the short way. Whichever half is not configured in this launch says so plainly when it is asked for.

### Skills for the sites you actually use

Most of the trouble with a browser task is one website's habits: the cookie notice that covers
everything, the table that is drawn a moment after the page says it has loaded, the same three
columns you pull off it every time. Those belong in a skill about that site, not in Branch.

A skill package may carry a **`site.json`** beside its `SKILL.md`:

```json
{
  "site": {
    "hosts": ["shop.example.com"],
    "dismiss": ["#cookie-notice .accept"],
    "waitFor": "#results",
    "settleMs": 200,
    "readings": {
      "basket": {
        "rows": "tr.line",
        "fields": {
          "item": {"selector": ".name", "required": true},
          "price": {"selector": ".price", "type": "number", "required": true}
        }
      }
    },
    "notes": "The basket table is drawn after the page loads, so wait for #results first."
  }
}
```

| Field | Default | What it does |
| --- | --- | --- |
| `hosts` | required | The websites this skill knows, one to ten. A page on any of them, or under one of them, gets its quirks. |
| `dismiss` | none | Up to five things to press once when a page opens, such as a cookie notice. One that is not on the page is skipped. |
| `waitFor` | none | Something to wait up to five seconds for before the page counts as ready. A wait that never comes is reported, not thrown. |
| `settleMs` | 0 | How long to let the page settle once it has opened, up to five seconds. |
| `readings` | none | Named readings of this site, each an ordinary `browser.shape` request written down once. |
| `notes` | empty | What is odd about this site, in plain words, for the person reading the skill. |

With one installed and switched on, `browser.navigate` to that website applies the quirks by itself
and **says in its answer that it did** — which notice it pressed, whether the wait came, and the
skill's own note. `browser.site { action: "list" }` says which websites have a skill and what each
one knows; `browser.site { action: "read", name: "basket" }` reads the page by the name of a
reading, and refuses by name when there is no such reading.

**Pressing is not reading.** Opening a page is a reading permission and pressing something is not,
so a task that may only read gets the waiting and the settling but never the pressing: what it
would have pressed comes back in the answer as `notPressed`, so it can ask for what it needs
instead of wondering why the notice is still there.

**What a site skill may not do.** It is data and only data: selectors, a wait, a pause and named
readings. There is deliberately nowhere to put a piece of script, because a skill can arrive from
anybody and a script in one would run inside the page. The selectors it will press are named in the
card you read before installing the skill — "presses #cookie-notice .accept when a page opens" —
because a cookie notice and a confirm-delete button look the same until somebody writes them down.
And it can never widen anything: it cannot
add a website to `allowedOrigins`, and a bank, broker, password manager or mailbox is refused as a
site skill outright, in the same words the browser refuses one everywhere else. A skill that is
installed but switched off brings no quirks, in the same way it brings no instructions. Site skills
are read fresh each time, so installing one needs no restart.

### Browser skills that come with Branch

Five ready-made skills are shipped as ordinary skill packages: **search and summarise the top
results**, **fill a form from a document**, **watch a page for a change** (which tells the assistant
to use the existing watcher rather than browse in a loop), **read several pages of one site** (how
to follow a site's own links a bounded number of times instead of crawling), and **write a site
skill** (how to write the `site.json` above). They are instructions and nothing else — no web calls,
no recipes — and arrive switched off like any other skill.

`GET /api/skills/browser` lists them; `POST /api/skills/browser { "name": "search-and-summarise" }` installs one.

### Not built, and what stands in for it

Remote and cloud browsers — Browserbase and the like — are **not built**. Everything here runs a browser on this computer.

**Three audit rows describe one thing under three project names.** `A2172` (browser-use
automation), `A2042` (browser-use integration) and `A2019` (browser/computer-use tools) all ask for
the same capability: an assistant that looks at a page, points at a thing on it and acts. That is
built, and it is what this whole section describes — `src/integrations/browser.ts` with
`browser-marks.ts`, `browser-schema.ts`, `browser-heal.ts` and `browser-sites.ts`, asserted in
`tests/browser-2.test.mjs` and `tests/browser-3.test.mjs`. What is **not** built, and deliberately
so, is the Python `browser-use` runtime those rows name, and the hosted sandbox backend `A2019`
names: Branch is TypeScript and drives the browser on this computer, the same reason the
`hybrid-tooling`, `cloud-compute` and `remote-execution` families are already marked not applicable.
One implementation satisfies all three rows; none of them needs building again.

**`A0743` (Scrapling page fetch) — not applicable.** It names another project's Python fetching
library. Fetching a page and reading it out is `web.fetch` (readable text, redirects bounded,
private addresses refused) and `browser.shape` (the same page in an exact shape) — both built and
tested. Branch would not gain a capability by adding a Python library, only a dependency.

**`A1452` (web crawling) — not applicable as a crawler; the capability is covered.** It names
Crawl4AI. Following a site's own links is `web.fetch` or `browser.navigate`, then `browser.shape`
for the addresses, then reading a bounded handful of them — which is what the shipped
**read several pages of one site** skill sets out, with the rules that keep it from becoming a
crawl: the same website only, one level deep, at most five pages, never in a loop. A page to be
checked again and again is the `monitors` tool's job, not a crawler's. No crawler is built, and a
task's caps on actions and websites (above) already stop one being improvised.

**The two document rows filed under the browser (`family: doc-processing`, `family:
document-processing` in #62) are stale.** PDF text extraction and document extraction are both
built with no extra software: `src/document-pdf.ts` unpacks the streams, reads the text operators
and applies the file's own character tables; `src/document-readers.ts` routes `pdf` to it alongside
Word, spreadsheets, PowerPoint, EPUB, RTF, HTML, CSV and JSON. Asserted in
`tests/docs-memory-2.test.mjs` (compressed streams unpacked, lines in the order they sit on the
page, a locked PDF refused in one sentence, a PDF of pictures saying so rather than pretending) and
`tests/docs-3.test.mjs`. Nothing here needs building.

## Code editor (A0098)

**Settings → Advanced → Developer → Code editor** has the three-way switch, off by default. When it is
"when needed" or "on", a conversation's **Files** tab gets **Edit a file**: a list of the workspace's
folders, a plain text editor with line numbers, Save (or Ctrl/Cmd+S) and Tab for two spaces.

- Every path goes through the same checks as the assistant's own file tools: nothing outside the
  workspace, no secret-looking names (`.env`, keys, credentials are not even listed), nothing
  `.branchignore` hides, and no link that leads out of the workspace.
- The memory folder opens read-only. A file that is not text, or is larger than 32 KiB, is refused.
- Saving is the assistant's own `files.write`, so the bytes before are kept and the change can be put
  back with `files.history` / `files.restore` like any other.
- A save says which version of the file it was opened from. If the file changed on disk since then
  (another program, the assistant), the save is refused and says so; nothing is overwritten.
- A short-lived key (`branch token create`) cannot use the editor at all: not its switch, not the
  list, not opening a file and not saving one.
- Branch's own program, settings and saved work stay out of reach here as everywhere else
  (`src/never-break/protected.ts`): a save there is refused whatever the switch says.

Routes: `GET/POST /api/workspace-editor/settings`, `GET /api/workspace-editor/list?path=`,
`GET /api/workspace-editor/read?path=`, `POST /api/workspace-editor/save`. Asserted in
`tests/code-editor.test.mjs`. Works the same on Windows, macOS and Linux.

## Channels (Telegram)

Create a bot with @BotFather, then either save its token as the secret `TELEGRAM_BOT_TOKEN` in the default project or export it as an environment variable, and add to the integrations file:

```json
{ "channels": [{ "type": "telegram", "tokenSecret": "TELEGRAM_BOT_TOKEN", "activation": "mention", "pairing": true, "allowlist": [] }] }
```

`tokenEnv` names an environment variable instead of a secret. Each chat (direct or group) keeps its own conversation. A sender who is neither on the `allowlist` (Telegram user ids) nor approved receives a six-digit code; approve it in **Settings → Channels** or with `POST /api/channels/pairings/approve {code}`. With `pairing: false`, strangers are told the assistant is private. In groups, `activation: "mention"` answers only messages that mention the bot or reply to it; `"always"` answers everything. Channel tasks run with every tool permission except host command execution. `GET /api/channels` lists connected channels, pending and approved people.

### What every channel shares

`activation`, `pairing` and `allowlist` mean the same on every channel, and every channel uses the same delivery ledger, the same pairing codes and `POST /api/channels/link { channel, chatId, sessionId }`. Every credential is read from an environment variable of that name first, then from a secret of that name in the **default project's** locker; nothing is ever written into the connections file. Every outbound request goes through the network settings in `web`, including the chat sockets (checked as the matching `https://` address) and the mail servers (checked by host name). `GET /api/channels` reports each channel's `health` as `connected`, `reconnecting` or `needs attention` with a plain reason; **Settings → Channels** shows the same line and a **Check the connection** button. A secret never appears in that output, in an error message or in the log.

### Watching and steering a task from the chat

Everything in this section is **off on a fresh install**: chat replies arrive exactly as before until you switch a part on. There are four switches, each `on`, `off` or `when-needed`, read from `GET /api/channels` (`live`) and changed with `POST /api/channels/live { liveStatus?, commands?, steering?, splitting? }` (the ones you leave out keep their value):

| Switch | On | When needed | Off |
|---|---|---|---|
| `liveStatus` | Typing, the reaction and the progress message from the start. | Nothing for a quick answer; all three start once a task has worked for about four seconds. | Just the reply. |
| `commands` | Every command below. | Only `/stop`, `/status`, `/btw` and `/help`, and only while a task works. | A message starting with `/` is an ordinary message. |
| `steering` | Quick messages are answered as one, and later ones are handed to the running task. | Handed to the running task, without waiting to gather quick messages. | A message for a busy chat waits for the task to finish and is answered on its own. |
| `splitting` | Paragraph breaks first, and code blocks closed and reopened. | The same, but only for a reply that contains code. | Cut at the last line break or space, as before. |

These are things the chat does, not things the model reads, so "when needed" is decided by the moment (a slow task, a busy chat, code in the reply) rather than by loading a summary into the prompt.

While a task works, the chat shows it. Where the app has them: "typing…" stays on (Telegram, Discord, Matrix); the message you sent gets a reaction that moves from 👀 (seen) to 🤔 (thinking) to 👨‍💻 (using a tool) and ends on 👍 (done) or 😢 (stopped or went wrong) (Telegram, Discord, Slack); and a task still working after about four seconds gets one progress message that lists its steps and then fills in the reply as it is written, edited in place (Telegram, Discord, Slack). When the reply fits, it replaces the progress message instead of arriving a second time; otherwise the progress message ends as "Done (3 steps)." and the reply follows as usual. An app without these (WhatsApp, Signal, email, Messenger, a plugin's chat service) simply gets the reply. Nothing of this is shown during quiet hours or Lockdown, and every word passes the same last look as a reply.

Messages you send within about a second of each other are answered as one. A message sent while a task works is handed to it as a note it reads before its next step, the same as **Steer** in the app, and gets a 👀 (or "Noted." where there are no reactions); a note that arrives as the task is finishing becomes the next message instead of being lost. Only allowed or approved senders reach any of this; a stranger's `/stop` gets the pairing answer. The commands:

| Send | What happens |
|---|---|
| `/stop` (or `/cancel`) | Stops the task (or drops a message that has not started). |
| `/status` | How long it has worked, how many steps, and the latest one. |
| `/new` (or `/reset`) | The next message starts a new conversation; the old one stays in the app. |
| `/compact` | Folds the earlier part of the conversation into a summary now; the latest messages and pinned ones stay. |
| `/usage on` / `/usage off` | Adds a tokens-and-cost line to replies in this chat (estimates are called estimates). |
| `/btw <question>` | A quick answer on the side, with no tools, in a throwaway conversation; it never joins the task. |
| `/help` | The list. |

In a group where the bot answers only when mentioned, mention it before the command (`@YourBot /status`). Long replies are split at paragraph breaks first, and a block of code is closed at the end of one message and opened again, with its language, at the start of the next.

**macOS and Linux.** None of this uses anything from the operating system: it is the same code and the same calls to each chat service on Windows, macOS and Linux, and the tests use stand-in services on all three.

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

Point Meta's webhook at `/webhooks/whatsapp/<channel id>/<the word on your Connections card>` (the word is the same unguessable one every other chat address now carries, and the same one-release grace applies) and give it the same verify word. **The reverse proxy that exposes Branch must rewrite the `Host` header to the local bind address** (`127.0.0.1:<port>`), exactly as the schedule hook routes need: the server refuses any request whose `Host` is not its own, which is what stops a web page from reaching it through your browser. That route carries no session token, like the trigger routes: `GET` answers Meta's one-off `hub.challenge` as plain text when `hub.verify_token` matches, and `POST` is refused with 401 unless `X-Hub-Signature-256` is an HMAC-SHA256 of the exact bytes under the app secret. Text messages only; `allowlist` and `chatId` hold WhatsApp numbers in `wa_id` form. WhatsApp only allows a free-form reply within 24 hours of the person's last message: a later send is refused with "Outside WhatsApp's 24-hour reply window", so the delivery ledger holds it, retries it for about two and a half minutes, then parks it under **Messages still to send** for the owner to retry once the person writes again. When each person last wrote is remembered only while Branch is running, so after a restart the first reply to someone is attempted rather than held back.

### Channels (email)

Save the mailbox password as `EMAIL_PASSWORD` and give both servers:

```json
{ "channels": [{ "type": "email", "address": "you@example.com", "pollSeconds": 60,
  "imap": { "host": "imap.example.com", "port": 993, "user": "you@example.com" },
  "smtp": { "host": "smtp.example.com", "port": 465, "user": "you@example.com" },
  "pairing": true, "allowlist": ["someone@example.com"] }] }
```

Built on Node's own TLS with no mail library: a small IMAP4rev1 reader (`LOGIN`, `SELECT INBOX`, `SEARCH UNSEEN`, `FETCH`, `STORE \Seen`) looks for unread mail every `pollSeconds`, answers it, and marks it read so it is never answered twice; a small SMTP sender (implicit TLS, `AUTH PLAIN` then `AUTH LOGIN`, `8BITMIME`) sends the reply threaded onto the original with `In-Reply-To` and `References` and a `Re:` subject. `allowlist` holds sender addresses. `tls: false` on a server connects in the clear and upgrades with `STARTTLS` when the server offers it, which is only sensible for a mail server on this computer. **Plain text only**: attachments, HTML mail and multipart bodies are not read or sent, and quoted history below an "On … wrote:" line is trimmed from the question. An address longer than 60 characters is shortened to a stable `who:<hash>` handle, because a chat id may hold 64 characters; such an address therefore cannot be put on the `allowlist` by address, and has to pair with a code instead. The first look at the inbox does not hold up starting, so a mail server that is unreachable shows as **reconnecting** with the reason rather than stopping Branch.

## Connections: the other chat services

Ten more team-chat services work the same way as each other: you paste in an address to send to, the service posts what people write to an address of yours, and a signature or a shared word proves the post really came from the service. Branch has one connection for all of them, and what each one needs is kept as data in `data/channels.json` rather than as a separate piece of program. The table below is written from that file, so it can never say a service does something its row does not say it does.

The **longest message** column is what the service itself accepts. Branch splits every reply at 3,500 characters whatever the service allows, because a longer one is unreadable in a chat window, so a service with a higher limit is never sent more than that. The table is regenerated with `node scripts/channels-table.mjs`.

<!-- channels-table:start -->

| Service | Text | Files | Voice in | Voice out | Buttons | Can reply to you | Longest message | How this was checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Mattermost](https://developers.mattermost.com/integrate/webhooks/) | yes | no | no | no | no | yes | 4000 | tested against a fake of the documented shape |
| [Rocket.Chat](https://docs.rocket.chat/docs/integrations) | yes | no | no | no | no | yes | 4000 | tested against a fake of the documented shape |
| [Google Chat](https://developers.google.com/chat/how-tos/webhooks) | yes | no | no | no | no | yes | 4000 | tested against a fake of the documented shape |
| [Microsoft Teams](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook) | yes | no | no | no | no | yes | 4000 | tested against a fake of the documented shape |
| [Zulip](https://zulip.com/api/outgoing-webhooks) | yes | no | no | no | no | yes | 4000 | tested against a fake of the documented shape |
| [Feishu / Lark](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) | yes | no | no | no | no | yes | 4000 | tested against a fake of the documented shape |
| [DingTalk](https://open.dingtalk.com/document/robots/custom-robot-access) | yes | no | no | no | no | yes | 2000 | tested against a fake of the documented shape |
| [WeCom group robot](https://developer.work.weixin.qq.com/document/path/91770) | yes | no | no | no | no | send only | 2000 | tested against a fake of the documented shape |
| [LINE](https://developers.line.biz/en/docs/messaging-api/receiving-messages/) | yes | no | no | no | no | yes | 4900 | tested against a fake of the documented shape |
| [Viber](https://developers.viber.com/docs/api/rest-bot-api/) | yes | no | no | no | no | yes | 7000 | tested against a fake of the documented shape |

- **Mattermost** (`mattermost`) — Outgoing webhooks post the words people type with the token you chose; incoming webhooks carry the reply back. Text only. You need: The address of an incoming webhook (Integrations, then Incoming Webhooks); The token you set on the matching outgoing webhook.
- **Rocket.Chat** (`rocketchat`) — Two integrations, one each way, sharing the token Rocket.Chat shows you. Text only. You need: The address of an incoming webhook integration; The token shown on the matching outgoing webhook integration.
- **Google Chat** (`googlechat`) — A space webhook carries the reply; the Chat app's own events carry what people write, proved by the verification token Google shows you. Branch does not check Google's bearer token, so put this address behind something only Google can reach. You need: The address of a space webhook (Manage webhooks inside the space); The verification token shown on your Chat app's configuration page.
- **Microsoft Teams** (`msteams`) — An incoming webhook sends and an outgoing webhook receives, with Teams signing every post. This is not a full Teams app: there is no Bot Framework registration, so one-to-one chats, cards and file sharing are out of reach. You need: The address of an incoming webhook added to the channel; The security token Teams shows when you create the outgoing webhook.
- **Zulip** (`zulip`) — Replies go back as private messages to whoever wrote, so a question asked in a stream is answered in a direct message. You need: Your Zulip address, for example https://example.zulipchat.com; A bot's email and key written as one base64 word, for the Basic header; The token shown on the outgoing webhook bot.
- **Feishu / Lark** (`feishu`) — Feishu asks the address to echo a word once before it will send anything; Branch answers that automatically. Encrypted event subscriptions are not supported, so leave the encrypt key empty. You need: The address of a custom bot webhook added to the group; The verification token from the app's Event Subscriptions page.
- **DingTalk** (`dingtalk`) — Both directions are signed with the same secret and a timestamp. DingTalk signs the timestamp rather than the words, so the signature proves who sent it and that it is recent, not what it says; a post copied and sent again more than five minutes later is refused, one copied within that window is not. You need: The address of a custom robot webhook; The signing secret shown beside it (starts with SEC).
- **WeCom group robot** (`wecom`) — Send only. A WeCom group robot has no way to hand messages back, so Branch can post to the group but cannot be asked anything there; use it for the morning brief and for notices. You need: The address of a group robot webhook.
- **LINE** (`line`) — Replies are sent with the push endpoint rather than the reply token, so an answer that takes a while still arrives. LINE counts pushed messages against your plan. You need: The channel access token from the LINE Developers console; The channel secret from the same page.
- **Viber** (`viber`) — The same token both signs what Viber sends and authorises what Branch sends back. One-to-one chats only. You need: The bot authentication token from the Viber admin panel.

<!-- channels-table:end -->

Connect one by naming the service in the connections file:

```json
{ "channels": [{ "type": "chat", "id": "work-chat", "service": "mattermost",
  "webhookUrlSecret": "MATTERMOST_WEBHOOK", "secretSecret": "MATTERMOST_TOKEN",
  "botName": "branch", "activation": "mention", "pairing": true, "allowlist": [] }] }
```

`service` is the id from the table (`mattermost`, `rocketchat`, `googlechat`, `msteams`, `zulip`, `feishu`, `dingtalk`, `wecom`, `line`, `viber`). The three `…Secret` settings name a secret in the **default project's** locker, or an environment variable of that name, exactly as every other channel does; nothing is written into the connections file. Give only the ones that service's row asks for: `webhookUrlSecret` for the services you paste an address for, `tokenSecret` for the ones with a proper API, and `secretSecret` for the shared word or signing key. `apiBase` is for the services your company hosts itself (Zulip, Mattermost). `botName` is what the bot is called in a group, so "reply when mentioned" knows what to look for; without it a group message is always answered.

Point the service's outgoing webhook at `/webhooks/chat/<channel id>/<the word on your Connections card>`. **The address carries a long random word of its own**, 128 bits made on this computer the first time the Connections card shows it, because the part before it is a name you chose — "telegram", "work" — and a name a person picks is a name somebody else can guess. Guessing it was never a way in (every post still has to be signed), but it did let anyone on the internet find the door and knock; now they cannot find it. The card shows the whole address with a **Copy this address** button and a **Give it a new address** button for when you think somebody else has seen it. Addresses without the word on the end are still answered for one release, so you have time to change them over — the card gives the date they stop — and `POST /api/channels/addresses/settings {"acceptOldAddresses": false}` ends that early. The date itself is `oldAddressesEndOn`, written down the first time this copy of Branch makes an address, so the card can name a day rather than say "soon". After it, the old shape is 404, refused before the channel is even looked up, so a wrong address never says which channel names exist. `GET /api/channels/addresses` lists the addresses and `POST /api/channels/addresses/rotate {"channel": "telegram"}` makes a new one. The word for a channel is made the first time the Connections card asks for it and never by a post arriving from outside, so somebody knocking on names they invented cannot leave anything behind on this computer. That address carries no session key, like the WhatsApp one, so **the reverse proxy that exposes Branch must rewrite the `Host` header to the local bind address**. A post whose signature or shared word does not match is refused with 401 and nothing inside it is read; the refusal is written into the record of what the assistant was allowed to do, without the post itself, and somewhere that keeps posting rubbish is made to wait after five tries, counted separately from the app's own key so it can never shut you out of your own app. A service that sends the same message again because it did not hear back quickly is answered once, not twice: each connection remembers for two minutes what it has already taken in. Feishu asks the address to echo a word back once before it will send anything; Branch answers that automatically. Everything else is the same as every other channel: the pairing code for a stranger, the `allowlist`, "reply when mentioned", the delivery ledger with its retries and quiet hours, and the `reply y / a / n` answer to a question, because none of that lives in the connection.

`activation`, `pairing`, `allowlist`, pairing codes and `POST /api/channels/link` all mean exactly what they mean on Telegram. Chat, sender and message ids longer than the delivery ledger allows are shortened to a stable handle (`chat:…`), which means such an id cannot be put on the `allowlist` by hand; that person pairs with a code instead.

**What is not built.** None of these ten carry files, voice notes or buttons, so a question that needs an answer goes out as words with "reply y for yes, a for yes always, or n for no". Google Chat's own bearer-token check is not implemented — Branch checks the verification token the Chat app is given, so put that address somewhere only Google can reach it. Microsoft Teams is an incoming webhook plus an outgoing webhook, **not** a Bot Framework app: one-to-one chats, cards and file sharing are out of reach. Feishu's encrypted event subscriptions are not supported. A WeCom group robot can only be posted to, so Branch can send the morning brief there but cannot be asked anything.

### Matrix

Matrix is not a webhook service, so it gets its own connection: one long request is held open asking what has happened since, and the next goes out when it answers. A dropped connection is retried with a widening wait, and stopping the channel stops the loop.

```json
{ "channels": [{ "type": "matrix", "homeserver": "https://matrix.example.org",
  "userId": "@branch:example.org", "tokenSecret": "MATRIX_ACCESS_TOKEN", "syncSeconds": 30 }] }
```

Save an access token for the assistant's own Matrix account as `MATRIX_ACCESS_TOKEN`. **End-to-end encrypted rooms are not supported**: their messages arrive as `m.room.encrypted` and Branch has no key to read them, so they are counted and the channel's health line says how many have arrived rather than pretending nothing happened. Invite the assistant to an unencrypted room. Whatever is already in a room when Branch connects is not answered, so it does not reply to history after a restart.

### Signal

Signal has no bot API. The only supported way in is a registered account driven by the `signal-cli` program, which **you install yourself** — Branch downloads nothing. Give the full path to it:

```json
{ "channels": [{ "type": "signal", "path": "C:/tools/signal-cli/bin/signal-cli.bat", "account": "+15550000000" }] }
```

If there is no program at that path the channel refuses to start and says so, rather than appearing to work. Messages travel over that program's JSON-RPC mode — one JSON document per line in and out — so this connection makes no network call of its own.

### Messenger and Instagram

Facebook Messenger and Instagram direct messages use the same Meta webhook and send shape WhatsApp does, so they share its code: the same one-off address check, the same `X-Hub-Signature-256` over the exact bytes, and the same Graph API send.

```json
{ "channels": [{ "type": "messenger", "id": "messenger", "pageId": "123456789012345",
  "tokenSecret": "META_PAGE_TOKEN", "verifyTokenSecret": "META_VERIFY_TOKEN", "appSecretSecret": "META_APP_SECRET" }] }
```

Use `"type": "instagram"` for Instagram, with the professional account's id as `pageId`. Point Meta's webhook at `/webhooks/chat/<channel id>/<the word on your Connections card>`; `GET` answers the `hub.challenge` check and `POST` is refused with 401 unless the signature matches.

**Meta must review your app before anybody outside your own team can write to it.** Until that review passes, only people with a role on the app can message the page, which is enough to try it out and not enough to use it. Branch says so in the channel's health line rather than leaving you to discover it.

**X / Twitter direct messages are not built.** The direct-message endpoints need an elevated access tier that is applied for and paid for per project, and there is no shape Branch could ship that would work on a fresh developer account, so shipping a connection that always fails would be worse than not shipping one.

### Sending without being asked

Two tools send on the assistant's own initiative rather than answering somebody. `channels.broadcast` sends one message to several linked chats at once — leave the list empty to reach every chat that has talked to the assistant — and `channels.digest` sends the morning brief as it stands right now to one chat on any connected service. Both go through the same waiting line every reply uses, so quiet hours, splitting and retries apply unchanged: during quiet hours the message is written down and sent when they end. Both are the owner's alone: somebody else using this computer under their own profile is refused, because the chats belong to the owner. Neither is available to a task started from a chat message, so somebody you have paired cannot make the assistant write to everyone else.

### Chat services a plugin brings

A plugin may bring a chat service of its own, the same way it may bring a way of talking to a model. It exports one or more adapters under `plugin.channel.<id>`; each is a factory that is handed what the owner typed, a way to fetch a named secret out of the locker, and a fetch that has already checked the address against your network settings. Registering one only makes it available to connect — a plugin cannot quietly start answering your chats — and switching the plugin off takes its services away again.

## More chat apps

Wave mac3 added the chat services the other assistants reach, each through its own official API or
open protocol, each in its own file under `src/channels/`. They are written in the connections file
like every other channel, with `type` set to the service's name, and everything in
[What every channel shares](#what-every-channel-shares) applies unchanged: pairing codes, the
`allowlist`, "reply when mentioned", the waiting line with its retries and quiet hours, and the
`reply y / a / n` answer to a question. Credentials are named, never written in the file: each
`…Secret` setting names an environment variable or a secret in the **default project's** locker.
Every web request goes through your network settings; the services that use a plain connection
(IRC, XMPP, MQTT, Mumble) have their server checked by name first, as the mail servers are.

**Each one has a switch, and every switch starts off.** Customize → Chat apps → **More chat apps**
lists them with Off, When needed and On (`GET /api/channels/parity`, `POST /api/channels/parity
{"irc": "on"}`):

- **Off** never connects. A reply meant for that chat waits under **Messages still to send**.
- **When needed** holds nothing open. The connection is made when the assistant has something to
  send there, or when the service posts a message to this computer, and let go after fifteen quiet
  minutes. People can reach the assistant through it only while it is open.
- **On** connects when Branch starts and stays connected, as the older channels do.

A change applies at once to a channel that is already connected; adding a channel to the connections
file still needs a restart. The health line says "Switched off" for a service that is off.

The services that are posted to (Microsoft Teams bots, Webex, Synology Chat, Zalo, Flock, Pumble)
use the same address as the other chat services, `/webhooks/chat/<channel id>/<the word on your
Connections card>`, and prove every post in their own way before anything in it is read; a post that
fails is refused, written into the record and slowed down exactly as for the others. While such a
service is switched off its address answers 503 and reads nothing.

<!-- channels-parity:services -->

### IRC (`irc`)

`{"type": "irc", "id": "irc", "server": "irc.libera.chat", "port": 6697, "tls": true, "nick": "branch-bot", "channels": ["#my-team"], "passwordSecret": "IRC_PASSWORD"}`. With `passwordSecret` the nick signs in with SASL PLAIN before it joins anything. A channel line is answered when it starts with the nick (`branch-bot: …`); a private message always is. IRC cannot carry a line break, so a reply goes out one line at a time, at most 400 characters each, spaced so the server does not disconnect the assistant for flooding. `allowlist` holds nicks. A nick taken by somebody else gets an underscore added; a refused password shows as "needs attention".

### Twitch chat (`twitch`)

`{"type": "twitch", "id": "twitch", "login": "mybot", "channels": ["mystreamer"], "tokenSecret": "TWITCH_CHAT_TOKEN"}`. Twitch chat is IRC inside a secure WebSocket (`wss://irc-ws.chat.twitch.tv:443`). Save a user access token with the `chat:read` and `chat:edit` scopes for the bot's own Twitch account. A message is answered when it mentions the bot's login. People are paired and listed by their Twitch user id (`twitch:12345`), which does not change when they rename themselves. Lines are spaced 1.6 seconds apart, inside Twitch's limit for an account that is not a moderator.

### Gotify (`gotify`)

`{"type": "gotify", "id": "phone", "server": "https://push.example.org", "tokenSecret": "GOTIFY_APP_TOKEN", "title": "Branch", "priority": 5}`. Save an application token made in Gotify. Send only: good for `channels.broadcast`, the morning brief and scheduled results; the chat id is ignored.

### iMessage (`imessage`)

`{"type": "imessage", "id": "imessage", "account": "you@icloud.com"}` (Mac only). Branch reads new messages from `~/Library/Messages/chat.db` every few seconds (`pollSeconds`) and answers through the Messages app with `/usr/bin/osascript`. The script is fixed text and the words travel as its arguments, so nothing anyone writes can become a script. Two permissions are needed, both given by you in System Settings → Privacy & Security: **Full Disk Access** for Branch, to read the messages, and **Automation → Messages**, to send; until then the health line names the one missing. One-to-one chats are always answered (after pairing); a group chat is answered when the message contains the first part of `account`. Messages that were already there when Branch started are not answered, and nothing you send yourself is. Only Apple's own service is involved — no relay such as BlueBubbles or a paid iMessage service.

### Microsoft Teams (bot) (`msteams-bot`)

```json
{ "type": "msteams-bot", "id": "teams", "appId": "<Microsoft app id>", "appPasswordSecret": "MSTEAMS_APP_PASSWORD", "tenant": "botframework.com" }
```
Save the Azure Bot's client secret as `MSTEAMS_APP_PASSWORD`, turn on the Teams channel, and set the bot's messaging endpoint to the address shown under Connections. Every post is checked against Microsoft's published signing keys (issuer, audience, time, service address); replies go only to Microsoft's own service hosts (`*.botframework.com`, `*.trafficmanager.net`, `*.botframework.us`, `*.teams.microsoft.com`) unless you list another in `allowServiceHosts`. Single-tenant apps set `tenant` to their tenant id. Handles one-to-one chats, group chats and channels (in a group or channel only when the bot is @mentioned). Text only: no cards, files or proactive messages to a chat nobody has written in since Branch started.

### Webex (`webex`)

```json
{ "type": "webex", "id": "webex", "botTokenSecret": "WEBEX_BOT_TOKEN", "webhookSecret": "WEBEX_WEBHOOK_SECRET" }
```
Make a bot at developer.webex.com and save its token as `WEBEX_BOT_TOKEN`. Create a webhook (resource `messages`, event `created`) pointing at the address shown under Connections, with a secret you choose, and save that secret as `WEBEX_WEBHOOK_SECRET`. Each post is checked with `X-Spark-Signature` (HMAC-SHA1), then the message is fetched with the bot token. Webex only tells a bot about space messages that mention it; replies stay in the thread. Text only.

### Synology Chat (`synology-chat`)

```json
{ "type": "synology-chat", "id": "nas", "tokenSecret": "SYNOLOGY_CHAT_TOKEN", "incomingUrlSecret": "SYNOLOGY_CHAT_INCOMING_URL" }
```
In Synology Chat, Integration, make a Chatbot. Set its outgoing address to the address shown under Connections, save its token as `SYNOLOGY_CHAT_TOKEN`, and save its incoming address (it contains a key) as `SYNOLOGY_CHAT_INCOMING_URL`. One-to-one with the Chatbot only; replies are cut at 2000 characters. The user id in the outgoing post is used to reply; on some DSM versions this differs from the Chat user id, in which case replies fail and Synology's Chatbot settings need checking. Branch never writes the incoming address into an error or log.

### Zalo Official Account (`zalo`)

```json
{ "type": "zalo", "id": "zalo", "appId": "<app id>", "oaSecretKeySecret": "ZALO_OA_SECRET_KEY", "appSecretSecret": "ZALO_APP_SECRET", "accessTokenSecret": "ZALO_OA_ACCESS_TOKEN", "refreshTokenSecret": "ZALO_OA_REFRESH_TOKEN" }
```
Zalo Official Accounts only (personal Zalo has no official API). Link the OA to an app at developers.zalo.me, set the webhook to the address shown under Connections and turn on the `user_send_text` event. Save the OA secret key, the app secret, and an OA access token with its refresh token. Posts are checked with `X-ZEvent-Signature` (`mac=sha256(app id + body + timestamp + OA secret key)`). When the access token expires Branch renews it once with the refresh token, but Zalo replaces the refresh token each time and Branch cannot rewrite saved secrets, so Connections then asks you to save a fresh pair before the next restart. Replies use the customer-service message API, which Zalo only allows within its reply window after the person wrote; text is cut at 2000 characters.

### Flock (`flock`)

```json
{ "type": "flock", "id": "flock", "appId": "<app id>", "appSecretSecret": "FLOCK_APP_SECRET", "botTokenSecret": "FLOCK_BOT_TOKEN", "botUserId": "<bot user id>", "botName": "branch" }
```
Make an app with a bot at dev.flock.com, set its event callback to the address shown under Connections, and save the app secret as `FLOCK_APP_SECRET` and the bot token as `FLOCK_BOT_TOKEN`. Each post's `X-Flock-Event-Token` (HS256 with the app secret) is checked with its expiry. Only `chat.receiveMessage` is answered; in a group, only a message naming `@botName`. Text only.

### Pumble (`pumble`)

```json
{ "type": "pumble", "id": "pumble", "botUserId": "<bot user id>", "signingSecretSecret": "PUMBLE_SIGNING_SECRET", "appKeySecret": "PUMBLE_APP_KEY", "botTokenSecret": "PUMBLE_BOT_TOKEN" }
```
Make a Pumble app with a bot user and the `NEW_MESSAGE` event, set its event address to the address shown under Connections, and save its signing secret, app key and the bot token from its installation. The signing rule (HMAC-SHA256 of `timestamp:body` in `x-pumble-request-signature`) is taken from Pumble's official Node SDK; Pumble's public web docs do not spell it out, and no freshness window is applied because the SDK does not say what unit the timestamp is in (resent copies are dropped instead). Direct messages are always answered; channel messages only when they mention the bot, and the reply goes in the thread.

### Mastodon (`mastodon`)

```json
{ "type": "mastodon", "id": "mastodon", "instance": "https://mastodon.social", "tokenSecret": "MASTODON_ACCESS_TOKEN", "maxCharacters": 500, "pollSeconds": 30, "activation": "mention", "pairing": true, "allowlist": [] }
```

Save an access token (Preferences, Development, New application, read and write scopes) as `MASTODON_ACCESS_TOKEN`. Branch polls the account's mention notifications. A direct mention is a private chat with that person; any other mention is its own group chat (one per status, so a long thread does not share one conversation). Replies start with `@person`, use the same visibility as the mention, answer the status in its thread, and carry an `Idempotency-Key`. Set `maxCharacters` if the server allows more than 500.

### Bluesky (`bluesky`)

```json
{ "type": "bluesky", "id": "bluesky", "handle": "assistant.bsky.social", "appPasswordSecret": "BLUESKY_APP_PASSWORD", "service": "https://bsky.social", "pollSeconds": 10, "activation": "mention", "pairing": true, "allowlist": [] }
```

Make an app password with direct-message access (Settings, Privacy and security, App passwords) and save it as `BLUESKY_APP_PASSWORD`. Direct messages only, through the official chat service (`chat.bsky.convo.*` with the `atproto-proxy` header); posts and mentions are not read. Replies are cut at 1000 characters. The session renews itself when the access token runs out.

### Reddit (`reddit`)

```json
{ "type": "reddit", "id": "reddit", "username": "assistant_bot", "clientId": "the-app-client-id", "clientSecretSecret": "REDDIT_CLIENT_SECRET", "passwordSecret": "REDDIT_PASSWORD", "userAgent": "desktop:branch-agent:1.0 (by /u/assistant_bot)", "pollSeconds": 30, "activation": "mention", "pairing": true, "allowlist": [] }
```

Make a "script" app at reddit.com/prefs/apps on the assistant's account, put its client id in the settings, and save its secret as `REDDIT_CLIENT_SECRET` and the account password as `REDDIT_PASSWORD` (accounts with two-factor sign-in cannot use the password grant). Branch reads the unread inbox: private messages are direct chats, username mentions and comment replies are group chats in their thread. Each answer is a reply to the exact message or comment; answered items are marked read, and items already unread when Branch starts are left unread and unanswered. `userAgent` defaults to a descriptive one naming the account, as Reddit requires.

### Discourse (`discourse`)

```json
{ "type": "discourse", "id": "forum", "forum": "https://forum.example.org", "username": "assistant", "apiKeySecret": "DISCOURSE_API_KEY", "pollSeconds": 30, "activation": "mention", "pairing": true, "allowlist": [] }
```

A forum admin makes an API key for the assistant's user and it is saved as `DISCOURSE_API_KEY`. Branch polls the account's notifications: private messages are direct chats, mentions and replies are group chats in their topic. Answers are new posts in the same topic, replying to the post that asked; notifications are marked read. The forum's own minimum post length and rate limits still apply.

### X (`x-dm`)

```json
{ "type": "x-dm", "id": "x", "tokenSecret": "X_USER_ACCESS_TOKEN", "pollSeconds": 60, "activation": "mention", "pairing": true, "allowlist": [] }
```

Needs your own X developer account and an app on a **paid** X API plan: direct messages are not in the free plan. Save an OAuth 2.0 user access token for the assistant's account (scopes `dm.read dm.write tweet.read users.read`) as `X_USER_ACCESS_TOKEN`. User tokens expire (about two hours unless refreshed); when X refuses it the card says so. Branch polls `GET /2/dm_events` (keep `pollSeconds` at 60 or more for the rate limit) and answers in the same conversation. One-to-one conversations are direct; group conversations are answered only when `@assistant` is named. Posts and mentions on the timeline are not read. The kind is `x-dm` (a one-letter kind cannot be switched on).

### Twist (`twist`)

```json
{ "type": "twist", "id": "twist", "conversations": [123456], "tokenSecret": "TWIST_ACCESS_TOKEN", "pollSeconds": 15, "activation": "mention", "pairing": true, "allowlist": [] }
```

Save an access token for the assistant's Twist account (from a Twist integration) as `TWIST_ACCESS_TOKEN`, and list the conversation ids (from their web addresses) the assistant should read. A conversation of the assistant and one person is direct; a larger one is answered only when the assistant is mentioned. Channel threads and comments are not read.

### Nextcloud Talk (`nextcloud-talk`)

```json
{ "type": "nextcloud-talk", "id": "talk", "server": "https://cloud.example.org", "username": "branch", "rooms": ["abcd1234"] }
```
Save the app password of the `branch` user as `NEXTCLOUD_TALK_APP_PASSWORD` (or name another secret in `passwordSecret`). `rooms` are conversation tokens, the last part of a conversation's link; add the assistant's user to each. One-to-one conversations are always answered; group conversations only when the assistant is mentioned (`@branch`). Branch checks each conversation every `pollSeconds` (default 3) and lets the server hold each check open for `waitSeconds` (default 2). Messages from before Branch started, system notes and the assistant's own messages are never answered. Answers are posted as replies in the same conversation (Talk's limit is far above Branch's 3500 characters per message).

### Text messages (Twilio) (`sms`)

```json
{ "type": "sms", "id": "sms", "accountSid": "AC-your-account-sid", "from": "+15557654321" }
```
Save the Twilio auth token as `TWILIO_AUTH_TOKEN` (or name another secret in `authTokenSecret`). Every text is a one-to-one chat with the sending phone number, which is also who you approve. Branch lists the number's messages every `pollSeconds` (default 5); texts from before it started are left alone. A text is cut at 1600 characters (Twilio's limit); longer answers are sent in parts. A provider that copies Twilio's API can be used with `apiBase`. Twilio charges per text, and US numbers need A2P 10DLC registration before they can send.

### ntfy (`ntfy`)

```json
{ "type": "ntfy", "id": "ntfy", "server": "https://ntfy.sh", "topic": "branch-alerts-x7k2", "listenTopic": "ask-branch-x7k2", "tokenSecret": "NTFY_TOKEN" }
```
Branch publishes to `topic`. With `listenTopic`, whatever is published there reaches the assistant (checked every `pollSeconds`, default 5) and the answer is published back to it, tagged `branch-assistant` so it is never answered. A topic has no users: anyone who can publish to the listen topic is treated as one person, so protect it with an access token (saved as the secret named in `tokenSecret`, sent as a Bearer header) or use your own server with access control. Without `tokenSecret` no token is sent. Messages are cut to 4000 bytes.

### Pushover (`pushover`)

```json
{ "type": "pushover", "id": "pushover", "title": "Branch" }
```
Save the application's API token as `PUSHOVER_APP_TOKEN` and your user key as `PUSHOVER_USER_KEY` (other names via `appTokenSecret` and `userKeySecret`). Send only: nobody can write back, and the chat id is ignored. A notification is at most 1024 characters; longer answers are sent in parts.

### Threema Gateway (`threema`)

```json
{ "type": "threema", "id": "threema", "gatewayId": "*BRANCH1" }
```
Save the Gateway ID's secret as `THREEMA_GATEWAY_SECRET` (or name another in `gatewaySecret`). Basic mode only, send only: the chat id is the recipient, a Threema ID (8 letters and digits), a phone number with its leading `+`, or an email address linked to Threema. Text is cut to 3500 bytes. Each message uses a Gateway credit (a paid service). End-to-end mode and receiving are not built.

### Home Assistant (`homeassistant`)

```json
{ "type": "homeassistant", "id": "home", "url": "http://homeassistant.local:8123", "service": "mobile_app_your_phone" }
```
Save a long-lived access token (your Home Assistant profile, Security) as `HOMEASSISTANT_TOKEN` (or name another in `tokenSecret`). Send only: Branch calls `notify.<service>`. A chat id made only of lower-case letters, digits and underscores picks that notify service instead; anything else uses `service` (default `notify`).

### XMPP (Jabber) (`xmpp`)

**XMPP (Jabber)** — `receives: socket`.

```json
{ "type": "xmpp", "id": "jabber", "jid": "assistant@example.org",
  "rooms": [{ "room": "team@conference.example.org", "nick": "branch" }] }
```

Save the account password as `XMPP_PASSWORD` (or name another secret with `passwordSecret`). Optional: `server` (when it differs from the address's domain), `port`, `security` (`direct`, TLS from the first byte on port 5223, the default; or `starttls` on port 5222), `resource`. The password is only ever sent inside TLS: a server that offers no encryption is refused. One-to-one messages are always answered; in a room the assistant answers only when its nick is named, and ignores the room's history and its own echoes. Only SASL PLAIN sign-in (inside TLS) is supported; servers that allow only SCRAM or certificate sign-in are not.

### MQTT (`mqtt`)

**MQTT** — `receives: socket` (MQTT 3.1.1).

```json
{ "type": "mqtt", "id": "home", "host": "broker.example.org", "clientId": "branch",
  "username": "assistant", "inboundTopic": "branch/in/#", "replyTopic": "branch/out/{chat}" }
```

Save the broker password as `MQTT_PASSWORD` if `username` is set (or name another secret with `passwordSecret`). Optional: `port` (8883 with TLS, 1883 without), `tls` (default true), `qos` (0 or 1, default 1), `keepAliveSeconds`, `plainTextSender`. Messages on `inboundTopic` are JSON `{"from": "…", "chat": "…", "text": "…"}`; without `chat` (or with `chat` equal to `from`) it is a one-to-one message, otherwise a shared chat where the assistant answers only when the text contains `@<clientId>`. With `plainTextSender`, a payload that is not that JSON is read as plain words from that one sender. Replies go to `replyTopic` with `{chat}` replaced (a chat name containing `+`, `#` or NUL is refused) as `{"from": <clientId>, "chat", "text"}`; messages from `<clientId>` and retained messages are never answered. MQTT itself does not prove who sent a message: anybody allowed to publish on the inbound topic can claim any `from`, so restrict publishing on the broker.

### Keybase (`keybase`)

**Keybase** — `receives: program`.

```json
{ "type": "keybase", "id": "keybase", "path": "/usr/local/bin/keybase" }
```

No secret: install Keybase and sign in with the assistant's own account on this computer. Branch runs `keybase whoami`, `keybase chat api-listen` and `keybase chat api -m <json>` with argument lists; it refuses to start if nothing is at `path`. One-to-one conversations are always answered; team channels and group conversations only when the assistant is @mentioned. The assistant's own messages are ignored. The sender is the Keybase user id.

### SimpleX Chat (`simplex`)

**SimpleX Chat** — `receives: socket`.

```json
{ "type": "simplex", "id": "simplex", "address": "ws://127.0.0.1:5225" }
```

No secret: run `simplex-chat -p 5225` yourself with a profile for the assistant, and accept contact requests there. Its API has no password, so Branch only connects to this computer unless `allowRemote` is true. Optional: `displayName` (otherwise asked from the program). One-to-one chats are always answered; in groups only when the assistant is mentioned. Replies use `/_send @<contact number>` or `#<group number>` with the words as JSON. The sender is `contact:<number>` or `member:<member id>`. Files and voice notes are not handled.

### Delta Chat (`deltachat`)

**Delta Chat** — `receives: program`.

```json
{ "type": "deltachat", "id": "deltachat", "path": "/usr/local/bin/deltachat-rpc-server",
  "accountsPath": "/Users/me/.branch-deltachat" }
```

No secret in Branch: set up the assistant's account (for example on a chatmail server) in `deltachat-rpc-server` or the Delta Chat app first; Branch says so if no configured account exists. Optional: `accountsPath` (DC_ACCOUNTS_PATH), `accountId` (default: the first account). Branch refuses to start if nothing is at `path`. One-to-one chats are always answered; groups only when `@<display name>` or `@<address local part>` appears. Messages sent before Branch started, info messages, the device chat and the account's own messages are ignored. The sender is their email address. Messages are end-to-end encrypted by Delta Chat itself.

### Nostr (`nostr`)

**Nostr** — `receives: socket` (NIP-01 relays, NIP-04 direct messages).

```json
{ "type": "nostr", "id": "nostr", "relays": ["wss://relay.damus.io", "wss://nos.lol"] }
```

Save the assistant's private key (64 hex characters or `nsec1…`) as `NOSTR_PRIVATE_KEY` (or name another secret with `privateKeySecret`). Only kind-4 direct messages sent after Branch started are read; every event's id and BIP-340 signature is checked, and the same event from several relays is handled once. Replies are NIP-04 encrypted, signed and published to every relay. The sender (and allowlist entry) is the person's 64-character hex public key. NIP-04 hides the words but not who is talking to whom or when; NIP-17 / NIP-44 private messages are not supported yet. Public notes and mentions are not read.

### VK (`vk`)

```json
{ "type": "vk", "id": "vk", "groupId": 123456789, "tokenSecret": "VK_GROUP_TOKEN" }
```
Save a community access token with the *messages* right as `VK_GROUP_TOKEN`. In the community's settings, turn on the Long Poll API (version 5.199) and the *incoming message* event, and allow the community to receive messages. Private messages to the community are always answered; in a group chat the community must be mentioned (`@club123456789`). The token only ever travels in the form body. The long-poll address VK hands back carries a session key, so it is never written in an error, and only VK's own servers (vk.com, vk.ru) are followed. Replies are cut at 3500 characters. Uses long polling, so nothing needs to reach this computer.

### QQ (official bot) (`qq-bot`)

```json
{ "type": "qq-bot", "id": "qq", "appId": "102000000", "clientSecretSecret": "QQ_BOT_CLIENT_SECRET", "sandbox": false }
```
Register a bot on the QQ open platform (q.qq.com) and save its client secret (AppSecret) as `QQ_BOT_CLIENT_SECRET`. Branch buys a short-lived access token with it, opens QQ's gateway socket, and answers private (C2C) chats, @mentions in groups, @mentions in guild channels and guild direct messages. This is the official bot API only; personal-account protocols (OneBot, NapCat and the like) are not supported because they break QQ's terms. QQ only allows *passive* replies (to a message just received, within a few minutes), so the assistant cannot start a conversation or send long-running results much later. Public bots are reviewed by Tencent before strangers can reach them; `sandbox: true` uses the sandbox API while testing. Only gateway addresses on qq.com are followed.

### Guilded (`guilded`)

```json
{ "type": "guilded", "id": "guilded", "tokenSecret": "GUILDED_BOT_TOKEN" }
```
Create a bot in your Guilded server's settings (Bots), generate an API token and save it as `GUILDED_BOT_TOKEN`. Guilded bots only see server channels, so the assistant answers when it is @mentioned there; there are no direct messages for bots. After a dropped connection Guilded replays what was missed. Replies are cut at 3500 characters (Guilded allows 4000). Limitation: Branch's socket client answers Guilded's pings but does not send its own, so a silently dead connection is only noticed when it closes.

### Revolt (`revolt`)

```json
{ "type": "revolt", "id": "revolt", "tokenSecret": "REVOLT_BOT_TOKEN" }
```
Create a bot in Revolt's settings (My Bots), invite it to your server and save its token as `REVOLT_BOT_TOKEN`. Direct messages are always answered; in server channels and groups the bot must be @mentioned. A self-hosted instance sets `apiBase` and `socketBase`. The token is sent inside the socket's Authenticate message and in the `x-bot-token` header, never in an address. Replies are cut at 2000 characters, Revolt's limit.

### Mumble (`mumble`)

```json
{ "type": "mumble", "id": "mumble", "server": "voice.example.org", "port": 64738, "username": "branch", "channel": "Lobby", "passwordSecret": "MUMBLE_PASSWORD", "certificateFingerprint": "AB:CD:..." }
```
Branch joins as an ordinary (text-only) user. A private message to it is always answered; in a channel it answers when its username is in the message. Save the server password, if there is one, as the named secret. The server certificate is checked: a server with a certificate from a public authority needs nothing more; for a self-signed server, save its SHA-256 fingerprint as `certificateFingerprint` (pinning, recommended) or set `allowSelfSigned: true`. Voice is not supported. People with a registered account or a client certificate are recognised by it; guests are only known by name, so approve guests with care. Replies are cut at 3500 characters and sent as escaped HTML.

<!-- channels-parity:services-end -->

**macOS and Linux.** Every service here works the same on Windows, macOS and Linux except iMessage,
which exists only on a Mac and is refused by name anywhere else. The programs some services speak
through (`keybase`, `simplex-chat`, `deltachat-rpc-server`, `signal-cli`) are looked for at the path
you give and never installed; their tests, like iMessage's, use stand-ins, so nothing real is run.

### Parity with other assistants

Every chat or notification service found in OpenClaw (`extensions/`), PicoClaw (`pkg/channels/`),
nanobot (`nanobot/channels/`), OpenFang (`crates/openfang-channels/src/`), ZeroClaw
(`crates/zeroclaw-channels/src/`), Hermes Agent (`gateway/platforms/`, `plugins/platforms/`),
Agent Zero (`plugins/`) and IronClaw (`registry/channels/`, `FEATURE_PARITY.md`), as of their
September 2026 sources. **Had it** means Branch already carried it before wave mac3; **built now**
means this wave added it (behind its switch, off); **not built** gives the reason.

| Service | Found in | Branch |
| --- | --- | --- |
| Telegram (Bot API) | all eight | had it (`telegram`) |
| Discord | OpenClaw, PicoClaw, nanobot, OpenFang, ZeroClaw, Hermes, IronClaw | had it (`discord`) |
| Slack | OpenClaw, PicoClaw, nanobot, OpenFang, ZeroClaw, Hermes, IronClaw | had it (`slack`) |
| WhatsApp Business (Cloud API) | OpenClaw, PicoClaw, nanobot, OpenFang, ZeroClaw, Hermes, IronClaw | had it (`whatsapp`) |
| Email (IMAP/SMTP) | OpenClaw, nanobot, OpenFang, ZeroClaw, Hermes, Agent Zero | had it (`email`) |
| Signal (signal-cli) | OpenClaw, nanobot, OpenFang, ZeroClaw, Hermes | had it (`signal`) |
| Matrix | OpenClaw, PicoClaw, nanobot, OpenFang, ZeroClaw, Hermes | had it (`matrix`); end-to-end encrypted rooms are not read |
| Messenger | OpenFang | had it (`messenger`) |
| Instagram (Graph API messaging) | — | had it (`instagram`) |
| Mattermost | OpenClaw, nanobot, OpenFang, ZeroClaw, Hermes | had it (`chat` / `mattermost`) |
| Rocket.Chat | OpenFang | had it (`chat` / `rocketchat`) |
| Google Chat | OpenClaw, OpenFang, Hermes | had it (`chat` / `googlechat`) |
| Microsoft Teams, incoming/outgoing webhook | PicoClaw (`teams_webhook`), OpenFang | had it (`chat` / `msteams`) |
| Zulip | OpenFang | had it (`chat` / `zulip`) |
| Feishu / Lark | OpenClaw, PicoClaw, nanobot, OpenFang, ZeroClaw (`lark`), Hermes, IronClaw | had it (`chat` / `feishu`); the long-connection mode is not built, events come by web address |
| DingTalk | PicoClaw, nanobot, OpenFang (incl. stream mode), ZeroClaw, Hermes | had it (`chat` / `dingtalk`); stream mode not built, events come by web address |
| WeCom | PicoClaw, nanobot, OpenFang, ZeroClaw (incl. `wecom_ws`), Hermes, IronClaw | had it (`chat` / `wecom`), group robot, send only |
| LINE | OpenClaw, PicoClaw, OpenFang, ZeroClaw, Hermes | had it (`chat` / `line`) |
| Viber | OpenFang | had it (`chat` / `viber`) |
| Generic webhook, WebSocket, HTTP API, A2A, ACP | all | had it (triggers, webhooks, the Branch API, A2A and ACP) — not chat services |
| IRC | OpenClaw, PicoClaw, OpenFang, ZeroClaw, Hermes | built now (`irc`) |
| Twitch chat | OpenClaw, OpenFang, ZeroClaw | built now (`twitch`) |
| iMessage (Messages on your own Mac) | OpenClaw, ZeroClaw | built now (`imessage`), Mac only |
| Microsoft Teams bot (Bot Framework) | OpenClaw, nanobot, OpenFang, Hermes (`teams`, `msgraph_webhook`) | built now (`msteams-bot`) |
| Webex | OpenFang | built now (`webex`) |
| Synology Chat | OpenClaw | built now (`synology-chat`) |
| Zalo Official Account | OpenClaw (`zalo`) | built now (`zalo`) |
| Flock | OpenFang | built now (`flock`) |
| Pumble | OpenFang | built now (`pumble`) |
| Mastodon | OpenFang | built now (`mastodon`) |
| Bluesky (direct messages) | OpenFang, ZeroClaw | built now (`bluesky`) |
| Reddit | OpenFang, ZeroClaw | built now (`reddit`) |
| Discourse | OpenFang | built now (`discourse`) |
| X (direct messages, API v2) | ZeroClaw (`twitter`) | built now (`x-dm`); X sells this API as a paid plan |
| Twist | OpenFang | built now (`twist`) |
| Nextcloud Talk | OpenClaw, OpenFang, ZeroClaw | built now (`nextcloud-talk`) |
| SMS (Twilio and compatible) | OpenClaw, Hermes | built now (`sms`) |
| ntfy | OpenFang, Hermes | built now (`ntfy`) |
| Gotify | OpenFang | built now (`gotify`), send only |
| Pushover | — | built now (`pushover`), send only |
| Threema Gateway | OpenFang | built now (`threema`), Basic mode, send only; end-to-end mode and receiving not built: they need NaCl (XSalsa20-Poly1305), which Node does not ship |
| Home Assistant notifications | Hermes | built now (`homeassistant`), send only |
| XMPP | OpenFang | built now (`xmpp`) |
| MQTT | PicoClaw, OpenFang | built now (`mqtt`) |
| Keybase | OpenFang | built now (`keybase`), through your installed `keybase` |
| SimpleX Chat | Hermes | built now (`simplex`), through your own `simplex-chat` |
| Delta Chat | PicoClaw | built now (`deltachat`), through your installed `deltachat-rpc-server` |
| Nostr (NIP-04 direct messages) | OpenClaw, OpenFang, ZeroClaw | built now (`nostr`) |
| VK (community bots) | PicoClaw | built now (`vk`) |
| QQ official bot API | PicoClaw, nanobot, ZeroClaw, Hermes (`qqbot`) | built now (`qq-bot`) |
| Guilded | OpenFang | built now (`guilded`) |
| Revolt (Stoat) | OpenFang | built now (`revolt`) |
| Mumble text chat | OpenFang | built now (`mumble`); voice is ignored |
| AMQP (RabbitMQ and others) | ZeroClaw | not built: AMQP 0-9-1 is a large binary protocol that would need a client of its own; most brokers also speak MQTT, which is built |
| LinkedIn messaging | OpenFang | not built: LinkedIn's messaging API is open only to approved partners |
| Tlon / Urbit | OpenClaw | not built: the chat runs inside an Urbit ship through agents whose interface changes between releases; there is no stable public bot API to write against |
| Buzz | OpenClaw, Hermes | not built: rooms are reached through Block's own `buzz` program on a Nostr relay with its own sign-in; plain Nostr direct messages are built |
| Mochat | nanobot | not built: no public API documentation could be found for it |
| ClickClack | OpenClaw | not built: no public API documentation could be found for it |
| Yuanbao (Tencent) | Hermes | not built: no public bot API documentation; the reference speaks a private protocol |
| BlueBubbles, Photon, Linq (iMessage relays) | Hermes, OpenClaw, ZeroClaw | not built: third-party relays for iMessage; Branch drives Messages on your own Mac instead |
| WhatsApp personal account (WhatsApp Web emulation, Baileys, whatsmeow) | OpenClaw, PicoClaw (`whatsapp_native`), nanobot, ZeroClaw (`whatsapp_web`), Agent Zero | not built: emulates the WhatsApp Web client, which WhatsApp's terms forbid; the official Business API is built |
| Personal WeChat (iLink, web protocols) | OpenClaw, PicoClaw, nanobot, ZeroClaw, Hermes, IronClaw | not built: signs a personal WeChat account in by QR code rather than through an official bot API; WeCom is built |
| Personal QQ (OneBot, NapCat) | PicoClaw (`onebot`), nanobot (`napcat`) | not built: drives a personal QQ account through an unofficial client; the official QQ bot API is built |
| Personal Zalo (zca-js) | OpenClaw (`zalouser`) | not built: drives a personal Zalo account through an unofficial client; Zalo Official Account is built |
| Instagram private API | — | not built: unofficial and against Instagram's terms; Instagram messaging through Meta's Graph API is built |
| Snapchat | — | not built: there is no official messaging API |
| Telegram userbot (MTProto as a person) | IronClaw uses MTProto for its bot | not built: Branch uses the official Bot API |
| Voice calls and meetings (Twilio/Telnyx voice, ClawdTalk, Google Meet, Zoom, Teams meetings) | OpenClaw, ZeroClaw | not built here: these are phone calls and meetings, not chat; Branch's voice lives under Settings, Voice |
| Their own devices and bridges (PicoClaw `pico`, MaixCam, OpenClaw Raft and Reef, QA channel, device pairing, visitor access) | PicoClaw, OpenClaw | not applicable: parts of those projects rather than chat services; Branch has its own phone pairing and A2A |
| Notion, Gmail push, file-drop and git "channels" | ZeroClaw | not applicable: not chat services; Branch has documents, email and triggers for these |

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

**macOS and Linux.** "The voice that comes with your computer" keeps its saved name (`windows`) but means the system voice wherever Branch runs. On a Mac that is `say`, started with a list of arguments, the words read from a file (`-f`) and the sound written to a WAV file (`--file-format=WAVE --data-format=LEI16@22050 -o …`); the voice list comes from `say -v ?`. On Linux it is `espeak-ng` (`-w <file> -s <words a minute> -f <file>`, voices from `espeak-ng --voices`) when it is installed. `spd-say` can only speak through the loudspeaker and cannot make a sound file, so a computer that has only `spd-say` is told to install `espeak-ng`; with neither, reading aloud says "there is no system voice on this computer" and the voice list is empty. A voice name that starts with a dash is refused. These flags follow each program's own documentation; the tests use stand-ins, so no sound is ever played. Off Windows the Voice screen calls it "your computer's own voice" (Windows keeps "the voice that comes with Windows"), and the voice list shows the computer's own voices above the browser's. `GET /api/voice/voices` answers `{ windows, system, platform, label, microphoneHelp }`, where `system` is the same list as `windows` under a name that fits every computer; the list is only asked for when you open it, never when the page loads. `GET /api/voice/plan` carries `systemVoice: { platform, label, microphoneHelp }`, which starts no program. The computer's own voice has its own switch, `systemVoice` in the voice settings: `off` (the default, on every computer: reading aloud with it refuses in one sentence and its voice list stays empty without asking the computer), `when-needed`, or `on` (the `voice.say` tool also travels with every task). Its card, "Your computer's own voice", has the home `settings:voice`. `POST /api/voice/settings` now merges what it is sent onto what is saved, so a form that sends some fields leaves the rest alone.

### Other speech services and spoken commands (bucket 17)

Speech is pluggable. **Settings → Voice → Other speech services** picks a service for writing speech out and one for reading replies aloud, instead of the usual choices above: **Deepgram** (both), **ElevenLabs** (both), **Azure speech** (both; give the region as `azureRegion`, for example `westeurope`, and writing out takes WAV only), or **a program on this computer** that reads aloud, such as Piper (name it by its full place and give its arguments one per line as `programArgs`, at most 20, with `{text}` for the file holding the words and `{out}` for the WAV file it must write; the words never travel as an argument). Each service's key stays in **Secrets** (the default project); the card only names the secret (`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `AZURE_SPEECH_KEY` by default), and it is taken out at the moment of the call. The switch ships **off**, and while it is off, or while no service is picked, the usual routes do the work exactly as before. "Keep audio on this computer" refuses every cloud service in plain words; only the program on this computer still works. No price is on file for these services, so none is shown. Other code can add its own engine or spoken command through `SpeechRegistry.register` / `addIntent` (`src/speech-engines.ts`).

**Spoken commands.** While the switch is on, saying only "stop", "say that again", "slower" or "faster" (or "arrête", "répète", "plus lentement", "plus vite") into **Talk** is taken as a command rather than sent as a message: it stops reading aloud, reads the last answer again, or changes the speaking speed by a quarter. A longer sentence is always an ordinary message. There is still no wake word. API: `GET|POST /api/voice/engines`, `POST /api/voice/command`, and `POST /api/voice/transcribe` now answers with `command` (null when the phrase is not one, or while the switch is off).

**macOS and Linux.** The cloud services are the same everywhere. For a voice that never leaves the computer beyond `say` and `espeak-ng`, install Piper yourself and name it here.

### Live conversation (wave 8)

A **live conversation** is the other way of talking to Branch: instead of holding a button, recording, and waiting, you press **Talk live** once and then simply talk. Your voice goes up while you are still saying it, the answer comes back while it is still being said, and pressing the button again cuts it off mid-sentence the way you would interrupt a person. There is still no wake word: nothing listens until you press the button, and pressing it again ends the conversation.

**What is sent.** While a live conversation is open, the sound of your microphone goes to the model service you are connected to, continuously, and its answer comes back as sound. Both sides are also written out in words, and those words go into the conversation on screen as ordinary messages, so afterwards you can read what was said. **The sound itself is not kept anywhere** — not in the database, not in a file, and there is no setting that changes that. It is sent, played and forgotten. The one setting near it, *Note in the task's record how much sound a live conversation carried*, writes down the size of each piece of sound and nothing else, so you can see how much went back and forth; switch it on only if you want that detail.

**You need a connection that offers it.** Only OpenAI and Google Gemini offer this today, and only those two lines of the connections table are marked *live conversation*. On any other connection the **Talk live** button does not appear at all, and the Voice screen says so in a sentence. Hold-to-talk still works on everything.

**"Keep sound on this computer" refuses it outright.** A live conversation is sound leaving this computer by definition, so with that setting on Branch will not start one, and says why. There is no way round it: the refusal is in the service, before anything is opened.

**How to interrupt.** Press **Talk live** again while it is talking. The sound stops instantly on your side, the answer is cancelled at the service, whatever it had heard of you so far is thrown away, and it is listening again. You can also just **type** while it is talking: what you type is sent straight into the same conversation and answered out loud, without waiting for it to finish.

**What it costs.** A live conversation is charged by the minute, and it is more expensive than typing — roughly $0.30 a minute for OpenAI and $0.15 for Gemini on published prices read on 2026-09-16. Branch counts the usage each service reports and writes it into the task's record as it goes. Two limits stop it running away, both in **Settings → Voice**: **how many minutes** one conversation may last (10 by default) and **how much** it may cost ($1.00 by default). When either is reached, Branch says one sentence out loud telling you it is stopping and why, and then stops — it never just goes silent.

**Tools still need your permission.** If the model asks for a tool mid-conversation, it goes through exactly the same approval settings as a tool call in a typed conversation. Something allowed runs; something refused comes back as a refusal; something that needs your yes **does not run** — the question appears on screen as the usual card, and the model is told it is waiting for you and says so out loud. It cannot talk its way past the gate.

**What is written down.** Every connection that stays open is recorded once in *What the assistant was allowed to do* as **A connection that stays open was made to a service outside this computer**, and leaves a span in the trace, naming only the host and the path — never the whole address, because Gemini takes its key in the address.

**Honest limits.** Branch has been tested against local stand-ins speaking OpenAI's and Gemini's documented live message shapes. It has **not** been tested against the real services with real sound; treat "Branch speaks the right language" as what is proved, not "this has been heard working".

Routes: `POST /api/voice/live` (opens a task for a live conversation and answers with whether one is possible); the conversation itself runs on the task's existing socket `/api/runs/<id>/ws`, with your microphone going up as binary frames and the answer coming back as binary frames numbered so they play in order. `GET /api/voice/plan` reports under `live` whether the connection in use can hold one, and the limits it would run under.

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

**macOS and Linux.** `secret://bitwarden/...` and `secret://1password/...` work the same way on a Mac and on Linux: `bw` and `op` are looked for by their bare names on the search path. On a Mac there is one more source, **the Keychain**: `secret://keychain/<name>` names one of the entries you listed (setting `keychain-entries`: `enabled`, off by default, and `entries`, each `{ name, service, account? }`), and Branch runs `/usr/bin/security find-generic-password -s <service> [-a <account>] -w` at the moment the value is needed. Only listed entries can be read, so a tool call cannot go looking through the rest of your Keychain; it waits for the same unlock as the locker, the value is scrubbed like every other, and each read is written into the audit by name only. If the Keychain is locked, or you turn down your Mac's question about the item, Branch says so in one sentence. **Settings → Passwords from your Mac's Keychain** (Mac only, home `settings:secrets`) lists and edits the entries: `GET /api/keychain/settings` returns `{ enabled, mode, entries, timeoutMs, available, references }` and `POST` saves `mode` (off, the default / when-needed / on; reading has no tools of its own, so the last two both read only when a task uses a reference), the older `enabled`, and `entries` through the same checks (names only — the route never asks the Keychain anything, and a field that is not a name is refused). On any other computer a Keychain reference is refused plainly.

### Keys Branch never looked up

The scrubber above only knows the secrets Branch took out of the locker itself. A second check looks for anything **shaped** like a key, wherever it came from: a key a command printed, one sitting in a file, one pasted into a message. It knows the shapes of OpenAI, Anthropic, OpenRouter, AWS, GitHub, Slack, Google and Stripe keys, sign-in tokens, private key blocks, the value after `password:` or `Authorization:`, and a password written into an address (`postgres://me:…@host`). Every tool's answer is checked before the model reads it, and every request is checked before it goes to a model service; a match is replaced with a note such as `[hidden key-like value: OpenAI key]`, and the task's record gets one plain line saying a key-like value was hidden, never the value. Ordinary text is left alone: hashes, commit ids, ids, version numbers and code such as `password: z.string()` pass untouched.

A web address that carries a key or password itself (`?api_key=`, `?token=`, `?password=` and similar names however they are written, `user:pass@` or a bare `token@`) is not fetched until you say yes, even where your rules would allow the website. This holds for the assistant's own calls, saved recipes and workflows, voice, and other AI tools connected to Branch. The yes is for that exact address in that conversation only.

The file tools also refuse more places keys live, as they already refused `.env` and `.ssh`: `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, the `.docker`, `.kube`, `.gnupg`, `.azure` and `.gcloud` folders, the GitHub command line's `gh/hosts.yml`, `.vault-token`, and shell history files (`.bash_history`, `.zsh_history`, `fish_history`, PowerShell's `ConsoleHost_history.txt`). File search skips them too.

**macOS and Linux.** The check is the same on every computer. The refused names cover what those systems keep in your home folder — the `.zsh_history` a Mac's Terminal writes, `.bash_history` on Linux, `~/.config/gh/hosts.yml` — so a workspace that is, or contains, a home folder never hands them to the assistant.

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

**macOS and Linux.** There is no job object there, so the same setting does the nearest thing
those systems allow. Each command starts as the head of its own group of programs, through a fixed
`/bin/sh` line that lowers the processor-time ceiling and then hands over to the program. Your
program and its arguments are passed alongside that line, never written into it. A ceiling already
lower than yours is kept, never raised. When the command finishes or is stopped, everything still
in its group is ended too: first asked to stop, then forced a moment later. This also covers
programs left running (`process.start`), kept-open command lines, and language servers. What the
system holds is written in each result, in `heldBySystem`. `isolation` stays `sampling`, because
that name means a Windows job. Two things are **not** held by the system. **Memory**: the system's
own memory caps count memory a program has only set aside, and at the default 1 GB they stop Node
from starting at all, so memory is checked about once a second instead. That check covers the
largest program in the group. Processor time is also checked as a total across the group. **The
number of programs**: the only system cap counts every program you run, not just this command's.
A program that deliberately leaves its group can outlive the command. On macOS a
`shell` alias is best pointed at `/bin/zsh` (with `-f` to skip your startup files), and on Linux
at your own `$SHELL` or `/bin/bash`. Add `HOME` (and `TMPDIR`, `USER`, `LOGNAME` or `SHELL` if a
tool wants them) to `inheritEnv` so the shell behaves as it does in a terminal. Git and SSH also
pass on `SSH_AUTH_SOCK`, so keys you have already unlocked keep working.

**No internet, best effort.** `"netless": true` in the `shell` settings, or `netless` on a single call, points the command at a dead address on this computer (`http://127.0.0.1:9`) through the usual proxy variables, so curl, git, npm, pip and anything else that respects them fail at once instead of reaching a website. Be clear about what this is: it is **not** a firewall. Blocking a single program properly on Windows needs administrator rights, which a desktop app should not ask for, so a program that ignores proxy settings and opens its own connection is not stopped. Use it to stop an ordinary tool phoning home by accident, not to contain something you do not trust.

The command's environment is built from nothing: only the variables named in `inheritEnv`, then the `env` you set, then the dead-address variables if the command is offline, then the secrets the call asked for. Nothing else from the host — no model keys, no vault variables, no `NODE_OPTIONS` — reaches the program, and the values of those secrets are taken back out of the output before it is recorded.

**The wall around programs (macOS and Linux).** Settings → Computer → *The wall around programs* is a three-way switch that ships **off**. When it is on (or "when needed", for the commands your rules ask about or hold in a box), `shell.execute`, `code.run` and `process.start` start the program behind the system's own sandbox: on macOS `/usr/bin/sandbox-exec` (always that exact file) with a profile that refuses everything by default; on Linux the system's own `bwrap`, which Branch never installs or ships (install the `bubblewrap` package yourself; if your system has switched off unprivileged user namespaces, Branch says so and starts nothing). Behind the wall a program can read the disk but not `~/.ssh`, `~/.aws`, `~/.gnupg`, the keychains, Branch's own data folder or any place you add; it can write only inside the workspace and the temporary folder (on Linux a private, empty one); `.git`, `.branch` and `.agents`, and Branch's own program, gateway settings and updater, stay read-only; and on Linux it cannot trace other programs or reach the desktop session's message bus or Docker. *Anywhere* means internet addresses and the system's name lookup, never a local socket file such as Docker's or the ssh agent's. What it may reach is one of *nothing*, *only reading from sites you allow* (GET and HEAD, no secure tunnels), *sites you allow*, or *anywhere*. With sites you allow, the program is pointed at Branch's own door on this computer (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` as SOCKS5, each carrying a secret made for that one command, without which the door answers nobody), the wall lets it reach nothing else, and a new site pauses the task with "let programs behind the wall reach this site" on the ordinary approval card; your blocked sites still apply, the door never reaches this computer, a private network or a cloud metadata address whatever your rules say, and it connects to the very address it checked. When the wall stops a write and the output names the file, the task asks once whether the next try may write to that one file, named as the system names it; startup places (`~/Library/LaunchAgents`, shell start-up files, `/etc`, `/usr`) are never offered. Every saved key a call asks for reaches a program behind the wall only as a stand-in (`branch_…`). For keys you tie to a site (`GITHUB_TOKEN api.github.com`) Branch swaps the real key in on the way out for that exact site (a key with no site is never sent anywhere), sends the request on over a secure connection, and takes the key and anything key-shaped back out of the answer. A secure tunnel the program opens itself cannot be read, so a stand-in inside one stays a stand-in. A program left running (`process.start`) gets no door: with *sites you allow* or *only reading* it has no network at all. The switch is saved by `GET`/`POST /api/os-sandbox` `{ mode, network, keySites, unreadable }`; the assistant has no tool that changes it, a short-lived key is refused, and every change is written in the record of what the assistant was allowed to do. On Windows the switch changes nothing: the job object and Windows Sandbox work exactly as before. Separately, and whatever the switch says, the voice and media programs (ffmpeg, yt-dlp, the reading-aloud program, the system voice) start with a clean environment: only `PATH`, `HOME`, `USER`, `LANG`/`LC_*`, `TZ`, the temporary-folder variables, the Linux sound-session variables and the variables Windows needs to start a program (`src/child-env.ts`). No model-service key or vault variable reaches them.

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

## The dashboard in the browser

One page, served by Branch itself at `/dashboard`, that shows at a glance what Branch is doing (**Now**:
running or not, the model and connection, the tasks working with a Stop button, what needs you),
whether its parts are healthy (**Health**: model connections and chat apps, automations as working,
failing, never run or paused, the background engine and the last update, memory and disk, the last
week's problems), what it has cost (**Spend**: today and this month by connection and by project,
with the month's forecast; a task on a model with no price on file is counted apart, never as
nothing), and what is happening (**Activity**: each step, filtered, with a way into each task). Its
**Controls** pause every automation, switch Lockdown, restart the engine, and open any Settings
page. It fits a phone at 400 px and spreads to four columns on a wall screen.

The switch is under Customize → Channels (`dashboard.mode` in the `DashboardSettingsSchema`,
`src/dashboard-api.ts`) and ships `off`:

- `off` — the page and its files answer 404 and `GET /api/dashboard` refuses.
- `on` — the page reads `GET /api/dashboard` every ten seconds while it is in view and keeps the
  live updates of `/api/events/stream` open.
- `when-needed` — the page is served but reads everything once, when it opens or Refresh is
  pressed, and keeps nothing open in between.

It sits behind the same key and host rules as the app window, so it is reachable on the paired
address exactly when the app is. A short-lived key made with `branch token create --scope read`
gets a page that only looks; `--scope run` may also press Stop (through `POST /api/runs/{id}/cancel`).
`POST /api/dashboard/automations` with `{ paused }`, `POST /api/dashboard/restart` and
`POST /api/dashboard/settings` with `{ mode }` need the master key. Pausing sets every waiting
schedule to paused and switches every trigger off, and remembers which; starting them again brings
back only those, so anything the owner paused by hand stays paused. Links back into the window use
`/#open=<place:tab>` (any home in `docs/places.md`) and `/#task=<id>`.

**macOS and Linux.** Restart stops the background engine the way Ctrl+C does, with exit code 75, and
the sign-in file starts it again: launchd's `KeepAlive` (`SuccessfulExit` false) on a Mac, systemd's
`Restart=on-failure` on Linux. It is offered only when this copy is the background engine and was
started by that file (`XPC_SERVICE_NAME` is `com.keepoak.branch-agent`, or systemd set
`INVOCATION_ID`); a copy started by hand or running in the app window says how to restart it
instead. On Windows the button explains that Branch is closed from its icon by the clock and opened
again; nothing on Windows changes. Disk use is read with `statfs` on the data folder, which works the
same on all three.

## A conversation that survives a restart

Closing Branch and opening it again does not empty a conversation of what it was carrying. At the end
of every task, the conversation's model choice, how hard it was asked to think, the project it was
under, the toolboxes it had opened for itself (at most three) and the standing yeses given in it are
written down beside it. The first task in that conversation after a restart puts them back and records
a `session.restored` line on itself saying what came back.

Anything that could not be put back is **said plainly instead of papered over**: a model that is no
longer set up names the one being used in its place, a project that has been removed names the one the
conversation is in now, a toolbox nothing offers any more is named, and a standing permission that had
already run out while the app was closed is named as needing to be asked for again. A permission that
is still in date comes back with the moment it was always going to run out, never a fresh hour: a
restart cannot lengthen a permission you gave.

## Long conversations and questions for you

When a conversation's working context passes about 11,000 estimated tokens, Branch asks the model for a short handoff summary of the older turns (facts, decisions, file paths, open tasks, next step), keeps at least the six most recent turns plus everything from the current task, and continues with the summary in place. The run records a `context.compacted` event with sizes before and after; the summary is saved per conversation and reused; the complete transcript stays stored and searchable.

The `user.ask` tool lets the assistant stop when it cannot proceed without you. The task ends with status `needs_input`, an `attention.needed` event, and the question as its output. `/api/state` lists waiting conversations under `attention`; the app shows a banner and a system notification that open that conversation; on a channel the question is sent as the reply. Your next message in that conversation is the answer.

## Reliability

`createBranch({ reliability })` accepts `modelStallMs` (5 s to 10 min, default 60 s: a model call that streams nothing for this long is treated as stalled), `stallRecovery` (`retry` twice then fall back, `fallback`, or `fail`), `toolTimeoutMs` (default 90 s: a single tool call is stopped after this), and `toolResultChars` (default 12,000: longer tool results are clipped for the model; the full result stays in the task's trace). Events: `model.stalled`, `model.stall_recovery`, `tool.stalled`, `tool.result_clipped`, `context.shrunk`.

`POST /api/run` accepts `checks`: `mustMention` (phrases), `mustMatch` (a regular expression), `resultSchema` (the answer must be JSON of that shape), `files` (workspace files that must exist) and `maxRetries` (0 to 2, default 1). A missed check is recorded as `run.check_failed`, the model is told what was missing and tries again; when the allowance is used up the task fails with a plain reason.

A task marked interrupted (the app stopped while it was working) shows **Continue where it stopped**. `POST /api/runs/:id/resume` starts a new run in the same conversation from the saved transcript: no new prompt, nothing replayed, and tool calls whose outcome was never recorded are shown to the model as unknown so it checks before repeating them.

## Stopping repeated steps and trusted folders

Both have a three-way switch in **Settings**, and both ship **off**, which is exactly how Branch behaved before them.

**Stopping repeated steps.** `GET|POST /api/loop-guard { mode }` with `mode` `off`, `on` or `when-needed` (`LoopGuardSettingsSchema`). When on, every task watches its own tool calls. The same tool with exactly the same details a third time gets a warning beside its result (`loopWarning`); a fifth time it is not run and the model is told why. A call that keeps giving back exactly the same result is refused sooner (from the fourth time), and two or three calls going back and forth (read, write, read, write) are warned about after two rounds and refused after three. Tools meant to be asked again while something finishes — a running program's output (`process.read`), a status, a list — get three times the room, judged from the tool's name only. After three refusals the task ends with one sentence starting "Stopped:", and every call the model asked for still has an answer in the conversation, so the next message carries on normally. **When needed** leaves a task alone until it has made eight tool calls (`whenNeededAfterCalls`), except that the very same call with the same details is still warned about the third time and refused the fifth, since a tight loop can start at the second step. Events: `loop.warned`, `loop.blocked`, `loop.stopped`. The limits are fixed in `src/loop-guard.ts`.

**Trusted folders.** `GET /api/folder-trust` gives the switch (`mode`, `FolderTrustSettingsSchema`) and lists the workspace and every project folder with what each holds for AI assistants and whether it is `trusted`, `untrusted` or `unknown`. `POST /api/folder-trust { mode }` changes the switch; `POST /api/folder-trust { folder, decision: "trust" | "distrust" }` answers for a folder written relative to the workspace (`""` is the workspace itself). A decision covers everything inside the folder and the closest one wins. What counts is one list, `assistantFolderItems` in `src/folder-trust.ts`: notes (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `GEMINI.md`, `.hermes.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `HEARTBEAT.md`, `TOOLS.md`, `SOP.md`, up to three folders deep), AI tool server lists (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`), skills, hooks and plugin folders. They are only listed: note files are never opened, and settings files are read for their entry names alone.

Any part of Branch that reads what a folder carries asks `isFolderTrusted(store, owner, path)` (or `runtime.guards.isFolderTrusted(path)`) first; a loader that cannot wait, and has already found a file to read, asks `folderAllows(store, owner, path)`, which gives the same answer without looking at the disk. **Off:** always yes. **On:** only for a folder the owner trusts. **When needed:** for a trusted folder, or for one nobody has decided about that holds nothing on the list. A folder the owner does not trust is always no. With the switch on or when needed, a task whose own folder (the workspace, or the active project's `folder`) is not trusted asks before every change, even with approvals switched off; deny and ask rules are kept and standing yeses are dropped. That fallback follows only the task's own folder: distrusting `vendor/` inside a trusted workspace keeps what `vendor/` holds out without making writes there ask. A folder that needs an answer shows a question on the chat screen, and a task started there writes `folder.trust_needed` once per launch. A short-lived key cannot change either switch or any answer. Every answer and every change of the switch is written to the record as `policy.changed`.

**macOS and Linux.** Both work the same on every system. Folder decisions compare paths with letter case on macOS and Linux and without it on Windows. Note files are listed whatever their letter case, since the usual macOS disk (and Windows) ignores case. A skills or plugin folder that is a link is never looked into.

## Keeping Branch running (never breaks)

The design, the threat list and the test for each threat are in [never-break.md](never-break.md).

**What a task can never touch.** Whatever the rules, a standing yes, a hook, Lockdown or any switch say, a task cannot change the program's own folder (`BRANCH_INSTALL_ROOT`, or the folder `dist/` was loaded from; only `dist/`, `node_modules/`, `package.json`, `resources/` and `app.asar` when the workspace lives inside it), the data folder (only its database, key, gateway and updater files when the workspace lives inside it), or read the database and key files. Every word of a command is checked, `rm`-like commands naming a parent folder are refused, and so are commands that stop, reinstall or update Branch's own service (`src/never-break/protected.ts`). The refusal is written as `policy.denied`. A command that hides a path from plain reading (built at run time, encoded) is not caught by this check; the operating-system sandbox (`settings:computer`) is the layer for that.

**The gateway.** `gateway.json` in the data folder, `GatewayConfigSchema` in `src/never-break/gateway-config.ts`: `mode` (`off`, the default; `when-needed`; `on`), `startSeconds` (90), `holdSeconds` (20), `maxQuickCrashes` (4), `gapSeconds` (300), `watchSeconds` (300) and `workerEnv` (only `BRANCH_*` names, never the data folder). With the mode not off, `branch start` runs the gateway on `BRANCH_PORT`, which runs the engine on a private loopback port and passes requests (and connection upgrades) through, checking the address exactly as the engine does. `GET /gateway/health` is answered by the gateway itself. An engine that stops is started again after 0.5, 1, 2 … 30 seconds; crashes chained less than `gapSeconds` apart, `maxQuickCrashes` times, slow it to once every five minutes and stop interrupted work carrying on by itself. Settings are promoted to `gateway.good.json` after a worker has stayed up; a broken `gateway.json`, or settings the engine fails to start with twice, are replaced by the good copy. `GET|POST /api/never-break { mode }` reads and sets the switch; `POST /api/never-break/proposal/accept|discard` answers a change the assistant suggested with the `gateway.propose` tool (offered only when the switch was on at launch), which is always tried on a throwaway gateway first. A short-lived key can do none of this.

**Work that survives a restart.** Every model turn and tool call is written to `journal.sqlite` in the data folder (`src/never-break/journal.ts`, `synchronous=FULL`) before it runs, with an idempotency key, a side-effect class (`none` for tools with a reading permission; `idempotent` for `files.write`, `files.restore`, `files.mkdir`, `memory.forget`, `todos.done`, `git.branch`; `external` for everything else, MCP and plugin tools included) and, for file and git tools, what the file or the repository looked like just before. A step that cannot be written down is not run: the task stops with a sentence saying the disk may be full. This is not switchable. A task cut off because Branch closed is now marked `interrupted` rather than `cancelled`. On a real start (the app window, the background engine, or an engine under the gateway) with the switch not off, `recoverOnStart` (`src/never-break/resume.ts`) settles every task interrupted in the last day: an in-flight step with no side effects, or an idempotent one, is done again (only if the approval rules allow it without asking); a file or git step is checked (`verified` or done now); anything else is put to the owner as a question and the task waits (`needs_input`, event `attention.needed` with `afterRestart`). Then the task carries on by itself (**on**, event `run.auto_resumed`) or is offered (**when needed**, `run.can_continue`). After a crash loop (`BRANCH_RESUME=ask`, set by the gateway) nothing carries on by itself. A task a chat message started (`channel.inbound`) is left for the chat app (`run.left_for_channel`): Telegram's read position is kept in settings (`channel-position:<id>`) and saved only after a message is handled, so a message a crash cut off is fetched and answered again, and one already answered is not. A repeating timed job cut off by a restart goes back to `pending` for its next turn (`lastInterruption`); a turn missed while Branch was down runs once, with `late` in its history and a `schedule.caught_up` event. Other chat apps keep their own delivery rules (webhook services resend by themselves; Discord, Slack and Matrix do not replay missed messages yet).

**Data formats.** The database carries a format stamp (`PRAGMA user_version` and a `branch_format` row with the oldest format that can still read it; `src/never-break/migrations.ts`). A version that finds data it cannot read stops with a sentence and changes nothing. Format changes are listed in `storeMigrations`, run in one transaction after a `VACUUM INTO` copy in `update-backups/`, and each has a way back (`migrateDown`); a change that only adds a column keeps `readableBy` at the old number, so the previous release still opens the data.

**Updates that cannot brick it.** With the switch not off, the updater tries the unpacked version before anything is swapped (`src/never-break/canary.ts`): the process that holds the database takes a copy (`VACUUM INTO` of `branch.sqlite` and `journal.sqlite`, plus `locker.key` and `gateway.json`) into `updates/canary-*/` in the data folder — the window asks a background engine for it with `POST /api/never-break/snapshot` — and the new version's own runtime runs `branch start` with `BRANCH_SELF_TEST=<report>` on that copy (`src/never-break/self-test.ts`): it opens the saved work (applying its format changes to the copy), does a task with the offline model, loads every chat adapter, lets the timed jobs tick, carries an interrupted task on, and answers on its address. Any failed check stops the update with a sentence saying which, before the safety copy or the hand-over; the copy is always removed. A passed check writes `update-watch.json`; the new gateway watches the first `watchSeconds`, repairs a program folder an interrupted swap left half-done (`repairSwap`), ends the watch once the version has stayed up, and, if the new engine fails to start twice or trips the crash breaker inside the window, writes `updates/roll-back.sh` (or `roll-back.cmd`, started through the same hidden scheduled-task launcher as the update, so no console window opens) and closes: the script puts `<program>.previous` back, keeps the failed one as `<program>.failed`, promotes `<program>.previous-2`, and starts the previous version. Every update now keeps the last two versions (`.previous` and `.previous-2`) on all three systems. The gateway and its engine each state the contract version they speak and the range they read (`src/never-break/contract.ts`), so a new engine runs under an old gateway and the other way round for one release.

**Telegram from a card.** `customize:channels` has a **Set up Telegram** card (`public/telegram-setup.js`, `src/never-break/telegram-setup.ts`): the BotFather steps in plain words, a password field whose token goes straight into the locker as `TELEGRAM_BOT_TOKEN` in the default project (checked for BotFather's shape, never sent back), the three-way switch (settings key `telegram-setup`, shipped off), and a box for the six-digit code the bot sends a new person, which approves the owner's own account through the ordinary pairing. `GET|POST /api/never-break/telegram { mode?, token? }`. On a real start with the switch not off, Branch connects that bot through the network rules, unless the integrations file already has a Telegram channel. No real token was used to build or test it.

**macOS and Linux.** The gateway is the same program on every system. It starts the engine with the same runtime it runs on (the app's own on an installed copy), with no window on Windows. The sign-in entries (`launchd`, `systemd --user`, the Windows scheduled task) are unchanged: they run `branch start`, which becomes the gateway when the switch is on, so `KeepAlive`/`Restart=on-failure` look after the gateway and the gateway looks after the engine. An engine whose gateway is killed closes itself within seconds, so the database is never left held.
**Tools run by hand or by a workflow (mac5/manual-actions).** A tool run outside a conversation goes through one gate, `src/tool-gate.ts`, called from `Runtime.executeTool`. Pressed by the owner in the app window (`POST /api/action`, the code editor's save, "Try a tool"), it obeys Branch's own files (above), a refusing rule, the role of a profile that is switched on, and the sandbox and OS wall the matching rule and `settings:computer` give a task's call; with Lockdown on, or in a folder marked untrusted while folder trust is on, anything that changes something is refused with a sentence saying why (looking still works). An "ask first" rule does not stop it, because the owner is the one asking ("Try a tool" still puts its question once). A saved workflow's tool step, a flow box, a live voice call and the pull-request hook working after a task are held to the full rules like a task (`mode: "policy"`): "ask" stops them for the owner's yes, kept under the workflow's own name. Another AI tool over MCP, a saved procedure's steps and a step redone after a restart use the same policy check and wall. Windows behaves as before apart from these refusals; the wall there stays the job object.

## Always allow, per command, and a second look before approvals (wave mac3)

**Always allow, per command.** "Yes, always" (and "No, always") to a command is remembered for that
one action of the program, not for the exact words and not for the whole program: a yes to
`git status` covers `git status --short`, and `git push` is still asked
about; `npm run dev` stays separate from `npm install`. How many words name the action comes from
OpenCode's table (`src/command-prefix.ts`): `git` takes two, `npm run` three, `ls` one. The rule is
written as `{ match: "*", resource: { kind: "command", pattern: "git status" } }`; for a program on
another computer the computer stays in `match` (`"tower: *"`). A command is remembered word for word,
exactly as before, when it is not a plain list of words (`;`, `&`, `|`, `<`, `>`, `$`, a backtick or a
bracket), when the table does not know the program, when a flag or quote sits where the action should
be, and when it is a one-word action that can change something (`rm`, `mv`, `chmod`, `env`,
`source`). A joined command (`git status && rm -rf ~`) is covered by an allow rule only word for word,
and by an ask or deny rule when any piece of it is, so joining commands can never get past a rule. A
command sent to a kept-open command line (`shell.session.run`) is judged by the command it sends.

**A second look before approvals.** `GET|POST /api/approval-reviewer { mode, preset, rules, maxTokens }`
(`ReviewerSettingsSchema`, Settings → Permissions → A second look before approvals). It ships **off**.
Another model reads a tool call before the approval card and answers two things: whether the call
only reads, and — against the owner's own rules in plain English (`rules`; empty uses
`stockReviewRules`) — whether it is fine, should be asked about, or should be refused. The call is
given to it as untrusted data after a marker, with saved passwords and anything that looks like a key hidden (the leak guard). While it is off the
saved setting is read once and kept, so a call costs nothing extra.
*Only reads* is used only for tools that do not say what they do (another AI tool's tools) and only in
tasks the owner started, and never for a tool whose name says it changes something (`delete`, `send`,
`write`…); it can only turn a question into a yes (Ask before changes), never a refusal (Read only, or a
deny rule) and never a rule for everything. *Fine / ask / refuse*
can only make the answer stricter: "ask" turns a yes into a question, and "refuse" turns the call into
a question carrying the reason that the owner may allow **only this once** ("Yes, just now";
`onceOnly: true` on the waiting question). A longer-lasting yes to it is refused with a 400, and
nothing is written into the rules. The one-time pass is spent on the next identical request in that
conversation (`policy.overruled`). **When needed** looks at tools that do not say what they do and at
commands no rule decides about; **On** also looks at every call that would wait for a yes, and at every
command and unknown tool the rules let through. A yes the owner already gave for that very request is
never looked at again. `preset` picks the connection (empty: the one answering); each look has its
own budget (`maxTokens`) and 30 seconds. If it fails, times out or answers in a shape that cannot be
read, the rules decide exactly as they would with it off, and `policy.review_failed` says why; a look
that answered writes `policy.reviewed`. Practice runs are never looked at. A short-lived key cannot
change these settings.

**What a remembered yes never covers** (integration review). A program named with a folder (`./git`,
`/tmp/git`, `C:\Temp\git`) is not the program a yes was given to: an allow covers it only when the rule
names that folder too, and a refusal or question naming the bare program still reaches it. A flag that
makes the action run or load something else (`git grep -O…`, `git fetch --upload-pack=…`,
`npm run dev --script-shell=…`, `npm exec x --package=…`, `make build SHELL=…`) is covered only word for
word. Line and page breaks other than a newline, no-break spaces and invisible characters count as shell
syntax. A refusal or question also looks past quotes, backslashes, `VAR=value` and wrapper programs
(`sudo`, `env`, `xargs`, `sh -c`, `find -exec`, `npx`). A command is judged whole from its arguments, not
from its 300-character target. A remembered command with a `*` in it is kept as an exact rule
(`resource.exact: true`), so `rm -rf *` never covers `rm -rf /`, and an allow that names a command only
through `match` (`"npm *"`) covers plain commands only. A `*` in any rule now also fits a line break.

**macOS and Linux.** Both work the same on every system. A program's folder is read whether it is
written with `/` or `\`.

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

## Measuring the assistant

There are three different things here, and they are easy to mix up.

A **suite** is a handful of your own tasks with the right answers written down. It is how you tell
whether a change made the assistant better or worse at the work you actually do. Suites are the
section above.

A **benchmark** is somebody else's published set of tasks, used so a number here can be put beside a
number in a paper. Branch Agent never downloads one. You download the dataset yourself, put it in a
folder, and point at that folder; the program only reads files that are already on this computer.

A **study** is a written-down experiment: a benchmark or suite, a subset of its tasks, the model
choices to try, how many repeats, and what it may cost. Running a study works through every
combination several at a time and writes each result down as it lands, so a study you stop — or one
that stops itself when the power goes — carries on from where it was rather than starting again.

### Scorers

A task can be decided by one or more scorers. Every scorer gives a score from 0 to 1, a pass or
fail, and its reasons in plain words; a task passes only when every one of its scorers passes. Put
them on a task in a suite file as `"scorers": [...]`:

`exact` (the answer, once case, spacing and trailing punctuation are taken off), `contains`,
`regex`, `json-schema`, `numeric` (with a tolerance), `url` (a pattern the address must match),
`file-exists` and `file-contains` (inside the workspace), `tool-called` (optionally `withArgs`, so
you can say a tool must have been used with particular arguments), `budget` (`maxSteps`, `maxMs`,
`maxTokens`, `maxDollars` — the rounds, time, tokens and money a task may use), `finished` (did it
actually do the work, or did it say it could not — the completion checks you already use, plus the
phrases an answer uses when it has quietly given up), `f1`, `passage`, `html`, `trajectory`, and
`rubric`.

**`f1`** — how many words the answer and your reference answer have in common, which is how
published question sets mark an answer that is right but worded differently. `{"kind": "f1",
"value": "the Eiffel Tower", "threshold": 0.6}`. Before comparing, both are lower-cased, stripped of
punctuation, and stripped of the three articles "a", "an" and "the"; word order does not count. So
"The Eiffel Tower." and "eiffel tower" score 1, and an answer that gets half the words right scores
about a half. `threshold` is the bar it has to clear, 0.6 unless you say otherwise.

**`passage`** — does the answer *carry* the right piece of a document rather than equal it.
`{"kind": "passage", "passages": ["the deposit is returned within ten working days"], "threshold":
0.8, "verbatim": false}`. The score is the share of the passage's words that are in the answer, so
a sentence with the passage inside it passes. List more than one passage when a question has more
than one right source; the best one wins. Set `verbatim` when the words must also appear back to
back, in the passage's own order.

**`html`** — the page itself rather than a description of it, for a task whose result is a changed
page. `{"kind": "html", "selector": "input#agree", "attribute": "checked"}` says the tick box has to
be ticked. `source` is `"answer"` (the markup is in the answer, the default) or `"file"` with a
`path` inside your workspace. Then: `absent` for "there must be none of these", `count` for exactly
how many, `text` for words the first one must contain, and `attribute` with an optional `value`.

The way an element is named is deliberately small, and that is the whole of it: a tag (`button`),
an id (`#total`), a class (`.row`), an attribute (`[disabled]`), an attribute with a value
(`[type=checkbox]`), any of those stuck together for one element (`input.tick[checked]`), and
spaces between them for "somewhere inside" (`form.order button#send`). Anything else — a comma, a
`>`, `:first-child` — is refused by name rather than half-understood.

**`trajectory`** — the path taken rather than the answer, for a task where guessing the right answer
is still wrong. `{"kind": "trajectory", "steps": [{"name": "files.read"}, {"name": "files.write",
"arguments": {"path": "notes.md"}}], "threshold": 0.6, "ordered": true}`. Only the arguments you
name are checked. The score is how much of the two paths line up, counting both the steps that did
not happen and the calls that were not asked for, so one extra call in the middle costs one call
rather than everything after it. With `ordered` (the default) every named step must also have
happened in the order you wrote.

`rubric` is the only one that costs money: it asks the model in use to grade a free-text answer
against words you write. It refuses to guess when no model connection has been chosen, and the same
question is only ever paid for once within a run. Everything else is decided without a model, which
is what makes a result two people can check against each other.

`GET /api/evaluation/benchmarks` lists the scorers, the benchmarks that can be read, and the ones
that cannot.

### Gates

A gate is the bar a run has to clear, for a release script that should stop when it is not cleared.
`POST /api/evaluation/run { suite, gates: { minAccuracy, maxDollars, maxMeanMs, maxRegressions,
mustPass: [taskId] } }`, or on the command line:

```
branch eval --suite everyday --gate '{"minAccuracy":0.9,"maxRegressions":0}'
branch eval --suite everyday --gate release-gate.json
```

Everything in a gate is optional, and a gate with nothing set passes. The gate is checked against
the schema above, so a misspelled name is a plain error rather than a bar that quietly never
applies.

Exit codes for `branch eval --suite`: **0** when it passed, **1** when it did not. With no `--gate`,
"passed" means every task passed. With `--gate`, the gate's verdict is the exit code and nothing
else — a run can have a failing task and still exit 0 when the bar it was given was cleared.

### Where dataset files go

| Benchmark | What it reads | Where to put it |
| --- | --- | --- |
| SWE-bench (Lite, Verified) | the instances JSONL | `<folder>/*.jsonl`, and each repository at `<folder>/repos/<owner>__<name>` |
| GAIA | `metadata.jsonl` | `<folder>/metadata.jsonl`, with any attached files beside it |
| Code tasks (APPS, MBPP, HumanEval) | a JSONL of prompt, entry point and tests | `<folder>/*.jsonl` |
| Web tasks (WebVoyager, BrowserGym) | a JSONL of questions and answers | `<folder>/*.jsonl`, with each saved page at `<folder>/pages/<name>.html` |
| terminal-bench | one folder per task | `<folder>/<task>/task.md` and `<folder>/<task>/tests.sh` |

SWE-bench never clones anything from the internet. If the repository an instance names is not
already at `repos/<owner>__<name>`, that task is refused and the message says exactly where to put
it. When it is there, it is **copied** into a folder of its own inside the workspace, so your own
checkout is never touched, and the copy is moved to the instance's base commit when it is a real Git
checkout — a local move of a copy that is already here, never a fetch, so no sign-in is ever
involved. Judging puts the instance's own `test_patch` back over the assistant's work and runs the
named tests (`FAIL_TO_PASS` and `PASS_TO_PASS`), so the assistant cannot pass by editing the tests.

Four rules hold for every benchmark that decides by running something:

- **The owner switches it on first.** Marking by running the tests a dataset ships is starting a
  program on this computer, so it waits on the same switch small scripts use (Settings → running
  small scripts). Until then those tasks are refused by name and nothing is run.
- **A dataset never chooses what runs.** The tests are run by this copy of Node, by the bash you
  pointed at, or by your own Git — each named in full — and the program is started with no `PATH`,
  so nothing in a downloaded file can decide which program on this computer starts.
- **A dataset never points outside its own folder.** A record naming `..\..\somewhere` as its
  attachment, its saved page or its repository is refused rather than followed.
- **Same limits as any other command**: the same time, memory, processor and output ceilings, in a
  job the operating system enforces, with no way out to the internet.

**Nexus** (`nexus`) is the published function-calling set: JSON Lines where each line has the
question (`Input`, `prompt` or `question`), the functions on offer (`Function`, `functions` or
`tools`) and the reference call written the way a person writes one, `get_weather(city="Paris")`
(`Output`, `call` or `reference`). Several spellings are accepted because the sets in the wild
differ. A question is right when the call actually made has the right function name and every
argument the reference names; marking looks at the tool calls the task really made first, and falls
back to a call written out in the answer. Extra arguments are not held against it, because a
reference call rarely lists the optional ones.

Web tasks are run against pages you have saved next to the dataset. A task that points at a live
website is refused by name: a score against today's version of a shopping site is not a score
anybody can repeat. terminal-bench tasks are marked by running their `tests.sh`, which needs a bash
on this computer — Git for Windows provides one, or set `BRANCH_BASH` to the one you have.

### What is not supported, and why

OSWorld, WindowsAgentArena (and its checkpoint scoring), AndroidWorld, and the live BrowserGym
environments — MiniWoB, WebArena and WorkArena — are **not** integrated. Each needs a separate virtual computer — a Linux desktop, a
throwaway Windows machine, an Android emulator — or a live website whose contents change. Branch
Agent runs on your computer and cannot make or roll back one, so a number from it would not mean
what the published numbers mean. They are listed by name in `GET /api/evaluation/benchmarks` with
what each would need, rather than half-supported.

Two more things in this area are deliberately not built, for the same reason and written down here
so nobody has to guess:

- **A live browser-benchmark environment.** MiniWoB, WebArena and WorkArena are not datasets; they
  are servers that have to be running, whose pages change as the agent works and whose scoring reads
  the server's own state. Branch Agent downloads nothing and starts no server, so what it can do
  honestly is the `web-tasks` adapter: the same task shapes run against pages you have saved to
  disk. A task that points at a live site is refused by name.
- **Generating tests for you.** Branch Agent runs tests; it does not write your test suite for you
  and then claim the result. What exists is the execution half: `data/tool-evaluations/*.json` is a
  set of tool checks kept as plain data that anyone can read and add to, run with `POST
  /api/evaluation/tools`, and suites in `data/evaluation/*.json` are the same idea one level up.
  Asking the assistant to draft a test is an ordinary task like any other, and its output is yours
  to read before it becomes a check.

### Studies

A study is saved with `POST /api/studies`:

```json
{
  "id": "gaia-level-one", "name": "GAIA, level one, two models",
  "source": { "kind": "benchmark", "benchmark": "gaia", "directory": "C:/datasets/gaia" },
  "presets": ["fast", "careful"], "limit": 20, "repeats": 1,
  "concurrency": 2, "retries": 1, "maxDollars": 2, "bestOfN": 1
}
```

`source` can instead be `{ "kind": "suite", "suite": "everyday" }`. `concurrency` is how many tasks
run at once, from 1 to 4. The whole app allows eight pieces of work at once, and **every task a study
runs takes one of those eight**, so a study can never quietly put four more on top of what everything
else is doing. A study also holds the place the request that started it took, and it runs its first
task on that one: that is what makes several studies at once safe. Each of them can always get on
with something using a place it already has, whatever the others are doing, so none waits on another
and none is starved. A task that wants a second or third place waits for one to come free, for up to
thirty seconds, and then lets its turn go rather than holding anything up; the study finishes either
way, more slowly when the computer is busy.

**Where a benchmark may be read from.** `directory` is confined the same way every other path in
Branch is: it must be inside your workspace, or inside the one benchmarks folder you have named.
`GET /api/studies/settings` shows that folder and `POST /api/studies/settings {"benchmarksFolder":
"C:/datasets"}` sets it; empty, which is where it starts, means the workspace and nothing else. A
study pointing anywhere else is refused in one sentence when it is saved and again if it is run, so
an older study cannot become a way to read a folder you never allowed.

**Grading costs money too.** A task graded by a model (`rubric`) sends a second model call, and what
that call costs is now charged to the cell that asked for it, so a study's tokens and its dollars
are what it really spent rather than what the tasks alone spent. The `budget` scorer is answered
last, whatever order the task listed its scorers in, so "did it stay inside its budget" is asked
once the grader has spent rather than before — a task that only fits its limit by not counting the
grader is not a task that fitted its limit.

`bestOfN` runs each task that
many times and keeps the best try by its score, remembering what the others scored. `maxDollars`
stops the study when it has spent that much, and says so.

`POST /api/studies/run { id, fresh }` runs it — without `fresh`, anything already finished is kept.
`GET /api/studies` lists the studies and past results. `POST /api/studies/compare { a, b }` takes two
result ids and reports the difference over the tasks both ran, with the range that difference is
very likely to be in, worked out by resampling the tasks two thousand times. When the range includes
zero, nothing is claimed.

On the command line: `branch study list`, `branch study run <id> [--fresh] [--json]` (JSON is one
result per line), `branch study compare <result id> <result id>`, and `branch study replay <id>`.

### The journal: repeating a study and seeing what changed

A number on its own is not evidence. "78% on twenty GAIA questions" means nothing without which
twenty, which model choices, how many repeats, which scorers, and which version of Branch Agent —
and those are exactly the things that drift between one month and the next. So every study run
writes a **journal entry** beside its result: the study exactly as it was written, the task ids that
actually ran, the scorer kinds the tasks used, the benchmarks folder, and the version that ran it.
Those are boiled down to one short fingerprint. Two entries with the same fingerprint measured the
same thing; two that do not are not comparable until you know why.

`branch study replay <id>` reads the two newest entries for a study and prints, in this order:
whether they measured the same thing, a table of every input that changed with its before and
after, the accuracy on each side, and — when the two results share tasks — the same interval
`compare` works out, so a small win on a handful of tasks is still not read as a real one. When
something changed it ends with the only advice that helps: change one thing at a time. `--json`
gives the entry itself, including the study to save and run to repeat it exactly.

### Scoring the real work as it finishes

A suite tells you how the assistant does on questions somebody wrote down. It does not tell you how
it is doing on the tasks you actually gave it today, which is where a quiet break shows up first.
Switch this on and every task that finishes is held to a few checks of your choosing.

`GET /api/evaluation/live` gives the settings, the fifty newest verdicts, and "this many of the last
hundred passed" with the reasons the failures gave. `POST /api/evaluation/live` sets:

- `enabled` — off until you turn it on. Nothing is scored and nothing is written while it is off.
- `scorers` — the checks, written exactly as a suite writes them, at most four so a task is never
  slowed down. `rubric` is refused here by name: scoring every ordinary task with a model would put
  a second bill on your everyday work, and being told that is better than wondering why. A `budget`
  scorer carrying `maxDollars` is refused for the same reason in reverse: what a finished task cost
  is worked out where usage is priced, not here, so a money limit set here would be a bar that never
  applied. `maxSteps`, `maxMs` and `maxTokens` are all real here — the time comes from the task's own
  timestamps and the tokens from its usage.
- `keep` — how many verdicts are kept, from 10 to 2000; 200 unless you say otherwise. The oldest are
  dropped once there are more than that.

A task never waits for its own verdict, and a check that fails to run is the verdict's problem
rather than the task's.

### Marking a search rather than an answer

`nDCG@k`, `Recall@k`, `Precision@k`, `MRR` and `MAP` are worked out in `src/retrieval-metrics.ts`,
which also reads the BEIR layout from a folder already on this computer: `corpus.jsonl` (`_id`,
`title`, `text`), `queries.jsonl` (`_id`, `text`), and `qrels/<split>.tsv` (question, document,
grade, after a header line). Nothing is downloaded — you put a set in a folder as with every other
benchmark here. The search itself is handed in, so these mark any search rather than deciding how
searching is done.

### Reading back what one task actually did

`runs.export` hands back a finished task's whole record. With `"as": "report"` it hands back the
same record written out for a person instead: what it was asked, the plan it wrote, then every
action numbered with what it was given and what came back, the rounds that failed, what the
reviewer said, the tokens, and the answer. Long inputs and outputs are cut short with the number of
characters dropped said out loud, so it never hides that there was more.

**Working out why a task went wrong.** That report is the first place to look, because it shows the
action that failed and the error it came back with rather than the assistant's summary of it.
Around it: a task's own completion checks are retried a set number of times before it gives up
(`reliability`), a model call that goes quiet is stopped by the stall watchdog rather than hanging,
a small script is checked before it runs, and a program can be run under a real debugger you
already have (Settings → debug adapters) to stop it on a line and look at what every name holds.
What Branch Agent does **not** have is a separate troubleshooting assistant that goes away and
fixes a failing command on its own; asking it to look at the report and try again is an ordinary
task, and you see each step.

**Cost warning.** A study multiplies: tasks × model choices × repeats × Best-of-N, and a task graded
by a rubric asks the model a second question on top. Twenty tasks, two models, three repeats and
Best-of-3 is three hundred and sixty runs. Set `limit` and `maxDollars` before the first one.

### Checking the tools themselves

`branch eval tools` (or `POST /api/evaluation/tools`) calls each tool directly with a known input and
checks what comes back against what the tool is documented to do. No model is involved, so it takes
a moment and costs nothing, and it belongs in a build script. The cases are plain JSON in
`data/tool-evaluations/`.

The cases call the real tools, so they leave real traces: a small file in the workspace and a couple
of notes in memory. That is deliberate — a check that stubbed the tool out would not be checking the
tool — but it is why the cases are kept few and obvious.

### Writing your own tests against Branch Agent

`ScriptedProvider` and `ScriptedTools` are part of the package, so a plugin or skill author can
write tests with no model, no key and no network:

```js
import { createBranch, ScriptedProvider, ScriptedTools, say, callTool } from "branch-agent";

const provider = new ScriptedProvider([
  ["greet Ada", [callTool("notes.add", { name: "Ada" }), say("I have greeted Ada.")]],
]);
const app = await createBranch({ workspace, dataDir, provider });
const doubles = new ScriptedTools().reply("notes.add", { greeted: "Ada" });
doubles.register(app.registry, ["notes.add"], "memory.write");
await app.runtime.run({ prompt: "Please greet Ada for me.", permissions: ["memory.write"] });
doubles.calledWith("notes.add"); // [{ name: "Ada" }]
```

A scripted model answers by *what it was asked* — each route is a phrase to look for in the newest
question — not by how many times it has been called, so one task cannot shift another task's script.

### Traces

Every evaluation task and every study task is a trace of its own, labelled with
`branch.evaluation.suite` and `branch.evaluation.task`, or `branch.study.id`, `branch.benchmark.id`
and `branch.study.task`. An export can then be narrowed to one suite, one study or one task months
later.

The Usage screen shows the experiments you have written down under the card for running a suite.

## Skill governance and consolidation

`GET|POST /api/governance` holds `excludeAfterFailures`, `windowMinutes`, `recoveryAfterMinutes` and `demoteAfterFailures`. A skill with a repeating failure pattern is set aside (`skill.set_aside`, `skill.excluded` on later runs), gets one recovery trial after the cool-off (`skill.recovery_trial`, `skill.recovered`), and is demoted when failures pile up (`skill.demoted`); `POST /api/governance/set-aside/:skillId/restore` lets it back in. `POST /api/skills/:id/benchmark { baselineVersion, candidateVersion, tasks, seed }` records per-task outcomes and costs; `POST /api/skills/:id/draft { runId }` saves an inactive draft version from a task. `consolidateDaily` in the learning settings (or `POST /api/memory/consolidate`) digests completed tasks since a cursor into memory suggestions.

## Guardrails

Shell: `maxMemoryMb` (default 1024) and `maxCpuSeconds` (default 60) stop a command whose sampled usage passes the limit (reasons `memory_limit`, `cpu_limit`); results carry `usage.peakMemoryMb` and `usage.cpuSeconds`. Network: the `web` section accepts `allowedHosts`, `blockedHosts`, `allowedPaths` and `blockedPaths` (rules look like `api.github.com/repos/`); the same policy applies to web reading, browser navigation and MCP HTTP requests. Hooks: `hooks: [{ id, event, executable, args, failureThreshold, timeoutMs }]` in the integrations file, where `executable` names a shell alias; `GET /api/hooks`, `POST /api/hooks/:id/enable`. Streams: `GET /api/runs/:id/ws` (WebSocket; send the token as the second subprotocol after `bearer`). Channels: `POST /api/channels/test { channel, chatId }`.

### Security self-check

Settings → Permissions has a **Security check** card, and the command line has `branch security audit [--fix] [--json]` (it exits with 1 while anything urgent is left). It runs 85 named checks, each in plain words, over files and folders (who else can read or change Branch's private folder, the database, the key to saved passwords, the ChatGPT sign-in, the app's own key, the launch settings file, plugins, saved website sign-ins, logs and backups; links; the private folder or workspace inside iCloud, Dropbox, OneDrive or Google Drive or a shared place), secrets, the phone door, short-lived keys, approval rules, the programs the assistant may run, the web and the browser, add-ons, models and chat services. The full list is `securityChecks` in `src/security-audit/audit.ts`. Running it changes nothing. **Fix what Branch can** (`--fix`, `POST /api/security-check/fix { ids? }`) only ever takes other people's access away from Branch's own files: `chmod` to 700 or 600 on macOS and Linux, and on Windows `icacls <path> /inheritance:r /grant:r <you>:(F) *S-1-5-18:(F)` followed by `icacls <path> /remove:g *S-1-1-0 *S-1-5-11 *S-1-5-32-545`. A path that turned into a link is left alone; everything else is described with what to do. `branch doctor --fix` adds one line with the counts. Routes: `GET /api/security-check` (switches, last report, malware check status), `POST /api/security-check/run`, `/fix` and `/settings`; a short-lived key may run the check but not fix or change switches, and neither may a household profile (both stay with the owner).

Two three-way switches, saved in `settings/security-check` and both **off** on a fresh install. `audit`: off runs the check only when asked; `when-needed` also gives the assistant one read-only tool, `settings.security_check` (permission `history.read`); `on` also runs it each time Branch starts. `malware`: before an outside server started with `npx`, `bunx`, `pnpm dlx`, `npm exec`, `uvx`, `uv tool run` or `pipx run` starts, also when wrapped in `cmd /c`, (from the launch settings or from "Try a server"), the package is looked up in OSV (`https://api.osv.dev/v1/query`, through the network policy; `BRANCH_OSV_ENDPOINT` points it elsewhere) and one with a `MAL-` advisory is refused with a plain sentence and a `connection.changed` line in the record. `when-needed` keeps each answer for a week, `on` for an hour. If OSV cannot be reached, answers badly, or the network policy refuses the address, the server starts as it did before and the reason shows on the card.

macOS and Linux: permissions are the file mode bits, a folder is open to others when its group or everyone may read or enter it, and files inside a private folder nobody else can enter are not reported again. The iCloud check also notices "Desktop and Documents" syncing. Windows: access lists are read with `icacls <path>`, and the broad groups are recognised by their English, French and German names.

## Memory over time, scopes and admission

`memory.put` accepts `entity`, `attribute` and `validFrom`; a newer fact for the same entity and attribute ends the earlier one at that moment. `memory.at { entity, attribute?, at? }` returns the facts true at a moment; `memory.timeline { entity }` lists them in order. Facts carry `scope`: `private` (default), `shared`, or `agent:<specialist id>`; delegated specialists see shared facts and their own only. `GET|POST /api/sessions/:id/memory-policy { remember }` controls whether a conversation may save memory on its own (forgetting a conversation denies it; allowing re-admits it). `POST /api/memory/hygiene { olderThanDays, action: preview | archive | purge }` and `GET /api/memory/archive` back the Tidy up controls in the Memory view.

## Recipes, templates and project folders

A recipe (`procedures.propose`) may declare `parameters` (`{ name: { type: "string" | "number" | "boolean", required, default, description } }`) and use `{{name}}` in step arguments, expectations and precondition paths; `procedures.verify` and `procedures.replay` take `inputs`, which are bound and checked before any step runs. `resultSchema` (the same JSON-Schema subset as delegation) is applied to the final step's result. `templates.export` / `GET /api/templates/:kind/:id` and `templates.import` / `POST /api/templates/import` move a specialist or recipe definition between installs without ids, evidence or secrets. A project's `folder` scopes every file tool to that folder inside the workspace while the project is active.

## Command line and terminal

`branch <command>` (or `node dist/cli.js <command>`) is the whole command line; `branch help` lists it. Nothing here needs the web app to be running.

**Talking in the terminal.** `branch` on its own, in a terminal, opens the terminal view; `branch chat` opens the same view. (Run with no terminal attached — a launcher, a service, a pipe — `branch` on its own still starts the web app, exactly as before.) The view is the window's design in character cells (`docs/design.md`, `docs/places.md`):

- **The head** carries the KeepOak mark and the assistant's name, the page you are on (`Inbox › Needs you`, `Settings › Models › Defaults`), the model that answers, and the Lockdown shield while Lockdown is on. While it is on, a red line under the head says so on every page.
- **The tab row** holds the five places in the window's order and with the window's names — Conversation, Inbox (with a count of what waits for your yes), Automations, Library, Customize.
- **The conversation** is one column of messages with the composer floating at its foot: the model chip first, then what the next message carries (the approval preset, attached files, practice run, a plan first). Each step the assistant takes is one short row — `· Writing notes.txt` while it happens, `ok Writing notes.txt` when it is done — and **Ctrl+E** shows what is behind those rows. The **side pane** (Activity, Plan, Files, Memory) opens with **Ctrl+P** or **F2**; under 100 columns it floats over the conversation, as the window's does under 1180 px.
- **Every other place** reads as the window's places do: its name, one sentence saying what it holds, its tabs, and its rows, each a title and one plain line. An empty tab says what the tab is for and what to do next. The ask box at the foot sends a question straight to the conversation.
- **Settings** opens as a window over the place you were in, with its twelve pages down the left (in a strip along the top under 86 columns) and the five Models tabs. Appearance, Models › Defaults and Permissions can be changed right there; the other pages say what they hold and where the rest of the page is.
- **Ctrl+K** (or **/** in an empty composer) opens the palette: every place and tab, every Settings page, the top actions, recent conversations and every slash command. Typing narrows it; Enter goes.

**Keys.** **Enter** sends, **Alt+Enter** adds a line, the **up arrow** brings back a message you sent, **PgUp**/**PgDn** scroll the conversation, **Ctrl+C** stops the task in hand without closing anything, **Ctrl+N** starts a conversation, **Ctrl+L** draws everything again and **Ctrl+D** leaves. **Esc** steps out of the composer without touching what you typed; then **1** to **5** open the places (**Alt+1** to **Alt+5** work from anywhere). In a place, the up and down arrows choose a row, left and right change tab, **Enter** opens a row and **Tab** moves to the ask box; **Esc** goes back to the conversation. In Settings, left and right change page and **Tab** changes the Models tab. **F1**, `/help` or `/keys` lists all of this. A paste arrives whole, line breaks and all, rather than sending half of it. Nothing needs a mouse.

**Three switches, all off.** `/switch mouse`, `/switch sidePane` and `/switch oak` (or Settings › Appearance in the view) each take on, off or when needed, and a fresh install has all three off. *Clicks and the wheel*: on catches them everywhere; when needed only while the palette or Settings is open; off never, so your terminal's own text selection always works. *The side pane opens by itself*: on opens it when the view starts; when needed opens it while a task works and folds it when the task ends; off leaves it to Ctrl+P. *The oak*: the window's pixel oak, drawn on an empty conversation in the season of the year from the theme's own colours; on whenever it fits, when needed only on a terminal of 30 rows or more.

The commands inside it are `/help` (and `/keys`), `/model [id]`, `/think <low|medium|high|default>`, `/preset [name]`, `/memory [words]`, `/skills`, `/plan`, `/verify`, `/dry-run`, `/attach <file>`, `/history`, `/export [file]`, `/new`, `/sessions [id]`, `/go <place>`, `/inbox`, `/automations`, `/library`, `/customize`, `/settings [page]`, `/theme`, `/default <id>`, `/switch`, `/pane`, `/lockdown [on|off]` and `/exit`. They live in one table (`src/terminal-command-table.ts`) that the help, the palette and the parser all read, and several answer to the names Hermes and OpenClaw use (`/reset`, `/clear`, `/models`, `/reasoning`, `/config`, `/tools`, `/cron`, `/skin`, `/pause`, `/quit`). `/plan`, `/verify` and `/dry-run` switch on and off and apply to every message after that. `/attach` takes a picture (PNG, JPEG, WebP or GIF) as a picture and any other text file as words added to your next message. `/export` writes the conversation to a Markdown file in your workspace. `/go` takes any place, tab or Settings page by id, English name or French name: `/go inbox finished`, `/go settings models defaults`, `/go Bibliothèque`.

**When it stops to ask.** If your approval preset makes a task pause, the terminal shows the question with the tool and the exact file or command, and takes **y** (yes, remembered as the rule suggests), **n** (no), **a** (yes, always — written into your approval settings as a rule) or **s** (yes, for this conversation), then Enter. The answer goes through the same route as the app's **Settings → When to check with me** screen, and the task carries straight on.

**When the terminal cannot take it.** `branch chat` falls back to the plain streaming view when stdout is not a terminal or when you pass `--plain`. With `NO_COLOR` set, or `TERM=dumb`, the view prints plain lines and writes not a single escape sequence — no colour, no cursor movement, no window title, no progress indicator — and every slash command, place and Settings page still works, printed as lines. `FORCE_TTY=1` asks for the full view anyway (this is what the tests use), and `FORCE_TTY=0` asks for the plain one. `COLUMNS` and `LINES` override the window size; the view redraws itself when the window changes size and works from 80×24 up. The view is drawn on the terminal's second screen with line wrapping off, so leaving puts back exactly what was there. On a terminal that takes them, the window title names the place you are in and Windows Terminal's taskbar progress indicator (OSC 9;4) turns on while a task is working; `BRANCH_TUI_DECORATIONS=0` turns just those two off.

**Colours: the same 44 themes as the window.** Nothing in the terminal names a colour. It reads the window's own table (`public/theme-catalogue.js`), lays each see-through colour over the theme's ground, and writes the result at the depth the terminal shows: true colour where `COLORTERM` is `truecolor` or `24bit`, in Windows Terminal (`WT_SESSION`), in iTerm, WezTerm, VS Code, Ghostty and Hyper, and in the Windows console from build 14931; the 256-colour table where `TERM` ends in `-256color` or in macOS Terminal; the sixteen colours elsewhere, where the terminal's own background and text colour stand in for the ground and the words so a light theme never writes dark text on a dark terminal. A colour lands on the numbered colour that looks nearest (distance in Lab space). `FORCE_COLOR=0…3` and `BRANCH_COLOR=truecolor|256|16|none` choose the depth by hand. Box lines, the dot and the ellipsis are drawn where they can be shown; `BRANCH_ASCII=1` (or a locale that is not UTF-8, or the Linux console) draws plain ASCII instead.

**One theme, two surfaces.** `branch theme <name>` (or `/theme` in the view, or Settings › Appearance in the view) and Settings › Appearance in the window are the same setting. The theme, the extra contrast and the language are kept with the workspace (`GET`/`POST /api/look`); light or dark stays in the preferences record the window has always saved, and "follow this computer" follows the terminal's own background (`COLORFGBG`) in the terminal. The window reads `/api/look` when it opens and whenever it comes back into view, and picks a theme the terminal chose since it last looked by pressing that theme's own tile (`public/look-sync.js`); a theme picked in the window is saved there for the terminal. Moving through the theme list in the view shows each theme as it is passed, Enter keeps it and Esc puts the saved one back. The words come from the window's language files (`public/locales/*.json`): French when the language is set to French, or set to "same as this computer" on a computer whose `LANG` is French.

**macOS, Linux and Windows.** The view looks and works the same in Windows Terminal, PowerShell and cmd, macOS Terminal and iTerm, and Linux terminals. It uses only what all of them understand: the second screen, cursor placement, colour, bracketed paste and, only when switched on, SGR mouse reports; every row is written whole at its own position, so nothing depends on how a terminal wraps or turns a line break into two. Node reads the Windows console's keys as the same sequences a Mac or Linux terminal sends and writes its text as UTF-16, so the box lines show whatever the console's code page. There is no POSIX-only call anywhere in the view. The tests work out the style for a Windows Terminal environment (`WT_SESSION`, no `COLORTERM`), a Windows console, macOS Terminal, iTerm and Linux terminals, check that a Windows-style frame uses only sequences Windows understands, and compare every view at 80×24 and 120×40 in true colour, 256 colours, 16 colours and none with stored snapshots.

**Every place by name, from the command line.** `branch inbox [needs|finished|history]`, `branch automations [tab]`, `branch library [tab]`, `branch customize [tab]` and `branch settings [page] [tab]` open the view there in a terminal, and print the same rows (one per line, or `--json`) anywhere else. `branch places` lists every home in `docs/places.md` with the command that opens it. `branch setup` opens Settings › Models › Connection. `branch resume [id|latest]` carries on a conversation in the view (and prints it without a terminal), `branch sessions [show <id>]` lists them, `branch model [use <id>]` lists the models or sets the one new conversations start with, `branch theme [name|list|light|dark|follow|contrast|language]` changes the look, `branch lockdown [on|off]` turns Lockdown on or off, `branch permissions [preset]` shows or sets when Branch checks with you, and `branch memory`, `branch skills`, `branch tools`, `branch channels`, `branch mcp`, `branch projects`, `branch usage` and `branch snapshots` print what the window shows. `branch version` (also `--version`) prints the version.

**Hermes Agent and OpenClaw, side by side.** Typing `hermes` gives Hermes Agent's terminal and `openclaw` gives OpenClaw's; `branch` gives Branch's. The table below sets their commands beside Branch's. Only their command names were read (both are MIT); no code was taken. The table is kept as data in `src/terminal-parity.ts`, and a test checks that every Branch command it names exists. The names people bring with them work as they are: `config`, `skin`, `models`, `plugins`, `cron`, `approvals`, `insights`, `checkpoints`, `pause`, `serve`, `dashboard`, `acp`, `kanban`, `tasks`, `webhooks`, `hooks`, `documents`, `specialists`, `connections` and `mcp serve` each run the Branch command they mean.

| What | Hermes Agent | OpenClaw | Branch | Status | Note |
| --- | --- | --- | --- | --- | --- |
| Interactive view | `hermes` | `openclaw` | `branch` | built | In a terminal it opens the designed view; anywhere else it runs `branch start` as before. |
| Conversation | `hermes chat` | `openclaw tui \| terminal \| chat` | `branch chat` | existed | Redrawn in the window's design; `--plain` keeps the streaming view. |
| One request, printed | `hermes -z \| chat -q` | `openclaw agent` | `branch run` | existed |  |
| A scripted job | `hermes chat --query-file` | `openclaw agent exec` | `branch headless` | existed |  |
| Carry on a conversation | `hermes --resume \| -c` | `openclaw resume` | `branch resume [id]` | built | `latest` or the first letters of a conversation's number. |
| Earlier conversations | `hermes sessions` | `openclaw sessions \| transcripts` | `branch sessions [show <id>]` | built | Removing one lives in Settings › Data & usage. |
| Which model answers | `hermes model` | `openclaw models list \| set \| status` | `branch model [list \| use <id>]` | built |  |
| Fallback models | `hermes fallback` | `openclaw models fallbacks` | `branch settings models defaults` | window | settings:models:defaults |
| Several models together | `hermes moa` | — | `branch settings models second` | window | settings:models:second |
| Signing in to a model service | `hermes auth \| login \| logout \| portal` | `openclaw models auth \| onboard` | `branch login \| logout` | existed | Keys for other services: settings:models:connection. |
| Setting up | `hermes setup` | `openclaw setup \| onboard \| configure` | `branch setup` | built | Opens Settings › Models › Connection; prints the health check when not in a terminal. |
| Settings | `hermes config` | `openclaw config get \| set` | `branch settings [page] (also `config`)` | built | Reads every page; changes are made on the page itself. |
| Status | `hermes status` | `openclaw status \| health` | `branch status` | existed |  |
| Checking and repairing | `hermes doctor \| dump \| debug` | `openclaw doctor \| triage` | `branch doctor [--fix]` | existed |  |
| What a task did | `hermes logs` | `openclaw logs` | `branch logs <task>` | existed |  |
| Emergency stop | `hermes pause \| resume` | `openclaw gateway suspend \| resume` | `branch lockdown [on \| off] (also `pause`)` | built |  |
| When to ask first | `hermes approvals` | `openclaw approvals \| exec-policy` | `branch permissions [preset]; branch approve` | built | `approve` already existed. |
| Schedules | `hermes cron` | `openclaw cron` | `branch schedule (also `cron`); branch trigger` | existed |  |
| Webhooks and hooks | `hermes webhook \| hooks` | `openclaw hooks \| webhooks` | `branch automations triggers` | built | Listed; edited at automations:triggers. |
| Skills | `hermes skills \| bundles \| curator \| sync` | `openclaw skills` | `branch skills; branch skill pack \| install` | built | `skill` already existed; the rest is customize:skills. |
| Plugins | `hermes plugins` | `openclaw plugins` | `branch plugin (also `plugins`)` | existed |  |
| Tools | `hermes tools` | — | `branch tools` | built | Listed by toolbox; what may run without asking is settings:permissions. |
| MCP servers | `hermes mcp` | `openclaw mcp` | `branch mcp; branch mcp-serve (also `mcp serve`)` | built | `mcp-serve` already existed. |
| Code editors (ACP) | `hermes acp` | `openclaw acp` | `branch acp-serve (also `acp`)` | existed |  |
| Chat apps | `hermes gateway \| whatsapp \| slack \| pairing \| peer` | `openclaw channels \| pairing \| directory` | `branch channels` | built | Listed; connecting and pairing are customize:channels. |
| Sending a message out | `hermes send` | `openclaw message` | — | not applicable | Messages go out through the running engine's own connections, after Lockdown and approval checks; ask the assistant in the view. |
| Memory | `hermes memory \| journey` | `openclaw memory \| wiki` | `branch memory [words]` | built |  |
| Documents | — | — | `branch library documents` | built |  |
| Backups | `hermes backup \| import` | `openclaw backup` | `branch backup \| restore` | existed |  |
| Moving in from another assistant | `hermes import-agent \| claw migrate` | `openclaw migrate` | `branch import-agent` | existed | Branch's own file; bringing in other assistants is mac2/move-in at settings:data. |
| Separate assistants | `hermes profile` | `openclaw agents` | `branch export-agent \| import-agent` | window | People on this computer: settings:general. |
| Projects | `hermes project` | — | `branch projects` | built |  |
| Updating | `hermes update` | `openclaw update` | `branch update` | existed |  |
| Removing | `hermes uninstall` | `openclaw uninstall \| reset` | `branch daemon uninstall` | not applicable | The app itself is removed the way this computer removes any app. |
| Working with the window closed | `hermes gateway install \| start \| stop` | `openclaw daemon \| gateway \| node` | `branch daemon install \| uninstall \| status` | existed |  |
| The web app | `hermes dashboard \| serve` | `openclaw dashboard \| gateway run` | `branch start (also `serve`, `dashboard`)` | existed |  |
| Shell completion | `hermes completion` | `openclaw completion` | `branch completion` | existed |  |
| Version | `hermes --version` | `openclaw --version` | `branch version (also `--version`, `-v`)` | built |  |
| Theme | `hermes skin` | — | `branch theme [name \| list \| light \| dark \| follow] (also `skin`)` | built | The same setting as Settings › Appearance. |
| Usage and cost | `hermes insights` | `openclaw gateway usage-cost` | `branch usage (also `insights`)` | built |  |
| Checkpoints | `hermes checkpoints` | `openclaw backup git` | `branch snapshots (also `checkpoints`)` | built | Putting one back is settings:data. |
| Worktrees | `hermes worktree` | `openclaw worktrees` | `branch settings general` | window | A project's line of work is switched at settings:general. |
| Task board | `hermes kanban` | `openclaw tasks` | `branch inbox [needs \| finished \| history]` | built |  |
| Security audit | `hermes security audit` | `openclaw security audit` | `branch doctor` | not applicable | Branch installs no packages of its own to audit; `doctor` checks what Branch relies on. |
| Secrets | `hermes secrets \| vault` | `openclaw secrets` | `branch settings secrets` | window | settings:secrets; values are never printed. |
| Browser and screen | `hermes browser \| computer-use` | `openclaw browser \| nodes \| sandbox` | `branch settings computer` | window | settings:computer. |
| Language servers | `hermes lsp` | — | `branch settings advanced` | window | settings:advanced, Help with code. |
| Network reach | `hermes egress \| proxy` | `openclaw proxy \| dns` | `branch settings computer` | window | settings:computer. |
| Telemetry | — | `openclaw telemetry` | — | not applicable | Branch sends none. |
| Pets | `hermes pets` | — | `branch switch oak` | not applicable | Branch has its own oak: `/switch oak` in the view. |
| Evaluations | — | `openclaw qa` | `branch eval \| study` | existed |  |
| Short-lived keys | — | `openclaw devices \| gateway auth-token` | `branch token` | existed |  |
| Pairing a phone | — | `openclaw qr` | `branch customize channels` | window | customize:channels. |
| Prompt size | `hermes prompt-size` | — | `branch settings advanced` | window | settings:advanced, How the assistant finds its tools. |
| Help | `hermes --help` | `openclaw docs` | `branch help; branch <command> --help` | existed |  |
| Every place by name | — | — | `branch places; branch inbox \| automations \| library \| customize` | built | Every home in docs/places.md. |

**For scripts.** `branch run "..."` takes `--json` (every event as one JSON object per line on stdout, human wording on stderr), `--attach <file>` (repeatable), `--plan`, `--verify`, `--dry-run`, `--preset <off|ask-before-changes|workspace|read-only>`, `--save-preset <same names>`, `--budget <tokens>` and `--timeout <milliseconds>`. `--preset` uses that approval setting **for this one task** and puts your saved setting back afterwards, so a script cannot quietly change what you chose; `--save-preset` changes the saved setting and stays changed, and says so on stderr. The exit code is the contract:

| Code | Meaning |
| --- | --- |
| 0 | The task finished. |
| 2 | The task stopped to ask you something; `branch approve` answers it. |
| 3 | The task failed, was cancelled, or ran past `--timeout`. |
| 4 | The task ran out of the budget you gave it. |

`branch status` lists the tasks working now, the ones waiting for an answer, and the health summary (`--json` for the same thing as JSON). `branch logs <task id>` prints that task's timeline one line per step (`--json` for the stored events). `branch approve <task id> yes|no` answers a task that stopped to ask. It cannot answer just this once: the program run that stopped has already ended, so the answer is **saved as a standing rule** for that tool and that exact target and applies to every future task, not only this one. The command says so when it runs, and the rule can be changed under **Settings → When to check with me**. For a one-time yes, use the terminal view (`branch chat`) or the settings screen instead.

**No window at all.** `branch headless` runs a scripted job with nothing on the screen: no web page, no
terminal conversation, no window. Give it one request, or `--script <file>` with one request per line
(blank lines and lines starting with `#` are notes, at most 100 requests). Every request after the
first joins the conversation the first one made, so a script reads as one job. `--stop-early` stops at
the first request that does not finish; without it the rest still run. It takes the same `--json`,
`--budget`, `--timeout`, `--session` and `--preset` flags as `branch run`, and **the exit code is the
same contract as the table above** — 0 finished, 2 stopped to ask you something, 3 failed, 4 out of
budget. For a whole job, the first request that did not finish decides the code. A summary line goes
to stderr; with `--json` the last line of stdout is `{"type":"headless.finished", ...}`.

**A command line kept open.** An ordinary command starts a program, waits for it and lets it go, so
nothing carries from one command to the next. `shell.session.open` opens one of the same programs your
host command settings allow and **keeps it open**, so a later command lands in the same folder with the
same loaded state, in a later task of the same conversation. `shell.session.run` sends one command and
reads what it printed, `shell.session.list` lists the ones this conversation has open (name one to read
what it has printed lately), and `shell.session.close` closes it and everything it started. It is held
to exactly what any other command is held to: the same allowed programs, the same environment built
from an allowlist, the same Windows job enforcing the limits, and the same approval rules — asked again
for **every** command sent, not once when it was opened. The limits are the ones under **programs left
running** (`maxRunning`, `maxMinutes`, `maxMemoryMb`, `maxCpuSeconds`, `bufferBytes`); it is never a
window on your screen, and every kept-open command line is closed when the app closes.

**When a task cannot be placed.** A task that cannot start is never left to hang in silence. The
waiting line answers every `submit` with where the task went and why: started, waiting (with its place
in the line and what would let it start sooner), moved to another model because the one it asked for is
no longer set up, or refused because something it needs is not on this computer — each with the next
best thing you can actually do about it.

**Completion.** `branch completion bash`, `branch completion zsh`, `branch completion fish` and `branch completion powershell` print a completion script. Nothing is installed for you and the script never runs a Branch command to work out its suggestions. The first lines of each script say how to load it in every new terminal:

| Shell | Install |
| --- | --- |
| bash | `branch completion bash > ~/.branch-completion.bash`, then add `source ~/.branch-completion.bash` to `~/.bashrc` |
| zsh (the Mac's own shell) | `mkdir -p ~/.zfunc && branch completion zsh > ~/.zfunc/_branch`, then add `fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit` to `~/.zshrc` |
| fish | `branch completion fish > ~/.config/fish/completions/branch.fish` |
| PowerShell | `branch completion powershell >> $PROFILE` |

## A queue service, and why there is not one

Some assistants put a queue service such as Redis in the middle: tasks go into it, separate workers
take them out, and the two halves talk over the network. Branch does not, and this is a decision
rather than an omission. The waiting line is already here, in `src/run-queue.ts`: it is kept in the
same private database as everything else, it orders what you asked for ahead of anything automatic,
it holds one task at a time per conversation, it shares one count of what is working with the app's
own screen, and it marks anything that was working when the app closed instead of quietly replaying
it. A queue service would add a second program to keep running and a second place your work can sit,
for a single computer that has no second worker to coordinate with. That is the same reason the
audit's other middle-men were turned down (see the "not going to be built" list). If Branch ever runs
across more than one computer, this is the paragraph to come back to.

## Other programs and streams

`POST /v1/chat/completions` accepts the OpenAI chat shape with the local session token as the bearer token. The last user message becomes the task, system/developer messages travel as caller instructions, `model` may name a preset id, `x-branch-session` (or `metadata.session_id`) continues a conversation, and `stream: true` returns `chat.completion.chunk` events. Every response carries `branch.{run_id, session_id, status}`. `GET /v1/models` lists presets. `GET /api/runs/:id/stream?after=<id>` streams a run's events in order over Server-Sent Events until it ends.

## Schedules that repeat, and ones that keep failing

`schedules.create` writes down a reminder, a task, a check or an evaluation with a due moment, and
optionally an interval (`intervalMs`, at least a minute) or a daily time in a timezone (`dailyAt` plus
`timezone`). It can deliver its result to a chat (`deliverTo`), be triggered by a signed webhook
(`webhook`), and be held back on a holiday or a day off (`daysOff`: run, skip or shift). Missed turns
while the app was closed coalesce into one. `schedules.pause`, `schedules.remove` and `schedules.list`
do what they say, and each schedule keeps the last fifty turns with what happened on each.

A repeating job that **fails** a turn now moves on to its next turn rather than stopping for good, and
the failures in a row are counted on the record as `consecutiveFailures`. After three in a row the job
is paused and the reason is written down in plain words under `pausedBecause`, so a job that is broken
rather than unlucky does not fail quietly every day for ever; start it again with `schedules.pause` set
to false once whatever it needs is working. One turn finishing clears the count.

### Background work that only speaks up when needed

**Switches.** Schedules → Background work that stays quiet (`POST /api/heartbeat/switches`, setting
`quiet-jobs`). Three switches, each `off` (the default), `on` or `when-needed`: `checkIn`, `scriptGates`
and `notifyGate`. "When needed" means the feature never runs on a timer of its own, only when something
calls for it. What each one means is written under the feature below.

**Check-in.** Schedules → Check-in (`GET`/`POST /api/heartbeat`, `POST /api/heartbeat/check` for "check
in now"). With `checkIn` on, every `everyMinutes` (30 by default, at least 5), inside `activeHours`
(`{ from, to }` in `timezone`, 08:00–22:00 by default, may run past midnight; `null` means any time),
the assistant works through your `checklist`. With `checkIn` set to when needed, nothing runs on a timer.
A check-in runs only when you press "Check in now" or something wakes it, and a wake still keeps to the
hours. With `checkIn` off, "Check in now" is refused. The checklist is read through one provider. When
the `heartbeat` context file (HEARTBEAT.md in the workspace) is switched on or set to when needed, that
file is the checklist; otherwise the text you keep here is used. That file has one switch, on the "What to
check when it wakes" card beside the check-in; the check-in card says which list it is using and links to it. If there is no checklist file, the check-in still runs. If the
checklist has only blank lines, headings, comments or empty boxes, the model is not asked at all. The
assistant answers with the `heartbeat.respond` tool. That tool sits in the schedules toolbox, so ordinary
tasks do not carry it, and a check-in is told to load it. It has its own permission, `heartbeat.respond`,
which counts as look-only, so a check-in answers without asking even under "Ask before changes" or "Read only". `notify: false` sends nothing. `notify: true`
sends its text to `deliverTo` (a chat) or to the activity list. If the tool is not used, a reply of
exactly `NOTHING_NEW` counts as quiet, and any other reply is sent as the news.
With `secondOpinion` on, one short extra question decides whether the news is worth interrupting you;
if that question cannot be asked or read, the news is sent. Each check-in is recorded (quiet, notified,
held back, failed) in the setting `heartbeat-state`. News from a check-in is announced to webhooks
listening for `heartbeat.notify` (`runId`, `via`, `delivered`; the words themselves are not sent). A
short-lived key may read `/api/heartbeat` but not change, switch or start the check-in.

**Check scripts.** A task or check schedule may carry `gate: { executable, args, timeoutMs, maxMemoryMb,
maxCpuSeconds, network }`. The program must be named in full and is started with a list of arguments,
never through a shell, with an emptied environment and, unless `network` is true, proxy settings pointing
at a dead address. It must end its output with one line of JSON, `{"wakeAgent": true|false, "data": …}`.
The assistant is only woken when `wakeAgent` is true, and is handed `data` as material to work with. With
`scriptGates` off, a new schedule with a script is refused. An existing one waits, and its health badge
says why. When needed, the script runs only for repeating jobs, and a one-off job goes straight ahead. A
job with a script starts paused until you approve the script in Schedules (`POST
/api/schedules/:id/gate { approve }`, the app window only; a short-lived key is refused). The approval
covers that exact program, arguments and limits, so changing any of them asks again. A script that fails
waits 2, 4, 8, 16 minutes (at most an hour, never sooner than the job's own next turn) and after five
failures in a row the job is paused with the reason. Each failure is announced to webhooks listening for
`schedule.script_failed` (`scheduleId`, `failures`, `paused`, `retryAt`; what the script printed stays in
the app). A saved script that cannot be read pauses the job instead of running. "Run now" and webhooks skip the script.

**Checks send news only.** With `notifyGate` on, a `check` schedule sends its result only when it is
new. A reply that is exactly `NOTHING_NEW` after trimming (capital letters count), or the same result as
last time, is recorded (`delivery.held`) but not sent. An answer that merely contains the phrase is still
sent. A job's first failure is always sent, and so is its first success after failures ("working again").
Only repeats are held back. When needed, only checks that repeat more than once a day are held back.
With the switch off, every result is sent, as before. On a schedule, `notify: "always"` or
`notify: "changes"` overrides the switch whenever the switch is not off. A watch (`monitor.*`) whose page only changed in spacing or line order no longer announces.

**Health.** Each schedule, the check-in and each watch show healthy / failing / waiting / never run, with the run
count, the share of the last ten turns that worked, and the average time a turn took (`health` on
`schedules.list`, `monitor.list` and `GET /api/heartbeat`).

**macOS and Linux.** All of this is the same on every computer. A check script on a Mac or Linux gets
`PATH=/usr/bin:/bin` (so `test` and `grep` are found, but nothing you installed can be picked up by name)
and `TMPDIR`; on Windows it gets no search path, `SYSTEMROOT` and `TEMP`. Limits are held the way every
other command's are: by a Windows job where one can be made, and elsewhere by sampling memory and
processor time about once a second and stopping the whole process group. Waking a check-in early when a
background command finishes is not done yet.

## Follow-ups and background specialists

`POST /api/sessions/:id/followups { prompt }` queues a message for a busy conversation; queued messages run in order as soon as the current task finishes (`GET` lists them). `specialists.delegate` with `background: true` starts a child that keeps working after the parent finishes; the result stays on the child run and is recorded on the parent as `delegation.background_finished` and in `/api/state.background`.

## Backup, restore and health

`GET /api/backup` (Settings → Backup, `branch backup <file>`) exports every state table as plain rows; secrets are left out because their key never leaves the device. `POST /api/restore` or `branch restore <file>` loads a backup into a fresh install and refuses when the install already has state. `GET /api/health?probe=1` (Settings → Health check, `branch doctor --probe`) reports each dependency with a plain fix.

## Moving in from another assistant

Settings → **Bring things over from another assistant** (placed at `settings:data`) has a three-way switch, **Off** by default: off looks at nothing, offers nothing and refuses a preview; **When needed** looks only when you press *Look for other assistants* (or give a folder or file) and never offers on its own; **On** checks the usual places whenever the card is shown and adds a one-line offer to the first-run card ("Bring your chats and memory from …"). With the switch allowing it, the card reads what Claude Code, Codex CLI, Hermes Agent, OpenClaw or OpenCode left on this computer, or in a folder, `.zip`, `.tar` or `.tar.gz` copy of one, and shows it before anything changes. The owner ticks what to bring; each thing is brought on its own, and a refusal (full memory, a skill name already in use, a chat over 1000 messages or 4 MB) is reported in a sentence while the rest still come.

| What | Where it goes in Branch |
| --- | --- |
| Chats | Saved conversations, labelled `from <assistant>`. User and assistant words only: hidden reasoning, tool calls and tool output, side conversations and text the other assistant added itself are left out, and anything that looks like a key is blanked. |
| Projects (the folders chats were in) | A project `moved-<folder name>`. |
| Memory, `CLAUDE.md` / `AGENTS.md` / `SOUL.md` | Context files (`AGENTS`, `CLAUDE`, `GEMINI`, `SOUL`, `USER`, `IDENTITY`, `MEMORY`, `HEARTBEAT`, `TOOLS`, `SOP`) are written where the context-file loader (`src/context-files.ts`) reads them: `SOUL`, `IDENTITY` and `USER` in Branch's own folder, the rest in the workspace, under the loader's name for that file (`CLAUDE.md` and `GEMINI.md` become `AGENTS.md`). A file that already exists is added to under a line naming the assistant, never replaced, and the same text is never added twice; a link is never written through. Each file's switch is left as it was (off on a fresh install), and the receipt says so. A `MEMORY.md` from one of the other assistant's projects, and other notes, become saved facts (long text is split, at most 3800 characters each); instructions that are not context files become preferences. |
| Skills | Installed skills, reshaped to Branch's fields and checked by the skill scanner first; other files in the skill's folder stay behind. |
| Tool servers (MCP) | Kept under the card, ready to try under Settings → Sharing with other AI tools → Try a server, with the entry to paste into the connections file once its `tools` and `expectedVersion` (both shown by the try) are filled in. |
| Model choice | Shown as a suggestion when connecting a model. |

Keys and sign-ins are never copied: `auth.json`, `.credentials.json`, `credentials/` and database tables of sign-ins are not opened, and from `.env`, `env` blocks and server headers only the names are read, to list which keys to add under Settings → Secrets. A record per assistant (`settings` row `move-in:<assistant>`, included in backups) makes a second press bring nothing twice, and every import is written in the record of what the assistant was allowed to do as `data.imported`. Text that is kept (chats, memory, instructions) passes the leak guard and the sharing scrubber first. Databases (`state.db`, `openclaw-agent.sqlite`, `opencode.db`) are read from a private copy of at most 2 GB, never in place, and the copy is removed afterwards, also when reading fails. Archives are opened in memory with limits (128 MB packed, 512 MB and 50,000 entries unpacked); links, devices and names that climb out are skipped.

Routes: `GET`/`POST /api/move-in/switch { mode: "off" | "when-needed" | "on" }` (settings row `move-in-switch`), `GET /api/move-in[?look=1]` (what was found and the offer, as the switch allows), `POST /api/move-in/preview { source? , path? | archive?: { name, data (base64, up to 32 MB) } }`, `POST /api/move-in/import { …the same, items: [keys] }`, `GET /api/move-in/brought`. Owner only. `BRANCH_MOVE_IN_HOME` looks under another home folder (an old disk, say) instead of this one, and then ignores the assistants' own overrides.

**macOS and Linux.** The same places are searched on every system: `~/.claude` (or `CLAUDE_CONFIG_DIR`) with `~/.claude.json`, `~/.codex` (or `CODEX_HOME`) with `~/.agents/skills`, `~/.hermes` (or `HERMES_HOME`; `%LOCALAPPDATA%\hermes` on Windows), `~/.openclaw` (or `OPENCLAW_STATE_DIR`), and OpenCode's `~/.local/share/opencode` and `~/.config/opencode` (or `XDG_DATA_HOME` / `XDG_CONFIG_HOME`). Links inside those folders are never followed, and a path that climbs out of the chosen folder is refused.

## Undo and workspace history

Every `files.write` keeps the file's previous bytes and records a `file.changed` event with a line diff. Activity shows each change with **Show change** and **Undo this change** (`POST /api/history/restore { versionId }`); `GET /api/history/files?path=` lists kept versions; the model has `files.history` and `files.restore`. Whole-workspace snapshots: `POST /api/history/snapshots { label }`, `GET /api/history/snapshots`, `POST /api/history/snapshots/:id/restore` (Settings → Workspace snapshots, tool `workspace.snapshot`). Limits: 500 files, 256 KiB per file, 16 MB per snapshot; `node_modules`, `.git`, `dist`, `release` and secret-named files are skipped.

**Switches for these two (wave mac2).** Settings → *Working until done, and going back* (next to *Workspace snapshots*) (`GET|POST /api/goal-undo/settings { goal, snapshots }`, each `"off"`, `"on"` or `"when-needed"`, both `"off"` on a fresh install; sending one leaves the other as it was). Goal mode: off refuses to start or resume a goal; on shows a **Goal** button and takes `/goal`; when needed takes `/goal` typed in the message box but shows no button. Snapshots: off records nothing (going back then covers only the changes Branch made with its own file tools, and says so); on records the workspace as each task starts; when needed records it just before a task's first tool call that can change something (a call that only reads records nothing), once per task. A snapshot already kept can still be used after the switch is turned off.

**Going back to an earlier message (wave mac2).** Each of your messages has **Edit**. Change the words and choose what to take back to just before that message: **Conversation and files**, **Conversation only** or **Files only**; the new words are then sent as usual. **Undo that** (the button, or typing `undo that` on its own) puts the conversation and the files back the way they were before you went back; it works newest first, once per going-back, and also after the edited message has been answered (whatever was said since is set aside). To cover changes made by commands too, and folders that are not git repositories, the whole workspace is recorded for each of your tasks (when the snapshot switch above allows it), in a hidden store in the private data folder (`snapshots/`, one per workspace). It is a separate git directory used only with `--git-dir` and `--work-tree`, so your own repository is never read from or written to. It uses the git already on this computer; secret-looking names (`.env`, keys, `*credentials*`, `*secret*`), `node_modules`, `dist`, `release` and `.branch` are never copied — a secret-looking name stays out even if a `.gitignore` in the workspace lists it back in — and otherwise your `.gitignore` is respected. Your own global git settings (such as a global ignore file) are not used, and a `.gitattributes` in the workspace cannot change the bytes: every file comes back exactly as it was. A file over 50 MB is left out; a workspace with more than 100,000 files or more than 2 GB in all is not recorded at all. Going back gives every recorded file its recorded bytes and removes files that appeared since (never an ignored or excluded one). If git is not installed, or a snapshot fails (for example a workspace too large to record in time, after which snapshots stay off until Branch restarts), files come back from the per-file copies above and the answer says that changes made by commands were not covered. Nothing is taken back while a task in that conversation is still working. Routes: `GET|POST /api/sessions/:id/rewind { messageId, restore: "conversation"|"files"|"both" }`, `POST /api/sessions/:id/unrevert {}`.

**Working until a goal is met (wave mac2).** `/goal <what should be true when it is done> [--max n]` in the message box (the **Goal** button beside the conversation's *Still to do* list only fills in `/goal ` for you) keeps the conversation working in rounds. After each round a judge decides: the declared completion checks, if the goal has any (`checks`, the same shape as a run's), and a model grader asked, with no tools, for a score from 0 to 1, what is still missing, and whether it is blocked. A reply along the way does not end it; the next round is asked to carry on with what is missing. It stops when the score reaches 0.8 with no check failing (done), when the model starts its reply with `BLOCKED:` or the grader says it cannot go on, when the score has not improved for two rounds (blocked, so a stuck task does not use up every round), when a round fails or waits for your answer, or after `n` rounds (6 unless you say, at most 20). Each round is an ordinary task with the usual approvals and time limit. A strip at the top of the conversation's *Still to do* list (the Plan tab in the redesigned window) shows the round, the score, what is missing and the time worked (pauses not counted), with **Pause** (the round that is working finishes first), **Resume** and **Stop** (the round is cancelled). A goal that was working when Branch closed shows as paused and can be resumed. Routes: `POST /api/goals { objective, maxRounds?, sessionId?, checks? }`, `GET /api/sessions/:id/goal`, `POST /api/sessions/:id/goal { action: "pause"|"resume"|"stop" }`.

**macOS and Linux.** Both work the same on every computer: git is found on the search path (`which git`) and started with a list of arguments, never through a shell, with hooks switched off and no prompts. Line endings are stored exactly as they are (`core.autocrlf=false`), so a file comes back byte for byte on Windows, macOS and Linux alike; links inside the workspace are recorded as links. Tests run the real git only inside temporary folders.

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

### The learning core

Branch's learning core (`src/fly-core/`) is modelled on the fruit fly's mushroom body. It has a three-way switch, saved in `settings/fly-core` as `{ mode }`, and it ships **off**. Off means nothing runs and nothing is stored, not even an empty table. With `mode: "when-needed"`, finished tasks are still learned from, and the model is offered one short tool, `learning.suggest`, which it asks only when the work calls for it; the tool answers from the switch of the person whose task is asking, so someone who has it off is never read or written for. With `mode: "on"`, every task also has its suggestions worked out as it starts, written on the task as a `fly.suggested` event (`tools`, `skills`, `memories`, `avoid`), and **applied** through what Branch already has: the top tools join the tool loader's pre-load (still inside its hard budget), the top skills are listed first, and the top memories go first in a new conversation's memory snapshot. A tool the core says to avoid is only left out of the pre-load, never hidden, and a tool you switched off (such as the screen and keyboard) is never pre-loaded on its advice. Each piece that was applied is written as a `fly.applied` event and shown on the task's "Look inside" screen as one line ("Chose these tools first because they worked before in similar tasks: …"). Temporary conversations are never learned from.

**Where you set it.** Library → Memory has a card, "What Branch learns from experience", with the switch (it saves as it moves), what Branch has learned in plain words (each tool, skill or note with how many tasks that rests on and whether they mostly went well), and **Forget what it learned**, which asks first and clears every `fly_*` row for you, the wiring seed included. The routes are `GET /api/learning-core`, `POST /api/learning-core/settings { mode }` and `POST /api/learning-core/forget { confirm: "forget" }`. A short-lived key can read the first but not use the other two. From code: `app.learningCore.settings()`, `configure({ mode })`, `view()` and `forget()`.

When a task ends, the core learns from how it went: finished or failed, checks passed or failed, what it cost, and whether your next message in the same conversation corrected it (the same openings `src/memory-learning.ts` recognises). That is written as `fly.learned`, with the reasons in plain words. When the same steps keep working for the same kind of request, the idea of making them a skill appears in the suggestions queue above, marked `learned.signal: "learning-core"` with the steps as its evidence. Accepting it opens the skill editor (Customize → Skills) on a draft written from those steps; nothing is installed until you install it. The core needs no model call and keeps no words from your requests, only the names of the tools, skills and memories involved. It lives in the `fly_*` tables of the same database and is part of the backup: restoring replaces a person's learning whole, and never leaves a trace pointing at a task that is not in the backup.

**Limits.** At most 5,000 actions per person, and at most 120 learned synapses on each side of an action (the faintest go first), which keeps the tables under about 10 MB at the cap (measured: 9.97 MB). What a task start needs is kept ready in memory (built once after launch; worked out at about 12 MB at the cap, up to twice that while its lists grow, not measured), so working out the advice takes well under a millisecond of processor time even at the cap. How well it learns, and how that is measured on real work (`experiments/fly-core/real-eval.mjs`), is in `experiments/fly-core/PLAN.md`.

**macOS and Linux.** The learning core is plain TypeScript over the built-in SQLite and works the same on Windows, macOS and Linux; it starts no program and asks the computer for nothing. Its timings are measured as the task's own processor time, because the build machines are shared.

### Looking back and writing new skills

Two switches, both saved in `settings/reflection` and both shipped **off** (`src/reflection/`). `GET /api/reflection` answers with the switches, the recent looks back, the skills the assistant wrote and the last background outcomes; `POST /api/reflection/settings` changes any of `reflection`, `everyTurns`, `newSkills` and `retireAfterDays`. Only the owner's profile may change them. From code, `app.learningLoop` does the same. The cards are in Library → Memory ("Looking back over conversations") and Customize → Skills ("Skills your assistant wrote").

- `reflection` (`off`, `when-needed`, `on`). With `on`, once `everyTurns` of your turns (5–500, default 25) have passed in a conversation, and whenever a long conversation is shortened, the assistant rereads only the turns since its last look, beside what it remembers and which skills are on, and asks the model once, with no tools, for corrections, merges, facts to set aside and notes on skills. With `when-needed` it looks only when a conversation is shortened, or when you press *Look back now* (`POST /api/reflection/look-back { sessionId? }`). Every answer is a suggestion in the usual queue, grouped as one batch; a suggestion naming a fact or skill it was not shown, or reading like an order slipped in from outside, is dropped. `POST /api/reflection/batches/:id/accept|reject` decides a whole batch. Temporary conversations are never read.
- `newSkills` (`off`, `when-needed`, `on`). With `when-needed` a skill is drafted only when asked: typing `/learn` (with anything to add after it) in a conversation, `POST /api/reflection/learn { sessionId, notes? }`, or accepting a skill idea from the learning core. The assistant also has one short tool, `skills.learn` (`skills.manage`), for the same request in plain words. With `on` it may also draft after a finished task that used three or more different tools without a skill (once per conversation), and a look back may suggest skill ideas. A draft is installed switched off, tried as a practice run on the task it came from and up to two like it, once without any skill and once with it, and waits: `POST /api/reflection/new-skills/try|accept|reject { skillId }`. Keeping one that was not tried, or did worse, needs `force: true` with the words shown in the app, and is written to the record. Throwing one away removes it, since nothing used it.
- Accepting a **skill note** in the queue now changes the skill: a note on an installed skill is written into a new, switched-off version, tried on the last tasks that used the skill, and listed under *Suggested better versions* with its diff, where a second yes switches it on. A skill idea with no skill becomes a new-skill draft as above, and is only noted while `newSkills` is `off`.
- `retireAfterDays` (7–365, default 60). *Look for skills nobody uses* (`POST /api/reflection/retire`) offers to set aside each switched-on skill that no task has read in that time, once. It looks at the last 100 tasks only and says so; when those go back less far than the setting, it offers nothing. A skill a schedule names is left alone. Accepting switches the skill off; it stays installed.

**macOS and Linux.** All of this is plain TypeScript over the built-in SQLite, with no program started, and works the same on Windows, macOS and Linux.

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

**Two ways to connect.** Over HTTP, at `/mcp` on the same port as the web interface: JSON-RPC 2.0 by `POST`, with your session key as `Authorization: Bearer …`. If you send no `Mcp-Session-Id`, the reply to your first message names one in an `Mcp-Session-Id` header; send it back on everything afterwards and your work is kept together. `DELETE` ends that conversation (204). A plain `GET` is refused (405), but a `GET` that asks for `text/event-stream` opens a stream Branch writes down when something changes on this side — see **Streaming** below. Responses carry `MCP-Protocol-Version`. Branch speaks `2025-06-18`, `2025-03-26` and `2024-11-05`; ask for anything else and you get a plain error saying which ones work. Or as a child program: `branch mcp-serve` speaks newline-delimited JSON-RPC on standard input and output, writes every message for a person to standard error, and stops cleanly when the other tool closes the connection.

**What Branch says it can do.** `initialize` answers with `tools: { listChanged: true }`, `resources: { subscribe: true, listChanged: true }`, `prompts: { listChanged: true }` and `logging: {}`. `logging/setLevel` is accepted and remembered for that connection.

**Streaming.** A `GET /mcp` with `Accept: text/event-stream` stays open and carries messages that expect no reply, each as `event: message` with the JSON-RPC notification as its data. Two things travel down it. `notifications/tools/list_changed` goes to every open stream whenever the set of tools changes — a skill loaded, a plugin added or removed, another server's tools arriving — so a connected tool never goes on calling something that is no longer there. `notifications/resources/updated` goes only to a connection that asked for it with `resources/subscribe`, naming the resource: subscribe to `runs://recent` to be told whenever a task finishes, or to `run://<id>` for one in particular. `resources/unsubscribe` stops it, and one connection may watch fifty things at most.

Use HTTP when Branch is already open — that is what the Claude Code and Cursor snippets do. `mcp-serve` starts a second copy of Branch against the same records, so close the app first; the snippet sets `BRANCH_DATA_DIR` and `BRANCH_WORKSPACE` for the child, because it inherits the other tool's working directory rather than Branch's.

**Resources.** `memory://facts` (what Branch remembers), `workspace://files` (the workspace listing) and `documents://library` (documents Branch has read) as JSON; `runs://recent` (the twenty most recent tasks) and `run://<id>` for one of them; the twenty most recent saved conversations as `conversation://<id>`, named after their first message and dated; and `policy://hidden-tools`, the note described under **What is offered** below. Reading a conversation returns the transcript as plain `role: text` lines in the order they were said, read-only: the most recent messages are kept and older ones dropped once the text passes 64 KiB. Temporary conversations are never listed, and a conversation belonging to someone else is not found.

Every resource is read-only, and each one is scoped by your approval settings. A resource is shown only when your settings would allow the tool that reads the same thing: `memory://facts` follows `memory.search`, `workspace://files` follows `files.list`, `documents://library` follows `documents.search`, and everything to do with tasks and conversations follows `history.search`. If your settings refuse one of those, the resource is not listed and reading it by name answers "unknown resource" — a connected tool cannot tell the difference between something you have hidden and something that was never there.

**What is offered, and what is held back.** When a tool connects, every tool you share is checked against your approval settings before any of them is offered. A tool your settings flatly refuse is not offered at all. A tool your settings want you asked about *is* still offered, because with an approval setting chosen almost everything that changes something becomes a question, and hiding all of those would leave the other tool looking at an empty toolbox — instead the call is stopped at the moment it is made, with a message saying it needs your yes here in Branch. The `policy://hidden-tools` resource says which tools are in which group and why, in plain sentences, and **Settings → Sharing with other AI tools → What another tool is offered** shows the same thing.

**Saying what a call would do, without doing it.** Send `tools/call` with `_meta: { dryRun: true }`, or call the `mcp.dry_run` tool with `{ name, arguments }`. Either way nothing is run, nothing is written and no web address is opened; what comes back says which tool, what it would touch, which files and which hosts the arguments name, whether it changes anything, what your settings would decide, what it would cost and one sentence on what would happen. Branch's own tools run on this computer and cost nothing; only `branch.ask` goes to a model, and then at whatever your chosen model charges.

**Writing down what you were shown.** Call the `mcp.snapshot` tool with `{ action: "record" }` and Branch keeps the exact tool list and every schema in it, with a sha-256 fingerprint, against that connection. `{ action: "compare" }` checks a saved record against what is on offer now and says what was added, what has gone and what has changed; `{ action: "list" }` shows the records. The fingerprint changes the moment a single word of a description or a schema does, so a later disagreement about what was on offer can be settled. `GET /api/mcp/snapshots` shows the same records; the last fifty are kept.

`mcp.dry_run` and `mcp.snapshot` appear in the tool list only while sharing is switched on.

**Prompts.** Your saved procedures and recipes, listed as `procedure:<id>` with the procedure's name and the blanks it takes — each named input becomes an argument, marked as needed or not. `prompts/get` fills them in; leaving out a needed one is refused by name rather than quietly running with a gap.

**What is recorded.** Every `tools/call` becomes a task of its own, named "Another AI tool used …", with `run.started`, `tool.started` and `tool.completed`/`tool.failed` events carrying `source: "mcp"` and the same signed receipt as local work. They appear in Activity and under `GET /api/runs/:id/receipts`. At most four shared calls run at once and one connection may make 100 in total.

**Signing in.** Branch accepts the session key the app already shows you, as `Authorization: Bearer …` — the same key the web interface uses. **Branch is not an authorization server.** It does not issue keys of its own, it has no sign-in page for other programs, and it does not let a program register itself at Branch's door. If a tool asks you for a client id and secret for Branch, there is none; paste the session key from **Settings → Sharing with other AI tools** instead. That key is private: anyone holding it can use Branch as you.

**What is shared over MCP, and what is not.**

| On offer | Not on offer |
| --- | --- |
| `branch.ask` — asking Branch for something in plain words | Any tool you have not ticked in the shared list |
| Every tool you tick, minus the ones your approval settings flatly refuse | Anything your approval settings refuse |
| `mcp.dry_run` and `mcp.snapshot`, while sharing is on | Your saved passwords and keys, in any form |
| Reading memory, the workspace listing, documents, tasks and conversations | Writing to any of those through a resource — resources are read-only |
| Your saved procedures as prompts, with their blanks | The owner-only parts of the app: projects, profiles, settings |
| A plain note saying what was held back and why | Sampling: Branch never asks a connected tool to run a model for it |

**Routes.** `GET /api/mcp/settings` returns `{ enabled, exposedTools, a2a, tools }`, where each tool carries `name`, `description`, `permission` and `changesThings`; `POST` the same `{ enabled, exposedTools, a2a }` to save it (unknown tool names are dropped). `GET /api/mcp/connection` returns this server's own address and key, the stdio command for this install, and the three configuration snippets. `GET /api/mcp/preflight` returns `{ allowed, hidden, explanation, tools }` — what a connection would be offered, what is held back, and the note in plain sentences. `GET /api/mcp/snapshots` lists the records of tool lists other tools were shown.

## Connecting MCP servers

Branch can also be the one asking: somebody else's MCP server becomes tools Branch may use. There are two ways in.

**Servers you set up once.** Put them in the connections file named by `BRANCH_INTEGRATIONS`, under `mcp`, exactly as described in **MCP tools** above: the server's address or the command that starts it, the version you expect, and the names of the tools you want. Nothing is guessed, and a tool the server starts advertising later is never granted.

**Trying one first.** **Settings → Sharing with other AI tools → Try a server** takes a web address (`https://…`, or `http://` on this computer) or the command that starts a server, asks it what it offers, and draws a form from the shape each tool describes. Fill it in, run the tool once, and see exactly what came back. Nothing is registered and nothing is kept: the connection is opened for the try and closed again. Every try is written into the record of what the assistant was allowed to do, as **You tried out another AI tool's server**, with the server, the tool and how it ended. `POST /api/mcp/try` takes `{ server: { transport: "http", url } | { transport: "stdio", command, args }, call?: { name, arguments } }`.

**When connections open and close.** A server named in the connections file can be started in one of two ways, and `connect` decides which. **`"startup"`** — what has always happened, and still what you get unless you change it — opens every configured server as Branch starts, because that is when Branch asks each one what tools it offers. **`"on-demand"`** lists a server's tools from what that server said the last time it was connected and starts nothing; the connection is made the first time a task really calls one of them, and the list is written down again as soon as it is. Either way the tools are searchable and callable from the first moment, which is the point — a tool that is not in the list might as well not exist. A server set up on demand that has never been connected has no list to show, so it is connected once; after that, every launch starts nothing. In **Settings → Connections**, a server that is set up but not started says **"Set up, not connected yet. It starts the first time a task needs it."**

The rest of these settings govern a connection once it is open: an unused one can be kept for a few minutes in case the next task wants it; there is a cap on how many servers may be connected at once, and at the cap Branch closes the oldest one nobody is using and refuses the new one only when every open server is busy; a server that will not answer is tried again with a growing wait before Branch gives up with a plain reason. `GET /api/mcp/connections` returns `{ settings, servers, known }`; `POST` it `{ connect, keepWarmMinutes, maxConcurrentServers, reconnectAttempts }` to change the settings, and anything you leave out keeps its value. Where several people share this computer, each profile keeps its own settings.

**Servers that need a sign-in.** Some servers do not hand out keys by hand. Branch reads what the server publishes at `/.well-known/oauth-authorization-server` (or `/.well-known/openid-configuration`), asks it for an identity of its own if it allows that (dynamic client registration), and then runs the ordinary sign-in in your own browser with a proof key (PKCE, `S256`). The key that comes back goes straight into the locker and the identity is remembered, so signing in again does not register a second time. Every address is checked by the network policy first, and the key never appears in a log, an event, the audit record or a message. A server that publishes no sign-in details, or one that needs a sign-in but will not let a program register itself, is refused with a sentence saying so.

One detail to know about: Branch registers its callback as `http://127.0.0.1/oauth/callback`, without a port, because the sign-in picks a free port on this computer at the moment you sign in and that port is different every time. This relies on the usual allowance for a program running on your own computer, where any port on the loopback address counts as the same callback. A server that insists on the exact port instead will refuse the sign-in; there is nothing you can set to work around that, and such a server has to be given a key by hand through `bearerEnv` in the connections file.

**Pages a server sends.** A server may answer with a small page meant for you to look at — a form, a picker, a chart. Branch will show one, in a frame that can do almost nothing: it is served from Branch's own address with `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`. `sandbox` with nothing after it gives the page an origin of its own and stops scripts running at all; `default-src 'none'` refuses every fetch, picture, font and frame it might still ask for. Branch also takes out the tags the frame would refuse anyway — scripts, frames, forms, `javascript:` addresses and `on…` handlers — so what you see is the page that was meant rather than a broken half of one. The page's address is a one-time unguessable name that stops working after five minutes, because a frame cannot carry your session key. `POST /api/mcp/app` with `{ server, uri, html }` returns `{ url }`.

**What Branch will not do as a client.** It will not send your saved passwords or keys to a server they were not configured for; a configured key that comes back inside a server's own answer means that answer is not shown at all. It will not follow a redirect. It will not accept an answer over 1 MiB or a tool schema over 64 KiB. And it never grants a tool that appeared later: what is granted is what you named.

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

**Approving and editing a plan.** With `planApproval` on, the task stops with status `needs_input` and the plan as its question (`plan.awaiting_approval`), the same way a question from the assistant does. `GET /api/runs/:id/plan` returns the plan; `POST /api/runs/:id/plan { steps }` replaces the steps and marks it approved (`plan.approved`); saying "go ahead" in the conversation also approves it. Your next message then carries it out. A plan being carried out by a task that stops early is dropped, so the next thing you ask is never answered by an abandoned plan, and a plan you were shown but walked away from is dropped as soon as you ask for something else. If the assistant stops in the middle of a plan made this way to ask you something — an approval rule, for instance — the rest of the plan is not picked up again: your answer carries the conversation on as an ordinary task. A plan made in "Show me the plan first" mode is kept instead, and picked up where it stopped; see the next section.

## Plan first, show me the plan, then act

Asking about one tool call at a time is not the same as agreeing what is going to happen. This section is the other way round: you see the whole plan in plain words, change a step if you want to, and only then does anything run.

**The two modes.** `GET|POST /api/plan-act` holds `planMode` — `just-do-it` (what Branch has always done, and still the default) or `show-plan` (make a plan, show it, and wait) — and `autonomy`, which says how far a task carrying out an agreed plan may go before it checks back: `every-step`, `changes-only` (only steps that change something) or `at-the-end` (the default: not until the whole plan is done). Both live per conversation **and** per project: `POST /api/plan-act { sessionId, planMode }` sets one conversation, `POST /api/plan-act { scope: "project", planMode }` sets what every new conversation in the project starts from, and `{ sessionId, followProject: true }` puts a conversation back on the project's choice. A conversation's own choice always wins. The switch is in the conversation itself, beside the model picker, not in Settings.

**What a plan says.** In `show-plan` mode the first round of the model produces two to six numbered steps in plain words. Each step carries `title` (what it will do), `touches` (the one file, website or program it uses) and `changes` (whether it changes anything; a step that does not say is taken to change something). The plan is stored with the task — run id, conversation, the prompt it was made for, the mode and the autonomy setting — and shown with one sentence naming which steps change something. Events: `plan.created` and `plan.awaiting_approval` carry the titles, what each step touches, which of them change something, and that one sentence.

**Agreeing it.** The task stops with status `needs_input` and the plan as its question. `POST /api/runs/:id/plan {}` agrees to it as it stands; `POST /api/runs/:id/plan { steps }` agrees to it with the wording you changed, and the changed wording is what runs; `POST /api/runs/:id/plan { decision: "reject", reason }` sends it back, and the model is asked for another plan straight away with your reason in front of it. Saying "go ahead" in the conversation also agrees to it. Nothing that changes anything runs before you have agreed. Events: `plan.approved`, `plan.rejected`, `plan.decided`. Every answer is written into the record of what the assistant was allowed to do, against the task, with the numbered plan, the autonomy setting and who answered.

**Following it.** Each step shows as waiting, doing, done or failed against the plan you agreed (`plan.step.started`, `plan.step.finished`). With `autonomy` set to `every-step` or `changes-only`, the task stops before the next step and says which one is coming (`plan.check_back`); your "go ahead" carries it on from exactly there. And if a step that said it would change nothing turns out to need something that does, the task stops and names the difference rather than quietly doing it (`plan.off_plan`), through the same question card as every other approval.

**Debugging a command.** When a command does not work — it failed, or it came back with a complaint — and the assistant then wants to run the same program again, you are shown both commands and what changed between them before anything runs (`command.correction`). You are asked once per command, so agreeing lets the corrected one through.

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

`research.run` takes a question, a depth (`quick`, `standard` or `deep`) and optionally the addresses to read. Quick runs one search and reads up to two pages; standard three searches and six pages; deep six and twelve. Each page is fetched under the same network policy as the rest of web reading, and page text is treated as information, never instructions. The sentences that speak to the question are kept with the address and title they came from. When a page cannot be read that way, or comes back almost empty because a script builds it, and a browser is set up that this task may use (`browser.read`), the page is opened in that browser and its text is read instead (`research.browser` in the log). The browser keeps its own list of allowed sites and the same network rules, so this reaches nothing a browser task could not (A2128).

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
what was learned about them is deleted. Forgetting one conversation forgets what it taught as well:
when you clear a conversation's facts, or throw away a temporary one, its line goes with it.

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

**What is deliberately not here.** The assistant does not make videos, and on its own it cannot pull still frames out of one: that needs a video decoder this app does not ship. With your own ffmpeg and the switch below turned on, it can (see *Watching and saving videos*). `media.info` exists so it can still reason about a video's length and shape. Sound editing is limited to trimming uncompressed WAV.

Reading a file is `media.read` and counts as looking, not changing; making a picture, speaking and trimming are `media.write` and are held to your approval rules like any other change. Each of those tools tells the approval rules the workspace path it would write (`media/poster.png`), so a rule about that folder fires on the path the file really gets rather than the bare name that was asked for. Every result is signed by the ordinary tool receipt, so what was made and where it was saved can be checked afterwards. A practice run reports what it would have made without calling the provider.

### Watching and saving videos (bucket 17)

**Settings → Models → Pictures and sound → Watching and saving videos** lets the assistant understand a video rather than only read its headers, using two programs you may already have: **ffmpeg** and **yt-dlp**. Branch never downloads or installs either; leave a place empty and it looks on this computer's search path, or give the full place (for example `/opt/homebrew/bin/ffmpeg`). The card says where each one was found, or why not. The switch has three positions and ships **off**: off (every tool below refuses in one sentence and is not offered to the model), when needed (offered when the work calls for it), or on (offered from the first step). API: `GET|POST /api/media/programs` (a short-lived key cannot change it).

- **Attach a video in the message box.** The picture button now takes video files (up to 32 MB). ffmpeg takes up to four still pictures spread evenly across it (at most 768 pixels wide) and the sound as a small WAV file; the pictures ride with your next message like any attached picture, and what is said is written out through your **Settings → Voice** choices and put in the message box. "Keep audio on this computer" still holds. API: `POST /api/media/understand` with the video as the body.
- `media.watch` — the same for a video or sound file in your workspace: the pictures and the words go to the connected model, which says what happens and answers your question. What is said or written in a video is treated as untrusted data.
- `media.frames` — keep up to four still pictures from a video with the task.
- `media.convert` — turn any video or sound file into WAV or MP3 in the media folder (so `media.trim` can then cut it).
- `media.download` — save a video, or only its sound, from a web page into the media folder, up to the size limit on the card (200 MB by default).
- `media.captions` — read what is said in an online video (YouTube and most video sites) from its captions, in the language you name, without saving the video.

Every program is started with a list of arguments, never a shell line. ffmpeg is only allowed its readers for ordinary video and sound files (`-format_whitelist`) and plain files (`-protocol_whitelist file`), and the private copy it reads keeps only a known video or sound ending: a playlist (`.m3u8`) dressed as a video would otherwise make it open other files named inside it. yt-dlp always gets `--ignore-config` (no settings file can add a command to run afterwards), `--no-plugin-dirs` (no plug-in from your home or Python folders is loaded; this needs yt-dlp from February 2025 or later), `--no-remote-components` (no code is fetched from the web), `--no-cache-dir`, `--use-extractors default,-generic` (only yt-dlp's own site readers; a bare link to a video file on an unknown site is turned down with "No suitable extractor") and `--` before the address (an address can never be read as an option). It never gets `--netrc`, cookies or `--exec`. Only `http` and `https` addresses without a name or password are accepted, and the address is checked against the network policy before yt-dlp starts. **What the network policy does not cover:** yt-dlp then makes its own connections — redirects, the site's video servers — and the policy cannot follow those hop by hop, so an allowed or blocked list only governs the address you give. Downloads land in a private temporary folder first; `--max-filesize` only works when the site says the size in advance, so the file is measured again before it is kept, and every program is stopped after five minutes. Tests use a stand-in for both programs; the ffmpeg lists were also run once by hand with ffmpeg 8.1 on the owner's Mac against a generated four-second clip (four pictures, the sound, WAV and MP3 all came out), and every yt-dlp option was checked against yt-dlp 2026.07.04's own help. Nothing was downloaded.

**macOS and Linux.** `brew install ffmpeg yt-dlp` on a Mac, or the distribution's own packages on Linux; Windows looks for `ffmpeg.exe` and `yt-dlp.exe`.

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
- `git.write` — `git.branch` (list, start or switch a line of work), `git.commit` (save a version; a message is required, it saves everything that changed unless you name paths, it refuses when nothing has changed, and it never rewrites a version you already saved), `git.worktree_add` and `git.worktree_remove` (a parallel copy for an experiment, only ever inside `.branch-worktrees` in the repository, so experiments cannot spread elsewhere; `git.worktree_list` reads them and needs only `git.read`). Both groups are available as soon as Branch starts.
- `git.remote` — `git.push` and `git.pull`. **These are off until you turn them on.** Add a `git` block to the integrations file:

```json
{ "git": { "remote": true } }
```

Sending work to the branch everyone shares (`main` or `master`) stops and asks you first, in the same way the assistant asks any other question; answer yes and it goes ahead. Pulling only ever adds work cleanly on top of yours; it never merges over the top of your changes. A message that arrives from a chat app (Telegram) can read and change the copy on this computer but can never push or use GitHub.

**GitHub** needs a personal access token that you create on GitHub and paste in yourself. Save it in **Settings → Projects → Secrets** of the project you want it in, under the name `GITHUB_TOKEN` (secrets use environment-style names, so this is the stored name for what the GitHub API calls a token). Then switch GitHub on in the integrations file:

```json
{ "git": { "remote": true, "github": { "tokenSecret": "GITHUB_TOKEN" } } }
```

That registers `github.create_repo` (private unless you say otherwise), `github.open_pull_request`, `github.create_issue`, `github.issues` (listing them), `github.checks` (whether the automatic checks passed on a branch or a saved version, said in plain words), `github.release` (the releases published, newest first) and `github.publish_repo`, all behind the `github.manage` permission. `github.publish_repo` makes the repository and sends a folder there in one step; it writes the address as a plain remote with no sign-in details in it, so the push uses the Git sign-in this computer already has and no token is ever written into the repository's settings. You are asked before anything leaves the computer.

**GitLab** can be read in the same way, with its own token saved as `GITLAB_TOKEN`:

```json
{ "git": { "gitlab": { "tokenSecret": "GITLAB_TOKEN" } } }
```

That registers `gitlab.issues`, `gitlab.releases` and `gitlab.pipelines` behind `gitlab.read`. Reading only: GitLab's endpoints for changing things are shaped differently enough from GitHub's that offering half of them would mislead you about what Branch can actually do. The token is read from whichever project is active at the moment of the call, is sent only in the request header, is never written into a web address, and is scrubbed out of anything reported back — it cannot appear in Activity, in a receipt, or in an error message. Every GitHub address goes through the same network policy as web reading, so an address that is blocked there is refused here too. Nothing is installed on your account; your own GitHub App can be used instead of a token (below).

**Your own GitHub App instead of a personal token (A2227).** Save the app's private key (the `.pem`
GitHub gave you) in your secrets, then name it, the app number and the installation number:

```json
{ "git": { "github": {}, "githubApp": { "mode": "on", "appId": "123456", "privateKeySecret": "GITHUB_APP_PRIVATE_KEY", "installationId": "7890" } } }
```

- `"off"` (the default) uses the personal token exactly as before.
- `"when-needed"` uses the app when all three details are saved, and the personal token otherwise.
- `"on"` always uses the app, and says plainly when a detail is missing.

When the app is in use, Branch signs a short-lived app token with the key (valid nine minutes) and
exchanges it at `<apiBase>/app/installations/<id>/access_tokens` for an installation token. That
token is kept in memory until five minutes before it expires. The key is read from the locker only
at that moment. It is never written into the settings, a log or an error, and an error from GitHub
is scrubbed of both the key and the signed token. The exchange goes through the same network rules
as everything else. If the app fails, Branch says why instead of quietly using your personal token.

**Issues from GitLab and Jira (A0174).** Pasting a GitLab issue address
(`https://gitlab.example.org/group/project/-/issues/12`) or a Jira one
(`https://acme.atlassian.net/browse/SHOP-12`) now brings that issue in, the same way a GitHub or
Linear address does. You get the title, the description and up to 20 comments, quoted with a note
that other people wrote them, and put through the same instruction check as a web page. Both are
read only and off until named:

```json
{ "git": { "gitlab": { "apiBase": "https://gitlab.example.org/api/v4", "tokenSecret": "GITLAB_TOKEN" } },
  "issues": { "gitlab": true, "jira": { "site": "acme", "emailSecret": "JIRA_EMAIL", "tokenSecret": "JIRA_API_TOKEN" } } }
```

- Your GitLab key is only ever sent to your own GitLab (the host of `apiBase`), and your Jira
  sign-in only to your own site. An address on any other server is not read.
- The Jira sign-in is an email and an API token from the locker, sent only in the request header.
- `issues.get` also takes a bare key such as `SHOP-12`. It is Jira's when Jira is set up and Linear
  is not.
- In ordinary text, only full addresses count, so words such as `UTF-8` are never taken for issues.

**A pull request from a task's changes (A0300).** **Settings → Advanced → Developer → Pull requests
from changes** has the three-way switch, off by default:

- **When asked** offers `github.pull_request_from_changes` while GitHub is set up. The tool puts the
  changed files on a new branch called `branch/<name>`, sends that branch with this computer's own
  Git sign-in, and opens a **draft** pull request. An issue named in the summary is linked.
- **After every task that changed files** does the same by itself when a task finishes well. It
  takes only the files that task changed, on `branch/task-<id>`. Tools you press by hand and saves
  from the code editor do not count as tasks.

It never sends anywhere else:

- The branch is always a new `branch/…` one. It is never the base, never the remote's default branch,
  and never a name such as main, master, develop, trunk or release/…. The push names that one branch
  explicitly.
- The remote must be on GitHub, and an address that carries a password or token is refused.
- The repository address is checked against the network rules before anything is sent.
- The pull request is opened through the saved GitHub tools, whose token comes from the locker at
  the moment of the call.
- A short-lived key can neither use the tool nor change the switch. A task started with one is never
  sent (the task's log says so).
- Every attempt that stops is written to the task's log as `pull_request.failed` with the reason. A
  success is written as `pull_request.opened`.
- The workspace is left on the new branch afterwards.

Integration review (mac4/bucket-18): each file goes through the same checks as the assistant's own
file tools before it is sent: secret-looking names (`.env`, keys), anything `.branchignore` hides,
links, folders and Branch's own saved work and keys are left out. Names are taken literally (`*` is
a file called `*`), and only the named files are committed, whatever else was already staged. Every
push address of the remote must be the same GitHub repository. A task records where it came from
when it starts, so "after every task" only sends the owner's own tasks that were allowed to
publish: never a task a short-lived key started (nor its follow-ups, queued tasks, specialists or a
continued task), never a schedule's, a trigger's or another program's, never a chat app's, and
never a specialist's part on its own.

Routes: `GET/POST /api/developer/pull-requests`. Asserted in `tests/pr-hook.test.mjs`.

**Hiding files from the assistant: `.branchignore`.** Put a file called `.branchignore` in the workspace root and list anything you would rather the assistant did not read, using the same syntax as `.gitignore` (one pattern per line, `#` for a comment, a trailing `/` for folders only, `!` to un-hide, `*` and `?` inside one name, `**` across folders). Files it hides disappear from `files.read`, `files.list` and `files.search`, a hidden folder can no longer be used as the working folder of a host command, and the Git tools respect it too: hidden files are left out of `git.status`, out of `git.diff`, and are never staged by `git.commit`.

Precedence, in order: the fixed secret patterns come first and cannot be overridden — `.env` files, `.ssh`, `.aws`, `.git`, anything named like credentials or secrets, and key files (`.pem`, `.key`, `.p12`, `.pfx`) are always refused, and a `!` line in `.branchignore` does **not** bring them back. `.branchignore` then hides more on top of that. Nothing inside a hidden folder can be un-hidden. The file is re-read whenever you change it, so there is nothing to restart.

## For coders

Everything in this section is for people who write software. None of it is switched on by default,
and none of it downloads anything: where a program is needed, it is one you already have.

**A map of the project (`code.map`).** Ask for the map and you get every file Branch may read, its
size, what kind of file it is, the names it declares, and which other files it pulls in.
TypeScript, JavaScript, Python, Go, Rust, Java, C# and Markdown headings each have a reader of
their own, and relative TypeScript, JavaScript and Python imports are resolved into real paths, so
the map carries a picture of how the project hangs together and not just a list.

Say plainly what this is: **the names are found by a light reader, not a parser** (`src/code-tags.ts`).
It sets comments and strings aside first, so a name inside a comment or a string does not count and
a declaration spread over lines keeps its line number. It then recognises declarations line by line,
including methods and what they sit inside, for TypeScript, JavaScript, Python, Ruby, Go, Rust,
Java, C#, Kotlin, Swift, Scala, PHP, C and C++, and counts every other name as a use. It cannot
understand a computed name or tell two things with the same name apart. When you need certainty
rather than a map, use a language server (below).

**A ranked outline in a token budget (A0334), the way Aider's repository map works.** Give
`code.map` a `tokens` budget (100 to 16,000) and you get an outline instead of a list: file names,
then the lines that declare the project's most important names, each under the class or block it
sits in, with `⋮` where lines were skipped.

- **How "important" is decided.** Every file that uses a name another file declares points at that
  file. Long, specific names count ten times, a name the request spelled out counts ten times, and
  names starting with `_` or declared in more than five files count a tenth. A personalised
  PageRank over those links, started from the files the request is about, decides which files
  matter. Each file's share then goes to the names it uses.
- **Fitting the budget.** The longest run of that order that fits is found by halving.
- **Files you already have.** Name them in `focus`: they steer the ranking and are left out.
- **Always first.** A project's README, `package.json` and similar files are named first.
- **Without a request.** The same ranking now also orders the plain `request` answer, so files
  joined only by use, such as Go or Java files with no import lines to follow, are lifted together.
- **In front of a task.** Set `repositoryOutlineTokens` (with `repositoryContext` on) and the
  project context puts this outline in front of a task instead of the list of file names.

This needs nothing installed: Aider uses tree-sitter grammars (native or WebAssembly packages for
each language), and Branch keeps to its no-new-dependency rule.

**Checking a file still reads (A0537).** `files.validate` now also checks TypeScript with Node's
own type reader. A missing brace or a broken type is reported with its line, without the TypeScript
compiler. The few forms that reader does not cover (enums, namespaces) and TSX get the bracket check
and say so. Python, Go, Rust, Java, C#, C, C++, Ruby, Kotlin, Swift, Scala and PHP get a bracket
check that ignores comments and strings: every `(`, `[` and `{` must be closed in order, and the
first ones that are not are named with their lines. JSON and JavaScript are checked as before.

Give `code.map` a `request` — what you are actually looking for, in your own words — and the answer
comes back ordered: the files whose path or declared names match come first, and a file those files
pull in (or that pulls them in) is lifted alongside, because the answer is very often next door.
The coder specialist style is told to start there, so it reads two files rather than twenty. The map
is built once and then kept up to date file by file: a file whose size and time of last change have
not moved is never read again. `.branchignore` and `.gitignore` are respected, as everywhere else.

**Language servers (Settings → Developer → Help with code).** A language server is the program a
code editor uses to underline mistakes, jump to where something is defined, and rename a name
everywhere at once. If you have one installed — `typescript-language-server`, `pyright`, `pylsp`,
`gopls`, `rust-analyzer` — name it here and Branch will talk to it. Give the short name you want to
call it, the **full address of the program** (a `.cmd` or `.bat` wrapper is refused; name the real
program), and the kinds of file it handles. Nothing is downloaded and nothing starts until you tick
the switch. That turns on `code.diagnostics`, `code.definition`, `code.references`, `code.hover` and
`code.rename`. The first four only look at things. `code.rename` works out the whole change across
every file first and then goes through the same gate as any other multi-file change: you are shown
which files it touches, they all change or none of them do, and each keeps its previous bytes so a
rename can be put back. Each server runs under the same limits as every other program Branch
starts, and all of them stop when the app closes.

**Debuggers.** Same screen, same rules. Name a debug adapter you already have — Python's `debugpy`
is the usual one — and `debug.start` will run a file in your workspace under it, stopping on the
lines you name. `debug.step` moves it on, `debug.variables` shows what every name holds where it
stopped, and `debug.stop` ends it. Starting one asks you exactly as running any other program does,
only one debugging session runs at a time, and what the program prints is kept in a rolling buffer.

**Neither is left running.** A language server or a program being debugged that a task started
stops again when that task is done, the same way a program `process.start` left running in a
conversation stops when the conversation does — so nothing you did not ask for is sitting there
using the machine afterwards. A task that has only stopped to ask you something is not done, so
what it started is still there when you answer. Two switches keep them up instead, **Keep a
language server running between tasks** and **Keep a program being debugged running between
tasks** (`keepRunning` in each of the two settings), which makes the next task that needs one start
sooner. Pressing one of these tools' own buttons yourself is one short task per press, so a press
is left alone — otherwise the debugger would stop between "start it" and "what is this name".

**Trying something risky on a copy (plan branches).** `plans.try` makes a parallel copy of the
repository on a line of work named after the plan, inside `.branch-worktrees`. Work happens there,
`plans.diff` shows exactly what it changed compared with where it started, and only `plans.merge`
brings it back — which asks you first and then puts the copy away. Until that merge, what you are
working on is untouched.

**Points to come back to.** `workspace.checkpoint` keeps the exact bytes of every file changed in
this conversation, under a name you give it. `workspace.undo` puts the last change in this
conversation back and `workspace.redo` puts it forward again; ask either with `preview` first and
you are told which file and what would change, without anything being touched. Another
conversation's changes are never in reach. Checkpoints appear in **Settings → Workspace snapshots**
alongside whole-workspace snapshots, each with a button that puts the whole point back.

**Keeping what a build produced.** `artifacts.keep` files a picture, a zip or a built program beside
the run artifacts under a name you choose; keeping the same name again makes the next version
rather than replacing the last, and each version records its size and its sha256 checksum.
`artifacts.list` reads that back, so "is this the same build I had yesterday?" has an answer. `artifacts.restore` puts a kept version back into the workspace byte for
byte, after checking its checksum; it will not overwrite an existing file unless you say `replace`,
and it never writes through a link. `artifacts.forget` lets one version go; the others keep their
numbers (A1183).

**Tools from a service's own description (`tools.from_openapi`).** Point it at an OpenAPI 3
document — an address, or a file in your workspace — list the operations you are willing to allow,
and each one becomes a tool called `api.<service>.<operation>`. Nothing you did not list is
registered. The shapes come from the document itself, the address goes through the same network
rules as everything else, and the key comes out of your locker at the moment of a call and is
scrubbed back out of the answer. Descriptions written in the document are capped and put through
the same filter a web page gets, so a document cannot talk the assistant into anything.
`tools.services` shows what is registered and `tools.forget_service` takes one back out. Every tool
a service brings is filed in its own **services** toolbox, so one large document can never crowd out
the built-in tools. **A service you add stays added.** What you told Branch — the name, the
operations you allowed, the address to call, which saved secret holds the key, and the description
exactly as it was read — is written down with the rest of your settings, and the tools are built
back from it when Branch next starts. Nothing is fetched on the way back, so a service that is down,
or a description you have since moved, still gives you its tools; the address is checked against
your network rules when a call is actually made, as it always was. **The key is not part of what is
written down**: it stays in the locker and is fetched at the moment of each call. `tools.forget_service`
takes the tools out and forgets the service for good, so it does not come back next time. Notion is
the worked example:

```
tools.from_openapi { name: "notion", file: "notion-openapi.json",
                     allowlist: ["retrievePage", "updatePage"],
                     secret: "NOTION_TOKEN", auth: "bearer" }
```

Try it with `dryRun: true` first and you are shown exactly what you would get, with nothing
registered. For a service with no description written down, the plain web tools (`web.fetch`, and an
MCP server if the service ships one) are still the way in; nothing here takes that away.

**Handing the assistant over.** `branch export-agent <file>` writes one file holding your
specialists, your saved procedures, your installed skills, which model does what, and your approval
rules. Add `--memory` to include what it remembers and `--redact` to mask personal details on the
way out. **No secret is ever inside**: the locker is not opened at all, and everything written goes
through the same scrubber that keeps unlocked passwords out of the record. `branch import-agent
<file>` always prints what is inside first and brings in nothing until you say which parts you want
with `--sections specialists,routing`; every part is checked against its fingerprint before a byte
is written, and a skill arrives as its own document so it is installed and scanned the ordinary way.

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

**macOS and Linux.** `npm run package:desktop` builds the download for the computer it runs on.
On a Mac that is `Branch Agent.app` (bundle id `com.keepoak.branch-agent`), zipped as
`Branch-Agent-macos-arm64.zip` or, with `-- --arch x64`, `Branch-Agent-macos-x64.zip`; unzip it and
drag the app into Applications. Closing the window keeps Branch in the dock, Cmd+Q quits, and the
Edit menu gives copy and paste their usual keys. When `APPLE_SIGNING_IDENTITY` is set the app is
signed, and with `APPLE_NOTARY_PROFILE` (a `notarytool` keychain profile) or `APPLE_API_KEY_PATH`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` it is also notarised; no password is ever put on a command
line. Without an identity the copy is unsigned and macOS warns the first time it is opened: allow it
under System Settings, Privacy & Security, Open Anyway. On Linux the download is
`Branch-Agent-linux-x64.tar.gz`, a folder you unpack anywhere and start with `./branch-agent`. It
holds `branch-agent.desktop` and `branch-agent.png`; to see Branch in your applications menu, copy the
entry to `~/.local/share/applications/` and change `Exec` and `Icon` to the folder's full path. On
Ubuntu 24.04 and other systems that restrict Chromium's sandbox, the app may refuse to start until
`chrome-sandbox` in that folder is owned by root with mode 4755
(`sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`). Every download has a
`.sha256` beside it; a version tag builds all four and attaches them to the release
(`.github/workflows/package.yml`).

**What is still needed for a signed installer on every computer.** The code for signing is written;
what is missing is paperwork and keys, which only the owner can get. On a Mac: an Apple Developer ID
Application certificate, saved in the repository's secrets as `APPLE_CERTIFICATE_P12` (base64) with
`APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`, and an App Store Connect API key as
`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`; with those the release workflow signs,
notarises and staples both Mac downloads, and without them it still builds them unsigned. The Mac
download is a zip to drag into Applications, not a disk image or a `.pkg`. On Windows the installer
writes only to this person's own folders, so it needs no signature to run, but it is not
Authenticode-signed, so SmartScreen can still warn about a new download until a code-signing
certificate is bought and a signing step added to the workflow. On Linux the download is a folder in a
`.tar.gz`; there is no `.deb`, `.rpm`, AppImage or Flatpak, and no package repository, so the menu
entry is copied by hand and updates come from Branch's own updater. Checksums (`.sha256`) are
published for every download on every system.

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

**macOS and Linux.** `branch daemon install` on a Mac writes
`~/Library/LaunchAgents/com.keepoak.branch-agent.plist` (starts when you sign in to your Mac,
starts again only after a crash, no window, output in `logs/background.log` and
`logs/background-errors.log` inside the data folder) and loads it for you alone with
`launchctl bootstrap gui/<your user id>`; `uninstall` runs `launchctl bootout` and deletes the file,
and `status` asks `launchctl print`. On Linux it writes `~/.config/systemd/user/branch-agent.service`
(or under `$XDG_CONFIG_HOME`) and runs `systemctl --user daemon-reload` and `enable --now`;
`uninstall` runs `disable --now` and removes the file; `status` asks `is-enabled`. No administrator
password is needed on either. The update downloads are `Branch-Agent-macos-arm64.zip`,
`Branch-Agent-macos-x64.zip` and `Branch-Agent-linux-x64.tar.gz` (Windows keeps
`Branch-Agent-windows-x64.zip`), each with its `.sha256`; the names live in
`src/desktop/release-assets.ts`. After the checksum matches, the download is unpacked with `ditto`
(Mac, which keeps the links inside the app) or `tar` (Linux), and a small `sh` script is started on
its own with nothing attached, so no terminal window appears. It waits about a minute for the app
and the background engine to close, then asks them to stop and finally ends them, copies the new
version in beside the old one, keeps the old one as `Branch Agent.app.previous` (Mac) or
`<folder>.previous` (Linux), swaps them, and opens the new version (`open -n` on a Mac, the
`branch-agent` program on Linux). If the new version is not still running twenty seconds later the
previous one is put back and opened. A copy running from its source code says so and points to
`branch update` instead. `branch doctor --fix` gives Mac and Linux steps for installing Git.

**Closing the background engine for an update (macOS and Linux).** When the window joined an engine
working in the background, the update first asks that engine to close over its own local address
(`POST /api/deployment/close`, answered only on this computer's loopback address and only with the
master key, never a short-lived key or the phone door; Windows refuses it and keeps using
`taskkill`). If it has not gone within three seconds it is sent the ordinary stop signal (SIGTERM,
the same as Ctrl+C), then, three seconds later, ended outright (SIGKILL). Where the app is installed
is worked out one way for the engine and the updater: the program's folder on Windows and Linux,
the `.app` bundle on a Mac, whose engine script is `Contents/Resources/app/dist/cli.js`. A built Mac
app that is not inside an `.app` bundle is asked to move into Applications instead of being told it
runs from source. The engine's own answers say "start by itself when you sign in to your Mac" (or "to
this computer" on Linux) where Windows says "start with Windows".

Routes: `GET /api/deployment`, `POST /api/deployment/autostart`, `POST /api/deployment/daemon`,
`POST /api/deployment/remote`, `POST /api/deployment/remote/invite`, `GET /api/deployment/doctor`,
`POST /api/deployment/backup`, `GET /api/deployment/restore-points`,
`POST /api/deployment/restore-point`, `POST /api/deployment/close` (macOS and Linux), and `POST /api/pair`. Interface files: `/deployment.js`,
`/pair` and `/pair.js`.
## Phone apps

Branch Agent for iPhone and Android is a small native shell around the Branch window you already
have. It lives in `apps/mobile` (its own `package.json`: Capacitor 8.5.2, MIT, and jsQR 1.4.0,
Apache-2.0; nothing is added to the main package). Capacitor was chosen because it is the smallest
way to get one codebase onto both phones while the screens stay Branch's own web pages, so the
redesign, the 44 themes and every place look the same on the phone. The native parts use only what
each phone ships (Keychain, `LocalAuthentication`, `BackgroundTasks`; Android Keystore,
`BiometricPrompt`, `JobScheduler`), so there are no further plugins and no Google services.

**What it does.** The first screen connects to your Branch: switch on reaching Branch from your
phone on the computer (see above), then scan its square code with the phone's camera (or paste its
address) and type the six numbers. The phone makes the pairing request itself and keeps the key in
the iOS Keychain or behind an Android Keystore key; the app's own page never sees it. After that the
home screen shows the five places in their usual order and *Open Branch*, which opens the full
window from your computer inside the app. A small KeepOak button in the window's title bar comes
back to the phone's own screen.

To open the window, the app writes the key and the phone's own secret (for the "this exact phone"
step) into your Branch address's session storage, exactly as the pairing page does in a phone
browser, so any script on that address can read them while the window is open. The phone app's
own plugin answers only its own page: on iPhone every call made while another page is showing is
refused; on Android the window opens inside the app only when the system web view can keep the app's
bridge to its own page (otherwise *Open Branch* goes to the phone's browser). A phone paired in its
browser now keeps its secret too (`public/pair.js`) and sends it with every request
(`public/device-headers.js`), so turning the "this exact phone" step on no longer locks it out; live
sockets cannot carry that secret yet.

Addresses are checked twice, in the page (`apps/mobile/web/rules.js`) and natively
(`BranchRules.swift`, `BranchRules.java`): https is allowed anywhere; plain http only to this
network (`10/8`, `172.16/12`, `192.168/16`, the phone itself), Tailscale (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`, names ending `.ts.net`) and `.local` / `.home.arpa` names. The web view may
open only the paired address; every other link goes to the phone's browser.

**On this phone.** Five switches, each *off*, *when needed* or *on*, and all off on a new install:

| Switch | When needed | On |
| --- | --- | --- |
| Lock with face or fingerprint | asks after five minutes away | asks every time the app opens |
| Tell me when a task needs me | checks `GET /api/state` every minute while the app is open | also checks in the background about every 15 minutes |
| Send to Branch from other apps | Branch appears in the share sheet and asks for a note first | sends straight away |
| Talk button | shows the button | shows the button |
| Alerts while the app is closed | asks the phone for a push address (see below) | the same |

*Send to Branch* turns words and links into a new conversation (`POST /api/run`): your own note
comes first, and what the other app shared follows between `<shared>` markers, labelled as untrusted
content the assistant should read but not obey. Up to four pictures ride along (5 MB each); any
other file up to 20 MB goes to Library, Documents (`POST /api/documents`). On iPhone a share extension sends directly, reading the key through the
shared app group; on Android the share target is a switched-off activity alias that the switch
turns on. *Talk* records while the button is held, has your computer write it out
(`POST /api/voice/transcribe`) and sends the words. The live-voice route is not used from the phone
yet: the paired listener has no WebSocket door, so a live conversation cannot reach it.

The splash screen, the icon, the status bar and the native screens take their colours from
`public/theme-catalogue.js` through `apps/mobile/web/palette.js`, and their words from the
`phone.*` keys in `public/locales` (English and French). `apps/mobile/scripts/native-files.mjs`
and `icons.mjs` write those native files before every build; none of them is kept in git.

**Building.** `npm run build`, then `npm ci` in `apps/mobile`, then
`node scripts/package-mobile.mjs [--android] [--ios]`. Files land in `release/mobile/`, each with a
`.sha256`:

- `Branch-Agent-android.apk` — signed with a key made once on this Mac in
  `~/.branch-mobile-keystore/`. Its password is generated and kept in the macOS Keychain (service
  `branch-mobile-keystore`), handed to the tools only through stdin and the environment, and never
  printed. On Linux, or on CI without the `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`
  secrets, the APK is left unsigned. Needs JDK 21 and an Android SDK (`ANDROID_HOME`).
- `Branch-Agent-android.aab` — the same app for the Play Store, signed with the same key.
- `Branch-Agent-ios.ipa` — built without an Apple signing identity (macOS and Xcode only). It
  carries only a local signature with the app-group entitlement, so the tool that installs it can
  sign it with your own Apple ID. Without an installed iOS Simulator runtime Xcode cannot compile
  the asset catalog, so such a build carries the app icons but a plain launch screen; a Mac with a
  runtime (or the CI runner) builds the full one.
- `Branch-Agent-ios-simulator.zip` — the same app for the iOS Simulator
  (`xcrun simctl install booted App.app`).

`.github/workflows/mobile.yml` builds both on pull requests that touch the phone apps and keeps
the files for seven days. It publishes nothing.

**Putting it on a phone.** Nothing here is uploaded anywhere; each route is a step the owner takes.

- *iPhone, free Apple ID:* open `Branch-Agent-ios.ipa` in Sideloadly or AltStore, sign in with your
  Apple ID and install. A free ID's apps expire after seven days and need signing again (AltStore
  can do that on its own). Turn on Developer Mode on the phone when iOS asks.
- *iPhone, paid Apple Developer account (TestFlight, then the App Store):* in the developer
  account, register the identifiers `com.keepoak.branchagent` and `com.keepoak.branchagent.share` and
  the app group `group.com.keepoak.branchagent`; open `apps/mobile/ios/App/App.xcodeproj`, choose the
  team for both targets, then Product → Archive and Distribute App → App Store Connect. Add testers
  in TestFlight; submit for review from App Store Connect when ready.
- *Android, directly:* copy `Branch-Agent-android.apk` to the phone and open it (allow installing
  from that app when asked), or `adb install Branch-Agent-android.apk`. Keep the key in
  `~/.branch-mobile-keystore/` and its Keychain entry: every later version must be signed with it.
- *Google Play:* create the app in the Play Console, enrol in Play App Signing, and upload
  `Branch-Agent-android.aab` to an internal testing track first.
- *F-Droid:* `apps/mobile/fdroid/com.keepoak.branchagent.yml` is the metadata to open a merge
  request with in `fdroiddata` once a `v0.16.0` tag exists; F-Droid builds from source and signs
  with its own key.
- *Push (alerts while the app is closed):* needs accounts first. On iPhone, a paid account with the
  Push Notifications capability and an APNs key; the app already asks for a device token while the
  switch is not off and keeps it on the phone. On Android, a Firebase project: put its
  `google-services.json` in `apps/mobile/android/app/` and build with
  `./gradlew assembleRelease -PbranchPush`, which adds `BranchPushService`. Branch itself has no
  sender for either yet; until then *Tell me when a task needs me* is the way to hear about
  questions.

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
**macOS and Linux.** On a Mac every action goes through one fixed JavaScript for Automation script
run by `osascript -l JavaScript <script> <action> <request as JSON>`, so what was asked for is only
ever a separate argument read as data; pictures through `screencapture -x`, programs and files
through `open`, and "ctrl" in a key chord means Command. On Linux the same actions are `xdotool`
argument lists (typed words after `--`), on an X11 session only; Wayland, no session, or no
`xdotool` is one plain sentence. Reading a window's contents, pictures, the clipboard and starting a
program by name are not built for Linux yet. A refusal from macOS names the page to change
(Automation, Accessibility, or Screen & System Audio Recording).
The **Stop** notice there is a small window of the desktop app's own: frameless, always on top (on a
Mac on every desktop, full-screen ones included), with no script in it, and put up without taking
the keyboard from the window being worked. Its Stop button is a link to an address that is never
visited: the app refuses the visit, closes the notice, and a closing notice is "let go now", exactly
as on Windows. Screen control on a Mac or Linux runs only while that window is really showing — the
check is made again before every action — so it works only inside the Branch Agent app on this
computer. From the command line, or from an engine working in the background with no window, every
screen tool answers "Branch can only use your screen and keyboard from the Branch Agent app on this
computer". If the notice cannot be shown, nothing is done and Branch says so. (Code:
`src/integrations/desktop-banner.ts`, `src/desktop/banner-window.ts`.)
**Off, when needed, or on (every computer).** The setting also carries `mode`: `off` (the default:
every screen tool refuses, and none is offered to the model in the first round; one asked for by
name still refuses), `when-needed` (the tools are a line
in the tool index and load when the work calls for them — what "enabled" always meant, so an older
saved `enabled: true` reads as this), or `on` (the tools travel with every task from the first
round). `POST /api/desktop/settings` takes `mode` or the older `enabled`; turning `enabled` on
brings back the mode it had, or `when-needed`. Saving only `maxActionsPerRun` no longer switches
the feature off. The choice is its own card, "How Branch uses your screen" (home
`settings:computer`, in `public/os-permissions.js`). (Code: `src/feature-switches.ts`.)
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
### A client for Python programs
`packages/sdk-python/` is the same client for Python 3.9 or later, using only the standard library
(`urllib` and `json`), so it runs the same on Windows, macOS and Linux with nothing to install. It
covers the same groups with Python names (`runs.start`, `runs.stream`, `runs.get`, `runs.approve`,
`memory.search`, `search`, `audit`, and the rest); `from_data_dir(folder)` reads the session key the
app wrote. It streams a task's events but does not open the run socket, because the standard library
has no client for one. To keep the key safe it sends it over plain `http` only to this computer's own
address (anything else must be `https`), never follows a redirect, and ignores proxy settings in the
environment. It is not on the package index yet (`pip install ./packages/sdk-python` works from a
copy of the source). Its tests run against a fake server
(`python3 -m unittest discover -s packages/sdk-python/tests`); `tests/sdk-python.test.mjs` runs them as
part of `npm test` and also drives a real Branch Agent with it, and is skipped where no Python is
installed. See `packages/sdk-python/README.md`.
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
**Where it happened, and what started the task, are two different things.** `source` is where the
moment actually happened: this app, a schedule, a trigger, another AI tool — and now also the chat
app a button was pressed in, one of `telegram`, `discord`, `slack`, `whatsapp`, `email` or `chat`
(anything else a plugin brought). `origin` is what the task itself came from, which for an answer
given on a phone is usually not the same thing at all: a schedule can start a task whose question
you answer on Telegram, and the record says both. Rows written before the two were told apart carry
no origin of their own; they read back, and filter, as their source, which is what that column
always meant, and nothing is rewritten — the two rules on the table refuse any edit to a row that
already exists.

`GET /api/audit` lists it newest first and accepts `action`, `source`, `origin`, `from`, `to` and
`limit`. `GET /api/audit/export.csv` saves the same, with the same filters, as a spreadsheet file,
with **where it happened** and **what started the task** as two columns. The
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
`GET`/`POST /api/retrieval` holds `mode` (`words` or `model`), `candidates` and `keep`; the same
`GET` also returns the named pipelines and which knowledge base uses which, and
`POST /api/retrieval/pipelines` sets them.
`POST /api/retrieval/search {"query": "..."}` returns the passages with `reranked` and
`rerankCalls`, which is 0 for the word count and 1 for the model. The same ordering is used for the
passages put in front of an ordinary task.
### Narrowing a search before anything is ranked (wave 9)

A question about this year's invoices should not drag last year's in behind it. Every search of a
knowledge base — the `knowledge.search` tool and `POST /api/knowledge/search` — takes an optional
`filter` made of things a passage already carries, so the unwanted ones are left out of the
comparison rather than pushed down it:

| In `filter` | What it means |
| --- | --- |
| `collections` | Knowledge bases, by name or by id. |
| `files` | Files, by workspace path or by the file's own name. A folder path matches everything under it. |
| `kinds` | Kinds of document: `pdf`, `docx`, `xlsx`, `pptx`, `md`, `csv`, `txt`, `html`, `json`, `odt`, `ods`, `epub`, `rtf`. |
| `changedAfter` | Only files Branch last saw change on or after this date, written `2026-01-01`. |
| `changedBefore` | Only files Branch last saw change before this date. |

**Filters combine.** Naming a kind and a date means both must be true, not either. The narrowing is
done in the database, in **both** ways Branch finds candidates — the full-text one and the plain scan
it falls back to — so a filter is never quietly dropped when full-text search happens to find
nothing.

**A filter that matches nothing says so.** The answer carries a `note` naming what you asked for and
saying plainly that the search was not widened and no answer was taken from outside the filter. An
empty list on its own cannot tell "nothing in those invoices" from "nothing anywhere", and the
difference is the whole point of having a filter. A knowledge base you named that does not exist is
named back to you in the same sentence.

"Last changed" means the last time Branch saw that file's contents differ from what it had. Reading
a folder where nothing changed does not move the date.

In the **Knowledge** card, the two boxes under the search row set a kind and a date.

### Naming an order for the places Branch looks (wave 9)

Branch looks in several places for passages: your documents, your saved notes, your knowledge bases,
one hop through the map of a knowledge base, and text pasted in for this job alone. By default all of
them are asked at once, their answers merged, and the best put first. That is still exactly what
happens unless you write down something else, and `tests/retrieval-2.test.mjs` asserts that the
default and the old code give the identical answer.

The picker on each knowledge base's card is what the assistant uses when it looks something up for
you; the search box on that same card always searches that one knowledge base directly.

A **named pipeline** is an order for those places, with a ceiling on each, and the pass that puts the
best first at the end. `POST /api/retrieval/pipelines` holds two things. `pipelines` is the list of
orders you have written, each `{ name, stages: [{ retriever, cap }] }`; `byCollection` says which of
them a search aimed at one knowledge base uses, keyed by that knowledge base's name or id. Anything
not named there uses the usual way.

`retriever` is one of `documents`, `memory`, `knowledge`, `knowledge-graph`, `ephemeral`, or
`rerank`. `cap` is the most that step may bring back — or, for `rerank`, the most it may keep. The
rerank always runs last whether or not you write it down; writing it down is how you set its number.
A step naming something Branch has no retriever for is skipped and said so in the answer's `note`,
rather than failing the search.

```
POST /api/retrieval/pipelines
{
  "pipelines": [
    { "name": "the contract in front of me",
      "stages": [ { "retriever": "ephemeral", "cap": 8 },
                  { "retriever": "documents", "cap": 2 },
                  { "retriever": "rerank", "cap": 3 } ] }
  ],
  "byCollection": { "Contracts": "the contract in front of me" }
}
```

`POST /api/retrieval/search` takes `query` and optionally `pipeline` (a name) or `collection` (which
picks the pipeline through `byCollection`). The answer carries `pipeline` and a `stages` list saying
what each step was allowed and what it actually brought back, so you can see where an answer came
from. Each knowledge base's card in **Documents** has the same picker.

### A retrieval, end to end, that you can actually run

This is the whole path, from nothing to a quoted answer with its source, on one computer. Every step
is a real request.

1. **Make a knowledge base and point it at a folder of your own.**

   ```
   POST /api/knowledge  { "name": "Invoices", "sources": [ { "kind": "folder", "path": "invoices" } ] }
   ```

2. **Read it.** Every file is cut into passages and kept for word search. With no model connected
   that is all that happens, and the answer says so — word search on its own is enough for this
   example.

   ```
   POST /api/knowledge/reindex  { "collection": "Invoices" }
   ```

   The answer is a progress line: `files`, `filesDone`, `chunks`, `unchanged`, `tokens` and a
   `status` in words.

3. **Ask it something, narrowed to this year's spreadsheets.**

   ```
   POST /api/knowledge/search
   { "query": "what did we pay Dane Heating",
     "limit": 5,
     "filter": { "kinds": ["xlsx"], "changedAfter": "2026-01-01" } }
   ```

   Each result names its `collectionName`, `documentName`, `heading` and `page`, so the answer can be
   quoted and checked. If the filter left nothing, `note` says so and the list is empty — Branch does
   not widen it.

4. **Have the assistant answer in sentences, with numbered sources.**

   ```
   POST /api/knowledge/ask  { "collection": "Invoices", "question": "what did we pay Dane Heating" }
   ```

5. **Change the order it looks in, and check it.** Say you want the map of the knowledge base asked
   first for this one, and only three answers kept:

   ```
   POST /api/retrieval/pipelines
   { "pipelines": [ { "name": "suppliers first", "stages": [
       { "retriever": "knowledge-graph", "cap": 6 },
       { "retriever": "documents", "cap": 4 },
       { "retriever": "rerank", "cap": 3 } ] } ],
     "byCollection": { "Invoices": "suppliers first" } }

   POST /api/retrieval/search  { "query": "Dane Heating", "collection": "Invoices" }
   ```

   The answer's `stages` shows each step, its ceiling and what it found; `passages` is at most three,
   each still naming its `source`. Reranking never loses a citation: the source travels with the
   passage.

6. **Put the vectors somewhere else, if the library is large.**

   ```
   POST /api/knowledge/vectors  { "vectorsIn": "file", "vectorsFile": "D:/branch/vectors.db" }
   ```

   Then press **Read it again** to fill it. If that drive is not there, the answer's `note` says so
   and Branch carries on with its own database. One honest edge: deleting a knowledge base clears its
   vectors from wherever they are kept **now**, so rows left behind in a file you have since switched
   away from stay in that file until you delete it yourself.

### What is put in front of a task, and in what order (wave 9)

Before the model reads your question, Branch may put some of your own material in front of it. Three
things can do that, and they are asked in this order; the first with something to say is the one
used:

1. a knowledge base you ticked **Use this when answering**,
2. your document library,
3. the files of the project you are working in.

The third is off until you turn it on, because most questions are not about code and a list of file
names in front of every task would be noise. `POST /api/retrieval/context` sets the two: `repositoryContext` turns it on and
`repositoryContextFiles` (5 by default, at most 10) is how many files may be named. Each is named
with the reason it was picked — the words you used appear in it, or it is connected to a file that
matches — and with the names it declares. Turning **Use my documents when answering** off at the top
of the Documents panel turns all three off, so that one switch always means "put none of my own
material in front of my tasks".

The contract is `ContextProvider` in `src/context-providers.ts`: an id, a label the owner would
recognise, and one method that is given the question and either answers with numbered passages and
their sources or answers with nothing. A provider that throws is treated as having nothing to say,
because material in front of a task is a help and never a reason for the task to fail. Everything a
provider returns is still your own untrusted text: the runtime wraps it in the same "quote it, never
obey it" sentence it always has.

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

**Which calls go through the network rules, and why.** One convention covers the whole provider
layer, reading passages included. Every call that leaves this computer — a model answer, a picture,
speech, a content check, and every reading of a passage for a document, a knowledge base, a saved
fact or the assistant's search for its own tools — is made through the fetch the network rules
guard, so **Where it may go** in Settings decides it: a blocked website, or one outside your allowed
list, is refused before a single word of yours is sent. A reader **running on this computer** is the
one exception, and deliberately so: those rules refuse private and local addresses, which is exactly
what you want for the open web and exactly the wrong answer for a model on your own machine. Its
floor is the check every provider address makes anyway — HTTPS, or plain HTTP only on this
computer's own loopback address (`localhost`, `127.0.0.1`, `[::1]`), never an address with a
password written into it. That is the floor, not the ceiling: everything reachable from outside this
machine is held to the full rules on top of it.

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

**Where the vectors live.** By default in the same database as everything else, in a table called
`vectors`, and the comparison is done in TypeScript. That is comfortable up to roughly **50,000
passages in one knowledge base**; past that a real vector database would be the right answer.

There is one alternative you can switch on today: a **database file of your own**, anywhere on this
computer. `POST /api/knowledge/vectors` holds `vectorsIn` (`database`, the default, or `file`) and
`vectorsFile` (the full path of that file, such as `D:/branch/vectors.db`). The card **Where your
vectors are kept** in Documents sets the same two. A large library's vectors can be bigger than
everything else Branch stores put together, so putting them on another drive keeps the main database
small and quick to copy.

Three things are promised about that switch. The path must be a full one, and a missing folder is
created for you. If the file cannot be opened — a drive that is not plugged in, a folder you may not
write to — Branch says so in one sentence on the card and **carries on using its own database**; it
never starts up broken and it never fails a search in silence. And **nothing is deleted by
changing it**: the vectors you already had stay where they were, and the new place fills up the next
time you press **Read it again**.

**The hosted vector services are deliberately not built.** Qdrant, Chroma, Pinecone, Weaviate and
the rest are all real products, and an adapter for each was asked for in the capability audit. None
is built here, for one reason: nobody running Branch on their own computer is also running one of
them, an adapter could not be tested on this machine without a network, and each one would be a new
dependency to talk to a service you do not have. What exists instead is the contract, a second real
implementation of it, and the worked example below. If you do run one, that example is enough to
write the adapter in an afternoon.

### Writing your own place to keep the vectors, end to end

`VectorBackend` in `src/vector-store.ts` is seven methods, six of them required. Here is a complete
one, for a service that speaks HTTP. Nothing is left out; this compiles.

```ts
import type { VectorBackend, VectorMatch, VectorRecord } from "branch-agent";

/** Your service, behind the same contract the shipped SQLite one implements. */
export class MyVectors implements VectorBackend {
  readonly name = "my vector service";
  constructor(private readonly base: string, private readonly call: typeof fetch) {}

  /** `POST` the passages. Returns how many were written, which the progress line shows. */
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    if (!records.length) return 0;
    const body = records.map((record) => ({
      id: `${owner}:${record.collection}:${record.chunkId}`,
      vector: Array.from(record.vector),
      payload: { owner, collection: record.collection, docId: record.docId,
        model: record.model, textHash: record.textHash },
    }));
    const answer = await this.call(`${this.base}/points`, { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ points: body }) });
    if (!answer.ok) throw new Error(`The vector service refused the write: ${answer.status}`);
    return records.length;
  }

  async removeDocument(owner: string, collection: string, docId: string): Promise<number> {
    return this.deleteWhere({ owner, collection, docId });
  }
  async removeCollection(owner: string, collection: string): Promise<number> {
    return this.deleteWhere({ owner, collection });
  }
  private async deleteWhere(match: Record<string, string>): Promise<number> {
    const answer = await this.call(`${this.base}/points/delete`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: match }) });
    if (!answer.ok) throw new Error(`The vector service refused the delete: ${answer.status}`);
    return Number(((await answer.json()) as { deleted?: number }).deleted ?? 0);
  }

  /** Best first. `scanAtMost` may be ignored where the service does the comparison itself. */
  async search(owner: string, collection: string, query: Float32Array, limit: number): Promise<VectorMatch[]> {
    const answer = await this.call(`${this.base}/points/search`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vector: Array.from(query), limit, filter: { owner, collection } }) });
    if (!answer.ok) return [];
    const found = (await answer.json()) as { result?: { payload: { docId: string }; id: string; score: number }[] };
    return (found.result ?? []).map((row) => ({
      docId: row.payload.docId, chunkId: String(row.id).split(":").slice(2).join(":"),
      score: Number(row.score.toFixed(6)),
    }));
  }

  async count(owner: string, collection?: string): Promise<number> {
    const answer = await this.call(`${this.base}/points/count`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: collection ? { owner, collection } : { owner } }) });
    return answer.ok ? Number(((await answer.json()) as { count?: number }).count ?? 0) : 0;
  }

  /** Chunk id to fingerprint, so a passage that has not changed is never read again. */
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    const answer = await this.call(`${this.base}/points/scroll`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: { owner, collection, model }, with_payload: true, limit: 50000 }) });
    if (!answer.ok) return new Map();
    const found = (await answer.json()) as { result?: { id: string; payload: { textHash: string } }[] };
    return new Map((found.result ?? []).map((row) =>
      [String(row.id).split(":").slice(2).join(":"), row.payload.textHash]));
  }
}
```

Three rules that are not in the type and that a wrong adapter will break. **Every call takes an
owner and must scope to it**: two people on one computer never see each other's passages. **Lists of
different lengths score zero rather than throwing** — a knowledge base read by two different models
has both, and a search must not fall over. And **the network policy is not optional**: hand your
adapter the guarded `fetch`, never `globalThis.fetch`, so the owner's address rules are checked
before anything leaves.

Then hand it over where the knowledge bases are made, in `src/index.ts`:

```ts
const knowledgeBases = new KnowledgeBases(store, files, runtime.models, ledger,
  new MyVectors("http://127.0.0.1:6333/collections/branch", guardedFetch), guardedFetch);
```

`countNow` is the seventh method and the only optional one: the Documents panel draws its cards in
one pass and cannot wait, so a backend that can answer a count without waiting implements it and one
that cannot leaves it out — the card then says nothing about how many passages are compared by
meaning rather than showing a wrong zero.

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
`{ collection }`, `POST /api/knowledge/search` with `{ collection?, query, limit, filter? }`,
`POST /api/knowledge/ask` with `{ collection?, question }`, `POST /api/knowledge/attach` with
`{ collection, attached }`, `POST /api/knowledge/settings` with `{ maxIndexTokens?, compareAtMost? }`,
`POST /api/knowledge/vectors` with `{ vectorsIn?, vectorsFile? }`,
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
covers the site and anything under it, so `example.com` fits `shop.example.com`. A command rule
covers the words it names and anything after them, so `rm` fits `rm -rf something` and `git status`
fits `git status --short` but not `git push` (see "Always allow, per command" below). `*` still
stands for any text.
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

**More than one question at a time.** A conversation can genuinely stop on two things at once — a
second task started in the same conversation while the first was waiting, or one AI-tool connection
making two calls — so the questions are kept as a list, oldest first, and the second never takes the
first's place. `GET /api/policy` returns all of them; the approval card shows each with its own
exact words. Answering with a fingerprint answers that exact request, whichever of them it is;
answering without one answers the one that has been waiting longest, which is the only one when
only one is waiting. Asking the very same request again is the same question, not a second copy. A
conversation holds at most **eight** waiting questions; at a ninth the one that has been waiting
longest is let go and its task is stopped with a plain sentence saying so, rather than being left
waiting on an answer that can no longer arrive. That also goes into the record of what the assistant
was allowed to do, filed under the same heading as every yes and no with the outcome "let go
unanswered", so a question that went away is not a thing only the failed task remembers. An AI-tool
connection may hold the same eight.

**One rule, everywhere.** Every way of answering binds the answer to that fingerprint, and there is
no route that does not: the approval card in the app, the buttons and the `reply y / a / n` in a
chat app, `branch approve <task id> yes` on the command line, the question Branch holds open for
another AI tool over its own server, the terminal display, an editor over ACP, and the resume of a
saved workflow or flow — a workflow's step carries the fingerprint of its own arguments, so a step
edited while the workflow sat waiting is asked about again rather than let past on the old yes. The
one thing a fingerprint does not bind is a **rule**: "yes, always" and anything in **Ask first**
are standing decisions about a tool and a target, not answers to one request, and they are meant to
cover every later call that matches. `branch approve` writes such a rule, because the program run
that asked the question has already ended by the time you answer.
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

## What is allowed, trajectories, the live feed, the month view and metering (batch 19, wave 7)

### What is allowed right now
The details pane beside a conversation lists what that conversation is allowed to do without asking
again: every yes it has remembered, with the plain words of what it covers and when it runs out,
and beneath them the standing rules that say "go ahead". Each remembered yes has a "Take this back"
beside it; taking one back makes the assistant ask again the next time. Before you press any of the
answers on an approval card, a quiet line under each says what that answer leaves behind — nothing,
a yes for this conversation that runs out in an hour, or a standing rule you can remove later.

- `GET /api/rules/allowed?session=<id>` — `{ session, grants, standing }`. `grants` are this
  conversation's remembered answers (`tool`, `target`, `decision`, `label`, `grantedAt`,
  `expiresAt`, `fingerprint`); `standing` are the rules whose decision is "allow", each with the
  sentence the settings screen shows.
- `POST /api/rules/allowed/revoke` — `{ session, tool, target }`. Removes one remembered answer and
  hands back what is left. A yes that is not there any more answers 404.

### Answering an approval from a chat app
When a task started from Telegram or Discord stops to ask whether it may go ahead, the question is
put in that chat with buttons: Yes, Yes always (only for a task you started yourself, the same rule
the app's own card follows) and No. Telegram uses an inline keyboard, Discord an action row of
message components. Each button carries its answer and the fingerprint of the exact request, so a
yes cannot be replayed against a different one, and the conversation it belongs to is worked out
from the chat rather than carried in the button — Telegram allows only 64 bytes there.

A channel with no buttons — WhatsApp, email — gets the same question with "Reply y for yes, a for
yes always, or n for no." A bare `y`, `a` or `n` from a chat whose conversation has a question
waiting answers it; anything longer is an ordinary message, whatever it happens to say. The answer
goes through the same approval path as the app's own card, and the record of what the assistant was
allowed to do says which chat app it was answered on.

### A task's trajectory
A trajectory is one JSON file holding everything a task actually did, in a shape that is written
down here and does not move, so an evaluation tool can read a file saved months ago. "Save
trajectory" in the Look inside panel writes one; `runs.export` hands the same thing to the
assistant itself.

- `GET /api/runs/<id>/trajectory` — one task.
- `GET /api/runs/trajectories.jsonl?limit=<1-500>` — many tasks, newest first, one trajectory per
  line, for feeding an evaluation run. This one is the owner's own: a second person's profile is
  refused, because every task at once is the whole history rather than one task of theirs.
- Tool: `runs.export` (`{ runId? }`, defaults to the task it is called in; read-only).

The shape: `format` is always `"branch-agent-trajectory"` and `formatVersion` is `1`. Beside them,
`exportedAt`, `version` (the Branch that ran the task), `run` (`id`, `sessionId`, `prompt`,
`status`, `output`, times), `seconds`, `rounds` (each model round with its provider, model, preset,
duration, prompt size, tokens, whether the provider counted them, and its cost), `calls` (each tool
call with what went in and what came back, both clipped to 600 characters, its status and its
receipt), `plan`, `verdicts`, `steering`, `questions`, `timeline`, `receiptCounts`, `usage`, `cost`,
`messages` (the conversation as the model saw it) and `spans` (up to 500 steps recorded while it
ran). Saved passwords and keys are taken out before anything leaves.

### The live event stream
`GET /api/events/stream` is Server-Sent Events carrying every event of this workspace, not just one
task's. It is behind the same local key as every other route, so a browser reads it with `fetch`
and a stream reader rather than `EventSource`, which cannot carry a key. The Activity screen uses
it for the "Happening now" feed, and it starts and stops with that screen.

- `kind=tool.completed,tool.failed` — only these kinds. Leave it out for every kind. At most 20.
- `after=<id>` — everything after that event id, so a client that reconnects carries on rather than
  repeating itself. `after=0` replays from the beginning. Leaving `after` out means "only what
  happens from now on", which is what a fresh screen wants.
- `maxMs=<milliseconds>` — how long the connection is held open. The default is 150 000, and that
  is also the ceiling: a larger number is brought back down to it.

One connection is closed after 2 000 events, whichever comes first. An event's body can hold what a
tool was asked to do, so every one of them has any saved password or key taken back out of it before
it is sent, the same way the rest of the app does. A second person's profile sees only its own
events, never the owner's.

Each message is `id: <n>`, `event: <kind>`, `data: {"id","runId","kind","data","createdAt"}`. The
stream opens with an `event: ready` naming where it started and closes with an `event: end` naming
the last id it sent, which is the id to pass as `after` next time.

### What a month cost
The Usage screen opens on this month: what it has cost so far across the tasks whose model has a
price on file, one plain sentence saying what it is heading for at that pace ("At this pace, about
$X this month"), and the same money broken three ways — by model, by conversation, and by where the
task came from. A month in which no model had a price says so rather than showing $0.00. A task is
not filed under a project anywhere in the ledger, so there is no cost-per-project breakdown.

Beside it, "How it has been going" counts the middle round's size (the middle, not the average, so
one enormous task does not colour it), how many rounds were counted, how often a tool worked, and
how many conversations had to be shortened to make room. All of it comes from `GET /api/usage`,
which now returns a `statistics` record alongside `data` and `stats`.

The spreadsheet at `GET /api/usage/export.csv` carries `estimatedCostUsd`, `costPerRunUsd`,
`dearestModel`, `dearestModelCostUsd`, `runsWithPrice` and `runsWithoutPrice`. A day whose models
had no price leaves the money cells empty rather than writing a zero.

### Keeping a usage spreadsheet on a schedule (metering)
Branch can keep a spreadsheet of this month's usage in a folder of your own workspace and write it
again at an interval you choose. It is off until you ask for it, and it is written on this computer
only — nothing is sent anywhere.

- `GET /api/usage/metering` / `POST /api/usage/metering` — `{ enabled, folder, every }`, where
  `every` is `hourly`, `daily` or `weekly` and `folder` is a plain name inside the workspace. A
  folder that would climb out of the workspace is refused when you save it, not later.
- `POST /api/usage/metering/now` — writes it straight away and says where it went.

The file is named after the month (`usage-2026-09.csv`) and holds the same money columns as the
export above. The scheduler's existing beat writes it; a folder it cannot write to is passed over
quietly rather than stopping the rest of the scheduled work.

## Specialists that work in different ways (batch 20, wave 7)

A specialist now says how it works, not just what it knows. Pick one in Specialists → Propose a
specialist, under "How this one works"; the choice is written into the definition as `style`.

- **the ordinary way** — no change from before.
- **react** — it writes one line starting "Thought:" before each step, saying what it is about to
  do and why. That line never appears in the answer: it is kept against the task, and you can read
  the whole trail under "Look inside" → "What it was thinking, step by step".
- **plan then execute** — it writes a short plan for its own piece of work and then does one step
  at a time, exactly as a planned task does.
- **critic** — it reads and comments and cannot change anything, whatever permissions it was given.
  The permissions are narrowed when it runs, so this is not a matter of it behaving well.
- **researcher** — it starts with the web, research, document and memory tools to hand, and it is
  told to say where every claim came from.
- **coder** — it starts with the code, version-control and file tools to hand, and is told to make
  its changes with `code.patch` or `code.change_set` so each one can be put back.

`GET /api/specialist-styles` lists them with what each one does. The style a task ran under is shown
on its "Look inside" screen.

## Changing several files at once (batch 20, wave 7)

Two tools sit beside the older `files.patch`, which is unchanged:

- `code.patch` takes a unified diff. With `dryRun` it works the whole change out and shows you what
  it would do without writing a thing. Applied, it is all-or-nothing: if one part of the diff does
  not fit the file exactly, nothing at all is written. Every file it changes is kept in the file
  history first, so `files.history` and `files.restore` can put one file back on its own. A file
  that is not text is refused, and anything outside the workspace was never reachable.
- `code.change_set` changes several files in one go, each by replacing an exact piece of text. You
  are asked once, for the whole set, and the question names the files ("2 files: a.txt, b.txt").
  All of them change or none of them do.

**The project's check.** `GET`/`POST /api/code-check` holds one program to run after a change —
your tests, or your linter. Give the program in full, with its arguments and a timeout; a `.cmd` or
`.bat` wrapper is refused, as it is for host commands. It runs in the workspace under the same
memory and processor ceilings a host command gets, and what it said comes straight back to the
assistant in the same step, so it sees what its own change broke before it does anything else.
`code.check` runs it on its own, and needs the `code.execute` permission, because running your
tests is running a program on this computer whatever else it does. Off by default.

## Programs left running (batch 20, wave 7)

Some programs are meant to keep going: a preview server, a watcher. `process.start` starts one and
lets it outlive the step that started it; `process.list` says what is running, `process.read` gives
the most recent part of what it printed, and `process.stop` stops it and everything it started.

`GET`/`POST /api/background-programs` holds the list of programs you are willing to leave running,
each under a short name you choose, with how many may run at once and how long one may stay up.
The limit on how many is counted across the whole app, not per conversation, so one task cannot use
them all up and leave another with none.
Nothing else can be started. Each one is held in the same Windows job the one-off commands use, so
the system enforces its memory and processor limits and kills whatever it left behind. Output is
kept in a small rolling buffer, oldest dropped first. Everything started in a conversation stops
when that conversation is thrown away, and everything stops when the app closes — nothing is left
running for the next launch to find. `GET /api/processes` lists them and `POST /api/processes` with
an id stops one. Starting or stopping one needs the `process.manage` permission and is approved the
way a host command is; listing and reading need only `process.read`, which changes nothing. Running
a small script needs `code.execute`. These are separate from `shell.execute`, so allowing one does
not quietly allow the others.

## Running a small script (batch 20, wave 7)

`code.run` runs a short script the assistant just wrote — a calculation, a quick check — in a fresh
program of its own, started in the workspace. `GET`/`POST /api/code-run` is the switch: whether it
is allowed at all, where your Python is if you have one, whether a script may reach the internet,
and the time, memory, processor and output limits. JavaScript uses the app's own Node; Python needs
you to point at yours. Off out of the box, because a script is host execution like any other: these
are limits on time, memory and output, not a sandbox. With the internet switch off the script is
pointed at a dead address, the same best-effort measure host commands use.

## Work handed over to finish later (batch 20, wave 7)

A tool may answer `{ deferred: true, id }` instead of a result: the work has been handed over
and is not finished. The task does not wait; it carries on and gives its answer. `user.task` is the
plainest example — something for you to do by hand. `GET /api/deferred` lists what is waiting, and
`POST /api/deferred/settle` with the id and what came of it brings the answer back into the
conversation as an ordinary follow-up message.

All the routes in this batch — flows, the handed-over jobs, the programs left running, and the
three switches above — belong to the owner. With somebody else's profile switched on they answer
"belongs to the owner", exactly as saved workflows and the waiting line do, and so does the
`flows.list` tool, because the assistant always works as the owner.

## Flows: workflows as boxes and arrows (batch 20, wave 7)

A flow is a saved workflow seen as a picture. Every step is a box; an arrow says what follows what,
and a step that can go two ways gets one arrow labelled "as expected" and one labelled "otherwise".

- `GET /api/flows` — every flow with its picture and where each box has got to.
- `POST /api/flows` — save one, either as `{name, description, steps}` or as
  `{name, description, nodes}`, where the nodes are the steps in the order they happen.
- `GET`/`PUT`/`DELETE /api/flows/:id` — read, change, remove.
- `POST /api/flows/:id/run` — start it. `…/resume` carries a stopped one on, or says yes to the step
  it is waiting for; `…/pause` stops it between steps.

Each box that finishes, fails, or stops to wait is announced to anything listening for the
`flow.node` event through the webhooks you already have, carrying the flow, the box, its name and
what it said. Procedures shows the same picture, read-only.

## Skills that improve themselves, safely (batch 20, wave 7)

After a task that went well, the app writes a better version of the skill that task used. Nothing
switches over on its own. Under Skills → "Suggested better versions" you see:

- the lines that changed, exactly as a file change is shown;
- a button to try the new version against your last three real tasks. That trial is a practice run:
  every tool that would change something only reports what it would have done. The version in use
  and the new one are run on the same tasks and compared;
- "Keep it" and "Throw it away". Keeping is refused until the trial has happened and the new version
  did at least as well; the API takes a force flag if you mean to override that.

`GET /api/skill-revisions`, and `POST /api/skill-revisions/try`, `…/accept`, `…/reject` with the
skill and the version.

**Skills as files.** `skills.sync` keeps your installed skills as `.md` files in a folder inside the
workspace — your own version-controlled folder, if you keep one. Direction "out" writes them out,
"in" reads them back (installing what is new, adding a version where the text changed), and "both"
does both. A sync never deletes anything. Commit the folder with the version-control tools you
already have.

## Where plugins come from (batch 20, wave 7)

There is no shop to browse and nothing is downloaded. A plugin arrives as a folder or as one file
somebody handed you, holding `branch-plugin.json` and the plugin's own `.mjs` beside it.

- `POST /api/plugin-catalog/inspect` with the address of that folder or file shows the manifest —
  what it is called, what it says it does, what it asks to be allowed to do — and the fingerprint of
  its code. Nothing is copied and no code is run.
- `POST /api/plugin-catalog/install` copies it in. Pass the fingerprint you were shown and it
  refuses if the code has changed since. If the manifest carries its own fingerprint and the code
  does not match it, it is refused outright.
- `GET /api/plugin-catalog` lists what came from where, with the fingerprint each one had when you
  accepted it and whether the file on disk still matches.

Installing switches nothing on: turning a plugin on is still a separate, deliberate step, and that
is the step that runs its code.

## Reading documents (batch 25, wave 7)

Branch reads the files people actually have, using nothing but Node's own building blocks. No file
is ever executed, and no address written inside a file is ever fetched: a document is read, never
obeyed. Every read is capped — a file larger than 20 MB is refused before a byte is parsed, and a
file still being walked after 20 seconds is cut short and says so in the "could not be read" list.
Unpacking is capped too, because a few hundred kilobytes of file can be built to unpack into
gigabytes: one Word, spreadsheet, slide, OpenDocument or e-book file may unpack to at most 64 MB and
list at most 5,000 parts, and one PDF may unpack to at most 64 MB. Past either, the file is refused
in a sentence rather than left to fill the machine's memory. A PDF is checked against its time
allowance before each page, so a long one stops and says how many pages it managed.

**What can be read**

| Kind | What comes out |
| --- | --- |
| Notes, Markdown, web pages, tables, JSON | The text, headings kept where there are any |
| Word (`.docx`, `.docm`) | Headings at the level the document gives them, paragraphs, tables, footnotes |
| Spreadsheets (`.xlsx`, `.xlsm`) | Every sheet under its own heading, one line per row; a formula gives the value it last worked out |
| Slides (`.pptx`, `.pptm`) | Each slide numbered, with its title, its words and the speaker's notes |
| OpenDocument (`.odt`, `.ods`) | The same, from what a free office suite writes |
| E-books (`.epub`) | The chapters in reading order, each under a heading |
| Rich text (`.rtf`) | The words, with the type-setting instructions dropped |
| PDF (`.pdf`) | The words, page by page, reconstructed from where they sit on the page |

**What cannot be read, said plainly**

- A PDF locked with a password is refused outright: open it with the password and save an unlocked
  copy first. Branch never tries to guess or break a password.
- A PDF that is pictures of text has no words to lift out. It says so, and you can ask for it to be
  read with a vision model instead, which sends the pages to whichever provider you have connected.
- A PDF written an unusual way — text drawn with an encoding the file does not describe, or streams
  packed in a way this reader does not unpack (only FlateDecode is unpacked) — comes back with those
  parts listed rather than silently missing. Lines are rebuilt from where text sits on the page, so
  a heavily designed page can come out in an odd order.
- `.doc`, `.xls` and `.ppt` — the formats before the current ones — are not read. Save as the newer
  format first. OpenDocument presentations (`.odp`) are not read either.
- Anything with no reader is listed on the knowledge base with a reason, never quietly skipped.

**What is sent where.** Reading happens entirely on this computer. What may leave it is exactly what
left it before: the passages sent to your provider's embeddings route so they can be compared by
meaning, under the same network policy as every other provider call, and only when you have such a
connection. Turning meaning search off keeps everything here. Asking a vision model to look at a
scanned PDF sends those pages to your provider, and only when you ask for it.

**Into a knowledge base.** A collection now walks every kind above. Passages are cut at headings,
slides, sheets and pages, so a citation says which one it came from. Reading a folder again compares
each file by its contents and leaves the ones that have not changed, so a second reading of a large
folder is quick; the progress line says how many were left alone (`unchanged`). Every file that could
not be read is kept against the collection with its reason, and `GET /api/knowledge` returns them as
`unread`.

**Asking about one file.** `documents.analyse` takes `{ file, question }`: it reads the file with the
right reader, finds the passages that fit, and answers with the heading and page each claim came
from. Tables inside the file are opened as figures the `data.*` tools can be pointed at, under the
names the answer lists. `documents.compare` takes `{ file, against }` and says in plain language what
was added, taken out or reworded, section by section. Both are under `documents.read`; the panel
under **Documents** has a box for each.

**Cards from a conversation.** `knowledge.propose` takes `{ sessionId, collection }`, reads a finished
conversation and writes up what is worth looking up again as fact cards: a title, a few sentences,
the turn it came from and how sure it is. Every card is a suggestion. Nothing reaches a knowledge
base until you accept it under "What it learns", and an accepted card is indexed and cited exactly
like a passage from a file. It is under `documents.write`. A conversation can repeat whatever a
document or a web page said, so every card is put through the same check that guards what comes back
from the web: a card that reads like an order to the assistant is never offered, and is refused again
if something else puts it in the queue — otherwise that order would outlive the conversation.

## How memory is organised (batch 25, wave 7)

Every saved fact now says two things about itself.

**What kind of thing it is.** A *preference* (how you like things done), a *fact about a person*, a
*fact about the world*, a *procedure hint* (how to do something), a *project note*, or *task scratch*
— a note the assistant made for itself while doing one job. A fact saved before this arrived, or
saved without a kind, counts as a fact about the world, which is exactly how it behaved before.

**How long it is meant to last.** *Working* is this conversation. *Task* is this job and no longer:
a task-scratch note is cleared when the job that made it ends, unless you asked to keep it. *Long
term* is everything else, kept until you forget it. A fact with no layer of its own is long-term.

Keeping a note (the `memory.keep` tool, or `POST /api/memory/{id}/keep`) moves it to long-term, which
is what spares it when the job ends. A cleared note keeps its last wording as a version, so it can
still be brought back. Facts can also belong to a **project**, and a fact tied to one project is left
out while another is being worked on.

**What reaches a task.** The facts put in front of a task are taken layer by layer in this order and
budget: working first (at most 6 facts), then task (at most 4), then long-term — stopping at 20 facts
or 2000 characters, whichever comes first. Within a layer the most useful facts come first, which is
the same ordering the Memory screen shows.

**Tidying.** "Tidy my memory" runs every check at once: the same thing saved twice, a newer fact that
disagrees with an older one, facts not touched in 180 days, facts never drawn on, and notes left over
from a job. It shows everything in one screen and **removes nothing** — each finding becomes a
suggestion you accept or reject under "What it learns", and accepting one sets the fact aside in the
archive where it can be brought back. A leftover note from a job has a **Keep this** button beside
it, so you can keep one for good instead of setting it aside.

It also ships as a recipe called **Tidy my memory**, so the steps are written down where you can read
them. That recipe stays a proposal on purpose: the recipe checker compares a step's whole result
against a fixed expectation, and a tidy report says what it found, which differs every time — so it
cannot be certified that way. Run tidying from the Memory screen, or by calling `memory.tidy`.

**Counts you can see.** `GET /api/memory/health` gives counts only — how
many of each kind and layer, how many are notes from a job, how many have never been used, how many
are set aside. No wording of any fact is included, which is why the same line goes into the
diagnostics folder as `memory.json`.

**Is it finding the right fact?** `branch eval memory` measures it. It loads the labelled set in
`data/memory-retrieval.json` under a scope of its own, asks every question, runs the nightly pass,
asks again, and reports the hit rate before and after. The set is a plain file: replace it with your
own facts and questions to measure your own kind of memory. The scope is emptied afterwards, so
nothing you actually saved is touched.

**Where facts are kept.** In this computer's own database, and only there. What that database has to
promise is written down as the `MemoryBackend` contract in `src/memory-backend.ts` — read, list,
write, search, forget and count, with owners never seeing each other's facts and nothing leaving this
computer unless you asked for it. The SQLite implementation is the only one that ships.

**Taking memory elsewhere.** The export is one fact per line, and it now carries the kind, the layer
and the project too, so a file written out and read back in comes back the same. Reading a file back
never makes a second copy of something already saved.

**Picking a conversation up on your phone.** Conversations already persist, and a paired phone
already reaches the whole app through the same door with the same key. `GET /api/sessions` is the
list that makes that practical on a small screen: the recent conversations with how each one started,
what was last said and who said it. `GET /api/sessions/{id}` then gives the messages. Both need the
same key as everything else, and remote access still listens only on the private Tailscale address,
so nothing here widens what can reach this computer.

New routes: `GET|POST /api/memory/tidy/all` (every check; `{ "stage": true }` turns findings into
suggestions), `GET /api/memory/health`, `POST /api/memory/{id}/keep`, and `GET /api/sessions`. New
tools: `memory.tidy` and `memory.keep` under `memory.write`,
`documents.analyse` and `documents.compare` under `documents.read`, and `knowledge.propose` under
`documents.write`.

## What Branch is not (batch 26, wave 8)

Branch Agent is one person's assistant on one Windows computer. A number of things the ledger asked
for belong to a hosted product with many customers, or to another operating system, and they are not
going to be built. They are written down here so nobody goes looking for them.

- **No screen control on a Mac or Linux outside the app.** There the screen and keyboard tools work
  only inside the Branch Agent app, whose own window carries the Stop notice; see "Using this
  computer's screen and keyboard".
- **No wake word.** Talk mode starts when you press the button or run the command. Nothing listens
  to the room waiting for its name, because that means a microphone open all day.
- **No outside vector databases.** Everything Branch remembers is searched in the SQLite file beside
  your own data. There are no connectors to Postgres, Redis, Qdrant, Pinecone, Chroma, Weaviate,
  MongoDB or Azure, because that would mean sending what you said to a server somewhere else.
- **No crash reporting service.** Nothing is sent to Sentry or anywhere like it. Problems are
  recorded in the traces and counters on this computer, where only you can read them.
- **No company sign-in.** There is no OpenID Connect, no single sign-on and no identity provider.
  The people who share this computer get named profiles with a PIN, and that is all.
- **No security keys.** There is no WebAuthn, no passkey and no fingerprint sign-in. The app is
  reached over a key on this computer or over your own private Tailscale address.
- **No invitations.** Accounts are not handed out. Nobody signs up; you create a profile for someone
  in this house and that is the whole of it.

## Passwords from the password manager you already have (batch 26, wave 8)

Branch can read a password out of Bitwarden or 1Password instead of keeping a copy of its own. You
write a reference where the password would go — `secret://bitwarden/GitHub Deploy`, or
`secret://1password/Private/GitHub/password` — and the real value is asked of that program's own
command line at the moment it is handed over, then taken straight back out of the transcript, the
traces, the receipts and any error message. Nothing is ever stored.

It is off until you turn it on, and then only for the vaults you tick. Branch only ever reads: it
never writes to a vault, never unlocks one and never signs in for you. If the command line is not
installed, or the vault is locked, Branch says so plainly and stops — it does not guess and does not
fall back to anything else.

Settings: `enabled` (off by default), `services` (`bitwarden`, `1password`), `bitwardenCommand`
(`bw`), `onePasswordCommand` (`op`) and `timeoutMs`. New routes: `GET|POST
/api/credentials/settings`. The look-up waits for the same unlock the secrets locker does, so a
locked app reads nothing.

## How tightly a program is held (batch 26, wave 8)

An approval rule can now say how a program Branch starts should be held, as well as whether to allow
it. There are three choices: **in a box with no way out to the internet** (Windows holds it to its
memory and processor limits, and it is pointed at a dead address), **in a box** (the same limits, but
it may reach the internet), and **no box** (the tool's own limits only). A rule that says nothing
leaves the tool doing exactly what it did before, so nothing changes until you choose.

The choice is on the rule as `sandbox` (`no-internet`, `limits-only`, `none`), it is shown on the
approval card before you answer, and `code.run`, `process.start` and the host-command tool all
honour it — the result each of them hands back says which box it actually ran in. It is not a
security boundary: the program still runs on this computer as you. It is you deciding how much rope
one tool gets.

A rule can only tighten what the settings already say, never loosen it. If Settings says scripts may
not reach the internet, a rule that asks for **in a box** or **no box** still leaves the internet
shut off for them; the box gets looser, the way out stays closed. To let scripts reach the internet
you turn that on in Settings, in one place, on purpose.

## Your own checks, before something happens (batch 26, wave 8)

A hook used to be told about things after they had already happened. There is now one more moment,
`tool.before`, which happens *before* a tool call goes ahead — and a hook registered for it can stop
the call. It prints one line of JSON: `{"decision":"ask","reason":"..."}` holds the call and puts the
question to you with that reason attached; `{"decision":"deny","reason":"..."}` refuses it outright
and the reason goes back to the assistant; anything else leaves the decision alone.

A check may only make the answer stricter. It can turn a yes into a question or a refusal; it can
never turn a refusal into a yes, and it is not consulted at all on something your settings already
said no to. If the check takes longer than its `timeoutMs` or falls over, the call is held for a yes
rather than let through, unless you set `onTimeout` to `allow` on that hook. Every time a check
changes what happened, it is written into "What the assistant was allowed to do".

## What each answer cost, in the terminal (batch 26, wave 8)

The status line at the bottom of `branch chat` has always carried the running totals for the whole
conversation — the model in use, tokens in and out, the money so far, and which approval preset is
on. Each answer now also prints one dim line under it saying what that answer alone used and cost,
so a single expensive turn is visible without doing the subtraction yourself. Nothing is printed
when no tokens were counted.

## What Windows itself allows (batch 26, wave 8)

Branch's own switches are not the only ones. Windows keeps its own, under Settings, Privacy &
security, and when Windows says no a program just sees nothing happen. Branch now asks first: before
it touches your screen it checks whether Windows will let it take hold of another program's window,
and the microphone and camera are read out of what you already chose. A refusal is one plain
sentence naming the page that turns it on (`ms-settings:privacy-microphone`,
`ms-settings:privacy-webcam`, `ms-settings:privacy-graphicscaptureprogrammatic`).

Only an outright "no" stops anything: a computer that keeps no such setting answers "nothing to say"
and Branch carries on exactly as before. New route: `GET /api/os-permissions`. Branch never asks
Windows to grant a permission — only you can do that.

**macOS and Linux.** Merely asking a Mac about one of these switches can put a question on the
screen, so on a Mac nothing is asked. The permissions route lists four switches — Microphone,
Camera, Screen & System Audio Recording, and Accessibility (pressing keys and clicking in other
apps) — each with an `explanation` in plain words and a `settingsLink` that opens its page
(`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`, `?Privacy_Camera`,
`?Privacy_ScreenCapture`, `?Privacy_Accessibility`). Every entry now carries `explanation`, on
Windows too. On Linux the desktop session is what decides: with an X11 session screen control can
work (with `xdotool`); on Wayland, or with no desktop session at all, the screen is reported as
unavailable with the reason, and the microphone and camera are explained as having no single switch.
The route also returns `platform`, and on Linux `session` (`x11`, `wayland` or `none`). **Settings →
What this computer allows** (`public/os-permissions.js`, home `settings:computer`) shows the list on a
Mac and on Linux: each switch with its explanation, on Linux the session type, and on
a Mac an **Open System Settings** button that opens that one page only when you press it (in the app
through its own link opener, which accepts only these four pages). On Windows the card is not shown.

## Commands nobody has ruled on (batch 26, wave 8)

A command on this computer is the one thing that can do absolutely anything, including things none
of Branch's own tools offer. Until now, a command that no rule mentioned was simply run. It is now
put to you instead, whatever preset you are on, and answering yes writes a standing rule for that
command — so it is one question the first time and nothing afterwards.

**What changes for you.** If you have been using Branch already, the first time it wants to run each
kind of command you will see one extra question, naming the command. Say "yes, always" and you will
not be asked about that one again. Nothing else changed: a file, a web page or a message that no
rule mentions is still simply allowed, exactly as before. If you would rather have the old behaviour
back, set `unmatchedCommands` to `allow` on the approval settings; the rules you already have are
untouched either way.

## What each person here may do (batch 26, wave 8)

A profile already keeps one person's conversations and saved facts apart from everybody else's. It
now also says what they may have Branch do. There are three roles. **Owner** may do anything.
**Adult** may read, write files, run commands, use web pages and send messages, but may not change
how Branch is set up and may not spend money. **Child** may look things up and answer questions, and
nothing else.

Alongside the role, the owner can hold a profile to particular projects and to a daily allowance.
All three are checked at the tool boundary, in the same place the approval rules are checked, so
there is no way round them; a refusal is one plain sentence naming the person and what is missing. A
grant can only narrow what a role allows, never widen it, and the owner is never held to any of it.
Each person's card on the People screen shows their role and what they are held to.

New routes: `GET|POST /api/profiles/{id}/role` (only the owner may set one). The grant is
`{ role, categories, projects, dailySpendLimit }`; `categories` uses the same seven kinds the
approval settings group tools by.

## Doing a task again, and reading the difference (batch 26, wave 8)

"Look inside" now has a **Do this again** button. It runs the same task a second time — the same
words, the same tools it had, the same model that answered it — in a conversation of its own, so the
second answer is not shaped by the first. The two then open side by side on the screen that already
compares two tasks: what each cost, how long each took, how many rounds and tools each used, and the
difference between the two answers line by line.

This is how a change to a prompt, a model or a set of rules is judged: run the same thing twice and
read the difference, rather than remembering what it did last week. What each task was allowed to
reach is now recorded when it starts, which is what makes "the same tools" a real promise. New
route: `POST /api/runs/{id}/replay`.

## More ways to put several specialists on one job (batch 26, wave 8)

Three new tools, all over the fan-out engine that was already there. Every sub-task goes through the
same budget, the same approval rules and the same record as any other delegated task.

- **`delegate.supervise`** — one specialist you name is put in charge. It splits the job between the
  workers you name, they do their parts at the same time, and it writes the one answer that comes
  back. The splitting is its own piece of the code, so a split can be read and checked on its own,
  and work given to somebody who is not on the team is dropped rather than guessed at.
- **`delegate.swarm`** — several specialists work down one shared list of things to do. Each takes
  the next item nobody else is holding, and anything a worker cannot finish goes back on the list
  for somebody else rather than being lost.
- **`delegate.route`** — works out which one of several specialists a request belongs to, from a
  short description of what each one is for, then hands it straight to that one.

**Handing work on.** `delegate.handoff` now takes a reason, and the handover is written into the
conversation — "Handed over from X to Y: why" — so a person reading it afterwards can see the work
change hands. You can also write down who each specialist may hand work on to; with a list, a
handover to anybody else is refused in plain words, and without one nothing changes.

**Not built, deliberately.** Three things the ledger asked for here are not in Branch and are not
planned: a second model on its own context putting notes into every turn of a task; a separate
"turn this design into tasks" step beyond the plan the assistant already makes; and a sequential
action-planning step inside a role loop. Each would be a second engine beside the plan-and-fan-out
one that already does this work, which is complication without a matching gain for one person's
assistant.

## The long tail: the API description, kept answers, whole sets, Lockdown, branches and projects (batch 21, wave 8)

This section closes the "other" theme of the capability audit. Some of it is new, some of it points
at a feature that already does the job under a different name, and some of it is written down here
as deliberately not built.

### The app's own web API, described (A0758)

Branch has had a web API since the beginning — `/api/*`, the OpenAI-shaped `/v1/chat/completions`
and `/v1/models`, and the client library in `packages/sdk`. What was missing was a description other
programs could read.

- `GET /api/openapi.json` is an OpenAPI 3.1 description of the routes worth calling from outside.
  Every request shape in it is generated from the same zod schema the server checks that request
  with, so the description cannot drift from what the app will actually accept.
- `node scripts/write-api-docs.mjs` writes the readable version to [docs/api.md](api.md). Run it
  after `npm run build`.
- Every operation in it says the session key is required and what a missing or wrong one gets back;
  the API is not open to anything that has not been given the key the app printed when it started.
- The description is the only thing under this heading anybody with the session key may simply read;
  everything else here belongs to the owner.
- A test asserts that every route the description names is really answered by the server, so it
  cannot promise a route that does not exist.

The routes themselves are listed in `src/api-openapi.ts`. Routes that only the app's own screens use,
and the ones that write their own answer (a backup file, a spreadsheet), are left out on purpose.

### Asking the same thing twice: kept answers (A0928)

Off until you turn it on. When it is on, the exact request that would go to the model — every
message, the model, the effort, the tools it was shown — is reduced to one hash, and the answer is
kept against it for a while. An identical request is then answered from what was kept: nothing
leaves this computer and nothing is charged.

- `GET /api/request-cache` — whether it is on, how long an answer counts for, how many are kept.
- `POST /api/request-cache` with `{ "enabled": true, "ttlMinutes": 60, "maxEntries": 500 }`.
- `POST /api/request-cache/clear` throws every kept answer away.

Three rules keep it honest. **An answer that asks for a tool is never kept**, because replaying it
would replay whatever that tool does — only plain text answers are. **Nothing that carried a picture
or the name of a saved secret is kept at all.** And the kept answers are filed under whoever is using
the app, so a second person in the household never reads one of the owner's answers back out.

A secret is named as `secret://project/NAME`, and the place it most often appears is not the words of
a message but the **arguments of a tool call** the model asked for earlier in the same conversation —
a deploy command, a header, a sign-in. Those arguments are part of the request, so they are read by
the same rule: a conversation carrying one anywhere is never kept.

A request is only the same request when everything the model was shown is the same: the messages
(your instructions among them), the model, the effort, and every tool by name *and* by the words
describing it. Change any of those and the question is asked afresh.

On the "Look inside" screen a round answered this way is marked `cached`, its cost shows as nothing,
and the reason is written beside it. The kept answer is looked for before anything is charged, so the
figures per project agree with the inspector: a round that never reached the provider counts nothing
in either place. One consequence worth knowing: a task that has reached its token ceiling can still
be answered from a kept answer, because nothing is charged for one. The limit on how many steps a
task may take still stops it.

Kept answers live in the settings table, so they travel in a backup and they stay there when you
switch the cache off. `POST /api/request-cache/clear` is what throws them away.

### A whole set of questions at once (A1351, A1352)

Off until you turn it on. OpenAI and Anthropic will both take a large set of questions at once, work
through it in their own time and charge about half. Reading a whole knowledge base is exactly that
shape: each part of it is summarised on its own before the parts are drawn together, and those parts
do not depend on each other.

- `GET /api/batch` — the settings, and which of your connections can take a whole set.
- `POST /api/batch` with `{ "enabled": true, "pollMs": 5000, "maxWaitMs": 600000, "discount": 0.5 }`.
- `POST /api/batch/run` with `{ "questions": [{ "id": "q1", "prompt": "…" }] }` hands the set over,
  waits for it, and gives the answers back.
- `GET /api/batch-sets` — every set handed over, what it cost and what handing it over saved. This
  is what the **What asking a whole set at once saved** panel on the Usage screen reads.

`discount` is how much less a set costs than the same questions asked one at a time. Both services
charge half at the time of writing, so it is `0.5`. The price tables price a model at its ordinary
rate, so this is the number that turns that rate into what a set actually cost and into what handing
it over saved; change it if your agreement with a service says something else.

**Which connections can take one.** A set only goes over where the address really is the service
that offers one: `api.openai.com` and any `*.openai.azure.com` deployment for an OpenAI-shaped
connection, and `api.anthropic.com` for an Anthropic one. Plenty of services speak the OpenAI shape
for ordinary questions without having a set endpoint at all, and claiming they do would only make
every set fail and fall back. `GET /api/batch` says `takesWholeSets` per connection so you can see
which of yours can.

**The two roads are different underneath.** OpenAI wants the questions uploaded as a file of one
question per line, then a set created against that file, then the answers fetched back as another
file — and the questions that failed on their own come back in a second file, which is read too.
Anthropic takes the questions in the request itself and hands back an address to read the answers
from; that address is checked against the address you configured before anything is fetched from it,
so a service that answered with somewhere else cannot make this app fetch from somewhere else. Both
are reduced to the same three steps, so nothing above has to know which service it is talking to.

**A set that only half works keeps the half that worked.** Whatever came back is collected first,
even when the service called the whole set failed, and only the questions with no answer are asked
again one at a time. Nothing already answered is paid for twice. The answer says how many were
answered in the set, how many had to be asked again, and how many nothing could answer at all — and
the ids of each, so a caller can say which part of the work is missing rather than quietly dropping
it. Anything that goes wrong before that — the connection cannot do it, the hand-over is refused,
nothing at all came back — falls back to one ordinary call per question and says in one line why.

**A set carries words only.** A question with a picture in it would reach the service without the
picture, which is a different question, so a set containing one is asked one at a time instead and
says so. Being stopped part-way is not treated as a failure either: a cancelled set stops rather
than quietly asking every question again on its own.

What a set cost is read from what the service reported, never guessed.

### Chat engines (A0847) — not applicable

This row asks for "chat engines": a way of plugging in different chat back-ends behind one
interface. Branch already has exactly that and has had since the first release, under a different
name. `Provider` in `src/contracts.ts` is the interface; `src/providers.ts` and `src/providers/`
hold the implementations (OpenAI-shaped, Anthropic, Gemini, Azure, Bedrock, Cohere, Ollama, the
signed-in ChatGPT connection, a command-line agent, and the demo); `src/models.ts` picks between
them, falls back when one is failing, and keeps a cooldown. Adding a second name for the same idea
would mean a wrapper with no caller, so nothing was built for this row. If you want to add a chat
back-end, implement `Provider` and register a preset — that is the whole contract.

### Lockdown: one switch (A0615)

- `GET /api/lockdown` — whether it is on, since when, and in plain words what it stops.
- `POST /api/lockdown` with `{ "on": true }` or `{ "on": false }`.
- It also sits at the top of the sidebar.

Turning it on makes **every tool wait for your yes**, and switches off running a script (`code.run`),
leaving a program running (`process.start` refuses by name, because the list of programs allowed to
be left running is emptied), using your screen and keyboard, borrowing your browser, sending messages
out, and telling other programs what happened. It also ends every "yes, just for this conversation"
you gave earlier, so nothing that was already said yes to carries on unasked. Only the owner can turn
it on or off: under someone else's profile the route refuses. It is kept in the database, so it is
still on after the app is closed and opened again.

What it does **not** switch off, because there is no switch to throw:

- **Running a command** (`shell.execute`) is held to "ask", like every other tool, rather than being
  refused outright.
- A **server for another AI tool** that is already set up stays reachable; every tool call through it
  waits for your yes like any other.

Turning it off puts back **exactly** the settings that were there before — they are copied, untouched,
before anything is changed, and a switch that had never been saved at all is left unsaved rather than
given a made-up default. Both moments go into the record of what the assistant was allowed to do.

### Branches, as a shape (A0390)

Conversations have always persisted, and one conversation could already be branched off another at a
chosen message (`sessions.branch`). Two things are added:

- `GET /api/sessions/{id}/tree`, and the tool `sessions.tree`, give the whole shape a conversation
  belongs to — from the one at the root down through everything branched off it, each with what it is
  about and which message it came off. The sidebar draws it when there is one.
- `POST /api/sessions/{id}/merge-note` carries a branch's last answer back into the conversation it
  came off, as **one note** marked as coming from the branch. Nothing already said is rewritten and
  the branch is left exactly as it was. This is the owner's own choice, made from the sidebar, so it
  is not offered to the model.

### One flow inside another (A1274), and flow checkpointing (A0834)

A flow step may now be `{ "kind": "flow", "flowId": "…" }`: it works through another saved flow
before carrying on. Flows may go three deep, and a flow that leads back to one already running is
refused by name rather than looping.

Checkpointing was **already there** and is not new work: every step's state — where it got to, how
many tries, what it said, which task it ran — is written to `workflow_state` as it happens, and the
flow's cursor is saved with it. Closing the app mid-flow loses nothing; `POST /api/flows/{id}/resume`
picks up at the step it stopped on.

### What a project brings to a task (A0794)

Projects already carried their own instructions, a preferred model connection, a folder and their own
secrets. They now also carry:

- `profile` — the way of working its tasks start from (see routing profiles), and
- `knowledgeBases` — the collections of your own documents its tasks look in when no collection is
  named.

Each is only a starting point: anything chosen for this conversation still wins.

Every task also records the project it was done under, settled when it starts and never changed
afterwards. `GET /api/projects/costs?days=30` adds the figures up a project at a time. Tasks whose
model has no price on file are counted separately rather than shown as nothing.

### Watching a folder (A0344)

`branch watch <folder> <procedure-id>` runs a saved procedure whenever a file under that folder is
written. A burst of saves settles into one run; it never runs twice at once; `node_modules`, `.git`,
`dist` and `.branch` are ignored, as are temporary files. `--once` stops after the first run and
`--settle <ms>` changes how long it waits. Ctrl+C closes the watcher and waits for whatever is
running to finish.

### Already covered elsewhere

These rows of the audit are done, by a feature that exists under another name.

- **A1011 local studio / playground** — the developer playground: `GET /api/tools/forms` gives a form
  for every tool and `POST /api/tools/try` runs one by hand, through the same approval gate, scrubbed
  on the way out.
- **A0279 human-in-the-loop executor** and **A0624 approval-gated side effects** — the approval gate
  (`src/approvals.ts`): a task stops, the question is kept with what it is about, and the owner's yes
  is remembered for this conversation or as a standing rule. Whole kinds of thing can be decided at
  once (`POST /api/approvals/categories`), and "ask me questions first" runs before a task starts.
- **A0323 OAuth login flows** — `src/oauth.ts` is the standard authorization-code flow with PKCE:
  the service's own page opens in the default browser, the answer lands on a tiny page on this
  computer, the key goes straight into the locker. Branch never sees the password.
- **A0354 Answer Engine**, **A0355 shareable pages**, **A0840 metadata filtering**, **A1745 retriever
  pipeline** — knowledge bases with word and meaning search, a second ranking pass
  (`src/retrieval.ts`), numbered sources on every answer (`src/citations.ts`), and a conversation
  shared as one page that can do nothing (`src/conversation-share.ts`).
- **A0847 chat engines** — the runtime is the chat engine: conversations, compaction, tool rounds,
  per-conversation model choice and working styles.
- **A1410 structured output** — a delegated task may be required to match a JSON shape
  (`resultSchema`), checked before the answer is accepted. Pydantic is a Python library; the same job
  is done here by zod and JSON Schema.
- **A1509 SDKs** — the TypeScript client is `packages/sdk`, and its types are generated from the app's
  own checks by `scripts/generate-sdk-types.mjs`. Other languages need no library of ours: the
  OpenAPI description above is enough to generate one.
- **A1561 action trace recording** and **A1589 bounded visual trajectory** — a task's whole trajectory
  is written as one JSON file (`src/trajectory.ts`), spans and all, with secrets scrubbed; pictures
  are capped per turn and never written into the conversation store, so they are not replayed.
- **A1979 self-evolution** — skill governance drafts a better version of a skill from a task that went
  well, benchmarks it against the old one and keeps the owner's answer (`src/skill-governance.ts`,
  `src/skill-revisions.ts`). Unbounded self-modification is deliberately not offered.
- **A2001 prompt library** — saved procedures with named inputs (`src/recipes.ts`) and templates that
  carry one between installs (`src/templates.ts`).
- **A2243 background terminal sessions** — programs left running (`src/processes.ts`), with the owner
  naming which programs may be left running at all.
- **A2315 headless mode** — `branch run --json` prints one JSON object per line and exits with a code
  a script can read; `branch mcp-serve` and `branch acp-serve` speak over standard input and output.
  Nothing needs a window.
- **A2334 artifact file operations** — `src/artifacts.ts` for what a task produced and
  `src/build-artifacts.ts` for kept versions with sizes and checksums.
- **A2377 fallback dispatch** — a failed connection is passed over for the next one in the fallback
  order, with a cool-off and a sentence saying why (`src/provider-retry.ts`, `src/provider-health.ts`).
- **A1193 bidirectional live streaming** — talk mode plus the per-task WebSocket already carry speech
  and text both ways. A provider's own realtime socket stays deferred, as recorded in wave 7.

### Deliberately not built

- **A0098 embedded code editor** — the Documents and "Look inside" screens show code read-only with
  syntax colouring, which is what a desktop assistant needs. A full editor is not: the owner already
  has one, and building a second would be a worse version of it.
- **A2375 configurable intent pipeline** — skill discovery and dispatch already choose what to do. A
  pipeline the owner configures would be a second, competing way to decide the same thing.
- **A1976 personal knowledge base on a graph database** — needs a graph store running alongside; the
  knowledge bases here do the same job on the SQLite file that is already there.
- **A1749 Gradio interface** and **A1611 side-panel chat** — Gradio is a Python web toolkit; the web
  app here is the interface. A browser side panel is an extension, not part of a local app.
- **A0663 C FFI** — calling native libraries from the assistant would put unsandboxed native code
  inside the app. Anything needing that is a program the owner runs through the shell tools.
- **A1468 ADB operator** — driving an Android phone over USB is not a local Windows desktop
  assistant's job.
- **A0602 Ultracode plugin lifecycle** — another project's plugin format. Branch has its own
  (`src/plugins.ts`, `src/plugin-catalog.ts`) with fingerprints and an explicit switch.
- **A1141 LiteLLM** — a Python proxy in front of many providers. The provider catalog and the
  OpenAI-shaped adapter reach the same services directly, with no extra process to run.

## Writing documents, and a knowledge base that knows what is in it (batch 27, wave 8)

Branch could already read a Word file, a spreadsheet, a slide deck, a PDF and an e-book. This batch
is the other half of that: writing them, changing them, and knowing what a whole knowledge base
holds rather than only which passage answers one question. Nothing new was installed to do any of
it — an Office file is a folder of XML inside a zip, and Node already packs and unpacks zips.

### Writing a document (A2145, A2263)

`documents.write` saves a file into your workspace: `.docx` for Word, `.xlsx` for a spreadsheet,
`.pptx` for slides, or `.md` and `.html` for a note and a web page. You describe what goes in it in
pieces — a heading, a paragraph, a list, a table; sheets of figures for a spreadsheet; a title and
bullet points for a slide, with a picture the assistant made earlier able to take a slide of its
own. Figures in a spreadsheet stay figures, so you can add them up, and a cell the assistant worked
out is written as the sum it stands for with the answer beside it, so the spreadsheet recalculates
the moment you change a figure. Columns can be shown as plain numbers, money, a percentage or a
date. A sheet can be filled straight from a table the task already opened with `data.load`.

`documents.edit` changes a Word or spreadsheet file that already exists: replace some wording, add a
section at the end, replace a table, or add or replace a sheet. The promise it keeps is narrow and
worth stating: every part of the file the change did not touch comes back as the very same bytes,
not as a re-saved copy that happens to say the same thing. A Word file with your company template, a
footer and a picture in it still has all of those, untouched, after one sentence in it is changed.
The one case that cannot be silent is a phrase spread across differently formatted pieces — half of
it bold, say: that paragraph is rewritten as one piece and the answer says so, so you can look.

Both are under the same permission as any other change to your files, and both go through the same
before-and-after the ordinary file tools use, so a document the assistant wrote can be undone like
anything else it did.

**What this is not.** There is no live document that two people type in at once. Branch writes a
file, or changes one, and hands it back. It does not know what anybody else is doing in that file
while it is open in front of them, and it says so in every answer it gives.

### Pictures as documents (A0946)

A photograph of a meter, a screenshot of an error, a scan of a receipt: these used to be listed as
files that could not be read, because there are no words in them to lift out. `knowledge.pictures`
asks a model that can see to describe each one in plain words — including any words, numbers and
readings visible in it, which is what makes a screenshot or a scan worth having — and indexes that
description beside the picture, so a search finds it and the answer cites the picture itself.

Each picture is described once and once only: the description is kept against a fingerprint of the
picture's own bytes, so the same picture in two knowledge bases, or the same folder read again next
month, costs nothing. Ask with `estimateOnly` first and it says how many pictures would be sent and
to which model, and sends nothing. When none of your connected models can look at a picture it says
so in one sentence and sends nothing at all.

### Summing up a knowledge base (A1668, A2362)

`knowledge.summarise` writes a short account of everything in one knowledge base, or of one subject
in it. A knowledge base does not fit in one request, so each batch of passages is summarised on its
own and the batches are then drawn together; every point carries the number of the passage it came
from, and the sources are listed underneath. The answer is kept against a fingerprint of the
collection's passages, so asking twice costs nothing and one changed file is enough to make it be
written again. With nothing connected, or when the model cannot be reached, it still answers — with
the opening of each passage and its number — and says why it reads as it does.

### Looking after a knowledge base (A1867, A2036)

`knowledge.manage` renames one, merges one into another, or splits one folder out into a knowledge
base of its own. The passages move; nothing is read again and nothing is charged. The Documents
panel can save a whole knowledge base out as a plain zip of Markdown with a small list of facts
beside it, and bring one back from that zip as a new knowledge base — which is a backup, and also
how you move one between computers. The panel shows what each holds and what reading it has cost.

`knowledge.refresh` reads your last few conversations and suggests fact cards for one knowledge
base. It adds nothing: each card waits in the Memory screen until you accept it, exactly as with
everything else the assistant proposes to remember. Accepting one indexes it like a passage from a
file, so a search finds it and can cite it.

### A light map of what a knowledge base mentions (A0994)

`knowledge.map` builds a map of the names a knowledge base talks about and which of them are
mentioned together; `knowledge.graph` answers for one name with everything linked to it, one or two
hops out. It answers the question a passage search is bad at — "everything you know about this
supplier", where the answer is spread over eight files that never use the same words twice — and one
hop through it is another way of finding passages, beside words and meaning. The Documents panel
draws the neighbourhood as a simple read-only picture with the file behind each link named under it.

**The limits, said plainly.** The map is built from names as they are written in the files, not from
understanding. Two spellings of one company are two entries. A name that is also an ordinary word
shows up as both. With nothing connected, "mentioned together in the same passage" is the only link
it can find, and that does not say how the two are related — which the answer states every time.
Where a model is connected and you allow it, the model names the relations properly instead. Either
way, every link carries the passage it came from, so nothing here has to be taken on trust.

### Age and size limits for knowledge

You can set how long a knowledge base may keep files and how large it may get. Nothing is removed by
a limit: each knowledge base over one becomes a suggestion in the Memory screen that says to save it
out first. A knowledge base built over months should never quietly shrink because a number was
crossed while nobody was looking. These are the same two figures the conversation-retention setting
uses — how long, and how much — so there is one idea in the product rather than two; that setting had
not landed when this was written, so this keeps the minimal shape and will read from it when it does.

The three figures (`src/knowledge-manage.ts`, `RetentionSchema`, saved under the settings key
`knowledge-retention`, read and written through `POST /api/knowledge/retention`): `keepDays` is how
many days a file may go unread before it is suggested for removal, `maximumDocuments` how many files
one collection may hold, and `maximumChunks` how many passages. **Zero means no limit**, and all
three are zero until you set them, so nothing is suggested until you ask for it.

### What the assistant remembers, as Markdown in your workspace (A2185)

Everything the assistant remembers is written into a `memory/` folder in your workspace as ordinary
Markdown: one note per kind of fact, rewritten from scratch each time. The database stays the real
store; this is a window onto it, which makes what the assistant knows readable in any editor,
searchable with any tool, and — because it is a folder of Markdown — usable by a notes app such as
Obsidian pointed at the same workspace.

The folder is read-only to the assistant's own file tools. A change made in it would be undone the
next time the mirror is written, and a change nobody can keep is worse than a plain refusal, so
`files.write` refuses it in one sentence that says where to change the fact instead.

For the same reason **there is no tool that writes the mirror**: giving the assistant a second way
into the one folder it may not edit would take the refusal back. Instead:

- The folder does not appear until you ask for it. `POST /api/memory/mirror` — the button on the
  Memory screen — writes it the first time. Nobody's workspace grows a folder they never asked for.
- After that it keeps itself up to date: every task that finishes writes the notes again if what is
  remembered has changed, and skips the writing when it has not.
- Deleting the folder is how you stop it. Nothing puts it back until you ask again.
- Send `{"force": true}` to write the notes even when nothing has changed.

A knowledge base never reads these notes back in. A collection pointed at your whole workspace skips
the mirror folder (`KnowledgeBases.skip`, wired in `src/index.ts`), because otherwise the assistant
would end up quoting its own notes back to you as though they were a document of yours.

This is *not* the [notes-folder bridge](#your-notes-folder-the-obsidian-bridge-batch-22-wave-8).
That bridge writes tagged notes into a vault folder you name, through `insideVault`; the mirror
writes into your workspace, through the ordinary workspace checks, and never resolves a vault path.
One caution if you use both: if you point the notes folder at your workspace and call its folder
`memory`, the bridge writes straight to disk and does not go through the read-only rule above, so a
note it syncs there would be wiped the next time the mirror is written. Give the bridge a folder of
its own.

### Text pasted in for one job (A1117)

`scratch.text.add` holds a piece of pasted text for one job only: it is cut into passages,
searchable while the job runs, and dropped the moment the job ends. Nothing is written to the
database and nothing is sent anywhere to be compared by meaning. It is for the three pages of a
contract you want to ask four questions about and then be done with — which does not belong in the
document library, where it would sit for good, nor in the conversation, where it would fill the
space in front of every later turn with text that stopped mattering an hour ago.

### Worked examples: finding the right passage (A1144)

Three whole runs through, from nothing to a cited answer. Everything here is on this computer unless
a step says otherwise.

**A folder of your own work.** Put the files in `workspace/house`. `POST /api/knowledge` with
`{"name":"House","sources":[{"kind":"folder","path":"house"}]}` makes the collection;
`POST /api/knowledge/reindex` with `{"collection":"<id>"}` reads it once, cutting each file into
passages that keep their
headings, sheets, slides and pages. Then `knowledge.search` with `{"query":"who services the boiler"}`
searches by words and, where comparing by meaning is switched on, by meaning as well, and returns
passages each naming its file and heading. `knowledge.ask` does the same and writes the answer, with
`[1]`-style marks and the numbered list of sources underneath. Reading the folder again compares each
file by its contents, so only the changed ones are read a second time, and files that look like
secrets are never read in at all.

**Something said in a conversation.** With review switched on, a finished task is read back by the
model and anything worth keeping becomes a *suggestion*, never a saved fact. Accepting a knowledge
card (`POST /api/memory/proposals/{id}/accept`) puts it into the collection named on the card through
`KnowledgeBases.putDocument`, cut and stored exactly like a file. A later question finds it through
the same search, with the knowledge base named as where it came from — that whole round trip is
`tests/docs-3.test.mjs` D18.

**Three pages you will not need tomorrow.** `scratch.text.add` with `{"name":"Contract","text":"…"}`
holds it for this job: `scratch.text.search` finds passages in it, the common retriever offers them
beside every other source, and when the job ends the store is dropped on `onRunFinished`. Nothing
reaches the database and nothing is sent away to be compared by meaning.

Which retriever answered is always on the passage, in `from`: `knowledge`, `documents`, `memory`,
`knowledge-graph` for one hop through the map, or `task-text` for the third example. They all sit
behind the one `Retriever` interface in `src/retrieval.ts`.

### Routes

`POST /api/knowledge/summarise`, `/api/knowledge/graph`, `/api/knowledge/map`,
`/api/knowledge/pictures`, `/api/knowledge/manage`, `/api/knowledge/refresh`,
`/api/knowledge/export`, `/api/knowledge/import`, `/api/knowledge/retention`,
`/api/knowledge/retention/check`, and `GET /api/knowledge/extras` for the panel.
`POST /api/memory/mirror` writes the Markdown mirror of what is remembered.

### Already covered, and not applicable

- **A1013 pluggable storage domains** — VERIFIED as already built: `src/vector-store.ts` defines the
  `VectorBackend` contract and `src/memory-backend.ts` the memory one, both with the shipped SQLite
  backend behind them, and `src/retrieval.ts` puts every way of finding passages behind one
  `Retriever` interface that this batch adds two more to.
- **A2264 PDF processing** — VERIFIED as already built in wave 7: `src/document-pdf.ts` lifts text
  out of a PDF, marks its pages, and says plainly when a PDF is pictures of text rather than text.
  This batch adds the other half of that sentence: pictures can now be described.
- **A1144 worked examples of finding the right passage** — this section, with the examples above.
- **A1426 RAGFlow knowledge search** and **A2343 embedded knowledge base** — not applicable: both are
  external services to run alongside. The knowledge bases here do the same job on the SQLite file
  that is already there, with nothing else to install or keep running.
- **A2168 long-term memory with QMD retrieval** — not applicable, for the same reason: it needs an
  external retrieval service. Memory here is searched by words, by meaning and now through the map,
  all on this computer.
- **A1425 pluggable memory backends** and **A1475 pluggable session storage** — already documented;
  the contracts exist and one backend is shipped.

## What Branch is not (batch 22, wave 8)

Some rows of the audit describe a *demonstration written for one Python or Rust toolkit*, not a
capability. Branch is a local Windows desktop assistant with one web app of its own, so these are
recorded here as deliberately out of scope rather than left open for ever.

- **A1131 Gradio UI**, **A1536 Gradio web application** — Gradio is a Python notebook-style web
  toolkit. Branch's own web app is the interface; adding Gradio would mean running Python beside the
  app to draw a second, worse one.
- **A1676 Streamlit demo UI**, **A2198 Streamlit web UI** — the same, for Streamlit.
- **A0419 Chainlit UI example** — the same, for Chainlit: a Python chat front end for a Python agent.
- **A1435 Next.js web chat** — a React/Next.js chat app is a second front end to keep in step with
  this one. The web app here is plain modules served by the app itself, with no build step.
- **sdk-react (React SDK)** — likewise a front-end library for somebody else's page. The TypeScript
  client in `packages/sdk` and the OpenAPI description are what an outside page talks to.
- **A1905 Interactive terminal coding agent** — Branch's terminal interface is `src/terminal-tui.ts`
  in the same Node process as everything else. A Rust TUI would be a second program to ship, sign
  and update for no new behaviour.
- **A2200 Desktop pet UI** — a floating animated character on the desktop. Branch's desktop presence
  is a window and a tray icon; a pet is charm, not capability, and it would need the always-on-top
  overlay the screen-control rules deliberately forbid.
- **A1984 Multi-user web chat** — Branch is single-owner by design: one person, one workspace, one
  set of keys on their own computer. Sharing is a read-only page (`src/conversation-share.ts`) and a
  paired remote listener, never a second account.

### Already covered, under another name (batch 22, wave 8)

- **A0527 chat web UI**, **A0704 local web UI**, **A0956 web UI example**, **A1192 development web UI
  and API**, **A1774 web control UI and WebChat**, **A2033 web console**, **A2157 web management
  panel** — all one thing: the app shell in `public/index.html` with the rail, the conversation
  column and the ten sections (see docs/design.md), served by `src/server.ts` on this computer and
  covered by `tests/shell-ui.test.mjs` and `tests/web-ui.test.mjs`.
- **A2015 Web dashboard and webchat** — the audit's "no file upload UI" is out of date: the Documents
  section takes a file from disk and accepts one dropped on the page (`public/documents.js`).
- **A0401 Dashboard and desktop** — the desktop app is `src/desktop/main.ts` with its own settings,
  updater and conversation export; see "The desktop app" above.
- **A1585 Cross-platform GUI control** — screen and keyboard control is
  `src/integrations/desktop.ts`, behind its own switch and the Stop banner. On a Mac and on Linux it
  runs inside the desktop app only, while the app's own Stop window is showing (wave mac2).
- **A1452 Web crawling** — `src/integrations/web.ts` fetches and reads a page through the network
  policy, and `src/integrations/browser.ts` drives a real browser when a page needs one. There is no
  Crawl4AI: it is a Python library, and a whole-site crawler is not something a personal assistant
  should be able to start on its own.
- **A2197 Terminal UIs** — the terminal interface is `src/terminal-tui.ts`: the conversation, the
  live task, approvals and the token figures for each round, drawn with the app's own style helpers.
  It is Node, not Rust, and that is the whole of the difference the audit found.
- **A1522 Browser recording artifacts** — `src/integrations/browser-trace.ts` keeps everything the
  browser did during one task as a single Playwright trace file, off unless the owner asks.
- **A1637 Live WebSocket run channel** — `src/ws.ts` carries the run lifecycle and is authenticated:
  the session token travels in `Sec-WebSocket-Protocol` as `bearer, <token>` and is compared in
  constant time.
- **A0500 Tracing and debugging**, **A1677 pipeline logging and usage accounting**, **A0798 run and
  vertex monitoring** — `src/tracing.ts` opens a span for the run and for every model round, tool
  call, retrieval, delivery and sub-task inside it, with the usage figures on the model spans; the
  inspector draws them.
- **A0400 Usage analytics**, **A0367 usage analytics and reports** — the Usage section's month view
  (`src/usage.ts`, `src/pricing.ts`) plus "Save as report" below, which writes the same figures out
  as Markdown, a page, or print.
- **A0605 Approval-gated plans** — the approval gate (`src/approvals.ts`) holds a task at a step and
  keeps the answer; the to-do list below is where a plan's steps are now written down and ticked.
- **app-building (App-builder SDK MCP server)** — Branch is itself an MCP server (`branch mcp-serve`,
  `src/mcp-server.ts`), so another tool can drive it; and the artifact frame below is the same
  sandbox that shows a small page an MCP server sends back.

## Artifacts: what a reply can show as well as say (batch 22, wave 8)

When a reply carries a fenced `html`, `svg` or `chart` block, Branch shows it as a card beside the
words rather than leaving markup to read. Four buttons sit under it: **Open larger**, **Copy code**,
**Save to workspace**, and — for a `javascript` or `python` block — **Run this script**.

**A page or a drawing goes into a frame that is sealed shut.** It is served from Branch's own
address at `/artifact/<name>`, under the same content policy an MCP app gets (`src/mcp-apps.ts`):
`sandbox` with nothing after it, which gives the page an origin of its own and stops every script,
plus `default-src 'none'`, which refuses every fetch. The frame itself carries `sandbox=""` — no
`allow-same-origin` — so it cannot reach the page around it, the session key, or the network.
Unlike an MCP app's address, an artifact's is **not** used up by the first fetch: a frame may
reload and "Open larger" may show the same one again. It expires after ten minutes.

The app's own colours are passed in as CSS variables, read off the running page, so an artifact
matches the theme instead of fighting it. Every value is checked against a short pattern first.

**A script is never run by the frame.** The frame runs nothing at all. The button is a button on
Branch's own page, and it goes through `POST /api/tools/try` to `code.run`, which is off until the
owner switches it on in Settings → Developer and which stops to ask like any other tool.

**Charts** are drawn in the page from a `chart` block — `{"type":"bar|line|pie","title":…,"data":
[{"label":…,"value":…}]}`. The number under the pointer is written out in words, the same numbers
can be shown as a table instead, and **Save as a picture** turns the drawing into a PNG using the
browser's own canvas. Nothing is drawn on this computer's side and no drawing library is loaded.

**Save to workspace** keeps the artifact beside the task it came out of (`POST /api/artifacts/save`),
where the Documents section lists it under "Made by the assistant".

Routes: `POST /api/artifacts/page` mints an address, `GET /artifact/<name>` serves it,
`POST /api/artifacts/save` keeps one. Files: `src/artifact-pages.ts`, `public/artifacts.js`,
`public/charts.js`.

## Save as report (batch 22, wave 8)

Any task can be written out to keep or hand on, from Activity → **Save a task as a report**:

- **Save as notes** — Markdown: headings and prose, nothing a reader needs a program to open.
- **Save as a page** — one self-contained HTML page with its colours written into it and no script
  at all, the same renderer a shared conversation uses (`src/conversation-share.ts`).
- **Open the print view** — the same page with print rules, opened in a window of its own. This is
  how a PDF is made: the browser's own "Save as PDF". Branch never draws a PDF on this computer.
- **Save every step** — one task's whole trajectory as a page: every step it took, what came back,
  and how it ended.

Every form goes through the same redaction pass that guards a shared conversation, so a key that
appeared in a tool result does not leave in a file the owner emails on; the result says how many
things were blanked out. Routes: `POST /api/reports`, `GET /api/reports/episode/<task>`. Files:
`src/reports.ts`, `public/reports.js`.

## The to-do list (batch 22, wave 8)

A plain list of what is still to be done, in the context pane beside the conversation. The
assistant writes its plan there as it works (`todos.add`, `todos.done`, `todos.list`) and the owner
can type a line of their own. An item with a day on it can be turned into a **reminder**, which puts
it in the schedules — the one part of the app that keeps time. The to-do list grows no clock of its
own.

Routes: `GET`/`POST /api/todos`, `POST /api/todos/<id>/done`, `POST /api/todos/<id>/remind`,
`DELETE /api/todos/<id>`. Files: `src/todos.ts`, `public/todos.js`.

## The flow editor (batch 22, wave 8)

Under Procedures, **Change a flow** turns the wave-7 picture into something the owner can change.
Add a step, take one away, move one earlier or later, and fill in the boxes that kind of step needs —
the side form shows only those, because the saved shape (`src/workflows.ts`) refuses a prompt step
with no prompt and a branch step with no words to look for. The picture above the list redraws as
you type; nothing is saved until Save, which sends exactly a name, a line about it and the steps to
`PUT /api/flows/<id>`.

Under the picture, **While it runs** shows each step, where it has got to and when it started. It is
read from `GET /api/flows/<id>` while a flow is working. The note each finished step sends goes out
over a webhook to whoever asked to hear about it (`flow.node`), not to this page, so asking the app
how the flow is getting on is the honest way to keep the timeline current.

Beside it, **How often should it repeat?** offers a rhythm and a time and writes the answer out in
plain words — "every weekday at 09:00" — before filling in the schedule boxes below. Files:
`public/flow-editor.js`.

## Your notes folder (the Obsidian bridge) (batch 22, wave 8)

The owner uses Obsidian, and Obsidian's own files are ordinary Markdown in an ordinary folder. So
this is a **folder bridge and nothing more**: there is no Obsidian plugin here, nothing is installed
into Obsidian, and Obsidian does not have to be running.

Switch it on in Settings → **Your notes folder**, name the folder in full, and name the subfolder
Branch may write into. Branch then writes memory facts, knowledge cards, saved reports and
conversation exports there as Markdown notes with front matter carrying Branch's own numbers, and
reads back the notes tagged `#branch` as documents it can search.

Three rules make it safe to point at a folder full of the owner's own writing:

1. **Confined.** Every path is resolved for real — following any shortcut — and must still sit inside
   the folder named, with the separator part of the comparison, so `notes-other` is never mistaken
   for `notes`.
2. **Never overwritten.** Each note carries a hash of what Branch wrote. If the file no longer
   matches it, the owner has edited it, and the new version is written beside it as
   `<name>.branch-conflict.md`. Nothing the owner typed is lost.
3. **Only what it is given.** Reading back takes only notes carrying `#branch`, so pointing at a
   whole vault does not pull private writing into the assistant's documents.

Tools: `obsidian.sync`, `obsidian.read`. Routes: `GET`/`POST /api/obsidian`,
`POST /api/obsidian/write`, `GET /api/obsidian/notes`. File: `src/obsidian.ts`.

## Reaching Branch from other pages (batch 22, wave 8)

Two ways in from outside Branch's own window, both **off until the owner switches them on** in
Settings → **Reaching Branch from other pages**, and both for the owner's own pages and their own
browser. Neither is for publishing anywhere.

Both obey the same rule: they may only talk to the **paired remote listener**, with the key pairing
gave the owner, and they refuse a loopback address outright. The key the app's own page uses on this
computer is the whole of Branch's authority here, and a page next door must not be able to borrow it.

- **The small ask box** — `public/widget.js`, included by a page of the owner's own:

      <script src="http://your-machine.tailnet.ts.net:8765/widget.js"
              data-branch="http://your-machine.tailnet.ts.net:8765"
              data-key="the key pairing gave you"></script>

  It reads its address and key off that tag and nowhere else — never out of the page it sits on, and
  never out of any storage.

  **List the pages that may carry it.** A browser asks Branch for permission before letting a page of
  yours send anything to it, and Branch names back only a website you listed in `widgetSites` (for
  example `https://notes.example.com`), spelled exactly, never with a star. An empty list means no
  page may ask, so the box has to be allowed as well as switched on. The key alone is deliberately
  not enough: a star there would let any page that ever got hold of your key spend it. The script
  itself is not served at all while the switch is off, so turning the switch off takes the box off
  your page rather than only hiding the setting.

  **The extension asks for one address, when you name it.** It requests no website when you install
  it. The first time you press Send, Chrome asks whether it may reach the address you typed, and a no
  leaves everything as it was.

- **The browser extension** — `extras/browser-extension/`, an unsigned Manifest V3 folder with a
  popup that sends the current page's address, title and selection to Branch as a task. Load it by
  hand: `chrome://extensions` → Developer mode → **Load unpacked**. Install steps and the reasons
  behind them are in that folder's README.

Route: `GET`/`POST /api/embeds`. File: `src/embeds.ts`.

## The record, how busy a connection is, and what asking twice saved (batch 22, wave 8)

Three readings of things the app already writes down:

- **The record** (Activity → *The record of what happened*): every step every task took, narrowed by
  the kind of step, by the task, or by when it happened, and saved as a file of one line each — the
  shape a log file has, so it opens in anything. `GET /api/log`, `GET /api/log/export`.
- **How busy each connection is** (Usage): how many calls went to each model service in the last
  minute and the last hour, beside the allowance that service reports in its own answers
  (`x-ratelimit-*`). `GET /api/request-rates`.
- **What asking twice saved** (Usage): every round answered out of the kept-answers store, with what
  it would have cost had it been sent. `GET /api/cached-answers`.

The terminal view now says what each finished task used as well, and what it cost, so the figures
are not the web app's alone. File: `src/dashboards.ts`, `public/logs.js`.

## Watches that tell you something (batch 22, wave 8)

A page watch already sends its news wherever the owner asked — the activity list, or a chat they
have connected (`monitor.create`, `notifyVia: {channel, chatId}`). Wave 8 adds a **screen watch**:
Branch takes a picture of one rectangle every so often and says when it looks different.

This is the most intrusive thing in the app, so it is fenced three ways: it is off until the owner
switches it on, it refuses to run unless **using your screen** is switched on as well, and it keeps a
fingerprint of the picture rather than the picture — nothing that was on screen is written to disk.
A password manager showing on screen stops it outright, as it stops any other picture of the screen.

Tools: `monitors.screen.create`, `monitors.screen.check`. File: `src/screen-watch.ts`.

## Asking a specialist one question (batch 22, wave 8)

The composer has a **Who should answer** picker beside the Temporary toggle. Leave it on "Your
assistant" and nothing changes. Choose a specialist and that one message goes to it; the reply is
signed with that specialist's name instead of the assistant's, and the next message goes back to the
assistant unless the specialist is chosen again. What the owner typed is what they see: the
delegation is machinery and is not shown back to them. File: `public/app.js`.

## Short-lived keys, where a password comes from, who may message, and the command line (batch 20, wave 8)

This section closes the open rows of the secrets-and-auth (#69), tracing-and-telemetry (#63) and
cli-and-tui (#72) themes. Some of it is new, some points at a feature that already does the job,
and some is written down here as deliberately not built.

### Short-lived keys for a script (A0100, A1930)

The local session key the app prints when it starts never runs out and may do everything. That is
right for the app's own window and wrong for anything you paste into a script, a browser extension
or the client library. So there is a second kind of key, made from the command line:

```
branch token create --scope read --minutes 60 --name "My dashboard"
branch token list
branch token revoke <id>
```

- `--scope read` may look at things only: any request that is not a GET is refused, in those words.
  `--scope run` may also start a task. Neither may ever become the master key.
- The key is shown once. Only its hash is kept (`session_tokens` in the database), so nothing can
  read it back out of Branch afterwards.
- It stops working at the minute you named, and `branch token revoke` stops it sooner.
- Making one and taking one back are both written into the record of what the assistant was allowed
  to do, as "A short-lived key for a script was made or taken back".
- The master key is checked **first** on every request, so a mistake in this feature can hold up a
  script and never you. A wrong short-lived key is counted by the same rate limit as a wrong master
  key. See `src/session-tokens.ts` and `authorize` in `src/server.ts`.

These are one feature answering two audited rows: A0100 ("session API-key authentication") and
A1930 ("API keys and temporary auth tokens") describe the same thing from two projects.

### Where a saved password can come from (A1807, A0221)

`src/vault-sources.ts` writes down the contract every source follows: a scheme (the part after
`secret://`), a label, and one method that turns a reference into a value at the moment it is
needed. Every source obeys the same three rules — nothing is looked up early, every look-up is
scrubbed out of results and logs, and every look-up is written into the record.

| Reference | Where the value comes from |
| --- | --- |
| `secret://<project>/NAME` | Branch's own locker, encrypted on this computer. |
| `secret://cmd/<name>` | A command **you listed in Settings** that prints the password. |
| `secret://bitwarden/<item>`, `secret://1password/<path>` | Your password manager's own command line, when you have switched that on. |
| `env`, `file` | A value already in a program's environment, or in a file you pointed at. |

The command source is new. It is off until you turn it on, and the command is never free text —
`secret-commands` in your settings holds the list:

```json
{
  "enabled": true,
  "commands": [
    { "name": "deploy", "command": "C:/tools/get-deploy-key.exe", "args": ["--quiet"], "note": "the deploy key" }
  ]
}
```

`secret://cmd/deploy` then runs exactly that program — no shell, no window, a stripped environment
(only `PATH`, `TEMP` and the few a program needs to find itself), a ten-second limit, and a 64 KiB
cap on what it may print. A name that is not in your list never starts a process at all. A missing
program, a non-zero exit and an empty answer each get their own plain sentence.

### One list of who may message the assistant (A0686)

Each chat app carried a list of its own. `src/channels/allowlist.ts` is the one shape for all of
them: a rule names a channel (or `*`) and a sender (or `*`) and says `allow` or `block`.

- **A block anywhere wins**, so "never this person" cannot be undone by a broader rule.
- `unknown` says what happens to somebody no rule covers: `pair` offers them a code to be approved
  with (as before), `block` turns them away.
- The per-channel lists still work and are read after this one, so nothing you already set up stops
  working.

### What a phone must satisfy (A1003, A1004, A1804)

The extra door that faces your private Tailscale address has a chain of named steps, and **every
step in it must pass** — so adding a step can only make the door harder to open:

- `token` — the same local key the window on this computer uses.
- `pairing` — at least one phone has been let in on this computer. This step is a switch rather
  than a check on who is calling; `device` below is the one that tells one phone from another.
- `device` — the phone must send back the secret it was given when it paired
  (`x-branch-device` and `x-branch-device-key`), so a key copied off one phone is no use on another.

The default chain is `token, pairing`. Set it in `remote-gateway-auth`; the phones that have been
let in are in `remote-devices`, and only the fingerprint of each secret is kept.

**Signing in through somebody else's identity service (OIDC, a social login, WebAuthn against an
outside authenticator) is deliberately not one of the steps** — A1897, A2003, A2074, A2095, A2216.
There is one owner, the door faces their own private network, and putting an outside company on the
path a phone takes to reach this computer would make it less private, not more.

### The third OpenTelemetry signal, the logs route, and one task's trace (A0056, A0800, A1440)

- **Logs.** When sending traces is on and the destination is a collector that speaks
  OpenTelemetry, each finished task's own story goes out as OTLP **log records** to `/v1/logs`
  beside the spans at `/v1/traces` and the counters at `/v1/metrics`. Each record carries the trace
  id, so a viewer shows the words beside the span they came from. Langfuse and LangSmith have no
  logs signal, so for those nothing is sent.
- **The logs route.** `GET /api/logs` answers one JSON object per line (`application/x-ndjson`),
  filtered with `run`, `kind` and `limit`, behind the same local key as everything else. That is
  the "logs API" a log shipper reads. **There is no Grafana or Loki client here on purpose**: a
  collector of yours already reads OpenTelemetry, so the way to Grafana is to point one at the OTLP
  address above rather than to teach Branch a second protocol.
- **One task's trace.** `branch trace <task id>` prints the trace id, how many steps were recorded
  and of what kinds, whether sending is on and where to, and whether the last send arrived. The
  same trace id is what Langfuse and LangSmith are given, so the number you read here is the number
  you search for there.

### What a task's spans cover (A1149, A0856, A1498, A1583, A0799, A1287, A1523)

One implementation, in `src/tracing.ts` and `src/tracing-shapes.ts`, projected into three shapes.
A task now has a span for each of: the task itself (`run`), each model round (`model`), each tool
call (`tool`), looking something up in your own documents (`retrieval`), the answer going back out
to a chat app (`delivery`), and each sub-task (`child`). A delivery happens after the task has
settled, so it is joined back to the task's own trace rather than floating on its own.

### The record of what the assistant was allowed to do, widened (A1931)

Four more kinds of moment are written down: a short-lived key made or taken back
(`token.issued`), a connection to a model service added or removed (`connection.changed`),
Lockdown turned on or off (`lockdown.changed`), and your own browser window borrowed and given back
(`browser.borrowed`). Handing the whole assistant over as one file and switching who is using the
computer now write a line too.

### Installing the `branch` command (A1159)

`package.json` carries `"bin": { "branch": "./dist/cli.js" }`, so the command line can be installed
like any npm command:

```
npm run pack:cli          # builds, then writes branch-agent-<version>.tgz — publishes nothing
npm install -g ./branch-agent-0.15.0.tgz
branch --help
```

`scripts/pack-cli.mjs` only reads this folder and writes one file. Installing is your own step,
because it writes outside this folder.

### More of the command line (A0012, A0306, A0910, A2103)

- `branch <command> --help` says what one command does, and stops. Asking is never the same thing
  as doing: no workspace, database or connection is opened.
- `branch run` takes `--session <id>` to carry on in a conversation, `--resume <task id>` to pick a
  stopped task up where it left off (with no new words needed), and `--fork <session id>` to work in
  a copy so the conversation it came from is left exactly as it was.
- `branch chat --attach` joins the conversation the engine already running in the background is
  having: it lists the conversations, picks one (`--session`), prints what has been said, and either
  says something or just watches. Two terminals can be in one conversation at once and each sees
  what the other said. It goes through the same door, with the same key, as the app window.
- `branch schedule add --prompt "..." [--at <moment>] [--every <ms>] | list | remove <id>` works
  against that same running engine over `/api/schedules`.
- **A coding assistant you already have, used as a model.** `cli-agent` is a provider shape that
  runs an installed tool's own command line: Claude Code (`claude -p --output-format json`), Codex
  (`codex exec --json`) or the GitHub Copilot CLI. The prompt goes in on standard input, the answer
  comes out of the tool's JSON where it prints JSON. Nothing is stored, no key is asked for, and
  **the tool's own sign-in is the only sign-in there is** — which is what each row says beside it.
  `GET /api/providers/cli-agents` lists them; `POST` the same address offers one in the model list.
  It never asks for tool calls: it answers in words and Branch decides what to do.

### Already true, and checked (A0284, A0383, A0425, A0488, A0551, A0723, A0793, A1191, A0137, A2404, A0614, A2177, A1497)

- **A command line exists**, and has since the first release: `src/cli.ts`, with every command in
  one list (`cliCommands` in `src/cli-completion.ts`) that drives the checking, `branch help`, the
  per-command help and the bash and PowerShell completion scripts. A test runs `--help` for every
  command in that list.
- **A local web client** is the app itself: the pages in `public/` served by `src/server.ts` on
  `http://127.0.0.1:3210`, behind the local key.
- **An interactive terminal view** is `branch chat` — the full drawn view from wave 4
  (`src/terminal-tui.ts`) where the terminal can be drawn on, the plain stream otherwise.
- **Session authentication and pairing** is the local key plus the invitation flow above.
- **A profile needs its PIN**, and five wrong ones in a row are made to wait five minutes
  (`src/profiles.ts`).
- **LangSmith** is one of the three destinations traces can be sent to (`src/tracing-export.ts`).

### Not applicable, and why

- **A2003, A2095, A2216, A1897, A2074 (social login, web-UI password reset, multi-user accounts,
  OIDC, WebAuthn)** — Branch is one person's assistant on their own computer. There is nobody to
  register, no password to reset, and no second account to keep apart. What protects it is that it
  listens on this computer only, behind a key on disk. See the chain above.
- **A0566 Sentry error telemetry** — nothing about you is collected or sent anywhere, which is a
  written non-goal. A crash is already recorded as an error span (`recordUncaughtErrors` in
  `src/tracing.ts`) and goes to **your** collector when you turn sending on.
- **A1620, A1751 (optional analytics, execution telemetry)** — the same non-goal. The counters page
  and the usage ledger are yours and stay here.
- **A0681 tracing/logging** is a Rust library for a Rust program; this is TypeScript.
- **A1334 application logging guidance** — `GET /api/logs` and the OTLP logs signal above are the
  answer for this tree.
- **A1519, A1841 (Bitwarden and 1Password)** are built on another branch of this wave and land
  separately; `secret://cmd/<name>` above is the general form of the same idea.
- **FAMILY custom-commands (#72)** — the owner's own saved procedures and skills are their custom
  commands; the terminal view's slash commands stay fixed on purpose, so a mistyped one can never
  become a task. Still open.

## Sandboxes: where a script actually runs (batch 26, wave 8)

"How tightly a program is held" above is about the ceilings on a program. This is about *where* it
runs. Nothing here is ever installed: each one is looked for on this computer and offered only if it
is already there. **Settings → Approvals → Where scripts run** shows all four with a plain sentence
each, and says what to install for any that is missing.

| Where | What it protects you from | What it does **not** do |
| --- | --- | --- |
| **On this computer** (`job-object`) | A runaway script using all the memory or the processor. Always available; it is what everything did before. | It does not stop the script reading your files. |
| **In a container** (`docker`) | Your files and your programs: nothing of this computer is visible inside except the one folder it is given. | Needs Docker Desktop or Podman already installed. Branch installs neither. |
| **On the Linux side** (`wsl`) | The original folder: the script works on a copy, and only the files you name come back. | Needs Windows Subsystem for Linux already set up. |
| **In Windows' throwaway desktop** (`windows-sandbox`) | Everything: a fresh Windows that is deleted when it closes. | **It opens a window on your screen**, so it is never chosen for you — you switch it on yourself. |

A rule picks one with `backend`, next to `sandbox` and `paths`. A backend that is not on this
computer is a plain refusal naming what to install; it never quietly falls back to something weaker,
because that would be the opposite of what the rule asked for. `paths` on the rule is the only part
of your workspace a sandboxed script can see — one folder, given relative to the workspace.

Before anything is started at all, the script itself is read: a forbidden call for its language, a
size over the cap, or an import that would reach the network when the rule does not allow it, is
refused before any container, distribution or desktop is prepared.

`GET /api/sandboxes` answers the settings and what this computer can offer; `POST /api/sandboxes`
saves them. The settings are `SandboxBackendSettingsSchema` (`src/sandbox-backends.ts`):

| Setting | What it is |
| --- | --- |
| `image` | The container image a script runs in. Nothing is ever pulled; it must already be on this computer. |
| `distro` | Which Linux this computer already has, by name. Empty means the default one. |
| `windowsSandbox` | Let Branch use Windows' throwaway desktop. Off, because it opens a window on your screen. |
| `pulled` | Whether Branch has confirmed the image is already here. Branch writes this; it is not for you to set. |

## Remote computers over SSH (batch 26, wave 8)

A project's work can live on another computer — a machine in the cupboard, a server at work — and
Branch reaches it with the OpenSSH client Windows already ships. Nothing is installed and **no
password is ever handled**.

Two things have to be true before a computer can be added, and both are read from files that are
yours, not Branch's:

1. Its short name must already be a `Host` in your own `~/.ssh/config`. You cannot type a hostname
   here; if it is not in your config, Branch has no way to reach it and says so.
2. Its key must already be in your own `known_hosts`. A computer Branch has never seen is refused,
   not trusted: connect to it once yourself, look at the key it shows you, and then add it here.
   Branch never passes `StrictHostKeyChecking=no`, and forces `BatchMode=yes`,
   `PasswordAuthentication=no` and `NumberOfPasswordPrompts=0` on every call.

A computer starts able to hold files and **nothing else**. You add the programs it may run one at a
time; anything else is refused by name. Paths are kept inside that computer's own folder exactly as
they are inside your workspace: `..`, a path starting at `/`, and a drive letter are all refused
before anything is sent. The approval card names the computer, so a yes is never given blind.

`ssh` itself is the boundary here. Every byte goes through the child process, so nothing on a remote
computer can be used to reach an address the web rules refuse — but equally, the web rules do not
see inside that connection. That is the trade, said out loud.

The tools are `remote.list`, `remote.files`, `remote.read` and `remote.run` (their own toolbox,
`remote`, because everything in it is somewhere else). `remote.run` has a permission of its own,
`remote.execute`: allowing commands on *this* computer must never quietly allow them on another, and
the "ask before changes" rules ask about it every time whatever the rule for commands here says. The screen is **Settings → Remote computers**:
`GET /api/remotes` lists them, `POST /api/remotes` adds one, `POST /api/remotes/remove` takes one
off. Each computer is `RemoteComputerSchema` (`src/remote/ssh-workspace.ts`): `alias` the short name
from your SSH config, `root` the folder on that computer everything is kept inside, `label` a name
you will recognise, `executables` the programs it may run, and `addedAt` when you added it.

## A way back to before a change (batch 26, wave 8)

Before Branch writes a set of changes, it makes a mark of how the folder is right now — but only
when the folder is kept in Git. The mark is a real commit, made with `git stash create`, which builds
a commit object without touching your working folder, your index, or the shared stash list. It is
kept on a ref of Branch's own under `refs/branch/checkpoints/`, so nothing else trips over it, and
the twenty most recent are kept.

The answer to a change now carries an `undo` you can ask for: "Ask to undo this, and the files go
back to how they were just before." A folder that is not kept in Git simply has no mark and says so
plainly; the change is still written. `GET /api/marks` lists them, `POST /api/marks/undo` puts one
back, `POST /api/marks/forget` lets one go.

A project may also name a **line of work** (`branch` on the project, in `src/projects.ts`). Switching
to that project switches the folder to it. Work you have not saved yet stops the switch rather than
being carried across — Branch says so and leaves the folder exactly as it was.

## Firewall: what can reach outside this computer (batch 26, wave 8)

The network rules have been enforced for a long time; what was missing was anywhere to read them
back. **Settings → Approvals → What can reach out** says them in sentences — "Branch may only reach
example.com and docs.rs, and nowhere else on the internet", "Scripts cannot reach the internet: they
are pointed at an address that goes nowhere", "The browser may visit https://example.com. Any other
address is refused before the page opens."

The card is only a reading of the rules; nothing in it decides anything, so it cannot say one thing
while the app does another. The **test** button asks the same check every real request asks, so
pressing it cannot reach the address you asked about — and when an address is on Branch's list but
not on the browser's, it says both halves.

`GET /api/firewall` is the card; `POST /api/firewall/test` takes `{"address": "https://…"}`.

## How much one person may ask for (batch 26, wave 8)

A fixed window, deliberately, because "twenty a minute" is something you can reason about and watch
reset. **Settings → Approvals → Ceilings** sets four numbers (`SessionLimitsSchema`,
`src/session-limits.ts`; 0 means no limit):

| Setting | What it is |
| --- | --- |
| `requestsPerMinute` | Most questions one conversation may ask in a minute. |
| `tokensPerHour` | Most thinking one conversation may spend in an hour. |
| `senderRequestsPerMinute` | The same per minute, for one person messaging Branch through a chat app. |
| `senderTokensPerHour` | The same per hour, for one person messaging Branch through a chat app. |

Reaching a ceiling means two different things on purpose. **Your own** task waits for the window to
free up and then carries on — nothing is refused and nothing is lost. **Somebody messaging from
outside** is told in one sentence ("That is as much as Branch will do for one person right now…")
and their message is let go rather than queued behind everybody else's, because a stranger waiting
silently for a minute looks exactly like Branch being broken. Both are written into the record as
"Something reached the limit you set for a minute or an hour".

`GET /api/limits` reads them, `POST /api/limits` saves them.

## Carrying a sign-in to another computer (batch 26, wave 8)

"Sign in once" already kept a browser profile per project. A saved sign-in can now be exported as a
single sealed file and read back somewhere else: it is encrypted with a passphrase you choose, and
the cookies inside are nowhere in the bytes that leave this computer. The wrong passphrase, and a
file that is not one of ours, both refuse plainly. The alternative, if you would rather not move a
sign-in at all, is to borrow your own browser window for the task instead.

## Letting old conversations go (batch 26, wave 8)

Nothing was ever deleted unless you deleted it one conversation at a time. **Settings → Retention**
sets a rule, and the rule never acts on its own: Branch works out what it would sweep up, shows you
the list, and only a plain yes deletes anything. Every conversation is handed back as a saved copy
first, so nothing is lost to a rule you set months ago and forgot; one that cannot be copied is not
deleted. Every sweep is written into the record as "Old conversations were offered for deletion,
exported, or deleted".

`RetentionSettingsSchema` (`src/retention.ts`):

| Setting | What it is |
| --- | --- |
| `enabled` | Off until you ask for it. Off means nothing is ever proposed. |
| `keepDays` | Conversations older than this many days are proposed. 0 means age is not a reason. The same name a knowledge base uses for the same idea (`RetentionSchema`, `src/knowledge-manage.ts`), so there is one vocabulary for "how long is this kept". |
| `megabytes` | When everything together is bigger than this, the oldest are proposed until it fits. 0 means size is not a reason. |
| `exportBeforeDeleting` | Hand back a saved copy of everything before it goes. On, and it is meant to stay on. |

`GET /api/retention` is the rule and what it would sweep up; `POST /api/retention` saves the rule;
`POST /api/retention/prune` takes `{"approve": true}` and, optionally, the exact conversations.

A knowledge base has a retention rule of its own, counted in documents and passages rather than in
megabytes, and it proposes rather than deletes in exactly the same way. The two share `keepDays`.

## What an add-on asked for, and what holds it to that (batch 26, wave 8)

A skill package and a plugin both declare the permissions they need, and you see that list before
anything is switched on. What the list now *does*: the tools are narrowed to what you allowed. A tool
asking for a permission you did not grant is never registered at all — it is not in the catalog, so
nothing can call it, and you are told which ones were left out and why.

A skill package also declares every web address it will call, worked out from the package itself. You
see them by name before installing, and they are held to at the moment of each call, not only when
the package was read: a declared address can carry a value from the request, so an address outside
the manifest is refused there and then.

`POST /api/skills/package/install` takes `allow` — the permissions you ticked — alongside `approve`;
`POST /api/plugins/<id>/enable` takes the same `allow`. Leave it out and the add-on gets exactly what
its own manifest declared, as switching one on always did. Naming a permission the add-on never asked
for grants nothing.

## One list of who may reach Branch, phones included (batch 26, wave 8)

The one allowlist (`src/channels/allowlist.ts`) already covered every chat app: a rule names a
channel — or `*` for all of them — and a sender, and says `allow` or `block`, with `block` winning.
It now covers a paired phone too, under the channel name `remote` with the device's id as the sender.

A rule that says never is asked **first**, before the door's own chain of checks, so it holds whatever
that chain is set to. Only a "never" is acted on for a phone: one that has already been let in stays
let in unless you write a rule against it, so switching the list on never quietly locks your own
phone out. A phone turned away this way is still paired — it is the rule stopping it, and taking the
rule off lets it straight back in. Each refusal is written into the record.

## Every setting named, so nothing is only in the code (batch 26, wave 8)

`scripts/check-docs.mjs` reads every settings schema in `src/` and fails if a field is not named
here. These were only in the code until it started running.

### Voice

Every field of `VoiceSettingsSchema` (`src/voice.ts`), which is what **Settings → Voice** writes:

| Setting | What it is |
| --- | --- |
| `autoReadAloud` | Read every reply aloud as it arrives. |
| `voiceId` | Which voice reads aloud. Which ones exist depends on this computer. |
| `speechRate` | How fast it reads, from 0.5 to 2 times normal speed. |
| `useProviderVoice` | Prefer the connected service's higher-quality voice over the browser's. |
| `sttRoute` | Who writes out what you say: `auto`, `openai`, `gemini`, or `local` (a speech program here). |
| `sttModel` | The model name to use for writing speech out, when the route wants one. |
| `ttsRoute` | Who reads replies aloud: `auto`, `openai`, `gemini`, or `windows` (the voices Windows ships). |
| `ttsModel` | The model name to use for reading aloud, when the route wants one. |
| `keepAudioOnThisComputer` | Nothing containing sound may leave. Both cloud routes then refuse in plain words, and so does a live conversation. |
| `replyWithVoiceOnChannels` | Answer a voice note on a chat app with a voice note back. Telegram only, today. |
| `localSpeechExecutable` | The full path to whisper.cpp or faster-whisper, if you have one. Branch downloads nothing. |
| `localSpeechModel` | The model file that program should use. |
| `localSpeechKind` | Which of the two it is: `whisper-cpp` or `faster-whisper`, so the right flags are used. |
| `liveMaxMinutes` | How many minutes one live conversation may last. 10 by default. |
| `liveMaxDollars` | How much one live conversation may cost. $1.00 by default. |
| `liveVoiceDetection` | Let the service decide when you have stopped speaking, rather than waiting for the button. |
| `keepLiveRecordings` | Note in the task's record how much sound a live conversation carried — the size of each piece and nothing else. The sound itself is never kept either way. |

### The rest

- **Connections** (`src/connections-preset.ts`): `activePreset` is which connection answers by
  default in this workspace, `fallbackOrder` the connections to try in order when one fails, and
  `cooldownMs` how long a failed connection rests before it is tried again.
- **Pictures** (`src/media-settings.ts`): `imageModel` is which model makes them (leave it empty for
  the connection's own default) and `imagePrices` your own corrections to the per-picture prices,
  for a service whose price Branch does not know.
- **The waiting line** (`POST /api/queue/settings`): `atOnce` is how many tasks may work at the same
  time.
- **A standing brief** (`src/briefs.ts`): `lastSentAt` is when it last went out and `nextAt` when it
  is next due. Branch writes both; they are not for you to set.
- **Programs left running** (`src/processes.ts`): `maxRunning` is how many at once, `maxMinutes` how
  long one may live before it is stopped, and `bufferBytes` how much of what it printed is kept to
  show you.

## It gets better the more you use it (wave 9)

Three pieces, and one rule over all of them: **it proposes, you dispose.** Nothing in this section
deletes, rewrites or adds a remembered fact on its own. Everything becomes a suggestion in the
**What it learns** queue, and turning a suggestion down is itself something learned.

### Facts noticed from what actually happened

Until now, the assistant only learned from what you typed at it. **What it has noticed by itself**,
on the Memory screen, works the other way round: it reads the record of tasks that have already
finished — which is kept anyway — and notices three things, all worked out on this computer with no
model involved and nothing sent anywhere.

| What it notices | When it counts | What it offers |
| --- | --- | --- |
| A file you keep coming back to | The same workspace file opened in three separate finished tasks | A project note naming that file |
| A name that keeps turning up | The same capitalised name in three separate task requests | A project note naming it |
| A correction you made | A message of yours that begins "no", "actually", "I meant", "that's wrong" and the like | A fact about the world, in your own words |

Every suggestion carries **what it was learned from** — how many tasks, the last date, and an
example — so you can see why it is being offered before you decide. A suggestion that reads like an
order to the assistant rather than something to remember is dropped before it is ever offered.

The file signal needs the path of the file a call was about. That is now written beside the call in
the task's own record (`tool.started` events gain a `path` field for the file tools listed in
`src/activity.ts`). The path only — never what was in the file.

**Turning one down is final.** Each suggestion keeps a fingerprint of the noticing behind it. When
you reject one, that fingerprint is remembered on the rejected suggestion, and the same thing is
never offered again however many times it recurs. See `src/memory-learning.ts`.

Routes: `GET /api/memory/learned` says what it has noticed and changes nothing at all;
`POST /api/memory/learned` turns those into suggestions. Neither writes a fact.

### Refresh from recent conversations, with the cost shown first

**Refresh from recent conversations**, on the Memory screen, reads your recent conversations again
and writes up what is worth keeping as fact cards for a knowledge base. Accepting a card folds it
into that collection, where it is cut into passages, searched and cited exactly like a passage from
one of your own files — so a thing said in passing in March is quotable in October, with the
knowledge base named as the source.

Because reading conversations means sending them to your model service, the cost is shown first and
is worked out **entirely on this computer with no model call**: how many conversations, how many
turns, and roughly how many units of text would be sent. `GET /api/memory/refresh` gives that
figure, and it is the only route in this section that the Memory screen's first button calls. The
reading itself is `POST /api/knowledge/refresh` (or the `knowledge.refresh` tool), which answers with
the same reckoning of what it actually read — and even then adds nothing: every card waits in **What
it learns** until the owner accepts it.

### Where facts are kept, and what a second place would have to do

This is the honest state of it, because the ledger asks for pluggable storage several times over
and the answer differs for each.

**Saved facts.** The contract is `MemoryBackend` in `src/memory-backend.ts` — `read`, `list`,
`write`, `search`, `forget`, `count` — with two rules for every implementation: owners never see
each other's facts, and nothing leaves this computer unless the owner plainly asked for it. The one
implementation that ships is `SqliteMemoryBackend`, wired in at `src/index.ts` as `memory.backend`.
Writing a second one is a small piece of work; installing it today means changing that one line,
because there is no chooser and no setting for it. A worked example, in full:

```ts
import type { MemoryBackend } from "branch-agent";

/** A second place to keep facts. This one holds them in this process and forgets them at exit. */
export class ScratchMemoryBackend implements MemoryBackend {
  readonly name = "a scratch store in memory";
  private readonly rows = new Map<string, Map<string, MemoryRecord>>();
  private of(owner: string) { return this.rows.get(owner) ?? new Map(); }
  read(owner: string, id: string) { return this.of(owner).get(id); }
  list(owner: string) {
    return [...this.of(owner).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  write(owner: string, id: string, data: Record<string, unknown>) {
    const now = new Date().toISOString(), before = this.read(owner, id);
    const record = { id, owner, data, createdAt: before?.createdAt ?? now, updatedAt: now,
      revision: (before?.revision ?? 0) + 1 };
    const mine = this.of(owner); mine.set(id, record); this.rows.set(owner, mine);
    return record;
  }
  search(owner: string, query: string) {
    const wanted = query.toLowerCase();
    return this.list(owner).filter((r) => String(r.data.text).toLowerCase().includes(wanted));
  }
  forget(owner: string, id: string) { return this.of(owner).delete(id); }
  count(owner: string) { return this.of(owner).size; }
}
```

Note what the contract does **not** promise: it says nothing about full-text ranking, about
comparing by meaning, or about the version history — those live above it, in
`src/memory-retrieval.ts` and `src/memory.ts`, and a backend that only answers the six methods gets
the plain behaviour for the rest.

**Conversations.** There is no equivalent contract, and this is worth saying plainly rather than
leaving people to look for one. Conversations, their messages and their tasks are tables in the one
SQLite file that `Store` opens (`src/store.ts`), and every part of the app reaches them through
`Store` directly. Swapping that for a file store, an in-process store or a database on a server
would mean giving `Store` an interface of its own first. That has not been done, and a file-backed
or server-backed conversation store is not planned: one person, one computer, one file that the
backup and the diagnostics folder both already understand is the whole design.

**What is not applicable, and why.** Written down here so nobody goes looking.

- **A memory service reached over the network** (the QMD-style long-term store). Not applicable:
  it is another product's hosted service, and pointing Branch at it would mean everything the
  assistant remembers about you living on somebody else's computer. That is the one thing this app
  promises not to do.
- **MongoDB, or any other database server, for conversations.** Not applicable, for the same
  reason and for a second one: there is no server to run and no second machine in this design.
- **A graph database for a personal knowledge base.** Not applicable as a *database*: the map of
  what is mentioned with what is built in the same SQLite file (`src/knowledge-graph.ts`), which is
  what a house-sized knowledge base actually needs. A separate graph server would be a service to
  install, run and back up for no gain here.

## A second opinion before it commits (wave 9)

Three separate things, all of them off or opt-in, because a second opinion costs a second model call.

### An advisor that reads the answer

When it is on, a connection of your choosing reads each finished answer and says whether it stands
up and what it would check. **Its words go beside the answer and are never written into it.** The
answer you were given is the answer the model gave; the advice is a second thing you read next to
it, and you decide. The pass runs on its own budget and its cost lands on the task like any other
model call, so you can see what it came to on the Usage screen.

Settings, saved under `second-opinion` and set on the Settings screen:

- `advisor` — whether a second connection checks each finished answer. Off by default.
- `advisorPreset` — which connection advises. Empty means whichever one answered, which is a
  weaker check: a model rarely argues with itself.
- `advisorMaxTokens` — the most the pass may spend on one task.

It never runs for a specialist's sub-task, and it can never fail a task that has already answered:
an advisor that errors, times out or runs out of its own tokens is written down as
`advice.failed` and the answer is given exactly as it was.

### Two connections arguing

`delegate.debate` puts two of your model connections on one question. Each answers on its own, then
each reads the other and says where it disagrees and why, and a short verdict says what was argued
and what is still open. Nothing here decides anything for you — two models arguing is evidence to
read, not a ruling to act on.

It is bounded twice over, and it says which bound stopped it:

- `debateExchanges` — how many times each side may answer the other. One unless you raise it.
- `debateMaxTokens` — the most a whole debate may spend. The running total is checked before every
  single call, so reaching the ceiling means nothing more is sent.

### Answers in a shape the app can rely on

A task can declare the shape it wants back in zod, the same way a tool declares its arguments
(`declareShape("weather", z.object({ city: z.string(), temperature: z.number() }))`). The model is
asked for exactly that shape, and the reply goes through the same check every delegated answer
already goes through. A reply that does not fit is re-asked **once** with its own validation error,
and a second reply that still does not fit is refused in a plain sentence naming what was wrong.
Nothing is half-parsed: a shape that could not be met produces no answer rather than a guess.

Where this uses a service's own setting and where it does not, honestly:

- **OpenAI** (and the OpenAI-compatible adapters that share `openaiBody`): its own
  `response_format: {"type":"json_schema"}` is sent, so the model is genuinely constrained. `strict`
  is deliberately left off — it would demand that every property be required and no extras be
  allowed anywhere, which a shape written in zod need not be, and a refused request is worse than a
  reply that has to be checked.
- **Anthropic**: there is no response-format setting. Anthropic's own way of fixing a reply's shape
  is a tool the model is made to call, so the shape is sent as one tool with `tool_choice` naming
  it, and the reply arrives as that tool's arguments. This only works when the request carries no
  other tools — true of the shaped pass, which runs with no permissions and so an empty catalog. A
  request that does carry tools keeps them and falls back to asking in words.
- **Every other adapter** (Gemini, Bedrock, Cohere, Ollama, Azure through its own body, the CLI
  agents): the shape is asked for in the words of the question and checked afterwards. That is the
  re-ask path, not a native one. It works; it is just not enforced by the service.

### Pydantic: not applicable, and what stands in for it

The capability audit asks for Pydantic model validation of structured output. Pydantic is a Python
library and Branch is TypeScript, so there is nothing to integrate. The equivalent is zod, which
Branch already uses to declare every tool's arguments and every setting on this page, and which is
what a declared shape is written in above. A shape goes from zod through zod's own `toJSONSchema`
into the same check every delegated answer already passes through, so a declared shape is validated
the same way a tool's arguments are. Nothing further is needed, and adding a Python dependency to a
TypeScript app to satisfy the letter of the row would be worse than not having it.

### The adapter family (`adapter-system` in #55): chat and XML are not applicable

The audit's `adapter-system` family asks for three adapters. Only one of them means anything here,
and building the other two would be building something nobody would run:

- **JSON adapter — built.** That is the shaped answer above, native where a service offers it.
- **Chat adapter — not applicable.** Every connection Branch has already speaks the one chat shape:
  `Message[]` in, `Completion` out, through `openaiMessage`, `anthropicMessages` and their
  equivalents. A "chat adapter" is the `Provider` contract itself, which has existed since the
  first release. Adding a thing called a chat adapter on top of it would be a second name for the
  same object.
- **XML adapter — not applicable.** Nothing in Branch consumes XML from a model. Tool calls arrive
  as structured objects from every provider's own API, not as tags to be parsed out of prose, and
  the one place a reply's shape matters is covered by JSON above. An XML adapter would add a
  parser, a failure mode and a setting for a format no part of the app reads.

## The smaller asks, the Python client and installing: where each one stands (wave mac2)

The last three buckets of the public list (#103: 21 "A library other people can build on", 22
"Installing it should be boring", 23 "The smaller asks") were checked row by row against the code,
because several of the audit's notes were out of date. Each row below says **verified** (it already
works; the file and the test that proves it are named), **built**, **partly** (what exists and what
does not), **not built** (and why) or **not applicable**. `tests/bottom-buckets.test.mjs` checks that
every row is listed here and that every file named here exists.

### A library other people can build on (bucket 21)

- **sdk-python** — built: `packages/sdk-python/branch_agent/client.py`, tested by
  `packages/sdk-python/tests/test_client.py` and `tests/sdk-python.test.mjs` (see "A client for Python programs").
- **framework-adapters** (Python API SDK) — built: the same Python client.
- **A1509** (TypeScript, Python and Go clients) — partly: the TypeScript client is `packages/sdk/client.mjs`
  (`packages/sdk/test/sdk.test.mjs`) and the Python one is above. There is no Go client; the OpenAPI
  description below is what a Go program would generate one from.
- **A2353** (REST API) and **A0758** (HTTP API) — verified: `src/server.ts` serves it and
  `src/api-openapi.ts` describes it at `GET /api/openapi.json`, with `docs/api.md` written from the same
  description. `tests/other-2.test.mjs` checks the description is well formed, that every route it
  promises is really served, and that `docs/api.md` matches; `tests/sdk-python.test.mjs` checks the routes
  the Python client calls are in it.
- **sdk-react** — not applicable: a front-end library for somebody else's page (see "What Branch is not").
  An outside page uses `packages/sdk/client.mjs` or the OpenAPI description.
- **app-building** (an MCP server for building apps with an SDK) — not built: Branch's own MCP server
  (`src/mcp-server.ts`) offers Branch's tools to other programs; a server for writing somebody else's
  app is a different product.
- **serialization** (pipelines written as YAML) — partly: skills are YAML (`src/skill-document.ts`),
  flows are JSON (`src/flows.ts`), and a whole assistant goes out and back as one file
  (`src/agent-export.ts`, `tests/code-ide.test.mjs`). Flows are not written as YAML because JSON is what
  the flow editor saves and reads; a second format would be a second thing to keep in step.

### Installing it should be boring (bucket 22)

- **installers** — partly: Windows has a real installer with an uninstall entry
  (`src/install/installer.ts`); macOS and Linux have downloads you unzip or unpack
  (`scripts/package-macos.mjs`, `scripts/package-linux.mjs`, `tests/packaging.test.mjs`) and a
  start-at-sign-in file (`src/install/launchd.ts`, `src/install/systemd.ts`, `tests/service-update.test.mjs`).
  What is still needed for signed installers is written under "What is still needed for a signed
  installer on every computer".
- **desktop-packaging** — verified: `scripts/package-desktop.mjs` builds the download for Windows, macOS
  (both chips) and Linux, and `.github/workflows/package.yml` builds all four on a version tag.
  `tests/packaging.test.mjs` checks every name, option, signing step and the menu entry;
  `tests/service-update.test.mjs` checks the packaging, the workflow and the updater agree.
- **platform-support** — verified for macOS and Linux: the same downloads and sign-in files
  (`src/install/launchd.ts`, `src/install/systemd.ts`, `tests/service-update.test.mjs`); WSL is not a target, because on Windows
  the Windows download is the one to use.
- **distributions** (custom distributions) — not built: there is no rebranded or trimmed-down build.
  Portable copies (`portable.txt`) and the settings file cover running one copy differently.

### The smaller asks (bucket 23)

- **A0794** (project bookkeeping) — partly: projects hold instructions, a model, a folder and knowledge
  bases, each task records its project, and cost adds up per project (`src/projects.ts`,
  `src/project-ledger.ts`, `tests/projects-locker.test.mjs`, `tests/other-2.test.mjs`). Flows are not
  filed under a project.
- **A2334** (artifact versioning) — verified: keeping a file again under the same name makes the next
  version, each with its checksum (the cap of 20 in `keptLimits` is not tested) (`src/build-artifacts.ts`, `tests/code-ide.test.mjs`).
  Changing an artifact means keeping the changed file as the next version; there is no editor for it.
- **A0612** (source sync with a cursor) — not built: nothing copies Telegram, Gmail or GitHub into
  Branch in the background. The chat channels read new messages as they arrive, and knowledge bases
  read folders (`src/knowledge-bases.ts`).
- **A2221** (Hindsight memory) — not applicable: it is an outside memory service. Memory stays in this
  computer's own database behind the contract in `src/memory-backend.ts` (`tests/docs-memory-2.test.mjs`).
- **A1895** (image generation) — verified: `src/media-images.ts` makes and changes pictures through the
  services that offer it, and says plainly when a model cannot (`tests/media.test.mjs`).
- **examples** (an MCP example, a Notion MCP example) — partly: connecting an MCP server is shown under
  "MCP tools" and the app hands out ready-made connection snippets (`src/mcp-server.ts`,
  `tests/mcp-server.test.mjs`); Notion is shown as an OpenAPI connection (`src/openapi-tools.ts`), not as
  an MCP server.
- **integration-blocks** (a catalogue of third-party blocks) — partly: GitHub, GitLab and Linear are built
  in (`src/integrations/github.ts`, `src/integrations/gitlab.ts`, `src/integrations/linear.ts`) and
  plugins install from files (`src/plugin-catalog.ts`); there is no online catalogue of blocks.
- **A0355** (pages that stay shared) — partly: a share link needs its code, works once and expires
  (`src/conversation-share.ts`, `tests/collab-workflows.test.mjs`); a lasting public page is not offered
  on purpose, because Branch only listens on this computer and its private address.
- **A0354** (an answer engine) — verified: `knowledge.ask` answers from a knowledge base and numbers its
  sources (`src/knowledge-tools.ts`, `src/knowledge-bases.ts`, `tests/rag-vector.test.mjs`).
- **A2375** (a configurable intent pipeline) — not built: requests are not sorted into intents first; the
  model picks tools itself, and the one configurable pipeline is for searching
  (`src/retrieval-pipeline.ts`, `tests/retrieval-2.test.mjs`).
- **A1012** (a model gateway) — partly: OpenRouter, LiteLLM, Portkey and Cloudflare's gateway are
  connections in `data/providers.json` (`src/provider-catalog.ts`, `tests/providers-2.test.mjs`); Vercel's
  AI SDK is a JavaScript library, not a service, so there is nothing to connect to.
- **A2258** (several agent runtimes) — partly: Claude Code, Codex and the Copilot command line, when
  installed here, can answer as a model (`src/providers/cli-agent.ts`, `tests/auth-tracing-cli.test.mjs`);
  they answer in words only, without Branch's tools.
- **A0032** (an app-server protocol) — partly, in its shared form: `branch acp-serve` speaks the Agent
  Client Protocol to editors (`src/acp.ts`, `tests/interop-agents.test.mjs`), alongside the OpenAI-shaped
  way in (`src/openai-compat.ts`, `tests/interop.test.mjs`), the MCP server (`src/mcp-server.ts`) and
  agent-to-agent (`src/a2a.ts`). Codex's own app-server protocol is not spoken (A0601).
- **A0601** (Codex's app-server as a backend) — not built: Codex is reached through `codex exec`
  (`src/providers/cli-agent.ts`). Its app-server protocol is Codex's own and still changing; ACP above is
  the shared one.
- **A0464** (desktop conversations that last) — partly: the desktop app (`src/desktop/main.ts`) runs the
  same app and server, and a conversation coming back after a restart is proven for that shared core
  (`tests/long-jobs.test.mjs`); no test drives the desktop app itself.
- **A2043** (computer use) — verified: `computer.look`, `computer.press` and `computer.type` go to a web
  page or to a window (`src/integrations/computer.ts`, `tests/browser-2.test.mjs`). Window control is
  Windows-only.
- **research-pipeline** (STORM-style articles) — partly: research splits the question, reads several
  pages, compares them and cites them (`src/research.ts`, `tests/data-research.test.mjs`); there are no
  persona, outline or polishing stages.
- **gateway** — partly: one local router fronts every chat channel (`src/channels/router.ts`,
  `tests/channels.test.mjs`); there is no gateway spread over several computers, because Branch runs on one.
- **A0504** (analytics collected only with consent) and **A1620** (optional analytics) — not applicable:
  Branch collects nothing, so there is nothing to consent to (see "There is no telemetry, and there never
  will be"; `tests/tracing-policy.test.mjs` checks the promise is written where the owner reads it). No
  analytics will be added, with or without a switch.
- **A1611** (a side-panel chat) — not built: the browser extension (`extras/browser-extension/`) opens a
  small window from its button. A side panel would need one more browser permission for the same job.
- **A2240** (live app surfaces inside a reply) — partly: pages from MCP servers and artifacts are shown,
  but with no scripts, forms or network (`src/mcp-apps.ts`, `tests/mcp-mode.test.mjs`,
  `tests/artifacts-ui.test.mjs`). Keeping them inert is the safety rule, so "live" is not planned.
- **A2133** (an Obsidian plugin) — partly: Branch writes to and reads from your notes folder
  (`src/obsidian.ts`, `tests/obsidian.test.mjs`); nothing is installed inside Obsidian.
- **A1932** (a browser extension) — partly: `extras/browser-extension/` sends the page or the selection to
  Branch (`src/embeds.ts`); `tests/embeds-watches.test.mjs` checks its folder, its permissions and that it
  refuses this computer's own address, but no test drives the popup sending a page.
- **A1934** (a chat box for other websites) — partly: `public/widget.js` is a small ask box for pages of
  the owner's own, on sites the owner lists (`src/embeds.ts`, `tests/embeds-watches.test.mjs`); it is not
  meant for putting in front of the public.
- **A2367** (Google PaLM) — not applicable: Google retired PaLM. Gemini, its successor, is supported
  (`src/providers/gemini.ts`, `tests/provider-presets.test.mjs`).

## Comments that ask the assistant (A0344)

`branch watch <folder> --ai-comments` watches a folder inside your workspace. A comment written in
`#`, `//`, `--` or `;` style that ends (or starts) with **AI!** asks for a change, and one with
**AI?** asks a question. A comment that starts with the word **AI** or ends with it only adds
context. This is Aider's rule.

- Each burst of saves that holds an AI! or AI? comment becomes one task. The task names the file
  and line, shows the lines around each comment, and asks for the comments to be removed afterwards.
- Plain AI comments go along as context, but never start anything on their own.
- The files the assistant changed while answering are marked as seen, so its own edits never start
  another task. A file whose text has not changed is not looked at again.
- Comments are only read through the workspace's checks: secret-looking names and anything
  `.branchignore` hides are skipped, and a folder outside the workspace is refused.
- `--once` stops after the first task, and `--settle <ms>` sets how long a burst is.
- Nothing runs unless you start the command, and only for the folder you name.
- A comment can come from anyone whose file lands in the folder (a pulled branch, a downloaded
  project), so its task is not treated as yours: it is a trigger's task, held to the approval rules
  for work you did not start, and it may only read and change files. It cannot run commands or
  code, reach the internet, send messages, or send anything to Git or GitHub. The task is also told
  that the comments are requests about those files only.

Asserted in `tests/ai-comments.test.mjs`.

## A history of what is remembered (A2317)

The database stays the real store of what the assistant remembers. The history is a Git record of
it, off by default. Switch it with `POST /api/memory/history` and `{ "mode": "on" }` (or
`"when-needed"`, or `"off"`).

- **What is recorded.** After every task, the same notes the memory mirror writes (one per kind of
  fact) are written into a private repository in Branch's data folder, `memory-history/`. They are
  committed when they changed, with a message such as "Remembered 12 facts: 2 lines added,
  1 removed, in 2 notes".
- **What is never touched.** Your workspace, and any repository in it.
- **Reading it.** `memory.versions` lists the versions, and `memory.version_note` shows what one
  note said at one of them. `GET /api/memory/history` shows the switch, when the last version was
  kept, and the last problem if there was one.
- **A copy elsewhere (optional).** Name a remote address in `remote`: https or ssh, never with a
  password in it. Each new version is pushed there as `branch-memory-history`, with this
  computer's own Git sign-in, after the network rules allow the host.
- **Who decides.** Only the app window or the computer's own key can change the switch or the
  remote. A short-lived key cannot. `{ "remote": null }` stops the copy.
- **No keys in it.** Anything in a remembered fact that looks like a key or password is replaced
  before the note is written, so it is never committed or copied.

Asserted in `tests/memory-git.test.mjs`. Needs Git installed.

## Seeing what a task did, step by step, afterwards (public list, bucket 13)

Two switches, both off on a fresh install, each with the usual three positions.

**Watch a task again** (Inbox → History, `src/run-recording.ts`, `src/run-recording-page.ts`,
`src/run-recording-api.ts`, `public/recordings.js`). Pick a finished task and it plays back as frames: the
question, each round with the model (with the words it used), each action and what came back, each box
of a flow, each helper it sent off, each picture it looked at, and how it ended. Play, Pause, Step back
and Step on move through it; "The path it took" draws one box per step, coloured from the theme's own
tokens. Nothing new is recorded to make this: the task's event log already holds it, and everything
shown passes through the secret remover first. Off refuses every route in one sentence; "when needed"
builds a recording only when one is opened; "on" does the same and lists recent tasks straight away.

- **Save as a page** writes one HTML file that plays anywhere. It carries its own copy of
  `public/tokens.css` and can reach nothing (`default-src 'none'`). Pictures go into it only when
  "Put the pictures it looked at into saved pages" (`keepPictures`, off by default) is ticked, and then only the newest three.
- **Make a workflow from it** turns the actions that worked into the steps of a saved workflow, with the
  settings they were given (secrets removed). Saving never runs it, and its steps pass the same checks
  as any workflow's when it does run.
- `GET /api/runs/<id>/monitor?after=<event>` is the run monitor: every flow box with its state, what it
  handed on and the words its own task used; every exchange with the model and every action with how
  long it took; and totals. Pass the last event number back to be handed only what is new.

**Is Branch keeping up** (Settings → Advanced, `src/event-loop-watch.ts`). Measures how late Branch's own
work starts and how busy it is, and says in one sentence whether that is fine, slow or stuck. "When
needed" takes a two-second measurement only when Check now is pressed; "on" watches from launch and
counts every stall; off measures nothing. A stall is work that starts later than `stallMs` (250 ms by
default, between 50 and 10000).

Integration review (mac4/bucket-13): the saved page is written in the window's language (`?lang=`,
only a language file the app ships), and step names in the player and the page are translated too;
its content rules also forbid `<base>` and form submission. Action labels and box names pass the
secret remover like everything else. The event-loop watch is one for the whole app, so only the
owner's profile can change its switch. A short-lived key cannot change either switch
(`POST /api/recordings`, `POST /api/event-loop`), and a household profile is told "not found" for
the owner's tasks. The picture window marks the pictures the task took by the message itself, not
by its words, so an owner's picture is never thinned out.

A task that takes many pictures now keeps only its newest three in what the model sees
(`src/visual-window.ts`); each older one is replaced by one sentence, and the owner's own attached
pictures are never removed. This is a bound rather than a feature, so it has no switch.

macOS and Linux: nothing here depends on the system. The event-loop watch uses Node's own
`perf_hooks`, and the saved page is plain HTML. Tests: `tests/run-recording.test.mjs`,
`tests/recordings-ui.test.mjs`.

### Usage report, task counters and logging (A0367, A1751, A1334, A0681)

Bucket 14 of the public list ("what it has cost you, in plain figures"). Each piece ships off.

- **Usage report** (A0367). Settings → Data → *Usage report* writes a page you can keep or hand on:
  the last 7, 30 or 90 days in a few plain sentences (tasks, tokens, tool calls, what went wrong and
  the estimated money), each set beside the same number of days before it, then day by day, by model,
  by where the tasks came from, the tools used most, each person on this computer when more than one
  used it, and how many moments were written in the record of what the assistant was allowed to do.
  A task whose model has no price is counted and said so, never shown as costing nothing. It is made
  by the same writer as "Save as report", so it comes as notes, a page or the print view, and keys are
  blanked out first. No prompt, answer or file goes into it. `GET`/`POST /api/usage/report/settings`
  holds `mode` (`off`, `when-needed`, `on`; there is no tool behind it, so the last two both mean
  "available") and `range`; `POST /api/usage/report` with `range` and `format` makes one. Only the
  owner may use either. Code: `src/usage-report.ts`, `src/usage-report-api.ts`, `public/usage-report.js`.
- **Task counters for your own collector** (A1751). Other agents send "anonymous execution
  statistics" to the people who made them. Branch does not, and the promise above stands. What you can
  have is the same counters — tasks started, working, failed and waiting, tokens in and out, the
  month's estimated money, tool calls and failures — sent to **the address you chose for traces**, in
  OpenTelemetry metrics shape to `/v1/metrics`. Settings → Advanced → *Task counters for your own
  collector*: *off* sends nothing; *when I press Send* sends only on the button; *after tasks finish*
  sends when a task ends, at most once every `minutesBetween` minutes (15 unless changed). Nothing goes
  while sending traces is off. Only numbers go, with no name, words, file or identifier of you or this
  computer, and every send is written in the record. `GET`/`POST /api/usage/counters`,
  `POST /api/usage/counters/send`. Code: `src/execution-metrics.ts`.
- **Logging from a program that embeds Branch** (A1334). `bridgeLogs(store, logger, options)` hands
  every stored event to a logger with `debug`, `info`, `warn` and `error` — `console`, pino, winston or
  bunyan all fit — as one line each, cut down to names, counts and outcomes exactly as the diagnostics
  folder is. Failures are `error`, retries, stalls and limits `warn`, streamed pieces `debug`, the rest
  `info`. It installs nothing and sends nothing; it does nothing until a program calls it. See the
  builders' guide. Code: `src/log-bridge.ts`.
- **Tracing from the start** (A0681). The row comes from an agent whose runtime switches on Rust's
  tracing when it starts. Branch has no Rust; the same thing in Branch is that tracing starts with the
  engine: `createBranch` opens the span store, records any uncaught failure as an error span from that
  moment (`recordUncaughtErrors` in `src/tracing.ts`), and every task, model round and tool call gets a
  span (`tests/tracing-policy.test.mjs` T1), which the diagnostics folder carries (T4).

macOS and Linux: nothing here depends on the operating system; the tests run the same on all three.

## Typed commands, the same everywhere (wave mac3)

Commands that start with a slash — `/status`, `/stop`, `/tokens`, `/help` — come from one table,
`src/commands/catalog.ts`. The app window's message box, the phone (which shows the same window
through the paired address), the `branch` terminal view, the chat apps and the browser dashboard all
read their list from it, so they cannot drift apart. `/help` on each of them lists only what that
place can do.

**The switch** is in Settings › General, under *Typed commands*, and ships **off**:

- **Off:** every place keeps exactly the commands it had before this table — the window `/help`,
  `/model` and `/goal` (from goal mode), the terminal its 28, the chat apps `/stop /status /new /compact /usage /btw /help`.
  Anything else typed with a slash is what it always was (a message in the window and in chats).
- **When needed:** every command in the table works when it is typed, but the `/` menu and `/help`
  show only the everyday ones; `/help all` shows the rest.
- **On:** every command works and every list shows it. The window gets a `/` menu above the message
  box (up and down choose, Tab or Enter fills one in, Esc closes), and the dashboard gets a command line.

The chat apps still have their own switch (Customize › Chat apps, *Commands*), which decides whether
a chat reads commands at all; this one decides which of the table's commands it may read.

**Who may do what.** A command asks at least what the matching API route asks. Looking needs any
key; starting a task (or stopping one, or asking on the side) needs a key that may start tasks;
changing settings or permissions (`/preset <name>`, `/default`, `/lockdown on|off`, `/switch`) needs
the key of this computer and the owner's own profile — a short-lived key is refused in one sentence.
Typed on their own, `/preset`, `/lockdown` and `/model` only read, so any key may send them. A key
that may only look sends its commands with `GET /api/commands/run`, which refuses anything that would
change something. In a chat app, nothing that changes settings or permissions is a command at all
(it is an ordinary message), `/goal` is not offered because a goal would run with the owner's tools,
and `/whoami` tells the sender what their tasks may use.

**What the new ones do.** `/tokens` shows what fills the next request — instructions, the list of
tools, the conversation and the room left — from the figures the last task measured, and what
sending it would cost (the idea of Aider's `/tokens`). `/help <question>` answers from Branch's own
handbook (`docs/handbook`): the best-matching sections are found by word ranking and the model
answers from those alone, with no tools; with no model it shows the sections themselves. `/goal`
uses goal mode (mac2/goal-undo), which keeps its own switch; the window already had `/goal` from
goal mode, and the terminal gets it from this table. `/stop`, `/status`, `/compact`, `/usage` and `/btw` work outside chats now too. `/health` is the
same check as `branch doctor`.

**Routes.** `GET /api/commands?surface=window|phone|dashboard` (the list that place offers, for the
phone apps as well), `GET /api/commands/table` (every command on every surface, and the table
below), `GET|POST /api/commands/run`, `GET|POST /api/commands/settings`.

**macOS and Linux.** Nothing here depends on the operating system: the table, the routes and the
terminal behave the same on macOS, Linux and Windows, and Windows behaves exactly as before while
the switch is off.

### Every command, and where it works

"had it" means the place offered the command before this table (it works whatever the switch says);
"new" means it follows the switch.

| Command | Also | Needs | Window | Phone | Terminal | Chat apps | Dashboard |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/help [question]` | `/?` | any key (with a question: a key that may start tasks) | had it | had it | had it | had it | new |
| `/model [id]` | `/models` | a key that may start tasks (on its own: any key) | had it | had it | had it | new | — |
| `/think <low\|medium\|high\|default>` | `/reasoning` | a key that may start tasks | new | new | had it | new | — |
| `/preset [name]` | `/permissions`, `/approvals` | the key of this computer (on its own: any key) | new | new | had it | — | — |
| `/memory [words]` | — | any key | new | new | had it | — | — |
| `/skills` | — | any key | new | new | had it | — | — |
| `/plan [on\|off]` | — | any key | new | new | had it | — | — |
| `/verify [on\|off]` | — | any key | — | — | had it | — | — |
| `/dry-run [on\|off]` | `/practice` | any key | — | — | had it | — | — |
| `/temporary [on\|off]` | `/incognito` | any key | new | new | had it | — | — |
| `/attach <file>` | `/image` | any key | new | new | had it | — | — |
| `/history` | — | any key | — | — | had it | new | — |
| `/export [file]` | `/save` | any key | new | new | had it | — | — |
| `/new` | `/clear`, `/reset` | any key | new | new | had it | had it | — |
| `/sessions [id]` | `/resume` | any key | new | new | had it | — | — |
| `/go <place>` | `/open` | any key | new | new | had it | — | new |
| `/inbox [tab]` | — | any key | new | new | had it | — | new |
| `/automations [tab]` | `/cron` | any key | new | new | had it | — | new |
| `/library [tab]` | — | any key | new | new | had it | — | new |
| `/customize [tab]` | `/tools` | any key | new | new | had it | — | new |
| `/settings [page]` | `/config` | any key | new | new | had it | — | new |
| `/theme [name\|light\|dark\|follow\|list]` | `/skin` | any key | new | new | had it | — | — |
| `/default <id>` | — | the key of this computer | new | new | had it | — | — |
| `/switch <mouse\|sidePane\|oak> [on\|off\|when-needed]` | — | the key of this computer | — | — | had it | — | — |
| `/pane [activity\|plan\|files\|memory]` | `/details` | any key | new | new | had it | — | — |
| `/lockdown [on\|off]` | `/pause` | the key of this computer (on its own: any key) | new | new | had it | — | new |
| `/keys` | `/shortcuts` | any key | — | — | had it | — | — |
| `/exit` | `/quit` | any key | — | — | had it | — | — |
| `/stop [task]` | `/cancel` | a key that may start tasks | new | new | new | had it | new |
| `/status` | — | any key | new | new | new | had it | new |
| `/compact` | `/compress`, `/fold` | a key that may start tasks | new | new | new | had it | — |
| `/usage [on\|off]` | `/cost` | any key | new | new | new | had it | new |
| `/btw <question>` | `/side` | a key that may start tasks | new | new | new | had it | — |
| `/tokens` | `/context` | any key | new | new | new | new | — |
| `/goal <what should be true> [--max rounds]` | — | a key that may start tasks | had it | had it | new | — | — |
| `/whoami` | `/id` | any key | new | new | new | new | new |
| `/version` | `/about` | any key | new | new | new | new | new |
| `/health` | `/doctor` | any key | new | new | new | — | new |

### Parity with other agents

Studied from Hermes Agent, OpenClaw, Codex, Gemini CLI, OpenCode and Aider (MIT or Apache-2.0) and
OpenHands (study only); Claude Code's list is from its public documentation. No code was copied.
The same table is in `src/commands/parity.ts`.

| What | Their commands | Branch | Status | Note |
| --- | --- | --- | --- | --- |
| List the commands | /help (all), /commands (OpenClaw, Hermes) | `/help` | existed | Now written from the one table, per surface. |
| Ask about the agent itself | /help <question> (Aider), /docs (Gemini) | `/help <question>` | built | Answers from Branch's own handbook. |
| Change the model | /model (all), /models (OpenClaw) | `/model` | existed | Now also in chat apps, for that chat's conversation. |
| How hard it thinks | /think, /reasoning (OpenClaw, Hermes), /reasoning_effort (Aider) | `/think` | built | Was terminal only. |
| Start afresh | /new, /clear, /reset (all) | `/new` | existed | Window, phone, terminal and chat. |
| Earlier conversations | /resume, /sessions (Hermes, Codex, Gemini, Claude Code) | `/sessions` | existed |  |
| Fold the conversation | /compact (Codex, Claude Code, OpenCode, OpenClaw), /compress (Hermes, Gemini) | `/compact` | built | Was chat only. |
| Stop the task | /stop (Hermes, OpenClaw, Codex), Esc (Claude Code) | `/stop` | built | Was chat only. |
| What is happening | /status (Hermes, OpenClaw, Codex, Claude Code), /stats (Gemini) | `/status` | built | Was chat only. |
| Tokens and cost | /usage (Hermes, OpenClaw, Codex), /cost (Claude Code), /stats (Gemini) | `/usage` | built | Chat keeps its footer switch. |
| What fills the next request | /tokens (Aider), /context (Hermes, OpenClaw, Claude Code) | `/tokens` | built |  |
| A question on the side | /btw (Hermes, OpenClaw, Codex), /side (Codex) | `/btw` | built | Was chat only. The OpenHands version was only studied. |
| Work until a goal is met | /goal (Hermes, OpenClaw, Codex, OpenHands) | `/goal` | built | Uses goal mode from mac2/goal-undo when that is in this copy. |
| Who am I, what may I do | /whoami (Hermes, OpenClaw) | `/whoami` | built |  |
| Version | /version (Hermes), /about (Gemini) | `/version` | built |  |
| Health check | /doctor (Claude Code), /diagnostics (OpenClaw), /debug (Hermes) | `/health` | built | The same check as `branch doctor`. |
| Approval mode | /permissions (Codex, Gemini, Claude Code), /approvals (Hermes), /yolo (Hermes) | `/preset` | existed | Changing it needs the key of this computer; never from a chat. |
| Emergency stop for everything | /pause (Hermes), /elevated (OpenClaw) | `/lockdown` | existed | Owner only; ends earlier yeses as the route does. |
| Memory | /memory (Hermes, Gemini, Claude Code, Codex) | `/memory` | existed |  |
| Skills | /skills (Hermes, Codex, Gemini), /skill (OpenClaw) | `/skills` | existed |  |
| Plan first | /plan (Hermes, Codex, Gemini), /architect (Aider) | `/plan` | existed |  |
| Practice without changes | /ask (Aider) | `/dry-run` | existed |  |
| Private conversation | incognito (OpenClaw) | `/temporary` | existed |  |
| Attach a file or picture | /image, /paste (Hermes, Aider), /add (Aider), @file (Codex, Gemini) | `/attach` | existed |  |
| Save the conversation | /export (Codex, Claude Code, OpenCode), /save (Hermes, Aider), /export-session (OpenClaw) | `/export` | existed |  |
| Theme | /theme (Codex, Gemini, Claude Code), /skin (Hermes) | `/theme` | existed |  |
| Settings | /config (Hermes, OpenClaw, Claude Code), /settings (Gemini, Aider) | `/settings` | existed |  |
| Tools and connections | /tools (Hermes, Gemini), /mcp (Codex, Gemini, OpenCode, OpenClaw), /plugins | `/customize` | existed | Opens Customize; adding one stays a screen. |
| Scheduled work | /cron (Hermes), /loop (OpenClaw, Hermes) | `/automations` | existed |  |
| Steer the working task | /steer (Hermes, OpenClaw), /queue (Hermes) | — | elsewhere | Typing while it works steers it (window's follow-up, chat notes). |
| Keyboard help | /keymap (Codex), /shortcuts (Gemini) | `/keys` | existed | Terminal only; the window shows keys in its own help. |
| Leave | /quit, /exit (all) | `/exit` | existed | Terminal only. |
| Take back a turn or files | /undo (Hermes, Aider, OpenCode), /rewind (Gemini), /rollback (Hermes) | — | elsewhere | mac2/goal-undo builds it as a message action; a command can follow it. |
| Branch or fork a conversation | /branch (Hermes), /fork (Codex, OpenCode) | — | elsewhere | The window's branch action (session tree); not a typed command yet. |
| Show the changes | /diff (Hermes, Codex, Aider) | — | elsewhere | Receipts in the side pane's Files tab. |
| Review the work | /review (Hermes, Codex) | — | elsewhere | /verify (terminal) and the reviewer switch. |
| Write project instructions | /init (Hermes, Codex, Gemini, Claude Code) | — | elsewhere | Context files belong to the context-file loader (Legion). |
| Copy the last answer | /copy (Hermes, Codex, Gemini, Aider) | — | not applicable | The window has a copy button on each answer; a terminal copies with the mouse. |
| Sign in or out | /login, /logout (Hermes, Codex, OpenClaw), /auth (Gemini) | — | not applicable | Signing in is a Settings screen; a typed command would carry secrets. |
| Run a shell command | /run, /bash, ! (Aider, OpenClaw, Gemini) | — | not applicable | Programs run only as tool calls under the approval rules. |
| Change directory | /cd (Codex), /directory (Gemini) | — | not applicable | The workspace is set per project in Settings. |
| Mascots and pets | /pet, /hatch (Hermes), /pets (Codex), /corgi (Gemini) | — | not applicable | Branch draws its own oak instead. |
| Vendor account and billing | /subscription, /topup (Hermes), /upgrade (Gemini) | — | not applicable | Branch has no account of its own. |
| Report a bug | /bug (Gemini), /feedback (Codex), /debug upload (Hermes) | — | not applicable | Nothing is sent anywhere; Settings › Advanced has diagnostics. |
| Restart or update | /restart, /update (Hermes, OpenClaw) | — | elsewhere | The dashboard's restart control and Settings › About. |

## Talking to other agents and tools: where each one stands (wave mac4, bucket 20)

The open protocols, so Branch can be one part of somebody else's setup and they can be part of yours.
Everything new lives in `src/interop/` and is switched in Customize → Connections, card "Working with other
agents and tools" (`public/interop.js`). Each part has the three-way switch — off, when needed, on — and
every one ships off: while a part is off its routes answer "switched off" (the Agent Protocol answers 404)
and its tools are not in the catalog at all; "when needed" makes them a line in the index; "on" loads them
from the first round (`src/feature-switches.ts`). Switching a part, bringing an assistant in and handing a
conversation on need the key of this computer; a short-lived key is refused.

**macOS and Linux.** Nothing here depends on the system: the socket, the routes and the files behave the
same on all three, and the tests run on each.

- **agent-protocol** (A0548, the Agent Protocol task API) — built: `POST /ap/v1/agent/tasks` makes a task,
  `POST …/{task}/steps` runs a step as an ordinary Branch task in one conversation, held to "Ask before
  changes" like an A2A task; steps, tasks and artifacts list with the specification's pagination, and
  every answer is a small `answer-N.md` artifact you can download. Files sent in are refused (415). Tasks are
  written down, so a restart keeps them (`src/interop/agent-protocol.ts`, `src/interop/api.ts`,
  `tests/agent-interop.test.mjs`).
- **client-tools** (A2335, external client tools) — built: a program on this computer opens
  `ws://127.0.0.1:<port>/api/interop/client-tools/ws` with the key as `Sec-WebSocket-Protocol: bearer, <key>`,
  says `hello` with up to 16 tools, and those tools join the catalog as `client.<program>.<tool>` until it
  hangs up. Each call goes down the socket and waits up to a minute; every lent tool needs `client.tools`,
  which counts as a change, and its description is read as somebody else's text
  (`src/interop/client-tools.ts`, `tests/agent-interop.test.mjs`).
- **A0429** (custom agent modes) — built: five modes come built in (Ask, Architect, Code, Debug,
  Orchestrator); you add your own in Customize → Specialists; a project folder you trust may add more in
  `.branch/modes.json` (a folder you have not trusted brings none). A mode is a role, instructions, the
  toolboxes it may open and whether it may change anything, and it only ever narrows what the task could
  already do (`src/interop/modes.ts`, `tests/agent-interop.test.mjs`, `tests/agent-interop-ui.test.mjs`).
- **A0428** (boomerang orchestration) — built: `mode.task` sends one piece of work to another mode; that
  mode works with its own reach and instructions and its summary comes back to the task that sent it, with
  "sent" and "returned" on the parent's record. The Orchestrator mode does nothing else
  (`src/interop/modes.ts`, `tests/agent-interop.test.mjs`).
- **A1857** (agent marketplace) — built: a market is a `market.json` list naming files made by "Export the
  assistant", each with its fingerprint. Looking installs nothing; bringing one in checks the fingerprint
  and every part, and takes only specialists, saved procedures and skills — never approval rules, model
  choices or memory — with new skills switched off, and a specialist or procedure with a name you already use is left out, never replaced. Publishing writes both files into a folder of your
  workspace for any web server; nothing is uploaded (`src/interop/agent-market.ts`, `src/agent-export.ts`,
  `tests/agent-interop.test.mjs`).
- **provider-actions** (A2252, provider effect actions) — verified: a service's own operations become
  tools once you name them (`tools.from_openapi`), the key is fetched at the call and kept out of the
  answer, and every one needs `api.call`, which is a change, so "Ask before changes" asks before it acts
  (`src/openapi-tools.ts`, `tests/code-ide.test.mjs` "a call built from the document fills the path",
  `tests/agent-interop.test.mjs`).
- **A0146** (fleet coordination) — built: `fleet.status` shows every working task with the task above it,
  the teams, the assistants elsewhere and the programs lending tools; `fleet.send` gives one job to several
  specialists and assistants elsewhere at once; `fleet.stop` stops everything, or everything under one
  task, and never the task asking or any task above it (`src/interop/fleet.ts`,
  `tests/agent-interop.test.mjs`).
- **A0319** (remote handoff) — built: from Customize → Connections a conversation goes to another device as
  a link that opens it (`#handoff=<id>`) and a key that may look and start tasks for the minutes you choose,
  shown once; to a terminal as `branch chat --attach --session <id>`; or to an assistant elsewhere with the
  recent conversation, keys scrubbed. The model can hand on to a terminal or an assistant, never mint a key
  (`src/interop/handoff.ts`, `src/cli-attach.ts`, `tests/agent-interop.test.mjs`).
- **A0688** (project routing) — built: each project may carry a few words of its own; a request is scored on
  those and on the project's name, folder and repository, and the best one is named with the words that
  decided it. A tie or no match changes nothing, and routing alone never switches — only the owner's
  window, asking with `switch`, does (`src/interop/project-routing.ts`, `tests/agent-interop.test.mjs`).
- **A1293** (swarm patterns) — documented: four ways of putting several specialists on one job, all over
  the same fan-out engine, budget and approval rules. *Supervisor*: one specialist splits the goal between
  named workers and writes the answer (`delegate.supervise`). *Swarm*: several workers take items off one
  shared list, and an item nobody finished goes back on it (`delegate.swarm`). *Router*: the one specialist
  a request belongs to is chosen and sent it (`delegate.route`). *Parallel*: up to six branches share this
  task's budget (`delegate.parallel`), and *teams* keep a durable room (`src/teams.ts`). Mode boomerangs and
  fleet commands above sit on the same engine (`src/orchestration-modes.ts`,
  `src/orchestration-tools.ts`, `tests/reopened.test.mjs` "A0317 a swarm works down one shared list").
- **A1327** (tool-discovery progressive disclosure) — verified: every round the catalog has three tiers —
  loaded, a one-line index entry, and deferred until searched for — so a thousand tools cost no more than a
  dozen, and a tool found by searching stays loaded (`src/tool-loading.ts`, `tests/tool-loading.test.mjs`
  "a deferred tool is found by searching for it, called, and stays loaded afterwards").
- **A0421** (AFlow workflow optimisation) — built, bounded: `flow.search` (and `POST /api/interop/flow-search`)
  asks the model for up to four different flows for a goal, checks each the way the flow editor does, tries
  each on up to five worked examples, scores the share of answers containing what was expected, shows the
  best its misses for up to two rounds of improvement, and saves the winner only when you ask in Customize (the model's
  call cannot save). A drafted flow may only ask and branch — at most eight boxes, no tool, list or other-flow box. It is greedy
  improvement, not MetaGPT's tree search, and every try is a real run that costs what it costs
  (`src/interop/flow-search.ts`, `tests/agent-interop.test.mjs`).
