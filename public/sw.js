const CACHE = "food-coster-v2";
const CORE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

async function precacheAppShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(CORE);
  try {
    const response = await fetch("/", { cache: "no-store" });
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((url) => url.startsWith("/_next/static/"));
    await Promise.all([...new Set(assets)].map(async (url) => {
      try { await cache.add(url); } catch {}
    }));
  } catch {}
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("/")) || Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || /\.(?:js|css|woff2?|png|svg|webp|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const update = fetch(request).then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        });
        return cached || update;
      }),
    );
  }
});
