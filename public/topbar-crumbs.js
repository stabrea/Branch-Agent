/* DG-099: the top bar says where you are, as the approved sample does (design/Branch-Grown-Up.html, renderTopbar and
   crumbTitle): the face of the computer or Trunk you are on, its name, "/", and then the conversation's own title
   ("New conversation" before its first message) or the place's name. On a phone the name and the "/" give way.

   The place's heading (#page-title) keeps its words for a screen reader and for the places; in a conversation the
   visible title is the conversation's (#thread-name), which public/app.js and public/rooms.js already keep up to date.
   Words have data-t keys; no colour is written here. */
import { face } from "/faces.js";
import { say } from "/strip.js";

const $ = (id) => document.getElementById(id);

function build() {
  const title = $("page-title");
  if (!title || $("lx-crumbs-mid")) return;
  const mark = Object.assign(document.createElement("span"), { className: "lx-crumbs-mark", id: "lx-crumbs-mark" });
  mark.setAttribute("aria-hidden", "true");
  const mid = Object.assign(document.createElement("span"), { className: "lx-crumbs-mid", id: "lx-crumbs-mid" });
  const sep = Object.assign(document.createElement("span"), { className: "lx-crumbs-sep", textContent: "/" });
  sep.setAttribute("aria-hidden", "true");
  title.before(mark, mid, sep);
  const brand = document.querySelector("#rail-target-mark svg, .brand-mark svg");
  if (brand) mark.replaceChildren(brand.cloneNode(true));
  mid.textContent = $("rail-target-name")?.textContent.trim() ?? "";
  const thread = $("thread-name");
  if (thread) {
    thread.dataset.tEmpty = "composer.new";
    thread.dataset.empty = say("composer.new", "New conversation");
  }
}

/** The computer or Trunk the strip has picked: its face and its name. */
function follow(event) {
  const { id, name, spec } = event.detail ?? {};
  const mark = $("lx-crumbs-mark"), mid = $("lx-crumbs-mid");
  if (!mark || !mid) return;
  if (spec) mark.replaceChildren(face(spec, 20, { ground: "surface" }));
  mid.textContent = id === "here" ? $("rail-target-name")?.textContent.trim() || name || "" : name || "";
  mid.title = mid.textContent;
}

build();
document.addEventListener("branch-strip-selection", follow);
document.addEventListener("branch-language", () => {
  const thread = $("thread-name");
  if (thread) thread.dataset.empty = say("composer.new", "New conversation");
});
