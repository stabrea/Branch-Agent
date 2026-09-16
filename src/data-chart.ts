import { z } from "zod";
import type { Cell, DataTable } from "./data-table.js";

/**
 * A simple picture of a table — bars, a line, or a pie — drawn as an SVG file so it can be kept
 * beside the task and opened in any browser. Nothing is downloaded and no drawing library is used:
 * the shapes are written out directly, with the colours already used elsewhere in the app.
 */
export const ChartSpecSchema = z.object({
  type: z.enum(["bar", "line", "pie"]),
  /** The column whose values name each bar, point or slice. */
  label: z.string().trim().min(1).max(60),
  /** The column holding the numbers being drawn. */
  value: z.string().trim().min(1).max(60),
  title: z.string().trim().max(120).optional(),
  /** How many rows to draw; the rest are left out and the picture says so. */
  limit: z.number().int().min(1).max(40).default(12),
}).strict();
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

const palette = ["#b5651d", "#4f7942", "#8c6a4a", "#5b6c7d", "#2f3640", "#a0522d", "#6b8e23", "#7d6b5b"];
const width = 720, height = 400, padding = 56;
const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (value: Cell): string => {
  const text = String(value ?? "");
  return escape(text.length > 18 ? `${text.slice(0, 17)}…` : text);
};

interface Point { label: Cell; value: number }
/** The rows a chart will draw, refusing plainly when a column is missing or holds no numbers. */
export function chartPoints(table: DataTable, spec: ChartSpec): Point[] {
  const labelAt = table.columns.findIndex((column) => column.name.toLowerCase() === spec.label.toLowerCase());
  const valueAt = table.columns.findIndex((column) => column.name.toLowerCase() === spec.value.toLowerCase());
  if (labelAt < 0) throw new Error(`This table has no column called "${spec.label}"`);
  if (valueAt < 0) throw new Error(`This table has no column called "${spec.value}"`);
  const points = table.rows
    .map((row) => ({ label: row[labelAt] ?? "", value: Number(row[valueAt]) }))
    .filter((point) => Number.isFinite(point.value))
    .slice(0, spec.limit);
  if (!points.length) throw new Error(`The "${spec.value}" column has no numbers to draw`);
  return points;
}

/** The whole picture as SVG text, ready to be saved beside the task. */
export function chartSvg(table: DataTable, spec: ChartSpec): string {
  const points = chartPoints(table, spec);
  const title = spec.title ?? `${spec.value} by ${spec.label}`;
  const body = spec.type === "pie" ? pieBody(points) : spec.type === "line" ? lineBody(points) : barBody(points);
  const note = table.rows.length > points.length
    ? `<text x="${width - padding}" y="${height - 8}" text-anchor="end" font-size="11" fill="#6b6b6b">Showing ${points.length} of ${table.rows.length} rows</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(title)}">` +
    `<rect width="${width}" height="${height}" fill="#fdfbf7"/>` +
    `<text x="${padding}" y="30" font-family="system-ui, sans-serif" font-size="17" fill="#2f3640">${escape(title)}</text>` +
    `<g font-family="system-ui, sans-serif" font-size="11" fill="#2f3640">${body}${note}</g></svg>`;
}

const plotTop = 52, plotBottom = height - padding;
/** A shared vertical scale: bars and lines both start at zero so heights can be compared honestly. */
function scale(points: Point[]): (value: number) => number {
  const top = Math.max(0, ...points.map((point) => point.value));
  const bottom = Math.min(0, ...points.map((point) => point.value));
  const span = top - bottom || 1;
  return (value) => plotBottom - ((value - bottom) / span) * (plotBottom - plotTop);
}
function axis(points: Point[]): string {
  const y = scale(points)(0);
  return `<line x1="${padding}" y1="${plotTop}" x2="${padding}" y2="${plotBottom}" stroke="#d9d2c6"/>` +
    `<line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="#d9d2c6"/>`;
}
function barBody(points: Point[]): string {
  const at = scale(points), zero = at(0);
  const step = (width - padding * 2) / points.length, bar = Math.max(6, step * 0.62);
  const bars = points.map((point, index) => {
    const x = padding + index * step + (step - bar) / 2, y = Math.min(zero, at(point.value));
    const tall = Math.max(1, Math.abs(zero - at(point.value)));
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bar.toFixed(1)}" height="${tall.toFixed(1)}" fill="${palette[index % palette.length]}"/>` +
      `<text x="${(x + bar / 2).toFixed(1)}" y="${(plotBottom + 16).toFixed(1)}" text-anchor="middle">${short(point.label)}</text>`;
  });
  return axis(points) + bars.join("");
}
function lineBody(points: Point[]): string {
  const at = scale(points);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const coordinates = points.map((point, index) => [padding + index * step, at(point.value)] as const);
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const dots = coordinates.map(([x, y], index) =>
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${palette[0]}"/>` +
    `<text x="${x.toFixed(1)}" y="${(plotBottom + 16).toFixed(1)}" text-anchor="middle">${short(points[index]!.label)}</text>`);
  return axis(points) + `<path d="${path}" fill="none" stroke="${palette[0]}" stroke-width="2.5"/>` + dots.join("");
}
function pieBody(points: Point[]): string {
  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  if (total <= 0) throw new Error("A pie needs values above zero to divide up");
  const cx = 250, cy = 220, r = 130;
  let angle = -Math.PI / 2;
  const slices = points.map((point, index) => {
    const sweep = (Math.max(0, point.value) / total) * Math.PI * 2, end = angle + sweep;
    const [x1, y1] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    const [x2, y2] = [cx + r * Math.cos(end), cy + r * Math.sin(end)];
    angle = end;
    const path = `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${sweep > Math.PI ? 1 : 0},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${palette[index % palette.length]}"/>`;
    const key = `<rect x="470" y="${72 + index * 22}" width="12" height="12" fill="${palette[index % palette.length]}"/>` +
      `<text x="490" y="${82 + index * 22}">${short(point.label)} — ${Math.round((Math.max(0, point.value) / total) * 100)}%</text>`;
    return path + key;
  });
  return slices.join("");
}
