/**
 * 回归测试：导航条发现绝不能把 data-dpr-rail 打到对话区容器上。
 *
 * 复刻 v0.4.0 的线上事故现场：长会话（121 轮）时横条容器高度 = 121 轮 × 10px = 1210px，
 * 超过旧版 railLike() 里 "height > 1200" 的上限 → 真正的 marks 容器被排除，外层
 * <nav class="xpvNua_frame"> 被当成导航条 → tagRail() 顺着祖先链把标记打到对话滚动容器上
 * → 对话区被 CSS 压到 220px 宽并左移 192px（界面整体“偏移到左侧”）。
 *
 *   node tools/rail-target-test.mjs [client-bundle-path]
 *
 * 默认测 lib/client.js。传入旧版 bundle（例如 git show HEAD~1:lib/client.js > old.js）时应当失败，
 * 用来证明本测试确实覆盖了该缺陷。
 *
 * 断言：
 *   1. 页面里恰好一个 [data-dpr-rail="scroller"]，且它必须是导航条自己的 .xpvNua_scroller；
 *   2. 对话滚动容器 [data-conversation-scroll] 没有任何 data-dpr-rail，宽度保持 920px；
 *   3. 横条确实被接管（出现 [data-dpr-bar]），说明插件在该页面上真的跑了。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLIENT = resolve(process.argv[2] || process.env.DSH_PULSE_CLIENT || join(ROOT, 'lib', 'client.js'));

const TURNS = 121;              // 事故会话的轮次（121 × 10px = 1210px > 旧上限 1200px）
const RENDERED_BARS = 45;       // 导航条虚拟化后实际渲染的横条数（与线上 diag 一致）
const CONV_WIDTH = 920;         // 对话列宽度：任何情况下都不该被插件改动

if (!existsSync(CLIENT)) {
  console.error('client bundle not found: ' + CLIENT);
  process.exit(2);
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error('Microsoft Edge not found');
  process.exit(2);
}

function buildPage() {
  const bars = [];
  for (let i = 0; i < RENDERED_BARS; i++) {
    bars.push(
      '<button class="xpvNua_mark' + (i === RENDERED_BARS - 1 ? ' xpvNua_markActive' : '') + '"' +
      ' data-index="' + i + '" type="button" style="position:absolute;left:0;right:0;top:' + (i * 10) + 'px;height:10px;border:0;padding:0;background:none"></button>'
    );
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>pulse-rail target test</title><style>',
    'html,body{margin:0;height:100%;background:#151517;color:#c9c9cf;font:12px system-ui}',
    '#app{display:flex;height:100%}',
    '#sidebar{flex:0 0 280px;background:#101012}',
    '#main{flex:1;min-width:0;display:flex;justify-content:center}',
    '.ConversationRoot_scrollBody{position:relative;width:' + CONV_WIDTH + 'px;max-width:' + CONV_WIDTH + 'px;height:100%;overflow:hidden}',
    '.ViewHost{position:relative;width:100%;height:calc(100% - 120px)}',
    '.xz4KEq_frame{position:relative;width:100%;height:100%;display:flex;flex-direction:column}',
    '.xpvNua_slot{position:absolute;top:0;left:0;right:0;height:0;pointer-events:none}',
    '.xpvNua_frame{position:absolute;right:12px;top:300px;width:28px;height:420px;pointer-events:auto;background:#1b1b1f}',
    '.xpvNua_scroller{position:relative;width:28px;height:420px;max-height:420px;overflow-y:auto;overflow-x:hidden}',
    '.xpvNua_marks{position:relative;width:28px;height:' + (TURNS * 10) + 'px}',
    '.xpvNua_mark::before{content:"";position:absolute;right:0;top:50%;width:20px;height:2px;border-radius:2px;background:#fff3;transform:translateY(-50%) scaleX(.6);transform-origin:100%}',
    '.xz4KEq_root{flex:1;min-height:0;display:flex}',
    '.xz4KEq_scroll{flex:1;overflow:auto}',
    '.xz4KEq_column{padding:24px 32px}',
    '.composer{height:120px;border-top:1px solid #222;display:flex;align-items:center;justify-content:center}',
    '</style></head><body>',
    '<div id="app">',
    '  <div id="sidebar"></div>',
    '  <div id="main">',
    '    <div class="ConversationRoot_scrollBody" data-conversation-content data-conversation-scroll>',
    '      <div class="ViewHost">',
    '        <div class="xz4KEq_frame">',
    '          <div class="xpvNua_slot">',
    '            <nav class="xpvNua_frame" aria-label="turn rail">',
    '              <div class="xpvNua_scroller">',
    '                <div class="xpvNua_marks">' + bars.join('') + '</div>',
    '              </div>',
    '            </nav>',
    '          </div>',
    '          <div class="xz4KEq_root"><div class="xz4KEq_scroll"><div class="xz4KEq_column">chat transcript</div></div></div>',
    '        </div>',
    '      </div>',
    '      <div class="composer">composer</div>',
    '    </div>',
    '  </div>',
    '</div>',
    '<script>',
    'window.__ModuleLoader__={load:function(m){try{var exp=m.factory(function(){return {};});if(exp&&typeof exp.apply==="function"){window.__dispose=exp.apply({});}}catch(e){console.error("test load failed: "+e);}}};',
    '</script>',
    '<script src="/plugins/dsh-pulse-rail/client.js"></script>',
    '</body></html>',
  ].join('\n');
}

const PAGE = buildPage();
const STATE = JSON.stringify({
  ok: true, enabled: true, running: true, playing: true, ageMs: 0,
  frame: { rms: 0.35, b: [0.2, 0.5, 0.8, 0.6, 0.4, 0.3, 0.5, 0.7, 0.9, 0.6, 0.4, 0.3] },
  config: { enabled: true, minW: 1, maxW: 3, minH: 2, maxH: 2, gamma: 2, agcMix: 1, gate: 0.02, atkMs: 5, relMs: 200, silentMs: 200, bands: 12 },
});

const PORT = 8810 + Math.floor(Math.random() * 300);
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (path === '/plugins/dsh-pulse-rail/client.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(CLIENT, 'utf8'));
    return;
  }
  if (path === '/pulse-rail/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(STATE);
    return;
  }
  if (path === '/pulse-rail/diag') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG_PORT = 9340 + Math.floor(Math.random() * 300);

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('fixture: http://127.0.0.1:' + PORT + '/  turns=' + TURNS + ' renderedBars=' + RENDERED_BARS);
  console.log('client : ' + CLIENT);

  const userDataDir = mkdtempSync(join(tmpdir(), 'pr-target-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + userDataDir,
    '--window-size=1400,900', 'http://127.0.0.1:' + PORT + '/',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  edge.stderr.on('data', () => {});

  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
      page = list.find((t) => t.type === 'page' && String(t.url).indexOf('127.0.0.1:' + PORT) >= 0) || null;
    } catch { /* not up yet */ }
  }
  if (!page) throw new Error('no CDP page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      if (String(args).indexOf('dsh-pulse-rail') >= 0) console.log('[console] ' + String(args).slice(0, 240));
    }
  };
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const EXPR = '(function(){' +
    'var rail=document.querySelector(".xpvNua_scroller");' +
    'var sc=document.querySelectorAll("[data-dpr-rail=\\"scroller\\"]");' +
    'var tagged=[];var all=document.querySelectorAll("[data-dpr-rail]");' +
    'for(var i=0;i<all.length;i++)tagged.push(String(all[i].className)+" -> "+all[i].getAttribute("data-dpr-rail"));' +
    'var conv=document.querySelector("[data-conversation-scroll]");var cr=conv.getBoundingClientRect();' +
    'var rr=rail?rail.getBoundingClientRect():{width:0,left:0};' +
    'var bars=document.querySelectorAll("[data-dpr-bar]").length;' +
    'return JSON.stringify({scrollerCount:sc.length,scrollerIsRail:!!(sc.length===1&&rail&&sc[0]===rail),' +
    'tagged:tagged,convAttr:conv.getAttribute("data-dpr-rail"),convW:Math.round(cr.width),convLeft:Math.round(cr.left),' +
    'railW:Math.round(rr.width),railLeft:Math.round(rr.left),bars:bars,pulse:!!window.__DSH_PULSE_RAIL__});})()';

  let result = null;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const res = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    const raw = res && res.result && res.result.result && res.result.result.value;
    if (raw) {
      result = JSON.parse(raw);
      if (result.bars > 0) break;
    }
    await sleep(300);
  }

  try { ws.close(); } catch { /* ignore */ }
  edge.kill();
  server.close();

  if (!result) {
    console.log('FAIL: page produced no result');
    process.exit(1);
  }
  console.log('observed: ' + JSON.stringify(result));

  const problems = [];
  if (!result.pulse) problems.push('plugin instance did not mount (window.__DSH_PULSE_RAIL__ missing)');
  if (result.bars <= 0) problems.push('no [data-dpr-bar] — plugin did not take over the marks');
  if (result.scrollerCount !== 1) problems.push('expected exactly 1 [data-dpr-rail="scroller"], got ' + result.scrollerCount);
  else if (!result.scrollerIsRail) problems.push('[data-dpr-rail="scroller"] is not the rail scroller (targeted the wrong element)');
  if (result.convAttr !== null) problems.push('conversation scroll container was tagged: data-dpr-rail=' + result.convAttr);
  if (Math.abs(result.convW - CONV_WIDTH) > 1) problems.push('conversation width changed: ' + result.convW + 'px (expected ' + CONV_WIDTH + 'px)');

  if (problems.length) {
    console.log('FAIL');
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('PASS: rail scroller tagged only; conversation container untouched (' + result.convW + 'px)');
  process.exit(0);
}

main().catch((err) => {
  console.log('ERROR ' + ((err && err.stack) || err));
  try { server.close(); } catch { /* ignore */ }
  process.exit(1);
});
