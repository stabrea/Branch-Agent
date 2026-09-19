/* mac7/phone-qr: "Get Branch on your phone" (Customize, Channels).

   Show the code opens a download link on this computer for fifteen minutes; the phone's ordinary
   camera scans it and lands on the install page. The link only ever hands out the app. Every word
   has a data-t key with English and French (public/locales/). No colour is written here. */
import { api } from "/app.js";
import { qrPicture } from "/devices.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => {
  const word = t(key, values);
  return (word === key ? english : word).replace(/\{(\w+)\}/g, (whole, name) => values?.[name] ?? whole);
};
function make(tag, className, key, english, values) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key && values) { node.dataset.tTemplate = key; node.textContent = say(key, english, values); }
  else if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function button(key, english, handler) {
  const node = make("button", "quiet-button", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } catch (error) { status.textContent = error.message ?? String(error); } finally { node.disabled = false; }
  });
  return node;
}

let status = document.createElement("p");
let timer = null;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function showing(view, share) {
  const box = document.createElement("div");
  box.id = "phone-app-share";
  const link = make("code", "");
  link.textContent = share.url;
  link.style.overflowWrap = "anywhere";
  box.append(make("p", "", "phoneApp.scan", "Point your Android phone's camera at this square, then press the link it shows:"),
    qrPicture(share.qr),
    make("p", "field-note", "phoneApp.sameWifi", "Your phone must be on the same Wi-Fi as this computer."),
    make("p", "field-note", "phoneApp.expires", "This link only downloads the Branch app and stops working at {time}.", { time: time(share.expiresAt) }),
    link);
  const others = view.addresses.filter((address) => address !== share.address);
  if (others.length) {
    box.append(make("p", "field-note", "phoneApp.other", "Phone cannot open it? Try another address of this computer:"));
    for (const address of others) {
      const pick = button("", "", () => start(address));
      pick.textContent = address;
      box.append(pick);
    }
  }
  box.append(button("phoneApp.stop", "Stop the link", async () => { await api("phone-app/stop", {}); await draw(); }));
  return box;
}

async function start(address) {
  await api("phone-app/share", address ? { address } : {});
  await draw();
}

async function buildCard() {
  const view = await api("phone-app");
  const node = make("section", "card");
  node.id = "phone-app-card";
  node.dataset.home = "customize:channels";
  node.append(make("h2", "", "phoneApp.title", "Get Branch on your phone"),
    make("p", "subtle", "phoneApp.purpose", "Scan a code with your phone's camera and the Branch app installs. It comes straight from this computer; nothing is downloaded from the internet."));
  status = make("p", "subtle");
  status.setAttribute("role", "status");
  if (!view.available) status.textContent = view.reason;
  else if (view.share) node.append(showing(view, view.share));
  else node.append(button("phoneApp.show", "Show the code", () => start()));
  node.append(status);
  return { node, view };
}

async function draw() {
  try {
    const { node, view } = await buildCard();
    const old = $("phone-app-card");
    if (old) old.replaceWith(node); else document.body.append(node);
    // The card closes the code itself when the link runs out, so an old code is never left showing.
    clearTimeout(timer);
    if (view.share) timer = setTimeout(() => void draw(), Math.max(1000, Date.parse(view.share.expiresAt) - Date.now() + 500));
  } catch { /* the window stays as it was; the next draw tries again */ }
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

whenReady(() => {
  void draw();
  document.addEventListener("branch-language", () => void draw());
});
