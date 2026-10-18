/**
 * A/B 基准：基线（CURVE-1 改动前 HEAD 的 client.js）vs 新版（当前 lib/client.js）。
 *
 *   node tools/ab-compare.mjs [--baseline <绝对路径>] [--new <绝对路径>]
 *
 * 做法：
 * - 对每个 bundle 起一个 harness（DSH_PULSE_CLIENT=<该 bundle>，端口 18721），
 *   再用 headless Edge + CDP 打开页面；
 * - 通过 Page.addScriptToEvaluateOnNewDocument 在页面脚本之前注入：
 *     · window.fetch 覆盖：同源 /pulse-rail/state 由本基准喂入，同一组合成 band 序列；
 *     · requestAnimationFrame 包裹：逐帧给「被测 render loop」计时；
 * - 页面加载后把横条固定为 28 根、统一 markActive 状态（消除应用状态对长度的干扰）；
 * - 每帧（rAF 之后）读 DOM 里每根横条的**真实几何**：
 *     getComputedStyle(el,'::before').transform（matrix 的 scaleX/scaleY）+ ::before 的 width(20px)
 *     ⇒ L[i] = width * scaleX（px），同时记录 el.style 里真实写入的 --dpr-w 与 rightEdge；
 * - 对 5 组输入（单频段尖峰 / 相邻强弱交替 / 低频→高频扫描 / 均匀 / 静音→有声）统计：
 *     mean|ΔL|、max|ΔL|、对比度 max-min、argmax 位置、峰值质心逐帧位移、每帧耗时等；
 * - 与基线对比，按门限判定；任何一条不满足 → 非零退出（见 GATES / 退出码注释）。
 *
 * 输出：tools/out/ab-baseline.json、ab-curve1.json、ab-compare.json、ab-compare.log。
 * 约束：不改 lib/、不 npm install；端口用 18721（避开真实 DSH 的 19387/11636）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');

const BARS = 42;            // 固定横条数 = 应用上限（42 根，采样最密；28 根会因采样欠密低估相邻差变化）
const BANDS = 12;           // 与 harness / 宿主默认 config.bands 一致
const HARNESS_PORT = 18721;
const CFG = {
  enabled: true, minW: 0.45, maxW: 1.35, gamma: 1.1, gate: 0.05,
  atkMs: 40, relMs: 130, silentMs: 450, bassAtBottom: true, bands: BANDS,
};
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function argOf(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const BASELINE = resolve(argOf('--baseline', join(ROOT, '..', '_curve1', 'client.baseline.js')));
const NEWCLIENT = resolve(argOf('--new', join(ROOT, 'lib', 'client.js')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

const LOG = [];
function log(line) {
  LOG.push(line);
  console.log(line);
}

// ── 合成输入时间线（ticks 由客户端 /state 轮询驱动；同一浏览器会话内顺序跑完） ──────
// 注意：这里只定义“喂进去的 band 序列 + 阶段标签”，不实现任何被测算术。
const zeroB = () => new Array(BANDS).fill(0);
function spikeB(k, amp) { const b = zeroB(); b[k] = amp; return b; }
function altB(ampHi, ampLo) { const b = zeroB(); for (let i = 0; i < BANDS; i++) b[i] = i % 2 ? ampLo : ampHi; return b; }
function sweepB(pos) { // pos∈[0,BANDS-1] 连续位置 → 两个相邻 band 交叉淡化
  const b = zeroB(); const k = Math.min(BANDS - 2, Math.floor(pos)); const f = pos - k;
  b[k] = 1 - f; b[k + 1] = f;
  return b;
}

function buildTimeline() {
  const seq = [];
  const ranges = [];
  const add = (tag, n, fn, settle) => {
    const start = seq.length;
    for (let i = 0; i < n; i++) {
      const s = fn(i);
      seq.push({ tag, playing: !!s.playing, rms: s.rms || 0, b: s.b });
    }
    ranges.push({ tag, start, end: seq.length, settle: settle || 0, ticks: n });
  };
  const silent = () => ({ playing: false, rms: 0, b: zeroB() });
  const sound = (b, rms = 0.25) => ({ playing: true, rms, b });

  add('pre', 40, silent, 0);
  add('spike', 80, () => sound(spikeB(5, 1.0)), 40);      // 单频段尖峰（band 5）
  add('gap1', 45, silent, 0);                              // 留足 AGC 慢基线衰减（slowMs=900）
  add('alt', 80, () => sound(altB(0.9, 0.12)), 40);       // 相邻强弱交替
  add('gap2', 45, silent, 0);
  add('sweep', 150, (i) => sound(sweepB((i / 149) * (BANDS - 1)), 0.3), 10); // 低频→高频扫描
  add('gap3', 60, silent, 0);
  add('uniform', 90, () => sound(new Array(BANDS).fill(0.55)), 50); // 均匀
  add('gap4', 50, silent, 0);
  add('riseSilence', 40, silent, 0);                      // 静音→有声
  add('riseSound', 60, () => sound(new Array(BANDS).fill(0.8), 0.3), 0);
  add('tail', 20, silent, 0);

  return { seq, ranges };
}

// 应用导航条「位置→频率」映射（center）：仅供把“输入峰值所在 band”换算成期望的横条下标。
function layoutPos(index, count, layout) {
  if (!(count > 1)) return 0.5;
  const t = Math.min(1, Math.max(0, index / (count - 1)));
  if (layout === 'center') return 1 - Math.abs(2 * t - 1);
  if (layout === 'top') return 1 - t;
  return t;
}
function expectedBarForBand(band) {
  const p = band / (BANDS - 1);       // 频段位置 0..1
  const t = p / 2;                    // center 布局：p = 2t（t<=0.5 左半支）
  return Math.round(t * (BARS - 1));
}

// ── 页面内注入脚本：fetch 覆盖 + rAF 计时 + 逐帧真实 DOM 采样 ─────────────────────
const INIT_SCRIPT = String.raw`(function () {
  var CFG = __CFG__;
  var BANDS = CFG.bands;
  var zero = []; for (var z = 0; z < BANDS; z++) zero.push(0);
  function state(playing, b, rms) {
    return { ok: true, running: true, playing: !!playing, ageMs: 0, config: CFG, frame: { rms: rms || 0, b: b } };
  }
  var boot = state(false, zero, 0);
  window.__ab = { seq: [], i: 0, armed: false, frames: [], bars: 0, capture: null, boot: boot };

  // 1) /pulse-rail/state 由基准喂入（其余请求照旧走真 fetch，例如页面自己的 /report）
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (u, o) {
    var s = String(u);
    if (s.indexOf('/pulse-rail/state') >= 0) {
      var seq = window.__ab.seq, i = window.__ab.i;
      var src = seq.length ? seq[i < seq.length ? i : seq.length - 1] : null;
      var st = src ? state(src.playing, src.b, src.rms) : window.__ab.boot;
      window.__ab.lastB = src ? src.b : null;
      if (seq.length && i < seq.length) window.__ab.i = i + 1;
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(st); } });
    }
    return origFetch ? origFetch(u, o) : Promise.reject(new Error('no fetch'));
  };

  // 2) 包住 rAF：只给“被测 render loop”的耗时计时，随后逐帧采 DOM 真实几何（采样不计入耗时）
  var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  if (raf) {
    window.requestAnimationFrame = function (cb) {
      return raf(function (ts) {
        var t0 = performance.now();
        try { cb(ts); } finally {
          var cost = performance.now() - t0;
          if (window.__ab.armed && window.__ab.capture) {
            try { window.__ab.capture(ts, cost); } catch (e) { /* ignore */ }
          }
        }
      });
    };
  }
})();`;

function initScript() { return INIT_SCRIPT.replace('__CFG__', JSON.stringify(CFG)); }

// 页面内逐帧采样：优先读 computed transform（真几何），并对照 el.style 的 --dpr-w
const CAPTURE_SCRIPT = String.raw`(function () {
  var BARS = __BARS__;
  window.__ab.bars = BARS;
  window.__ab.capture = function (ts, cost) {
    var els = document.querySelectorAll('[data-index]');
    if (els.length !== BARS) return;
    var len = [], sx = [], w = [], sy = [], right = [];
    for (var i = 0; i < els.length; i++) {
      var cs = getComputedStyle(els[i], '::before');
      var nums = (cs.transform || '').match(/-?[0-9.]+/g) || [];
      var a = nums.length >= 6 ? parseFloat(nums[0]) : NaN;       // matrix.a = scaleX（含 --dpr-w）
      var d = nums.length >= 6 ? parseFloat(nums[3]) : NaN;       // matrix.d = scaleY
      var cssW = parseFloat(cs.width) || 0;                        // ::before 原始宽 20px
      var p = parseFloat(els[i].style.getPropertyValue('--dpr-w')); // 客户端真实写入的自定义属性
      len.push(cssW * (isFinite(a) ? a : 0));
      sx.push(isFinite(a) ? a : NaN);
      sy.push(isFinite(d) ? d : NaN);
      w.push(isFinite(p) ? p : NaN);
      right.push(els[i].getBoundingClientRect().right);
    }
    window.__ab.frames.push({
      t: ts, c: cost, tick: window.__ab.i, len: len, sx: sx, w: w, sy: sy,
      fed: window.__ab.lastB ? window.__ab.lastB.slice() : null,
      rMin: Math.min.apply(null, right), rMax: Math.max.apply(null, right),
    });
  };
})();`;

// ── CDP 小客户端 ───────────────────────────────────────────────────────────────
async function httpJson(url, timeoutMs = 1000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function waitHarness(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/', { cache: 'no-store' });
      if (res.ok) return true;
    } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

function findEdge() { return EDGE_CANDIDATES.find((p) => existsSync(p)) || null; }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.consoleLines = []; this.closed = false; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket error')); });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ');
        if (String(text).indexOf('dsh-pulse-rail') >= 0) cdp.consoleLines.push('[' + msg.params.type + '] ' + String(text).slice(0, 200));
      }
    };
    ws.onclose = () => { cdp.closed = true; for (const { reject: rej } of cdp.pending.values()) rej(new Error('CDP closed')); cdp.pending.clear(); };
    return cdp;
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (res && res.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res && res.result ? res.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// ── 单个 bundle 跑一遍全部合成输入 ────────────────────────────────────────────
async function runVariant(edgePath, label, clientPath) {
  if (!existsSync(clientPath)) throw new Error(label + ' bundle 不存在: ' + clientPath);
  const harnessLog = [];
  const harness = spawn(process.execPath, [join(HERE, 'harness.mjs'), String(HARNESS_PORT)], {
    cwd: ROOT,
    env: { ...process.env, DSH_PULSE_CLIENT: clientPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (buf) => { harnessLog.push(String(buf)); };
  harness.stdout.on('data', collect);
  harness.stderr.on('data', collect);

  let edge = null;
  let cdp = null;
  let userDataDirRef = null;
  try {
    if (!(await waitHarness(HARNESS_PORT, 8000))) throw new Error('harness 未在 8s 内监听 ' + HARNESS_PORT);
    const url = 'http://127.0.0.1:' + HARNESS_PORT + '/';
    const dbgPort = 9411 + Math.floor(Math.random() * 300);
    const userDataDir = mkdtempSync(join(tmpdir(), 'dpr-ab-edge-'));   // 临时 profile，避免往仓库里塞大文件
    userDataDirRef = userDataDir;
    edge = spawn(edgePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--remote-debugging-port=' + dbgPort, '--user-data-dir=' + userDataDir,
      '--window-size=420,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let target = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !target) {
      const list = await httpJson('http://127.0.0.1:' + dbgPort + '/json/list', 800);
      if (list && list.length) target = list.find((t) => t.type === 'page');
      if (!target) await sleep(150);
    }
    if (!target) throw new Error('没有 CDP page target（Edge 未就绪）');

    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript() });
    await cdp.send('Page.navigate', { url });

    // 等页面、client bundle 就绪
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await sleep(100);
      const v = await cdp.eval("(function(){var d=window.__DSH_PULSE_RAIL__;return JSON.stringify({ready:document.readyState==='complete',pulse:!!d});})()").catch(() => null);
      if (!v) continue;
      const o = JSON.parse(v);
      if (o.ready && o.pulse) ready = true;
    }
    if (!ready) throw new Error('页面/客户端未就绪：' + JSON.stringify(cdp.consoleLines.slice(0, 4)));

    // 固定横条数 + 统一状态（消除应用 stateScale 对长度的影响），并冻结页面的随机重建
    const setup = await cdp.eval("(function(){var b=window.build;if(typeof b!=='function')return 'no-build';window.build=function(){};b(" + BARS + ");var els=document.querySelectorAll('[data-index]');for(var i=0;i<els.length;i++){els[i].className='mark xpvNua_mark markActive';}return String(els.length);})()");
    if (String(setup) !== String(BARS)) throw new Error('固定横条失败: ' + setup);
    // 等客户端重新扫描并接管 28 根
    let adopted = false;
    for (let i = 0; i < 80 && !adopted; i++) {
      await sleep(100);
      const v = await cdp.eval("(function(){var d=window.__DSH_PULSE_RAIL__;if(!d||!d._debug)return '{}';var s=d._debug();return JSON.stringify({bars:s.bars,polls:s.polls});})()").catch(() => '{}');
      try { const o = JSON.parse(v); if (o.bars === BARS && o.polls > 1) adopted = true; } catch { /* ignore */ }
    }
    if (!adopted) throw new Error('客户端未接管 ' + BARS + ' 根横条');

    // 注入采样器，然后开始喂时间线
    await cdp.eval(CAPTURE_SCRIPT.replace('__BARS__', String(BARS)));
    const { seq, ranges } = buildTimeline();
    await cdp.eval('window.__ab.seq=' + JSON.stringify(seq) + ';window.__ab.i=0;window.__ab.frames=[];window.__ab.armed=true;');
    const tStart = Date.now();
    const maxWait = seq.length * 60 + 12000;
    while (Date.now() - tStart < maxWait) {
      const i = await cdp.eval('window.__ab.i').catch(() => null);
      if (typeof i === 'number' && i >= seq.length) break;
      await sleep(200);
    }
    await cdp.eval('window.__ab.armed=false;');
    const frames = await cdp.eval('window.__ab.frames');
    if (!Array.isArray(frames) || frames.length < 50) throw new Error('采样帧数不足: ' + (frames && frames.length));

    // 采样质量：computed transform 与真实写入的 --dpr-w 应一致（stateScale=1）
    let comparable = 0, written = 0;
    for (const f of frames) for (let i = 0; i < f.sx.length; i++) if (Number.isFinite(f.w[i])) { written++; if (Math.abs(f.sx[i] - f.w[i]) < 0.02) comparable++; }
    const totalVals = written;
    return {
      label, clientPath, frames, seq, ranges,
      harnessLines: harnessLog.join('').split(/\r?\n/).slice(-40),
      consoleLines: cdp.consoleLines.slice(-20),
      transformMatchesDprW: comparable / totalVals,
      elapsedMs: Date.now() - tStart,
    };
  } finally {
    if (cdp) cdp.close();
    try { if (userDataDirRef) rmSync(userDataDirRef, { recursive: true, force: true }); } catch { /* ignore */ }
    if (edge) { try { edge.kill(); } catch { /* ignore */ } }
    try { harness.kill(); } catch { /* ignore */ }
  }
}

// ── 指标 ───────────────────────────────────────────────────────────────────────
function frameStats(len) {
  const n = len.length;
  let adjSum = 0, adjMax = 0;
  for (let i = 0; i + 1 < n; i++) { const d = Math.abs(len[i + 1] - len[i]); adjSum += d; if (d > adjMax) adjMax = d; }
  let mn = Infinity, mx = -Infinity, am = 0, total = 0, centroid = 0;
  let leftSum = 0, leftTotal = 0;
  const half = Math.floor((n - 1) / 2);   // center 镜像布局：镜像折叠后取左半边质心 = 规范峰值位置
  for (let i = 0; i < n; i++) {
    const v = len[i];
    if (v < mn) mn = v;
    if (v > mx) { mx = v; am = i; }
    total += v;
    centroid += i * v;
    if (i <= half) { leftSum += i * v; leftTotal += v; }
  }
  // 长度含 minW 底座（~9px），质心改用「高出本帧最小值的部分」加权，否则底座会把质心拉向中心
  let eSum = 0, eTot = 0;
  for (let i = 0; i <= half; i++) { const e = Math.max(0, len[i] - mn); eSum += i * e; eTot += e; }
  return {
    adjMean: n > 1 ? adjSum / (n - 1) : 0,
    adjMax,
    contrast: mx - mn,
    min: mn, max: mx, meanLen: total / n,
    argmax: am,
    centroid: total > 1e-9 ? centroid / total : 0,
    centroidLeft: eTot > 1e-6 ? eSum / eTot : am,
  };
}

function mode(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  let best = null, bestN = -1;
  for (const [v, n] of m) if (n > bestN) { bestN = n; best = v; }
  return best;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[idx];
}

function summarizeRun(run) {
  const { frames, seq, ranges } = run;
  const byTag = new Map();
  for (const r of ranges) byTag.set(r.tag, { range: r, list: [] });
  for (const f of frames) {
    const si = Math.min(Math.max(f.tick - 1, 0), seq.length - 1);
    const tag = seq[si].tag;
    const entry = byTag.get(tag);
    if (!entry) continue;
    entry.list.push({ f, off: si - entry.range.start, stat: frameStats(f.len) });
  }

  const out = {};
  for (const [tag, { range, list }] of byTag) {
    if (!list.length) continue;
    const steady = ['spike', 'alt', 'uniform', 'sweep'].includes(tag)
      ? list.filter((x) => x.off >= range.settle)
      : list;
    const stats = (steady.length ? steady : list).map((x) => x.stat);
    const costs = list.map((x) => x.f.c);
    out[tag] = {
      frames: stats.length,
      rawFrames: list.length,
      adjMeanAvg: mean(stats.map((s) => s.adjMean)),
      adjMaxPeak: Math.max(...stats.map((s) => s.adjMax)),
      adjMaxAvg: mean(stats.map((s) => s.adjMax)),
      contrastAvg: mean(stats.map((s) => s.contrast)),
      contrastMax: Math.max(...stats.map((s) => s.contrast)),
      contrastMin: Math.min(...stats.map((s) => s.contrast)),
      argmaxAvg: mean(stats.map((s) => s.argmax)),
      argmaxFirst: stats.length ? stats[0].argmax : null,
      argmaxMode: mode(stats.map((s) => s.argmax)),
      meanLen: mean(stats.map((s) => s.meanLen)),
      centroidAvg: mean(stats.map((s) => s.centroid)),
      centroidLeftAvg: mean(stats.map((s) => s.centroidLeft)),
      series: {
        t: list.map((x) => round(x.f.t, 1)),
        argmax: stats.map((s) => s.argmax),
        centroid: stats.map((s) => round(s.centroid, 3)),
        contrast: stats.map((s) => round(s.contrast, 3)),
        adjMean: stats.map((s) => round(s.adjMean, 3)),
      },
      costMeanMs: mean(costs),
      rightEdgeSpread: Math.max(...list.map((x) => x.f.rMax - x.f.rMin)),
    };
    if (tag === 'sweep') {
      const cents = stats.map((s) => s.centroidLeft);
      const moves = [];
      for (let i = 1; i < cents.length; i++) moves.push(cents[i] - cents[i - 1]);
      out[tag].centroidSpan = Math.max(...cents) - Math.min(...cents);
      out[tag].centroidMaxMove = moves.length ? Math.max(...moves.map((m) => Math.abs(m))) : 0;
      out[tag].centroidReversals = moves.filter((m) => m < -0.5).length;
      out[tag].centroidForward = mean(moves.filter((m) => m > 0));
    }
    if (tag === 'riseSound') {
      const onset = Math.min(...list.map((x) => x.f.t));
      const lenMeans = list.map((x) => x.stat.meanLen);
      const steadyMean = mean(lenMeans.slice(-15));
      let settleFrame = list.findIndex((x) => x.stat.meanLen >= 0.9 * steadyMean);
      if (settleFrame < 0) settleFrame = lenMeans.length - 1;
      out[tag].steadyMeanLen = steadyMean;
      out[tag].riseMs = list[settleFrame].f.t - onset;
      out[tag].overshoot = Math.max(...lenMeans) - steadyMean;
    }
  }
  const costAll = frames.map((f) => f.c);
  out.__perf = {
    frames: frames.length,
    costMeanMs: mean(costAll),
    costP95Ms: percentile(costAll, 0.95),
    costMaxMs: Math.max(...costAll),
    fps: frames.length > 1 ? (frames.length - 1) / ((frames[frames.length - 1].t - frames[0].t) / 1000) : 0,
    durationMs: frames.length ? frames[frames.length - 1].t - frames[0].t : 0,
  };
  return out;
}

// ── 对比 + 门限 ──────────────────────────────────────────────────────────────
const GATES = {
  adjDropMin: 0.20,      // 交替/尖峰：mean|ΔL| 与 max|ΔL| 相对基线至少要降 20%
  contrastDropMax: 0.35, // 对比度 max-min 相对基线下降不得超过 35%
  paramTolBars: 2,       // argmax 与基线/期望位置偏差 ≤2 根
  sweepMaxMove: 1.5,     // 扫描时峰值质心逐帧位移 ≤1.5 根
  sweepReversals: 5,     // 峰值质心明显倒退（>0.5 根）次数上限
  perfRiseRatio: 1.5,    // 每帧耗时相对基线增幅 ≤50%
};

function verdict(base, cur) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  for (const tag of ['spike', 'alt']) {
    const b = base[tag], n = cur[tag];
    if (!b || !n) { add('adj-' + tag, false, '缺少场景数据'); continue; }
    const dm = b.adjMeanAvg > 0 ? 1 - n.adjMeanAvg / b.adjMeanAvg : 0;
    const dx = b.adjMaxPeak > 0 ? 1 - n.adjMaxPeak / b.adjMaxPeak : 0;
    add('adj-mean-' + tag, dm >= GATES.adjDropMin,
      'mean|ΔL| ' + round(b.adjMeanAvg) + '→' + round(n.adjMeanAvg) + 'px (−' + round(dm * 100, 1) + '%, 要求≥20%)');
    add('adj-max-' + tag, dx >= GATES.adjDropMin,
      'max|ΔL| ' + round(b.adjMaxPeak) + '→' + round(n.adjMaxPeak) + 'px (−' + round(dx * 100, 1) + '%, 要求≥20%)');
    const dc = b.contrastAvg > 0 ? 1 - n.contrastAvg / b.contrastAvg : 0;
    add('contrast-' + tag, dc <= GATES.contrastDropMax,
      'contrast(max-min) ' + round(b.contrastAvg) + '→' + round(n.contrastAvg) + 'px (下降 ' + round(dc * 100, 1) + '%, 上限35%)');
    const da = Math.abs(n.argmaxAvg - b.argmaxAvg);
    add('argmax-' + tag, da <= GATES.paramTolBars,
      'argmax ' + round(b.argmaxAvg, 1) + '→' + round(n.argmaxAvg, 1) + '（偏差 ' + round(da, 2) + ' 根，上限 ' + GATES.paramTolBars + '）');
  }
  // 单频段尖峰：argmax 还必须落在输入峰值对应的横条附近
  const expBar = expectedBarForBand(5);
  const nSpike = cur.spike;
  if (nSpike) add('argmax-spike-input', Math.abs(nSpike.argmaxAvg - expBar) <= GATES.paramTolBars,
    '新版 argmax ' + round(nSpike.argmaxAvg, 1) + '，输入 band5 期望 ' + expBar + '±' + GATES.paramTolBars);

  // 扫描连续性
  if (base.sweep && cur.sweep) {
    add('sweep-move', cur.sweep.centroidMaxMove <= GATES.sweepMaxMove,
      '峰值质心最大单帧位移 ' + round(cur.sweep.centroidMaxMove, 3) + ' 根/帧（上限 ' + GATES.sweepMaxMove + '）');
    add('sweep-reversal', cur.sweep.centroidReversals <= GATES.sweepReversals,
      '质心倒退次数 ' + cur.sweep.centroidReversals + '（上限 ' + GATES.sweepReversals + '）');
    add('sweep-span', cur.sweep.centroidSpan >= 0.5 * base.sweep.centroidSpan,
      '质心覆盖 ' + round(cur.sweep.centroidSpan, 2) + ' 根（基线 ' + round(base.sweep.centroidSpan, 2) + '）');
  } else {
    add('sweep', false, '缺少扫描场景数据');
  }
  // 性能
  const bm = base.__perf.costMeanMs, nm = cur.__perf.costMeanMs;
  add('perf', nm <= bm * GATES.perfRiseRatio,
    '每帧耗时 ' + round(bm, 3) + '→' + round(nm, 3) + 'ms（+' + round((nm / bm - 1) * 100, 1) + '%，上限 +50%）');

  return checks;
}

function printTable(base, cur) {
  const rows = [];
  const addRow = (sc, metric, b, n, fmt = (v) => round(v, 3)) => rows.push([sc, metric, fmt(b), fmt(n)]);
  for (const tag of ['spike', 'alt', 'uniform', 'sweep', 'riseSound']) {
    const b = base[tag], n = cur[tag];
    if (!b || !n) continue;
    if (tag === 'riseSound') {
      addRow(tag, 'rise 90% (ms)', b.riseMs, n.riseMs, (v) => round(v, 0));
      addRow(tag, 'steady mean L (px)', b.steadyMeanLen, n.steadyMeanLen);
      addRow(tag, 'overshoot (px)', b.overshoot, n.overshoot);
      continue;
    }
    addRow(tag, 'mean|ΔL| (px)', b.adjMeanAvg, n.adjMeanAvg);
    addRow(tag, 'max|ΔL| (px)', b.adjMaxPeak, n.adjMaxPeak);
    addRow(tag, 'contrast max-min (px)', b.contrastAvg, n.contrastAvg);
    addRow(tag, 'argmax (bar)', b.argmaxAvg, n.argmaxAvg, (v) => round(v, 1));
    if (tag === 'sweep') {
      addRow(tag, 'peakPos(左半质心) span', b.centroidSpan, n.centroidSpan, (v) => round(v, 2));
      addRow(tag, 'peakPos max move/frame', b.centroidMaxMove, n.centroidMaxMove, (v) => round(v, 3));
      addRow(tag, 'peakPos reversals', b.centroidReversals, n.centroidReversals, (v) => String(v));
    }
  }
  addRow('perf', 'frame cost mean (ms)', base.__perf.costMeanMs, cur.__perf.costMeanMs);
  addRow('perf', 'frame cost p95 (ms)', base.__perf.costP95Ms, cur.__perf.costP95Ms);
  addRow('perf', 'fps', base.__perf.fps, cur.__perf.fps, (v) => round(v, 1));

  const head = ['scenario', 'metric', 'baseline', 'curve1'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  log('');
  log(line(head));
  log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) log(line(r));
  log('');
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true });
  log('A/B bench: baseline=' + BASELINE);
  log('A/B bench: new     =' + NEWCLIENT);
  const edgePath = findEdge();
  if (!edgePath) {
    // 明确退化说明：没有浏览器就无法读 DOM 真实几何；不伪造数据，直接失败并说明。
    log('FAIL: 找不到 headless Edge（' + EDGE_CANDIDATES.join(' / ') + '）。');
    log('      本机离线链路只能退化为 Node 端度量；基线 bundle 不导出 __curve，Node 端无法公平测量，');
    log('      因此 ab-compare 不做伪造对比，直接失败（详见报告 limitations）。');
    process.exitCode = 1;
    return;
  }
  log('edge=' + edgePath);

  const t0 = Date.now();
  log('[1/2] 跑基线 bundle @ ' + HARNESS_PORT + ' ...');
  const baseRun = await runVariant(edgePath, 'baseline', BASELINE);
  log('      采样 ' + baseRun.frames.length + ' 帧，transform≡--dpr-w 一致率 ' + round(baseRun.transformMatchesDprW * 100, 1) + '%，耗时 ' + baseRun.elapsedMs + 'ms');
  log('[2/2] 跑新版 bundle @ ' + HARNESS_PORT + ' ...');
  const curRun = await runVariant(edgePath, 'curve1', NEWCLIENT);
  log('      采样 ' + curRun.frames.length + ' 帧，transform≡--dpr-w 一致率 ' + round(curRun.transformMatchesDprW * 100, 1) + '%，耗时 ' + curRun.elapsedMs + 'ms');
  log('总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const base = summarizeRun(baseRun);
  const cur = summarizeRun(curRun);
  const baseOut = {
    label: 'baseline', clientPath: BASELINE, generatedAt: new Date().toISOString(),
    config: CFG, bars: BARS, bands: BANDS,
    transformMatchesDprW: round(baseRun.transformMatchesDprW, 4),
    metrics: base,
    consoleLines: baseRun.consoleLines,
    harnessTail: baseRun.harnessLines,
  };
  const curOut = {
    label: 'curve1', clientPath: NEWCLIENT, generatedAt: new Date().toISOString(),
    config: CFG, bars: BARS, bands: BANDS,
    transformMatchesDprW: round(curRun.transformMatchesDprW, 4),
    metrics: cur,
    consoleLines: curRun.consoleLines,
    harnessTail: curRun.harnessLines,
  };
  writeFileSync(join(OUT, 'ab-baseline.json'), JSON.stringify(baseOut, null, 2));
  writeFileSync(join(OUT, 'ab-curve1.json'), JSON.stringify(curOut, null, 2));

  printTable(base, cur);
  const checks = verdict(base, cur);
  let failed = 0;
  log('门限检查：');
  for (const c of checks) {
    if (!c.ok) failed++;
    log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.id.padEnd(18) + '  ' + c.detail);
  }

  // 退出码：1 环境/运行失败；3 相邻差收益不达标；4 对比度/峰值退化；5 扫描连续性退化；6 性能超限
  let code = 0;
  const failedIds = checks.filter((c) => !c.ok).map((c) => c.id);
  if (failedIds.some((id) => id.startsWith('adj-'))) code = 3;
  else if (failedIds.some((id) => id === 'contrast-spike' || id === 'contrast-alt' || id.startsWith('argmax'))) code = 4;
  else if (failedIds.some((id) => id.startsWith('sweep'))) code = 5;
  else if (failedIds.includes('perf')) code = 6;

  const summary = {
    generatedAt: new Date().toISOString(),
    baseline: BASELINE, new: NEWCLIENT, config: CFG, bars: BARS, bands: BANDS,
    checks, failedChecks: failed, exitCode: code,
    baselineMetrics: base, curve1Metrics: cur,
    transformMatchesDprW: { baseline: round(baseRun.transformMatchesDprW, 4), curve1: round(curRun.transformMatchesDprW, 4) },
    durationMs: Date.now() - t0,
  };
  writeFileSync(join(OUT, 'ab-compare.json'), JSON.stringify(summary, null, 2));

  if (failed) {
    log('结论：FAIL（' + failed + '/' + checks.length + ' 条门限未通过，exit=' + code + '）');
  } else {
    log('结论：PASS（新版在保持对比度/峰值可辨识的前提下，相邻长度差显著下降）');
  }
  log('输出：' + join(OUT, 'ab-baseline.json') + ' / ' + join(OUT, 'ab-curve1.json') + ' / ' + join(OUT, 'ab-compare.json'));
  writeFileSync(join(OUT, 'ab-compare.log'), LOG.join('\n') + '\n');
  process.exitCode = code;
}

main().catch((err) => {
  log('ERROR ' + ((err && err.stack) || err));
  log('HINT 若 headless Edge 不可用，可先用 tools/cdp-check.mjs 确认；基线 bundle 不导出 __curve，Node 端无法公平测量。');
  try { writeFileSync(join(OUT, 'ab-compare.log'), LOG.join('\n') + '\n'); } catch { /* ignore */ }
  process.exitCode = 1;
});
