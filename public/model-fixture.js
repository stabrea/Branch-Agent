/**
 * FQ-models.hosted-local: "Run the same check" in Settings → Which model does what. Sends one
 * fixed conversation, with a tool call and a round trip on the tool's own answer, through every
 * configured connection, and marks each result Hosted or On this computer from what the server
 * reports — so the owner can see a hosted connection and a local one pass the same fixture.
 */
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const bearer = () => "Bearer " + (sessionStorage.getItem("branch-token") || "");
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { authorization: bearer(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}
const say = (message) => (typeof globalThis.toast === "function" ? globalThis.toast(message) : console.warn(message));

function resultCard(result) {
  const card = el("div", undefined, "record");
  const where = result.local ? "On this computer" : "Hosted";
  card.append(el("strong", `${result.name} — ${where} — ${result.passed ? "passed" : "failed"}`));
  card.append(el("p", result.passed ? `Round trip completed in ${result.ms} ms.` : result.reason, "meta"));
  return card;
}

async function runFixtureCheck() {
  const list = $("model-fixture-list");
  if (!list) return;
  list.replaceChildren(el("p", "Running the same check on every connection…", "meta"));
  try {
    const { results } = await post("/api/models/fixture", {});
    if (!results.length) {
      list.replaceChildren(el("p", "No model connections are configured yet.", "meta"));
      return;
    }
    list.replaceChildren(...results.map(resultCard));
    const failed = results.filter((result) => !result.passed).length;
    say(failed ? `${failed} of ${results.length} connections did not complete the fixture.` : "Every connection completed the same fixture.");
  } catch (error) {
    list.replaceChildren(el("p", error.message, "meta"));
  }
}

function start() {
  $("model-fixture-run")?.addEventListener("click", () => void runFixtureCheck());
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
