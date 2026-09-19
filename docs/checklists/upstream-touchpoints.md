# 上游触点登记与保鲜（upstream touchpoints）

> 面向维护者：登记 dsh-chamber 对上游 dsh（deepseek-harness）的**全部接触面**——fork 副本逐文件
> 纯度、深引 vendor 内部、契约镜像、covered/assembly 行、生成物——并给出每次升级 tag 后的保鲜闭环。
> 机器侧门 = `scripts/upstream/verify-upstream-touchpoints.mjs`（C1–C15：C11–C14 插件受保护集合门、C15 悬停卡移植退役门；CI 两条腿在 Bootstrap 后 pre-install 跑
> `--no-artifact-rebuild`（C1/C3–C15，C8 advisory）、post-install 跑完整门（C8 重建-比对硬失败）；C2 本地 advisory）；
> **单一来源 = `scripts/upstream/registry.json`**（机械事实：路径 / 分类 / 判据 id / 偏差 id / 一句话原因）。
> 本文件 §2/§9 的表格是它的生成视图（`<!-- GENERATED:registry:… -->` 块，**禁止手改**；重生成
> `node scripts/upstream/registry-views.mjs --write`，保鲜门 `node scripts/upstream/verify-registry.mjs`）；
> `verify-upstream-touchpoints.mjs` 启动即读同一份 registry，脚本内不再有第二份登记表。
> 基准值不在本表：源码线 pin 的单一来源是 `harness.commit`（== submodule gitlink），运行时锚的
> 单一来源是 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `@deepseek-ai/dsh` specifier，
> fork 版本以各 fork `package.json` 为准（对拍门 = C5/C10）。本表只登记**结构性触点与判据**；
> 每次重锚按 §7 循环复核结构，逐 tag 的升级叙述写 `CHANGELOG.md` 发布节与 git 历史。

## 0. 结构速查（只登记结构与判据，不记录版本值）

> 机器可读的登记表在 `scripts/upstream/registry.json`（§2/§9 的表格由它生成）；本节速查值（链接数、
> 契约数、covered/factory 计数）仍是手写散文，以 §6 的门与源码为准。

| 项 | 值 / 判据 |
|---|---|
| vendor 链接数 | 由 `ensure-harness-vendor` 断言 == 锁文件 importer 集合——**源码线**，不是 F |
| 运行时线族集合（F） | `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包里的 `@deepseek-ai/*` 名字集合（C11 硬门）：含核心 `dsh`/`dsh-base`/`dsh-web-app`，**不含** `dsh-experimental-*`（官方 opt-in 层必须可装）与 dev/test 包；本行与上一行是**两条线**，数量相近但集合不同，不可互推 |
| typert remote 装配契约 | 15（C4；+command-feedback/+workspace-files） |
| covered / factory | `chamber-covered.ts` 的两个集合（factory ⊆ covered，chamber-entry 锁步断言；含 `ui-dockkit`、`client-file-upload` 的 covered factory 与 `session-log-export`（deferred）、两个 page-own 跳过 id） |
| 种子域 | `clientGraph/graph`、`gitWorktree/previewCreate`、`archiveCleanup/probe`、`openInApp/probe`（C7 双门） |

## 1. 标记约定（每文件分类）

| 标记 | 含义 | 机器校验 |
|---|---|---|
| [pure] | 与上游锚**逐字节一致** | C1：不一致即硬失败（除非登记 [patch-*]） |
| [patch-add] | 补丁仅**追加**（如 package.json 追加脚本），上游内容原样保留 | C3（放行差异） |
| [patch-mod] | **修改**上游内容（chamber 语义面） | C3（放行差异） |
| [patch-comment] | 仅**注释级**差异（chamber 说明/rebase 日志） | C3（放行差异） |
| [own-divergent] | 结构/内容 chamber 自有、仅**跟踪上游增量**（tsconfig 构面、base.css） | C3（放行差异） |
| [own] | chamber 自有文件/目录（上游无对应物） | C3：漏登记即硬失败 |
| [dropped] | 上游文件**有意不镜像**（host 半/tests/tsdown/README…） | C3：漏登记即硬失败 |

锚 = fork `package.json` version + `harness.commit`（两者同时漂移才算跟随；任一过期 C5 硬失败）。

### 1.5 权威梯度与冲突裁决（registry `authority` 字段引用本节）

| 权威 | 含义 | 冲突时的裁决 |
|---|---|---|
| `upstream` | pin 住的上游实现/形状是权威，我方只允许登记在案的补丁（`classify.patched`/`own`/`dropped`） | 上游变 ⇒ 我方跟随（重放或改登记），禁止反向解释；C1/C3/C5 硬失败兜底 |
| `chamber` | chamber 自持：上游无对应物，或官方注册被 chamber fork 替换（design 20 §2.2 fork & supersede） | 只以本仓源码为准；上游同域变化先裁决是否退役/再登记，未裁决不得静默跟随 |

> 其它裁决规则（沿用既有口径）：版本值只认 `harness.commit` / 运行时锁文件 / 各 fork `package.json`，
> 本表与生成块都不记录版本值；`status: accepted` 必须带 `rationale`（理由随条目走）。
> 符号锚（`registry.entries[].symbols`）写作 `path#symbol`（退化 `path#=literal:<唯一子串>`），
> path 先按该条目的 `ours` 解析、再退回仓库根；解析门 = `node scripts/upstream/check-anchors.mjs`。

## 2. fork-mirror 登记（逐 fork）

### 2.1 `packages/dsh-client-connection`（上游 `packages/client/connection`）

pure **16**：`src/http-bridge.ts`、`src/rpc.ts`、`src/rpc-host.ts`、`src/rpc-schema.ts`、
`src/loopback-hostname.ts`、`src/index.ts`、`src/recovery-config.ts`、`src/browser-auth.ts`、
`src/client/api.ts`、`src/client/fixture.ts`、`src/client/random-uuid.ts`、`README.md`、
`README.zh.md`、`README.i18n.yaml`（+client 构面未列出的小项以脚本计数为准）。


<!-- GENERATED:registry:touchpoints.fork-mirror.connection:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-add] | 仅追加 chamber test 脚本（其余与上游一致；版本行随上游推进） |
| `src/api-path.ts` | [patch-mod] | 追加 resolveInstanceBasePath + 头部 chamber 说明（basePath 语义，design 05 §6） |
| `src/client/connection.ts` | [patch-mod] | 仅 erasableSyntaxOnly 显式字段改写（两个构造参数属性）+ 顶部 chamber 说明；其余逐字节上游（Batch 2 重锚：loopEpoch 守卫与 CONNECTION_BACKOFF_MAX_MS 导出退役，改由原生 reconnect/setNetworkAvailable） |
| `src/client/index.ts` | [patch-mod] | apply(ctx) 读 ctx.chamberBasePath → 载波装配（design 05 §6）+ SYSTEM_RESUME_EVENT/liveness 触发（design 14 D4）+ recovery-policy 转出（/client barrel）+ 头部 chamber 说明 |
| `src/client/rpc.ts` | [patch-mod] | basePath 前缀拼装 + WebConnectionRpcOptions（chamber 选项对象）+ 头部 chamber 说明 |
| `tsconfig.client.json` | [patch-mod] | chamber 构面：extends ../../tsconfig.json + vendor paths + files 列表（与上游 files 增量同步维护） |
| `tsconfig.host.json` | [patch-mod] | 同上（host 构面） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `tsconfig.check-base.json` | [own] | chamber erasable-only 校验构面 |
| `tsconfig.check-client.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `tsconfig.check-host.json` | [own] | chamber erasable-only 校验构面（files 与 host 同步） |
| `src/client/carrier-assembly.ts` | [own] | chamber 载波装配纯策略（basePath 扇出） |
| `src/client/liveness-triggers.ts` | [own] | chamber sleep/wake 活性触发（design 14；原生 reconnect + 离线门 + 唤醒事件旁路） |
| `src/client/recovery-policy.ts` | [own] | chamber 每来源恢复时序策略（远端 45s/5s，本地保持上游默认） |
| `test/` | [own] | chamber 自有测试（api-path/carrier-assembly/liveness-triggers/client-apply + fixtures（含 schemastery/fixture/recovery-config 桩 loader）） |
| `tests/` | [dropped] | chamber 无 tsdown / 不镜像上游测试 |
| `tsdown.config.ts` | [dropped] | chamber 无 tsdown / 不镜像上游测试 |
<!-- GENERATED:registry:touchpoints.fork-mirror.connection:end -->

### 2.2 `packages/dsh-client-web`（上游 `packages/client/web`）

pure **5**：`src/base.css`（Batch 2 恢复逐字节一致——chamber token 表改由 renderer 入口
CSS `packages/renderer/src/styles.css` 引入）+ client 构面未列出的小项（以脚本计数为准）。

<!-- GENERATED:registry:touchpoints.fork-mirror.client-web:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.i18n.yaml` | [own-divergent] | chamber README 对的哈希记录 |
| `README.md` | [own-divergent] | chamber 说明（boot kernel 差异/维护约定），非上游镜像 |
| `README.zh.md` | [own-divergent] | 同 README.md（中文镜像） |
| `package.json` | [patch-mod] | 描述/测试脚本/deps·peerDeps·files 面差异（版本行随上游推进） |
| `src/boot.ts` | [patch-mod] | N-ctx boot kernel（extraRows / __ModuleLoader__ / configureContext / 异步 dispose） |
| `src/index.ts` | [patch-mod] | 入口差异（module-system 宿主接线） |
| `src/platform.ts` | [patch-mod] | PLATFORM_MODULES/静态表 chamber 接线（C3 偏差：ui-primitives 不 seed） |
| `src/seed.ts` | [patch-mod] | seed 行 chamber 接线（extraRows/__ModuleLoader__；C3 偏差同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths/检查面） |
| `src/boot-rows.ts` | [own] | chamber 每实例 boot-rows（design 09 module D） |
| `src/boot-tolerance.ts` | [own] | chamber boot 容忍/恢复（design 09） |
| `test/` | [own] | chamber 自有测试（boot-tolerance/boot-rows/configure-context + fixtures） |
| `tests/` | [dropped] | 上游文件有意不镜像 |
| `tsdown.config.ts` | [dropped] | 上游文件有意不镜像 |
<!-- GENERATED:registry:touchpoints.fork-mirror.client-web:end -->

### 2.3 `packages/dsh-api-gateway`（上游 `packages/api/gateway`，client 半）

pure **5**（以脚本计数为准）。

<!-- GENERATED:registry:touchpoints.fork-mirror.api-gateway:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | description/peer 集裁剪（host 依赖 dropped）+ chamber test 脚本 + 版本行随上游推进 |
| `src/client/index.ts` | [patch-mod] | apply(ctx) 读 ctx.chamberBasePath → /api/remote.mux 落到实例前缀 + start(sinks, recoveryOverridesForTransport(transport))（design 05 §6）+ $stream 工厂组合 carrierFailed 发布 dsh-chamber:stream-carrier-failed 页面事实（design 14 §D4） |
| `src/client/remote-stream.ts` | [patch-mod] | 载波重试策略：活连接世代下的后续载波失败改走有界退避重开，不再逃逸为终局 gateway/internal（design 14 §D4；退避纯函数在同包 own 文件 remote-retry-policy.ts，patch 形状由 test/patch-lock 钉住） |
| `src/client/stream-client.ts` | [patch-mod] | per-entry basePath（流载波 URL 拼装） |
| `tsconfig.client.json` | [patch-mod] | chamber client 构面（files 表随新增 client 文件同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（files 表随新增 client 文件同步） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `src/client/remote-retry-policy.ts` | [own] | chamber 载波退避纯函数 + 可中止等待（零 import，可脱离 vendor 图行为单测） |
| `src/client/stream-carrier-fact.ts` | [own] | chamber 载波故障页面事实（有界计数 + dsh-chamber:stream-carrier-failed；零 import，可注入 dispatch 单测） |
| `tsconfig.check-base.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `tsconfig.check-client.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `test/` | [own] | chamber 自有测试（退避真值表 + 可中止等待 + 载波事实契约 + patch 源文本锁） |
| `README.i18n.yaml` | [dropped] | 上游 README 不携带（fork 描述在 package.json） |
| `README.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json） |
| `README.zh.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json） |
| `src/index.ts` | [dropped] | 上游 host 插件入口（chamber 不镜像 host 半） |
| `src/stream-server.ts` | [dropped] | 上游 host 半流服务器（dropped） |
| `src/types.ts` | [dropped] | 上游 host/aux 类型文件（exports 保留 inert ./types 子路径） |
| `tests/` | [dropped] | 上游文件有意不镜像 |
| `tsconfig.host.json` | [dropped] | host 构面不镜像 |
| `tsdown.config.ts` | [dropped] | 上游文件有意不镜像 |
<!-- GENERATED:registry:touchpoints.fork-mirror.api-gateway:end -->

### 2.4 有意未镜像表（跨 fork 汇总）

host 插件入口/半、上游 `tests/`、`tsdown.config.ts`、上游 README（api-gateway）、构建产物
`lib/` 一律不镜像。本表**不记录逐 tag 的升级叙述**（那属于 `CHANGELOG.md` 发布节与 git 历史）；
升级时按下列**判据**裁决，判据本身随重锚复核：

- **fork 面**：上游 counterpart 的 `src/` 有改动 ⇒ 逐文件重放并更新 §2.1–§2.3 的分类与原因；
  只有 `package.json` 版本行变化 ⇒ 仅同步版本标记（C5 对拍）。
- **上游 workspace 成员增删**：vendor 链接集合与根 `pnpm-lock.yaml` 随之变化；新增成员按 §5
  裁决是否属再生物，删除成员须确认 `restore-lockfile-vendor-records.mjs` 的守卫已跳过该记录
  （见 `dsh-upgrade-checklist.md` §4）。
- **「首屏依赖 extra row 服务」触点（结构性，与 tag 无关）**：composite 首屏插件的 cordis
  `inject` 若由**未覆盖**的 extra row 提供，该行不挂载时首屏永远 PENDING。探针集合**完全派生**——`chamber-entry.ts` 的 `register(id, plugin)` 与
  `registerDeferred` 记录每个（首屏与延迟）命名空间导出的 `inject` 面，
  `injectedServices`/`missingInjectedServices`（`required-extra-rows.ts`）取并集后探测
  （上游同 fact：`Object.keys(entry.fiber.inject)`）。上游改 inject 面**无需登记名字**；
  唯一派生面看不见的漂移（命名空间不再导出 `inject`）由
  `packages/renderer/test/lifecycle/required-extra-rows.test.ts` 的逐 id 表钉住。
- **平台词偏离的跨代耦合（后果登记于 `docs/progress/STATUS.md`）**：`ui-primitives` 不 seed、
  由 covered factory 回答（C3 偏差）；实例侧 `ui-sidebar-documentpreview` 的代码预览**行为上
  依赖**与 composite 同代的 `ui-primitives`（`CodeBlock` 的 `contentRef` 与
  `[data-code-block-content]` 是其唯一滚动/行定位锚点）。composite 比实例旧一代时该行失去
  独立滚动区与行定位（纯文本仍可用）——版本歪斜把这条体积优化变成可见功能面。
- **平台词 vs host-graph 行**：`client/web` 的平台词表（`platform.ts`/`seed.ts`）与 host-graph
  行是互斥裁决——把行当平台词 seed 会让启动失败（C3 不变量）；上游新增平台词时先裁决归属。
  宿主半的 `webServer` 可选注入会影响 connection 宿主半的重放，须逐面复核。

### 2.5 `packages/dsh-chamber-seed-open-in`（上游 `packages/host/open-in-app`）

> chamber-named fork（design 20 §6，fork & supersede）：不覆盖上游包名，随 chamber 版本发布
> （`versionAnchor: chamber`，C5 版本等值豁免）；上游 `packages/host/open-in-app` 保留在 vendor
> 树作 C1 锚，因此**不**进 `EXCLUDED_UPSTREAM_DIRS`。分类表由 registry 生成：

<!-- GENERATED:registry:touchpoints.fork-mirror.seed-open-in:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | chamber seed package（自有名字/版本/构建入口；upstream 名与发布面不复制） |
| `src/index.ts` | [patch-mod] | typert 门面取代 webServer 路由 + Config schema + SSH 休眠门（design 20 §6.1） |
| `src/shared.ts` | [patch-mod] | wire 契约家：上游三条 webServer 路由常量 → typert Remote 方法名 + 域载体（design 20 §4.1/§6.1） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths + 本包 files） |
| `dist/index.js` | [own] | chamber 提交态产物（C8 逐字节重建-比对；上游无对应文件） |
| `scripts/build.mjs` | [own] | chamber esbuild 产物构建 |
| `src/core.ts` | [own] | chamber 域核心：上游 apply() 的目录/图标/拉起状态机（去掉路由与 SSH 门） |
| `test/` | [own] | chamber 自有测试（域契约 + 载荷拒绝矩阵 + vendor stub loader） |
| `README.i18n.yaml` | [dropped] | 上游 README 不携带（fork 描述在 package.json/源码首页） |
| `README.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json/源码首页） |
| `README.zh.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json/源码首页） |
| `src/internals.ts` | [dropped] | 上游测试接缝（本包的接缝走 OpenInAppCore 构造注入，不需要它） |
| `tests/` | [dropped] | 上游测试不镜像（本包 test/ 覆盖域契约） |
| `tsdown.config.ts` | [dropped] | 上游打包配置（本包走 scripts/build.mjs） |
<!-- GENERATED:registry:touchpoints.fork-mirror.seed-open-in:end -->

## 3. deep-import 与 roster 登记

- renderer 深引 vendor：`@deepseek-ai/*` 一律经 vite workspace→src 别名与 `paths`；node 测试经桩 loader
  （`scripts/dev/test-connection-loader.mjs` 等）——**不新增裸运行时 vendor 依赖**。
- covered/factory：`packages/renderer/src/chamber-covered.ts` 的 `CHAMBER_COVERED_IDS` /
  `CHAMBER_COVERED_FACTORY_IDS`（chamber-entry 执行期断言 map == 列表）；新增官方 client 行必须先裁决
  （消费 / 镜像 / 替换）再登记 covered，删包 fail-loud 哨兵在 C4。
- typert remote 装配：契约 == **15**（集合与顺序，gen-typert-remotes 与 C4 双向断言）；上游新增 remote 包
  = 先裁决是否 chamber 消费/镜像再登记；装配契约唯一入口 `remotePackagesFromAssembly`
  （`renderer/scripts/typert-remote-contract.mjs`）。
- **版本锚与「活」版本字面量（门 = C10）**：dsh 运行时版本的单一来源 = **已提交**的
  `packages/desktop/vendor/dsh/pnpm-lock.yaml`（同目录 `package.json` 被 gitignore，仅本地存在时交叉校验）；
  六个运行时线锚（`bundle-dsh.mjs` 兜底、vendor 锁文件、`release.yml` env、`install-gateway.sh`、
  gateway `dshAnchorVersion`、`release-preflight` `FORK_VERSION`）与三个 fork 副本必须等于它。
  生产源码/脚本/配置（非注释、非夹具、非产物）里不得出现其他 dsh 版本字面量，历史叙述只留注释；
  确有语义的具名常量（如 `HOST_IDENTITY_METHOD_SINCE`）按「上限 1 处 + 理由」登记白名单。
  扫描面排除 `*/test/**` 的合成版本与**本地派生状态**——后者由 `.gitignore` 本身判定
  （`git ls-files --others --ignored --exclude-per-directory=.gitignore --directory`；**不用**
  `--exclude-standard`，它会把 `core.excludesFile` 带进来，让本地少扫、CI 多扫）；唯一例外是被忽略
  却必须扫的 `vendor/dsh/package.json`。
- **vendor 源码补丁集（构建期改写，design 09 §3.6）**：`packages/renderer/scripts/vendor-patches.mjs` 登记两类补丁，
  由 renderer 的 `deepseekSource().transform` 在构建期按**精确上游文本**改写，vendor 文件零写入。
  ① 同源绝对 URL 类（N-ctx 壳必须改写）：`ui-chat` 的 `/api/file`、`client-file-upload`、
  `ui-deliverables` 的 `/api/present.host|open`、`session-log-export` 的 `/api/session.export`；
  一律经 `ctx.get('chamberBasePath')` 读取并保留「缺 base path → 回落上游」的形状（cordis 代理对未 provide
  的服务是抛错而非 undefined），相关包按 covered / covered-deferred 登记。
  ② **实测帧成本类**（正确性优先）：`ui-chat` 的 CSS-module 行 sweep、`ui-conversation` 的三层 rAF 发布链
  ——条目必须把 A/B 实测写进 `reason`（同一 Electron/显示器、`app.getAppMetrics` 累积差）。
  门：**C9**（锚点唯一命中）+ `vendor-patches.test.mjs`（锚点/行为/id 形态）。新增补丁前先问
  「能否在 chamber 自己的包里修」；性能类还须先证明成本是**每帧**的、且 chamber 侧门控覆盖不到它。
- **复合首屏 ← 未覆盖官方行（反向依赖，集合为派生）**：`ui-chat` ← `sidebarRight`（`ui-sidebar-right` 行提供）；
  集合由 `packages/renderer/src/chamber-entry.ts` 的 `register(id, plugin)` 记录、经
  `required-extra-rows.ts` 取并集，**不手写**；`client-file-upload` 为 covered（消除 extra row 依赖，也让
  构建期补丁能覆盖它的同源绝对 URL），`resources`（渲染期 `useResource` 座，非 inject）不成立。
  + `packages/renderer/src/required-extra-rows.ts` 的
  `registeredInjectMembers`/`injectedServices`/`missingInjectedServices`
  + `required-extra-rows.test.ts`；集合本身**派生**、不手写。上游新增/改名首屏 inject 成员时，
  两侧（`host-graph.ts` 降级注释 + 本行）按 design 09 §3.2 复核即可——探针自动覆盖
  新的未覆盖 provider。
- `remotePackagesFromAssembly`（renderer/scripts/typert-remote-contract.mjs）为装配契约唯一入口。

## 4. contract-mirror 登记（按上游属主分组）

> 逐行的「怎么判」在各自脚本/测试头注里；本表只写**契约镜像点 + 保鲜门 + 完整细节在哪**。

| 上游属主 | chamber 契约镜像点 | 保鲜 |
|---|---|---|
| dsh-api-remotes（client） | typert remote 装配（15）与 message-feedback / session-reference / subagent 等 wire 面 | `gen-typert-remotes` + C4（集合与顺序双向断言） |
| dsh-api-session-controller | api-gateway fork 的 journal-stream 帧（无游标 notification）：帧词表与帧形状都在 `packages/dsh-api-gateway/src/stream-protocol.ts`（纯文件集内） | 形状 = C1 逐字节；**行为 = 升级时人工重放一次 journal-stream 通路**（C1 只证形状未变） |
| client/connection（recovery） | recovery-config 共享 schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` == schema 默认 `backoffMaxMs`） | liveness-triggers 钉值 + C1 |
| dsh-api-session-controller（客户端半的会话事实语义；**人工登记，无 C 编号门**） | L1 回执必须自带独立权威判定（`verify` seam），押在三条上游事实上：① `sessions.refresh()` → `refreshList()` 单飞并把权威 summary 的 running 回灌已物化会话；② `api-session/status` 是 `mode:'emit'` 转发事件（无重传/无 ack）；③ `session.list` 拉取失败（`result.ok===false`）时 `refreshList()` 照常 resolve、只置 `listState='error'`（非 remote 异常仍 reject）。对话流健康臂另押三条（`followCurrent()` 仅在 `current !== watched` 时 open、`Session.open()` 在 open/在途 promise 上短路、`failEventStream()` 锁 `openState='error'` 并清 promise） | `test/session-state/session-fact-reconcile.test.ts`（语义锁）+ open-in 包 `test/session-health/vendor-heal-contract.test.ts`（读 vendor 源逐条钉住）。**残**：三条会话事实无读 vendor 源的 lockstep 测试，上游改语义会 fail-open——已登记 `STATUS.md`；升级 tag 时人工复验这三条（design 14 §D4） |
| dsh-runtime（激活探针域） | `HOST_DOMAIN_PROBE_NAMES` ↔ gateway `HOST_PACKAGE_PROBE_DOMAINS` | C7 + gateway 运行时 fail-loud |
| interaction/commands（`commands/execute` 第三参数） | 激活探针载荷键名 == 上游 `execute(agent, line, submittedAttachments, signal)` 的参数名（历代皆 `submittedAttachments`；`attachments` 从不是上游线名） | `runtime-probes.test.ts`：读 vendor 签名逐字比对 + 夹具按真实 typert gateway 校验参数键集 |
| `@deepseek-ai/dsh-client-ui-sidebar-right` / `-ui-layout` / `-ui-dockkit` / `-ui-conversation`（**移动插件锚点面**，打包 fork 侧） | 锚点集（设计 17 §18.4.3）：右栏 `[data-sidebar-right-panel]`（`push\|fullscreen`；**不得**用 `data-rightbar-collapsed` 当「已展开」）、抽屉让位的两条臂、dockkit 条 `[data-dockkit-strip]` 与其 chips、会话头 `role="tablist"` 条、slot 出口 `display:contents` | `packages/dsh-chamber-client-ui-mobile/README.md`「Anchor baseline」+ `test/visual/breakpoints.test.ts` 逐条钉住；升级 pin 时按 §7 重锚。mobile 不在 registry 分类条目内（C1/C3/C5 不适用），产物陈旧由 C8 盯 |
| `@deepseek-ai/dsh-client-ui-{layout,sidebar,sidebar-right,conversation,chat,dockkit}` + `ui-primitives`（**上游发射侧**，与上一行同一批 DOM 契约） | 插件声明的锚点必须**上游真在发射**：attribute / role / slot 三层都要写入形，只有消费形不足以判定 | `scripts/upstream/verify-mobile-anchors.mjs`（纯判据 `mobile-anchors.mjs`、负例 `verify-mobile-anchors.test.mjs`）做双向差集；语料 = 锚点根下 `node_modules/@deepseek-ai/**` 的全部 `.js/.mjs/.cjs` + shell 产物（`dsh-web-frontend/dist/assets`，`.js.map` 不算）；根按 `--anchor-root` → `DSH_MOBILE_ANCHOR_ROOT` → 本机 gateway → `packages/desktop/vendor/dsh` 取。**根缺失 / 无 client 产物 = fail-soft 跳过 exit 0**；`--require-anchor-root` 把「其实什么都没查」的四条路径全部改判 exit 1（与 `--simulate-rename` 互斥）。**升级流程 §7 必须带严格模式跑**（CI 无上游树，只能 fail-soft）。**只判锚点、不判几何**——几何断言在 `scripts/gui-acceptance/mobile-walkthrough.mjs`，两者合起来才是 design 17 §18.6。**最小断言集（19 项）必须既在源码侧声明、又在产物侧发射**：`data-slot="root"`、三列 key `sidebar`/`main`/`rightbar`、`shell.overlay`、`data-conversation-scroll`、`data-composer-seat`、`data-composer-input`、`data-chat-flow`、`data-chat-anchor-key`、`data-phase`、会话头 `conversation.session.header` 及其 `actions`/`utilities`/`corner`/`lineage` 四座、`data-sidebar-collapsed`/`data-rightbar-collapsed`、`data-sidebar-right-panel`；强度规则（写入形 vs 消费形）与语料/根解析细节见脚本头注 |
| dsh-host-webserver（index-inject） | `__DSH_CONNECTION_RECOVERY__` 全局注入（connection host 半） | fork C1（`src/index.ts` pure） |
| dsh-host-open-in-app + dsh-client-ui-open-in-app（官方两份） | **chamber fork**（设计 20 §2.2/§6）：宿主半 `packages/dsh-chamber-seed-open-in/`（`src/{catalog,resolver,icons}.ts` pure、`src/{shared,index}.ts` patched、其余 own/dropped），客户端半 `packages/dsh-chamber-client-ui-open-in/` 自有 wire 镜像与 `app.*` 标签表；官方两份都不加载（client 行 page-own 跳过、host 行挂载但无调用方） | registry `seed.*` 条目（`versionAnchor: 'chamber'`，分类表见 §2.5）：C1 / C3 / C5（版本锚豁免）；有意分歧逐条写在 `patched`/`dropped` 原因里，跨半契约由客户端 `test/wire-protocol/open-in-wire-lockstep.test.ts` 钉住 |
| dsh-client-ui-primitives（`HoverCard`/`pointer-grace`；vendor seam，非 fork） | **侧栏行卡片自持移植**（design 06 §7）：`RowHoverCard.tsx` + `src/shared/hover-intent.ts` 取代 vendor 原子（vendor 宽限关闭以**已提交的 `open`** 判定，leave 落在 dwell→commit 窗口即残留）；相对上游等价 + 有意增量（页面级单卡、blur/hidden 关闭、两轴定位、关闭路径 copyEpoch）见 design 06 §7 与 `STATUS.md` 偏差条 | **C15（硬失败）**：在冻结 pin 上断言 ① CLOSE 侧竞态形状仍在（`onPointerLeave` 的每个 arm 都由已提交 `open` 守卫）①b OPEN 侧 dwell 回调无指针在场复查、定时器唯一可定位 ② 时间常数逐值锁步（`POINTER_GRACE_MS` / `openDelayMs`）。**退役条件 = 上游修掉该竞态**，任一断言不成立即红并逼出裁决。防伪：去注释 + 去字符串投影、组件体内逐调用点、常数取值唯一；单测随 `test:upgrade-tools`，端到端走查 `W-4b` |
| `@deepseek-ai/dsh-client-locale` + `dsh-client-ui-settings`（**页面语言归属**，design 06 §4.6） | `packages/renderer/src/locale-ownership.ts` 只依赖四条 vendor 事实：① locale 服务名 `locale` 与 `slots.installLocale` 面；② `LOCALE_SETTINGS_NAMESPACE = 'locale'` 与 `settingsScope.bind({ namespace })` 形状；③ `locale.subscribe(sync)` **先于** apply 里紧随的立即 `sync()`；④ 每 namespace scope 的 `status: persistence === 'host' ? 'loading' : 'unavailable'` 与 `derive → ready/unavailable`（settled 判据 = `status !== 'loading'`） | 四条事实**无自动化锁步** ⇒ pin 升级时**人工复审**（③ 漂移削弱同栈回写，④ 漂移让闪烁问题复活） |
## 5. 再生物登记

| 再生物 | 源 | 提交纪律 |
|---|---|---|
| renderer typert 工件（gen-typert-remotes 输出） | vendor typert/remote 源码 | **构建期生成、`.gitignore` 忽略，不提交**（`renderer/src/generated/`；升级后由 `build:renderer` 重生成） |
| host dist ×4（`dist/index.js`，含 seed-open-in）+ `dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/index.js`/`lib/client.js`(+map) | chamber host 包 src / dsh-runtime src / mobile src | `build:host-packages` / `build:dsh-runtime` / mobile `build` 后提交（C8 共 6 组）。C8 **重建-比对硬失败**盯陈旧（mobile 产物由 gateway 逐字节 seed，陈旧即线上锚点失效）；两个 build 脚本都带 `absWorkingDir`，产物与调用者 CWD 无关 |
| boot manifest / perf-sizes | build:renderer | 构建产物 diff 随批审查 |
| schemastery 桩 loader（connection/web 测试） | vendor source-only 现实 | 新增 vendor 运行时导入面时同步补桩 |

## 6. 保鲜自动化

`node scripts/upstream/verify-upstream-touchpoints.mjs`（除 C8 在**正常路径**下「重建-比对后原样还原」外只读；中断/并发/额外产物路径由整目录快照 + SIGINT/SIGTERM 处理器 + `wx` 独占锁兜底）：
- **registry 单一来源与两道门**：`registry.json` 是触点登记的唯一机器来源（生成视图与
  verifier 都读它）；三道命令：
  - `node scripts/upstream/registry-views.mjs --check|--write`：生成物保鲜（本表 §2/§9 的 GENERATED 块）；
    手改生成块 ⇒ `verify-registry` 红。
  - `node scripts/upstream/verify-registry.mjs`：schema / canonical / 引用存在性 / deviations id /
    覆盖面网（§2.x 标题 ↔ 条目、`chamberNamedForks` ↔ `versionAnchor: chamber`、
    `excludedUpstreamDirs` ↔ `ensure-harness-vendor` 的 EXCLUDED）/ 生成块字节一致。
  - `node scripts/upstream/check-anchors.mjs`：registry 符号锚可解析 + 遗留 `文件:行` 锚预算棘轮
    （`anchors-budget.json`，**只降不升**）；`--report` 出漂移与测试面三分类，
    `--fix --file <md> [--apply]` 只回写「同行唯一可解析符号」的锚点、拒绝生成块。
- **参数守卫与退出码（措辞与脚本头注同源）**：默认模式会**就地重建并还原**提交态生成物（唯一写盘路径），因此任何未知参数/位置参数都由 `verify-upstream-touchpoints-args.mjs` 判为用法错误——`--help`/`-h` = 打印权威用法文本、**exit 0，不跑任何门、不写盘**；未知参数（如拼错的 `--no-artifact-rebuid`）、位置参数、重复 flag 或 `--tags` 缺值 = **exit 2（用法错误）且不先跑门**；门硬失败 = exit 1；全部通过 = exit 0。一个拼错的 flag 以前会被静默忽略并照跑全量写盘门，故这里是响亮失败而非容错。判定逻辑是纯函数（单测 `verify-upstream-touchpoints-args.test.mjs`）。
- C1 pure 字节恒等 / C3 完整性（fork 每文件分类、上游每文件裁决，漏 = 硬失败）/
  C5 过期锚扫描 / C6 EXCLUDED 存在性 —— **CI 在 Bootstrap 后 fail-loud**；
- C4 roster（covered/factory 哨兵 + remote 契约 15 的集合与顺序）—— 本地/CI 均可；
- C7 种子域锁步、C8 **提交态生成物 == src**（重建-比对，硬失败；写后原样还原，`--no-artifact-rebuild` 退回 mtime advisory）、C9 **vendor 补丁锚唯一命中**（硬失败）、C10 **版本锚一致性 + 活版本字面量白名单**（硬失败：运行时版本单一来源 = **已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`，见 §3；同目录 `package.json` 被 gitignore、属派生本地状态，仅本地存在时与锁文件交叉校验；六锚 + 3 fork 必须等于该锁文件；生产源码/脚本/配置里出现未登记的「活」版本字面量即红——历史叙述只能留在注释里，具名诊断常量按上限 1 处白名单登记）—— CI 与本地均跑（CI 分 pre/post-install 两段）。
- C11–C14 **受保护集合与代耦合**（硬失败，只读，CI 两段都跑；判据纯函数在 `plugin-protection-gate.mjs`，负例测试随 `pnpm run test:upgrade-tools`）：
  C11 **运行时线族集合**——受保护集合的 F 分量只认**已提交**的运行时锁文件闭包（含核心、不含官方 opt-in `dsh-experimental-*` 与 dev/test 包；实例树物化时另做等价性交叉校验，允许差集 = 其他平台 `node-addon-system-*`）；同一闭包也是 design 21 §6.11 装后复验所用 **name→version 事实**的来源，但本门判据**只判名字集**（名字集合语义不变，版本事实不进门禁）；
  C12 **profile 契约锚**——上游源码仍以 `dsh.profile.bundles` 承载层列表、以 `dsh.bundle.patch` 声明层、web 模板默认组合不变、profile workspace 仍是 `nodeLinker: hoisted` + `autoInstallPeers: false`；**两个锚点文件（`packages/boot/app-boot/src/profile.ts` 与 `apps/cli/src/plugin.ts`）都必须可读**——树已部分物化时缺文件 = 改名/搬移（违规），只有整体未物化才降级为 note；
  C13 **播种注册表结构**——`HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一一对应；
  C14 **manifest 三方镜像 + rows 行类型**——`plugin-sync.ts`（producer）↔ `preload.cts` ↔ `renderer/src/global.d.ts` 字段集一致，**且** `rows` 的**元素类型**三方一致（control-plane `PluginRow` ↔ preload/renderer `PluginRowProjection`：字段名 + `role`/`owner` 字面量并集；可选标记 `?` 不属于字段名；producer 以**命名类型别名**（`role: PluginRowRole`）声明时在同源内解析成字面量并集一起比较；任一侧声明了该字段却读不出并集 ⇒ **按违规处理**，绝不静默只比剩下两方。负例覆盖"任一 wire 侧删/收窄 `owner`/`role` 并集、producer 别名增/删值、行字段漂移、producer 换成不透明类型"；ipc-surface-mirror 只覆盖宿主接口的后两者）。
  任一红 = 停升级、改派生（B₀ 快照 / F 来源 / S 注册表 / wire 镜像），**绝不放行**——design 21 §6.11。
- C15 **悬停卡自持移植的上游退役门**（硬失败：在冻结 pin 上断言竞态**两侧**形状仍在——①`onPointerLeave` 的每个 arm 调用都由已提交 `open` 守卫（CLOSE 侧）；②dwell 定时器回调只 `setOpen(true)`、**不复查指针在场**（OPEN 侧；这一侧的最小上游修复会让 CLOSE 侧一字不改，只锁 CLOSE 侧就会在上游修好那天静默放行——回调定位不到或出现多个 setOpen(true) 定时器同样按漂移硬失败）+ 两个时间常数逐值锁步（`POINTER_GRACE_MS`/`openDelayMs` ↔ `HOVER_CLOSE_GRACE_MS`/`HOVER_OPEN_DELAY_MS`）——**退役条件 = 上游修掉该竞态**，形状漂移或常数失步即红，逼出退役/再登记裁决；防伪纪律同 §4 行（去注释/去字符串投影、组件范围逐调用点、常数取值唯一）；登记行见 §4；判定是纯函数，单测随 `verify-upstream-touchpoints-args.test.mjs` 在 `test:upgrade-tools` 跑；pin 树未物化时本门与 C1 同样响亮失败）—— CI 与本地均跑（CI 分 pre/post-install 两段）。
- C2 `--tags <old> <new>`：tag 间**全部已登记 fork 面**的重放差异报告（advisory；C2 遍历 registry 的分类条目（fork/seed），故三条 shadow 副本与 `seed-open-in` 都在内），升级前先跑。
- `scripts/upstream/preflight-vendor-pin.mjs <tag>`（只读，§7 第 0 步）：C2 的**超集**——
  额外报深引 vendor seam 文件、上游包集合增删、新增 client 行、运行时 npm 状态；
  纯函数单测随 `pnpm run test:upgrade-tools` 在 CI 跑。
- update-vendor.mjs 完成输出提示运行本脚本；不进 preinstall。

## 7. 每 tag 维护循环（预检 + 8 步）

> **顺序硬约束**：`pnpm install` 必须在
> `ensure-harness-vendor.mjs`（或根 `preinstall`）**之后**——先 install 再 bootstrap
> 会以 0 退出但只装 20/304 个 workspace 项目（vendor 成员的依赖缺失），随后
> `build:renderer` 才以 `Rollup failed to resolve import "lexical"` 报错。CI 的
> linux/win 两条腿都已是 `Bootstrap → install`。

0. 预检（动 pin **之前**）：`node scripts/upstream/preflight-vendor-pin.mjs <tag> --offline`
   —— 一次给出「fork pure/replay/dropped + 深引 vendor seam 文件 + 上游包增删 +
   新增 client 行 + 运行时 npm 状态」；`--fail-on-replay` 可当硬门。
   （工具与 C2 的分工：C2 只报 fork 面，本脚本额外覆盖 seam 与 roster 面。）
0.5. 结构登记改动只改 `scripts/upstream/registry.json`，然后
   `node scripts/upstream/registry-views.mjs --write` 重生成 §2/§9 的块，
   `node scripts/upstream/verify-registry.mjs` 必须绿（手改生成块或漏改 registry 都红）。
1. 读 C2 报告逐面裁决；仍 open 的偏差登记进 `docs/progress/STATUS.md`——本表只更新结构登记行，
   不记版本值、不加「追踪 <tag>」行；
2. `node scripts/upstream/update-vendor.mjs <tag>`（原子升级 + 锁文件重生成）；
3. C2 触点报告（`--tags old new`）→ 逐文件裁决：重放 [pure]/[patch-*] 或改登记；
4. fork 重放 + 版本标记同步（三副本 → 新版本）；
5. roster pass：covered/factory 存在性、typert 契约、新增官方行裁决；
6. 契约复验：contract-mirror 表逐行（§4）+ 相关测试；移动锚点面额外跑
   `node scripts/upstream/verify-mobile-anchors.mjs --require-anchor-root`（严格模式：无锚点树、
   无 client 产物、插件源码抽不到、pin 身份不可判定、或锚点树 `dsh-web-frontend` 版本与 pin 不一致都 exit 1，见 §4 登记行）——
   哈希 class token 变更是预期内的重锚信号，按移动包 README「Anchor baseline」逐条重锚；
7. 运行时线单独提交（bundle-dsh 刷新 + 四锚 + bin.js 冒烟）；
8. 文档回写：CHANGELOG/STATUS + registry 刷新后重生成本表 §2/§9（`registry-views.mjs --write`，
   `verify-registry.mjs` 绿；版本值不进 checklist）+ i18n 重录。

## 8. PR 评审清单条目

改动含下列任一项 ⇒ **必须登记/刷新本表与 verify 脚本**（PR 模板已含自检项）：
- 新增 `@deepseek-ai/*` 深导入或裸 vendor 运行时导入面（→ §3/§5）；
- 修改 fork 副本文件（pure 面改动会被 C1 拦；[patch-*] 须同批更新登记原因）；
- 镜像新上游 wire / 契约（→ §4）；
- 新增再生物（→ §5）；
- covered/factory/assembly 行变化（→ §3）；
- 触点/分类/契约结构变化 ⇒ 改 `scripts/upstream/registry.json` 并重生成 §2/§9（`verify-registry` 是硬门）；
- 新增文档锚点一律写符号锚 `path#symbol`；遗留 `文件:行` 锚只降不升（`check-anchors` 预算棘轮）。

## 9. 触点总表（生成）

> 由 `scripts/upstream/registry.json` 生成（重生成：`node scripts/upstream/registry-views.mjs --write`；
> 保鲜门：`node scripts/upstream/verify-registry.mjs`）。机械索引，表格禁止手改；散文仍在本表之外。

<!-- GENERATED:registry:touchpoints.index:begin -->
| id | 类型 | 上游 | 我方 | 判据 | 偏差 / 门 | 状态 |
|---|---|---|---|---|---|---|
| `fork.dsh-client-connection` | fork | `packages/client/connection` | `packages/dsh-client-connection` | C1, C2, C3, C5, C6 | — | aligned |
| `fork.dsh-client-web` | fork | `packages/client/web` | `packages/dsh-client-web` | C1, C2, C3, C5, C6 | — | aligned |
| `fork.dsh-api-gateway` | fork | `packages/api/gateway` | `packages/dsh-api-gateway` | C1, C2, C3, C5, C6 | — | aligned |
| `seed.dsh-chamber-seed-open-in` | seed | `packages/host/open-in-app` | `packages/dsh-chamber-seed-open-in` | C1, C2, C3, C5 | — | aligned |
<!-- GENERATED:registry:touchpoints.index:end -->
