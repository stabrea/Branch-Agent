const $ = (id) => document.getElementById(id);
const desktop = new URLSearchParams(location.search).get("desktop") === "1";
if (desktop) document.querySelector(".brand").href = "/?desktop=1";
let savedAppearance;
let token = sessionStorage.getItem("branch-token") || "",
  state = null,
  sessionId = null,
  selectedRun = null;
const titles = {
  chat: "Conversation",
  runs: "Activity",
  memory: "Memory",
  specialists: "Specialists",
  procedures: "Procedures",
  schedules: "Schedules",
  settings: "Settings",
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function action(tool, args) {
  const result = await api("action", { tool, args });
  await refresh();
  return result;
}
function button(label, handler) {
  const node = el("button", label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await handler();
    } catch (e) {
      toast(e.message);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}
function displayView(view) {
  document.querySelectorAll(".view").forEach((node) => {
    node.hidden = node.id !== view;
  });
  document
    .querySelectorAll(".nav")
    .forEach((node) =>
      node.classList.toggle("active", node.dataset.view === view),
    );
  $("page-title").textContent = titles[view];
}
document
  .querySelectorAll(".nav")
  .forEach((node) =>
    node.addEventListener("click", () => displayView(node.dataset.view)),
  );
function list(id, items, render, empty) {
  const target = $(id);
  target.replaceChildren(...items.map(render));
  if (!items.length) target.append(el("div", empty, "empty"));
}
function recordCard(title, status) {
  const node = el("article", undefined, "item");
  if (status) node.append(el("span", status, "badge " + status));
  node.append(el("h3", title));
  return node;
}
function date(value) {
  return new Date(value).toLocaleString();
}
function renderRuns() {
  list(
    "runs-list",
    state.runs,
    (run) => {
      const node = recordCard(run.prompt, run.status);
      node.append(el("p", run.output || "Working…"));
      const usage = el("div", undefined, "usage");
      usage.append(
        el(
          "span",
          `Estimated tokens: ${run.usage.estimatedInput} in / ${run.usage.estimatedOutput} out`,
        ),
        el(
          "span",
          run.usage.reports
            ? `Provider reported: ${run.usage.reportedInput} in / ${run.usage.reportedOutput} out`
            : "Provider usage: not reported",
        ),
      );
      node.append(
        usage,
        el(
          "p",
          `${run.usage.unreportedCalls} calls without provider usage · ${run.usage.incompleteCalls} calls with incomplete output accounting`,
          "meta",
        ),
        el("p", date(run.createdAt), "meta"),
        button("Inspect trace", () => showRun(run.id)),
      );
      if (run.status === "running")
        node.append(
          button("Cancel", async () => {
            await api("runs/" + run.id + "/cancel", {});
            await refresh();
          }),
        );
      return node;
    },
    "Your completed and active runs will appear here.",
  );
}
async function showRun(id) {
  selectedRun = id;
  const detail = await api("runs/" + id);
  const target = $("run-detail");
  target.hidden = false;
  target.replaceChildren(
    el("h3", "Run trace"),
    el("p", id, "meta"),
    el("pre", JSON.stringify(detail.events, null, 2)),
  );
}
function renderMemory() {
  list(
    "memory-list",
    state.memory,
    (record) => {
      const node = recordCard(record.data.text);
      node.append(
        el("p", record.data.source),
        el("p", date(record.createdAt), "meta"),
        button("Delete", () => action("memory.delete", { id: record.id })),
      );
      return node;
    },
    "Save a preference, decision, or useful fact.",
  );
}
function specialistCard(record) {
  const d = record.data,
    node = recordCard(
      d.definition.name,
      d.activeVersion ? "active v" + d.activeVersion : "candidate",
    );
  node.append(
    el("p", d.definition.instructions),
    el(
      "p",
      `Candidate v${d.version} · ${d.evaluationPassed ? "checks passed" : "not evaluated or checks failed"}`,
    ),
    el("p", "Permissions: " + d.definition.permissions.join(", "), "meta"),
  );
  specialistActions(node, record);
  node.append(
    button("Revise", async () => {
      $("specialist-json").value = JSON.stringify(
        { ...d.definition, id: record.id },
        null,
        2,
      );
      $("specialist-form").closest("details").open = true;
    }),
  );
  if (d.activeVersion)
    node.append(
      button("Use in conversation", async () => {
        displayView("chat");
        $("prompt").value = `Delegate to specialist ${record.id}: `;
        $("prompt").focus();
      }),
    );
  return node;
}
function specialistActions(node, record) {
  node.append(
    button("Evaluate candidate", () =>
      action("specialists.evaluate", { id: record.id }),
    ),
  );
  if (record.data.evaluationPassed)
    node.append(
      button("Activate candidate", () =>
        action("specialists.promote", { id: record.id }),
      ),
    );
  if (record.data.previousActive)
    node.append(
      button("Roll back", () =>
        action("specialists.rollback", { id: record.id }),
      ),
    );
}
function renderSpecialists() {
  list(
    "specialists-list",
    state.specialists,
    specialistCard,
    "Propose a focused assistant and test its work before activation.",
  );
}
function renderProcedures() {
  list(
    "procedures-list",
    state.procedures,
    (record) => {
      const d = record.data,
        node = recordCard(d.definition.name, d.status);
      node.append(
        el(
          "p",
          `Version ${d.version} · ${d.definition.steps.length} steps · ${d.definition.preconditions.length} preconditions`,
        ),
      );
      node.append(
        button("Verify by executing", () =>
          action("procedures.verify", { id: record.id }),
        ),
      );
      if (d.status === "verified")
        node.append(
          button("Replay", () =>
            action("procedures.replay", { id: record.id }),
          ),
        );
      node.append(
        button("Revise", async () => {
          $("procedure-json").value = JSON.stringify(
            { ...d.definition, id: record.id },
            null,
            2,
          );
          $("procedure-form").closest("details").open = true;
        }),
      );
      return node;
    },
    "Turn a repeatable workflow into a recipe with checked results.",
  );
}
function renderSchedules() {
  list(
    "schedules-list",
    state.schedules,
    (record) => {
      const d = record.data,
        node = recordCard(d.prompt, d.status);
      node.append(el("p", `${d.kind} · ${date(d.dueAt)}`));
      if (d.intervalMs)
        node.append(
          el(
            "p",
            `Repeats every ${d.intervalMs / 60000} minutes · ${d.runCount ?? 0} completed executions`,
            "meta",
          ),
        );
      if (["pending", "paused"].includes(d.status))
        node.append(
          button(d.status === "paused" ? "Resume" : "Pause", () =>
            action("schedules.pause", {
              id: record.id,
              paused: d.status !== "paused",
            }),
          ),
        );
      if (d.runId)
        node.append(
          button("View run", async () => {
            displayView("runs");
            await showRun(d.runId);
          }),
        );
      return node;
    },
    "Keep a reminder or task for later.",
  );
}
async function refresh() {
  state = await api("state");
  $("login").hidden = true;
  $("workspace").hidden = false;
  $("lock").hidden = desktop;
  $("connection").textContent = "Connected";
  $("provider").textContent = state.provider;
  if (savedAppearance !== state.preferences.appearance) {
    savedAppearance = state.preferences.appearance;
    applyAppearance(savedAppearance);
  }
  $("context-provider").textContent =
    state.provider === "offline-demo-fixture"
      ? "Offline demonstration"
      : state.provider;
  $("context-runs").textContent = state.runs.filter(
    (run) => run.status === "running",
  ).length;
  $("context-memory").textContent = state.memory.length;
  $("context-tools").textContent = state.tools.length;
  $("demo-notice").hidden = state.provider !== "offline-demo-fixture";
  renderRuns();
  renderMemory();
  renderSpecialists();
  renderProcedures();
  renderSchedules();
}
function message(role, content) {
  const node = el("div", undefined, "message " + role);
  node.append(
    el("small", role === "user" ? "You" : "Branch Agent"),
    document.createTextNode(content),
  );
  $("conversation").append(node);
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  try {
    await refresh();
    sessionStorage.setItem("branch-token", token);
    $("token").value = "";
  } catch (e) {
    toast(e.message);
  }
});
$("lock").addEventListener("click", () => {
  token = "";
  sessionStorage.removeItem("branch-token");
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("lock").hidden = true;
  $("connection").textContent = "Locked";
});
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  if (!sessionId) $("conversation").replaceChildren();
  message("user", prompt);
  $("prompt").value = "";
  $("send").disabled = true;
  try {
    const run = await api("run", {
      prompt,
      ...(sessionId ? { sessionId } : {}),
    });
    sessionId = run.sessionId;
    message("assistant", run.output);
    $("session-label").textContent = run.status + " · conversation saved";
    await refresh();
  } catch (e) {
    message("assistant", e.message);
  } finally {
    $("send").disabled = false;
  }
});
$("new-session").addEventListener("click", () => {
  sessionId = null;
  $("conversation").replaceChildren();
  $("session-label").textContent = "New conversation";
});
$("demo-prompt").addEventListener("click", () => {
  $("prompt").value =
    "Write a greeting to branch-demo.txt, read it, and verify the contents.";
  $("prompt").focus();
});
function form(id, handler) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector("button");
    submit.disabled = true;
    try {
      await handler();
      toast("Saved.");
    } catch (e) {
      toast(e.message);
    } finally {
      submit.disabled = false;
    }
  });
}
form("memory-form", () =>
  action("memory.put", {
    text: $("memory-text").value,
    source: $("memory-source").value,
  }),
);
form("specialist-form", () =>
  action("specialists.propose", JSON.parse($("specialist-json").value)),
);
form("procedure-form", () =>
  action("procedures.propose", JSON.parse($("procedure-json").value)),
);
form("schedule-form", () =>
  action("schedules.create", {
    prompt: $("schedule-prompt").value,
    dueAt: new Date($("schedule-time").value).toISOString(),
    kind: $("schedule-kind").value,
    ...(Number($("schedule-repeat").value)
      ? { intervalMs: Number($("schedule-repeat").value) }
      : {}),
  }),
);
$("specialist-json").value = JSON.stringify(
  {
    name: "Workspace helper",
    instructions: "Write and verify the requested greeting.",
    permissions: ["files.read", "files.write"],
    evaluation: {
      prompt:
        "Write Hello from Branch. followed by a newline to branch-demo.txt and verify it.",
      checks: [{ path: "branch-demo.txt", expected: "Hello from Branch.\n" }],
    },
  },
  null,
  2,
);
$("procedure-json").value = JSON.stringify(
  {
    name: "Write a checked greeting",
    preconditions: [],
    steps: [
      {
        tool: "files.write",
        args: { path: "greeting.txt", content: "Hello" },
        expected: { path: "greeting.txt", bytes: 5 },
      },
      {
        tool: "files.verify",
        args: { path: "greeting.txt", expected: "Hello" },
        expected: { path: "greeting.txt", verified: true },
      },
    ],
  },
  null,
  2,
);
function applyAppearance(value) {
  const theme = value === "daylight" ? "daylight" : "forest";
  document.documentElement.dataset.theme = theme;
  $("appearance").value = theme;
}
applyAppearance("forest");
form("settings-form", async () => {
  const value = await api("preferences", { appearance: $("appearance").value });
  savedAppearance = value.appearance;
  applyAppearance(savedAppearance);
});
$("appearance-shortcut").addEventListener("click", () => {
  displayView("settings");
  if ($("workspace").hidden) toast("Connect to change settings.");
});
if (token || desktop) refresh().catch((e) => toast(e.message));
setInterval(() => {
  if (token || desktop) refresh().catch(() => {});
}, 3000);
