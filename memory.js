// 記憶體保護（v0.5）：依裝置決定貼圖預算，載入時直接把貼圖解碼成較小的尺寸。
// 背景：手機瀏覽器一個分頁大約只能用 1～1.5 GB，一張 7200×17400 的 JPEG 解開就要 500 MB，
// 179 張貼圖全部原尺寸要 2.8 GB 顯示記憶體（使用者回報開不了的模型，見 回報/v0.5.md）。
import * as THREE from './lib/three.module.min.js';

const UA = navigator.userAgent;
const params = new URLSearchParams(location.search);

// 裝置：phone／tablet／desktop（網址 ?device= 可以指定，測試用）
export const DEVICE = (() => {
  const forced = params.get('device');
  if (['phone', 'tablet', 'desktop'].includes(forced)) return forced;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const minSide = Math.min(screen.width, screen.height);
  if (/iPhone|iPod/.test(UA) || /Android.+Mobile/.test(UA) || (coarse && minSide < 600)) return 'phone';
  if (/iPad|Android/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || coarse) return 'tablet';
  return 'desktop';
})();

// 貼圖顯示記憶體預算（MB，含 mipmap）。手機要留給網格、程式本身和瀏覽器。
export const TEX_BUDGET_MB = { phone: 160, tablet: 700, desktop: 3000 }[DEVICE];
// 解碼單張圖片的上限（百萬像素）：瀏覽器不支援「解碼時縮小」時，比這個大的圖手機直接略過（用灰色代替），避免閃退
const MAX_FULL_DECODE_MP = { phone: 24, tablet: 64, desktop: 400 }[DEVICE];
// 手機上：檔案大於這個（MB）而且沒有手機版時，開之前先提醒
export const WARN_FILE_MB = Number(params.get('warnmb')) || { phone: 200, tablet: 600, desktop: Infinity }[DEVICE]; // ?warnmb= 測試用

// ---------- 讀 GLB 裡每張圖片的尺寸（只讀檔頭，不解碼） ----------
function dims(bytes) {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return [dv.getUint32(16), dv.getUint32(20)];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      while (b[i] === 0xff && b[i + 1] === 0xff) i++;
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m === 0xc0 || m === 0xc1 || m === 0xc2) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += 2 + len;
    }
  }
  return [0, 0];
}

export function scanGlb(buf) {
  const dv = new DataView(buf);
  const jlen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
  const binStart = 28 + jlen;
  const images = (json.images || []).map((im) => {
    const v = json.bufferViews[im.bufferView];
    const off = binStart + (v.byteOffset || 0);
    return dims(new Uint8Array(buf, off, Math.min(v.byteLength, 65536)));
  });
  return { json, images };
}

const gpuMB = (images, cap) => images.reduce((t, [w, h]) => {
  const s = Math.min(1, cap / Math.max(w, h, 1));
  return t + (w * s) * (h * s) * 4 * 4 / 3;
}, 0) / 1048576;

// 依預算選貼圖的最大邊長
export function chooseCap(images, maxTex) {
  const levels = [16384, 8192, 4096, 2048, 1024, 512, 256, 128].filter((c) => c <= maxTex);
  for (const c of levels) if (gpuMB(images, c) <= TEX_BUDGET_MB) return { cap: c, mb: gpuMB(images, c), fullMb: gpuMB(images, 1e9) };
  return { cap: 128, mb: gpuMB(images, 128), fullMb: gpuMB(images, 1e9) };
}

// ---------- 解碼時縮小 ----------
let resizeOK = null;
export async function detectResize() {
  if (resizeOK !== null) return resizeOK;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const bmp = await createImageBitmap(blob, { resizeWidth: 2, resizeHeight: 2, resizeQuality: 'medium' });
    resizeOK = bmp.width === 2;
    bmp.close && bmp.close();
  } catch (e) {
    resizeOK = false;
  }
  return resizeOK;
}

const placeholder = (() => {
  let tex = null;
  return () => {
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const g = c.getContext('2d');
      g.fillStyle = '#c8c8c8';
      g.fillRect(0, 0, 4, 4);
      tex = c;
    }
    return tex;
  };
})();

// GLTFLoader 用的圖片載入器：解碼成不超過 cap 的尺寸（ImageBitmap）
export function makeTextureLoader(cap, stats) {
  // 一次只解一張：GLTFLoader 會同時載入全部貼圖，179 張同時解碼時記憶體尖峰會暴衝（實測 3.1 GB）
  let queue = Promise.resolve();
  return {
    isImageBitmapLoader: true,
    setCrossOrigin() { return this; },
    setRequestHeader() { return this; },
    setPath() { return this; },
    load(url, onLoad, onProgress, onError) {
      const job = () => (async () => {
        const blob = await (await fetch(url)).blob();
        const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        const [w, h] = dims(head);
        const s = w && h ? Math.min(1, cap / Math.max(w, h)) : 1;
        const tw = Math.max(1, Math.round(w * s));
        const th = Math.max(1, Math.round(h * s));
        const opt = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
        let bmp;
        if (s < 1 && await detectResize()) {
          bmp = await createImageBitmap(blob, { ...opt, resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
        } else if (s < 1 && (w * h) / 1e6 > MAX_FULL_DECODE_MP) {
          stats.skipped++;
          stats.skippedList.push(`${w}×${h}`);
          bmp = await createImageBitmap(placeholder());
        } else {
          bmp = await createImageBitmap(blob, opt);
          if (bmp.width > tw) { // 不支援解碼時縮小：解開後再畫小一點
            const c = document.createElement('canvas');
            c.width = tw;
            c.height = th;
            c.getContext('2d').drawImage(bmp, 0, 0, tw, th);
            bmp.close && bmp.close();
            bmp = await createImageBitmap(c);
          }
        }
        if (s < 1) stats.resized++;
        stats.count++;
        stats.gpuMB += bmp.width * bmp.height * 4 * 4 / 3 / 1048576;
        stats.maxDim = Math.max(stats.maxDim, w, h);
        return bmp;
      })();
      const p = queue.then(job);
      queue = p.catch(() => {});
      p.then(onLoad, onError);
    },
  };
}

// 解析完後把幾何的陣列複製成獨立的記憶體，讓 GLTFLoader 暫存的整段 bufferView（含貼圖原始檔）可以被回收
export function detachGeometry(root) {
  const seen = new Set();
  root.traverse((o) => {
    const g = o.geometry;
    if (!g || seen.has(g)) return;
    seen.add(g);
    for (const k of Object.keys(g.attributes)) {
      const a = g.attributes[k];
      if (a.isInterleavedBufferAttribute) continue;
      a.array = a.array.slice();
    }
    if (g.index) g.index.array = g.index.array.slice();
  });
}

export function memoryNow() {
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
}

export { THREE };
