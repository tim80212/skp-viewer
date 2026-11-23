// PDF 檢視（v0.7.0）。pdf.js 4.10.38（Apache-2.0，lib/pdfjs/，legacy 版：舊 iPhone 也能跑），開 PDF 時才載入。
//
// 順暢度（大檔、幾百頁、掃描、A1 圖面，手機也要能開）：
// - 分段讀取：Google Drive 的下載支援 Range（CORS 允許 range 標頭），pdf.js 只抓「畫目前這頁需要的那幾段」，
//   不用先下載整個檔案；用我們自己的 fetch（cache:'no-store'、credentials:'omit'）→ 不進瀏覽器快取。
// - 一次只畫目前這頁，前後一頁先畫好（翻頁不用等），其他頁的畫布和 pdf.js 的頁面資源都放掉。
// - 底圖的像素有上限（手機 300 萬）；放大時底圖用 CSS 放大（手勢很順），停下來後只把「看得到的那一塊」用高解析度補畫。
// - 縮圖列：看到的才畫、一次一張、主畫面在畫的時候先等。
// - 分享：浮水印「#代號・僅供檢視・日期」畫進每一頁的 canvas（不是蓋在上面的 HTML）。
import { DEVICE } from './memory.js';

const $ = (s) => document.querySelector(s);
const CAPS = {
  phone: { base: 3.0e6, detail: 3.5e6, maxImage: 40e6, thumbs: 1 },
  tablet: { base: 6e6, detail: 6e6, maxImage: 120e6, thumbs: 1 },
  desktop: { base: 12e6, detail: 10e6, maxImage: -1, thumbs: 2 },
}[DEVICE] || { base: 6e6, detail: 6e6, maxImage: -1, thumbs: 1 };
const RANGE_CHUNK = 256 * 1024;
const FIRST_CHUNK = 512 * 1024;

let pdfjs = null;
let ui = null;
const S = {
  doc: null, task: null, n: 0, cur: 1, fit: 'width', zoom: 1, panX: 0, panY: 0, sizes: new Map(),
  bases: new Map(), // 頁碼 → { canvas, scale }
  detail: null, detailTimer: 0, rendering: 0, wm: '', name: '', bytes: 0, fetched: 0, requests: 0,
  open: false, token: 0, mode: '', timing: {}, thumbObs: null, thumbQ: [], thumbBusy: 0, gesture: false,
};

async function lib() {
  if (!pdfjs) {
    pdfjs = await import('./lib/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export function isPdf(buf) {
  const h = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  for (let i = 0; i + 4 < h.length; i++) if (h[i] === 0x25 && h[i + 1] === 0x50 && h[i + 2] === 0x44 && h[i + 3] === 0x46) return true; // %PDF
  return false;
}

// ---------------------------------------------------------------- 開啟
// src：{ data: ArrayBuffer } 或 { size, fetchRange(begin, end) → Promise<ArrayBuffer|{full:ArrayBuffer}> }
export async function openPdf(src, { name = '', share = null, t0 = performance.now(), hooks } = {}) {
  ui = hooks || ui;
  const lib0 = performance.now();
  const P = await lib();
  close();
  const token = ++S.token;
  S.name = name;
  S.fetched = 0;
  S.requests = 0;
  const common = {
    cMapUrl: new URL('./lib/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL('./lib/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false, enableXfa: false, maxImageSize: CAPS.maxImage, disableFontFace: false,
    useSystemFonts: true, stopAtErrors: false,
  };
  let params;
  if (src.data) {
    S.mode = 'data';
    S.bytes = src.data.byteLength;
    S.fetched = S.bytes;
    params = { ...common, data: new Uint8Array(src.data) };
  } else {
    S.bytes = src.size;
    const first = await src.fetchRange(0, Math.min(src.size, FIRST_CHUNK));
    if (token !== S.token) return null;
    if (first.full) { // 伺服器不支援 Range：整個檔案已經下載了
      S.mode = 'full';
      S.fetched = first.full.byteLength;
      params = { ...common, data: new Uint8Array(first.full) };
    } else {
      S.mode = 'range';
      S.fetched = first.byteLength;
      S.requests = 1;
      if (!isPdf(first)) throw new Error('這不是 PDF 檔。');
      const tr = new P.PDFDataRangeTransport(src.size, new Uint8Array(first));
      tr.requestDataRange = (begin, end) => {
        S.requests++;
        src.fetchRange(begin, end).then((buf) => {
          S.fetched += buf.byteLength;
          tr.onDataRange(begin, new Uint8Array(buf));
          progress();
        }).catch((e) => { S.rangeError = e; ui && ui.toast && ui.toast('下載 PDF 時網路中斷，請重新整理再試一次', 5000); });
      };
      params = { ...common, range: tr, length: src.size, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
    }
  }
  S.task = P.getDocument(params);
  const doc = await S.task.promise;
  if (token !== S.token) { doc.destroy(); return null; }
  S.doc = doc;
  S.n = doc.numPages;
  // 分享副本（第 2 層）：檔案裡寫著代號和到期時間，過期就不顯示（存了檔、換個方式打開也一樣）
  let info = {};
  try { info = ((await doc.getMetadata()).info || {}).Custom || {}; } catch (e) { /* 沒有就算了 */ }
  const shareInfo = info.SKPVCode ? { code: String(info.SKPVCode), expires: String(info.SKPVExpires || '') } : null;
  if (shareInfo) {
    const exp = Date.parse(shareInfo.expires);
    if (!exp || exp <= Date.now()) { close(); throw new Error(`這個分享副本（#${shareInfo.code}）已經過期，不能再開啟。`); }
    if (share && share.code !== shareInfo.code) { close(); throw new Error('分享副本的代號和連結不符，不能開啟。'); }
  } else if (share) {
    close();
    throw new Error('這不是分享副本，不能用分享連結開啟。');
  }
  const d = new Date();
  S.wm = shareInfo ? `#${shareInfo.code}・僅供檢視・${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
  S.share = shareInfo;
  S.open = true;
  S.cur = 1;
  S.fit = 'width';
  S.zoom = 1;
  $('#pdf-count').textContent = S.n;
  buildThumbs();
  S.timing = { lib: lib0 ? +(performance.now() - lib0).toFixed(0) : 0, open: +(performance.now() - t0).toFixed(0) };
  await go(1, true);
  S.timing.firstPage = +(performance.now() - t0).toFixed(0);
  S.timing.bytesAtFirstPage = S.fetched;
  window.__skpvPdfTiming = S.timing;
  return { pages: S.n, share: shareInfo, mode: S.mode, bytes: S.bytes };
}

export function close() {
  S.token++;
  S.open = false;
  for (const b of S.bases.values()) freeCanvas(b.canvas);
  S.bases.clear();
  S.sizes.clear();
  if (S.detail) { freeCanvas(S.detail.canvas); S.detail = null; }
  if (S.thumbObs) S.thumbObs.disconnect();
  S.thumbQ = [];
  for (const img of document.querySelectorAll('#pdf-thumbs img')) URL.revokeObjectURL(img.src);
  $('#pdf-thumbs').innerHTML = '';
  $('#pdf-page').innerHTML = '';
  if (S.doc) { S.doc.destroy(); S.doc = null; }
  else if (S.task) S.task.destroy();
  S.task = null;
}

export function info() {
  return { name: S.name, pages: S.n, bytes: S.bytes, mode: S.mode, fetched: S.fetched, requests: S.requests, share: S.share, timing: S.timing };
}

function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; c.remove(); } }

function progress() {
  if (S.mode !== 'range') return;
  const el = $('#pdf-net');
  if (el) el.textContent = `已下載 ${(S.fetched / 1048576).toFixed(1)} / ${(S.bytes / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- 尺寸、版面
async function pageSize(n) {
  if (!S.sizes.has(n)) {
    const p = await S.doc.getPage(n);
    const v = p.getViewport({ scale: 1 });
    S.sizes.set(n, { w: v.width, h: v.height });
  }
  return S.sizes.get(n);
}
function viewRect() {
  const v = $('#pdf-view');
  return { W: v.clientWidth || 1, H: v.clientHeight || 1 };
}
const DPR = () => Math.min(window.devicePixelRatio || 1, DEVICE === 'phone' ? 3 : 2);
function fitScale(sz) {
  const { W, H } = viewRect();
  const m = 8;
  return S.fit === 'width' ? (W - m * 2) / sz.w : Math.min((W - m * 2) / sz.w, (H - m * 2) / sz.h);
}
function maxZoom(sz) { return Math.min(40, Math.max(3, 4 / fitScale(sz))); }

// 依 zoom、pan 擺放目前這頁（只改 CSS，手勢時每一幀都會呼叫）
function layout() {
  const sz = S.sizes.get(S.cur);
  if (!sz) return;
  const { W, H } = viewRect();
  const sc = fitScale(sz) * S.zoom;
  const pw = sz.w * sc, ph = sz.h * sc;
  // 比畫面小就置中；比畫面大就限制在邊緣以內
  S.panX = pw <= W ? (W - pw) / 2 : Math.min(0, Math.max(W - pw, S.panX));
  S.panY = ph <= H ? (H - ph) / 2 : Math.min(0, Math.max(H - ph, S.panY));
  const pg = $('#pdf-page');
  pg.style.width = `${pw}px`;
  pg.style.height = `${ph}px`;
  pg.style.transform = `translate(${S.panX}px, ${S.panY}px)`;
  if (S.detail) {
    const d = S.detail;
    const k = sc / d.css; // 補畫之後又縮放了：跟著縮放，等停下來再重畫
    d.canvas.style.transform = `translate(${d.x * k}px, ${d.y * k}px) scale(${k})`;
  }
}

// ---------------------------------------------------------------- 換頁、繪製
export async function go(n, first = false) {
  if (!S.doc) return;
  n = Math.max(1, Math.min(S.n, Math.round(n) || 1));
  const token = S.token;
  const t0 = performance.now();
  S.cur = n;
  if (!first) { S.zoom = 1; S.panY = 0; S.panX = 0; }
  $('#pdf-num').value = n;
  $('#pdf-prev').disabled = n <= 1;
  $('#pdf-next').disabled = n >= S.n;
  await pageSize(n);
  if (token !== S.token || S.cur !== n) return;
  dropDetail();
  const pg = $('#pdf-page');
  const have = S.bases.get(n);
  pg.innerHTML = '';
  if (have && have.canvas.width) {
    pg.appendChild(have.canvas);
  } else {
    pg.classList.add('blank');
  }
  layout();
  markThumb();
  if (!have) await renderBase(n);
  if (token !== S.token || S.cur !== n) return;
  const b = S.bases.get(n);
  if (b && b.canvas.parentNode !== pg) { pg.innerHTML = ''; pg.appendChild(b.canvas); }
  pg.classList.remove('blank');
  S.timing.lastFlip = +(performance.now() - t0).toFixed(0);
  document.body.dataset.pdfPage = String(n);
  // 前後一頁先畫好；其他頁的畫布、pdf.js 的頁面資源放掉
  for (const k of [...S.bases.keys()]) {
    if (Math.abs(k - n) > 1) { freeCanvas(S.bases.get(k).canvas); S.bases.delete(k); releasePage(k); }
  }
  idle(async () => {
    for (const k of [n + 1, n - 1]) {
      if (token !== S.token || S.cur !== n) return;
      // 前後頁先畫好底圖，畫完馬上放掉它解開的影像（畫布留著；翻過去要放大時才重新解）→ 記憶體只留目前這頁的影像
      if (k >= 1 && k <= S.n && !S.bases.has(k)) { await pageSize(k); await renderBase(k); if (S.cur !== k) releasePage(k); }
    }
    pumpThumbs();
  });
}

function idle(fn) { (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(() => fn()); }

async function releasePage(n) {
  try { const p = await S.doc.getPage(n); p.cleanup(); } catch (e) { /* 略過 */ }
}

async function renderBase(n) {
  const sz = S.sizes.get(n);
  const dpr = DPR();
  // 底圖：適合畫面的大小 × 裝置像素比，但總像素不超過上限
  let scale = fitScale(sz) * dpr;
  scale = Math.min(scale, Math.sqrt(CAPS.base / (sz.w * sz.h)));
  const c = document.createElement('canvas');
  c.className = 'pdf-base';
  S.rendering++;
  try {
    const page = await S.doc.getPage(n);
    await draw(page, c, scale, 0, 0, Math.ceil(sz.w * scale), Math.ceil(sz.h * scale));
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    throw e;
  } finally {
    S.rendering--;
  }
  const old = S.bases.get(n);
  if (old) freeCanvas(old.canvas);
  S.bases.set(n, { canvas: c, scale });
}

async function draw(page, canvas, scale, offX, offY, w, h) {
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const vp = page.getViewport({ scale });
  const task = page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -offX, -offY],
    annotationMode: pdfjs.AnnotationMode.ENABLE, intent: 'display' });
  canvas._task = task;
  await task.promise;
  canvas._task = null;
  if (S.wm) watermark(ctx, vp.width, vp.height, offX, offY, canvas.width, canvas.height);
}

// 浮水印：以「頁面」為座標（底圖、放大補畫、縮圖的位置都一致）
function watermark(ctx, pw, ph, offX, offY, cw, ch) {
  const unit = Math.min(pw, ph);
  const fs = Math.max(8, unit * 0.045);
  const dx = Math.max(fs * 10, unit * 0.55), dy = fs * 6;
  ctx.save();
  ctx.font = `bold ${fs}px "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1, fs / 10);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.fillStyle = 'rgba(30,40,50,0.30)';
  const ang = -Math.PI / 9;
  for (let row = -1, y = -dy; y < ph + dy; row++, y += dy) {
    for (let x = (row % 2 ? dx / 2 : 0) - dx; x < pw + dx; x += dx) {
      const sx = x - offX, sy = y - offY;
      if (sx < -dx || sy < -dy || sx > cw + dx || sy > ch + dy) continue;
      ctx.setTransform(Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), sx, sy);
      ctx.strokeText(S.wm, 0, 0);
      ctx.fillText(S.wm, 0, 0);
    }
  }
  ctx.restore();
}

// 放大後：只把畫面看得到的那一塊用目前的倍率補畫（像素有上限）
function dropDetail() {
  clearTimeout(S.detailTimer);
  if (S.detail) {
    if (S.detail.canvas._task) S.detail.canvas._task.cancel();
    freeCanvas(S.detail.canvas);
    S.detail = null;
  }
}
function scheduleDetail() {
  clearTimeout(S.detailTimer);
  S.detailTimer = setTimeout(renderDetail, 180);
}
async function renderDetail() {
  const n = S.cur;
  const sz = S.sizes.get(n);
  const base = S.bases.get(n);
  if (!sz || !base || S.gesture) return;
  const dpr = DPR();
  const css = fitScale(sz) * S.zoom;
  if (css * dpr <= base.scale * 1.15) { dropDetail(); return; } // 底圖已經夠清楚
  const { W, H } = viewRect();
  // 看得到的區域（頁面 CSS 座標）
  const x0 = Math.max(0, -S.panX), y0 = Math.max(0, -S.panY);
  const x1 = Math.min(sz.w * css, W - S.panX), y1 = Math.min(sz.h * css, H - S.panY);
  if (x1 <= x0 || y1 <= y0) return;
  let s = css * dpr;
  const area = (x1 - x0) * (y1 - y0) * dpr * dpr;
  if (area > CAPS.detail) s *= Math.sqrt(CAPS.detail / area);
  const k = s / css; // CSS px → 畫布像素
  const c = document.createElement('canvas');
  c.className = 'pdf-detail';
  const t0 = performance.now();
  const page = await S.doc.getPage(n);
  if (n !== S.cur) return;
  const old = S.detail;
  S.detail = { canvas: c, css, x: x0, y: y0 };
  c.style.width = `${(x1 - x0)}px`;
  c.style.height = `${(y1 - y0)}px`;
  c.style.transform = `translate(${x0}px, ${y0}px)`;
  try {
    await draw(page, c, s, x0 * k, y0 * k, Math.ceil((x1 - x0) * k), Math.ceil((y1 - y0) * k));
  } catch (e) {
    if (S.detail && S.detail.canvas === c) S.detail = old;
    freeCanvas(c);
    return;
  }
  if (S.detail && S.detail.canvas === c && n === S.cur) {
    if (old && old.canvas !== c) freeCanvas(old.canvas);
    $('#pdf-page').appendChild(c);
    layout();
    S.timing.lastDetail = +(performance.now() - t0).toFixed(0);
    S.timing.detailPx = c.width * c.height;
    document.body.dataset.pdfDetail = String(Date.now());
  } else {
    freeCanvas(c);
  }
}

// ---------------------------------------------------------------- 縮放、手勢
export function setZoom(z, cx, cy) {
  const sz = S.sizes.get(S.cur);
  if (!sz) return;
  const { W, H } = viewRect();
  cx = cx == null ? W / 2 : cx;
  cy = cy == null ? H / 2 : cy;
  const nz = Math.max(1, Math.min(maxZoom(sz), z));
  const r = nz / S.zoom;
  S.panX = cx - (cx - S.panX) * r;
  S.panY = cy - (cy - S.panY) * r;
  S.zoom = nz;
  layout();
  if (!S.gesture) scheduleDetail();
}
function setFit(f) {
  S.fit = f;
  S.zoom = 1;
  S.panX = S.panY = 0;
  dropDetail();
  for (const b of S.bases.values()) freeCanvas(b.canvas);
  S.bases.clear(); // 底圖的大小跟「適合寬度／整頁」有關，重畫
  $('#pdf-fit').textContent = f === 'width' ? '整頁' : '適合寬度';
  go(S.cur, true);
}

function setupGestures() {
  const v = $('#pdf-view');
  const pts = new Map();
  let start = null, lastTap = 0, swipe = null;
  v.addEventListener('pointerdown', (e) => {
    v.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = v.getBoundingClientRect();
    if (pts.size === 1) {
      swipe = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY, t: performance.now() };
      const now = performance.now();
      if (now - lastTap < 300) { // 點兩下：放大 2.5 倍／回到適合
        setZoom(S.zoom > 1.05 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
        lastTap = 0;
        swipe = null;
      } else lastTap = now;
    }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      start = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.zoom, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, panX: S.panX, panY: S.panY };
      swipe = null;
      S.gesture = true;
      dropDetail();
    }
  });
  v.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = v.getBoundingClientRect();
    if (pts.size === 2 && start) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const sz = S.sizes.get(S.cur);
      const nz = Math.max(1, Math.min(maxZoom(sz), start.z * d / start.d));
      const k = nz / start.z;
      S.zoom = nz;
      S.panX = mx - (start.mx - start.panX) * k;
      S.panY = my - (start.my - start.panY) * k;
      layout();
    } else if (pts.size === 1 && swipe) {
      S.panX = swipe.panX + (e.clientX - swipe.x);
      S.panY = swipe.panY + (e.clientY - swipe.y);
      if (Math.abs(e.clientX - swipe.x) + Math.abs(e.clientY - swipe.y) > 6) { S.gesture = true; lastTap = 0; }
      layout();
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 1 && start) { // 放開一指：剩下的那指接著平移
      const [a] = [...pts.values()];
      swipe = { x: a.x, y: a.y, panX: S.panX, panY: S.panY, t: performance.now() };
      start = null;
      return;
    }
    if (pts.size) return;
    // 沒放大、左右滑超過 60 px：翻頁
    if (swipe && S.zoom <= 1.02) {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      const sz = S.sizes.get(S.cur);
      const pageTall = sz && sz.h * fitScale(sz) > viewRect().H + 2;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { go(S.cur + (dx < 0 ? 1 : -1)); swipe = null; S.gesture = false; return; }
      if (!pageTall && Math.abs(dy) > 80 && Math.abs(dy) > Math.abs(dx) * 1.5) { go(S.cur + (dy < 0 ? 1 : -1)); swipe = null; S.gesture = false; return; }
    }
    start = null;
    swipe = null;
    S.gesture = false;
    scheduleDetail();
  };
  v.addEventListener('pointerup', up);
  v.addEventListener('pointercancel', up);
  let wheelAcc = 0, wheelT = 0;
  v.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = v.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { // 觸控板捏合、Ctrl＋滾輪：縮放
      setZoom(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    const before = S.panY;
    S.panY -= e.deltaY;
    S.panX -= e.deltaX;
    layout();
    if (Math.abs(S.panY - before) < 1) { // 已經到頁首／頁尾：再捲就翻頁
      const now = performance.now();
      if (now - wheelT > 400) wheelAcc = 0;
      wheelT = now;
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) > 220) { const dir = Math.sign(wheelAcc); wheelAcc = 0; go(S.cur + dir).then(() => { if (dir < 0) { S.panY = -1e9; layout(); } }); }
    } else {
      wheelAcc = 0;
      scheduleDetail();
    }
  }, { passive: false });
  window.addEventListener('resize', () => { if (S.open) { for (const b of S.bases.values()) freeCanvas(b.canvas); S.bases.clear(); dropDetail(); go(S.cur, true); } });
  window.addEventListener('keydown', (e) => {
    if (!S.open || e.target.tagName === 'INPUT') return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { go(S.cur + 1); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { go(S.cur - 1); e.preventDefault(); }
    else if (k === 'Home') go(1);
    else if (k === 'End') go(S.n);
    else if (k === '+' || k === '=') setZoom(S.zoom * 1.4);
    else if (k === '-') setZoom(S.zoom / 1.4);
  });
}

// ---------------------------------------------------------------- 縮圖列
function buildThumbs() {
  const box = $('#pdf-thumbs');
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= S.n; i++) {
    const b = document.createElement('button');
    b.className = 'pthumb';
    b.dataset.n = i;
    b.innerHTML = `<span class="pt-img"></span><span class="pt-n">${i}</span>`;
    frag.appendChild(b);
  }
  box.appendChild(frag);
  if (S.thumbObs) S.thumbObs.disconnect();
  S.thumbObs = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const n = Number(en.target.dataset.n);
      if (en.isIntersecting && !en.target.dataset.done) { if (!S.thumbQ.includes(n)) S.thumbQ.push(n); }
      else if (!en.isIntersecting) S.thumbQ = S.thumbQ.filter((x) => x !== n);
    }
    pumpThumbs();
  }, { root: box, rootMargin: '0px 120px' });
  for (const b of box.children) S.thumbObs.observe(b);
}
function markThumb() {
  const box = $('#pdf-thumbs');
  const old = box.querySelector('.pthumb.cur');
  if (old) old.classList.remove('cur');
  const b = box.children[S.cur - 1];
  if (b) {
    b.classList.add('cur');
    if (!box.hidden) b.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}
async function pumpThumbs() {
  if ($('#pdf-thumbs').hidden || !S.doc) return;
  while (S.thumbQ.length && S.thumbBusy < CAPS.thumbs && !S.rendering) {
    const n = S.thumbQ.shift();
    const el = $('#pdf-thumbs').children[n - 1];
    if (!el || el.dataset.done) continue;
    S.thumbBusy++;
    const token = S.token;
    try {
      const page = await S.doc.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      const s = (56 * DPR()) / v1.width;
      const c = document.createElement('canvas');
      await draw(page, c, s, 0, 0, Math.ceil(v1.width * s), Math.ceil(v1.height * s));
      if (token !== S.token) { freeCanvas(c); return; }
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.7));
      freeCanvas(c);
      if (blob) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.alt = '';
        el.querySelector('.pt-img').appendChild(img);
        el.dataset.done = '1';
      }
      if (Math.abs(n - S.cur) > 1) page.cleanup();
    } catch (e) { /* 縮圖失敗不影響主畫面 */ } finally {
      S.thumbBusy--;
    }
  }
}

// ---------------------------------------------------------------- 初始化
export function init(hooks) {
  ui = hooks;
  setupGestures();
  $('#pdf-prev').addEventListener('click', () => go(S.cur - 1));
  $('#pdf-next').addEventListener('click', () => go(S.cur + 1));
  $('#pdf-num').addEventListener('change', (e) => go(Number(e.target.value)));
  $('#pdf-num').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); go(Number(e.target.value)); } });
  $('#pdf-fit').addEventListener('click', () => setFit(S.fit === 'width' ? 'page' : 'width'));
  $('#pdf-thumb-btn').addEventListener('click', () => {
    const box = $('#pdf-thumbs');
    box.hidden = !box.hidden;
    $('#pdf-thumb-btn').classList.toggle('on', !box.hidden);
    try { localStorage.setItem('skpv-pdf-thumbs', box.hidden ? '0' : '1'); } catch (e) { /* 略過 */ }
    if (S.open) { for (const b of S.bases.values()) freeCanvas(b.canvas); S.bases.clear(); go(S.cur, true); }
    markThumb();
    pumpThumbs();
  });
  let showThumbs = DEVICE !== 'phone';
  try { const v = localStorage.getItem('skpv-pdf-thumbs'); if (v != null) showThumbs = v === '1'; } catch (e) { /* 略過 */ }
  $('#pdf-thumbs').hidden = !showThumbs;
  $('#pdf-thumb-btn').classList.toggle('on', showThumbs);
  $('#pdf-thumbs').addEventListener('click', (e) => {
    const b = e.target.closest('.pthumb');
    if (b) go(Number(b.dataset.n));
  });
  // 測試用
  window.skpvPdf = {
    go, setZoom, info, get state() { return { cur: S.cur, n: S.n, zoom: +S.zoom.toFixed(3), fit: S.fit, panX: Math.round(S.panX), panY: Math.round(S.panY),
      bases: [...S.bases.keys()], detail: S.detail ? [S.detail.canvas.width, S.detail.canvas.height] : null, wm: S.wm, rendering: S.rendering }; },
    // 浮水印有沒有畫進 canvas：同一頁有／沒有浮水印各畫一次，比較像素
    async wmProbe() {
      const page = await S.doc.getPage(S.cur);
      const a = document.createElement('canvas'), b = document.createElement('canvas');
      const keep = S.wm;
      await draw(page, a, 0.5, 0, 0, Math.ceil(S.sizes.get(S.cur).w * 0.5), Math.ceil(S.sizes.get(S.cur).h * 0.5));
      S.wm = '';
      await draw(page, b, 0.5, 0, 0, a.width, a.height);
      S.wm = keep;
      const pa = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, pb = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
      let diff = 0;
      for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 12) diff++;
      freeCanvas(a); freeCanvas(b);
      return { on: !!keep, text: keep, diffRatio: +(diff / (pa.length / 4)).toFixed(4) };
    },
    // 目前底圖中央的像素（測試用：確認畫出來的不是空白）
    sample() {
      const b = S.bases.get(S.cur);
      if (!b) return null;
      const c = b.canvas, g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] < 200) dark++;
      return { w: c.width, h: c.height, darkRatio: +(dark / (d.length / 16)).toFixed(4) };
    },
  };
}
