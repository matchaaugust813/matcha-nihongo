/* =========================================================
   Service Worker — Minna no Nihongo Kartu Kosakata
   =========================================================
   Strategi dibagi dua supaya UPDATE SELALU LANGSUNG TERLIHAT:

   1. File INTI (HTML/CSS/JS/manifest) -> NETWORK-FIRST.
      Selalu coba ambil versi terbaru dari server dulu setiap
      dibuka; cache cuma dipakai sebagai cadangan kalau benar-
      benar sedang offline. Jadi begitu kamu publish ulang ke
      Netlify, perubahan langsung kelihatan di kunjungan
      berikutnya -- tidak akan "nyangkut" di versi lama lagi.

   2. File STATIS BERAT (audio, font, ikon) -> CACHE-FIRST.
      File ini nyaris tidak pernah berubah, jadi diambil dari
      cache dulu (instan, hemat kuota); kalau belum ada di
      cache, baru diambil dari server lalu disimpan untuk lain
      kali.

   Panggilan ke Supabase / CDN luar (login & sinkron akun)
   SENGAJA dibiarkan lewat apa adanya, tidak ikut di-cache.
   ========================================================= */

var CORE_CACHE = "mnn-core-v2";
var ASSET_CACHE = "mnn-assets-v2";

var CORE_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./data.js",
  "./extra_data.js",
  "./config.js",
  "./sync.js",
  "./manifest.json"
];

function isStaticAsset(url) {
  return url.pathname.indexOf("/audio/") !== -1 ||
         url.pathname.indexOf("/fonts/") !== -1 ||
         url.pathname.indexOf("/icons/") !== -1;
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CORE_CACHE)
      .then(function (cache) { return cache.addAll(CORE_FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CORE_CACHE && k !== ASSET_CACHE; })
          .map(function (k) { return caches.delete(k); }) // buang cache versi lama (mis. mnn-shell-v1)
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  // Biarkan permintaan ke domain lain (Supabase, CDN supabase-js, dsb) lewat apa adanya
  if (url.origin !== self.location.origin) return;

  if (isStaticAsset(url)) {
    // CACHE-FIRST untuk audio/font/ikon
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(ASSET_CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // NETWORK-FIRST untuk file inti (HTML/CSS/JS) -> update selalu kepakai duluan
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CORE_CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req);
    })
  );
});
