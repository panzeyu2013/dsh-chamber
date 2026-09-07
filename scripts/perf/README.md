# scripts/perf — 性能实测工具（T0 场景表 / 整改前后对照）

本目录是 dsh-chamber 性能整改的实机测量工具箱。全部为**零新依赖**的纯 Node
（`ws` 复用 control-plane 包依赖解析，`node:` 内置模块 + node 24 类型擦除直跑
TS）。**「只读」措辞的精确含义**（2026-09 review nit6）：脚本不修改被测应用的
数据/存储，但会**改变被测页面运行时**——boot/eval/switch 经 CDP 向页面注入
`window.__dshPerf` 标记并注册 `PerformanceObserver`（longtask/layout-shift/
paint/resource，buffered），boot/eval 每个 run 还执行 `Page.reload`（switch
为合成点击驱动切换）；仅 `disk-walk-baseline.mjs` 跑在合成 fixture 上、完全
不触被测应用。

| 文件 | 用途 |
|---|---|
| `cdp-lib.mjs` | CDP 公共库：target 发现、ws 连接、早期性能观察者注入（longtask/layout-shift/paint/resource，buffered）、状态轮询（单次 evaluate 4s 超时守卫）、`__dshPerf` 汇总 |
| `boot-measure.mjs` | 场景① 启动（骨架 → 内容）：`Page.reload` 冷启 ×N，记录长任务/CLS/区间 |
| `switch-measure.mjs` | 场景② 跨来源切换 / 场景③ 连点 ×N（热切换面；见 performance-baseline.md §3） |
| `eval-measure.mjs` | T6/H3 归因探针：每 run 新建 CDP 连接（导航竞态下旧 ws 会挂起）→ reload → 长任务 + JS 资源清单 |
| `disk-walk-baseline.mjs` | T3 磁盘统计曲线：合成 .pnpm-store 形态 fixture（深层嵌套/符号链接/硬链接去重面）上同步 vs 异步实现描点（`--async` 切换测量目标） |
| `measure-ui.mjs` | **稳态基线尺子**（2026 性能整改验收）：附加运行中实例，采 DOM 节点/挂载视图数/JS 堆基数 + 空闲 N 秒长任务 + 合成输入帧间隔 + 可选 5s CPU profile，输出固定 schema 基线 JSON 供 A/B 对照 |
| `data/*.json` | 各轮测量落盘（基线/中间态/after），`gitignore` 白名单入库供前后对照 |

## 前置条件

- dev Electron 实例已启动并带 `--remote-debugging-port=9333`
  （`packages/desktop/scripts/electron-dev.mjs` 起 dev 实例；CDP 端口经
  electron 命令行加参传入）。首次测量前确认 `packages/desktop/dist/preload.cjs`
  存在——主进程模态错误框会挂起 CDP 可观测性。
- 测量环境差异会实质影响绝对值（沙箱化启动、GPU/合成器、实例冷热）。**前后
  对照必须在同一环境内做 A/B**（换构建产物 → 同实例 reload → 复测），绝对
  值跨环境不可比（2026-09 实测：同机两轮会话的"每启长任务数"形态即不同）。

## 复测命令

```sh
node scripts/perf/boot-measure.mjs 3 --out scripts/perf/data/boot-after-xxx.json   # 场景①
node scripts/perf/switch-measure.mjs 2 --out scripts/perf/data/switch-xxx.json      # 场景②（A→B→A）
node scripts/perf/switch-measure.mjs 1 --rapid 10 --out scripts/perf/data/rapid-xxx.json  # 场景③
node scripts/perf/eval-measure.mjs 3 --out scripts/perf/data/eval-xxx.json          # H3 归因
node scripts/perf/disk-walk-baseline.mjs            --out scripts/perf/data/disk-walk-before.json  # 同步（改造前）
node scripts/perf/disk-walk-baseline.mjs --async    --out scripts/perf/data/disk-walk-after.json   # 异步（改造后）
node scripts/perf/measure-ui.mjs --idle 15 --clicks 5 --out scripts/perf/data/measure-ui-before.json  # 稳态基线（整改前）
node scripts/perf/measure-ui.mjs --profile         --out scripts/perf/data/measure-ui-profile.json    # 附 5s CPU profile
```

> --out 一律写 `scripts/perf/data/`（.gitignore 白名单例外入库供前后对照）；写到
> 仓库根 `data/` 会被忽略且不随整改台账保存。

## measure-ui 口径（2026 性能整改基线尺子）

- 不改被测页面（不 reload、不导航）；注入与 cdp-lib 同款长任务观察者 + 一个
  rAF 帧间隔采样器（仅记录，不驱动渲染）。
- 字段语义：`dom.totalNodes` = 全文档元素数（验收表"全视图 DOM 节点"）；
  `dom.perInstanceNodes[]` 按 `data-instance` 分壳；`idle` 窗长任务过滤自
  `__dshPerfIdleMark`（注入时刻）之后，**不含**注入前残留；`input.clicks[].worstFrameMs`
  为每击后 1s 窗最坏帧间隔（验收表"合成输入无 >500ms 帧间隔"）；`frames` 为
  全程采样窗 p95/最坏。单步失败降级为字段缺失并记 `errors[]`，仅连接/参数
  错误非零退出——脚本可挂在整改前后各跑一次做同环境 A/B。
- 注意：视图保留回收整改后"挂载视图数/每壳节点"应下降、堆应无净增长；空闲
  长任务与帧间隔对后台周期拉取门控敏感（对比时保持同一实例同批视图）。

## 指标口径（settle 语义的下界，2026-09 review minor2）

`switch-measure.mjs` 场景②的 `clickToSettledMs` 与场景③（`--rapid`）的
`lastClickToQuietMs` 都定义为 **click（末次 click）→ 首个「安静」轮询的间隔**，
是 settle 时长的**下界、不是内容稳定证明**：轮询只断言 `!skeleton && quietMs`
超过阈值（场景② 700ms / 场景③ 900ms），**不校验目标视图/内容确已切换**——
同文档热切换形态下可能首轮即安静（数值≈0 属正常形态），真实内容就绪只会晚
于该刻度；对照解读时把它当「安静下界」而非「切换完成点」。

## 已知限制（诚实测量纪律）

- longtask `attribution` 对 module 脚本为空（Chromium 只对可定位 culprits
  填值）——H3 归因靠 JS 资源加载序 + 时长预算推断，不做超长任务级精确归因；
- 骨架窗口：skeletonWindowMs 以 120ms 轮询全量 trail 计算（实测窗口常
  <120ms → null）；落盘 pollTrail 为每 5 条抽样（600ms），只作过程留痕；
- 场景②③在本环境为同文档热切换形态（无骨架/无 chamber View Transition），
  冷挂载路径需真实会话/多来源，列真实机清单。
