# W3 切源体验蓝图（延迟揭示 / 遮罩主题化 / 意图预热 / 温壳档位）

> 输入：`docs/progress/todo/remote-session-state-and-switch.md` W3（L136）、R7（L176-179）、R8（L181-184）、
> §5-8/§5-9（L112-113）、§9（L241）、§10（L249）、§12（L262）。
> 本文只做**设计**，不改计划文档；Lead 负责合并。
> 证据纪律：每条断言标注「事实」（本轮读过源码/产物确认）或「推断」（由事实推出的机制判断）。
> 打包上游产物一律读 `/Applications/dsh-chamber.app/Contents/Resources/sidecar/vendor/dsh/node_modules/@deepseek-ai/`。
> 本工作区无 node_modules，未运行任何 gate；下文所有「锁/用例」都是**建议新增或需同步修改**的测试，不是已验证结果。

---

## 0. 结论摘要（供 Lead 直接采信/驳回）

1. **延迟揭示不能只靠 View Transition**。现有 `runViewTransition` 的语义是"新状态渲染就绪后动画才开始"
   （`packages/renderer/src/view-transition.ts:6-11`，「事实」），冷 boot 的"新状态就绪"就是遮罩本身；
   要在 boot 期间保持旧视图，必须在 VT 之外把**可见性**从**选择**里拆出来（本文 §2 的 `paintedView`）。「推断」
2. **今天的白屏有确定的机制**：遮罩底色 `.instance-loading{background:var(--dsw-alias-bg-base,var(--bg))}`
   （`styles.css:224-231`，「事实」），而该 token 的出厂值（`body` 无 `data-ds-dark-theme`）是 #fff
   （`styles.css:14-21` 的注释即此事实的仓内陈述；打包产物 `dsh-client-ui-theme/lib/client.js` 里
   `body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00)}`、`--dsw-static-neutral-bluish-00:#fff`，
   深色为 `[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)}` = #151517，「事实」）。
   于是"上一个活动来源是浅色 / 还没壳"时，切向一个深色来源 = 整个 boot 期纯白遮罩。「推断」
3. **主题化不应新增 CSS 颜色规则，而应把"文档调色板"在切换前 prime 到目标来源的已知快照**：
   文档投影已有唯一写者（全页单例 `ThemePresenter`，`packages/dsh-chamber-client-ui-layout/src/client/index.ts:52-57`）
   与唯一归属规则（`document-theme.ts:63-85`）。把 cache 放进同一模块 + 活动来源变化时 prime，
   既不违反 `test/frame-chrome/theme-fallback.test.ts:20`「文档级深色**规则**禁止」的钉子，也不产生第二个文档写者。「推断」
4. **意图预热的安全形态是"重排既有单槽队列 + 计费预算"，不是新增并发**。稳态并发上限由
   `MAX_PREWARMED_REMOTE_VIEWS=1`（`App.tsx:243`）与 `RETAINED_HIDDEN_VIEWS=1`（`retention.ts:39`）决定；
   hover 只能改"谁来用这个槽"。真正会放大远端 blank 会话创建的只有"重开机已回收来源"，
   因此预算按**每会话 2 次、冷却 60s、每来源 1 次**计费（§4）。「推断」
5. **温壳档位保持 1**，直到度量过表（§5）。design 05 §9:782 已把"1→3"列为"需先有帧时/权重预算的度量面"，
   本文把该度量面写成可执行的 budget 表 + 失效判据。「事实 + 设计」
6. **"无白帧"必须给出可判定定义**（三种形态，§7）：今天的两个现成探针都不足以判它
   ——`switch-measure.mjs:87` 的 done 条件只断言 `!skeleton && quietMs>700`（README:65-72 自述是 settle **下界**，
   不校验目标/内容，「事实」）；`measure-ui.mjs:88-100` 的帧采样器只记帧间隔，没有内容归属。「事实」

---

## 1. 现状盘点（file:line）

### 1.1 InstanceView：遮罩合成、可见性、绘制信号

| 事实 | 位置 | 内容 |
|---|---|---|
| 遮罩合成式 | `packages/renderer/src/components/InstanceView.tsx:401-402` | `veilVisible = (!settled 或 (holdVeil === true && !surfaceRelease)) && failureOverlayVisible !== true` |
| 租客隐藏不变量 | 同文件 `:420` | `shellHeld = settled && veilVisible` → 外层类 `instance-veil-held`（`:447`） |
| 视图三态类 | 同文件 `:421-425` | `active ? 'instance-view' : settled ? 'instance-hidden' : 'instance-pending'` —— **可见性完全由 `active` 决定** |
| 遮罩 DOM | 同文件 `:460-528` | `.instance-loading` + spinner + 文案 + 10s 后可操作（重试 / 连接 / 切换） |
| 揭示门（open intent） | 同文件 `:311-340, 401` | `holdVeil` + 会话面相位（`session-surface.ts`）决定遮罩是否在 settle 后继续持有 |
| 持有窗基准 | 同文件 `:314-329, 385-400` | 以**本次持有起点**为基准；单调钟 `monotonicNow()`（`:65-75`）；到期 tick 重臂 |
| 相位观察器 | 同文件 `:347-380` | `MutationObserver(subtree, childList, attributes, attributeFilter:['data-phase'])` + 一帧 rAF 节流 |
| settle 落地 | 同文件 `:250-264` | `activeRef.current` 为真走 `runViewTransition(()=>setShell(next),'settle')`，否则直落 `setShell` |
| hover 卡关闭 | 同文件 `:439-444` | `active` true→false 时 `dismissVisibleRowCard()` |

### 1.2 styles.css：可见性 / 过渡作用域 / 遮罩

| 事实 | 位置 | 内容 |
|---|---|---|
| 视图根底色 | `packages/renderer/src/styles.css:100-115` | `.instance-view{background:var(--dsw-alias-bg-base,var(--bg)); isolation:isolate}`（`:107`） |
| 隐藏壳 | `:125-133` | `visibility:hidden; opacity:0; pointer-events:none` + `.instance-shell{content-visibility:hidden}`（渲染缓存态） |
| 后台 boot 壳 | `:151-155` | `.instance-pending` 只 `visibility:hidden`（保留 layout，vendor 测量可用） |
| 持有期租客隐藏 | `:164-166` | `.instance-veil-held .instance-shell{visibility:hidden}` |
| 租客层叠边界 | `:176-182` | `.instance-shell{isolation:isolate}`（遮罩 z-index:1 结构性获胜） |
| 过渡作用域 | `:201-208` | 只有**活动**视图 `view-transition-name:active-instance`；隐藏 / 待命显式 `none`（名字必须唯一） |
| cut 硬切 | `:210-222` | `html[data-vt-intent='cut']::view-transition-*(active-instance){animation:none}` + old opacity 0 / new 1 |
| 遮罩 | `:224-231` | `.instance-loading{position:absolute;inset:0;z-index:1;background:var(--dsw-alias-bg-base,var(--bg))}` |
| reduced-motion | `:310-314` | spinner 停转（过渡由 `view-transition.ts` 直通模式接管） |

### 1.3 视图过渡机器

- `packages/renderer/src/view-transition.ts`（**就是**本仓的 view transition 机制，非"或类似"）：
  `PaintIntent = 'crossfade' | 'cut'`（`:44`）；`reducedMotion()/directMode()`（`:63-72`）；
  键控单槽合并 `pending: Map<string, PendingIntent>` + `activeKey`（`:59-61, 147-217`）；
  认领时求值 resolver（`:136-145`）；公开入口 `runViewTransition(update, key, paint)`（`:229-241`）。「事实」
- 调用面：`App.tsx:2587-2613`（键 `'view'`，resolver 按目标落地后 `.instance-loading` 是否在场选 cut/crossfade，`:2577-2584`）；
  `InstanceView.tsx:259`（键 `'settle'`）。「事实」

### 1.4 文档主题

- `packages/dsh-chamber-client-ui-layout/src/client/document-theme.ts`：
  `createDocumentThemeProjector(instanceId, env)`（`:63-85`）；`owns()`（`:70-74`，未发布 / 无 instanceId 时 fail-open）；
  `project()` 只在自己是活动视图时 `env.apply`（`:79-82`）；`dispose()` **只退订、永不回收文档**（`:83`）。「事实」
- `packages/dsh-chamber-client-ui-layout/src/client/index.ts`：
  全页单例 presenter `let documentThemePresenter`（`:52`）+ `applyDocumentTheme`（`:55-57`）；
  主题 effect `:307-330`（读 `ctx.chamberInstanceId`、`chamberBridge.getActiveSource/onActiveSource`）。「事实」
- 打包 vendor `dsh-client-ui-layout/lib/client.js` 的 `ThemePresenter`：写 `html.style.colorScheme`、`body[data-ds-dark-theme]`、
  `--dsh-content-font-size`、`theme-color` meta；`apply(snapshot)` 只消费 `snapshot.active.colorScheme`、`snapshot.active.tokens`、`snapshot.fontSize`。「事实」
- 快照来源 `dsh-client-ui-theme/lib/client.js`：`ThemeRuntime` 的 `getTheme()` 返回 `{preference, fontSize, active, themes, revision}`；
  `preference` 默认 `'system'`，`adopt()` 在 settings scope 未水合（`section === undefined`）时直接 return ⇒ **boot 首帧可能是 provisional（浅色）**。「事实」
- App 发布"谁在屏上"：`packages/renderer/src/App.tsx:3162-3165` `useLayoutEffect([activeView])` 内
  `chamberBridge.setActiveSource(activeView)` + `setPageActiveSource(activeView)`。「事实」
- 兜底钉子：`packages/renderer/test/frame-chrome/theme-fallback.test.ts:16-29` 要求 `:root{color-scheme:light}`，
  且**任何文档级浅 / 深规则**都受限；`:31-41` 钉住"layout effect 内发布 activeView"。「事实」

### 1.5 hover intent（现有）

- `packages/dsh-chamber-client-ui-sidebar/src/shared/hover-intent.ts`：**行悬浮卡**状态机，
  `HOVER_OPEN_DELAY_MS=500` / `HOVER_CLOSE_GRACE_MS=200`（`:129-132`），页级单卡槽（`:80-110`），
  `assertSingletonModule('hover-intent')`（`:68-70`）。它服务卡片可见性，**不是**来源预热意图。「事实」
- 侧栏来源头可挂指针事件的位置：`packages/dsh-chamber-client-ui-sidebar/src/client/ServerSection.tsx:747-839`
  （`<header data-chamber-row={server.id}>`，已有 `onPointerDown` / `onClick` / `onKeyDown`；点击走
  `chamberBridge.requestActivateSource(server.id)`，`:823, :836`）。「事实」

### 1.6 预热 / 收割队列与保留

| 事实 | 位置 | 内容 |
|---|---|---|
| 单槽常量 | `App.tsx:243` | `MAX_PREWARMED_REMOTE_VIEWS = 1` |
| 队列 refs | `App.tsx:2745-2752` | `prewarmQueueRef / prewarmInflightRef / prewarmInflightAtRef / viewBootStartedAtRef` |
| eligible 计算 | `App.tsx:2761-2843` | 保留槽占用门、`warmRemaining`、收割优先、`prewarmSuppressed`、`harvestParked` 排除、`slotBudget` |
| drain 选取 | `App.tsx:2845-2870` | `pickPrewarmTarget(queue, eligible, pendingOf, dueOf)` → 置 `prewarmInflight` + `autoPrewarmed` + `setMountedViews` |
| 队列补种 + drain | `App.tsx:3239-3253` | 每个 eligible 来源入队，`activeView` 依赖让"纯激活"释放保留槽 |
| 周期补 drain | `App.tsx:3214-3222` | `VIEW_RECLAIM_TICK_MS` tick |
| 温壳为收割让位 | `App.tsx:3228-3237` | `reclaimView(warm,'harvest')`（抢占的既有先例） |
| 回收 = 拆壳 + 抑制 | `App.tsx:2953-3009` | 守卫活动 / 待开 / 设置目标 / 预热在途；`prewarmSuppressedRef.add`（`:2982`）；`setShellStates` 删键（`:3007`） |
| 保留策略 | `retention.ts:39,42,83-121` | `RETAINED_HIDDEN_VIEWS=1`；`VIEW_RECLAIM_GRACE_MS=60_000`；`decideReclaimCandidates` |
| 收割预算 | `baseline-harvest.ts:37,39,49,99,132-140,178-191` | 2 次尝试 / 120s 退避 / deadline=75s / abandon=135s / 收割独占槽 / 选取顺序 |
| boot 预算 | `boot-budget.ts:11` | `BOOT_TIMEOUT_MS = 60_000` |
| open 预算 | `shell.ts:122-123` | `OPEN_WAIT_MS=8000`、`OPEN_RETRY_MS=400`（延迟揭示 1s 上限的依据之一） |

### 1.7 切换的现状语义（App）

- `activeView` state：`App.tsx:650`；`activeViewRef` 渲染期镜像：`:1098-1099`。
- `selectView`：`App.tsx:2533-2615`。点击即 `pendingViewRef.current = viewId`（`:2571`）→
  `runViewTransition(()=>{...setActiveView(viewId); setMountedViews(...)}, 'view', paint)`（`:2587-2613`）；
  apply 内再查注册表（`:2593-2602`）。
- 可见性：`App.tsx:4331` `active={activeView === viewId}`。
- `activeView` 的 60 处消费者里，与"屏上是谁"真正相关的：`deriveServers` 的 `projectableCurrent`
  （`:419-424`，投影 current ⇒ 侧栏高亮）、阅读 / 蓝点武装（`:4044, 4075, 4093-4107`）、
  保留 / 回收（`:3116-3128`、`reclaimView` 守卫 `:2955`）、hiddenSince（`:3170-3176`）、
  失败覆盖层与降级横幅（`:4209-4236, 4436-4490`）、hover 卡（InstanceView `:439-444`）。「事实」

---

## 2. 延迟揭示设计

### 2.1 机制：拆开"选择"与"绘制"

新增一个 App 级事实 **`paintedView`**（初始 = `activeView` = `local`）：

- **`activeView`（选择）**：语义不变——用户选了哪个来源。驱动：数据发布（`setActiveSource` / `setPageActiveSource`）、
  open 意图 / 投影门、设置目标、深链、失败覆盖层与横幅、保留的"忙"判定、侧栏导航。
- **`paintedView`（绘制）**：屏上真正可见的那个视图。驱动：`InstanceView active=`、hover 卡关闭、
  保留回收的"展示中"保护、`projectableCurrent`（侧栏高亮跟随屏上来源）、阅读 / 蓝点武装。
- 两者相等 = 稳态；不等 = 一次在途揭示（同一时刻至多一个）。

### 2.2 揭示门（新 leaf `packages/renderer/src/reveal-gate.ts`）

纯函数（零运行时 import，可 node 直测；照 `session-surface.ts` 的叶子纪律）：

```ts
export const REVEAL_HOLD_MAX_MS = 1_000      // 旧视图最长保留
export interface RevealFacts {
  selectedViewId: string
  paintedViewId: string
  targetMountable: boolean      // 在 mountedViews 且（local 或 liveServerIds 内）
  targetSettled: boolean        // isSettledShellState(shellStates[target]) —— booted || error!=null
  holdStartedAtMs: number | null
  nowMs: number                 // 单调钟
}
export function shouldReveal(f: RevealFacts): { reveal: boolean; reason: 'steady'|'painted'|'unmountable'|'settled'|'failed'|'expired' }
```

规则：
1. `selected === painted` ⇒ 稳态（无事可做）。
2. `!targetMountable` ⇒ **立即**把 painted 收敛到 selected（或回落 local）——绝不把死视图留在屏上。
3. `targetSettled` ⇒ 立即揭示（成功或失败都算：`isSettledShellState = booted || error !== null`，`shell.ts:593-595`）。
4. 其余 ⇒ 持有，直到 `nowMs - holdStartedAtMs >= REVEAL_HOLD_MAX_MS` 才揭示（此时展示的是目标自己的遮罩）。

### 2.3 揭示动作（App）

- 点击路径（`selectView`）**不再**做可见性切换：把 `:2587-2613` 的 VT 包装换成普通 commit
  （`setActiveView` + `setMountedViews` + `restoreSidebarScroll`），保留注册表守卫（`:2593`）。
  点击后屏上**没有任何变化**（A 仍可见），所以这里不需要过渡节。
- 新的揭示 effect（`useLayoutEffect`，依赖 `[activeView, paintedView, shellStates, revealTick]`）：
  `runViewTransition(() => { if (activeViewRef.current !== target) return; setPaintedView(target) }, 'view', paint)`。
  - **回调内必须重验 `activeViewRef.current === target` 与 mountable**：单槽队列里的揭示意图可能已过期
    （用户点了 B 又点回 A；或来源被退役）。这是本设计最容易写错的一点——没有这道守卫，
    一个过期的揭示会把已撤销的目标画回屏上（对应 `selectView` 现有的 `pendingViewRef` 守卫，`:2592`）。
  - `paint` resolver 沿用 `:2577-2584`：目标落地后 `.instance-loading` 在场 ⇒ `'cut'`，否则 `'crossfade'`。
    **不新增第三种绘制意图**。
- 截止窗：单调钟（`performance.now()`，照 `InstanceView.tsx:65-75` 的既有理由——墙钟回拨会让一次性定时器
  算出负 elapsed 且不再重臂）；到期用 `revealTick` 状态重算（照 `surfaceFallbackTick` 的形态，`InstanceView.tsx:385-400`）。

### 2.4 与既有模式的关系

| 场景 | 结果 |
|---|---|
| **温壳互切**（目标已 mounted + settled） | 规则 3 同帧揭示 ⇒ 与今天逐帧等价（旧快照覆盖 reveal 重排 → crossfade）。 |
| **目标正在后台预热**（pending，slot 在途） | 持有到它 settle（典型数百 ms）⇒ **无遮罩**出现；超过 1s 才退化为主题化遮罩。 |
| **目标被回收后冷 boot** | 持有 1s → 揭示主题化遮罩 → 既有 `'settle'` 路径（`InstanceView.tsx:259`）在壳就绪时揭幕。 |
| **目标 boot 被推迟**（来源 idle，`bootDeferred`） | 1s 后揭示，遮罩即"未连接 + 连接"的可操作态（`source-readiness.ts:191-195`）。 |
| **目标失败** | `error !== null` ⇒ 立即揭示；App 的 `.fatal-overlay` 不透明，没有白帧风险（`App.tsx:4443`）。 |
| **首次启动（无前序视图）** | `painted` 初值 = `selected` 初值 = local，没有"持有"阶段；首帧观感由 §3 的主题化负责（`index.html:16-73` 的静态骨架本就是 chamber 暗色 `#0f1115`，「事实」）。 |
| **reduced-motion** | `directMode()`（`view-transition.ts:63-72`）让揭示**即时落地**（无过渡节）；持有窗 / 截止窗不变——持有是内容决策、不是动效。绝不为持有窗新增任何入场动画（`styles.css:135-145` 的隐藏壳动画门）。 |
| **连点 / 撤销** | 揭示共用 `'view'` 键，单槽合并（`view-transition.ts:239-240`）继续兜住；回调守卫（§2.3）保证末意图胜出。 |

### 2.5 为什么是 1000ms「推断」

- 低于 1s 不打断用户流（Nielsen 0.1 / 1 / 10s 的中间档）。
- 覆盖典型预热 / 温壳揭示：open 分发重试节奏 400ms（`shell.ts:123`），预热在途的 settle 余量多在 1s 内。
- 长于 1s 会让"点了没反应"变成主投诉面；宁可 1s 后给主题化进度面（诚实）也不无限冻结旧内容。

### 2.6 必须同步修改的语义（否则行为会打架）

1. `reclaimView` 守卫（`App.tsx:2955`）：加 `|| id === paintedViewRef.current`——**屏上的壳永不被回收**。
2. `decideReclaimCandidates` 入参（`:3116-3128`）：`activeViewId` 传 **painted**（否则持有窗内 A 被判"隐藏"）。
3. hiddenSince（`:3170-3176`）：按 painted 起表（屏上壳不开始隐藏计时）。
4. `deriveServers` 的 `activeViewId`（`:910`、`:419-424`）：传 painted（否则持有窗内 A 的侧栏 current 高亮消失）。
5. 阅读 / 蓝点武装（`:4044, 4075, 4093-4107`）：用 painted（"谁在阅读" = 屏上）。
6. 退役（`:1446-1461`）：若 retired 含 painted，painted 同帧回落 local / selected。
7. 失败 / 控制面不可达（`:4209, 4224-4236, 4436-4490`）：继续用 **selected**（用户选的那个失败必须立刻可见），
   且在 `activeShellError !== null || controlUnreachable` 时强制 `setPaintedView(activeView)` 释放持有。

---

## 3. 遮罩主题化设计

### 3.1 目标

"目标来源上次已知调色板"必须在**遮罩出现的第一帧**就生效；无缓存时必须落到 chamber 暗色，
**永不落到设计系统默认白**（计划 R7② 原文）。10s 内遮罩是唯一可见面（`source-readiness.ts:177`），
所以这段时间的底色 / 文案 / 按钮配色必须整套正确，不能只改背景。

### 3.2 cache 放哪（唯一写者纪律）

放在 `packages/dsh-chamber-client-ui-layout/src/client/document-theme.ts`——它是文档投影的**唯一**归属模块，
且已经持有全页单例 presenter（`client/index.ts:52`）。新增：

```ts
interface DocumentThemePage {
  report(instanceId: string, snapshot: DocumentThemeSnapshot, settled: boolean): void
  prime(sourceId: string | undefined): void      // 目标快照 ?? 暗色回退，apply 到文档
  forget(sourceIds: Iterable<string>): void
  snapshotOf(sourceId: string): DocumentThemeSnapshot | undefined
}
```

- **页面全局槽**（照 `page-language.ts:228-247` 的 `__dshChamberPageLanguageOwner__` 先例）：
  `globalThis.__dshChamberDocumentThemePage__` + 结构校验。理由：frame chunk 与 composite entry chunk
  是两个 chunk（`page-language.ts:211-219` 已就此写明），跨 chunk 的模块实例不保证同一个。
- **写入点**：`createDocumentThemeProjector` 的 `project()`（`:79-82`）改成"先 `report()`，再按 `owns()` 决定 apply"。
  所有权规则不变（仍然只有活动视图写文档），cache 是**旁路事实**。
- **可靠性标记（provisional 判定）**：boot 首帧快照可能只是 `preference='system'` 的出厂值
  （打包 `dsh-client-ui-theme/lib/client.js`：`DEFAULT_PREFERENCE='system'`，`adopt()` 在 section undefined 时 return，「事实」）。
  因此照抄 `locale-ownership.ts:127-150` 的口径：读
  `ctx.settingsScope.bind({namespace:'ui-theme'}).getSnapshot().status`（namespace 字面量来自打包产物
  `THEME_SETTINGS_NAMESPACE="ui-theme"`，「事实」）；**status === 'loading' 时不写 cache**；
  `theme/change` 之后无条件覆盖 cache（有事件 = 已 adopt）。
- **prime 时机**：page owner 的 `onActiveSource`（`client/index.ts:321`）。App 的 `setActiveSource(activeView)`
  在 layout effect 里（`App.tsx:3162-3165`）⇒ prime 与可见性变化同一次绘制前提交。「推断」
- **回退快照**：`{ preference:'dark', fontSize:<上次应用到文档的值 或 bootstrap>, active:{ id:'dark', colorScheme:'dark', tokens:{} }, themes:[], revision:0 }`。
  只喂 `ThemePresenter.apply` 真正读的字段（见 §1.4 打包事实）。
  `fontSize` 沿用上次值以免惊动字号轴（presenter 每次 apply 都会写 `--dsh-content-font-size`）。「推断」

### 3.3 失效规则

| 触发 | 动作 | 理由 |
|---|---|---|
| 来源退役（`App.tsx:1446-1461`） | `forget(retired)` | id 复用可能换主题；防泄漏 |
| 同一来源新一轮 boot 首报 / `theme/change` | 覆盖 | 权威事实到达，无需额外失效 |
| OS scheme 翻转（`prefers-color-scheme`） | `preference==='system'` 且主题 id ∈ {light,dark} ⇒ 就地重算 colorScheme；否则**丢弃**该条目 | system 解析依赖客户端 OS；自定义主题的 tokens 是按旧 scheme compose 的，重算会错 |
| settings scope 稍后才水合 | boot 快照被 `theme/change` 覆盖 | provisional 不写 cache；写入门槛见 §3.2 |

### 3.4 "永不纯白"的机制化保证

- 无 cache ⇒ prime 必写 `body[data-ds-dark-theme]` ⇒ `--dsw-alias-bg-base` 解析为
  `--dsw-static-neutral-bluish-950`（#151517），与 chamber `--bg:#0f1115`（`styles.css:36`）同域、
  与 `index.html:22,32` 的静态首帧同域。「事实 + 推断」
- **不新增任何 CSS 颜色规则**：`test/frame-chrome/theme-fallback.test.ts:20` 禁止文档级深色规则；
  prime 走的是既有的运行时 presenter 路径（inline `color-scheme` + body 属性），
  `:root{color-scheme:light}` 兜底原样保留（`styles.css:35`，「事实」）。
- 遮罩内的按钮（官方 `Button` 原子）与 spinner 都是 `--dsw-alias-*` token 消费点
  （`styles.css:249-267`；`InstanceView.tsx:48` 深路径导入），因此随文档调色板一起正确。「事实」
- 已知代价「推断」：无缓存目标的真实主题若是浅色，boot 完成时文档会从暗翻浅一次
  （与今天"静态暗骨架 → 本地浅色 UI"的翻色同族，`index.html:17-19` 已就此裁决过）。

---

## 4. 意图预热设计

### 4.1 触发面与去抖

- 新 leaf `packages/dsh-chamber-client-ui-sidebar/src/shared/prewarm-intent.ts`：
  `INTENT_DWELL_MS = 120`（计划 R8 原文）、`INTENT_LEAVE_GRACE_MS = 80`（指针掠过子按钮不误触发）、
  `createPrewarmIntent({dwellMs, onIntent})` → `{enter(), leave(), press(), dispose()}`，零 DOM 零槽位
  （与卡片机器分开，别把 `hover-intent.ts` 的单卡槽语义拖进来）。
- 挂载点：`ServerSection.tsx:747-839` 的 `<header>`：`onPointerEnter → enter()`、`onPointerLeave → leave()`、
  点击（`:815-824`）与键盘（`:825-838`）→ `press()` + 既有 `requestActivateSource`。React 的 `onPointerEnter/Leave`
  不会因指针移入子按钮而 leave（与 `RowHoverCard.tsx:295-296` 同款用法，「事实」）。
- 会话行（跨来源点会话）暂不接入：第一版只做来源头，避免与行菜单 / 拖拽的指针语义冲突（登记为范围）。

### 4.2 通道

`aggregate-store.ts` 的 `chamberBridge` 新增 `requestIntentPrewarm(sourceId)` / `onIntentPrewarm(listener)`
（紧邻 `requestActivateSource` 的 `:677-686`）。App 侧一个订阅 effect。单向事实通道，复用既有桥接纪律。

### 4.3 三档行为

| 档 | 条件 | 动作 | 是否可能新增远端 blank 会话 |
|---|---|---|---|
| **T0** | dwell ≥120ms | `probeRemoteReady(id)` + `ensureRemoteConnected(id)`（`App.tsx:2474-2508`） | **否**（只做隧道 / 会话复检；二者对 connecting/ready 幂等、reverify 在静默窗是主进程 no-op，注释见 `:2470-2472, 2495`） |
| **T1** | T0 + 来源 ready、未挂载、非 `harvestParked` | 把 id 提到 `prewarmQueueRef` 队首；清该 id 的 `prewarmSuppressedRef`；`drainPrewarm()` | **可能**（与既有空闲预热同类），受 §4.4 预算 |
| **T1b**（默认关，需实测） | T1 + 槽被"投机温壳"占用 | 复用 `:3228-3237` 的让位路径 `reclaimView(warm,'harvest')` 后重排 | 可能增加（被抢占的源白付一次 boot）——**默认关** |

不做的事：不新增后台槽位、不提高 `MAX_PREWARMED_REMOTE_VIEWS`、不抢占收割在途（`prewarmInflight`）、
不做"悬停即全量预载"（计划 §12 已否）。

### 4.4 不放大远端 blank 会话创建的守卫

远端 blank 会话来自官方初始导航（design 06 §5:590-596；STATUS:390），一次 shell boot 一次。因此：

1. **结构性**：intent 只能重排 `prewarmEligible` 里的 id；harvest 优先级不变
   （`baseline-harvest.ts:132-140` 的"收割候选在场时独占槽"原样保留）。
2. **计费**：`INTENT_PREWARM_MAX_PER_SESSION = 2`（只在 `drainPrewarm` 真正选中一条 intent 来源时扣减；
   队列重排不扣）；`INTENT_PREWARM_COOLDOWN_MS = 60_000`（两条 intent boot 的最小间隔）；
   `INTENT_PREWARM_PER_SOURCE = 1`（每来源每会话最多一次 intent boot）。
3. **不碰 parked**：`harvestParked`（`baseline-harvest.ts:64-66`）的源 hover 不清停车——第三次 boot 是白烧，
   出口是用户点击（点击仍走现有 `selectView` 清抑制）。
4. **不变式**：`warmRemaining` / `liveAutoPrewarmed` 的算术（`App.tsx:2790-2797`）不改；
   intent boot 成功后该壳照常是 `autoPrewarmed`，照常不算"用户温壳"、照常可被 retention 先收
   （`retention.ts:112-119` 的 prewarmOrigin 排序）。
5. **度量**：新增 perf marks `dsh:app:intent-prewarm:<id>`、`dsh:app:view-request:<id>`、`dsh:app:view-reveal:<id>`
   （`perf-marks.ts:19-48` 的表新增三项，保持"只观测零业务语义"）；probe 用它算
   intent 启动次数、切换耗时与命中率，并作为 R16 验收的对照口径。

### 4.5 与保留 / 收割的交互矩阵「推断」

| 槽状态 | intent 的结果 |
|---|---|
| 槽空闲、无收割候选 | intent 源优先 boot（T1） |
| 收割候选在场 | 收割独占槽（不变），intent 只能排队等待 |
| 槽被用户温壳占（`retentionSlotOccupied=true`） | `warmRemaining=0` ⇒ intent 不生效（除非开 T1b） |
| 槽被投机温壳占 | intent 等待它 settle 后重排（T1）；开 T1b 则抢占 |
| 目标已被 `prewarmSuppressedRef` 抑制 | intent **清除抑制**（显式意图 > 空闲策略），但受 §4.4 计费 |
| 目标 `harvestParked` | 不生效（停车不可由 hover 解开） |

### 4.6 命中率（R8 的 ≥80% 需要定义）

- `hit ⟺ 用户点击该来源的那一帧，目标已 settled（`shellStates[id]` 存在且 booted）或在途 mount`
  （`prewarmInflightRef.current === id` 或已在 `mountedViews`）。「推断」
- 采集：`view-request` 与 `shell:settled:<id>` / mount 事实对齐（probe 侧计算，不改业务语义）。

---

## 5. 温壳档位与预算

### 5.1 档位定义

| 常量 | 现值 | 位置 | 本蓝图取值 |
|---|---|---|---|
| `RETAINED_HIDDEN_VIEWS`（用户温壳） | 1 | `retention.ts:39` | 默认 1；实测过表可开 2 |
| `MAX_PREWARMED_REMOTE_VIEWS`（投机槽） | 1 | `App.tsx:243` | **保持 1** |
| 壳总量上界 | — | — | 1(local) + 1(屏上) + T_hidden + T_spec |

design 05 §9:782 已裁决"1→3 需先有帧时 / 权重预算的度量面"；本文给出的就是那张表。「事实 + 设计」

### 5.2 预算表（同环境 A/B；口径沿用 `scripts/perf/README.md:22-31`）

| 指标 | 现成采集点 | 档 2 开启条件（全部满足） |
|---|---|---|
| `mountedShells` / 每壳 DOM | `measure-ui.mjs:103-110`（`dom.views.mounted`, `dom.perInstanceNodes[]`） | 全视图 DOM 不超既有 13,000 口径（STATUS:222），每壳增量 ≈ 单壳基线 |
| `pageHeap` | `measure-ui.mjs:112-114` | 每多一壳增量有界（建议 ≤ 单壳 DOM 对应堆；首轮记录绝对值） |
| `idleLongTasks` | `measure-ui.mjs:117-130` | 空闲 15s 无新增 >100ms 长任务 |
| 帧时 p95 | `measure-ui.mjs:171-177` | p95 ≤ 档 1 p95 × 1.15 |
| `switchFrameMs` p95 | **需新增**（§7 Leg A/B） | 不劣于档 1（同一脚本、同一序列） |
| 无白帧断言 | §7 | 不变红 |

任何一项不过 ⇒ 保持 1，并把结论写回 design 05 §9（该条既有"失效判据"体例）。

### 5.3 与延迟揭示的联动

T_hidden 越大，"已打开过"的来源在 60s 回收窗（`retention.ts:42`）内被覆盖的概率越高 ⇒ 冷 boot 比例下降
⇒ §2 的 1s 持有窗与主题化遮罩更少被触发。因此 **R8 的温壳档位是 R7 体验的乘数**：两者要一起验收，
不能只开档位不做揭示，也不能只做揭示而档位恒 1（那样"已打开过"的来源大多已被回收）。「推断」

---

## 6. 逐条改动点

> 记号：**[新]** 新文件；**[改]** 修改；**[锁]** 建议的测试 / 源码锁。

### 6.1 延迟揭示

1. **[新]** `packages/renderer/src/reveal-gate.ts`：`REVEAL_HOLD_MAX_MS`、`shouldReveal(facts)`、
   `revealHoldStartedAt(...)`（纯函数、单调钟注入）。
   **[锁]** `packages/renderer/test/view-runtime/reveal-gate.test.ts`：稳态 / 不可挂载 / settled / 失败 / 到期 / 时钟回拨六例。
2. **[改]** `App.tsx:650` 旁新增 `paintedView` state + `paintedViewRef`（渲染期镜像，照 `:1098-1099`）。
   **[锁]** `test/wiring/veil-layering-invariants.test.ts` 新增源码锁。
3. **[改]** `App.tsx:2587-2613`：`selectView` 的 VT 包装改为普通 commit；`paint` resolver 迁到揭示 effect。
   保留 `:2593-2602` 的注册表守卫；`onApply` 语义不变。
4. **[改]** `App.tsx:3162-3165` 之后新增揭示 `useLayoutEffect`（依赖 `[activeView, paintedView, shellStates, revealTick]`）：
   `runViewTransition(update, 'view', paint)`，**update 内重验 selected / mountable**。
5. **[改]** `App.tsx:2953-2955` `reclaimView` 守卫加 painted；`:3116-3128` retention 入参改 painted。
6. **[改]** `App.tsx:3170-3176` hiddenSince 改按 painted；`:910` `deriveServers(..., paintedView, ...)`。
7. **[改]** `App.tsx:4044, 4075, 4093-4107` 阅读 / 蓝点武装改 painted。
8. **[改]** `App.tsx:1446-1461` 退役：painted 同时回落；失败 / 控制面不可达时强制揭示（`:4209` 附近）。
9. **[改]** `App.tsx:4331` `active={paintedView === viewId}`（props 名可保留 `active`，但注释必须写清语义）。
10. **[改]** `InstanceView.tsx:250-264`：注释订正（settle 时 `activeRef` 表达的是"已绘制"）；行为不变。
    **[锁]** `test/wiring/veil-layering-invariants.test.ts`：断言 `active={` 绑定到 painted、揭示回调含 selected 守卫。
11. **[改]** `PERF_MARKS`（`perf-marks.ts:19-48`）新增 `appViewRequest / appViewReveal / appIntentPrewarm`。
12. **[不动]** `view-transition.ts`、`styles.css`：本设计不需要它们改动（这是刻意的最小面）。

### 6.2 遮罩主题化

13. **[改]** `dsh-chamber-client-ui-layout/src/client/document-theme.ts`：新增 `DocumentThemePage`
    （页面全局槽 + report / prime / forget / snapshotOf + 回退快照 + OS scheme 失效）。
14. **[改]** `dsh-chamber-client-ui-layout/src/client/index.ts:307-330`：effect 内构造 / 安装 page owner；
    `:52-57` 的 presenter 复用为 page owner 的 apply。
15. **[新]** `packages/renderer/src/theme-prime.ts`：**结构性**适配器（不 import layout 包，避免主图变大与
    chunk 身份问题），供 App 调 `forgetDocumentThemes(retired)`。prime 由 `onActiveSource` 驱动，App 不需要显式调用。
16. **[改]** `App.tsx:1446-1461`：退役时 `forgetDocumentThemes(retired)`。
17. **[改]** `packages/dsh-chamber-client-ui-layout/test/document-theme.test.ts`：新增
    report-settled-only / 无缓存暗色回退 / prime 目标快照 / forget / system-flip 五组用例。
18. **[改]** `packages/renderer/test/frame-chrome/theme-fallback.test.ts`：新增"prime 不得引入 CSS 深色规则"的锁
    （继续钉 `:20` 的否定断言），并钉住"无缓存 ⇒ 必然写 `data-ds-dark-theme`"。
19. **[不动]** `styles.css`：不新增颜色字面量 / token 规则。

### 6.3 意图预热

20. **[新]** `dsh-chamber-client-ui-sidebar/src/shared/prewarm-intent.ts`（dwell 机器）。
    **[锁]** `test/session-rows/prewarm-intent.test.ts`（与 `hover-intent.test.ts` 同目录体例）：
    dwell 内 leave 不触发、dwell 后触发一次、press 取消、dispose 清定时器。
21. **[改]** `aggregate-store.ts:677-686` 旁新增 `requestIntentPrewarm / onIntentPrewarm`（+ 单测）。
22. **[改]** `ServerSection.tsx:747-839` 头部挂 enter / leave / press。
23. **[改]** `App.tsx` 新增订阅 effect + `noteIntentPrewarm(id)`：T0 两条 + T1 重排 + §4.4 计费
    （预算 / 冷却 / 每来源一次记在 ref 中，随来源退役清除，照 `:1448-1454` 的收敛体例）。
24. **[改]** `App.tsx:2845-2870` `drainPrewarm`：标注本条来源是否为 intent 驱动（仅用于计费与 mark）。
25. **[可选 / 默认关]** T1b 抢占：复用 `:3228-3237`，加开关常量 `INTENT_PREWARM_PREEMPTS_WARM = false`。
26. **[锁]** `test/wiring/`：intent 不得绕过 `harvestParked`、不得新增槽位、冷却 / 预算存在、`prewarmCandidates` 调用不变。

### 6.4 温壳档位

27. **[改]** `retention.ts:39`：`RETAINED_HIDDEN_VIEWS` 改为单一具名常量 + 注释指向预算表；本期值仍 1。
28. **[改]** `scripts/perf/measure-ui.mjs`：schema 增 `switchFrameMs` / `warmTier`（§7 Leg A 的判据来源）；
    `mountedShells` 已在 `dom.views.mounted`。
29. **[改]** `docs/design/05-connection-manager.md:782` 的条目：把"需先有度量面"替换为"度量面见 W3 蓝图 §5.2 + 失效判据"
    （**由 Lead 合并，本文不改计划与设计文档**）。

---

## 7. 无白帧的验证方法

### 7.1 "空白帧"的可判定定义（三形态）

- **(a) 无可见视图**：某一帧里没有任何 `.instance-view` 处于"可见"态
  （选择器口径照遮罩探针：`.instance-view:not(.instance-hidden):not(.instance-pending)`，`walkthrough.mjs:294`）。
  ⇒ 对"已打开来源互切"是 FAIL；对首启（尚无任何视图）不适用。
- **(b) 平面浅色帧**：可见面是**无内容平面**（整块单色）且颜色 = 设计系统默认浅色（#fff）。
- **(c) 主题失配的进度面**：可见面是遮罩（进度面，非空白），但其底色 ≠ 目标来源的预期调色板
  （target cache 命中时是精确色，未命中时是 chamber 暗色 #151517 / #0f1115 同域）。
  (b)/(c) 在"首次进入"路径上允许"有进度面"，但都不允许"纯白"（计划 §0.5、R7②）。

### 7.2 可用探针（现状与边界）

| 探针 | 能给什么 | 不能给什么 |
|---|---|---|
| `scripts/perf/measure-ui.mjs` | DOM 分壳 / 每壳节点（`:103-110`）、堆（`:112-114`）、空闲长任务（`:117-130`）、合成输入帧（`:132-168`）、全程帧间隔 p95（`:171-177`） | 帧的**内容归属**；它只记 `{t, delta}`（`:88-100`） |
| `scripts/perf/switch-measure.mjs` | A→B→A 循环、skeleton 窗口（`:88-104`）、连点 ×N | 其 `done` 只断言 `!skeleton && quietMs>700`，**不校验目标视图 / 内容**（README:65-72 自述为 settle 下界） |
| `scripts/dev/svg-resource-probe.mjs` | 真机 WKWebView 像素真值：最小 PNG 解码（`:193-263`，`node:zlib` `inflateSync` `:33`）+ 区域 ink 计数（`measureInk`，阈值 `INK_THRESHOLD=5` `:38`） | 与切换无关；是**方法学先例**（DOM 可见 ≠ 已绘制） |
| `scripts/gui-acceptance/walkthrough.mjs` | rAF 逐帧遮罩层叠探针（`:288-376`）+ 纯判据体例（`checks.mjs` + `checks.test.mjs`）+ CDP 会话可收事件（`cdp.mjs:114`）与截图（`:146-151`） | 探针只判"遮罩压住租客"，不判"有没有内容 / 什么颜色" |

### 7.3 Leg A（CI 可跑：DOM 逐帧状态机）

1. 新增 `SWITCH_FRAME_PROBE_INSTALL/READ`（照 `walkthrough.mjs:288-376` 的体例）：
   每 4 帧采一次 `{visibleView: data-instance 或 null, selectedView, veil: bool, veilBg: computedBackground(veil), phase, at}`；
   `veilBg` 用 `getComputedStyle(veil).backgroundColor`（**DOM 真值，不需截图**）。
2. 探针窗口覆盖：安装 → 通过点击 `[data-chamber-row="<id>"]` 切到一个远端来源 → 等目标稳定 → 切回。
3. 新增纯判据 `switchFrameVerdict`（`scripts/gui-acceptance/checks.mjs`，配 `checks.test.mjs` 用例）：
   - `noVisibleViewFrames === 0`（形态 a）；
   - `veilFrames > 0` 时，`veilBg` 为 #ffffff 的帧数 === 0，除非目标被声明为浅色来源（形态 b/c）；
   - 目标已 settled 的那些帧里 `veil` 应为 0（温壳不该出现进度面）。
4. 走查新增腿（`walkthrough.mjs` 的 `rec.add`）+ CLI `--require-switch`：来源 <2 导致"未演练"时 INFO→FAIL
   （`--require-hover` 的先例）。
5. `measure-ui.mjs` 增 `switchFrameMs`：由 `view-request` → `view-reveal` 两条 mark（§6.1-11）算，
   作为 §5.2 的档位判据之一。

### 7.4 Leg B（CDP 逐帧像素：dev Electron）

1. 新 `scripts/perf/switch-frame-probe.mjs`：`Page.startScreencast{format:'png', everyNthFrame:1, maxWidth:960}` +
   每帧 `Page.screencastFrameAck`（`cdp.mjs:114` 已能订阅事件）。
2. 把 `svg-resource-probe.mjs:193-263` 的最小 PNG 解码抽到 `scripts/lib/png-ink.mjs`（零新依赖，`node:zlib`），
   对"内容区"矩形（`[data-conversation-scroll]` 的 rect，取窗口中心 60% 兜底）统计**众数颜色 + 非背景像素占比**：
   - 整块单色 ⇒ 平面帧；平面帧颜色必须落在目标调色板集合内（cache 命中为精确值，未命中为暗色族），**不得为 #fff**；
   - 出现"平面帧之后又回到旧视图"的抖动 ⇒ FAIL。
3. 回退实现（若 screencast 在 Electron 43 上不稳）：`Page.captureScreenshot` + `clip` 以 60-100ms 轮询
   （`cdp.mjs:146-151` 的形式），代价是采样率低、可能漏帧，需在报告里标注。
4. 与 Leg A 的时间对齐：探针自己在页面里打 `performance.mark`（probe 注入，非 app 语义），
   每条 screencast 帧按到达时刻归到最近一次 mark 段。

### 7.5 Leg C（真机像素：WKWebView，发布前人工）

复用 `svg-resource-probe.mjs:139-193` 的 Swift 驱动骨架：脚本驱动一次 A→B 切换并在窗口期内以固定节奏截图，
判据同 Leg B。它是**人工验收工具**（该探针头注 `:24-25` 已声明同款纪律），不注册 CI。

### 7.6 新检查还缺什么（清单）

1. **目标首帧信号**：本设计靠 `settled` + VT 覆盖；像素腿需要一个 probe 侧标记
   （在目标 `.instance-view` 上打 `data-probe-first-paint`，由注入的 rAF 观察者写，**不进业务代码**）。
2. **内容区矩形**：`[data-conversation-scroll]`（`session-surface.ts:70` 的已登记锚点）优先；降级为窗口中心矩形。
3. **平面色提取**：众数 / 边缘能量，不能用平均色（内容可能恰好均值 = 背景）。
4. **采样与点击对齐**：probe 侧 mark 或 screencast 帧时间戳。
5. **reduced-motion 腿**：`Emulation.setEmulatedMedia({features:[{name:'prefers-reduced-motion',value:'reduce'}]})`，
   断言同样的无空白不变量且无过渡节。
6. **首启腿**：`Page.reload` 后立刻装采样器，断言"静态暗骨架 → 遮罩"之间没有一帧 #fff。
7. **对照腿**：在已回收的来源上重复同一序列（模拟 R7 的最难形态），记录 `switchFrameMs` 分布。

---

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | 持有窗让用户以为"点击没反应" | 上限 1s；到期即揭示主题化进度面；必要时再加按压反馈（本版不做，先测量投诉面） |
| 2 | 揭示回调过期（连点 / 退役）把旧目标画回 | update 内重验 `selected / mountable`（§2.3），并写 wiring 锁 |
| 3 | 保留 / 回收误拆屏上壳 | `reclaimView` + retention 入参改 painted（§2.6-1/2），配单测 |
| 4 | 侧栏高亮 / 阅读判定与屏上不一致 | `projectableCurrent` 与阅读 / 蓝点武装统一用 painted（§2.6-4/5） |
| 5 | 主题 prime 把浅色来源的文档先染暗 | 只在有 cache 时精确 prime；无 cache 的暗色回退是本设计的显式裁决（计划 R7②）；prime 与"发布 activeView"同帧，切走不回滚（teardown 永不回收，`document-theme.ts:83`） |
| 6 | provisional 快照被当权威缓存（深色来源被记成浅色） | settings scope `status==='loading'` 不写 cache；`theme/change` 覆盖（§3.2） |
| 7 | OS 主题翻转后缓存过期 | system 条目就地重算或丢弃（§3.3） |
| 8 | hover 预热放大远端 blank 会话创建 | §4.4 结构性守卫 + 计费 + parked 不解锁；R16 验收按"intent boot 计数 + 每源新增会话数"对照 |
| 9 | T1b 抢占造成白付 boot | 默认关；开之前必须先有 A/B（§5.2） |
| 10 | 帧探针本身不稳（screencast 静止期无帧、色差） | 用 PNG（不引入解码复杂度）；Leg A（DOM）作 CI 主判据、Leg B 作实机像素证据；报告必须写清采样率与丢帧 |
| 11 | 档位放宽后主线程 / 帧时劣化（design 05 §9:781-782 的老问题） | 档位默认 1；§5.2 全表过才开，并留失效判据 |
| 12 | 与 W2（未读水位 / 账本派生）在同几行打架 | §2.6 的 painted / selected 拆分先落地；W2 的"谁在阅读"统一读 painted（一个具名事实，不再散落 activeView） |
| 13 | reduced-motion 下持有窗被误解为动效 | 文档与注释写明"持有是内容决策"；不加任何入场动画（`styles.css:135-145` 的门） |

---

## 9. 对主计划 W3 与 R7/R8 的修订建议

> 建议 Lead 直接替换 / 增补计划文档的对应句子（本文不改计划）。

### 9.1 W3（计划 L136）

- 出口判据建议改为可判定三条：
  1. **已打开来源互切**：从点击到目标内容稳定之间，逐帧采样**不存在**"无可见视图帧"，
     且**不存在**"整块 #fff 平面帧"；
  2. **首访 / 回收后冷 boot**：允许出现进度面，但进度面必须带目标来源调色板（cache 命中为精确值、
     未命中为 chamber 暗色；**永不 #fff**）；
  3. 同环境 A/B 下 `switchFrameMs` p95 与帧时 / 长任务 / 堆不劣化（§5.2）。
- 新增 W3 子项：
  - **W3-a 主题 prime**（§3，必须先于 / 同批于 b）——否则 b 会把白遮罩留满 boot 期；
  - **W3-b 揭示门**（§2，含 `paintedView` 语义拆分与 retention / 阅读跟随）；
  - **W3-c 意图预热**（§4，含预算与计费）；
  - **W3-d 档位度量面**（§5，档位值本期仍 1，交付的是度量与失效判据）。

### 9.2 R7（计划 L176-179）

- 方案①"延迟揭示——目标首帧可用前保留旧视图绘制（cut 硬切改为旧快照保持 + 就绪后 crossfade）"
  **只对已 settle 的目标成立**；冷 boot 的"新状态首帧"就是遮罩，VT 无法跨 boot 保持旧视图。「事实 + 推断」
  建议改写为："**选择 / 绘制分离 + 有界持有窗（默认 1s：`REVEAL_HOLD_MAX_MS`）+ 到期揭示主题化进度面**；
  揭示仍走 `'view'` 过渡键，paint 意图判据不变（目标落地后是否有遮罩 ⇒ cut/crossfade）。"
- 落点补充：`App.tsx` 的 `paintedView` 状态与揭示 effect、`reclaimView` / retention / hiddenSince /
  `projectableCurrent` / 阅读武装的跟随（§2.6）、新 leaf `reveal-gate.ts`。
- 落点修正：原写 `App.tsx:2580` 与 `view-transition.ts` 的 `cut` 分支——`view-transition.ts` **不需要改**；
  改的是 `App.tsx:2587-2613`（点击路径去 VT 化）与新增揭示 effect。
- 判据改写为 §7.1 的三形态 + 两腿（DOM 逐帧为主、像素为辅），并明确"今天的 `switch-measure.mjs` 不能作证据"。

### 9.3 R8（计划 L181-184）

- 意图预热补三条硬约束：**只重排不增并发**（默认）、**每会话计费 2 次 + 冷却 60s + 每来源 1 次**、
  **`harvestParked` 不可由 hover 解锁**；T1b（抢占投机温壳）默认关、需 A/B 才开。
- "预热命中率 ≥80%"补定义：命中 = 点击帧目标已 settled 或在途 mount（§4.6），采集走三条新 perf marks。
- 温壳档位改写为："**默认 1**；度量面 = §5.2 表；全表通过才开 2；任一指标不过即退回 1 并把结论写回
  design 05 §9（既有失效判据体例）。"
- 落点补充：`shared/prewarm-intent.ts`（新）、`aggregate-store.ts` 的新通道、
  `App.tsx` 的 `noteIntentPrewarm` / `drainPrewarm` 计费点、`perf-marks.ts` 三项；
  原写 `shared/hover-intent.ts` 作落点是**错的**——那是行悬浮卡机器（`hover-intent.ts:129-132`），不复用。

### 9.4 对 §10 测试与度量的建议（计划 L249）

- `measure-ui.mjs` 增 `switchFrameMs` / `warmTier` / `intentPrewarmBoots`；
- 新 `scripts/perf/switch-frame-probe.mjs` + `scripts/lib/png-ink.mjs`（PNG 解码复用，零新依赖）；
- `scripts/gui-acceptance/walkthrough.mjs` 增一腿 + `checks.mjs` 增 `switchFrameVerdict`（配 CI 单测）；
- 接线锁清单（新）：`active` 绑 painted；揭示回调含 selected 守卫；`reclaimView` 含 painted；
  retention 入参为 painted；prime 不得引入 CSS 深色规则；无缓存 prime 必写 `data-ds-dark-theme`；
  intent 不得绕过 parked / 预算 / 槽位。
