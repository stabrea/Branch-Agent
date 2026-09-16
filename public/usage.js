const $ = (id) => document.getElementById(id);
const toast = (message) => (globalThis.toast ? globalThis.toast(message) : console.warn(message));
function initializeUsageView() {
  const view = $("usage");
  if (!view) return;

  let usageData = null;
  let budgetData = null;

  async function loadUsage() {
    try {
      const response = await api("usage?range=30d&by=day");
      usageData = response;
      renderUsage();
    } catch (e) {
      toast("Failed to load usage: " + e.message);
    }
  }

  async function loadBudget() {
    try {
      const response = await api("usage/budget");
      budgetData = response.budget;
      renderBudget();
    } catch (e) {
      console.error("Failed to load budget:", e);
    }
  }

  async function saveBudget(maxMonthlyTokens, pauseAtBudget) {
    try {
      await api("usage/budget", { maxMonthlyTokens, pauseAtBudget });
      budgetData = { maxMonthlyTokens, pauseAtBudget };
      toast("Budget saved");
      renderBudget();
    } catch (e) {
      toast("Failed to save budget: " + e.message);
    }
  }

  function renderUsage() {
    if (!usageData || !Array.isArray(usageData)) return;

    view.innerHTML = "";

    // Summary cards
    const summary = el("div", undefined, "usage-summary");
    const totals = usageData.reduce(
      (acc, d) => ({
        runs: acc.runs + d.runs,
        cost: acc.cost + d.estimatedCost,
        failures: acc.failures + d.failures,
        tokens: acc.tokens + d.tokens.input + d.tokens.output,
      }),
      { runs: 0, cost: 0, failures: 0, tokens: 0 }
    );

    const cards = [
      { label: "Estimated Cost This Month", value: "$" + totals.cost.toFixed(2) },
      { label: "Runs", value: totals.runs },
      { label: "Failures", value: totals.failures },
      { label: "Total Tokens", value: totals.tokens.toLocaleString() },
    ];

    for (const card of cards) {
      const cardEl = el("article", undefined, "summary-card");
      cardEl.append(el("span", card.label, "label"), el("span", String(card.value), "value"));
      summary.append(cardEl);
    }
    view.append(summary);

    // Chart
    if (usageData.length > 0) {
      const chartDiv = el("article", undefined, "chart-card");
      const h = el("h2", "Daily Cost");
      chartDiv.append(h);
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 200;
      chartDiv.append(canvas);
      view.append(chartDiv);
      drawCostChart(canvas, usageData);
    }

    // Table by model
    if (usageData[0]?.presets.length > 0) {
      const tableDiv = el("article", undefined, "table-card");
      tableDiv.append(el("h2", "By Model"));
      const table = document.createElement("table");
      table.innerHTML =
        "<thead><tr><th>Model</th><th>Runs</th><th>Cost</th></tr></thead><tbody></tbody>";
      const tbody = table.querySelector("tbody");
      const presetMap = new Map();
      for (const day of usageData) {
        for (const preset of day.presets) {
          const key = preset.id;
          if (!presetMap.has(key)) {
            presetMap.set(key, { id: key, runs: 0, cost: 0 });
          }
          const p = presetMap.get(key);
          p.runs += preset.runs;
          p.cost += preset.cost;
        }
      }
      for (const preset of presetMap.values()) {
        const row = table.insertRow(-1);
        row.innerHTML = `<td>${preset.id}</td><td>${preset.runs}</td><td>$${preset.cost.toFixed(4)}</td>`;
      }
      tableDiv.append(table);
      view.append(tableDiv);
    }

    // Budget section
    const budgetSection = el("article", undefined, "budget-card");
    budgetSection.append(el("h2", "Budget"));
    const budgetForm = el("form", undefined, "form-grid");
    budgetForm.innerHTML = `
      <div>
        <label for="max-monthly">Maximum monthly tokens</label>
        <input id="max-monthly" type="number" value="${budgetData?.maxMonthlyTokens || 0}" placeholder="Leave blank for no limit" />
      </div>
      <label class="check-row">
        <input type="checkbox" id="pause-at-budget" ${budgetData?.pauseAtBudget ? "checked" : ""} />
        Pause new runs when budget is reached
      </label>
      <button type="button" id="save-budget">Save budget</button>
    `;
    budgetSection.append(budgetForm);

    $("save-budget").addEventListener("click", () => {
      const maxTokens = parseInt($("max-monthly").value) || 0;
      const pauseAtBudget = $("pause-at-budget").checked;
      saveBudget(maxTokens, pauseAtBudget);
    });

    view.append(budgetSection);

    // Export section
    const exportSection = el("article", undefined, "export-card");
    exportSection.append(el("h2", "Export"));
    const exportForm = el("form", undefined, "form-grid");
    const csvBtn = button("Export to CSV", async () => {
      const link = document.createElement("a");
      link.href = "/api/usage/export.csv";
      link.download = "usage-30d.csv";
      link.click();
    });
    exportForm.append(csvBtn);
    exportSection.append(exportForm);
    view.append(exportSection);
  }

  function renderBudget() {
    const budgetForm = view.querySelector(".budget-card form");
    if (!budgetForm) return;
    $("max-monthly").value = budgetData?.maxMonthlyTokens || "";
    $("pause-at-budget").checked = budgetData?.pauseAtBudget || false;
  }

  function drawCostChart(canvas, data) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const padding = 40;
    const width = canvas.width - 2 * padding;
    const height = canvas.height - 2 * padding;
    const costs = data.map((d) => d.estimatedCost);
    const maxCost = Math.max(...costs, 1);
    const barWidth = Math.max(2, width / data.length);

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#000";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";

    // Y axis label
    ctx.save();
    ctx.translate(15, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Cost ($)", 0, 0);
    ctx.restore();

    // X axis
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#ccc";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, canvas.height - padding);
    ctx.lineTo(canvas.width - padding, canvas.height - padding);
    ctx.stroke();

    // Y axis
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, canvas.height - padding);
    ctx.stroke();

    // Grid and bars
    const barColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0066ff";
    for (let i = 0; i < data.length; i++) {
      const barHeight = (costs[i] / maxCost) * height;
      const x = padding + (i * width) / data.length + barWidth / 2;
      const y = canvas.height - padding - barHeight;

      // Bar
      ctx.fillStyle = barColor;
      ctx.fillRect(x - barWidth / 2, y, barWidth, barHeight);

      // Date label (every 7 days)
      if (i % 7 === 0) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-dim").trim() || "#666";
        ctx.fillText(data[i].date.slice(5), x, canvas.height - padding + 20);
      }
    }

    // Y axis scale
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-dim").trim() || "#666";
    for (let i = 0; i <= 5; i++) {
      const y = canvas.height - padding - (i * height) / 5;
      const value = ((i * maxCost) / 5).toFixed(2);
      ctx.fillText(value, padding - 20, y + 4);
    }
  }

  // Load data when view is shown
  view.addEventListener("shown", loadUsage);
  if (!view.hidden) {
    loadUsage();
  }
  loadBudget();
}

// Hook into app.js display view logic
const originalDisplayView = window.displayView;
if (originalDisplayView) {
  window.displayView = function (view) {
    originalDisplayView(view);
    if (view === "usage") {
      initializeUsageView();
      $("usage").dispatchEvent(new Event("shown"));
    }
  };
} else {
  // If displayView doesn't exist yet, wait for app.js to load
  document.addEventListener("DOMContentLoaded", () => {
    // Try again after app.js loads
    if (typeof displayView !== "undefined") {
      setTimeout(initializeUsageView, 100);
    }
  });
}
