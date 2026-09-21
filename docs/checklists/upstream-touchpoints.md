# 上游触点登记与保鲜（upstream touchpoints）

> 登记dsh-chamber对上游dsh（deepseek-harness）的全部接触面（fork纯度、深引vendor、契约镜像、covered/assembly行、生成物）与升级tag后的保鲜闭环。
> 机器侧门 = `scripts/upstream/verify-upstream-touchpoints.mjs`（C1–C15：C11–C14插件受保护集合门、C15悬停卡移植退役门；CI两条腿Bootstrap后pre-install跑 `--no-artifact-rebuild`（C1/C3–C15，C8 advisory）、post-install跑完整门（C8重建-比对硬失败）；C2本地advisory）；
> **单一来源 = `scripts/upstream/registry.json`**（路径 / 分类 / 判据id / 偏差id / 原因）；§2/§9的表格即其生成视图（`<!-- GENERATED:registry:… -->` 块**禁止**手改；重生成 `node scripts/upstream/registry-views.mjs --write`，保鲜门 `node scripts/upstream/verify-registry.mjs`）；`verify-upstream-touchpoints.mjs` 启动即读同一份。
> 基准值不在本表：pin单一来源 `harness.commit`（== submodule gitlink）、运行时锚 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `@deepseek-ai/dsh`、fork版本各 `package.json`（对拍门 = C5/C10）。本表只登记结构性触点与判据；升级叙述写 `CHANGELOG.md`。

## 0. 结构速查（只登记结构与判据，不记录版本值）

> 本节速查值（链接数、契约数、covered/factory计数）为手写散文，以 §6的门与源码为准。

|项|值 / 判据|
|---|---|
|vendor链接数|由 `ensure-harness-vendor` 断言 == 锁文件importer集合——源码线，不是F|
|运行时线族集合（F）|`packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包里的 `@deepseek-ai/*` 名字集合（C11硬门）：含核心 `dsh`/`dsh-base`/`dsh-web-app`，不含 `dsh-experimental-*`（官方opt-in层必须可装）与dev/test包；本行与上一行是两条线，数量相近但集合不同，不可互推|
|typert remote装配契约|15（C4；+command-feedback/+workspace-files）|
|covered / factory|`chamber-covered.ts` 的两个集合（factory ⊆ covered，chamber-entry锁步断言；含 `ui-dockkit`、`client-file-upload` 的covered factory与 `session-log-export`（deferred）、两个page-own跳过id）|
|种子域|`clientGraph/graph`、`gitWorktree/previewCreate`、`archiveCleanup/probe`、`openInApp/probe`（C7双门）|

## 1. 标记约定（每文件分类）

|标记|含义|机器校验|
|---|---|---|
|[pure]|与上游锚逐字节一致|C1：不一致即硬失败（除非登记 [patch-*]）|
|[patch-add]|补丁仅追加（如package.json追加脚本），上游内容原样保留|C3（放行差异）|
|[patch-mod]|修改上游内容（chamber语义面）|C3（放行差异）|
|[patch-comment]|仅注释级差异（chamber说明/rebase日志）|C3（放行差异）|
|[own-divergent]|结构/内容chamber自有、仅跟踪上游增量（tsconfig构面、base.css）|C3（放行差异）|
|[own]|chamber自有文件/目录（上游无对应物）|C3：漏登记即硬失败|
|[dropped]|上游文件有意不镜像（host半/tests/tsdown/README…）|C3：漏登记即硬失败|

锚 = fork `package.json` version + `harness.commit`（两者同时漂移才算跟随；任一过期C5硬失败）。

### 1.5 权威梯度与冲突裁决（registry `authority` 字段引用本节）

|权威|含义|冲突时的裁决|
|---|---|---|
|`upstream`|pin住的上游实现/形状是权威，我方只允许登记在案的补丁（`classify.patched`/`own`/`dropped`）|上游变 ⇒ 我方跟随（重放或改登记），禁止反向解释；C1/C3/C5硬失败兜底|
|`chamber`|chamber自持：上游无对应物，或官方注册被chamber fork替换（design 20 §2.2 fork & supersede）|只以本仓源码为准；上游同域变化先裁决是否退役/再登记，未裁决不得静默跟随|

> 其它裁决规则（沿用既有口径）：版本值只认 `harness.commit` / 运行时锁文件 / 各fork `package.json`，
> 本表与生成块都不记录版本值；`status: accepted` 必须带 `rationale`（理由随条目走）。
> 符号锚（`registry.entries[].symbols`）写作 `path#symbol`（退化 `path#=literal:<唯一子串>`），
> path先按该条目的 `ours` 解析、再退回仓库根；解析门 = `node scripts/upstream/check-anchors.mjs`。

## 2. fork-mirror 登记（逐 fork）

### 2.1 `packages/dsh-client-connection`（上游 `packages/client/connection`）

pure 16：`src/http-bridge.ts`、`src/rpc.ts`、`src/rpc-host.ts`、`src/rpc-schema.ts`、
`src/loopback-hostname.ts`、`src/index.ts`、`src/recovery-config.ts`、`src/browser-auth.ts`、
`src/client/api.ts`、`src/client/fixture.ts`、`src/client/random-uuid.ts`、`README.md`、
`README.zh.md`、`README.i18n.yaml`（+client构面未列出的小项以脚本计数为准）。


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

pure 5：`src/base.css`（Batch 2恢复逐字节一致——chamber token表改由renderer入口
CSS `packages/renderer/src/styles.css` 引入）+ client构面未列出的小项（以脚本计数为准）。

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

pure 5（以脚本计数为准）。

<!-- GENERATED:registry:touchpoints.fork-mirror.api-gateway:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | description/peer 集裁剪（host 依赖 dropped）+ chamber test 脚本 + 版本行随上游推进 |
| `src/client/index.ts` | [patch-mod] | apply(ctx) 读 ctx.chamberBasePath → /api/remote.mux 落到实例前缀 + start(sinks, recoveryOverridesForTransport(transport))（design 05 §6）+ $stream 工厂组合 carrierFailed 发布 dsh-chamber:stream-carrier-failed 页面事实（design 14 §D4）+ 生命周期取证通道 dsh-chamber:stream-forensics（generation 就绪/丢失；2026-09 卡死排查） |
| `src/client/journal-stream.ts` | [patch-mod] | 静默看门狗（design 14 §D4，2026-09 卡死排查）：已开启的 journal 静默 ≥45s 时开一条旁路 sibling follow、只比对 opening cursor，仅当宿主确已前进才替换物理世代（新 opening 以 replace 全窗口收敛）；不设盲空闲重启；探针节奏按无进展次数放宽至 90s 上限（探针自身失败/超时同样放宽）；prepend 用户读带 60s 期限 |
| `src/client/remote-stream.ts` | [patch-mod] | 载波重试策略：活连接世代下的后续载波失败改走有界退避重开，不再逃逸为终局 gateway/internal（design 14 §D4；退避纯函数在同包 own 文件 remote-retry-policy.ts，patch 形状由 test/patch-lock 钉住） |
| `src/client/stream-client.ts` | [patch-mod] | per-entry basePath（流载波 URL 拼装）+ 开帧发送前校验（socket 已被替换/正在关闭 ⇒ 载波失败，杜绝 RFC 6455 静默丢弃）+ 逻辑流首帧期限（30s 起、按 endpoint+payload 摘要分账、连续超时放宽至 300s（30→60→120→240→300），失败 inbox 走既有退避重开）+ 静默 socket 升级（首帧期限到期而当前 socket 本次尝试期间一帧未收 ⇒ replaceSocket() 换掉物理 socket，与连接泵 reconnect() 共用拆除道，不再在同一条静默载波上重发；放宽预算保留）+ socket 丢失后自行重排重连（1s 起、连接泵下令的重连不计失败、真实失败翻倍封顶 10s、成功即复位）+ WebSocket 握手期限 30s + socket 生命周期取证（lost/reconnect/attempt-failed/disposed/opening-timeout/socket-silent） |
| `tsconfig.client.json` | [patch-mod] | chamber client 构面（files 表随新增 client 文件同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（files 表随新增 client 文件同步） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `src/client/remote-retry-policy.ts` | [own] | chamber 载波退避纯函数 + 可中止等待 + 逻辑流首帧期限预算（endpoint+payload 摘要分账）+ 静默 socket 替换判定 shouldReplaceSilentSocket（一帧未收 ⇒ 换物理 socket）+ mux 自查重连重排区间 1s/10s + WebSocket 握手期限 30s（零 import，可脱离 vendor 图行为单测） |
| `src/client/stream-carrier-fact.ts` | [own] | chamber 载波故障页面事实（有界计数 + dsh-chamber:stream-carrier-failed；零 import，可注入 dispatch 单测） |
| `src/client/stream-forensics.ts` | [own] | chamber 流生命周期取证事实（有界计数 + dsh-chamber:stream-forensics：socket lost/reconnect/disposed/silent、opening-timeout、generation ready/lost；零 import，可注入 dispatch 单测） |
| `src/client/stream-stall-policy.ts` | [own] | chamber 静默看门狗纯决策（阈值 + probe/wait 判定；零 import，可脱离 vendor 图行为单测） |
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

host插件入口/半、上游 `tests/`、`tsdown.config.ts`、上游README（api-gateway）、构建产物 `lib/` 一律不镜像；升级时按下列判据裁决，判据随重锚复核（逐tag叙述属 `CHANGELOG.md` 与git历史）：

- fork面：上游counterpart的 `src/` 有改动 ⇒ 逐文件重放并更新 §2.1–§2.3的分类与原因；只有 `package.json` 版本行变化 ⇒ 仅同步版本标记（C5对拍）。
- 上游workspace成员增删：vendor链接集合与根 `pnpm-lock.yaml` 随之变化；新增成员按 §5裁决是否属再生物，删除成员须确认 `restore-lockfile-vendor-records.mjs` 的守卫已跳过该记录（见 `dsh-upgrade-checklist.md` §4）。
- 「首屏依赖extra row服务」触点（结构性，与tag无关）：composite首屏插件的cordis `inject` 若由未覆盖的extra row提供，该行不挂载时首屏永远PENDING；探针集合完全派生（记录与并集见 §3），上游改inject面无需登记名字。
- **平台词偏离的跨代耦合（后果登记于 `docs/progress/STATUS.md`）**：`ui-primitives` 不seed、由covered factory回答（C3偏差）；实例侧 `ui-sidebar-documentpreview` 的代码预览行为上依赖与composite同代的 `ui-primitives`（`CodeBlock` 的 `contentRef` 与 `[data-code-block-content]` 是其唯一滚动/行定位锚点）；composite比实例旧一代时该行失去独立滚动区与行定位（纯文本仍可用）——版本歪斜把它变成可见功能面。
- 平台词vs host-graph行：`client/web` 的平台词表（`platform.ts`/`seed.ts`）与host-graph行是互斥裁决——把行当平台词seed会让启动失败（C3不变量）；上游新增平台词时先裁决归属。宿主半的 `webServer` 可选注入会影响connection宿主半的重放，须逐面复核。

### 2.5 `packages/dsh-chamber-seed-open-in`（上游 `packages/host/open-in-app`）

> chamber-named fork（design 20 §6，fork & supersede）：不覆盖上游包名，随chamber版本发布
> （`versionAnchor: chamber`，C5版本等值豁免）；上游 `packages/host/open-in-app` 保留在vendor
> 树作C1锚，因此不进 `EXCLUDED_UPSTREAM_DIRS`。分类表由registry生成：

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

- renderer深引vendor：`@deepseek-ai/*` 一律经vite workspace→src别名与 `paths`；node测试经桩loader（`scripts/dev/test-connection-loader.mjs` 等）——不新增裸运行时vendor依赖。
- covered/factory：`packages/renderer/src/chamber-covered.ts` 的 `CHAMBER_COVERED_IDS` / `CHAMBER_COVERED_FACTORY_IDS`（chamber-entry执行期断言map == 列表）；新增官方client行先裁决（消费 / 镜像 / 替换）再登记covered，删包fail-loud哨兵在C4。
- typert remote装配：契约 == 15（集合与顺序，gen-typert-remotes与C4双向断言）；上游新增remote包先裁决是否chamber消费/镜像再登记；装配契约唯一入口 `remotePackagesFromAssembly`（`renderer/scripts/typert-remote-contract.mjs`）。
- 版本锚与「活」版本字面量（门 = C10）：dsh运行时版本单一来源 = 已提交的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`（同目录 `package.json` 被gitignore，仅本地存在时交叉校验）；六个运行时线锚（`bundle-dsh.mjs` 兜底、vendor锁文件、`release.yml` env、`install-gateway.sh`、gateway `dshAnchorVersion`、`release-preflight` `FORK_VERSION`）与三个fork副本必须等于它。生产源码/脚本/配置（非注释、非夹具、非产物）里不得出现其他dsh版本字面量，历史叙述只留注释；具名常量（如 `HOST_IDENTITY_METHOD_SINCE`）按「上限1处 + 理由」登记白名单。扫描面排除 `*/test/**` 的合成版本与本地派生状态——后者由 `.gitignore` 本身判定（`git ls-files --others --ignored --exclude-per-directory=.gitignore --directory`；不用 `--exclude-standard`，它会把 `core.excludesFile` 带进来，让本地少扫、CI多扫）；唯一例外是被忽略却必须扫的 `vendor/dsh/package.json`。
- vendor源码补丁集（构建期改写，design 09 §3.6）：`packages/renderer/scripts/vendor-patches.mjs` 登记两类补丁，由renderer的 `deepseekSource().transform` 在构建期按精确上游文本改写，vendor文件零写入。① 同源绝对URL类（N-ctx壳必须改写）：`ui-chat` 的 `/api/file`、`client-file-upload`、`ui-deliverables` 的 `/api/present.host|open`、`session-log-export` 的 `/api/session.export`；一律经 `ctx.get('chamberBasePath')` 读取并保留「缺base path → 回落上游」的形状（cordis代理对未provide的服务是抛错而非undefined），相关包按covered / covered-deferred登记。② 实测帧成本类（正确性优先）：`ui-chat` 的CSS-module行sweep、`ui-conversation` 的三层rAF发布链——条目必须把A/B实测写进 `reason`（同一Electron/显示器、`app.getAppMetrics` 累积差）。门：C9（锚点**唯一命中**）+ `vendor-patches.test.mjs`（锚点/行为/id形态）。新增补丁前先问「能否在chamber自己的包里修」；性能类还须先证明成本是每帧的、且chamber侧门控覆盖不到它。
- 复合首屏 ← 未覆盖官方行（反向依赖，集合为派生）：`ui-chat` ← `sidebarRight`（`ui-sidebar-right` 行提供）；集合由 `packages/renderer/src/chamber-entry.ts` 的 `register(id, plugin)` 记录（`chamber-entry.ts` 的 `registerDeferred` 覆盖首屏与延迟）、经 `required-extra-rows.ts` 的 `injectedServices`/`missingInjectedServices` 取并集探测（上游同fact：`Object.keys(entry.fiber.inject)`），不手写；`client-file-upload` 为covered（消除extra row依赖，也让构建期补丁覆盖它的同源绝对URL），`resources`（渲染期 `useResource` 座，非inject）不成立。漂移（命名空间不再导出 `inject`）由 `packages/renderer/src/required-extra-rows.ts` 的 `registeredInjectMembers` 与 `required-extra-rows.test.ts`（`packages/renderer/test/lifecycle/required-extra-rows.test.ts`）的逐id表钉住。上游新增/改名首屏inject成员时，两侧（`host-graph.ts` 降级注释 + 本行）按design 09 §3.2复核即可——探针自动覆盖新的未覆盖provider。

## 4. contract-mirror 登记（按上游属主分组）

> 「怎么判」在各自脚本/测试头注；本表只写**契约**镜像点 + 保鲜门 + 细节在哪。

|上游属主|chamber契约镜像点|保鲜|
|---|---|---|
|dsh-api-remotes（client）|typert remote装配（15）与message-feedback / session-reference / subagent等wire面|`gen-typert-remotes` + C4（集合与顺序双向断言）|
|dsh-api-session-controller|api-gateway fork的journal-stream帧（无游标notification）：帧词表与帧形状都在 `packages/dsh-api-gateway/src/stream-protocol.ts`（纯文件集内）|形状 = C1逐字节；行为 = 升级时人工重放一次journal-stream通路（C1只证形状未变）|
|client/connection（recovery）|recovery-config共享schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` == schema默认 `backoffMaxMs`）|liveness-triggers钉值 + C1|
| dsh-api-session-controller（客户端半的会话事实语义；**人工登记，无 C 编号门**） | **运行位活性守卫押在四条上游语义上**（vendor lockstep 共 6 个断言）（design 14 §D4）：① `sessions.refresh()` → `refreshList()` 单飞并把权威 summary 的 running 回灌已物化会话（`handleRunning`）；② `api-session/status` 是 `mode:'emit'` 转发事件（无重传/无 ack）；③ **`session.list` 拉取失败**（`result.ok===false`，含 carrier 失败被折叠成结果失败）时 `refreshList()` **照常 resolve**，只把 `listState` 置 `'error'`；非 remote 异常仍 reject（emit 本身不触发 `refreshList`）——故 chamber 的 L1 回执必须自带独立权威判定（`verify` seam）；④ **`ClientSessions.handleSessionStatus(sessionId, running)` 是具体类公开方法**（`ISessions` 契约只暴露 `refresh()`），一次调用同时写 list summaries、物化 Session 的 `running`（聊天面）与 catalog activity —— chamber 的 tier-3 写回押在它上面（只写 false、写后自校验、无 TTL；方法缺失即 WARN 一次并降级到升级阶梯） | 现有钉法：`packages/renderer/test/wiring/session-liveness-wiring.test.ts`（五条跨模块不变量：最坏回执 < 等回执期限、
verify 预算 ≥ **两次**探针上限（N=2 串行读；探针上限直接 import `INSTANCE_UNARY_TIMEOUT_MS`，另有一条 `=== 30_000` 的绊线断言——数字仍只有生产一处来源）、
生产装配不得 override 任何对账预算、保留视图 90s 界限的接线、两条恢复路径都要「记水位 + 撤标记」）
+ `test/aggregate/aggregate-refresh.test.ts`（界限判定纯函数）
+ `session-fact-reconcile.test.ts` 的判定纯函数组（`hasReconcilableRunning` / `confirmDeniedRunningIds` / `writeBackTargets`）+ `session-fact-reconcile.test.ts`（「resolve ≠ 成功」的语义锁 + 写回仅在 stale 时调用、成功才按 converged 结算）+ `session-fact-reconcile-wiring.test.ts`（只写 false / 能力守卫 / 写后自校验）。现有钉法（2026-12 补齐）：`packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts` **读 pin 住的 vendor 源**逐条钉住本节语义（6 个断言：emit 白名单 / `$on`→`handleSessionStatus` / 公开且一次写三处 / `refreshList` 失败折叠 + 缺席 id 移除 / 不在 `ISessions` 契约）——vendor 树未物化时**默认失败**（只有显式 `DSH_CHAMBER_VENDOR_ABSENT=skip` 才跳过；CI 不设该变量），升级 tag 时按 §7 人工复验。**新增（2026-12）**：对话流健康臂的杠杆另押三条事实——`followCurrent()` 仅在 `current !== watched` 时 `session.open()`、`Session.open()` 在 `open`/在途 promise 上短路、`failEventStream()` 把 `openState` 锁成 `'error'` 并清空 promise——由 `packages/dsh-chamber-client-ui-open-in/test/session-health/vendor-heal-contract.test.ts` 读 vendor 源逐条钉住（去注释 + 归一化；语义一变即红，恢复臂须重推） |
|dsh-runtime（激活探针域）|`HOST_DOMAIN_PROBE_NAMES` ↔ gateway `HOST_PACKAGE_PROBE_DOMAINS`|C7 + gateway运行时fail-loud|
|interaction/commands（`commands/execute` 第三参数）|激活探针载荷键名 == 上游 `execute(agent, line, submittedAttachments, signal)` 的参数名（历代皆 `submittedAttachments`；`attachments` 从不是上游线名）|`runtime-probes.test.ts`：读vendor签名逐字比对 + 夹具按真实typert gateway校验参数键集|
|`@deepseek-ai/dsh-client-ui-sidebar-right` / `-ui-layout` / `-ui-dockkit` / `-ui-conversation`（移动插件锚点面，打包fork侧）|锚点集（设计17 §18.4.3）：右栏 `[data-sidebar-right-panel]`（`push\|fullscreen`；**不得**用 `data-rightbar-collapsed` 当「已展开」）、抽屉让位的两条臂、dockkit条 `[data-dockkit-strip]` 与其chips、会话头 `role="tablist"` 条、slot出口 `display:contents`|`packages/dsh-chamber-client-ui-mobile/README.md`「Anchor baseline」+ `test/visual/breakpoints.test.ts` 逐条钉住；升级pin时按 §7重锚。mobile不在registry分类条目内（C1/C3/C5不适用），产物陈旧由C8盯|
|`@deepseek-ai/dsh-client-ui-{layout,sidebar,sidebar-right,conversation,chat,dockkit}` + `ui-primitives`（上游发射侧，与上一行同一批DOM契约）|插件声明的锚点**必须**上游真在发射：attribute / role / slot三层都要写入形，只有消费形不足以判定|`scripts/upstream/verify-mobile-anchors.mjs`（纯判据 `mobile-anchors.mjs`、负例 `verify-mobile-anchors.test.mjs`）做双向差集；语料 = 锚点根下 `node_modules/@deepseek-ai/**` 的全部 `.js/.mjs/.cjs` + shell产物（`dsh-web-frontend/dist/assets`，`.js.map` 不算）；根按 `--anchor-root` → `DSH_MOBILE_ANCHOR_ROOT` → 本机gateway → `packages/desktop/vendor/dsh` 取。根缺失 / 无client产物 = fail-soft跳过exit 0；`--require-anchor-root` 把「其实什么都没查」的四条路径改判exit 1（与 `--simulate-rename` 互斥）。升级流程 §7**必须**带严格模式跑（CI无上游树，只能fail-soft）。只判锚点、不判几何——几何断言在 `scripts/gui-acceptance/mobile-walkthrough.mjs`，两者合起来才是design 17 §18.6。最小断言集（19项）**必须**既在源码侧声明、又在产物侧发射：`data-slot="root"`、三列key `sidebar`/`main`/`rightbar`、`shell.overlay`、`data-conversation-scroll`、`data-composer-seat`、`data-composer-input`、`data-chat-flow`、`data-chat-anchor-key`、`data-phase`、会话头 `conversation.session.header` 及其 `actions`/`utilities`/`corner`/`lineage` 四座、`data-sidebar-collapsed`/`data-rightbar-collapsed`、`data-sidebar-right-panel`；强度规则（写入形vs消费形）与语料/根解析细节见脚本头注。**2026-12 起 `data-phase` 新增一个消费者**：renderer 的会话面揭幕门（`packages/renderer/src/session-surface.ts` 从 `[data-conversation-scroll]` 反查该相位做"遮罩何时揭"的判定，我方声明由 `packages/renderer/test/wiring/veil-layering-invariants.test.ts` 钉住，design 05 §2.2.1）；移动侧此前已有消费者（`packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts` 的 `[data-phase]` 反查、`scripts/gui-acceptance/mobile-checks.mjs`）——上游改名或语义漂移会同时打红本门 REQUIRED_ANCHORS 与两侧的锁。另记：租客 DOM 不得引入 `view-transition-name`（N-ctx 把同一官方 UI 挂 N 份，同态重名会让整节过渡被跳过，design 05 §4）|
|dsh-host-webserver（index-inject）|`__DSH_CONNECTION_RECOVERY__` 全局注入（connection host半）|fork C1（`src/index.ts` pure）|
|dsh-host-open-in-app + dsh-client-ui-open-in-app（官方两份）|chamber fork（设计20 §2.2/§6）：宿主半 `packages/dsh-chamber-seed-open-in/`（`src/{catalog,resolver,icons}.ts` pure、`src/{shared,index}.ts` patched、其余own/dropped），客户端半 `packages/dsh-chamber-client-ui-open-in/` 自有wire镜像与 `app.*` 标签表；官方两份都不加载（client行page-own跳过、host行挂载但无调用方）|registry `seed.*` 条目（`versionAnchor: 'chamber'`，分类表见 §2.5）：C1 / C3 / C5（版本锚豁免）；有意分歧逐条写在 `patched`/`dropped` 原因里，跨半契约由客户端 `test/wire-protocol/open-in-wire-lockstep.test.ts` 钉住|
|dsh-client-ui-primitives（`HoverCard`/`pointer-grace`；vendor seam，非fork）|侧栏行卡片自持移植（design 06 §7）：`RowHoverCard.tsx` + `src/shared/hover-intent.ts` 取代vendor原子（vendor宽限关闭以**已提交的 `open`** 判定，leave落在dwell→commit窗口即残留）；相对上游等价 + 有意增量（页面级单卡、blur/hidden关闭、两轴定位、关闭路径copyEpoch）见design 06 §7与 `STATUS.md` 偏差条|C15（硬失败）：在冻结pin上断言 ① CLOSE侧竞态形状仍在（`onPointerLeave` 的每个arm都由已提交 `open` 守卫）①b OPEN侧dwell回调无指针在场复查、定时器唯一可定位 ② 时间常数逐值锁步（`POINTER_GRACE_MS` / `openDelayMs`）。退役条件 = 上游修掉该竞态，任一断言不成立即红并逼出裁决。防伪：去注释 + 去字符串投影、组件体内逐调用点、常数取值唯一；单测随 `test:upgrade-tools`，端到端走查 `W-4b`|
|`@deepseek-ai/dsh-client-locale` + `dsh-client-ui-settings`（页面语言归属，design 06 §4.6）|`packages/renderer/src/locale-ownership.ts` 只依赖四条vendor事实：① locale服务名 `locale` 与 `slots.installLocale` 面；② `LOCALE_SETTINGS_NAMESPACE = 'locale'` 与 `settingsScope.bind({ namespace })` 形状；③ `locale.subscribe(sync)` 先于apply里紧随的立即 `sync()`；④ 每namespace scope的 `status: persistence === 'host' ? 'loading' : 'unavailable'` 与 `derive → ready/unavailable`（settled判据 = `status !== 'loading'`）|四条事实无自动化锁步 ⇒ pin升级时人工复审（③ 漂移削弱同栈回写，④ 漂移让闪烁问题复活）|
## 5. 再生物登记

|再生物|源|提交纪律|
|---|---|---|
|renderer typert工件（gen-typert-remotes输出）|vendor typert/remote源码|**构建期生成、`.gitignore` 忽略，不提交**（`renderer/src/generated/`；升级后由 `build:renderer` 重生成）|
|host dist ×4（`dist/index.js`，含seed-open-in）+ `dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/index.js`/`lib/client.js`(+map)|chamber host包src / dsh-runtime src / mobile src|`build:host-packages` / `build:dsh-runtime` / mobile `build` 后提交（C8共6组）。C8重建-比对硬失败盯陈旧（mobile产物由gateway逐字节seed，陈旧即线上锚点失效）；两个build脚本都带 `absWorkingDir`，产物与调用者CWD无关|
|boot manifest / perf-sizes|build:renderer|构建产物diff随批审查|
|schemastery桩loader（connection/web测试）|vendor source-only现实|新增vendor运行时导入面时同步补桩|

## 6. 保鲜自动化

`node scripts/upstream/verify-upstream-touchpoints.mjs`（除C8在正常路径下「重建-比对后原样还原」外只读；中断/并发/额外产物路径由整目录快照 + SIGINT/SIGTERM处理器 + `wx` 独占锁兜底）：
- registry单一来源与生成闭环（`registry.json` 为唯一机器来源）：三道命令：
  - `node scripts/upstream/registry-views.mjs --check|--write`：生成物保鲜（本表 §2/§9的GENERATED块）；手改生成块 ⇒ `verify-registry` 红。
  - `node scripts/upstream/verify-registry.mjs`：schema / canonical / 引用存在性 / deviations id / 覆盖面网（§2.x标题 ↔ 条目、`chamberNamedForks` ↔ `versionAnchor: chamber`、`excludedUpstreamDirs` ↔ `ensure-harness-vendor` 的EXCLUDED）/ 生成块字节一致。
  - `node scripts/upstream/check-anchors.mjs`：registry符号锚可解析 + 遗留 `文件:行` 锚预算棘轮（`anchors-budget.json`，只降不升）；`--report` 出漂移与测试面三分类，`--fix --file <md> [--apply]` 只回写「同行唯一可解析符号」的锚点、拒绝生成块。
- 参数守卫与退出码（措辞与脚本头注同源）：默认模式会就地重建并还原提交态生成物（唯一写盘路径），因此任何未知参数/位置参数都由 `verify-upstream-touchpoints-args.mjs` 判为用法错误——`--help`/`-h` = 打印权威用法文本、exit 0，不跑任何门、不写盘；未知参数（如拼错的 `--no-artifact-rebuid`）、位置参数、重复flag或 `--tags` 缺值 = exit 2（用法错误）且不先跑门；门硬失败 = exit 1；全部通过 = exit 0。拼错的flag以前被静默忽略并照跑全量写盘门，故这里响亮失败而非容错。判定逻辑是纯函数（单测 `verify-upstream-touchpoints-args.test.mjs`）。
- C1 pure字节恒等 / C3完整性（fork每文件分类、上游每文件裁决，漏 = 硬失败）/
  C5过期锚扫描 / C6 EXCLUDED存在性 —— CI在Bootstrap后fail-loud；
- C4 roster（covered/factory哨兵 + remote契约15的集合与顺序）—— 本地/CI均可；
- C7种子域锁步、C8提交态生成物 == src（重建-比对，硬失败；写后原样还原，`--no-artifact-rebuild` 退回mtime advisory）、C9 vendor补丁锚**唯一**命中（硬失败）、C10版本锚一致性 + 活版本字面量白名单（硬失败，判据见 §3：运行时版本单一来源、六锚 + 3 fork等值、未登记「活」版本字面量即红、具名常量按上限1处白名单）—— CI与本地均跑（CI分pre/post-install两段）。
- C11–C14受保护集合与代耦合（硬失败，只读，CI两段都跑；判据纯函数在 `plugin-protection-gate.mjs`，负例测试随 `pnpm run test:upgrade-tools`）：
  C11运行时线族集合——F分量**只**认已提交的运行时锁文件闭包（见 §0；实例树物化时另做等价性交叉校验，允许差集 = 其他平台 `node-addon-system-*`）；同一闭包也是design 21 §6.11装后复验所用name→version事实的来源，但本门只判名字集（版本事实不进门禁）；
  C12 **profile契约锚**——上游源码仍以 `dsh.profile.bundles` 承载层列表、以 `dsh.bundle.patch` 声明层、web模板默认组合不变、profile workspace仍是 `nodeLinker: hoisted` + `autoInstallPeers: false`；**两个锚点文件（`packages/boot/app-boot/src/profile.ts` 与 `apps/cli/src/plugin.ts`）都必须可读**——树已部分物化时缺文件 = 改名/搬移（违规），只有整体未物化才降级为note；
  C13播种注册表结构——`HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一一对应；
  C14 manifest三方镜像 + rows行类型——`plugin-sync.ts`（producer）↔ `preload.cts` ↔ `renderer/src/global.d.ts` 字段集一致，且 `rows` 的元素类型三方一致（`PluginRow` ↔ `PluginRowProjection`：字段名 + `role`/`owner` 字面量并集；可选标记 `?` 不属于字段名；producer以命名类型别名（`role: PluginRowRole`）声明时在同源内解析成字面量并集一起比较；任一侧声明了该字段却读不出并集 ⇒ 按违规处理，绝不静默只比剩下两方。负例覆盖"任一wire侧删/收窄 `owner`/`role` 并集、producer别名增/删值、行字段漂移、producer换成不透明类型"；ipc-surface-mirror只覆盖宿主接口的后两者）。
  任一红 = 停升级、改派生（B₀ 快照 / F来源 / S注册表 / wire镜像），**绝不放行**——design 21 §6.11。
- C15悬停卡自持移植的上游退役门（硬失败；形状、常数与防伪判据见 §4行：①CLOSE侧每个 `onPointerLeave` arm由已提交 `open` 守卫，②OPEN侧dwell回调只 `setOpen(true)`、不复查指针在场——只锁CLOSE侧会在上游修好那天静默放行，③`POINTER_GRACE_MS`/`openDelayMs` ↔ `HOVER_CLOSE_GRACE_MS`/`HOVER_OPEN_DELAY_MS` 逐值锁步；判定为纯函数，单测随 `verify-upstream-touchpoints-args.test.mjs` 在 `test:upgrade-tools` 跑；pin树未物化时与C1同样响亮失败）—— CI与本地均跑（CI分pre/post-install两段）。
- C2 `--tags <old> <new>`：tag间全部已登记fork面的重放差异报告（advisory；C2遍历registry的分类条目（fork/seed），故三条shadow副本与 `seed-open-in` 都在内），升级前先跑。
- `scripts/upstream/preflight-vendor-pin.mjs <tag>`（只读，§7第0步）：C2的超集——
  额外报深引vendor seam文件、上游包集合增删、新增client行、运行时npm状态；
  纯函数单测随 `pnpm run test:upgrade-tools` 在CI跑。
- update-vendor.mjs完成输出提示运行本脚本；不进preinstall。

## 7. 每 tag 维护循环（预检 + 8 步）

> 顺序硬约束：`pnpm install` 必须在 `ensure-harness-vendor.mjs`（或根 `preinstall`）之后——先install再bootstrap以0退出但只装20/304个workspace项目（vendor依赖缺失），随后 `build:renderer` 才报 `Rollup failed to resolve import "lexical"`。CI的linux/win两条腿都已是 `Bootstrap → install`。

0. 预检（动pin之前）：`node scripts/upstream/preflight-vendor-pin.mjs <tag> --offline` —— 一次给出「fork pure/replay/dropped + 深引vendor seam文件 + 上游包增删 + 新增client行 + 运行时npm状态」；`--fail-on-replay` 可当硬门。（C2只报fork面，本脚本另覆盖seam与roster面。）
0.5. 结构登记改动只改 `scripts/upstream/registry.json`，然后
   `node scripts/upstream/registry-views.mjs --write` 重生成 §2/§9的块，
   `node scripts/upstream/verify-registry.mjs` 必须绿（手改生成块或漏改registry都红）。
1. 读C2报告逐面裁决；仍open的偏差登记进 `docs/progress/STATUS.md`——本表只更新结构登记行，
   不记版本值、不加「追踪 <tag>」行；
2. `node scripts/upstream/update-vendor.mjs <tag>`（原子升级 + 锁文件重生成）；
3. C2触点报告（`--tags old new`）→ 逐文件裁决：重放 [pure]/[patch-*] 或改登记；
4. fork重放 + 版本标记同步（三副本 → 新版本）；
5. roster pass：covered/factory存在性、typert契约、新增官方行裁决；
6. 契约复验：contract-mirror表逐行（§4）+ 相关测试；移动锚点面额外跑
   `node scripts/upstream/verify-mobile-anchors.mjs --require-anchor-root`（严格模式：无锚点树、
   无client产物、插件源码抽不到、pin身份不可判定、或锚点树 `dsh-web-frontend` 版本与pin不一致都exit 1，见 §4登记行）——
   哈希class token变更是预期内的重锚信号，按移动包README「Anchor baseline」逐条重锚；
7. 运行时线单独提交（bundle-dsh刷新 + 四锚 + bin.js冒烟）；
8. 文档回写：CHANGELOG/STATUS + registry刷新后重生成本表 §2/§9（`registry-views.mjs --write`，
   `verify-registry.mjs` 绿；版本值不进checklist）+ i18n重录。

## 8. PR 评审清单条目

改动含下列任一项 ⇒ **必须**登记/刷新本表与verify脚本（PR模板已含自检项）：
- 新增 `@deepseek-ai/*` 深导入或裸vendor运行时导入面（→ §3/§5）；
- 修改fork副本文件（pure面改动会被C1拦；[patch-*] 须同批更新登记原因）；
- 镜像新上游wire / 契约（→ §4）；
- 新增再生物（→ §5）；
- covered/factory/assembly行变化（→ §3）；
- 触点/分类/契约结构变化 ⇒ 改 `scripts/upstream/registry.json` 并重生成 §2/§9（`verify-registry` 是硬门）；
- 新增文档锚点一律写符号锚 `path#symbol`；遗留 `文件:行` 锚只降不升（`check-anchors` 预算棘轮）。

## 9. 触点总表（生成）
> 由 `scripts/upstream/registry.json` 生成；机械索引，表格**禁止**手改；散文在本表之外。

<!-- GENERATED:registry:touchpoints.index:begin -->
| id | 类型 | 上游 | 我方 | 判据 | 偏差 / 门 | 状态 |
|---|---|---|---|---|---|---|
| `fork.dsh-client-connection` | fork | `packages/client/connection` | `packages/dsh-client-connection` | C1, C2, C3, C5, C6 | — | aligned |
| `fork.dsh-client-web` | fork | `packages/client/web` | `packages/dsh-client-web` | C1, C2, C3, C5, C6 | — | aligned |
| `fork.dsh-api-gateway` | fork | `packages/api/gateway` | `packages/dsh-api-gateway` | C1, C2, C3, C5, C6 | — | aligned |
| `seed.dsh-chamber-seed-open-in` | seed | `packages/host/open-in-app` | `packages/dsh-chamber-seed-open-in` | C1, C2, C3, C5 | — | aligned |
<!-- GENERATED:registry:touchpoints.index:end -->
