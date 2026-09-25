/**
 * "Save as report": whatever is on the screen — a task, a written-down experiment, an answer out of
 * the owner's own documents — written out as Markdown, as one page that carries its own colours, or
 * laid out for printing, which is how a PDF is made: the browser's own "Save as PDF", never a PDF
 * drawn on this computer. Keys are blanked out of every form before it is written.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};

/**
 * Hands the owner a file without ever putting the report's words into an address, which is where a
 * key would end up in a history if one slipped past the redaction pass.
 */
function handOver(report) {
  const blob = new Blob([report.body], { type: report.contentType });
  const address = URL.createObjectURL(blob);
  const link = el("a");
  link.href = address;
  link.download = report.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(address), 10000);
}

/** The print-ready form opens in a window of its own, where the owner presses Print. */
function openForPrinting(report) {
  /* No "noopener" here: with it the browser hands back null by the spec, and there would be no
     window to write the report into. Nothing written here can script the page it came from —
     every heading and every word of a report is escaped before it leaves the server. */
  const window_ = globalThis.open("", "_blank", "width=900,height=1000");
  if (!window_) throw new Error("Your browser would not open the print view. Allow pop-ups for this page.");
  window_.document.write(report.body);
  window_.document.close();
}

/**
 * Makes one report and does the right thing with it. The sections are given by whoever asks —
 * `saveReport({ title, subtitle, sections })` — so a task, a study and a knowledge answer all use
 * this one path rather than each growing a writer of its own.
 */
export async function saveReport(source, format) {
  const report = await api("reports", { ...source, format });
  if (format === "print") openForPrinting(report); else handOver(report);
  return report;
}

/** One task's whole trajectory as a page, from the record the app already keeps. */
export async function saveEpisode(runId) {
  const report = await api(`reports/episode/${runId}`);
  handOver(report);
  return report;
}

/**
 * The three buttons, wherever they are wanted. `describe()` is called at the moment the owner
 * presses one, so the report is made from what is on the screen then, not from what was there
 * when the buttons were drawn.
 */
export function reportButtons(describe, say = () => {}) {
  const row = el("div", undefined, "report-actions");
  const forms = [
    ["markdown", t("reports.markdown")],
    ["html", t("reports.page")],
    ["print", t("reports.print")],
  ];
  for (const [format, label] of forms) {
    const button = el("button", label, "quiet");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        const report = await saveReport(await describe(), format);
        const removed = report.secretsRemoved + report.contactDetailsRemoved;
        say(removed ? t("reports.blanked", { count: removed }) : t("reports.saved"));
      } catch (error) { say(error.message); }
    });
    row.append(button);
  }
  return row;
}

/* Anything else that wants the buttons — a study, an answer out of the owner's documents — asks
   for them here rather than writing a second copy of them. */
globalThis.branchReports = { reportButtons, saveReport, saveEpisode };

const $ = (id) => document.getElementById(id);
const sayInCard = (message) => { const box = $("report-status"); if (box) box.textContent = message; };

/** A task's state in words (Mac mini's E2 review: the picker read "look around — needs_input"). */
function statusWords(status) {
  const said = t(`reports.status.${status}`);
  return said === `reports.status.${status}` ? String(status).replace(/_/g, " ") : said;
}
/** Fills the "which task" picker from the tasks the app already lists. */
async function fillTasks() {
  const picker = $("report-run");
  if (!picker) return;
  try {
    /* The app's own state already carries the list of tasks; asking again would be a second
       question with the same answer. */
    const { runs } = await api("state");
    picker.replaceChildren();
    for (const run of (runs ?? []).slice(0, 30))
      picker.append(new Option(`${run.prompt.slice(0, 60)} — ${statusWords(run.status)}`, run.id));
    if (!picker.options.length) picker.append(new Option("No tasks yet", ""));
  } catch (error) { sayInCard(error.message); }
}

/** The task the owner picked, as the sections a report is made of. */
async function describeTask() {
  const runId = $("report-run")?.value;
  if (!runId) throw new Error("Run a task first; a report is made out of one.");
  const run = await api(`runs/${runId}`);
  return {
    title: `Task ${runId.slice(0, 8)}`,
    subtitle: run.prompt?.slice(0, 200) ?? "",
    sections: [
      { heading: "What was asked", body: run.prompt ?? "" },
      { heading: "What it answered", body: run.output ?? "" },
      { heading: "How it went", body: `Status: ${run.status}\nStarted: ${run.createdAt}\nFinished: ${run.updatedAt}` },
    ],
  };
}

/* `describe` is called when the button is pressed, so it has to be the function, not its answer. */
function wireButtons() {
  const row = $("report-buttons");
  if (!row || row.childElementCount) return;
  const buttons = reportButtons(describeTask, sayInCard);
  row.replaceChildren(...buttons.childNodes);
  const episode = el("button", t("reports.episode"), "quiet");
  episode.type = "button";
  episode.addEventListener("click", async () => {
    try {
      const runId = $("report-run")?.value;
      if (!runId) throw new Error("Run a task first; a report is made out of one.");
      await saveEpisode(runId);
      sayInCard(t("reports.saved"));
    } catch (error) { sayInCard(error.message); }
  });
  row.append(episode);
}

document.querySelector('[data-view="runs"]')?.addEventListener("click", () => { void fillTasks(); });
wireButtons();
void fillTasks();
