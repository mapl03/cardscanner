/* Card Vault service worker.
   App shell is cached so the app opens offline and Android offers to install it.
   Firebase and the API proxy are never cached — stale card data would be worse
   than no data. Bump CACHE when you ship, or browsers serve the old bundle. */

const CACHE = "cardscanner-v1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

const BYPASS = [
  "googleapis.com", "firebaseio.com", "firebaseapp.com",
  "gstatic.com", "workers.dev", "firebasestorage.app",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (BYPASS.some((host) => url.hostname.includes(host))) return;

  // Navigations: network first, cached shell as the offline fallback.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("./index.html")));
    return;
  }

  // Built assets are content-hashed, so cache-first is safe and fast.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
