const CACHE = "weeqo-groups-v81";
const ASSETS = [
  "./",
  "./index.html",
  "./assets/index-DpiSe78P.css",
  "./assets/weekly-VO4sFbvD.css",
  "./assets/WeeklyApp-BMeQie97.css",
  "./assets/weekly-transitions-BckgDRnH.css",
  "./assets/weekly-opaque-GLxzbT3R.css",
  "./css/patch.css",
  "./js/config.js",
  "./js/app.js",
  "./js/schedule.js",
  "./images/weeqo-icon.svg",
  "./images/weeqo-180.png",
  "./manifest.webmanifest",
  "./assets/fonts/inter.ttf"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      /* Обходим HTTP-кэш браузера, чтобы в кэш SW не попала устаревшая копия. */
      .then((cache) =>
        Promise.all(
          ASSETS.map((url) =>
            fetch(new Request(url, { cache: "reload" }))
              .then((res) => (res.ok ? cache.put(url, res) : null))
              .catch(() => null)
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/* Страница может попросить сбросить кэш и сам SW, если приложение не загрузилось. */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "skip-waiting") {
    self.skipWaiting();
    return;
  }
  if (data.type === "purge") {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => {
          if (event.source) event.source.postMessage({ type: "purged" });
        })
    );
  }
});

const stash = (request, response) => {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = request.url;
  const parsed = new URL(url);
  const sameOrigin = parsed.origin === location.origin;

  /* Облако с заменами, auth-токены и виджет Telegram не кешируем.
     Офлайн отдаём 503 сами, чтобы не сыпать Uncaught в консоль. */
  if (/\.(firebaseio\.com|firebasedatabase\.app|googleapis\.com|getpantry\.cloud)|telegram\.org/.test(url)) {
    event.respondWith(
      fetch(request).catch(() => new Response(null, { status: 503 }))
    );
    return;
  }

  /* Чужие запросы — просто в сеть, без кэша. */
  if (!sameOrigin) return;

  /* Хэшированные ассеты сборки (assets/*-ХЭШ.css) не меняются под тем же
     именем — их безопасно отдавать из кэша мгновенно. */
  if (parsed.pathname.indexOf("/assets/") !== -1) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request)
            .then((response) => stash(request, response))
            .catch(() => caches.match("./index.html"))
      )
    );
    return;
  }

  /* Всё остальное своё (index.html, js, patch.css, иконки, манифест, данные) —
     network-first: после деплоя новые версии подхватываются сразу и никакой
     файл не может залипнуть старым. Офлайн — последняя копия из кэша. */
  event.respondWith(
    fetch(request)
      .then((response) => stash(request, response))
      .catch(() =>
        caches.match(request).then(
          (cached) =>
            cached ||
            (request.mode === "navigate" || request.destination === "document"
              ? caches.match("./index.html")
              : request.destination === "script"
                ? new Response("", {
                    status: 503,
                    headers: { "Content-Type": "application/javascript" }
                  })
                : Response.error())
        )
      )
  );
});
