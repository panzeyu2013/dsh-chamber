# dsh 上游升级审计 — 临时结论工作文档（b150a551 → dsh-v0.1.2-alpha.1）

> ⚠️ **临时工作文档**（用户要求：审计期间在此汇聚所有结论，后续结论直接追加）。
> 非正式设计文档。升级落地后按 `docs/checklists/dsh-upgrade-checklist.md` §7 归档到
> STATUS.md / CHANGELOG，本文件可删除。审计为**只读**，未修改任何仓库文件。

---

## 0. 审计概况

> **决策状态(2026-xx 已拍板)**:D1=方案 A(fork api-gateway client)、D2=方案 1(控制面实例事实)、D3=采纳 READY 门/保留 prefetch 守卫、D4=本次不实现(记录解锁,后期排期)、D5=deep-source import、D6=ui-session/ui-chat/ui-approval 进复合、ui-cordis 忽略。
> **执行状态**:见文末 §11 执行状态跟踪表(随迁移推进更新)。

- 上游：deepseek-harness，旧 pin `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（0.1.1-rc.2）→
  目标 tag `dsh-v0.1.2-alpha.1` = commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`（git ls-remote 复核一致）。
- 上游根 package.json：version `0.1.2-alpha.1`；packageManager `pnpm@11.7.0`；engines `node ^22.19.0 || >=24.0.0`。
- 差异规模：**单个 squash 提交**，6421 文件，+323745/−126827 行；packages 改动 3419 文件
  （client 945、api 151、session 136、subagent 135、llm 110、host 99、boot 20、typert 35、settings 13、preset 42…）。
- 分派 4 个 subagent：SA1 fork 副本 rebase 面（✅）、SA2 控制面/渲染器/桌面/gateway 消费面（⏳ 运行中）、
  SA3 设计 07 §4 + 插件注册面（✅）、SA4 版本常量/锁文件/CI 机械面（✅）。
- subagent 原始报告：`/tmp/dsh-upgrade-audit/sa1-fork-rebase.md`、`/tmp/dsh-upgrade-audit/sa3-design07-slots.md`、`/tmp/dsh-upgrade-audit/sa4-mechanics.md`（SA2 待生成）。

## 1. 性质判定

**结构性升级，不是增量 rebase。** 上游删除两个 chamber 深度依赖的整包：

| 旧包 | 新状态 | 替代 |
|---|---|---|
| `@deepseek-ai/dsh-client-runtime`（packages/client/runtime） | **整包删除** | `@deepseek-ai/dsh-client-store`（新，仅 3 源文件，store 原语）+ `@deepseek-ai/dsh-api-session-controller` / `dsh-api-workspace-controller`（会话/工作区 client 面）+ `dsh-client-ui-renderer`（SlotRegistry 新家）+ `dsh-client-ui-session`（新） |
| `@deepseek-ai/dsh-host-apiproxy`（packages/host/apiproxy） | **整包删除**，`toFetchHandler` 新 commit 全树 **0 命中** | `packages/api/*`（settings-controller / session-controller / workspace-controller / remotes / gateway，Typert Remote 面） |

其他包级变化：connection 依赖 `ws`→`zod`；`packages/client/runtime` 删除、`store`/`ui-approval`/`ui-chat`/`ui-session` 新增；
顶层新增 `packages/webhook`（webhook/webhook-github）；vendor 链接集合**删 5 增 25**（240→260）。

## 2. P0 总览（编译/启动必坏）

1. **7 个 chamber 包 `workspace:^` 依赖已删的 dsh-client-runtime**：dsh-client-web、dsh-chamber-client-ui-sidebar、
   settings-bridge、ui-git、ui-layout、ui-open-in、ui-settings-connections → **pin bump 重生成锁文件时 pnpm 解析失败**，
   §3 fork rebase/依赖重指是 pin bump 的**硬前置**。
2. **dsh-client-connection peer/devDeps 依赖已删的 dsh-host-apiproxy**（package.json:55,67；src/index.ts:7 import toFetchHandler）。
3. **boot manifest wire 契约变化（P0）**：vendor `dsh-client-modules` 的 `parseBootManifest` 强制 `graph.batches` 数组
   （`BootModuleRow` 新增 `initialUrl`/`inject`、重复 entry id 硬失败）→ chamber `packages/renderer/scripts/gen-boot-manifest.mjs`
   生成的旧 shape（无 batches）升级后 boot 解析**直接抛错**。
4. **传输层删除**：`events.mux`/`events.host` WebSocket 路径常量删除（api-path.ts）、`websocket-downlink.ts`/`web-api-client.ts`
   删除 → 推流迁到 vendor `dsh-api-gateway` 的**硬编码** `new URL('/api/remote.mux', location.origin)`（stream-protocol.ts
   `REMOTE_STREAM_MUX_PATH='/api/remote.mux'`）——**per-instance base-path 补丁面迁移**，最大设计决策点（见 §6.1）。
5. **npm 未发布**：`@deepseek-ai/dsh@0.1.2-alpha.1` 不存在（latest/next=0.1.1-rc.2；dsh-client-store 亦未发布）→
   运行时线（bundle-dsh / install-gateway.sh / dsh-runtime 安装器）被阻塞。

## 3. SA1 — fork 副本 rebase 面（完整报告 /tmp/dsh-upgrade-audit/sa1-fork-rebase.md）

### 3.1 dsh-client-connection（上游 37 文件改动）

- 三分法：
  - **冲突（5 个补丁文件 ∩ 上游重写，需在新实现上重打补丁）**：
    - `src/api-path.ts` — 上游删 `MUX_EVENTS_PATH`/`HOST_EVENTS_PATH`；保留 chamber `resolveInstanceBasePath`/`__DSH_BASE_PATH__`
    - `src/client/connection.ts` — 新构造器 `(source: ConnectionGenerationSource, sinks, config)`；`streamOpenTimeoutMs`→`generationReadyTimeoutMs`；
      `ConnectionHostInfo` 只剩 `{home}`；重打 basePath config、`CONNECTION_BACKOFF_MAX_MS`、design 14 D4 loopEpoch 守卫
    - `src/client/index.ts` — `ConnectionHandle` 面 `{api, hostDescription, start}` → `{rpc, generation, registerGenerationSource, start}`；
      `ClientTransportHooks` 增 `openStream`/`loadBundle`/`ownsHost`；重接 carrier-assembly / liveness-triggers（restart 改 handle 级）、保留 `handle.basePath`
    - `src/client/rpc.ts` — 新签名 `createWebConnectionRpc(doFetch?, openStream?)`；重打 `${basePath}${channel}/${endpoint}` 注入 + 透传 openStream
    - `src/client/web-api-client.ts` — **上游已删，直接删**（其 basePath 注入逻辑无对应物）
  - **干净采纳**：fixture.ts（`FixtureApiClient`→`createFixtureFaces()`/`createFixtureConnectionRpc()`）、rpc-host.ts、rpc.ts（协议类型自持）、
    client/api.ts、api-request-trust.ts、http-bridge.ts（300MiB `DEFAULT_MAX_REQUEST_BODY_BYTES` **未变**）、invariant.ts、
    **新增** browser-auth.ts、rpc-schema.ts；index.ts（host 半，async apply + `BrowserAuth` + `inject ['webServer','credentials']` + `Config.cookieMaxAgeDays`，删 apiProxy 回退）
  - **删除**：websocket-downlink.ts；random-uuid.ts / loopback-hostname.ts 上游未变保留
- 包级：deps 删 `ws` 增 `zod`；peerDeps 删 `dsh-host-apiproxy`/`dsh-tools`，增 `dsh-credentials`/`dsh-brand`/`dsh-host-directory-picker`/`dsh-settings`/`dsh-tool-todo`；
  tsconfig.client.json / tsconfig.host.json 删 apiproxy path mappings。
- **设计决策点 1.6**：推流 WebSocket 路径构造迁到 vendor api-gateway（`remoteStreamUrl()` 硬编码 `/api/remote.mux`），
  chamber 需三选一：① 新 fork api-gateway client（扩"可改 dsh 源"清单，AGENTS.md 更新）；② `connection.rpc.open`（`RpcStreamOpen`）接缝
  （在副本 apply 里提供 base-path 感知 openStream）；③ 评估 N-ctx 是否真用该流（若 chamber 会话面全走自建 fetch 通道可绕过）。
  无论哪条：`/api/remote.mux` WS 必须落到 `<basePath>/api/remote.mux`，否则控制面反代（只收 `/api/i/<id>/*`）收不到。

### 3.2 dsh-client-web（上游 11 文件）

- **必须采纳（P0）**：`platform.ts` `PLATFORM_MODULES` 增 `@deepseek-ai/dsh-client-store`（vendor ui-slots/ui-theme/locale/ui-layout 均 import store）；
  `seed.ts` staticModules 同步增；package.json devDep `dsh-client-runtime`→`dsh-client-store`，version→0.1.2-alpha.1；tsconfig.json 删 runtime path mapping。
- boot.ts：上游 `run()` 开头新增 `await window.__DSH_BOOT_READY__?.promise` 门（可选采纳 P2，chamber index.html 不注入该全局，`?.` 短路跳过）；
  `prefetchImmediateTier` 删 `__DSH_TRANSPORT__?.loadBundle` 守卫（P1 行为取舍，chamber 可保留守卫）。
- boot wire P0：`gen-boot-manifest.mjs` 输出新 wire（单 entry `@dsh-chamber/app` + 一个 `application` batch）。
- 注释引用更新：boot.ts:220（runtime ISessions→session-controller）、boot-tolerance.ts:82（SlotRegistry→ui-renderer）——P2。

### 3.3 ui-sidebar / ui-layout 镜像

- **结构不破坏，全为 import 来源迁移**：
  - `ClientContext` → cordis `Context`（官方惯例 `Context as ClientContext`）
  - `defineStore`/`EngineStoreHandle`/`EngineStoreInstance`/`ActionsDecl`/`ObservableSnapshot` → `@deepseek-ai/dsh-client-store`（contract.ts 名称签名全保留）
  - `WorkspaceId`/`WorkspaceView`/`IWorkspaces`/`WorkspaceSnapshot` → `@deepseek-ai/dsh-api-workspace-controller/client`
  - `SessionListState`/`SessionSummary`/`ISessions` → `@deepseek-ai/dsh-api-session-controller/client`
  - `SlotRegistry` → `@deepseek-ai/dsh-client-ui-renderer/client`（registry.ts:95）
  - `DirectoryBrowseError` → `@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts:62`（client index 未导出 → deep-source import 或本地复制）
  - `indexSubagentDescendants` → `@deepseek-ai/dsh-client-ui-workspace/src/client/subagent-lineage.ts`（同，deep-source 或复制）
  - locale 类型 → `@deepseek-ai/dsh-client-ui-slots`（上游已如此）
- **`WorkspaceListState` 上游已删**：新面 `WorkspaceSnapshot` = `{items: WorkspaceView[], archivedSessionIds, state, phase, error}`
  → sidebar `projectInstanceSnapshot`（shared/derive.ts）按新 shape 重构；`ctx.workspaces.startSession` 上游改走 `ctx.get('uiWorkspace').startSession`；
  `ctx.connection.hostDescription` 没了 → `dshVersionFromHostDescription` 失去数据源（P1 决策：build env `DSH_CLIENT_VERSION` 或新 controller 宿主事实）。
- layout fork：`store-core.ts`/`stores.ts` 换 store 源（P0）；`index.ts` 的 `ClientContext`→cordis、`inject` 增 `'locale'`、
  register 补 `locale: 'common'`（新 vendor AppFrame 需要 `PropsLocale<'common'>`/`SessionProvider`/`DocumentTitle`，P1）。
- **renderer 复合层连带**：vendor ui-layout/ui-sidebar 现在 inject `dsh-client-ui-session` → chamber-covered.ts/chamber-entry.ts 必须**新增覆盖**该包（P0）。

### 3.4 交叉依赖映射（runtime/apiproxy 删除）

- runtime→新家映射表见 sa1 报告 §4.1；settings-bridge 9 处（`vendor-modules.d.ts` 8 行 + bridge-rows/index.ts + runtime-section-plugin.ts +
  bridge-context.ts + client/index.ts 的 `ClientContext`/`SlotRegistry`）→ 全部换新源；**bridge-context.ts 的 `FakeConnectionHandle.api` 面被新
  `remote.settings` 取代，child-context 需重建**。
- renderer：`chamber-entry.ts:120,440`（`import * as Runtime from '@deepseek-ai/dsh-client-runtime/client'` + coveredFactory）→ 换新提供方；
  `chamber-covered.ts:56,148`；`vendor-modules.d.ts:23,71`；`shell.ts:561-651`（`ctx.sessions` 新 ISessions，`list.byId`/`open` 保留，字段核对）；
  `shell.test.ts:109,114`、`host-graph.test.ts` 文案（P2）。
- dsh-client-connection 内 apiproxy 引用：index.ts:7,158（toFetchHandler，删）、client/rpc.ts:6-20、rpc-host.ts:9-24（干净采纳新版）、
  web-api-client.ts:22-23（文件删）、client/api.ts（重写）、package.json:55,67、两个 tsconfig。

## 4. SA3 — 设计 07 §4 复查 + 插件注册面（完整报告 /tmp/dsh-upgrade-audit/sa3-design07-slots.md）

### 4.1 设计 07 §4 六项复查

| # | 复查项 | 判定 | 证据 |
|---|---|---|---|
| ① | serialize.ts 白名单扩增 | **未解锁** | wire 仍只发 model/messages/stream/stream_options/thinking/reasoning_effort/tools/temperature/max_tokens/stop；diff 仅图像序列化 |
| ② | deepseek/pi-ai schema 新字段 | 字段有变但**不解锁** | deepseek：`imageDetail` **删除（含旧配置直接 throw，破坏性）**、`imagePixelBudget` 增 `'low'`、catalog 增 `description`；pi-ai：3 个 baseten compat 开关（supportsFinishReason/chatTemplateArgs/supportsThinkingTokenBudget） |
| ③ | agent-default-model 暴露 | **解锁 ✅** | `exposedNamespaces` 0 命中（机制已删）；新宿主 `packages/api/settings-controller`（`@deepseek-ai/dsh-api-settings-controller`）`describe()` 返回**全部注册 namespace**（可读可写）；新 `session/modelCatalog.default` = `agentDefaultModel.currentSelection()`（catalog.ts:18,61）→ **07 §3 #3（设置页回显/默认选择）由阻塞转可行** |
| ④ | agent/request 官方监听者 | **未解锁** | 唯一非测试监听者 = webhook（session.ts:92），仅注入模型选择、webhook 会话作用域 |
| ⑤ | DeepSeekCatalogModel effort | **未解锁** | 无 effort/extra 泛化字段（imageDetail 移除） |
| ⑥ | schemastery 行为 | **无变化** | 两端均 3.18.1，vendor 零 diff |

→ 结论：设计 07 §3 #3 可单独先行落地（"新会话默认推理等级"或"设置页回显"），#1/#2/#4 推迟成立；§6 蓝本按此更新。

### 4.2 插件注册 slot 验证（**全部仍有效**）

| slot | 新 commit 位置 | 结论 |
|---|---|---|
| `sidebar.settings` | ui-sidebar slots.ts:41（scope root，occupant 注册链不变） | 有效；chamber priority -1 遮蔽机制不变 |
| `settings.section` | ui-settings slots.ts（契约不变） | 有效；**同包 wire 面变**：`settings.mutate(ns, ops, expectedRevision)` 新签名、`settings-contract.ts` 新增、`SettingsWireFace` 走 `ctx.remote.settings` |
| `sidebar.workspace.git` | 官方无此 slot，chamber 自声明自渲染（slots.ts:44 + SidebarRoot 三处） | 有效，无官方依赖 |
| `conversation.session.header.utilities` | ui-conversation slots.ts:111 | 有效（owner props 微调 `{children?:never}` 兼容）；ui-conversation 94 文件 diff = chat/ 拆往 ui-chat |
| 官方 SettingsRoot | ui-settings-general SettingsRoot.tsx:104 + shell-contract.ts | 不变；数据层改 `SettingsDocumentStore(ctx.remote,…)` |
| ui-agent-preset section | id `agent-presets` order 20 不变 | 有效；数据层 `connection.api`→`ctx.remote`（agentPresets/settings）+ `ctx.uiWorkspace` |

### 4.3 设置/预设面

- `packages/settings` 服务本体**零 diff**（settings/src/index.ts、settings-file 均无变化）；`types.ts` +59 行迁入 wire 视图类型 +
  新增 `settings/document-updated` 事件（携带 revision）。
- agent-presets（42 文件）：新增打包内置预设（`presets/{cordis,minimal,ptc,standard}/agent.cordis.yml + preset.yml`，新 authoring 形态）；
  远端方法集 `agentPresets: list/read/copy/deletePreset/select`（旧 `agentPreset.list/remove` 命名变化）。chamber 无结构依赖，影响低。
- settings-bridge 的 dsh-runtime section 仅依赖 nav 序（order 31），不受影响。

### 4.4 locale 抽查

chamber 只依赖：`Translate`/`TranslateNS` 类型再导出（新 locale client index.ts:37 仍从 ui-slots 再导出 ✅）、
`directory-browser` namespace（key 集未变，抽查 8 个 key 全在位 ✅）、`LocalePlugin` 模块形状（inject/apply 不变 ✅）。**无缺口**。

### 4.5 已知缺陷类（STATUS.md 两条记录保持有效）

- `dsh-client-hmr` `EventSource('/plugins/events')`：新旧一致 → `CHAMBER_COVERED_IDS` 断链修复继续生效。
- `dsh-session-log-export` `HEAD /api/session.export`：`SESSION_LOG_EXPORT_PATH='/api/session.export'` 不变（handler 从 apiproxy 迁入本包，wire 逐字未变）→ 缓办决策维持。

### 4.6 新包决策

| 新包 | 是什么 | chamber 动作 |
|---|---|---|
| `dsh-client-store` | React-free observable/snapshot-store 契约 + Zustand/Immer 引擎 | **必须迁移导入**（P0） |
| `dsh-client-ui-session` | Session Controller React 适配 + session 级 slots | 记录 + 迁移参照；vendor ui-layout/ui-sidebar inject 依赖 → chamber 复合层**必须覆盖**（P0） |
| `dsh-client-ui-approval` / `dsh-client-ui-chat` | 审批合成器 / chat 渲染栈（自 ui-conversation 拆出） | 记录即可 |
| `dsh-webhook` / `dsh-webhook-github` | GitHub webhook → workspace 会话 | 记录即可（不挂载） |
| `dsh-api-session-controller` / `-settings-controller` / `-workspace-controller` | 旧 host-apiproxy 分立的 Typert Remote 宿主（ctx.remote.session/settings/workspace） | 迁移参照（P0 导入目标） |

### 4.7 settings-bridge wire 重写要点（P0）

`bridge-api.ts` 按新 remote wire 重写：dotted id → Typert id——
`settings.describe/update/mutate/openDocument` → `settings/describe|update|replace|mutate|openSettingsDocument`（新增 `settings/openAgentPresetDirectory`、`settings/canOpenAgentPresetDirectory`）；
`credentials.describe/set/unset` 保留；`llm.providers`→`llm/listProviders`；`llm.models`→`llm/listConfigurableProviders` + `session/modelCatalog`（目录+默认选择新读面）；
`agentPreset.list/remove`→`agentPresets/list`、`agentPresets/deletePreset`；payload/envelope 改 Typert（`{args}` 面 + 新响应形态）；`response.result.ok` 消费改新 envelope。
`permission-row-controller.ts` 等同类 `settings.describe/mutate` 调用同步改；`SettingsScope` 类型源 → `@deepseek-ai/dsh-client-ui-settings/client`（settings-contract.ts）。

## 5. SA4 — 机械面（完整报告 /tmp/dsh-upgrade-audit/sa4-mechanics.md）

### 5.1 源码线（可机械升级）

`node scripts/update-vendor.mjs dsh-v0.1.2-alpha.1`：fetch+复核 tag → checkout submodule → 更新 harness.commit →
差量建链（`--allow-lockfile-stale`）→ pnpm install 重生成锁文件 → restore-lockfile-vendor-records → frozen 验证（前后 sha256 一致）。

- **基于上游包清单建链（非旧锁文件）→ 改名自动处理**：链接删 5（dsh-acp-demo、dsh-acp-snapshot、**dsh-client-runtime**、**dsh-host-apiproxy**、dsh-sdk-jsonrpc-demo）、
  增 25（**dsh-client-store**、**dsh-client-ui-approval/ui-chat/ui-session**、**dsh-webhook/dsh-webhook-github**、api-session/settings/workspace-controller、
  session-snapshot、util-crypto、util-workspace-path、win32-process、deepseek-llm-api-extensions、experimental-*×5、plugin-package-inventory-deepseek、
  sdk-app、sdk-minimal、session-log-deepseek）。期望链接数 **240 → 260**（262 包 − 2 EXCLUDED 副本;D1 fork 落地后 EXCLUDED 增至 3 个副本包,最终链接数 **259**,round9b 口径统一）。
- **锁文件坑（checklist §4 命中）**：pnpm 11 重生成裁剪 vendor importer → restore 脚本只从 git HEAD 补旧记录 →
  **25 个新包 importer 记录不在 HEAD，必须手工补齐**（零依赖单行 `  vendor/harness-packages/@deepseek-ai/<name>: {}`；
  有依赖参照 pnpm-lock.yaml:1518 `dsh-authorization` 块：`devDependencies:` + `specifier: workspace:^` + `version: link:../<sibling>`）
  → 三连验证：`pnpm install --frozen-lockfile` + `node scripts/dev/ensure-harness-vendor.mjs --check` + `git diff --exit-code -- pnpm-lock.yaml`。
- 同批提交：submodule gitlink + harness.commit + pnpm-lock.yaml（vendor 链接 gitignored 不提交）。
- 纪律：提交 gitlink 前不要 `git submodule update`；锁文件重生成前不要手工跑 ensure 默认模式。

### 5.2 运行时线（被 npm 发布阻塞 ⛔）

| 常量位 | 当前值 | 升级后 |
|---|---|---|
| `packages/desktop/scripts/bundle-dsh.mjs:80` lockfileDshVersion 兜底 pin | 0.1.1-rc.2 | 0.1.2-alpha.1（推导值自动随新 runtime 锁文件） |
| `packages/desktop/vendor/dsh/pnpm-lock.yaml` | @deepseek-ai/dsh@0.1.1-rc.2 | `bundle:dsh -- --force --refresh-lockfile` 重生成 |
| `.github/workflows/release.yml:65` env.DSH_CHAMBER_DSH_VERSION | 0.1.1-rc.2 | 0.1.2-alpha.1 |
| `scripts/install-gateway.sh:39` DSH_CHAMBER_DSH_VERSION | 0.1.1-rc.2 | 0.1.2-alpha.1（release-preflight 硬断言与 release.yml 一致） |

- **`@deepseek-ai/dsh@0.1.2-alpha.1` 未发布**（versions 止于 0.1.1-rc.2；dist-tags latest/next=0.1.1-rc.2；dsh-client-store 亦未发布）。
  desktop bundle / install-gateway.sh / dsh-runtime 安装器都只从 npm 装 `@deepseek-ai/dsh` → **等上游发布（含依赖闭包齐发）后再走 §5**；
  发布前用 `npm view @deepseek-ai/dsh@0.1.2-alpha.1 dependencies` 复核闭包。
- 冒烟验证：`node packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version` = 目标版本。

### 5.3 fork 基线常量（P0，与 pin bump 同批）

- `packages/dsh-client-connection/package.json:4`、`packages/dsh-client-web/package.json:4` version → 0.1.2-alpha.1。
- `scripts/dev/release-preflight.mjs:15,67` FORK_VERSION 默认 → 0.1.2-alpha.1（release.yml:159 调 `--versions-only` 不带 flag 走默认；
  若改调用加 `--fork-version` 须同步 `scripts/dev/release-workflow-policy.test.mjs:35` 断言）。

### 5.4 注释/文档引用（分类）

- **需更新**：`packages/control-plane/src/spawn-dsh.ts:44-45`（b150a551 注记）；`packages/desktop/README.md:64`；`docs/deploy-gateway.md:29`；
  `docs/design/11-auto-update.md:257-258`；`docs/design/18-dsh-runtime-version.md:210,293`（P2）。
- **已核查（SA2 定论）**：`proxy-forward.ts:31,108` + `docs/design/03:277`（上游 300MiB/200MiB **不变**，W10；仅注释版本号可更新）；
  `packages/gateway/src/features/schedule.ts:79` + `feature-lifecycle.test.ts:364`（**session.prompt 必填 `requestId`**，W1/W11 方法串点→斜杠，P1 适配）。
- **保留（历史叙述）**：CHANGELOG 双份旧条目、design 07:10 时效警告、checklist 模板标注、update-vendor 示例字符串。
- **纯 fixture 不改**：`packages/dsh-runtime/test/*` 全部、`packages/desktop/dsh-runtime-controller.test.ts` 9 处、`after-pack-adhoc-sign.test.mjs`。
- **无 builtin 硬编码**：desktop main.ts `readDshVersion(builtinDshWorkspace)`（line 376-383）与 gateway runtime-manager.ts 运行期从 vendored
  dsh package.json 读取 → 升级后自动跟随。

### 5.5 CI / 工作流

- **零结构改动**：submodules:true 5 处（ci 1 + release 4）、frozen+`git diff --exit-code -- pnpm-lock.yaml` 漂移断言 5 处、
  node 22 / lts/* 满足新 engines（^22.19.0||>=24.0.0）；pnpm 11.21.0 ≥ 上游 11.7.0。
- 需同步仅：release.yml:65 env + release-preflight.mjs:67 FORK_VERSION 默认。
- `vite.config.mjs:47,116`：`if (name === 'dsh-host-apiproxy')` 特例（./client→src/fetch/client.ts、./api/*→src/api/*.ts）**必须按新结构重写**（P0）。

## 6. 升级顺序与未决决策

### 6.1 建议执行顺序

1. **§3 fork rebase / 依赖重指（硬前置）**：7 个包 runtime 依赖重指（候选 dsh-client-store / api-session-controller client face）；
   dsh-client-connection 的 apiproxy 重指；全部 src 重基（connection 5 补丁文件、web platform/seed、sidebar/layout/settings-bridge、
   renderer chamber-entry/chamber-covered/shell/vite.config、各插件 vendor-modules.d.ts）。
2. **boot manifest wire**：gen-boot-manifest.mjs 输出 batches/initialUrl 新 wire（P0，与 boot 升级同批）。
3. **pin bump**：`node scripts/update-vendor.mjs dsh-v0.1.2-alpha.1` → 手工补齐 25 个新 importer → frozen + ensure --check + 漂移断言 → 同批提交。
4. **运行时线（等 npm 发布）**：release.yml env / install-gateway.sh / bundle-dsh 兜底 → `bundle:dsh -- --force --refresh-lockfile` → bin.js --version 冒烟。
5. **文档**：STATUS.md 基线记录；CHANGELOG 双份；design 07 §4 更新（#3 解锁）；design 09/11/18、README、deploy-gateway、spawn-dsh 注记。
6. **回归**：checklist §6 全量炮组（见 §7 表）。

### 6.2 未决决策点（升级时拍板）——含推荐（2026-xx 补充）

- **D1（最大）：`/api/remote.mux` 推流 base-path** —— 已验证：`remoteStreamUrl()`（api/gateway/src/client/stream-client.ts:342）写死 `location.origin`，`RemoteStreamMuxClient` 无参实例化（client/index.ts:131），官方 `openStream` 钩子注明 "worker-local Gateway stream carrier"（rpc.ts:28），主流程 mux 流不走该钩子。
  - 方案 A：**fork api-gateway 客户端半边**为 chamber 副本（与 dsh-client-connection/dsh-client-web 同构：ensure EXCLUDED + packages/dsh-api-gateway 副本 + base-path 补丁重打 `remoteStreamUrl`）——机制一致、可控、风险最低；代价：AGENTS.md 可改源码清单 + 一项长期 fork 维护。
  - 方案 B：用 connection 副本的 `openStream` 接缝自建 base-path 感知流开启器——官方主流程不消费该钩子，需额外改造 api-gateway 消费路径，工作量大、风险高。
  - 方案 C：绕过（chamber 会话面全走自建 unary 通道）——与"attach，never re-implement"原则冲突，官方 ui-session/ui-workspace 新代码默认依赖 follow 流，绕过需补丁更多官方行为。
  - **推荐：方案 A**（若后续上游给 remoteStreamUrl 加配置接缝，可退回零补丁）。
- **D2：版本芯片数据源**（`host.describe` 删除后 `dshVersionFromHostDescription` 无数据源）。
  - 方案 1：控制面实例事实投影（控制面 spawn 时/SSH 连接时本就探测 `dsh --version`，非秘密元数据，chamber 侧 API 提供）——权威、诚实；探不到显示"未知"/隐藏芯片。
  - 方案 2：改显壳（复合）版本（`DSH_CLIENT_VERSION` build env，官方新做法）——不是实例版本，语义变了。
  - 方案 3：删除芯片。
  - **推荐：方案 1**（控制面实例事实 + 未知时隐藏）。
- **D3：boot 两个小取舍**。
  - `__DSH_BOOT_READY__` 门（上游新增，`?.` 短路）：**采纳**（对齐上游、零风险，chamber 不注入该全局即跳过）。
  - prefetch 守卫（上游删 `__DSH_TRANSPORT__?.loadBundle` 守卫改为永远预取）：**保留 chamber 守卫**（chamber 复合延迟加载依赖守卫，且不用 loadBundle transport；永远预取对 N-ctx 是浪费）。
- **D4：设计 07 #3 解锁后是否顺带实现"新会话默认推理等级"**。
  - 方案 1：本次升级顺带落地；方案 2：仅更新文档/STATUS（标记解锁），实现单独排期。
  - **推荐：方案 2** —— 本次升级已是结构性 rebase（P0 面 20+ 文件），混入新功能放大回归面；蓝本细化另行进行。
- **D5：`DirectoryBrowseError` / `indexSubagentDescendants` 导入方式**。
  - deep-source import（与 ui-layout fork 的 `deepseekSource` 同款 monorepo 接缝，单一事实来源）vs 本地复制（纯函数/小错误类）。
  - **推荐：deep-source import**（机制已有）；若打包链/类型解析有坑则本地复制纯函数。
- **D6（SA2 新增）：新官方行进复合还是 per-instance extras**（ui-session/ui-chat/ui-approval/ui-cordis）。
  - **澄清（2026-xx）**："进复合"≠"魔改/fork"。chamber 现状：只有自建包（sidebar 自建、layout fork、settings-bridge/connections、git/open-in、connection/web 副本）是 chamber 写的；其余官方 UI（ui-conversation/ui-workspace/ui-settings-* 等 39 个覆盖 id）一律**原样复用上游源码 + 编入复合壳**（chamber-covered.ts 覆盖清单，实例图行被去重、由复合提供）。新包走同一条路：加入 chamber-covered.ts + chamber-entry.ts 导入/工厂 + CI lockstep，不改上游源码。
  - **必须覆盖的证据**（已核实新 commit）：ui-conversation 的 `dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-session`（硬依赖）；chat 渲染 slot（`conversation.chat.node/commandview/turnTail/assistant-actions`）整体迁入 ui-chat；ui-chat 又 inject ui-conversation。不覆盖则：① 复合会话壳缺 ui-session → 从实例拉（版本分裂；老版本实例图里没有这行 → 会话视图缺件/降级）；② 缺 ui-chat → 聊天区 slot 声明丢失 → 聊天区空白。
  - **推荐：ui-session + ui-chat + ui-approval 进复合**（ui-approval 一并覆盖便宜、整壳一致）；ui-cordis（调试面）忽略（作为实例 extras 加载或缺失均无害）。

## 7. 回归验证映射（checklist §6 → scripts）

受改名影响**必须先适配再跑**：`test:client-web`、`typecheck:client-web`、`test:connection`、`typecheck:connection`、
`test:sidebar`、`test:settings-bridge`、`test:connections`、`test:layout`、`test:open-in`、`test:git`、`test:renderer-shell`、
`build:renderer`（chamber-entry.ts import dsh-client-runtime/client + vite.config apiproxy 特例）。

无影响可正常跑：`test:control-plane`（rpc-envelope 注释引用 apiproxy 待改注释）、`test:desktop`（fixture 版本不改）、`test:gateway`
（schedule wire 待核对）、`test:cli`、`test:host-git`、`verify:i18n`、`smoke`（未捆绑 SKIP）、typecheck 根 + `typecheck:runtime` + `typecheck:host-graph` + `typecheck:host-git` + `typecheck:gateway`。

## 8. 待办 / 进行中

- [x] **SA2（控制面/渲染器/桌面/gateway/dsh-runtime 消费面矩阵）** — 已完成，结论见 §9。
- [x] 上游 200MiB 图片准入（**不变** W10）/ session.prompt wire（**必填 requestId**，P1）/ parseBootManifest 消费者 — 均已覆盖。
- [ ] 主 checkout submodule HEAD 与 pin 一致性（本机工作区脏态提示：SA4 报 submodule HEAD 60a2382e ≠ pin b150a551，需在执行升级前核实物化状态）。
- [ ] 6.1 升级顺序落地时的决策点 D1–D5（见 §6.2）。

## 9. SA2 — 控制面/渲染器/桌面/gateway/dsh-runtime 消费面（完整报告 /tmp/dsh-upgrade-audit/sa2-consumption.md + 4 份子报告 sa2-{slots,settings-ui,typert-host,desktop-gateway}.md）

### 9.1 横切事实（W1–W13，影响所有模块）

| # | 事实 | 证据 |
|---|---|---|
| W1 | `dsh-host-apiproxy` 删除 → RPC 分发迁到新 `packages/client/connection`（`HostConnectionService`/`rpc-host.ts`）+ 新 `packages/api/{session,settings,workspace}-controller`（Typert Remote）。unary envelope（`client-request`/`server-response`）**形状不变**，但**方法路径点→斜杠**：`/api/session.list` → `/api/session/list`（两段式，旧点路径 404） | 新 `rpc.ts`/`rpc-host.ts`、apps/web e2e |
| W2 | `host.describe` **删除（无替代）**；`host.listDirectory`/`createDirectory` → `directoryPicker.list`/`createDirectory`（namespace `directoryPicker`） | 新 `packages/api/workspace-controller/src/directory-picker.ts` |
| W3 | `events.mux`/`events.host` 下行 WS **删除** → `/api/remote.mux`（WS，`{type:'open',streamId,endpoint,payload}` 复用帧）承载 Typert Remote stream（`session.follow`/`session.control`/`workspace.follow`/`$events`） | 新 `packages/api/gateway/src/stream-protocol.ts` |
| W4 | `dsh-client-runtime` 删除 → store 引擎→`dsh-client-store`；`SlotRegistry`→`dsh-client-ui-renderer/client`；session/workspace manager 客户端半→`dsh-client-ui-session` + api-session/workspace-controller；`ClientContext` 不再存在（官方改 cordis `Context`） | packages/client/runtime 全删 |
| W5 | `__DSH_BOOT__` 必填 `batches`（`{phase:'bootstrap'|'application',url,rev,entries[]}`，每 entry 恰属一个 batch）；`BootModuleRow` 必填 `initialUrl`+`inject`；缺 batches/未入 batch/重复 entry 直接 throw；bundle URL 改 **combo** `/plugins/??<id>/client.js,<id2>/client.js&rev=…` | manifest.ts / modules index.ts / system.ts |
| W6 | web profile 插件名册：**新增** ui-session、ui-approval、ui-chat、ui-cordis 行；runtime 行消失；chat 渲染拆往 ui-chat | 新旧 `packages/bundle/web-app/cordis.patch.yml` |
| W7 | `dsh-client-hmr` 仍 `EventSource('/plugins/events')`（帧带 rev、`invalidate(id,rev)`） | 新 hmr events.ts |
| W8 | `/api/session.export`（HEAD/GET）仍在（`@deepseek-ai/dsh-session-log-export` 移入 `packages/session-query/`） | 新 fetch-routes 测试 |
| W9 | dsh CLI 入口/参数**不变**：bin 仍 `lib/bin.js`；`--profile/--patch/--host/--port/--trusted-host` 语义不变；`--version` 仍裸版本串；`--patch` overlay 格式不变（新增 `anchorInsertedPluginNames` 只改写 `./`、`../` 相对 name，裸包名不受影响） | apps/cli、app-boot |
| W10 | 300MiB 请求体上限 / 200MiB 图片准入 **不变** | http-bridge.ts / attachment-local |
| W11 | `workspace.list` unary **删除** → `workspace.follow` stream + observable `WorkspaceSource`；`commands.execute` 形参 `{agentId,line,images}` → 直接 `(agent, line, images, signal)` | workspace-controller / interaction/commands |
| W12 | `settings.describe` 仍在（settings-controller），value 含 `namespaces` 数组（redactSecrets） | api/settings-controller |
| W13 | 上游 pnpm@11.7.0 ≤ chamber 内嵌 11.21.0（兼容）；engines node ^22.19.0||>=24 与 chamber lts/* 满足 | 上游根 package.json |

### 9.2 control-plane

- **static-serving.ts / gen-boot-manifest.mjs：P0 必坏** — manifest 缺 `batches` → 新 `parseBootManifest` 抛错，`AppWebEntry` 启动即失败。动作：`gen-boot-manifest.mjs` 输出 `{rev, entries, batches:[{phase:'bootstrap', url, rev, entries:[CHAMBER_ID]}]}`。
- **proxy-forward.ts**：300MiB 注释可更新（值不变，W10）；**`WS_STREAM_PATHS = {'/api/events.mux','/api/events.host'}`（:196）→ 更新为 `/api/remote.mux`**（P1 行为对齐；反代本身通用 passthrough，保留旧值仅心跳无副作用）。
- **ws-frames.ts / ws-heartbeat.ts：无需改动**（纯 RFC 6455 ping/pong）。
- **spawn-dsh.ts：P0 运行必坏** — 就绪探针 `host.describe`（:651）在新 host 必失败 → 每次 spawn 5 次尝试后失败，本地实例永远起不来。**必须换 `session/list`（斜杠 POST）**；browse 探针 `host.listDirectory`（:678）→ `directoryPicker.list`（payload `{args:{}}`）；错误码 `directory-picker-unavailable` 语义按新 `requireCapability` 重查。CLI flags / SSH_CONNECTION pin 语义不变（W9）。
- **host-graph-seed.ts / cordis-inserts.ts：格式兼容（P2 观察）** — overlay 格式不变；新风险：新 profile.ts 把 profile node_modules 变为 pnpm 管理（`ensureProfileSymlink`/owned links），chamber 直写非 symlink 包存在被 pnpm prune 清掉的风险（升级后验证）。
- **rpc-envelope.ts：无需改**（envelope 形状与上游一致）；但 `dsh-client.ts` 的 `call()` 方法串由调用方给 → 所有 unary 调用点方法串改斜杠；`openEventStream('/api/events.mux'|'/api/events.host')`（:564）指向已删端点 → gateway 消费方改新流载体（P1）。

### 9.3 renderer

- **host-graph.ts：P0/P1** — `ExtraModuleRow` 喂 `extraRows: BootModuleRow[]`，新 `BootModuleRow` 必填 `initialUrl`+`inject` → **typecheck 必坏（P0）**，补字段（initialUrl=url，inject=[]）；`HostGraphRow.url` 现在是 **combo URL**（多 entry 共享）→ 逐行 `loadModuleBundle` 会把同一 combo 执行多次 → **按 URL 去重预载（P1）**。
- **chamber-covered.ts**：删 runtime 死 id（无害但清理）；**新增覆盖 `dsh-client-ui-session`、`dsh-client-ui-approval`、`dsh-client-ui-chat`、`dsh-client-ui-cordis`**（W6，否则作为 per-instance extras 以 combo URL 拉取、版本分裂）。hmr 覆盖理由仍成立（W7）。
- **chamber-entry.ts：P0** — `import * as Runtime from '@deepseek-ai/dsh-client-runtime/client'`（:120）包已删 → 重新组合 api controllers + store + ui-session + ui-chat + ui-approval（**最大重构面**；`ctx.plugin(ConnectionPlugin,{basePath})` 机制保留）。
- **vite.config.mjs：P0 构建面** — 删 `dsh-host-apiproxy` 特例（:116-121 死代码）；为 `dsh-client-store`/api-*-controller 等新包建源解析；`gen-typert-remotes.mjs`/`typert-remote-contract.mjs` 对齐新 remote 贡献包集合。

### 9.4 desktop

- **dsh runtime 管理（design 18）**：bin `lib/bin.js`（不变）、`--version` 裸版本串（不变）、DSH_HOME 布局（不变；chamber 状态全在 `<baseDir>/dsh-runtime/`，整树快照布局无关）、pnpm 11.21.0 ≥ 11.7.0（兼容）→ **P2 确认全兼容**。新行为观察：上游 `healProfilesModuleFallback` 变 async + 跨进程锁 + 每 profile `.dsh-module-fallback` 投影 + `normalizeShippedProfile` boot 期写回 `profiles/web/package.json` → **新的 boot 期 DSH_HOME 写入须保持在 chamber spawn 写入栅栏内（P2 观察）**。
- **激活探针（dsh-runtime/src/runtime-probes.ts:241/255）：P0/P1** — `host.describe` + `workspace.list` 删除 → 激活事务对新 host 必失败；替换为 `session/list`（斜杠）+ 新 workspace 源；`commands.execute` 形参变化后 miss 语义重查。
- **ssh-provider.ts / gateway-provider.ts：P1** — `verifyDshEndpoint`（POST `/api/host.describe`，~:346）、`probeDshSignature`（GET `/api/events.mux`，~:285）、gateway 身份握手（gateway-provider.ts:807-875）在新 host 全 404 → 换新身份/签名探针（如 `session/list` 斜杠 POST、`/api/remote.mux` upgrade + `$events` ready 帧）。
- 通知投影本体消费 renderer 事实，不直连 events.mux → 不受 W3 影响（P2 确认）。

### 9.5 gateway

- **features/schedule.ts：P1** — 新 `SessionPromptRequest` **必填 `requestId`**（持久化在 user message、回显于 `SessionQueuedItem.rpcId`）；schedule.ts:84 加随机 UUID；响应 `command?` 槽删除（chamber 未用）。**方法名映射（dot→slash + 改名）**：`session.list`→`session/list`、`session.prompt`→`session/prompt`、`session.history`→**`session/page`**、`session.models`→**`session/modelCatalog`**、`workspace.list` 删除（→`workspace/follow`）、`host.*` 目录方法→`directory-picker/*`、`host.openPath`→`session/openWorkspacePath`。
- **features/index.ts / notify.ts / dispatch.ts：P1** — `:319/:331` 消费 events.mux/events.host 的 `session/subscribed`/`session/projection` 帧（帧协议删除）→ 迁移到 `session/control`（`SessionControlBaseline{queues,jobs,projections}`）+ `session/follow` Remote stream；`dispatch.ts:415` upgrade 特判改 `/api/remote.mux`。
- **/chamber/runtime 代理：无需改（P2）**（只依赖 `bin.js --version` + restartLocal 事务）；**systemd restart_service：无需改（P2）**（上游无 systemd 耦合，chamber 为 SSH-only 白名单 unit 的 systemctl exec）。

### 9.6 dsh-runtime

- npm 安装/冒烟兼容（0.1.2-alpha.x 发布后）；pnpm/engines 兼容；DSH_HOME 快照/恢复布局无关（P2）。
- **激活探针（P0/P1）**：`host.describe`+`workspace.list` → 替换；`settings.describe` 的 `.namespaces` 校验仍成立（W12）；`commands.execute` wire 变化（W11）。

### 9.7 host 包 —— 🎉 重大好消息

- **`packages/dsh-host-client-graph` 与 `packages/dsh-chamber-host-git-worktree` 无需修改**：`@Remote('name')` 装饰器、`TypertRemoteService(ctx, serviceKey, options?)`、unary envelope（原样迁入 connection/src/rpc.ts）、`payload:{args}`、2 段 SRC endpoint claim（`claimsEndpoint` 未变）、`workspaceRegistry.list()` → `{id,path,sessionIds}`、`agents.list()` → `{id,status,session.header.cwd?}` 形状全部 KEEP。
- **`dsh-chamber-client-ui-git/src/client/index.ts`：P0** — `ClientContext` from runtime → cordis `Context`，删 peer dep 与 vendor-modules.d.ts stub。
- **sidebar `shared/instance-api.ts`：P1** — `client.workspace.list({})`/`client.sessions.list({})`（喂 git sagas）随 connection 客户端重同步一并处理（workspace.list 删除 → workspace/follow stream）。
- 未消费增量（P2 记录）：`TypertRemoteFailure`、`@Remote({mode:'stream'})`、`TypertHostContextAdapter`（新增必填 identity）、`$dispatch` 删除等。

### 9.8 settings-bridge / settings-connections

- **HARD BREAK（P0）—— settings 子 ctx 无法挂载**：settings wire 从 `connection.api.settings` 迁到 `ctx.remote.*` Remote namespace（位置参数 + `RemoteResult`）；官方 settings 插件 `inject` 全部新增 `remote.settings`（models 还要 `remote.credentials`/`remote.llm`，plugins 要 `remote.credentials`/`remote.session`）。chamber `buildRemoteStub` 只暴露 `$on/$dispatch/pluginInventory` → inject 永不满足 → 5s 挂载门 fail-loud。**必须扩展 stub remote + 重接 bridge-api.ts**。
- runtime 溶解（P0）：bridge-context.ts:20 `SlotRegistry`→ui-renderer/client；`ClientContext`→cordis；`SettingsScope*`→ui-settings/client（settings-contract.ts）。`SettingsSchemaService`/`/client` 子路径/`settings.section` slot **KEEP**。
- **ui-primitives（P1/P2）**：26 个 chamber 图标名全部 KEEP；**`RiskConfirmation` 新增必填 `closeLabel` — chamber `PermissionRow.tsx:93-100` 未传**（ambient face 掩盖，a11y 回归，需补）；HoverCard `copyLabel/copiedLabel` 必填（SidebarRoot.tsx:2445 调用安全）。
- **ui-theme（P2）**：token 集逐字节一致，`--dsw-*`/`--ds-*` 全 KEEP；新增 `ThemeSnapshot.fontSize`/`--dsh-content-font-size`（additive）。
- **agent-presets（P2 信息）**：`code` preset **删除**、`ptc` **新增**（现 standard/ptc/minimal/cordis）；chamber 无代码引用 preset id。
- additive：`settings.models.provider-card`/`footer` 子 slot、`SubagentModelSelectionCard`、`FontSizeRow`（bridge-outlet 已支持 keyed/list 根 slot）。

### 9.9 sidebar / layout / open-in —— slot 与类型

- **全部 slot id KEEP**：`conversation.session.header.utilities`（open-in）、`sidebar.settings`（遮蔽语义不变）、`settings.section`/`settings.general.item`、`sidebar.workspace.git`（chamber 自有）、`sidebar`/`root`/`conversation`/`details`/`shell.overlay`/`sidebar.workspaces`/`sidebar.footer.action`；ui-conversation 的 chat slot 们整体迁入 ui-chat（id 不变，MOVED-PACKAGE）。
- **ui-slots 类型 KEEP**：`InjectFace`/`PropsLocale`/`PropsRuntime`/`StoredEntry`/`SnapshotSelectorHook`/`LocaleFace`/`HostObservable`/`RenderOpts`/`resolveSlotLabel`；store 类型经 `dsh-client-store` 再导出；`SlotRegistry` 签名 KEEP、新家 ui-renderer（新增 `provideRoot`）。
- **需要 chamber 适配**：6 插件 + chamber-entry + dsh-client-web 的 `ClientContext`→cordis/`SlotRegistry`→ui-renderer/store 类型→dsh-client-store；`SessionListState`→api-session-controller/client；`WorkspaceListState`→`WorkspaceSnapshot`（**无 `baselinesReady` — chamber `derive.ts` 的 `baselinesReady !== true` 检查必须删**，否则投影永久 withdraw）；`indexSubagentDescendants`→ui-workspace；`DirectoryBrowseError`→ui-workspace navigation.ts；`ctx.workspaces.startSession`→`ctx.uiWorkspace.startSession()`；`ctx.connection.hostDescription`→`connection.generation`（**只含 home，无 dsh 版本 — 版本芯片需新数据源**）；layout fork 采纳 `locale:'common'` 注册 + 新 AppFrame 的 SessionProvider/useSessions 标准 props。

### 9.10 SA2 适配动作清单（合并入 §6.1 顺序）

**P0（10 项）**：① gen-boot-manifest.mjs 补 batches；② host-graph.ts 类型对齐 + combo 去重；③ chamber-entry.ts 重组合 + chamber-covered.ts 增删；④ 6 插件 ClientContext/SlotRegistry 迁移；⑤ dsh-client-connection 整包 rebase + instance-api；⑥ spawn-dsh.ts 探针；⑦ dsh-runtime 探针；⑧ ssh-provider/gateway-provider 探针；⑨ settings-bridge stub remote + bridge-api 重接 + RiskConfirmation closeLabel；⑩ vite.config 特例清理 + typert 生成器对齐。

**P1（7 项）**：⑪ gateway schedule requestId；⑫ gateway 流迁移（session/control+follow、/api/remote.mux）；⑬ gateway 方法改名（history→page、models→modelCatalog、dot→slash）；⑭ proxy-forward WS_STREAM_PATHS；⑮ sidebar 状态面（WorkspaceSnapshot/startSession/generation/版本芯片）；⑯ layout 注册面（locale:'common'/store/AppFrame props）；⑰ dsh-client-web 类型对齐（BootModuleRow/extraRows）。

**P2（观察）**：host-graph-seed prune 风险；上游 boot 期 DSH_HOME 写入栅栏；STATUS.md 记录维持；`CHAMBER_COVERED_IDS` 死 id 清理；`--version`/bin/pnpm/systemd 兼容确认。

## 10. 追加日志（后续结论直接追加到此节）

- 2026-xx-xx：SA2 完成，§9 已追加（含 W1–W13 横切事实、四模块判定、P0×10/P1×7/P2 动作清单、host 包"无需修改"好消息）。
- 2026-xx-xx：决策建议已补充至 §6.2（D1 推荐 fork api-gateway client；D2 控制面实例事实；D3 采纳 READY 门/保留 prefetch 守卫；D4 不混入升级；D5 deep-source；D6 前三新包进复合、ui-cordis 忽略）。
- 2026-xx-xx：执行期修正——D3 READY 门**回退**(await 边界破坏同步 configureContext 契约,test:client-web 暴露);D5 deep-source 回退为**本地复制**(vendor ui-workspace 源码不兼容 chamber tsconfig,root typecheck 暴露);connection/api-gateway check 配置对齐上游(eoPT=true + subpath paths)。

## 11. 执行状态跟踪表

| 工作包 | 内容 | 状态 |
|---|---|---|
| WP1 | dsh-client-connection 副本迁移 | ✅ 完成(rebase+补丁重打,单测20过) |
| WP2 | dsh-client-web 副本迁移 | ✅ 完成(platform/seed+store,自检清零) |
| WP3 | dsh-api-gateway fork(D1 方案 A) | ✅ 完成(fork+basePath补丁,tsc 0诊断) |
| WP4 | 六个 chamber 客户端插件迁移 | ✅ 完成(6插件+git直改,全部测试过) |
| WP5 | renderer 复合层 | ✅ 完成(9文件,126测试过) |
| WP6 | control-plane 探针 | ✅ 完成(15文件,含健康探针P0-3) |
| WP7 | dsh-runtime 探针 | ✅ 完成(7探针,335测试过) |
| WP8 | desktop 探针 | ✅ 完成(229测试过,兄弟checkout验证) |
| WP9 | gateway wire | ✅ 完成(降级轮询已记录) |
| WP10 | proxy-forward | ✅ 完成(WS_STREAM_PATHS) |
| WP11 | 版本常量 | ✅ 完成(FORK_VERSION+副本版本) |
| WP12 | pin bump 与锁文件 | ✅ 完成(pin=cd5ef81,259链接,frozen稳定,importer手工处理) |
| WP13 | 全量验证 | ✅ 完成(14 typecheck + 16 测试套件 + build:renderer + verify:i18n + build:preload + frozen install 全绿;round3-7 修复后多次复跑确认) |
| WP14 | review-fix loop(独立 subagent,直至无错误) | ✅ **收口(round8/9 全新审查:9-A/9-C 判定 0 错误、9-B 无 P0/P1;8-A P1 经上游链驳斥已登记证据;全部 P2 修复/登记)**。round3-9 历程:3-C P0 BrowserAuth 门禁适配、7-B P1 combo URL 尾斜杠、令牌全日志面脱敏(含 LAN/跨 chunk)、流帧双上限(队列+字节+标量)、双线门禁、D2 芯片、cookie 全生命周期清理;已知偏差 ①-⑭ 与驳斥证据见 plan §7.5-§7.6 |
| WP15 | 最终结果报告 + 文档归档(checklist §7) | 🕓 报告已交付;文档归档(STATUS/CHANGELOG/design 版本引用)待合入前统一;运行时线 npm 发布为外部阻塞 |

> 迁移设计与执行方案见 `docs/tmp-dsh-v012-migration-plan.md`。
>
> **round8 结论补录位(结构准备)**:三路独立审查报告返回后,主代理在 WP14 行追加:各审查员结论(0 错误/剩余 P2 清单)、修复动作、最终收口判定。
