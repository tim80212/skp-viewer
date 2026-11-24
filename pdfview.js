// PDF 檢視（v0.7.0）。pdf.js 4.10.38（Apache-2.0，lib/pdfjs/，legacy 版：舊 iPhone 也能跑），開 PDF 時才載入。
//
// 順暢度（大檔、幾百頁、掃描、A1 圖面，手機也要能開）：
// - 分段讀取：Google Drive 的下載支援 Range（CORS 允許 range 標頭），pdf.js 只抓「畫目前這頁需要的那幾段」，
//   不用先下載整個檔案；用我們自己的 fetch（cache:'no-store'、credentials:'omit'）→ 不進瀏覽器快取。
// - 一次只畫目前這頁，前後一頁先畫好（翻頁不用等），其他頁的畫布和 pdf.js 的頁面資源都放掉。
// - 底圖的像素有上限（手機 300 萬）；放大時底圖用 CSS 放大（手勢很順），停下來後只把「看得到的那一塊」用高解析度補畫。
// - 縮圖列：看到的才畫、一次一張、主畫面在畫的時候先等。
// - 分享：浮水印「#代號・僅供檢視・日期」畫進每一頁的 canvas（不是蓋在上面的 HTML）。
// v0.7.1：桌面程式在 PDF 裡放了每頁的預覽圖（WebP，長邊 1600 px）和縮圖，檔頭 `%SKPV-PREVIEW 位置 長度` 指到索引。
//   有預覽：先秀預覽（瀏覽器原生解圖、在背景執行緒，很快），pdf.js 同時在背景開檔；預覽夠清楚就不用 pdf.js 畫，
//   不夠清楚（電腦高解析度螢幕）才在背景畫清晰版換上去；放大時照舊只補畫看得到的區域。縮圖列直接用縮圖，不用 pdf.js。
import { DEVICE, TOUCH_UI, step } from './device.js';
import { Source } from './pdfdata.js';
import * as offline from './offline.js';

const $ = (s) => document.querySelector(s);
const CAPS = {
  phone: { base: 3.0e6, detail: 3.5e6, maxImage: 40e6, thumbs: 1 },
  tablet: { base: 6e6, detail: 6e6, maxImage: 120e6, thumbs: 1 },
  desktop: { base: 12e6, detail: 10e6, maxImage: -1, thumbs: 2 },
}[DEVICE] || { base: 6e6, detail: 6e6, maxImage: -1, thumbs: 1 };
const RANGE_CHUNK = 256 * 1024;
const FIRST_CHUNK = 64 * 1024; // v0.9.0：開檔先讀 64 KB（檔頭、索引的位置；其他的跟著背景下載進來）

let pdfjs = null;
let ui = null;
const S = {
  doc: null, task: null, n: 0, cur: 1, fit: 'width', zoom: 1, panX: 0, panY: 0, sizes: new Map(),
  bases: new Map(), // 頁碼 → { canvas, scale }
  detail: null, detailTimer: 0, rendering: 0, wm: '', name: '', bytes: 0, fetched: 0, requests: 0,
  open: false, token: 0, mode: '', timing: {}, thumbObs: null, thumbQ: [], thumbBusy: 0, gesture: false,
  pv: null, pvCache: new Map(), pvFail: false, head: null, get: null, docReady: null, stats: { previews: 0, sharp: 0, detail: 0 },
  tl: null, tc: null, tcache: new Map(), tcachePx: 0, tq: new Map(), tinflight: 0, tdraw: 0, tview: 0, tstat: { tiles: 0, bytes: 0, reqs: 0 },
};
const PV_TAG = '%SKPV-PREVIEW ';
const NO_VECTOR = new URLSearchParams(location.search).get('vector') === '0';
// v0.8.0 圖磚：一次最多幾個請求、相鄰多近就合併成一個請求、快取多少像素
const TL = { conc: 4, gap: 24 * 1024, maxReq: 3 * 1048576, blockMax: 8 * 1048576, cachePx: DEVICE === 'phone' ? 48e6 : DEVICE === 'tablet' ? 80e6 : 160e6 };

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
// src：{ data: ArrayBuffer, cached? } 或 { size, open(begin, end, signal) → Promise<Response> }（Range 請求）或 Source
// keep：擁有者（自己登入、自己的檔案）{ id, name, modifiedTime, md5, cached? } → 下載完存在這台裝置（offline.js）。分享連結一律 null
export async function openPdf(src, { name = '', share = null, t0 = performance.now(), hooks, keep = null } = {}) {
  ui = hooks || ui;
  const lib0 = performance.now();
  // pdf.js（約 1.8 MB）：有圖磚（v0.8.0）的檔案完全不載入；有預覽（v0.7.1）的跟第一段資料同時下載
  let libP = null;
  const getLib = () => {
    if (!libP) {
      libP = lib();
      libP.then(() => { S.timing.lib = +(performance.now() - lib0).toFixed(0); }).catch(() => {});
    }
    return libP;
  };
  close();
  const token = ++S.token;
  S.name = name;
  S.fetched = 0;
  S.requests = 0;
  S.pv = null;
  S.pvFail = false;
  S.head = null;
  S.timing = { startNav: Math.round(t0), openPdfNav: Math.round(performance.now()) }; // 從打開網頁算起的時間點（速度紀錄）
  S.t0 = t0;
  S.stats = { previews: 0, sharp: 0, detail: 0 };
  S.docReady = null;
  S.tl = null;
  S.tstat = { tiles: 0, bytes: 0, reqs: 0 };
  const common = {
    cMapUrl: new URL('./lib/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL('./lib/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false, enableXfa: false, maxImageSize: CAPS.maxImage, disableFontFace: false,
    useSystemFonts: true, stopAtErrors: false,
  };
  // v0.9.0：資料一律經過 Source（pdfdata.js）：開檔就在背景把整個檔案分 4 段下載到記憶體，讀的時候有就直接拿
  if (S.src) { S.src.close(); S.src = null; }
  const source = src instanceof Source ? src : new Source(src.data ? { data: src.data, cached: !!src.cached } : { size: src.size, open: src.open, pre: src.pre || null });
  S.src = source;
  S.keep = keep || null;
  S.bytes = source.size;
  source.on(() => netUi());
  source.startFull();
  netUi();
  const firstP = source.read(0, Math.min(source.size, FIRST_CHUNK));
  firstP.catch(() => {});
  S.get = (off, len) => source.read(off, len);
  // v0.10.0：擁有者、有每頁的圖（桌面程式上傳到 Drive，網頁從 lh3 抓）：不用等 Drive 下載 PDF 就能看。PDF 照樣在背景下載（放大看向量、存在裝置上）
  const imgTl = !share && src.images ? imagesTl(src.images) : null;
  let first = null;
  if (!imgTl) {
    first = await firstP;
    if (token !== S.token) return null;
    if (!isPdf(first)) throw new Error('這不是 PDF 檔。');
    S.timing.headNav = Math.round(performance.now());
    S.head = first;
  }
  S.mode = source.state === 'done' ? 'data' : 'range';
  const makeParams = (P) => {
    const tr = new P.PDFDataRangeTransport(source.size, new Uint8Array(first.slice(0)));
    tr.requestDataRange = (begin, end) => {
      S.requests++;
      source.read(begin, end - begin).then((buf) => {
        tr.onDataRange(begin, new Uint8Array(buf));
        progress();
      }).catch((e) => { S.rangeError = e; ui && ui.toast && ui.toast('下載 PDF 時網路中斷，請重新整理再試一次', 5000); });
    };
    return { ...common, range: tr, length: source.size, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
  };
  const startDoc = async () => {
    if (!first) first = await firstP;
    const P = await getLib();
    if (token !== S.token) throw new Error('canceled');
    S.task = P.getDocument(makeParams(P));
    return S.task.promise;
  };
  // v0.7.1：先看檔案裡有沒有預覽（有的話不用等 pdf.js 開檔就能先顯示）
  if (!imgTl) {
    try { S.pv = await readIndex(first); } catch (e) { S.pv = null; }
    S.timing.indexNav = Math.round(performance.now());
    if (token !== S.token) return null;
  }
  let shareInfo = null;
  if (imgTl) {
    S.tl = imgTl;
    S.n = imgTl.pages.length;
    imgTl.pages.forEach((p, i) => S.sizes.set(i + 1, { w: p.w, h: p.h }));
    S.docReady = null;
    S.startDoc = startDoc;
    // 背景：PDF 的檔頭到了就讀圖磚索引（lh3 的圖抓不到時改用 PDF 的圖磚）
    firstP.then(async (buf) => {
      if (token !== S.token || !isPdf(buf)) return;
      S.head = buf;
      S.timing.headNav = Math.round(performance.now());
      const js = await readIndex(buf);
      if (token === S.token && js && js.v >= 2) S.pdfTl = tilesFrom(js);
      if (S.imgFail && S.pdfTl) usePdfTiles('lh3 failed');
    }).catch(() => {});
  } else if (S.pv && S.pv.v >= 2) { // v0.8.0：圖磚，不用 pdf.js（v0.9.0：v3＝第 1 頁和縮圖放前面）
    S.tl = tilesFrom(S.pv);
    S.pv = null;
    shareInfo = S.tl.share || null;
    checkShare(shareInfo, share);
    S.n = S.tl.pages.length;
    S.tl.pages.forEach((p, i) => S.sizes.set(i + 1, { w: p.w, h: p.h }));
    S.docReady = null; // pdf.js 等到「放大超過圖磚」才載入
    S.startDoc = startDoc;
  } else if (S.pv) {
    getLib();
    shareInfo = S.pv.share || null;
    checkShare(shareInfo, share);
    S.n = S.pv.pages.length;
    S.pv.pages.forEach((p, i) => S.sizes.set(i + 1, { w: p[8], h: p[9] }));
    S.docReady = startDoc().then(async (doc) => {
      if (token !== S.token) { doc.destroy(); return null; }
      S.doc = doc;
      S.timing.docReady = +(performance.now() - t0).toFixed(0);
      const inf = await shareFromInfo(doc);
      if ((inf && inf.code) !== (shareInfo && shareInfo.code)) { // 預覽索引和文件資訊不一致：當成不是分享副本
        close();
        if (ui && ui.showProblem) ui.showProblem('文件開不起來', '這個檔案的分享資訊不一致，不能開啟。', true);
        return null;
      }
      return doc;
    });
    S.docReady.catch(() => { if (token === S.token && ui && ui.toast) ui.toast('PDF 開不起來（預覽可以看，放大時沒辦法補清楚）', 5000); });
  } else {
    getLib();
    const doc = await startDoc();
    if (token !== S.token) { doc.destroy(); return null; }
    S.doc = doc;
    S.docReady = Promise.resolve(doc);
    S.n = doc.numPages;
    shareInfo = await shareFromInfo(doc);
    checkShare(shareInfo, share);
  }
  const d = new Date();
  S.wm = shareInfo ? `#${shareInfo.code}・僅供檢視・${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
  S.share = shareInfo;
  S.open = true;
  netUi();
  S.cur = 1;
  S.fit = TOUCH_UI && innerWidth > innerHeight ? 'page' : 'width'; // v0.10.2：觸控、橫向一開始整頁
  fitUi();
  S.zoom = 1;
  $('#pdf-count').textContent = S.n;
  buildThumbs();
  S.timing = { ...S.timing, open: +(performance.now() - t0).toFixed(0), preview: !!S.pv };
  await go(1, true);
  S.timing.firstPage = +(performance.now() - t0).toFixed(0);
  S.timing.bytesAtFirstPage = source.received;
  S.timing.firstPageNav = Math.round(performance.now()); // 從打開網頁算起
  step('pdf first page');
  window.__skpvPdfTiming = S.timing;
  if (TOUCH_UI && DEVICE === 'phone' && innerWidth > innerHeight && new URLSearchParams(location.search).get('autohide') !== '0') {
    const tk = S.token;
    setTimeout(() => { // v0.10.3：手機橫向一開檔就收起（看圖面積最大），點一下才出現
      if (tk !== S.token || $('#app').classList.contains('chrome-off')) return;
      toggleChrome(true);
      if (!S.hintShown && ui && ui.toast) { S.hintShown = true; ui.toast('點一下畫面：顯示工具', 2500); }
    }, 1200);
  }
  if (S.keep) keepWhenDone(token);
  return { pages: S.n, share: shareInfo, mode: S.mode, bytes: S.bytes, preview: !!S.pv, tiles: !!S.tl, images: !!(S.tl && S.tl.images), full: source.state };
}

// 分享副本（第 2 層）：檔案裡寫著代號和到期時間，過期就不顯示（存了檔、換個方式打開也一樣）
function checkShare(info, share) {
  if (info) {
    const exp = Date.parse(info.expires);
    if (!exp || exp <= Date.now()) { close(); throw new Error(`這個分享副本（#${info.code}）已經過期，不能再開啟。`); }
    if (share && share.code !== info.code) { close(); throw new Error('分享副本的代號和連結不符，不能開啟。'); }
  } else if (share) {
    close();
    throw new Error('這不是分享副本，不能用分享連結開啟。');
  }
}
async function shareFromInfo(doc) {
  let info = {};
  try { info = ((await doc.getMetadata()).info || {}).Custom || {}; } catch (e) { /* 沒有就算了 */ }
  return info.SKPVCode ? { code: String(info.SKPVCode), expires: String(info.SKPVExpires || '') } : null;
}

// ---------------------------------------------------------------- 預覽（v0.7.1）
async function readIndex(buf) {
  if (!buf) return null;
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(4096, buf.byteLength)));
  const i = head.indexOf(PV_TAG);
  if (i < 0) return null;
  const m = /^%SKPV-PREVIEW (\d{12}) (\d{12})/.exec(head.slice(i));
  if (!m) return null;
  const js = JSON.parse(new TextDecoder().decode(await S.get(Number(m[1]), Number(m[2]))));
  if (!js || ![1, 2, 3].includes(js.v) || !Array.isArray(js.pages) || !js.pages.length) return null;
  return js;
}
function previewBitmap(n) {
  if (S.pvCache.has(n)) return S.pvCache.get(n);
  const p = S.pv.pages[n - 1];
  const pr = S.get(p[0], p[1]).then((buf) => createImageBitmap(new Blob([buf], { type: `image/${S.pv.fmt || 'webp'}` })));
  S.pvCache.set(n, pr);
  for (const k of [...S.pvCache.keys()]) { // 只留附近幾頁
    if (Math.abs(k - n) > 2) { S.pvCache.get(k).then((b) => b.close && b.close()).catch(() => {}); S.pvCache.delete(k); }
  }
  pr.catch(() => S.pvCache.delete(n));
  return pr;
}
async function previewCanvas(n) {
  const bm = await previewBitmap(n);
  const c = document.createElement('canvas');
  c.className = 'pdf-base';
  c.width = bm.width;
  c.height = bm.height;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.drawImage(bm, 0, 0);
  if (S.wm) watermark(ctx, bm.width, bm.height, 0, 0, c.width, c.height);
  S.stats.previews++;
  return c;
}

export function close() {
  S.token++;
  S.open = false;
  if (S.src) { S.src.close(); S.src = null; }
  S.keep = null;
  S.keepSaved = false;
  S.keepTried = false;
  if ($('#pdf-net')) $('#pdf-net').hidden = true;
  if ($('#pdf-dl')) $('#pdf-dl').hidden = true;
  if ($('#pdf-debug')) $('#pdf-debug').hidden = true;
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
  for (const pr of S.pvCache.values()) pr.then((b) => b.close && b.close()).catch(() => {});
  S.pvCache.clear();
  for (const t of S.tcache.values()) if (t.bmp && t.bmp.close) t.bmp.close();
  S.tcache.clear();
  S.tcachePx = 0;
  S.tq.clear();
  S.tl = null;
  S.pdfTl = null;
  S.imgFail = 0;
  if (S.tdet) { if (S.tdet.canvas) freeCanvas(S.tdet.canvas); S.tdet = null; }
  clearTimeout(S.tvecTimer);
  if (S.tc) { freeCanvas(S.tc); S.tc = null; }
  $('#pdf-page').style.display = '';
}

export function info() {
  const net = S.src ? S.src.stats() : null;
  return { name: S.name, pages: S.n, bytes: S.bytes, mode: S.mode, fetched: net ? net.received : S.fetched, requests: net ? net.requests : S.requests,
    share: S.share, timing: S.timing, preview: !!S.pv && !S.pvFail, stats: { ...S.stats }, docReady: !!S.doc, tiles: !!S.tl,
    images: !!(S.tl && S.tl.images), imgFail: S.imgFail || 0,
    tileStats: { ...S.tstat, cached: S.tcache.size, net }, pdfjsLoaded: !!pdfjs, keep: S.keep ? { saved: !!S.keepSaved, cached: !!S.keep.cached } : null };
}

function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; c.remove(); } }

function progress() { netUi(); }

// ---------------------------------------------------------------- 離線準備（v0.9.0）
// 右上角的小標籤：背景下載的進度 → 下載完（翻頁、放大都不用再上網）；擁有者的檔案存在這台裝置上（下次秒開、沒網路也能開）
const mbText = (b) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;
function netState() {
  const src = S.src;
  if (!src) return { text: '', cls: '' };
  if (S.keep && S.keep.cached) return { text: '✓ 這台裝置上的版本', cls: 'ok', long: `這份文件存在這台裝置上（${mbText(src.size)}），沒有網路也能開。` };
  if (src.state === 'loading') {
    const p = Math.floor(src.progress * 100);
    return { text: `離線準備 ${p}%`, cls: 'busy', long: `正在背景下載整份文件（${mbText(src.received)} / ${mbText(src.size)}）。下載完以後翻頁、放大都不用再上網。` };
  }
  if (src.state === 'done') {
    if (S.keep && S.keepSaved) return { text: '✓ 已存在這台裝置', cls: 'ok', long: `這份文件已經存在這台裝置上（${mbText(src.size)}），下次打開不用下載，現場沒有網路也能開。` };
    if (S.keep) return { text: '✓ 已下載', cls: 'ok', long: `整份文件已經下載到記憶體（${mbText(src.size)}），翻頁、放大都不用再上網。` };
    return { text: '✓ 已下載', cls: 'ok', long: `整份文件已經下載到這一頁的記憶體（${mbText(src.size)}），翻頁、放大都不用再上網。${S.share ? '關掉網頁就清掉，不會存在這台裝置上。' : ''}` };
  }
  if (src.state === 'off') return { text: '只下載看到的頁', cls: '', long: `這份文件很大（${mbText(src.size)}），只下載看到的頁（每頁要等網路）。` };
  if (src.state === 'failed') return { text: '下載中斷', cls: 'warn', long: '背景下載中斷了：之後看到的頁會一頁一頁從網路抓（比較慢）。' };
  return { text: '', cls: '', long: '' };
}
function netUi() {
  const el = $('#pdf-net');
  if (!el) return;
  const st = netState();
  el.hidden = !S.open || !st.text;
  el.textContent = st.text;
  el.className = 'pdf-net ' + st.cls;
  if (!$('#pdf-dl').hidden) dlPanel();
  if (S.debug) debugUi();
}
function dlPanel() {
  const st = netState();
  $('#pdf-dl-text').textContent = st.long || '';
  const owner = !!S.keep;
  $('#pdf-dl-save').hidden = !owner || S.keep.cached || S.keepSaved;
  $('#pdf-dl-save').disabled = !(S.src && S.src.state === 'done');
  $('#pdf-dl-save').textContent = S.src && S.src.state === 'done' ? '下載到這台裝置（現場離線用）' : '下載到這台裝置（下載完才能存）';
  $('#pdf-dl-clear').hidden = !owner || !(S.keep.cached || S.keepSaved);
  $('#pdf-dl-note').hidden = owner;
}
async function saveKeep() {
  const src = S.src, k = S.keep;
  if (!src || !k || k.cached || src.state !== 'done') return false;
  const blob = src.blob();
  if (!blob) return false;
  try {
    await offline.put({ id: k.id, name: k.name, size: src.size, modifiedTime: k.modifiedTime || '', md5: k.md5 || '', blob });
    if (S.keep === k) { S.keepSaved = true; netUi(); }
    return true;
  } catch (e) {
    if (ui && ui.toast) ui.toast('這台裝置的儲存空間不夠，沒辦法存下來（照樣可以看）', 4000);
    return false;
  }
}
// 擁有者：背景下載完就自動存在這台裝置上（下次秒開、沒網路也能開）
function keepWhenDone(token) {
  if (!S.keep || S.keep.cached) return;
  const check = () => {
    if (token !== S.token || !S.src) return true;
    if (S.src.state === 'done') { if (!S.keepSaved && !S.keepTried) { S.keepTried = true; saveKeep(); } return true; }
    return S.src.state === 'off' || S.src.state === 'failed';
  };
  if (check()) return;
  const off = S.src.on(() => { if (check()) off(); });
}
function debugUi() {
  const el = $('#pdf-debug');
  el.hidden = !S.debug || !S.open;
  if (el.hidden || !S.src) return;
  const n = S.src.stats();
  const t = S.timing || {};
  el.textContent = [
    `檔案 ${mbText(n.size)}・${n.state}${n.cached ? '（裝置）' : ''}・已下載 ${Math.round(100 * n.received / (n.size || 1))}%`,
    `請求 ${n.requests} 個（自己抓 ${n.ownRequests}）・等待 中位 ${n.waitMedianMs ?? '-'} / 最久 ${n.waitMaxMs ?? '-'} ms・${n.MBps ?? '-'} MB/s`,
    `第一頁 ${t.firstPage ?? '-'} ms・清楚 ${t.firstSharp ?? '-'} ms・整份 ${n.fullMs ?? '-'} ms・翻頁 ${t.lastFlip ?? '-'} ms・清楚 ${t.lastSharp ?? '-'} ms`,
  ].join(String.fromCharCode(10));
}
function speedLog() {
  return JSON.stringify({ app: 'skpv-pdf', at: new Date().toISOString(), device: DEVICE, ua: navigator.userAgent, name: S.share ? `#${S.share.code}` : S.name,
    pages: S.n, timing: S.timing, steps: window.__skpvSteps || [], net: S.src ? S.src.stats() : null, tiles: { ...S.tstat } });
}

// ---------------------------------------------------------------- 尺寸、版面
async function pageSize(n) {
  if (!S.sizes.has(n)) {
    await S.docReady;
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
  return fitScaleWH(sz, W, H);
}
function fitScaleWH(sz, W, H) {
  const m = 8;
  W -= insetR(W, H);
  return S.fit === 'width' ? (W - m * 2) / sz.w : Math.min((W - m * 2) / sz.w, (H - m * 2) / sz.h);
}
// v0.10.3：觸控、橫向、工具顯示時，右邊直立的工具佔掉的寬度（整頁、置中都扣掉它，圖的右緣不會被蓋住）
function insetR(W, H) {
  if (!TOUCH_UI || W <= H || $('#app').classList.contains('chrome-off')) return 0;
  const t = $('#pdf-tools');
  return t ? Math.round(t.getBoundingClientRect().width) + 12 : 0;
}
function maxZoom(sz) { return Math.min(40, Math.max(3, 4 / fitScale(sz))); }

// 依 zoom、pan 擺放目前這頁（只改 CSS，手勢時每一幀都會呼叫）
function layout() {
  const sz = S.sizes.get(S.cur);
  if (!sz) return;
  if (S.tl) { clampPan(sz); if (!S.tview) S.tview = performance.now(); requestDraw(); return; }
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
  if (!S.open && !first) return;
  if (S.tl) return tileGo(n, first);
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
  if (!have) await showBase(n);
  if (token !== S.token || S.cur !== n) return;
  const b = S.bases.get(n);
  if (b && b.canvas.parentNode !== pg) { pg.innerHTML = ''; pg.appendChild(b.canvas); }
  pg.classList.remove('blank');
  sharpen(n);
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
      if (k >= 1 && k <= S.n && !S.bases.has(k)) {
        await pageSize(k);
        await showBase(k);
        // v0.10.3：畫的時候已經跳到很遠的頁（例如輸入頁碼）：這張不要了（以前會留著，記憶體多一張）
        if (S.cur !== n && Math.abs(k - S.cur) > 1 && S.bases.has(k)) { freeCanvas(S.bases.get(k).canvas); S.bases.delete(k); releasePage(k); return; }
        if (S.bases.get(k) && !S.bases.get(k).preview && S.cur !== k) releasePage(k);
      }
    }
    pumpThumbs();
  });
}

function idle(fn) { (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(() => fn()); }

async function releasePage(n) {
  if (!S.doc) return;
  try { const p = await S.doc.getPage(n); p.cleanup(); } catch (e) { /* 略過 */ }
}

// 這一頁先顯示什麼：有預覽就用預覽（不用 pdf.js），沒有（或解不開）才用 pdf.js 畫
async function showBase(n) {
  if (S.pv && !S.pvFail) {
    try {
      const c = await previewCanvas(n);
      const old = S.bases.get(n);
      if (old) freeCanvas(old.canvas);
      S.bases.set(n, { canvas: c, scale: c.width / S.sizes.get(n).w, preview: true });
      return;
    } catch (e) {
      S.pvFail = true; // 這台的瀏覽器解不開 WebP 之類：改用 pdf.js
    }
  }
  await renderBase(n);
}
// 預覽不夠清楚（例：電腦高解析度螢幕、適合寬度）：在背景用 pdf.js 畫清晰版換上去
async function sharpen(n) {
  const b = S.bases.get(n);
  const sz = S.sizes.get(n);
  if (!b || !b.preview || !sz) return;
  const need = Math.min(fitScale(sz) * DPR(), Math.sqrt(CAPS.base / (sz.w * sz.h)));
  if (b.scale >= need * 0.9) return; // 預覽已經夠清楚
  if (b.sharpening) return;
  b.sharpening = true;
  try {
    await S.docReady;
    if (S.cur !== n || !S.doc) return;
    const keep = b.canvas;
    await renderBase(n);
    const nb = S.bases.get(n);
    if (S.cur === n && nb && nb.canvas !== keep) {
      const pg = $('#pdf-page');
      if (keep.parentNode === pg) { pg.replaceChild(nb.canvas, keep); layout(); }
      S.stats.sharp++;
      S.timing.lastSharp = Date.now();
    }
  } catch (e) { /* 清晰版畫不出來就留著預覽 */ }
}

async function renderBase(n) {
  if (!S.docReady && S.startDoc) S.docReady = S.startDoc();
  await S.docReady;
  if (!S.doc) return;
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
  if (S.tl) return;
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
  await S.docReady;
  if (!S.doc) return;
  const page = await S.doc.getPage(n);
  if (n !== S.cur) return;
  S.stats.detail++;
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
function fitUi() {
  const b = $('#pdf-fit');
  b.textContent = '整頁';
  b.classList.toggle('on', S.fit === 'page');
  b.title = S.fit === 'page' ? '目前：整頁（再按一次：適合寬度）' : '目前：適合寬度（按一下：整頁）';
}
function setFit(f) {
  S.fit = f;
  S.zoom = 1;
  S.panX = S.panY = 0;
  dropDetail();
  for (const b of S.bases.values()) freeCanvas(b.canvas);
  S.bases.clear(); // 底圖的大小跟「適合寬度／整頁」有關，重畫
  fitUi();
  go(S.cur, true);
}

function setupGestures() {
  const v = $('#pdf-view');
  const pts = new Map();
  let start = null, lastTap = 0, swipe = null, tapT = 0;
  v.addEventListener('pointerdown', (e) => {
    v.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = v.getBoundingClientRect();
    if (pts.size === 1) {
      swipe = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY, t: performance.now() };
      const now = performance.now();
      if (now - lastTap < 300) { // 點兩下：放大 2.5 倍／回到適合
        clearTimeout(tapT); // 不是單擊
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
    // v0.10.2 觸控模式：單擊（沒移動、很快放開）＝收起／顯示工具（等 0.3 秒確定不是點兩下）
    if (TOUCH_UI && swipe && !S.gesture && Math.abs(e.clientX - swipe.x) + Math.abs(e.clientY - swipe.y) < 10 && performance.now() - swipe.t < 300) {
      clearTimeout(tapT);
      tapT = setTimeout(() => {
        if (performance.now() - lastTap < 290) return;
        if (!$('#pdf-thumbs').hidden) closeThumbs(); else toggleChrome(); // v0.10.3：縮圖開著先收縮圖
      }, 310);
    }
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
  // v0.10.2：畫面大小改變（轉方向、收起工具、視窗大小）：畫面中心看的那一點不變（以前會回到頁首）
  let lastVR = null;
  const onResize = () => {
    const vr = viewRect();
    if (lastVR && lastVR.W === vr.W && lastVR.H === vr.H) return;
    const sz = S.open && S.sizes.get(S.cur);
    if (sz && lastVR && S.tl) {
      const s0 = fitScaleWH(sz, lastVR.W, lastVR.H) * S.zoom, s1 = fitScale(sz) * S.zoom;
      const px = (lastVR.W / 2 - S.panX) / s0, py = (lastVR.H / 2 - S.panY) / s0;
      S.panX = vr.W / 2 - px * s1;
      S.panY = vr.H / 2 - py * s1;
    }
    lastVR = vr;
    if (!S.open) return;
    if (S.tl) { layout(); return; }
    for (const b of S.bases.values()) freeCanvas(b.canvas);
    S.bases.clear();
    dropDetail();
    go(S.cur, true);
  };
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(v); else window.addEventListener('resize', onResize);
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
  if ($('#pdf-thumbs').hidden) return;
  if (S.tl) return pumpTileThumbs();
  if (S.pv && !S.pvFail) return pumpPvThumbs();
  if (!S.doc) return;
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

// 縮圖（v0.7.1）：檔案裡的小縮圖，看得到的那幾張一次抓（連續的一段），不用 pdf.js、不搶主畫面
async function pumpPvThumbs() {
  if (S.thumbBusy || !S.thumbQ.length) return;
  S.thumbBusy = 1;
  const token = S.token;
  try {
    while (S.thumbQ.length && token === S.token) {
      const want = S.thumbQ.splice(0, 24).sort((a, b) => a - b);
      const ps = want.map((n) => S.pv.pages[n - 1]);
      const a = Math.min(...ps.map((p) => p[4])), z = Math.max(...ps.map((p) => p[4] + p[5]));
      const buf = await S.get(a, z - a);
      if (token !== S.token) return;
      for (let i = 0; i < want.length; i++) {
        const el = $('#pdf-thumbs').children[want[i] - 1];
        if (!el || el.dataset.done) continue;
        const p = ps[i];
        try {
          const bm = await createImageBitmap(new Blob([buf.slice(p[4] - a, p[4] - a + p[5])], { type: `image/${S.pv.fmt || 'webp'}` }));
          const c = document.createElement('canvas');
          c.width = bm.width;
          c.height = bm.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(bm, 0, 0);
          bm.close && bm.close();
          if (S.wm) watermark(ctx, c.width, c.height, 0, 0, c.width, c.height);
          c.className = 'pt-canvas';
          el.querySelector('.pt-img').appendChild(c);
          el.dataset.done = '1';
        } catch (e) { /* 這張縮圖壞了就算了 */ }
      }
    }
  } finally {
    S.thumbBusy = 0;
  }
}

// ---------------------------------------------------------------- 圖磚（v0.8.0）
// 桌面程式用 PDFium 把每頁畫成多層圖磚（最清楚一層 300 dpi），網頁只抓畫面上看得到的那幾塊貼上去：
// 縮放、平移、翻頁都不用 pdf.js 畫向量。先畫粗的層（已經有的放大），清楚的層到了再蓋上去，所以不會空白。
// v0.9.0（索引 v3）：每頁分成「小的」（最小 sl 層，縮圖）和「大的」兩段，s／o 是兩段的位置。v2：一頁一段（o）。
// blocks＝這頁的段 [起, 迄)：網頁一次抓一整段（Google Drive 每個請求都要等好幾秒，一頁只發一個請求）
function tilesFrom(js) {
  const T = js.tile || 512;
  const sl = js.v >= 3 ? (js.sl || 2) : 0;
  const pages = js.pages.map((p) => {
    const raw = Uint8Array.from(atob(p.t), (c) => c.charCodeAt(0));
    const u = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const L = p.d.length;
    const grid = p.d.map(([w, h]) => ({ w, h, cols: Math.ceil(w / T), rows: Math.ceil(h / T), tw: T, th: T }));
    const start = new Array(L);
    let k0 = 0;
    for (let k = L - 1; k >= 0; k--) { start[k] = k0; k0 += grid[k].cols * grid[k].rows; } // 檔案裡從最小一層放起
    // 每塊：全白（不存）、跟同一層前面某塊一樣（canon 指到那塊）、一般（位置、長度）
    const lens = new Uint32Array(u.length), webp = new Uint8Array(u.length), offs = new Float64Array(u.length);
    const blank = new Uint8Array(u.length), canon = new Uint32Array(u.length);
    const small = sl > 0 && p.s != null;
    let o = small ? p.s : p.o;
    const blocks = [[o, o]];
    for (let k = L - 1; k >= 0; k--) {
      if (small && k === L - 1 - sl) { o = p.o; blocks.push([o, o]); } // 大的那段
      for (let j = 0, n = grid[k].cols * grid[k].rows; j < n; j++) {
        const i = start[k] + j, v = u[i];
        canon[i] = i;
        if (v & 0x40000000) { blank[i] = 1; continue; }
        if (v & 0x20000000) { const r = start[k] + (v & 0x1fffffff); canon[i] = canon[r]; blank[i] = blank[r]; continue; }
        lens[i] = v & 0x1fffffff;
        webp[i] = v >>> 31;
        offs[i] = o;
        o += lens[i];
        blocks[blocks.length - 1][1] = o;
      }
    }
    return { w: p.w, h: p.h, L, grid, start, lens, webp, offs, blank, canon, blocks, blk: (k) => (small && k < L - sl ? 1 : 0) };
  });
  return { T, pages, share: js.share || null, dpi: js.dpi || 200 };
}
function tileCanvas() {
  if (!S.tc) {
    S.tc = document.createElement('canvas');
    S.tc.className = 'pdf-tiles';
    $('#pdf-view').appendChild(S.tc);
  }
  const { W, H } = viewRect();
  const d = DPR();
  const cw = Math.round(W * d), ch = Math.round(H * d);
  if (S.tc.width !== cw || S.tc.height !== ch) { S.tc.width = cw; S.tc.height = ch; }
  return S.tc;
}
function clampPan(sz) {
  const { W, H } = viewRect();
  const sc = fitScale(sz) * S.zoom;
  const pw = sz.w * sc, ph = sz.h * sc;
  const ir = insetR(W, H);
  S.panX = pw <= W - ir ? (W - ir - pw) / 2 : pw <= W ? Math.min(0, Math.max(W - pw, S.panX)) : Math.min(0, Math.max(W - ir - pw, S.panX));
  S.panY = ph <= H ? (H - ph) / 2 : Math.min(0, Math.max(H - ph, S.panY));
}
function requestDraw() {
  if (S.tdraw) return;
  S.tdraw = requestAnimationFrame(() => { S.tdraw = 0; drawTiles(); });
}
function levelFor(pg, pxPerPt) { // 夠清楚的最粗一層（層和層之間不一定是 2 倍：v0.8.0 沒有放 75 dpi 那層）
  for (let k = pg.L - 1; k > 0; k--) if (pg.grid[k].w / pg.w >= pxPerPt * 0.9) return k;
  return 0;
}
function tkey(n, k, i) { return `${n}/${k}/${i}`; }
// 畫一次：c＝目標畫布（預設畫面），wm＝要不要浮水印。回傳「該清楚的那層」還缺幾塊
function drawTiles(c = null, wm = true) {
  if (!S.tl || !S.open) return 0;
  const n = S.cur, pg = S.tl.pages[n - 1], sz = S.sizes.get(n);
  if (!pg || !sz) return 0;
  const canvas = c || tileCanvas();
  const ctx = canvas.getContext('2d', { alpha: false });
  const d = canvas.width / (viewRect().W || 1);
  const css = fitScale(sz) * S.zoom, s = css * d, ox = S.panX * d, oy = S.panY * d;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#5b6672';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, pg.w * s, pg.h * s);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const x0 = Math.max(0, -ox / s), y0 = Math.max(0, -oy / s);
  const x1 = Math.min(pg.w, (canvas.width - ox) / s), y1 = Math.min(pg.h, (canvas.height - oy) / s);
  const want = levelFor(pg, s);
  let missing = 0;
  for (let k = pg.L - 1; k >= want; k--) { // 粗的先畫，細的蓋上去
    const g = pg.grid[k], f = g.w / pg.w, TW = g.tw, TH = g.th;
    const cx0 = Math.max(0, Math.floor(x0 * f / TW)), cx1 = Math.min(g.cols - 1, Math.floor((x1 * f - 1e-6) / TW));
    const cy0 = Math.max(0, Math.floor(y0 * f / TH)), cy1 = Math.min(g.rows - 1, Math.floor((y1 * f - 1e-6) / TH));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = pg.canon[pg.start[k] + cy * g.cols + cx];
        if (pg.blank[i]) continue; // 全白：頁面本來就是白底
        const t = S.tcache.get(tkey(n, k, i));
        if (t && t.bmp) {
          S.tcache.delete(tkey(n, k, i)); S.tcache.set(tkey(n, k, i), t); // 最近用過
          const tw = Math.min(TW, g.w - cx * TW), th = Math.min(TH, g.h - cy * TH); // 這塊應該的大小（lh3 給的圖大小可能不一樣）
          ctx.drawImage(t.bmp, ox + (cx * TW) / f * s, oy + (cy * TH) / f * s, tw / f * s, th / f * s);
        } else if (k === want || k === pg.L - 1) {
          if (k === want) missing++;
          needTile(n, k, i, k === want ? 0 : 1);
        }
      }
    }
  }
  // 放大超過最清楚一層：向量即時補畫的那一塊（pdf.js，背景畫好才蓋上去）
  const dt = S.tdet;
  if (dt && dt.n === n && dt.canvas) {
    ctx.drawImage(dt.canvas, ox + dt.x0 * s, oy + dt.y0 * s, (dt.x1 - dt.x0) * s, (dt.y1 - dt.y0) * s);
  }
  if (wm && S.wm) watermark(ctx, pg.w * s, pg.h * s, -ox, -oy, canvas.width, canvas.height);
  if (!c) {
    if (want === 0 && s > (pg.grid[0].w / pg.w) * 1.25) scheduleVector(n, s, x0, y0, x1, y1);
    if (!missing && S.tview) { // 這次的畫面已經全部清楚
      S.timing.lastSharp = +(performance.now() - S.tview).toFixed(0);
      if (S.timing.firstSharp == null && S.t0) { S.timing.firstSharp = +(performance.now() - S.t0).toFixed(0); S.timing.firstSharpNav = Math.round(performance.now()); step('pdf first sharp'); }
      S.tview = 0;
      document.body.dataset.pdfSharp = String(Date.now());
    }
    flushTiles();
  }
  return missing;
}
// 放大到超過圖磚最清楚一層（例如很密的圖用 150 dpi）：停下來 0.25 秒後，用 pdf.js 只畫看得到的那一塊（第一次才載入 pdf.js）
function scheduleVector(n, s, x0, y0, x1, y1) {
  if (NO_VECTOR) return; // 測試用（&vector=0）：只看圖磚
  const d = S.tdet;
  if (d && d.n === n && d.s >= s * 0.95 && d.x0 <= x0 && d.y0 <= y0 && d.x1 >= x1 && d.y1 >= y1) return; // 已經有
  clearTimeout(S.tvecTimer);
  S.tvecTimer = setTimeout(() => vectorDetail(n, s, x0, y0, x1, y1), 250);
}
async function vectorDetail(n, s, x0, y0, x1, y1) {
  if (S.gesture || S.cur !== n || !S.tl) return;
  const token = S.token;
  const t0 = performance.now();
  try {
    if (!S.docReady) S.docReady = S.startDoc().then((doc) => { if (token === S.token) S.doc = doc; return doc; });
    await S.docReady;
    if (token !== S.token || S.cur !== n || !S.doc) return;
    const page = await S.doc.getPage(n);
    let sc = s;
    const area = (x1 - x0) * (y1 - y0) * sc * sc;
    if (area > CAPS.detail) sc *= Math.sqrt(CAPS.detail / area);
    const c = document.createElement('canvas');
    const keep = S.wm;
    S.wm = ''; // 浮水印由 drawTiles 統一畫
    try {
      await draw(page, c, sc, x0 * sc, y0 * sc, Math.ceil((x1 - x0) * sc), Math.ceil((y1 - y0) * sc));
    } finally {
      S.wm = keep;
    }
    if (token !== S.token || S.cur !== n) { freeCanvas(c); return; }
    if (S.tdet && S.tdet.canvas) freeCanvas(S.tdet.canvas);
    S.tdet = { n, s: sc, x0, y0, x1, y1, canvas: c };
    S.stats.detail++;
    S.timing.lastVector = +(performance.now() - t0).toFixed(0);
    document.body.dataset.pdfVector = String(Date.now());
    requestDraw();
  } catch (e) { /* 補畫不出來就留著圖磚 */ }
}
function needTile(n, k, i, prio) {
  const key = tkey(n, k, i);
  if (S.tcache.has(key) || S.tq.has(key)) return;
  const pg = S.tl.pages[n - 1];
  S.tq.set(key, pg.urls ? { n, k, i, url: pg.urls[i], off: i, len: 0, prio, sent: false }
    : { n, k, i, off: pg.offs[i], len: pg.lens[i], webp: pg.webp[i], prio, sent: false });
}
function flushTiles() {
  if (!S.tl) return;
  // 跟目前這頁無關、也不是前後頁縮圖的就不抓了
  for (const [key, q] of S.tq) if (!q.sent && Math.abs(q.n - S.cur) > 1 && q.prio !== 2) S.tq.delete(key);
  while (S.tinflight < TL.conc) {
    const todo = [...S.tq.values()].filter((q) => !q.sent).sort((a, b) => a.prio - b.prio || (a.n === S.cur ? 0 : 1) - (b.n === S.cur ? 0 : 1) || a.off - b.off);
    if (!todo.length) return;
    const first = todo[0];
    if (first.url) { fetchImage(first); continue; } // v0.10.0：每頁的圖（lh3），一張一個請求
    // 同一頁、位置相近的合併成一個請求
    const group = [first];
    let end = first.off + first.len;
    for (const q of todo.slice(1).filter((q) => q.n === first.n).sort((a, b) => a.off - b.off)) {
      if (q.off < first.off) continue;
      if (q.off - end > TL.gap || q.off + q.len - first.off > TL.maxReq) continue;
      group.push(q);
      end = Math.max(end, q.off + q.len);
    }
    // v0.9.0：還沒下載到的話，一次抓這頁的一整段（同一段裡排著的也一起），之後這頁的其他圖磚都在記憶體裡
    let ra = first.off, rb = end;
    const pg = S.tl.pages[first.n - 1], bk = pg.blocks[pg.blk(first.k)];
    if (S.src && !S.src.covered(first.off, end) && bk && bk[1] - bk[0] <= TL.blockMax && group.every((q) => q.off >= bk[0] && q.off + q.len <= bk[1])) {
      ra = bk[0];
      rb = bk[1];
      for (const q of todo) if (!q.sent && q.n === first.n && !group.includes(q) && q.off >= ra && q.off + q.len <= rb) group.push(q);
    }
    group.forEach((q) => { q.sent = true; });
    S.tinflight++;
    S.tstat.reqs++;
    const token = S.token;
    S.get(ra, rb - ra).then(async (buf) => {
      if (token !== S.token) return;
      S.tstat.bytes += buf.byteLength;
      await Promise.all(group.map(async (q) => {
        try {
          const blob = new Blob([buf.slice(q.off - ra, q.off - ra + q.len)], { type: q.webp ? 'image/webp' : 'image/png' });
          const bmp = await createImageBitmap(blob);
          if (token !== S.token) { bmp.close && bmp.close(); return; }
          S.tcache.set(tkey(q.n, q.k, q.i), { bmp, px: bmp.width * bmp.height });
          S.tcachePx += bmp.width * bmp.height;
          S.tstat.tiles++;
        } catch (e) { /* 壞掉的圖磚就算了 */ }
        S.tq.delete(tkey(q.n, q.k, q.i));
      }));
      evictTiles();
      requestDraw();
      if (q0Thumb(group)) pumpTileThumbs();
    }).catch(() => { group.forEach((q) => S.tq.delete(tkey(q.n, q.k, q.i))); })
      .finally(() => { S.tinflight--; flushTiles(); });
  }
}
// ---------------------------------------------------------------- 每頁的圖（v0.10.0）
// 桌面程式把每頁存成 JPEG 放在 Drive（m＝長邊 1600 的整頁、f＝150 dpi 全尺寸，大頁切塊），網頁用縮圖網址（lh3）抓：
// lh3 的回應很快（主管實測 0.3～0.9 秒），Drive 下載 PDF 要先等 5～10 秒。
// 做成跟圖磚一樣的結構（3 層：0＝全尺寸切塊、1＝中等整頁、2＝縮圖 =s240），畫法、快取、縮圖列都共用。
const lh3 = (link, sz) => link.replace(/=[swh]\d+[^/=]*$/, '') + '=' + sz;
function imagesTl(files) {
  const by = new Map();
  for (const f of files || []) {
    const a = f.appProperties || {}, n = Number(a.p);
    if (!n || !a.b || !f.thumbnailLink) continue;
    if (!by.has(n)) by.set(n, {});
    by.get(n)[a.b] = { link: f.thumbnailLink, a };
  }
  const N = by.size;
  if (!N) return null;
  const pages = [];
  for (let n = 1; n <= N; n++) {
    const e = by.get(n);
    if (!e || !e.m) return null;
    const a = e.m.a;
    const [pw, ph] = String(a.pt).split(',').map(Number), [W, H] = String(a.px).split(',').map(Number);
    const [cols, rows] = String(a.g).split(',').map(Number), mx = String(a.x).split(',').map(Number);
    if (!(pw > 0 && ph > 0 && W > 0 && H > 0 && cols > 0 && rows > 0 && mx[2] > 0)) return null;
    const mw = mx[2], mh = mx[3], ts = 240 / Math.max(mw, mh);
    const sw = Math.max(1, Math.round(mw * ts)), sh = Math.max(1, Math.round(mh * ts));
    const grid = [{ w: W, h: H, cols, rows, tw: Math.ceil(W / cols), th: Math.ceil(H / rows) },
      { w: mw, h: mh, cols: 1, rows: 1, tw: mw, th: mh },
      { w: sw, h: sh, cols: 1, rows: 1, tw: sw, th: sh }];
    const start = [2, 1, 0], total = 2 + cols * rows;
    const urls = new Array(total);
    urls[0] = lh3(e.m.link, 's240');
    urls[1] = lh3(e.m.link, 's0');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = e[`${r}_${c}`];
        if (!b) return null;
        urls[2 + r * cols + c] = lh3(b.link, 's0');
      }
    }
    pages.push({ w: pw, h: ph, L: 3, grid, start, urls, canon: Uint32Array.from({ length: total }, (_, i) => i), blank: new Uint8Array(total),
      blocks: [], blk: () => 0 });
  }
  return { T: 512, pages, share: null, dpi: 150, images: true };
}
function fetchImage(q) {
  q.sent = true;
  S.tinflight++;
  S.tstat.reqs++;
  const token = S.token, key = tkey(q.n, q.k, q.i), t0 = performance.now();
  fetch(q.url, { cache: 'no-store', credentials: 'omit' }).then((r) => {
    if (!r.ok) throw Object.assign(new Error(`lh3 ${r.status}`), { status: r.status });
    return r.blob();
  }).then(async (blob) => {
    if (token !== S.token) return;
    S.tstat.bytes += blob.size;
    const bmp = await createImageBitmap(blob);
    if (token !== S.token) { if (bmp.close) bmp.close(); return; }
    S.tcache.set(key, { bmp, px: bmp.width * bmp.height });
    S.tcachePx += bmp.width * bmp.height;
    S.tstat.tiles++;
    if (!S.tstat.img) { S.tstat.img = 1; step('lh3 first image', t0); }
    S.tq.delete(key);
    evictTiles();
    requestDraw();
    if (q.prio === 2) pumpTileThumbs();
  }).catch((e) => {
    S.tq.delete(key);
    if (token !== S.token) return;
    S.imgFail = (S.imgFail || 0) + 1;
    step(`lh3 failed ${e.status || ''}`.trim(), t0);
    if (S.pdfTl) usePdfTiles('lh3 failed'); // PDF 的圖磚到了：改用 PDF
  }).finally(() => { S.tinflight--; flushTiles(); });
}
// 每頁的圖抓不到（網址過期、網路）：改用 PDF 裡的圖磚（背景下載到了才有）
function usePdfTiles(why) {
  if (!S.pdfTl || !S.tl || !S.tl.images) return;
  for (const t of S.tcache.values()) if (t.bmp && t.bmp.close) t.bmp.close();
  S.tcache.clear();
  S.tcachePx = 0;
  S.tq.clear();
  S.tl = S.pdfTl;
  S.tl.pages.forEach((p, i) => S.sizes.set(i + 1, { w: p.w, h: p.h }));
  step(`switch to pdf tiles (${why})`);
  for (const el of $('#pdf-thumbs').children) delete el.dataset.done;
  requestDraw();
  pumpTileThumbs();
}
function q0Thumb(group) { return group.some((q) => q.prio === 2); }
function evictTiles() {
  if (S.tcachePx <= TL.cachePx) return;
  for (const [key, t] of S.tcache) { // 最久沒用的先丟（目前這頁的最小一層留著）
    if (S.tcachePx <= TL.cachePx * 0.8) break;
    const [n, k] = key.split('/').map(Number);
    if (n === S.cur && k === S.tl.pages[n - 1].L - 1) continue;
    if (t.bmp && t.bmp.close) t.bmp.close();
    S.tcachePx -= t.px;
    S.tcache.delete(key);
  }
}
async function tileGo(n, first) {
  n = Math.max(1, Math.min(S.n, Math.round(n) || 1));
  const t0 = performance.now();
  if (n !== S.cur || first) badge(n);
  S.cur = n;
  if (!first) { S.zoom = 1; S.panX = 0; S.panY = 0; }
  $('#pdf-num').value = n;
  $('#pdf-prev').disabled = n <= 1;
  $('#pdf-next').disabled = n >= S.n;
  $('#pdf-page').style.display = 'none';
  S.tview = performance.now();
  if (S.tdet) { if (S.tdet.canvas) freeCanvas(S.tdet.canvas); S.tdet = null; }
  clampPan(S.sizes.get(n));
  markThumb();
  // 前後頁的最小一層先抓（翻頁馬上有東西）
  for (const m of [n + 1, n - 1]) {
    if (m >= 1 && m <= S.n) { const pg = S.tl.pages[m - 1]; const ci = pg.canon[pg.start[pg.L - 1]]; if (!pg.blank[ci]) needTile(m, pg.L - 1, ci, 1); }
  }
  drawTiles();
  // 等到這頁至少畫出一層（第一次開檔：最小一層通常在第一段資料裡）
  const pg = S.tl.pages[n - 1];
  for (let i = 0; i < 400 && S.cur === n; i++) {
    let any = false;
    if (pg.blank[pg.canon[pg.start[pg.L - 1]]]) any = true;
    for (let k = pg.L - 1; k >= 0 && !any; k--) if ([...S.tcache.keys()].some((key) => key.startsWith(`${n}/${k}/`))) any = true;
    if (any) break;
    await new Promise((r) => setTimeout(r, 15));
  }
  drawTiles();
  S.timing.lastFlip = +(performance.now() - t0).toFixed(0);
  document.body.dataset.pdfPage = String(n);
  idle(() => pumpTileThumbs());
}
// v0.10.2：翻頁時中間上方顯示「12 / 94」1 秒（觸控模式；上方列收起來的時候特別需要）
function badge(n) {
  const b = $('#pdf-badge');
  if (!b || !TOUCH_UI || !S.n) return;
  b.textContent = `${n} / ${S.n}`;
  b.hidden = false;
  b.classList.remove('fade');
  clearTimeout(S.badgeT);
  S.badgeT = setTimeout(() => { b.classList.add('fade'); S.badgeT = setTimeout(() => { b.hidden = true; }, 350); }, 1100);
}
function closeThumbs() {
  $('#pdf-thumbs').hidden = true;
  $('#pdf-thumb-btn').classList.remove('on');
}
// v0.10.2：點一下畫面收起／顯示上方列和工具（觸控模式）
export function toggleChrome(force) {
  const app = $('#app');
  const off = force != null ? !!force : !app.classList.contains('chrome-off');
  app.classList.toggle('chrome-off', off);
  document.body.dataset.chrome = off ? 'off' : 'on';
}
// 縮圖列：每頁最小一層（≤ 256 px）就是縮圖
function pumpTileThumbs() {
  if ($('#pdf-thumbs').hidden || !S.tl) return;
  for (const n of S.thumbQ) {
    const el = $('#pdf-thumbs').children[n - 1];
    if (!el || el.dataset.done) continue;
    const pg = S.tl.pages[n - 1];
    const ci = pg.canon[pg.start[pg.L - 1]];
    const key = tkey(n, pg.L - 1, ci);
    const t = S.tcache.get(key);
    if (pg.blank[ci]) { el.dataset.done = '1'; continue; }
    if (t && t.bmp) {
      const c = document.createElement('canvas');
      c.width = t.bmp.width;
      c.height = t.bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(t.bmp, 0, 0);
      if (S.wm) watermark(ctx, c.width, c.height, 0, 0, c.width, c.height);
      c.className = 'pt-canvas';
      el.querySelector('.pt-img').appendChild(c);
      el.dataset.done = '1';
    } else {
      needTile(n, pg.L - 1, ci, 2);
    }
  }
  flushTiles();
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
  if (TOUCH_UI) showThumbs = false; // v0.10.3：觸控模式一律收起（按「縮圖」才滑出來，蓋在圖上）
  $('#pdf-thumbs').hidden = !showThumbs;
  $('#pdf-thumb-btn').classList.toggle('on', showThumbs);
  $('#pdf-thumbs').addEventListener('click', (e) => {
    const b = e.target.closest('.pthumb');
    if (!b) return;
    go(Number(b.dataset.n));
    if (TOUCH_UI) closeThumbs(); // v0.10.3：觸控模式點了某一頁就收起（縮圖蓋在圖上）
  });
  // v0.9.0：離線準備、速度紀錄
  $('#pdf-net').addEventListener('click', () => { $('#pdf-dl').hidden = false; dlPanel(); });
  $('#pdf-dl-close').addEventListener('click', () => { $('#pdf-dl').hidden = true; });
  $('#pdf-dl').addEventListener('click', (e) => { if (e.target.id === 'pdf-dl') $('#pdf-dl').hidden = true; });
  $('#pdf-dl-save').addEventListener('click', async () => {
    if (await saveKeep() && ui && ui.toast) ui.toast('已存在這台裝置：現場沒有網路也能開', 3000);
  });
  $('#pdf-dl-clear').addEventListener('click', async () => {
    if (!S.keep) return;
    await offline.del(S.keep.id);
    S.keepSaved = false;
    S.keepTried = true;
    if (S.keep.cached) S.keep = { ...S.keep, cached: false };
    netUi();
    dlPanel();
    if (ui && ui.toast) ui.toast('已從這台裝置清除', 2500);
  });
  const setDebug = (on) => {
    S.debug = on;
    try { localStorage.setItem('skpv-debug', on ? '1' : '0'); } catch (e) { /* 略過 */ }
    $('#pdf-dl-debug').textContent = on ? '不要顯示在畫面角落' : '顯示在畫面角落';
    clearInterval(S.debugTimer);
    if (on) S.debugTimer = setInterval(debugUi, 1000);
    debugUi();
  };
  let dbg = new URLSearchParams(location.search).get('debug') === '1';
  try { dbg = dbg || localStorage.getItem('skpv-debug') === '1'; } catch (e) { /* 略過 */ }
  setDebug(dbg);
  $('#pdf-dl-debug').addEventListener('click', () => setDebug(!S.debug));
  $('#pdf-dl-copy').addEventListener('click', async () => {
    const t = speedLog();
    try { await navigator.clipboard.writeText(t); if (ui && ui.toast) ui.toast('速度紀錄已複製，可以貼到 LINE', 3000); } catch (e) { prompt('速度紀錄（長按複製）', t); }
  });
  // 測試用
  window.skpvPdf = {
    go, setZoom, info, speedLog: () => JSON.parse(speedLog()), net: () => (S.src ? S.src.stats() : null),
    // 測試用：放大到「每 pt 幾個 CSS 像素」（2.5 ≈ 7 pt 的字 17 px 高，看得清楚）
    pageRect() { const sz = S.sizes.get(S.cur); const c = sz ? fitScale(sz) * S.zoom : 0; return sz ? { x: S.panX, y: S.panY, w: sz.w * c, h: sz.h * c } : null; }, // 測試用（v0.10.3）
    cssPerPt() { const sz = S.sizes.get(S.cur); return sz ? fitScale(sz) * S.zoom : 0; }, // 測試用（v0.10.2）
    zoomToCss(cssPerPt, cx, cy) { const sz = S.sizes.get(S.cur); setZoom(cssPerPt / fitScale(sz), cx, cy); }, get state() { return { cur: S.cur, n: S.n, zoom: +S.zoom.toFixed(3), fit: S.fit, panX: Math.round(S.panX), panY: Math.round(S.panY),
      bases: [...S.bases.keys()], detail: S.detail ? [S.detail.canvas.width, S.detail.canvas.height] : null, wm: S.wm, rendering: S.rendering }; },
    // 浮水印有沒有畫進 canvas：同一頁有／沒有浮水印各畫一次，比較像素
    async wmProbe() {
      if (S.tl) { // 圖磚：同一個畫面有／沒有浮水印各畫一次
        const a = document.createElement('canvas'), b = document.createElement('canvas');
        a.width = b.width = S.tc.width;
        a.height = b.height = S.tc.height;
        drawTiles(a, true);
        drawTiles(b, false);
        const pa = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, pb = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
        let diff = 0;
        for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 12) diff++;
        freeCanvas(a); freeCanvas(b);
        return { on: !!S.wm, text: S.wm, diffRatio: +(diff / (pa.length / 4)).toFixed(4), tiles: true };
      }
      if (S.pv && !S.pvFail) { // 預覽：同一張預覽有／沒有浮水印各畫一次
        const keep0 = S.wm;
        const a = await previewCanvas(S.cur);
        S.wm = '';
        const b = await previewCanvas(S.cur);
        S.wm = keep0;
        const pa = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, pb = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
        let diff = 0;
        for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 12) diff++;
        freeCanvas(a); freeCanvas(b);
        return { on: !!keep0, text: keep0, diffRatio: +(diff / (pa.length / 4)).toFixed(4), preview: true };
      }
      await S.docReady;
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
      if (S.tl && S.tc) {
        const c = S.tc, g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] < 200) dark++;
        return { w: c.width, h: c.height, darkRatio: +(dark / (d.length / 16)).toFixed(4), tiles: true };
      }
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
