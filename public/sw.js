/**
 * Network-first service worker.
 *
 * Deliberately network-first, not cache-first: this is a live scoreboard, so a
 * stale bundle is worse than a slow one. The cache exists only so the app still
 * opens when the venue wifi drops — Supabase requests are never touched, they
 * are cross-origin and must always hit the network.
 */
const CACHE = "bx-shell-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave Supabase alone

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        /*
         * Only a page may fall back to the shell. Handing index.html to a
         * script request is worse than failing: the browser rejects it on MIME
         * type and the app renders nothing at all. This bit it once already,
         * when a deploy replaced the bundle a cached page still asked for.
         */
        if (req.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
