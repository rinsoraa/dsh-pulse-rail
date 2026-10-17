# dsh-pulse-rail

[English](README.md) | 中文

把 DeepSeek Harness 的**轮次导航条**变成音乐可视化：右缘那一列细横条会随正在播放的系统声音变长、变粗。

![导航条律动](docs/rail-pulse.png)

|  |  |
|---|---|
| ![设置面板](docs/settings-panel.png) | 左下角用户信息正上方有一个 ♪ 按钮，点开是滑动条面板；任何改动都会立刻写回 `config.json`，**不用重启**。 |

- **Windows 平台、无需管理员权限、不装驱动、无第三方运行时**：用 WASAPI **共享模式 loopback**
  抓默认播放设备的混音，采集由自带的小程序完成（`lib/pulse-tap.exe`，源码 `lib/pulse-tap.cs`，
  用系统自带的 .NET Framework csc 编译）。
- **只动横条本身**：长度对应各自的频段能量，厚度跟着节拍走；没有发光、没有颜色、没有阴影 —— 纯几何，
  而且全部是只走合成层的 `transform: scale()`，所以右缘不会抖。
- **不破坏原生交互**：悬停预览、点击跳转、超出可视条数时的滚轮滚动全都照旧；没有声音时横条
  逐像素回到应用原本的样子。

## 环境要求

| | |
|---|---|
| DSH | 桌面端 / web profile（客户端半侧声明 `platform: web`） |
| 操作系统 | Windows 10/11 x64（WASAPI loopback） |
| 运行时 | 无 —— `.NET Framework 4.x` 的 csc 只用于**编译**采集器 |
| 音频 | 任意默认播放设备（耳机 / USB DAC / HDMI 均可） |

## 安装

### A. 走插件管理器（推荐）

1. **设置 → 插件 → 添加插件**，填入本仓库地址（或本地克隆目录的绝对路径）。
2. 启用后**重启 DSH**（宿主半侧在启动时组合）。

> 管理器在有 agent 运行时拒绝安装，请在空闲会话里操作。

### B. 从 npm 安装

已发布为 [`dsh-pulse-rail`](https://www.npmjs.com/package/dsh-pulse-rail)：

```sh
dsh plugin add dsh-pulse-rail      # 或 npm i dsh-pulse-rail
```

### C. 手动安装（本插件开发时的做法）

```bat
git clone https://github.com/<you>/dsh-pulse-rail.git
xcopy /E /I dsh-pulse-rail "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pulse-rail"
```

然后把 `"dsh-pulse-rail"` 加进 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles`，并重启 DSH：

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-pulse-rail"
  ] } }
}
```

（顺便把它加进同级 `dependencies`，这样它会出现在「已安装插件」列表里，也不会被后续的
`pnpm install` 当作多余目录清掉。）

## 调参

所有参数在 `%USERPROFILE%\.dsh\pulse-rail\config.json`；可以从 ♪ 面板改，也可以手改后运行自带的小工具应用：

```bat
%USERPROFILE%\.dsh\pulse-rail\tune-config.cmd
```

```jsonc
{
  "enabled": true,      // false = 立刻停效果、导航条恢复原样
  "minW": 0.18,         // 最短横条（单位：应用原始的 20px 长度）
  "maxW": 2.6,          // 最长横条（面板滑动条可以拉到 4 = 80px）
  "minH": 2,            // 最薄厚度（px，应用原始就是 2）
  "maxH": 7,            // 最厚厚度（px；横条间距 10px，别超过 8）
  "gamma": 0.6,         // 响应曲线：<1 更猛，>1 更克制
  "gate": 0.02,         // 噪声门：低于此值的频段算静音
  "agcMix": 0.6,        // 动态对比：每个频段跟自己的慢基线比，解决「长度看不出差别」
  "atkMs": 35,          // 横条上升 / 下降时间常数
  "relMs": 120,
  "silentMs": 450,      // 多久没有音频就恢复原样
  "freqLayout": "center",// top=高频在上 / center=高频居中（两端低频）/ down=高频在下
  "fps": 30,            // 采集帧率
  "tapIdleMs": 20000    // 采集器空闲多久自停
}
```

不编辑文件的热改方式（端口取 `DSH_WEB_URL` 里的那个）：

```powershell
Invoke-WebRequest -UseBasicParsing -Method POST -ContentType 'application/json' `
  -Body (Get-Content -Raw $env:USERPROFILE\.dsh\pulse-rail\config.json) `
  http://127.0.0.1:19387/pulse-rail/config
```

| 想要 | 改哪个 |
|---|---|
| 更夸张 | `maxW` → 3~4，`agcMix` → 0.8~1.0 |
| 更克制 | `agcMix` → 0.3，`gate` → 0.05~0.1 |
| 厚度更猛 | `maxH` → 8（再多就会上下粘连） |
| 更跟拍 | `atkMs` → 15~25 |

## 工作原理

```
默认播放设备
   │  WASAPI 共享模式 loopback（48 kHz、N 声道、float32）
   ▼
lib/pulse-tap.exe ── 1024 点 FFT ──► 12 个对数频段（45 Hz – 15 kHz）
   │  每帧一行 JSON，30 fps
   ▼
宿主半侧（lib/index.js） ──  GET /pulse-rail/state  ──►  浏览器半侧（lib/client.js）
                                 │                          │
                                 │                          └─ 定位导航条，把 12 个频段映射到
                                 │                             「当前实际渲染出来的横条数」上
                                 └─ /pulse-rail/config、/pulse-rail/health、/pulse-rail/diag
```

* **宿主半侧**（`lib/index.js` + `lib/tap.js`）：懒启动采集子进程、缓存最后一帧、用同源 HTTP 路由提供数据。
  20 秒没有请求就停掉采集器；异常退出按退避重启；宿主停止心跳时自己退出（防止产生孤儿进程）。
* **浏览器半侧**（`lib/client.js`）：按几何特征定位导航条（右缘、窄容器、小横条；类名换版时有
  `button[data-index]` 兜底），每帧按**当前渲染的横条数**重算映射，然后只写一个自定义属性。
  长度和厚度都通过横条 `::before` 的 `transform: scale()` 表达，`transform-origin: 100% 50%`。
  由于应用的滚动容器横向把内容裁在 28px 内，插件会把该容器向左加宽（右缘不动、命中区域不变、
  `pointer-events` 透传），这样长横条才真的画得出来。
* **静音**时移除全部覆盖 —— 导航条回到应用自己的渲染。

## 隐私与开销

采集器只在**内存里**读取系统混音，输出只有 12 个频段电平加 RMS/峰值；不录音、不缓存、不落盘。
它只在页面请求数据时运行，最后一次请求后 20 秒自行停止；任务管理器里能看到 `pulse-tap.exe`，
也可以把 `enabled` 设为 `false` 彻底关掉。

## 排障

| | |
|---|---|
| `GET /pulse-rail/health` | 采集器状态（running / playing / pid / 重启次数 / 最近错误） |
| `POST /pulse-rail/restart` | 重启采集子进程 |
| `GET /pulse-rail/diag` | 浏览器半侧最近的发现结果 |
| `%USERPROFILE%\.dsh\pulse-rail\diag.jsonl` | 浏览器半侧诊断日志（超过 256KB 会重写） |
| `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` | 渲染进程 `console.error`（例如 `[dsh-pulse-rail] …`） |
| `lib\pulse-tap.exe --fps 30` | 手动跑采集器看 JSON 流 |

横条不动？先放点声音，再看 `/pulse-rail/state` 的 `playing`。如果 `running` 是 false，看 `lastError`
（某些 USB/蓝牙端点会「假装在放、实际全 0」，插件会在持续静音 5 秒后自动重建采集客户端）。

## 开发 / 自检

| 工具 | 用途 |
|---|---|
| `tools/verify-install.mjs` | 最快自检：路由注册 + 采集器出帧 |
| `tools/harness.mjs`（+`page.mjs`） | 离线验证台：复刻导航条 DOM/CSS，上报每根横条的实测几何 |
| `tools/host-test.mjs` | 用最小 `webServer` 实现跑**真实** `lib/index.js` |
| `tools/cdp-check.mjs` | headless Edge + CDP：采样 `::before` 的 transform、右缘对齐、命中测试 |
| `tools/mktone.py`、`tools/mkmusic.py` | 生成测试音 / 伪音乐 |

改了 `pulse-tap.cs` 之后重新编译采集器：

```bat
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /platform:x64 /optimize+ ^
  /out:lib\pulse-tap.exe lib\pulse-tap.cs
```

## 卸载

1. 从 `dsh.profile.bundles`（以及 `dependencies`）里删掉 `"dsh-pulse-rail"`；
2. 删除 `node_modules\dsh-pulse-rail`；
3. 需要的话删掉 `%USERPROFILE%\.dsh\pulse-rail\`；
4. 重启 DSH。

## 许可

MIT，见 [LICENSE](LICENSE)。
