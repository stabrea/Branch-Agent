// Bucket 17: two cards, each placed by its `data-home` (docs/places.md):
//   settings:models:media  watching and saving videos with the owner's own ffmpeg and yt-dlp
//   settings:voice         other speech services (Deepgram, ElevenLabs, Azure, a program here)
// Both ship off. Every word goes through a key, and every colour comes from the page's tokens.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
function worded(tag, key, props = {}) {
  const node = el(tag, { ...props, textContent: t(key) });
  node.dataset.t = key;
  return node;
}
function field(key, control) {
  return [worded("label", key, { htmlFor: control.id }), control];
}
function modeSelect(id) {
  const select = el("select", { id });
  for (const mode of ["off", "when-needed", "on"]) select.append(worded("option", `switch.${mode}`, { value: mode }));
  return select;
}
function card(id, home, name, ...controls) {
  const section = el("section", { id, className: "card" },
    worded("h2", `settings.card.${name}`), worded("p", `settings.intro.${name}`, { className: "subtle" }), ...controls,
    el("p", { id: `${id}-status`, className: "subtle", role: "status" }));
  section.dataset.home = home;
  return section;
}
const status = (id, text) => { const node = $(`${id}-status`); if (node) node.textContent = text; };
function saveButton(id, save) {
  const button = worded("button", "action.save-switch", { type: "button", className: "primary" });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await save(); status(id, t("media.programs.saved")); } catch (error) { status(id, error.message); } finally { button.disabled = false; }
  });
  return button;
}

/* ---------- watching and saving videos ---------- */

function videoCard() {
  const id = "video-programs-card";
  const inputs = {
    mode: modeSelect("video-programs-mode"),
    ffmpeg: el("input", { id: "video-programs-ffmpeg", maxLength: 400, placeholder: "/opt/homebrew/bin/ffmpeg" }),
    ytDlp: el("input", { id: "video-programs-ytdlp", maxLength: 400, placeholder: "/opt/homebrew/bin/yt-dlp" }),
    frames: el("input", { id: "video-programs-frames", type: "number", min: 1, max: 4 }),
  };
  const found = el("p", { id: "video-programs-found", className: "subtle" });
  const save = saveButton(id, async () => {
    const shown = await api("media/programs", {
      mode: inputs.mode.value, ffmpeg: inputs.ffmpeg.value.trim(), ytDlp: inputs.ytDlp.value.trim(),
      frames: Math.min(4, Math.max(1, Number(inputs.frames.value) || 4)),
    });
    drawVideo(shown);
  });
  return card(id, "settings:models:media", "video-programs",
    ...field("field.feature-switch", inputs.mode), ...field("media.programs.ffmpeg", inputs.ffmpeg),
    ...field("media.programs.ytdlp", inputs.ytDlp), ...field("media.programs.frames", inputs.frames), found, save);
}
function drawVideo(shown) {
  $("video-programs-mode").value = shown.settings.mode;
  $("video-programs-ffmpeg").value = shown.settings.ffmpeg;
  $("video-programs-ytdlp").value = shown.settings.ytDlp;
  $("video-programs-frames").value = shown.settings.frames;
  const line = (name, entry) => entry.path ? t("media.programs.found", { name, path: entry.path }) : entry.problem;
  $("video-programs-found").textContent = `${line("ffmpeg", shown.ffmpeg)} ${line("yt-dlp", shown.ytDlp)}`;
}

/* ---------- other speech services ---------- */

function engineSelect(id, engines, can) {
  const select = el("select", { id });
  select.append(worded("option", "voice.engines.usual", { value: "" }));
  for (const engine of engines.filter((entry) => entry[can])) select.append(el("option", { value: engine.id, textContent: engine.label }));
  return select;
}
function speechCard(view) {
  const id = "speech-engines-card";
  const s = view.settings;
  const inputs = {
    mode: modeSelect("speech-engines-mode"),
    listen: engineSelect("speech-engines-listen", view.engines, "listens"),
    speak: engineSelect("speech-engines-speak", view.engines, "speaks"),
    deepgram: el("input", { id: "speech-engines-deepgram", maxLength: 100, value: s.secrets.deepgram }),
    elevenlabs: el("input", { id: "speech-engines-elevenlabs", maxLength: 100, value: s.secrets.elevenlabs }),
    azure: el("input", { id: "speech-engines-azure", maxLength: 100, value: s.secrets.azure }),
    region: el("input", { id: "speech-engines-region", maxLength: 30, value: s.azureRegion, placeholder: "westeurope" }),
    voice: el("input", { id: "speech-engines-voice", maxLength: 100, value: s.voice }),
    program: el("input", { id: "speech-engines-program", maxLength: 400, value: s.program, placeholder: "/opt/homebrew/bin/piper" }),
    args: el("textarea", { id: "speech-engines-args", rows: 3, value: s.programArgs.join("\n"), placeholder: "--model\n/path/voice.onnx\n--input-file\n{text}\n--output_file\n{out}" }),
  };
  inputs.mode.value = s.mode;
  inputs.listen.value = s.listen;
  inputs.speak.value = s.speak;
  const save = saveButton(id, () => api("voice/engines", {
    mode: inputs.mode.value, listen: inputs.listen.value, speak: inputs.speak.value,
    secrets: { deepgram: inputs.deepgram.value.trim(), elevenlabs: inputs.elevenlabs.value.trim(), azure: inputs.azure.value.trim() },
    azureRegion: inputs.region.value.trim(), voice: inputs.voice.value.trim(), program: inputs.program.value.trim(),
    programArgs: inputs.args.value.split("\n").map((line) => line.trim()).filter(Boolean),
  }));
  const commands = worded("p", "voice.engines.commands", { className: "subtle" });
  return card(id, "settings:voice", "speech-engines",
    ...field("field.feature-switch", inputs.mode), ...field("voice.engines.listen", inputs.listen),
    ...field("voice.engines.speak", inputs.speak), ...field("voice.engines.deepgram-key", inputs.deepgram),
    ...field("voice.engines.elevenlabs-key", inputs.elevenlabs), ...field("voice.engines.azure-key", inputs.azure),
    ...field("voice.engines.region", inputs.region), ...field("voice.engines.voice", inputs.voice),
    ...field("voice.engines.program", inputs.program), ...field("voice.engines.program-args", inputs.args), commands, save);
}

async function render() {
  const settings = $("settings");
  if (!settings || !token()) return;
  if (!$("video-programs-card")) settings.append(videoCard());
  await api("media/programs").then(drawVideo).catch((error) => status("video-programs-card", error.message));
  const view = await api("voice/engines").catch((error) => ({ error }));
  if (view.error) return;
  const fresh = speechCard(view);
  const old = $("speech-engines-card");
  if (old) old.replaceWith(fresh); else settings.append(fresh);
}

document.querySelector('.nav[data-view="settings"]')?.addEventListener("click", () => void render());
window.branchMediaPrograms = { render };
if (token()) void render();
