// 雲端（Google Drive）：登入看「我的模型」、分享單一模型的連結、用 ?m=檔案ID 開啟。
// 範圍 drive.file：只碰「SKP 轉檔上傳」程式上傳的檔案，看不到 Drive 裡其他東西。
// 模型檔直接從 Google 下載到這台裝置，不經過其他伺服器。
import { CONFIG } from './config.js';
import { Source } from './pdfdata.js';
import * as offline from './offline.js';
import { step } from './device.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

// 測試用（只在本機網址有效）：?gbase=http://127.0.0.1:8790&gtoken=…&gkey=…（tools/mock_google.py）
let base = 'https://www.googleapis.com';
let apiKey = CONFIG.apiKey;
let clientId = CONFIG.clientId;
let testToken = null;
if (isLocal && /^http:\/\/127\.0\.0\.1:\d+$/.test(params.get('gbase') || '')) {
  base = params.get('gbase');
  apiKey = params.get('gkey') || apiKey;
  testToken = params.get('gtoken');
  clientId = clientId || 'mock';
}
const DRIVE = () => `${base}/drive/v3`;
const USERINFO = () => (testToken ? `${base}/v1/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo');

let ui = null; // { loadBuffer, showLoading, hideLoading, fail, toast, onLoaded }
let auth = null; // { token, exp, email }
let currentId = null;
let tokenClient = null;
let files = [];

export function configured() { return !!clientId; }
export function currentFileId() { return currentId; }

// ---------- 登入（Google Identity Services，彈出視窗）----------
function loadStored() {
  if (testToken) return { token: testToken, exp: Date.now() + 3600e3, email: '' };
  try {
    const a = JSON.parse(localStorage.getItem('skpv-auth') || 'null');
    if (a && a.exp > Date.now() + 60e3) return a;
  } catch (e) { /* 私密瀏覽等情況讀不到 */ }
  return null;
}
function store(a) {
  try { a ? localStorage.setItem('skpv-auth', JSON.stringify(a)) : localStorage.removeItem('skpv-auth'); } catch (e) { /* 略過 */ }
}
function loadGis() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('連不上 Google 登入服務（請檢查網路）'));
    document.head.appendChild(s);
  });
}
export function signedIn() { return !!(auth && auth.exp > Date.now()); }

async function signIn() {
  if (testToken) { auth = loadStored(); return auth; }
  if (!clientId) throw new Error('網頁還沒設定 Google 用戶端 ID。');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: async (r) => {
        if (r.error) { reject(new Error('Google 登入沒有完成：' + r.error)); return; }
        auth = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000, email: '' };
        try {
          const info = await (await fetch(USERINFO(), { headers: { Authorization: 'Bearer ' + auth.token } })).json();
          auth.email = info.email || '';
        } catch (e) { /* 拿不到 email 不影響 */ }
        store(auth);
        resolve(auth);
      },
      error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? '登入視窗被關閉了' : 'Google 登入失敗（可能被擋了彈出視窗）')),
    });
    tokenClient.requestAccessToken({ prompt: '', hint: auth && auth.email ? auth.email : undefined });
  });
}
function signOut() {
  if (auth && auth.token && window.google && window.google.accounts && !testToken) {
    try { window.google.accounts.oauth2.revoke(auth.token, () => {}); } catch (e) { /* 略過 */ }
  }
  auth = null;
  store(null);
}

async function api(path, { method = 'GET', query = {}, body, raw = false, useKey = false } = {}) {
  const q = new URLSearchParams(query);
  const headers = {};
  if (useKey) {
    q.set('key', apiKey);
  } else {
    if (!signedIn()) await signIn();
    headers.Authorization = 'Bearer ' + auth.token;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${DRIVE()}${path}${q.toString() ? '?' + q : ''}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store', // v0.6.0：模型和清單都不進瀏覽器快取
  });
  if (res.status === 401 && !useKey) { auth = null; store(null); }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error.message; } catch (e) { /* 略過 */ }
    const err = new Error(`Google Drive ${res.status}${msg ? '：' + msg : ''}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  return res.status === 204 ? {} : res.json();
}

// ---------- 開啟雲端檔案 ----------
// PDF（v0.7.0）：不先下載整個檔案，pdf.js 要哪一段就抓哪一段（Drive 支援 Range）。cache:'no-store'、不帶 cookie。
export function rangeFetcher(url, headers = {}) {
  // v0.9.0：open＝發一個 Range 請求、回傳 Response（pdfdata.js 串流下載、記錄等待／傳輸時間用）
  const open = (begin, end, signal) => fetch(url, { headers: { ...headers, Range: `bytes=${begin}-${end - 1}` }, cache: 'no-store', credentials: 'omit', signal });
  const f = async (begin, end) => {
    const res = await open(begin, end);
    if (res.status === 206) return res.arrayBuffer();
    if (res.ok) { // 伺服器不支援 Range：給整個檔案
      const full = await res.arrayBuffer();
      return begin === 0 ? { full } : full.slice(begin, end);
    }
    throw Object.assign(new Error(`Google Drive ${res.status}`), { status: res.status });
  };
  f.open = open;
  return f;
}
function mediaUrl(id, useKey) {
  return `${DRIVE()}/files/${encodeURIComponent(id)}?alt=media${useKey ? '&key=' + encodeURIComponent(apiKey) : ''}`;
}
export const isPdfMeta = (m) => (m && (m.mimeType === 'application/pdf' || /\.pdf$/i.test(m.name || '') || (m.appProperties || {}).kind === 'pdf'));

// v0.9.0：讀檔案資料的同時就先發 bytes=0- 的下載請求（Drive 每個下載請求都要先等好幾秒），是 PDF 就當成背景下載的第一段，不是就取消
function startPre(id, useKey) {
  if (params.get('pre') === '0') return null;
  const early = takeEarly(id);
  if (early && !useKey && auth && early.tok === auth.token) return early; // index.html 網頁一開始就發出去的
  if (early) early.abort();
  const headers = useKey ? {} : auth && auth.token ? { Authorization: 'Bearer ' + auth.token } : null;
  if (!headers) return null;
  const ctrl = new AbortController();
  const t0 = performance.now();
  const res = fetch(mediaUrl(id, useKey), { headers: { ...headers, Range: 'bytes=0-' }, cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
  res.catch(() => {});
  return { res, t0, abort: () => ctrl.abort() };
}

// v0.10.0：這份文件每頁的圖（JPEG，lh3）的清單。index.html 一開頁就發了的話直接接手
function startPreImg(id) {
  const e = window.__skpvPreImg;
  window.__skpvPreImg = null;
  if (e && e.id === id && auth && e.tok === auth.token) return { res: e.res, t0: e.t0 };
  if (!auth || !auth.token || params.get('img') === '0' || !/^[\w-]+$/.test(id)) return null;
  const q = new URLSearchParams({ q: `appProperties has { key='skpvDoc' and value='${id}' } and trashed=false`,
    fields: 'files(appProperties,thumbnailLink)', pageSize: '1000' });
  const t0 = performance.now();
  const res = fetch(`${DRIVE()}/files?${q}`, { headers: { Authorization: 'Bearer ' + auth.token }, cache: 'no-store', credentials: 'omit' });
  res.catch(() => {});
  return { res, t0 };
}
// 清單 → 這一版（pagesV）的圖，頁數要對得上；不對（上傳到一半、舊版）就不用，照舊走 PDF
async function pageImages(pi, meta) {
  const a = meta.appProperties || {};
  if (!pi || !a.pagesV) return null;
  try {
    const r = await Promise.race([pi.res, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    if (!r.ok) { step(`page images list ${r.status}`, pi.t0); return null; }
    const files = ((await r.json()).files || []).filter((f) => (f.appProperties || {}).v === a.pagesV);
    step('page images list', pi.t0);
    const m = files.filter((f) => (f.appProperties || {}).b === 'm').length;
    if (!m || m !== Number(a.pages)) return null;
    return files;
  } catch (e) {
    return null;
  }
}

async function download(id, useKey) {
  const pre = startPre(id, useKey);
  const preImg = useKey ? null : startPreImg(id);
  const dropPre = () => { if (pre) pre.abort(); };
  let meta;
  let tm = performance.now();
  const em = window.__skpvPreMeta; // v0.10.0：index.html 一開頁就發了的
  window.__skpvPreMeta = null;
  if (em && !useKey && em.id === id && auth && em.tok === auth.token) {
    try {
      const r = await em.res;
      if (r.ok) { meta = await r.json(); tm = em.t0; }
    } catch (e) { meta = null; }
  }
  try {
    if (!meta) meta = await api(`/files/${encodeURIComponent(id)}`, { query: { fields: 'id,name,size,mimeType,appProperties,modifiedTime,md5Checksum,ownedByMe' }, useKey });
    step(useKey ? 'drive meta (key)' : 'drive meta', tm);
  } catch (e) { step(`drive meta failed ${e.status || ''}`, tm); dropPre(); throw e; }
  if (!isPdfMeta(meta)) dropPre();
  const mainName = meta.name;
  const mainReq = id;
  const mobileId = meta.appProperties && meta.appProperties.mobile;
  // 手機：有「手機版」（桌面程式 v0.5 起自動產生：貼圖縮小）就改下載手機版（v0.5）
  if (ui.device === 'phone' && mobileId && params.get('full') !== '1') {
    try {
      const m = await api(`/files/${encodeURIComponent(mobileId)}`, { query: { fields: 'id,name,size,mimeType' }, useKey });
      meta = { ...m, name: mainName, appProperties: meta.appProperties };
      id = mobileId;
      ui.toast(`手機自動改用手機版（${mb(Number(m.size || 0))}，${isPdfMeta(meta) ? '影像較小' : '貼圖較小'}）`, 3500);
    } catch (e) { /* 手機版不見了就用原檔 */ }
  } else if (!isPdfMeta(meta) && Number(meta.size || 0) / 1048576 > (ui.warnMB || Infinity)) {
    const size = mb(Number(meta.size || 0));
    if (!confirm(`這個模型很大（${size}），${ui.device === 'phone' ? '手機' : '這台裝置'}的記憶體可能不夠、開到一半網頁會被重新整理。\n\n` +
      '建議：請上傳的人用新版「SKP 轉檔上傳」重新上傳（會自動產生手機版），或改用電腦／平板開。\n\n仍要試著開啟嗎？')) {
      const err = new Error(`沒有開啟：模型 ${size}，超過${ui.device === 'phone' ? '手機' : '這台裝置'}建議的大小。請用電腦或平板開，或請上傳的人重新上傳（新版會自動產生手機版）。`);
      err.shown = true;
      ui.hideLoading();
      if (ui.showProblem) ui.showProblem('沒有開啟這個模型', err.message, false);
      throw err;
    }
  }
  if (ui.loadBegin) ui.loadBegin({ name: meta.name, size: Number(meta.size || 0), id });
  if (isPdfMeta(meta)) {
    if (!useKey && !signedIn()) await signIn();
    const headers = useKey ? {} : { Authorization: 'Bearer ' + auth.token };
    window.__skpvCloudLoaded = { requested: mainReq, loaded: id, mobile: id !== mainReq, pdf: true }; // 測試用
    const rf = rangeFetcher(mediaUrl(id, useKey), headers);
    // v0.9.0：自己登入、自己的檔案（擁有者）→ 下載完存在這台裝置上（下次秒開、現場沒網路也能開）
    const keep = !useKey && meta.ownedByMe === true && id === mainReq
      ? { id, name: meta.name, modifiedTime: meta.modifiedTime || '', md5: meta.md5Checksum || '' } : null;
    if (id !== mainReq) dropPre(); // 改開手機版：先發的請求是原檔的
    const images = id === mainReq ? await pageImages(preImg, meta) : null; // v0.10.0
    return { pdf: { size: Number(meta.size || 0), fetchRange: rf, open: rf.open, pre: id === mainReq ? pre : null, images }, name: meta.name, keep };
  }
  ui.showLoading(`下載 ${meta.name}（${mb(Number(meta.size || 0))}）…`);
  const res = await api(`/files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, raw: true, useKey });
  const total = Number(meta.size || res.headers.get('Content-Length') || 0);
  let buf;
  if (res.body && total) { // 顯示下載進度
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) { buf = null; break; }
      out.set(value, got);
      got += value.length;
      ui.showLoading(`下載 ${meta.name}… ${Math.round((100 * got) / total)}%`);
    }
    buf = got === total ? out.buffer : null;
  }
  if (!buf) buf = await (await api(`/files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, raw: true, useKey })).arrayBuffer();
  window.__skpvCloudLoaded = { requested: mainReq, loaded: id, mobile: id !== mainReq }; // 測試用
  return { buf, name: meta.name };
}

function takeEarly(id) {
  const e = window.__skpvPre;
  if (!e) return null;
  window.__skpvPre = null;
  if (e.id !== id) { e.abort(); return null; }
  return e;
}

// v0.9.0：這台裝置上存的版本（擁有者）→ 直接開（不用等網路），背景再跟雲端比對版本，不一樣就作廢、重新下載
async function openCached(id, t0) {
  if (params.get('nocache') === '1') return false;
  const rec = await offline.get(id);
  if (!rec || !rec.blob) return false;
  const early = takeEarly(id);
  if (early) early.abort(); // 這台裝置上有：網頁一開始先發的下載請求不用了
  let buf;
  try { buf = await rec.blob.arrayBuffer(); } catch (e) { await offline.del(id); return false; }
  await ui.openPdf({ data: buf, cached: true }, rec.name, t0, { keep: { id, name: rec.name, modifiedTime: rec.modifiedTime, md5: rec.md5, cached: true } });
  window.__skpvCloudLoaded = { requested: id, loaded: id, pdf: true, cached: true }; // 測試用
  verifyCached(id, rec);
  return true;
}
async function verifyCached(id, rec) {
  let meta = null;
  const q = { fields: 'id,modifiedTime,md5Checksum,trashed' };
  try {
    auth = auth || loadStored();
    if (signedIn()) meta = await api(`/files/${encodeURIComponent(id)}`, { query: q });
    else if (apiKey) meta = await api(`/files/${encodeURIComponent(id)}`, { query: q, useKey: true });
  } catch (e) {
    window.__skpvCacheCheck = e.status ? `error ${e.status}` : 'offline'; // 沒網路：照樣用這台裝置上的版本
    return;
  }
  if (!meta) { window.__skpvCacheCheck = 'unknown'; return; }
  if (meta.trashed) { window.__skpvCacheCheck = 'trashed'; ui.toast('雲端的這份文件已經刪除（這台裝置上的版本還能看）', 4000); return; }
  if (offline.sameVersion(rec, meta)) { window.__skpvCacheCheck = 'same'; return; }
  window.__skpvCacheCheck = 'changed';
  await offline.del(id);
  if (currentId !== id) return;
  ui.toast('雲端的文件已經更新（重新最佳化），下載新版…', 4000);
  openCloud(id);
}

export async function openCloud(id) {
  ui.showLoading('下載中…');
  const t0 = performance.now();
  try {
    if (await openCached(id, t0)) {
      afterOpen(id);
      return;
    }
    let got = null, pub = false;
    // 1. 先試「有連結就能看」（不用登入）。v0.9.0：不再先試抓 1 byte（Drive 每個請求要等好幾秒），讀不到再改用登入
    if (apiKey && !signedIn()) {
      try {
        got = await download(id, true);
        pub = true;
      } catch (e) { got = null; if (![403, 404].includes(e.status)) throw e; }
    }
    const login = async () => {
      if (!signedIn() && !loadStored()) {
        ui.hideLoading();
        showLocked(id);
        return null;
      }
      auth = auth || loadStored();
      return download(id, false);
    };
    // 2. 沒分享（或已登入）：用自己的 Google 帳號
    if (!got) { got = await login(); if (!got) return; }
    if (got.pdf) {
      try {
        await ui.openPdf(got.pdf, got.name, t0, { keep: got.keep });
      } catch (e) {
        if (!pub || ![401, 403, 404].includes(e.status)) throw e;
        got = await login();
        if (!got) return;
        await ui.openPdf(got.pdf, got.name, t0, { keep: got.keep });
      }
    } else await ui.loadBuffer(got.buf, got.name, t0);
    afterOpen(id);
  } catch (err) {
    if (err.shown) return; // 已經顯示原因（例如手機上太大的模型、使用者選擇不開）
    if (err.status === 404) {
      ui.hideLoading();
      showLocked(id, true);
    } else {
      ui.fail(err);
    }
  }
}
function afterOpen(id) {
  currentId = id;
  const u = new URL(location.href);
  ['src', 'm'].forEach((k) => u.searchParams.delete(k));
  u.searchParams.set('m', id);
  history.replaceState(null, '', u);
  $('#cloud').hidden = true;
  $('#locked').hidden = true;
  ui.onLoaded && ui.onLoaded();
}

function showLocked(id, notFound) {
  $('#locked-text').textContent = notFound && signedIn()
    ? '找不到這個模型：可能已被刪除，或不是這個 Google 帳號上傳的。'
    : '這個模型沒有公開分享。如果是你的模型，請登入上傳它的 Google 帳號。';
  $('#locked').hidden = false;
  $('#locked-login').onclick = async () => {
    try {
      await signIn();
      $('#locked').hidden = true;
      openCloud(id);
    } catch (e) { ui.toast(e.message, 4000); }
  };
}

// ---------- 我的模型 ----------
export async function showList() {
  const panel = $('#cloud');
  panel.hidden = false;
  if (!configured()) {
    renderMsg('網頁還沒設定 Google 帳號連結（請開發者照「Google設定步驟.md」設定）。');
    return;
  }
  if (!signedIn()) {
    auth = loadStored();
    if (!auth) { renderSignIn(); return; }
  }
  await refresh();
}

async function refresh() {
  $('#cloud-account').textContent = auth && auth.email ? auth.email : '';
  $('#cloud-logout').hidden = false;
  renderMsg('讀取中…');
  try {
    const res = await api('/files', { query: {
      q: "appProperties has { key='skpv' and value='1' } and trashed=false",
      fields: 'files(id,name,size,mimeType,modifiedTime,md5Checksum,ownedByMe,thumbnailLink,permissionIds,appProperties)',
      orderBy: 'modifiedTime desc', pageSize: '200',
    } });
    files = res.files || [];
    await renderList();
  } catch (e) {
    if (e.status === 401) { renderSignIn(); return; }
    renderMsg(e.status ? e.message : '連不上網路。下面是存在這台裝置上的文件（沒有網路也能開）。');
    renderDevice();
  }
}

// ---------- 存在這台裝置上的文件（v0.9.0，擁有者；現場沒網路也能開）----------
let dev = new Map(); // id → { id, name, size, modifiedTime, md5, savedAt, bytes }
const saving = new Map(); // id → 進度 0～1
async function loadDev() { dev = new Map((await offline.list()).map((r) => [r.id, r])); }
async function renderDevice() {
  await loadDev();
  const box = document.createElement('div');
  box.id = 'cloud-device';
  const cloudIds = new Set(files.map((f) => f.id));
  const only = [...dev.values()].filter((r) => !cloudIds.has(r.id));
  const total = [...dev.values()].reduce((t, r) => t + (r.bytes || 0), 0);
  if (!dev.size) { const old = $('#cloud-device'); if (old) old.remove(); return; }
  box.innerHTML = `<h3 class="dev-h">存在這台裝置上的文件（${dev.size} 份，${mb(total)}）<button class="btn" data-act="devclear">全部清除</button></h3>` +
    (only.length ? only.map((r) => `<div class="mitem" data-id="${esc(r.id)}"><button class="mopen" data-act="open"><span class="mtext"><b>${esc(r.name.replace(/\.pdf$/i, ''))}</b>
      <span class="small"><span class="mkind pdf">PDF</span> ${mb(r.bytes || 0)} · 存於 ${esc(fmtTime(r.savedAt))}</span></span></button>
      <div class="macts"><button class="btn" data-act="undev">從這台裝置清除</button></div></div>`).join('')
      : '<p class="small">上面清單裡標「已存在這台裝置」的文件，現場沒有網路也能開。</p>');
  const old = $('#cloud-device');
  if (old) old.replaceWith(box); else $('#cloud-list').appendChild(box);
}
function fmtTime(iso) {
  const t = new Date(iso);
  return isNaN(t) ? '' : `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
function devButtons(f) {
  if (!isPdfMeta(f) || f.ownedByMe === false) return '';
  if (saving.has(f.id)) return `<button class="btn" disabled>下載中 ${Math.floor(saving.get(f.id) * 100)}%</button>`;
  const r = dev.get(f.id);
  if (r && offline.sameVersion(r, f)) return '<span class="mdev">✓ 已存在這台裝置</span><button class="btn" data-act="undev">從這台裝置清除</button>';
  return `<button class="btn" data-act="dev">${r ? '更新這台裝置上的版本' : '下載到這台裝置（現場離線用）'}</button>`;
}
async function saveToDevice(id) {
  const f = files.find((x) => x.id === id);
  if (!f || saving.has(id)) return;
  if (!signedIn()) await signIn();
  const rf = rangeFetcher(mediaUrl(id, false), { Authorization: 'Bearer ' + auth.token });
  const src = new Source({ size: Number(f.size || 0), open: rf.open });
  saving.set(id, 0);
  if (!src.startFull()) { saving.delete(id); ui.toast('這份文件太大，這台裝置放不下', 4000); return; }
  await renderList();
  await new Promise((resolve) => {
    let last = 0;
    src.on((x) => {
      saving.set(id, x.progress);
      if (x.state !== 'loading') { resolve(); return; }
      if (performance.now() - last > 500) { last = performance.now(); renderList(); }
    });
  });
  try {
    if (src.state !== 'done') throw new Error('下載中斷');
    await offline.put({ id, name: f.name, size: src.size, modifiedTime: f.modifiedTime || '', md5: f.md5Checksum || '', blob: src.blob() });
    ui.toast(`「${f.name.replace(/\.pdf$/i, '')}」已存在這台裝置：現場沒有網路也能開`, 3500);
  } catch (e) {
    ui.toast(e.message === '下載中斷' ? '下載中斷了，請再試一次' : '這台裝置的儲存空間不夠，沒辦法存下來', 4000);
  } finally {
    src.close();
    saving.delete(id);
    await renderList();
  }
}

function renderMsg(text) {
  $('#cloud-list').innerHTML = `<p class="cloud-msg">${esc(text)}</p>`;
}
function renderSignIn() {
  $('#cloud-account').textContent = '';
  $('#cloud-logout').hidden = true;
  $('#cloud-list').innerHTML = `<div class="cloud-msg"><p>登入上傳檔案的 Google 帳號，就能看到全部模型和文件。</p>
    <button class="btn primary big" id="cloud-signin">用 Google 登入</button>
    <p class="small">只會讀取「SKP 轉檔上傳」程式上傳的模型和文件，看不到你 Google Drive 裡的其他檔案。</p></div>`;
  $('#cloud-signin').onclick = async () => {
    try { await signIn(); await refresh(); } catch (e) { ui.toast(e.message, 4000); }
  };
  renderDevice();
}
async function renderList() {
  await loadDev();
  if (!files.length) {
    renderMsg('還沒有檔案。請在電腦用「SKP 轉檔上傳」程式選 .skp 或 .pdf 上傳。');
    renderDevice();
    return;
  }
  $('#cloud-list').innerHTML = files.map((f) => {
    const shared = (f.permissionIds || []).includes('anyoneWithLink');
    const t = new Date(f.modifiedTime);
    const when = isNaN(t) ? '' : `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const pdf = isPdfMeta(f);
    const name = f.name.replace(/\.(glb|pdf)$/i, '');
    const thumb = f.thumbnailLink ? `<img src="${esc(f.thumbnailLink)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    return `<div class="mitem${f.id === currentId ? ' current' : ''}" data-id="${esc(f.id)}">
      <button class="mopen" data-act="open"><span class="mthumb">${thumb}</span>
        <span class="mtext"><b>${esc(name)}</b><span class="small"><span class="mkind ${pdf ? 'pdf' : 'skp'}">${pdf ? 'PDF' : '3D'}</span> ${when} · ${mb(Number(f.size || 0))}${pdf && f.appProperties && f.appProperties.pages ? ` · ${esc(f.appProperties.pages)} 頁` : ''}${!pdf && f.appProperties && f.appProperties.scenes ? ` · ${esc(f.appProperties.scenes)} 個場景` : ''}</span>
        <span class="mshare ${shared ? 'on' : ''}">${shared ? '舊式公開分享中（原檔，沒有期限）' : '只有我'}${f.appProperties && f.appProperties.mobile ? ' · 有手機版' : ''}</span></span></button>
      <div class="macts">${devButtons(f)}${shared ? '<button class="btn" data-act="share">複製舊式連結</button><button class="btn" data-act="unshare">取消舊式分享</button>'
        : '<span class="small">分享：用電腦的「SKP 轉檔上傳」新增（每人一條）</span>'}</div></div>`;
  }).join('');
  renderDevice();
}

function shareUrl(id) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('m', id);
  return u.href;
}

async function shareFile(id) {
  const f = files.find((x) => x.id === id);
  if (f && !(f.permissionIds || []).includes('anyoneWithLink')) {
    // v0.6.0 起網頁不再公開原檔；分享一律用桌面程式「新增分享」（每人一份副本、有期限和開啟紀錄）
    ui.toast('分享請用電腦的「SKP 轉檔上傳」→「新增分享」（每人一條連結）', 4000);
    return;
  }
  // 以下只給 v0.5 以前已經公開的舊式分享：複製原本的連結
  const url = shareUrl(id);
  const title = f ? f.name.replace(/\.glb$/i, '') : 'SKP 模型';
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title, text: `${title}（3D 模型，可旋轉、量尺寸）`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('分享連結已複製，可以貼到 LINE', 3000);
  } catch (e) {
    prompt('分享連結（長按複製）', url);
  }
}
async function unshareFile(id) {
  if (!confirm('取消分享後，之前傳出去的連結別人就打不開了。確定？')) return;
  await api(`/files/${encodeURIComponent(id)}/permissions/anyoneWithLink`, { method: 'DELETE' });
  const f = files.find((x) => x.id === id);
  const mob = f && f.appProperties && f.appProperties.mobile;
  if (mob) {
    try { await api(`/files/${encodeURIComponent(mob)}/permissions/anyoneWithLink`, { method: 'DELETE' }); } catch (e) { /* 略過 */ }
  }
  if (f) f.permissionIds = (f.permissionIds || []).filter((p) => p !== 'anyoneWithLink');
  renderList();
  ui.toast('已取消分享');
}

export function init(hooks) {
  ui = hooks;
  auth = loadStored();
  $('#cloud-close').onclick = () => { $('#cloud').hidden = true; };
  $('#locked-close').onclick = () => { $('#locked').hidden = true; };
  $('#cloud-logout').onclick = () => { signOut(); files = []; renderSignIn(); };
  $('#cloud-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'devclear') {
      if (confirm('把存在這台裝置上的文件全部清除？（雲端的檔案不受影響）')) { await offline.clearAll(); ui.toast('已清除', 2500); if (files.length) await renderList(); else await renderDevice(); }
      return;
    }
    const id = b.closest('.mitem').dataset.id;
    try {
      if (b.dataset.act === 'open') await openCloud(id);
      else if (b.dataset.act === 'share') await shareFile(id);
      else if (b.dataset.act === 'unshare') await unshareFile(id);
      else if (b.dataset.act === 'dev') await saveToDevice(id);
      else if (b.dataset.act === 'undev') { await offline.del(id); ui.toast('已從這台裝置清除', 2500); if (files.length) await renderList(); else await renderDevice(); }
    } catch (err) { ui.toast(err.message, 4000); }
  });
  window.skpvCloud = { openCloud, showList, signedIn, saveToDevice, offlineList: offline.list, get files() { return files; } };
}

function mb(bytes) { return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
