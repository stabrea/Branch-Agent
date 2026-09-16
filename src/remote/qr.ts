/**
 * A square barcode the phone's camera can read, drawn here rather than fetched from anywhere, so no
 * address and no pairing link ever leaves this computer. It covers what this app needs and no more:
 * plain text up to 271 characters, at the lowest error-correction level, which is ample for a link
 * shown on screen a step away from the camera.
 */
export interface QrMatrix {
  version: number;
  size: number;
  /** modules[row][column]; true is a dark square. */
  modules: boolean[][];
}

/** Error-correction codewords per block, then the blocks themselves, for level L, versions 1 to 10. */
const VERSIONS: { ec: number; blocks: [count: number, data: number][] }[] = [
  { ec: 7, blocks: [[1, 19]] }, { ec: 10, blocks: [[1, 34]] }, { ec: 15, blocks: [[1, 55]] },
  { ec: 20, blocks: [[1, 80]] }, { ec: 26, blocks: [[1, 108]] }, { ec: 18, blocks: [[2, 68]] },
  { ec: 20, blocks: [[2, 78]] }, { ec: 24, blocks: [[2, 97]] }, { ec: 30, blocks: [[2, 116]] },
  { ec: 18, blocks: [[2, 68], [2, 69]] },
];
const ALIGNMENT: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
export const maximumQrBytes = 271;

const dataCodewords = (version: number): number =>
  VERSIONS[version - 1]!.blocks.reduce((total, [count, data]) => total + count * data, 0);
const lengthBits = (version: number): number => (version < 10 ? 8 : 16);
/** How many characters (bytes) fit at this version. */
export function capacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - lengthBits(version)) / 8);
}
function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= VERSIONS.length; version++)
    if (byteLength <= capacity(version)) return version;
  throw new Error(`That link is too long for a scannable code (limit ${maximumQrBytes} characters).`);
}

// --- Reed-Solomon over GF(256), primitive polynomial 0x11D ---
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/** The divisor polynomial, highest power first, with its leading 1 left out as the standard does. */
export function generator(degree: number): number[] {
  const poly = new Array<number>(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = mul(poly[j]!, root);
      if (j + 1 < degree) poly[j] = poly[j]! ^ poly[j + 1]!;
    }
    root = mul(root, 2);
  }
  return poly;
}
/** The error-correction codewords for one block: the remainder of the message divided by the divisor. */
export function remainder(data: number[], degree: number): number[] {
  const gen = generator(degree), out = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift()!;
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] = out[i]! ^ mul(gen[i]!, factor);
  }
  return out;
}

function payloadCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, lengthBits(version));
  for (const byte of bytes) push(byte, 8);
  const total = dataCodewords(version) * 8;
  push(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    words.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/** Splits the message into blocks, adds error correction to each, and shuffles them together. */
function interleave(words: number[], version: number): number[] {
  const { ec, blocks } = VERSIONS[version - 1]!;
  const data: number[][] = [], parity: number[][] = [];
  let offset = 0;
  for (const [count, size] of blocks)
    for (let i = 0; i < count; i++) {
      const block = words.slice(offset, offset + size);
      offset += size;
      data.push(block);
      parity.push(remainder(block, ec));
    }
  const out: number[] = [];
  const longest = Math.max(...data.map((block) => block.length));
  for (let i = 0; i < longest; i++) for (const block of data) if (i < block.length) out.push(block[i]!);
  for (let i = 0; i < ec; i++) for (const block of parity) out.push(block[i]!);
  return out;
}

class Canvas {
  readonly modules: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
}

function drawFinders(canvas: Canvas): void {
  const size = canvas.size;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        canvas.set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
}
function drawAlignment(canvas: Canvas, version: number): void {
  const centres = ALIGNMENT[version - 1]!, last = centres.length - 1;
  for (let i = 0; i <= last; i++)
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          canvas.set(centres[j]! + dx, centres[i]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
}
const bitOf = (value: number, index: number): boolean => ((value >>> index) & 1) === 1;

function drawFormat(canvas: Canvas, mask: number): void {
  const size = canvas.size;
  let rest = (1 << 3) | mask; // error-correction level L is 1
  for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  const bits = ((((1 << 3) | mask) << 10) | rest) ^ 0x5412;
  for (let i = 0; i <= 5; i++) canvas.set(8, i, bitOf(bits, i));
  canvas.set(8, 7, bitOf(bits, 6));
  canvas.set(8, 8, bitOf(bits, 7));
  canvas.set(7, 8, bitOf(bits, 8));
  for (let i = 9; i < 15; i++) canvas.set(14 - i, 8, bitOf(bits, i));
  for (let i = 0; i < 8; i++) canvas.set(size - 1 - i, 8, bitOf(bits, i));
  for (let i = 8; i < 15; i++) canvas.set(8, size - 15 + i, bitOf(bits, i));
  canvas.set(8, size - 8, true);
}
function drawVersion(canvas: Canvas, version: number): void {
  if (version < 7) return;
  let rest = version;
  for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  const bits = (version << 12) | rest;
  for (let i = 0; i < 18; i++) {
    const dark = bitOf(bits, i), a = canvas.size - 11 + (i % 3), b = Math.floor(i / 3);
    canvas.set(a, b, dark);
    canvas.set(b, a, dark);
  }
}
function drawFunctionPatterns(canvas: Canvas, version: number): void {
  for (let i = 0; i < canvas.size; i++) {
    canvas.set(6, i, i % 2 === 0);
    canvas.set(i, 6, i % 2 === 0);
  }
  drawFinders(canvas);
  drawAlignment(canvas, version);
  drawFormat(canvas, 0);
  drawVersion(canvas, version);
}

function drawCodewords(canvas: Canvas, words: number[]): void {
  const size = canvas.size;
  let index = 0, upward = true, row = size - 1;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (;;) {
      for (let step = 0; step < 2; step++) {
        const x = right - step;
        if (canvas.fixed[row]![x]) continue;
        const bit = index < words.length * 8 && ((words[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1;
        canvas.modules[row]![x] = bit;
        index++;
      }
      row += upward ? -1 : 1;
      if (row < 0 || row >= size) { row -= upward ? -1 : 1; upward = !upward; break; }
    }
  }
}

const MASKS: ((row: number, column: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
function applyMask(canvas: Canvas, mask: number): void {
  const test = MASKS[mask]!;
  for (let row = 0; row < canvas.size; row++)
    for (let column = 0; column < canvas.size; column++)
      if (!canvas.fixed[row]![column] && test(row, column))
        canvas.modules[row]![column] = !canvas.modules[row]![column];
}

const FINDER_LIKE = ["10111010000", "00001011101"];
function lineScore(line: boolean[]): number {
  let score = 0, run = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) { run++; continue; }
    if (run >= 5) score += 3 + (run - 5);
    run = 1;
  }
  if (run >= 5) score += 3 + (run - 5);
  const text = line.map((dark) => (dark ? "1" : "0")).join("");
  for (const pattern of FINDER_LIKE)
    for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) score += 40;
  return score;
}
function penalty(canvas: Canvas): number {
  const size = canvas.size;
  let score = 0, dark = 0;
  for (let row = 0; row < size; row++) {
    score += lineScore(canvas.modules[row]!);
    score += lineScore(canvas.modules.map((line) => line[row]!));
    for (let column = 0; column < size; column++) {
      if (canvas.modules[row]![column]) dark++;
      if (row === 0 || column === 0) continue;
      const value = canvas.modules[row]![column];
      if (value === canvas.modules[row - 1]![column] && value === canvas.modules[row]![column - 1] &&
        value === canvas.modules[row - 1]![column - 1]) score += 3;
    }
  }
  const percent = (dark * 100) / (size * size);
  return score + 10 * Math.floor(Math.abs(percent - 50) / 5);
}

/** Builds the barcode for a piece of text, choosing the smallest size and the tidiest pattern. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const words = interleave(payloadCodewords(bytes, version), version);
  let best: Canvas | null = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const canvas = new Canvas(21 + 4 * (version - 1));
    drawFunctionPatterns(canvas, version);
    drawCodewords(canvas, words);
    drawFormat(canvas, mask);
    applyMask(canvas, mask);
    const score = penalty(canvas);
    if (score < bestScore) { bestScore = score; best = canvas; }
  }
  return { version, size: best!.size, modules: best!.modules };
}

/** The barcode as rows of text, for a terminal or a test. */
export function qrText(matrix: QrMatrix): string {
  return matrix.modules.map((row) => row.map((dark) => (dark ? "##" : "  ")).join("")).join("\n");
}
