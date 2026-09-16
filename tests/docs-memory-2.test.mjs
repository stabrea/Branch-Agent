import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { createBranch } from "../dist/index.js";
import { readDocument, tryReadDocument, picturesMessage, readableTypes } from "../dist/document-readers.js";
import { pdfText, readContent, parseCmap, unescapeLiteral } from "../dist/document-pdf.js";
import { documentType } from "../dist/document-text.js";

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

const docxFixture = () => zip([["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Holiday plan</w:t></w:r></w:p>
  <w:p><w:r><w:t>We leave on the fifth of June.</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Costs</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>Flights</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>420</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`, true],
  ["word/footnotes.xml", `<w:footnotes xmlns:w="x"><w:footnote w:id="0" w:type="separator"><w:p><w:r><w:t>-</w:t></w:r></w:p></w:footnote>
    <w:footnote w:id="2"><w:p><w:r><w:t>Prices checked in April.</w:t></w:r></w:p></w:footnote></w:footnotes>`, false]]);

const xlsxFixture = () => zip([
  ["xl/workbook.xml", `<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`, false],
  ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`, false],
  ["xl/sharedStrings.xml", `<sst><si><t>Item</t></si><si><t>Total</t></si><si><t>Flights</t></si></sst>`, false],
  ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
    <row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>
    <row><c t="s"><v>2</v></c><c><f>SUM(A1:A2)</f><v>420</v></c></row>
    </sheetData></worksheet>`, true],
  ["xl/worksheets/sheet2.xml", `<worksheet><sheetData><row><c t="inlineStr"><is><t>Booked already</t></is></c></row></sheetData></worksheet>`, false]]);

const pptxFixture = () => zip([
  ["ppt/slides/slide1.xml", `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Quarter review</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>Sales rose by nine per cent.</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`, true],
  ["ppt/notesSlides/notesSlide1.xml", `<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Mention the new shop.</a:t></a:r></a:p></p:notes>`, false],
  ["ppt/slides/slide2.xml", `<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:r><a:t>Thank you</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`, false]]);

const odtFixture = () => zip([["content.xml", `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>
  <text:h text:outline-level="1">Garden notes</text:h>
  <text:p>The apple tree needs pruning.</text:p>
  <table:table table:name="Jobs"><table:table-row><table:table-cell><text:p>Job</text:p></table:table-cell><table:table-cell><text:p>When</text:p></table:table-cell></table:table-row>
  <table:table-row><table:table-cell><text:p>Prune</text:p></table:table-cell><table:table-cell><text:p>March</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body></office:document-content>`, true]]);

const odsFixture = () => zip([["content.xml", `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:spreadsheet>
  <table:table table:name="Hours"><table:table-row><table:table-cell><text:p>Day</text:p></table:table-cell><table:table-cell><text:p>Hours</text:p></table:table-cell></table:table-row>
  <table:table-row><table:table-cell><text:p>Monday</text:p></table:table-cell><table:table-cell><text:p>7</text:p></table:table-cell></table:table-row></table:table>
  </office:spreadsheet></office:body></office:document-content>`, false]]);

const epubFixture = () => zip([
  ["META-INF/container.xml", `<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>`, false],
  ["OEBPS/book.opf", `<package><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`, false],
  ["OEBPS/one.xhtml", `<html><head><title>Beginnings</title></head><body><h1>Beginnings</h1><p>It started in a shed.</p></body></html>`, true],
  ["OEBPS/two.xhtml", `<html><body><h2>Afterwards</h2><p>It ended in a barn.</p></body></html>`, false]]);

const rtfFixture = () => Buffer.from(
  "{\\rtf1\\ansi{\\*\\generator Something}\\b Invoice\\b0\\par Total due: 30 \\'a3\\par}", "latin1");

test("a Word file keeps its headings, its table and its footnotes", () => {
  const read = readDocument(docxFixture(), "plan.docx");
  assert.equal(read.type, "docx");
  assert.match(read.text, /^# Holiday plan/m);
  assert.match(read.text, /^## Costs/m);
  assert.match(read.text, /Item\tPrice/);
  assert.match(read.text, /\[1\] Prices checked in April\./);
  assert.deepEqual(read.tables[0].grid, [["Item", "Price"], ["Flights", "420"]]);
});

test("a spreadsheet comes back sheet by sheet, with what a formula worked out", () => {
  const read = readDocument(xlsxFixture(), "money.xlsx");
  assert.match(read.text, /^## Sheet: Budget/m);
  assert.match(read.text, /^## Sheet: Notes/m);
  assert.match(read.text, /Flights\t420/);
  assert.match(read.text, /Booked already/);
  assert.deepEqual(read.tables.map((table) => table.name), ["Budget", "Notes"]);
});

test("a slide deck gives each slide a title, its words and the speaker's notes", () => {
  const read = readDocument(pptxFixture(), "review.pptx");
  assert.match(read.text, /## Slide 1: Quarter review/);
  assert.match(read.text, /Sales rose by nine per cent\./);
  assert.match(read.text, /Notes: Mention the new shop\./);
  assert.match(read.text, /## Slide 2/);
  assert.equal(read.pages, 2);
});

test("open document text and spreadsheet files are read too", () => {
  const text = readDocument(odtFixture(), "garden.odt");
  assert.match(text.text, /^# Garden notes/m);
  assert.match(text.text, /Prune\tMarch/);
  const sheet = readDocument(odsFixture(), "hours.ods");
  assert.match(sheet.text, /^## Sheet: Hours/m);
  assert.deepEqual(sheet.tables[0].grid, [["Day", "Hours"], ["Monday", "7"]]);
});

test("an e-book is read chapter by chapter, and rich text gives its words", () => {
  const book = readDocument(epubFixture(), "story.epub");
  assert.match(book.text, /## Beginnings[\s\S]*It started in a shed/);
  assert.match(book.text, /## Afterwards[\s\S]*It ended in a barn/);
  const rich = readDocument(rtfFixture(), "invoice.rtf");
  assert.match(rich.text, /Invoice/);
  assert.match(rich.text, /Total due: 30 £/);
  assert.doesNotMatch(rich.text, /generator/);
});

test("every kind the readers claim is one documentType actually names", () => {
  for (const type of readableTypes) assert.equal(documentType(`file.${type === "txt" ? "txt" : type}`), type);
});

// ---------------------------------------------------------------- PDF

/** A PDF built by hand: objects, a page tree and one content stream, optionally compressed. */
function pdf({ content = "BT /F1 12 Tf 72 720 Td (Hello there) Tj ET", compress = false, encrypt = false, extra = "" } = {}) {
  const stream = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const filter = compress ? " /Filter /FlateDecode" : "";
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
  ];
  const head = Buffer.from(`%PDF-1.4\n${objects.join("\n")}\n4 0 obj << /Length ${stream.length}${filter} >>\nstream\n`, "latin1");
  const tail = Buffer.from(`\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n${extra}\n`
    + `trailer << /Root 1 0 R${encrypt ? " /Encrypt 9 0 R" : ""} >>\n%%EOF\n`, "latin1");
  return Buffer.concat([head, stream, tail]);
}

test("a plain PDF gives its words with a page marker", () => {
  const read = readDocument(pdf(), "note.pdf");
  assert.equal(read.type, "pdf");
  assert.match(read.text, /\[\[page 1\]\]/);
  assert.match(read.text, /Hello there/);
  assert.equal(read.pictures, false);
  assert.equal(read.pages, 1);
});

test("a compressed PDF stream is unpacked", () => {
  const read = pdfText(pdf({ compress: true, content: "BT /F1 12 Tf 72 700 Td (Squeezed words) Tj ET" }));
  assert.equal(read.pages.length, 1);
  assert.match(read.pages[0].text, /Squeezed words/);
});

test("lines come back in the order they sit on the page", () => {
  const read = pdfText(pdf({ content: "BT /F1 12 Tf 72 700 Td (second line) Tj 0 40 Td (first line) Tj ET" }));
  assert.deepEqual(read.pages[0].text.split("\n"), ["first line", "second line"]);
});

test("a PDF locked with a password is refused in one plain sentence", () => {
  assert.throws(() => readDocument(pdf({ encrypt: true }), "locked.pdf"), /locked with a password/);
});

test("a PDF that is pictures of text says so instead of pretending", () => {
  const read = readDocument(pdf({ content: "q 200 0 0 100 72 600 cm /Im1 Do Q" }), "scan.pdf");
  assert.equal(read.pictures, true);
  assert.equal(read.text, "");
  assert.ok(read.limits.includes(picturesMessage));
});

test("a stream packed in a way the reader does not unpack is listed, not hidden", () => {
  const bytes = pdf({ content: "BT /F1 12 Tf 72 700 Td (hidden) Tj ET" });
  const swapped = Buffer.from(bytes.toString("latin1").replace("/Length", "/Filter /LZWDecode /Length"), "latin1");
  const read = pdfText(swapped);
  assert.ok(read.limits.some((line) => /LZWDecode/.test(line)), read.limits.join("|"));
});

test("a table that turns numbers into letters is used when the file carries one", () => {
  const map = parseCmap("beginbfchar <0041> <0061> endbfchar beginbfrange <0042> <0043> <0062> endbfrange");
  assert.equal(map.get(0x41), "a");
  assert.equal(map.get(0x43), "c");
  assert.equal(readContent("BT /F1 12 Tf 10 20 Td <00410042> Tj ET", new Map([["F1", map]])), "ab");
});

test("escapes inside a drawn string are turned back into what they stand for", () => {
  assert.equal(unescapeLiteral("a\\(b\\)c"), "a(b)c");
  assert.equal(unescapeLiteral("A\\101"), "AA");
});

test("a file larger than the size cap is refused before it is parsed", () => {
  assert.throws(() => readDocument(Buffer.alloc(2048), "big.pdf", { byteLimit: 1024 }), /MB can be read/);
});

test("a time cap that has already passed is reported rather than hidden", () => {
  const read = readDocument(docxFixture(), "plan.docx", { timeLimitMs: -1 });
  assert.ok(read.limits.some((line) => /longer to read than the time allowed/.test(line)));
});

test("a file no reader can make sense of comes back as a reason, not a crash", () => {
  const result = tryReadDocument(Buffer.from("not a zip at all"), "broken.docx");
  assert.equal(result.document, null);
  assert.match(result.reason, /\w/);
});
