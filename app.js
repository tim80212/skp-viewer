// SKP 瀏覽器（瀏覽端）— 開啟 SketchUp 插件匯出的 .glb 瀏覽檔。
// 純前端：檔案用檔案選擇器在本機讀取，或從自己的 Google Drive 下載（cloud.js）。
import * as THREE from './lib/three.module.min.js';
import { OrbitControls } from './lib/OrbitControls.js';
import { GLTFLoader } from './lib/GLTFLoader.js';
import * as cloud from './cloud.js';

const APP_VERSION = '0.2.0';
const FORMAT_VERSION = 1;
const $ = (s) => document.querySelector(s);
const app = $('#app');
const canvas = $('#view');
const stage = $('#stage');
const overlay = $('#overlay');

// ---------- three.js 基本設定 ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
  console.error(err);
  toast(String(err && err.message ? err.message : err), 5000);
}

async function loadBuffer(buf, name, t0) {
  const head = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...head) !== 'glTF') {
    throw new Error('這不是瀏覽檔（.glb）。請在 SketchUp 用「SKP 瀏覽器 → 匯出瀏覽檔」產生。');
  }
  const tRead = performance.now();
  showLoading('建立模型…');
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
  const tParse = performance.now();
  const extras = (gltf.parser.json.extras || {}).skpViewer || null;
  if (extras && extras.format > FORMAT_VERSION) {
    toast('這個檔案是較新版的匯出器產生的，部分功能可能無法顯示，請更新瀏覽器網頁。', 5000);
  }
  setModel(gltf.scene, extras);
  fileInfo = { name, bytes: buf.byteLength };
  renderer.render(scene, camera); // 第一次繪製（含著色器編譯、貼圖上傳），同步完成
  renderer.getContext().finish();
  const tFirst = performance.now();
  fileInfo.timing = { read: tRead - t0, parse: tParse - tRead, firstFrame: tFirst - tParse, total: tFirst - t0 };
  window.__skpvTiming = fileInfo.timing;
  hideLoading();
  updateMeta();
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
  app.classList.remove('empty');
  clearMeasure();
  setEdges(true);
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
  pickables = null;
  dirty = true;
}

function setCamera(c, animate) {
  const eye = new THREE.Vector3().fromArray(c.eye);
  const target = new THREE.Vector3().fromArray(c.target);
  const dir = target.clone().sub(eye);
  const dist = dir.length() || 1;
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
  for (const l of lineObjects) l.visible = on;
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
}
document.querySelectorAll('.tool[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- 量測 ----------
const raycaster = new THREE.Raycaster();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const measure = { a: null, b: null, line: null, preview: null };
const measureLineMat = new THREE.LineBasicMaterial({ color: 0xd64545, depthTest: false, transparent: true });

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
  measure.a = measure.b = measure.preview = null;
  if (measure.line) { scene.remove(measure.line); measure.line.geometry.dispose(); measure.line = null; }
  $('#readout').hidden = true;
  dirty = true;
}

function setMeasureLine(a, b) {
  if (measure.line) { scene.remove(measure.line); measure.line.geometry.dispose(); }
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  measure.line = new THREE.Line(g, measureLineMat);
  measure.line.renderOrder = 10;
  scene.add(measure.line);
}

// 世界座標（公尺、Y 朝上）→ SketchUp 軸向的公釐
function suMM(v) {
  return { x: v.x * 1000, y: -v.z * 1000, z: v.y * 1000 };
}
const fmt = (mm) => Math.round(mm).toLocaleString('en-US');
const SNAP_NAME = { vertex: '端點', edge: '邊線上', face: '面上' };

function showDistance(a, b, extra = '') {
  const d = a.point.distanceTo(b.point) * 1000;
  const pa = suMM(a.point);
  const pb = suMM(b.point);
  const r = $('#readout');
  r.hidden = false;
  r.innerHTML = `<div class="big">${fmt(d)} mm</div>` +
    `<div class="sub">X ${fmt(Math.abs(pb.x - pa.x))}　Y ${fmt(Math.abs(pb.y - pa.y))}　Z ${fmt(Math.abs(pb.z - pa.z))}</div>` +
    `<div class="snap">${extra || `${SNAP_NAME[a.type]} → ${SNAP_NAME[b.type]}`}</div>`;
  window.__skpvLastMeasure = { mm: d, a: pa, b: pb, types: [a.type, b.type] };
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
  if (measure.a) html += dot(measure.a, '');
  if (measure.b) {
    html += dot(measure.b, '');
    const mid = measure.a.point.clone().add(measure.b.point).multiplyScalar(0.5);
    const s = toScreen(mid);
    if (s.z <= 1) html += `<div class="label" style="left:${s.x}px;top:${s.y}px">${fmt(measure.a.point.distanceTo(measure.b.point) * 1000)}</div>`;
  }
  if (measure.preview) html += dot(measure.preview, 'preview');
  overlay.innerHTML = html;
}

// ---------- 主迴圈：有變動才重畫（省電） ----------
controls.addEventListener('change', () => { dirty = true; });
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
};
cloud.init({ loadBuffer, showLoading, hideLoading, fail, toast });
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
