/**
 * Artifacts: when a reply carries a fenced `html`, `svg` or `chart` block, it is shown as a card
 * beside the words instead of being left as markup to read. A page or a drawing goes into a frame
 * that is sealed shut — it has an origin of its own, runs no script, submits no form and can fetch
 * nothing, so it can neither read this page nor reach the network. A chart is drawn here in the
 * page, with the numbers under the pointer and the table behind a toggle.
 *
 * A `javascript` or `python` block is never run by the frame. The card offers a button, and that
 * button asks the app to run `code.run`, which is off until the owner switches it on and stops to
 * ask exactly as any other tool does.
 */
import { plainCodeBlock, setArtifactRenderer } from "/markdown.js";
import { drawChart } from "/charts.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}

/** The kinds a reply can carry, and the plain word for each. */
const KINDS = {
  html: { what: "A small page", media: "text/html", framed: true },
  svg: { what: "A drawing", media: "image/svg+xml", framed: true },
  chart: { what: "A chart", media: "application/json", framed: false },
  javascript: { what: "A small JavaScript script", media: "text/plain", framed: false },
  python: { what: "A small Python script", media: "text/plain", framed: false },
};

/** The app's own colours, read off the running page, so an artifact matches the theme around it. */
export function themeTokens() {
  const style = getComputedStyle(document.documentElement);
  const wanted = ["--paper", "--card", "--ink", "--muted", "--line", "--accent", "--good", "--warn", "--danger"];
  const tokens = {};
  for (const name of wanted) {
    const value = style.getPropertyValue(name).trim();
    /* Only a plain colour or size travels; anything stranger is left out rather than patched up. */
    if (value && /^[a-zA-Z0-9 ,.()#%/_+-]{1,120}$/.test(value)) tokens[name] = value;
  }
  return tokens;
}

/** Asks the app for an address this artifact can be shown at, then points the frame at it. */
async function frameFor(kind, code, title) {
  const frame = document.createElement("iframe");
  frame.className = "artifact-frame";
  frame.title = `${KINDS[kind].what}, shown in a sealed frame`;
  /* Empty sandbox: no scripts, no forms, no pop-ups, and no shared origin with this page. */
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.loading = "lazy";
  try {
    const { url } = await api("artifacts/page", { kind, code, title, tokens: themeTokens() });
    frame.src = url;
  } catch (error) {
    frame.replaceWith(el("p", error.message, "meta"));
  }
  return frame;
}

/** "Open larger" mints a second address for the same artifact, because the first one is in use. */
async function openLarger(kind, code, title) {
  const { url } = await api("artifacts/page", { kind, code, title, tokens: themeTokens() });
  if (globalThis.branchDesktop?.openExternal) { await globalThis.branchDesktop.openExternal(location.origin + url); return; }
  globalThis.open(url, "_blank", "noopener");
}

/** A row of buttons; each one says what it does and reports back in the same place. */
function actions(kind, code, title, say) {
  const row = el("div", undefined, "artifact-actions");
  if (KINDS[kind].framed) {
    const larger = el("button", "Open larger", "quiet");
    larger.type = "button";
    larger.addEventListener("click", () => { openLarger(kind, code, title).catch((error) => say(error.message)); });
    row.append(larger);
  }
  const copy = el("button", "Copy code", "quiet");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(code); say("Copied."); } catch { say("Could not copy."); }
  });
  row.append(copy);

  const save = el("button", "Save to workspace", "quiet");
  save.type = "button";
  save.addEventListener("click", () => { void saveArtifact(kind, code, say); });
  row.append(save);

  if (kind === "javascript" || kind === "python") {
    const run = el("button", "Run this script", "quiet");
    run.type = "button";
    run.addEventListener("click", () => { void runScript(kind, code, say, row); });
    row.append(run);
  }
  return row;
}

const EXTENSION = { html: "html", svg: "svg", chart: "json", javascript: "txt", python: "txt" };
/** Keeps the artifact beside the task it came from, where the Documents list shows it. */
async function saveArtifact(kind, code, say) {
  const runId = latestRunId();
  if (!runId) { say("Save it once a task has run; artifacts are kept beside a task."); return; }
  const name = `artifact-${Date.now().toString(36)}.${EXTENSION[kind]}`;
  try {
    await api("artifacts/save", { runId, name, mediaType: KINDS[kind].media, code });
    say(`Saved as ${name}. It is in Documents, under "Made by the assistant".`);
  } catch (error) { say(error.message); }
}
/** The task this reply belongs to, so a saved artifact is kept with it rather than on its own. */
function latestRunId() {
  const known = globalThis.branchLastRunId ?? document.querySelector("[data-run-id]")?.dataset.runId;
  return /^[0-9a-f-]{36}$/i.test(String(known ?? "")) ? known : null;
}

/**
 * Running a script goes out through `code.run` like any other tool, so the owner's switch, the
 * time and memory ceilings and the approval gate all apply. Nothing runs inside the frame.
 */
async function runScript(kind, code, say, row) {
  say("Running…");
  let text, ok = true;
  try {
    const outcome = await api("tools/try", { name: "code.run", arguments: { language: kind, source: code } });
    const result = outcome.result ?? outcome;
    ok = outcome.ok !== false;
    text = String(result?.output || result?.errors || outcome.error || "It finished with nothing to show.");
  } catch (error) { ok = false; text = error.message; }
  /* Whatever came back — an answer, or the switch saying no — the owner sees it in the same place. */
  let shown = row.parentElement?.querySelector(".artifact-output");
  if (!shown) { shown = el("pre", undefined, "artifact-output"); row.after(shown); }
  shown.textContent = text.slice(0, 4000);
  say(ok ? "Finished." : "That did not work.");
}

/** The whole card: a title, what it is, the artifact itself, the buttons, and the code behind a fold. */
export function artifactCard(code, language) {
  const kind = KINDS[language] ? language : null;
  if (!kind) return null;
  /* Not a `.card`, and its title is not a heading: an artifact sits inside a reply, and a heading
     here would push its way into the shape of the document the reply itself makes. */
  const card = el("div", undefined, "artifact");
  const title = `${KINDS[kind].what} the assistant wrote`;
  const heading = el("p", undefined, "artifact-title");
  heading.append(el("strong", title));
  card.append(heading);
  const note = el("p", undefined, "meta artifact-note");
  card.append(note);
  const say = (message) => { note.textContent = message; };
  say(KINDS[kind].framed
    ? "Shown in a sealed frame: it cannot run a script, reach this page, or reach the internet."
    : kind === "chart" ? "Point at a bar or a slice to read its number."
      : "Nothing has run. Press the button to run it, under your usual rules.");

  const body = el("div", undefined, "artifact-body");
  card.append(body);
  if (KINDS[kind].framed) {
    frameFor(kind, code, title).then((frame) => body.append(frame)).catch((error) => say(error.message));
  } else if (kind === "chart") {
    try { body.append(drawChart(code)); } catch (error) { say(error.message); body.append(plainCodeBlock(code, "chart")); }
  }
  card.append(actions(kind, code, title, say));
  const fold = el("details", undefined, "artifact-code");
  fold.append(el("summary", "Show the code"));
  fold.append(plainCodeBlock(code, kind));
  card.append(fold);
  return card;
}

setArtifactRenderer(artifactCard);
