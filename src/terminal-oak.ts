import type { Canvas, Paint } from "./terminal-canvas.js";
import type { Glyphs } from "./terminal-style.js";

/**
 * The oak on an empty conversation: one tree on a low hill, dressed for the season, drawn in half
 * cells so it has twice the height of the text around it. Like `public/grove.js` it takes every
 * colour from the theme — the ground, the text, the accent and the "good" green — and steps between
 * two of them with the usual 4×4 ordered dither.
 */
export type Season = "spring" | "summer" | "autumn" | "winter";
/** The season of a date, as the window's oak picks it. */
export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  return month >= 2 && month <= 4 ? "spring" : month <= 7 && month >= 5 ? "summer" : month >= 8 && month <= 10 ? "autumn" : "winter";
}

const ORDER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const threshold = (x: number, y: number): number => (ORDER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16;
const LEAVES: Record<Season, [Paint, Paint]> = {
  spring: [{ from: "ok", to: "text", amount: 0.3 }, { from: "accent", to: "text", amount: 0.55 }],
  summer: [{ from: "ok", to: "ground", amount: 0.25 }, "ok"],
  autumn: [{ from: "accent", to: "ground", amount: 0.2 }, { from: "accent", to: "warn", amount: 0.5 }],
  winter: [{ from: "text", to: "ground", amount: 0.35 }, "text"],
};
interface Shape { w: number; h: number; cx: number; hill: (x: number) => number }

/** One pixel of the picture, or null where the sky (the theme's ground) shows through. */
function pixel(shape: Shape, season: Season, x: number, y: number): Paint | null {
  const { w, h, cx } = shape;
  if (y >= shape.hill(x)) return threshold(x, y) < 0.35 ? { from: "ok", to: "ground", amount: 0.45 } : { from: "ok", to: "ground", amount: 0.6 };
  const canopyY = h * 0.36, rx = w * 0.3, ry = h * 0.27;
  const lobes: [number, number, number][] = [[cx, canopyY, 1], [cx - rx * 0.55, canopyY + ry * 0.25, 0.7], [cx + rx * 0.55, canopyY + ry * 0.2, 0.72]];
  const inside = lobes.some(([lx, ly, scale]) => ((x - lx) / (rx * scale)) ** 2 + ((y - ly) / (ry * scale)) ** 2 <= 1);
  const bare = season === "winter" && threshold(x, y) > 0.55;
  if (inside && !bare) {
    const light = Math.max(0, Math.min(1, 0.55 - (x - cx) / (rx * 3) - (y - canopyY) / (ry * 2.5)));
    return LEAVES[season][threshold(x, y) < light ? 1 : 0];
  }
  const trunk = Math.max(1, Math.round(w * 0.045));
  const flare = y > shape.hill(x) - 3 ? 1 : 0;
  if (y > canopyY && Math.abs(x - cx) <= trunk + flare) return { from: "accent", to: "ground", amount: 0.62 };
  const moon = { x: w * 0.86, y: h * 0.14, r: Math.max(1.5, h * 0.07) };
  if ((x - moon.x) ** 2 + (y - moon.y) ** 2 <= moon.r ** 2) return { from: "text", to: "ground", amount: 0.15 };
  return null;
}

/** Draws the oak into a box of character cells; nothing at all when half blocks cannot be shown. */
export function drawOak(canvas: Canvas, box: { x: number; y: number; width: number; height: number }, season: Season, glyphs: Glyphs): void {
  if (!glyphs.upper) return;
  const w = box.width, h = box.height * 2, cx = w / 2;
  const hill = (x: number): number => Math.round(h - 1 - h * 0.16 * Math.max(0, 1 - ((x - cx) / (w * 0.55)) ** 2));
  const shape: Shape = { w, h, cx, hill };
  for (let row = 0; row < box.height; row++)
    for (let column = 0; column < w; column++) {
      const top = pixel(shape, season, column, row * 2), bottom = pixel(shape, season, column, row * 2 + 1);
      if (!top && !bottom) continue;
      canvas.halfBlock(box.x + column, box.y + row, top ?? "ground", bottom ?? "ground", glyphs.upper);
    }
}
