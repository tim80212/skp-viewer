// 離線快取：只有網頁本身（同網域的程式、圖示；pdf.js 用到時才快取）。模型檔、PDF、Google、紀錄端點一律不經過這裡、不快取（v0.6.0：分享的檔案不留在對方手機）
const CACHE = 'skpv-0.7.0';
const FILES = [
  './', './index.html', './app.css', './app.js', './cloud.js', './share.js', './notice.js', './pdfview.js', './memory.js', './config.js', './manifest.webmanifest',
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
      // 快取的鍵去掉 ?… 和 #…：分享連結的權杖（?s=…）不會留在快取裡
      if (res.ok && (FILES.includes(rel) || url.pathname.includes('/lib/') || url.pathname.includes('/icons/'))) c.put(url.origin + url.pathname, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }));
});
