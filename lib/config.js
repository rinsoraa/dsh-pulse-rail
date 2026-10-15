/**
 * dsh-pulse-rail — 配置读写。
 *
 * 配置文件放在 DSH 主目录下的 pulse-rail/config.json（默认 ~/.dsh/pulse-rail/config.json），
 * 与 wallpaper-engine 插件把数据放在 ~/.dsh-wallpaper-engine 同一思路：跨重启、跨端口稳定，
 * 且不写进插件目录（升级插件不丢设置）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CONFIG = {
  enabled: true,
  // —— 采集端（pulse-tap.exe）——
  fps: 30,            // 每秒输出帧数
  attack: 0.6,        // 频段包络：上升系数
  release: 0.15,      // 频段包络：下降系数
  tapIdleMs: 20000,   // 这么久没人要数据就停子进程（不常驻抓系统音频）
  // —— 可视化端（浏览器半侧）——
  minW: 0.18,         // 横条最短时的长度倍率（1 = 原始 20px；上限已解锁到 4 = 80px）
  maxW: 2.60,         // 最长时的倍率（面板可拉到 4）
  minH: 2,            // 横条最薄时的厚度（px，原始就是 2px）
  maxH: 7,            // 最厚时的厚度（px；横条间距 10px，别超过 8 否则会粘连）
  gamma: 0.60,        // 频段值曲线：<1 更「响」、>1 更克制
  agcMix: 0.60,       // 自适应对比：每个频段跟自己的慢基线比（0 = 只看绝对电平，差别小；1 = 只看变化量，最猛）
  gate: 0.02,         // 噪声门（低于此值的频段算静音）
  atkMs: 35,          // 横条跟随上升的时间常数（越小越跟拍）
  relMs: 120,         // 下降
  silentMs: 450,      // 超过这么久没有新音频帧 ⇒ 回到原始外观
  freqLayout: 'center', // 频谱方向：top=高频在上（低频在下端）/ center=高频居中（两端低频）/ down=高频在下
  bands: 12,          // 与 pulse-tap 的 --bands 一致
};

export function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_CONFIG_HOME || join(homedir(), '.dsh');
}

export function dataDir() {
  return join(dshHome(), 'pulse-rail');
}

export function configPath() {
  return join(dataDir(), 'config.json');
}

export function loadConfig() {
  const merged = Object.assign({}, DEFAULT_CONFIG);
  try {
    const p = configPath();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (raw && raw[key] !== undefined) merged[key] = raw[key];
      }
    }
  } catch { /* 配置坏了就用默认值，不影响加载 */ }
  return merged;
}

export function saveConfig(next) {
  const merged = Object.assign(loadConfig(), next || {});
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  return merged;
}
