# 上游 UI 对齐：剩余待裁面（侧栏 / 工作区）

用户报告的四例（workspace 悬停卡缺 path/创建时间、`+`/头部控件样式、长标题跑马灯、按钮与菜单快捷键提示）
与同批判定「非有意、非 chamber 功能面」的其余条目，已按上游 pin `0.1.7-rc.2` 的代码逐字落地（旧逻辑删除、测试与
design 同批更新；已落地面的契约见 design 06 §7、design 05 §2）。本文件只留**仍需裁决**的差异与已裁决维持项，
作为下一轮的入口。

判据口径：`SB` = 安装包内未压缩的 `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` 行号；`WS` =
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 行号；本仓 = `packages/dsh-chamber-client-ui-sidebar`。

## 1. 待裁决

### 1.1 pinned 会话（本仓零支撑）

- 上游：树节点 `pinned: !archived.has(id) && pinned.has(id)`（`WS:450-465`）；置顶序在 `sectionMembers`（`WS:371-382`）；
  菜单项 pin/unpin（`WS:3630-3643`，order 100）+ 行 hover 按钮（`WS:3649-3668`，order 200）+ 静息 `PinnedIndicator`
  （`WS:1441-1450`、行内 1636）；拖拽分区边界由 `sectionMembers` 决定；`pinnedSessionIds` 来自 registry 级 rowState。
- 本仓：`pinnedSessionIds`/pin/unpin/`IconPin*` 在 sidebar 与 core **零命中**；`ChamberServerWorkspace.sessions`
  无 `pinned` 字段，derive 无置顶序；行 hover 动作簇是本仓设计，但已按上游形态补上第二个成员
  （kebab + 独立归档钮 `ArchiveSessionRowButton`，design 06 §7；pin 行按钮仍零支撑）。
- 为何要裁：①这是一项**宿主写能力**（pin/unpin 会改宿主 rowState），不是样式；②完整对齐需消费上游 rowState 面
  （本仓当前只读 workspaces/sessions 两个 store）并把置顶序接进**本仓自有的会话拖拽排序**（`sessionOrderOverride`），
  与 `sidebar.workspaces.*` 座席「只声明不渲染」的既有裁决（design 24 §1、STATUS）直接相邻。
- 候选落法：A. 只做展示半（指示器 + 置顶序，无动作）＝无用（无人能 pin）；B. 菜单项 pin/unpin + 指示器 + 置顶序 +
  拖拽分区守卫（不渲染 `sidebar.workspaces.session.menu.item` 座席，走本仓菜单）；C. 不落，登记为有意缺失。
- 证据：`packages/dsh-chamber-seed-archive-cleanup/test/binding.test.ts`（宿主 state 确有该字段，本仓只做透传保护）。

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
  `directory-picker-browse`（`packages/renderer/src/chamber-entry.ts:105-110`；picker 在 :1027 注入该座席）⇒ 门放行、
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

### 1.4 官方 schedule 两座席

- 上游：ui-schedule 注册 `sidebar.session.row.leading`（idle 行活动任务标记）与 `sidebar.session.row.hover`（悬停卡任务列表）
  （`@deepseek-ai/dsh-client-ui-schedule` 的 client bundle，两个 `sidebar.session.row.*` 注册），两座席由 `sidebar.workspaces` 的 children 表声明（`WS:4307-4314`）。
- 本仓：未声明两座席（`sidebar.workspaces` 只声明不渲染的裁决之下），改用自有 `SessionScheduleIndicator`（标题后）
  与自有卡片内容。
- 为何要裁：要接官方座席，须先解开 `sidebar.workspaces` 的座席裁决（design 24 §1）或在**本仓自有行内**渲染官方座席
  的注册项（跨插件渲染面），二者都是架构级选择。

### 1.5 重命名交互：模态 vs 行内

- 上游：session 重命名走 `shell.overlay` 模态 `SessionRenameDialog`（`WS:3703/4372`）、workspace 重命名走 Modal
  （`WS:3316-3340`）。
- 本仓：两者都是行内 `ServerSectionRenameForm`（双击进编辑，design 06 §2.2 的既有交互）。
- 为何要裁：行内重命名是 chamber 的既定交互（且拖拽/pending-click 都围着它写），换模态是交互层重写而非样式抄齐。

### 1.6 search 的展开/收起形态（inline 槽 vs 胶囊常驻）

- 上游：inline 搜索槽 `max-width .18s` 展开、输入透明度/宽度过渡、`search-skeleton` 骨架行（`WS:3109-3243` +
  `WorkspaceBrowser.module.css`）；`search` 标签键已在 §2 收敛，不在此列。
- 本仓：胶囊行常驻（展开即挂载，无过渡/骨架），是 design 06 §1 的既有形态。
- 为何要裁：动画/骨架要新 DOM 结构与时长契约，且会改动 design 06 §1 的胶囊行设计（不是样式抄齐）。

## 2. 无需裁决：已按「与上游一致」或推荐落法收敛（2026-02 复核批）

- **品牌回退**：mark 回退保持 chamber `BrandWordmark`（自有产品标识，rail 态已是上游 `FishLogo`）；name 洞维持空回退
  （上游回退 `brandName ?? localBuild` 的版本徽标需要构建版本事实，本仓无该事实）。**属「我们自己的功能」，不再列为待裁。**
- **Windows 标题栏**：按推荐 B —— 随 design 23 的 Windows 腿落地时照抄上游整块 `[data-windows-titlebar]`
  CSS 与分支。**更正前提**：属性并非「永不设置」，Electron win32 的 preload 已在 `markWindowsTitlebar` 里写
  `root.dataset.windowsTitlebar=''`（`packages/desktop/preload.cts`，`packages/desktop/upstream-seats.test.ts` 钉住）；
  但侧栏的 Windows 形态属 design 23 未落地范围（design 23 与 `todo/windows-v1.md` 对 titlebar/侧栏零描述），
  故照抄整块仍随该腿，不在本轮落。
- **会话卡状态行 0–1**：维持 design 06 §7 ⑥ 的登记偏差（本仓只在有状态时渲染，不兜底常在的 `status.idle`）。
- **search 的 `search` 标签键**：上游搜索钮 tooltip 用 `t("search")`；该键不在 workspace 命名空间，但 locale 解析会回落到
  `common`（`dsh-client-locale/lib/client.js` 的 `lookup(ns,key) ?? lookup('common',key) ?? key`；common zh「搜索」/ en "Search"）。
  本仓以 `search.sessions.aria`（「搜索会话」/"Search sessions"）作 aria-label——语义更具体、与上游可见文案不同，登记为文案选择（不追）。
- **路径缩写**：上游 `abbreviateHomePath(cwd, home)` 在 home 缺席时原样返回。本仓**选择**绝对路径（范围选择，不是外部约束）：
  `@deepseek-ai/dsh-api-remotes` 由本复合入口注册（`packages/renderer/src/chamber-entry.ts:431`），其 Remote schema 带 `home`，
  正是上游 `useHostInfo` 读的同一面 ⇒ 事实可达，只是本仓不缩写。
- **clear 钮命中盒**：按推荐 A 维持登记的回退命中盒 18px（上游 24px）；ink/hover/字形已是上游值；小图标钮
  （`.actionIcon`/`.searchButton`/`.searchClear`/`.foldToggle`/`.sourceFoldToggle`）圆角统一 `--dsw-radius-xs`，
  `.railDotButton` 是 8px 点的无圆角热区；登记在 design 06 §7。
- **workspace 卡会话数**：维持上游形态（标题 + 路径 + 创建时间），不再加 chamber 会话数行。
- **菜单密度数值更正（本轮复核）**：design 06 §7 原文把原语 `compact` 记成「item 26px/12px、容器 r7/pad 2px/
  min-width 164、item r5、图标槽 14px、默认 218/4」，与 pin 的已发布 `ui-primitives/lib/Menu.module.css` 不符
  （实测 compact：item min-height 24px / padding 2px 6px / `--dsw-radius-sm`=8px / 11px·17px、list 156px/pad 4px、
  label 3px 6px / 10px·15px、itemIcon 12px；默认 item 34px / 13px·20px / r-md、`.list` 144px/pad 4px）。已在
  design 06 §7、design 20、两处代码注释按实测值改写；**代码未动**（照旧传 `compact`），菜单行比侧栏 26px 列表行矮
  2px 记为接受偏差。pin 的 `Menu` 有 `listClassName`（无 item 钩子）——若将来要把菜单抬到 26px，这是唯一干净入口。
- **search 占位符文案**：本仓原为「搜索会话…」/ "Search sessions…"，上游 WorkspaceBrowser 字典是「搜索会话名称」/
  "Search session names"；已按上游逐字改写（值变化、键不变，无测试引用旧值）。
- **新建会话 tooltip 词典键**：**已对齐上游** —— 新增独立键 `actions.newSession`（zh「新会话」/ en "New session"，值与上游 pin 的字典逐字一致），
  `ServerSection.tsx` 的 workspace `+` tooltip 改用它；`session.new`/`session.new.label` 仍服务按钮与行标签。design 06 §7 同批登记。

## 3. 已裁决维持（不再逐条论证）

行高/字号密度（26px 行、13px 标题、20px 命中盒）、菜单 `compact` 档、行动作簇 4px/20px、来源 accent 与
多来源分组、折叠入场动画删除、`RowHoverCard` 自持（vendor 竞态；上游修掉即退役）、darwin vibrancy 门、
`sidebar.workspaces` 只声明不渲染、`sidebar.toggle.badge` 不做、完成状态品牌蓝点、默认 `orderBy=manual`、
flat/workspace-tree 与归档过滤推迟、`data-chamber-row` 锚点、归档确认对话框（本仓两段式）。

指针：design 06 §7、design 24 §1、STATUS 的对应条目与 `docs/checklists/upstream-touchpoints.md`（registry 门 C1–C15）。

## 4. 复核发现但未落地的清洁项（非裁决）

两轮 review 后仍未落地的都是「改了没风险但会动到注册决定/大面积排版」的项，登记备查：

- `derive.ts` 的半截重复注释已分两轮清完（12 对相邻近重复 → 0，检测器：相邻注释行 token Jaccard ≥ 0.45）。
- **命中盒几何的测试面**：`hit-area-geometry.test.ts`（一次性批测）已删，「六个小图标钮命中盒 = 视觉盒」现在只有
  CSS 注释与 design 06 §7 登记兜着（本包 grep `18px`/`hitArea` 无测试命中）。重加 rim / 改命中盒前先补一条几何锁。
- **补锁候选（本轮 review 的低优建议，未做）**：`RowHoverCard.tsx` 的 `onClickCapture` 无源码锁（与 `onPointerDownCapture`
  同址调 `intent.press()`，上游 `dismissFromAnchor` 双挂）；`session-title-marquee.ts` 的 `range <= MIN_TITLE_REVEAL_PX`
  早退与 reduced-motion 直达分支未被 4 条单测覆盖；`row-render-cost.test.ts` 的 `faces.length === 12`/`keys.length === 43`
  等号是**有意**的收紧（合法新增一个 face/字段会红，改前先确认清单）。
- **生效 dwell 与 C15 面**：C15 的 `TIMING_PAIRS`（`verify-upstream-touchpoints-hover.mjs` 的 `TIMING_PAIRS`）只锁
  原子默认 500 与 `HOVER_OPEN_DELAY_MS`；两处 call site 的 `openDelayMs={800}`（`ServerSection.tsx`、`ServerSectionRows.tsx`）
  是**生效值**却无锁。要么在侧栏测试里加一对源文本锁，要么把 TIMING_PAIRS 扩成「上游 rows call 值 == chamber call 值」
  （后者会改 C15 判据与其 8 条夹具用例，动前先确认）。
- **遗留锚的符号化**：本批重定位的两条锚（design 06 里那两条上游锚——`InstanceView.tsx` 的 `dismissVisibleRowCard()` 与 `SessionTodoArea.tsx` 的 `.todoHeader`——路径已核
  准确，但仓库规范要求新锚写符号锚（`…tsx#=literal:dismissVisibleRowCard()` 形态，预算只降不升）；转换属 docs 面清理。
- `ServerSection.tsx` 的两处 IIFE（一处是 workspace 行动作簇，一处唯一局部量是 `repoLayouts` 却包住约 550 行 JSX）与
  自文件头部起的整体 12 空格多缩进：形态比上游绕，可无损改写为普通 const/组件结构，但会动整个文件的行号与既有
  源码锁，留待专门一轮。
- **投影查询四份实现**：`ServerSectionSearch.tsx` 的 `searchRowLabel`/`projectedRunning`/`projectedHasActiveSchedule`
  各写一遍线性扫描，`server-section-model.ts` 的 `projectionHasSession` 是第四份；可收敛为一个 `findProjected`。
- **复制文案键粒度**：上游 workspace 卡用 `t("copy")`（共享命名空间），本仓用 `action.copy`；值与语义一致，仅键名不同，
  未列为偏差（`design 06 §7` 的「同形」指卡片结构与行为）。
- **防御性 NaN 加固**：`ServerSection.tsx` 的门只判 `createdAt === undefined`，而 `createdLabel` 对任意 number 逐字格式化；
  今天不可达（唯一写入点 `derive.ts` 用 `Number.isFinite` 稀疏写入），若将来出现第二写入点需同时加有限性判定。

## 5. 复用准则（下一轮沿用）

1. 上游有源码路径导出 → 经 `types/vendor-modules.d.ts` + registry `vendorSourceConsumers` 直接消费；
2. 非导出的纯函数 → 逐字拷入 + 出处注 + 语义锁测试（本轮：`session-title-marquee.ts`）；
3. 结构不同的可见面 → 只复用片段（CSS 值 / JSX 形态 / 字典键），逐值对照后替换本仓旧值。
