/* phase2/delight: a small 3D drawer, written by hand in WebGL (no library), for the 3D look of the acorn
   and the pet and for a 3D object behind the glass. The shapes are built here from spheres, cones and
   rings and coloured from the theme's own tokens; a .glb file of the owner's own is read here too
   (its meshes and base colours; textures are not drawn). Real models can replace the stand-ins later
   without changing anything else. Nothing is fetched from anywhere. */

const root = document.documentElement;
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
/** A token as [r, g, b] from 0 to 1. */
export function tone(name, fallback = "transparent") {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((v) => v / 255);
}
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

/* ---------- shapes ---------- */
/** An ellipsoid (or part of one, `upTo` of the way from the top) as positions, normals and indices:
    `seg` slices around it and `rows` from top to bottom; `flat` draws each face with one shade. */
export function ellipsoid([cx, cy, cz], [rx, ry, rz], color, { seg = 16, rows = seg, upTo = 1, flat = false } = {}) {
  const positions = [], normals = [], indices = [], rings = Math.max(2, Math.round(rows * upTo));
  for (let i = 0; i <= rings; i++) {
    const v = (i / rows) * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
    for (let j = 0; j <= seg; j++) {
      const u = (j / seg) * Math.PI * 2, nx = sv * Math.cos(u), ny = cv, nz = sv * Math.sin(u);
      positions.push(cx + rx * nx, cy + ry * ny, cz + rz * nz);
      const n = [nx / rx, ny / ry, nz / rz], len = Math.hypot(...n) || 1;
      normals.push(n[0] / len, n[1] / len, n[2] / len);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions, normals, indices, color, flat };
}
/** A cone or a cylinder along y, from `bottom` to `top`, with the two radii given. */
export function cone([cx, cy, cz], height, r0, r1, color, seg = 12, { flat = false } = {}) {
  const positions = [], normals = [], indices = [], slope = (r0 - r1) / height;
  for (let i = 0; i <= 1; i++) for (let j = 0; j <= seg; j++) {
    const u = (j / seg) * Math.PI * 2, r = i ? r1 : r0, c = Math.cos(u), s = Math.sin(u);
    positions.push(cx + r * c, cy + i * height, cz + r * s);
    const len = Math.hypot(1, slope);
    normals.push(c / len, slope / len, s / len);
  }
  for (let j = 0; j < seg; j++) indices.push(j, j + seg + 1, j + 1, j + seg + 1, j + seg + 2, j + 1);
  return { positions, normals, indices, color, flat };
}
/** A ring standing up and facing the viewer (a snail's shell is one of these): `seg` steps around the
    ring and `sides` around its tube. */
export function torus([cx, cy, cz], radius, tube, color, seg = 18, sides = seg, { flat = false } = {}) {
  const positions = [], normals = [], indices = [];
  for (let i = 0; i <= seg; i++) for (let j = 0; j <= sides; j++) {
    const u = (i / seg) * Math.PI * 2, v = (j / sides) * Math.PI * 2;
    const nx = Math.cos(v) * Math.cos(u), ny = Math.cos(v) * Math.sin(u), nz = Math.sin(v);
    positions.push(cx + (radius + tube * Math.cos(v)) * Math.cos(u), cy + (radius + tube * Math.cos(v)) * Math.sin(u), cz + tube * nz);
    normals.push(nx, ny, nz);
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
    const a = i * (sides + 1) + j, b = a + sides + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions, normals, indices, color, flat };
}

/* ---------- the stand-ins ----------
   DG-138: the approved sample's procedural shapes, part for part: its sizes, segment counts and flat
   (faceted) faces, moved down so the point its camera looks at is the middle here. */
export function acornModel() {
  const lift = -0.1;
  return [
    ellipsoid([0, lift, 0], [0.5, 0.625, 0.5], tone("--model-acorn-nut"), { seg: 14, rows: 10 }),
    ellipsoid([0, 0.2 + lift, 0], [0.55, 0.385, 0.55], tone("--model-acorn-cap"), { seg: 12, rows: 12, upTo: 0.5, flat: true }),
    cone([0, 0.72 - 0.15 + lift, 0], 0.3, 0.07, 0.05, tone("--model-acorn-stem"), 6, { flat: true }),
  ];
}
export function oakModel() {
  const green = tone("--ok", "#2e7d4f"), text = tone("--text", "#23343e"), copper = tone("--copper", "#b8562e");
  const bark = mix(text, copper, 0.35), leaf = mix(green, [1, 1, 1], 0.1), deep = mix(green, text, 0.25);
  return [
    cone([0, -1.2, 0], 1.6, 0.28, 0.18, bark),
    ellipsoid([0, 0.75, 0], [1.1, 0.8, 1.1], leaf, { seg: 10 }),
    ellipsoid([-0.75, 0.35, 0.2], [0.7, 0.55, 0.7], deep, { seg: 9 }),
    ellipsoid([0.8, 0.4, -0.1], [0.72, 0.58, 0.72], deep, { seg: 9 }),
    ellipsoid([0.1, 1.25, -0.2], [0.65, 0.5, 0.65], leaf, { seg: 9 }),
  ];
}
/** A cone the way the sample places one: centred on its point, not standing on it. */
const centredCone = ([x, y, z], radius, height, color, seg) => cone([x, y - height / 2, z], height, radius, 0, color, seg, { flat: true });
export function petModel(kind) {
  const known = ["squirrel", "owl", "hedgehog", "fox", "robin", "rabbit", "snail", "fawn"].includes(kind) ? kind : "squirrel";
  const coat = tone(`--model-${known}`), belly = tone(`--model-${known}-belly`), eye = tone("--model-eye"), lift = -0.8;
  const rabbit = known === "rabbit", flat = true;
  const parts = [
    ellipsoid([0, 0.55 + lift, 0], [0.55, 0.495, 0.6325], coat, { seg: 12, rows: 9, flat }),
    ellipsoid([0, 1.15 + lift, 0.35], [0.38, 0.38, 0.38], coat, { seg: 12, rows: 9, flat }),
    ellipsoid([0, 0.5 + lift, 0.42], [0.36, 0.36, 0.18], belly, { seg: 10, rows: 8, flat }),
  ];
  for (const s of [-1, 1]) {
    parts.push(centredCone([s * 0.2, (rabbit ? 1.7 : 1.5) + lift, 0.3], rabbit ? 0.1 : 0.12, rabbit ? 0.6 : 0.28, coat, 5));
    parts.push(ellipsoid([s * 0.15, 1.22 + lift, 0.68], [0.05, 0.05, 0.05], eye, { seg: 6, rows: 5 }));
  }
  if (known === "squirrel" || known === "fox") parts.push(ellipsoid([0, 1 + lift, -0.7], [0.245, 0.49, 0.245], coat, { seg: 9, rows: 7, flat }));
  if (known === "snail") parts.push(torus([0, 0.9 + lift, -0.2], 0.35, 0.18, belly, 14, 8, { flat }));
  return parts;
}

/* ---------- a little matrix arithmetic (column-major, as WebGL reads it) ---------- */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function turn(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1], rx = [1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1];
  return multiply(rx, ry);
}
const moved = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/* ---------- drawing ---------- */
const VERTEX = `attribute vec3 p; attribute vec3 n; attribute vec3 c; uniform mat4 mvp; uniform mat4 rot; varying vec3 vn; varying vec3 vc;
void main() { vn = (rot * vec4(n, 0.0)).xyz; vc = c; gl_Position = mvp * vec4(p, 1.0); }`;
/* DG-138: the sample's light: a sky-and-ground light (the theme's surface, whitened, above; its accent
   below) and a warm sun from the upper right, then shown in screen colour (gamma 2.2). */
const FRAGMENT = `precision mediump float; varying vec3 vn; varying vec3 vc; uniform vec3 light; uniform vec3 sky; uniform vec3 ground; uniform vec3 sun;
void main() { vec3 N = normalize(vn); float d = max(dot(N, light), 0.0); vec3 hemi = mix(ground, sky, 0.5 + 0.5 * N.y);
  vec3 lit = vc * (0.9 * hemi + 0.9 * sun * d); gl_FragColor = vec4(pow(clamp(lit, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0); }`;
const SUN = [3, 5, 4].map((v) => v / Math.hypot(3, 5, 4));
/** The light's colours from the theme, read again whenever the parts are (a theme change). */
const lights = () => ({ sky: mix(tone("--surface"), [1, 1, 1], 0.5), ground: tone("--copper"), sun: tone("--model-sun") });
function program(gl) {
  const make = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("3D could not start here.");
  return p;
}
/** All the parts in one set of buffers: position, normal and colour for each corner. Copied value by
    value, never spread into push, which a big model overflows (integration review). */
function merge(parts) {
  parts = parts.map((part) => (part.flat ? faceted(part) : part));
  const corners = parts.reduce((n, part) => n + part.positions.length, 0), count = parts.reduce((n, part) => n + part.indices.length, 0);
  const pos = new Float32Array(corners), nor = new Float32Array(corners), col = new Float32Array(corners), idx = new Uint32Array(count);
  let at = 0, i = 0;
  for (const part of parts) {
    const base = at / 3;
    pos.set(part.positions, at);
    nor.set(part.normals, at);
    for (let k = 0; k < part.positions.length; k++) col[at + k] = part.color[k % 3] ?? 0.8;
    for (const index of part.indices) idx[i++] = base + index;
    at += part.positions.length;
  }
  return { pos, nor, col, idx };
}
/** A part with one shade per face (the sample's flat shading): each triangle gets its own three corners,
    all with the face's normal, turned outward the way the part's own normals point. */
function faceted(part) {
  const { positions: p, normals: n, indices } = part, positions = [], normals = [], out = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => i * 3);
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    let f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...f);
    if (len < 1e-9) continue; // a face with no area (the poles) adds nothing
    const along = [0, 1, 2].reduce((sum, k) => sum + f[k] * (n[a + k] + n[b + k] + n[c + k]), 0);
    f = f.map((x) => (x / len) * (along < 0 ? -1 : 1));
    for (const i of [a, b, c]) { out.push(positions.length / 3); positions.push(p[i], p[i + 1], p[i + 2]); normals.push(...f); }
  }
  return { positions, normals, indices: out, color: part.color };
}
function upload(gl, prog, parts) {
  const data = merge(parts);
  for (const [name, values] of [["p", data.pos], ["n", data.nor], ["c", data.col]]) {
    const buffer = gl.createBuffer(), at = gl.getAttribLocation(prog, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 3, gl.FLOAT, false, 0, 0);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
  return data.idx.length;
}
/**
 * A turning 3D view on a canvas. `still()` says whether it may move on its own; dragging turns it
 * either way. Returns null where WebGL is not available, so the caller keeps the pixel look.
 */
export function view3d(canvas, parts, { distance = 3.2, still = () => false, spin = 0.0006, fov = 0.7, yaw: startYaw = 0.6, pitch: startPitch = 0.18 } = {}) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, preserveDrawingBuffer: true })
    ?? canvas.getContext("webgl", { alpha: true, antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  if (!(globalThis.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext) && !gl.getExtension("OES_element_index_uint")) return null;
  let prog, count;
  try {
    prog = program(gl);
    gl.useProgram(prog);
    count = upload(gl, prog, parts);
  } catch { return null; } // no 3D here: the caller keeps the pixel look
  let yaw = startYaw, pitch = startPitch, frame = 0, last = 0, drag = null, light = lights();
  const where = (name) => gl.getUniformLocation(prog, name);
  function draw() {
    const w = canvas.width = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, 2)));
    const h = canvas.height = Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio || 1, 2)));
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const rot = turn(yaw, pitch);
    gl.uniformMatrix4fv(where("mvp"), false, multiply(perspective(fov, w / h, 0.1, 50), multiply(moved(0, 0, -distance), rot)));
    gl.uniformMatrix4fv(where("rot"), false, rot);
    gl.uniform3fv(where("light"), SUN);
    for (const name of ["sky", "ground", "sun"]) gl.uniform3fv(where(name), light[name]);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
  }
  function tick(now) {
    frame = 0;
    if (!canvas.isConnected || document.hidden || still()) return;
    if (!drag) yaw += Math.min(100, last ? now - last : 16) * spin;
    last = now;
    draw();
    frame = requestAnimationFrame(tick);
  }
  canvas.addEventListener("pointerdown", (event) => { drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag) return;
    yaw += (event.clientX - drag.x) * 0.012;
    pitch = Math.max(-0.8, Math.min(0.8, pitch + (event.clientY - drag.y) * 0.008));
    drag = { x: event.clientX, y: event.clientY };
    draw();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, () => { drag = null; });
  const api = {
    draw,
    start() { if (!frame) { last = 0; frame = requestAnimationFrame(tick); } draw(); },
    stop() { cancelAnimationFrame(frame); frame = 0; },
    setParts(next) { count = upload(gl, prog, next); light = lights(); draw(); },
  };
  api.start();
  return api;
}

/* ---------- the owner's own .glb ---------- */
/* The file comes from anywhere, so nothing in it is trusted (integration review): every length, offset,
   count and index is checked against the file before it is used, the node tree is walked without
   recursion and each node at most once (a loop or a shared branch cannot grow it), and the whole model
   has a size limit. A damaged or hostile file is refused in plain words; it never hangs the window. */
export const GLB_LIMITS = { bytes: 5 * 1024 * 1024, corners: 300_000, indices: 900_000, parts: 10_000, nodes: 4096 };
const GLB_WORDS = {
  notGlb: "That is not a .glb 3D model.",
  tooBig: "That model is bigger than {limit} MB.",
  noShapes: "That .glb has no shapes Branch can read.",
  compressed: "That model is compressed in a way Branch cannot read yet. Export it without compression.",
  packed: "That model is packed in a way Branch cannot read yet.",
  broken: "That .glb is damaged: part of it points outside the file.",
  tooDetailed: "That model is too detailed to turn smoothly here. Choose one with fewer than {limit} corners.",
};
/** A refusal with its words' key, so the window can say it in its own language. */
export class GlbError extends Error {
  constructor(what, values) {
    super(GLB_WORDS[what].replace(/\{(\w+)\}/g, (whole, name) => String(values?.[name] ?? whole)));
    this.key = `delight.glb.${what}`;
    this.values = values;
  }
}
const refuse = (what, values) => { throw new GlbError(what, values); };
const tooDetailed = () => refuse("tooDetailed", { limit: GLB_LIMITS.corners.toLocaleString() });
const isCount = (n) => Number.isInteger(n) && n >= 0;
const item = (list, index) => (Array.isArray(list) && isCount(index) ? list[index] : undefined);
const numbers = (value, length) => (Array.isArray(value) && value.length === length && value.every(Number.isFinite) ? value : null);
const IDENTITY = moved(0, 0, 0);

/** The JSON and the binary chunk, each checked to lie inside the file. */
function unpack(buffer) {
  const data = new DataView(buffer);
  if (buffer.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67) refuse("notGlb");
  if (data.getUint32(4, true) !== 2) refuse("packed");
  const end = Math.min(buffer.byteLength, data.getUint32(8, true));
  let at = 12, json = null, bin = null;
  while (at + 8 <= end) {
    const length = data.getUint32(at, true), type = data.getUint32(at + 4, true);
    if (at + 8 + length > end) refuse("broken");
    if (type === 0x4e4f534a && !json) json = new Uint8Array(buffer, at + 8, length);
    if (type === 0x004e4942 && !bin) bin = buffer.slice(at + 8, at + 8 + length);
    at += 8 + length;
  }
  if (!json || !bin) refuse("noShapes");
  let gltf = null;
  try { gltf = JSON.parse(new TextDecoder().decode(json)); } catch { refuse("broken"); }
  if (!gltf || typeof gltf !== "object" || Array.isArray(gltf)) refuse("broken");
  return { gltf, bin };
}
const COMPONENTS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC3: 3 };
/** One accessor's values, copied out of the binary chunk after its whole range is checked. */
function accessor(gltf, bin, index, types, width) {
  const a = item(gltf.accessors, index), view = a && item(gltf.bufferViews, a.bufferView);
  const Kind = a && types.includes(a.componentType) ? COMPONENTS[a.componentType] : undefined;
  if (!a || !view || !Kind || WIDTH[a.type] !== width || a.sparse || (view.buffer ?? 0) !== 0) refuse("packed");
  const size = Kind.BYTES_PER_ELEMENT * width, start = view.byteOffset ?? 0, offset = a.byteOffset ?? 0;
  if (view.byteStride !== undefined && view.byteStride !== size) refuse("packed");
  if (![start, view.byteLength, offset, a.count].every(isCount)) refuse("broken");
  if (start + view.byteLength > bin.byteLength || offset + a.count * size > view.byteLength) refuse("broken");
  return new Kind(bin.slice(start + offset, start + offset + a.count * size));
}
/** A node's own placing: its matrix, or its move, turn and size. */
function local(node) {
  if (node.matrix !== undefined) return numbers(node.matrix, 16) ?? IDENTITY;
  const [x, y, z, w] = numbers(node.rotation, 4) ?? [0, 0, 0, 1], [sx, sy, sz] = numbers(node.scale, 3) ?? [1, 1, 1];
  const [tx, ty, tz] = numbers(node.translation, 3) ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
const apply = (m, [x, y, z], w = 1) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
function faceNormals(positions, indices) {
  const normals = new Array(positions.length).fill(0), p = (k, d) => positions[k * 3 + d];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    const u = [0, 1, 2].map((d) => p(b, d) - p(a, d)), v = [0, 1, 2].map((d) => p(c, d) - p(a, d));
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [a, b, c]) for (let d = 0; d < 3; d++) normals[k * 3 + d] += n[d];
  }
  for (let i = 0; i < normals.length; i += 3) { const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1; for (let d = 0; d < 3; d++) normals[i + d] /= len; }
  return normals;
}
/** Whole triangles only, and every corner they name must exist. */
function triangles(list, corners) {
  const out = Array.from(list.subarray(0, list.length - (list.length % 3)));
  if (out.some((index) => index >= corners)) refuse("broken");
  return out;
}
function placedNormals(gltf, bin, primitive, matrix, corners) {
  const n = accessor(gltf, bin, primitive.attributes.NORMAL, [5126], 3), normals = [];
  if (n.length !== corners * 3) refuse("broken");
  for (let i = 0; i < n.length; i += 3) { const t = apply(matrix, [n[i], n[i + 1], n[i + 2]], 0), len = Math.hypot(...t) || 1; normals.push(t[0] / len, t[1] / len, t[2] / len); }
  return normals;
}
function primitivePart(gltf, bin, primitive, matrix, budget) {
  const raw = accessor(gltf, bin, primitive.attributes.POSITION, [5126], 3), corners = raw.length / 3, positions = [];
  if ((budget.corners += corners) > GLB_LIMITS.corners || ++budget.parts > GLB_LIMITS.parts) tooDetailed();
  for (let i = 0; i < raw.length; i += 3) positions.push(...apply(matrix, [raw[i], raw[i + 1], raw[i + 2]]));
  if (!positions.every(Number.isFinite)) refuse("broken");
  const indices = primitive.indices === undefined
    ? Array.from({ length: corners - (corners % 3) }, (_, i) => i)
    : triangles(accessor(gltf, bin, primitive.indices, [5121, 5123, 5125], 1), corners);
  if ((budget.indices += indices.length) > GLB_LIMITS.indices) tooDetailed();
  const normals = primitive.attributes.NORMAL === undefined ? faceNormals(positions, indices) : placedNormals(gltf, bin, primitive, matrix, corners);
  const factor = numbers(item(gltf.materials, primitive.material)?.pbrMetallicRoughness?.baseColorFactor, 4);
  return { positions, normals, indices, color: factor ? factor.slice(0, 3).map((v) => Math.min(1, Math.max(0, v))) : [0.8, 0.8, 0.8] };
}
/** The scene's own top nodes; without a scene, every node that is nobody's child. */
function rootsOf(gltf) {
  const scene = item(gltf.scenes, gltf.scene ?? 0);
  if (Array.isArray(scene?.nodes)) return scene.nodes;
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const children = new Set(nodes.flatMap((node) => (Array.isArray(node?.children) ? node.children : [])));
  return nodes.map((_, i) => i).filter((i) => !children.has(i));
}
/** Every node once, parents before children, with a list instead of recursion. */
function walkNodes(gltf, bin) {
  const parts = [], seen = new Set(), budget = { corners: 0, indices: 0, parts: 0 };
  const roots = rootsOf(gltf);
  if (roots.length > GLB_LIMITS.nodes) tooDetailed();
  const stack = roots.map((index) => ({ index, matrix: IDENTITY }));
  while (stack.length) {
    const { index, matrix } = stack.pop(), node = item(gltf.nodes, index);
    if (!node || typeof node !== "object" || seen.has(index)) continue;
    if (seen.add(index).size > GLB_LIMITS.nodes) tooDetailed();
    const placed = multiply(matrix, local(node)), mesh = item(gltf.meshes, node.mesh);
    for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : [])
      if (primitive && (primitive.mode ?? 4) === 4 && primitive.attributes?.POSITION !== undefined) parts.push(primitivePart(gltf, bin, primitive, placed, budget));
    if (Array.isArray(node.children)) for (const child of node.children) stack.push({ index: child, matrix: placed });
  }
  return parts;
}
/** Centred and sized to fit the view, whatever units the model was made in. */
function fitted(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let i = 0; i < part.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], part.positions[i]); hi[i % 3] = Math.max(hi[i % 3], part.positions[i]); }
  const middle = lo.map((v, i) => (v + hi[i]) / 2), size = Math.max(...hi.map((v, i) => v - lo[i])) || 1;
  for (const part of parts) part.positions = part.positions.map((v, i) => ((v - middle[i % 3]) * 1.9) / size);
  return parts;
}
/** The shapes in a .glb file, with its own colours. Throws a GlbError, in plain words, for what it cannot read. */
export function readGlb(buffer) {
  if (!(buffer instanceof ArrayBuffer)) refuse("notGlb");
  if (buffer.byteLength > GLB_LIMITS.bytes) refuse("tooBig", { limit: GLB_LIMITS.bytes / 1048576 });
  const { gltf, bin } = unpack(buffer);
  if (gltf.extensionsRequired !== undefined && (!Array.isArray(gltf.extensionsRequired) || gltf.extensionsRequired.length)) refuse("compressed");
  const parts = walkNodes(gltf, bin);
  if (!parts.length) refuse("noShapes");
  return fitted(parts);
}
