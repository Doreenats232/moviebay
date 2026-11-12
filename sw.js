// OmegaStream service worker
// - App shell: served from cache instantly, refreshed in the background (hides Render cold starts)
// - API JSON via the proxy: network first, cached copy if offline
// - Posters: cache first, capped
// - Video / range requests: never touched
var VERSION = "v3";
var SHELL = "os-shell-" + VERSION;
var API = "os-api-" + VERSION;
var IMG = "os-img-" + VERSION;
var SHELL_FILES = ["./", "index.html", "manifest.json", "icons/icon-192.png", "icons/icon-512.png"];
var DLC = "os-dlstore"; // finished background downloads waiting to be saved
var IMG_MAX = 150;
var API_MAX = 60;

self.addEventListener("install", function(e) {
  e.waitUntil(caches.open(SHELL).then(function(c) { return c.addAll(SHELL_FILES.map(function(u) { return new Request(u, { cache: "reload" }); })); }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener("activate", function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k.indexOf("os-") === 0 && k !== SHELL && k !== API && k !== IMG && k !== DLC; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); }).then(notifyUpdate)
  );
});

function notifyUpdate() {
  return self.clients.matchAll().then(function(cs) { cs.forEach(function(c) { c.postMessage({ type: "update-ready" }); }); });
}

function trim(name, max) {
  caches.open(name).then(function(c) {
    c.keys().then(function(keys) { if (keys.length > max) c.delete(keys[0]).then(function() { trim(name, max); }); });
  });
}

self.addEventListener("fetch", function(e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (req.headers.has("range")) return;
  var url = new URL(req.url);

  // never cache video streams / downloads
  if (url.pathname.indexOf("/video") !== -1 || /\/(dl|download)\/?$/.test(url.pathname) || /\.(mp4|m3u8|ts|mkv|webm)(\?|$)/i.test(url.pathname)) return;

  // app shell (same origin): cache first, update in background
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(SHELL).then(function(cache) {
        return cache.match(req, { ignoreSearch: true }).then(function(hit) {
          var hitCopy = hit ? hit.clone() : null; // hit itself is consumed when served
          var net = fetch(req).then(function(res) {
            if (!res || !res.ok) return res;
            var forCache = res.clone();
            var forCompare = res.clone();
            var changed = (hit && req.mode === "navigate")
              ? Promise.all([hitCopy.text(), forCompare.text()]).then(function(t) { return t[0] !== t[1]; }).catch(function() { return false; })
              : Promise.resolve(false);
            return changed.then(function(isChanged) {
              return cache.put(req, forCache).then(function() { if (isChanged) return notifyUpdate(); });
            }).then(function() { return res; });
          }).catch(function() { return hit; });
          if (hit) { e.waitUntil(net); return hit; }
          return net.then(function(res) { return res || cache.match("index.html"); });
        });
      })
    );
    return;
  }

  // images (posters/backdrops): cache first
  if (req.destination === "image") {
    e.respondWith(
      caches.open(IMG).then(function(cache) {
        return cache.match(req).then(function(hit) {
          if (hit) return hit;
          return fetch(req).then(function(res) {
            if (res && (res.ok || res.type === "opaque")) { cache.put(req, res.clone()); trim(IMG, IMG_MAX); }
            return res;
          });
        });
      })
    );
    return;
  }

  // proxy / API JSON: network first, fall back to cache
  if (url.hostname.indexOf("workers.dev") !== -1) {
    e.respondWith(
      fetch(req).then(function(res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(API).then(function(c) { c.put(req, copy); trim(API, API_MAX); });
        }
        return res;
      }).catch(function() {
        return caches.open(API).then(function(c) { return c.match(req); }).then(function(hit) {
          return hit || new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
        });
      })
    );
  }
});

// ---- Background Fetch: the browser keeps downloading with the tab / app closed ----
function dlKey(id) { return new URL("__dl/" + encodeURIComponent(id), self.registration.scope).href; }

self.addEventListener("backgroundfetchsuccess", function(e) {
  var bgf = e.registration;
  e.waitUntil((async function() {
    try {
      var cache = await caches.open(DLC);
      var recs = await bgf.matchAll();
      for (var i = 0; i < recs.length; i++) {
        var r = await recs[i].responseReady;
        var resp = r.status === 206 ? new Response(r.body, { status: 200, headers: r.headers }) : r;
        await cache.put(dlKey(bgf.id), resp);
      }
      await e.updateUI({ title: "Download ready - tap to save" });
    } catch (err) {
      await e.updateUI({ title: "Download finished but could not be stored" });
    }
  })());
});

self.addEventListener("backgroundfetchfail", function(e) {
  e.waitUntil(e.updateUI({ title: "Download failed - open the app to retry" }));
});

self.addEventListener("backgroundfetchclick", function(e) {
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(function(cs) {
    if (cs.length) return cs[0].focus();
    return self.clients.openWindow("./");
  }));
});
