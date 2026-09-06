# 24 · 已归档会话清理执行台账（design 24 companion：M0–M4）

> 配套契约：`docs/design/24-archived-session-cleanup.md`（v3，2026-12 三路
> 评审 + v2 合规复核修订）。本文件是执行期台账：M0 评审包（材料清单 + 决策点 + 准出）、
> vendor 前置核对记录表（§10 八项 → 证据/结论/决定）、M1–M4 任务与门禁
> 清单、文档同步时点。todo 12 调研记录见
> `docs/progress/todo/12-todo-archived-sessions.md`。
>
> 状态：**M0 已收口（2026-12 用户拍板：跳过人工评审，直接进入执行；
> 决策点 D1–D7 全部按推荐值生效）**；M1 执行中。vendor 前置核对
> **阻塞中**：本 worktree 的 vendor/harness-packages 子模块未物化（缺失），
> 核对需先由仓库 owner 物化 submodule（`git submodule` + 网络；仓库纪律：
> 不自行执行 git/网络命令）。执行环境限制：本 worktree 无 node_modules/
> vendor（pnpm 安装与依赖 vendor 的构建/类型检查不可运行；纯 Node 逻辑可用
> node v24 类型剥离补充验证）。

## 0. 阶段总览

| 阶段 | 内容 | 准出门禁 | 状态 |
|---|---|---|---|
| M0 | 例外动议评审 + vendor 前置核对 | 评审记录落 STATUS；AGENTS/01 随批准即改；核对表 8 项填完并决定 §4 a/b | **已收口**（用户跳过人工评审，D1–D7 生效；AGENTS/01 已改；vendor 核对阻塞） |
| M1 | 新宿主包 + control-plane seed/probe 接线 + runtime-probes 第三域执行腿（本地形态） | test:host-archive-cleanup / test:control-plane / test:runtime / dist 锁步绿；design 05 §6/02/18 §3.4/09/13/16/17 同步 | **代码落地**；验证与收尾受环境阻塞（§8） |
| M2 | 探针期望集派生改造 + 分发面（desktop/gateway/门禁） | test:desktop / test:gateway / ci-release 腿绿；18 §3.4 + STATUS 头部探针段同步 | 未开始 |
| M3 | 客户端 instance-api 增量 + 侧边栏 UI | test:sidebar / typecheck:sidebar / build:renderer 绿；05 §2.2/§3 同步 | 未开始 |
| M4 | 实机 E2E + 收口（CHANGELOG/todo12/可选增强登记） | §9 实机矩阵；文档收口 | 未开始 |

## 1. M0 评审包

### 1.1 评审材料清单

1. design 24 §2 例外动议（红线对照表 + 边界 1–5 + 回退路径 A+C）；
2. design 24 §0 评审修订记录（v1→v3 全部 Major/高优 Minor 处置）；
3. design 24 §7 C 探针契约修订（期望集按实际 seed 域派生——独立于本例外
   的另一契约面，需一并放行）；
4. design 24 §12 文档同步时点表（M0 即改 AGENTS/01；其余随 M1–M3）；
5. 本台账 §2 vendor 核对记录表（就绪部分）。

### 1.2 M0 决策记录（2026-12 用户拍板：跳过人工评审，直接执行）

> 以下决策点**全部按推荐值生效**（design 24 v3 定稿值），无人工评审否决项。

| # | 决策点 | 生效值 |
|---|---|---|
| D1 | 放行「第三个 chamber 宿主包 / 会话删除域」例外（§2 边界 1–5） | **放行** |
| D2 | 探针期望集派生契约修订（§7 C）随本设计 M2 落地 | **纳入**（M1 先行布尔全量执行腿） |
| D3 | PluginDialog 内建表 v1 不加 archive-cleanup 行 | **不加**（三态行列为 M4+ 可选） |
| D4 | 行内错误/信息文案 zh 硬编码 | **zh 硬编码** |
| D5 | purge 客户端超时预算 5 min + 「超时≠失败、可幂等重试」文案 | **同意** |
| D6 | AGENTS.md 例外清单 + design 01 地图行 12 随 M0 批准即改 | **已执行**（AGENTS ×4 处、design 01 行 12 + 新增行 24） |
| D7 | 命名三件套：`@dsh-chamber/dsh-host-archive-cleanup` / loader `archive-cleanup` / wire 域 `archiveCleanup` | **确认** |

### 1.3 M0 准出清单

- [x] 评审结论（D1–D7 逐项）记录进本台账与 STATUS（本台账 §1.2；STATUS
      条目已更新）；
- [x] AGENTS.md：宿主包清单加入新包 + 有界例外句修订（4 处，先于任何实现
      commit）；
- [x] design 01 §3 地图行 12 改为指 design 24 + 新增行 24；
- [ ] vendor/harness-packages 物化（仓库 owner 执行）→ §2 核对表 8 项填完、
      §4 a/b 决定落地为 design 24 实现注记（**阻塞中**，见头部状态）。

## 2. vendor 前置核对记录表（design 24 §10 八项）

> 就绪列：子模块缺失时标「阻塞」；chamber 侧可离线预核的旁证已先行填入
> （file:line 出处于 design 24 v2 与评审记录）。子模块就绪后逐项填
> 证据（vendor file:line）→ 结论 → 对 §4 的影响。

| # | 核对项 | 离线旁证（chamber 侧） | vendor 证据 | 结论/决定 |
|---|---|---|---|---|
| 1 | workspaceRegistry ctx 服务面（list/archived 集合读写/sessionIds 账目/持久化 setState/archiveSession） | git 宿主包 structural 注入 `['workspaceRegistry','agents']`（dsh-chamber-host-git-worktree/src/index.ts L44–59/L63） | 阻塞 | |
| 2 | 归档顶层行可枚举性（含 parentSessionId 链/header 索引可见性） | chamber 侧仅 follow baseline 带 archivedSessionIds、无 unary 读面（sidebar shared/instance-api.ts L377–384 注记）；todo12 §1 | 阻塞 | |
| 3 | 官方进程内可复用删除例程（含 workspace.delete 对成员会话/目录的处置） | todo12 §5.2「header 索引重建即剔除已删 id」；git remove saga 以 workspace.delete 收尾 | 阻塞 | 决定 §4 a/b |
| 4 | 事件精确名与发射面：host/session-removed、host/archived-sessions-changed | chamber 代码零引用（仅 docs）；todo12 §5.2 命名 | 阻塞 | |
| 5 | agents 覆盖面（subagent 起源行？）+ 归档行 running 位事实来源 | git 宿主包注释：agents 守卫 cwd 覆盖 ungrouped/subagents（src/index.ts L79–84）——不足以定论 | 阻塞 | |
| 6 | 零参 Remote envelope 要求；unary 断连后宿主侧执行是否继续 | 零参先例：clientGraph/graph 客户端 `{args:{}}`（renderer src/host-graph.ts）；git-api snapshot；宿主侧参数名约束只影响带参方法 | 阻塞（断连语义项） | |
| 7 | cordis patch insert 三行共存无冲突 | cordis-inserts.ts 冲突规则 + control-plane/cordis-inserts.test.ts | 阻塞 | |
| 8 | 会话存储布局（format.ts/sessions-root/header 索引）与原子写/持久化原语 | todo12 §5.2 `<sessions-root>/<project>/<id>/` | 阻塞 | 仅 b 分支需要 |

**决策门**（design 24 §10）：#3 决定 a/b；若 a/b 均不可行 → 方案冻结回退
todo12 C，台账标记冻结并回报。

## 3. M1 宿主域（本地形态全链）

任务：
- [ ] 新包 `packages/dsh-host-archive-cleanup/`：src/index.ts（TypertRemoteService、
      `static inject=['workspaceRegistry','agents']`、零参 @Remote×2、domainResult）、
      src/core.ts（纯核心：候选集/级联/运行保护/children-first/复检/账目/事件——
      design 24 §4）、scripts/build.mjs（external @deepseek-ai/*）、test/core.test.ts
      （纯 fixture）、提交态 dist；
- [ ] control-plane：host-graph-seed.ts 常量 + index.ts seedEntries 第三行 +
      probeDomains + DEFAULT source dir + ControlPlaneOptions
      `hostArchiveCleanupPackageSourceDir`；host-graph-seed.test.ts /
      cordis-inserts.test.ts 数组先红后绿；
- [ ] 探针接线（与 seed 同 commit）：activation-gate.ts 常量（REQUIRED +
      HOST_DOMAIN_PROBE_NAMES）+ **dsh-runtime 提交态 dist 重建** +
      dist-sync / cross-package-contract 锁步 + **runtime-probes 第三域执行
      腿与 accept 语义**（full-set 布尔形状下 7 条全跑——只加常量不加执行
      腿会 7 期望 vs 6 执行 → 'probe not wired' 回退）+ runtime-probes.test.ts
      7 端点 fixture（布尔全量形状；按域派生 fixture 归 M2）；
- [ ] 根 .gitignore 为 `packages/dsh-host-archive-cleanup/dist/` 加否定；
- [ ] 文档：design 05 §6（宿主包 2→3）、design 02（loader id 表 / 宿主包
      附着表）、**design 18 §3.4 域枚举文字（随常量同 commit；M2 仅补派生
      契约段）**、09/13/16/17 枚举宿主包表述、STATUS.md。

门禁：`test:host-archive-cleanup`（新）`test:control-plane` `test:runtime`
全绿、根 typecheck（新 typecheck:host-archive-cleanup）、`verify:i18n`
不受影响；实机冒烟（本地实例 spawn 后 `archiveCleanup/preview` 可达）登记
在 M4。

## 4. M2 探针契约 + 分发面

任务：
- [ ] 探针期望集派生改造（替代二元 hostDomains；seed 清单逐条 probeDomains
      为源；空缓存=空域集兼容现状）——activation-gate.ts / runtime-probes.ts /
      gateway runtime-manager（L936/1026/2374 语义）/ desktop 激活路径共用；
      probe accept 语义（archiveCleanup/preview：ok:true 形态良好 = 在位；
      ok:false = fail-closed）；
- [ ] runtime-probes.test.ts 派生 fixture（2-of-3 / 空缓存 / 全量）先红后绿；
- [ ] desktop：plugin-sync.ts 常量 + seedRemoteChamberHostPackages + main.ts
      chamberHostPackageSeeds / localChamberHostPackageSources / 打包路径 +
      build-host-graph-package.mjs 数组 + dist 内嵌；
- [ ] 门禁面：根 package.json（build:host-packages 并入、typecheck/test 新别名）、
      ci.yml / release.yml 逐包腿、release-preflight.mjs；
- [ ] gateway：plugins.ts SYNCABLE_HOST_PACKAGES + index.ts extraSeedEntries 第三行
      + 测试数组（feature-lifecycle / chamber-installed / runtime-routes 真探针
      fixture 答第 7 端点 / plugin-spec-lockstep 自动覆盖）；
- [ ] settings `plugin-inventory-text.ts`：classifyInventoryEntry/chamberKindOf
      归类常量第三包（§7 F——gateway Loader inventory 驱动的清单防 third-party
      误标；常量级，非三态行）；
- [ ] 文档：design 18 §3.4 派生契约修订段 + §9.3、STATUS 头部探针段（含挂账①
      口径，M0 已先行补半句区分）。

门禁：`test:desktop` / `test:gateway` / `test:runtime` 全绿 + 类型检查全绿。

## 5. M3 客户端 + UI

任务：
- [ ] instance-api.ts：call() 可选 `timeoutMs` + `notFoundAsDomainMissing` 开关 +
      `InstanceDomainMissingError`/`isInstanceDomainMissing` + 访问器
      archiveCleanup.preview/purge + wrapper（preview 默认 30s；purge
      `PURGE_CALL_TIMEOUT_MS = 5*60_000`）+ 超时/404 zh 硬编码文案；
      传输层分类测试（global fetch stub 或可注入 seam，二选一）；
- [ ] SidebarRoot.tsx：簇尾第 4 按钮（title+aria，三件套点击纪律）+ per-server
      单飞（purgeBusy）+ confirm 前复查 + header 下新错误/信息槽位（fold 门
      之外、与搜索态无关；role=alert/status）+ key 可见性清理；注释清单维护；
- [ ] locales：action.purgeArchived / confirm.purgeArchived（含跳过子句、约量
      措辞）en/zh；
- [ ] 文档：design 05 §2.2（交互表 + 例外注）、05 §3 与 **§2.3** 的两处同源
      陈旧注记（requestRefresh/mounted 推送语义与 App.tsx 不符——§2.3
      L131–133 与 §3 L216–217 同句重复，一并修正）。

门禁：`test:sidebar` / `typecheck:sidebar` / `build:renderer` 绿；手动冒烟
（hover 簇 4 图标宽度目检、Menu portal × confirm 叠放目检）登记 M4。

## 6. M4 收口

- [ ] 实机 E2E（§9 矩阵：本地 / gateway / 远程 dsh；并发 busy；超时续跑；
      崩溃乱序收敛；磁盘与事件验证）——需打包态 + vendor 树；
- [ ] CHANGELOG、desktop README、todo 12 结项（B 冻结结论保留并指回
      design 24 §2）、本台账结项；
- [ ] M4+ 可选增强登记：PluginDialog 三态行（§7 F 代价清单）、rowError
      本地化（§5）、已归档浏览区（todo12 A 区）。

## 7. 风险与回退

- vendor 核对否决（§2 决策门）→ 冻结回退 todo12 C；
- M0 否决 → 回退 todo12 A+C，本台账归档；
- 激活探针改造前不得上线第三域（design 24 §11/§7 C）；
- 契约细节以 design 24 v3 为准；本台账只做执行跟踪，不另立契约。

## 8. 环境限制与阻塞登记（如实）

**执行环境（本 worktree，2026-12）**：`node_modules` 未安装、
`vendor/harness-checkout` 子模块空（`vendor/harness-packages` 不存在）→
pnpm install / 依赖 vendor 的 typecheck / esbuild 构建（build:host-* 经
vite/esbuild）/ dsh-runtime dist 重建均不可运行。仓库纪律不自行执行
git/网络命令，物化与安装需仓库 owner。

**已执行的补充验证（node v24.20 原生 TS 类型剥离，无依赖）**：
- 新包 `test/core.test.ts`：**15/15 通过**（children-first 顺序、崩溃收敛
  续跑、运行子树整棵跳过（含中途翻转）、逐项错误隔离、孤儿/幂等、容量
  门、domainResult 载体）；
- dsh-runtime `test/runtime-probes.test.ts` + `activation-gate.test.ts`：
  **32/32 通过**（含新增 archiveCleanup/preview accept 语义与
  hostDomains=false 不调用新域断言）。仓库正式套件待 pnpm 环境。

**M1 收尾阻塞项（按序）**：
1. **host binding 依 §10 vendor 核对**：`src/index.ts` 的
   `makeHostBinding` 现以 `host-binding-pending` 显式拒绝全部宿主能力——
   绝不猜测存储布局/注册表访问器名；核对完成前域不启用（无错误删除面）；
2. **dsh-runtime 提交态 dist 重建 + 提交**（`pnpm run build:dsh-runtime`）：
   dist-sync / desktop cross-package-contract 锁步测试转绿的前提，且
   desktop/gateway 经包 main 消费 dist——重建前 src/dist 语义分裂期测试
   会红（预期，防漂移机制在岗）；
3. **启用次序**：新域 seed 行 + 激活探针集 + dist **同 commit 落地**
   （design 24 §7 C rollout）——本台账完成项均未提交，等待 binding 后
   一次性按序提交；
4. M1 文档同步余项：design 05 §6（宿主包 2→3）、design 02（loader id 表/
   宿主包附着表）、09/13/16/17 枚举表述（AGENTS 与 design 01 已先行）；
5. 控制面测试影响评估：`host-graph-seed`/`cordis-inserts` 测试显式传两行
   数组属调用方 fixture（非全量断言）；seedEntries 第三行在无 dist 时被
   产物门跳过——真实行为与测试在 dist 提交前不变，dist 提交后按
   design 24 §7 A/B 断言先行扩展。

## 9. 执行状态快照（逐轮更新）

**2026-12 · 轮次 1（M0 收口 + M1 代码落地）**：见 §0/§1.2/§1.3/§8——M0
全部准出（用户跳过人工评审、AGENTS×6 处 + design 01 入册）；M1 新包
`packages/dsh-host-archive-cleanup` 全量文件 + control-plane seed/option 接线 +
activation-gate/runtime-probes 第三域执行腿与 accept 语义 + 根脚本/.gitignore/
AGENTS 验证清单 + 测试更新。补充验证：核心 15/15、runtime 探针 32/32
（node v24 类型剥离）。阻塞登记见 §8（host binding / dsh-runtime dist / 启用次序）。

**2026-12 · 轮次 2（M1 文档同步 + M3 客户端代码）**：
- M1 文档同步余项完成：design 05 §6（宿主包 bullet + 三 host 包 seed 段）、
  design 02（§2.6 标题/表格/接线文 + 引文 + 远端 seed + 附着表）、09
  （模块 A 2026-12 注）、13（seed 三包表述）、16（release 断言集）、17
  （`/chamber/plugins` 三包表述）；
- M3 客户端落地：instance-api 增量（call() `timeoutMs` + 404 判别开关、
  `InstanceDomainMissingError`/`isInstanceDomainMissing`、`archiveCleanup`
  访问器、`PURGE_CALL_TIMEOUT_MS`、preview/purge wrapper 与解码）、
  locales（zh/en `action.purgeArchived`/`confirm.purgeArchived`）、
  SidebarRoot（header 簇第 4 按钮 + 全流程 per-server 单飞 + header 下
  错误/信息槽位（fold/搜索态无关）+ 断连清理 effect + 注释清单）。
  补充验证：instance-api.test.ts **7/7 通过**（含 404 判别、busy 码、
  部分失败解码；node v24）。
  验证受限：SidebarRoot/locales 依赖 vendor 类型与 DOM 基建——未运行
  typecheck/test（如实登记）；渲染目检/实机属 M4。
- 剩余：M2（探针派生改造 + desktop/gateway/settings 分发面）、M3 余项
  （若需：busy 视觉态目检、Menu×confirm 叠放目检）、M4 实机与收口。

**2026-12 · 轮次 3（M2 探针派生 + 分发面生产代码）**：
- dsh-runtime：activation-gate 新增 `activationProbeNamesForDomains`（空=缩减
  集 / 部分=base+列出域 / 全量=REQUIRED）；runtime-probes 新增
  `hostDomainNames` 选项（取代二元布尔语义，布尔向后兼容），三条 chamber
  腿按实际期望域执行、byName/期望集派生——**runtime-probes+activation-gate
  测试 35/35 通过**（新增 2-of-3 部分派生、空列表=缩减集、未知域不伪造行）。
- gateway：plugins.ts `SYNCABLE_HOST_PACKAGES` 第三行 +
  `HOST_PACKAGE_PROBE_DOMAINS` 映射 + `syncedHostDomainProbeNames`（按 seed
  cache 实际存在包派生）；runtime-manager 三处接线（managed 探针签名、
  buildStartupDeps 快照改为域列表 + probeExpectedNames 派生、env override
  探针、metadata 恢复探针）；index.ts extraSeedEntries 第三行。
- desktop：plugin-sync.ts ARCHIVE_CLEANUP 常量、main.ts
  `chamberHostPackageSeeds`/`localChamberHostPackageSources`/
  `hostArchiveCleanupPackageSourceDir` 三处、build-host-graph-package.mjs
  第三包（dist/host-archive-cleanup-package）。
- settings-connections：plugin-inventory-text 分类第三包（kind
  `chamber-archive-cleanup`，gateway Loader inventory 不再 third-party 误标；
  内建表行仍按 v1 决策不加）。
- 验证受限登记：desktop/gateway 全部依赖 pnpm/vendor 的 typecheck/测试与
  dist 消费未运行（dsh-runtime dist 重建后 gateway/desktop 方解析新导出）；
  根 CI/release/preflight 逐包腿与 desktop/gateway 测试 fixture 数组更新
  （feature-lifecycle/chamber-installed/runtime-routes/plugin-sync/
  gateway-provider 等）留待 toolchain 就绪批次（“先红后绿”断言先行）。

**2026-12 · 轮次 4（M2 收尾生产面 + 文档同步 + 静态审查）**：
- 根门禁腿：ci.yml ×3（typecheck ×2/test ×1）、release.yml ×2、
  release-preflight.mjs ×2 补 `typecheck/test:host-archive-cleanup`；
- M2 文档同步：design 18 §3.4（探针枚举加 `archiveCleanup/preview` + accept
  语义；形态化 bullet 改三域按 seed 派生（M2 修订）；缩减集表述改三域跳过）、
  STATUS 头部探针段（7 项 + HOST_DOMAIN_PROBE_NAMES 三域 + 派生契约）；
- 待 toolchain 批次的「先红后绿」fixture 文件清单（已枚举，不盲改）：
  gateway test ×4（chamber-installed/feature-lifecycle/plugin-spec-lockstep/
  runtime-routes——真探针 fixture 答第 7 端点）、desktop test ×4
  （cross-package-contract/plugin-sync/ssh-provider/gateway-provider）、
  settings（chamber-seed-drift/control-plane/plugin-model）、control-plane
  （host-graph-seed/cordis-inserts——无 dist 前行为不变，dist 后按 §7 A/B 扩）；
- 静态审查（subagent，只读）：M1/M2/M3 全部已落代码逐文件细读中——结果
  到齐后按 Blocker/Major 修复（下一轮）。

**2026-12 · 轮次 5（回归验证 + M3 文档同步勘误）**：
- 回归：runtime 35/35、host 包 core 15/15、instance-api 7/7（node v24 全绿，
  与上轮一致——多轮编辑后无回归）；
- design 05 §2.2：交互表补「删除已归档内容」来源头动作 + 例外注（design 24
  受界例外，含 wire/域/404/启用前提摘要）；
- design 05 §2.3/§3：requestRefresh 陈旧注记勘误（2026-12 复核 App.tsx
  onRefresh 对 live 来源无条件 mutation-pull——非 mounted no-op；双通道语义
  入文）——M3 文档同步项（05 §2.2/§3/§2.3）全部落地；
- 静态审查（subagent）运行中：结果到齐后按 Blocker/Major 修复。

**2026-12 · 轮次 6-7（自查收尾）**：静态审查 subagent 经催办仍多轮未产出，
已中断（零输出，如实登记——不以其缺席推断代码质量）；替代自查：命名/引用
一致性扫描通过（`@dsh-chamber/dsh-host-archive-cleanup` 全仓引用 8 处全部
预期位置、无旧双前缀残留）；runtime-manager 改动区目检通过；dsh-runtime
全系 354 测试回归绿（353 通过/1 条件跳过，dist-sync 预期红待 dist 重建）；
instance-api/core 套件绿（7/7、15/15）。结论：**环境可执行范围内的工作已
穷尽**——剩余全部依赖外部前置：vendor 子模块物化（§10 host binding 与
启用批次）、pnpm toolchain（dist 重建与全量门禁、fixture 先红后绿批次）、
实机（M4）。

## 10. 外部前置解除后的执行状态（2026-12，物化/安装后）

**已执行**：vendor 子模块物化（a66e4702，pin 校验通过）→ ensure-harness-vendor
（261 链接）→ pnpm install（10.8s，store 复用；electron 按设计跳过）→
**§10 核对全部完成（结论见 design 24 §14 实现注记）**：分支 b 落地——
binding 使用官方公开面（registry.archivedSessionIds / sessionQuery.listSessions /
agents+sessions live 守卫 / sessionPersistence.locate）+ 文档化结构 seam
（registry.setState 单写，运行时守卫）删除占位 id + 事件为文档化 no-op。
**产物**：`dsh-host-archive-cleanup/dist/index.js`（含 binding）与
`dsh-runtime/dist/index.js`（7 项探针常量）均已重建（提交态就绪）。

**门禁结果（toolchain 实跑）**：
- 根 typecheck ✅；typecheck:runtime/host-archive-cleanup/sidebar/connections/
  gateway ✅（修复：main.ts 缺 import、instance-api 未用参数、core.ts
  `agent.sessionId` 残留类型错——均修复后绿）
- dsh-runtime 全链 ✅（含 dist-sync）；host 包 core 15 + binding 4 ✅
- gateway 555（552 通过/3 平台跳过）✅ —— fixture 批次：feature-lifecycle ×3、
  chamber-installed ×1、runtime-routes shape-gate（三包 seed + 部分派生注释）已绿
- desktop 833/833 ✅、control-plane 348/0/1 ✅（host-graph-seed 集成腿 ×8
  注入缺省 archive-cleanup 源以保持单/双包场景语义）、sidebar 240 ✅、
  connections 118 ✅

**残余/待办**：① 启用批次（seed+探针+dist 同 commit——未执行 git 提交，
由 owner 审阅提交）；② M4 实机 E2E（需真实 dsh 实例/打包态；smoke 级不可
在本环境跑）；③ 残余登记：archived 占位 id 保留至上游 wire（design 24 §14）；
④ 静态审查 subagent 中断零输出（不构成质量结论，以上以实跑门禁为准）。

**2026-12 · 轮次 9（最终门禁与收口）**：verify:i18n consistent；layout/
open-in/settings-bridge/git/host-git/renderer-shell 全绿（exit 0）；
**build:renderer 成功**（4.74s，chamber 复合 bundle + boot manifest —— M3
UI 改动全量编译验证）；**build:gateway 成功**（含第三 seed entry 打包路径）；
desktop `build:host-graph-package` 成功（dist/host-archive-cleanup-package
物化，打包态路径就绪）。实机 E2E（M4）不可行原因登记：无 dsh 可执行/无
desktop vendor bundle（bundle:dsh 需额外发行链），需打包态/真机环境。
剩余外部项：启用批次 git 提交（owner）、M4 实机矩阵。

## 11. 六路多维度评审处置（2026-12，架构/安全/实现/性能/交互/一致性）

评审结论汇总：全部 0 Blocker；评审前与评审中的修复批已闭合的 Major 与
Minor 清单 + 文档债务见 design 24 §15。本轮落地证据：host 包 24 测
（core16+binding8 实代码直测，binding.ts 无装饰器拆分）、instance-api 9 测
（含 404/503/双层域载体/504/超时诚实文案/部分失败解码）、control-plane
host-graph-seed 38 测（新增三包 overlay + seed 源级 probe 锁步腿）、
runtime 全链 exit0、typecheck（根/host/sidebar）全绿、i18n consistent、
双提交态 dist 重建。残余（照实）：启用批次提交（owner，含双 dist 同 commit）、
M4 实机冒烟（含建议先跑一次本地 spawn 探针可达性）、design 24 §15 登记项
（§6 文本微差、幽灵窗口措辞、§3 错误码枚举 v4 修订轮、桌面恒全量取舍、
seam 退役跟踪）。
（六路评审补记 · 实现评审 C 轮处置）：activationProbeNamesForDomains 未知域
改为 fail-loud throw（消除 fail-open：域漂移不再静默剔除期望/执行腿；runtime
dist 已随重建）；binding 链缺失 loud-refuse（registry-unreadable，直写路径
仅测试 fake 可用）；session 目录 ENOENT → 幂等 'missing'；probe 现含零 IO
registry 表面检查（挂载但损坏 → ok:false fail-closed）；宿主包 dist 锁步：
本轮最终重建为合入最后一步产物（主机/runtime 双 dist 与 src 同时刻）；补
binding 10 测 + runtime 探测测试 fail-loud 断言。待实证（照实登记，归 M4）：
① 官方 UI 能否直接归档 subagent 起源会话（covered-first 顺序依赖的
reachability）；② purge 后 registry 内存 header 索引重建前的 ghost 行窗口
（chamber 行源为 fs-fresh sessionQuery，推断无影响，需实机一次）。
