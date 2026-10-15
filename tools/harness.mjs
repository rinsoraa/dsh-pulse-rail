/**
 * 离线验证台：不启动 DSH，也能把「音频 → 宿主路由 → 浏览器半侧 → 横条宽度」整条链路跑一遍。
 *
 *   node tools/harness.mjs [port]
 *
 * - 用真实的 lib/tap.js + lib/pulse-tap.exe 采系统音频；
 * - 页面复刻轮次导航条的真实 DOM/CSS（类名、10px 间距、::before 的 20x2 横条、scaleX 状态），
 *   并每 2.5s 随机改变横条数量（1..42）来复现「轮次增长」；
 * - 页面每 500ms 把每根横条的**实测宽度**上报到 /report，由本进程打到 stdout，
 *   因此律动是否真的发生、横条数变化后是否仍然律动，都能从文本日志判定。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioTap } from '../lib/tap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.argv[2] || 8791);

const tap = new AudioTap({ log: (m) => console.log('[tap] ' + m), fps: 30 });
const reports = [];
let reportCount = 0;

import { PAGE } from './page.mjs';


function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (path !== '/pulse-rail/state' && path !== '/report') console.log('[req] ' + (req.method || 'GET') + ' ' + path);
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (path === '/plugins/dsh-pulse-rail/client.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'));
    return;
  }
  if (path === '/pulse-rail/state') {
    tap.ensure();
    const snap = tap.snapshot();
    json(res, 200, { ok: true, enabled: true, running: snap.running, playing: snap.playing, ageMs: snap.ageMs, frame: snap.frame, hello: snap.hello, config: { enabled: true, minW: 0.45, maxW: 1.35, gamma: 1.1, gate: 0.05, atkMs: 40, relMs: 130, silentMs: 450, bassAtBottom: true, bands: 12 } });
    return;
  }
  if (path === '/pulse-rail/diag') {
    if ((req.method || 'GET').toUpperCase() === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        console.log('[diag] ' + body.slice(0, 400));
        json(res, 200, { ok: true });
      });
      return;
    }
    json(res, 200, { ok: true, count: 0 });
    return;
  }
  if (path === '/report') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reportCount += 1;
      let obj = null;
      try { obj = JSON.parse(body); } catch { obj = { raw: body.slice(0, 120) }; }
      reports.push(obj);
      if (reports.length > 200) reports.shift();
      console.log('#' + reportCount + ' n=' + obj.n + ' min=' + (obj.min || 0).toFixed(1) + ' max=' + (obj.max || 0).toFixed(1) +
        ' w=' + (obj.w || []).slice(0, 6).map((x) => Number(x).toFixed(1)).join(',') + (obj.event && obj.event !== 'tick' ? ' [' + obj.event + ']' : ''));
      json(res, 200, { ok: true });
    });
    return;
  }
  if (path === '/reports') { json(res, 200, { count: reportCount, reports }); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('harness on http://127.0.0.1:' + PORT + '/');
});

process.on('SIGINT', () => { tap.dispose(); process.exit(0); });
