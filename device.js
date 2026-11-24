// 裝置判斷（v0.10.0 從 memory.js 分出來：memory.js 會載入 three.js，看 PDF 時不需要）。
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
// 手機上：檔案大於這個（MB）而且沒有手機版時，開之前先提醒
export const WARN_FILE_MB = Number(params.get('warnmb')) || { phone: 200, tablet: 600, desktop: Infinity }[DEVICE]; // ?warnmb= 測試用


// v0.10.0：速度紀錄。每一步：從打開網頁算起第幾毫秒做完（at）、這一步花幾毫秒（ms）。放進「複製速度紀錄」。
export const STEPS = (window.__skpvSteps = window.__skpvSteps || []);
export function step(name, t0) {
  const now = performance.now();
  STEPS.push({ name, at: Math.round(now), ms: t0 == null ? null : Math.round(now - t0) });
}
