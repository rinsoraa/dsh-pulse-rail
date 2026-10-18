/**
 * 在 Node 里加载浏览器半侧 bundle（lib/client.js）并取出它的导出。
 *
 * client.js 是手写的 lazy-CJS bundle：外层 IIFE 调 window.__ModuleLoader__.load({ id, factory })，
 * factory(require) 返回 module.exports。这里用最小 stub 顶掉 window/react，就能拿到同一份
 * 生产实现的纯函数（exports.__curve），测试不需要另写一套算法。
 */
import { readFileSync } from 'node:fs';

export function loadClient(file) {
  const src = readFileSync(file, 'utf8');
  let exportsObj = null;
  const requireStub = (name) => {
    if (name === 'react') return { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
    return {};
  };
  const stubWindow = {
    __ModuleLoader__: {
      load(entry) { exportsObj = entry.factory(requireStub); }
    },
    document: { querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }) },
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    location: { href: 'http://127.0.0.1/' },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    performance: { now: () => Date.now() }
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'self', 'document', 'globalThis', src);
  fn(stubWindow, stubWindow, stubWindow.document, stubWindow);
  if (!exportsObj) throw new Error('client.js did not register a module');
  return exportsObj;
}
