import { packZip } from "./document-package.js";
import { xmlSafe, type DocBlock } from "./document-write.js";

/**
 * A Word file written from blocks. Word's own parts are all here — the content list, the
 * relationships, the styles the headings point at and the two numbering definitions a bulleted and
 * a numbered list use — so the file opens in Word and Pages exactly as it opens in this build's own
 * reader. Nothing is styled beyond what the blocks ask for: the person's own template is a better
 * place for how a document should look than a guess made here.
 */
const wordNamespace = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const contentTypes =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>';
const rootRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const documentRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>';

/** Heading styles one to six, plus the title and the style a list item carries. */
const headingStyle = (level: number): string =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>`
  + `<w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
  + `<w:rPr><w:b/><w:sz w:val="${Math.max(22, 36 - level * 2)}"/></w:rPr></w:style>`;
const styles =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${wordNamespace}>`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>'
  + [1, 2, 3, 4, 5, 6].map(headingStyle).join("") + "</w:styles>";
/** Two lists: number 1 is bulleted, number 2 is numbered. A block points at one of them. */
const numbering =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${wordNamespace}>`
  + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>'
  + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>'
  + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';

/** One run of words, with tabs and line breaks kept the way the reader expects to find them. */
export function run(text: string): string {
  const parts = xmlSafe(text).split(/(\n|\t)/).map((piece) =>
    piece === "\n" ? "<w:br/>" : piece === "\t" ? "<w:tab/>" : piece ? `<w:t xml:space="preserve">${piece}</w:t>` : "");
  return `<w:r>${parts.join("")}</w:r>`;
}
const paragraph = (text: string, properties = ""): string =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${text ? run(text) : ""}</w:p>`;

/** One block as Word paragraphs. A table becomes a real Word table, cell by cell. */
export function docxBlock(block: DocBlock): string {
  if (block.kind === "heading") return paragraph(block.text, `<w:pStyle w:val="Heading${block.level}"/>`);
  if (block.kind === "paragraph") return block.text.split(/\n{2,}/).map((piece) => paragraph(piece)).join("");
  if (block.kind === "list") {
    const numId = block.ordered ? 2 : 1;
    return block.items.map((item) =>
      paragraph(item, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`)).join("");
  }
  return `<w:tbl><w:tblPr><w:tblBorders>${borders()}</w:tblBorders></w:tblPr>${block.grid.map(tableRow).join("")}</w:tbl>`;
}
const borders = (): string =>
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:color="auto"/>`).join("");
const tableRow = (row: string[]): string =>
  `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`;

/** The document part on its own, so an edit can rebuild it without rebuilding the whole file. */
export function docxBody(blocks: DocBlock[], title = ""): string {
  const parts = title ? [paragraph(title, '<w:pStyle w:val="Title"/>')] : [];
  for (const block of blocks) parts.push(docxBlock(block));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${wordNamespace}><w:body>`
    + `${parts.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
}

/** A complete Word file. Its own reader opens it, and so does Word. */
export function buildDocx(blocks: DocBlock[], title = ""): Buffer {
  return packZip([
    { name: "[Content_Types].xml", body: contentTypes },
    { name: "_rels/.rels", body: rootRels },
    { name: "word/document.xml", body: docxBody(blocks, title) },
    { name: "word/_rels/document.xml.rels", body: documentRels },
    { name: "word/styles.xml", body: styles },
    { name: "word/numbering.xml", body: numbering },
  ]);
}
