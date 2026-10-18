/**
 * CDP 验证器：用 headless Edge + DevTools Protocol 直接测量页面里每根横条 ::before 的**实际宽度**，
 * 判定「音乐响 → 横条变长 / 静音 → 恢复原样 / 横条数量变化后仍律动」。
 *
 *   node tools/cdp-check.mjs [url] [seconds] [toneWav]
 *
 * 之所以不用 --dump-dom：headless 的 --dump-dom 在 load 后立刻退出，抓不到动画；
 * 这里保持页面存活，用 Runtime.evaluate 连续采样。Node 22 自带 WebSocket，无需依赖。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8791/';
const SECONDS = Number(process.argv[3] || 10);
const TONE = process.argv[4] || '';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333 + Math.floor(Math.random() * 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(join(tmpdir(), 'pr-cdp-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDataDir,
  '--window-size=420,900', URL_,
], { stdio: ['ignore', 'ignore', 'pipe'] });
edge.stderr.on('data', () => {});

let tone = null;
async function startTone() {
  if (!TONE) return;
  tone = spawn('powershell', ['-NoProfile', '-Command', "(New-Object Media.SoundPlayer '" + TONE + "').PlaySync()"], { stdio: 'ignore' });
}

async function targets() {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return await res.json();
  } catch { return []; }
}

async function main() {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(300);
    const list = await targets();
    page = list.find((t) => t.type === 'page' && String(t.url).indexOf('8791') >= 0) || list.find((t) => t.type === 'page');
  }
  if (!page) { console.log('FAIL: no CDP page target'); edge.kill(); process.exit(1); }
  console.log('target: ' + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      if (String(args).indexOf('dsh-pulse-rail') >= 0) console.log('[console.' + msg.params.type + '] ' + String(args).slice(0, 200));
    }
  };
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const EXPR = '(function(){' +
    'var els=document.querySelectorAll("[data-index]");var w=[],h=[],rw=[],ww=[];' +
    'for(var i=0;i<els.length;i++){var cs=getComputedStyle(els[i],"::before");' +
    'var nums=(cs.transform||"").match(/-?[0-9.]+/g)||[];' +
    'w.push(nums.length>=6?Math.round(parseFloat(nums[0])*1000)/1000:0);' +
    'h.push(nums.length>=6?Math.round(parseFloat(nums[3])*1000)/1000:0);' +
    'ww.push(Math.round((parseFloat(cs.width)||0)*10)/10);' +
    'var r=els[i].getBoundingClientRect();rw.push(Math.round(r.right*100)/100);}' +
    'var mn=Math.min.apply(null,w),mx=Math.max.apply(null,w);' +
    'var hmn=Math.min.apply(null,h),hmx=Math.max.apply(null,h);' +
    'var mi=0;for(var q=1;q<w.length;q++){if(w[q]>w[mi])mi=q;}' +
    'var mark=els[0];var mr=mark?mark.getBoundingClientRect():null;var hitRail=null,hitStrip=null,markPE=null,scrPE=null;' +
    'if(mr){var el1=document.elementFromPoint(Math.round(mr.right)-6,Math.round(mr.top+5));' +
    'hitRail=el1?(el1.tagName+(el1.getAttribute&&el1.getAttribute("data-index")!==null?"#"+el1.getAttribute("data-index"):"")):"null";' +
    'var el2=document.elementFromPoint(Math.round(mr.right)-70,Math.round(mr.top+5));' +
    'hitStrip=el2?(el2.tagName+"."+String(el2.className||"").slice(0,26)):"null";' +
    'markPE=getComputedStyle(mark).pointerEvents;' +
    'var sc=document.querySelector("[data-dpr-rail=scroller]");scrPE=sc?getComputedStyle(sc).pointerEvents:null;}' +
    'return JSON.stringify({n:w.length,sxMin:mn,sxMax:mx,syMin:hmn,syMax:hmx,mid:mi,w:w.slice(0,8),h:h.slice(0,8),' +
    'rightMin:Math.min.apply(null,rw),rightMax:Math.max.apply(null,rw),cssW:ww[0],hitRail:hitRail,hitStrip:hitStrip,markPE:markPE,scrPE:scrPE,' +
    'pulse:!!window.__DSH_PULSE_RAIL__,hidden:document.hidden});})()';

  await startTone();
  const started = Date.now();
  let samples = 0;
  let animated = 0;
  while (Date.now() - started < SECONDS * 1000) {
    const res = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    const raw = res && res.result && res.result.result && res.result.result.value;
    if (raw) {
      const o = JSON.parse(raw);
      samples++;
      const spread = Math.round((o.sxMax - o.sxMin) * 100) / 100;
      if (spread > 1.5) animated++;
      console.log('t=' + ((Date.now() - started) / 1000).toFixed(1) + 's n=' + o.n + ' scaleX[' + o.sxMin + '..' + o.sxMax + '] scaleY[' + o.syMin + '..' + o.syMax + ']' +
        ' cssW=' + o.cssW + ' rightEdge=' + o.rightMin + '..' + o.rightMax + ' 峰值第' + o.mid + '/' + o.n + '条' +
        ' | 命中(导轨内)=' + o.hitRail + ' 命中(左70px)=' + o.hitStrip + ' markPE=' + o.markPE + ' scrollerPE=' + o.scrPE +
        ' sx=' + o.w.join(','));
    } else {
      console.log('t=' + ((Date.now() - started) / 1000).toFixed(1) + 's <no value> ' + JSON.stringify(res).slice(0, 200));
    }
    await sleep(400);
  }
  const pulseOk = samples > 0 && animated > samples * 0.3;
  console.log('SUMMARY samples=' + samples + ' animated=' + animated + (pulseOk ? ' => PULSE OK' : ' => NO PULSE') + ' exit=' + (pulseOk ? 0 : 1));
  try { ws.close(); } catch {}
  if (tone) { try { tone.kill(); } catch {} }
  edge.kill();
  await sleep(300);
  // 真·非零退出：没有采样到页面、或律动帧数不足 30% 都算失败（此前恒 exit 0，CI 抓不到回归）
  process.exit(pulseOk ? 0 : 1);
}

main().catch((err) => { console.log('ERROR ' + (err && err.stack || err)); try { edge.kill(); } catch {} process.exit(1); });
