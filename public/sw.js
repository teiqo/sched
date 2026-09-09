const SCOPE = new URL(self.registration.scope).pathname;
const CACHE_PREFIX = "sched:" + SCOPE + ":";
const CACHE = CACHE_PREFIX + "2026-09-09-v47-editor-close-drag-fix";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/compat.js",
  "./js/config.js",
  "./js/app.js",
  "./js/schedule.js",
  "./js/push.js",
  "./js/pair-moves.js",
  "./js/pair-drag.js",
  "./js/day-swipe.js",
  "./js/lesson-types.js",
  "./js/telegram-auth.js",
  "./js/telegram-auth-ui.js",
  "./js/reporting.js",
  "./css/base.css",
  "./css/layout.css",
  "./css/components.css",
  "./css/transitions.css",
  "./css/palettes.css",
  "./css/overrides.css",
  "./css/fixes.css",
  "./css/interaction.css",
  "./css/editor-mode.css",
  "./css/editor-mode-close.css",
  "./css/onboarding-tour.css",
  "./assets/fonts/inter.ttf",
  "./assets/icons/sched.svg",
  "./assets/icons/sched-180.png",
  "./assets/icons/sched-192.png",
  "./assets/icons/sched-512.png",
  "./data/schedule.json",
  "./data/changelog.json",
];
const isOurs = (key) =>
  key.startsWith(CACHE_PREFIX) ||
  key.startsWith("weeqo-groups-") ||
  key.startsWith("weekly-groups-");
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.all(
          ASSETS.map(async (url) => {
            const response = await fetch(new Request(url, { cache: "reload" }));
            if (!response.ok) throw new Error("Missing precache asset: " + url);
            return cache.put(url, response);
          }),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  let hadPreviousCache = false;
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        hadPreviousCache = keys.some((key) => key !== CACHE && isOurs(key));
        return Promise.all(
          keys.filter((key) => key !== CACHE && isOurs(key)).map((key) => caches.delete(key)),
        );
      })
      .then(() => self.clients.claim())
      .then(() => hadPreviousCache ? self.clients.matchAll({ type: "window", includeUncontrolled: true }) : [])
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => null)))),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
  if (event.data?.type === "purge")
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter(isOurs).map((key) => caches.delete(key))))
        .then(() => event.source?.postMessage({ type: "purged" })),
    );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;
  // Never cache credentials, authenticated requests or login callback URLs.
  if (request.headers.has("Authorization") || /\/auth(?:\/|$)/.test(url.pathname) ||
      ["code", "state", "hash", "auth_date", "id_token", "session_token"].some((key) => url.searchParams.has(key))) return;
  // Stable filenames for editable CSS/JS are network-first, not cached forever.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type !== "opaque" && !/no-store/i.test(response.headers.get("Cache-Control") || "")) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(
        async () =>
          (await caches.match(request)) ||
          (request.mode === "navigate" ? await caches.match("./index.html") : null) ||
          new Response("", { status: 503 }),
      ),
  );
});
