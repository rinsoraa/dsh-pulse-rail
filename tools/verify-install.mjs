/**
 * 安装后自检：直接对 profile 里已安装的副本做「路由注册 + 采集器出帧」两项冒烟测试。
 *   node tools/verify-install.mjs
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const INSTALLED = 'C:\\Users\\HP\\.dsh\\profiles\\desktop\\node_modules\\dsh-pulse-rail';
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

// 1) 宿主半侧能加载并注册全部路由
const mod = await import(pathToFileURL(join(INSTALLED, 'lib', 'index.js')).href);
ok(typeof mod.apply === 'function', 'lib/index.js 导出 apply()');
ok(JSON.stringify(mod.inject) === '["webServer"]', 'inject = ["webServer"]  -> ' + JSON.stringify(mod.inject));
const routes = [];
const dispose = mod.apply({
  webServer: { register(r) { routes.push(r.kind + ' ' + r.path); return () => {}; } },
  logger: () => ({ info() {}, warn() {}, error() {} }),
});
ok(routes.length === 5, '注册了 5 条路由: ' + JSON.stringify(routes));
ok(typeof dispose === 'function', 'apply 返回卸载函数');

// 2) 采集器能起来并出帧（不需要真有声音，只要帧结构正确）
const exe = join(INSTALLED, 'lib', 'pulse-tap.exe');
const child = spawn(exe, ['--fps', '20', '--watch-stdin'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
let hello = null, frames = 0, bands = 0;
child.stdout.setEncoding('utf8');
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith('{')) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'hello') hello = obj;
    else if (Array.isArray(obj.b)) { frames++; bands = obj.b.length; }
  }
});
await new Promise((r) => setTimeout(r, 2500));
try { child.stdin.end(); } catch {}
try { child.kill(); } catch {}
ok(!!hello && hello.rate > 0, 'pulse-tap hello: ' + JSON.stringify(hello));
ok(frames > 5, '出帧数=' + frames + ' (期望 > 5)');
ok(bands === 12, '频段数=' + bands);

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
