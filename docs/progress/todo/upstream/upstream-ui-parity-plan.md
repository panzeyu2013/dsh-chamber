# 上游 UI 对齐：剩余待裁面（侧栏 / 工作区）

> 分类：A · 上游对齐（chamber 侧裁决）｜状态权威：design 06 §7 与 STATUS

本文件只留**仍需裁决**的差异（§1）与**维持的差异/裁决**（§2，不再逐条论证），作为下一轮的入口；已落地面（含
2026-02 收敛批）的契约见 design 06 §7、design 05 §2，本文不复述。

判据口径：`SB` = 安装包内未压缩的 `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` 行号；`WS` =
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 行号；本仓 = `packages/dsh-chamber-client-ui-sidebar`。

## 1. 待裁决

### 1.1 pinned 会话（残余：块内拖拽 + 跨块守卫 + 账号写入）

- 本仓：写入口、三个行面与**置顶渲染分区**已落地（形态见 design 06 §7、分区见 §3.4、checklist §4.6）。
  分区 = 上游 `sectionMembers` 语义（blank → pinned → 其余；manual 块内取宿主 `pinnedSessionIds`
  的「最近置顶在前」，updated 保留本仓 account 序，搜索结果不分区），`pinSetKnown` 出处门不变。
- 上游：树节点 `pinned: !archived.has(id) && pinned.has(id)`（`WS:450-465`）；置顶序在 `sectionMembers`（`WS:371-382`）；
  菜单项 pin/unpin（`WS:3630-3643`，order 100）+ 行 hover 按钮（`WS:3649-3668`，order 200）+ 静息 `PinnedIndicator`
  （`WS:1441-1450`、行内 1636）；拖拽分区边界由 `sectionMembers` 决定；`pinnedSessionIds` 来自 registry 级 rowState。
- 仍缺（本条的开放部分）：①置顶块内拖拽与跨块守卫（上游 `sessionDragOrder` 的同分区门）；②把置顶写进本地
  账号（上游 `pinSessionOrder` 的持久领先槽语义，含 `unpin` 落点偏差 B2——本仓回自然位）；③半开 follow
  通道下的陈旧置顶标记（pin → HTTP 归档 → HTTP 恢复，本地集仍指该 id、unpin 变 no-op；修法 = 归档成功时
  本地按 vendor 同规则清 id）与未挂载来源的"发送即忘"（标记/分区无界延迟到挂载）。
- 候选落法：A. 完整对齐（拖拽分区守卫 + 账号写入，会引入第三条持久手动账号并碰 manual=wire 权威）；
  B. **已落地的渲染分区**（选项1：序的可见结果对齐、不写账号、不动拖拽）；C. 维持不做（已被否——标记之外
  毫无位置效果）。
- 为何仍要裁：残余 A 会与本仓两套既有排序语义并列并给会话拖拽加跨分区守卫；与
  `sidebar.workspaces.*` 座席「只声明不渲染」的既有裁决（design 24 §1、STATUS）相邻——写入口/标记/分区的
  移植形态已定，剩下两项仍需一次裁决。
- 证据：`packages/dsh-chamber-client-ui-sidebar/test/session-rows/pin-partition.test.ts`（分区语义与三处接线）、
  `test/session-rows/session-row-actions.test.ts` 与 `test/session-state/vendor-session-fact-contract.test.ts`
  （形态/座席/文案/线协议锁）、`packages/dsh-chamber-seed-archive-cleanup/test/binding.test.ts`（宿主字段透传）。

### 1.2 会话行时间列

- 上游：行尾 `.time` 单元，静息显示 `primaryStatus.trailingLabel ?? timeLabel(updatedAt, now, t)`（`WS:1631-1635`），
  hover 换出动作簇（`Rows.module.css` 的 `:hover .time{display:none}`）；时限词表 `time.*`。
- 本仓：行尾是**尾随状态槽**（`ServerSectionRows.tsx` 的状态槽，常态 10px / pending 14px、hover 换出），静息不显示时间；
  `updatedAt` 只进 hover 卡。
- 为何要裁：上游的时间列与本仓的状态槽占同一位置且都由 hover 换出——直接叠加会出现「静息同时显示时间与状态」
  （上游没有的形态）；对齐需动 STATUS 的状态呈现偏差（品牌蓝完成点 / 14px pending 徽标，登记行见 STATUS 的对应条目）。
- 候选落法：A. 时间列进状态槽的静息分支（有状态时状态优先、无状态时显示时间）；B. 时间列独立单元 + 状态槽保留（双尾随）；
  C. 不落（登记：chamber 行尾语义 = 状态，时间只在卡片）。

### 1.3 快捷键回调接线

- 上游：`session.search`（KeyK primary）、`workspace.add`、`session.rename`、`session.fork`、`session.archive`
  在 `WS:139-203` 注册（`installWorkspaceShortcuts` 的函数体），回调或写官方浏览器自己的 store（`controls.search`/`add`/`rename`），或调共享服务。
- 本仓：目录行存在（tooltip 键帽已按行取）。回调的**可达性分两类**（`WS:139-203` 的 resolver；括注为**调用点**）：
  `session.new`→`navigation.startSession()`（:142）、`session.fork`→`navigation.forkSession(target.id)`（:184）、
  `session.archive`→`archiveSession(target.id)`（:200）调**共享服务**——键若被派发就真的建/分叉/归档；`session.rename`→
  `controls.rename(…)`（:167）写官方 store，但它的消费者是官方 `SessionRenameDialog`：该模态注册进 `shell.overlay`（`WS:4367-4372`），
  而 `shell.overlay` 正是本仓 layout fork 声明的座席（`packages/dsh-chamber-client-ui-layout/src/client/index.ts#apply` 的
  `slots.register` 子座席表 `shell.overlay`）并由官方 `AppFrame` 渲染（fork `:22`/`:181`；`renderSlot("shell.overlay")`
  见产物 `dsh-client-ui-layout/lib/client.js`）
  ⇒ **模态真的出现，不是死件**。真正没有消费者的是三个：`session.search`→`controls.search`（:147）与
  `workspace.add`→`controls.add`（:153）只把 `searchRequest`/`addRequested` 写进被覆盖的官方浏览器 store；
  open-in 的 `workspace.openLocal` 是另一种死法——键被消费、`currentApp()` 恒 undefined、无可见反馈
  （见 STATUS「无法控制的差异」的死键条）。`workspace.add` 的 `noPicker` 门
  （`WS:106` 的 `addReason()`）要求 `sidebar.workspaces.directoryFlow` 座席为空，而本仓为每个托管来源 pin 了
  `directory-picker-browse`（`packages/renderer/src/chamber-entry.ts:105-110`；picker 在 `packages/dsh-chamber-client-ui-directory-picker-browse/src/client/index.ts:86-92` 注入该座席）⇒ 门放行、
  只写 `addRequested: true`（`WS:28-50`）——静默死件，**不是** `shortcut.noPicker` 的 blocked。
- 为何要裁（**注册表语义已实测，候选只剩「不动注册表」两条**）：pin 的 `dsh-client-shortcuts/lib/client.js`
  `ShortcutRegistry.register` 在 :589 对重复 id 抛 `Duplicate shortcut command`、在 :602 逐 runtime×platform 校验默认键重叠并抛
  `Conflicting shortcut defaults`（:598/:599 另拒 Web 不可达键与保留键）⇒ A. 覆盖注册同名 id **必然抛错**；
  B. 自建 `chamber.*` 沿用同一默认键 **必然撞默认键冲突**，换键则键帽不再是官方键。可做的只有：
  C1 维持现状（键帽只展示，官方键按上面两类结果走）；C2 先实机验证一次（store 级的三个是否确实生效、归档在活动会话上是否静默无效），再决定登记口径。
- 归档面：`session.archive` 在活动会话上走官方**两段式**（注入点 `WS:4193-4216` 的 `archiveRequest` +
  `settleSessionArchive`/`stopAndArchiveSession`），确认框是 `SessionArchiveConfirmDialog`（`WS:3466`，注册于 :4373-4378）——
  与重命名模态同属 `shell.overlay` 座席，**本仓可见**；与本仓自己的两段式确认（行菜单项/行内钮入口）不叠加：一次按键只弹官方那一层。
  `RowActionToast`（`WS:3806`，注册于 :4379-4385）同座席，归档结果提示同样可见。
- **C2 实机判定清单**（任一来源已挂载即可；按键用 pin 的默认绑定）：
  1. 活键面：`session.new` = **⌘N** 应真的新建；`session.fork` = **⌥⌘F** 应真的分叉；`session.rename` = **⌥⌘R** 应弹出官方
     重命名模态；`session.archive` = **⇧⌘A** 在**有活动工作**的会话上应弹出官方「停止并归档」确认框；
  2. 不叠加面：一次 ⌥⌘R 只出现官方模态（本仓行内重命名不被触发）；一次 ⇧⌘A 只出现官方那一层确认（本仓两段式对话框不叠加）；
  3. 死键面：`session.search` = **⌘K**、`workspace.add` = **⌘O** 预期无可见反应（两者只写被覆盖浏览器的 store；
     `workspace.add` 是静默 store 写，不会出现 `shortcut.noPicker` 的「目录选择器不可用」提示）。
  结论落法：1/2 成立 ⇒ 键帽保留现状（C1）；3 若某个键意外有反应，说明该 store 另有消费者，需重查再登记。
  注册表不动（`register` 的重复 id / 默认键冲突语义已封死）。
- STATUS 分类：本条归「无法控制的差异（外部约束）」——注册表语义与被覆盖的官方浏览器都不是本仓能改的面；
  这里保留的裁决只有「是否做 C2 实机判定 / 如何登记」。

### 1.4 重命名交互：模态 vs 行内

- 上游：session 重命名走 `shell.overlay` 模态 `SessionRenameDialog`（`WS:3703/4372`）、workspace 重命名走 Modal
  （`WS:3316-3340`）。
- 本仓：两者都是行内 `ServerSectionRenameForm`（双击进编辑，design 06 §2.2 的既有交互）。
- 为何要裁：行内重命名是 chamber 的既定交互（且拖拽/pending-click 都围着它写），换模态是交互层重写而非样式抄齐。

### 1.5 search 的展开/收起形态（inline 槽 vs 胶囊常驻）

- 上游：inline 搜索槽 `max-width .18s` 展开、输入透明度/宽度过渡、`search-skeleton` 骨架行（`WS:3109-3243` +
  `WorkspaceBrowser.module.css`）；`search` 标签键已在 §2 收敛，不在此列。
- 本仓：胶囊行常驻（展开即挂载，无过渡/骨架），是 design 06 §1 的既有形态。
- 为何要裁：动画/骨架要新 DOM 结构与时长契约，且会改动 design 06 §1 的胶囊行设计（不是样式抄齐）。

## 2. 维持的差异与裁决（不再逐条论证）

- **品牌回退**：mark 回退保持 chamber `BrandWordmark`（自有产品标识，rail 态已是上游 `FishLogo`）；name 洞维持空回退
  （上游 `brandName ?? localBuild` 的版本徽标需要构建版本事实，本仓无该事实）。属「我们自己的功能」，不列为待裁。
- **Windows 标题栏**：随 design 23 的 Windows 腿落地时照抄上游整块 `[data-windows-titlebar]` CSS 与分支；属性本身已由
  win32 preload 的 `markWindowsTitlebar` 写入（`packages/desktop/upstream-seats.test.ts` 钉住），侧栏形态仍属该腿未落地范围。
- **会话卡状态行 0–1**：维持 design 06 §7 ⑥ 的登记偏差（只在有状态时渲染，不兜底常在的 `status.idle`）。
- **文案键选择**：搜索钮 aria-label 用 `search.sessions.aria`（上游 tooltip 键 `search` 回落到 `common`；本仓语义更具体，不追）；
  workspace 卡复制键用 `action.copy`（上游 `t("copy")`，值/语义一致，仅键名不同，未列为偏差）；上游搜索占位符与 `+` tooltip
  文案已逐字对齐（`actions.newSession` 等独立键）。
- **路径缩写**：上游 `abbreviateHomePath(cwd, home)`；本仓**选择**绝对路径——`dsh-api-remotes` 的 `home` 面即上游
  `useHostInfo` 读的同一面，事实可达，只是不缩写。
- **clear 钮命中盒**：维持回退命中盒 18px（上游 24px）；ink/hover/字形与圆角已是上游值（登记在 design 06 §7）。
- **workspace 卡会话数**：维持上游形态（标题 + 路径 + 创建时间），不加 chamber 会话数行。
- **菜单密度**：照旧传 `compact`（实测值：item min-height 24px / padding 2px 6px / r-sm 8px / 11px·17px、list 156px/pad 4px、
  label 3px 6px / 10px·15px、itemIcon 12px；默认 item 34px / 13px·20px / r-md、`.list` 144px/pad 4px），菜单行比侧栏 26px
  行矮 2px 记为接受偏差；若要抬到 26px，pin 的 `Menu.listClassName` 是唯一干净入口。
- **其余布局/交互维持项**：行高/字号密度（26px 行、13px 标题、20px 命中盒）、行动作簇 4px/20px、来源 accent 与多来源分组、
  折叠入场动画删除、`RowHoverCard` 自持（vendor 竞态；上游修掉即退役）、darwin vibrancy 门、`sidebar.workspaces` 只声明不渲染、
  `sidebar.toggle.badge` 不做、完成状态品牌蓝点、默认 `orderBy=manual`（偏差 B1）、flat/workspace-tree 与归档过滤已于 2026 对齐轮落地（per-source，design 06 §3.4）、
  `data-chamber-row` 锚点、归档确认对话框（本仓两段式）、
  **面板轴入口按来源下挂**（宽态来源头动作簇内的紧凑入口、静息 `display:none`；rail 上游字形行；design 05 §2 / 06 §4.7）。

指针：design 06 §7、design 24 §1、STATUS 的对应条目与 `docs/checklists/upstream-touchpoints.md`（registry 触点门）。

## 3. 复核发现但未落地的清洁项（非裁决）

- **命中盒几何无测试锁**：六个小图标钮命中盒 = 视觉盒现在只有 CSS 注释与 design 06 §7 登记兜着；重加 rim / 改命中盒前先补一条几何锁。
- **补锁候选（低优，未做）**：`RowHoverCard.tsx` 的 `onClickCapture` 无源码锁（与 `onPointerDownCapture` 同址调
  `intent.press()`，上游 `dismissFromAnchor` 双挂）；`session-title-marquee.ts` 的 `range <= MIN_TITLE_REVEAL_PX` 早退与
  reduced-motion 直达分支未被 4 条单测覆盖；`row-render-cost.test.ts` 的 `faces.length === 13` 等号与 ctxValue 的
  key==deps 动态对账是**有意**的收紧（合法新增一个 face/字段会红，改前先确认清单）。
- **生效 dwell 与 C15 面**：C15 的 `TIMING_PAIRS`（`verify-upstream-touchpoints-hover.mjs`）只锁原子默认 500 与
  `HOVER_OPEN_DELAY_MS`；两处 call site 的 `openDelayMs={800}`（`ServerSection.tsx`、`ServerSectionRows.tsx`）是**生效值**却无锁。
  要么在侧栏测试里加一对源文本锁，要么把 `TIMING_PAIRS` 扩成「上游 rows call 值 == chamber call 值」（后者会改 C15 判据与其
  8 条夹具用例，动前先确认）。
- **遗留锚的符号化**：design 06 里两条重定位的上游锚（`InstanceView.tsx` 的 `dismissVisibleRowCard()` 与 `SessionTodoArea.tsx`
  的 `.todoHeader`）路径已核准确，但仓库规范要求新锚写符号锚（`…tsx#=literal:dismissVisibleRowCard()` 形态，预算只降不升）。
- **`ServerSection.tsx` 形态**：两处 IIFE（workspace 行动作簇；唯一局部量 `repoLayouts` 却包住约 550 行 JSX）与整体 12 空格
  多缩进可无损改写，但会动全文件行号与既有源码锁，留待专门一轮。
- **投影查询四份实现**：`ServerSectionSearch.tsx` 的 `searchRowLabel`/`projectedRunning`/`projectedHasActiveSchedule` 各写一遍
  线性扫描，`server-section-model.ts` 的 `projectionHasSession` 是第四份；可收敛为一个 `findProjected`。
- **防御性 NaN 加固**：`ServerSection.tsx` 的门只判 `createdAt === undefined`，而 `createdLabel` 对任意 number 逐字格式化；
  今天不可达（唯一写入点 `derive.ts` 用 `Number.isFinite` 稀疏写入），若将来出现第二写入点需同时加有限性判定。

## 4. 复用准则（下一轮沿用）

1. 上游有源码路径导出 → 经 `types/vendor-modules.d.ts` + registry `vendorSourceConsumers` 直接消费；
2. 非导出的纯函数 → 逐字拷入 + 出处注 + 语义锁测试（先例：`session-title-marquee.ts`）；
3. 结构不同的可见面 → 只复用片段（CSS 值 / JSX 形态 / 字典键），逐值对照后替换本仓旧值。
