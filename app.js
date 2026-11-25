// SKP 瀏覽器（瀏覽端）— 開啟桌面程式「SKP 轉檔上傳」轉出的 .glb 瀏覽檔和 PDF。
// 純前端：檔案用檔案選擇器在本機讀取，或從自己的 Google Drive 下載（cloud.js）。
// v0.10.0：這個檔只放介面外殼；3D 模型（three.js）在 model3d.js，開到 .glb 才載入。
import * as cloud from './cloud.js';
import * as mem from './device.js';
import * as share from './share.js';
import * as pdfv from './pdfview.js';

const APP_VERSION = '0.10.5';
window.__skpvVersion = APP_VERSION; // 測試用（Service Worker 換版）
const $ = (s) => document.querySelector(s);
const app = $('#app');
const params = new URLSearchParams(location.search);
let fileInfo = {};

// ---------- 3D 模型：要用到才載入 ----------
let m3 = null;
let m3P = null;
function load3d() {
  if (!m3P) {
    m3P = import('./model3d.js').then((m) => { m.init({ toast, showLoading, hideLoading, showProblem, leavePdf }); m3 = m; return m; });
    m3P.catch(() => { m3P = null; });
  }
  return m3P;
}
function leavePdf() {
  app.classList.remove('chrome-off');
  if (app.classList.contains('pdf')) { pdfv.close(); app.classList.remove('pdf'); pdfInfo = null; document.body.classList.remove('shared'); }
}
// ---------- 讀檔 ----------
for (const id of ['#file', '#file2']) {
  $(id).addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) openFile(f);
  });
}
// 電腦可以直接拖進來
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

async function openFile(file) {
  loadBegin({ name: file.name, size: file.size });
  history.replaceState(null, '', location.pathname); // 本機檔案沒有分享網址
  showLoading(`讀取 ${file.name}…`);
  const t0 = performance.now();
  try {
    const buf = await file.arrayBuffer();
    await loadBuffer(buf, file.name, t0);
  } catch (err) {
    fail(err);
  }
}

async function openUrl(url) {
  loadBegin({ name: decodeURIComponent(url.split('/').pop()), size: 0 });
  showLoading('下載中…');
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`讀不到檔案（${res.status}）`);
    const buf = await res.arrayBuffer();
    await loadBuffer(buf, decodeURIComponent(url.split('/').pop()), t0);
  } catch (err) {
    fail(err);
  }
}

function fail(err) {
  hideLoading();
  loadEnd();
  if (loadingModel) {
    loadingModel = false;
    showProblem('檔案開不起來', `${err && err.message ? err.message : err}`, true);
    console.error(err);
    return;
  }
  console.error(err);
  toast(String(err && err.message ? err.message : err), 5000);
}

// ---------- 載入失敗偵測（v0.5） ----------
// 手機記憶體不夠時，iPhone Safari／Android Chrome 會直接把分頁重新載入，網頁來不及顯示任何訊息。
// 所以開始載入前先在 localStorage 記一筆「正在載入 X」，成功或正常失敗都會清掉；
// 下次打開網頁還看到這一筆（10 分鐘內），就知道上次是載入到一半被重新載入，顯示原因。
const LOAD_KEY = 'skpv-loading';
let loadingModel = false;
function loadBegin(info) {
  loadingModel = true;
  try { localStorage.setItem(LOAD_KEY, JSON.stringify({ ...info, t: Date.now(), ua: navigator.userAgent.slice(0, 120) })); } catch (e) { /* 略過 */ }
}
function loadEnd() {
  try { localStorage.removeItem(LOAD_KEY); } catch (e) { /* 略過 */ }
}
function checkLastLoad() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LOAD_KEY) || 'null'); } catch (e) { /* 略過 */ }
  loadEnd();
  if (!last || Date.now() - last.t > 10 * 60 * 1000) return null;
  const what = `「${last.name || '模型'}」${last.size ? `（${mb(last.size)}）` : ''}`;
  showProblem('上次沒有開成功', `上次開啟${what}時，網頁在載入途中被重新整理了。這通常是<b>手機記憶體不夠</b>（模型或貼圖太大），瀏覽器把網頁關掉重開。` +
    '<ul><li>在電腦或平板開同一個連結通常可以。</li><li>請上傳的人在電腦的「SKP 轉檔上傳」（v0.5 以上）選這個模型、按「<b>建立手機版</b>」，之後手機開同一個連結會自動用手機版。</li></ul>', false);
  return last;
}
function showProblem(title, html, isError) {
  $('#problem-title').textContent = title;
  $('#problem-text').innerHTML = html;
  $('#problem').hidden = false;
  $('#problem').classList.toggle('error', !!isError);
}
$('#problem-close').addEventListener('click', () => { $('#problem').hidden = true; });

async function loadBuffer(buf, name, t0, opts = {}) {
  if (pdfv.isPdf(buf)) return openPdf({ data: buf }, name, t0, opts); // v0.7.0：PDF
  const head = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...head) !== 'glTF') {
    throw new Error('這不是瀏覽檔（.glb）或 PDF。請在電腦用「SKP 轉檔上傳」程式把 .skp 或 .pdf 轉檔上傳。');
  }
  showLoading('載入 3D 程式…');
  const m = await load3d();
  fileInfo = await m.loadGlb(buf, name, t0, opts);
  hideLoading();
  loadEnd();
  loadingModel = false;
  updateMeta();
}

// ---------- PDF（v0.7.0）：src＝{ data } 或 { size, fetchRange }（分段讀取）----------
let pdfInfo = null;
async function openPdf(src, name, t0 = performance.now(), opts = {}) {
  const wasEmpty = app.classList.contains('empty');
  const wasPdf = app.classList.contains('pdf');
  showLoading('開啟 PDF…');
  app.classList.add('pdf');
  app.classList.remove('empty');
  let r;
  try {
    r = await pdfv.openPdf(src, { name, share: opts.share, keep: opts.keep || null, t0, hooks: { toast } });
  } catch (err) {
    if (!wasPdf) app.classList.remove('pdf');
    if (wasEmpty) app.classList.add('empty');
    throw err;
  }
  if (!r) return; // 已經改開別的檔案
  if (m3) m3.unload(); // 3D 模型的記憶體放掉、浮水印拿掉
  pdfInfo = { ...r, name, info: pdfv.info() };
  fileInfo = { name, bytes: r.bytes, share: r.share, pdf: true };
  document.body.classList.toggle('shared', !!r.share);
  hideLoading();
  loadEnd();
  loadingModel = false;
  updateMeta();
  document.title = `${r.share ? '#' + r.share.code : name.replace(/\.pdf$/i, '')} — SKP 瀏覽器`;
  return r;
}

// ---------- 介面雜項 ----------
function showLoading(text) {
  $('#loading').hidden = false;
  $('#loading-text').textContent = text;
}
function hideLoading() { $('#loading').hidden = true; }
let toastTimer = 0;
function toast(text, ms = 2000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function mb(bytes) { return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function updateMeta() {
  $('#info-title').textContent = fileInfo.pdf ? '文件資訊' : '模型資訊';
  $('#info-pdf-help').hidden = !fileInfo.pdf;
  $('#info-3d-help').hidden = !!fileInfo.pdf;
  if (fileInfo.pdf) {
    const i = pdfv.info();
    $('#model-name').textContent = fileInfo.share ? `#${fileInfo.share.code}` : fileInfo.name.replace(/\.pdf$/i, '');
    $('#model-meta').textContent = `${mb(i.bytes)} · ${i.pages} 頁`;
    const t = i.timing || {};
    const rows = [
      ['檔案', fileInfo.share ? `#${fileInfo.share.code}` : fileInfo.name],
      ['大小', mb(i.bytes)],
      ['頁數', i.pages],
      ['讀取方式', i.mode === 'range' ? `分段讀取（目前已下載 ${mb(i.fetched)}，${i.requests} 次）` : '整個檔案'],
      ['開啟時間', `${((t.firstPage || 0) / 1000).toFixed(2)} 秒看到第一頁`],
      ...(fileInfo.share ? [['分享', `#${fileInfo.share.code}，有效到 ${share.fmtDate(fileInfo.share.expires)}（僅供檢視，不提供下載和列印）`]] : []),
      ['瀏覽器', `${APP_VERSION}（${{ phone: '手機', tablet: '平板', desktop: '電腦' }[mem.DEVICE]}）`],
    ];
    $('#info-list').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
    return;
  }
  const mi = m3.metaInfo(APP_VERSION);
  $('#model-name').textContent = mi.name;
  $('#model-meta').textContent = mi.meta;
  $('#info-list').innerHTML = mi.rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
$('#info-btn').addEventListener('click', () => { if (fileInfo.pdf) updateMeta(); uiModeText(); $('#info').hidden = false; });
// v0.10.2：版面（觸控看圖模式／電腦版）：自動判斷，也可以在這裡切換（記在這台裝置，重新整理後生效）
function uiModeText() {
  $('#ui-mode').textContent = mem.TOUCH_UI ? '觸控看圖模式（手機、平板）' : '電腦版';
  $('#ui-toggle').textContent = mem.TOUCH_UI ? '改用電腦版' : '改用觸控看圖模式';
}
$('#ui-toggle').addEventListener('click', () => { mem.setUiMode(mem.TOUCH_UI ? 'desktop' : 'touch'); location.reload(); });
$('#info-close').addEventListener('click', () => { $('#info').hidden = true; });
$('#info').addEventListener('click', (e) => { if (e.target.id === 'info') $('#info').hidden = true; });

// ---------- 離線（PWA） ----------
// v0.10.0：Service Worker 改成「先用快取」（網頁本身第二次開不用等網路）。第一次開時等第一個檔開好（或 8 秒）才註冊，
// 預先下載網頁程式才不會跟開檔的請求搶頻寬。本機測試照舊「網路優先」（改了程式馬上看得到），網址加 &swcache=1 測快取優先。
let swDone = false;
function registerSw() {
  if (swDone) return;
  swDone = true;
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  const local = location.protocol !== 'https:';
  navigator.serviceWorker.register(local && params.get('swcache') !== '1' ? 'sw.js' : 'sw.js?mode=cache').then(() => {
    $('#offline-state').textContent = '已可離線使用：加到主畫面後，沒有網路也能開。';
  }).catch(() => {});
}

// ---------- 測試／示範用的網址參數 ----------
// ?src=檔案網址  &scene=場景序號（0＝匯出時的畫面）  &mode=measure|edge
// &demo=x1,y1,z1;x2,y2,z2   （SketchUp 公釐座標）用一般「點螢幕」的流程量兩點，會偏移幾個像素測試吸附
// &edges=0
pdfv.init({ toast });
cloud.init({ loadBuffer, openPdf, showLoading, hideLoading, fail, toast, loadBegin, showProblem, device: mem.DEVICE, warnMB: mem.WARN_FILE_MB });
const lastFailed = checkLastLoad();
$('#cloud-btn').addEventListener('click', () => cloud.showList());
$('#welcome-cloud').addEventListener('click', () => cloud.showList());
const shareUi = { loadBuffer, openPdf, showLoading, hideLoading, toast, loadBegin, showProblem, device: mem.DEVICE };
const first = share.isShareLink() ? share.openShare(shareUi).catch(fail)
  : params.get('m') ? cloud.openCloud(params.get('m')) : params.get('src') ? openUrl(params.get('src')) : null;
setTimeout(registerSw, first ? 8000 : 0); // v0.10.0：第一個檔開好前不註冊（見 registerSw）
if (first) {
  first.catch(() => {}).finally(() => setTimeout(registerSw, 500));
  first.then(() => {
    if (app.classList.contains('pdf')) { document.body.dataset.ready = '1'; return; }
    if (!m3 || !m3.hasModel()) return;
    m3.applyParams();
    if (params.get('info') === '1') $('#info').hidden = false;
    document.body.dataset.ready = '1';
  });
}
