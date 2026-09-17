/**
 * The side panel's conversation with your own Branch (A1611), as plain functions so they can be
 * checked without a browser. The panel keeps one conversation going: every message after the first
 * carries the conversation's id, so Branch answers with what was said before in mind.
 *
 * The same rule as the popup: only the paired listener, with the key pairing gave you, and never
 * this computer's own address, whose key is the whole of Branch's authority here.
 */

/** This computer talking to itself, which the panel will not do. */
export function isLoopback(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return true; }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The one address pattern Chrome is asked for, at the moment the owner names it. */
export function hostPattern(where) {
  const url = new URL(where);
  return `${url.protocol}//${url.hostname}${url.port ? ":" + url.port : ""}/*`;
}

/** What goes to Branch: the message, and the page it is about when the owner ticked that. */
export function messageFor(text, page) {
  const said = String(text ?? "").trim();
  if (!page) return said;
  const lines = [said || "Have a look at this page.", "", `Page: ${page.title || "(no title)"}`, `Address: ${page.url}`];
  if (page.selection?.trim()) lines.push("", "What I selected on it:", page.selection.trim());
  return lines.join("\n");
}

/** A reason not to send, in plain words, or null when the address and key will do. */
export function refusal(where, key) {
  if (!where || !key) return "Fill in your paired Branch address and its key first.";
  if (isLoopback(where)) return "The side panel will not talk to Branch on your computer's own address. Pair once and use that address and key.";
  if (!/^https?:\/\//i.test(where)) return "The address starts with http:// or https://.";
  return null;
}

/**
 * One turn of the conversation. `conversation` holds the id Branch gave the first answer; it is
 * filled in here so the next turn continues the same conversation.
 */
export async function sendTurn(fetchImpl, where, key, text, conversation) {
  const base = String(where).trim().replace(/\/+$/, "");
  const why = refusal(base, key);
  if (why) return { ok: false, answer: why };
  const response = await fetchImpl(`${base}/api/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: text, ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, answer: String(data.error ?? "That did not work.") };
  if (typeof data.sessionId === "string") conversation.sessionId = data.sessionId;
  const waiting = data.status === "needs_input" ? "\n\n(Branch is waiting for a yes. Answer it in the Branch app.)" : "";
  return { ok: true, answer: `${String(data.output ?? "")}${waiting}` };
}
