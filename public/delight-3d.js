/* phase2/delight: a small 3D drawer, written by hand in WebGL (no library), for the 3D look of the acorn
   and the pet and for a 3D object behind the glass. The shapes are built here from spheres, cones and
   rings and coloured from the theme's own tokens; a .glb file of the owner's own is read here too
   (its meshes and base colours; textures are not drawn). Real models can replace the stand-ins later
   without changing anything else. Nothing is fetched from anywhere. */

const root = document.documentElement;
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
/** A token as [r, g, b] from 0 to 1. */
export function tone(name, fallback) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((v) => v / 255);
}
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

/* ---------- shapes ---------- */
/** An ellipsoid (or part of one, `upTo` of the way from the top) as positions, normals and indices. */
export function ellipsoid([cx, cy, cz], [rx, ry, rz], color, { seg = 16, upTo = 1 } = {}) {
  const positions = [], normals = [], indices = [], rings = Math.max(2, Math.round(seg * upTo));
  for (let i = 0; i <= rings; i++) {
    const v = (i / seg) * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
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
  return { positions, normals, indices, color };
}
/** A cone or a cylinder along y, from `bottom` to `top`, with the two radii given. */
export function cone([cx, cy, cz], height, r0, r1, color, seg = 12) {
  const positions = [], normals = [], indices = [], slope = (r0 - r1) / height;
  for (let i = 0; i <= 1; i++) for (let j = 0; j <= seg; j++) {
    const u = (j / seg) * Math.PI * 2, r = i ? r1 : r0, c = Math.cos(u), s = Math.sin(u);
    positions.push(cx + r * c, cy + i * height, cz + r * s);
    const len = Math.hypot(1, slope);
    normals.push(c / len, slope / len, s / len);
  }
  for (let j = 0; j < seg; j++) indices.push(j, j + seg + 1, j + 1, j + seg + 1, j + seg + 2, j + 1);
  return { positions, normals, indices, color };
}
/** A ring lying flat (a snail's shell turned on its side is one of these). */
export function torus([cx, cy, cz], radius, tube, color, seg = 18) {
  const positions = [], normals = [], indices = [];
  for (let i = 0; i <= seg; i++) for (let j = 0; j <= seg; j++) {
    const u = (i / seg) * Math.PI * 2, v = (j / seg) * Math.PI * 2;
    const nx = Math.cos(v) * Math.cos(u), ny = Math.sin(v), nz = Math.cos(v) * Math.sin(u);
    positions.push(cx + (radius + tube * Math.cos(v)) * Math.cos(u), cy + tube * ny, cz + (radius + tube * Math.cos(v)) * Math.sin(u));
    normals.push(nx, ny, nz);
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions, normals, indices, color };
}

/* ---------- the stand-ins ---------- */
export function acornModel() {
  const copper = tone("--copper", "#b8562e"), text = tone("--text", "#23343e"), ground = tone("--ground", "#eaf0f2");
  const nut = mix(copper, [0.95, 0.75, 0.45], 0.35), cap = mix(text, copper, 0.3), stem = mix(text, ground, 0.2);
  return [
    ellipsoid([0, -0.18, 0], [0.5, 0.62, 0.5], nut, { seg: 22 }),
    ellipsoid([0, 0.18, 0], [0.58, 0.34, 0.58], cap, { seg: 18, upTo: 0.55 }),
    cone([0, 0.44, 0], 0.26, 0.07, 0.05, stem),
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
const PET_SHAPE = {
  squirrel: { tail: true }, fox: { tail: true, ears: 0.3 }, rabbit: { ears: 0.6 }, owl: { ears: 0.18 },
  hedgehog: { spikes: true }, robin: { beak: true }, snail: { shell: true }, fawn: { ears: 0.25, legs: true },
};
export function petModel(kind) {
  const text = tone("--text", "#23343e"), ground = tone("--ground", "#eaf0f2"), copper = tone("--copper", "#b8562e");
  const fur = kind === "fox" || kind === "robin" ? mix(copper, text, 0.15) : mix(text, ground, 0.35), light = mix(ground, [1, 1, 1], 0.4);
  const eye = mix(text, [0, 0, 0], 0.5), shape = PET_SHAPE[kind] ?? {};
  const parts = [ellipsoid([0, -0.25, 0], [0.5, 0.45, 0.55], fur), ellipsoid([0, 0.35, 0.25], [0.34, 0.32, 0.32], fur),
    ellipsoid([0, -0.25, 0.32], [0.32, 0.3, 0.2], light), ellipsoid([-0.13, 0.42, 0.53], [0.05, 0.06, 0.04], eye), ellipsoid([0.13, 0.42, 0.53], [0.05, 0.06, 0.04], eye)];
  if (shape.ears) for (const s of [-1, 1]) parts.push(cone([s * 0.17, 0.55, 0.2], shape.ears, 0.09, 0.02, fur));
  if (shape.tail) parts.push(ellipsoid([0, 0.1, -0.6], [0.25, 0.55, 0.22], fur));
  if (shape.beak) parts.push(cone([0, 0.3, 0.55], 0.14, 0.06, 0.0, copper));
  if (shape.shell) parts.push(torus([0, 0.05, -0.2], 0.3, 0.18, mix(copper, light, 0.3)));
  if (shape.spikes) parts.push(ellipsoid([0, -0.1, -0.1], [0.56, 0.5, 0.6], mix(text, copper, 0.3), { seg: 7 }));
  if (shape.legs) for (const s of [-1, 1]) parts.push(cone([s * 0.22, -1.05, 0.1], 0.6, 0.06, 0.06, fur));
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
const FRAGMENT = `precision mediump float; varying vec3 vn; varying vec3 vc; uniform vec3 light;
void main() { vec3 N = normalize(vn); float d = max(dot(N, light), 0.0); float sky = 0.5 + 0.5 * N.y;
  gl_FragColor = vec4(vc * (0.32 + 0.22 * sky + 0.62 * d), 1.0); }`;
function program(gl) {
  const make = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("3D could not start here.");
  return p;
}
/** All the parts in one set of buffers: position, normal and colour for each corner. */
function merge(parts) {
  const pos = [], nor = [], col = [], idx = [];
  for (const part of parts) {
    const base = pos.length / 3;
    pos.push(...part.positions);
    nor.push(...part.normals);
    for (let i = 0; i < part.positions.length / 3; i++) col.push(...part.color);
    for (const i of part.indices) idx.push(base + i);
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), col: new Float32Array(col), idx: new Uint32Array(idx) };
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
export function view3d(canvas, parts, { distance = 3.2, still = () => false, spin = 0.0006 } = {}) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, preserveDrawingBuffer: true })
    ?? canvas.getContext("webgl", { alpha: true, antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  if (!(globalThis.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext) && !gl.getExtension("OES_element_index_uint")) return null;
  const prog = program(gl);
  gl.useProgram(prog);
  let count = upload(gl, prog, parts), yaw = 0.6, pitch = 0.18, frame = 0, last = 0, drag = null;
  const where = (name) => gl.getUniformLocation(prog, name);
  function draw() {
    const w = canvas.width = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, 2)));
    const h = canvas.height = Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio || 1, 2)));
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const rot = turn(yaw, pitch);
    gl.uniformMatrix4fv(where("mvp"), false, multiply(perspective(0.7, w / h, 0.1, 50), multiply(moved(0, 0, -distance), rot)));
    gl.uniformMatrix4fv(where("rot"), false, rot);
    gl.uniform3fv(where("light"), [-0.45, 0.7, 0.55].map((v) => v / Math.hypot(-0.45, 0.7, 0.55)));
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
    setParts(next) { count = upload(gl, prog, next); draw(); },
  };
  api.start();
  return api;
}

/* ---------- the owner's own .glb ---------- */
const COMPONENTS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function accessor(gltf, bin, index) {
  const a = gltf.accessors?.[index], view = a && gltf.bufferViews?.[a.bufferView ?? -1];
  const Kind = a && COMPONENTS[a.componentType];
  if (!a || !view || !Kind || view.byteStride) throw new Error("That model is packed in a way Branch cannot read yet.");
  return new Kind(bin, (view.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * (WIDTH[a.type] ?? 1));
}
/** A node's own placing: its matrix, or its move, turn and size. */
function local(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1], [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
const apply = (m, [x, y, z], w = 1) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
function faceNormals(positions, indices) {
  const normals = new Array(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map((k) => positions.slice(k * 3, k * 3 + 3));
    const u = b.map((v, k) => v - a[k]), v = c.map((w, k) => w - a[k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [indices[i], indices[i + 1], indices[i + 2]]) for (let d = 0; d < 3; d++) normals[k * 3 + d] += n[d];
  }
  for (let i = 0; i < normals.length; i += 3) { const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1; for (let d = 0; d < 3; d++) normals[i + d] /= len; }
  return normals;
}
function primitivePart(gltf, bin, primitive, matrix) {
  const raw = accessor(gltf, bin, primitive.attributes.POSITION), positions = [];
  for (let i = 0; i < raw.length; i += 3) positions.push(...apply(matrix, [raw[i], raw[i + 1], raw[i + 2]]));
  const indices = primitive.indices === undefined ? [...Array(positions.length / 3).keys()] : [...accessor(gltf, bin, primitive.indices)];
  let normals;
  if (primitive.attributes.NORMAL === undefined) normals = faceNormals(positions, indices);
  else {
    const n = accessor(gltf, bin, primitive.attributes.NORMAL);
    normals = [];
    for (let i = 0; i < n.length; i += 3) { const t = apply(matrix, [n[i], n[i + 1], n[i + 2]], 0), len = Math.hypot(...t) || 1; normals.push(...t.map((v) => v / len)); }
  }
  const factor = gltf.materials?.[primitive.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
  return { positions, normals, indices, color: factor.slice(0, 3) };
}
function walk(gltf, bin, nodeIndex, parent, parts) {
  const node = gltf.nodes?.[nodeIndex];
  if (!node) return;
  const matrix = multiply(parent, local(node));
  for (const primitive of gltf.meshes?.[node.mesh ?? -1]?.primitives ?? [])
    if ((primitive.mode ?? 4) === 4 && primitive.attributes?.POSITION !== undefined) parts.push(primitivePart(gltf, bin, primitive, matrix));
  for (const child of node.children ?? []) walk(gltf, bin, child, matrix, parts);
}
/** Centred and sized to fit the view, whatever units the model was made in. */
function fitted(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let i = 0; i < part.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], part.positions[i]); hi[i % 3] = Math.max(hi[i % 3], part.positions[i]); }
  const middle = lo.map((v, i) => (v + hi[i]) / 2), size = Math.max(...hi.map((v, i) => v - lo[i])) || 1;
  for (const part of parts) part.positions = part.positions.map((v, i) => ((v - middle[i % 3]) * 1.9) / size);
  return parts;
}
/** The shapes in a .glb file, with its own colours. Throws, in plain words, what it cannot read. */
export function readGlb(buffer) {
  const data = new DataView(buffer);
  if (buffer.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67) throw new Error("That is not a .glb 3D model.");
  let at = 12, gltf = null, bin = null;
  while (at + 8 <= buffer.byteLength) {
    const length = data.getUint32(at, true), type = data.getUint32(at + 4, true), chunk = buffer.slice(at + 8, at + 8 + length);
    if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(chunk));
    if (type === 0x004e4942) bin = chunk;
    at += 8 + length;
  }
  if (!gltf || !bin) throw new Error("That .glb has no shapes Branch can read.");
  if ((gltf.extensionsRequired ?? []).length) throw new Error("That model is compressed in a way Branch cannot read yet. Export it without compression.");
  const parts = [];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const node of scene?.nodes ?? gltf.nodes?.map((_, i) => i) ?? []) walk(gltf, bin, node, moved(0, 0, 0), parts);
  if (!parts.length) throw new Error("That .glb has no shapes Branch can read.");
  return fitted(parts);
}
