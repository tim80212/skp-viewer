// 分享連結（v0.6.0）：?s=連結權杖&k=紀錄端點的部署編號#n=收件人稱呼
// 1. 問紀錄端點（設計方自己的 Apps Script）這條連結的狀態：有效才繼續（過期、取消、沒網路都不顯示）
// 2. 第一次開啟先顯示著作權與使用聲明；按「我同意並開啟」才記錄、才載入；按「不同意」什麼都不做
// 3. 記一筆開啟紀錄（時間由端點記、IP、裝置類型、作業系統、瀏覽器），端點這時才給模型的檔案編號
// 4. 下載模型：cache:'no-store'，不進瀏覽器快取、Service Worker、IndexedDB；只留在這一頁的記憶體
// v0.10.5（PDF 快路）：網址一解析就同時問紀錄端點、查 IP；紀錄端點給了第 1 頁的圖（每頁的圖，桌面程式分享時複製的）就馬上在背景抓
//   （只放在記憶體，聲明還沒同意不顯示）。按同意 → 立刻畫第 1 頁，同時送開啟紀錄；紀錄回來才拿到 PDF 和其他頁的圖。
//   紀錄沒成功（沒網路、連結剛被取消）→ 關掉文件、顯示原因（一樣「沒記錄就不給看」，只是先畫、紀錄失敗再收）。
// 螢幕上看得到的東西，技術上一定擷取得到；這些措施是控制、提醒和追查，不是「別人就拿不到」。
import { CONFIG } from './config.js';
import { renderNotice, AGREE, DISAGREE, IP_SERVICE } from './notice.js';
import { rangeFetcher } from './cloud.js';
import { step } from './device.js';
import { close as closePdf } from './pdfview.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DEPLOY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const AGREED_KEY = 'skpv-agreed';

// 測試用（只在本機網址有效）：&gbase=http://127.0.0.1:8790 → 假的 Drive、假的端點、假的 IP 查詢
let base = 'https://www.googleapis.com';
let apiKey = CONFIG.apiKey;
let ipService = IP_SERVICE;
let scriptBase = 'https://script.google.com';
if (isLocal && /^http:\/\/127\.0\.0\.1:\d+$/.test(params.get('gbase') || '')) {
  base = params.get('gbase');
  scriptBase = base;
  apiKey = params.get('gkey') || 'mock-key';
  ipService = params.get('noip') === '1' ? '' : `${base}/ip`;
}

export function isShareLink() { return params.has('s'); }
// v0.7.0：分享的是 PDF 時，桌面程式在連結加 &type=pdf（只影響聲明的用字；真正的格式看檔案內容）
const KIND = params.get('type') === 'pdf' ? 'pdf' : '';
const WHAT = KIND === 'pdf' ? '文件' : '模型';

const STATUS_TEXT = {
  expired: ['這條分享連結已經過期', `有效期限已過，${WHAT}不會再顯示。如果還需要看，請聯絡分享給你的人重新分享。`],
  revoked: ['這條分享連結已被取消', `分享的人已經取消這條連結，${WHAT}不會再顯示。`],
  unknown: ['找不到這條分享連結', '可能已經刪除，或網址不完整（請確認整段網址都有複製到）。'],
  busy: ['開啟次數太頻繁', '這條連結短時間內開啟太多次，請過幾分鐘再試。'],
  offline: ['沒辦法確認這條連結', `分享的${WHAT}每次開啟都要先上網確認連結還有效，沒有網路時不會顯示。請連上網路後重新整理。<br>如果網路正常還是這樣，可能是連結網址不完整，或分享的人已經停用這條連結，請聯絡分享給你的人。`],
  bad: ['連結不完整', '這條分享連結少了一部分，請確認整段網址都有複製到。'],
};

function problem(ui, key, extra = '') {
  const [t, d] = STATUS_TEXT[key] || STATUS_TEXT.unknown;
  ui.hideLoading();
  ui.showProblem(t, esc(d).replace(/&lt;br&gt;/g, '<br>') + extra, key !== 'expired' && key !== 'revoked');
  document.body.dataset.share = key; // 測試用
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow', ...opts });
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
  return res.json();
}

function deviceInfo(device) {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS／iPadOS'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS'
      : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '其他';
  const browser = /Line\//.test(ua) ? 'LINE 內建' : /FBAN|FBAV|Instagram/.test(ua) ? 'Facebook／IG 內建'
    : /SamsungBrowser/.test(ua) ? 'Samsung' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
      : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '其他';
  return { device: { phone: '手機', tablet: '平板', desktop: '電腦' }[device] || '其他', os, browser };
}

async function lookupIp() {
  if (!ipService) return '';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const r = await getJson(ipService, { signal: ctl.signal });
    clearTimeout(timer);
    return /^[0-9a-fA-F:.]{3,64}$/.test(r.ip || '') ? r.ip : '';
  } catch (e) {
    return ''; // 查不到（被擋、逾時）：紀錄寫「未取得」，照樣開啟
  }
}

async function hash(s) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('skpv:' + s));
    return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}
function readAgreed() {
  try { return JSON.parse(localStorage.getItem(AGREED_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writeAgreed(h, expires) {
  if (!h) return;
  try {
    const a = readAgreed();
    a[h] = Date.parse(expires) || Date.now() + 30 * 86400e3;
    for (const k of Object.keys(a)) if (a[k] < Date.now()) delete a[k]; // 過期的同意紀錄順便清掉
    localStorage.setItem(AGREED_KEY, JSON.stringify(a));
  } catch (e) { /* 私密瀏覽：每次都會再問一次 */ }
}

export function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function askNotice(fields) {
  return new Promise((resolve) => {
    $('#notice-text').innerHTML = renderNotice(fields, undefined, KIND);
    $('#notice-yes').textContent = AGREE;
    $('#notice-no').textContent = DISAGREE;
    $('#notice').hidden = false;
    $('#notice .card').scrollTop = 0;
    const done = (v) => { $('#notice').hidden = true; resolve(v); };
    $('#notice-yes').onclick = () => done(true);
    $('#notice-no').onclick = () => done(false);
  });
}

// ---------- v0.10.5：每頁的圖（縮圖網址 lh3）----------
// 紀錄端點給的每頁資料：[[圖的編號, 頁寬pt, 頁高pt, 圖寬px, 圖高px], …]（檢查連結時只有第 1 頁有編號）
const FID_RE = /^[A-Za-z0-9_-]{10,80}$/;
function validPages(a, needAll) {
  if (!Array.isArray(a) || !a.length || a.length > 900) return null;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    if (!Array.isArray(p) || p.length !== 5) return null;
    if ((i === 0 || needAll) && !FID_RE.test(String(p[0]))) return null;
    if (p[0] && !FID_RE.test(String(p[0]))) return null;
    if (!p.slice(1).every((x) => typeof x === 'number' && x > 0 && x < 1e6)) return null;
  }
  return a;
}
const lh3 = (link, sz) => link.replace(/=[swh]\d+[^/=]*$/, '') + '=' + sz;
const links = new Map(); // 圖的編號 → Promise<縮圖網址>（只在記憶體）
function imageLink(fid, fresh) {
  if (fresh || !links.has(fid)) {
    const p = getJson(`${base}/drive/v3/files/${encodeURIComponent(fid)}?fields=thumbnailLink&key=${encodeURIComponent(apiKey)}`)
      .then((m) => (m.thumbnailLink ? m.thumbnailLink : Promise.reject(new Error('no thumbnail'))));
    links.set(fid, p);
    p.catch(() => { if (links.get(fid) === p) links.delete(fid); });
  }
  return links.get(fid);
}
// 第 1 頁的中等整頁圖：先抓到記憶體（fetch no-store、不帶 cookie；不進 Cache Storage、IndexedDB）。onProgress 給載入畫面顯示 MB
function prefetchFirst(fid, onProgress) {
  const st = { fid, got: 0, total: 0, done: false, t0: performance.now() };
  st.blob = imageLink(fid).then(async (link) => {
    step('share page1 meta', st.t0);
    const r = await fetch(lh3(link, 's0'), { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw Object.assign(new Error('lh3 ' + r.status), { status: r.status });
    st.total = Number(r.headers.get('Content-Length') || 0);
    let blob;
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader(), parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        st.got += value.length;
        onProgress(st);
      }
      blob = new Blob(parts, { type: 'image/jpeg' });
    } else {
      blob = await r.blob();
      st.got = blob.size;
    }
    st.done = true;
    onProgress(st);
    step('share page1 image', st.t0);
    return blob;
  });
  st.blob.catch(() => { step('share page1 failed', st.t0); });
  return st;
}
const mbx = (n) => (n / 1048576).toFixed(1);
function progressText(st) {
  if (!st || st.done) return '開啟中…';
  if (!st.got) return '第一頁準備中…';
  return st.total ? `第一頁 ${mbx(st.got)} / ${mbx(st.total)} MB…` : `第一頁 ${mbx(st.got)} MB…`;
}

export async function openShare(ui) {
  const t = params.get('s') || '';
  const k = params.get('k') || '';
  document.title = 'SKP 瀏覽器';
  if (!TOKEN_RE.test(t) || !DEPLOY_RE.test(k)) return problem(ui, 'bad');
  const ep = `${scriptBase}/macros/s/${encodeURIComponent(k)}/exec`;
  const label = new URLSearchParams(location.hash.slice(1)).get('n') || '';
  const t0 = performance.now();
  ui.showLoading('確認連結…');
  // v0.10.5：同時發出：問紀錄端點、查 IP（IP 只在按同意後隨開啟紀錄送出）、算同意紀錄的雜湊
  let tc = performance.now();
  let cP = null;
  const early = window.__skpvPreCheck; // index.html 一開頁就發了的
  window.__skpvPreCheck = null;
  if (early && early.t === t && early.k === k) { cP = early.res; tc = early.t0; }
  if (!cP) cP = getJson(`${ep}?a=check&t=${encodeURIComponent(t)}`);
  cP.catch(() => {});
  const ti = performance.now();
  const ipP = lookupIp().then((ip) => { step('share ip', ti); return ip; });
  const hP = hash(t);
  const slow = setTimeout(() => ui.showLoading('確認連結…（第一次開可能要多等幾秒）'), 3000);
  let c;
  try {
    c = await cP;
    step('share check', tc);
  } catch (e) {
    clearTimeout(slow);
    return problem(ui, 'offline');
  }
  clearTimeout(slow);
  if (c.status !== 'active') return problem(ui, c.status in STATUS_TEXT ? c.status : 'unknown');
  // 有每頁的圖：第 1 頁馬上在背景抓（聲明還沒同意前不顯示）
  const pages = validPages(c.pages, false);
  let showing = false;
  const first = pages ? prefetchFirst(pages[0][0], (st) => { if (showing) ui.showLoading(progressText(st)); }) : null;
  ui.hideLoading();
  document.title = `#${c.code} — SKP 瀏覽器`;
  const h = await hP;
  if (!(h && readAgreed()[h])) {
    const ok = await askNotice({ 收件人稱呼: label.slice(0, 40), 代號: c.code, 到期日: fmtDate(c.expires), 設計公司名稱: c.company, 聯絡方式: c.contact });
    if (!ok) {
      ui.showProblem('沒有開啟', `你選了「不同意」，所以沒有載入${WHAT}，也沒有記錄。要看的話請重新整理網頁。`, false);
      document.body.dataset.share = 'declined';
      return;
    }
    writeAgreed(h, c.expires);
    step('share notice agreed');
  } else {
    ui.toast(`分享代號 #${c.code}：開啟會記錄（你之前已同意聲明）`, 3500);
  }
  showing = true;
  ui.showLoading(progressText(first));
  const env = deviceInfo(ui.device);
  // 開啟紀錄：按同意之後才送（IP 最多再等 1.5 秒，查不到就寫「未取得」）
  const oP = (async () => {
    const ip = await Promise.race([ipP, new Promise((r) => setTimeout(() => r(''), 1500))]);
    const to = performance.now();
    const res = await getJson(ep, { method: 'POST', body: JSON.stringify({ a: 'open', t, ip, ...env }) });
    step('share open (log)', to);
    return res;
  })();
  oP.catch(() => {});
  if (pages) return openSharePdfFast(ui, { c, pages, first, oP, t0, setShowing: (v) => { showing = v; } });
  let o;
  try {
    o = await oP;
  } catch (e) {
    return problem(ui, 'offline');
  }
  if (o.status !== 'active' || !o.file) return problem(ui, o.status in STATUS_TEXT ? o.status : 'unknown');
  const name = `#${o.code}`;
  ui.loadBegin({ name, size: 0 });
  const media = `${base}/drive/v3/files/${encodeURIComponent(o.file)}?alt=media&key=${encodeURIComponent(apiKey)}`;
  // v0.7.0：PDF 分段讀取；v0.9.0：背景整份下載到這一頁的記憶體（cache:'no-store'、不帶 cookie，不進 IndexedDB／Cache Storage，關掉就沒了）
  let meta = null;
  // v0.9.0：讀檔案資料的同時就先發 bytes=0- 的下載請求（Drive 每個下載請求都要先等好幾秒）；不是 PDF 就取消
  const preCtrl = new AbortController();
  const pre = { t0: performance.now(), abort: () => preCtrl.abort(),
    res: fetch(media, { headers: { Range: 'bytes=0-' }, cache: 'no-store', credentials: 'omit', signal: preCtrl.signal }) };
  pre.res.catch(() => {});
  const tm = performance.now();
  try {
    meta = await getJson(`${base}/drive/v3/files/${encodeURIComponent(o.file)}?fields=size,mimeType&key=${encodeURIComponent(apiKey)}`);
    step('drive meta', tm);
  } catch (e) {
    pre.abort();
    if (e.status === 404 || e.status === 403) return problem(ui, 'revoked');
    return problem(ui, 'offline');
  }
  if (meta.mimeType === 'application/pdf') {
    document.body.classList.add('shared');
    try {
      const rf = rangeFetcher(media); // v0.9.0：背景整份下載到記憶體（不存在裝置上：沒有 keep）
      await ui.openPdf({ size: Number(meta.size || 0), fetchRange: rf, open: rf.open, pre }, name, t0, { share: { code: o.code, expires: o.expires } });
    } catch (e) {
      if (e.status === 404 || e.status === 403) return problem(ui, 'revoked');
      if (e.status || /fetch|network/i.test(String(e.message))) return problem(ui, 'offline');
      throw e;
    }
    document.body.dataset.share = 'open';
    return true;
  }
  pre.abort();
  ui.showLoading('下載模型…');
  let buf;
  try {
    const res = await fetch(media, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return problem(ui, res.status === 404 || res.status === 403 ? 'revoked' : 'offline');
    const total = Number(res.headers.get('Content-Length') || 0);
    if (res.body && total) {
      const reader = res.body.getReader();
      const out = new Uint8Array(total);
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > total) throw new Error('下載的大小不對');
        out.set(value, got);
        got += value.length;
        ui.showLoading(`下載模型… ${Math.round((100 * got) / total)}%`);
      }
      buf = out.buffer;
    } else {
      buf = await res.arrayBuffer();
    }
  } catch (e) {
    return problem(ui, 'offline');
  }
  await ui.loadBuffer(buf, name, t0, { share: { code: o.code, expires: o.expires } });
  document.body.dataset.share = 'open';
  return true;
}

// v0.10.5：分享的 PDF 有每頁的圖：第 1 頁（已經在記憶體）馬上畫，PDF 和其他頁的圖等開啟紀錄回來才拿
async function openSharePdfFast(ui, { c, pages, first, oP, t0, setShowing }) {
  const name = `#${c.code}`;
  ui.loadBegin({ name, size: 0 });
  document.body.classList.add('shared');
  let failed = null;
  const fail = (key) => {
    if (failed) return;
    failed = key;
    closePdf();
    setShowing(false);
    problem(ui, key);
  };
  // 開啟紀錄回來 → 其他頁的圖編號＋PDF（背景整份下載到這一頁的記憶體：放大超過中等圖、圖抓不到時用）
  const later = oP.then(async (o) => {
    if (o.status !== 'active' || !o.file) throw Object.assign(new Error('share ' + o.status), { share: o.status in STATUS_TEXT ? o.status : 'unknown' });
    if (o.code !== c.code) throw Object.assign(new Error('code mismatch'), { share: 'unknown' });
    const media = `${base}/drive/v3/files/${encodeURIComponent(o.file)}?alt=media&key=${encodeURIComponent(apiKey)}`;
    const preCtrl = new AbortController();
    const pre = { t0: performance.now(), abort: () => preCtrl.abort(),
      res: fetch(media, { headers: { Range: 'bytes=0-' }, cache: 'no-store', credentials: 'omit', signal: preCtrl.signal }) };
    pre.res.catch(() => {});
    const tm = performance.now();
    let meta;
    try {
      meta = await getJson(`${base}/drive/v3/files/${encodeURIComponent(o.file)}?fields=size,mimeType&key=${encodeURIComponent(apiKey)}`);
      step('drive meta', tm);
    } catch (e) {
      pre.abort();
      throw Object.assign(e, { share: e.status === 404 || e.status === 403 ? 'revoked' : 'offline' });
    }
    if (meta.mimeType !== 'application/pdf') { pre.abort(); throw Object.assign(new Error('not pdf'), { share: 'unknown' }); }
    const rf = rangeFetcher(media);
    return { size: Number(meta.size || 0), open: rf.open, pre, ids: (validPages(o.pages, true) || []).map((p) => p[0]) };
  });
  const ids = later.then((x) => x.ids);
  ids.catch(() => {});
  later.catch((e) => fail(e.share || 'offline'));
  try {
    const op = ui.openPdf({ later, images: { share: true, pages, ids, first, link: imageLink } }, name, t0, { share: { code: c.code, expires: c.expires } });
    ui.showLoading(progressText(first)); // openPdf 會先顯示「開啟 PDF…」：換回第一頁的進度
    await op;
  } catch (e) {
    if (failed) return false;
    if (e.status === 404 || e.status === 403) return fail('revoked');
    if (e.status || /fetch|network/i.test(String(e.message))) return fail('offline');
    throw e;
  }
  setShowing(false);
  if (failed) return false;
  document.body.dataset.share = 'open';
  later.then(() => { if (!failed) document.body.dataset.shareLogged = '1'; }).catch(() => {});
  return true;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
