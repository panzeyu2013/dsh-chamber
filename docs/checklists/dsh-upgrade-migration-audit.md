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
| **renderer** | `chamber-covered.ts`/`chamber-entry.ts` | 修复 | 53/25（**三轮后 54/26**：`client-file-upload` 转 covered）、dockkit 仅 factory；探针抽纯模块 + ctx 生命周期定时器 |
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

---

## 6. 第二轮复核（2026-09，3 个独立只读 agent + 本机机械扫描）

> 对象：迁移 4 提交 + 第一轮复核修正（`7439861`）之后的全部改动；本轮修正与本文件同批提交
> （`fix(upgrade): 二轮复核修正…`，紧接 `7439861` 之后）。
> 方法：W1 **对抗式回归审查**（逐项验证第一轮修复是否真的修好、是否引入新问题）、
> W2 **从 alpha.2 源码独立重推端到端链路**（boot 时序 / 首屏服务提供方 / 归档清理 /
> 种子探针）、W3 **全仓一致性扫描**（版本锚、计数、登记表、门禁实跑）。
> 结论：**0 遗留 BLOCKER**；2 个 MAJOR（一门失效、一依赖漏登）与 6 个 MAJOR/MINOR
> 实质缺陷全部修复，其余为登记/措辞修正。
> **⚠ 本节「门禁全绿」的成立前提已被第三轮推翻**：W4 证明当时 C1/C3、C4-roster 违规
> 不影响退出码、C8 在 CI 空转且构建不可用时 fail-open。三处均已在第三轮修复（见 §9.1
> T1–T3）；引用本节结论时请一并读 §9。报告原文：`.analysis/out/W{1,2,3}-*.md`（scratch，不入库）。

### 6.1 实质修复（代码/测试/门禁）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| R1 | **MAJOR（门失效）** | C8「生成物新鲜」是 mtime 门：fresh checkout 恒误报，且**永远发现不了已提交的陈旧产物**——正是第一轮 BLOCKER 的形态（W1 N1） | `verify-upstream-touchpoints.mjs` C8 重写为**确定性重建-比对**：按包组跑各自 `build.mjs`、逐字节比对、写后原样还原，内容不一致 = 硬失败；`--no-artifact-rebuild` 退回 mtime advisory。**该门立刻抓出真缺陷 R2**；负向测试（人为污染 dist）已验红 |
| R2 | **MAJOR（产物不可复现）** | mobile `scripts/build.mjs` 缺 `absWorkingDir`：产物字节依赖调用者 CWD（仓库根构建 57,675B vs 包目录 57,295B），与 host 包 build 的既有修复不一致；gateway 逐字节 seed 该产物 | 两个 esbuild 调用补 `absWorkingDir: root`；重建后与提交态一致（C8 绿）。touchpoints §5 登记 |
| R3 | **MAJOR（依赖漏登）** | `ui-conversation` 根 inject 含 `fileUpload`，唯一提供方是**未覆盖**的 extra row `dsh-client-file-upload`；缺它时中列整块空白而 boot 仍报成功。`REQUIRED_EXTRA_ROW_SERVICES` 只列了 `sidebarRight`/`resources`（W2 F1/F2） | 清单补 `fileUpload`（+3 例断言），探针文案改为点名三行；`host-graph.ts` 降级注释改正（「复合仍提供完整 shell」在 alpha.2 已不成立）、design 09 §3.2 新增反向依赖段、touchpoints §3 登记、AGENTS 补一句 |
| R4 | **MAJOR（文档与 vendor 相反）** | design 24 §22⑦ 称官方 `stat(id)` 对空/损坏/编码不支持工件一律 `undefined`、不抛错；vendor 实际对**损坏 zstd 帧 / 代际名与 header 版本不一致 / 版本过新 / 非 ENOENT IO** 抛错（W1 N3） | §22⑦ 按 vendor 逐行改为「undefined 集合 / 抛错集合」两分；`binding.ts` 注释同步（代码行为本就 fail-closed 正确） |
| R5 | **MAJOR（能力门后果未登记）** | `assertHostSurface` 要求官方 `stat`（0.1.3-alpha.1 起）⇒ 旧宿主上 `archiveCleanup/probe` 恒 `ok:false` → 激活门 observe→fail（可触发回退），而同一缺失在 sweep 里是「跳过」降级（W1 N2） | design 24 §3 错误码段 + §22⑪ 登记**最低宿主版本 0.1.3-alpha.1**与「能力门响亮失败 / 运行期 fail-closed 降级」的分工 |
| R6 | **MINOR（永久不可清理）** | purge 白名单未认 vendor 迁移暂存名 `session.migration.<16hex>.jsonl[.zstd].tmp` ⇒ 一次中断的迁移让该会话**永久不可 purge**（W2 F5） | 新增 `isMigrationTempFilename`（精确 16 位小写 hex + 两种后缀）纳入可删集合；+2 组断言（含 12 位近失名仍拒绝）；design 24 §22⑩ 登记白名单 |
| R7 | **MINOR（白名单方向反了）** | 生成名正则 `[1-9][0-9]*` 无安全整数上界，vendor `Number.isSafeInteger` 会拒；本域却判「可删」（W1 N13） | 新增 `isCanonicalVersion`（undefined 或 safe integer），与 vendor 同判；+2 例（超界拒绝 / MAX_SAFE_INTEGER 可删） |
| R8 | **MINOR（测试空转）** | layout 采纳隔离测试只断言 writer 自身值 ⇒ 把 catch 体换成 `break` 仍全绿（W1 N5） | 改为三实例（writer / 中间抛错 / 尾随健康）+ 断言尾随实例仍采纳；**变异验证**：去掉 try/catch → 1 例红 |
| R9 | **MINOR（测试空转）** | panel-wiring 的 `panels.sync(` 被定义行满足，锁不住「注册后补同步」；locales 只查一次（W1 N6） | 改为**顺序断言**（register 索引 < 独立 `syncPanels()` 调用）+ 空白归一化匹配 + 空态/宽窄几何 + zh/en 两条文案；**变异验证**：删掉注册后调用 → 2 例红 |
| R10 | **MINOR（可见样式偏差）** | 面板列表 CSS 与上游 5 处非几何差异：`font: inherit`/`line-height: 22px`/`text-align: left`、`.panelRow.panelActive` 权重与 `bg-active` token、`.collapsed .panelList` 多 `align-items`（W1 N12） | **对齐上游**：该块现与 vendor 逐字节一致（仅保留一条说明注释），chamber 的「以上游为准」原则下不留无理由偏差 |
| R11 | **MINOR（契约双份）** | 15 项 remote 装配期望在 `verify-upstream-touchpoints.mjs` 与 `typert-remote-contract.test.mjs` 各有一份字面量，上游新增 remote 时须同改两处（W1 N8） | 期望列表**单源**到 `packages/renderer/scripts/typert-remote-contract.mjs` 的 `EXPECTED_REMOTE_PACKAGES`，两个消费者各自与解析结果逐项比对；C4 与锁步测试复跑绿 |
| R12 | **MINOR（层级未登记）** | 移动端固定层（74/75/76）挂在官方 `shell.overlay`（`position:absolute; z-index:20` 的独立栈上下文）内 ⇒ 永远压不过官方全屏右栏（z-40）/ 浮层宿主（z-60）（W2 F4） | 判定为**有意行为**（全屏官方面板接管屏幕），design 17 §18.4.3 + `styles.ts` 头注登记栈上下文与「跨栈需 body 级 portal」的取舍 |

### 6.2 文档/登记一致性修正（W3 22 项 + 本机扫描）

- **版本基线**：`STATUS.md:57`「升级在途」→ 已完成记录；`design 11` fork 基线/vendored 源 0.1.2-rc.1 → 0.1.5-alpha.2（并补全 16 包枚举）；`deploy-gateway.md` 当前版本；`desktop/README.md` pin 示例；`design 18` 内建 pin 与探针项数（六→七）；`design 17` store `narrow` 误述与旧基线；diff 文档「本仓当前 pin」标注、契约表头、运行时锚现状；`runtime-probes.ts`/`activation-gate.ts`/`binding.ts`/`index.ts` 的 rc.1 注释。
- **实现口径**：D2 由「失败转致命」改为**非致命 loud 探针**（决策矩阵 C8/§3.2/§4.2/D2 + diff 文档同步）；`selectPanel` 由「探测式」改为**直调**（矩阵 C5/D1/§4.2 + `panel-source.ts` 注释 + 双语 CHANGELOG）；vendor 链接 271→282 全部改为实测 **284**（diff 文档 ×3 + 矩阵 B1）。
- **计数**：`release-checklist` 15→16 包；`design 24` 78→85（59+26）与 51→85、284→412 测试计数；checklist §9.2 改为「执行记录（已全部落地）」并修好断句/重复清单；touchpoints §5 合并 mobile 产物重复行；settings-bridge README 与 `collapsedOf` JSDoc 的消费者描述改正。
- **登记**：矩阵 §5.2 批次状态（B0/B1/B2/B3/B4/B5/B7/B8/B9 ✅，B6 ⏳ 待 D4）；`runtime-host-adapter` 退役**未采纳**并登记理由（AGENTS 明示 documented sketch，删除须同步三处契约）；AGENTS 补 `layoutFacts`/`panellist`/必需行探针；`.analysis/` 入 `.gitignore`；`CHANGELOG` 双语补探针条目（i18n 记录重录）。
- **D3 事实补强**（W2 Q3，供用户裁决）：控制面只代理 `/api/i/<id>/*`，`/api/file` 落控制面 404 JSON；绝对实例 origin 被 CSP `img-src 'self'` 拦；最小修法是相对 `<basePath>/api/file`；ssh/http dsh 目标无 cookie 注入 → 实例侧 401（矩阵 C9/D3）。

### 6.3 第二轮绿门（修复后实跑）

- `verify-upstream-touchpoints`（C1/C3–C8，**C8 为新重建-比对门**）+ `verify:i18n` 绿；
  负向测试：污染 `dist/index.js` → C8 硬失败（exit 1）。
- 定向变异验证：layout 采纳隔离、panel-wiring 顺序锁各 1 次人为回归 → 均被抓到。
- 全量 `test:*`/`typecheck:*`/`build:renderer`/`build:host-packages`/`build:dsh-runtime`/
  `frozen-lockfile`/`smoke` 与 `bin.js --version` 见 §7。
- **本轮自查出的两个自身问题（已修，登记以示口径）**：
  ① 强化 panel-wiring 时写的断言串多写了两个空格（`{ wide && … }` vs 源文件 `{wide && …}`），
  首次「通过」是我用 `grep -c "fail 0"` 统计导致的假绿——已改为显式失败检测并复跑全绿；
  ② 全量连跑中 `test:gateway` 出现一次不可复现失败（单跑与 `control-plane → gateway`
  连跑各 2 轮均绿），判定为连跑资源竞争性瞬时失败，已登记；`test:sidebar` 的失败则是
  ① 的真实缺陷。

## 7. 第二轮全量门禁（本机实跑，2026-09）

- test（19 套）：control-plane / gateway / desktop / renderer-shell / layout / mobile /
  sidebar / settings-bridge / connections / client-web / connection / git / host-git /
  host-archive-cleanup / open-in / cli / upgrade-tools / release-workflow 全绿；
  `test:runtime` 仅既有 ZFS rich-fixture 登记失败。
- typecheck（16 项）：根 + runtime + layout/mobile/sidebar/settings-bridge/connections/
  git/open-in/client-web/connection/api-gateway/host-graph/host-git/host-archive-cleanup/
  gateway 全 OK。
- build：`build:renderer`（预算内）、`build:host-packages`、`build:dsh-runtime`、
  `build:preload`、mobile `build`；`bundle:dsh` 产物 `bin.js --version` = 0.1.5-alpha.2。
- 一致性：`ensure-harness-vendor --check`（284 链接、HEAD = b2e3b2a01258）、
  `pnpm install --frozen-lockfile`、`smoke` 绿。
- 产物：全部构建后 `git status` 仅显示本轮**有意**变更（mobile `lib/client.js.map`、
  archive-cleanup `dist/index.js`），无意外产物漂移；C8 门复跑绿。
- 备注：本轮全量连跑中 `test:gateway` 出现过 1 次不可复现失败（单跑 2 轮 + `control-plane
  → gateway` 连跑 2 轮均绿，见 §6.3 ②），已按瞬时资源竞争登记；其余 18 套全绿为最终状态。

## 8. 仍未验证（实机门禁，两轮一致）

多来源 sleep/wake 与隐藏恢复、gateway 形态回归、右侧栏栈在真实 profile 下的装载时序、
`provideRoot` 时序（`useResource`/`usePanelInfo`/`fileUpload`）、session v3 迁移在真实存储上的
行为（含中断迁移暂存文件下的 purge、坏产物 `stat` 的抛错分支）、移动端真机视觉与
`<768px` 全屏右栏下的抽屉层级、`<basePath>/api/file` 的 200/401 复验、ssh/http dsh 目标的
cookie 注入缺失、探针 5s 窗口在真机冷启动下是否足够。

---

## 9. 第三轮复核（2026-09，3 个独立只读 agent + 本机实跑）

> 对象：`8ed233a`（第二轮修正提交）及其后工作树的改动。
> 方法：W4 **对抗式审查**（逐问验证第二轮修复是否真的成立、门是否可信）、W5 **纯净克隆验证**
> （`git clone --shared` + 真实 submodule 物化，按 CI 顺序实跑全链）、W6 **决策证据**
> （D3/D4/D5 的全仓证据与选项排序）。报告原文：`.analysis/out/W4-adversarial.md` /
> `W5-pristine.md` / `W6-decisions.md`（scratch，不入库）。
> 结论：**0 遗留 BLOCKER**；第三轮修掉 3 个 MAJOR 门缺陷、2 个真实功能缺陷（四处同源绝对
> URL 中第二/三处）、2 个产物不可复现缺陷，并把 D3/D4/D5 全部按最优实践裁决落地或登记。

### 9.1 门与验证基建（W4/W5）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| T1 | **MAJOR（门失效）** | C1/C3 与 C4-roster 违规只 `hardFails += 1`、从不 `fail()` ⇒ **打印违规却 exit 0**（`hardFails` 从未被读） | `fail()` 统一持有计数与退出码，最终判定读 `hardFails`；负向测试：改一个 pure fork 文件 → exit 1 |
| T2 | **MAJOR（CI 空转）** | 门禁步骤排在 `pnpm install` **之前** ⇒ node_modules 缺失、C8 四组全部 skip、脚本仍打印「全部通过」 | CI 拆两段：pre-install 跑 `--no-artifact-rebuild`（C1/C3/C5/C6/C9，纯文件）；post-install 新增「Committed artifacts match sources (C8 rebuild gate)」跑默认门（linux/win 两条腿） |
| T3 | **MAJOR（fail-open）** | C8「构建不可用」只 warn 不失败（无 esbuild 时静默通过，且可被污染的产物骗过） | 判定逻辑抽到 `scripts/dev/artifact-gate.mjs` 纯模块：`skipped` 非空 = 硬失败（显式 `--no-artifact-rebuild` 才降级为 advisory）；+8 例单测（`test:upgrade-tools`） |
| T4 | **MAJOR（脏树）** | 中断（SIGINT/SIGTERM）留下「已重建」字节；并发运行互相污染；还原是白名单，构建新增的产物会被留下 | 还原改**整目录快照**（新增项删除、原文件写回）+ `spawn` 异步（事件循环保持空闲）+ 信号处理器（还原→kill 子进程→exit 130/143）+ `tmpdir` 下 `wx` 独占锁（死 PID 自动接管）。实跑验证：SIGINT → exit 130 且产物原样；构建写额外文件 → 被清除；并发 → 第二个 run 响亮跳过 |
| T5 | **MAJOR（产物不可复现 ×2）** | 新增 dsh-runtime 组后立刻抓出 `packages/dsh-runtime/scripts/build.mjs` 缺 `absWorkingDir`（root-CWD 构建 319,440B vs 包内 318,684B）；第二轮同因修过 mobile | 补 `absWorkingDir`；两组产物现与提交态逐字节一致 |
| T6 | MINOR | 缺失产物与「字节不同」混在一条报错；spawn 无超时；C8 漏 `dsh-runtime/dist` | 消息拆分、300s 超时、新增该组（现 5 组） |
| T7 | MAJOR（顺序陷阱） | 先 `pnpm install` 再 bootstrap 会以 0 退出但只装 20/304 workspace 项目，直到 `build:renderer` 才炸 | touchpoints §7 登记硬顺序约束（CI 两条腿本就正确） |

**纯净克隆（W5）**：`clone --shared` + 真实 submodule 物化后按 CI 顺序实跑——install / lockfile /
ensure --check / 门禁（含真实 C8）/ i18n / typecheck / 5 个包测试全绿；C8 后整树 827 文件哈希不变；
六锚、284 链接、53/25（当时值；三轮后 54/26）、15 契约全部复核一致。唯一红灯是 `test:runtime`（ZFS 目录 `st_size` 使
`failureBytes > 1024` 断言失败）——**第三轮已修**（fixture 的失败族文件改为 2 KiB，文件系统无关），
该套现在本机也全绿。

### 9.2 功能缺陷（W6 全仓扫描 → 第三轮修复）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| T8 | **MAJOR（核心功能坏）** | 同源绝对 URL 共**四处**，第二轮只修了一处：② `client-file-upload` 的 `/api/session/uploadFileBinary`（**composer 附件上传 404**）；③④ `ui-deliverables` 的 `/api/present.host|open`（交付卡打开/定位 404） | 补丁集扩到 4 条 / 5 文件 / 18 锚点：file-upload 从服务 ctx 读 `chamberBasePath`、ui-deliverables 控制器构造时接收；**`client-file-upload` 转为 composite covered**（extra-row bundle 由实例提供、不经过我们的构建，不覆盖就无法打补丁），同时消除该 extra-row 依赖 |
| T9 | MAJOR | 探针清单的理由不成立：`resources` 不是任何复合插件的 inject（渲染期 seat），且不可能单独缺失；`fileUpload` 的真实依赖方还包括 `api-session-controller`（后果是整壳） | 覆盖 file-upload 后清单收敛为 `['sidebarRight']`；design 09 §3.2、touchpoints §3、AGENTS、双语 CHANGELOG、矩阵 D2 同步；`required-extra-rows.test.ts` 重写 |
| T10 | MINOR | remote 契约只建模 import 列表，真正挂载的是 `apply()` 数组（同长度改挂载仍绿）；多行 import/再导出/动态 import 不可见；vendor 文件缺失时 C4 静默消失 | 解析器重写：注释剥离、`type`-only 子句识别、`remoteMountPackages()` 解析挂载数组并与 import 1:1 同序断言、无法分类的 `/remote` 边 fail-loud；C4 缺文件即硬失败、解析异常即硬失败；+3 例单测 |
| T11 | MINOR | 两处测试锁仍可被绕过：layout 反转+break 全绿；panel-wiring 的「死文本」`/* syncPanels() */` 满足顺序锁 | layout 测试改为「抛错实例两侧各一健康实例」+ 断言恰好一条采纳日志（变异验证：反转+break → 红）；panel-wiring 加注释剥离 + 空白归一化 JSX 断言（变异验证：死文本 → 红） |
| T12 | MINOR | `binding.ts` 谓词的近似名未被测试覆盖（大写后缀、前导零版本、`session.lock.*` 前缀） | +3 组近失名断言（拒绝且不移除任何文件） |

### 9.3 决策（按最优实践裁决并落地/登记）

- **D3（同源绝对 URL）**：裁决 = **构建期 vendor 补丁集**（不 fork 整个 `ui-chat`、不用 DOM/SW 改写）。
  已落地并加固：C9（锚点唯一命中）+ `vendor-patches.test.mjs`（锚点/改写后行为/id 形态）
  + `build:renderer` 末步 `verify-vendor-patch-applied.mjs`（**产物**里必须出现补丁形状——这一条
  正是本轮的教训：vite 给的是 realpath 后的子模块 id，错误的 id 形式会让补丁静默 no-op）。
  剩余边界：ssh/http dsh 目标无 cookie 注入（实例侧 401）——既有认证面待办。
- **D4（open-in 平行实现）**：裁决 = **保留 chamber 插件**（官方 client 是严格子集：单池 host catalog、
  无 per-source 矩阵、无桌面主进程 VS Code override、无 ssh 远程路径；且其根绝对 URL 在同源壳内
  自隐藏），**仅去重契约镜像**：`shared/open-in-app-protocol.ts` 改为直接 import 官方
  `@deepseek-ai/dsh-host-open-in-app/shared`（与官方 client 同源）。矩阵原「建 fork」建议
  **显式推翻**并登记理由。
- **D5（插件管理面）**：裁决 = **保留 chamber PluginDialog**（4 来源超集，已消费官方
  `pluginInventory/list`；上游「Desktop Plugins…」窗口只管 Electron 自身 profile、registry-only、
  仅打包态），**补 `update(name, version)` 动作**；预设分组与暂存式健康检查事务列为可选后续。
- **`runtime-host-adapter` 退役建议**：**不采纳**——它不是死代码：`test/fake-adapter.ts` 实现它，
  `test/run-phase-fixture.ts` 以它为底座驱动 `dsh-runtime` 全部纯 Node 测试；design 18 §9.1 的
  「desktop 与 gateway 各实现一份」已更正为「无生产实现者，生产走 DI seam」。

### 9.4 第三轮绿门（修复后实跑）

- 门禁：`verify-upstream-touchpoints` C1/C3–C9 全绿（C4 covered=54/factory=26、装配 15 = import 选择
  == apply 挂载、C8 5 组重建一致、C9 5 文件/18 锚点）；`verify:i18n` 0 DRIFTED；
  `test:upgrade-tools`（含新 `artifact-gate.test.mjs`）绿。
- 负向验证（本机实跑）：pure fork 被改 → exit 1；污染 `dist` → C8 exit 1；无 `node_modules` →
  C8 硬失败（不再静默）；SIGINT → exit 130 且产物原样；构建新增文件 → 被清除；并发 → 第二个 run 跳过；
  产物断言 → 去掉 id 匹配即 exit 1；layout 反转+break / panel-wiring 死文本 → 各自被抓。
- 全量：18 套 test + 16 项 typecheck + `build:renderer`（含产物断言）/`build:host-packages`/
  `build:dsh-runtime`/`build:preload` + mobile build + frozen-lockfile + `smoke` +
  `ensure --check` + `bin.js --version` 见 §10；**`test:runtime` 本轮起全绿**（ZFS fixture 修复）。

## 10. 第三轮全量门禁（本机实跑）

见本轮提交说明与 `docs/progress/STATUS.md` 的基线块；要点：18 套测试全绿（含 `test:runtime`）、
16 项 typecheck 全 OK、全部构建通过（含 `build:renderer` 末步的 vendor 补丁产物断言）、
frozen-lockfile / i18n / 触点门 C1–C9 / ensure --check / smoke 全绿。

## 11. 仍未验证（实机门禁，三轮一致）

多来源 sleep/wake 与隐藏恢复、gateway 形态回归、右侧栏栈在真实 profile 下的装载时序、
`provideRoot` 时序（`useResource`/`usePanelInfo`/`chamberFileApiBase`）、session v3 迁移在真实存储上
的行为、移动端真机视觉与 `<768px` 全屏右栏下的抽屉层级、四处补丁 URL 在真机的 200/401 复验
（本地与 gateway 来源应 200，ssh/http dsh 目标 401）、探针 5s 窗口在真机冷启动下是否足够。

---

## 12. 最终对比（收口，2026-09）

> 对象：提交 `e778e8e`（三轮修正后）。方法：本机机械枚举（上游 web roster ↔ chamber 装配表、
> 六锚/计数/契约实测）+ **纯净克隆全链实跑** + 两份独立只读复核（F1 文档↔代码、F2 上游面↔
> chamber 面）。本节是「上游 v0.1.5-alpha.2 ↔ chamber 现状」的最终对照表。

### 12.1 上游 web roster 全量对照（51 条 `dsh.client` 行，零遗漏）

| chamber 处置 | 行数 | 行 |
|---|---|---|
| composite 首屏 covered factory | 16 | connection、api-remotes、api-session-controller、api-workspace-controller、locale、ui-theme、ui-session、ui-conversation、ui-approval、ui-chat、ui-workspace、ui-input-trigger、ui-commands、ui-model-selection、ui-settings、client-file-upload |
| composite covered、非首屏（page-own 跳过 / deferred chunk） | 26 | ui-layout、ui-sidebar、ui-renderer、modules、ui-open-in-app、client-hmr、ui-settings-{general,models,plugin-inventory,plugins}、ui-brand-official、ui-attachment、ui-tool、ui-workflow-run、ui-deliverables、ui-skill、ui-subagent、ui-reference、ui-jobs、ui-goal、ui-message-feedback、ui-permission-presets、ui-agent-preset、ui-plan、ui-user-questions、ui-trajectory |
| 保留为 host-graph extra row | 9 | session-log-export、api-workspace-files、cordis-client-runner、client-resources、ui-sidebar-right、ui-sidebar-documentpreview、ui-sidebar-files、ui-cordis、ui-schedule（上游 `disabled: true`，host 图不下发） |
| **合计** | **51** | 无一行未处置 |

`CHAMBER_COVERED_IDS` = **54** = 42 条上游 client 行（上表前两行）+ 6 个 chamber 自建 client id（layout/sidebar/git/open-in/settings-connections/settings-bridge）+ 2 个 fork 副本（`dsh-client-connection` 亦为上表行、`dsh-api-gateway` 不在 web roster）+ 5 个上游非 roster 包（`dsh-typert-registry`、`dsh-client-store`、`ui-primitives`、`ui-dockkit`、`ui-directory-picker-browse`）。`dsh-client-web` 不进 covered（shell 内核由 boot 行采纳，page-own）。

### 12.2 chamber 自建物 ↔ 上游对应物

| chamber 包 | 上游对应 | 关系 | 差异性质 |
|---|---|---|---|
| `dsh-client-connection` | `packages/client/connection` | fork 副本 | pure 16 / patched 7 / own 14 / dropped 2；补丁 = 每 entry base path（HTTP/WS/RPC 载波）+ recovery-policy/liveness 接缝 |
| `dsh-client-web` | `packages/client/web` | fork 副本 | pure 5 / patched 9 / own 6 / dropped 2；补丁 = N-ctx boot re-base（extraRows/configureContext/异步 dispose） |
| `dsh-api-gateway` | `packages/api/gateway`（client 半） | fork 副本 | pure 6 / patched 5 / own 2 / dropped 9；补丁 = `/api/remote.mux` 载波 base path；host 半不入本仓 |
| `dsh-chamber-client-ui-layout` | `ui-layout` | 替换注册 | 镜像 alpha.2 槽模型 + 两项增值（sidebarWidth 共享持久化、单一 document theme 投影）+ `layoutFacts` 扩展 |
| `dsh-chamber-client-ui-sidebar` | `ui-sidebar` | 替换注册 | 多来源会话导航 + chamberBridge + alpha.2 `brand.*`/`panellist` 孔位（CSS 与上游逐字节一致） |
| `dsh-chamber-client-ui-settings-bridge` | `ui-settings`（SettingsRoot） | 替换注册 | 服务器下拉 + 连接入口 + 每服务器 `dsh-runtime` 段（child cordis ctx 台账与官方 sidebar children 同构） |
| `dsh-chamber-client-ui-settings-connections` | 无 | 扩展 | 控制面连接管理（本地/远端 CRUD、systemd、日志） |
| `dsh-chamber-client-ui-git` | 无 | 扩展 | design 08 的实例内 Git 工作树面 |
| `dsh-chamber-client-ui-open-in` | `ui-open-in-app`（官方行 page-own 跳过） | 替换注册 | 多来源视图模型 + 桌面主进程 VS Code override（官方 client 为严格子集） |
| `dsh-chamber-client-ui-mobile` | 无 | 扩展 | design 17 §18 移动端适配（纯 CSS 层 + DOM 锚点） |
| `dsh-chamber-seed-{client-graph,git-worktree,archive-cleanup}` | 无 | 扩展 | 3 个宿主域（design 09 A / 08 / 24），激活探针域锁步 |
| **vendor 补丁集** | `ui-chat` / `client-file-upload` / `ui-deliverables` | 构建期补丁（vendor 文件零写入） | 4 条 / 5 文件 / 18 锚点：同源绝对 URL 走本 entry 前缀，缺失回落上游 |

### 12.3 前端可见差异（与官方前端逐项对照）

| 面 | 官方行为 | chamber 行为 | 登记处 |
|---|---|---|---|
| 左栏 | `ui-sidebar` 单来源工作区树 | chamber sidebar（多来源会话列表 + 待办区 + 全局面板行/品牌孔位） | 05 §6、design 09 §3.2 |
| 中列 | keyed `main` 槽 | 一致（fork 镜像） | design 06 |
| 右栏 | `ui-sidebar-right` 官方行（额外行加载） | 一致 + 四处 URL 走本实例前缀 | design 09 §3.6、touchpoints §3 |
| 移动端 | 无移动适配（<768px 由官方全屏右栏接管） | 触控抽屉/汉堡/遮罩（z-74/75/76，位于 `shell.overlay` z-20 栈内）+ 手机档排版；退役日志胶囊打标与自绘右栏覆盖层 | design 17 §18.4、`styles.ts` 头注 |
| 设置 | `ui-settings` SettingsRoot | chamber 设置壳（服务器下拉 + 连接 + runtime 段），官方 section 由 deferred 簇提供 | 05 §5 |
| open-in | 官方 `ui-open-in-app`（同源壳内自隐藏） | chamber open-in（多来源 + 桌面 override） | designs 16/20 |
| 上传/附件 | 官方 `client-file-upload` 额外行 | 同款官方客户端（covered）+ base path 补丁 | design 09 §3.6 |
| 主题 | 每 view 各自投影 | 单一 document 投影（active view 门控） | design 06 §4.6 |

### 12.4 最终事实表（本机实测，2026-09）

covered/factory **54/26**（factory ⊆ covered）· remote 装配 **15**（import 选择 == apply 挂载）·
vendor 链接 **284** · harness.commit `b2e3b2a01258`（= submodule HEAD）· 六锚 **0.1.5-alpha.2** ·
激活探针 **7**（4 官方 + 3 chamber 域）· 必需 extra-row 服务 **1**（`sidebarRight`）·
vendor 补丁 **4 条 / 5 文件 / 18 锚点** · `@dsh-chamber/*` 包 **16** + 3 fork 副本 ·
chamber entry raw **1,982,194**（warn 门 2,000,000）· main graph **1,208,064** · head CSS **245,227**。

### 12.5 最终验证证据（纯净克隆，`e778e8e`）

`git clone --shared` + 真实 submodule 物化后按 CI 顺序实跑：ensure vendor ✅ · frozen install ✅ ·
lockfile 无漂移 ✅ · 门禁 C1–C9 ✅（C8 后整树 0 文件改动）· i18n ✅ · 根 typecheck ✅ ·
test:layout/sidebar/mobile/renderer-shell/host-archive-cleanup/runtime/upgrade-tools ✅ ·
`build:renderer`（含 vendor 补丁产物断言）✅ · `smoke` ✅。

### 12.6 仍存在（有意边界，非缺陷）

1. **ssh/http dsh 目标无 cookie 注入** → 四处补丁 URL 在那些来源返回 401（本地与 gateway 来源 200）；
   属既有认证面，登记于 STATUS 与 design 17。
2. **D5 缺口**：PluginDialog 缺专用 `update(name,version)`（其余动作已覆盖；登记为后续动作）。
3. **实机门禁**：多来源 sleep/wake、gateway 形态回归、右栏栈与 `provideRoot` 装载时序、
   session v3 迁移真实存储行为、移动端真机视觉、四处 URL 真机 200/401 复验。
