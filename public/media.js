/**
 * Pictures and sound in the page: what you attach to a message, what the assistant has made, and
 * the few settings behind them. Kept in its own file; the page only provides the empty places.
 */
const $ = (id) => document.getElementById(id);
/** The same caps the runtime holds to, so nothing is sent that would only be refused. */
/* These mirror src/attachments.ts, which is what actually decides; here they only save a long upload. */
const limits = {
  pictures: 4, pictureBytes: 5 * 1024 * 1024, soundBytes: 25 * 1024 * 1024,
  videoBytes: 32 * 1024 * 1024, documentBytes: 20 * 1024 * 1024, files: 6,
  /** Everything on one message added up, the same budget the server holds to. */
  totalBytes: 32 * 1024 * 1024,
};
/**
 * The files this message will really carry. A still taken out of a film is not one of them: it goes
 * as a picture for the model to look at, and the film it came from is already being sent. Counting
 * the stills as files meant a film and its four stills used five of the six a message may have, so
 * the next perfectly legal file was refused for room that was never being spent.
 */
const sendableFiles = () => attached.filter((item) => item.keep !== false);
/** What the files already on this message weigh, so the next one can be refused before it is read. */
const attachedBytes = () => sendableFiles().reduce((sum, item) => sum + (item.bytes ?? 0), 0);
/**
 * The two rules every file on a message must pass, in one place so a picture cannot go round them.
 * It did: a picture was pushed with no `bytes` at all, so four 5 MB pictures added up to nothing and
 * the page would hand a server that takes 32 MB a message weighing 52.
 */
function roomFor(file, mostBytes) {
  if (sendableFiles().length >= limits.files) throw new Error(`Up to ${limits.files} files can go with one message.`);
  if (file.size > mostBytes)
    throw new Error(`${file.name} is larger than ${mostBytes / 1048576} MB, so it was skipped.`);
  // The whole message has a budget as well as each file: two films can each be allowed and still be
  // too much together. Refused here, before the file is read, so nothing long happens for nothing.
  if (attachedBytes() + file.size > limits.totalBytes) {
    const room = Math.max(0, limits.totalBytes - attachedBytes());
    throw new Error(`Everything on one message can add up to ${limits.totalBytes / 1048576} MB. `
      + `${file.name} needs ${Math.round(file.size / 1048576)} MB and there is `
      + `${Math.round(room / 1048576)} MB left — send it in a message of its own.`);
  }
}
const pictureKinds = ["image/png", "image/jpeg", "image/webp", "image/gif"];
let attached = [];

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}
const sizeText = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const say = (message) => globalThis.toast?.(message);

/* ---------- what you attach to the message you are writing ---------- */

/**
 * The pictures the next message should carry for the model to look at, and *only* the ones that are
 * not kept as files in their own right: a still taken out of a film, which exists so the model can
 * see what the film shows. A picture a person attached travels once, with the other files, and the
 * server derives the model's copy from it. Sending it in both places doubled its bytes and could
 * push four perfectly legal pictures past what a message may weigh (src/server.ts: picturesAmong).
 */
globalThis.branchAttachments = () =>
  attached.filter((item) => item.kind === "picture" && item.keep === false)
    .map((item) => ({ mediaType: item.mediaType, data: item.data, name: item.name }));
/**
 * Every file on the message, pictures included, to be kept as it is. A picture also travels as a
 * picture so the model can look at it; a sound and a video are still written out and watched, but the
 * file itself is no longer thrown away once that is done.
 */
globalThis.branchAttachedFiles = () =>
  attached.filter((item) => item.data && item.keep !== false)
    .map((item) => ({ mediaType: item.mediaType, data: item.data, name: item.name }));
globalThis.branchAttachmentsClear = () => {
  attached = [];
  renderAttachments();
};

function renderAttachments() {
  const row = $("composer-attachments");
  if (!row) return;
  row.replaceChildren();
  row.hidden = attached.length === 0;
  for (const item of attached) {
    const chip = el("span", undefined, "attachment");
    if (item.kind === "picture") {
      const thumb = el("img");
      thumb.src = `data:${item.mediaType};base64,${item.data}`;
      thumb.alt = item.name;
      chip.append(thumb);
    }
    chip.append(el("span", item.name));
    const remove = el("button", "×");
    remove.type = "button";
    remove.title = `Take ${item.name} off this message`;
    remove.addEventListener("click", () => {
      attached = attached.filter((other) => other !== item);
      renderAttachments();
    });
    chip.append(remove);
    row.append(chip);
  }
}
const asBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.readAsDataURL(file);
  });

/** A sound file becomes words: it is written out now and the words go into the message. */
async function addSound(file) {
  if (file.size > limits.soundBytes) throw new Error(`${file.name} is larger than 25 MB, so it was skipped.`);
  say(`Listening to ${file.name}…`);
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""), "content-type": file.type || "audio/webm" },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${file.name} could not be written out`);
  const box = $("prompt");
  box.value = (box.value ? box.value.trimEnd() + "\n\n" : "") + data.text;
  box.focus();
  say(`Wrote out what is said in ${file.name}.`);
}
/**
 * Bucket 17: a video becomes a few still pictures on this message and the words said in it. This
 * needs "Watching and saving videos" switched on and ffmpeg on this computer; the server says so
 * plainly when either is missing.
 */
async function addVideo(file) {
  if (file.size > limits.videoBytes) throw new Error(`${file.name} is larger than 32 MB, so it was skipped.`);
  say(`Watching ${file.name}…`);
  const response = await fetch("/api/media/understand", {
    method: "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""), "content-type": file.type },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${file.name} could not be watched`);
  const room = limits.pictures - attached.filter((item) => item.kind === "picture").length;
  data.pictures.slice(0, Math.max(0, room)).forEach((picture, at) =>
    // keep:false — these stills came out of the film, and the film itself is already kept.
    attached.push({ kind: "picture", keep: false, name: `${file.name} · ${at + 1}`, mediaType: picture.mediaType, data: picture.data }));
  renderAttachments();
  const box = $("prompt");
  const said = data.transcript ? `\n\n${file.name}, what is said:\n${data.transcript}` : "";
  if (said) box.value = (box.value ? box.value.trimEnd() : "") + said;
  box.focus();
  say([`Watched ${file.name}.`, ...data.notes].join(" "));
}
/** A document, or anything else the server takes: kept, with nothing read out of it here. */
async function keptOnly(file) {
  await keepAsIs(file, "document", limits.documentBytes);
  say(`${file.name} goes with your message.`);
}
/** Keeps the file as it arrived, so the conversation can hand it back later. */
async function keepAsIs(file, kind, mostBytes) {
  roomFor(file, mostBytes);
  attached.push({ kind, name: file.name, mediaType: file.type || "application/octet-stream",
    bytes: file.size, data: await asBase64(file) });
  renderAttachments();
}
async function addFiles(files) {
  // While a task is working the next message is a follow-up, and a follow-up carries words only.
  const live = Boolean(globalThis.branchLiveState?.()) && globalThis.branchLiveState() !== "idle";
  if ($("composer-media")?.disabled && !live)
    throw new Error("Wait until the assistant has finished; a message sent while it is working carries words only.");
  for (const file of files) {
    if (pictureKinds.includes(file.type)) {
      if (attached.filter((item) => item.kind === "picture").length >= limits.pictures)
        throw new Error(`Up to ${limits.pictures} pictures can go with one message.`);
      if (file.size > limits.pictureBytes) throw new Error(`${file.name} is larger than 5 MB, so it was skipped.`);
      // Bucket 17: during a live conversation a picture is shown straight away instead of waiting for a message.
      const picture = { mediaType: file.type, data: await asBase64(file), name: file.name };
      if (live && globalThis.branchShowLive?.(picture)) {
        say(`Showed ${file.name} in the live conversation.`);
        continue;
      }
      // Asked after the live branch, because a picture shown in a live conversation is not on the
      // message at all and has no budget to spend.
      roomFor(file, limits.pictureBytes);
      attached.push({ kind: "picture", bytes: file.size, ...picture });
      renderAttachments();
      continue;
    }
    if (file.type.startsWith("audio/")) {
      await keepAsIs(file, "sound", limits.soundBytes);
      await addSound(file); // the words in it, as well as the sound itself
      continue;
    }
    if (file.type.startsWith("video/")) {
      await keepAsIs(file, "video", limits.videoBytes);
      await addVideo(file); // a few stills and the words, beside the film itself
      continue;
    }
    await keptOnly(file);
  }
}
function wireComposer() {
  const button = $("composer-media"), picker = $("composer-media-file"), form = $("chat-form");
  if (!button || !picker || !form) return;
  button.addEventListener("click", () => picker.click());
  picker.addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    addFiles(files).catch((error) => say(error.message));
  });
  for (const name of ["dragover", "dragenter"])
    form.addEventListener(name, (event) => {
      event.preventDefault();
      form.classList.add("dropping");
    });
  for (const name of ["dragleave", "drop"]) form.addEventListener(name, () => form.classList.remove("dropping"));
  form.addEventListener("drop", (event) => {
    event.preventDefault();
    addFiles([...event.dataTransfer.files]).catch((error) => say(error.message));
  });
}

/* ---------- made by the assistant ---------- */

/** One kept picture, shown from its own bytes; the page cannot put a key in an image address. */
async function thumbnail(entry) {
  const response = await fetch(`/api/artifacts/file?path=${encodeURIComponent(entry.path)}`, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  if (!response.ok) throw new Error("That picture could not be opened");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${entry.mediaType};base64,${btoa(binary)}`;
}
function madeCard(entry) {
  const node = el("div", undefined, "item");
  const picture = el("img", undefined, "made-thumb");
  picture.alt = entry.name;
  picture.loading = "lazy";
  thumbnail(entry).then((source) => (picture.src = source)).catch(() => picture.remove());
  node.append(picture, el("h3", entry.name));
  node.append(el("p", `${sizeText(entry.bytes)} · made ${new Date(entry.createdAt).toLocaleString()}`, "meta"));
  node.append(el("p", entry.path, "meta"));
  const copy = el("button", "Copy where it is");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(entry.path);
      say("The full path is on your clipboard. Paste it into your file browser to open the folder.");
    } catch {
      say("Copying did not work here. The full path is shown above.");
    }
  });
  node.append(copy);
  return node;
}
export async function loadGallery() {
  const list = $("gallery-list");
  if (!list) return;
  const { artifacts } = await request("/api/artifacts?type=image");
  list.replaceChildren();
  if (!artifacts.length) {
    list.append(el("p", "The assistant has not made any pictures yet. Ask it for one and it will appear here.", "empty"));
    return;
  }
  for (const entry of artifacts.slice(0, 24)) list.append(madeCard(entry));
}

/* ---------- the media settings card ---------- */

export async function loadMediaSettings() {
  const form = $("media-form");
  if (!form) return;
  const { settings, prices, pricedAt } = await request("/api/media/settings");
  $("media-image-model").value = settings.imageModel;
  $("media-folder").value = settings.folder;
  // The price quoted is the one for the model actually chosen, not whichever the table lists first.
  const named = settings.imageModel;
  const listed = named ? (prices[named] ?? prices[named.toLowerCase()]) : undefined;
  const amounts = Object.values(prices);
  const lead = !named
    ? `About $${Math.min(...amounts).toFixed(2)}–$${Math.max(...amounts).toFixed(2)} for one 1024×1024 picture with the common models (list prices as of ${pricedAt}).`
    : listed === undefined
      ? `There is no price on file for ${named}.`
      : `About $${listed.toFixed(2)} for one 1024×1024 picture with ${named} (list price as of ${pricedAt}).`;
  $("media-prices").textContent =
    `${lead} A picture at any other size, or one made by a model with no price on file, is reported as unknown rather than free.`;
}
function wireSettings() {
  const form = $("media-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    $("media-status").textContent = "Saving…";
    try {
      await request("/api/media/settings", {
        body: { imageModel: $("media-image-model").value.trim(), folder: $("media-folder").value.trim() || "media", imagePrices: {} },
      });
      $("media-status").textContent = "Saved.";
    } catch (error) {
      $("media-status").textContent = error.message;
    }
  });
  document
    .querySelector('.nav[data-view="settings"]')
    ?.addEventListener("click", () => loadMediaSettings().catch(() => undefined));
  // phase2/settings: Settings opens from the calm window's cog and from links too, not only this old button.
  document.addEventListener("branch-place", (event) => {
    if (String(event.detail?.view ?? "").startsWith("settings")) loadMediaSettings().catch(() => undefined);
  });
  document
    .querySelector('.nav[data-view="documents"]')
    ?.addEventListener("click", () => loadGallery().catch(() => undefined));
  $("gallery-refresh")?.addEventListener("click", () => loadGallery().catch((error) => say(error.message)));
}
wireComposer();
wireSettings();
