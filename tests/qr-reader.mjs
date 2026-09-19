/**
 * An independent reader for the square codes Branch draws, shared by the tests that check a code
 * reads back as the link it was made from (tests/channel-setup.test.mjs, tests/phone-app.test.mjs).
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/** An independent reader for the codes Branch draws (byte mode, level L), used when jsQR is not installed here. */
export function readCode(modules) {
  const size = modules.length, version = (size - 17) / 4;
  // The format bits next to the top-left finder: bit i sits at a fixed place (ISO/IEC 18004, 7.9).
  const places = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  let format = places.reduce((value, [row, column], bit) => value | ((modules[row][column] ? 1 : 0) << bit), 0);
  format ^= 0x5412;
  assert.equal(format >> 13, 1, "error correction level L");
  const mask = (format >> 10) & 7;
  const masks = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  const fixed = functionArea(size, version);
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1])
        if (!fixed[row][column]) bits.push(modules[row][column] !== masks[mask](row, column));
    }
    upward = !upward;
  }
  const blocks = { 1: [[1, 19]], 2: [[1, 34]], 3: [[1, 55]], 4: [[1, 80]], 5: [[1, 108]], 6: [[2, 68]], 7: [[2, 78]], 8: [[2, 97]], 9: [[2, 116]], 10: [[2, 68], [2, 69]] }[version];
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | (b ? 1 : 0), 0));
  const lengths = blocks.flatMap(([count, data]) => Array(count).fill(data));
  const data = lengths.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...lengths); i++) lengths.forEach((length, b) => { if (i < length) data[b].push(words[at++]); });
  const stream = data.flat().flatMap((word) => [...word.toString(2).padStart(8, "0")].map(Number));
  assert.equal(stream.slice(0, 4).join(""), "0100", "byte mode");
  const lengthBits = version < 10 ? 8 : 16;
  const count = parseInt(stream.slice(4, 4 + lengthBits).join(""), 2);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(parseInt(stream.slice(4 + lengthBits + i * 8, 12 + lengthBits + i * 8).join(""), 2));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function functionArea(size, version) {
  const area = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) area[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]])
    for (let r = -1; r <= 8; r++) for (let c = -1; c <= 8; c++) mark(r0 + r, c0 + c);
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  const centres = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version - 1];
  for (const r of centres) for (const c of centres) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
  mark(size - 8, 8);
  return area;
}

export async function jsQr() {
  for (const where of ["jsqr", fileURLToPath(new URL("../apps/mobile/node_modules/jsqr/dist/jsQR.js", import.meta.url))])
    try { return (await import(where)).default; } catch { /* not installed on this computer */ }
  return null;
}
