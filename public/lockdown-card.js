/* DG-049: Lockdown on Settings › Permissions, as the sample has it. It is the rail's own switch (public/other.js),
   not a second one: the box shows what the rail's button says and pressing it presses that button, the way the More
   menu and the title-bar banner do (public/layout.js), so all of them always agree. The card shows only where the
   rail's switch does: the owner's, once Branch has said whether Lockdown is on. */
const $ = (id) => document.getElementById(id);

const card = $("lockdown-card");
const box = $("lockdown-switch");
const panel = $("lockdown-panel");
/** The rail's button: the one place Lockdown is turned on and off. */
const railButton = () => panel?.querySelector("button");

/** Shows what the rail's switch says, and nothing when there is no switch to show. */
function sync() {
  const button = railButton();
  const shown = Boolean(button) && !panel.hidden;
  if (card.hidden === shown) card.hidden = !shown;
  if (!button) return;
  const on = button.getAttribute("aria-pressed") === "true";
  if (box.checked !== on) box.checked = on;
  box.disabled = button.disabled;
}

if (card && box && panel) {
  box.addEventListener("change", () => {
    const button = railButton();
    if (!button || button.disabled) { sync(); return; }
    button.click();
    sync(); // until the rail's button redraws with the answer, the box keeps saying what is true now
  });
  new MutationObserver(sync).observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed", "hidden", "disabled"] });
  sync();
}
