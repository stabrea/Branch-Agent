/** The paired screen: the five places, the phone's own switches, and checking for questions. */
import { newAttention, pollPlan, SWITCH_POSITIONS } from "/rules.js";
import { $, phone, plugin, say } from "/phone-common.js";

export const SWITCHES = [
  ["lock", "Lock with face or fingerprint", "Ask before showing Branch. When needed: only after five minutes away."],
  ["notifications", "Tell me when a task needs me", "Checks your Branch for questions. When needed: only while this app is open."],
  ["share", "Send to Branch from other apps", "Puts Branch in the share sheet. When needed: asks for a note before sending."],
  ["voice", "Talk button", "Shows the button that turns what you say into a message."],
  ["push", "Alerts while the app is closed", "Needs a store account first; see the note below."],
];
const POSITION_WORDS = { off: ["phone.switch.off", "Off"], "when-needed": ["phone.switch.whenNeeded", "When needed"], on: ["phone.switch.on", "On"] };

function worded(tag, key, english) {
  const node = document.createElement(tag);
  node.dataset.t = key;
  node.textContent = say(key, english);
  return node;
}
function switchRow([name, title, note], current) {
  const set = document.createElement("fieldset");
  set.className = "phone-switch";
  const segment = document.createElement("div");
  segment.className = "phone-seg";
  for (const position of SWITCH_POSITIONS) {
    const label = document.createElement("label");
    const input = Object.assign(document.createElement("input"), { type: "radio", name: `switch-${name}`, value: position });
    input.checked = current === position;
    input.addEventListener("change", () => void changeSwitch(name, position));
    label.append(input, worded("span", ...POSITION_WORDS[position]));
    segment.append(label);
  }
  set.append(worded("legend", `phone.switch.${name}.title`, title), worded("p", `phone.switch.${name}.note`, note), segment);
  return set;
}

export async function drawSwitches() {
  const current = await phone.vault.switches();
  $("switches").replaceChildren(...SWITCHES.map((row) => switchRow(row, current[row[0]])));
  $("talk-card").hidden = current.voice === "off";
  $("push-note").hidden = current.push === "off";
  $("send-card").hidden = current.share === "off" && !phone.shared.length;
  startPolling(current.notifications);
  return current;
}
/* Changes are saved one after another: two quick taps must not each read the old set and undo the other. */
let changes = Promise.resolve();
function changeSwitch(name, position) {
  changes = changes.then(async () => {
    await phone.vault.setSwitch(name, position);
    await plugin.switchesChanged?.();
    await drawSwitches();
  }).catch(() => drawSwitches());
  return changes;
}

/* ---------- questions from the computer, while the app is open ---------- */
let pollTimer = 0;
const told = new Set();
function startPolling(position) {
  clearInterval(pollTimer);
  const plan = pollPlan(position);
  if (plan.foreground) pollTimer = setInterval(() => void checkAttention(), plan.everySeconds * 1000);
}
export async function checkAttention() {
  try {
    const state = await phone.vault.request("GET", "/api/state");
    for (const item of newAttention(state, told)) {
      told.add(item.id);
      await plugin.notify({ id: item.id, title: say("phone.notify.title", "Branch needs you"), body: item.question });
    }
  } catch { /* the computer may be asleep; the next check tries again */ }
}

export async function drawHome(session) {
  $("paired-with").textContent = say("phone.home.pairedWith", "Paired with {address}", { address: session.origin });
  return drawSwitches();
}
