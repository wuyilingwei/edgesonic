// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EdgeSonic Service Worker — App Shell + navigation fallback.
// Strategy:
//   - Precache core shell (index.html, manifest, logo, icons).
//   - Navigation requests: network-first, fall back to cached index.html.
//   - Same-origin static GET (hashed Vite assets): stale-while-revalidate.
//   - API paths (/rest/* /edgesonic/* /storage/* /tag/*) and
//     /edgesonic/version: network-only (never cached).
//   - Cross-origin (fonts, covers, etc.): opaque CORS, cache 1h, no revalidate.

const SW_VERSION = "1";
const PRECACHE = `edgesonic-shell-v${SW_VERSION}`;
const RUNTIME = `edgesonic-runtime-v${SW_VERSION}`;
const OPAQUE = `edgesonic-opaque-v${SW_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./logo.svg",
  "./favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

const NEVER_CACHE_PATH_PREFIXES = [
  "/rest/",
  "/edgesonic/",
  "/storage/",
  "/tag/",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => ![PRECACHE, RUNTIME, OPAQUE].includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function shouldNeverCache(url) {
  for (const p of NEVER_CACHE_PATH_PREFIXES) {
    if (url.pathname.startsWith(p)) return true;
  }
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Navigation: network-first with cache fallback to index.html.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(PRECACHE);
          cache.put("./index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(PRECACHE);
          return (await cache.match("./index.html")) || (await cache.match("./"));
        }
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    // CORS-enabled APIs (e.g. api.github.com for the update check) must go
    // through the normal browser fetch — wrapping them in no-cors yields an
    // opaque response the page cannot read, silently breaking the feature.
    if (url.hostname === "api.github.com") return; // default fetch
    // Cross-origin: cache opaque responses briefly (fonts, images).
    event.respondWith(
      (async () => {
        const cache = await caches.open(OPAQUE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req, { mode: "no-cors" });
          if (res.type === "opaque" || res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (shouldNeverCache(url)) return; // default fetch

  // Same-origin static GET: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "edgesonic:skip-waiting") self.skipWaiting();
  if (event.data === "edgesonic:claim-clients") self.clients.claim();
});