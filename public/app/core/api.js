/* Talking to the engine: one fetch helper and one event stream. The desktop app signs every request itself (Electron adds
   the header); in a browser the window uses the session token it was given at sign-in. */

const TOKEN_KEY = "branch-token";
export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) || "",
  set: (value) => (value ? sessionStorage.setItem(TOKEN_KEY, value) : sessionStorage.removeItem(TOKEN_KEY)),
};
export const isDesktop = new URLSearchParams(location.search).has("desktop");

function headers(json) {
  const out = {};
  const value = token.get();
  if (value) out.authorization = "Bearer " + value;
  if (json) out["content-type"] = "application/json";
  return out;
}

/* GET when there is no body, POST when there is, unless a method is given. Throws the engine's own error words. */
export async function api(path, body, method, signal) {
  const response = await fetch("/api/" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    cache: "no-store",
    signal,
    headers: headers(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || String(response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

/* POST raw bytes (a recording, a file) with their own content type; answers the engine's JSON or throws its words. */
export async function apiBytes(path, blob) {
  const response = await fetch("/api/" + path, { method: "POST", cache: "no-store", headers: { ...headers(false), "content-type": blob.type || "application/octet-stream" }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || String(response.status)), { status: response.status });
  return data;
}

/* Server-sent events over fetch (EventSource cannot carry the header). Calls onEvent(kind, payload) until stopped. */
export function stream(kinds, onEvent) {
  const controller = new AbortController();
  const run = async () => {
    const query = kinds.length ? "?kind=" + encodeURIComponent(kinds.join(",")) : "";
    const response = await fetch("/api/events/stream" + query, { headers: headers(false), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(String(response.status));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = drain(buffer + decoder.decode(value, { stream: true }), onEvent);
    }
  };
  const done = run().catch((error) => { if (error.name !== "AbortError") console.error(error); });
  return { stop: () => controller.abort(), done };
}

function drain(buffer, onEvent) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let kind = "message";
    let payload = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("data:")) payload += line.slice(5).trim();
    }
    if (!payload || kind === "ready" || kind === "end") continue;
    try { onEvent(kind, JSON.parse(payload)); } catch { /* a half-written block is ignored */ }
  }
  return rest;
}
