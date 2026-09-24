import { t } from "./i18n.js";
/**
 * A chart drawn in the page, from a fenced `chart` block in a reply or from a picture the data
 * tools already made. Bars, a line or a pie; the number under the pointer is written out, the same
 * numbers can be shown as a table instead, and the whole thing can be saved as a picture using the
 * browser's own canvas — nothing is drawn on the computer's side and no drawing library is loaded.
 *
 * Every colour comes from the eight series tokens in tokens.css, read off the running page, so a
 * chart follows the theme and no colour is written down here.
 */
const svgNS = "http://www.w3.org/2000/svg";
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const node = (tag, attributes = {}, text) => {
  const made = document.createElementNS(svgNS, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  if (text !== undefined) made.textContent = String(text);
  return made;
};

/** The eight series colours as they stand right now, for drawing and for the saved picture. */
export function seriesColours() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return [1, 2, 3, 4, 5, 6, 7, 8].map((index) => read(`--series-${index}`, read("--accent", "gray")));
}
const themeColour = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** What a `chart` block must say. Anything else is refused plainly rather than half-drawn. */
export function readChart(source) {
  let spec;
  try { spec = typeof source === "string" ? JSON.parse(source) : source; } catch {
    throw new Error("A chart block holds the chart written as JSON.");
  }
  const type = ["bar", "line", "pie"].includes(spec?.type) ? spec.type : "bar";
  const rows = Array.isArray(spec?.data) ? spec.data : [];
  const points = rows
    .map((row) => ({ label: String(row?.label ?? ""), value: Number(row?.value) }))
    .filter((point) => point.label && Number.isFinite(point.value))
    .slice(0, 40);
  if (!points.length) throw new Error("This chart has no numbers to draw.");
  return { type, title: String(spec?.title ?? "Chart").slice(0, 120), points };
}

const size = { width: 720, height: 360, pad: 48 };
const plotTop = 28, plotBottom = size.height - size.pad;

/** A bar, a line point or a pie slice, each one carrying its own number for the pointer. */
function shapes(chart, colours) {
  const { type, points } = chart;
  if (type === "pie") return pieShapes(points, colours);
  const top = Math.max(0, ...points.map((p) => p.value));
  const bottom = Math.min(0, ...points.map((p) => p.value));
  const span = top - bottom || 1;
  const at = (value) => plotBottom - ((value - bottom) / span) * (plotBottom - plotTop);
  const step = (size.width - size.pad * 2) / (type === "line" ? Math.max(1, points.length - 1) : points.length);
  if (type === "line") return lineShapes(points, colours, at, step);
  return points.map((point, index) => {
    const bar = Math.max(6, step * 0.62);
    const x = size.pad + index * step + (step - bar) / 2;
    const y = Math.min(at(0), at(point.value));
    return { kind: "rect", point, colour: colours[index % colours.length],
      attributes: { x: x.toFixed(1), y: y.toFixed(1), width: bar.toFixed(1),
        height: Math.max(1, Math.abs(at(0) - at(point.value))).toFixed(1) },
      labelAt: [x + bar / 2, plotBottom + 16] };
  });
}
function lineShapes(points, colours, at, step) {
  return points.map((point, index) => ({
    kind: "circle", point, colour: colours[0],
    attributes: { cx: (size.pad + index * step).toFixed(1), cy: at(point.value).toFixed(1), r: 5 },
    labelAt: [size.pad + index * step, plotBottom + 16],
  }));
}
function pieShapes(points, colours) {
  const total = points.reduce((sum, point) => sum + Math.abs(point.value), 0) || 1;
  const cx = size.width / 2, cy = size.height / 2, r = Math.min(cx, cy) - 40;
  let from = -Math.PI / 2;
  return points.map((point, index) => {
    const sweep = (Math.abs(point.value) / total) * Math.PI * 2;
    const to = from + sweep;
    const path = `M ${cx} ${cy} L ${(cx + r * Math.cos(from)).toFixed(1)} ${(cy + r * Math.sin(from)).toFixed(1)} `
      + `A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${(cx + r * Math.cos(to)).toFixed(1)} ${(cy + r * Math.sin(to)).toFixed(1)} Z`;
    const mid = from + sweep / 2;
    from = to;
    return { kind: "path", point, colour: colours[index % colours.length], attributes: { d: path },
      labelAt: [cx + (r + 16) * Math.cos(mid), cy + (r + 16) * Math.sin(mid)] };
  });
}

/** The picture itself, with a title on it and a place for the number under the pointer. */
function chartSvg(chart, colours, say) {
  const svg = node("svg", { viewBox: `0 0 ${size.width} ${size.height}`, width: "100%",
    role: "img", preserveAspectRatio: "xMidYMid meet", "aria-label": `${chart.title}: ${chart.points.length} values` });
  svg.classList.add("chart-svg");
  const ink = themeColour("--text", "black"), quiet = themeColour("--muted", "gray");
  svg.append(node("rect", { width: size.width, height: size.height, fill: themeColour("--surface", "white") }));
  svg.append(node("text", { x: size.pad, y: 20, "font-size": 15, fill: ink }, chart.title));
  if (chart.type !== "pie")
    svg.append(node("line", { x1: size.pad, y1: plotBottom, x2: size.width - size.pad, y2: plotBottom,
      stroke: themeColour("--line-strong", "gray") }));
  const drawn = shapes(chart, colours);
  if (chart.type === "line" && drawn.length > 1)
    svg.append(node("path", { fill: "none", stroke: colours[0], "stroke-width": 2,
      d: drawn.map((s, i) => `${i ? "L" : "M"}${s.attributes.cx},${s.attributes.cy}`).join(" ") }));
  for (const shape of drawn) {
    const drawnShape = node(shape.kind, { ...shape.attributes, fill: shape.colour,
      ...(shape.kind === "circle" ? { stroke: shape.colour } : {}) });
    drawnShape.append(node("title", {}, `${shape.point.label}: ${shape.point.value}`));
    /* The pointer writes the number out in words under the chart, for anyone who cannot hover. */
    drawnShape.addEventListener("pointerenter", () => say(`${shape.point.label}: ${shape.point.value}`));
    drawnShape.addEventListener("pointerleave", () => say(""));
    svg.append(drawnShape);
    svg.append(node("text", { x: shape.labelAt[0].toFixed(1), y: shape.labelAt[1].toFixed(1),
      "text-anchor": "middle", "font-size": 11, fill: quiet }, shape.point.label.slice(0, 14)));
  }
  return svg;
}

/** The same numbers written out, for reading rather than looking. */
function chartTable(chart) {
  const scroll = el("div", undefined, "md-table-scroll");
  const table = el("table", undefined, "md-table");
  const head = el("thead"), headRow = el("tr");
  headRow.append(el("th", "Name"), el("th", "Value"));
  head.append(headRow);
  const body = el("tbody");
  for (const point of chart.points) {
    const row = el("tr");
    row.append(el("td", point.label), el("td", point.value));
    body.append(row);
  }
  table.append(head, body);
  scroll.append(table);
  return scroll;
}

/**
 * Saves the chart as a PNG using the page's own canvas. The drawing travels as a `data:` address
 * rather than a blob or a link to somewhere else, because a canvas that has been given anything
 * from another place refuses to hand its picture back.
 */
export async function chartPng(svg) {
  const source = new XMLSerializer().serializeToString(svg);
  const encoded = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(source)));
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error("The chart could not be turned into a picture.")), { once: true });
    image.src = encoded;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size.width * 2;
  canvas.height = size.height * 2;
  const pen = canvas.getContext("2d");
  pen.fillStyle = themeColour("--surface", "white");
  pen.fillRect(0, 0, canvas.width, canvas.height);
  pen.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** The whole chart: the picture, the number under the pointer, a table toggle and "save a picture". */
export function drawChart(source) {
  const chart = readChart(source);
  const wrap = el("div", undefined, "chart");
  const reading = el("p", "", "meta chart-reading");
  reading.setAttribute("aria-live", "polite");
  const svg = chartSvg(chart, seriesColours(), (text) => { reading.textContent = text; });
  const figure = el("div", undefined, "chart-figure");
  figure.append(svg);
  const table = chartTable(chart);
  table.hidden = true;
  const row = el("div", undefined, "chart-actions");
  const toggle = el("button", t("charts.action.showNumbers"), "quiet");
  toggle.dataset.t = "charts.action.showNumbers";
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    table.hidden = !table.hidden;
    // The key changes with the state, so a later language change writes the right one.
    toggle.dataset.t = table.hidden ? "charts.action.showNumbers" : "charts.action.chartOnly";
    toggle.textContent = t(toggle.dataset.t);
    toggle.setAttribute("aria-expanded", String(!table.hidden));
  });
  const save = el("button", t("charts.action.savePicture"), "quiet");
  save.dataset.t = "charts.action.savePicture";
  save.type = "button";
  save.addEventListener("click", async () => {
    try {
      const png = await chartPng(svg);
      const link = el("a", "");
      link.href = png;
      link.download = `${chart.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "chart"}.png`;
      link.click();
      reading.textContent = t("charts.status.savedPicture");
    } catch (error) { reading.textContent = error.message; }
  });
  row.append(toggle, save);
  wrap.append(figure, reading, row, table);
  return wrap;
}
