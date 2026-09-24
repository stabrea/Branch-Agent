/**
 * Choosing how a specialist works, in Specialists. The definition itself is still the JSON below;
 * this only writes the choice into it and says in plain words what the choice means, so nobody has
 * to remember the word for it. What each way of working does comes from the app, not from here.
 */
import { t } from "./i18n.js";
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);
const wording = {
  default: "Works the ordinary way.",
  react: "Thinks one line out loud before each step. You can read the whole trail under “Look inside”.",
  "plan-execute": "Writes a short plan first, then works through it one step at a time.",
  critic: "Reads and comments, and cannot change anything, whatever else it was allowed.",
  researcher: "Looks things up and has to say where each answer came from.",
  coder: "Reads and changes code, one reversible change at a time.",
};

function describe(styles, chosen) {
  const found = styles.find((entry) => entry.style === chosen);
  const extra = found?.opens?.length ? ` It starts with the ${found.opens.join(", ")} tools to hand.` : "";
  $("specialist-style-note").textContent = (wording[chosen] ?? found?.summary ?? "") + extra;
}
/** Writes the choice into the definition without disturbing anything else the person typed. */
function apply(chosen) {
  const field = $("specialist-json");
  try {
    const definition = JSON.parse(field.value || "{}");
    definition.style = chosen;
    field.value = JSON.stringify(definition, null, 2);
  } catch { /* half-typed JSON is the person's business; the choice goes in when it parses */ }
}

async function start() {
  const select = $("specialist-style");
  if (!select) return;
  try {
    const { styles } = await api("specialist-styles");
    select.replaceChildren();
    for (const entry of styles) {
      const option = document.createElement("option");
      option.value = entry.style;
      option.textContent = entry.style === "default" ? "the ordinary way" : entry.style.replace("-", " then ");
      select.append(option);
    }
    describe(styles, select.value);
    select.addEventListener("change", () => { describe(styles, select.value); apply(select.value); });
  } catch { $("specialist-style-note").textContent = t("specialists.status.stylesUnreadable"); }
}

void start();
