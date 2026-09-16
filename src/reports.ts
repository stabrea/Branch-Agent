import { z } from "zod";
import type { Store } from "./store.js";
import {
  RedactionSchema, pageStyle, redactText, redactionDefaults, type Redaction,
} from "./conversation-share.js";

/**
 * "Save as report": anything the owner has just read — a task, a written-down experiment, an answer
 * out of their own documents — written out in a form they can keep or hand to somebody else.
 *
 * Three forms, one piece of work behind them: Markdown for writing with, a single HTML page that
 * carries its own colours and needs no other file, and the same page laid out for printing, which
 * is how a PDF is made — the browser's own "print to PDF", never a PDF drawn on this computer.
 *
 * The same redaction pass that guards a shared conversation runs over every report, so a key that
 * appeared in a tool result does not leave in a file the owner emails on.
 */
export const reportFormats = ["markdown", "html", "print"] as const;
export type ReportFormat = (typeof reportFormats)[number];

export const ReportSectionSchema = z.object({
  heading: z.string().trim().min(1).max(160),
  body: z.string().max(60_000).default(""),
}).strict();
export const ReportSchema = z.object({
  title: z.string().trim().min(1).max(160),
  /** What this is a report about, in one line, under the title. */
  subtitle: z.string().trim().max(300).default(""),
  sections: z.array(ReportSectionSchema).min(1).max(60),
  format: z.enum(reportFormats).default("markdown"),
  redact: RedactionSchema.default(redactionDefaults),
}).strict();
export type ReportInput = z.infer<typeof ReportSchema>;
export interface Report {
  format: ReportFormat; contentType: string; filename: string; body: string;
  /** What the redaction pass took out, so the owner knows before they send it on. */
  secretsRemoved: number; contactDetailsRemoved: number;
}

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fileName = (title: string, extension: string): string =>
  (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report") + "." + extension;

/** Runs the redaction pass over every section, counting what it took out as it goes. */
function cleaned(input: ReportInput): { sections: { heading: string; body: string }[]; secrets: number; contacts: number } {
  let secrets = 0, contacts = 0;
  const sections = input.sections.map((section) => {
    const heading = redactText(section.heading, input.redact);
    const body = redactText(section.body, input.redact);
    secrets += heading.secrets + body.secrets;
    contacts += heading.contactDetails + body.contactDetails;
    return { heading: heading.text, body: body.text };
  });
  return { sections, secrets, contacts };
}

/** Extra rules that only matter on paper: no dark ground, and a heading never alone at the foot. */
const printStyle = `@media print{
:root{color-scheme:light}
body{background:#fff;color:#111}
main{max-width:none;padding:0}
article{background:#fff;border:1px solid #ccc;break-inside:avoid}
h2{color:#444}
.no-print{display:none}
}
.no-print{margin:0 0 1.5rem}`;

/** The report as one page that carries everything it needs, optionally laid out for printing. */
function reportHtml(input: ReportInput, sections: { heading: string; body: string }[], forPrint: boolean): string {
  const blocks = sections.map((section) =>
    `<article><h2>${escape(section.heading)}</h2><p>${escape(section.body) || "<em>(nothing here)</em>"}</p></article>`).join("\n");
  const printNote = forPrint
    ? `<p class="no-print notice">Use your browser's Print, and choose "Save as PDF" as the printer. Nothing is sent anywhere.</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escape(input.title)}</title>
<style>${pageStyle}
${forPrint ? printStyle : ""}</style></head>
<body><main><h1>${escape(input.title)}</h1>
<p class="meta">${escape(input.subtitle)}${input.subtitle ? " · " : ""}Saved from Branch Agent on ${new Date().toISOString().slice(0, 10)}</p>
${printNote}${blocks}
<footer>A saved report. It carries no script and is not connected to the assistant.</footer>
</main></body></html>\n`;
}

/** The report as Markdown: headings and prose, nothing a reader needs a program to open. */
function reportMarkdown(input: ReportInput, sections: { heading: string; body: string }[]): string {
  const lines = [`# ${input.title}`, ""];
  if (input.subtitle) lines.push(input.subtitle, "");
  lines.push(`_Saved from Branch Agent on ${new Date().toISOString().slice(0, 10)}._`, "");
  for (const section of sections) lines.push(`## ${section.heading}`, "", section.body || "_(nothing here)_", "");
  return lines.join("\n");
}

/** One report in the form that was asked for. */
export function buildReport(input: unknown): Report {
  const wanted = ReportSchema.parse(input);
  const { sections, secrets, contacts } = cleaned(wanted);
  const shared = { secretsRemoved: secrets, contactDetailsRemoved: contacts };
  if (wanted.format === "markdown")
    return { format: "markdown", contentType: "text/markdown; charset=utf-8",
      filename: fileName(wanted.title, "md"), body: reportMarkdown(wanted, sections), ...shared };
  const forPrint = wanted.format === "print";
  return { format: wanted.format, contentType: "text/html; charset=utf-8",
    filename: fileName(wanted.title, forPrint ? "print.html" : "html"),
    body: reportHtml(wanted, sections, forPrint), ...shared };
}

/**
 * One task's whole trajectory as a page: every step it took, what came back, and how long each one
 * ran. The same renderer and the same redaction as any other report, so an episode handed to
 * somebody else has had its keys taken out too.
 */
export function episodeReport(store: Store, owner: string, runId: string, redact?: Redaction): Report {
  const run = store.run(runId);
  if (!run || run.owner !== owner) throw new Error("There is no task with that number");
  const events = store.events(runId);
  const sections = [{
    heading: "What was asked",
    body: `${run.prompt}\n\nHow it ended: ${run.status}\nStarted: ${run.createdAt}\nFinished: ${run.updatedAt}`,
  }];
  let step = 0;
  for (const event of events.slice(0, 400)) {
    step += 1;
    const detail = Object.entries(event.data ?? {})
      .filter(([key]) => !["html", "image", "bytes"].includes(key))
      .map(([key, value]) => `${key}: ${String(value).slice(0, 600)}`).join("\n");
    sections.push({ heading: `Step ${step} — ${event.kind}`, body: detail || "(nothing recorded)" });
  }
  sections.push({ heading: "What it answered", body: run.output || "(no answer)" });
  return buildReport({ title: `Task ${runId.slice(0, 8)}`, subtitle: run.prompt.slice(0, 200),
    sections, format: "html", ...(redact ? { redact } : {}) });
}

/** The routes behind "Save as report". Returns null for any path that is not one of them. */
export async function reportsApi(
  store: Store, owner: string, request: { method?: string | undefined }, path: string,
  body: () => Promise<unknown>,
): Promise<unknown | null> {
  if (path === "/api/reports" && (request.method ?? "GET") === "POST") return buildReport(await body());
  const episode = /^\/api\/reports\/episode\/([a-f0-9-]{36})$/.exec(path);
  if (episode && (request.method ?? "GET") === "GET") return episodeReport(store, owner, episode[1]!);
  return null;
}
