/**
 * Pictures and sound in the page: what you attach to a message, what the assistant has made, and
 * the few settings behind them. Kept in its own file; the page only provides the empty places.
 */
const $ = (id) => document.getElementById(id);
/** The same caps the runtime holds to, so nothing is sent that would only be refused. */
const limits = { pictures: 4, pictureBytes: 5 * 1024 * 1024, soundBytes: 25 * 1024 * 1024 };
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

/** The pictures the next message should carry, in the shape the run route expects. */
globalThis.branchAttachments = () =>
  attached.filter((item) => item.kind === "picture").map((item) => ({ mediaType: item.mediaType, data: item.data, name: item.name }));
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
async function addFiles(files) {
  // While a task is working the next message is a follow-up, and a follow-up carries words only.
  if ($("composer-media")?.disabled)
    throw new Error("Wait until the assistant has finished; a message sent while it is working carries words only.");
  for (const file of files) {
    if (pictureKinds.includes(file.type)) {
      if (attached.filter((item) => item.kind === "picture").length >= limits.pictures)
        throw new Error(`Up to ${limits.pictures} pictures can go with one message.`);
      if (file.size > limits.pictureBytes) throw new Error(`${file.name} is larger than 5 MB, so it was skipped.`);
      attached.push({ kind: "picture", name: file.name, mediaType: file.type, data: await asBase64(file) });
      renderAttachments();
      continue;
    }
    if (file.type.startsWith("audio/")) {
      await addSound(file);
      continue;
    }
    throw new Error(`${file.name} is not a picture or a sound file. Use the Documents panel for other files.`);
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
  document
    .querySelector('.nav[data-view="documents"]')
    ?.addEventListener("click", () => loadGallery().catch(() => undefined));
  $("gallery-refresh")?.addEventListener("click", () => loadGallery().catch((error) => say(error.message)));
}
wireComposer();
wireSettings();
