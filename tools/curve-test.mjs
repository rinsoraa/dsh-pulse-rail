#!/usr/bin/env node
/**
 * tools/curve-test.mjs — CURVE-1「频谱曲线整形」流水线验证（直接打生产实现）
 *
 * 被测对象是 lib/client.js 里真正跑的 exports.__curve（经 tools/_load-client.mjs 的 stub
 * window/react 加载同一个 lazy-CJS bundle），测试里不另写一套等价算法：
 *   清洗 → 绝对电平 + 连续动态对比(agcMix/slowLv/peakLv/smoothStep) → 轻压缩 log1p
 *   → 三点空间平滑 → 时间包络(atkMs/relMs) → Fritsch–Carlson 保形 PCHIP 插值
 *
 * 插值质量（PCHIP）的断言：
 *   - 无过冲：百万级随机采样点，每个采样值落在所属区间两端点范围内
 *   - 节点复现：pos = k/(n-1) 处精确复现 band[k]
 *   - 节点折角：内部节点左右斜率跳变总量，PCHIP ≤ 线性插值的一半（打印两者数值）
 * 注：PCHIP 与线性插值经过同样的 12 个节点、段内均单调，总变差守恒；因此本测试不再
 *     断言「PCHIP 相邻差比线性插值下降」。相邻差的下降归因于空间平滑环节，在 [12] 中验证。
 *
 * 平滑有效性（[12]）：
 *   - 比较 spatialSmoothInto(pointwiseBands, 0.3) 前后的 Σ|Δ|、max|Δ| 与 max-min 对比度。
 *   - pointwiseBands 为空间平滑前的点式整形输出：测试内临时把导出的 CURVE.smoothMix 置 0
 *     取得（走同一生产函数 bandShape），随后在 finally 中恢复；不修改源码、不改变默认参数。
 *   - 阈值按输入类别区分（3 点 [0.25,0.5,0.25] 平滑、mix=0.3 的理论值）：
 *       交替输入：Σ|Δ| 降 ≥25%（段内理论 30%，端点效应后实测 28.6%）、max|Δ| 降 ≥20%（22.5%）
 *       单尖峰：  max|Δ| 降 ≥20%（22.5%）、Σ|Δ| 降 ≥10%（孤立尖峰总变差由两处大跳变构成，
 *                 平滑只会削掉 mix/2=15%，强行要求更高就等于抹平频谱，故只设 ≥10%）
 *       两类都要求对比度 max-min 降幅 ≤20%（防止平滑过度、层次被抹平）
 *
 * 运行： "C:\Program Files\nodejs\node.exe" tools/curve-test.mjs
 * 退出码：0 = 全部断言通过（打印 ALL PASS）；1 = 存在失败断言；2 = 生产导出缺失。
 */

import { loadClient } from './_load-client.mjs';

const client = loadClient(new URL('../lib/client.js', import.meta.url));
const C = client && client.__curve;
if (!C) {
  console.error('FATAL: lib/client.js 未导出 __curve（无法验证生产实现）');
  process.exit(2);
}

// ── 生产参数（与 lib/client.js DEFAULTS / 渲染循环一致）────────────────────────
const BAND_COUNT = 12;
const DT_MS = 33;
const SAMPLE_COUNT = 42;          // 3/4/5 类固定采样点数
const ARG_LAYOUT = 'down';        // 单调布局：采样位置 0→1，适合检查峰值移动
const LAYOUTS = ['top', 'center', 'down'];
const CFG = { gate: 0.02, gamma: 0.6, agcMix: 0.6, atkMs: 35, relMs: 120 };
const EPS = 1e-12;

// ── 断言与统计 ──────────────────────────────────────────────────────────────
let checkCount = 0;
const failures = [];
const globalStats = { values: 0, min: Infinity, max: -Infinity };

function ok(name, cond, detail) {
  checkCount++;
  if (cond) return true;
  failures.push({ name, detail: detail === undefined ? '' : String(detail) });
  return false;
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

function fmtVal(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
  }
  if (typeof v === 'undefined') return 'undefined';
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function collectNumbers(value, out) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectNumbers(value[i], out);
  } else {
    out.push(value);
  }
}

/**
 * 断言一批输出值全部是有限值且位于 [0,1]（同时并入全局值统计）。支持嵌套数组。
 */
function assertUnit(name, values, extra) {
  const flat = [];
  collectNumbers(values, flat);
  const bad = [];
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -EPS || v > 1 + EPS) {
      if (bad.length < 5) bad.push(fmtVal(v));
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < globalStats.min) globalStats.min = v;
      if (v > globalStats.max) globalStats.max = v;
    }
    globalStats.values++;
  }
  const detail = bad.length
    ? '异常值样本: ' + bad.join(', ') + ' (共 ' + flat.length + ' 个)'
    : flat.length + ' 个值 ∈ [0,1] 且有限' + (extra ? '，' + extra : '');
  return ok(name, bad.length === 0, detail);
}

// ── 生产 API 的调用封装 ─────────────────────────────────────────────────────
function zeroBands() {
  return new Array(BAND_COUNT).fill(0);
}

/** 连续 frames 帧喂同一组 rawBands，返回最后一帧的整形频段与 PCHIP 斜率（均为拷贝）。 */
function runStatic(rawBands, frames, idleFlag) {
  const idle = !!idleFlag;
  const memo = C.newShapeState(BAND_COUNT);
  let out = null;
  for (let f = 0; f < frames; f++) out = C.bandShape(memo, rawBands, BAND_COUNT, CFG, DT_MS, idle);
  return { bands: Array.from(out), slopes: Array.from(memo.slopes) };
}

/** 逐帧运行，返回每帧的整形频段与斜率拷贝。 */
function runFrames(rawBands, frames, idleFlag) {
  const idle = !!idleFlag;
  const memo = C.newShapeState(BAND_COUNT);
  const framesOut = [];
  let out = null;
  for (let f = 0; f < frames; f++) {
    out = C.bandShape(memo, rawBands, BAND_COUNT, CFG, DT_MS, idle);
    framesOut.push({ bands: Array.from(out), slopes: Array.from(memo.slopes) });
  }
  return { frames: framesOut, last: framesOut[framesOut.length - 1] };
}

/** 用生产实现按 count 个横条采样：索引 → 布局位置 → pchipAt。 */
function samplePchip(bands, slopes, count, layout) {
  const n = count === undefined ? SAMPLE_COUNT : count;
  const lay = layout === undefined ? ARG_LAYOUT : layout;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = C.pchipAt(bands, slopes, C.layoutPos(i, n, lay));
  return out;
}

/**
 * 参考实现：对整形后频段直接做线性插值采样（CURVE-1 之前的渲染路径）。
 * 仅用于节点折角的对比基准，不是被测对象。
 */
function sampleLinear(ys, count, layout) {
  const n = count === undefined ? SAMPLE_COUNT : count;
  const lay = layout === undefined ? ARG_LAYOUT : layout;
  const last = ys.length - 1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const pos = C.layoutPos(i, n, lay);
    const x = pos * last;
    let k = Math.floor(x);
    if (k >= last) k = last - 1;
    if (k < 0) k = 0;
    let t = x - k;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    out[i] = ys[k] * (1 - t) + ys[k + 1] * t;
  }
  return out;
}

function stats(seq) {
  let sum = 0;
  let maxAdj = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (i > 0) {
      const d = Math.abs(v - seq[i - 1]);
      sum += d;
      if (d > maxAdj) maxAdj = d;
    }
  }
  return {
    meanAdj: seq.length > 1 ? sum / (seq.length - 1) : 0,
    sumAdj: sum,
    maxAdj,
    min,
    max,
    contrast: max - min
  };
}

function argmaxOf(seq) {
  let best = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] > seq[best]) best = i;
  return best;
}

/** 峰值质心（横条索引加权），对平顶/近简并比 argmax 稳定。 */
function centroidOf(seq) {
  let sumV = 0;
  let sumIV = 0;
  for (let i = 0; i < seq.length; i++) {
    sumV += seq[i];
    sumIV += i * seq[i];
  }
  return sumV > 0 ? sumIV / sumV : 0;
}

function topGap(seq) {
  let a = -Infinity;
  let b = -Infinity;
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i];
    if (v > a) { b = a; a = v; } else if (v > b) { b = v; }
  }
  return a - b;
}

function num(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits === undefined ? 4 : digits) : String(v);
}

function pct(v) {
  return Number.isFinite(v) ? v.toFixed(2) + '%' : String(v);
}

function pad(s, width) {
  s = String(s);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function lcg(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 新判据的两张数值表
const kinkRows = [];
const smoothRows = [];

function printQualityTables() {
  console.log('\n== 插值折角对比（内部节点 1..10，ε=1e-4；折角=|右斜率-左斜率|）==');
  console.log(pad('scenario', 12) + pad('PCHIP sum', 14) + pad('linear sum', 14) +
    pad('ratio', 12) + pad('PCHIP max', 14) + pad('linear max', 14));
  for (const row of kinkRows) {
    console.log(pad(row.scenario, 12) + pad(row.pchipSum.toExponential(3), 14) +
      pad(row.linearSum.toFixed(4), 14) + pad((row.pchipSum / row.linearSum).toExponential(2), 12) +
      pad(row.pchipMax.toExponential(3), 14) + pad(row.linearMax.toFixed(4), 14));
  }
  console.log('\n== 空间平滑前后相邻差 / 对比度（mix=0.3，同一份点式整形频段）==');
  console.log(pad('scenario', 12) + pad('Σ|Δ| before', 14) + pad('Σ|Δ| after', 14) +
    pad('Σ drop', 10) + pad('max|Δ| before', 15) + pad('max|Δ| after', 14) +
    pad('max drop', 10) + pad('contrast b→a', 18));
  for (const row of smoothRows) {
    console.log(pad(row.scenario, 12) + pad(row.sumBefore.toFixed(4), 14) +
      pad(row.sumAfter.toFixed(4), 14) + pad(pct(row.sumDrop), 10) +
      pad(row.maxBefore.toFixed(4), 15) + pad(row.maxAfter.toFixed(4), 14) +
      pad(pct(row.maxDrop), 10) + pad(row.contrastBefore.toFixed(4) + ' → ' + row.contrastAfter.toFixed(4), 18));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// [0] 生产导出面 sanity
// ═════════════════════════════════════════════════════════════════════════════
function testExports() {
  section('[0] 生产导出面');
  const expected = [
    'CURVE', 'sanitizeBands', 'compressLog', 'smoothStep', 'spatialSmoothInto',
    'pchipSlopesInto', 'pchipAt', 'layoutPos', 'newShapeState', 'bandShape', 'zeros', 'clamp'
  ];
  const missing = expected.filter(function (k) { return C[k] === undefined; });
  ok('[0] __curve 导出齐全', missing.length === 0, '缺失: ' + missing.join(','));
  ok('[0] CURVE 参数对象存在（smoothMix=0.3）', C.CURVE && C.CURVE.smoothMix === 0.3, JSON.stringify(C.CURVE));
  const memo = C.newShapeState(BAND_COUNT);
  const allZero = function (arr) {
    return Array.isArray(arr) && arr.length === BAND_COUNT && arr.every(function (v) { return v === 0; });
  };
  ok('[0] newShapeState(12) 状态缓冲正确',
    allZero(memo.slow) && allZero(memo.peak) && allZero(memo.smooth) && allZero(memo.slopes),
    Object.keys(memo).join(','));
  ok('[0] zeros(3) / clamp',
    C.zeros(3).length === 3 && C.clamp(-1, 0, 1) === 0 && C.clamp(5, 0, 1) === 1 && C.clamp(0.4, 0, 1) === 0.4);
}

// ═════════════════════════════════════════════════════════════════════════════
// [1] 全零静音：连续 150 帧 dt=33ms，不得产生假信号
// ═════════════════════════════════════════════════════════════════════════════
function testSilence() {
  section('[1] 全零静音（150 帧，dt=33ms）');
  const frames = 150;
  const memo = C.newShapeState(BAND_COUNT);
  const allBands = [];
  const allSamples = [];
  let nonZeroBands = 0;
  let nonZeroSlopes = 0;
  for (let f = 0; f < frames; f++) {
    const bands = C.bandShape(memo, zeroBands(), BAND_COUNT, CFG, DT_MS, false);
    for (let i = 0; i < BAND_COUNT; i++) {
      allBands.push(bands[i]);
      if (bands[i] !== 0) nonZeroBands++;
      if (memo.slopes[i] !== 0) nonZeroSlopes++;
    }
    allSamples.push(samplePchip(bands, memo.slopes, SAMPLE_COUNT, ARG_LAYOUT));
  }
  assertUnit('[1] 输出全部有限且在 [0,1]', [allBands, allSamples]);
  ok('[1] 150 帧 × 12 频段输出恒为 0（无假信号）', nonZeroBands === 0,
    '非零值 ' + nonZeroBands + ' 个');
  ok('[1] PCHIP 斜率恒为 0', nonZeroSlopes === 0, '非零斜率 ' + nonZeroSlopes + ' 个');
  ok('[1] 42 点采样序列恒为 0', allSamples.every(function (seq) {
    return seq.every(function (v) { return v === 0; });
  }), '非零采样帧 ' + allSamples.filter(function (seq) {
    return seq.some(function (v) { return v !== 0; });
  }).length);
}

// ═════════════════════════════════════════════════════════════════════════════
// [2] 均匀输入：输出一致且不为 0
// ═════════════════════════════════════════════════════════════════════════════
function testUniform() {
  section('[2] 均匀输入（全 0.55，200 帧）');
  const raw = new Array(BAND_COUNT).fill(0.55);
  const res = runStatic(raw, 200);
  assertUnit('[2] 整形后频段有限且在 [0,1]', [res.bands]);
  const s = stats(res.bands);
  ok('[2] 输出一致（max-min ≤ 1e-9）', s.contrast <= 1e-9, 'max-min=' + s.contrast);
  ok('[2] 输出不为 0（各频段 > 0.1）', s.min > 0.1, 'min=' + num(s.min));

  const seq = samplePchip(res.bands, res.slopes);
  assertUnit('[2] 42 点采样有限且在 [0,1]', [seq]);
  const ss = stats(seq);
  ok('[2] 采样后仍一致（max-min ≤ 1e-9）', ss.contrast <= 1e-9, 'max-min=' + ss.contrast);
  ok('[2] 采样值不为 0', ss.min > 0.1, 'min=' + num(ss.min));
}

// ═════════════════════════════════════════════════════════════════════════════
// [3] 单调递增/递减：count=42 采样无过冲、序列单调
// ═════════════════════════════════════════════════════════════════════════════
function testMonotone() {
  section('[3] 单调递增 / 递减（0.05..0.95，count=42，layout=down）');
  const rampUp = Array.from({ length: BAND_COUNT }, function (_, i) {
    return 0.05 + 0.9 * i / (BAND_COUNT - 1);
  });
  const rampDown = rampUp.slice().reverse();
  const cases = [
    { label: '递增', raw: rampUp, dir: 1 },
    { label: '递减', raw: rampDown, dir: -1 }
  ];
  for (const item of cases) {
    const res = runStatic(item.raw, 400);
    assertUnit('[3] ' + item.label + '：整形后频段有限且在 [0,1]', [res.bands]);

    let bandMonotone = true;
    for (let i = 1; i < BAND_COUNT; i++) {
      if ((res.bands[i] - res.bands[i - 1]) * item.dir < -EPS) bandMonotone = false;
    }
    ok('[3] ' + item.label + '：整形后频段保持单调', bandMonotone,
      res.bands.map(function (v) { return v.toFixed(3); }).join(','));

    const seq = samplePchip(res.bands, res.slopes, SAMPLE_COUNT, 'down');
    assertUnit('[3] ' + item.label + '：42 点采样有限且在 [0,1]', [seq]);

    let noOvershoot = true;
    let worst = null;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const pos = C.layoutPos(i, SAMPLE_COUNT, 'down');
      const x = pos * (BAND_COUNT - 1);
      let k = Math.floor(x);
      if (k >= BAND_COUNT - 1) k = BAND_COUNT - 2;
      if (k < 0) k = 0;
      let t = x - k;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const lo = Math.min(res.bands[k], res.bands[k + 1]);
      const hi = Math.max(res.bands[k], res.bands[k + 1]);
      if (seq[i] < lo - EPS || seq[i] > hi + EPS) {
        noOvershoot = false;
        worst = { i: i, pos: pos.toFixed(4), value: seq[i], lo: lo, hi: hi };
      }
    }
    ok('[3] ' + item.label + '：每个采样区间不越过两端点范围（无过冲）', noOvershoot,
      worst ? JSON.stringify(worst) : '42/42 采样落在所属区间两端点之间');

    let seqMonotone = true;
    for (let i = 1; i < seq.length; i++) {
      if ((seq[i] - seq[i - 1]) * item.dir < -EPS) seqMonotone = false;
    }
    ok('[3] ' + item.label + '：采样序列' + (item.dir > 0 ? '非递减' : '非递增'), seqMonotone);

    ok('[3] ' + item.label + '：采样端点精确命中首末频段',
      Math.abs(seq[0] - res.bands[0]) <= EPS &&
      Math.abs(seq[SAMPLE_COUNT - 1] - res.bands[BAND_COUNT - 1]) <= EPS,
      'seq[0]=' + num(seq[0]) + ' bands[0]=' + num(res.bands[0]));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// [4] 单频段尖峰：峰值可辨识、对比度保留
// ═════════════════════════════════════════════════════════════════════════════
function testSpike() {
  section('[4] 单频段尖峰（第 5 段=1.0，其余 0.05）');
  const raw = new Array(BAND_COUNT).fill(0.05);
  raw[4] = 1.0; // 「第 5 段」按 1-based 计 → 索引 4
  const res = runStatic(raw, 400);
  assertUnit('[4] 整形后频段有限且在 [0,1]', [res.bands]);

  const seq = samplePchip(res.bands, res.slopes, SAMPLE_COUNT, 'down');
  assertUnit('[4] 42 点 PCHIP 采样有限且在 [0,1]', [seq]);
  const got = stats(seq);

  const peakBar = argmaxOf(seq);
  const expectedBar = 4 * (SAMPLE_COUNT - 1) / (BAND_COUNT - 1);
  ok('[4] 峰值仍可辨识（采样峰值 ≥0.5 且 argmax 在尖峰附近 ±3 根）',
    got.max >= 0.5 && Math.abs(peakBar - expectedBar) <= 3,
    'peak=' + num(got.max) + ' argmax=' + peakBar + ' expected≈' + num(expectedBar, 2));
  ok('[4] 对比度 max-min ≥ 0.25（不抹平频谱）', got.contrast >= 0.25, 'contrast=' + num(got.contrast));
  ok('[4] 峰值处采样不塌陷（采样峰值 ≥ 整形后频段峰值的 90%）',
    got.max >= 0.9 * Math.max.apply(null, res.bands),
    'sampled=' + num(got.max) + ' bands=' + num(Math.max.apply(null, res.bands)));
}

// ═════════════════════════════════════════════════════════════════════════════
// [5] 相邻强弱交替：对比度不塌（相邻差下降改由 [12] 空间平滑环节验证）
// ═════════════════════════════════════════════════════════════════════════════
function testAlternating() {
  section('[5] 相邻强弱交替（0.95 / 0.05）');
  const raw = Array.from({ length: BAND_COUNT }, function (_, i) { return i % 2 === 0 ? 0.95 : 0.05; });
  const res = runStatic(raw, 400);
  assertUnit('[5] 整形后频段有限且在 [0,1]', [res.bands]);

  const seq = samplePchip(res.bands, res.slopes, SAMPLE_COUNT, 'down');
  assertUnit('[5] 42 点 PCHIP 采样有限且在 [0,1]', [seq]);
  const got = stats(seq);
  const bandsMin = Math.min.apply(null, res.bands);
  const bandsMax = Math.max.apply(null, res.bands);

  ok('[5] 对比度 max-min ≥ 0.25（不把频谱抹平）', got.contrast >= 0.25,
    'contrast=' + num(got.contrast) + '（整形后频段=' + num(bandsMax - bandsMin) + '）');
  ok('[5] 采样极值仍接近整形后频段极值（峰值保留 ≥90%）',
    got.max >= 0.9 * bandsMax && got.min <= bandsMin + 0.1 * (bandsMax - bandsMin),
    'sampled=[' + num(got.min) + ',' + num(got.max) + '] bands=[' + num(bandsMin) + ',' + num(bandsMax) + ']');
}

// ═════════════════════════════════════════════════════════════════════════════
// [6] 局部峰值在相邻频段间移动：峰值质心逐帧连续（≤1.5 根）
// ═════════════════════════════════════════════════════════════════════════════
function trackPeak(opts) {
  const frames = opts.frames;
  const from = opts.from;
  const to = opts.to;
  const floor = opts.floor === undefined ? 0.05 : opts.floor;
  const amp = opts.amp === undefined ? 0.95 : opts.amp;
  const memo = C.newShapeState(BAND_COUNT);
  const argmaxes = [];
  const centroids = [];
  const gaps = [];
  const sampleFrames = [];
  for (let f = 0; f < frames; f++) {
    const p = from + (to - from) * f / Math.max(1, frames - 1);
    const k = Math.max(0, Math.min(BAND_COUNT - 2, Math.floor(p)));
    let fr = p - k;
    if (fr < 0) fr = 0;
    if (fr > 1) fr = 1;
    const raw = new Array(BAND_COUNT).fill(floor);
    raw[k] += amp * (1 - fr);
    raw[k + 1] += amp * fr;
    const bands = C.bandShape(memo, raw, BAND_COUNT, CFG, DT_MS, false);
    const seq = samplePchip(bands, memo.slopes, SAMPLE_COUNT, ARG_LAYOUT);
    sampleFrames.push(seq);
    argmaxes.push(argmaxOf(seq));
    centroids.push(centroidOf(seq));
    gaps.push(topGap(seq));
  }
  return { argmaxes: argmaxes, centroids: centroids, gaps: gaps, sampleFrames: sampleFrames };
}

function maxCentroidDelta(centroids) {
  let max = 0;
  let frames = [];
  for (let i = 1; i < centroids.length; i++) {
    const d = Math.abs(centroids[i] - centroids[i - 1]);
    if (d > max) { max = d; frames = ['帧' + i + ': ' + centroids[i - 1].toFixed(2) + '→' + centroids[i].toFixed(2)]; }
  }
  return { max: max, worst: frames.join(' ') };
}

function testMovingPeak() {
  section('[6] 局部峰值在相邻频段间移动（峰值质心连续性，42 点采样，layout=down）');
  const designs = [
    { label: '3→8 连续横移 / 60 帧', frames: 60, from: 3, to: 8, minTravel: 5 },
    { label: '相邻频段 5→6 / 120 帧', frames: 120, from: 5, to: 6, minTravel: 0.8 }
  ];
  for (const design of designs) {
    const track = trackPeak(design);
    assertUnit('[6] ' + design.label + '：每帧 42 点采样有限且在 [0,1]', track.sampleFrames);
    const delta = maxCentroidDelta(track.centroids);
    ok('[6] ' + design.label + '：峰值质心单帧移动 ≤1.5 根', delta.max <= 1.5,
      'maxΔ=' + delta.max.toFixed(3) + ' ' + delta.worst);
    const travel = track.centroids[track.centroids.length - 1] - track.centroids[0];
    ok('[6] ' + design.label + '：质心确实随输入移动（总位移 ≥' + design.minTravel + ' 根）',
      travel >= design.minTravel,
      '首=' + track.centroids[0].toFixed(2) + ' 末=' +
      track.centroids[track.centroids.length - 1].toFixed(2) + ' 位移=' + travel.toFixed(2));

    let argmaxMaxJump = 0;
    for (let i = 1; i < track.argmaxes.length; i++) {
      argmaxMaxJump = Math.max(argmaxMaxJump, Math.abs(track.argmaxes[i] - track.argmaxes[i - 1]));
    }
    let minTopGap = Infinity;
    for (let i = 0; i < track.gaps.length; i++) minTopGap = Math.min(minTopGap, track.gaps[i]);
    console.log('  质心 maxΔ=' + delta.max.toFixed(3) + '（阈值 1.5）；诊断：argmax maxJump=' +
      argmaxMaxJump + '（含平顶近简并 top1-top2 min=' + minTopGap.toExponential(2) + '），不作断言');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// [7] 低频→高频扫描：argmax 随时间单调移动
// ═════════════════════════════════════════════════════════════════════════════
function testSweep() {
  section('[7] 低频 → 高频扫描（峰值 0→11，120 帧）');
  const sweep = trackPeak({ frames: 120, from: 0, to: 11 });
  assertUnit('[7] 每帧 42 点采样有限且在 [0,1]', sweep.sampleFrames);

  const declines = [];
  for (let i = 1; i < sweep.argmaxes.length; i++) {
    if (sweep.argmaxes[i] < sweep.argmaxes[i - 1]) {
      declines.push('帧' + i + ':' + sweep.argmaxes[i - 1] + '→' + sweep.argmaxes[i]);
    }
  }
  ok('[7] argmax 随时间非递减（单调向高频移动）', declines.length === 0,
    declines.length ? declines.slice(0, 5).join(' | ') : '120 帧全部非递减');
  ok('[7] 扫描覆盖两端（首帧 argmax ≤3 且末帧 ≥38）',
    sweep.argmaxes[0] <= 3 && sweep.argmaxes[sweep.argmaxes.length - 1] >= 38,
    '首=' + sweep.argmaxes[0] + ' 末=' + sweep.argmaxes[sweep.argmaxes.length - 1]);
}

// ═════════════════════════════════════════════════════════════════════════════
// [8] 横条数量 × 布局：数量/范围正确；count=1 → layoutPos=0.5
// ═════════════════════════════════════════════════════════════════════════════
function testCountsAndLayouts() {
  section('[8] 横条数量 [1,2,3,5,12,20,42] × 布局 [top,center,down]');
  const raw = new Array(BAND_COUNT).fill(0.05);
  raw[4] = 1.0;
  const res = runStatic(raw, 400);
  const counts = [1, 2, 3, 5, 12, 20, 42];

  for (const count of counts) {
    for (const layout of LAYOUTS) {
      const seq = samplePchip(res.bands, res.slopes, count, layout);
      const positions = [];
      for (let i = 0; i < count; i++) positions.push(C.layoutPos(i, count, layout));
      const positionOk = positions.every(function (p) {
        return Number.isFinite(p) && p >= 0 && p <= 1;
      });
      const valuesOk = seq.length === count && seq.every(function (v) {
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
      });
      ok('[8] count=' + count + ' layout=' + layout + '：数量=' + count + '，采样有限且在 [0,1]',
        valuesOk && positionOk, 'len=' + seq.length + ' positionsOk=' + positionOk);
      if (count === 1) {
        ok('[8] count=1 layout=' + layout + '：layoutPos(0,1)=' + positions[0] + ' = 0.5',
          positions[0] === 0.5, 'layoutPos=' + positions[0]);
        ok('[8] count=1 layout=' + layout + '：采样等于 pchipAt(0.5)',
          seq[0] === C.pchipAt(res.bands, res.slopes, 0.5), 'v=' + seq[0]);
      }
    }
  }

  const n = 12;
  ok('[8] layout=top：pos(0)=1、pos(N-1)=0',
    C.layoutPos(0, n, 'top') === 1 && C.layoutPos(n - 1, n, 'top') === 0,
    C.layoutPos(0, n, 'top') + ',' + C.layoutPos(n - 1, n, 'top'));
  ok('[8] layout=down：pos(0)=0、pos(N-1)=1',
    C.layoutPos(0, n, 'down') === 0 && C.layoutPos(n - 1, n, 'down') === 1,
    C.layoutPos(0, n, 'down') + ',' + C.layoutPos(n - 1, n, 'down'));
  const centerFirst = C.layoutPos(0, n, 'center');
  const centerLast = C.layoutPos(n - 1, n, 'center');
  let centerMax = -Infinity;
  for (let i = 0; i < n; i++) centerMax = Math.max(centerMax, C.layoutPos(i, n, 'center'));
  ok('[8] layout=center：两端 0、中间最大（V 形映射）',
    centerFirst === 0 && centerLast === 0 && centerMax >= 0.9,
    'ends=' + centerFirst + '/' + centerLast + ' max=' + centerMax);
}

// ═════════════════════════════════════════════════════════════════════════════
// [9] 异常输入：NaN / Infinity / -1 / 5 / undefined / 非数字
// ═════════════════════════════════════════════════════════════════════════════
function testAbnormalInputs() {
  section('[9] 异常输入');
  const junk = [NaN, Infinity, -Infinity, -1, 5, undefined, '0.5', null, {}, [], false, true];

  const mixed = [NaN, Infinity, -Infinity, -1, 5, undefined, '0.5', null, {}, [], 0.3, -0.5];
  const mixedRun = runFrames(mixed, 200, false);
  assertUnit('[9a] 混合异常输入 200 帧输出有限且在 [0,1]',
    mixedRun.frames.map(function (item) { return item.bands; }));
  ok('[9a] 混合异常输入下斜率全部有限',
    mixedRun.frames.every(function (item) {
      return item.slopes.every(function (v) { return Number.isFinite(v); });
    }));

  for (const value of junk) {
    const res = runStatic(new Array(BAND_COUNT).fill(value), 60);
    const allOk = res.bands.every(function (v) {
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    }) && res.slopes.every(function (v) { return Number.isFinite(v); });
    ok('[9b] 全频段=' + fmtVal(value) + ' 输入：输出有限且在 [0,1]', allOk,
      'bands=[' + res.bands.map(function (v) { return num(v, 3); }).join(',') + ']');
  }

  const badPayloads = [
    ['rawBands=undefined', undefined],
    ['rawBands=null', null],
    ['rawBands 长度不足(3)', [0.9, 0.9, 0.9]]
  ];
  for (const item of badPayloads) {
    const res = runStatic(item[1], 60);
    ok('[9c] ' + item[0] + '：输出有限且在 [0,1]',
      res.bands.every(function (v) { return Number.isFinite(v) && v >= 0 && v <= 1; }) &&
      res.slopes.every(function (v) { return Number.isFinite(v); }),
      'bands=[' + res.bands.map(function (v) { return num(v, 3); }).join(',') + ']');
  }

  const res = runStatic(new Array(BAND_COUNT).fill(0.7), 400);
  for (const pos of [NaN, Infinity, -Infinity, -1, 5, undefined, '0.5', null, {}, false]) {
    const v = C.pchipAt(res.bands, res.slopes, pos);
    ok('[9d] pchipAt(pos=' + fmtVal(pos) + ') 输出有限且在 [0,1]',
      Number.isFinite(v) && v >= 0 && v <= 1, 'v=' + v);
  }

  const cleaned = Array.from(C.sanitizeBands(
    [NaN, Infinity, -1, 5, undefined, '0.5', null, {}, 0.3, 1], 10));
  const expectedClean = [0, 0, 0, 1, 0, 0, 0, 0, 0.3, 1];
  ok('[9e] sanitizeBands 清洗 NaN/Infinity/-1/5/undefined/字符串/对象',
    cleaned.length === 10 && cleaned.every(function (v, i) { return Math.abs(v - expectedClean[i]) <= EPS; }),
    cleaned.join(','));
  for (const x of [NaN, Infinity, -1, 5, '0.5', undefined, null]) {
    const y = C.compressLog(x, 3);
    ok('[9e] compressLog(' + fmtVal(x) + ') 有限且在 [0,1]',
      Number.isFinite(y) && y >= 0 && y <= 1, 'y=' + y);
  }
  ok('[9e] compressLog 边界：f(0)=0、f(1)=1',
    C.compressLog(0, 3) === 0 && Math.abs(C.compressLog(1, 3) - 1) <= EPS);
  ok('[9e] smoothStep 边界/异常值有限',
    C.smoothStep(0.04, 0.16, 0.04) === 0 && C.smoothStep(0.04, 0.16, 0.16) === 1 &&
    [NaN, Infinity, -1, 5, undefined, null].every(function (x) {
      const y = C.smoothStep(0.04, 0.16, x);
      return Number.isFinite(y) && y >= 0 && y <= 1;
    }));
}

// ═════════════════════════════════════════════════════════════════════════════
// [10] 静音 → 有声 → 静音：上升若干帧内完成、回落收敛到 0、无 NaN
// ═════════════════════════════════════════════════════════════════════════════
function testOnsetRelease() {
  section('[10] 静音 → 有声 → 静音');
  const memo = C.newShapeState(BAND_COUNT);

  let preSilenceNonZero = 0;
  for (let f = 0; f < 20; f++) {
    const bands = C.bandShape(memo, zeroBands(), BAND_COUNT, CFG, DT_MS, true);
    for (let i = 0; i < BAND_COUNT; i++) if (bands[i] !== 0) preSilenceNonZero++;
  }
  ok('[10] 预静音 20 帧输出恒为 0', preSilenceNonZero === 0, '非零值 ' + preSilenceNonZero);

  const tone = new Array(BAND_COUNT).fill(0.8);
  const riseMeans = [];
  const riseFrames = [];
  for (let f = 0; f < 30; f++) {
    const bands = Array.from(C.bandShape(memo, tone, BAND_COUNT, CFG, DT_MS, false));
    riseFrames.push(bands);
    riseMeans.push(bands.reduce(function (a, b) { return a + b; }, 0) / BAND_COUNT);
  }
  assertUnit('[10] 上升段 30 帧输出有限且在 [0,1]', riseFrames);
  const riseIndex = riseMeans.findIndex(function (v) { return v >= 0.85; });
  ok('[10] 上升在 ≤10 帧内完成（均值达到 0.85）', riseIndex >= 0 && riseIndex <= 10,
    '首次达到 0.85 的帧=' + riseIndex + '，帧均值=' +
    riseMeans.slice(0, 12).map(function (v) { return v.toFixed(3); }).join(','));
  ok('[10] 上升后保持稳定（第 10 帧 ≥ 稳态第 30 帧的 95%）',
    riseMeans[9] >= 0.95 * riseMeans[29], 'm10=' + num(riseMeans[9]) + ' m30=' + num(riseMeans[29]));

  const releaseMax = [];
  const releaseFrames = [];
  const releaseSlopes = [];
  for (let f = 0; f < 60; f++) {
    const bands = Array.from(C.bandShape(memo, zeroBands(), BAND_COUNT, CFG, DT_MS, true));
    releaseFrames.push(bands);
    releaseSlopes.push(Array.from(memo.slopes));
    releaseMax.push(Math.max.apply(null, bands));
  }
  assertUnit('[10] 回落段 60 帧输出有限且在 [0,1]', releaseFrames);
  const releaseIndex = releaseMax.findIndex(function (v) { return v < 1e-3; });
  ok('[10] 回落在 ≤40 帧内收敛到 <1e-3', releaseIndex >= 0 && releaseIndex <= 40,
    '首次 <1e-3 的帧=' + releaseIndex + '，实际=' +
    (releaseIndex >= 0 ? releaseMax[releaseIndex] : 'N/A'));
  ok('[10] 回落单调不升（每帧 ≤ 前一帧）',
    releaseMax.every(function (v, i) { return i === 0 || v <= releaseMax[i - 1] + EPS; }),
    '末帧=' + releaseMax[releaseMax.length - 1]);
  ok('[10] 末帧收敛到 0（<1e-3）', releaseMax[releaseMax.length - 1] < 1e-3,
    '末帧=' + releaseMax[releaseMax.length - 1]);
  const finalSample = samplePchip(releaseFrames[releaseFrames.length - 1],
    releaseSlopes[releaseSlopes.length - 1], SAMPLE_COUNT, ARG_LAYOUT);
  assertUnit('[10] 回落末帧采样有限且在 [0,1]', [finalSample]);
}

// ═════════════════════════════════════════════════════════════════════════════
// [11] PCHIP 曲线质量：无过冲（百万级模糊测试）/ 节点复现 / 节点折角
// ═════════════════════════════════════════════════════════════════════════════
function testInterpolationQuality() {
  section('[11] PCHIP 曲线质量（无过冲 fuzz / 节点复现 / 节点折角）');

  // ── 11a 无过冲：百万级采样点，每个采样值必须落在所属区间两端点之间 ──
  const scenarios = {
    zero: zeroBands(),
    uniform: new Array(BAND_COUNT).fill(0.55),
    rampUp: Array.from({ length: BAND_COUNT }, function (_, i) { return 0.05 + 0.9 * i / (BAND_COUNT - 1); }),
    rampDown: Array.from({ length: BAND_COUNT }, function (_, i) { return 0.95 - 0.9 * i / (BAND_COUNT - 1); }),
    spike: (function () { const a = new Array(BAND_COUNT).fill(0.05); a[4] = 1.0; return a; })(),
    alternating: Array.from({ length: BAND_COUNT }, function (_, i) { return i % 2 === 0 ? 0.95 : 0.05; })
  };
  const rand = lcg(0x9e3779b9);
  let fuzzSamples = 0;
  let fuzzBad = 0;
  let fuzzFirstBad = null;
  let fuzzPositionsPerScenario = 100000;

  function checkSample(bands, slopes, pos) {
    const last = bands.length - 1;
    const x = pos * last;
    let k = Math.floor(x);
    if (k >= last) k = last - 1;
    if (k < 0) k = 0;
    let t = x - k;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const v = C.pchipAt(bands, slopes, pos);
    const lo = Math.min(bands[k], bands[k + 1]);
    const hi = Math.max(bands[k], bands[k + 1]);
    fuzzSamples++;
    if (!Number.isFinite(v) || v < lo - EPS || v > hi + EPS) {
      fuzzBad++;
      if (!fuzzFirstBad) {
        fuzzFirstBad = { pos: pos, k: k, t: t, v: v, lo: lo, hi: hi };
      }
    }
  }

  for (const key in scenarios) {
    if (!Object.prototype.hasOwnProperty.call(scenarios, key)) continue;
    const res = runStatic(scenarios[key], 400);
    for (let i = 0; i < fuzzPositionsPerScenario; i++) {
      checkSample(res.bands, res.slopes, rand());
    }
  }
  // 随机频段（任意 12 个 [0,1] 值）+ 随机位置：400 组 × 1000 点
  for (let g = 0; g < 400; g++) {
    const ys = new Array(BAND_COUNT);
    for (let i = 0; i < BAND_COUNT; i++) ys[i] = rand();
    const slopes = C.zeros(BAND_COUNT);
    C.pchipSlopesInto(ys, slopes);
    for (let i = 0; i < 1000; i++) checkSample(ys, slopes, rand());
  }
  ok('[11a] 百万级随机采样点无过冲（每点 ∈ 所属区间两端点范围）',
    fuzzSamples >= 1000000 && fuzzBad === 0,
    '采样=' + fuzzSamples + '，越界=' + fuzzBad +
    (fuzzFirstBad ? '，首例=' + JSON.stringify(fuzzFirstBad) : ''));
  ok('[11a] 模糊测试规模达到百万级', fuzzSamples >= 1000000, '采样=' + fuzzSamples);
  console.log('  模糊测试: 采样点=' + fuzzSamples + '，越界=' + fuzzBad);

  // ── 11b 节点处精确复现 band[k] ──
  const nodeCases = [
    ['spike', scenarios.spike],
    ['alternating', scenarios.alternating],
    ['rampUp', scenarios.rampUp]
  ];
  for (const item of nodeCases) {
    const res = runStatic(item[1], 400);
    let maxErr = 0;
    for (let k = 0; k < BAND_COUNT; k++) {
      const pos = k / (BAND_COUNT - 1);
      const v = C.pchipAt(res.bands, res.slopes, pos);
      const err = Math.abs(v - res.bands[k]);
      if (err > maxErr) maxErr = err;
    }
    ok('[11b] ' + item[0] + '：12 个频段节点处精确复现（误差 <1e-9）', maxErr < 1e-9,
      'maxErr=' + maxErr.toExponential(2));
  }
  // 随机频段节点复现
  {
    const ys = [0.11, 0.93, 0.27, 0.5, 0.05, 0.77, 0.32, 0.6, 0.19, 0.84, 0.41, 0.66];
    const slopes = C.zeros(BAND_COUNT);
    C.pchipSlopesInto(ys, slopes);
    let maxErr = 0;
    for (let k = 0; k < BAND_COUNT; k++) {
      const v = C.pchipAt(ys, slopes, k / (BAND_COUNT - 1));
      const err = Math.abs(v - ys[k]);
      if (err > maxErr) maxErr = err;
    }
    ok('[11b] 随机频段：12 个节点处精确复现（误差 <1e-9）', maxErr < 1e-9, 'maxErr=' + maxErr.toExponential(2));
  }

  // ── 11c 节点折角对比：PCHIP ≤ 线性插值的一半 ──
  const h = 1e-4;
  function kinkOf(bands, slopes) {
    const last = bands.length - 1;
    const d = [];
    for (let i = 0; i < last; i++) d.push(bands[i + 1] - bands[i]);
    let sumP = 0;
    let maxP = 0;
    let sumL = 0;
    let maxL = 0;
    for (let k = 1; k < last; k++) {
      const pos = k / last;
      const denom = h * last;
      const yL = C.pchipAt(bands, slopes, pos - h);
      const y0 = C.pchipAt(bands, slopes, pos);
      const yR = C.pchipAt(bands, slopes, pos + h);
      const sL = (y0 - yL) / denom;
      const sR = (yR - y0) / denom;
      const kinkP = Math.abs(sR - sL);
      const kinkL = Math.abs(d[k] - d[k - 1]);
      sumP += kinkP;
      if (kinkP > maxP) maxP = kinkP;
      sumL += kinkL;
      if (kinkL > maxL) maxL = kinkL;
    }
    return { sumP: sumP, maxP: maxP, sumL: sumL, maxL: maxL };
  }
  const kinkCases = [
    ['alternating', scenarios.alternating],
    ['spike', scenarios.spike]
  ];
  for (const item of kinkCases) {
    const res = runStatic(item[1], 400);
    const kink = kinkOf(res.bands, res.slopes);
    kinkRows.push({
      scenario: item[0],
      pchipSum: kink.sumP,
      linearSum: kink.sumL,
      pchipMax: kink.maxP,
      linearMax: kink.maxL
    });
    ok('[11c] ' + item[0] + '：PCHIP 折角总量 ≤ 线性插值的一半',
      kink.sumP <= 0.5 * kink.sumL,
      'PCHIP=' + kink.sumP.toExponential(3) + ' linear=' + kink.sumL.toFixed(4) +
      ' ratio=' + (kink.sumP / kink.sumL).toExponential(2));
    ok('[11c] ' + item[0] + '：PCHIP 最大节点折角 ≤ 线性插值的一半',
      kink.maxP <= 0.5 * kink.maxL,
      'PCHIP max=' + kink.maxP.toExponential(3) + ' linear max=' + kink.maxL.toFixed(4));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// [12] 空间平滑环节：Σ|Δ| / max|Δ| 下降 ≥20%，对比度不塌
// ═════════════════════════════════════════════════════════════════════════════
function pointwiseShapedBands(rawBands, frames) {
  const saved = C.CURVE.smoothMix;
  C.CURVE.smoothMix = 0; // 临时关闭空间平滑，取点式整形输出（随后恢复）
  try {
    const memo = C.newShapeState(BAND_COUNT);
    let out = null;
    for (let f = 0; f < frames; f++) out = C.bandShape(memo, rawBands, BAND_COUNT, CFG, DT_MS, false);
    return { bands: Array.from(out), slopes: Array.from(memo.slopes) };
  } finally {
    C.CURVE.smoothMix = saved;
  }
}

function deltaStats(ys) {
  let sum = 0;
  let max = 0;
  for (let i = 1; i < ys.length; i++) {
    const d = Math.abs(ys[i] - ys[i - 1]);
    sum += d;
    if (d > max) max = d;
  }
  return { sum: sum, max: max };
}

function testSpatialSmoothing() {
  section('[12] 空间平滑环节（mix=0.3，比较同一份点式整形频段平滑前后，阈值按输入类别）');
  const savedSmoothMix = C.CURVE.smoothMix;
  const scenarios = {
    alternating: Array.from({ length: BAND_COUNT }, function (_, i) { return i % 2 === 0 ? 0.95 : 0.05; }),
    spike: (function () { const a = new Array(BAND_COUNT).fill(0.05); a[4] = 1.0; return a; })()
  };
  for (const key in scenarios) {
    if (!Object.prototype.hasOwnProperty.call(scenarios, key)) continue;
    const pointwise = pointwiseShapedBands(scenarios[key], 400);
    assertUnit('[12] ' + key + '：点式整形输出有限且在 [0,1]', [pointwise.bands]);
    const smoothed = C.zeros(BAND_COUNT);
    C.spatialSmoothInto(pointwise.bands, 0.3, smoothed);
    assertUnit('[12] ' + key + '：平滑后频段有限且在 [0,1]', [smoothed]);

    const before = deltaStats(pointwise.bands);
    const after = deltaStats(smoothed);
    const contrastBefore = Math.max.apply(null, pointwise.bands) - Math.min.apply(null, pointwise.bands);
    const contrastAfter = Math.max.apply(null, smoothed) - Math.min.apply(null, smoothed);
    const sumDrop = 100 * (1 - after.sum / before.sum);
    const maxDrop = 100 * (1 - after.max / before.max);
    smoothRows.push({
      scenario: key,
      sumBefore: before.sum,
      sumAfter: after.sum,
      sumDrop: sumDrop,
      maxBefore: before.max,
      maxAfter: after.max,
      maxDrop: maxDrop,
      contrastBefore: contrastBefore,
      contrastAfter: contrastAfter
    });

    // 判据按输入类别区分，理由见文件头 [12] 说明：
    //   交替输入是周期性大跳变，3 点平滑把内部 |Δ| 压到 0.7 倍（理论 30%），端点效应后实测 28.6%，
    //   故 Σ 要求 ≥25%；单尖峰的总变差集中在两处大跳变，平滑削掉的比例恒为 mix/2 = 15%，
    //   再高就只能靠抹平频谱换取，故 Σ 只要求 ≥10%。
    //   两类 max|Δ| 的理论降幅都是 1-0.775 = 22.5%，统一要求 ≥20%。
    //   对比度 max-min 降幅上限 20%：实测两类均为 15%（0.8191→0.6962 / 0.8437→0.7171），
    //   既保留层次，又能挡住"把频谱抹平"的退化实现。
    const contrastDrop = 100 * (1 - contrastAfter / contrastBefore);
    const sumThreshold = key === 'alternating' ? 25 : 10;
    const maxThreshold = 20;
    ok('[12] ' + key + '：Σ|Δ| 下降 ≥' + sumThreshold + '%', sumDrop >= sumThreshold,
      'before=' + before.sum.toFixed(4) + ' after=' + after.sum.toFixed(4) + ' drop=' + pct(sumDrop));
    ok('[12] ' + key + '：max|Δ| 下降 ≥' + maxThreshold + '%', maxDrop >= maxThreshold,
      'before=' + before.max.toFixed(4) + ' after=' + after.max.toFixed(4) + ' drop=' + pct(maxDrop));
    ok('[12] ' + key + '：平滑后对比度 max-min ≥0.25（不抹平频谱）', contrastAfter >= 0.25,
      'contrast=' + contrastAfter.toFixed(4) + '（before=' + contrastBefore.toFixed(4) + '）');
    ok('[12] ' + key + '：对比度 max-min 降幅 ≤20%（保留层次）', contrastDrop <= 20,
      'before=' + contrastBefore.toFixed(4) + ' after=' + contrastAfter.toFixed(4) +
      ' drop=' + pct(contrastDrop));
  }
  ok('[12] 生产参数 CURVE.smoothMix 已恢复为 0.3', C.CURVE.smoothMix === savedSmoothMix && savedSmoothMix === 0.3,
    'smoothMix=' + C.CURVE.smoothMix);

  // mix=0 时 spatialSmoothInto 应为恒等映射
  const identitySrc = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.5, 0.5, 0.55, 0.45];
  const identityOut = C.zeros(BAND_COUNT);
  C.spatialSmoothInto(identitySrc, 0, identityOut);
  ok('[12] spatialSmoothInto(mix=0) 为恒等映射',
    identityOut.every(function (v, i) { return Math.abs(v - identitySrc[i]) <= EPS; }),
    identityOut.join(','));
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const started = Date.now();
  console.log('CURVE-1 生产实现验证：lib/client.js exports.__curve（12 频段 / dt=33ms / 42 采样点）');

  testExports();
  testSilence();
  testUniform();
  testMonotone();
  testSpike();
  testAlternating();
  testMovingPeak();
  testSweep();
  testCountsAndLayouts();
  testAbnormalInputs();
  testOnsetRelease();
  testInterpolationQuality();
  testSpatialSmoothing();

  printQualityTables();

  const passed = checkCount - failures.length;
  console.log('\n== 汇总 ==');
  console.log('断言: ' + checkCount + '  通过: ' + passed + '  失败: ' + failures.length);
  console.log('输出值覆盖: ' + globalStats.values + ' 个，范围 [' +
    num(globalStats.min, 6) + ', ' + num(globalStats.max, 6) + ']');
  console.log('耗时: ' + (Date.now() - started) + 'ms');

  if (failures.length === 0) {
    console.log('\nALL PASS');
    process.exitCode = 0;
    return;
  }

  console.log('\n失败断言：');
  for (const item of failures) {
    console.log(' - ' + item.name + (item.detail ? ' :: ' + item.detail : ''));
  }
  console.log('\nRESULT: FAIL (' + failures.length + ' failed / ' + checkCount + ' checks)');
  process.exitCode = 1;
}

main();
