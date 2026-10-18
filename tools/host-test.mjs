/**
 * 真·宿主半侧集成测试：用「最小 webServer 实现 + 真实 lib/index.js」跑一遍，
 * 验证路由注册契约（kind/path/handler、register 返回 disposer）、/pulse-rail/* 处理函数、
 * 采集器生命周期，以及浏览器半侧对真实 /pulse-rail/state 的消费。
 *
 *   node tools/host-test.mjs [port]
 *
 * 然后配 tools/cdp-check.mjs 使用（它负责打开页面并测量横条宽度）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE } from './page.mjs';
import * as host from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.argv[2] || 8792);
// A/B 基准用：DSH_PULSE_CLIENT=<绝对路径> 时改发该 client bundle（默认仍是 ../lib/client.js）
const CLIENT = process.env.DSH_PULSE_CLIENT ? resolve(process.env.DSH_PULSE_CLIENT) : join(ROOT, 'lib', 'client.js');

const routes = [];
const webServer = {
  register(route) {
    const row = { kind: route.kind || 'exact', path: route.path, handler: route.handler };
    routes.push(row);
    console.log('[webServer] register ' + row.kind + ' ' + row.path);
    return () => {
      const idx = routes.indexOf(row);
      if (idx >= 0) routes.splice(idx, 1);
      console.log('[webServer] dispose ' + row.path);
    };
  },
};

const logger = (tag) => ({
  info: (m) => console.log('[info][' + tag + '] ' + m),
  warn: (m) => console.log('[warn][' + tag + '] ' + m),
  error: (m) => console.log('[error][' + tag + '] ' + m),
});

console.log('host exports: ' + Object.keys(host).join(',') + ' inject=' + JSON.stringify(host.inject));
const dispose = host.apply({ webServer, logger });
console.log('routes after apply: ' + routes.length);

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (path === '/plugins/dsh-pulse-rail/client.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(readFileSync(CLIENT, 'utf8'));
    return;
  }
  if (path === '/report') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let o = {};
      try { o = JSON.parse(body); } catch { o = { raw: body.slice(0, 80) }; }
      console.log('#report n=' + o.n + ' min=' + o.min + ' max=' + o.max + ' w=' + (o.w || []).slice(0, 6).join(',') + (o.event && o.event !== 'tick' ? ' [' + o.event + ']' : ''));
      res.writeHead(200); res.end('{}');
    });
    return;
  }
  for (const row of routes) if (row.kind === 'exact' && row.path === path) { row.handler(req, res); return; }
  for (const row of routes) if (row.kind === 'prefix' && path.indexOf(row.path) === 0) { row.handler(req, res); return; }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => console.log('host-test on http://127.0.0.1:' + PORT + '/  client=' + CLIENT));

process.on('SIGINT', () => { try { dispose(); } catch {} server.close(); process.exit(0); });
