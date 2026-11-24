// PDF 的資料來源（v0.9.0）。
// Google Drive 每個下載請求都要先等好幾秒（實測大多 5 秒，跟大小幾乎無關；傳輸本身很快）→ 請求次數要最少：
// - 開檔就在背景把整個檔案分 4 段同時下載到記憶體（串流：邊下載邊能用）。下載完翻頁、放大都不用再上網。
// - 要讀某一段：已經下載了 → 直接拿；某一段串流快要下載到（預估 4 秒內）→ 等它；還很遠 → 另外發一個請求（同時存進記憶體）。
// - 檔案太大、記憶體配置不到 → 不整份下載：照舊一段一段抓，留最近用過的幾段（圖磚那邊一頁抓一段）。
// - 每個請求記下：等第一個 byte 的時間、傳輸時間、大小（速度紀錄，給除錯資訊和回報用）。
// 這裡只放在記憶體。要不要存在裝置上（只有擁有者）由 offline.js 決定。
import { DEVICE } from './device.js';

const MB = 1048576;
// 整份下載的上限（記憶體）：手機 300 MB（使用者的施工圖 41 MB）
const FULL_MAX = { phone: 300, tablet: 600, desktop: 2000 }[DEVICE] * MB || 600 * MB;
const SEG_MAX = (DEVICE === 'phone' ? 48 : 128) * MB; // 不整份下載時，留最近用過的幾段
const PARTS = 4;
const FRONT = 0.4; // 第一段（索引、第 1 頁、縮圖在最前面）佔 40%：一開始只有它在傳（頻寬全給它），標頭到了才開其他 3 段
const FRONT_OFF = 2 * MB; // 不整份下載時：先發的 bytes=0- 請求拿前面 2 MB（索引、第 1 頁、縮圖）就停
const WAIT_MS = 4000; // 串流預估這麼久以內會下載到 → 等它，不另外發請求
const WAIT_BYTES0 = MB; // 串流還沒開始傳（還在等第一個 byte）：離起點這麼近才等
const WAIT_MAX = 15000; // 等串流最多等這麼久，等不到就自己抓
const LOG_MAX = 300;

const now = () => performance.now();

export class Source {
  // o：{ size, open(begin, end) → Promise<Response>, pre? } 或 { data: ArrayBuffer, cached }
  //   pre＝{ res: Promise<Response>（bytes=0- 的請求，跟讀檔案資料同時發出去的）, t0, abort() }：第一段直接用它，省一次等待
  constructor(o) {
    this.t0 = now();
    this.log = [];
    this.waiters = [];
    this.streams = [];
    this.segs = []; // [{ a, b, buf }]（不整份下載時）
    this.segBytes = 0;
    this.have = []; // 已經下載的區間 [a, b)（已排序、合併）
    this.listeners = new Set();
    this.ctrl = new AbortController();
    this.closed = false;
    this.ownReqs = 0;
    if (o.data) {
      this.size = o.data.byteLength;
      this.buf = new Uint8Array(o.data);
      this.have = [[0, this.size]];
      this.state = 'done';
      this.cached = !!o.cached;
      this.doneAt = null; // 沒有下載
    } else {
      this.size = o.size;
      this.open = o.open;
      this.pre = o.pre || null;
      this.buf = null;
      this.state = 'idle'; // idle → loading → done／off（不整份下載）／failed
    }
  }

  get received() { return this.have.reduce((s, [a, b]) => s + b - a, 0); }
  get progress() { return this.size ? this.received / this.size : 0; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() {
    if (this.emitT) return;
    this.emitT = setTimeout(() => { this.emitT = 0; for (const fn of this.listeners) { try { fn(this); } catch (e) { /* 略過 */ } } }, 150);
  }
  emitNow() { clearTimeout(this.emitT); this.emitT = 0; for (const fn of this.listeners) { try { fn(this); } catch (e) { /* 略過 */ } } }

  covered(a, b) {
    for (const [x, y] of this.have) { if (x <= a && b <= y) return true; if (x > a) break; }
    return false;
  }
  addHave(a, b) {
    if (b <= a) return;
    const h = this.have;
    let i = 0;
    while (i < h.length && h[i][1] < a) i++;
    let s = a, e = b, j = i;
    while (j < h.length && h[j][0] <= e) { s = Math.min(s, h[j][0]); e = Math.max(e, h[j][1]); j++; }
    h.splice(i, j - i, [s, e]);
  }

  // 背景整份下載（分 PARTS 段同時抓）。回傳 false＝不整份下載（太大或記憶體配置不到）
  startFull() {
    if (this.state !== 'idle' || this.closed) return this.state === 'loading' || this.state === 'done';
    const off = () => {
      this.state = 'off';
      if (this.pre) this.frontP = this.readFront(this.pre);
      this.pre = null;
      this.emitNow();
      return false;
    };
    if (this.size > FULL_MAX || new URLSearchParams(location.search).get('full') === '0') return off();
    try { this.buf = new Uint8Array(this.size); } catch (e) { this.buf = null; return off(); }
    this.state = 'loading';
    this.fullT0 = now();
    // 第一段 40%，其他 60% 分 3 段。一開始只有第一段（第 1 頁、縮圖馬上到），它的標頭到了（或 8 秒）才開其他段：
    // 那幾秒第一段獨佔頻寬，頻寬一直沒有閒著，所以整份下載的時間差不多
    const cut = this.size < 4 * MB ? this.size : Math.ceil(this.size * FRONT);
    const s0 = { a: 0, b: cut, pos: 0, rate: 0, started: false, ended: false, pre: this.pre };
    this.pre = null;
    this.streams.push(s0);
    const rest = [];
    const part = Math.ceil((this.size - cut) / (PARTS - 1));
    for (let a = cut; a < this.size; a += part) rest.push({ a, b: Math.min(this.size, a + part), pos: a, rate: 0, started: false, ended: false });
    let go = false;
    this.startRest = () => {
      if (go || this.closed) return;
      go = true;
      clearTimeout(this.restT);
      for (const s of rest) { this.streams.push(s); this.runStream(s); }
    };
    this.restT = setTimeout(() => this.startRest(), 8000);
    this.runStream(s0);
    if (!rest.length) this.startRest();
    this.emitNow();
    return true;
  }
  async readFront(pre) {
    const lim = Math.min(this.size, FRONT_OFF);
    try {
      const res = await pre.res;
      const t1 = now();
      if (res.status !== 206 || !res.body) { try { res.body && res.body.cancel(); } catch (e) { /* 略過 */ } return; }
      const rec = this.pushLog({ kind: 'front', a: 0, n: 0, wait: t1 - pre.t0, xfer: 0 });
      const out = new Uint8Array(lim);
      const reader = res.body.getReader();
      let got = 0;
      while (got < lim) {
        const { done, value } = await reader.read();
        if (done) break;
        const n = Math.min(value.length, lim - got);
        out.set(n === value.length ? value : value.subarray(0, n), got);
        got += n;
      }
      try { reader.cancel(); } catch (e) { /* 略過 */ }
      rec.n = got;
      rec.xfer = Math.round(now() - t1);
      if (got && !this.closed) { this.segs.push({ a: 0, b: got, buf: out.buffer.slice(0, got) }); this.segBytes += got; }
    } catch (e) { /* 拿不到就一段一段抓 */ }
  }
  dropPre() {
    if (this.pre) { try { this.pre.abort(); } catch (e) { /* 略過 */ } this.pre = null; }
  }

  async runStream(s) {
    for (let tries = 0; tries < 4 && !this.closed && s.pos < s.b; tries++) {
      if (this.covered(s.pos, s.b)) { s.pos = s.b; break; }
      let t0 = now();
      let res;
      try {
        if (s.pre && tries === 0) { t0 = s.pre.t0; res = await s.pre.res; } // 跟讀檔案資料同時發出去的 bytes=0- 請求
        else res = await this.open(s.pos, s.b, this.ctrl.signal);
      } catch (e) {
        if (this.closed) return;
        if (s === this.streams[0] && this.startRest) this.startRest();
        await new Promise((r) => setTimeout(r, 1000 * (tries + 1)));
        continue;
      }
      const t1 = now();
      if (s === this.streams[0] && this.startRest) this.startRest(); // 第一段的標頭到了：開其他段
      if (res.status === 200 && s.a !== 0) { // 伺服器不支援 Range：第一段會拿到整個檔案
        try { res.body && res.body.cancel(); } catch (e) { /* 略過 */ }
        s.pos = s.b;
        this.pushLog({ kind: 'full', a: s.a, n: 0, wait: t1 - t0, xfer: 0, note: '200' });
        break;
      }
      if (res.status === 200) { s.pos = 0; s.b = this.size; for (const t of this.streams) if (t !== s) t.ended = true; }
      else if (res.status !== 206) { this.pushLog({ kind: 'full', a: s.pos, n: 0, wait: t1 - t0, xfer: 0, note: String(res.status) }); s.err = res.status; break; }
      s.started = true;
      const start = s.pos;
      const rec = this.pushLog({ kind: 'full', a: start, n: 0, wait: t1 - t0, xfer: 0 }); // 標頭到了就記（傳輸中持續更新）
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const n = Math.min(value.length, s.b - s.pos);
          if (n > 0) {
            this.buf.set(n === value.length ? value : value.subarray(0, n), s.pos);
            this.addHave(s.pos, s.pos + n);
            s.pos += n;
            s.rate = (s.pos - start) / Math.max(1, now() - t1); // bytes／ms
            rec.n = s.pos - start;
            rec.xfer = Math.round(now() - t1);
            this.wake();
            this.emit();
          }
          if (s.pos >= s.b) { try { reader.cancel(); } catch (e) { /* 略過 */ } break; }
        }
      } catch (e) {
        if (this.closed) return;
      }
      rec.n = s.pos - start;
      rec.xfer = Math.round(now() - t1);
    }
    s.ended = true;
    if (this.closed) return;
    this.wake();
    if (this.streams.every((x) => x.ended)) {
      if (this.covered(0, this.size)) {
        this.state = 'done';
        this.doneAt = now() - this.fullT0;
      } else {
        this.state = 'failed';
      }
      this.emitNow();
    }
  }

  // [a, b) 會不會很快被串流下載到（每一段沒下載的地方都有串流快到了）
  willCover(a, b) {
    let x = a;
    while (x < b) {
      const h = this.have.find(([p, q]) => p <= x && x < q);
      if (h) { x = h[1]; continue; }
      const s = this.streams.find((t) => !t.ended && t.pos <= x && x < t.b);
      if (!s) return false;
      const ahead = x - s.pos;
      if (s.rate > 0 ? ahead / s.rate > WAIT_MS : ahead > WAIT_BYTES0) return false;
      x = s.b;
    }
    return true;
  }
  wake() {
    if (!this.waiters.length) return;
    this.waiters = this.waiters.filter((w) => {
      if (this.covered(w.a, w.b)) { w.resolve(true); return false; }
      if (!this.streams.some((t) => !t.ended && t.pos <= w.b && w.a < t.b)) { w.resolve(false); return false; } // 串流停了
      return true;
    });
  }
  waitFor(a, b) {
    return new Promise((resolve) => {
      const w = { a, b, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); resolve(false); } }, WAIT_MAX);
    });
  }

  // 讀 [off, off+len)：回傳 ArrayBuffer（複本）
  async read(off, len) {
    const a = Math.max(0, off), b = Math.min(this.size, off + len);
    if (b <= a) return new ArrayBuffer(0);
    if (this.buf && this.covered(a, b)) return this.buf.slice(a, b).buffer;
    if (!this.buf && this.frontP && a < FRONT_OFF) await this.frontP;
    if (!this.buf) {
      const g = this.segs.find((x) => x.a <= a && b <= x.b);
      if (g) { this.segs.splice(this.segs.indexOf(g), 1); this.segs.push(g); return g.buf.slice(a - g.a, b - g.a); }
    }
    if (this.buf && this.state === 'loading' && this.willCover(a, b)) {
      const t0 = now();
      if (await this.waitFor(a, b)) {
        this.pushLog({ kind: 'wait', a, n: b - a, wait: now() - t0, xfer: 0 });
        return this.buf.slice(a, b).buffer;
      }
      if (this.closed) throw new Error('closed');
    }
    return this.fetchOwn(a, b);
  }

  async fetchOwn(a, b) {
    if (this.closed) throw new Error('closed');
    this.ownReqs++;
    const t0 = now();
    const res = await this.open(a, b, this.ctrl.signal);
    const t1 = now();
    if (res.status !== 206 && !res.ok) {
      this.pushLog({ kind: 'range', a, n: 0, wait: t1 - t0, xfer: 0, note: String(res.status) });
      throw Object.assign(new Error(`Google Drive ${res.status}`), { status: res.status });
    }
    const ab = await res.arrayBuffer();
    this.pushLog({ kind: 'range', a, n: ab.byteLength, wait: t1 - t0, xfer: now() - t1 });
    if (res.status === 200) { // 伺服器不支援 Range：拿到整個檔案
      if (!this.buf) { try { this.buf = new Uint8Array(this.size); } catch (e) { this.buf = null; } }
      if (this.buf && ab.byteLength === this.size) {
        this.buf.set(new Uint8Array(ab));
        this.addHave(0, this.size);
        this.state = 'done';
        this.wake();
        this.emitNow();
      }
      return ab.slice(a, b);
    }
    if (this.buf) {
      this.buf.set(new Uint8Array(ab), a);
      this.addHave(a, a + ab.byteLength);
      this.wake();
      this.emit();
    } else {
      this.segs.push({ a, b: a + ab.byteLength, buf: ab });
      this.segBytes += ab.byteLength;
      while (this.segBytes > SEG_MAX && this.segs.length > 1) this.segBytes -= this.segs.shift().buf.byteLength;
    }
    return ab;
  }

  pushLog(e) {
    const r = { ...e, at: Math.round(now() - this.t0), wait: Math.round(e.wait), xfer: Math.round(e.xfer) };
    this.log.push(r);
    if (this.log.length > LOG_MAX) this.log.shift();
    return r;
  }

  // 速度紀錄（除錯資訊、測試）
  stats() {
    const net = this.log.filter((e) => e.kind !== 'wait');
    const waits = net.map((e) => e.wait).sort((x, y) => x - y);
    const med = waits.length ? waits[Math.floor(waits.length / 2)] : null;
    const bytes = net.reduce((s, e) => s + e.n, 0), xfer = net.reduce((s, e) => s + e.xfer, 0);
    return {
      state: this.state, size: this.size, received: this.received, cached: !!this.cached,
      fullMs: this.doneAt != null && this.state === 'done' ? Math.round(this.doneAt) : null,
      requests: net.length, ownRequests: this.ownReqs, waitMedianMs: med, waitMaxMs: waits.length ? waits[waits.length - 1] : null,
      MBps: xfer ? +((bytes / MB) / (xfer / 1000)).toFixed(2) : null,
      log: this.log.slice(-40),
    };
  }

  blob() { return this.state === 'done' && this.buf ? new Blob([this.buf], { type: 'application/pdf' }) : null; }

  close() {
    this.closed = true;
    clearTimeout(this.restT);
    this.dropPre();
    try { this.ctrl.abort(); } catch (e) { /* 略過 */ }
    for (const w of this.waiters) w.resolve(false);
    this.waiters = [];
    this.listeners.clear();
    clearTimeout(this.emitT);
    this.buf = null;
    this.segs = [];
  }
}
