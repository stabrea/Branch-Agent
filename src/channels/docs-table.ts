import { channelCatalog, type ChannelCatalog } from "./catalog.js";

/**
 * The Connections table in `docs/configuration.md` is written from `data/channels.json` rather
 * than by hand, so a service can never be listed as doing something its row does not say it does.
 * The markers below bound the generated part; everything outside them is ordinary prose.
 */
export const tableStart = "<!-- channels-table:start -->";
export const tableEnd = "<!-- channels-table:end -->";

const yes = (value: boolean) => (value ? "yes" : "no");

/** The table and the setup notes, exactly as they appear in the documentation. */
export function renderChannelTable(catalog: ChannelCatalog = channelCatalog()): string {
  const rows = catalog.services.map((entry) => [
    `[${entry.name}](${entry.docs})`,
    "yes",
    yes(entry.can.files),
    yes(entry.can.voiceIn),
    yes(entry.can.voiceOut),
    yes(entry.can.buttons),
    entry.receive ? "yes" : "send only",
    String(entry.maxTextLength),
  ].join(" | "));
  const notes = catalog.services.map((entry) =>
    `- **${entry.name}** (\`${entry.id}\`) — ${entry.note} You need: ${entry.needs.map((need) => need.replace(/\.$/, "")).join("; ")}.`);
  return [
    tableStart,
    "",
    "| Service | Text | Files | Voice in | Voice out | Buttons | Can reply to you | Longest message |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
    "",
    ...notes,
    "",
    tableEnd,
  ].join("\n");
}

/** Where the generated part of a document starts and ends, or a plain complaint that it has none. */
function bounds(document: string): [number, number] {
  const from = document.indexOf(tableStart), to = document.indexOf(tableEnd);
  if (from < 0 || to < from) throw new Error("The Connections table markers are missing from that document");
  return [from, to + tableEnd.length];
}
const crlf = "\r\n";
/**
 * Puts a freshly rendered table into a document, leaving everything around it untouched. The
 * document keeps whichever line endings it already had, so regenerating changes nothing else.
 */
export function replaceChannelTable(document: string, table = renderChannelTable()): string {
  const [from, to] = bounds(document);
  const written = document.includes(crlf) ? table.split("\n").join(crlf) : table;
  return document.slice(0, from) + written + document.slice(to);
}
/** The generated part of a document as it stands, for checking it is still up to date. */
export function currentChannelTable(document: string): string {
  const [from, to] = bounds(document);
  return document.slice(from, to).split(crlf).join("\n");
}
