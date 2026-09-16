// Triggers and webhooks UI component for automations
// Shows "When something happens elsewhere" (triggers) and "Tell another app" (webhooks)

let automationsPanel = null;

function showAutomations() {
  const state = globalState;
  const div = el("div", undefined, "automations-panel");

  // Triggers section: When something happens elsewhere
  const triggersSection = el("div", undefined, "automations-section");
  triggersSection.appendChild(el("h3", "When something happens elsewhere"));
  const triggersDesc = el("p", "Let other apps start work here. Each trigger gets its own URL and secret.", "automations-desc");
  triggersSection.appendChild(triggersDesc);

  if (state.triggers && state.triggers.length > 0) {
    const triggersList = el("div", undefined, "automations-list");
    for (const trigger of state.triggers) {
      const item = el("div", undefined, "automations-item");
      const header = el("div", undefined, "automations-item-header");

      const nameEl = el("span", trigger.name, "automations-name");
      header.appendChild(nameEl);

      const enableSwitch = el("input");
      enableSwitch.type = "checkbox";
      enableSwitch.checked = trigger.enabled;
      enableSwitch.className = "automations-toggle";
      enableSwitch.onchange = async () => {
        // TODO: Wire up enable/disable toggle
        console.log("Toggle trigger:", trigger.id);
      };
      header.appendChild(enableSwitch);

      item.appendChild(header);

      const controls = el("div", undefined, "automations-controls");

      const copyUrl = el("button", "Copy URL", "automations-btn-small");
      copyUrl.onclick = () => {
        const url = `${window.location.origin}/api/triggers/${trigger.id}/fire`;
        navigator.clipboard.writeText(url);
        toast("URL copied");
      };
      controls.appendChild(copyUrl);

      const copySecret = el("button", "Copy secret", "automations-btn-small");
      copySecret.onclick = () => {
        navigator.clipboard.writeText(trigger.secret);
        toast("Secret copied");
      };
      controls.appendChild(copySecret);

      const rotateSecret = el("button", "Rotate secret", "automations-btn-small");
      rotateSecret.onclick = async () => {
        const result = await api("triggers/" + trigger.id + "/rotate-secret", {});
        if (result.secret) {
          toast("Secret rotated");
          refresh();
        }
      };
      controls.appendChild(rotateSecret);

      item.appendChild(controls);

      // Fire log
      const logBtn = el("button", "Fire log", "automations-btn-small");
      logBtn.onclick = async () => {
        const log = await api("triggers/" + trigger.id + "/log");
        if (log.log) {
          const logText = log.log.map(entry =>
            `${entry.createdAt}: ${entry.status} (run: ${entry.runId || "—"})`
          ).join("\n");
          alert(logText || "No fires yet");
        }
      };
      item.appendChild(logBtn);

      triggersList.appendChild(item);
    }
    triggersSection.appendChild(triggersList);
  } else {
    triggersSection.appendChild(el("p", "No triggers yet.", "automations-empty"));
  }

  const createTrigger = el("button", "Create trigger", "automations-btn");
  createTrigger.onclick = async () => {
    const name = prompt("Trigger name:");
    if (!name) return;
    const prompt_text = prompt("Prompt template (use {{payload}} or {{field.path}}):");
    if (!prompt_text) return;
    const result = await api("triggers", { name, prompt: prompt_text });
    if (result.id) {
      toast("Trigger created");
      refresh();
    }
  };
  triggersSection.appendChild(createTrigger);

  div.appendChild(triggersSection);

  // Webhooks section: Tell another app
  const webhooksSection = el("div", undefined, "automations-section");
  webhooksSection.appendChild(el("h3", "Tell another app"));
  const webhooksDesc = el("p", "Notify external endpoints when things happen. Delivery is signed with your secret.", "automations-desc");
  webhooksSection.appendChild(webhooksDesc);

  if (state.webhooks && state.webhooks.length > 0) {
    const webhooksList = el("div", undefined, "automations-list");
    for (const webhook of state.webhooks) {
      const item = el("div", undefined, "automations-item");
      const header = el("div", undefined, "automations-item-header");

      const statusEl = el("span", webhook.name, "automations-name");
      if (!webhook.enabled) {
        statusEl.textContent += " (disabled)";
        statusEl.className += " automations-disabled";
      }
      header.appendChild(statusEl);

      item.appendChild(header);

      const url = el("div", webhook.url, "automations-url");
      item.appendChild(url);

      const events = el("div", "Events: " + (webhook.events ? webhook.events.join(", ") : "none"), "automations-events");
      item.appendChild(events);

      const controls = el("div", undefined, "automations-controls");

      const testBtn = el("button", "Test", "automations-btn-small");
      testBtn.onclick = async () => {
        const result = await api("webhooks/" + webhook.id + "/test", {});
        const msg = result.ok ? `Success: ${result.message}` : `Failed: ${result.message}`;
        alert(msg);
      };
      controls.appendChild(testBtn);

      const logBtn = el("button", "Delivery log", "automations-btn-small");
      logBtn.onclick = async () => {
        const log = await api("webhooks/" + webhook.id + "/log");
        if (log.log) {
          const logText = log.log.map(entry =>
            `${entry.createdAt}: ${entry.eventType} - ${entry.status} (attempt ${entry.attempt})`
          ).join("\n");
          alert(logText || "No deliveries yet");
        }
      };
      controls.appendChild(logBtn);

      if (!webhook.enabled) {
        const enableBtn = el("button", "Turn back on", "automations-btn-small");
        enableBtn.onclick = async () => {
          const result = await api("webhooks/" + webhook.id + "/enable", {});
          if (result.enabled) {
            toast("Webhook enabled");
            refresh();
          }
        };
        controls.appendChild(enableBtn);
      }

      item.appendChild(controls);
      webhooksList.appendChild(item);
    }
    webhooksSection.appendChild(webhooksList);
  } else {
    webhooksSection.appendChild(el("p", "No webhooks yet.", "automations-empty"));
  }

  const createWebhook = el("button", "Create webhook", "automations-btn");
  createWebhook.onclick = async () => {
    const name = prompt("Webhook name:");
    if (!name) return;
    const url = prompt("Webhook URL:");
    if (!url) return;
    const secret = prompt("Secret (optional, leave blank for none):");
    const result = await api("webhooks", {
      name,
      url,
      secret: secret || undefined,
      events: ["run.completed", "run.failed"] // Default events
    });
    if (result.id) {
      toast("Webhook created");
      refresh();
    }
  };
  webhooksSection.appendChild(createWebhook);

  div.appendChild(webhooksSection);

  return div;
}
