// 離線快取：只有網頁本身（同網域的程式、圖示；pdf.js、three.js 用到時才快取）。模型檔、PDF、Google、紀錄端點一律不經過這裡、不快取（v0.6.0：分享的檔案不留在對方手機）
// v0.10.0：註冊時帶 ?mode=cache（正式網址一律這樣）→「先用快取」：網頁本身第二次開不用等網路。
//   每一版改 CACHE 名稱：瀏覽器發現 sw.js 變了就裝新版，安裝時把 FILES 整組重新下載（cache:'reload'，不用 HTTP 快取裡的舊檔），
//   裝好就換新版、刪掉舊的快取，所以不會新舊檔混在一起。下次打開網頁就是新版。
//   沒帶 ?mode=cache（本機測試）＝「網路優先」：改了程式馬上看得到，沒網路才用快取。
const CACHE = 'skpv-0.10.5';
const CACHE_FIRST = new URL(self.location.href).searchParams.get('mode') === 'cache';
const FILES = [
  './', './index.html', './app.css', './app.js', './model3d.js', './cloud.js', './share.js', './notice.js', './pdfview.js', './pdfdata.js', './offline.js',
  './device.js', './memory.js', './config.js', './manifest.webmanifest',
  './lib/three.module.min.js', './lib/OrbitControls.js', './lib/GLTFLoader.js', './lib/BufferGeometryUtils.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const rel = './' + url.pathname.split('/').pop();
  const mine = FILES.includes(rel) || url.pathname.includes('/lib/') || url.pathname.includes('/icons/');
  if (!mine) return; // 測試用的範例模型等：不經過這裡
  // 快取的鍵去掉 ?… 和 #…：分享連結的權杖（?s=…）不會留在快取裡
  const key = url.origin + url.pathname;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    if (CACHE_FIRST) {
      const hit = await c.match(key);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(key, res.clone());
      return res;
    }
    // 網路優先：有網路就拿最新版並更新快取；沒網路才用快取
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) c.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(key);
      if (hit) return hit;
      throw err;
    }
  }));
});
