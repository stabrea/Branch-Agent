import { t } from "/i18n.js";
import { changeAppearance, currentAppearance } from "/appearance.js";

/*
 * Dogfood E1 (the owner: "there's no even onboarding"; Hermes's is "beautiful"). After the model is picked, the same
 * card asks two more short questions, as Claude Code (theme, sign-in, trust) and Hermes ("one working chat first")
 * do: how Branch should look, and how much it should ask. Each is one click, with Skip, and changes nothing else.
 */
const $ = (id) => document.getElementById(id);
const el = (tag, key, className) => {
  const node = document.createElement(tag);
  if (key) { node.dataset.t = key; node.textContent = t(key); }
  if (className) node.className = className;
  return node;
};

async function savePolicy(preset) {
  const response = await fetch("/api/policy", { method: "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""), "content-type": "application/json" },
    body: JSON.stringify({ preset }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The choice was not saved.");
}

/** One question: a title, a few doors, and Skip. Resolves once one is picked or skipped. */
function ask(card, step, titleKey, choices) {
  return new Promise((done) => {
    const box = el("div", undefined, "onboarding-step");
    box.dataset.step = String(step);
    const counter = el("p", undefined, "first-run-lead onboarding-count");
    counter.textContent = t("onboarding.count", { step, of: 3 });
    const doors = el("div", undefined, "doors");
    const status = el("p", undefined, "onboarding-status");
    status.setAttribute("role", "status");
    for (const choice of choices) {
      const door = el("button", undefined, "door");
      door.type = "button";
      door.dataset.choice = choice.id;
      door.append(el("strong", choice.label), el("span", choice.note));
      if (choice.selected) door.classList.add("selected");
      door.addEventListener("click", async () => {
        door.disabled = true;
        try { await choice.pick(); box.remove(); done(); }
        catch (e) { status.textContent = e.message; door.disabled = false; }
      });
      doors.append(door);
    }
    const skip = el("button", "onboarding.skip", "quiet-button onboarding-skip");
    skip.type = "button";
    skip.addEventListener("click", () => { box.remove(); done(); });
    box.append(counter, el("h2", titleKey), doors, status, skip);
    card.append(box);
  });
}

async function lookStep(card) {
  const now = currentAppearance();
  await ask(card, 2, "onboarding.look.title", [
    { id: "dark", label: "onboarding.look.dark", note: "onboarding.look.dark-note", selected: !now.followSystem && now.appearance === "forest",
      pick: () => changeAppearance({ appearance: "forest", followSystem: false }) },
    { id: "light", label: "onboarding.look.light", note: "onboarding.look.light-note", selected: !now.followSystem && now.appearance === "daylight",
      pick: () => changeAppearance({ appearance: "daylight", followSystem: false }) },
    { id: "system", label: "onboarding.look.system", note: "onboarding.look.system-note", selected: now.followSystem,
      pick: () => changeAppearance({ followSystem: true }) },
  ]);
}

async function carefulStep(card) {
  await ask(card, 3, "onboarding.careful.title", [
    { id: "workspace", label: "onboarding.careful.workspace", note: "onboarding.careful.workspace-note", pick: () => savePolicy("workspace") },
    { id: "ask-before-changes", label: "onboarding.careful.ask", note: "onboarding.careful.ask-note", pick: () => savePolicy("ask-before-changes") },
    { id: "read-only", label: "onboarding.careful.read-only", note: "onboarding.careful.read-only-note", pick: () => savePolicy("read-only") },
  ]);
}

/** Called by the first-run card once a model is ready (public/app.js `finishFirstRun`); resolves when both are answered or skipped. */
globalThis.branchOnboardingSteps = async () => {
  const card = $("first-run");
  if (!card) return;
  const first = [...card.children];
  for (const node of first) node.hidden = true;
  try { await lookStep(card); await carefulStep(card); }
  finally { for (const node of first) node.hidden = false; }
};
