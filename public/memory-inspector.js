/** Memory Inspector: view to inspect, correct, and manage facts with their sources.
    Shows what the owner said, project decisions, and uncertain inferences with source tracking.
    Allows revision-checked corrections via the existing memory.update() path. */
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);

/** Origin label: who/what saved this fact. */
function originLabel(fact) {
  const { kind, scope, sourceRunId } = fact.data;

  // Determine the origin type
  let origin = "inferred"; // default: uncertain
  if (sourceRunId) {
    // Owner-sourced facts from their own runs
    if (!scope || scope === "private") origin = "you said";
    else if (scope === "shared") origin = "team decision";
  } else if (kind && kind.includes("decision")) {
    origin = "project decision";
  }

  return origin;
}

/** Format a fact for display with all source information. */
function factRow(fact) {
  const row = document.createElement("div");
  row.className = "memory-fact-row";
  row.dataset.factId = fact.id;
  row.dataset.revision = fact.revision;

  // Main text
  const textEl = document.createElement("p");
  textEl.className = "memory-fact-text";
  textEl.textContent = String(fact.data.text);

  // Metadata line
  const metaEl = document.createElement("div");
  metaEl.className = "memory-fact-meta";

  // Origin label
  const originEl = document.createElement("span");
  originEl.className = "memory-origin-label";
  originEl.textContent = originLabel(fact);
  metaEl.append(originEl);

  // Source (who saved it)
  const sourceEl = document.createElement("span");
  sourceEl.className = "memory-source";
  sourceEl.textContent = `source: ${String(fact.data.source || "workspace owner")}`;
  metaEl.append(sourceEl);

  // Revision indicator
  const revEl = document.createElement("span");
  revEl.className = "memory-revision";
  revEl.textContent = `v${fact.revision}`;
  metaEl.append(revEl);

  // Timestamps
  const timeEl = document.createElement("span");
  timeEl.className = "memory-time";
  const updated = new Date(fact.updatedAt);
  timeEl.textContent = updated.toLocaleDateString() + " " + updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  metaEl.append(timeEl);

  // Correct button
  const correctBtn = document.createElement("button");
  correctBtn.className = "memory-correct-btn";
  correctBtn.type = "button";
  correctBtn.textContent = "Correct";
  correctBtn.addEventListener("click", () => openCorrectDialog(fact));
  metaEl.append(correctBtn);

  row.append(textEl, metaEl);
  return row;
}

/** Open a modal to correct a fact using revision-checked update. */
async function openCorrectDialog(fact) {
  const dialog = document.createElement("dialog");
  dialog.className = "memory-correct-dialog";

  const form = document.createElement("form");
  form.method = "dialog";

  // Title
  const title = document.createElement("h3");
  title.textContent = "Correct fact";
  form.append(title);

  // Text input (pre-filled)
  const labelText = document.createElement("label");
  labelText.textContent = "Text: ";
  const textarea = document.createElement("textarea");
  textarea.value = String(fact.data.text);
  textarea.maxLength = 4000;
  textarea.required = true;
  labelText.append(textarea);
  form.append(labelText);

  // Source input (pre-filled)
  const labelSource = document.createElement("label");
  labelSource.textContent = "Source: ";
  const sourceInput = document.createElement("input");
  sourceInput.type = "text";
  sourceInput.value = String(fact.data.source || "workspace owner");
  sourceInput.maxLength = 500;
  sourceInput.required = true;
  labelSource.append(sourceInput);
  form.append(labelSource);

  // Current revision (read-only)
  const revisionInfo = document.createElement("p");
  revisionInfo.className = "memory-revision-info";
  revisionInfo.textContent = `Current revision: ${fact.revision}`;
  form.append(revisionInfo);

  // Buttons
  const buttonRow = document.createElement("div");
  buttonRow.className = "memory-dialog-buttons";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const newText = textarea.value.trim();
    const newSource = sourceInput.value.trim();
    if (!newText || !newSource) return;

    try {
      saveBtn.disabled = true;
      const result = await api("memory/correct", {
        id: fact.id,
        text: newText,
        source: newSource,
        expectedRevision: fact.revision
      });
      dialog.close();
      // Reload the facts view
      await loadAndDrawFacts();
    } catch (error) {
      alert(`Error saving: ${error.message}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => dialog.close());

  buttonRow.append(saveBtn, cancelBtn);
  form.append(buttonRow);

  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  textarea.focus();

  // Cleanup when closed
  dialog.addEventListener("close", () => dialog.remove());
}

/** Load and display all memory facts. */
async function loadAndDrawFacts() {
  const container = $("memory-facts-list");
  if (!container) return;

  try {
    container.innerHTML = "<p class=\"loading\">Loading facts...</p>";
    const state = await api("state");
    const facts = state.memory || [];

    if (facts.length === 0) {
      container.innerHTML = "<p class=\"memory-empty\">Nothing saved to memory yet.</p>";
      return;
    }

    // Sort by updatedAt descending (newest first)
    facts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    container.replaceChildren(
      ...facts.map(factRow)
    );
  } catch (error) {
    container.innerHTML = `<p class="memory-error">Error loading facts: ${error.message}</p>`;
  }
}

/** Initialize the inspector when the page loads. */
export async function initMemoryInspector() {
  const container = $("memory-facts-list");
  if (!container) return;

  await loadAndDrawFacts();

  // Auto-refresh every 10 seconds
  setInterval(loadAndDrawFacts, 10000);
}
