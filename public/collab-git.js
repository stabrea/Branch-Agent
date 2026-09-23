// Git activity: a patch and its repository's status, published as one signed collaboration event
// (src/collab-events.ts) and searchable by repository or by a word. Split out of collab.js so the
// two files, worked on at the same time, do not collide line for line.
import { t } from "./i18n.js"; // relative, so a test can import this file too; the same /i18n.js in the page
import { section, empty, smallButton, onClick } from "./collab.js";

/** `projects` is the owner's own list (empty under somebody else's profile, same as Projects). */
export function gitSection(projects, helpers) {
  const { el, api, toast } = helpers;
  const wrap = section(helpers, t("collab.git.title"), t("collab.git.description"));
  if (!projects.length) return empty(helpers, wrap, t("collab.git.no-projects"));

  const repository = el("select");
  repository.setAttribute("aria-label", t("collab.git.repository-label"));
  for (const project of projects) repository.appendChild(new Option(project.name, project.id));

  const summary = el("p", "", "collab-meta");
  const title = el("input"); title.maxLength = 200; title.placeholder = t("collab.git.title-placeholder");
  title.setAttribute("aria-label", t("collab.git.title-label"));
  const patch = el("textarea"); patch.rows = 6; patch.maxLength = 60000; patch.placeholder = t("collab.git.patch-placeholder");
  patch.setAttribute("aria-label", t("collab.git.patch-label"));
  let status = null; // the branch/head/clean/changed just read, exactly what would be signed

  const publish = smallButton(helpers, t("collab.git.publish"), async () => {
    if (!status) throw new Error(t("collab.git.status-unavailable"));
    await api("/api/collab/git-patches", { repository: repository.value, title: title.value.trim() || repository.value, patch: patch.value, status });
    title.value = ""; patch.value = ""; status = null; summary.textContent = "";
    toast(t("collab.git.published"));
    await runSearch();
  });
  const load = smallButton(helpers, t("collab.git.load-status"), async () => {
    const read = await api(`/api/collab/git-status?repository=${encodeURIComponent(repository.value)}`);
    if (read.error) { status = null; summary.textContent = ""; throw new Error(read.error); }
    status = read.status;
    patch.value = read.patch;
    summary.textContent = `${read.status.branch}@${read.status.head.slice(0, 7)} · ${read.status.clean ? t("collab.git.clean") : t("collab.git.changed", { count: read.status.changed.length })}`;
    toast(t("collab.git.status-loaded", { branch: read.status.branch }));
  });
  // A repository picked again, or typed over by hand, no longer matches what "Read its current
  // status" last found; publishing again needs a fresh read (or a status of its own — see below).
  repository.addEventListener("change", () => { status = null; summary.textContent = ""; });

  const form = el("div", undefined, "collab-row");
  form.append(repository, load, title, publish);
  wrap.appendChild(form);
  wrap.appendChild(summary);
  wrap.appendChild(patch);

  const query = el("input"); query.maxLength = 200; query.placeholder = t("collab.git.search-placeholder");
  query.setAttribute("aria-label", t("collab.git.search-placeholder"));
  const scope = el("select");
  scope.appendChild(new Option(t("collab.git.all-repositories"), ""));
  for (const project of projects) scope.appendChild(new Option(project.name, project.id));
  const results = el("div");
  async function runSearch() {
    const params = new URLSearchParams({ kind: "git.patch" });
    if (scope.value) params.set("repository", scope.value);
    if (query.value.trim()) params.set("q", query.value.trim());
    const found = await api(`/api/collab/events?${params}`);
    results.replaceChildren();
    if (!found.events.length) { empty(helpers, results, t("collab.git.no-results")); return; }
    for (const event of found.events) {
      const project = projects.find((candidate) => candidate.id === event.payload.repository);
      const card = el("div", undefined, "collab-card");
      card.appendChild(el("strong", event.payload.title));
      const meta = [project?.name ?? event.payload.repository, `${event.payload.status.branch}@${event.payload.status.head.slice(0, 7)}`,
        event.payload.status.clean ? t("collab.git.clean") : t("collab.git.changed", { count: event.payload.status.changed.length }),
        new Date(event.at).toLocaleString()].join(" · ");
      card.appendChild(el("p", meta, "collab-meta"));
      results.appendChild(card);
    }
  }
  const search = onClick(helpers, el("button", t("collab.git.search"), "collab-btn-small"), runSearch);
  const searchRow = el("div", undefined, "collab-row");
  searchRow.append(scope, query, search);
  wrap.appendChild(searchRow);
  wrap.appendChild(results);
  empty(helpers, results, t("collab.git.empty"));
  return wrap;
}
