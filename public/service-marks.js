// Redesign phase 2 (accounts, critiques #21 and #60): marks and plain names where Branch lists the
// services it talks to. Secrets: each key with its service's mark, a plain name ("OpenAI key") and the
// name commands use kept underneath. Chat apps (Customize › Channels):
// each with its mark, or a neutral tile (public/brand-marks.js). The lists are
// drawn by their own modules; this only adds to what they drew, so their behaviour is unchanged.
import { t } from "/i18n.js";
import { markFor, markTile } from "/brand-marks.js";

const say = (key, english, values) => { const said = t(key, values); return said === key ? english : said; };

/** The services a secret's name is recognised by, and the plain words for what it is. */
const KINDS = [
  [/BOT_TOKEN$/, "secrets.kind.bot-token", "{service} bot token"],
  [/APP_TOKEN$/, "secrets.kind.app-token", "{service} app token"],
  [/(API_KEY|_KEY)$/, "secrets.kind.key", "{service} key"],
  [/(TOKEN|PAT)$/, "secrets.kind.token", "{service} token"],
  [/(PASSWORD|PASS)$/, "secrets.kind.password", "{service} password"],
];
const TITLES = { openai: "OpenAI", anthropic: "Anthropic", claude: "Claude", github: "GitHub", githubcopilot: "GitHub Copilot", telegram: "Telegram",
  discord: "Discord", openrouter: "OpenRouter", mistralai: "Mistral", deepseek: "DeepSeek", perplexity: "Perplexity", huggingface: "Hugging Face" };

/** "OPENAI_API_KEY" → "OpenAI key"; "SUPPLIER_API_KEY" → "Supplier API key". Never invents a service. */
export function plainSecretName(name) {
  const slug = markFor(name);
  const words = name.toLowerCase().replace(/_/g, " ").replace(/\bapi\b/g, "API").replace(/^./, (c) => c.toUpperCase());
  if (!slug) return words;
  const service = TITLES[slug] ?? name.split("_")[0].replace(/^./, (c) => c.toUpperCase());
  const kind = KINDS.find(([pattern]) => pattern.test(name));
  return kind ? say(kind[1], kind[2], { service }) : service;
}

/** Hook for app.js's Secrets list: the mark, a plain name, and the name commands use underneath. */
function secretRow(node, secret) {
  const strong = node.querySelector("strong");
  if (!strong || node.querySelector(".brand-mark")) return;
  node.classList.add("secret-row");
  const words = document.createElement("div");
  words.className = "secret-row-words";
  const plain = document.createElement("strong");
  plain.textContent = plainSecretName(secret.name);
  const raw = document.createElement("small");
  raw.className = "secret-raw";
  raw.textContent = say("secrets.used-as", `Commands use it as ${secret.name}`, { name: secret.name });
  words.append(plain, raw);
  strong.replaceWith(words);
  const meta = node.querySelector(".meta");
  if (meta) meta.textContent = meta.textContent.replace(/^\s*·\s*/, "");
  node.prepend(markTile([secret.name], { size: 30, fallback: "key" }));
}

/* Chat apps (their Set up panels, the connected list, the other services) and the model connections on
   Settings › Models (the sign-in cards and the fallback list): a mark before each name. */
const PLACES = ["#lx-slot-customize-channels summary", "#lx-slot-customize-channels .record > strong:first-child",
  "#chatgpt-card > h2", "#gemini-signin-card > h2", "#models-fallback label"];
function decorate() {
  for (const target of document.querySelectorAll(PLACES.join(", "))) {
    if (target.querySelector(":scope > .brand-mark")) continue; // already marked
    const text = target.textContent.trim();
    if (!text) continue;
    const mark = markTile([text], { size: 22, fallback: target.closest("#lx-slot-customize-channels") ? "chat" : "service" });
    mark.classList.add("inline-mark");
    const box = target.querySelector(":scope > input");
    if (box) box.after(mark); else target.prepend(mark);
  }
}
let queued = false;
function soon() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; decorate(); });
}

/* Only the two places that hold marked lists are watched, not the whole page: the Settings window and the
   Customize place. Each is watched from the moment it exists (layout.js builds them after this loads). */
const watched = new Set();
function watch() {
  for (const id of ["settings-window", "customize"]) {
    const place = document.getElementById(id);
    if (!place || watched.has(place)) continue;
    watched.add(place);
    new MutationObserver(soon).observe(place, { childList: true, subtree: true });
  }
  soon();
}

if (typeof document !== "undefined") {
  globalThis.branchSecretMarks = secretRow;
  const until = new MutationObserver(() => { watch(); if (watched.size === 2) until.disconnect(); });
  until.observe(document.body, { childList: true, subtree: true });
  watch();
}
