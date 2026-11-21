// 離線快取：網頁本身（不含使用者開啟的模型檔，模型檔一律只在本機讀取）
const CACHE = 'skpv-0.4.1';
const FILES = [
  './', './index.html', './app.css', './app.js', './cloud.js', './config.js', './manifest.webmanifest',
  './lib/three.module.min.js', './lib/OrbitControls.js', './lib/GLTFLoader.js', './lib/BufferGeometryUtils.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 有網路就拿最新版並更新快取；沒網路才用快取（網頁更新後不會卡在舊版）
  e.respondWith(caches.open(CACHE).then(async (c) => {
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      const rel = './' + url.pathname.split('/').pop();
      if (res.ok && (FILES.includes(rel) || url.pathname.includes('/lib/') || url.pathname.includes('/icons/'))) c.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }));
});
