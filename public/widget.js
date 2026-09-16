/**
 * A small box the owner can put on a page of their own — a notes page, a dashboard on the desk
 * machine — to ask their assistant something without opening the app. It is for the owner's own
 * pages. It is not a widget to publish on a website, and Branch will not help make it one.
 *
 * The rule that makes it safe: it talks only to the **paired remote listener**, with the key that
 * pairing gave the owner, given to it on the script tag. It refuses a loopback address outright,
 * and it never reads a key out of the page it is on or out of any storage — the key the app's own
 * page uses on this computer is the whole of Branch's authority there, and a page of the owner's
 * own must not be able to borrow it simply by sitting next door.
 *
 * Put it on a page like this:
 *
 *     <script src="http://your-machine.tailnet.ts.net:8765/widget.js"
 *             data-branch="http://your-machine.tailnet.ts.net:8765"
 *             data-key="the key pairing gave you"></script>
 */
const script = document.currentScript;

/** This computer talking to itself. The paired listener has a real address; loopback is refused. */
export function isLoopback(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return true; }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Where the widget may talk to, and with what. Both come off the script tag and nowhere else;
 * anything missing, or a loopback address, and the widget says why and does nothing at all.
 */
export function settingsFrom(element) {
  const where = (element?.dataset?.branch ?? "").trim();
  const key = (element?.dataset?.key ?? "").trim();
  if (!where) return { ok: false, why: "This box needs the address of your paired Branch, in data-branch." };
  if (isLoopback(where))
    return { ok: false, why: "This box will not talk to Branch on this computer's own address. Turn on reaching Branch from your phone, pair once, and use that address and key." };
  if (!key) return { ok: false, why: "This box needs the key pairing gave you, in data-key." };
  return { ok: true, where: where.replace(/\/$/, ""), key };
}

const el = (tag, text, style) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (style) node.setAttribute("style", style);
  return node;
};

/** The box itself: one line to type in, one button, and one place the answer appears. */
export function makeWidget(settings, fetcher = globalThis.fetch) {
  const box = el("div", undefined, "font:14px system-ui,sans-serif;max-width:32rem;border:1px solid #ccc;border-radius:10px;padding:12px");
  const heading = el("strong", "Ask your assistant");
  const said = el("p", "", "white-space:pre-wrap;margin:8px 0 0");
  box.append(heading);
  if (!settings.ok) { said.textContent = settings.why; box.append(said); return box; }

  const row = el("div", undefined, "display:flex;gap:6px;margin-top:8px");
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("aria-label", "What would you like to ask?");
  input.setAttribute("style", "flex:1;min-width:0;padding:6px");
  const send = el("button", "Ask");
  send.type = "button";
  row.append(input, send);
  box.append(row, said);

  send.addEventListener("click", async () => {
    const prompt = input.value.trim();
    if (!prompt) return;
    said.textContent = "Asking…";
    try {
      const response = await fetcher(settings.where + "/api/run", {
        method: "POST",
        headers: { authorization: "Bearer " + settings.key, "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json();
      said.textContent = response.ok ? String(data.output ?? "") : String(data.error ?? "That did not work.");
    } catch (error) { said.textContent = error.message; }
  });
  return box;
}

/* On a real page the box appears where the script tag is. Imported in a test, nothing happens. */
if (script?.parentNode) script.parentNode.insertBefore(makeWidget(settingsFrom(script)), script);
