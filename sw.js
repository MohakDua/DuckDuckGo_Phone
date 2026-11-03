// DuckGoDo phone - service worker. Keeps the app itself (not your data) so it opens with no signal.
// Your data lives in this browser's storage, not here. Bump CACHE when you change any app file so phones pick the new version up.
const CACHE = "duck-phone-b26-1";
const SHELL = ["./", "./index.html", "./app.js", "./style.css", "./config.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;   // Google (sign-in, Drive) always goes straight to the network
    // config.js: network first, so a fixed Client ID arrives at once; the saved copy is used offline
    if (url.pathname.endsWith("/config.js")) {
        e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req)));
        return;
    }
    // everything else: the saved copy first, refreshed in the background
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req).then((r) => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; }).catch(() => hit);
        return hit || net;
    }).then((r) => r || caches.match("./index.html")));
});
