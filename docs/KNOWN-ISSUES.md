# 已知问题

## 1. 滚动后部分导航柱失去律动（open）

**现象**：会话很长（导航条柱子很多）时向上滚动，顶部一部分柱子不再随音乐律动；滚回原位置后恢复。

**实测数据**（用户环境，45–49 根柱）：
```
STATIC_COUNT=30/49 claimed=19
staticIdx=21(未接管) … 50(未接管)   cls=xpvNua_mark xpvNua_markUnloaded
```

**定位过程**：
1. 页面只有一个 `.xpvNua_marks` 容器（28×1162，含全部 49 根）；
2. 插件日志显示 `sync bars=49` —— 插件能看到全部柱子；
3. 但渲染循环里有 `if (!el.isConnected || el.__dprIdx !== b) { scanNow("stale"); return; }`：
   虚拟化导致 DOM 顺序/连接状态抖动时，**整帧被丢弃**，排在后面的柱子就写不到 `--dpr-w`；
4. 每次 `sync` 都会 `console.error` 上报，DOM 抖动越频繁 → 日志越多 → 越卡。

**已尝试**（均未彻底解决）：容器复用校验、多容器合并、子元素数变化重扫、断连柱 skip、
`__dprIdx` 不匹配改 continue + 帧末重扫、`sync` 不再每次上报。

**下一步方向**：去掉对 `__dprIdx` 的依赖 —— 扫描后按 `data-index` 排序，逐根按位置写值，
不再因为索引对不上而中断整帧；并在隔离实例里用 45+ 根会话复现验证后再发布。

**影响**：视觉不连续，但不影响功能正确性；不写配置、不破坏 rail 结构。

## 2. 控制台刷 `[dsh-pulse-rail] sync …`（open，历史遗留）

滚动/播放时 `sync` 高频触发，每次 `console.error` 上报到控制台。经用户确认，**在引入 Silk Wave 之前的版本即已存在**。
当前版本已将 `sync` 从「每次都上报」改为节流上报，频率已降低，但未完全消除。

## 3. 事故记录：0.3.x 测试期一次渲染循环损坏

开发测试期曾把 `rafId = window.requestAnimationFrame(loop);` 误拆为两行，导致每帧 `ReferenceError: d is not defined`、律动完全失效。
该问题**只存在于未发布的测试 bundle**，已在发布前修复并通过 `node --check`。教训：补丁必须带足够上下文锚点，且语法校验不通过绝不安装。

