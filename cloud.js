// 雲端（Google Drive）：登入看「我的模型」、分享單一模型的連結、用 ?m=檔案ID 開啟。
// 範圍 drive.file：只碰「SKP 轉檔上傳」程式上傳的檔案，看不到 Drive 裡其他東西。
// 模型檔直接從 Google 下載到這台裝置，不經過其他伺服器。
import { CONFIG } from './config.js';

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

// ---------- 開啟雲端模型 ----------
async function download(id, useKey) {
  let meta = await api(`/files/${encodeURIComponent(id)}`, { query: { fields: 'id,name,size,appProperties' }, useKey });
  const mainName = meta.name;
  const mainReq = id;
  const mobileId = meta.appProperties && meta.appProperties.mobile;
  // 手機：有「手機版」（桌面程式 v0.5 起自動產生：貼圖縮小）就改下載手機版（v0.5）
  if (ui.device === 'phone' && mobileId && params.get('full') !== '1') {
    try {
      const m = await api(`/files/${encodeURIComponent(mobileId)}`, { query: { fields: 'id,name,size' }, useKey });
      meta = { ...m, name: mainName };
      id = mobileId;
      ui.toast(`手機自動改用手機版（${mb(Number(m.size || 0))}，貼圖較小）`, 3500);
    } catch (e) { /* 手機版不見了就用原檔 */ }
  } else if (Number(meta.size || 0) / 1048576 > (ui.warnMB || Infinity)) {
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

export async function openCloud(id) {
  ui.showLoading('下載中…');
  const t0 = performance.now();
  try {
    let got = null;
    // 1. 先試「有連結就能看」（不用登入）
    if (apiKey && !signedIn()) {
      try { got = await download(id, true); } catch (e) { if (![403, 404].includes(e.status)) throw e; }
    }
    // 2. 沒分享（或已登入）：用自己的 Google 帳號
    if (!got) {
      if (!signedIn() && !loadStored()) {
        ui.hideLoading();
        showLocked(id);
        return;
      }
      auth = auth || loadStored();
      got = await download(id, false);
    }
    await ui.loadBuffer(got.buf, got.name, t0);
    currentId = id;
    const u = new URL(location.href);
    ['src', 'm'].forEach((k) => u.searchParams.delete(k));
    u.searchParams.set('m', id);
    history.replaceState(null, '', u);
    $('#cloud').hidden = true;
    $('#locked').hidden = true;
    ui.onLoaded && ui.onLoaded();
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
      fields: 'files(id,name,size,modifiedTime,thumbnailLink,permissionIds,appProperties)',
      orderBy: 'modifiedTime desc', pageSize: '200',
    } });
    files = res.files || [];
    renderList();
  } catch (e) {
    if (e.status === 401) { renderSignIn(); return; }
    renderMsg(e.message);
  }
}

function renderMsg(text) {
  $('#cloud-list').innerHTML = `<p class="cloud-msg">${esc(text)}</p>`;
}
function renderSignIn() {
  $('#cloud-account').textContent = '';
  $('#cloud-logout').hidden = true;
  $('#cloud-list').innerHTML = `<div class="cloud-msg"><p>登入上傳模型的 Google 帳號，就能看到全部模型。</p>
    <button class="btn primary big" id="cloud-signin">用 Google 登入</button>
    <p class="small">只會讀取「SKP 轉檔上傳」程式上傳的模型，看不到你 Google Drive 裡的其他檔案。</p></div>`;
  $('#cloud-signin').onclick = async () => {
    try { await signIn(); await refresh(); } catch (e) { ui.toast(e.message, 4000); }
  };
}
function renderList() {
  if (!files.length) {
    renderMsg('還沒有模型。請在電腦用「SKP 轉檔上傳」程式選 .skp 上傳。');
    return;
  }
  $('#cloud-list').innerHTML = files.map((f) => {
    const shared = (f.permissionIds || []).includes('anyoneWithLink');
    const t = new Date(f.modifiedTime);
    const when = isNaN(t) ? '' : `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const name = f.name.replace(/\.glb$/i, '');
    const thumb = f.thumbnailLink ? `<img src="${esc(f.thumbnailLink)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    return `<div class="mitem${f.id === currentId ? ' current' : ''}" data-id="${esc(f.id)}">
      <button class="mopen" data-act="open"><span class="mthumb">${thumb}</span>
        <span class="mtext"><b>${esc(name)}</b><span class="small">${when} · ${mb(Number(f.size || 0))}${f.appProperties && f.appProperties.scenes ? ` · ${esc(f.appProperties.scenes)} 個場景` : ''}</span>
        <span class="mshare ${shared ? 'on' : ''}">${shared ? '有連結就能看' : '只有我'}${f.appProperties && f.appProperties.mobile ? ' · 有手機版' : ''}</span></span></button>
      <div class="macts"><button class="btn" data-act="share">${shared ? '複製分享連結' : '分享連結'}</button>
        ${shared ? '<button class="btn" data-act="unshare">取消分享</button>' : ''}</div></div>`;
  }).join('');
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
    if (!confirm(`分享「${f.name.replace(/\.glb$/i, '')}」？\n有連結的人不用登入就能看這個模型（看不到你其他的模型）。`)) return;
    await api(`/files/${encodeURIComponent(id)}/permissions`, { method: 'POST', body: { role: 'reader', type: 'anyone', allowFileDiscovery: false } });
    f.permissionIds = [...(f.permissionIds || []), 'anyoneWithLink'];
    renderList();
  }
  // 手機版也要分享，手機開分享連結時才拿得到（v0.5）
  const mob = f && f.appProperties && f.appProperties.mobile;
  if (mob) {
    try { await api(`/files/${encodeURIComponent(mob)}/permissions`, { method: 'POST', body: { role: 'reader', type: 'anyone', allowFileDiscovery: false } }); } catch (e) { /* 略過 */ }
  }
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
    const id = b.closest('.mitem').dataset.id;
    try {
      if (b.dataset.act === 'open') await openCloud(id);
      else if (b.dataset.act === 'share') await shareFile(id);
      else if (b.dataset.act === 'unshare') await unshareFile(id);
    } catch (err) { ui.toast(err.message, 4000); }
  });
  window.skpvCloud = { openCloud, showList, signedIn, get files() { return files; } };
}

function mb(bytes) { return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
