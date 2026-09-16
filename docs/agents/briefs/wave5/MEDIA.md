# Wave 5 task: pictures, sound and video the assistant can make and handle

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave5/media from the local branch wave2/integration (fetch first: `git -C . log -1 wave2/integration`). Theme: media-generation (#76, 13 pieces) plus the voice leftovers in voice-io (#65). Backend plus small additive UI (attach/preview in the composer and a Media card in Settings). Do not touch the shell layout files (public/shell.css, public/shell.js) beyond adding a preview element hook if unavoidable.

Read: src/voice.ts, src/artifacts.ts (run artifacts), src/providers.ts (`audio()`, `embeddings()`, image parts), src/integrations/browser.ts (screenshot artifacts), src/documents.ts, docs/configuration.md voice and browser sections.

Build:
1. Image generation and editing through the active provider: OpenAI-compatible `/images/generations` and `/images/edits` (and Gemini image output when the preset is Gemini) behind a tool `media.image { prompt, size, style?, edit?: { source, mask? } }`; results saved as run artifacts and, on request, into the workspace (`media/` folder) with receipts; a plain-language refusal when the provider has no image endpoint. Cost estimates via the pricing table (per-image prices).
2. Image understanding tools: `media.describe { path }` (uses the vision plumbing: describe, OCR-like text extraction, simple table reading) and `media.compare` for two pictures; both size-capped.
3. Audio: `media.transcribe { path }` for workspace audio files (reuses the voice transcription client) with timestamps when the endpoint offers them; `media.speak { text, voice }` to a workspace file; simple audio trimming by time range using a pure-JS WAV/PCM path only (no ffmpeg dependency; other formats are "not supported here yet").
4. Video: no generation; `media.frames { path, every }` extracts still frames from MP4 ONLY if achievable with built-ins — it is not, so instead document the limitation and provide `media.info` (duration/size from the MP4 box headers, parsed in pure JS) so the assistant can at least reason about a file. Say clearly what is and is not supported.
5. Composer attachments: the attach button accepts images and audio (size caps), shows a thumbnail/waveform-less chip, and sends them as image parts or as a transcription step; drag-and-drop onto the composer.
6. Gallery: `GET /api/artifacts?type=image` and a small "Made by the assistant" list inside the Documents panel (reuse its list style) with open-in-folder.

Tests (tests/media.test.mjs with node:http fakes): image generation and edit requests hit the right endpoints with the right bodies and land as artifacts; refusal without an endpoint; describe uses image parts; WAV trim produces valid headers and the right length; MP4 info parses a tiny synthetic file; composer attachment reaches a run as an image part (route-level test); gallery route.

Acceptance: MD1 image generate/edit proven; MD2 describe proven; MD3 audio transcribe/speak/trim proven; MD4 MP4 info proven and video limits documented; MD5 attachments proven; MD6 docs section; MD7 no new dependency. Report the ids you consider done.
