// 分享連結（v0.6.0）：?s=連結權杖&k=紀錄端點的部署編號#n=收件人稱呼
// 1. 問紀錄端點（設計方自己的 Apps Script）這條連結的狀態：有效才繼續（過期、取消、沒網路都不顯示）
// 2. 第一次開啟先顯示著作權與使用聲明；按「我同意並開啟」才記錄、才載入；按「不同意」什麼都不做
// 3. 記一筆開啟紀錄（時間由端點記、IP、裝置類型、作業系統、瀏覽器），端點這時才給模型的檔案編號
// 4. 下載模型：cache:'no-store'，不進瀏覽器快取、Service Worker、IndexedDB；只留在這一頁的記憶體
// 螢幕上看得到的東西，技術上一定擷取得到；這些措施是控制、提醒和追查，不是「別人就拿不到」。
import { CONFIG } from './config.js';
import { renderNotice, AGREE, DISAGREE, IP_SERVICE } from './notice.js';

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

const STATUS_TEXT = {
  expired: ['這條分享連結已經過期', '有效期限已過，模型不會再顯示。如果還需要看，請聯絡分享給你的人重新分享。'],
  revoked: ['這條分享連結已被取消', '分享的人已經取消這條連結，模型不會再顯示。'],
  unknown: ['找不到這條分享連結', '可能已經刪除，或網址不完整（請確認整段網址都有複製到）。'],
  busy: ['開啟次數太頻繁', '這條連結短時間內開啟太多次，請過幾分鐘再試。'],
  offline: ['沒辦法確認這條連結', '分享的模型每次開啟都要先上網確認連結還有效，沒有網路時不會顯示。請連上網路後重新整理。<br>如果網路正常還是這樣，可能是連結網址不完整，或分享的人已經停用這條連結，請聯絡分享給你的人。'],
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
    $('#notice-text').innerHTML = renderNotice(fields);
    $('#notice-yes').textContent = AGREE;
    $('#notice-no').textContent = DISAGREE;
    $('#notice').hidden = false;
    $('#notice .card').scrollTop = 0;
    const done = (v) => { $('#notice').hidden = true; resolve(v); };
    $('#notice-yes').onclick = () => done(true);
    $('#notice-no').onclick = () => done(false);
  });
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
  let c;
  try {
    c = await getJson(`${ep}?a=check&t=${encodeURIComponent(t)}`);
  } catch (e) {
    return problem(ui, 'offline');
  }
  if (c.status !== 'active') return problem(ui, c.status in STATUS_TEXT ? c.status : 'unknown');
  ui.hideLoading();
  document.title = `#${c.code} — SKP 瀏覽器`;
  const h = await hash(t);
  if (!(h && readAgreed()[h])) {
    const ok = await askNotice({ 收件人稱呼: label.slice(0, 40), 代號: c.code, 到期日: fmtDate(c.expires), 設計公司名稱: c.company, 聯絡方式: c.contact });
    if (!ok) {
      ui.showProblem('沒有開啟', '你選了「不同意」，所以沒有載入模型，也沒有記錄。要看的話請重新整理網頁。', false);
      document.body.dataset.share = 'declined';
      return;
    }
    writeAgreed(h, c.expires);
  } else {
    ui.toast(`分享代號 #${c.code}：開啟會記錄（你之前已同意聲明）`, 3500);
  }
  ui.showLoading('開啟中…');
  const env = deviceInfo(ui.device);
  const ip = await lookupIp();
  let o;
  try {
    o = await getJson(ep, { method: 'POST', body: JSON.stringify({ a: 'open', t, ip, ...env }) });
  } catch (e) {
    return problem(ui, 'offline');
  }
  if (o.status !== 'active' || !o.file) return problem(ui, o.status in STATUS_TEXT ? o.status : 'unknown');
  const name = `#${o.code}`;
  ui.loadBegin({ name, size: 0 });
  ui.showLoading('下載模型…');
  let buf;
  try {
    const res = await fetch(`${base}/drive/v3/files/${encodeURIComponent(o.file)}?alt=media&key=${encodeURIComponent(apiKey)}`,
      { cache: 'no-store', credentials: 'omit' });
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

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
