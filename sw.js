'use strict';

const CACHE_NAME = "grasso-di-scende-v16";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./daily.js",
  "./backup.js",
  "./manifest.json",
  "./vocab.json",
  "./conjugations.json",
  "./icon-v2-192.png",
  "./icon-v2-512.png",
  "./icon-v2-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        // cache: "reload" skips the browser's own HTTP cache, so an update
        // always stores the files that are really on the server now.
        Promise.all(
          APP_SHELL.map((url) =>
            fetch(new Request(url, { cache: "reload" })).then((response) => {
              if (!response.ok) throw new Error("Could not cache " + url);
              return cache.put(url, response);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Cache-first for everything in the app shell, falling back to the
// network (and caching the response) for anything else same-origin.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response && response.ok && event.request.url.startsWith(self.location.origin)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
