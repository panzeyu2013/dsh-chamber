# 迁移复核（dsh-chamber → dsh-v0.1.5-alpha.2）逐模块逐文件审计

> 对象：本轮迁移的 4 个提交（`ebaa64e` 文档 → `896c3d3` 源码线重锚 → `130250e`
> 设计 24 + 运行时线 → `c9c2efe` 必需行探针）+ 复核后修复。
> 方法：4 个独立只读复核 agent（V1 layout+mobile / V2 sidebar+bridge / V3 forks+renderer /
> V4 seeds+runtime+docs）逐文件对照上游 alpha.2 源码，加本机机械扫描（残留标识符、版本锚、
> 产物新鲜度）与全量门禁实跑。
> 结论：**0 BLOCKER / 0 MAJOR 遗留**（1 个 BLOCKER 与 3 个 MAJOR 已在复核后修复），
> 详见下表。

## 0. 结论总览

| 域 | 复核者 | BLOCKER | MAJOR | MINOR/NIT | 处置 |
|---|---|---|---|---|---|
| layout fork + mobile | V1 | 1（mobile `lib/client.js` 陈旧产物） | 3 | 12 | **全部修复** |
| sidebar fork + settings bridge | V2 | 0 | 0 | 9 | 全部修复（1 项为复核期间并发修复） |
| 三 fork 副本 + renderer | V3 | 0 | 0 | 12 | 全部修复（2 项为登记/注释） |
| 归档清理 + 运行时锚 + 文档 | V4 | 0 | 5 | 14 | 全部修复 |

机械扫描（本仓全树，排除 vendor/node_modules/dist/`.analysis`）：
`DETAILS_MIN|MAX|DEFAULT`、`openDetails|closeDetails|setDetails`、`setNarrow`、`attachPanels`、
`deriveCollapsed`、`stampSessionLogDismiss|SESSION_LOG_`、`data-details-collapsed`、
`CONVERSATION_SESSION_HEADER_SLOT|findHeaderSlot`、`isSessionLogExportButton`、
`data-slot="conversation"` → **全部 0 命中**；`0.1.3-alpha.2` 仅剩历史叙述（触点表 delta 日志、
决策矩阵与 STATUS 的历史条目）。

## 1. 逐文件判定（迁移面 64 文件）

| 模块 | 文件 | 判定 | 依据/备注 |
|---|---|---|---|
| **源码线** | `harness.commit` | OK | `b2e3b2a01258` == gitlink == submodule HEAD（C5 实跑） |
| | `pnpm-lock.yaml` | OK | frozen 前后哈希一致；vendor importer 284 条 |
| **layout fork** | `src/client/index.ts` | 修复 | 装配与上游逐行等价；`collapsedOf` 改为从 store-core 导入（原私有、零覆盖） |
| | `src/client/store-core.ts` | 修复 | 8 动作/嵌套 state/columns 面与上游等价；采纳循环补 per-instance try/catch（注释曾声称隔离而实现没有） |
| | `src/client/stores.ts` | OK | 生产环境 + `trackLayoutInstance` 转发 |
| | `src/vendor-modules.d.ts` | OK | columns/service/AppFrame 面与 alpha.2 对齐 |
| | `test/layout-store.test.ts` | 修复 | 18 → 20 例：补 `collapsedOf` 4 组断言 + 采纳异常隔离 |
| | `README.md` | 修复 | 补 document-theme / layoutFacts / store-core；`inject` 补 `locale` |
| **mobile** | `lib/client.js`(+map) | **修复（BLOCKER）** | 旧产物仍遍历 `conversation/details` 槽 → alpha.2 下主列落 0px 轨、手机端会话区不可见；已重建（新产物含 `details:"rightbar"`、无退役机制） |
| | `src/client/markup.ts` | 修复 | `ROLE_SLOT_KEYS`；DOM 文档改正（无 `main.conversation` 包装层） |
| | `src/client/layout-facts.ts` | 修复 | tier1 用 `facts.getCollapsed()`；tier2 null 语义加注释 |
| | `src/client/index.ts` | 修复 | 右列出口常驻事实改正；退役打标调用移除 |
| | `src/client/styles.ts` | 修复 | 退役覆盖层/胶囊块删除；层级 74/75/76；`[class*="_row_"]` 副作用注释 |
| | `src/client/composer.ts`/`settings-sheet.ts` | 修复 | 锚点版本注更新 |
| | `test/breakpoints.test.ts` | 修复 | 选择器→z-index 配对断言 + 退役机制零残留断言 |
| | `test/markup.test.ts` | 修复 | 槽键改 `main`/`rightbar`；退役用例删除；形状前提更正 |
| | `test/drawer-state.test.ts` | 删除 | 公式已上移到 layout fork 并补测 |
| | `README.md`/`README.zh.md` | 修复 | 退役机制段落改写；锚点基线 → alpha.2 |
| **sidebar fork** | `src/client/contract/slots.ts` | OK | 三处新声明 + 类型与上游逐字一致 |
| | `src/client/index.ts` | 修复 | `selectPanel` 改直调（探测式理由不成立：两种 layout 都有该方法）；`syncPanels()` 移到注册后 |
| | `src/client/panel-source.ts` | OK | 投影语义与上游 `syncPanels` 等价；内联 `resolveSlotLabel` 加理由 |
| | `src/client/SidebarRoot.tsx` | 修复 | PanelRow 组件内取选择态；brand.name 无 fallback 的理由写明 |
| | `src/client/SidebarRoot.module.css` | 修复 | 面板行几何改镜像上游（无水平 padding、36px 行高、collapsed 36×36） |
| | `src/client/locales.ts` | OK | `panels.label` 中英齐 |
| | `src/vendor-modules.d.ts` | OK | `HostObservable`/`InjectFace`/`MainPanelId`/`renderSlot opts` 补声明 |
| | `test/panel-source.test.ts` | OK | 5 例（排序/tiebreak/thunk/id 缺失/变更通知） |
| | `test/panel-wiring.test.ts` | **新增** | 3 例源文本锁：声明/children+注入/渲染点+CSS 类 |
| | `README.md` | 修复 | 新增「alpha.2 extension holes」段 |
| **settings bridge** | `src/client/bridge-context.ts` | OK | 子 ctx children 6 键与官方 ui-sidebar 逐键同构 |
| | `src/client/bridge-outlet.tsx` | 修复 | `usePanelInfo` 稳定快照（原每次新对象 → uSES 无限重渲染坑）；悬空 JSDoc 合并；缺 `useResource` 的理由写明 |
| | `README.md` | 修复 | 新增「alpha.2 ledger parity」段 |
| **三 fork 副本** | connection `README×3`/`fixture.ts`/`src/index.ts` | OK | 与上游 alpha.2 **逐字节相等**（cmp+sha256） |
| | connection/client-web/api-gateway `package.json` | OK | 版本 0.1.5-alpha.2 == 上游 |
| | client-web `platform.ts`/`seed.ts` | OK | 未 seed dockkit、未加依赖、tsconfig 不镜像（登记在触点表 §2.4） |
| **renderer** | `chamber-covered.ts`/`chamber-entry.ts` | 修复 | 53/25、dockkit 仅 factory；探针抽纯模块 + ctx 生命周期定时器 |
| | `required-extra-rows.ts` | **新增** | 纯判定 + 消息 + 常量（3 例单测） |
| | `vendor-modules.d.ts` | 修复 | 补 `ctx.effect` 与 dockkit 模块声明 |
| | `typert-remote-contract.test.mjs` | OK | 15 项集合与顺序与 vendor 装配一致 |
| **归档清理** | `src/binding.ts` | 修复 | `list()` 快照形状、`stat()` 存在性、全代际+`.tmp`+租约删除、未识别条目整单拒绝、非数组枚举 loud、`assertHostSurface` 加 `stat`、跨进程/不可物化语义注释 |
| | `test/binding.test.ts` | 修复 | 夹具改 alpha.2 形态 + mkdtemp；补形状/边界/临时件/非数组用例（24→26 例） |
| | `dist/index.js` | OK | 与源码重建逐字节一致 |
| **运行时线** | 六锚（bundle-dsh / vendor 锁文件 / release.yml / install-gateway / gateway pkg / release-preflight） | OK | 全部 0.1.5-alpha.2；`bin.js --version` 冒烟通过；preflight 双线门实跑通过 |
| | `dsh-runtime/dist`、`git-worktree/dist` | OK | 陈旧补建（与源码逐字节一致） |
| **文档** | `CHANGELOG` 双语 + `i18n-record` | OK | 结构等价（11/30 条）；5 对 consistent |
| | `STATUS` / 触点表 / checklist / design 24 / design 17 / release-checklist / performance-baseline | 修复 | 见 §2 |
| | `decision-matrix` / `diff` 报告 | 修复 | 加执行状态块、缺陷编号口径统一 |

## 2. 复核发现与处置（按严重度）

### 2.1 BLOCKER（1，已修）

| # | 发现 | 处置 |
|---|---|---|
| B1 | `packages/dsh-chamber-client-ui-mobile/lib/client.js` 是 alpha.2 之前的旧 bundle，而它正是 `exports["./client"]` 指向、gateway 逐字节 seed 的那份。旧 `stampFrame` 只认 `conversation`/`details` 槽 → alpha.2 下只有 sidebar 列被打 role，`grid-column:2` 失效，主列落入 0px 轨（插件自己记录的 P1-C 故障）＝手机端会话区不可见；另带退役打标与旧层级。 | 重建 `lib/client.js`(+map) 并提交；产物内含 `details:"rightbar"`、无 `data-mobile-dismiss`/旧 z-index。 |

### 2.2 MAJOR（4，已修）

| # | 发现 | 处置 |
|---|---|---|
| M1 | 保鲜门 C8 声明检查 mobile 产物，实现只查 3 个 host dist → 「C1/C3–C8 全绿」与陈旧产物并存。 | `verify-upstream-touchpoints.mjs` 的 `artifacts` 加 `mobile/lib/client.js`；doc 同步。 |
| M2 | 迁移未提交完（mobile 8 文件锚点清理仍在工作树）。 | 本轮统一提交（见 §4）。 |
| M3 | mobile 中英 README 仍文档化已退役的 Session 日志打标。 | 两处改写为「alpha.2 退役」并说明上游替代。 |
| M4–M8（V4） | design 24 仍写「not-found 载体 ⇒ false」、称 `locate` 已退役/零布局知识、缺修复③契约；upgrade-checklist 仍写「未升级」；decision-matrix 缺陷未标已修。 | design 24 全文对齐 `stat`/全代际/租约/未知条目语义并补 §22⑦⑨⑩；checklist §9 改「已执行」+ 六锚/284；matrix 加执行状态块并统一编号口径。 |

### 2.3 MINOR / NIT（已修或已登记）

- layout：`collapsedOf` 零覆盖 → 上移 + 4 组断言；采纳循环无 try/catch → 补；README 过期 → 重写。
- mobile：CSS 断言只查数字 → 改选择器配对；`[class*="_row_"]` 扩大命中 → 注释；tier2 null → 注释；右列出口常驻事实 → 3 处改正。
- sidebar：`selectPanel` 探测式 → 直调（失败要 loud）；`.panelList` padding/行高 → 镜像上游；wiring 无断言 → 新增 3 例；README → 补段。
- bridge：`usePanelInfo` 快照引用稳定性（复核期间并发修复，复核确认正确）；悬空 JSDoc → 合并；缺 `useResource` → 写明「无当前消费者，不加」。
- renderer：探针定时器未挂 ctx → `ctx.effect` + `clearTimeout`；探针零单测 → 抽 `required-extra-rows.ts` + 3 例；C4 只验长度 → 改集合+顺序 deepEqual；探针消息补 instanceId；`?.` 冗余 → 去掉。
- 归档清理：非数组枚举静默跳过 → loud 拒绝；`assertHostSurface` 缺 `stat` 检查 → 补；`.tmp` 残留导致整单拒绝 → 纳入可删集合；固定 `/tmp/x` 夹具（本机 1/24 失败）→ mkdtemp；覆盖缺口（符号链接/子目录/v0/前导零/.zst/临时件）→ 5 组新断言。
- 文档数字：触点表/STATUS 的「13」→15；release-checklist/performance-baseline 的 0.1.3-alpha.2 → 0.1.5-alpha.2；release-preflight 注释；chunk 预算校准注释（chamberEntry 距 warn 门仅 1.2%，已写明）。

### 2.4 明确不修（有据）

| 项 | 理由 |
|---|---|
| D3 patched-copy 基础设施 | 待用户裁决（决策矩阵 §5.3）；本轮未动。 |
| D4 open-in in-repo basePath fork | 待用户裁决；现平行件保持。 |
| D5 官方桌面插件窗口 vs PluginDialog | 待用户裁决（倾向保留统一模型）。 |
| bridge kit 的 `useResource` 空座 | 无当前消费者（仓库规则：只为现役消费者加座）。 |
| client-web 保留未消费的 ui-primitives/ui-theme/react 依赖 | 上游同款清单；非本轮引入的 manifest 卫生项。 |
| `shared/derive.ts` 等上游语义移植 | 上游 `ui-workspace/src/client/tree.ts` 在本区间**零改动**，镜像仍有效（每次升 pin 人工复验）。 |

## 3. 复核实跑的绿门（本轮修复后）

- typecheck：根 + `runtime` + 12 个包/插件面（layout/mobile/sidebar/settings-bridge/
  host-archive-cleanup/open-in/git/connections/client-web/connection/api-gateway）全 OK。
- test：control-plane / gateway / desktop / renderer-shell / layout / mobile / sidebar /
  settings-bridge / host-archive-cleanup / connection / client-web / git / host-git /
  open-in / connections / cli / upgrade-tools / release-workflow 全绿；
  `test:runtime` 仅既有 ZFS rich-fixture 登记失败。
- build：`build:renderer`（预算内）、`build:host-packages`、`build:preload`、
  `bundle:dsh`（`bin.js --version` = 0.1.5-alpha.2）、mobile `build`（lib/client.js 刷新）。
- 保鲜/一致性：`verify-upstream-touchpoints`（C1/C3–C8）、`verify:i18n`、
  `ensure-harness-vendor --check`（284）、`pnpm install --frozen-lockfile`、`smoke` 全绿。

## 4. 复核后修复的提交边界

本轮修复与登记作为**独立提交**落在迁移 4 提交之后（`fix(upgrade): 复核修正 …`），
不与迁移提交混同，便于回溯「迁移本身」与「复核修正」两类改动。

## 5. 仍未验证（与迁移提交一致）

实机多来源 sleep/wake 与隐藏恢复、gateway 形态回归、右侧栏栈在真实 profile 下的装载时序、
`provideRoot` 时序（`useResource`/`usePanelInfo`）、session v3 迁移在真实存储上的行为、
mobile 产物的真机视觉（`[data-mobile-role]` 三值与主列宽度）、探针 5s 窗口是否足够。
