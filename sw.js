// Service worker: offline support, and notifications that arrive while the app is closed.
const CACHE = "masjid-v5";
const SHELL = ["./", "index.html", "config.js", "adhan.min.js", "data/verses.js", "data/times.json", "icon.svg", "icons/icon-192.png", "manifest.webmanifest", "lib/install-gate.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first (so config/times changes show up at once), cache as fallback when offline.
// The live API (/api/...) is never cached.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// A notification from the server: adhan, reminder before adhan, masjid opened/closed,
// reminder of the day or news. The phone plays its normal notification sound.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Mešita Al-huda", body: e.data ? e.data.text() : "" }; }
  const adhan = d.kind === "adhan";
  const opts = {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || d.kind || "masjid",
    renotify: true,
    silent: false,
    requireInteraction: adhan,                       // the adhan stays until it is seen
    vibrate: adhan ? [500, 250, 500, 250, 800] : [250, 120, 250],
    timestamp: Date.now(),
    data: { url: d.url || "./" }
  };
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Mešita Al-huda", opts),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: "push", data: d })))
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  // open the right page: the app, or Imam controls for account alerts
  const page = (u) => new URL(u).pathname.replace(/\/index\.html$/, "/");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (page(c.url) !== page(target) || !("focus" in c)) continue;
      return c.focus().then((w) => (w && target !== c.url && "navigate" in w ? w.navigate(target) : w)).catch(() => c.focus());
    }
    return self.clients.openWindow(target);
  }));
});

// If the phone renews its notification address, tell the server so alerts keep arriving
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const r = await fetch("api/push-key", { cache: "no-store" });
    const { publicKey } = await r.json();
    const b = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((publicKey.length + 3) % 4));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(b, (c) => c.charCodeAt(0)) });
    await fetch("api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  })());
});
