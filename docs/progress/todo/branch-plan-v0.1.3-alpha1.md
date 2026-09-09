# v0.1.3-alpha1 分支执行计划（T1–T4，2026-09 用户批准）

> 本文件持久化 v0.1.3-alpha1 分支上四项已批准工作的**全量方案**（调研结论 + 决策 + 批次与绿门）。
> 执行状态：**Batch 0（T1）✅ 已完成（2026-09）**——源码线 alpha.2 + fork 重放 + 双线收口 +
> covered 一行落地（记录：STATUS 基线对齐块 / CHANGELOG [Unreleased]）。
> **Batch 0.5（T4）✅ 已完成（2026-09）**——upstream-touchpoints.md + verify-upstream-touchpoints.mjs
> （C1–C8）+ CI fail-loud 步骤 + update-vendor 提示 + PR 模板自检节（记录：STATUS T4 行）。
> Batch 1（T2）→ 2（fork 重锚）→ 3（T3）待推进（每批完成即回写本文件与 STATUS）。
> 关联：任务登记在 `docs/progress/STATUS.md`「分支任务登记」块；升级操作手册见
> `docs/checklists/dsh-upgrade-checklist.md`；上游接触面保鲜见 T4 拟建
> `docs/checklists/upstream-touchpoints.md`。
> 依据：本会话五份只读调研（fork 差异/重锚、命名统一、open-in 官方侧深挖、open-in 通道与门控、
> 上游触点清单设计），结论已逐条并入下文；凡标 [UNVERIFIABLE] 项为无实机/runtime 无法静态确认，
> 须在对应批次执行时实测。

## 0. 背景与现状

- 分支 `v0.1.3-alpha1` = main(5a81843, v0.2.3 时代, 107 commits 分叉已 rebase) + `ed1f0d8`
  （dsh 源码线升级至 dsh-v0.1.3-alpha.1：pin d347e7039 / vendor 链接 267 / fork 重放 / 双线门开放）。
- 上游最新 = **dsh-v0.1.3-alpha.2**（82a5fd61a7，316 commits，3 个新包：
  `client/ui-open-in-app`、`host/open-in-app`、`util/package-manifest`）；**npm
  `@deepseek-ai/dsh@0.1.3-alpha.2` 已发布**（alpha.1 从未发布）→ 双线门可收口。
- 本仓库 packages/ 命名长期不一致（目录名 ≠ 包名；seed 无一眼可辨标记）；三个官方 fork 副本
  补丁逐年累积；上游 alpha.2 起官方 open-in 与 chamber 自建 open-in 同 slot 撞车。

## 1. 任务与批次总览

| 任务 | 内容 | 批次 | 规模量级 |
|---|---|---|---|
| T1 | 追踪 dsh-v0.1.3-alpha.2：源码线升级 + fork 重放 + **双线收口** + open-in covered 一行 | **Batch 0** | M |
| T4 | 上游触点跟踪文档 + 保鲜脚本（`verify-upstream-touchpoints.mjs`，CI 接入） | **Batch 0.5**（随 T1 后或同批） | S–M |
| T2 | 目录/包命名统一（client 插件补 `chamber` 词；种子改 `dsh-chamber-seed-*`） | **Batch 1**（原子单批） | M–L（机械但面广） |
| — | fork 重锚 alpha.2 + 补丁最小化（用户问题 2 的结论落地） | **Batch 2**（在 a2 基线上） | M（4–7 人日级） |
| T3 | open-in 统一：吸收官方 client + 远程 deeplink-only + 本地通道复用 | **Batch 3**（Phase 0 纯门控可提前） | M |

批次顺序建议：Batch 0（T1，含 covered 一行）→ Batch 0.5（T4）→ Batch 1（T2）→ Batch 2（fork
重锚）→ Batch 3（T3）；每批独立提交、各自绿门（§8）。

## 2. T1 — 追踪 dsh-v0.1.3-alpha.2（Batch 0）

### 2.1 源码线
- `node scripts/dev/update-vendor.mjs dsh-v0.1.3-alpha.2`。
  **已知工具怪癖（本会话实证）**：ensure-harness-vendor 的 verifyPin 要求 index gitlink == pin，
  首次运行会在 step 5 失败 → **先 `git add vendor/harness-checkout` 再重跑**（tag fetch 幂等）；
  运行间不得 `git submodule update`。vendor 链接 267 → **270**（+3 新目录，0 删除）。
- 上游 alpha.1→alpha.2 事实：316 commits / packages+apps 1134 文件（其余 .agents/snapshots/
  docs/perf 噪音占路径 67% 但仅 ~24% 行）；**无任何新增 install-script/native 依赖**
  （含 npm 闭包核对：仅新增纯 JS `dsh-http-proxy`）→ allow-builds/root deny 零改动；
  engines 不变。

### 2.2 fork 重放（本次唯一实质面 = connection）
- **connection**（14 文件，+351/−74，src 4 处 + recovery-config 新文件）：
  - [clean-adopt] 新 `src/recovery-config.ts`（ConnectionRecoveryConfig + schema +
    resolveConnectionConfig：backoff 500/2/10000、warn 3s、硬超时 15s 中止代次）；`src/index.ts`
    （host 侧 config.recovery + webserver/index-inject 页面全局 `__DSH_CONNECTION_RECOVERY__`）；
    README 三件。
  - [merge-needed] `src/client/connection.ts`：上游删除整块 ConnectionConfig/默认值（迁入
    recovery-config）→ chamber 的 `basePath` 成员移出控制器配置；**`CONNECTION_BACKOFF_MAX_MS`
    导出必须保留**（liveness-triggers.ts 依赖并 re-export 为
    DEFAULT_MIN_RESTART_INTERVAL_MS，测试钉值 10_000 == a2 schema 默认）；rebase 日志段落
    移到存留的 chamber 注释上；epoch 守卫 #1/#3 + while 条件 + stop() bump 保留，#2 可弃
    （上游 isRetryInterrupted + isRunning 复检覆盖）。
  - [merge-needed] `src/client/index.ts`：导入/导出改名 ConnectionConfig→ConnectionRecoveryConfig；
    `ClientTransportGlobal.__DSH_CONNECTION_RECOVERY__`；apply 内 recovery 读取与
    `{...recovery, ...config}` 合并（保留 chamber carrier 装配）；**apply 配置类型必须保持
    `basePath`**（renderer chamber-entry 传严格字面量）→ chamber 型
    `ConnectionRecoveryConfig & { basePath?: string }`。
  - tsconfig 四个 files 列表补 `src/recovery-config.ts`（client/host + check-client/check-host）。
  - 版本标记 → 0.1.3-alpha.2；追加 rebase-log 段落。
- **api-gateway**：a2 上游 src **零改动** → 仅版本行（README 不携带、tests 不镜像）。
- **client-web**：a2 上游仅版本行 → 版本标记同步。
- 行为注意（consumer-neutral 已证）：无 chamber 消费方订阅 connection.state 终态；15s 中止代次
  与 chamber liveness-triggers（window 事件 stop+start、隐藏 ≥30s、≥10s debounce）语义收敛，
  重放后回归 silent-death 场景。

### 2.3 双线收口（本次可做，因 npm alpha.2 已发布）
- 运行时四锚 rc.1 → 0.1.3-alpha.2：`bundle-dsh.mjs` 兜底常量（+其 lockfile 读取）、
  `packages/desktop/vendor/dsh/pnpm-lock.yaml`（`bundle:dsh --force --refresh-lockfile`）、
  `.github/workflows/release.yml` env、`scripts/install-gateway.sh`、`packages/gateway/package.json`
  `dshAnchorVersion`；release-preflight `FORK_VERSION` 默认 → 0.1.3-alpha.2。
- `bin.js --version` 冒烟 = 0.1.3-alpha.2。
- **实机激活探针验证（结转债）**：commands/execute `attachments` wire key（上游 typert 生成物
  未提交、上游 fixture 仍 `images`）→ 双线同代后可实测关闭。
- 运行时线一旦同代：STATUS 基线对齐记录（alpha.1 临时驻留块）使命完成 → 并入 CHANGELOG 后移除。

### 2.4 open-in covered 一行（随 T1 落地，防 a2 隐形行）
- `packages/renderer/src/chamber-covered.ts`：`CHAMBER_COVERED_IDS` 增
  `'@deepseek-ai/dsh-client-ui-open-in-app'`（page-own、无 factory；precedent：ui-sidebar/
  ui-layout/dsh-client-hmr）——a2 后官方 client 行将随 host-graph 出现，covered 后不进 chamber
  复合入口；官方按钮在 chamber 壳内 availability 失败会自隐藏（双保险）。
- 决策点记录：官方 **host** open-in-app 行是否随 a2 runtime 默认 profile 进入托管实例
  （chamber 的 --patch 能否摘除）→ [UNVERIFIABLE]，实机确认后登记（倾向接受 dormant +
  文档化，不引入 chamber 侧 host 代码）。

### 2.5 T1 验证与文档
- 验证：ensure --check（270 链接）、frozen、根/各 typecheck、全套测试（connection 重点：
  recovery 合并后 epoch/liveness 回归）、build:renderer（typert 工件重生成：message-feedback/
  session-reference/subagent 相关 diff 需提交）、build:dsh-runtime、verify:i18n、
  test:release-workflow；已知既有失败（control-plane spawnDsh abort post-TCP）另行复现登记。
- 文档：CHANGELOG zh/en [Unreleased]（alpha.2 双线条目）、STATUS 记录收口、design 11/18 与
  deploy/checklist 当前值刷新（0.1.2-rc.1 → 0.1.3-alpha.2）、i18n 重录。

## 3. T2 — 目录/包命名统一（Batch 1，原子单批）

### 3.1 目标形态（已批准；目录 == 包名非 scope 段）
| 类别 | 现状 | 目标 |
|---|---|---|
| 7× client 插件 | 目录 `dsh-chamber-client-ui-*`；包名 `@dsh-chamber/dsh-client-ui-*` | 目录不变；包名 → `@dsh-chamber/dsh-chamber-client-ui-<x>` |
| 3× host 种子 | 目录 `dsh-host-client-graph` / `dsh-chamber-host-git-worktree` / `dsh-host-archive-cleanup`；包名 `@dsh-chamber/dsh-host-*` | 目录+包名 → `dsh-chamber-seed-<loader-id>` / `@dsh-chamber/dsh-chamber-seed-<loader-id>`（loader id 与 probe 域不变） |
| mobile | client-ui 族 | **不动**（client-kind + extraSeedEntries，非 host seed） |
| fork 副本 ×3 | `@deepseek-ai/dsh-*` | **不改**（shadow 机制） |
| 基建 | — | 豁免 |

未来 host-kind 种子统一 `dsh-chamber-seed-`，控制面/gateway seed 登记处加 fail-loud 断言
（`kind==='host' ⇒ name matches ^@dsh-chamber/dsh-chamber-seed-`）。

### 3.2 引用面（调研清点摘要，执行时按全量清单走）
- 名称引用：根 `--filter` 脚本（脚本名不变 → CI YAML 零改）、renderer covered/factory 表 +
  chamber-entry + vendor-modules.d.ts + shell/api/App 导入、跨插件 by-name 导入（git/layout/
  settings-bridge/settings-connections）、mobile build ID（lib/client.js 内嵌字面量需重建）、
  gateway（SYNCABLE_HOST_PACKAGES/HOST_PACKAGE_PROBE_DOMAINS 按名键控、slug、syncedSourceDir）、
  desktop plugin-sync/ssh-provider fixtures、control-plane host-graph-seed/cordis-inserts、
  UI 文案常量 plugin-inventory-text、docs 全量、锁文件 importer。
- 目录引用：.gitignore committed-dist 负规则（**必须与 git mv 同批**）、control-plane 默认
  source-dir 常量、desktop main dev 分支路径、build-host-graph-package.mjs、renderer/git 相对
  深引、tsconfig excludes、测试 fixture 路径。
- 语义耦合（勿漏）：loader-row 身份（name ⇒ 磁盘布局 ⇒ 探针 ⇒ 激活缓存）、deny 谓词为 scope
  级（不需动）、covered/factory id == 包名（锁步 assert fail-loud）、golden-overlay 字节、
  desktop↔gateway 漂移按名比较、打包 dist/host-*-package 标签派生（不受影响）、发布计数 15
  不变、无 npm 发布。
- i18n：无包名字面量（无需改记录）。

### 3.3 迁移步骤（单提交内顺序）
1. `git mv` host 目录 + .gitignore 负规则同批（committed dist 随迁，防 CI clone 丢失）
2. 包名 + 全引用（按 §3.2 清单）
3. 重建：mobile（scripts/build.mjs → lib/client.js+map、gateway/host-packages 复制）、
   host dist ×3（内容字节稳定、路径搬移）
4. 锁文件重生成（vendor 树在场；importer 全量变；保留 @deepseek-ai vendor 记录；frozen 验证）
5. 文档 pass（历史 CHANGELOG/design 16/20 保留 + 顶部 rename 注记）
6. 全量验证（root/插件 typecheck、全套测试含 cross-package-contract/plugin-sync/
   host-graph-seed/feature-lifecycle、verify:i18n、build:renderer、build:host-packages、
   build:desktop、gateway build+pack smoke、release-preflight、verify:workflows）

### 3.4 过渡例外（两个，随本批发布）
- 远端 `cordis.patch.yml` 旧名行：一次性 fold（按 loader id 超越 chamber-legacy 名行），
  否则升级后远端 seed 因 id-bound 冲突永久硬失败。
- 旧名 profile node_modules / chamber-plugins slug 目录：本地自愈；远端孤儿可清理可忽略。

## 4. Fork 重锚 alpha.2 + 补丁最小化（Batch 2；用户问题 2 的答案）

### 4.1 结论（实证）
- **三个 fork 在 a2 均不可丢弃**：上游无多实例 boot / extraRows / configureContext / 前缀托管
  （只在文档根服务单实例；client/web 与 client/modules src 自 rc.1 零改动）。唯一架构级退场
  通道 = 每实例独立 origin/页（design-05 级决定），不属本计划。
- **推荐：alpha.2 一次性重锚 + 补丁最小化**（比持续旧锚修补显著减分叉），之后**锁步随 pin**
  移动 + **重放规模门**（上游 delta >~150 行或触及 connection.ts/boot.ts 语义 ⇒ 升级为
  seam 重审）。

### 4.2 逐 fork 动作
- **connection**（主要工作）：按 a2 全量重抄（http-bridge/rpc/rpc-host/index/fixture 已等于 a2，
  实际 = connection.ts/client-index.ts/index.ts 的 a2 内容 + recovery-config.ts）；
  loopEpoch 守卫与 stop+start 触发路径**删除**、改由原生 `reconnect()/setNetworkAvailable()`
  （liveness 触发加 onLine 门）；`CONNECTION_BACKOFF_MAX_MS` 迁为 liveness-triggers 内部默认并
  视消费删导出；basePath 收敛为 **apply(ctx) 读 `ctx.chamberBasePath`**（与 api-gateway 对称，
  chamber-entry 不再传 config）；browser-auth 注释与 prose rebase 日志清掉（换单行日期头）；
  erasableSyntaxOnly 显式字段改写保留；采用 a2 recovery 语义（15s 硬超时 + 3s warn）。
- **client-web**：重锚=卫生（上游零漂移）：**base.css 移出 fork**（上游文件恢复字节一致，
  chamber token 表改由 renderer 入口 CSS 引入）；保留 5 个不可替代 seam（模块系统宿主
  __DSH_MODULES__/__ModuleLoader__、extraRows/boot-rows、configureContext、容忍/boot-tolerance、
  runtimeCtx/bootError/异步 dispose 硬化）；trim seed/platform/index 散文。
- **api-gateway**：版本/描述；apply(ctx) 同样改读 ctx.chamberBasePath（chamber-entry 同步）。

### 4.3 防分叉的其他手段（已评分，采纳项）
- 上游原生机制：仅 timing 类可注入（页面 `__DSH_CONNECTION_RECOVERY__` 或 start(config)）；
  basePath/extraRows 因 N-ctx 一页多实例**不可能**页面级化（结构性根因，已论证）。
- **反向 upstream（机会主义小 PR）**：loop 级 reconnect 暴露、async dispose no-reject、
  `__DSH_BASE_PATH__` 式 embedding knob（默认 no-op 字节一致）；不阻塞重锚。
- 节奏：fork 与 vendor pin 锁步（ed1f0d8 模式），不跳 alpha。

## 5. T3 — Open-in 统一（Batch 3；用户问题 3 的答案）

### 5.1 目标形态（已批准）
- 吸收官方 client（组件/菜单/css/locale/标签表/选择持久化），**单 slot 入口**；
  官方 id `@deepseek-ai/dsh-client-ui-open-in-app` 保持 covered（§2.4 先行）；
  官方 host 半边不写 chamber 代码（本地实例内由官方包自带，经代理复用其 API 通道）。
- 呈现矩阵：本地=官方全量本地应用拾取器；dsh/gateway+ssh=**仅 VS Code 远程一项**
  （deeplink 等价物：主进程 IPC + source fingerprint proof）；http/未知/无路径=无。
- 通道（评分 23 vs 13 vs 14，选 a）：本地 catalog/图标/launch 走实例 host 路由
  （`<basePath>/open-in-app/*`——**控制面零代码**：实例代理为无白名单逐字透传，cookie 注入
  与 Host/Origin 重写已就绪）；**vscode 全家走 IPC 覆盖**（本地 `vscode://file`+新窗口策略、
  远端 `vscode-remote` URL、六步 loud 管线、指纹证明不变）；控制面 origin-root 映射**否决**
  （多实例语义污染）。红线两面已论证：本地 launch 信任界自 trustedIpc 迁至实例官方路由
  （connection 栅栏 + 白名单 + 绝对存在目录校验），控制面仍零执行面；以 design 05/20/AGENTS
  措辞修订登记。
- 远程 deeplink 语义：唯一存活项 = VS Code 远程（主进程构造 vscode://vscode-remote URL，
  不经 chamber 隧道/凭据；sshPort≠22 拒绝；password 主机留给 VS Code）；真浏览器上下文的
  OS 级 `dsh-chamber://open-vscode` 冷启动入口不变。

### 5.2 分阶段
- **Phase 0**（可提前，纯门控）：capabilities/open-in-gates 演进为 per-source view-model
  （双池 officialEntries/mainEntries + 显式抑制原因），纯函数 + 单测钉规则。
- **Phase 1**（随 T1 或紧随）：covered 一行（§2.4）。
- **Phase 2**（a2 基线上，本批核心）：官方 client 源入住 `dsh-chamber-client-ui-open-in`
  （component/css/locales/label 表 + `source-adapter.ts`：per-source 双 store 选择、
  basePath fetch/icon 重映射、per-entry channel 路由）；desktop 主进程瘦身至 vscode-only
  provider（finder/stat/openPath IPC 退役，proof/生命周期/队列保留）；chamber-entry 传参同步
  （§4.2 的 ctx 读取）；测试重写 + lockstep（host-graph 锁步、ipc-surface-mirror、
  cross-package-contract、renderer-trust）+ verify:i18n。
- 决策/风险 11 项（调研稿）：roster enablement [UNVERIFIABLE]、远程无 cookie 下 fence 行为
  [UNVERIFIABLE]、remote cwd 填充 [UNVERIFIABLE]、图标缓存/CSP、单本地实例假设、
  r6 vscode 探测器差（官方仅 /Applications bundle vs chamber PATH code → 展示并集+IPC 兜底）、
  r7 本地 vscode 策略保持（IPC 覆盖）、slot 顺序与 locale NS 合并（保持 order −1、单一 chamber
  NS、~40 个 app.* 标签随上游升级同步）、r10 单入口时选择持久化副作用、N-ctx 信任域注释更新。

## 6. T4 — 上游触点跟踪（Batch 0.5）

### 6.1 文档
`docs/checklists/upstream-touchpoints.md`（新；与 dsh-upgrade-checklist 同级，zh 正文 + en 标识，
STATUS 加链接行）：0 基线速查表 / 1 四类 surface 与标记约定（[pure]/[patch-add]/[patch-mod]/
[patch-comment]/[own]/[own-divergent]；锚 = fork package.json version + harness.commit）/
2 fork-mirror 登记（含有意未镜像表与每次 delta 日志）/ 3 deep-import 与 roster 登记 /
4 contract-mirror 登记（按上游属主分组）/ 5 再生物登记 / 6 保鲜自动化 / 7 每 tag 维护循环 /
8 PR 评审清单条目。初稿表格（逐文件分类）已在调研稿附录，落地直接采用。
已知要点：pure 20 文件 + 3 README 字节恒等可校验；patched 12 文件指纹已列；base.css 为
[own-divergent]（重锚后出 fork）；上游 host 半/tests/tsdown 为有意 dropped。

### 6.2 脚本
`scripts/dev/verify-upstream-touchpoints.mjs`（只读、exit-code 语义、仅内置模块）：
C1 pure 字节恒等（当前全 PASS）/ C2 `--tags old new` 重放报告（advisory）/
C3 完整性（fork 每文件在表、上游新文件必有裁决，漏=硬失败）/
C4 roster（remotePackagesFromAssembly==13、covered 50/factory 29 存在性、删包 fail-loud）/
C5 过期锚扫描 / C6 EXCLUDED 上游存在性 / C7 种子域锁步 / C8 生成物陈旧（advisory）。
接入：update-vendor 步骤 7 提示运行；CI 在 Bootstrap 后加一步（C1/C3/C5/C6 fail-loud）；
不进 preinstall。

### 6.3 保鲜闭环
每 tag 8 步循环（登记→update-vendor→触点报告 C2→fork 重放+版本标记→roster pass→契约复验→
运行时线单独提交→文档回写）；PR 模板加"上游触点"自检项（新增 @deepseek-ai/* 深导入/改 fork/
镜像 wire/新再生物 ⇒ 必须登记）。

## 7. 决策记录（2026-09，用户批准）
1. 命名统一按 §3 目标形态（client 补词、种子 `dsh-chamber-seed-<loader-id>`、mobile/fork/基建
   不动、原子单批）。
2. fork 在 a2 一次性重锚 + 补丁最小化（§4）；之后锁步随 pin + 规模门；机会主义反向 upstream。
3. open-in 方案 A（§5）：吸收官方 client；本地=实例通道+vscode IPC 覆盖；远程=deeplink-only；
   红线以 design 修订登记；covered 一行先行。
4. 上游触点文档+脚本（§6）按设计落地，CI fail-loud 步骤纳入。
5. 批次顺序 Batch 0 → 0.5 → 1 → 2 → 3，每批独立提交与绿门（§8）。
未尽事项（各批执行时再触发）：T1 的 open-in host 行处置实机确认；T3 的 3 项 [UNVERIFIABLE]
实机验证；fork 重锚后 design 05/16/20/AGENTS 措辞修订；命名批的 todo README 行更新与撤销。

## 8. 每批绿门（执行时逐项打勾）
- Batch 0：ensure --check 270 链接；frozen；根+各 typecheck；全套测试（连接 recovery 回归）；
  build:renderer + typert 工件 diff 提交；bundle:dsh + bin.js 冒烟；verify:i18n；
  test:release-workflow；实机激活探针一轮。
- Batch 0.5：verify-upstream-touchpoints C1–C8 期望态全绿；CI 步骤演示通过。
- Batch 1：§3.3 步骤 6 全量矩阵；golden/lockstep/seed fixtures 更新；无中间态提交。
- Batch 2：重锚后 typecheck:connection/client-web/api-gateway + test:connection + test:client-web
  + build:renderer + 手动本地/SSH 实例回归（sleep/wake、隐藏恢复、版本歪斜容忍、gateway 形态）。
- Batch 3：Phase 0 门控单测 → Phase 2 全量（renderer-shell/desktop open-in 相关/lockstep/
  verify:i18n）；红线修订登记先行评审。

## 9. 关联与记录
- 任务登记：`docs/progress/STATUS.md`「分支任务登记（v0.1.3-alpha1 规划）」块（本文件为全量
  载体，STATUS 只留指针）。
- 升级手册：`docs/checklists/dsh-upgrade-checklist.md`（§0–§8）。
- 上游审计证据：本会话五份调研（git 历史保留）；alpha.2 上游事实见 §2.1。
