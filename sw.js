/**
 * Cache-first for the app shell so the page opens instantly with no signal.
 * API calls are never cached — app.js owns freshness and the write queue.
 *
 * Staleness is handled structurally rather than by remembering to bump a
 * version: every shell response is revalidated in the background, and if the
 * copy on the server differs from the cached one, connected pages are told to
 * reload themselves. Bumping CACHE still forces a clean sweep, but forgetting
 * to no longer strands anyone on an old build.
 */

var CACHE = 'fd-shell-v11';


var SHELL = [
  './',
  './index.html',
  './app.js',
  './feeds.js',
  './manifest.json',
  './fonts/baloo2-latin.woff2'
];

// config.js is gitignored and may legitimately be absent. It must not sit in
// SHELL: addAll is atomic, so a single 404 rejects the whole install and the
// app loses offline support entirely — while still rendering, so nothing looks
// wrong. Cached opportunistically instead.
var OPTIONAL = ['./config.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // `cache: 'reload'` bypasses the HTTP cache so a fresh install never
      // seeds itself with the very files it is meant to replace.
      .then(function (c) {
        return c.addAll(SHELL.map(function (u) {
          return new Request(u, { cache: 'reload' });
        })).then(function () {
          return Promise.all(OPTIONAL.map(function (u) {
            return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
          }));
        });
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function tell(msg) {
  return self.clients.matchAll({ includeUncontrolled: true }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage(msg); });
  });
}

/** Cheap identity for a response: prefer validators, fall back to body text. */
function stamp(res) {
  var tag = res.headers.get('ETag') || res.headers.get('Last-Modified');
  if (tag) return Promise.resolve(tag);
  return res.clone().text().then(function (t) { return 'len:' + t.length; });
}

function changed(oldRes, newRes) {
  return Promise.all([stamp(oldRes), stamp(newRes)])
    .then(function (p) { return p[0] !== p[1]; })
    .catch(function () { return false; });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.indexOf('script.google.com') !== -1) return;
  if (req.url.indexOf(self.registration.scope) !== 0) return;

  var pair = caches.match(req).then(function (hit) {
    // Clone the cached response *now*. Once it is handed to respondWith the
    // browser consumes its body, and any later clone() throws.
    var before = hit ? hit.clone() : null;

    // `cache: 'no-cache'` forces revalidation against the server. Without it
    // this fetch is answered from the browser's own HTTP cache, so we compare
    // the stale response against itself and never notice a deploy.
    var net = fetch(req.url, { cache: 'no-cache' }).then(function (res) {
      if (!res || !res.ok) return res;
      var forCache = res.clone();
      var forCompare = res.clone();
      // Only shell documents and scripts can meaningfully go stale; a font
      // never changes under the same filename.
      var watch = /\.(html|js|json)$/.test(req.url) || req.url === self.registration.scope;
      var check = (before && watch)
        ? changed(before, forCompare)
        : Promise.resolve(false);

      return check.then(function (isNew) {
        return caches.open(CACHE)
          .then(function (c) { return c.put(req, forCache); })
          .then(function () {
            if (isNew) return tell({ type: 'shell-updated', cache: CACHE });
          })
          .then(function () { return res; });
      });
    }).catch(function () {
      // Offline, or the shell moved under us. The cached copy is still good.
      return hit;
    });

    return { hit: hit, net: net };
  });

  e.respondWith(pair.then(function (p) { return p.hit || p.net; }));

  // Without this the event settles as soon as the cached copy is returned and
  // the browser may kill the worker mid-revalidation — the update check would
  // then only land by luck.
  e.waitUntil(pair.then(function (p) { return p.net.catch(function () {}); }));
});
