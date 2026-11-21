// SKP 瀏覽器（瀏覽端）— 開啟桌面程式「SKP 轉檔上傳」轉出的 .glb 瀏覽檔。
// 純前端：檔案用檔案選擇器在本機讀取，或從自己的 Google Drive 下載（cloud.js）。
import * as THREE from './lib/three.module.min.js';
import { OrbitControls } from './lib/OrbitControls.js';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { mergeGeometries } from './lib/BufferGeometryUtils.js';
import * as cloud from './cloud.js';
import * as mem from './memory.js';

const APP_VERSION = '0.5.0';
const FORMAT_VERSION = 1;
const $ = (s) => document.querySelector(s);
const app = $('#app');
const canvas = $('#view');
const stage = $('#stage');
const overlay = $('#overlay');

// ---------- three.js 基本設定 ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 手機 DPR 3 也只用 2
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef1f4);
const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 2.6);
scene.add(hemi);
const perspCam = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 4000);
let camera = perspCam;
const headLight = new THREE.DirectionalLight(0xffffff, 1.0);
headLight.position.set(0.3, 0.6, 1);
perspCam.add(headLight);
const headLight2 = headLight.clone();
orthoCam.add(headLight2);
scene.add(perspCam, orthoCam);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.zoomToCursor = true;

let model = null; // gltf.scene
let data = null; // extras.skpViewer
let bounds = { center: new THREE.Vector3(), radius: 10 };
let taggedNodes = []; // { obj, tag, pid }
let lineObjects = [];
let meshObjects = [];
let pickables = null; // 目前看得見的網格（量測用），狀態改變時重建
let edgesOn = true;
let mode = 'orbit';
let dirty = true;
let anim = null;
let activeScene = -1;
let fileInfo = {};
let lastPivot = '';
let loadInfo = {};
let edgesAutoOff = false;

// ---------- 畫面大小 ----------
function resize() {
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  renderer.setSize(w, h, false);
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
  updateOrtho();
  dirty = true;
}
function updateOrtho() {
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  const half = (orthoCam.userData.height || 10) / 2;
  orthoCam.left = (-half * w) / h;
  orthoCam.right = (half * w) / h;
  orthoCam.top = half;
  orthoCam.bottom = -half;
  orthoCam.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(resize, 300));

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
    showProblem('模型開不起來', `${err && err.message ? err.message : err}`, true);
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
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  hideLoading();
  showProblem('畫面被手機關掉了', '顯示卡的記憶體不夠（WebGL context lost），通常是模型或貼圖太大。請重新整理網頁；如果一直發生，請在電腦用「SKP 轉檔上傳」重新上傳較小的版本（壓縮貼圖 1024）。', true);
}, false);

async function loadBuffer(buf, name, t0) {
  const head = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...head) !== 'glTF') {
    throw new Error('這不是瀏覽檔（.glb）。請在電腦用「SKP 轉檔上傳」程式把 .skp 轉檔產生。');
  }
  const tRead = performance.now();
  showLoading('建立模型…');
  // 依裝置的記憶體預算決定貼圖最大邊長，載入時直接解碼成小尺寸（v0.5）
  const scan = mem.scanGlb(buf);
  const maxTex = renderer.capabilities.maxTextureSize;
  const pickCap = mem.chooseCap(scan.images, maxTex);
  const texStats = { count: 0, resized: 0, skipped: 0, skippedList: [], gpuMB: 0, maxDim: 0 };
  const loader = new GLTFLoader();
  loader.register((parser) => {
    parser.textureLoader = mem.makeTextureLoader(pickCap.cap, texStats);
    return { name: 'skpv_texture_budget' };
  });
  if (pickCap.cap < 4096 && scan.images.length) showLoading(`建立模型…（${mem.DEVICE === 'phone' ? '手機' : '平板'}：貼圖縮到 ${pickCap.cap} px）`);
  const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
  const tParse = performance.now();
  loadInfo = {
    device: mem.DEVICE, fileMB: +(buf.byteLength / 1048576).toFixed(1), textures: scan.images.length,
    texCap: pickCap.cap, texBudgetMB: mem.TEX_BUDGET_MB, texFullMB: Math.round(pickCap.fullMb), texMB: Math.round(texStats.gpuMB),
    resized: texStats.resized, skipped: texStats.skipped, skippedList: texStats.skippedList.slice(0, 5), maxTexture: maxTex,
  };
  window.__skpvLoadInfo = loadInfo;
  const extras = (gltf.parser.json.extras || {}).skpViewer || null;
  if (extras && extras.format > FORMAT_VERSION) {
    toast('這個檔案是較新版的「SKP 轉檔上傳」產生的，部分功能可能無法顯示，請重新打開網頁取得新版。', 5000);
  }
  setModel(gltf.scene, extras);
  fileInfo = { name, bytes: buf.byteLength };
  renderer.render(scene, camera); // 第一次繪製（含著色器編譯、貼圖上傳），同步完成
  renderer.getContext().finish();
  const tFirst = performance.now();
  fileInfo.timing = { read: tRead - t0, parse: tParse - tRead, firstFrame: tFirst - tParse, total: tFirst - t0 };
  window.__skpvTiming = fileInfo.timing;
  hideLoading();
  loadEnd();
  loadingModel = false;
  updateMeta();
  if (loadInfo.skipped) toast(`有 ${loadInfo.skipped} 張超大貼圖（${loadInfo.skippedList.join('、')}）手機記憶體放不下，先用灰色顯示`, 6000);
  else if (loadInfo.resized && mem.DEVICE !== 'desktop') toast(`${mem.DEVICE === 'phone' ? '手機' : '平板'}記憶體有限：${loadInfo.resized} 張貼圖縮到 ${loadInfo.texCap} px 顯示`, 3500);
  if (edgesAutoOff) toast('模型很大，邊線先關閉（按下方「邊線」可以打開）', 4000);
  document.title = `${data.title || name.replace(/\.glb$/i, '')} — SKP 瀏覽器`;
}

function setModel(root, extras) {
  if (model) {
    scene.remove(model);
    disposeTree(model);
  }
  model = root;
  data = extras || { title: '', scenes: [], current: null, stats: {} };
  taggedNodes = [];
  lineObjects = [];
  meshObjects = [];
  const matCache = new Map();
  model.traverse((o) => {
    const ud = o.userData || {};
    if (ud.tag || ud.pid != null) taggedNodes.push({ obj: o, tag: ud.tag || '', pid: ud.pid });
    if (o.isLineSegments || o.isLine) {
      o.material = edgeMaterial;
      o.renderOrder = 1;
      lineObjects.push(o);
    } else if (o.isMesh) {
      o.material = convertMaterial(o.material, matCache);
      if (LITE) liteGeometry(o.geometry);
      meshObjects.push(o);
    }
  });
  scene.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  bounds = { box, center: sphere.center, radius: Math.max(sphere.radius, 0.5) };
  perspCam.near = THREE.MathUtils.clamp(bounds.radius * 0.0005, 0.01, 0.1);
  perspCam.far = bounds.radius * 20 + 100;
  perspCam.updateProjectionMatrix();
  orthoCam.near = -bounds.radius * 10;
  orthoCam.far = bounds.radius * 20 + 100;
  controls.maxDistance = bounds.radius * 8;
  controls.minDistance = 0.02;
  mergeStatic();
  // 手機：邊線非常多時先關掉（看不到的邊線不會佔顯示記憶體），使用者可以自己打開
  let segs = 0;
  for (const l of lineObjects) segs += (l.geometry.index ? l.geometry.index.count : l.geometry.attributes.position.count) / 2;
  edgesAutoOff = mem.DEVICE === 'phone' && segs > 1000000;
  loadInfo.edgeSegments = segs;
  app.classList.remove('empty');
  clearMeasure();
  setEdges(!edgesAutoOff);
  buildSceneList();
  const start = data.selectedScene != null && data.scenes[data.selectedScene] ? data.selectedScene + 1 : 0;
  goScene(start, false);
  resize();
}

const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1b1b1b });

// 換成 Lambert（手機比較快），面往後推一點讓邊線畫在面上面
function convertMaterial(m, cache) {
  if (cache.has(m)) return cache.get(m);
  const opts = {
    color: m.color ? m.color.clone() : new THREE.Color(0xf2f2f2),
    map: m.map || null,
    side: THREE.DoubleSide,
    flatShading: LITE, // 手機：沒有法線，改用 GPU 算每個面的法線（本來就是平面著色，看起來一樣）
    transparent: !!m.transparent,
    opacity: m.opacity != null ? m.opacity : 1,
    alphaTest: m.alphaTest || 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  };
  if (opts.transparent) opts.depthWrite = false;
  const out = new THREE.MeshLambertMaterial(opts);
  out.name = m.name;
  m.dispose();
  cache.set(m, out);
  return out;
}

// 手機省記憶體（v0.5）：不要法線（flatShading 代替，網格約省 37%）。UV 要留著（點選／量測時 three.js 會讀）
const LITE = mem.DEVICE === 'phone' && new URLSearchParams(location.search).get('lite') !== '0';
const liteDone = new WeakSet();
function liteGeometry(g) {
  if (liteDone.has(g)) return;
  liteDone.add(g);
  if (g.attributes.normal) g.deleteAttribute('normal');
}

function disposeTree(root) {
  const mats = new Set();
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && o.material !== edgeMaterial) mats.add(o.material);
  });
  mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
}

// ---------- 場景 ----------
function sceneEntries() {
  const list = [];
  if (data.current) list.push({ ...data.current, isCurrent: true });
  for (const s of data.scenes || []) list.push(s);
  return list;
}

function buildSceneList() {
  const nav = $('#scenes');
  nav.innerHTML = '';
  const entries = sceneEntries();
  entries.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'scene' + (s.isCurrent ? ' current' : '');
    b.textContent = s.isCurrent ? '匯出時的畫面' : s.name;
    b.addEventListener('click', () => goScene(i, true));
    nav.appendChild(b);
  });
  app.classList.toggle('no-scenes', entries.length === 0);
}

function goScene(i, animate) {
  const entries = sceneEntries();
  const s = entries[i];
  if (!s) { fitAll(); return; }
  activeScene = i;
  document.querySelectorAll('#scenes .scene').forEach((b, k) => b.classList.toggle('active', k === i));
  const btn = document.querySelectorAll('#scenes .scene')[i];
  if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  applyVisibility(s);
  if (s.camera) setCamera(s.camera, animate);
  else if (!anim && i === 0) fitAll();
}

// 標記、物件的顯示：場景沒有記錄的項目沿用目前狀態（和 SketchUp 一樣）
const visState = { tags: new Set(), pids: new Set() };
function applyVisibility(s) {
  if (s.hiddenTags) visState.tags = new Set(s.hiddenTags);
  if (s.hiddenPids) visState.pids = new Set(s.hiddenPids);
  for (const n of taggedNodes) {
    n.obj.visible = !(n.tag && visState.tags.has(n.tag)) && !(n.pid != null && visState.pids.has(n.pid));
  }
  refreshMerged();
  pickables = null;
  dirty = true;
}

// ---------- 合併靜態網格（v0.3.1 效能） ----------
// SketchUp 的每個群組／元件實例原本各是一個網格＋一個邊線物件，大案子每幀要 2000 多次 draw call，
// 手機的 CPU 光是送 draw call 就要 30 ms 以上（縮放卡頓的主因，見 回報/v0.3.1.md）。
// 載入後把「材質相同、而且場景切換時一起顯示／隱藏」的網格合併成一個（座標先換成世界座標），
// 邊線也照同樣的規則合併。只有在某個場景會被隱藏的標記／物件才需要分開（switches）。
// 另外依位置分區合併，畫面外的區塊照樣會被略過（不分區的話軟體繪圖反而變慢，見回報）。
const MERGE_MAX_VERTS = 500000;
let merged = []; // { obj, switches: [節點], isLine }
let plainLines = []; // 沒合併的邊線（開關邊線時直接切換）
function mergeStatic() {
  merged = [];
  plainLines = lineObjects.slice();
  if (params.get('merge') === '0') return; // 測試／比較用：不合併
  const hideTags = new Set();
  const hidePids = new Set();
  for (const s of sceneEntries()) {
    (s.hiddenTags || []).forEach((t) => hideTags.add(t));
    (s.hiddenPids || []).forEach((p) => hidePids.add(p));
  }
  const switchable = new Set(taggedNodes.filter((n) => (n.tag && hideTags.has(n.tag)) || (n.pid != null && hidePids.has(n.pid))).map((n) => n.obj));
  model.updateMatrixWorld(true);
  // 記憶體保險：全部展開超過 400 萬個頂點時，重複很多次的元件（同一網格 ≥ 4 份）保留原樣不合併
  const uses = new Map();
  let total = 0;
  model.traverse((o) => {
    if (!(o.isMesh || o.isLineSegments)) return;
    uses.set(o.geometry, (uses.get(o.geometry) || 0) + 1);
    total += o.geometry.attributes.position.count;
  });
  const keepRepeated = total > (Number(params.get('mergelimit')) || (mem.DEVICE === 'phone' ? 1000000 : 4000000));
  const keptLines = [];
  const keptMeshes = [];
  const groups = new Map();
  const old = [];
  const cellSize = Math.max(bounds.radius / (Number(new URLSearchParams(location.search).get('cells')) || 6), 2);
  model.traverse((o) => {
    if (!(o.isMesh || o.isLineSegments)) return;
    if (keepRepeated && uses.get(o.geometry) >= 4) { if (o.isLineSegments) keptLines.push(o); else keptMeshes.push(o); return; }
    const sw = [];
    for (let p = o; p && p !== model; p = p.parent) if (switchable.has(p)) sw.push(p);
    const attrs = Object.keys(o.geometry.attributes).sort().join(',') + (o.geometry.index ? '|i' : '|n');
    // 依位置分區（每區約模型半徑的 1/2）：合併後仍能把畫面外的區塊略過不畫
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const c = o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
    const cell = [c.x, c.y, c.z].map((v, i) => Math.floor((v - bounds.box.min.getComponent(i)) / cellSize)).join(',');
    const key = `${o.isMesh ? 'm' : 'l'}|${o.material.uuid}|${attrs}|${sw.map((x) => x.id).join(',')}|${cell}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mat: o.material, isLine: !o.isMesh, switches: sw, chunks: [[]], verts: 0 }));
    const n = o.geometry.attributes.position.count;
    if (g.verts + n > MERGE_MAX_VERTS && g.chunks[g.chunks.length - 1].length) { g.chunks.push([]); g.verts = 0; }
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    g.chunks[g.chunks.length - 1].push(geo);
    g.verts += n;
    old.push(o);
  });
  const oldGeos = new Set(old.map((o) => o.geometry));
  for (const o of old) o.parent.remove(o);
  oldGeos.forEach((g) => g.dispose());
  const holder = new THREE.Group();
  holder.name = '合併網格';
  meshObjects = keptMeshes.slice();
  lineObjects = keptLines.slice();
  plainLines = keptLines.slice();
  for (const g of groups.values()) {
    for (const list of g.chunks) {
      if (!list.length) continue;
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) list.forEach((x) => x.dispose());
      geo.computeBoundingSphere();
      const obj = g.isLine ? new THREE.LineSegments(geo, g.mat) : new THREE.Mesh(geo, g.mat);
      obj.matrixAutoUpdate = false;
      if (g.isLine) { obj.renderOrder = 1; lineObjects.push(obj); } else meshObjects.push(obj);
      holder.add(obj);
      merged.push({ obj, switches: g.switches, isLine: g.isLine });
    }
  }
  model.add(holder); // 跟著 model 一起移除／釋放；holder 本身沒有縮放（座標已是世界座標）
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(model.matrixWorld).invert();
  holder.updateMatrixWorld(true);
  window.__skpvMerge = { from: old.length, to: merged.length, totalVerts: total, keepRepeated };
}
// 測試用：符合條件（標記／pid）的節點底下有沒有看得到的面
function shownBy(test) {
  let shown = false;
  model.traverseVisible((o) => {
    if (shown || !o.isMesh) return;
    const m = merged.find((x) => x.obj === o);
    if (m) { if (m.switches.some((s) => test(s.userData || {}))) shown = true; return; }
    for (let p = o; p; p = p.parent) if (p.userData && test(p.userData)) { shown = true; return; }
  });
  return shown;
}
function refreshMerged() {
  for (const l of plainLines) l.visible = edgesOn;
  for (const m of merged) {
    let v = m.switches.every((s) => s.visible);
    if (m.isLine) v = v && edgesOn;
    m.obj.visible = v;
  }
}

// 場景相機的旋轉／縮放中心。
// SketchUp 存場景時不保留「目標點」：Page#camera.target 一律被改成眼睛前方約 60 m（實測，research/scene_camera_probe.rb），
// 常常穿過牆、在地板下或模型外面。直接拿來當 OrbitControls 的中心，旋轉會繞著模型外的一點轉、縮放一步跳很遠、拉不近。
// 所以只用它的「方向」：從眼睛沿視線找第一個碰到的面當中心；沒碰到就取視線上最靠近模型中心的點。畫面方向完全不變。
function scenePivot(eye, dir) {
  const far = eye.distanceTo(bounds.center) + bounds.radius * 2;
  const rc = new THREE.Raycaster(eye, dir, 0.02, far);
  const hit = rc.intersectObjects(getPickables().meshes, false).find((h) => h.distance > 0.05);
  if (hit) return { point: hit.point.clone(), how: 'hit' };
  let t = bounds.center.clone().sub(eye).dot(dir);
  if (!(t > bounds.radius * 0.05)) t = Math.max(bounds.radius * 0.5, 1);
  return { point: eye.clone().addScaledVector(dir, t), how: 'center' };
}

function setCamera(c, animate) {
  const eye = new THREE.Vector3().fromArray(c.eye);
  const rawTarget = new THREE.Vector3().fromArray(c.target);
  const viewDir = rawTarget.clone().sub(eye).normalize();
  const pivot = model ? scenePivot(eye, viewDir) : { point: rawTarget, how: 'raw' };
  const target = pivot.point;
  lastPivot = pivot.how;
  const dir = target.clone().sub(eye);
  const dist = dir.length() || 1;
  controls.maxDistance = Math.max(bounds.radius * 8, dist * 2);
  // OrbitControls 固定 Y 軸朝上；正上方往下看時把眼睛往「畫面上方」的反方向挪一點，方向才會和 SketchUp 一樣
  if (Math.abs(dir.clone().normalize().y) > 0.999) {
    const up = new THREE.Vector3().fromArray(c.up || [0, 0, -1]);
    eye.addScaledVector(up, -dist * 0.002);
  }
  const wantOrtho = c.perspective === false;
  const cur = { eye: camera.position.clone(), target: controls.target.clone() };
  const sameKind = wantOrtho === camera.isOrthographicCamera;
  // SketchUp 的畫面通常是橫的；直向手機比較窄時，改成保留左右的範圍，SketchUp 裡看到的東西才都在畫面內
  const viewAspect = (stage.clientWidth || 1) / (stage.clientHeight || 1);
  const srcAspect = c.aspect > 0 ? c.aspect : viewAspect;
  // 完全保留左右範圍在直向手機上會太小，取一半（幾何平均）
  const widen = srcAspect > viewAspect ? Math.sqrt(srcAspect / viewAspect) : 1;
  if (wantOrtho) {
    orthoCam.userData.height = (c.height || dist) * widen;
    orthoCam.zoom = 1;
    updateOrtho();
  } else {
    let vfov = THREE.MathUtils.degToRad(c.fov || 35);
    if (c.fovIsHeight === false) vfov = 2 * Math.atan(Math.tan(vfov / 2) / srcAspect);
    vfov = 2 * Math.atan(Math.tan(vfov / 2) * widen);
    const fov = THREE.MathUtils.radToDeg(vfov);
    perspCam.fov = THREE.MathUtils.clamp(fov, 10, 120);
    perspCam.updateProjectionMatrix();
  }
  useCamera(wantOrtho ? orthoCam : perspCam);
  if (animate && sameKind && model) {
    anim = { t0: performance.now(), dur: 650, from: cur, to: { eye, target } };
  } else {
    anim = null;
    camera.position.copy(eye);
    controls.target.copy(target);
    camera.lookAt(target);
    controls.update();
  }
  dirty = true;
}

function useCamera(cam) {
  if (camera === cam) return;
  cam.position.copy(camera.position);
  camera = cam;
  controls.object = cam;
}

function fitAll() {
  if (!model) return;
  const r = bounds.radius;
  const c = bounds.center;
  useCamera(perspCam);
  perspCam.fov = 45;
  perspCam.updateProjectionMatrix();
  const d = r / Math.sin(THREE.MathUtils.degToRad(22.5));
  camera.position.set(c.x + d * 0.55, c.y + d * 0.6, c.z + d * 0.58);
  controls.target.copy(c);
  controls.update();
  dirty = true;
}

$('#home-btn').addEventListener('click', () => {
  if (activeScene >= 0) goScene(activeScene, true);
  else fitAll();
});

// ---------- 邊線 ----------
function setEdges(on) {
  edgesOn = on;
  refreshMerged();
  $('#edges-btn').classList.toggle('on', on);
  pickables = null;
  dirty = true;
}
$('#edges-btn').addEventListener('click', () => setEdges(!edgesOn));

// ---------- 工具模式 ----------
const HINTS = {
  measure: '點第一點，再點第二點（會吸附端點、邊線）',
  edge: '點一條邊線，顯示長度',
};
function setMode(m) {
  mode = m;
  document.querySelectorAll('.tool[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  clearMeasure();
  const hint = $('#hint');
  hint.hidden = !HINTS[m];
  hint.textContent = HINTS[m] || '';
  $('#axes').hidden = m !== 'measure';
  app.classList.toggle('axes-on', m === 'measure');
}
document.querySelectorAll('.tool[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- 量測 ----------
const raycaster = new THREE.Raycaster();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const measure = { a: null, b: null, line: null, preview: null };

function snapRadius(pointerType) {
  return pointerType === 'mouse' ? 12 : 26;
}

function worldPerPixel(dist) {
  const h = stage.clientHeight || 1;
  if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / h;
  return (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / h;
}

function toScreen(v) {
  const p = v.clone().project(camera);
  return { x: (p.x + 1) / 2 * stage.clientWidth, y: (1 - p.y) / 2 * stage.clientHeight, z: p.z };
}

function getPickables() {
  if (pickables) return pickables;
  const meshes = [];
  const lines = [];
  if (model) {
    model.traverseVisible((o) => {
      if (o.isMesh) meshes.push(o);
      else if (o.isLineSegments) lines.push(o);
    });
  }
  pickables = { meshes, lines };
  return pickables;
}

// 在螢幕座標 (x, y) 找量測點：優先吸附端點，其次邊線，最後是面上的點
function pick(x, y, pointerType = 'touch', prefer = 'vertex') {
  if (!model) return null;
  const R = snapRadius(pointerType);
  const ndc = new THREE.Vector2((x / stage.clientWidth) * 2 - 1, -(y / stage.clientHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const { meshes, lines } = getPickables();
  const faceHits = raycaster.intersectObjects(meshes, false);
  const face = faceHits[0] || null;
  const refDist = face ? face.distance : camera.position.distanceTo(controls.target);
  const wpp = worldPerPixel(camera.isOrthographicCamera ? 1 : refDist);
  // three.js 的線段門檻用物件自己的 scale 換算，但我們的縮放在上層節點（英寸→公尺），所以逐個物件換成本地單位
  let lineHits = [];
  const ws = new THREE.Vector3();
  for (const l of lines) {
    l.matrixWorld.decompose(tmpV, tmpQ, ws);
    const s = (Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3 / ((l.scale.x + l.scale.y + l.scale.z) / 3);
    raycaster.params.Line = { threshold: (wpp * R) / s };
    l.raycast(raycaster, lineHits);
  }
  lineHits.sort((p, q) => p.distance - q.distance);
  // 被面擋住的邊不要
  if (face) lineHits = lineHits.filter((h) => h.distance <= face.distance + wpp * R * 1.5);

  const cands = [];
  const tmp = new THREE.Vector3();
  const segs = [];
  for (const h of lineHits.slice(0, 40)) {
    const pos = h.object.geometry.attributes.position;
    const i = h.index;
    const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(h.object.matrixWorld);
    segs.push({ a, b, point: h.pointOnLine ? h.pointOnLine.clone() : h.point.clone() });
    cands.push(a, b);
  }
  if (face && face.face) {
    const pos = face.object.geometry.attributes.position;
    for (const k of ['a', 'b', 'c']) cands.push(tmp.fromBufferAttribute(pos, face.face[k]).applyMatrix4(face.object.matrixWorld).clone());
  }
  if (prefer === 'vertex') {
    // 被面擋住的端點不要；螢幕上重疊的端點（例如平面圖上同一個角的上下兩點）取離眼睛近的
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const depth = (v) => v.clone().sub(camera.position).dot(camDir);
    const maxDepth = face ? depth(face.point) + wpp * R * 1.5 : Infinity;
    const near = [];
    for (const c of cands) {
      const s = toScreen(c);
      if (s.z > 1) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      const z = depth(c);
      if (d < R && z <= maxDepth) near.push({ c, d, z });
    }
    if (near.length) {
      const bd = Math.min(...near.map((n) => n.d));
      const best = near.filter((n) => n.d <= bd + 3).sort((p, q) => p.z - q.z)[0];
      return { point: best.c.clone(), type: 'vertex' };
    }
  }
  let bestSeg = null;
  let bs = R;
  for (const sg of segs) {
    const s = toScreen(sg.point);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bs) { bs = d; bestSeg = sg; }
  }
  if (bestSeg) return { point: bestSeg.point, type: 'edge', seg: bestSeg };
  if (face && prefer === 'vertex') return { point: face.point.clone(), type: 'face' };
  return null;
}

function clearMeasure() {
  measure.a = measure.b = measure.preview = measure.end = measure.segs = null;
  $('#readout').hidden = true;
  dirty = true;
}

// ---------- 鎖軸（像 SketchUp 一樣用紅／綠／藍軸） ----------
// 單選（v0.3.1 使用者要求）：一次只能鎖一個軸，選紅＝只量紅軸方向的距離；再按一次已選的＝取消，回到真實距離。
// 網頁內部是 Y 朝上：SketchUp 紅 X＝(1,0,0)、綠 Y＝(0,0,-1)、藍 Z＝(0,1,0)。
const AXES = {
  x: { name: '紅', label: 'X', color: 0xd62d2d, css: '#d62d2d', world: new THREE.Vector3(1, 0, 0) },
  y: { name: '綠', label: 'Y', color: 0x229a3c, css: '#229a3c', world: new THREE.Vector3(0, 0, -1) },
  z: { name: '藍', label: 'Z', color: 0x2563d6, css: '#2563d6', world: new THREE.Vector3(0, 1, 0) },
};
const AXIS_ORDER = ['x', 'y', 'z'];
let axes = new Set();
try { axes = new Set(JSON.parse(localStorage.getItem('skpv-axes') || '[]').filter((k) => AXES[k]).slice(0, 1)); } catch (e) { /* 略過 */ }
const axisLocked = () => axes.size > 0 && axes.size < 3;
function axesName() { return AXIS_ORDER.filter((k) => axes.has(k)).map((k) => AXES[k].name).join('＋'); }
// 鎖軸後的向量（世界座標）
function lockedVector(a, b) {
  const d = b.clone().sub(a);
  if (!axisLocked()) return d;
  const out = new THREE.Vector3();
  for (const k of AXIS_ORDER) if (axes.has(k)) out.addScaledVector(AXES[k].world, d.dot(AXES[k].world));
  return out;
}
let measureKind = 'measure';
function setAxes(list) {
  axes = new Set(list.filter((k) => AXES[k]).slice(-1)); // 單選：只留一個
  try { localStorage.setItem('skpv-axes', JSON.stringify([...axes])); } catch (e) { /* 略過 */ }
  document.querySelectorAll('#axes [data-axis]').forEach((b) => {
    const on = axes.has(b.dataset.axis);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $('#axes-state').textContent = axisLocked() ? `只量${axesName()}軸` : '真實距離';
  if (measure.a && measure.b && measureKind === 'measure') { // 點完兩點後改勾選：立刻重算、重畫
    setMeasureLine(measure.a.point, measure.b.point);
    showDistance(measure.a, measure.b);
  }
  dirty = true;
}
document.querySelectorAll('#axes [data-axis]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.axis;
  setAxes(axes.has(k) ? [] : [k]); // 再按一次已選的＝取消
}));
// 量測線畫在 HTML 疊圖（SVG，3 px 粗、手機上看得清楚），每次重畫時投影到螢幕
// 沒鎖軸＝紅色直線；鎖軸＝原本兩點的灰色虛線＋該軸方向的分量（軸的顏色）
function setMeasureLine(a, b) {
  const segs = [];
  if (measureKind === 'measure' && axisLocked()) {
    segs.push({ a, b, color: '#555', dash: true, w: 2 });
    const d = b.clone().sub(a);
    let p = a.clone();
    for (const k of AXIS_ORDER) {
      if (!axes.has(k)) continue;
      const q = p.clone().addScaledVector(AXES[k].world, d.dot(AXES[k].world));
      segs.push({ a: p, b: q, color: AXES[k].css, w: 4 });
      p = q;
    }
    measure.end = p;
  } else {
    segs.push({ a, b, color: '#d64545', w: 3 });
    measure.end = b;
  }
  measure.segs = segs;
  dirty = true;
}

// 世界座標（公尺、Y 朝上）→ SketchUp 軸向的公釐
function suMM(v) {
  return { x: v.x * 1000, y: -v.z * 1000, z: v.y * 1000 };
}
const fmt = (mm) => Math.round(mm).toLocaleString('en-US');
const SNAP_NAME = { vertex: '端點', edge: '邊線上', face: '面上' };

function showDistance(a, b, extra = '') {
  const real = a.point.distanceTo(b.point) * 1000;
  const locked = measureKind === 'measure' && axisLocked();
  const d = locked ? lockedVector(a.point, b.point).length() * 1000 : real;
  const pa = suMM(a.point);
  const pb = suMM(b.point);
  const comp = { x: Math.abs(pb.x - pa.x), y: Math.abs(pb.y - pa.y), z: Math.abs(pb.z - pa.z) };
  const r = $('#readout');
  r.hidden = false;
  const tag = locked ? `<span class="axtag">${axesName()}</span>` : '';
  const sub = AXIS_ORDER.map((k) => {
    const cls = locked && !axes.has(k) ? 'off' : '';
    return `<span class="ax ${cls}" style="color:${AXES[k].css}">${AXES[k].label} ${fmt(comp[k])}</span>`;
  }).join('　');
  r.innerHTML = `<div class="big">${tag}${fmt(d)} mm</div><div class="sub">${sub}</div>` +
    `<div class="snap">${extra || `${SNAP_NAME[a.type]} → ${SNAP_NAME[b.type]}${locked ? `　真實 ${fmt(real)}` : ''}`}</div>`;
  window.__skpvLastMeasure = { mm: d, real, axes: locked ? AXIS_ORDER.filter((k) => axes.has(k)).join('') : 'xyz', a: pa, b: pb, comp, types: [a.type, b.type] };
  return d;
}

function onTap(x, y, pointerType) {
  if (mode === 'measure') {
    const p = pick(x, y, pointerType, 'vertex');
    if (!p) { toast('沒有點到模型', 1200); return; }
    if (!measure.a || measure.b) {
      clearMeasure();
      measure.a = p;
      const r = $('#readout');
      r.hidden = false;
      r.innerHTML = `<div class="snap">第一點：${SNAP_NAME[p.type]}　請點第二點</div>`;
    } else {
      measure.b = p;
      measureKind = 'measure';
      setMeasureLine(measure.a.point, measure.b.point);
      showDistance(measure.a, measure.b);
    }
    dirty = true;
  } else if (mode === 'edge') {
    const p = pick(x, y, pointerType, 'edge');
    clearMeasure();
    if (!p) { toast('沒有點到邊線（請把邊線開啟、點靠近一點）', 1600); return; }
    measure.a = { point: p.seg.a, type: 'vertex' };
    measure.b = { point: p.seg.b, type: 'vertex' };
    measureKind = 'edge';
    setMeasureLine(p.seg.a, p.seg.b);
    showDistance(measure.a, measure.b, '邊長');
    dirty = true;
  }
}

// 點一下（沒有拖曳）才算量測；拖曳仍然是旋轉
const downs = new Map();
canvas.addEventListener('pointerdown', (e) => {
  downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), multi: downs.size > 0 });
  if (downs.size > 1) for (const d of downs.values()) d.multi = true;
});
canvas.addEventListener('pointerup', (e) => {
  const d = downs.get(e.pointerId);
  downs.delete(e.pointerId);
  if (!d || d.multi || mode === 'orbit') return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return;
  const r = canvas.getBoundingClientRect();
  onTap(e.clientX - r.left, e.clientY - r.top, e.pointerType);
});
canvas.addEventListener('pointercancel', (e) => downs.delete(e.pointerId));
// 滑鼠移動時預覽吸附點
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || mode !== 'measure' || e.buttons) { if (measure.preview) { measure.preview = null; dirty = true; } return; }
  const r = canvas.getBoundingClientRect();
  measure.preview = pick(e.clientX - r.left, e.clientY - r.top, 'mouse', 'vertex');
  dirty = true;
});
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS 不要整頁縮放

// ---------- HTML 疊圖（量測點、標籤） ----------
function drawOverlay() {
  let html = '';
  const dot = (p, cls) => {
    const s = toScreen(p.point);
    if (s.z > 1) return '';
    return `<div class="dot ${p.type} ${cls}" style="left:${s.x}px;top:${s.y}px"></div>`;
  };
  if (measure.segs) {
    // 線段兩端投影到螢幕；在相機後面的端點先截到近平面上
    const lines = [];
    for (const sg of measure.segs) {
      let a = sg.a.clone().project(camera);
      let b = sg.b.clone().project(camera);
      if (a.z > 1 && b.z > 1) continue;
      if (a.z > 1 || b.z > 1) {
        const camDir = camera.getWorldDirection(new THREE.Vector3());
        const near = camera.position.clone().addScaledVector(camDir, (camera.near || 0.05) * 2);
        const da = sg.a.clone().sub(near).dot(camDir);
        const db = sg.b.clone().sub(near).dot(camDir);
        const t = da / (da - db);
        const c = sg.a.clone().lerp(sg.b, t).project(camera);
        if (a.z > 1) a = c; else b = c;
      }
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const X = (v) => ((v.x + 1) / 2 * W).toFixed(1);
      const Y = (v) => ((1 - v.y) / 2 * H).toFixed(1);
      lines.push(`<line x1="${X(a)}" y1="${Y(a)}" x2="${X(b)}" y2="${Y(b)}" stroke="${sg.color}" stroke-width="${sg.w}" stroke-linecap="round"${sg.dash ? ' stroke-dasharray="6 5"' : ''}/>`);
    }
    html += `<svg class="mlines" width="100%" height="100%">${lines.join('')}</svg>`;
  }
  if (measure.a) html += dot(measure.a, '');
  if (measure.b) {
    html += dot(measure.b, '');
    const end = measure.end || measure.b.point;
    const mid = measure.a.point.clone().add(end).multiplyScalar(0.5);
    const s = toScreen(mid);
    if (s.z <= 1) html += `<div class="label" style="left:${s.x}px;top:${s.y}px">${fmt(measure.a.point.distanceTo(end) * 1000)}</div>`;
  }
  if (measure.preview) html += dot(measure.preview, 'preview');
  overlay.innerHTML = html;
}

// ---------- 主迴圈：有變動才重畫（省電） ----------
// 縮放／旋轉時：
// 1. 拉近到旋轉中心附近（< 25 cm 或模型半徑 1%）時，把中心往前移到下一個面（或前方一段距離），
//    不然每一步都只走「剩下距離的 5%」，越近越慢、看起來像拉不動（跟 SketchUp 一樣可以一直往前推）。
// 2. 移動中把解析度降到 1.25 倍，停下 250 ms 後恢復（手機 GPU 每幀要填的像素少一半以上）。
let lastDist = Infinity;
let lowRes = false;
let lowResTimer = 0;
const FULL_DPR = Math.min(window.devicePixelRatio || 1, 2);
const MOVE_DPR = Math.min(FULL_DPR, 1.25);
controls.addEventListener('change', () => {
  dirty = true;
  if (model && !anim && camera.isPerspectiveCamera) {
    const d = camera.position.distanceTo(controls.target);
    const near = Math.max(0.25, bounds.radius * 0.01);
    if (d < near && d < lastDist - 1e-6) {
      const dir = controls.target.clone().sub(camera.position).normalize();
      const from = controls.target.clone().addScaledVector(dir, 0.05);
      const rc = new THREE.Raycaster(from, dir, 0, bounds.radius * 2);
      const hit = rc.intersectObjects(getPickables().meshes, false)[0];
      const ahead = hit ? d + 0.05 + hit.distance : Math.max(bounds.radius * 0.1, 1);
      controls.target.copy(camera.position).addScaledVector(dir, Math.max(ahead, near * 4));
      lastPivot = 'push';
    }
    lastDist = camera.position.distanceTo(controls.target);
  }
  if (MOVE_DPR < FULL_DPR && params.get('lowres') !== '0') {
    if (!lowRes) { lowRes = true; renderer.setPixelRatio(MOVE_DPR); resize(); }
    clearTimeout(lowResTimer);
    lowResTimer = setTimeout(() => { lowRes = false; renderer.setPixelRatio(FULL_DPR); resize(); dirty = true; }, 250);
  }
});
function loop(now) {
  requestAnimationFrame(loop);
  if (anim) {
    const t = Math.min(1, (now - anim.t0) / anim.dur);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    camera.position.lerpVectors(anim.from.eye, anim.to.eye, k);
    controls.target.lerpVectors(anim.from.target, anim.to.target, k);
    if (t >= 1) anim = null;
    dirty = true;
  }
  if (controls.update()) dirty = true;
  if (!dirty) return;
  dirty = false;
  renderer.render(scene, camera);
  drawOverlay();
}
requestAnimationFrame(loop);

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
  $('#model-name').textContent = data.title || (fileInfo.name || '模型').replace(/\.glb$/i, '');
  const st = data.stats || {};
  $('#model-meta').textContent = `${mb(fileInfo.bytes)} · ${(data.scenes || []).length} 個場景 · 載入 ${(fileInfo.timing.total / 1000).toFixed(1)} 秒`;
  const rows = [
    ['檔案', fileInfo.name],
    ['大小', mb(fileInfo.bytes)],
    ['匯出時間', data.exportedAt || '—'],
    ['面／三角形', `${(st.faces || 0).toLocaleString()} ／ ${(st.triangles || 0).toLocaleString()}`],
    ['群組／元件', (st.instances || 0).toLocaleString()],
    ['材質／貼圖', `${st.materials || 0} ／ ${st.textures || 0}`],
    ['場景', (data.scenes || []).map((s) => s.name).join('、') || '（沒有）'],
    ['載入時間', `${(fileInfo.timing.total / 1000).toFixed(2)} 秒（讀檔 ${(fileInfo.timing.read / 1000).toFixed(2)}、建立 ${(fileInfo.timing.parse / 1000).toFixed(2)}、第一次繪製 ${(fileInfo.timing.firstFrame / 1000).toFixed(2)}）`],
    ['匯出器／瀏覽器', `${data.exporter || '?'} ／ ${APP_VERSION}`],
    ['裝置／貼圖', `${{ phone: '手機', tablet: '平板', desktop: '電腦' }[mem.DEVICE]}：貼圖最大 ${loadInfo.texCap} px（${loadInfo.resized || 0} 張縮小${loadInfo.skipped ? `、${loadInfo.skipped} 張略過` : ''}），約 ${loadInfo.texMB} MB（原尺寸約 ${loadInfo.texFullMB} MB）`],
  ];
  $('#info-list').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
$('#info-btn').addEventListener('click', () => { $('#info').hidden = false; });
$('#info-close').addEventListener('click', () => { $('#info').hidden = true; });
$('#info').addEventListener('click', (e) => { if (e.target.id === 'info') $('#info').hidden = true; });

// ---------- 離線（PWA） ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').then(() => {
    $('#offline-state').textContent = '已可離線使用：加到主畫面後，沒有網路也能開。';
  }).catch(() => {});
}

// ---------- 測試／示範用的網址參數 ----------
// ?src=檔案網址  &scene=場景序號（0＝匯出時的畫面）  &mode=measure|edge
// &demo=x1,y1,z1;x2,y2,z2   （SketchUp 公釐座標）用一般「點螢幕」的流程量兩點，會偏移幾個像素測試吸附
// &edges=0
const params = new URLSearchParams(location.search);
window.skpv = {
  pick, onTap, toScreen, goScene, setMode, setEdges,
  screenOfSU(mm) { return toScreen(new THREE.Vector3(mm[0] / 1000, mm[2] / 1000, -mm[1] / 1000)); },
  get last() { return window.__skpvLastMeasure; },
  get timing() { return window.__skpvTiming; },
  render() { renderer.render(scene, camera); drawOverlay(); },
  // 測試用：目前相機狀態（公尺）
  camInfo() {
    const r = (v) => v.toArray().map((x) => +x.toFixed(2));
    return { pos: r(camera.position), target: r(controls.target), dist: +camera.position.distanceTo(controls.target).toFixed(2),
      R: +bounds.radius.toFixed(2), center: r(bounds.center), ortho: !!camera.isOrthographicCamera, zoom: +camera.zoom.toFixed(3),
      eyeToCenter: +camera.position.distanceTo(bounds.center).toFixed(2), scene: activeScene, pivot: lastPivot,
      box: bounds.box ? [r(bounds.box.min), r(bounds.box.max)] : null, eye: camera.position.toArray(), maxD: controls.maxDistance };
  },
  get scenes() { return sceneEntries(); },
  setAxes,
  // 測試用：這個標記上的面現在有沒有顯示（合併後也要照場景切換）
  tagShown(tag) { return shownBy((u) => u.tag === tag); },
  pidShown(pid) { return shownBy((u) => u.pid === pid); },
  get mergeInfo() { return window.__skpvMerge || null; },
  // 測試用：效能數字（draw call、三角形、GPU 記憶體估計）
  perfInfo() {
    const gl = renderer.getContext();
    renderer.info.reset();
    renderer.render(scene, camera);
    gl.finish();
    const calls = renderer.info.render.calls;
    const tris = renderer.info.render.triangles;
    const lines = renderer.info.render.lines;
    let meshes = 0, lineObjs = 0, geoBytes = 0, texBytes = 0;
    const geos = new Set(), texs = new Set();
    scene.traverse((o) => {
      if (o.isMesh) meshes++;
      if (o.isLine) lineObjs++;
      if (o.geometry && !geos.has(o.geometry)) {
        geos.add(o.geometry);
        for (const a of Object.values(o.geometry.attributes)) geoBytes += a.array ? a.array.byteLength : a.count * a.itemSize * 4; // UV 上傳後可能已丟掉（手機）
        if (o.geometry.index) geoBytes += o.geometry.index.array.byteLength;
      }
      if (o.material && o.material.map && !texs.has(o.material.map)) {
        texs.add(o.material.map);
        const im = o.material.map.image;
        if (im) texBytes += im.width * im.height * 4 * 4 / 3;
      }
    });
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { renderer.render(scene, camera); }
    gl.finish();
    const renderMs = (performance.now() - t0) / N;
    return { calls, tris, lines, meshes, lineObjs, geoMB: +(geoBytes / 1048576).toFixed(1), texMB: +(texBytes / 1048576).toFixed(1),
      textures: texs.size, renderMs: +renderMs.toFixed(2), dpr: renderer.getPixelRatio(), canvas: [renderer.domElement.width, renderer.domElement.height] };
  },
  // 測試用：直接用 SketchUp 公釐座標放兩個量測點（不經過點螢幕）
  measureSU(a, b) {
    const w = (mm) => new THREE.Vector3(mm[0] / 1000, mm[2] / 1000, -mm[1] / 1000);
    setMode('measure');
    measure.a = { point: w(a), type: 'vertex' };
    measure.b = { point: w(b), type: 'vertex' };
    measureKind = 'measure';
    setMeasureLine(measure.a.point, measure.b.point);
    showDistance(measure.a, measure.b);
    dirty = true;
    return window.__skpvLastMeasure;
  },
  controls,
  get renderer() { return renderer; },
};
cloud.init({ loadBuffer, showLoading, hideLoading, fail, toast, loadBegin, showProblem, device: mem.DEVICE, warnMB: mem.WARN_FILE_MB });
const lastFailed = checkLastLoad();
setAxes([...axes]);
if (params.get('axes') != null) setAxes(params.get('axes').split(''));
$('#cloud-btn').addEventListener('click', () => cloud.showList());
$('#welcome-cloud').addEventListener('click', () => cloud.showList());
const first = params.get('m') ? cloud.openCloud(params.get('m')) : params.get('src') ? openUrl(params.get('src')) : null;
if (first) {
  first.then(() => {
    if (!model) return;
    if (params.get('scene') != null) goScene(Number(params.get('scene')), false);
    if (params.get('edges') === '0') setEdges(false);
    if (params.get('mode')) setMode(params.get('mode'));
    const demo = params.get('demo');
    if (demo) {
      controls.update();
      camera.updateMatrixWorld();
      const pts = demo.split(';').map((s) => s.split(',').map(Number));
      if (!params.get('mode')) setMode(pts.length === 1 ? 'edge' : 'measure');
      pts.forEach((p, i) => {
        const s = window.skpv.screenOfSU(p);
        const off = i === 0 ? 7 : -6; // 故意偏幾個像素，靠吸附抓到端點
        onTap(s.x + off, s.y + off, 'touch');
      });
      document.body.dataset.demo = window.__skpvLastMeasure ? `${window.__skpvLastMeasure.mm.toFixed(3)}` : 'none';
    }
    if (params.get('info') === '1') $('#info').hidden = false;
    document.body.dataset.ready = '1';
    dirty = true;
  });
}
