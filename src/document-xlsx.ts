import { packZip } from "./document-package.js";
import { numberFormats, xmlSafe, type NumberFormat, type SheetCell, type SheetSpec } from "./document-write.js";

/**
 * A spreadsheet written from sheets of cells. Figures stay figures, so the person can add them up;
 * words stay words. A cell the assistant worked out can be written as the sum it stands for, with
 * the answer it reached beside it — the spreadsheet shows the answer straight away and recalculates
 * it the moment the person changes a figure, which is what makes the file worth having over a
 * picture of one.
 */
const spreadsheetNamespace = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

/** The shapes figures are shown in, in the order a sheet's `formats` list names them. */
const formatStyle: Record<NumberFormat, number> = { plain: 0, number: 1, money: 2, percent: 3, date: 4 };
/** The heading row is bold; it is the last style in the list below. */
const headingStyle = 5;
const styles =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${spreadsheetNamespace}>`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>'
  + '<cellXfs count="6"><xf numFmtId="0" fontId="0" xfId="0"/><xf numFmtId="2" fontId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="14" fontId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/></cellXfs>'
  + "</styleSheet>";

/** The letter of a column, counting from A, the way a spreadsheet names them. */
export function columnName(index: number): string {
  let name = "";
  for (let at = index; at >= 0; at = Math.floor(at / 26) - 1) name = String.fromCharCode(65 + (at % 26)) + name;
  return name;
}

/** One cell. A formula keeps what it says and the value it last came to, so both survive a save. */
export function cellXml(value: SheetCell, reference: string, style: number): string {
  const attributes = `r="${reference}"${style ? ` s="${style}"` : ""}`;
  if (value === null || value === "") return `<c ${attributes}/>`;
  if (typeof value === "object")
    return `<c ${attributes}><f>${xmlSafe(value.formula.replace(/^=/, ""))}</f><v>${xmlSafe(String(value.value))}</v></c>`;
  if (typeof value === "number") return `<c ${attributes}><v>${Number.isFinite(value) ? value : 0}</v></c>`;
  if (typeof value === "boolean") return `<c ${attributes} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${xmlSafe(value)}</t></is></c>`;
}

/** One sheet of cells, with the heading row bold and each column in the shape it was asked for. */
export function sheetXml(sheet: SheetSpec): string {
  const rows = sheet.rows.map((cells, rowAt) => {
    const heading = sheet.headings && rowAt === 0;
    const written = cells.map((value, columnAt) =>
      cellXml(value, `${columnName(columnAt)}${rowAt + 1}`, heading ? headingStyle : styleFor(sheet, columnAt)));
    return `<row r="${rowAt + 1}">${written.join("")}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${spreadsheetNamespace}>`
    + `<sheetData>${rows.join("")}</sheetData></worksheet>`;
}
function styleFor(sheet: SheetSpec, column: number): number {
  const asked = sheet.formats[column];
  return asked && (numberFormats as readonly string[]).includes(asked) ? formatStyle[asked] : 0;
}

/** A complete spreadsheet file, one part per sheet, in the order the sheets were given. */
export function buildXlsx(sheets: SheetSpec[]): Buffer {
  const usable = sheets.length ? sheets : [{ name: "Sheet1", rows: [], table: "", headings: true, formats: [] }];
  return packZip([
    { name: "[Content_Types].xml", body: contentTypes(usable.length) },
    { name: "_rels/.rels", body: rootRels },
    { name: "xl/workbook.xml", body: workbookXml(usable) },
    { name: "xl/_rels/workbook.xml.rels", body: workbookRels(usable.length) },
    { name: "xl/styles.xml", body: styles },
    ...usable.map((sheet, at) => ({ name: `xl/worksheets/sheet${at + 1}.xml`, body: sheetXml(sheet) })),
  ]);
}
function contentTypes(count: number): string {
  const sheets = Array.from({ length: count }, (_value, at) =>
    `<Override PartName="/xl/worksheets/sheet${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + `${sheets.join("")}</Types>`;
}
const rootRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
export function workbookXml(sheets: { name: string }[]): string {
  const listed = sheets.map((sheet, at) =>
    `<sheet name="${xmlSafe(sheet.name.slice(0, 31))}" sheetId="${at + 1}" r:id="rId${at + 1}"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${spreadsheetNamespace} `
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${listed.join("")}</sheets></workbook>`;
}
export function workbookRels(count: number): string {
  const sheets = Array.from({ length: count }, (_value, at) =>
    `<Relationship Id="rId${at + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${at + 1}.xml"/>`);
  const styleId = count + 1;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `${sheets.join("")}<Relationship Id="rId${styleId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}
