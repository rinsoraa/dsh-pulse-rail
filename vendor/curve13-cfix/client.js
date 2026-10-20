/* dsh-pulse-rail — 浏览器半侧（手写 lazy-CJS bundle，禁止 ESM 语法）。
 *
 * 做什么：让会话右缘「轮次导航条」（TurnNavigator）的横条随系统输出音频律动。
 * 只改横条自身的**几何长度**（::before 的 width），不加任何发光/阴影/描边/颜色特效；
 * 横条数量会随会话轮次增长（最多 42 根），映射与平滑全部按「当前实际根数」现算，故数量变化
 * 不会让律动失效；没有音频（或插件关闭）时把自定义属性摘掉，导航条恢复原样。
 *
 * 数据来源：同源 GET /pulse-rail/state（宿主半侧 + pulse-tap.exe 的 WASAPI loopback 频谱）。
 * 可见时 30Hz 轮询、不可见时降到 1Hz；导航条不存在时降到慢速轮询。
 */
(function (global) {
  'use strict';
  if (!global || !global.__ModuleLoader__ || typeof global.__ModuleLoader__.load !== 'function') return;

  var ID = 'dsh-pulse-rail';
  var BASE = '/pulse-rail';
  var TAG = '[' + ID + ']';
  var STYLE_ID = 'dsh-pulse-rail-style';
  var CSS = ''
    // 长度与厚度都只改 ::before 的 transform（纯合成，不触发 layout），右缘钉死在 transform-origin:100%，
    // 因此不会再出现「右侧没对齐 / 轻微像素抖动」；宽度保持应用原本的 20px 不变。
    + '[data-dpr-bar]::before{transform:translateY(-50%) scale(var(--dpr-w,.6),var(--dpr-h,1))!important;transform-origin:100% 50%!important;transition:background-color .14s!important;}'
    // 横条命中区域保持原来的 28px 宽，不抢对话区的鼠标事件
    + '[data-dpr-bar]{left:auto!important;right:0!important;width:28px!important;}'
    // 应用的 .scroller 是 overflow-y:auto —— 横向同样被裁剪在 28px 内，所以之前把长度上限调大没用。
    // 这里把滚动容器向左加宽（右缘不动），长横条就能画出来；容器本身 pointer-events:none，事件照旧穿透给对话区。
    + '[data-dpr-rail="scroller"]{width:var(--dpr-clip-w,220px)!important;margin-left:calc(28px - var(--dpr-clip-w,220px))!important;pointer-events:none!important;}'
    // 关键：pointer-events:none 会被后代继承，所以必须把「横条容器」恢复成可交互，
    // 同时把它保持 28px 宽并靠右 —— 这样加宽出来的那一条透明区不抢事件（悬停/点击/滚轮都照旧）。
    + '[data-dpr-rail="marks"]{width:28px!important;margin-left:auto!important;pointer-events:auto!important;}'
    // ── 设置面板样式：全部走 DSH 自己的主题变量（--dsw-alias-*），浅色/深色自动适配 ──
    + '#dsh-pulse-rail-settings{position:fixed;left:12px;z-index:2147483000;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dpr-fg,#f9fafb)}'
    + '#dsh-pulse-rail-settings[data-dpr-hidden="1"]{display:none!important}'
    + '#dsh-pulse-rail-settings [data-dpr-panel]{position:absolute;left:0;bottom:42px;width:296px;max-height:72vh;overflow:auto;background:var(--dpr-panel,#232326);border:1px solid var(--dpr-border,#ffffff33);border-radius:10px;box-shadow:0 12px 32px #0006;padding:10px 12px 8px}'
    + '#dsh-pulse-rail-settings [data-dpr-head]{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:8px}'
    + '#dsh-pulse-rail-settings [data-dpr-head] em{font-style:normal;font-weight:400;color:var(--dpr-muted,#adb2b8);font-size:11px}'
    + '#dsh-pulse-rail-settings .dpr-row{display:grid;grid-template-columns:74px 1fr 58px;gap:6px;align-items:center;margin:5px 0}'
    + '#dsh-pulse-rail-settings .dpr-row>span{color:var(--dpr-muted,#adb2b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#dsh-pulse-rail-settings input[type=range]{-webkit-appearance:none;appearance:none;height:16px;background:transparent;margin:0}'
    + '#dsh-pulse-rail-settings input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--dpr-border,#ffffff26)}'
    + '#dsh-pulse-rail-settings input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:50%;background:var(--dpr-fg,#f9fafb);border:0}'
    + '#dsh-pulse-rail-settings input[type=number]{width:58px;background:transparent;color:var(--dpr-fg,#f9fafb);border:1px solid var(--dpr-border,#ffffff33);border-radius:6px;padding:2px 4px;font:inherit}'
    + '#dsh-pulse-rail-settings .dpr-seg{display:flex;align-items:center;gap:4px;margin:8px 0 2px}'
    + '#dsh-pulse-rail-settings .dpr-seg>span{color:var(--dpr-muted,#adb2b8);margin-right:4px;flex:0 0 74px}'
    + '#dsh-pulse-rail-settings .dpr-seg button,#dsh-pulse-rail-settings [data-dpr-foot] button{background:transparent;border:1px solid var(--dpr-border,#ffffff33);color:var(--dpr-muted,#adb2b8);border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;white-space:nowrap}'
    + '#dsh-pulse-rail-settings .dpr-seg button[aria-pressed=true]{background:var(--dpr-accent,#4c7dff);border-color:transparent;color:#fff}'
    + '#dsh-pulse-rail-settings [data-dpr-foot] button[aria-pressed=true]{color:var(--dpr-fg,#f9fafb);border-color:var(--dpr-fg,#f9fafb)}'
    + '#dsh-pulse-rail-settings [data-dpr-btn]{display:flex;align-items:center;justify-content:center;width:36px;height:30px;border-radius:8px;border:1px solid var(--dpr-border,#ffffff33);background:var(--dpr-panel,#ffffff0f);color:var(--dpr-fg,#f9fafb);cursor:pointer;font-size:14px}'
    + '#dsh-pulse-rail-settings [data-dpr-btn]:hover,#dsh-pulse-rail-settings [data-dpr-foot] button:hover{opacity:.8}'
    + '#dsh-pulse-rail-settings [data-dpr-foot]{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dpr-border,#ffffff22)}'
    + '#dsh-pulse-rail-settings [data-dpr-msg]{color:var(--dpr-muted,#adb2b8);font-size:11px}';
  var DEFAULTS = {
    enabled: true, minW: 0.18, maxW: 2.6, gamma: 0.6, gate: 0.02,
    agcMix: 0.6,                            // 自适应对比：每个频段跟自己的慢基线比，0=纯绝对电平，1=纯动态
    minH: 2, maxH: 7,                       // 横条厚度（px）：静音 2px，最响 7px（间距 10px，不会粘连）
    atkMs: 35, relMs: 120, silentMs: 450, freqLayout: 'center', bands: 12,
  };

  function assign(target, source) {
    if (!source) return target;
    for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    return target;
  }
  function zeros(n) { var out = []; for (var i = 0; i < n; i++) out.push(0); return out; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  // ── CURVE-1：频谱曲线整形（纯函数；导出给 tools/curve-test.mjs，测试打的就是生产这份实现）──
  // 顺序：清洗 → 绝对电平/连续动态对比 → 轻压缩 → 三点空间平滑 → 时间包络 → 保形(PCHIP)插值
  var CURVE = {
    compK: 3,          // log1p 压缩强度
    compMix: 0.45,     // 压缩结果占比（保守，避免与 gamma 叠加过平）
    smoothMix: 0.3,    // 三点空间平滑占比（0.2~0.35 之间）
    agcLo: 0.04,       // 动态对比权重下界
    agcHi: 0.16,       // 上界（区间内平滑过渡，替换原来的 dyn>0.10 硬切换）
    agcDen: 0.06,      // 分母下限，防弱信号被放大
    slowMs: 900,       // 慢基线时间常数
    peakMs: 4000       // 近期峰值时间常数
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function sanitizeBands(raw, n, out) {
    out = out || [];
    for (var i = 0; i < n; i++) out[i] = clamp(isNum(raw && raw[i]) ? raw[i] : 0, 0, 1);
    return out;
  }

  function compressLog(x, k) {                 // y = log1p(k*x)/log1p(k)，x∈[0,1]
    var v = clamp(isNum(x) ? x : 0, 0, 1);
    if (!(k > 0)) return v;
    var d = Math.log1p(k);
    if (!(d > 0)) return v;
    return clamp(Math.log1p(k * v) / d, 0, 1);
  }

  function smoothStep(lo, hi, x) {
    if (!(hi > lo)) return (isNum(x) ? x : 0) >= hi ? 1 : 0;
    var t = clamp(((isNum(x) ? x : 0) - lo) / (hi - lo), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function spatialSmoothInto(src, mix, out) {   // 三点 [0.25,0.5,0.25]，端点复用自身
    var n = src.length;
    mix = clamp(isNum(mix) ? mix : 0, 0, 1);
    for (var i = 0; i < n; i++) {
      var c = src[i];
      var l = src[i > 0 ? i - 1 : 0];
      var r = src[i < n - 1 ? i + 1 : n - 1];
      var sm = 0.25 * l + 0.5 * c + 0.25 * r;
      out[i] = clamp((1 - mix) * c + mix * sm, 0, 1);
    }
    return out;
  }

  // Fritsch–Carlson 保形斜率：内部点同号取加权调和平均，局部极值取 0，端点取单侧差分。
  // 性质：每个区间上单调 ⇒ 段内不越出两端点范围 ⇒ 不产生额外波峰/下陷。
  function pchipSlopesInto(ys, out) {
    var n = ys.length;
    if (n <= 0) return out;
    if (n === 1) { out[0] = 0; return out; }
    var d = new Array(n - 1);
    var i;
    for (i = 0; i < n - 1; i++) d[i] = ys[i + 1] - ys[i];
    out[0] = d[0];
    out[n - 1] = d[n - 2];
    for (i = 1; i < n - 1; i++) {
      var a = d[i - 1], b = d[i];
      out[i] = a * b <= 0 ? 0 : (2 * a * b) / (a + b);
    }
    return out;
  }

  function pchipAt(ys, slopes, pos) {
    var n = ys.length;
    if (n <= 0) return 0;
    if (n === 1) return clamp(isNum(ys[0]) ? ys[0] : 0, 0, 1);
    var x = clamp(isNum(pos) ? pos : 0, 0, 1) * (n - 1);
    var k = Math.floor(x);
    if (k >= n - 1) k = n - 2;
    if (k < 0) k = 0;
    var t = clamp(x - k, 0, 1);
    var y0 = ys[k], y1 = ys[k + 1], m0 = slopes[k], m1 = slopes[k + 1];
    var t2 = t * t, t3 = t2 * t;
    var y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 +
            (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
    var lo = y0 < y1 ? y0 : y1, hi = y0 < y1 ? y1 : y0;
    if (!isFinite(y)) return lo;
    return clamp(y, lo, hi);                    // 兜底：数值异常也不越界
  }

  // ── CURVE-1.3：线性插值 + 最终横条级自适应三点平滑（仅长度通道）─────────────────
  var CURVE13 = { enabled: true, mHigh: 0.35, mMid: 0.30, mLow: 0.25 };

  function lerpAt(ys, pos) {                    // 相邻节点间线性比例；边界/非有限值安全
    var n = ys.length;
    if (n <= 0) return 0;
    if (n === 1) return clamp(isNum(ys[0]) ? ys[0] : 0, 0, 1);
    var x = clamp(isNum(pos) ? pos : 0, 0, 1) * (n - 1);
    var k = Math.floor(x);
    if (k >= n - 1) k = n - 2;
    if (k < 0) k = 0;
    var t = clamp(x - k, 0, 1);
    var y0 = clamp(isNum(ys[k]) ? ys[k] : 0, 0, 1);
    var y1 = clamp(isNum(ys[k + 1]) ? ys[k + 1] : 0, 0, 1);
    return clamp(y0 + (y1 - y0) * t, 0, 1);
  }

  function barMixOf(n) {                        // 横条数 → 平滑系数；n<=2 恒等
    if (!(n >= 3)) return 0;
    if (n >= 30) return CURVE13.mHigh;
    if (n >= 18) return CURVE13.mMid;
    return CURVE13.mLow;
  }

  function smoothBarsInto(T, out) {             // 纯函数：不修改入参；端点复用自身
    var n = T && T.length ? T.length : 0;
    var m = barMixOf(n);
    for (var i = 0; i < n; i++) {
      var c = clamp(isNum(T[i]) ? T[i] : 0, 0, 1);
      if (m <= 0) { out[i] = c; continue; }
      var lv = clamp(isNum(T[i > 0 ? i - 1 : 0]) ? T[i > 0 ? i - 1 : 0] : 0, 0, 1);
      var rv = clamp(isNum(T[i < n - 1 ? i + 1 : n - 1]) ? T[i < n - 1 ? i + 1 : n - 1] : 0, 0, 1);
      out[i] = clamp((1 - m) * c + m * (0.25 * lv + 0.5 * c + 0.25 * rv), 0, 1);
    }
    return out;
  }

  function layoutPos(index, count, layout) {    // 横条序号 → 频率位置 0..1
    if (!(count > 1)) return 0.5;
    var t = clamp(index / (count - 1), 0, 1);
    if (layout === 'center') return clamp(1 - Math.abs(2 * t - 1), 0, 1);
    if (layout === 'top') return clamp(1 - t, 0, 1);
    return t;
  }

  function newShapeState(n) {
    return { slow: zeros(n), peak: zeros(n), smooth: zeros(n), tmpA: zeros(n), tmpB: zeros(n), slopes: zeros(n) };
  }

  // 每帧一次的频段整形，返回 memo.smooth（恒为有限值且位于 [0,1]）
  function bandShape(memo, rawBands, n, cfg, dt, idle) {
    if (memo.slow.length !== n) {
      memo.slow = zeros(n); memo.peak = zeros(n); memo.smooth = zeros(n);
      memo.tmpA = zeros(n); memo.tmpB = zeros(n); memo.slopes = zeros(n);
    }
    var gate = clamp(isNum(cfg.gate) ? cfg.gate : 0, 0, 0.95);
    var gamma = isNum(cfg.gamma) && cfg.gamma > 0 ? cfg.gamma : 1;
    var agcMix = clamp(isNum(cfg.agcMix) ? cfg.agcMix : 0.6, 0, 1);
    var atk = isNum(cfg.atkMs) && cfg.atkMs > 0 ? cfg.atkMs : 60;
    var rel = isNum(cfg.relMs) && cfg.relMs > 0 ? cfg.relMs : 120;
    var kSlow = 1 - Math.exp(-dt / CURVE.slowMs);
    var kPeak = 1 - Math.exp(-dt / CURVE.peakMs);
    var i;
    var raw = memo.tmpA;
    for (i = 0; i < n; i++) raw[i] = idle ? 0 : clamp(isNum(rawBands && rawBands[i]) ? rawBands[i] : 0, 0, 1);
    var shaped = memo.tmpB;
    for (i = 0; i < n; i++) {
      var r = raw[i];
      memo.slow[i] += (r - memo.slow[i]) * kSlow;
      memo.peak[i] = r > memo.peak[i] ? r : memo.peak[i] + (r - memo.peak[i]) * kPeak;
      var absLv = clamp((r - gate) / (1 - gate), 0, 1);
      var dyn = memo.peak[i] - memo.slow[i];
      var w = smoothStep(CURVE.agcLo, CURVE.agcHi, dyn);        // 连续权重，替代硬阈值
      var agc = clamp((r - memo.slow[i]) / Math.max(dyn, CURVE.agcDen), 0, 1);
      var mixed = (1 - agcMix) * absLv + agcMix * (w * agc + (1 - w) * absLv);
      var comp = compressLog(mixed, CURVE.compK);               // 保守压缩；静音仍为 0
      var x = clamp((1 - CURVE.compMix) * mixed + CURVE.compMix * comp, 0, 1);
      shaped[i] = idle ? 0 : Math.pow(x, gamma);
    }
    spatialSmoothInto(shaped, CURVE.smoothMix, raw);            // raw 缓冲已用完，复用
    for (i = 0; i < n; i++) {
      var target = raw[i];
      var tau = target > memo.smooth[i] ? atk : rel;
      memo.smooth[i] += (target - memo.smooth[i]) * (1 - Math.exp(-dt / (tau > 0 ? tau : 60)));
    }
    pchipSlopesInto(memo.smooth, memo.slopes);
    return memo.smooth;
  }

  function rectOf(el) {
    try { var r = el.getBoundingClientRect(); return { right: r.right, top: r.top, width: r.width, height: r.height }; }
    catch (e) { return { right: 0, top: 0, width: 0, height: 0 }; }
  }
  function classOf(el) {
    try {
      var c = el.className;
      if (typeof c === 'string') return c;
      if (c && typeof c.baseVal === 'string') return c.baseVal;
    } catch (e) { /* ignore */ }
    return '';
  }

  function createInstance() {
    var cfg = assign({}, DEFAULTS);
    var shapeMemo = newShapeState(cfg.bands);
    var smooth = shapeMemo.smooth;   // 整形后的频段（bandShape 的输出）
    var curveSlopes = shapeMemo.slopes;
    var barBuf = [];             // CURVE-1.3：横条目标长度（线性插值后、平滑前）
    var barSm = [];              // CURVE-1.3：平滑后的横条目标长度
    var liveBands = null;
    var bars = [];
    var container = null;
    var styleEl = null;
    var pollTimer = 0;
    var rafId = 0;
    var observer = null;
    var disposed = false;
    var inFlight = false;
    var lastTick = 0;
    var lastOkAt = 0;
    var hostAgeMs = null;
    var running = false;
    var playing = false;
    var polls = 0;
    var errors = 0;
    var source = 'none';
    var lastAudibleAt = 0;
    var levelEnv = 0;            // 整体响度包络（0..1），厚度通道用它表达节拍冲击
    var railScroller = null;     // 打了 data-dpr-rail 的滚动容器
    var clipW = 0;               // 当前横向放开宽度
    var menuTimer = 0;           // 检测左下角用户档案弹窗的轮询
    var lastReportAt = 0;
    var lastSummary = '';
    var scanAt = 0;
    var reportCount = 0;

    // ── 样式 ────────────────────────────────────────────────────────────────
    function ensureStyle() {
      if (styleEl && styleEl.isConnected) return;
      styleEl = document.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        styleEl.textContent = CSS;
        (document.head || document.documentElement).appendChild(styleEl);
      }
    }

    // ── 导航条发现（多策略 + 打分；CSS Module 类名带哈希，所以按后缀/结构找）──
    function collectRoots() {
      var roots = [];
      var sels = ['[class*="_marks"]', '[class*="_frame"]', '[class*="marks"]', '[class*="frame"]'];
      for (var i = 0; i < sels.length; i++) {
        var found;
        try { found = document.querySelectorAll(sels[i]); } catch (e) { found = []; }
        for (var j = 0; j < found.length; j++) if (roots.indexOf(found[j]) < 0) roots.push(found[j]);
      }
      // 兜底：CSS Module 哈希前缀换版时，仍能按「button[data-index] 的父节点」找到导航条
      // （对话列表的虚拟项也可能带 data-index，由 railLike 的窄容器判据排除）。
      var btns;
      try { btns = document.querySelectorAll('button[data-index]'); } catch (e) { btns = []; }
      for (var k = 0; k < btns.length; k++) {
        var parent = btns[k].parentElement;
        if (parent && roots.indexOf(parent) < 0) roots.push(parent);
      }
      return roots;
    }

    function barsIn(root) {
      var list;
      try { list = root.querySelectorAll('[data-index]'); } catch (e) { list = null; }
      if (!list || !list.length) {
        try { list = root.querySelectorAll('[class*="_mark"]'); } catch (e) { list = null; }
      }
      var out = [];
      if (!list) return out;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (classOf(el).indexOf('marks') >= 0) continue; // 容器本身，不是横条
        out.push(el);
      }
      return out;
    }

    // 导航条本体只有 28px 宽、每根横条 10px 间距。先按几何特征硬过滤，避免把
    // 对话列（也是一个带 data-index 虚拟列表、右缘同样贴边的大容器）误当导航条。
    function railLike(root, list) {
      var r = rectOf(root);
      // 宽度上限放到 320px：我们自己把滚动容器横向放开后，marks 容器会变成 ~220px 宽；
      // 真正的对话列宽 1600px+，仍然会被这一条排除掉（再加上「子元素必须是小横条」的判据）。
      if (!(r.width > 0) || r.width > 320) return null;
      if (!(r.height > 0) || r.height > 1200) return null;
      // 只判「扁」：我们把滚动容器横向放开后，横条按钮的宽度会跟着容器变宽（220px），
      // 但高度仍是 10px；而对话列的条目又高又大，照样被这一条排除。
      var small = 0;
      var probe = Math.min(list.length, 8);
      for (var k = 0; k < probe; k++) {
        var rc = rectOf(list[k]);
        if (rc.height > 0 && rc.height <= 24) small++;
      }
      if (probe > 0 && small < Math.ceil(probe / 2)) return null;  // 子元素不是小横条
      var vw = window.innerWidth || 0;
      var gap = vw - r.right;
      var score = 6;
      if (gap >= -4 && gap < 80) score += 4;               // 贴右缘
      score += Math.min(list.length, 42) / 10;
      score += (small / Math.max(1, probe)) * 3;
      return score;
    }

    function pick() {
      var roots = collectRoots();
      var best = null;
      var bestScore = -1;
      for (var i = 0; i < roots.length; i++) {
        var list = barsIn(roots[i]);
        if (!list.length) continue;
        var score = railLike(roots[i], list);
        if (score === null) continue;
        if (score > bestScore) { bestScore = score; best = { root: roots[i], bars: list }; }
      }
      return best;
    }

    // 应用自身的状态长度（与 asar 里 TurnNavigator.module.css 的 scaleX 值一致）
    function stateScaleOf(el) {
      var c = classOf(el);
      if (c.indexOf('markActive') >= 0) return 1;
      if (c.indexOf('markPreview') >= 0) return 0.9;
      if (c.indexOf('markUnloaded') >= 0) return 0.4;
      return 0.6;
    }

    function cleanupBar(el) {
      try {
        el.removeAttribute('data-dpr-bar');
        el.style.removeProperty('--dpr-w');
        el.style.removeProperty('--dpr-h');
        el.__dprIdx = undefined;
        el.__dprCur = undefined;
        el.__dprState = undefined;
      } catch (e) { /* ignore */ }
    }

    function releaseBars() {
      for (var i = 0; i < bars.length; i++) cleanupBar(bars[i]);
      bars = [];
      container = null;
    }

    // 横向放开裁剪边界：应用的 .scroller 是 overflow-y:auto（横向也被裁在 28px 内），
    // 给它打标记后由我们的样式向左加宽。长横条因此能画出来，而右缘位置不变。
    function tagRail(best) {
      if (railScroller && railScroller !== (best && best.root ? best.root.parentElement : null)) {
        try { railScroller.removeAttribute('data-dpr-rail'); railScroller.style.removeProperty('--dpr-clip-w'); } catch (e) { /* ignore */ }
        railScroller = null;
      }
      var el = best && best.root ? best.root.parentElement : null;
      for (var up = 0; el && up < 3; up++) {
        var c = classOf(el);
        if (c.indexOf('scroller') >= 0 || (el.getAttribute && el.getAttribute('style') === null && c.indexOf('marks') < 0)) {
          // 认 class 里有 scroller 的那层；找不到就退回 marks 的父层
        }
        if (c.indexOf('scroller') >= 0) break;
        el = el.parentElement;
      }
      if (!el || !el.setAttribute) el = best && best.root ? best.root.parentElement : null;
      if (el) {
        try { el.setAttribute('data-dpr-rail', 'scroller'); railScroller = el; } catch (e) { /* ignore */ }
      }
      if (best && best.root && best.root.setAttribute) {
        try { best.root.setAttribute('data-dpr-rail', 'marks'); } catch (e) { /* ignore */ }
      }
    }

    // 增量同步：已存在的横条保留当前倍率（加一根轮次不该让整条导航条闪回原样）。
    function sync(best) {
      var next = best ? best.bars : [];
      var prev = bars;
      for (var i = 0; i < next.length; i++) {
        var el = next[i];
        if (el.__dprIdx === undefined || el.__dprCur === undefined) el.__dprCur = 1;
        el.__dprIdx = i;
      }
      for (var j = 0; j < prev.length; j++) {
        if (next.indexOf(prev[j]) < 0) cleanupBar(prev[j]);
      }
      bars = next;
      container = best ? best.root : null;
      tagRail(best);
      var r = container ? rectOf(container) : null;
      source = best ? 'dom' : 'none';
      report('sync', 'bars=' + bars.length + ' root=' + (container ? classOf(container).slice(0, 60) : '-') +
        ' rect=' + (r ? Math.round(r.right) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : '-'));
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
      if (container && typeof MutationObserver === 'function') {
        try {
          observer = new MutationObserver(function () { scanNow('mutation'); });
          observer.observe(container, { childList: true, subtree: false });
        } catch (e) { observer = null; }
      }
    }

    function scanNow(why) {
      var now = Date.now();
      if (now - scanAt < 60) return;
      scanAt = now;
      var best = null;
      if (container && container.isConnected) {
        // 认过的容器只要还活着就一直用它：容器宽度会被我们放开，几何重选可能把它排除掉
        var live = barsIn(container);
        if (live.length) best = { root: container, bars: live };
      }
      if (!best) best = pick();
      var sameRoot = best && container && best.root === container;
      var sameCount = best && best.bars.length === bars.length;
      if (!best) {
        if (bars.length) { releaseBars(); report('lost', why); }
        return;
      }
      if (sameRoot && sameCount && bars.length && bars[0].isConnected) return;
      sync(best);
    }

    // ── 诊断上报（页面控制台在桌面端只有 error 级进日志，所以这里走宿主侧落盘）──
    function report(event, detail) {
      var summary = event + '|' + (detail || '');
      if (summary === lastSummary) return;
      lastSummary = summary;
      var now = Date.now();
      var alwaysReport = (event === 'apply' || event === 'sync' || event === 'probe' || event === 'lost' || event === 'anchor' || event === 'panel' || event === 'settings' || event === 'theme');
      if (now - lastReportAt < 800 && !alwaysReport) return;
      lastReportAt = now;
      console.error(TAG + ' ' + event + ' ' + (detail || ''));
      try {
        window.fetch(BASE + '/diag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            at: now, event: event, detail: detail || '', bars: bars.length, found: !!container,
            source: source, polls: polls, errors: errors,
            railClass: container ? classOf(container).slice(0, 120) : '',
            href: String(window.location && window.location.href || '').slice(0, 160),
            ua: String(window.navigator && window.navigator.userAgent || '').slice(0, 120),
          }),
        }).catch(function () { /* 上报失败无所谓 */ });
      } catch (e) { /* ignore */ }
    }

    // ── DOM 探针：找到/找不到导航条时，把「页面里到底有什么」上报给宿主 ────────
    function domProbe() {
      var out = {};
      try {
        var q = function (sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
        out.f_clsFrame = q('[class*="_frame"]');
        out.f_clsFrameAny = q('[class*="frame"]');
        out.f_clsMarks = q('[class*="_marks"]');
        out.f_clsMarksAny = q('[class*="marks"]');
        out.f_clsMark = q('[class*="_mark"]');
        out.f_dataIndex = q('[data-index]');
        out.f_btnDataIndex = q('button[data-index]');
        out.f_nav = q('nav');
        out.win = window.innerWidth + 'x' + window.innerHeight;
        out.bodyCls = String((document.body && document.body.className) || '').slice(0, 90);
        out.bodyKids = document.body ? document.body.children.length : -1;
        var root = document.getElementById('root') || document.body;
        out.rootKids = root ? root.children.length : -1;
        var shadow = 0;
        var samples = [];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) shadow++;
          var cls = classOf(all[i]);
          if (!cls) continue;
          var parts = cls.split(' ');
          for (var j = 0; j < parts.length && samples.length < 24; j++) {
            var p = parts[j];
            if (p.indexOf('_') > 0 && samples.indexOf(p) < 0) samples.push(p);
          }
        }
        out.shadowRoots = shadow;
        out.elements = all.length;
        out.classSamples = samples.join('|').slice(0, 400);
        // 每个候选容器的实况：类名 / 位置尺寸 / 命中子元素数
        var roots = collectRoots();
        var desc = [];
        for (var r = 0; r < roots.length && r < 8; r++) {
          var el = roots[r];
          var rc = rectOf(el);
          var di = 0, mk = 0;
          try { di = el.querySelectorAll('[data-index]').length; } catch (e) { /* ignore */ }
          try { mk = el.querySelectorAll('[class*="_mark"]').length; } catch (e) { /* ignore */ }
          desc.push(classOf(el).slice(0, 34) + '#' + Math.round(rc.width) + 'x' + Math.round(rc.height) +
            '@' + Math.round(rc.right) + ',' + Math.round(rc.top) + ' di=' + di + ' mk=' + mk);
        }
        out.candidates = desc.join(' || ').slice(0, 600);
        out.chosen = container ? classOf(container).slice(0, 34) + ' bars=' + bars.length : 'none';
      } catch (e) { out.err = String(e && e.message || e); }
      return out;
    }

    function reportProbe(tag) {
      var p = domProbe();
      var detail = 'tag=' + tag;
      for (var k in p) detail += ' ' + k + '=' + p[k];
      report('probe', detail);
    }

    // ── 探针：左下角用户信息区（设置按钮要放它上方）──────────────────────────
    function anchorProbe() {
      var out = [];
      try {
        var re = /\d{3}\*{3,}\d{2}/;
        var all = document.querySelectorAll('div,span,p,button,a,section,footer');
        var found = 0;
        for (var i = 0; i < all.length && found < 3; i++) {
          var el = all[i];
          var t = String(el.textContent || '').trim();
          if (t.length > 30 || !re.test(t)) continue;
          var inner = false;
          for (var c = 0; c < el.children.length; c++) {
            if (re.test(String(el.children[c].textContent || ''))) inner = true;
          }
          if (inner) continue;
          found++;
          var chain = [];
          var node = el;
          for (var d = 0; d < 6 && node; d++) {
            var r = rectOf(node);
            chain.push(node.tagName + '.' + classOf(node).slice(0, 46) + '[' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.top) + ']');
            node = node.parentElement;
          }
          out.push('mask=' + t + ' :: ' + chain.join(' < '));
        }
        // 侧栏底部容器候选
        var side = document.querySelectorAll('[class*="sidebar"],[class*="Sidebar"],[class*="userRow"],[class*="account"],[class*="profile"]');
        var desc = [];
        for (var s = 0; s < side.length && s < 8; s++) {
          var rr = rectOf(side[s]);
          desc.push(classOf(side[s]).slice(0, 40) + '[' + Math.round(rr.width) + 'x' + Math.round(rr.height) + '@' + Math.round(rr.top) + ']');
        }
        out.push('sidebarCandidates=' + desc.join(' | '));
      } catch (e) { out.push('err=' + e.message); }
      return out.join(' ;; ').slice(0, 1000);
    }

    // ── 设置面板：放在左下角用户信息正上方；滑动条/数字改动实时写回 config.json ──
    var FIELDS = [
      { key: 'maxW', label: '长度上限', min: 0.5, max: 4, step: 0.05, dec: 2, hint: '横条最长倍数（1 = 应用原本 20px，20px = 28px 框宽）。上限已解锁到 4（最长 80px，会画到导航条左边去）' },
      { key: 'minW', label: '长度下限', min: 0.05, max: 1.0, step: 0.01, dec: 2, hint: '安静频段最短倍数。调小 = 长短跨度更大（0.2 就很夸张）' },
      { key: 'maxH', label: '厚度上限', min: 2, max: 8, step: 0.5, dec: 1, hint: '最响时横条多粗（px）。横条间距 10px，超过 8 就会上下粘连 —— 想要「幅度大」主要调这个' },
      { key: 'minH', label: '厚度下限', min: 1, max: 6, step: 0.5, dec: 1, hint: '最静时横条厚度（px），应用原始就是 2' },
      { key: 'gamma', label: '响应曲线', min: 0.3, max: 2, step: 0.05, dec: 2, hint: '小于 1 更饱满更猛，大于 1 更克制（0.5 已经很夸张）' },
      { key: 'agcMix', label: '动态对比', min: 0, max: 1, step: 0.05, dec: 2, hint: '每个频段跟自己的慢基线比，0=只看绝对音量（差别小），1=只看变化量（最猛）。觉得长度差别不大就调它' },
      { key: 'gate', label: '噪声门', min: 0, max: 0.2, step: 0.005, dec: 3, hint: '低于此值的频段算静音。调大（0.06~0.1）可压掉底噪，横条不会一直抖' },
      { key: 'atkMs', label: '跟拍速度', min: 5, max: 200, step: 5, dec: 0, hint: '上升时间常数（ms）：越小越跟拍，越大越绵' },
      { key: 'relMs', label: '回落速度', min: 20, max: 500, step: 5, dec: 0, hint: '下降时间常数（ms）：越大余韵越长' },
      { key: 'silentMs', label: '静音回落', min: 100, max: 2000, step: 50, dec: 0, hint: '多久没有音频就把导航条恢复成原样（ms）' },
      { key: 'fps', label: '采集帧率', min: 15, max: 60, step: 5, dec: 0, hint: '音频帧率：越高越顺滑，CPU 略高（30 够用）' },
    ];
    // 频谱方向：三选一（高频在上 / 居中 / 在下）
    var SEGMENTS = [
      { key: 'freqLayout', label: '频谱方向', options: [
        { value: 'top', label: '高频在上' },
        { value: 'center', label: '高频居中' },
        { value: 'down', label: '高频在下' },
      ] },
    ];

    // 兼容旧配置：freqLayout 优先，其次由 mirrorCenter / bassAtBottom 推出来
    function freqLayoutOf() {
      var v = cfg.freqLayout;
      if (v === 'top' || v === 'center' || v === 'down') return v;
      if (cfg.mirrorCenter !== false) return 'center';
      return cfg.bassAtBottom === false ? 'down' : 'top';
    }
    var ui = null;
    var pending = {};
    var pendingTimer = 0;
    var msgTimer = 0;
    var localGuard = {};

    function localSet(key, value) {
      cfg[key] = value;
      localGuard[key] = Date.now() + 1200;   // 拖动期间不被宿主的回包覆盖
    }

    function uiMsg(text) {
      if (!ui || !ui.msgEl) return;
      ui.msgEl.textContent = text;
      if (msgTimer) clearTimeout(msgTimer);
      msgTimer = setTimeout(function () { if (ui && ui.msgEl) ui.msgEl.textContent = ''; }, 2600);
    }

    function flushPatch() {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0; }
      var body = assign({}, cfg);      // 整份写回：宿主侧若还是旧版代码，单键补丁会把 minH/maxH 从文件里挤掉
      var keys = Object.keys(pending);
      for (var i = 0; i < keys.length; i++) body[keys[i]] = pending[keys[i]];
      pending = {};
      if (!keys.length) return;
      try {
        window.fetch(BASE + '/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function () {
          uiMsg('已写入 config.json');
        }).catch(function (err) {
          uiMsg('保存失败：' + ((err && err.message) || err));
        });
      } catch (err) { uiMsg('保存异常：' + err.message); }
    }

    function queuePatch(key, value) {
      pending[key] = value;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(flushPatch, 160);
    }

    function syncInputs() {
      if (!ui) return;
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i];
        var slot = ui.inputs[f.key];
        if (!slot) continue;
        var v = typeof cfg[f.key] === 'number' ? cfg[f.key] : DEFAULTS[f.key];
        v = Math.min(f.max, Math.max(f.min, v));
        slot.range.value = v;
        if (slot.num !== document.activeElement) slot.num.value = Number(v.toFixed(f.dec));
      }
      for (var s = 0; s < SEGMENTS.length; s++) {
        var seg = ui.inputs[SEGMENTS[s].key];
        if (!seg) continue;
        var cur = freqLayoutOf();
        for (var b = 0; b < seg.buttons.length; b++) {
          var on = seg.buttons[b].getAttribute('data-value') === cur;
          seg.buttons[b].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      }
      if (ui.enableBtn) {
        var on2 = cfg.enabled !== false;
        ui.enableBtn.textContent = on2 ? '暂停律动' : '启用律动';
        ui.enableBtn.setAttribute('aria-pressed', on2 ? 'true' : 'false');
      }
    }

    function placeSettings() {
      if (!ui) return 0;
      var h = window.innerHeight || 0;
      var vw = window.innerWidth || 0;
      var best = null;
      try {
        var rows = document.querySelectorAll('[class*="triggerRow"]');
        for (var i = 0; i < rows.length; i++) {
          var r = rectOf(rows[i]);
          if (r.height < 20 || r.height > 90) continue;
          if (r.top < h * 0.55) continue;
          if (r.width > vw * 0.5) continue;
          if (!best || r.top > best.top) best = { top: r.top };
        }
      } catch (e) { /* ignore */ }
      var bottom = best ? Math.max(6, h - best.top + 8) : 74;
      ui.root.style.bottom = bottom + 'px';
      return bottom;
    }

    function toggleSettings(open) {
      if (!ui) return;
      ui.panel.style.display = open ? 'block' : 'none';
      if (open) {
        placeSettings();
        syncInputs();
        try {
          var pr = ui.panel.getBoundingClientRect();
          var rows = ui.panel.querySelectorAll('.dpr-row');
          var info = 'panel=' + Math.round(pr.left) + ',' + Math.round(pr.top) + ' ' + Math.round(pr.width) + 'x' + Math.round(pr.height);
          if (rows.length) {
            var r0 = rows[0].getBoundingClientRect();
            var rl = rows[rows.length - 1].getBoundingClientRect();
            var ft = ui.inputs.fps.range.getBoundingClientRect();
            info += ' row0=' + Math.round(r0.top) + ' rowLast=' + Math.round(rl.top) +
              ' each=' + (((rl.top - r0.top) / Math.max(1, rows.length - 1))).toFixed(1) +
              ' fpsTrack=' + Math.round(ft.left) + '..' + Math.round(ft.right) + '@' + Math.round(ft.top) +
              ' cfgFps=' + cfg.fps + ' cfgMaxH=' + cfg.maxH;
          }
          report('panel', info);
        } catch (e) { /* ignore */ }
      }
    }

    function buildSettings() {
      var root = document.createElement('div');
      root.id = 'dsh-pulse-rail-settings';
      root.style.bottom = '74px';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-dpr-btn', '1');
      btn.title = '导航条律动设置';
      btn.textContent = '♪';
      var panel = document.createElement('div');
      panel.setAttribute('data-dpr-panel', '1');
      panel.style.display = 'none';
      var head = document.createElement('div');
      head.setAttribute('data-dpr-head', '1');
      var title = document.createElement('span');
      title.textContent = '导航条律动';
      var msg = document.createElement('em');
      msg.setAttribute('data-dpr-msg', '1');
      head.appendChild(title); head.appendChild(msg);
      panel.appendChild(head);
      var inputs = {};
      FIELDS.forEach(function (f) {
        var row = document.createElement('label');
        row.className = 'dpr-row';
        if (f.hint) row.title = f.hint;
        var name = document.createElement('span');
        name.textContent = f.label;
        if (f.hint) name.title = f.hint;
        var range = document.createElement('input');
        range.type = 'range'; range.min = f.min; range.max = f.max; range.step = f.step;
        var num = document.createElement('input');
        num.type = 'number'; num.min = f.min; num.max = f.max; num.step = f.step;
        var commit = function (raw) {
          var val = Number(raw);
          if (!isFinite(val)) return;
          val = Math.min(f.max, Math.max(f.min, Number(val.toFixed(f.dec))));
          localSet(f.key, val);
          range.value = val;
          num.value = Number(val.toFixed(f.dec));
          queuePatch(f.key, val);
        };
        range.addEventListener('input', function () { commit(range.value); });
        num.addEventListener('input', function () { commit(num.value); });
        num.addEventListener('blur', function () { flushPatch(); });
        num.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') flushPatch(); });
        if (f.hint) { range.title = f.hint; num.title = f.hint; }
        row.appendChild(name); row.appendChild(range); row.appendChild(num);
        panel.appendChild(row);
        inputs[f.key] = { range: range, num: num };
      });
      SEGMENTS.forEach(function (seg2) {
        var row = document.createElement('div');
        row.className = 'dpr-seg';
        var name = document.createElement('span');
        name.textContent = seg2.label;
        row.appendChild(name);
        var buttons = [];
        seg2.options.forEach(function (opt) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = opt.label;
          b.setAttribute('data-value', opt.value);
          b.title = opt.value === 'top' ? '低频在下端、高频在上端'
            : opt.value === 'center' ? '两端低频、正中间高频（对称，推荐）'
            : '低频在上端、高频在下端';
          b.addEventListener('click', function () {
            localSet(seg2.key, opt.value);
            queuePatch(seg2.key, opt.value);
            for (var k = 0; k < buttons.length; k++) {
              buttons[k].setAttribute('aria-pressed', buttons[k] === b ? 'true' : 'false');
            }
          });
          buttons.push(b);
          row.appendChild(b);
        });
        panel.appendChild(row);
        inputs[seg2.key] = { buttons: buttons };
      });
      var foot = document.createElement('div');
      foot.setAttribute('data-dpr-foot', '1');
      var enableBtn = document.createElement('button');
      enableBtn.type = 'button';
      enableBtn.textContent = '暂停律动';
      enableBtn.addEventListener('click', function () {
        var next = cfg.enabled === false;
        localSet('enabled', next);
        queuePatch('enabled', next);
        enableBtn.textContent = next ? '暂停律动' : '启用律动';
        enableBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
      });
      var reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = '恢复默认';
      reset.addEventListener('click', function () {
        var body = {};
        Object.keys(DEFAULTS).forEach(function (k) { body[k] = DEFAULTS[k]; });
        var now = Date.now();
        Object.keys(body).forEach(function (k) { cfg[k] = body[k]; localGuard[k] = now + 2000; });
        syncInputs();
        pending = assign(pending, body);
        flushPatch();
      });
      var close = document.createElement('button');
      close.type = 'button';
      close.textContent = '关闭';
      close.addEventListener('click', function () { toggleSettings(false); });
      foot.appendChild(enableBtn); foot.appendChild(reset); foot.appendChild(close);
      panel.appendChild(foot);
      root.appendChild(btn); root.appendChild(panel);
      (document.body || document.documentElement).appendChild(root);
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleSettings(panel.style.display === 'none');
      });
      document.addEventListener('click', function (ev) {
        if (panel.style.display === 'none') return;
        if (root.contains(ev.target)) return;
        toggleSettings(false);
      }, true);
      return { root: root, panel: panel, inputs: inputs, msgEl: msg, enableBtn: enableBtn };
    }

    // 用户档案菜单（设置 / 意见反馈 / 退出登录）是半透明弹窗，位置正好压住我们的 ♪ 按钮 ——
    // 它一出现就把按钮整块藏起来，关掉再显示。
    function profileMenuOpen() {
      try {
        var cands = document.querySelectorAll('[role="menu"],[role="dialog"],[class*="menu"],[class*="Menu"],[class*="popup"],[class*="Popup"],[class*="dropdown"]');
        var vh = window.innerHeight || 0;
        for (var i = 0; i < cands.length && i < 24; i++) {
          var el = cands[i];
          var r = rectOf(el);
          if (r.width < 60 || r.height < 40) continue;
          if (r.top < vh * 0.5) continue;                 // 只认左下角那类弹窗
          var t = String(el.textContent || '');
          if (t.indexOf('退出登录') >= 0 || t.indexOf('意见反馈') >= 0) return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    }

    // 浅色/深色自适应：读按钮附近真实背景的亮度（不依赖 DSH 内部变量名），给面板自己的 5 个变量赋值
    function themeIsLight() {
      try {
        var el = (ui && ui.root && ui.root.parentElement) || document.body;
        var lum = 0;
        for (var i = 0; i < 8 && el; i++) {
          var c = window.getComputedStyle(el).backgroundColor || '';
          var m = c.match(/rgba?\(([^)]+)\)/);
          if (m) {
            var p = m[1].split(',').map(Number);
            var a = p.length > 3 ? p[3] : 1;
            if (a > 0.5) { lum = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255; break; }
          }
          el = el.parentElement;
        }
        if (!lum) lum = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 1 : 0;
        return lum > 0.55;
      } catch (e) { return false; }
    }

    function applyTheme() {
      if (!ui) return;
      var light = themeIsLight();
      var v = ui.root.style;
      if (light) {
        v.setProperty('--dpr-fg', '#1f2023');
        v.setProperty('--dpr-muted', '#5b6068');
        v.setProperty('--dpr-border', 'rgba(0,0,0,.18)');
        v.setProperty('--dpr-panel', '#ffffff');
        v.setProperty('--dpr-accent', '#3b6ef0');
      } else {
        v.setProperty('--dpr-fg', '#f9fafb');
        v.setProperty('--dpr-muted', '#adb2b8');
        v.setProperty('--dpr-border', 'rgba(255,255,255,.24)');
        v.setProperty('--dpr-panel', '#232326');
        v.setProperty('--dpr-accent', '#4c7dff');
      }
      ui.root.setAttribute('data-dpr-theme', light ? 'light' : 'dark');
    }

    function applyMenuHidden() {
      if (disposed || !ui) return;
      applyTheme();
      if (profileMenuOpen()) {
        if (ui.panel.style.display !== 'none') toggleSettings(false);
        if (ui.root.getAttribute('data-dpr-hidden') !== '1') ui.root.setAttribute('data-dpr-hidden', '1');
      } else if (ui.root.getAttribute('data-dpr-hidden') === '1') {
        ui.root.removeAttribute('data-dpr-hidden');
      }
    }

    function startMenuWatch() {
      if (menuTimer) return;
      applyTheme();
      menuTimer = setInterval(applyMenuHidden, 700);
      document.addEventListener('click', function () {
        setTimeout(applyMenuHidden, 90);                  // 等应用的弹窗渲染出来
      }, true);
    }

    function mountSettings() {
      try {
        // 客户端 bundle 热加载会换新实例：旧实例的面板必须先摘掉，否则它会留着不再更新（且按钮绑定的是旧配置）
        var stale = document.getElementById('dsh-pulse-rail-settings');
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        ui = buildSettings();
        var bottom = placeSettings();
        syncInputs();
        startMenuWatch();
        window.addEventListener('resize', placeSettings, false);
        try {
          var cs = window.getComputedStyle(document.documentElement);
          report('theme', 'labelPrimary=' + String(cs.getPropertyValue('--dsw-alias-label-primary')).trim() +
            ' bgLayer1=' + String(cs.getPropertyValue('--dsw-alias-bg-layer-1')).trim() +
            ' borderL4=' + String(cs.getPropertyValue('--dsw-alias-border-l4')).trim() +
            ' bizPrimary=' + String(cs.getPropertyValue('--dsw-alias-state-business-primary')).trim() +
            ' theme=' + ui.root.getAttribute('data-dpr-theme') +
            ' panelBg=' + window.getComputedStyle(ui.panel).backgroundColor +
            ' rootColor=' + window.getComputedStyle(ui.root).color);
        } catch (e) { /* ignore */ }
        report('settings', 'mounted bottom=' + bottom + ' cfg=' + cfg.minW + '..' + cfg.maxW + '/' + cfg.minH + '..' + cfg.maxH);
      } catch (e) {
        console.error(TAG + ' settings mount failed: ' + ((e && e.stack) || e));
      }
    }

    // ── 数据轮询 ───────────────────────────────────────────────────────────
    function applyState(json) {
      lastOkAt = performance.now();
      if (json && json.config) {
        var incoming = json.config;
        var nextBands = incoming.bands || cfg.bands;
        var nowGuard = Date.now();
        for (var key in incoming) {
          if (localGuard[key] && localGuard[key] > nowGuard) continue;   // 用户刚拖过，先别被回包盖掉
          cfg[key] = incoming[key];
        }
        if (ui) syncInputs();
        if (nextBands !== smooth.length) { shapeMemo = newShapeState(nextBands); smooth = shapeMemo.smooth; }
      }
      running = !!(json && json.running);
      playing = !!(json && json.playing);
      if (playing) lastAudibleAt = performance.now();
      hostAgeMs = (json && typeof json.ageMs === 'number') ? json.ageMs : null;
      var frame = json && json.frame;
      if (frame) {
        var raw = typeof frame.rms === 'number' ? frame.rms : 0;
        raw = clamp((raw - 0.008) / 0.22, 0, 1);
        if (raw > levelEnv) levelEnv += (raw - levelEnv) * 0.55;
        else levelEnv += (raw - levelEnv) * 0.12;
      }
      if (frame && frame.b && frame.b.length) {
        if (frame.b.length !== smooth.length) { shapeMemo = newShapeState(frame.b.length); smooth = shapeMemo.smooth; }
        liveBands = frame.b;
      } else {
        liveBands = null;
      }
    }

    function poll() {
      if (disposed) return;
      if (inFlight) { schedule(); return; }
      inFlight = true;
      var finished = false;
      var done = function () {
        if (finished) return;
        finished = true;
        inFlight = false;
        schedule();
      };
      try {
        var timeoutId = setTimeout(function () { done(); }, 4000);
        window.fetch(BASE + '/state', { cache: 'no-store' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (json) {
            polls++;
            source = 'poll';
            clearTimeout(timeoutId);
            applyState(json);
            done();
          })
          .catch(function (err) {
            errors++;
            clearTimeout(timeoutId);
            if (errors <= 3 || errors % 200 === 0) report('poll-error', String(err && err.message || err));
            running = false;
            done();
          });
      } catch (err) {
        errors++;
        report('poll-throw', String(err && err.message || err));
        done();
      }
    }

    function schedule() {
      if (disposed) return;
      var hidden = false;
      try { hidden = document.hidden === true || document.visibilityState === 'hidden'; } catch (e) { /* ignore */ }
      var delay = hidden ? 1000 : (bars.length ? 33 : 400);
      pollTimer = setTimeout(poll, delay);
    }

    // ── 渲染循环：只写 --dpr-w（几何量），无任何光效 ─────────────────────────
    function loop(ts) {
      if (disposed) return;
      rafId = window.requestAnimationFrame(loop);
      var now = (typeof ts === 'number' && ts > 0) ? ts : performance.now();
      if (!lastTick) lastTick = now;
      var dt = now - lastTick;
      lastTick = now;
      if (!(dt > 0)) dt = 16;
      if (dt > 80) dt = 80;

      if (!bars.length || !container || !container.isConnected) scanNow('loop');
      if (!bars.length) return;

      var stale = hostAgeMs === null ? 1e9 : hostAgeMs + (now - lastOkAt);
      // 「静音」以宿主判定为准（playing = 有实际电平），再留 400ms 迟滞，避免安静段落里横条抽动。
      var audible = playing && (now - lastAudibleAt) < 400;
      var idle = !cfg.enabled || !running || !liveBands || !audible || stale > cfg.silentMs;

      // 长度上限已解锁到 4（最长 4×20px = 80px）；滚动容器已横向放开，不再被 28px 裁掉
      var maxW = clamp(cfg.maxW, 0.5, 4);
      var minW = clamp(cfg.minW, 0.05, Math.max(0.1, maxW - 0.05));
      var maxH = clamp(cfg.maxH, 1, 8);
      var minH = clamp(cfg.minH, 1, maxH);
      var agcMix = clamp(typeof cfg.agcMix === 'number' ? cfg.agcMix : 0.6, 0, 1);
      var clipTarget = Math.round(20 * maxW + 44);
      if (railScroller && clipTarget !== clipW) {
        clipW = clipTarget;
        try { railScroller.style.setProperty('--dpr-clip-w', clipW + 'px'); } catch (e) { /* ignore */ }
      }

      // 频段整形（CURVE-1）：清洗 → 绝对电平 + 连续动态对比 → 轻压缩 → 空间平滑 → 时间包络
      var n = smooth.length;
      smooth = bandShape(shapeMemo, liveBands, n, cfg, dt, idle);
      curveSlopes = shapeMemo.slopes;

      var count = bars.length;
      var layout = freqLayoutOf();
      // CURVE-1.3：先在**归一化域 [0,1]** 做线性插值与自适应三点平滑，最后再映射为长度（只作用于长度）
      var barTargets = null;
      if (CURVE13.enabled && !idle && count > 0) {
        if (barBuf.length !== count) { barBuf = zeros(count); barSm = zeros(count); }
        for (var bi = 0; bi < count; bi++) barBuf[bi] = lerpAt(smooth, layoutPos(bi, count, layout));
        barTargets = smoothBarsInto(barBuf, barSm);
      }
      var settled = true;
      var kState = 1 - Math.exp(-dt / 140);   // 应用的 .14s transform 过渡被我们关掉了，用 JS 补回状态切换的顺滑
      for (var b = 0; b < count; b++) {
        var el = bars[b];
        if (!el.isConnected || el.__dprIdx !== b) { scanNow('stale'); return; }
        var acc = el.__dprCur === undefined ? 1 : el.__dprCur;
        // 位置 → 频率：mirrorCenter（默认）时两端是低频、正中间是最高频，视觉更对称好看；
        // 这里每帧都按「当前 DOM 里实际渲染出来的横条数」算，所以轮次增减、导航条内部滚动都会实时改映射。
        // 位置 → 频率（top/center/down）。CURVE13 开启：线性插值 + 已平滑的目标长度；
        // 关闭（回滚）：逐位保持 CURVE-1 行为（PCHIP + 无横条级平滑）。
        var want;
        if (idle) want = 1;
        else if (barTargets) want = minW + barTargets[b] * (maxW - minW);
        else want = minW + pchipAt(smooth, curveSlopes, layoutPos(b, count, layout)) * (maxW - minW);
        var kk = 1 - Math.exp(-dt / ((want > acc ? cfg.atkMs : cfg.relMs) || 60));
        acc += (want - acc) * kk;
        var span = maxW - minW;
        var thick = span > 0 ? clamp((acc - minW) / span, 0, 1) : 0;
        // 长度画频谱（每根各管各的频段），厚度让整条导航条跟着节拍一起变粗 —— 更「律动」
        if (!idle && levelEnv > thick) thick = levelEnv;
        var sy = (minH + thick * (maxH - minH)) / 2;     // 应用原始厚度 2px，用 scaleY 表达
        var st = el.__dprState === undefined ? stateScaleOf(el) : el.__dprState;
        var stWant = stateScaleOf(el);
        st += (stWant - st) * kState;
        if (idle && Math.abs(acc - 1) < 0.004) {
          // 彻底安静：摘掉覆盖，横条 100% 回到应用原生几何（不写任何自定义属性）
          el.__dprCur = 1;
          el.__dprState = stWant;
          if (el.getAttribute('data-dpr-bar') !== null) {
            try {
              el.removeAttribute('data-dpr-bar');
              el.style.removeProperty('--dpr-w');
              el.style.removeProperty('--dpr-h');
            } catch (e) { /* ignore */ }
          }
          continue;
        }
        settled = false;
        try {
          el.setAttribute('data-dpr-bar', String(b));
          el.style.setProperty('--dpr-w', (st * acc).toFixed(4));
          el.style.setProperty('--dpr-h', sy.toFixed(3));
        } catch (e) { /* ignore */ }
        el.__dprCur = acc;
        el.__dprState = st;
      }

      var nowMs = Date.now();
      if (nowMs - lastReportAt > 15000 || (reportCount === 0 && polls > 4)) {
        lastReportAt = nowMs;
        reportCount++;
        report('pulse', 'bars=' + count + ' idle=' + idle + ' settled=' + settled +
          ' rms=' + (liveBands ? 'live' : 'none') + ' polls=' + polls + ' errors=' + errors +
          ' v=' + bars.slice(0, 6).map(function (x) { return (x.__dprCur || 1).toFixed(2); }).join(','));
      }
    }

    function dispose() {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (pendingTimer) clearTimeout(pendingTimer);
      if (msgTimer) clearTimeout(msgTimer);
      if (menuTimer) { clearInterval(menuTimer); menuTimer = 0; }
      try {
        var panelRoot = document.getElementById('dsh-pulse-rail-settings');
        if (panelRoot && panelRoot.parentNode) panelRoot.parentNode.removeChild(panelRoot);
      } catch (e) { /* ignore */ }
      ui = null;
      if (rafId) { try { window.cancelAnimationFrame(rafId); } catch (e) { /* ignore */ } }
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
      releaseBars();
      if (styleEl && styleEl.parentNode) { try { styleEl.parentNode.removeChild(styleEl); } catch (e) { /* ignore */ } }
      document.removeEventListener('visibilitychange', onVisibility, false);
    }

    function onVisibility() { if (!disposed) { if (pollTimer) clearTimeout(pollTimer); schedule(); } }

    ensureStyle();
    report('apply', 'starting');
    scanNow('start');
    reportProbe('t0');
    mountSettings();
    setTimeout(function () { if (!disposed) scanNow('start-retry'); }, 1200);
    document.addEventListener('visibilitychange', onVisibility, false);
    schedule();
    rafId = window.requestAnimationFrame(loop);

    return { dispose: dispose, _debug: function () { return { bars: bars.length, polls: polls, errors: errors, source: source }; } };
  }

  global.__ModuleLoader__.load({
    id: ID,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      // 供 tools/curve-test.mjs 直接验证生产实现（浏览器里不对外暴露）
  exports.__curve = {
    CURVE: CURVE, sanitizeBands: sanitizeBands, compressLog: compressLog, smoothStep: smoothStep,
    spatialSmoothInto: spatialSmoothInto, pchipSlopesInto: pchipSlopesInto, pchipAt: pchipAt,
    layoutPos: layoutPos, newShapeState: newShapeState, bandShape: bandShape, zeros: zeros, clamp: clamp,
    lerpAt: lerpAt, barMixOf: barMixOf, smoothBarsInto: smoothBarsInto, CURVE13: CURVE13
  };

  exports.inject = [];
      exports.apply = function (ctx) {
        try {
          if (global.__DSH_PULSE_RAIL__ && typeof global.__DSH_PULSE_RAIL__.dispose === 'function') {
            try { global.__DSH_PULSE_RAIL__.dispose(); } catch (e) { /* ignore */ }
          }
          var instance = createInstance();
          global.__DSH_PULSE_RAIL__ = instance;
          return function dispose() {
            try { instance.dispose(); } catch (e) { /* ignore */ }
            if (global.__DSH_PULSE_RAIL__ === instance) global.__DSH_PULSE_RAIL__ = null;
          };
        } catch (err) {
          console.error(TAG + ' apply failed: ' + ((err && err.stack) || err));
          return function () {};
        }
      };
      return module.exports;
    }
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
