// reader service worker: keeps the app shell available so the app opens instantly and offline.
// Book data and audio always come from the network (audio is cached by the browser's HTTP cache).
const SHELL = "reader-shell-v4";
const FILES = ["/", "/static/app.js", "/static/sounds.js", "/static/style.css", "/manifest.webmanifest", "/static/icons/icon-192.png", "/static/icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((u) => new Request(u, { credentials: "include" })))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (!(e.request.mode === "navigate" || FILES.includes(url.pathname) || url.pathname.startsWith("/static/"))) return;
  // network first (so updates land immediately), cached shell when offline
  e.respondWith(
    fetch(e.request).then(async (r) => {
      if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request.mode === "navigate" ? "/" : e.request, copy)); }
      if (r.status >= 500) return (await caches.match(e.request.mode === "navigate" ? "/" : e.request)) || r;   // server restarting: keep the app up
      return r;
    }).catch(() => caches.match(e.request.mode === "navigate" ? "/" : e.request))
  );
});
