/**
 * dsh-pulse-rail — 宿主半侧（cordis 插件）。
 *
 * 职责：把「系统输出音频的实时频谱」变成一个同源 HTTP 接口，供浏览器半侧取用；
 * 采集本身由 lib/pulse-tap.exe（WASAPI loopback + FFT）完成，本文件只管生命周期与路由。
 *
 * 路由（都在 /pulse-rail 前缀下，同源，无需自建端口）：
 *   GET  /pulse-rail/state    → 最新一帧 + 运行状态 + 配置（浏览器半侧 30Hz 轮询它）
 *   GET  /pulse-rail/config   → 读配置
 *   POST /pulse-rail/config   → 合并写配置（下一次帧即生效）
 *   GET  /pulse-rail/diag     → 浏览器半侧上报的诊断（在页面里看不到控制台时用它）
 *   POST /pulse-rail/diag     → 追加一条诊断
 *   POST /pulse-rail/restart  → 重启采集子进程（排障用）
 *
 * 不变量：没人问就不抓音频（懒启动 + 20s 空闲自停）；所有路由注册句柄都推进 disposers，
 * 卸载/重挂后不留悬挂处理器，也不留还活着的子进程。
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AudioTap } from './tap.js';
import { dataDir, loadConfig, saveConfig, configPath } from './config.js';

export const name = 'pulse-rail';
export const inject = ['webServer'];

const BASE = '/pulse-rail';

function sendJson(res, code, obj) {
  let body;
  try { body = JSON.stringify(obj); } catch { body = '{"ok":false,"error":"serialize"}'; }
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { resolve(null); try { req.destroy(); } catch { /* ignore */ } return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function apply(ctx) {
  const webServer = ctx && ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const logger = typeof ctx.logger === 'function' ? ctx.logger('pulse-rail') : ctx.logger;
  const log = (msg, level) => {
    try {
      if (!logger) return;
      const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
      if (typeof fn === 'function') fn.call(logger, msg);
      else if (typeof logger.info === 'function') logger.info(msg);
    } catch { /* 日志失败绝不影响功能 */ }
  };

  let config = loadConfig();
  const tap = new AudioTap({
    log,
    fps: config.fps,
    attack: config.attack,
    release: config.release,
    idleMs: config.tapIdleMs,
  });
  const disposers = [];
  const diag = { count: 0, last: null, lastAt: 0, notes: [] };

  log('host half ready (config=' + configPath() + ')');

  const stateHandler = (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') { res.statusCode = 405; res.end('method not allowed'); return; }
    if (!config.enabled) { sendJson(res, 200, { ok: true, enabled: false, running: false, playing: false, frame: null, config }); return; }
    tap.ensure();
    const snap = tap.snapshot();
    sendJson(res, 200, {
      ok: true,
      enabled: true,
      running: snap.running,
      playing: snap.playing,
      ageMs: snap.ageMs,
      frame: snap.frame,
      hello: snap.hello,
      restarts: snap.restarts,
      lastError: snap.lastError,
      config,
    });
  };

  const diagHandler = async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') { sendJson(res, 200, { ok: true, count: diag.count, last: diag.last, lastAt: diag.lastAt }); return; }
    if (method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }
    const raw = await readBody(req);
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { parseError: String(raw).slice(0, 200) }; }
    if (!payload) { sendJson(res, 200, { ok: false }); return; }
    diag.count += 1;
    diag.last = payload;
    diag.lastAt = Date.now();
    const summary = 'bars=' + payload.bars + ' found=' + payload.found + ' src=' + payload.source +
      (payload.error ? ' error=' + String(payload.error).slice(0, 160) : '');
    if (summary !== diag.notes[0]) {
      diag.notes.unshift(summary);
      if (diag.notes.length > 20) diag.notes.pop();
      log('client diag: ' + summary);
    }
    try {
      mkdirSync(dataDir(), { recursive: true });
      const file = join(dataDir(), 'diag.jsonl');
      let size = 0;
      try { size = statSync(file).size; } catch { size = 0; }
      if (size > 262144) writeFileSync(file, '', 'utf8');   // 上限 256KB，超了从头写，避免无限增长
      appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
    } catch { /* ignore */ }
    sendJson(res, 200, { ok: true, count: diag.count });
  };

  const configHandler = async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') { sendJson(res, 200, { ok: true, config, path: configPath() }); return; }
    if (method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }
    const raw = await readBody(req);
    let patch = null;
    try { patch = raw ? JSON.parse(raw) : null; } catch { patch = null; }
    if (!patch || typeof patch !== 'object') { sendJson(res, 400, { ok: false, error: 'bad json' }); return; }
    config = saveConfig(patch);
    tap.fps = config.fps;
    tap.attack = config.attack;
    tap.release = config.release;
    tap.idleMs = config.tapIdleMs;
    if (patch.fps !== undefined || patch.attack !== undefined || patch.release !== undefined) tap.stop('config');
    log('config updated: ' + JSON.stringify(patch));
    sendJson(res, 200, { ok: true, config });
  };

  const restartHandler = async (req, res) => {
    if ((req.method || 'GET').toUpperCase() !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }
    tap.stop('restart-request');
    tap.ensure();
    sendJson(res, 200, { ok: true, snapshot: tap.snapshot() });
  };

  const healthHandler = (req, res) => {
    sendJson(res, 200, { ok: true, plugin: 'dsh-pulse-rail', config, snapshot: tap.snapshot() });
  };

  const routes = [
    { kind: 'exact', path: BASE + '/state', handler: stateHandler },
    { kind: 'exact', path: BASE + '/health', handler: healthHandler },
    { kind: 'prefix', path: BASE + '/diag', handler: diagHandler },
    { kind: 'exact', path: BASE + '/config', handler: configHandler },
    { kind: 'exact', path: BASE + '/restart', handler: restartHandler },
  ];
  for (const route of routes) {
    try {
      const dispose = webServer.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      log('route register failed ' + route.path + ': ' + err.message, 'error');
    }
  }

  return () => {
    for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
    disposers.length = 0;
    tap.dispose();
  };
}

export default { name, inject, apply };
