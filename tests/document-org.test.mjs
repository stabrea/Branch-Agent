import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { readDocument, readableTypes } from "../dist/document-readers.js";
import { readOrg } from "../dist/document-org.js";
import { documentType } from "../dist/document-text.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-document-org-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app };
}

// ---------------------------------------------------------------- Org-mode reading

const orgFixture = () => Buffer.from(
  `:PROPERTIES:
:ID: abc-123
:END:
#+TITLE: Trip Notes
#+AUTHOR: Alex
# a comment line, dropped entirely
* TODO [#A] Plan the trip :personal:travel:
Book the [[https://example.com/flights][flights]] before June.
** Costs
The budget is under control.
#+BEGIN_SRC bash
echo "packing list"
#+END_SRC
#+BEGIN_COMMENT
This part should not appear anywhere in the output.
#+END_COMMENT
Final paragraph mentions the orgword marker.
`, "utf8");

test("an Org file is recognized by its extension and readable in the same door as everything else", () => {
  assert.equal(documentType("plan.org"), "org");
  assert.ok(readableTypes.includes("org"));
});

test("an Org headline becomes a heading, with its TODO state, priority and tags stripped", () => {
  const read = readDocument(orgFixture(), "trip.org");
  assert.equal(read.type, "org");
  assert.match(read.text, /^# Trip Notes/m, "the file title becomes the first heading");
  assert.match(read.text, /^# Plan the trip$/m, "TODO, priority cookie and tags are gone from the headline");
  assert.match(read.text, /^## Costs/m, "two stars becomes a level-two heading");
  assert.doesNotMatch(read.text, /TODO|\[#A\]|:personal:|:travel:/, "the headline markup itself is not left behind");
});

test("a property drawer and in-file settings carry no words worth indexing", () => {
  const read = readDocument(orgFixture(), "trip.org");
  assert.doesNotMatch(read.text, /PROPERTIES|:ID:|:END:/, "the drawer is gone, not just its wrapper lines");
  assert.doesNotMatch(read.text, /AUTHOR|Alex/, "an unrelated #+KEYWORD: line is dropped");
  assert.doesNotMatch(read.text, /a comment line, dropped entirely/, "a line-comment is dropped");
});

test("a link becomes its description, and a source block keeps its body without the COMMENT block's", () => {
  const read = readDocument(orgFixture(), "trip.org");
  assert.match(read.text, /Book the flights before June\./, "the link's description replaces the [[target][description]] markup");
  assert.doesNotMatch(read.text, /example\.com/, "the raw link target is not left in the passage text");
  assert.match(read.text, /echo "packing list"/, "a SRC block's body is kept as plain text");
  assert.doesNotMatch(read.text, /BEGIN_SRC|END_SRC/, "the block's own markers are gone");
  assert.doesNotMatch(read.text, /should not appear anywhere/, "a COMMENT block's body is dropped, like a drawer's");
  assert.match(read.text, /Final paragraph mentions the orgword marker\./);
});

test("an Org file with nothing left after stripping its markup is refused, not indexed empty", () => {
  assert.throws(() => readOrg(Buffer.from(":PROPERTIES:\n:ID: 1\n:END:\n#+AUTHOR: nobody\n", "utf8")),
    /no readable text/);
});

// ---------------------------------------------------------------- one fixture, every supported format, with citations

/** A minimal ZIP container, the way Word, spreadsheet, slide and e-book files are packed. */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text, deflated] of entries) {
    const raw = Buffer.from(text, "utf8");
    const body = deflated ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(deflated ? 8 : 0, 10);
    entry.writeUInt32LE(0, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
/** A PDF built by hand: one page, one content stream, no compression. */
function pdf(content) {
  const stream = Buffer.from(content, "latin1");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
  ];
  const head = Buffer.from(`%PDF-1.4\n${objects.join("\n")}\n4 0 obj << /Length ${stream.length} >>\nstream\n`, "latin1");
  const tail = Buffer.from(`\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`
    + `trailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
  return Buffer.concat([head, stream, tail]);
}
const docxBytes = () => zip([["word/document.xml",
  "<w:document><w:body><w:p><w:r><w:t>The docxword marker sits in this Word file.</w:t></w:r></w:p></w:body></w:document>", true]]);
const xlsxBytes = () => zip([
  ["xl/workbook.xml", `<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`, false],
  ["xl/worksheets/sheet1.xml",
    `<worksheet><sheetData><row><c t="inlineStr"><is><t>The xlsxword marker sits in this sheet.</t></is></c></row></sheetData></worksheet>`, false]]);
const pptxBytes = () => zip([["ppt/slides/slide1.xml",
  `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>The pptxword marker sits in this slide.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`, true]]);
const odtBytes = () => zip([["content.xml",
  `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>
  <text:p>The odtword marker sits in this document.</text:p></office:text></office:body></office:document-content>`, true]]);
const odsBytes = () => zip([["content.xml",
  `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:spreadsheet>
  <table:table table:name="Sheet"><table:table-row><table:table-cell><text:p>The odsword marker sits in this sheet.</text:p></table:table-cell></table:table-row></table:table>
  </office:spreadsheet></office:body></office:document-content>`, false]]);
const epubBytes = () => zip([
  ["META-INF/container.xml", `<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>`, false],
  ["OEBPS/book.opf", `<package><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="c1"/></spine></package>`, false],
  ["OEBPS/one.xhtml", `<html><body><h1>Chapter</h1><p>The epubword marker sits in this chapter.</p></body></html>`, true]]);
const rtfBytes = () => Buffer.from("{\\rtf1\\ansi The rtfword marker sits in this rich text file.\\par}", "latin1");
const orgBytes = () => Buffer.from("* Notes\nThe orgword marker sits in this outline.\n", "utf8");

/** One file per supported format, each carrying a word found nowhere else in the library. */
const library = [
  { name: "notes.txt", marker: "txtword", content: "The txtword marker sits in this plain text file." },
  { name: "notes.md", marker: "mdword", content: "# Notes\n\nThe mdword marker sits in this markdown file." },
  { name: "notes.html", marker: "htmlword", content: "<html><body><p>The htmlword marker sits in this web page.</p></body></html>" },
  { name: "notes.csv", marker: "csvword", content: "topic,detail\ncsvword,The csvword marker sits in this spreadsheet row." },
  { name: "notes.json", marker: "jsonword", content: JSON.stringify({ note: "The jsonword marker sits in this JSON file." }) },
  { name: "plan.docx", marker: "docxword", content: docxBytes().toString("base64"), binary: true },
  { name: "money.xlsx", marker: "xlsxword", content: xlsxBytes().toString("base64"), binary: true },
  { name: "review.pptx", marker: "pptxword", content: pptxBytes().toString("base64"), binary: true },
  { name: "garden.odt", marker: "odtword", content: odtBytes().toString("base64"), binary: true },
  { name: "hours.ods", marker: "odsword", content: odsBytes().toString("base64"), binary: true },
  { name: "story.epub", marker: "epubword", content: epubBytes().toString("base64"), binary: true },
  { name: "invoice.rtf", marker: "rtfword", content: rtfBytes().toString("base64"), binary: true },
  { name: "note.pdf", marker: "pdfword",
    content: pdf("BT /F1 12 Tf 72 720 Td (The pdfword marker sits in this page.) Tj ET").toString("base64"), binary: true },
  { name: "trip.org", marker: "orgword", content: orgBytes().toString("base64"), binary: true },
];

test("one library that carries every supported format indexes each of them and cites it back", async (t) => {
  const { app } = await fixture(t);
  for (const file of library) {
    const added = file.binary
      ? await app.documents.add("local", { name: file.name, content: file.content })
      : await app.documents.add("local", { name: file.name, content: Buffer.from(file.content, "utf8").toString("base64") });
    assert.equal(added.status, "indexed", `${file.name} should have indexed cleanly: ${added.note}`);
  }
  assert.equal(app.documents.list("local").length, library.length);

  for (const file of library) {
    const marker = file.marker;
    const found = await app.documents.contextFor("local", `what does the note say about ${marker}`);
    assert.ok(found, `${file.name} (marker ${marker}) should turn up something to cite`);
    assert.match(found.text, new RegExp(marker), `the passage actually carries "${marker}"`);
    const citation = found.citations.find((entry) => entry.title === file.name);
    assert.ok(citation, `${file.name} should be among the numbered sources, got: ${found.citations.map((c) => c.title).join(", ")}`);
    assert.match(citation.url, /^document:/, "a document citation is addressed as document:<id>, never a web address");
    assert.match(found.text, new RegExp(`\\[${citation.number}\\]`), "the numbered marker for that source appears in the passage text");
    assert.match(found.text, new RegExp(`## Sources in your documents[\\s\\S]*${citation.number}\\. ${file.name.replace(/\./g, "\\.")}`),
      "the Sources list at the end names the file under its own number");
  }
});
