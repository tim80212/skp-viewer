// 存在這台裝置上的檔案（v0.9.0）：只給「擁有者」（自己登入、自己上傳的檔案）用，現場沒網路也能開。
// 分享連結（收件人）一律不經過這裡：只放在那一頁的記憶體，關掉就沒了（使用者的規定，v0.6.0）。
// IndexedDB「skpv-offline」：files（id → { id, name, size, modifiedTime, md5, savedAt, blob }）。
// 雲端的檔案更新（重新最佳化）時用 modifiedTime／md5Checksum 比對，不一樣就作廢。
const DB = 'skpv-offline';
const STORE = 'files';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}

export async function get(id) {
  try { return (await tx('readonly', (s) => s.get(id))) || null; } catch (e) { return null; }
}
export async function put(rec) {
  await tx('readwrite', (s) => s.put({ ...rec, savedAt: new Date().toISOString() }));
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 略過 */ }
}
export async function del(id) {
  try { await tx('readwrite', (s) => s.delete(id)); } catch (e) { /* 略過 */ }
}
// 清單（不含檔案內容）
export async function list() {
  try {
    const all = (await tx('readonly', (s) => s.getAll())) || [];
    return all.map(({ blob, ...r }) => ({ ...r, bytes: blob ? blob.size : 0 }));
  } catch (e) { return []; }
}
export async function clearAll() {
  try { await tx('readwrite', (s) => s.clear()); } catch (e) { /* 略過 */ }
}
// 雲端的版本跟存的一樣嗎（md5 優先，沒有就比 modifiedTime）
export function sameVersion(rec, meta) {
  if (!rec || !meta) return false;
  if (rec.md5 && meta.md5Checksum) return rec.md5 === meta.md5Checksum;
  return !!rec.modifiedTime && rec.modifiedTime === meta.modifiedTime;
}
