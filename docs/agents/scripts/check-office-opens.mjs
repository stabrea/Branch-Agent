// Writes one Word, one Excel and one PowerPoint file with Branch's own writers, so that
// check-office-opens.ps1 can open each in the real application and prove it loads. The unit tests
// only prove Branch's own readers get the expected structure back, which is not the same thing:
// a package can satisfy our reader and still be refused by Word. Run this before shipping a change
// to any of the three writers. Requires Office on the machine; the PowerShell script opens each
// application with Visible = false and quits it, so no window appears.
import { writeFile, mkdir } from "node:fs/promises";
const W = "C:/Users/bishi/Documents/Codex/Branch-build";
const { buildDocx } = await import(`file:///${W}/dist/document-docx.js`);
const { buildXlsx } = await import(`file:///${W}/dist/document-xlsx.js`);
const { buildPptx } = await import(`file:///${W}/dist/document-pptx.js`);
const out = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/office-check";
await mkdir(out, { recursive: true });

await writeFile(`${out}/check.docx`, Buffer.from(buildDocx([
  { kind: "heading", level: 1, text: "Quarterly note" },
  { kind: "paragraph", text: "Written by Branch Agent with no extra software installed." },
  { kind: "list", ordered: true, items: ["First point", "Second point"] },
  { kind: "table", name: "", grid: [["Region", "Sales"], ["North", "120"], ["South", "98"]] },
], "Branch Agent check")));

await writeFile(`${out}/check.xlsx`, Buffer.from(buildXlsx([
  { name: "Sales", rows: [["Region", "Amount"], ["North", 120], ["Total", { formula: "SUM(B2:B2)", value: 120 }]],
    table: "", headings: true, formats: ["plain", "money"] },
])));

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
await writeFile(`${out}/check.pptx`, Buffer.from(buildPptx([
  { title: "Branch Agent", bullets: ["Opens in PowerPoint", "No extra software"], picture: "", notes: "Say hello." },
  { title: "Second slide", bullets: ["One", "Two"], picture: "c.png", notes: "" },
], new Map([["c.png", png]]))));
console.log("wrote three files to", out);
process.exit(0);
