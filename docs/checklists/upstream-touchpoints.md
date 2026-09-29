# 上游触点登记与保鲜（upstream touchpoints）

> 登记dsh-chamber对上游dsh（deepseek-harness）的全部接触面（fork纯度、深引vendor、契约镜像、covered/assembly行、生成物）与升级tag后的保鲜闭环。
> 机器侧门 = `scripts/upstream/verify-upstream-touchpoints.mjs`（C1–C16：C11–C14插件受保护集合门、C15悬停卡移植退役门、C16 vendor源消费者双向门；CI两条腿Bootstrap后pre-install跑 `--no-artifact-rebuild`（C1/C3–C16，C8 advisory）、post-install跑完整门（C8重建-比对硬失败）；C2本地advisory）；
> **单一来源 = `scripts/upstream/registry.json`**（路径 / 分类 / 判据id / 偏差id / 原因）；§2/§9的表格即其生成视图（`<!-- GENERATED:registry:… -->` 块**禁止**手改；重生成 `node scripts/upstream/registry-views.mjs --write`，保鲜门 `node scripts/upstream/verify-registry.mjs`）；`verify-upstream-touchpoints.mjs` 启动即读同一份。
> 基准值不在本表：pin单一来源 `harness.commit`（== submodule gitlink）、运行时锚 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `@deepseek-ai/dsh`、fork版本各 `package.json`（对拍门 = C5/C10）。本表只登记结构性触点与判据；升级叙述写 `CHANGELOG.md`。

## 0. 结构速查（只登记结构与判据，不记录版本值）

> 本节速查值（链接数、契约数、covered/factory计数）为手写散文，以 §6的门与源码为准。

|项|值 / 判据|
|---|---|
|vendor链接数|由 `ensure-harness-vendor` 断言 == 锁文件importer集合——源码线，不是F|
|运行时线族集合（F）|`packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包里的 `@deepseek-ai/*` 名字集合（C11硬门）：含核心 `dsh`/`dsh-base`/`dsh-web-app`，不含dev/test与源码线harness段；官方opt-in（`dsh-experimental-*`）只放行**登记白名单**内的名字（运行时根包自己声明的opt-in依赖属于F；未登记名字出现/已登记名字不再出现都红）；本行与上一行是两条线，数量相近但集合不同，不可互推|
|typert remote装配契约|24（C4；import 选择表与 apply 挂载表各自定序，集合相等）|
|covered / factory|`chamber-covered.ts` 的两个集合（factory ⊆ covered，chamber-entry锁步断言；含 `ui-dockkit`、`client-file-upload` 的covered factory与 `session-log-export`（deferred）、四个有意跳过id（hmr/mobile/directory-picker-native/settings-account））|
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
> `authority: chamber` 的条目必须带非空 `retireWhen`（一句可判的退役触发），其余 authority 不得携带——
> 校验在 `scripts/upstream/registry.mjs`，能力面的对应触发由 `node scripts/upstream/verify-capabilities.mjs` 在命中时打印。
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
| `README.i18n.yaml` | [own-divergent] | chamber 冻结说明面（不随 pin 追上游 README；当前字节是上游文本的 chamber 裁减/改写版，非逐字副本：en 删 installConnection 内部段、zh 另有数段改写；上游文档更新有意不镜像） |
| `README.md` | [own-divergent] | chamber 冻结英文说明面（同 README.i18n.yaml；当前字节非上游逐字副本） |
| `README.zh.md` | [own-divergent] | chamber 冻结中文说明面（同 README.i18n.yaml；当前字节非上游逐字副本） |
| `package.json` | [patch-mod] | 追加 chamber test 脚本 + 删除死发布面 files/main/types（本仓不构建 lib、无发布路径；exports 面保持上游 lib 目标供 renderer 按包名消费；版本行随上游推进） |
| `src/api-path.ts` | [patch-mod] | 追加 resolveInstanceBasePath + 头部 chamber 说明（basePath 语义，design 05 §6） |
| `src/client/connection.ts` | [patch-mod] | erasableSyntaxOnly 显式字段改写（两个构造参数属性）+ 顶部 chamber 说明 + 若干上游 JSDoc 压缩删除；其余逐字节上游（Batch 2 重锚：loopEpoch 守卫与 CONNECTION_BACKOFF_MAX_MS 导出退役，改由原生 reconnect/setNetworkAvailable） |
| `src/client/index.ts` | [patch-mod] | 当前代重锚：apply(ctx) 读 entry Context 的 chamberBasePath → installConnection({basePath}) → 载波装配（design 05 §6）+ SYSTEM_RESUME_EVENT/liveness 触发（design 14 D4）+ recovery-policy 转出；上游的 installConnection/ConnectionInstallOptions/transport.rpc 原样保留 |
| `src/client/rpc.ts` | [patch-mod] | 当前代重锚：WebConnectionRpcOptions + basePath 前缀拼装（stock 保持上游 document-relative 路由；上游二进制响应/uplink 原样保留） |
| `tsconfig.client.json` | [patch-mod] | chamber 构面：extends ../../tsconfig.json + vendor paths + files 列表（与上游 files 增量同步维护） |
| `tsconfig.host.json` | [patch-mod] | chamber 构面：extends ../../tsconfig.json + vendor paths + files 列表（随当前代增补 src/operator-peer.ts、src/client/rpc.ts、src/client/random-uuid.ts） |
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
| `package.json` | [patch-mod] | 描述/测试脚本/deps·peerDeps 面差异 + 删除死发布面 files/main/types（本仓不构建 lib、无发布路径；exports 面保持上游 lib 目标供 renderer 按包名消费；版本行随上游推进） |
| `src/boot.ts` | [patch-mod] | N-ctx boot kernel（extraRows / __ModuleLoader__ / configureContext / 异步 dispose） |
| `src/index.ts` | [patch-mod] | 入口差异（module-system 宿主接线） |
| `src/platform.ts` | [patch-mod] | PLATFORM_MODULES/静态表 chamber 接线（C3 偏差：ui-primitives 不 seed） |
| `src/seed.ts` | [patch-mod] | seed 行 chamber 接线（extraRows/__ModuleLoader__；C3 偏差同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths/检查面） |
| `scripts/test.mjs` | [own] | chamber 测试清单委托共享 runner（scripts/lib/test-manifest.mjs）：3 文件表 + configure-context 的 vendor register 参数 |
| `src/boot-rows.ts` | [own] | chamber 每实例 boot-rows（design 09 module D） |
| `src/boot-tolerance.ts` | [own] | chamber boot 容忍/恢复（design 09） |
| `src/extra-chunk-owners.ts` | [own] | chamber extra rows 的包内动态 chunk owner 登记/撤销（design 09） |
| `test/` | [own] | chamber 自有测试（boot-tolerance/boot-rows/configure-context + fixtures） |
| `src/apply-injections.ts` | [dropped] | 上游当前代的 index 注入表解释器，服务 apps/web 的 __DSH_BOOT_READY__/Host rows；chamber 不消费（index.ts 刻意不导出 applyIndexInjections，package.json 也无 ./injections 子路径），注入面由 host boot graph + N-ctx kernel 接管 |
| `src/boot-client.ts` | [dropped] | 上游当前代抽出的 bootClient/assertEntriesActive 组合；chamber kernel 在 src/boot.ts 内联 boot 建 entry+await+audit 半边并叠加 extraRows 合并 + boot-tolerance 容忍；entries.start/sync 协调半边在 chamber 无消费者（其唯一消费者 HMR 行被覆盖集 skip，见 chamber-covered.ts） |
| `src/mount.ts` | [dropped] | 上游当前代抽出的 mountClient；chamber kernel 的 mountApp 已含同一 uiRenderer inject 挂载并附 15s 超时兜底 |
| `tests/` | [dropped] | 上游文件有意不镜像 |
| `tsdown.config.ts` | [dropped] | 上游文件有意不镜像 |
<!-- GENERATED:registry:touchpoints.fork-mirror.client-web:end -->

### 2.3 `packages/dsh-api-gateway`（上游 `packages/api/gateway`，client 半）

pure 5（以脚本计数为准）。

<!-- GENERATED:registry:touchpoints.fork-mirror.api-gateway:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | description/peer 集裁剪（host 依赖 dropped）+ chamber test 脚本 + 删除死发布面 files/main/types（本仓不构建 lib、无发布路径；exports 面保持上游 lib 目标供 renderer 按包名消费；版本行随上游推进） |
| `src/client/index.ts` | [patch-mod] | apply(ctx) 读 ctx.chamberBasePath → /api/remote.mux 落到实例前缀 + start(sinks, recoveryOverridesForTransport(transport))（design 05 §6）+ $stream 工厂组合 carrierFailed 发布 dsh-chamber:stream-carrier-failed 页面事实（design 14 §D4）+ 生命周期取证通道 dsh-chamber:stream-forensics（generation 就绪/丢失；卡死排查） |
| `src/client/journal-stream.ts` | [patch-mod] | 静默看门狗（design 14 §D4 卡死排查）：已开启的 journal 静默 ≥45s 时开一条旁路 sibling follow、只比对 opening cursor，仅当宿主确已前进才替换物理世代（新 opening 以 replace 全窗口收敛）；不设盲空闲重启；探针节奏按无进展次数放宽至 90s 上限（探针自身失败/超时同样放宽）；prepend 用户读带 60s 期限 |
| `src/client/remote-stream.ts` | [patch-mod] | 载波重试策略：活连接世代下的后续载波失败改走有界退避重开，不再逃逸为终局 gateway/internal（design 14 §D4；退避纯函数在同包 own 文件 remote-retry-policy.ts，patch 形状由 test/patch-lock 钉住） |
| `src/client/stream-client.ts` | [patch-mod] | per-entry basePath（流载波 URL 拼装）+ 开帧发送前校验（socket 已被替换/正在关闭 ⇒ 载波失败，杜绝 RFC 6455 静默丢弃）+ 逻辑流首帧期限（单档 30s，按 endpoint+payload 摘要识别请求与连续超时计数，失败 inbox 走既有退避重开）+ 静默 socket 升级（首帧期限到期而当前 socket 本次尝试期间一帧未收 ⇒ replaceSocket() 换掉物理 socket，与连接泵 reconnect() 共用拆除道，不再在同一条静默载波上重发）+ socket 丢失后自行重排重连（1s 起、连接泵下令的重连不计失败、真实失败翻倍封顶 10s、成功即复位）+ WebSocket 握手期限 30s + socket 生命周期取证（lost/reconnect/attempt-failed/disposed/opening-timeout/socket-silent）+ teardown 分支：逻辑流在其整个生命期内该 socket 零帧且生命期 ≥ 表值 SILENT_TEARDOWN_MIN_MS（15s）⇒ 同一条换 socket 升级（覆盖 20s 探针 abort 早于 30s 预算的已开启会话形态） |
| `tsconfig.client.json` | [patch-mod] | chamber client 构面（files 表随新增 client 文件同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（files 表随新增 client 文件同步） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `src/client/remote-retry-policy.ts` | [own] | chamber 载波退避纯函数（retry first/base/max 与无世代等待上限）+ 可中止等待 + 开帧身份键 streamOpeningKey + mux 自查重连重排区间 1s/10s（零 import，可脱离 vendor 图行为单测）；首帧期限、静默 teardown 下限与 WebSocket 握手期限均已单源于 @dsh-chamber/dsh-stream-state 的 tables.ts，本文件不再持有副本 |
| `src/client/stream-carrier-fact.ts` | [own] | chamber 载波故障页面事实（有界计数 + dsh-chamber:stream-carrier-failed；零 import，可注入 dispatch 单测） |
| `src/client/stream-forensics.ts` | [own] | chamber 流生命周期取证事实（有界计数 + dsh-chamber:stream-forensics：socket lost/reconnect/disposed/silent、opening-timeout、generation ready/lost（detail 带 endpoint、streamId、waitedMs、best-effort sessionId）；零 import，可注入 dispatch 单测） |
| `src/client/stream-stall-policy.ts` | [own] | chamber 静默看门狗纯决策（阈值 + probe/wait 判定；零 import，可脱离 vendor 图行为单测） |
| `tsconfig.check-base.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `tsconfig.check-client.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `test/` | [own] | chamber 自有测试（退避真值表 + 可中止等待 + 载波事实契约 + patch 源文本锁 + 载波自救行为用例 test/behavior/mux-self-heal.test.ts） |
| `README.i18n.yaml` | [dropped] | 上游 README 不携带（fork 描述在 package.json） |
| `README.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json） |
| `README.zh.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json） |
| `src/index.ts` | [dropped] | 上游 host 插件入口（chamber 不镜像 host 半） |
| `src/stream-server.ts` | [dropped] | 上游 host 半流服务器（dropped） |
| `src/types.ts` | [dropped] | 上游 host/aux 类型文件（源码与 inert ./types 子路径均已移除） |
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
| `dist/index.js` | [own] | chamber 构建期生成产物（不提交；clean checkout 由 pnpm run build:artifacts 自举；C8 逐字节重建-比对；上游无对应文件） |
| `scripts/build.mjs` | [own] | chamber esbuild 产物构建 |
| `scripts/test.mjs` | [own] | chamber 测试清单委托共享 runner（scripts/lib/test-manifest.mjs）：文件表 + core.test.ts 的 transform-types/vendor-stub 加载参数 |
| `src/core.ts` | [own] | chamber 域核心：上游 apply() 的目录/图标/拉起状态机（去掉路由与 SSH 门） |
| `test/` | [own] | chamber 自有测试（域契约 + 载荷拒绝矩阵 + vendor stub loader） |
| `README.i18n.yaml` | [dropped] | 上游 README 不携带（fork 描述在 package.json/源码首页） |
| `README.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json/源码首页） |
| `README.zh.md` | [dropped] | 上游 README 不携带（fork 描述在 package.json/源码首页） |
| `src/internals.ts` | [dropped] | 上游测试接缝（本包的接缝走 OpenInAppCore 构造注入，不需要它） |
| `tests/` | [dropped] | 上游测试不镜像（本包 test/ 覆盖域契约） |
| `tsdown.config.ts` | [dropped] | 上游打包配置（本包走 scripts/build.mjs） |
<!-- GENERATED:registry:touchpoints.fork-mirror.seed-open-in:end -->

### 2.6 `packages/dsh-chamber-client-ui-layout`（上游 `packages/client/ui-layout`）

> chamber-named fork（design 06 — 侧栏宽度共享）：不覆盖上游包名，上游
> `@deepseek-ai/dsh-client-ui-layout` 保留在 vendor 树（C1 锚）并被本 fork 深引其 frame 面
> （`AppFrame.tsx` 三列网格、`columns.ts` 几何、`service.ts` LayoutController、
> `theme-presenter.ts` 文档投影）——renderer 的 `deepseekSource` 别名编译真实上游源，本 fork
> 不重实现 shell。登记形态 = registry 的 chamber-named 类（`versionAnchor: chamber`，按
> `registry.mjs` schema 记 `type: seed`）；上游包仍在官方/gateway 部署形态服役，故**不**进
> `excludedUpstreamDirs`（那是三个同名 shadow 替换副本的清单）。覆盖 = C1/C3 分类表 +
> C2 的 tag 间报告 + 升级预检的 vendor-seam 面（预检的 `FORK_PATHS` 只含 shadow 副本，故本条
> 的 client index/store 上游改动以 C2 报告与 vendor-seam 形式出现，不以 fork-replay 形式出现；
> 把它错记成 shadow fork 会让深引的 frame 文件从 vendor-seam 降级成 fork-missing）。
> 分类表由 registry 生成：

<!-- GENERATED:registry:touchpoints.fork-mirror.layout:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.md` | [own-divergent] | chamber fork 说明（动机/形状/深引 frame 面），非上游镜像 |
| `package.json` | [patch-mod] | chamber 自有包名/版本/测试脚本/deps·peerDeps 面（上游发布面与类型入口不复制；版本行不随上游） |
| `src/client/index.ts` | [patch-mod] | 上游 client index 逐字副本上的 chamber 增量：store 换本包 stores.ts（共享+持久侧栏宽度，design 06）+ 根 standard prop chamberFileApiBase（design 09 §3.6）+ 活动视图门控的文档级 theme 投影；frame/service/columns/theme-presenter 深引 vendor 源，inject 面、注册顺序与 priority 不变 |
| `src/client/stores.ts` | [patch-mod] | vendor 每 boot 未持久 store → 本包共享/持久 store：view-prefs 播种与写回（150ms 尾随去抖）+ 跨 boot 订阅采纳（关闭态不回开/同值不循环）；右栏与窄屏覆盖保持 transient（design 06） |
| `tsconfig.json` | [patch-mod] | chamber 构面：extends ../../tsconfig.json + rootDir ../.. + 排除 vendor；上游 project references 不镜像 |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `src/client/document-theme.ts` | [own] | chamber 活动视图门控的文档级主题投影（design 06 §4.6；teardown 不回撤、未知活动源 fail-open） |
| `src/client/store-core.ts` | [own] | chamber 布局 store 纯核心工厂（注入式 env；八动作，node 可直测） |
| `src/client/theme-cache.ts` | [own] | chamber 页面级按源主题快照缓存 + 冷切换 prime 决策（design 06 §4.6） |
| `src/vendor-modules.d.ts` | [own] | repo 级共享 ambient vendor 面的 /// <reference> 存根；全部 dsh specifier 面已合并到 types/vendor-modules.d.ts（vendor 源树无构建类型输出） |
| `test/` | [own] | chamber 自有测试（layout-store：共享/持久/采纳/去抖；document-theme：活动视图门控与 prime 决策） |
| `README.i18n.yaml` | [dropped] | 上游 README 对的哈希记录不携带（fork 说明在 README.md/package.json） |
| `README.zh.md` | [dropped] | 中文 README 不镜像（chamber 说明只有一份） |
| `src/client/AppFrame.module.css` | [dropped] | frame 样式不镜像：深引 vendor 源 |
| `src/client/AppFrame.tsx` | [dropped] | frame 不镜像：深引 vendor 源（三列网格/拖拽/列解算仍是上游实现） |
| `src/client/DocumentTitle.tsx` | [dropped] | 上游同包文件，本 fork 不镜像（vendor 树内保留） |
| `src/client/columns.ts` | [dropped] | 列几何不镜像：深引 vendor 源并以其常数钉 clamp 范围 |
| `src/client/service.ts` | [dropped] | LayoutController/ILayout/PanelInfo 面深引 vendor 源 |
| `src/client/theme-presenter.ts` | [dropped] | 文档级投影仍用 vendor ThemePresenter（本包只加活动视图门控） |
| `src/css-modules.d.ts` | [dropped] | 本包不编译 vendor CSS module；实际 specifier 的 ambient 面在 src/vendor-modules.d.ts |
| `tests/` | [dropped] | 上游 tsdown spec 不镜像（本包 test/ 覆盖 store 与 theme 决策） |
| `tsdown.config.ts` | [dropped] | 死配置：本仓不构建 lib、引用不存在的 tsdown.client.ts，已删除 |
<!-- GENERATED:registry:touchpoints.fork-mirror.layout:end -->

### 2.7 `packages/dsh-chamber-client-ui-sidebar`（上游 `packages/client/ui-sidebar`）

> chamber-named fork（design 05 — 多来源侧栏）：不覆盖上游包名，上游
> `@deepseek-ai/dsh-client-ui-sidebar` 保留在 vendor 树（C1 锚）并被本 fork 深引其
> 同一 `shell.leading` 席位以自建 `SidebarLeadingControls`（上游同形 clone）占座；上游
> `HeaderLeadingControls` 不镜像、也不被源码路径消费——本 fork 只在
> 同一座位上重实现多来源列表、归档管理器与来源信号灯。登记形态 = registry 的
> chamber-named 类（`versionAnchor: chamber`，`type: fork`；`registry.mjs` 的
> chamberNamedForks 不变量接受 fork 与 seed 两种类型，两者都必须带文件级分类，否则
> C1/C3 覆盖不到）。上游包仍在官方/gateway 部署形态服役，故**不**进
> `excludedUpstreamDirs`。覆盖 = C1/C3 分类表 + C2 的 tag 间报告。分类表由 registry 生成：

<!-- GENERATED:registry:touchpoints.fork-mirror.ui-sidebar:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.i18n.yaml` | [own-divergent] | chamber README 对的哈希记录 |
| `README.md` | [own-divergent] | chamber 多来源侧栏说明，非上游镜像 |
| `README.zh.md` | [own-divergent] | 同 README.md（中文镜像） |
| `package.json` | [patch-mod] | chamber 包名/版本/测试脚本（版本行走 chamber 发布） |
| `src/client/SidebarRoot.module.css` | [patch-mod] | 重实现样式（多来源列表/行悬停卡/归档管理器/来源信号灯） |
| `src/client/SidebarRoot.tsx` | [patch-mod] | 重实现：多来源会话列表（按工作区分组、搜索/排序/归档管理器/悬停卡片/来源信号灯）替换上游单来源 workspaces 浏览器 |
| `src/client/contract/slots.ts` | [patch-mod] | chamber 座位契约（owner props 同名但按多来源扩展）；承接 ui-workspace 的 `sidebar.session.row.{leading,hover}` SlotMap 合并（座席所有权转移，vendor 补丁 13） |
| `src/client/index.ts` | [patch-mod] | apply：注册 chamber 侧栏 + sidebar.panellist 镜像 + workspace navigation 服务 + shell.leading 席位由本包 SidebarLeadingControls（上游同形 clone）占座；座席所有权转移后续：本包自行声明并渲染 `sidebar.session.row.{leading,hover}`（原声明由 vendor 补丁 13 删除） |
| `src/client/locales.ts` | [patch-mod] | chamber 文案表（含上游没有的工作区/来源操作） |
| `src/index.ts` | [patch-mod] | 包入口差异（module-system 宿主接线 + chamber 构面导出） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths/检查面） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `scripts/` | [own] | chamber 自有脚本（测试 manifest 与清单守卫） |
| `src/` | [own] | chamber 自有实现（多来源聚合、面板镜像、来源降级、归档管理器、工作区变更/拖拽排序、client-plugin load kernel、席位 chrome、按上游逐字移植的 keyed-row FLIP 动画器 rows/animated-rows.* 等） |
| `test/` | [own] | chamber 自有测试（按域分组：session-rows/session-state/source-runtime/plugin-kernel…） |
| `src/client/HeaderLeadingControls.module.css` | [dropped] | 该组件的内部样式；上游文件不镜像、也不被消费——同一 shell.leading 席位由本包 SidebarLeadingControls.module.css（上游同形 clone）实现 |
| `src/client/HeaderLeadingControls.tsx` | [dropped] | 上游组件不镜像、不被源码路径消费；同一 shell.leading 席位由本包 SidebarLeadingControls.tsx 注册占座（src/client/index.ts；vendor-modules.d.ts 只声明本包用到的类型面） |
| `tests/` | [dropped] | 上游测试/快照不镜像（chamber 有自建 test/） |
| `tsdown.config.ts` | [dropped] | chamber 不构建 lib/（沿用上游模板形状但 chamber 树不产出该产物） |
<!-- GENERATED:registry:touchpoints.fork-mirror.ui-sidebar:end -->

## 3. deep-import 与 roster 登记

- renderer深引vendor：`@deepseek-ai/*` 一律经vite workspace→src别名与 `paths`；node测试经桩loader（`scripts/dev/test-connection-loader.mjs` 等）——不新增裸运行时vendor依赖。
- 上游 pnpm patch 集合（§17-C，registry `patches`）：集合与字节由 vendor pin 拥有（`vendor/harness-checkout/pnpm-workspace.yaml` 的 `patchedDependencies` + `patches/*`），**不复制进本仓**；`bundle-dsh` 逐字生成到运行期 workspace、把 patch 文件拷进 work 目录，runtime `pnpm-lock.yaml` 记录 specifier→patch hash（`allowUnusedPatches` 只豁免不在运行期闭包的条目）。集合漂移 = 可重锚触点：`registry.test.mjs` 对 pin 逐条对拍、`upstream-patches.test.mjs` 对 runtime lock 对拍，两者同时红。
- vendor源直穿登记（门 = C16 + `verify:package-boundaries` 的A判据）：生产源里唯一的「相对 import 出包到 `vendor/`」必须逐条登记在 registry 的 `vendorSourceConsumers`（consumer / vendorFile / symbols / reason / retiresWhen）；C16 双向判定——登记与真实 import 必须同时存在、符号集合逐条相等、每个符号在 vendor 文件里仍是 `export function`，未登记的 vendor 相对 import 一律红；A 门按**同一块**放行，不维护第二份白名单。当前唯一行 = renderer `src/host-graph.ts` ← dsh-client-modules `src/client/manifest.ts`（`optionalStringArray` / `stripClientSuffix`），退役条件写在该条目的 `retiresWhen`（上游把符号放上公开 `./client` 面即删登记、改走包说明符）。
- covered/factory：`packages/renderer/src/chamber-covered.ts` 的 `CHAMBER_COVERED_IDS` / `CHAMBER_COVERED_FACTORY_IDS`（chamber-entry执行期断言map == 列表）；新增官方client行先裁决（消费 / 镜像 / 替换）再登记covered，删包fail-loud哨兵在C4。
- typert remote装配：契约 == 24（唯一顺序表 `EXPECTED_MOUNT_PACKAGES` 钉 apply 挂载序；import 选择无运行时顺序语义，按集合与该表相等断言；gen-typert-remotes与C4双向断言）；上游新增remote包先裁决是否chamber消费/镜像再登记；装配契约唯一入口 `remotePackagesFromAssembly`/`remoteMountPackages`（`renderer/scripts/typert-remote-contract.mjs`）。
- 版本锚与「活」版本字面量（门 = C10）：dsh运行时版本单一来源 = 已提交的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`（同目录 `package.json` 被gitignore，仅本地存在时交叉校验）；六个运行时线锚（`bundle-dsh.mjs` 兜底、vendor锁文件、`release.yml` env、`install-gateway.sh`、gateway `dshAnchorVersion`、`release-preflight` `FORK_VERSION`）与三个fork副本必须等于它。生产源码/脚本/配置（非注释、非夹具、非产物）里不得出现其他dsh版本字面量，历史叙述只留注释；具名常量（如 `HOST_IDENTITY_METHOD_SINCE`）按「上限1处 + 理由」登记白名单。扫描面排除 `*/test/**` 的合成版本与本地派生状态——后者由 `.gitignore` 本身判定（`git ls-files --others --ignored --exclude-per-directory=.gitignore --directory`；不用 `--exclude-standard`，它会把 `core.excludesFile` 带进来，让本地少扫、CI多扫）；唯一例外是被忽略却必须扫的 `vendor/dsh/package.json`。
- vendor源码补丁集（构建期改写，design 09 §3.6）：`packages/renderer/scripts/vendor-patches.mjs` 登记四类补丁（当前 = 15 文件 / 36 处锚点；含第四类的座席所有权转移形态），由renderer的 `deepseekSource().transform` 在构建期按精确上游文本改写，vendor文件零写入。① 同源资源URL类（N-ctx壳必须改写）：`ui-chat` 的 `api/file`（`AssistantMarkdown`/`ChatView` 两处解析器）、`client-file-upload` 的 `api/session/uploadFileBinary`、`ui-deliverables` 的 `api/present.host|open`、`api/changes.open|summary|diff`（owner 动作路由与两个读 store 的 wire URL）、`session-log-export` 的 `api/session.export`——上游现行路由已是**document-relative**（单一 `document.baseURI`，per-entry前缀无处承载），一律经 `ctx.get('chamberBasePath')`（组件类站点读 root 标准 prop `chamberFileApiBase`）归一为 `/api/i/<id>/` 前缀前置（markdown图片URL以 `new URL(basePath + '/', document.baseURI)` 作解析基准），并保留「缺base path → 回落上游document-relative」的形状（`ctx.get` 对未 provide 返回 `undefined`；对**服务代理读属性**才抛错），相关包按covered / covered-deferred登记。② 实测帧成本类（正确性优先）：`ui-conversation` 的三层rAF发布链（`ui-chat` 的 `ReasoningRow` 行sweep 已在当前代上游移入共享 TextShimmer 合成器 keyframes 并随之退役；`GenericCommandCard` 行sweep已在上一代上游删除）——条目必须把A/B实测写进 `reason`（同一Electron/显示器、`app.getAppMetrics` 累积差）。③ 模块私有状态机的逻辑缺陷类（维护者裁决）：`ui-chat` 的 `chat/use-chat-reading.ts` 采样settle——残余偏移在跟随容差（`FOLLOW_THRESHOLD`=24px）内不再保留（实测12px非reader偏移在 `data-chat-following-tail` 保持时永久残留、任一后续布局变化即回贴；触发侧为直接bash调用的 preparing→started 整行替换，scroll侧成因未定，PTC子调用不复现），上游携带修复后删除条目；第三类的第二实例 = `util-values` 的 `hasIntrinsicConstructor` 严格单行比较（上述 JavaScriptCore 多行 native source 缺陷）已在当前代上游改为引擎无关比较并退役（`RETIRED_PATCHES` 钉住新比较句），症状/取舍/删除条件见 design 09 §3.6。④ 多实例正确性类（维护者裁决）：`ui-workspace` 的 `client/navigation.ts` 选择键 per-entry scope + 座席所有权转移（两形态都写明理由，后者 `noRetireForm`）。门：C9（锚点**唯一命中**）+ `vendor-patches.test.mjs`（锚点/行为/id形态）+ vite `buildEnd` 的 applied 覆盖（15/15，未 apply 即构建失败）+ `verify-vendor-patch-applied`（产物侧每补丁 present 标记）。新增补丁前先问「能否在chamber自己的包里修」；性能类还须先证明成本是每帧的、且chamber侧门控覆盖不到它；逻辑缺陷类（第三类）须写明实测症状、接受的取舍与删除条件。

- 插件管理页源深引与 DOM 缝（chamber `dsh-chamber-client-ui-settings-plugin-manager` → `@deepseek-ai/dsh-client-ui-plugin-manager/src/client/*`：页面/controller/config ledger/locales/navigation/slot-contract 类型）：走包说明符 + vite src 别名与 `paths`（本节第 1 条规则），无相对 import ⇒ C16 不适用；容纳层 `EmbeddedPluginManagerPage.module.css` 另钉该页的 `data-plugin-panel` 根、页头/详情头两条 `data-window-drag`、页头行「标题块（**首子**，其内全部内容被容纳层隐去：上游 `h1` + intro 块，与块内标签无关）+ 控件（末子）」的两子元素序列与「页头行是页根首个子元素」的顺序、以及分组缝 `data-plugin-group`（每组 = 首子 `div` 组头 + 末子 `ul` 卡列表；首组头被提进页头行、落在**首轨**，次轨由页头行 subgrid 依自身控件定尺寸（首组以 `:is(:first-of-type, :nth-child(1 of [data-plugin-group]))` 认出；无 subgrid 引擎走 CSS `@supports not` 降级）——见 design 05 §5）形状——改名/改结构即静默回归（锁 = 本包 `test/dom-seam/vendor-page-dom-seam.test.ts`：读 pin 住的 vendor 源逐条钉住上述形状并含负控口径，缺 vendor 树即红；`test/dom-seam/containment-selectors.test.ts` 钉本层消费面。升级按 §7 第 6 步复核；宽容层裁决与有意保留项见 STATUS）。

## 4. contract-mirror 登记（按上游属主分组）

> 「怎么判」在各自脚本/测试头注；本表只写**契约**镜像点 + 保鲜门 + 细节在哪。

|上游属主|chamber契约镜像点|保鲜|
|---|---|---|
|dsh-api-remotes（client）|typert remote装配（24）与message-feedback / session-reference / subagent等wire面|`gen-typert-remotes` + C4（挂载顺序表 + 选择/挂载集合相等）|
|dsh-api-session-controller|api-gateway fork的journal-stream帧（无游标notification）：帧词表与帧形状都在 `packages/dsh-api-gateway/src/stream-protocol.ts`（纯文件集内）|形状 = C1逐字节；行为 = 升级时人工重放一次journal-stream通路（C1只证形状未变）|
|client/connection（recovery）|recovery-config共享schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` == schema默认 `backoffMaxMs`）|liveness-triggers钉值 + C1|
| dsh-api-session-controller（客户端半的会话事实语义；**人工登记，无 C 编号门**） | **运行位活性守卫押在四条上游语义上**（vendor lockstep 共 6 个断言）（design 14 §D4）：① `sessions.refresh()` → `refreshList()` 单飞并把权威 summary 的 running 回灌已物化会话（`handleRunning`）；② `api-session/status` 是 `mode:'emit'` 转发事件（无重传/无 ack）；③ **`session.list` 拉取失败**（`result.ok===false`，含 carrier 失败被折叠成结果失败）时 `refreshList()` **照常 resolve**，只把 `listState` 置 `'error'`；非 remote 异常仍 reject（emit 本身不触发 `refreshList`）——故 chamber 的 probe 必须用独立权威读取判定（不依赖 refresh 成败，见 design 14 §D4「会话事实单一权威」）；④ **`ClientSessions.handleSessionStatus(sessionId, running)` 是具体类公开方法**（`ISessions` 契约只暴露 `refresh()`），一次调用同时写 list summaries、物化 Session 的 `running`（聊天面）与 catalog activity —— chamber 的 tier-3 写回押在它上面（只写 false、写后自校验、无 TTL；方法缺失即 WARN 一次并降级到升级阶梯） | 现有钉法：`packages/renderer/test/wiring/session-authority-wiring.test.ts`（架构守卫：App 无第二 planner、写回只写 false + 能力守卫、30s tick 唯一驱动、保留视图 90s 接线）＋
`packages/dsh-stream-state/test/authority/session-authority.test.ts`（运行位真相：episode / N=2 / 恰好一次完成边沿 / 代际围栏 / 缺席作证）＋
`packages/dsh-chamber-client-ui-sidebar/test/session-state/session-fact-reconcile.test.ts`（执行端：probe 节流 / N=2 / 写回 / 恢复 / 动作 ring）＋
`session-authority-escalation.test.ts`（真实执行端 × App 升级 ladder 的端到端时序：190s reconnect / 310s notice / 恢复撤销）＋
`test/aggregate/aggregate-refresh.test.ts`（保留视图 90s 界限判定纯函数）。现有钉法（补齐）：`packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts` **读 pin 住的 vendor 源**逐条钉住本节语义（6 个断言：emit 白名单 / `$on`→`handleSessionStatus` / 公开且一次写三处 / `refreshList` 失败折叠 + 缺席 id 移除 / 不在 `ISessions` 契约）——vendor 树未物化时**默认失败**（只有显式 `DSH_CHAMBER_VENDOR_ABSENT=skip` 才跳过；CI 不设该变量），升级 tag 时按 §7 人工复验。**新增**：对话流健康臂的杠杆另押三条事实——`retain()` 以 `reference.attachOpening(...)` 呈现会话（呈现即重入 `Session.open()`）、`Session.open()` 在 `open`/在途 promise 上短路、`failEventStream()` 把 `openState` 锁成 `'error'` 并清空 promise——由 `packages/dsh-chamber-client-ui-open-in/test/session-health/vendor-heal-contract.test.ts` 读 vendor 源逐条钉住（去注释 + 归一化；语义一变即红，恢复臂须重推） |
|dsh-api-session-controller（goal 投影 + activation 事件；**人工登记，无 C 编号门**；registry `mirror.dsh-api-session-controller-goal`）|P2a/P2b 的 goal wire 契约镜像（design 17 §10.7、design 19 §3.2）：① 只读 `session/list` 行带 `projections.values.goal`（嵌套 `{goal:{id,revision,phase},updatedAt}`，只取白名单，objective/blockedReason 丢弃）且**不激活 agent**；② `$events` 转发 `goal/activation-changed`（emit 形 `{sessionId, goal?:{id,revision,activation}}`，无重放）；③ activation 只进程内、`$events` ready 代际清空、绝不落盘|无自动化 vendor 源锁步：我方形状由 `packages/control-plane/test/protocol/session-mux.test.ts`（白名单/隐私/activation 路由）与 `packages/renderer/test/session-state/source-mux-facts-goal.test.ts`（P2b 同规）钉住；升级 pin 时按 §7 第 6 步人工对照 pin 住的 vendor 源中 `session/list` 的 `projections` 发射面与 goal activation 事件复验——语义漂移只会保持 unknown（不误报），但白名单字段必须重锚|
|dsh-client-hmr（宿主半的 `/plugins/events`；**人工登记，无 C 编号门**；registry `mirror.dsh-client-hmr-events-endpoint`）|chamber 自带订阅者（design 09 §3.7，`packages/renderer/src/live-graph.ts`）经页面通道消费该 exact 路由（控制面按 `instanceId` 打开上游 `GET <target>/plugins/events`，页面侧不再自建按实例前缀的订阅）：连接即一帧全量 `{type:'graph',graph}`，`onGraphChanged` 推 graph；`rebuilt` 帧不单独消费（上游 `rebuilt()` 会 `compose()`+`notifyGraphChanged()`，带新 rev 的 graph 帧随到）。官方客户端半身仍不加载（document-relative，§3.5 名单①）|无自动化 vendor 源锁步：形状由 `packages/renderer/test/lifecycle/live-graph.test.ts`（帧解析/装-卸-rev 诊断/撤臂栅栏）钉住；升级 pin 时按 §7 第 6 步对照 pin 住的 vendor 源复验路由方法与帧形状——端点消失/改名即 §3.7 退回现状（机会性契约），不会静默坏图|
|dsh-runtime（激活探针域）|`HOST_DOMAIN_PROBE_NAMES` ↔ gateway `HOST_PACKAGE_PROBE_DOMAINS`|C7 + gateway运行时fail-loud|
|interaction/commands（`commands/execute` 第三参数）|激活探针载荷键名 == 上游 `execute(agent, line, submittedAttachments, signal)` 的参数名（历代皆 `submittedAttachments`；`attachments` 从不是上游线名）|`runtime-probes.test.ts`：读vendor签名逐字比对 + 夹具按真实typert gateway校验参数键集|
|`@deepseek-ai/dsh-client-ui-sidebar-right` / `-ui-layout` / `-ui-dockkit` / `-ui-conversation`（移动插件锚点面，打包fork侧）|锚点集（设计17 §18.4.3）：右栏 `[data-sidebar-right-panel]`（`push\|fullscreen`；**不得**用 `data-rightbar-collapsed` 当「已展开」）、抽屉让位的两条臂、dockkit条 `[data-dockkit-strip]` 与其chips、会话头 `role="tablist"` 条、slot出口 `display:contents`|`packages/dsh-chamber-client-ui-mobile/README.md`「Anchor baseline」+ `test/behavior/composer-guard.test.ts`（样式面）逐条钉住；升级pin时按 §7重锚。mobile不在registry分类条目内（C1/C3/C5不适用），产物陈旧由C8盯|
|`@deepseek-ai/dsh-client-ui-{layout,sidebar,sidebar-right,conversation,chat,dockkit}` + `ui-primitives`（上游发射侧，与上一行同一批DOM契约）|插件声明的锚点**必须**上游真在发射：attribute / role / slot 三层要写入形，build-time 哈希 token 要字面命中；只有消费形（选择器/CSS）不足以判定|`scripts/upstream/verify-mobile-anchors.mjs`（纯判据 `mobile-anchors.mjs`、负例 `verify-mobile-anchors.test.mjs`）做双向差集；语料 = 锚点根下 `node_modules/@deepseek-ai/**` 的全部 `.js/.mjs/.cjs` + shell产物（`dsh-web-frontend/dist/assets`，`.js.map` 不算）；根按 `--anchor-root` → `DSH_MOBILE_ANCHOR_ROOT` → 本机gateway → `packages/desktop/vendor/dsh` 取。根缺失 / 无client产物 = fail-soft跳过exit 0；`--require-anchor-root` 把「其实什么都没查」的四条路径改判exit 1（与 `--simulate-rename` 互斥）。升级流程 §7**必须**带严格模式跑（CI无上游树，只能fail-soft）。只判锚点、不判几何——几何断言在 `scripts/gui-acceptance/mobile-walkthrough.mjs`，两者合起来才是design 17 §18.6。最小断言集（21项）**必须**既在源码侧声明、又在产物侧发射：`data-slot="root"`、三列key `sidebar`/`main`/`rightbar`、`shell.overlay`、`data-conversation-scroll`、`data-composer-seat`、`data-composer-input`、`data-chat-flow`、`data-chat-anchor-key`、`data-phase`、会话头 `conversation.session.header` 及其 `actions`/`utilities`/`corner`/`lineage` 四座、`data-sidebar-collapsed`/`data-rightbar-collapsed`、`data-sidebar-right-panel`、悬停卡 watchdog 的两个 CSS-module token `_root_38jqx_`/`_card_38jqx_`（值见移动包 README「Anchor baseline」）；强度规则（写入形vs消费形）与语料/根解析细节见脚本头注；哈希 token 零命中与 attribute/role/slot 同列**硬失败**（pin bump 后必须重锚，见移动包 README「Anchor baseline」）。**起 `data-phase` 新增一个消费者**：renderer 的会话面揭幕门（`packages/renderer/src/session-surface.ts` 从 `[data-conversation-scroll]` 反查该相位做"遮罩何时揭"的判定，我方声明由 `packages/renderer/test/wiring/veil-layering-invariants.test.ts` 钉住，design 05 §2.2.1）；移动侧此前已有消费者（`packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts` 的 `[data-phase]` 反查、`scripts/gui-acceptance/mobile-checks.mjs`）——上游改名或语义漂移会同时打红本门 REQUIRED_ANCHORS 与两侧的锁。另记：租客 DOM 不得引入 `view-transition-name`（N-ctx 把同一官方 UI 挂 N 份，同态重名会让整节过渡被跳过，design 05 §4）|
|dsh-host-webserver（index-inject）|`__DSH_CONNECTION_RECOVERY__` 全局注入（connection host半）|fork C1（`src/index.ts` pure）|
|dsh-host-open-in-app + dsh-client-ui-open-in-app（官方两份）|chamber fork（设计20 §2.2/§6）：宿主半 `packages/dsh-chamber-seed-open-in/`（`src/{catalog,resolver,icons}.ts` pure、`src/{shared,index}.ts` patched、其余own/dropped），客户端半 `packages/dsh-chamber-client-ui-open-in/` 自有wire镜像与 `app.*` 标签表；官方 client 行**加载**（D2：其文件级席位生效——右栏文档动作 `sidebar.right.tab.document.actions`/`.unpreviewable` 与 deliverables 文件动作——前者走 per-instance session Remote，后者读 owner 的鉴权路由 `api/present.open|changes.open`（N-ctx 下由 ui-deliverables 带 per-entry 前缀下发，design 09 §3.6）；其 header 席位读的 document-relative `open-in-app/*` 路由落在控制面 SPA origin ⇒ 渲染 null，目录打开仍由 chamber `open-in` 承接），官方 host 行仍由控制面以本地 `--patch` overlay 显式 `disabled: true`（见 `host-graph-seed.ts` 的 `OFFICIAL_OPEN_IN_DISABLE` 与 `local-host-seeding.ts` 的条件追加）|registry `seed.*` 条目（`versionAnchor: 'chamber'`，分类表见 §2.5）：C1 / C3 / C5（版本锚豁免）；有意分歧逐条写在 `patched`/`dropped` 原因里，跨半契约由客户端 `test/wire-protocol/open-in-wire-lockstep.test.ts` 钉住|
|dsh-client-ui-primitives（`HoverCard`/`pointer-grace`；vendor seam，非fork）|侧栏行卡片自持移植（design 06 §7）：`RowHoverCard.tsx` + `dsh-chamber-client-core/src/hover-intent.ts` 取代vendor原子（vendor宽限关闭以**已提交的 `open`** 判定，leave落在dwell→commit窗口即残留）；相对上游等价 + 有意增量（页面级单卡、blur/hidden关闭、两轴定位、关闭路径copyEpoch）见design 06 §7与 `STATUS.md` 偏差条|C15（硬失败）：在冻结pin上断言 ① CLOSE侧竞态形状仍在——`onPointerLeave` 每个arm的守卫必须是已提交 `open` 本身（或含 `open` 合取项、无顶层 `\|\|` 析取；`open \|\| intentRef.current` / `open \|\| true` 这类 ref-intent 修复判红）①b OPEN侧以 `openDelayMs` 为延迟的dwell回调只 `setPhase('open')`、至多把该 `setTimeout` 赋值目标的 ref 清成 `null`（其他成员写判红）、无指针在场复查（相位机的预览淡出关闭回调投影后同形，故定时器按延迟识别）、生效点唯一 ①c 组件体内的 post-commit 回调（`useEffect`/`useLayoutEffect`/`useInsertionEffect`）fail-closed：任何执行关闭/相位动作（`close()`/`setPhase('')`/宽限 arm）的回调都必须是白名单化的 pinned 形状逐字一致（冻结pin的预览淡出定时器 / owner-disable / Escape 三个 effect），其余一律判红并交人工裁决——把指针在场事实挪到 ref 之外（模块作用域/helper）即可绕过旧的「回调内出现 `*.current` 读取」判据，故判据不再以 ref 读取为前提（二次复核补强：上游可在 commit/effect 层修竞态而两处被钉形状一字不变） ② 时间常数逐值锁步（`POINTER_GRACE_MS` / `openDelayMs`）。**当前代复核**：preview/inline 相位机把开卡语句 `setOpen(true)`→`setPhase('open')`，`onPointerLeave` 逐字未变 ⇒ 竞态仍在、偏差不退役，判据已按相位机形态更新。退役条件 = 上游修掉该竞态，任一断言不成立即红并逼出裁决。防伪：去注释 + 去字符串投影、组件体内逐调用点、常数取值唯一；单测随 `test:upgrade-tools`，端到端走查 `W-4b`；`ui-primitives/src/overlay-top-margin.ts` 的 `overlayTopMargin` 由 `RowHoverCard.tsx` 逐行镜像（模块私有，不可 import）：顶部夹紧 = `max(min, (hasAttribute(data-fullscreen) ? 0 : --dsh-frame-top-clearance) + 20)`；该变量由上游 `ui-layout/AppFrame.module.css` 发布（darwin 48px / `[data-windows-titlebar]` = caption 40px），故 mac 窗态 68、win 窗态 60、全屏 20。`data-fullscreen` 两 flavor 都镜像（`main.ts` 的 `pushFullscreenMark` / `ShellWindowFullscreenMark`，锁 S-53）；真机几何核对见 `STATUS.md` 的窗口 chrome 验收条|
|`@deepseek-ai/dsh-client-locale` + `dsh-client-ui-settings`（页面语言归属，design 06 §4.6）|`packages/renderer/src/locale-ownership.ts` 只依赖四条vendor事实：① locale服务名 `locale` 与 `slots.installLocale` 面；② `LOCALE_SETTINGS_NAMESPACE = 'locale'` 与 `ctx.configForms.get('locale')`（ConfigForm 的 getSnapshot/subscribe 面）形状；③ `locale.subscribe(sync)` 先于apply里紧随的立即 `sync()`；④ 每namespace scope的 `status: persistence === 'host' ? 'loading' : 'unavailable'` 与 `derive → ready/unavailable`（settled判据 = `status !== 'loading'`）|四条事实无自动化锁步 ⇒ pin升级时人工复审（③ 漂移削弱同栈回写，④ 漂移让闪烁问题复活）|
## 4.5 桌面 seat 覆盖审计（`apps/desktop/src`，61 文件）

> I-8 的人工覆盖台账（registry 条目 + 本表两份同源；无 C 编号门）。pin 升级时按 §7 第 6 步逐条照面：
> `mirror` 行必须仍有对应 chamber 席位与门；`different-adopted` 行必须仍是显式取舍；`not-applicable`
> 行一旦被采用（chamber 开始渲染/依赖该上游产品面）即转 mirror 条目。审计对象 = 当前 pin 的 vendor
> 子模块 `apps/desktop/src` 全量 61 文件（任务书估「约 59」）。registry 落点：
> `mirror.dsh-desktop-carrier-seats`（data-platform/dshDesktop 载体/caption/native theme）、
> `mirror.dsh-desktop-shortcuts-seat`（keyboard/keybindings）、`mirror.dsh-desktop-native-chrome-seats`
> （locale/tray/single-instance/quit-confirmation/fatal-recovery/crash-report）、`mirror.dsh-desktop-update-chain`
> （更新链，本批补齐 attention/presentation 并收窄传输/弹窗面）。registry 的 `upstream` 字段受 schema 约束、必须是
> pin 树内存在的单一路径（故四条 mirror 条目仍写 `apps/desktop/src`，逐文件覆盖清单写在各条目 evidence 与本表行内）。
> Swift 腿窗口量不单列条目：由 design 25
> §5.6 逐值重锚 + §4 的 mobile anchors 门覆盖（T-04 记明上游无 Sparkle、Swift 更新链自建）。

| 上游文件 | 分类 | chamber 对照点 | 一句理由 |
|---|---|---|---|
| `account-backend.ts` | not-applicable | 无（对照面：`packages/control-plane` 的无认证 loopback 模型） | 上游 DeepSeek 账号后端（WebSocket 账号流 + 会话 cookie）；chamber 是匿名 loopback 连接管理器，无账号面。 |
| `backend-controller.ts` | different-adopted | `packages/control-plane/src/local-connection.ts`、`packages/desktop/host-assembly.ts` | 本地 dsh 后端的启动/就绪/失败状态机归控制面持有，desktop 只消费 PlaneHandle，不再由 Electron 主进程自持 backend。 |
| `background-notice.ts` | not-applicable | `packages/desktop/chamber-settings.ts`（windowCloseBehavior）、`packages/desktop/main.ts`（maybeCreateTray） | 上游 Windows「首次隐藏到托盘」的一次性确认+标记文件；chamber 的关窗行为是设置项 + 托盘恢复入口，没有该确认产品面。 |
| `browser-guests.ts` | not-applicable | `packages/desktop/README.md`（webPreferences 无 webviewTag） | 上游为官方 sidebar-browser 的 webview 租客做分区/租约隔离；chamber 单窗口无 webviewTag、也不加载该客户端行。 |
| `client-metadata.ts` | not-applicable | 无 | 账号客户端元数据（版本/语言）供账号平台使用；chamber 无账号面。 |
| `client/WelcomePage.tsx` | not-applicable | 无 | 上游欢迎/登录页 React 组件（账号登录 UI）；chamber 不采用 welcome 产品面。 |
| `client/styles.d.ts` | not-applicable | 无 | 欢迎页 CSS module 类型垫片，随 welcome 面一起不采用。 |
| `client/welcome.tsx` | not-applicable | 无 | 欢迎页渲染入口（createRoot + theme CSS）；不采用。 |
| `core-package-set.ts` | different-adopted | `packages/dsh-runtime/src/registry-integrity.ts`、`packages/dsh-runtime/src/anchor-version.ts`、`packages/desktop/vendor/dsh/pnpm-lock.yaml` | chamber 的运行树完整性由 registry 版本 + 已提交 lockfile 锚管理（design 18），不下载/校验上游 desktop-packages.json 的 tgz 包集与 sha512。 |
| `crash-report.ts` | mirror | `packages/desktop/fatal-report.ts`（FATAL_REPORT_FILE / CONSOLE_RING_BYTES=64KiB / REPORT_DETAIL_LIMIT）、`packages/desktop/main.ts`（crashReporter uploadToServer=false） | 落盘崩溃报告 + 有界渲染端 console 环 + 本地留证与上游 fatal diagnostics 同口径；有意差异 = 不做 10 份轮转、只追加。 |
| `directory-picker.ts` | not-applicable | `packages/renderer/src/chamber-covered.ts` 有意跳过名单（directory-picker-native） | 上游为 native 目录选择行提供窗口级对话框 IPC；chamber 把该行列为「covered 但不加载」，picker 交互钉在 browse。 |
| `fatal-recovery.ts` | mirror | `packages/desktop/startup-error.ts`（planStartupRecovery / resolveStartupRecoveryAction / SAFE_MODE_ENV）、`packages/desktop/main.ts` 恢复框接线 | 三选恢复框 + 安全模式重启是上游 fatal-recovery 的等价物；有意差异（S-43 默认项/Esc 落安全项、不实现 disableAllPlugins/sanitizeProfile）已登记在源码头注。 |
| `host-process.ts` | different-adopted | `packages/control-plane/src/spawn-dsh.ts`、`packages/control-plane/src/reaper.ts`、`packages/desktop/host-assembly.ts` | 本地 dsh 子进程的 spawn/就绪探测/回收在控制面，desktop 不做上游的 Electron 子进程协议与 quit inspection。 |
| `host-protocol.ts` | different-adopted | `packages/desktop/sidecar-entry.ts`（B 桥 NDJSON）、`packages/desktop/sidecar-exit-codes.ts` | chamber 的双 flavor 宿主协议是自持 B 桥与退出码分级，没有上游 Desktop host protocol v4 这一 Electron↔host 版本面。 |
| `ipc.ts` | mirror | `packages/desktop/ipc-events.ts`、`packages/desktop/shortcuts-bridge.ts`（DESKTOP_SHORTCUTS_CHANNELS 六个字面量与上游同名）、`packages/desktop/preload.cts`、`packages/desktop/test/ipc/desktop-carrier-surface.test.ts` | 通道表与 DesktopUpdatePresentation/失败分类形状镜像上游；native-theme 通道改用 chamber 前缀 `dsh-chamber:native-theme-set`（upstream-seats 钉住）。 |
| `keybindings.ts` | mirror | `packages/desktop/main.ts`（userData/keybindings.json，注释点名 upstream 同位文件）、`packages/desktop/shortcuts-bridge.ts`（revision 化事务） | 快捷键偏好持久化事务与存储位置镜像上游。 |
| `keyboard.ts` | mirror | `packages/desktop/shortcuts-bridge.ts`（before-input-event 决策表/scopedDesktop 门/投递门）、`packages/desktop/main.ts` glue | 原生键盘桥语义按上游当前代实现；上游协议实现本身从运行树加载而非重写。 |
| `locale.ts` | mirror | `packages/desktop/shell-locale.ts`、`packages/desktop/shell-locale.test.ts` | typed en/zh 字典与 `zh*`→zh-CN 判定镜像上游，范围收窄到原生 chrome（tray/错误框/退出框/恢复框）。 |
| `main.ts` | different-adopted | `packages/desktop/main.ts`（单帧加载控制面 origin）、`packages/desktop/shell-core.ts`、`macos/Sources/DSHChamber/*` | 上游是单进程桌面宿主（web document + account + overlay + app menu）；chamber 是连接管理器单帧 + 双 flavor core，仅 win32 caption、darwin 窗口 chrome（hiddenInset/红绿灯/vibrancy/透明底逐值）、tray/quit 等席位是镜像子集。 |
| `mandatory-update-ipc.ts` | not-applicable | 无 | 上游强制更新 IPC 表；chamber 无强制更新面。 |
| `mandatory-update-policy.ts` | not-applicable | 无 | 上游强制更新策略（semver 门 + 策略页）；chamber 更新一律用户确认、无强制门。 |
| `mandatory-update-window.ts` | not-applicable | 无 | 上游强制更新窗口（下载/安装/稍后）；不采用。 |
| `microphone-permissions.ts` | different-adopted | `packages/desktop/main.ts`（setPermissionRequestHandler / setPermissionCheckHandler + isChamberPermissionGranted） | chamber 的权限面是「默认拒绝，只放行 clipboard-sanitized-write」，不实现上游的麦克风主帧白名单。 |
| `node-environment.ts` | different-adopted | `packages/control-plane/src/spawn-dsh.ts`（resolveNodeExecutable）、`packages/desktop/host-assembly.ts`（pnpm 子进程 ELECTRON_RUN_AS_NODE 分支） | 同样用 Electron-as-node，但 node 解析由控制面单源（process.execPath + ELECTRON_RUN_AS_NODE + --expose-internals），无上游的 launcher 目录 / DSH_DESKTOP_NODE_EXECUTABLE / PATH 契约。 |
| `owned-directory.ts` | different-adopted | `packages/dsh-runtime/src/dsh-runtime-store.ts`、`packages/dsh-runtime/src/private-fs.ts` | chamber 的受管目录清理/校验在 dsh-runtime（lstat + 符号链接拒绝 + 私有 FS 纪律），没有上游那个专用于 Electron 递归 rm 的 junction-safe 删除助手。 |
| `paths.ts` | different-adopted | `packages/desktop/chamber-lock.ts`（`<userData>/.dsh-chamber.lock`）、`packages/desktop/host-root-lease.ts` | chamber 的路径根 = Electron userData + 双 flavor 锁/租约；上游 `profiles/desktop` profile 布局不采用。 |
| `platform-ipc.ts` | not-applicable | 无 | 账号平台视图 IPC 表（locale bootstrap 等）；无账号面。 |
| `platform-view.ts` | not-applicable | 无 | 账号登录 WebContentsView（cookie 合并 / platform headers）；chamber 无账号登录面。 |
| `policy-test-auth.ts` | not-applicable | 无 | 上游强制更新策略的登录测试助手；不适用。 |
| `preload-app.ts` | mirror | `packages/desktop/preload.cts`（exposeDesktopCarrier：protocolVersion 1 + updates/keyboard/shortcuts）、`macos/Sources/DSHChamber/Resources/bridge-shim.js`、`packages/desktop/upstream-seats.test.ts`（S-52） | dshDesktop 载体的存在、成员与相位映射双 flavor 锁步；browser 臂不采用（chamber 无 webview 租客）。 |
| `preload-browser.ts` | not-applicable | 无 | sidebar-browser 的 preload 桥；chamber 不加载该客户端行。 |
| `preload-mandatory-overlay.ts` | not-applicable | 无 | 强制更新遮罩 preload；不采用。 |
| `preload-mandatory.ts` | not-applicable | 无 | 强制更新窗口 preload；不采用。 |
| `preload-menu.ts` | not-applicable | `packages/desktop/main.ts`（唯一 Menu 是托盘上下文菜单，无 setApplicationMenu） | 上游 Windows 应用菜单（原生菜单 + 窗口控制）；chamber 无应用菜单产品面。 |
| `preload-platform-account.ts` | not-applicable | 无 | 账号平台 preload；不采用。 |
| `preload-platform.ts` | mirror | `packages/desktop/preload.cts`（markDocumentPlatform 逐字）、`packages/desktop/main.ts`（全屏标记推送：进出全屏 + 装载后重放）、`macos/Sources/DSHChamber/ShellWindowFullscreenMark.swift`（fullscreen 原生半边）、`packages/desktop/upstream-seats.test.ts`（S-51/S-53） | `dataset.platform` 与 fullscreen 标记镜像上游；**两 flavor 都写 fullscreen**（Electron `main.ts` 的 pushFullscreenMark / Swift `ShellWindowFullscreenMark`，`dataset.fullscreen = 'true'` / `delete` 逐字同形，design 25 §5.6）。 |
| `preload-theme.ts` | mirror | `packages/desktop/preload.cts`（syncNativeTheme observer）、`packages/desktop/shell-ipc-settings.ts`（NATIVE_THEME_SET）、`packages/desktop/electron-edges.ts`（nativeTheme.themeSource）、`packages/desktop/node-edges.ts`（显式 no-op） | `data-ds-theme-source` 观察者与宿主投影镜像上游（macOS-only）；Swift 腿按页面事实跟随，通道保留成员。 |
| `preload-update-dialog.ts` | not-applicable | 无 | 上游更新对话框 preload（update-dialog 窗口）；chamber 更新面无该窗口。 |
| `preload-welcome.ts` | not-applicable | 无 | 欢迎页 preload；不采用。 |
| `preload-windows.ts` | mirror | `packages/desktop/preload.cts`（markWindowsTitlebar：`data-windows-titlebar` + `--dsh-windows-titlebar-height`）、`packages/desktop/main.ts`（titleBarStyle hidden + titleBarOverlay）、`windows-layout.ts` 常数 | Windows caption 席位逐值镜像（高度 40），preload/main 两份常数相等由 upstream-seats 钉住。 |
| `project-manager.ts` | different-adopted | `packages/dsh-runtime/src/runtime-installer.ts`、`packages/desktop/dsh-runtime-controller.ts` | chamber 用 registry 版本安装 + override 机制（design 18）管理运行树，不建上游的 desktop-runtime pnpm 工程/profile 元数据。 |
| `quit-confirmation.ts` | mirror | `packages/desktop/chamber-settings.ts`（computeQuitRisk）、`packages/desktop/main.ts`（before-quit 对话框） | 「退出会打断什么才确认」的席位镜像；检查面收窄为本地实例运行中（上游 = host 活跃/计划任务探测）。 |
| `release.ts` | different-adopted | `packages/desktop/package.json`（version）、`packages/desktop/vendor/dsh/pnpm-lock.yaml`、`packages/desktop/primary-runtime-lock.json` | chamber 的版本身份单源 = 包版本 + lockfile 锚；不读上游 desktop-runtime.json 的 release 元数据（node/pnpm 版本）。 |
| `runtime-tree.ts` | different-adopted | `packages/dsh-runtime/src/dsh-runtime-store.ts`、`packages/desktop/runtime-tree-check.ts` | 运行树清单/校验在 dsh-runtime + 启动期闭包抽样，不采用上游 desktop-runtime.json 描述符与 shared package inventory。 |
| `single-instance.ts` | mirror | `packages/desktop/main.ts`（requestSingleInstanceLock + second-instance 路由）、`packages/desktop/chamber-lock.ts`（O_EXLOCK 跨 flavor） | 单实例所有权与二次启动聚焦镜像上游，另加一层跨 flavor 目录锁（design 25 §6.3）。 |
| `startup-error.ts` | mirror | `packages/desktop/startup-error.ts`（desktopErrorState 同形） | 启动失败态的形状/文案投影与上游同名同义。 |
| `tray.ts` | mirror | `packages/desktop/main.ts`（maybeCreateTray：tooltip + 显示/退出菜单）、`packages/desktop/shell-locale.ts` | 「常驻托盘 = 回到窗口 + 显式退出的入口」席位镜像；chamber 仅打包态且图标存在时创建。 |
| `update-attention.ts` | mirror | `packages/desktop/updater.ts`（Dock 注意力 / flashFrame / parent.isFocused 注入）、`packages/desktop/test/desktop-shell/updater-attention.test.ts` | 更新就绪注意力语义镜像（mac Dock bounce + win flashFrame + 聚焦闩锁，每目标一次）。 |
| `update-coordinator.ts` | mirror | `packages/desktop/updater.ts`（相位机/焦点 nudge/单飞/quitAndInstall 武装）、`packages/desktop/update-headless.ts`（Swift 腿同相位） | 更新编排的相位/注意力/安装语义镜像（§22.3.5）；传输面有意不同（见 update-http-executor）。 |
| `update-dialog.ts` | different-adopted | `packages/dsh-chamber-client-ui-settings-bridge`（UpdateSection / update-store / update-gate） | chamber 的更新面是 settings 普通状态行，无对话框/遮罩窗口（design 11 §2 无弹窗硬约束）。 |
| `update-error.ts` | different-adopted | `packages/desktop/updater.ts`（failureKind + 相位保持 + 一次性 restartFailureText） | 无上游 preparationFailure 家族（停止失败/任务变更/任务不可用）——chamber 没有安装前任务检查面。 |
| `update-http-executor.ts` | different-adopted | `packages/desktop/updater.ts`（idle 看门狗 + 忽略迟到事件） | registry 明载：替换 electron-updater 传输需注入私有字段（Electron 升级即碎），chamber 改用外部 watchdog + 忽略迟到事件。 |
| `update-journal.ts` | mirror | `packages/desktop/update-journal.ts`、`packages/desktop/update-journal.test.ts` | 白名单字段 JSONL 取证日志同名镜像（同 env 开关 DSH_DESKTOP_UPDATE_JOURNAL_DIR、同白名单、失败自禁用）。 |
| `update-overlay.ts` | different-adopted | `packages/desktop/main.ts`（唯一 BrowserWindow）、settings-bridge UpdateSection | 上游用遮罩子窗阻塞父窗输入；chamber 只有一个主窗 + settings 状态行，无遮罩面。 |
| `update-presentation.ts` | mirror | `packages/desktop/preload.cts`（toUpstreamUpdatePresentation 相位映射）、`packages/desktop/updater.ts`（failureKind）、`packages/desktop/upstream-seats.test.ts`（S-52 失败归类） | 对官方设置壳的相位/失败归类呈现契约镜像（downloaded→ready、downloading→download…）；上游的本地化文案面不镜像（文案在 settings 壳）。 |
| `update-schedule.ts` | mirror | `packages/desktop/update-schedule.ts`、`packages/desktop/update-schedule.test.ts` | 600s 基准 ±20% 抖动、失败退避封顶 1h、同 env 名镜像；有意差异 = 非法 env 回退默认并 loud 警告而非抛错。 |
| `web-document.ts` | different-adopted | `packages/control-plane/src/static-serving.ts`、`packages/control-plane/src/instance-proxy.ts` | 静态前端与请求转发由控制面 loopback origin 提供，不使用上游 `dsh-app:` scheme / boot 注入 / cookie 转发。 |
| `welcome-api.ts` | not-applicable | 无 | 欢迎 API 与「是否需要登录」判定；chamber 无账号面。 |
| `welcome-backend.ts` | not-applicable | 无 | 欢迎后端连接（账号流）；不采用。 |
| `welcome-window.ts` | not-applicable | 无 | 欢迎窗口；不采用。 |
| `windows-layout.ts` | mirror | `packages/desktop/main.ts`（WINDOWS_TITLEBAR_HEIGHT = 40）、`packages/desktop/preload.cts`（同值副本） | caption 高度常数逐值镜像（上游 40），两份副本相等由 upstream-seats 钉住。 |

### 计数与落点

| 分类 | 计数 | 登记方式 |
|---|---|---|
| mirror | 20 | 四条 `mirror.dsh-desktop-*` 条目 + 各自 relatedGates（本表逐行给出对照点） |
| different-adopted | 17 | 逐条写进对应 mirror 条目的 rationale / evidence（本表给出对照点与差异） |
| not-applicable | 24 | 本节一行式「有意不采用」列表（welcome/account/mandatory-update/browser-guest 等上游桌面产品面），不建条目 |
| **合计** | **61** | — |

bucket 明细：mirror = crash-report / fatal-recovery / ipc / keybindings / keyboard / locale / preload-app /
preload-platform / preload-theme / preload-windows / quit-confirmation / single-instance / startup-error / tray /
update-attention / update-coordinator / update-journal / update-presentation / update-schedule / windows-layout。
different-adopted = backend-controller / core-package-set / host-process / host-protocol / main / microphone-permissions /
node-environment / owned-directory / paths / project-manager / release / runtime-tree / update-dialog / update-error /
update-http-executor / update-overlay / web-document。not-applicable = account-backend / background-notice / browser-guests /
client-metadata / client/WelcomePage.tsx / client/styles.d.ts / client/welcome.tsx / directory-picker / mandatory-update-ipc /
mandatory-update-policy / mandatory-update-window / platform-ipc / platform-view / policy-test-auth / preload-browser /
preload-mandatory-overlay / preload-mandatory / preload-menu / preload-platform-account / preload-update-dialog /
preload-welcome / welcome-api / welcome-backend / welcome-window。

门覆盖：`mirror.dsh-desktop-update-chain` 原有的 `packages/desktop/upstream-seats.test.ts` 已迁到 carrier 条目
（S-51 文档平台标记 / S-52 dshDesktop 载体与失败归类归载体席位）；`upstream-seats.test.ts` 在 desktop 套件内执行
（`packages/desktop/scripts/test.mjs`），非新增 C 编号门。

## 4.6 手工移植登记（hand-transplant register）

本节登记**手工移植 / 镜像上游形态**的面：上游锚（当前 pin 的 vendor 树）→ 本仓落点、移植形态、有意分歧 / 我方增量、今日钉法、升 pin 复核触发。
人工台账，与 §4.5 同规矩**无 C 编号门**；文件级分类（`[own]` / `[patch-*]` / `[pure]` / `[dropped]`）仍归 §2 / §9 生成块，本表不重复；版本值不进本表。

**评审义务**：新增这样的面（或上游新增的占用者 / 键值被本仓接手）时，先补本表一行，并按 §7 第 5 步交用户裁决**采纳 / 跳过 / 替换**——默认处置只有「上报待裁」，不得默认拒绝、也不得静默跟随。升 pin 时按 §7 第 6 步逐行照面复核。

**移植形态词**：形态副本（上游组件 / 标记的 markup 逐字复刻）｜逐字副本（源码级复刻）｜行为镜像（语义等价、实现不同）｜声明转移（座席 / 契约声明的所有权转移）。

| 上游锚（vendor 树） | chamber 落点 | 移植形态 | 有意分歧 / 我方增量 | 今日钉法 | 升 pin 复核触发 |
|---|---|---|---|---|---|
| `ui-workspace/…/session-actions/ArchiveSession.tsx` 的 `ArchiveSessionRowButton`（`sidebar.workspaces.session.row.action` order 100） | 侧栏 `ServerSectionRows.tsx` 行悬停动作簇（kebab 之后第二成员） | 形态副本 | 无障碍名参数化 `action.archive.aria`（上游用行菜单同款泛化名）；无 unarchive 半支（归档行不进本仓列表）；拖拽尾随 click 门；类名换 `.actionIcon` | `test/session-rows/session-row-actions.test.ts` | 上游改形态 / order / 文案键即重放并复核 aria 分歧 |
| `ui-primitives` 的 `HoverCard.tsx` + `overlay-top-margin.ts` 的 `overlayTopMargin` | `RowHoverCard.tsx` + client-core `hover-intent.ts` + `sidebar-chamber.module.css` 卡片盒 | 形态副本 + 行为镜像 | 打开判宽限、copy epoch、出屏即关、ResizeObserver；`overlayTopMargin` 公式逐行镜像（`max(min, (fullscreen ? 0 : 顶部净空) + 20)`） | C15（§6）+ `hover-intent.test.ts` | 上游修竞态 / 改净空公式 ⇒ C15 判红逼裁决 |
| `ui-workspace/…/rows/Rows.tsx` 的行首 / 悬停座席渲染（`sidebar.session.row.{leading,hover}`） | `ServerSectionRows.tsx` 行首座席与悬停卡 + `index.ts` 声明 + `contract/slots.ts` | 声明转移 + 行为镜像 | 只对本实例求值（外来源行自有标记）；只留 blank 半边守卫（本仓行数据无 archived 标记）；两席声明权本仓代持（vendor 补丁 13） | `seat-position.test.ts` / `sidebar-slot-declaration.test.ts` / C9 | 座席键或渲染位变先改 vendor 补丁 13；所有权回归上游 ⇒ 上报待裁 |
| `ui-sidebar/…/SidebarRoot.tsx` 的 darwin 顶部带 + `.topStrip` / `.logoRow` | `SidebarRoot.tsx` darwin 分支 + `SidebarRoot.module.css` | 形态副本 + 几何值镜像 | 带高 / 位移 / 内距逐值照上游；透明三组加 `[data-window-vibrancy]` 门；toggle 为本仓组件 | `test/leading/macos-top-strip.test.ts` + Swift 接线锁 | 带高 / 拖拽清单 / 净空变量变即同步（与表格第 2 行同批复核） |
| `ui-sidebar/…/HeaderLeadingControls.tsx` + module.css | `SidebarLeadingControls.tsx` + `index.ts` 注册（`shell.leading`） | 形态副本 + 声明转移 | 同 inject 面 / sidebar 命名空间；不写 id-order-priority；ShortcutsHook cast；控件顺序与键帽取法照上游 | `leading-controls.test.ts` / `leading-seat-wiring.test.ts` | 席位成员或注册形态变先裁决所有权；帧座挂载条件变复核重开入口不变量 |
| `ui-schedule/…/SessionScheduleMark.tsx`（`sidebar.session.row.leading`，`schedule-mark` order 10） | `server-section-controls.tsx` 的 `SessionScheduleIndicator`（行首座席 / 搜索行） | 形态副本（锚已换代：旧锚 `ActiveScheduleIndicator` 已退役） | 本仓 16px 闹钟 + `role="img"` + `aria/title = schedule.active`；上游 12px 时钟 + `data-session-schedule-mark` + 视觉隐藏计数标签；本仓去 margin-right 6px | 无自动化锁（本行为唯一登记） | 上游形态 / 规模变，或 `ui-schedule` 进 roster（不进 ⇒ 本仓回落是唯一渲染路径）⇒ 上报待裁 |
| 旧代上游搜索行的日程标记（当前 pin 的搜索行不渲染） | `ServerSectionSearch.tsx` 搜索行标记 | 行为镜像（旧代同址） | 投影外即 false；状态点前 / 标题后；无额外 blank 门 | 无自动化锁 | 上游重新引入 / 移除 ⇒ 与上一行同批复核 |
| `ui-workspace/…/rows/AnimatedRows.tsx` + module.css | `rows/animated-rows.tsx` + module.css（接 `ServerSection.tsx`） | 逐字副本 | 不深引（C16 只收 `export function`）；`.workspaceList` 非滚动容器 ⇒ 裁剪退化 | `animated-rows.test.ts` 逐字对拍 | 上游改体 / 常数即重放；若改走 C16 直穿可删副本（同批改 registry） |
| `ui-workspace/…/rows/Rows.tsx` 的 `useTitleMarquee` + 常数 | `session-title-marquee.ts`（接 `ServerSectionRows.tsx`） | 逐字副本 | 同常数；`data-scrolled` / `data-clipped` 由本仓样式消费 | `session-title-marquee.test.ts` | 上游改速度 / 最小揭示 / 停靠 / reduced-motion 即重放 |
| `ui-workspace/…/session-actions/ArchiveSession.tsx` 的 `SessionArchiveConfirmDialog`（`shell.overlay`） | `SessionArchiveConfirmDialog.tsx` + `session-archive-confirm.ts` | 形态副本 + 文案转录 | Modal 与入口归本仓；generic 活动行阶梯；框内 `role=alert` 失败行；单层 Modal | `session-archive-confirm.test.ts` | 上游改家族词表 / 文案键 / 停止语义逐条重放；座席归属变复核不叠加 |
| `ui-workspace` / `ui-sidebar` 的 `locales.ts` 键值（侧栏部分） | 侧栏 `locales.ts` 字典 | 形态副本（词典值逐字） | 键为本仓并集；行级动作名参数化 | `session-row-actions.test.ts` / `leading-controls.test.ts` 的值断言 | 上游改词值即重放；新增键先裁决归属 |
| 宿主 runtime service 的 fork 标题递增 | client-core `derive.ts` 的 `increasedForkTitle`（由 `sidebar-root-sessions.ts` 调用） | 逐字副本 | 无（rename 失败非致命） | client-core 测试 + `instance-api.test.ts` 锚 | 上游改递增规则即重放；跨包移动更新落点 |
| 官方应用内 Modal chrome（删除工作区的标题 / 描述 / pending 文案 + outline 取消 / 破坏性确认 + pending 行 + 框内失败） | `sidebar-root-dialogs.tsx` | 行为镜像 + 文案转录 | 焦点入框 / 归还 opener；四开启点单层闸门；来源消失撤武装（失败行除外） | `workspace-echo.test.ts` | 上游改 chrome / 文案键重放；该面退役 ⇒ 上报待裁 |
| `ui-workspace/…/session-actions/PinSession.tsx` 的两个入口（menu.item order 100 / row.action order 200）+ `rows/Rows.tsx` 的 `PinnedIndicator` | 侧栏 `ServerSectionRows.tsx` 行菜单首项 + 归档钮之后的悬停置顶钮 + 状态槽之后的静息标记；client-core 的置顶集投影与 unary 出口 | 形态副本（不注册官方座席：官方 ui-workspace 声明所在洞只声明不渲染，I-4 锁） | 无障碍名**照上游**用行菜单长名（行名参数化只留在归档钮上）；首落不含置顶序（design 06 §5）；失败走行级 `rowErrors` 槽（上游是 toast）；`pinSetKnown !== true` 时标记不出现、动作按 pin 方向出；静息标记盒 20×20 跟齐本仓动作盒且不另加左边距（上游 16×20 + `margin-left:6px`，差异源于本仓行 gap/动作盒结构） | `test/session-rows/session-row-actions.test.ts` + `test/session-state/vendor-session-fact-contract.test.ts`（上游形态 lockstep）+ `test/source-runtime/instance-api.test.ts`（wire 信封） | 上游改入口 order / 文案键 / 14px 字形 / 归档守卫 / 线协议即重放；座席顺序或形态变先改本行并按 §7 第 5 步上报裁决 |

## 5. 再生物登记

|再生物|源|提交纪律|
|---|---|---|
|renderer typert工件（gen-typert-remotes输出）|vendor typert/remote源码|**构建期生成、`.gitignore` 忽略，不提交**（`renderer/src/generated/`；升级后由 `build:renderer` 重生成）|
|host dist ×4（`dist/index.js`，含seed-open-in）+ `dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/index.js`/`lib/client.js`(+map)|chamber host包src / dsh-runtime src / mobile src|**构建期生成、`.gitignore` 忽略，不提交**（clean checkout 由 `pnpm run build:artifacts` 自举；C8共6组重建-比对硬失败盯陈旧——mobile产物由gateway逐字节seed，陈旧即线上锚点失效）；两个build脚本都带 `absWorkingDir`，产物与调用者CWD无关|
|boot manifest / perf-sizes|build:renderer|构建产物diff随批审查|
|schemastery桩loader（connection/web测试）|vendor source-only现实|新增vendor运行时导入面时同步补桩|

## 6. 保鲜自动化

`node scripts/upstream/verify-upstream-touchpoints.mjs`（除C8在正常路径下「重建-比对后原样还原」外只读；中断/并发/额外产物路径由整目录快照 + SIGINT/SIGTERM处理器 + `wx` 独占锁兜底）：
- registry单一来源与生成闭环（`registry.json` 为唯一机器来源）：三道命令：
  - `node scripts/upstream/registry-views.mjs --check|--write`：生成物保鲜（本表 §2/§9的GENERATED块）；手改生成块 ⇒ `verify-registry` 红。
  - `node scripts/upstream/verify-registry.mjs`：schema / canonical / 引用存在性 / deviations id / 覆盖面网（§2.x标题 ↔ 条目、`chamberNamedForks` ↔ `versionAnchor: chamber`、`excludedUpstreamDirs` ↔ `ensure-harness-vendor` 的EXCLUDED）/ 生成块字节一致。
  - `node scripts/upstream/check-anchors.mjs`：registry符号锚可解析 + 遗留 `文件:行` 锚预算棘轮（`anchors-budget.json`，只降不升）；`--report` 出漂移与测试面三分类，`--fix --file <md> [--apply]` 只回写「同行唯一可解析符号」的锚点、拒绝生成块。
- 参数守卫与退出码（措辞与脚本头注同源）：默认模式会就地重建并还原构建期生成物（唯一写盘路径），因此任何未知参数/位置参数都由 `verify-upstream-touchpoints-args.mjs` 判为用法错误——`--help`/`-h` = 打印权威用法文本、exit 0，不跑任何门、不写盘；未知参数（如拼错的 `--no-artifact-rebuid`）、位置参数、重复flag或 `--tags` 缺值 = exit 2（用法错误）且不先跑门；门硬失败 = exit 1；全部通过 = exit 0。拼错的flag以前被静默忽略并照跑全量写盘门，故这里响亮失败而非容错。判定逻辑是纯函数（单测 `verify-upstream-touchpoints-args.test.mjs`）。
- C1 pure字节恒等 / C3完整性（fork每文件分类、上游每文件裁决，漏 = 硬失败）/
  C5过期锚扫描 / C6 EXCLUDED存在性 —— CI在Bootstrap后fail-loud；
- C4 roster（covered/factory哨兵 + remote契约24的集合与顺序）—— 本地/CI均可；
- C7种子域锁步、C8生成物 == src（重建-比对，硬失败；写后原样还原，`--no-artifact-rebuild` 退回mtime advisory）、C9 vendor补丁锚**唯一**命中（硬失败）、C10版本锚一致性 + 活版本字面量白名单（硬失败，判据见 §3：运行时版本单一来源、六锚 + 3 fork等值、未登记「活」版本字面量即红、具名常量按上限1处白名单）—— CI与本地均跑（CI分pre/post-install两段）。
- C11–C14受保护集合与代耦合（硬失败，只读，CI两段都跑；判据纯函数在 `plugin-protection-gate.mjs`，负例测试随 `pnpm run test:upgrade-tools`）：
  C11运行时线族集合——F分量**只**认已提交的运行时锁文件闭包（见 §0；实例树物化时另做等价性交叉校验，允许差集 = 其他平台 `node-addon-system-*` / `libreoffice-kit-*`）；官方opt-in按登记白名单（`RUNTIME_FAMILY_OPT_IN_ALLOWED`，只登记实测在闭包里的名字；新增未登记/移除已登记都红）；锁文件原文出现 `@dsh-chamber/` 引用即红（F 来源被污染/取错锁文件——解析器只取 `@deepseek-ai/*`，故按原文判定）；同一闭包也是design 21 §6.11装后复验所用name→version事实的来源，但本门只判名字集（版本事实不进门禁）；
  C12 **profile契约锚**——上游源码仍以 `dsh.profile.bundles` 承载层列表、以 `dsh.bundle.patch` 声明层、web模板默认组合不变、profile workspace仍是 `nodeLinker: hoisted` + `autoInstallPeers: false`；**三个锚点文件（`packages/boot/app-boot/src/profile.ts`、`packages/boot/plugin-manager/src/operations.ts`（自上一代起 pnpm 转发与 reconcile 在此，CLI 仅入口壳）、`apps/cli/src/plugin.ts`）都必须可读**——树已部分物化时缺文件 = 改名/搬移（违规），只有整体未物化才降级为note；
  C13播种注册表结构——`HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一一对应；
  C14 manifest三方镜像 + rows行类型**单源**——宿主 manifest 字段集仍三方一致（`plugin-sync.ts` producer ↔ `preload.cts` ↔ `renderer/src/global.d.ts`，可选标记 `?` 不属于字段名；任一侧声明了该字段却读不出声明 ⇒ 按违规处理，绝不静默只比剩下两方）；**行类型是唯一定义**：`@dsh-chamber/dsh-chamber-wire/plugin-row` 声明 `PluginRow`/`PluginRowRole`，五个消费方（control-plane、client-core pass-through、preload.cts、renderer global.d.ts、settings-connections）只允许 import/export type 引用指定面且绑定期待名——出现 `interface|type` 同名本地重声明、或引用面漂移即红（单源字段集/role 并集逐字锚定）。负例覆盖"本地重声明（interface 与 type 两臂）、引用面改道/期待别名缺失、单源字段缺失或 role 并集漂移、单源换成不透明类型/读不到"；ipc-surface-mirror只覆盖宿主接口面。
  任一红 = 停升级、改派生（B₀ 快照 / F来源 / S注册表 / wire镜像），**绝不放行**——design 21 §6.11。
- C15悬停卡自持移植的上游退役门（硬失败；形状、常数与防伪判据见 §4行：①CLOSE侧每个 `onPointerLeave` arm 的守卫必须是已提交 `open` 本身或含 `open` 的合取（顶层 `||` 析取即红——`open || intentRef.current`/`open || true` 是修复而非已知形状），②OPEN侧以 `openDelayMs` 为延迟的dwell回调只 `setPhase('open')`、至多把该定时器赋值目标的 ref 清成 `null`（其他成员写即红）、不复查指针在场，③组件体内 post-commit 回调（`useEffect`/`useLayoutEffect`/`useInsertionEffect`）fail-closed：执行关闭/相位动作的回调必须逐字命中白名单化的 pinned 形状（预览淡出 / owner-disable / Escape），其余一律判红——只锁前两项、或只查回调内的 `*.current` 读取，会在上游把指针事实挪到模块作用域/helper 或在 commit/effect 层修好那天静默放行，④`POINTER_GRACE_MS`/`openDelayMs` ↔ `HOVER_CLOSE_GRACE_MS`/`HOVER_OPEN_DELAY_MS` 逐值锁步；判定为纯函数，单测随 `verify-upstream-touchpoints-args.test.mjs` 在 `test:upgrade-tools` 跑；pin树未物化时与C1同样响亮失败）—— CI与本地均跑（CI分pre/post-install两段）。
- C16 vendor源消费者清单与真实相对 import 双向一致（硬失败，只读，CI两段都跑；判定纯函数在 `verify-upstream-touchpoints-vendor.mjs`，负控随 `verify-upstream-touchpoints-args.test.mjs` 在 `test:upgrade-tools`/`test:scripts` 跑）：registry `vendorSourceConsumers` 与 `packages/<pkg>/src` 的真实相对 import 双向一致——登记的 (consumer, vendorFile) 必须仍被 import **且**符号集合逐条相等，每个符号在 vendor 文件里仍是 `export function`，未登记的 vendor 相对 import（或孤儿登记）即红；A 门（`pnpm run verify:package-boundaries`）读同一 registry 块放行；退役条件写在条目的 `retiresWhen`。登记行见 §3。
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
5. roster pass：covered/factory存在性、typert契约、新增官方行裁决；**侧栏新增内容面必须提请用户裁决，不得默认拒绝**——上游若在侧栏（`sidebar.*` 任一键：会话行/工作区行/页脚/设置/面板入口等）新增声明、新增占用者，或把内容注册进「已声明但本壳未渲染」的键，逐条列出并交用户裁决采纳/跳过/替换；默认处置只有一条：**上报待裁**，不得以「本壳不渲染」为由拒绝或静默丢弃（键仍被声明 ⇒ 第三方 `inject` 不会失败，面却不会出现，静默即漏裁决）。差集取法：`grep -rhoE "'sidebar\.[a-z.]+" vendor/harness-checkout/packages/client/ui-*/src/client/index.ts | sort -u` 对 chamber 侧栏 `packages/dsh-chamber-client-ui-sidebar/src/client/index.ts` 的声明表 + 各渲染点，逐键判定「已渲染 / 未渲染待裁」；裁决结果按 §2.7 登记行或 `STATUS.md` 偏差条落账；
6. 契约复验：contract-mirror表逐行（§4）+ 相关测试；移动锚点面额外跑
   `node scripts/upstream/verify-mobile-anchors.mjs --require-anchor-root`（严格模式：无锚点树、
   无client产物、插件源码抽不到、pin身份不可判定、或锚点树 `dsh-web-frontend` 版本与pin不一致都exit 1，见 §4登记行）——
   build-time 哈希 class token 与 attribute/role/slot 同列**硬失败**：pin bump 后零命中即 exit 1，
   按移动包 README「Anchor baseline」逐条重锚（含 `official-hover-card.ts` 的两个 CSS-module token）；插件管理页容纳层的 DOM 缝先跑 §3 末条的锁步门（`pnpm --filter @dsh-chamber/dsh-chamber-client-ui-settings-plugin-manager test`；跑在 `test:plugin-manager` 腿里，红了即形状已变，按本步重锚），再按 §3 末条 grep 复核（`data-plugin-panel`、页头/详情头两条 `data-window-drag`、页头行「标题块（首子，其内内容被整块隐去）+ 控件（末子）」的两子元素序列、分组缝 `data-plugin-group` 的「组头在前、`ul` 卡列表在后」形状）：零命中或形状变化 ⇒ 按 STATUS 偏差条裁决。
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
| `fork.dsh-api-gateway` | fork | `packages/api/gateway` | `packages/dsh-api-gateway` | C1, C2, C3, C5, C6 | G43, packages/dsh-api-gateway/test/behavior/client-uplink-rejection.test.ts, packages/dsh-api-gateway/test/patch-lock/base-path-normalization-lock.test.ts, packages/dsh-api-gateway/test/patch-lock/journal-stall-watchdog-lock.test.ts, packages/dsh-api-gateway/test/patch-lock/remote-stream-carrier-retry-lock.test.ts, test:api-gateway, typecheck:api-gateway, typecheck:connection, verify:upstream-lifecycle-contract | open |
| `seed.dsh-chamber-seed-open-in` | seed | `packages/host/open-in-app` | `packages/dsh-chamber-seed-open-in` | C1, C2, C3, C5 | — | aligned |
| `seed.dsh-chamber-client-ui-layout` | seed | `packages/client/ui-layout` | `packages/dsh-chamber-client-ui-layout` | C1, C2, C3, C5 | packages/dsh-chamber-client-ui-layout/test/document-theme.test.ts, packages/dsh-chamber-client-ui-layout/test/layout-store.test.ts, test:layout, typecheck:layout | aligned |
| `fork.dsh-chamber-client-ui-sidebar` | fork | `packages/client/ui-sidebar` | `packages/dsh-chamber-client-ui-sidebar` | C1, C2, C3, C5 | — | aligned |
| `mirror.dsh-api-session-controller-goal` | mirror | `packages/api/session-controller` | `packages/control-plane` | — | packages/control-plane/test/protocol/session-mux.test.ts, packages/renderer/test/session-state/source-mux-facts-goal.test.ts | accepted |
| `mirror.dsh-session-status-write-face` | mirror | `packages/api/session-controller` | `packages/dsh-chamber-client-ui-sidebar/src/client/status-write-face.ts` | — | packages/dsh-chamber-client-ui-sidebar/test/session-state/status-write-face.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts | accepted |
| `mirror.dsh-desktop-carrier-seats` | mirror | `apps/desktop/src` | `packages/desktop` | — | packages/desktop/test/ipc/bridge-shim-document.test.ts, packages/desktop/test/ipc/desktop-carrier-surface.test.ts, packages/desktop/upstream-seats.test.ts | accepted |
| `mirror.dsh-desktop-shortcuts-seat` | mirror | `apps/desktop/src` | `packages/desktop/shortcuts-bridge.ts` | — | packages/desktop/test/ipc/desktop-shortcuts-bridge.test.ts | accepted |
| `mirror.dsh-desktop-native-chrome-seats` | mirror | `apps/desktop/src` | `packages/desktop` | — | packages/desktop/chamber-lock.test.ts, packages/desktop/shell-locale.test.ts, packages/desktop/test/desktop-shell/fatal-report.test.ts, packages/desktop/test/desktop-shell/startup-recovery.test.ts | accepted |
| `mirror.dsh-desktop-update-chain` | mirror | `apps/desktop/src` | `packages/desktop` | — | packages/desktop/test/desktop-shell/updater-attention.test.ts, packages/desktop/test/desktop-shell/updater-main-wiring.test.ts, packages/desktop/test/desktop-shell/updater-watchdog.test.ts, packages/desktop/update-journal.test.ts, packages/desktop/update-schedule.test.ts | accepted |
| `mirror.dsh-client-hmr-events-endpoint` | mirror | `packages/client/hmr` | `packages/renderer/src/live-graph.ts` | — | packages/control-plane/test/page-channel/page-channel-flow.test.ts, packages/renderer/test/lifecycle/live-graph.test.ts | accepted |
<!-- GENERATED:registry:touchpoints.index:end -->
