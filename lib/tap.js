/**
 * dsh-pulse-rail — 宿主侧音频采集器封装。
 *
 * 纯 Node、无 cordis 依赖：只负责「起/停 pulse-tap.exe、解析它的 JSON 行、把最新一帧
 * 广播给订阅者」，因此可以在插件之外单独跑（tools/harness.mjs 与 tools/domtest 都用它）。
 *
 * 生命周期约定：
 *   · ensure() 是唯一入口——有人要数据才启动子进程；20s 没人问就自动停（不常驻抓音频）。
 *   · 子进程异常退出按退避重启；pulse-tap 自己会在端点持续静音时重建采集客户端。
 *   · stop()/dispose() 必须能被插件卸载路径安全地重复调用。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export class AudioTap {
  constructor(options = {}) {
    this.exePath = options.exePath || join(HERE, 'pulse-tap.exe');
    this.fps = options.fps || 30;
    this.attack = options.attack ?? 0.6;
    this.release = options.release ?? 0.15;
    this.idleMs = options.idleMs ?? 20000;
    this.stdinTimeoutMs = options.stdinTimeoutMs ?? 20000;   // 心跳超时：宿主每 5s 写一个字节，断供就自杀（防孤儿进程）
    this.log = options.log || (() => {});
    this.child = null;
    this.frame = null;
    this.hello = null;
    this.lastError = null;
    this.lastFrameAt = 0;
    this.lastUseAt = 0;
    this.startedAt = 0;
    this.restarts = 0;
    this.exits = 0;
    this.stderrTail = [];
    this._listeners = new Set();
    this._restartTimer = null;
    this._idleTimer = null;
    this._disposed = false;
  }

  onFrame(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 有人需要数据：保证子进程在跑，并刷新空闲计时。 */
  ensure() {
    if (this._disposed) return;
    this.lastUseAt = Date.now();
    if (!this.child) this._start();
    this._armIdle();
  }

  get running() {
    return !!this.child && (Date.now() - this.lastFrameAt) < 2000;
  }

  get playing() {
    const f = this.frame;
    if (!f || !this.running) return false;
    return (f.rms || 0) > 0.012 || (f.peak || 0) > 0.03;
  }

  snapshot() {
    return {
      running: this.running,
      playing: this.playing,
      ageMs: this.frame ? Date.now() - this.lastFrameAt : null,
      hello: this.hello,
      frame: this.frame,
      lastError: this.lastError,
      restarts: this.restarts,
      exits: this.exits,
      pid: this.child ? this.child.pid : null,
      stderrTail: this.stderrTail.slice(-3),
    };
  }

  _start() {
    if (this._disposed || this.child) return;
    const args = ['--fps', String(this.fps), '--attack', String(this.attack), '--release', String(this.release),
      '--watch-stdin', '--stdin-timeout', String(this.stdinTimeoutMs)];
    let child;
    try {
      child = spawn(this.exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.lastError = 'spawn failed: ' + err.message;
      this.log('spawn failed: ' + err.message, 'error');
      this._scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    const beat = setInterval(() => { try { child.stdin.write('.'); } catch { /* ignore */ } }, 5000);
    child.once('exit', () => clearInterval(beat));
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this._onLine(line));
    child.stderr.on('data', (buf) => {
      const text = String(buf).trim();
      if (!text) return;
      this.stderrTail.push(text.slice(0, 300));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.on('error', (err) => { this.lastError = 'child error: ' + err.message; });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.exits += 1;
      this.lastError = 'exited code=' + code + ' signal=' + signal;
      this.log('tap exited code=' + code + ' signal=' + signal, 'warn');
      if (!this._disposed) this._scheduleRestart();
    });
    this.log('tap started pid=' + child.pid + ' fps=' + this.fps);
  }

  _onLine(line) {
    const text = line.trim();
    if (!text || text[0] !== '{') return;
    let obj;
    try { obj = JSON.parse(text); } catch { return; }
    if (obj.type === 'hello') {
      this.hello = obj;
      this.lastError = null;
      this.log('tap hello rate=' + obj.rate + ' ch=' + obj.ch + ' bands=' + obj.bands);
      return;
    }
    if (obj.type === 'error') { this.lastError = obj.message; return; }
    if (Array.isArray(obj.b)) {
      this.frame = obj;
      this.lastFrameAt = Date.now();
      for (const fn of this._listeners) {
        try { fn(obj); } catch { /* 单个订阅者出错不影响其它 */ }
      }
    }
  }

  _scheduleRestart() {
    if (this._disposed || this._restartTimer) return;
    this.restarts += 1;
    const delay = Math.min(8000, 500 * Math.pow(2, Math.min(4, this.restarts - 1)));
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._disposed) return;
      if (Date.now() - this.lastUseAt > this.idleMs) return; // 已经没人要了，别再起
      this._start();
    }, delay);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  _armIdle() {
    if (this._idleTimer) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._disposed) return;
      if (Date.now() - this.lastUseAt >= this.idleMs) {
        this.log('tap idle ' + Math.round(this.idleMs / 1000) + 's — stopping');
        this.stop('idle');
      } else {
        this._armIdle();
      }
    }, this.idleMs);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  stop(reason = 'manual') {
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    const child = this.child;
    this.child = null;
    this.frame = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* ignore */ }
    const kill = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 400);
    if (kill.unref) kill.unref();
    child.once('exit', () => clearTimeout(kill));
    this.log('tap stopped (' + reason + ')');
  }

  dispose() {
    this._disposed = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this._listeners.clear();
    this.stop('dispose');
  }
}
