/**
 * Keeps the app's own files on the phone so opening it again is quick and a dropped connection
 * shows the app rather than a browser error page. Nothing your assistant does is cached: every
 * /api/ request goes straight to your computer and fails honestly when it cannot be reached, which
 * is what puts the offline banner on the screen.
 */
const CACHE = "branch-shell-v2";
const SHELL = [
  "/", "/tokens.css", "/style.css", "/shell.css", "/web-ui.css", "/layout.css",
  "/app.js", "/device-headers.js", "/shell.js", "/layout.js", "/theme-catalogue.js", "/grove.js", "/appearance.js", "/context-pane.js", "/acorn.js",
  "/markdown.js", "/i18n.js", "/inspector.js", "/live-run.js", "/token-meter.js",
  "/locales/en.json", "/manifest.webmanifest",
  "/assets/keepoak-mark.png", "/assets/keepoak-mark-reversed.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* One missing file must not stop the whole thing being useful. */
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  /* Anything the assistant does is live or it is nothing; never answer it from a cache. */
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/webhooks/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      /* Only opening the app falls back to the saved page; a missing picture must not become one. */
      .catch(async () => (await caches.match(request))
        ?? (request.mode === "navigate" ? await caches.match("/") : null)
        ?? Response.error()),
  );
});

/**
 * FQ-surfaces.mobile-push: shows a notification even while nothing is open — the whole point of a
 * push. public/push.js decides whether the owner wants one at all (public/comfort.js's "This
 * window only" is honored on the server, before anything is sent here); this worker just shows what
 * it is given. A push whose body is not JSON still shows a plain fallback rather than nothing.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* shown with the fallback text below */ }
  event.waitUntil(self.registration.showNotification(data.title || "Branch", {
    body: data.body || "",
    tag: data.tag || "branch-task",
    data: { runId: data.runId ?? null, sessionId: data.sessionId ?? null },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const opened = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of opened) {
      /* The page itself decides what "open" means for its own conversation list; the worker only says which one. */
      client.postMessage({ type: "branch-push-open", runId: event.notification.data?.runId ?? null, sessionId: event.notification.data?.sessionId ?? null });
      return client.focus();
    }
    return self.clients.openWindow("/");
  })());
});
