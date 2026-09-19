/** Parses simple CSV text (a header line, then rows) into objects. */
export function parseCsv(text) {
  const lines = text.split("\n");
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c].trim();
    rows.push(row);
  }
  return rows;
}
