/* R17-C: files, voice, devices and personal connectors, one card in each part's home, each placed by
   public/layout.js through data-home. Every part has the owner's three-way switch and starts off.

   customize:connections   Your own accounts (Google, Microsoft, Spotify), searching X, Home Assistant
   customize:channels      Sending files into chats, searching the email channel's inbox
   automations:triggers    A public address for incoming webhooks only
   settings:voice          The spoken briefing, and saying yes aloud                                  */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function labelled(id, key, english, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
function input(value = "", type = "") {
  const node = document.createElement("input");
  if (type) node.type = type;
  if (type === "checkbox") node.checked = !!value; else node.value = value ?? "";
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node) => { node.dataset.t = "personal.saved"; node.textContent = say("personal.saved", "Saved."); };
const show = (node, text) => { delete node.dataset.t; node.textContent = text; };
function button(key, english, handler) {
  const node = make("button", "quiet-button", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return node;
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children);
  return node;
}
/** Runs a request and reports its answer or its refusal in the card's status line. */
const attempt = (status, work) => async () => { try { await work(); } catch (error) { tell(status, error); } };

const POSITIONS = [["off", "field.switch-off", "Off"], ["when-needed", "field.switch-when-needed", "When needed"], ["on", "field.switch-on", "On"]];
const PARTS = {
  "chat-files": ["personal.part.chatFiles", "Sending files into your chats"],
  "home-control": ["personal.part.home", "Looking at and controlling Home Assistant"],
  "spoken-brief": ["personal.part.brief", "A spoken daily briefing"],
  "voice-approvals": ["personal.part.voiceYes", "Saying yes aloud to approve a request"],
  "x-search": ["personal.part.x", "Searching X through the xAI API"],
  spotify: ["personal.part.spotify", "Controlling your Spotify"],
  google: ["personal.part.google", "Your Gmail, Google Calendar and Google Drive"],
  microsoft: ["personal.part.microsoft", "Your Outlook mail, calendar and Teams meetings"],
  "mail-search": ["personal.part.mail", "Searching the email channel's inbox"],
  tunnel: ["personal.part.tunnel", "A public address for incoming webhooks only"],
};

function switchFor(part, modes, status) {
  const control = segmented({
    id: `personal-switch-${part}`,
    options: POSITIONS,
    value: modes[part],
    onChange: attempt(status, async () => {
      await api("personal/switch", { part, mode: control.value });
      done(status);
      await drawCards();
    })
  });
  const [key, english] = PARTS[part];
  return labelled(`personal-switch-${part}`, key, english, control);
}

function card(id, home, titleKey, title, purposeKey, purpose) {
  const node = make("section", "card");
  node.id = id;
  node.dataset.home = home;
  /* DG-198: a card on Settings › Automations & inbox is titled under its section heading (DG-008). */
  const titled = home === "settings:automations";
  node.append(make(titled ? "h3" : "h2", titled ? "settings-card-title" : "", titleKey, title), make("p", "subtle", purposeKey, purpose));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  return { node, status };
}

/* ---------- customize:connections — the owner's own accounts ---------- */
const SERVICES = [
  ["google", "personal.google.name", "Google (Gmail, Calendar, Drive)", "google/events"],
  ["microsoft", "personal.microsoft.name", "Microsoft (Outlook mail, calendar, Teams)", "microsoft/events"],
  ["spotify", "personal.spotify.name", "Spotify, for music", "spotify/now"],
];

async function serviceBlock(service, nameKey, name, tryPath, status) {
  const { settings, status: signed } = await api(`personal/signin/${service}`);
  const id = input(settings.clientId), secret = input(settings.clientSecretName);
  const parts = [make("h3", "", nameKey, name),
    ...labelled(`personal-${service}-client`, "personal.signin.client", "Client id of your own app", id),
    ...labelled(`personal-${service}-secret`, "personal.signin.secret", "Saved secret holding its client secret (leave empty if it has none)", secret)];
  const extra = {};
  if (service !== "spotify") {
    extra.drafts = input(settings.drafts, "checkbox");
    parts.push(...labelled(`personal-${service}-drafts`, "personal.signin.drafts", "Also allow writing drafts (never sending)", extra.drafts));
    parts.push(make("p", "field-note", "personal.signin.draftsNote",
      "The service only offers drafts with a permission that could also send mail. Branch never sends; sign in again after changing this."));
  }
  if (service === "microsoft") {
    extra.tenant = input(settings.tenant);
    parts.push(...labelled("personal-microsoft-tenant", "personal.signin.tenant", "Directory (common lets any account in)", extra.tenant));
  }
  const state = signed.signedIn ? say("personal.signin.yes", "Signed in.") : say("personal.signin.no", "Not signed in yet.");
  const save = attempt(status, async () => {
    await api(`personal/signin/${service}`, { clientId: id.value.trim(), clientSecretName: secret.value.trim(),
      ...(extra.drafts ? { drafts: extra.drafts.checked } : {}), ...(extra.tenant ? { tenant: extra.tenant.value.trim() || "common" } : {}) });
    done(status);
  });
  const signIn = attempt(status, async () => {
    const started = await api(`personal/signin/${service}/start`, {});
    window.open(started.url, "_blank", "noopener");
    show(status, say("personal.signin.opened", "The sign-in page is open in your browser. Come back here when it says you are signed in."));
  });
  const check = attempt(status, async () => show(status, JSON.stringify(await api(`personal/${tryPath}`, {})).slice(0, 400)));
  parts.push(plain("p", state, "field-note"), row(button("personal.save", "Save", save), button("personal.signin.go", "Sign in", signIn),
    button("personal.signin.try", "Try it", check)));
  return parts;
}

async function accountsCard(modes) {
  const { node, status } = card("personal-accounts-card", "customize:connections", "personal.accounts.title", "Your own accounts",
    "personal.accounts.purpose", "Let Branch read your mail, calendar and files, and play your music, with your own sign-in. Nothing is ever sent from your mailbox.");
  for (const [service, key, name, tryPath] of SERVICES) {
    node.append(...switchFor(service, modes, status));
    if (modes[service] !== "off") node.append(...await serviceBlock(service, key, name, tryPath, status));
  }
  node.append(status);
  return node;
}

async function xCard(modes) {
  const { node, status } = card("personal-x-card", "customize:connections", "personal.x.title", "Searching posts on X",
    "personal.x.purpose", "Search X through xAI's own API, with an xAI API key saved in Secrets. It costs what xAI charges.");
  node.append(...switchFor("x-search", modes, status));
  if (modes["x-search"] !== "off") {
    const { settings } = await api("personal/x");
    const key = input(settings.keyName), model = input(settings.model), query = input();
    node.append(...labelled("personal-x-key", "personal.x.key", "Saved secret holding the xAI API key", key),
      ...labelled("personal-x-model", "personal.x.model", "xAI model", model),
      row(button("personal.save", "Save", attempt(status, async () => { await api("personal/x", { keyName: key.value.trim(), model: model.value.trim() }); done(status); }))),
      ...labelled("personal-x-query", "personal.x.query", "What to look for", query),
      row(button("personal.x.search", "Search X", attempt(status, async () => show(status, (await api("personal/x/search", { query: query.value })).answer)))));
  }
  node.append(status);
  return node;
}

async function homeCard(modes) {
  const { node, status } = card("personal-home-card", "customize:connections", "personal.home.title", "Your Home Assistant",
    "personal.home.purpose", "Let Branch look at your devices, and switch the kinds you list, with a long-lived access token saved in Secrets.");
  node.append(...switchFor("home-control", modes, status));
  if (modes["home-control"] !== "off") {
    const { settings } = await api("personal/home");
    const url = input(settings.url ?? "", "url"), token = input(settings.tokenName), kinds = input(settings.domains.join(" "));
    node.append(...labelled("personal-home-url", "personal.home.url", "Address of your Home Assistant", url),
      ...labelled("personal-home-token", "personal.home.token", "Saved secret holding the access token", token),
      ...labelled("personal-home-kinds", "personal.home.kinds", "Kinds of device Branch may switch (light switch scene…)", kinds),
      make("p", "field-note", "personal.home.private", "A Home Assistant on your home network needs private addresses allowed under Computer → Network reach."),
      row(button("personal.save", "Save", attempt(status, async () => {
        await api("personal/home", { url: url.value.trim() || null, tokenName: token.value.trim(), domains: kinds.value.split(/\s+/).filter(Boolean) });
        done(status);
      })), button("personal.home.lights", "Show the lights", attempt(status, async () => {
        const { states } = await api("personal/home/states", { domain: "light" });
        show(status, states.map((s) => `${s.name || s.entity}: ${s.state}`).join(" · ") || "—");
      }))));
  }
  node.append(status);
  return node;
}

/* ---------- customize:channels — files into chats, the inbox ---------- */
async function filesCard(modes) {
  const { node, status } = card("personal-files-card", "customize:channels", "personal.files.title", "Files sent into your chats",
    "personal.files.purpose", "Branch can send a chart, PDF or spreadsheet it made into a Telegram, Slack or Discord chat that already talks to it. A file holding a key or password is never sent.");
  node.append(...switchFor("chat-files", modes, status));
  if (modes["chat-files"] !== "off") {
    const { settings } = await api("personal/chat-files");
    const size = input(settings.maxMegabytes, "number");
    size.min = "1"; size.max = "100";
    node.append(...labelled("personal-files-size", "personal.files.size", "Largest file, in megabytes", size),
      row(button("personal.save", "Save", attempt(status, async () => { await api("personal/chat-files", { maxMegabytes: Number(size.value) }); done(status); }))));
  }
  node.append(status);
  return node;
}

async function mailCard(modes) {
  const { node, status } = card("personal-mail-card", "customize:channels", "personal.mail.title", "Searching the email inbox",
    "personal.mail.purpose", "Search the email channel's inbox and open the files attached to a message. Nothing is marked read or sent.");
  node.append(...switchFor("mail-search", modes, status));
  if (modes["mail-search"] !== "off") {
    const { settings } = await api("personal/mail");
    const host = input(settings.host ?? ""), port = input(settings.port, "number"), user = input(settings.user),
      password = input(settings.passwordName), folder = input(settings.folder), words = input();
    node.append(...labelled("personal-mail-host", "personal.mail.host", "Mail server (IMAP)", host),
      ...labelled("personal-mail-port", "personal.mail.port", "Port number", port),
      ...labelled("personal-mail-user", "personal.mail.user", "User name", user),
      ...labelled("personal-mail-password", "personal.mail.password", "Saved secret holding the password", password),
      ...labelled("personal-mail-folder", "personal.mail.folder", "Workspace folder for saved attachments", folder),
      row(button("personal.save", "Save", attempt(status, async () => {
        await api("personal/mail", { host: host.value.trim() || null, port: Number(port.value), user: user.value.trim(),
          passwordName: password.value.trim(), folder: folder.value.trim() });
        done(status);
      }))),
      ...labelled("personal-mail-words", "personal.mail.words", "Words to look for", words),
      row(button("personal.mail.search", "Search the inbox", attempt(status, async () => {
        const { messages } = await api("personal/mail/search", words.value.trim() ? { text: words.value.trim() } : {});
        show(status, messages.map((m) => `${m.name}: ${m.subject}`).join(" · ") || "—");
      }))));
  }
  node.append(status);
  return node;
}

/* ---------- automations:triggers — the webhook-only address ---------- */
async function tunnelCard(modes) {
  const { node, status } = card("personal-tunnel-card", "settings:automations", "personal.tunnel.title", "A public address for webhooks",
    "personal.tunnel.purpose", "Chat services and triggers can reach Branch from the internet through your own tunnel program. Only webhook addresses pass; the window never does.");
  /* Its section heading already says "A public address for webhooks": the title stays for a screen reader, not shown twice (DG-032). */
  node.querySelector(":scope > h3")?.classList.add("sr-only");
  node.append(...switchFor("tunnel", modes, status));
  if (modes.tunnel !== "off") {
    node.append(make("p", "field-note", "personal.tunnel.warning",
      "While it runs, anyone on the internet who learns the address can reach your webhook addresses. Each one still checks its own signature. Stop it when you do not need it."));
    const view = await api("personal/tunnel");
    const programs = [["cloudflared", "cloudflared"], ["tailscale", "tailscale"], ["ngrok", "ngrok"]];
    const program = dropdown({ id: "personal-tunnel-program-select", options: programs, value: view.settings.program });
    const path = input(view.settings.executable);
    const address = view.status.address ?? say("personal.tunnel.none", "Not running.");
    node.append(...labelled("personal-tunnel-program", "personal.tunnel.program", "Tunnel program you installed", program),
      ...labelled("personal-tunnel-path", "personal.tunnel.path", "Full path to it, if it is not found by name", path),
      row(button("personal.save", "Save", attempt(status, async () => { await api("personal/tunnel", { program: program.value, executable: path.value.trim() }); done(status); }))),
      plain("p", address, "field-note"),
      row(button("personal.tunnel.start", "Start", attempt(status, async () => { await api("personal/tunnel/start", {}); await drawCards(); })),
        button("personal.tunnel.stop", "Stop", attempt(status, async () => { await api("personal/tunnel/stop", {}); await drawCards(); }))));
  }
  node.append(status);
  return node;
}

/* ---------- settings:voice — the spoken briefing and a spoken yes ---------- */
async function record(seconds) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const pieces = [];
  recorder.addEventListener("dataavailable", (event) => pieces.push(event.data));
  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve));
  recorder.start();
  setTimeout(() => recorder.stop(), seconds * 1000);
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  const blob = new Blob(pieces, { type: recorder.mimeType || "audio/webm" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return { audio: btoa(text), mediaType: blob.type };
}

async function waitingQuestions(status) {
  const { waiting = [] } = await api("policy");
  return waiting.map((question) => {
    const item = plain("p", question.label, "field-note");
    item.append(" ", button("personal.voice.answer", "Answer aloud", attempt(status, async () => {
      const offer = await api("personal/voice/offer", { sessionId: question.sessionId, fingerprint: question.fingerprint });
      show(status, say("personal.voice.speak", "Listening for four seconds: say yes or no."));
      const spoken = await record(4);
      const heard = await api("personal/voice/answer", { id: offer.id, ...spoken });
      show(status, heard.message);
      // A risky request needs a press as well as the spoken yes.
      if (heard.confirm) item.append(" ", button("personal.voice.confirm", "Yes, allow it", attempt(status, async () => {
        show(status, (await api("personal/voice/confirm", { id: offer.id })).message);
      })));
    })));
    return item;
  });
}

async function voiceCard(modes) {
  const { node, status } = card("personal-voice-card", "settings:voice", "personal.voice.title", "Briefings and answers by voice",
    "personal.voice.purpose", "Hear your day read aloud, and answer a waiting question by saying yes or no. Branch only listens when you press the button.");
  node.append(...switchFor("spoken-brief", modes, status));
  if (modes["spoken-brief"] !== "off") {
    node.append(row(button("personal.brief.play", "Play my briefing", attempt(status, async () => {
      const played = await api("personal/brief/play", {});
      show(status, played.text);
      await new Audio(`data:${played.mediaType};base64,${played.audio}`).play();
    }))));
  }
  node.append(...switchFor("voice-approvals", modes, status));
  if (modes["voice-approvals"] !== "off") node.append(...await waitingQuestions(status));
  node.append(status);
  return node;
}

const BUILDERS = [accountsCard, xCard, homeCard, filesCard, mailCard, tunnelCard, voiceCard];
const IDS = ["personal-accounts-card", "personal-x-card", "personal-home-card", "personal-files-card", "personal-mail-card", "personal-tunnel-card", "personal-voice-card"];

async function drawCards() {
  let modes;
  try { modes = (await api("personal")).modes; } catch { return; }
  for (const [index, build] of BUILDERS.entries()) {
    try {
      const fresh = await build(modes);
      const old = $(IDS[index]);
      if (old) old.replaceWith(fresh); else document.body.append(fresh);
    } catch { /* one card failing leaves the rest of the window as it was */ }
  }
}

function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}

whenReady(() => { void drawCards(); });
