# 上游触点登记与保鲜（upstream touchpoints）

- 阶段：upstream upgrade；触发：改 pin / 升级 dsh，或任何触点结构（fork 副本、深引、契约镜像、covered/assembly 行、生成物）变化；Owner：触点登记 owner（`scripts/upstream/registry/registry.json`）与升级负责人；Timebox：预检 + 审计 ≤2 小时；扩散到具体面按该面 owner 另计
- 退出标准：§6 门全绿（C1/C3–C16；C8 按模式）、§2/§9 生成块与 registry 一致、§7 八步收口；自动化入口：`scripts/upstream/verify/verify-upstream-touchpoints.mjs`、`registry-views.mjs --check/--write`、`verify-registry.mjs`、`check-anchors.mjs`、`preflight-vendor-pin.mjs`；证据：门输出与 C2 报告；升级叙述发版时写 `CHANGELOG.md`，开放偏差进 `docs/progress/STATUS.md`

> 登记 dsh-chamber 对上游 dsh（deepseek-harness）的全部接触面（fork 纯度、深引 vendor、契约镜像、covered/assembly 行、生成物）与升级 tag 后的保鲜闭环。**单一来源 = `scripts/upstream/registry/registry.json`**（路径 / 分类 / 判据 id / 偏差 id / 原因）；§2/§9 的表格即其生成视图（`<!-- GENERATED:registry:… -->` 块**禁止**手改；重生成 `node scripts/upstream/registry/registry-views.mjs --write`，保鲜门 `node scripts/upstream/registry/verify-registry.mjs`）；`verify-upstream-touchpoints.mjs` 启动即读同一份。
> 机械门：C1–C16（C11–C14 插件受保护集合门、C15 悬停卡移植退役门、C16 vendor 源消费者双向门；CI 两条腿 Bootstrap 后 pre-install 跑 `--no-artifact-rebuild`（C1/C3–C16，C8 advisory）、post-install 跑完整门（C8 重建-比对硬失败）；C2 本地 advisory）。基准值不在本表：pin 单一来源 `harness.commit`（== submodule gitlink）、运行时锚 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `@deepseek-ai/dsh`、fork 版本各 `package.json`（对拍门 = C5/C10）。本表只登记结构性触点与判据。

## 0. 结构速查（只登记结构与判据，不记录版本值）

- vendor 链接数由 `ensure-harness-vendor` 断言 == 锁文件 importer 集合——源码线，不是 F；运行时线族集合（F）= `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包里的 `@deepseek-ai/*` 名字集合（C11 硬门）：含核心 `dsh`/`dsh-base`/`dsh-web-app`，不含 dev/test 与源码线 harness 段；官方 opt-in（`dsh-experimental-*`）只放行**登记白名单**内的名字（运行时根包自己声明的 opt-in 依赖属于 F；未登记名字出现/已登记名字不再出现都红）。本行与上一行是两条线，数量相近但集合不同，不可互推；其余计数（typert remote 装配契约 30 的挂载表定序、covered/factory 两集合、种子域 `clientGraph/graph`、`gitWorkTree/previewCreate`、`archiveCleanup/probe`、`openInApp/probe`）以 §3 与 §6 的门/源码为准（C4、C7 双门）。

### 0.1 改动层索引（owner map；只做链接，不复述判据）

“本仓对上游的改动”按**机制**分四层，物理位置跟着机制走；每层内容与判据归其 owner：① 依赖补丁（第三方 npm 包，仓内 `patches/` + 根 `patchedDependencies`，登记 = registry `patches`）→ `registry.test.mjs` / `upstream-patches.test.mjs`；② 构建期源码补丁（vendor 树零写入，`vendor-patches.mjs` 即注册表）→ C9 + `vendor-patches.test.mjs` + `verify-vendor-patch-applied`；③ in-repo fork 副本（`dsh-client-connection`/`-web`/`-api-gateway` + chamber-named layout/sidebar/seed-open-in，registry `entries` 的逐文件 `classify`）→ C1/C2/C3/C5/C10 + 预检；④ 运行时页面适配（gateway 代理上游 index 文档的一行 `<script>`，`html-inject.ts` + design 17 §10.5）→ `gateway-proxy.test.ts`。
新增一类“改上游”的机制 = 新层，必须同批在此登记 owner 与登记源；[`types/vendor-modules.d.ts`](../../../types/vendor-modules.d.ts) 不改上游任何字节，只是编译期消费面（登记见 §3 的 deep-import 与 roster）。

## 1. 标记约定（每文件分类）

|标记|含义|机器校验|
|---|---|---|
|[pure]|与上游锚逐字节一致|C1：不一致即硬失败（除非登记 [patch-*]）|
|[patch-add]|补丁仅追加（如package.json追加脚本），上游内容原样保留|C3（放行差异）|
|[patch-mod]|修改上游内容（chamber语义面）|C3（放行差异）|
|[patch-comment]|仅注释级差异（chamber说明/rebase日志）|C3（放行差异）|
|[own-divergent]|结构/内容chamber自有、仅跟踪上游增量（tsconfig构面、base.css）|C3（放行差异）|
|[own]|chamber自有文件/目录（上游无对应物）|C3：漏登记即硬失败|
|[dropped]|上游文件有意不镜像（host半/tests/tsdown/README/文案目录…）；以 `/` 结尾的条目表示目录前缀|C3：漏登记即硬失败|

锚 = fork `package.json` version + `harness.commit`（两者同时漂移才算跟随；任一过期C5硬失败）。

### 1.5 权威梯度与冲突裁决（registry `authority` 字段引用本节）

- `upstream`：pin 住的上游实现/形状是权威，我方只登记在案的补丁（`classify.patched`/`own`/`dropped`）；上游变 ⇒ 我方跟随（重放或改登记），禁止反向解释，C1/C3/C5 硬失败兜底；`chamber`：chamber 自持（上游无对应物，或官方注册被 chamber fork 替换，design 20 §2.2）；只以本仓源码为准，上游同域变化先裁决是否退役/再登记，未裁决不得静默跟随；其它裁决：版本值只认单源（`harness.commit` / 运行时锁 / 各 fork `package.json`），本表与生成块都不记版本值；`status: accepted` 必须带 `rationale`（理由随条目走）；`authority: chamber` 的条目必须带非空 `retireWhen`（一句可判的退役触发）、其余 authority 不得携带（校验在 `scripts/upstream/registry/registry.mjs`，能力面触发由 `verify-capabilities.mjs` 在命中时打印）；符号锚（`registry.entries[].symbols`）写 `path#symbol`（退化 `path#=literal:<唯一子串>`），解析门 = `check-anchors.mjs`。

## 2. fork-mirror 登记（逐 fork）

### 2.1 `packages/dsh-client-connection`（上游 `packages/client/connection`）

上游 `packages/client/connection` 的 shadow fork：`[pure]` 面 = `src/` 核心 + 双语 README（client 构面小项以脚本计数为准）；逐文件分类表由 registry 生成（下方 GENERATED 块即清单），升级时按 §3 重放。

<!-- GENERATED:registry:touchpoints.fork-mirror.connection:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.i18n.yaml` | [own-divergent] | chamber 冻结说明面（不随 pin 追上游 README；当前字节是上游文本的 chamber 裁减/改写版，非逐字副本：en 删 installConnection 内部段、zh 另有数段改写；上游文档更新有意不镜像） |
| `README.md` | [own-divergent] | chamber 冻结英文说明面（同 README.i18n.yaml；当前字节非上游逐字副本） |
| `README.zh.md` | [own-divergent] | chamber 冻结中文说明面（同 README.i18n.yaml；当前字节非上游逐字副本） |
| `package.json` | [patch-mod] | 追加 chamber test 脚本 + 删除死发布面 files/main/types（本仓不构建 lib、无发布路径；exports 面保持上游 lib 目标供 renderer 按包名消费；版本行随上游推进）；deps 面按本仓消费面裁剪（不逐字镜像上游 host/dev 依赖集合） |
| `src/api-path.ts` | [patch-mod] | 追加 resolveInstanceBasePath + 头部 chamber 说明（basePath 语义，design 05 §6） |
| `src/client/connection.ts` | [patch-mod] | erasableSyntaxOnly 显式字段改写（两个构造参数属性）+ 顶部 chamber 说明 + 若干上游 JSDoc 压缩删除；其余逐字节上游（重锚：loopEpoch 守卫与 CONNECTION_BACKOFF_MAX_MS 导出退役，改由原生 reconnect/setNetworkAvailable） |
| `src/client/index.ts` | [patch-mod] | 当前代重锚：apply(ctx, config: SyncedConfig<ConnectionConfig>) 从第二参取 recovery 时序（上游 alpha.1 签名；已退役的 __DSH_CONNECTION_RECOVERY__ 页面全局不再读取，ClientTransportGlobal 的该全局声明随上游删除）→ 读 entry Context 的 chamberBasePath → installConnection({basePath, recovery}) → 载波装配（design 05 §6）+ chamberTransport → carrier 分类（local 载体不装 navigator.onLine 网络门：浏览器离线时首连照发、offline 不停泊；远程保持上游门，design 14 §D4）+ SYSTEM_RESUME_EVENT/liveness 触发 + recovery-policy 转出；上游的 installConnection/ConnectionInstallOptions/transport.rpc 原样保留（ConnectionInstallOptions 加可选 carrier，省略 = remote = 上游行为；isLoopback 语义不变，仅注明它不判载体） |
| `src/client/rpc.ts` | [patch-mod] | 当前代重锚：WebConnectionRpcOptions + basePath 前缀拼装（stock 保持上游 document-relative 路由；上游二进制响应/uplink 原样保留）+ 502/504 带 details.phase=after-body 时抛出「可能已生效」文案（普通 Error + 稳定 message；design 27 §3.5；有界 fail-soft 读取，未知形态保持原 transport 文案） |
| `tsconfig.client.json` | [patch-mod] | chamber 构面：extends ../../tsconfig.json + vendor paths + files 列表（与上游 files 增量同步维护） |
| `tsconfig.host.json` | [patch-mod] | chamber 构面：extends ../../tsconfig.json + vendor paths + files 列表（src/peer.ts、src/client/rpc.ts、src/client/random-uuid.ts、src/authentication.ts、src/types.ts；上游删除的 browser-auth.ts 不再列入） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `tsconfig.check-base.json` | [own] | chamber erasable-only 校验构面 |
| `tsconfig.check-client.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `tsconfig.check-host.json` | [own] | chamber erasable-only 校验构面（files 与 host 同步） |
| `src/client/carrier-assembly.ts` | [own] | chamber 载波装配纯策略（basePath 扇出） |
| `src/client/liveness-triggers.ts` | [own] | chamber sleep/wake 活性触发（design 14；原生 reconnect + 离线门 + 唤醒事件旁路） |
| `src/client/recovery-policy.ts` | [own] | chamber 每来源恢复时序策略（远端 45s/5s，本地保持上游默认） |
| `test/` | [own] | chamber 自有测试（api-path/carrier-assembly/liveness-triggers/client-apply + fixtures（含 schemastery/fixture/recovery-config 桩 loader）） |
| `locale/` | [dropped] | 上游 fork 文案目录整体不镜像（chamber 侧文案与多来源界面自有实现，该 fork 无 locale 消费面）——按目录前缀登记，免逐语言追加；该目录只承载发布面文案数据，若上游把代码/类型放进此目录需重裁。 |
| `tests/` | [dropped] | chamber 无 tsdown / 不镜像上游测试 |
| `tsdown.config.ts` | [dropped] | chamber 无 tsdown / 不镜像上游测试 |
<!-- GENERATED:registry:touchpoints.fork-mirror.connection:end -->

### 2.2 `packages/dsh-client-web`（上游 `packages/client/web`）

`[pure]` 面 = `src/base.css` 逐字节（chamber token 表改由 renderer 入口 CSS `packages/renderer/src/styles.css` 引入）+ client 构面小项（以脚本计数为准）；逐文件分类表由 registry 生成。

<!-- GENERATED:registry:touchpoints.fork-mirror.client-web:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.i18n.yaml` | [own-divergent] | chamber README 对的哈希记录 |
| `README.md` | [own-divergent] | chamber 说明（boot kernel 差异/维护约定），非上游镜像 |
| `README.zh.md` | [own-divergent] | 同 README.md（中文镜像） |
| `package.json` | [patch-mod] | 描述/测试脚本/deps·peerDeps 面差异 + 删除死发布面 files/main/types（本仓不构建 lib、无发布路径；exports 面保持上游 lib 目标供 renderer 按包名消费；版本行随上游推进）；alpha.1 delta = 新增 devDep @deepseek-ai/dsh-package-manifest（seed 静态 module-manifest 类型面）；deps 面不逐字镜像上游 host/dev 依赖集合 |
| `src/boot.ts` | [patch-mod] | N-ctx boot kernel（extraRows / __ModuleLoader__ / configureContext / 异步 dispose）；alpha.1：上游把 module system dispose 收进单壳 dispose，chamber 的 module system 是页面级共享（window.__DSH_MODULES__ 缓存、页面 teardown 才拥有生命周期）⇒ 单壳 dispose 不销毁 modules（:177 偏差注释 + boot-nctx-dispose.test.ts 源锁钉住） |
| `src/index.ts` | [patch-mod] | 入口差异（module-system 宿主接线） |
| `src/platform.ts` | [patch-mod] | PLATFORM_MODULES/静态表 chamber 接线（C3 偏差：ui-primitives 不 seed）+ 重放上游 STATIC_MODULE_MANIFEST_EXPORT 常量（seed 消费；平台词表不随上游新增） |
| `src/seed.ts` | [patch-mod] | seed 行 chamber 接线（extraRows/__ModuleLoader__；C3 偏差同步）；alpha.1：getStaticModules(): readonly DshClientModuleManifest[] 按上游静态 module-manifest 协议重放，compiledModule 在 vendor 源码消费形态下缺 __$dsh_client_module_manifest 导出时用本仓 platform(id, exports) 等价包装（manifest 存在则按上游严格校验、损坏即 throw；seed-manifest.test.ts 钉住） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths/检查面） |
| `scripts/test.mjs` | [own] | chamber 测试清单委托共享 runner（scripts/lib/test-manifest.mjs）：3 文件表 + configure-context 的 vendor register 参数 |
| `src/boot-rows.ts` | [own] | chamber 每实例 boot-rows（design 09 module D） |
| `src/boot-tolerance.ts` | [own] | chamber boot 容忍/恢复（design 09） |
| `src/extra-chunk-owners.ts` | [own] | chamber extra rows 的包内动态 chunk owner 登记/撤销（design 09） |
| `test/` | [own] | chamber 自有测试（boot-tolerance/boot-rows/configure-context + fixtures） |
| `src/apply-injections.ts` | [dropped] | 上游当前代的 index 注入表解释器，服务 apps/web 的 __DSH_BOOT_READY__/Host rows；chamber 不消费（index.ts 刻意不导出 applyIndexInjections，package.json 也无 ./injections 子路径），注入面由 host boot graph + N-ctx kernel 接管 |
| `src/boot-client.ts` | [dropped] | 上游当前代抽出的 bootClient/assertEntriesActive 组合；chamber kernel 在 src/boot.ts 内联 boot 建 entry+await+audit 半边并叠加 extraRows 合并 + boot-tolerance 容忍；entries.start/sync 协调半边在 chamber 无消费者（其唯一消费者 HMR 行被覆盖集 skip，见 chamber-covered.ts） |
| `src/mount.ts` | [dropped] | 上游当前代抽出的 mountClient；chamber kernel 的 mountApp 已含同一 uiRenderer inject 挂载并附 15s 超时兜底 |
| `tests/` | [dropped] | chamber 无 tsdown / 不镜像上游测试（dropped 噪声面：变化只报不计失败，见 preflight 的 isDroppedNoise） |
| `tsdown.config.ts` | [dropped] | chamber 无 tsdown / 不镜像上游打包配置（dropped 噪声面） |
<!-- GENERATED:registry:touchpoints.fork-mirror.client-web:end -->

### 2.3 `packages/dsh-api-gateway`（上游 `packages/api/gateway`，client 半）

`[pure]` 面以脚本计数为准；逐文件分类表由 registry 生成。

<!-- GENERATED:registry:touchpoints.fork-mirror.api-gateway:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.md` | [own-divergent] | chamber 包契约（职责/边界/模块；补丁与载体语义见 design 14 §D4），非上游镜像 |
| `package.json` | [patch-mod] | description/peer 集裁剪（host 依赖 dropped）+ chamber test 脚本 + 删除死发布面 files/main/types（本仓不构建 lib、无发布路径；exports 面保持上游 lib 目标供 renderer 按包名消费；版本行随上游推进） |
| `src/client/index.ts` | [patch-mod] | apply(ctx) 读 ctx.chamberBasePath → /api/remote.mux 落到实例前缀 + start(sinks, recoveryOverridesForTransport(transport))（design 05 §6）+ $stream 工厂组合 carrierFailed 发布 dsh-chamber:stream-carrier-failed 页面事实（design 14 §D4）+ 生命周期取证通道 dsh-chamber:stream-forensics（generation 就绪/丢失；卡死排查）；alpha.1：转出 isRemoteStreamCarrierFailure/RemoteStreamCarrierFailure，$stream carrierFailed 类型与 openRemoteStream reporter 谓词改 code 判定（auth 先于 carrier 的终态/重试顺序不变） |
| `src/client/journal-stream.ts` | [patch-mod] | 静默看门狗（design 14 §D4 卡死排查）：已开启的 journal 静默 ≥45s 时开一条旁路 sibling follow、只比对 opening cursor，仅当宿主确已前进才替换物理世代（新 opening 以 replace 全窗口收敛）；不设盲空闲重启；探针节奏按无进展次数放宽至 90s 上限（探针自身失败/超时同样放宽）；prepend 用户读带 60s 期限；alpha.1：重放 protected releaseBefore(cursor)（本 pin chamber 无调用者，看门狗保留） |
| `src/client/remote-stream.ts` | [patch-mod] | 载波重试策略：活连接世代下的后续载波失败改走有界退避重开，不再逃逸为终局 gateway/internal（design 14 §D4；退避纯函数在同包 own 文件 remote-retry-policy.ts，patch 形状由 test/patch-lock 钉住）；4401/4403 的 RemoteStreamAuthError 映射为终态 gateway/auth（P1-3）；alpha.1：载波失败分类改 isRemoteStreamCarrierFailure（carrierFailed 参数类型 RemoteStreamCarrierFailure），auth 分支仍在 carrier 之前（带 code 的 auth 子类先按 RemoteStreamAuthError 走终态，绝不进重试梯） |
| `src/client/stream-client.ts` | [patch-mod] | per-entry basePath（流载波 URL 拼装）+ 开帧发送前校验（socket 已被替换/正在关闭 ⇒ 载波失败，杜绝 RFC 6455 静默丢弃）+ 逻辑流首帧期限（单档 30s，按 endpoint+payload 摘要识别请求与连续超时计数，失败 inbox 走既有退避重开）+ 静默 socket 升级（首帧期限到期而当前 socket 本次尝试期间一帧未收 ⇒ replaceSocket() 换掉物理 socket，与连接泵 reconnect() 共用拆除道，不再在同一条静默载波上重发）+ socket 丢失后自行重排重连（1s 起、连接泵下令的重连不计失败、真实失败翻倍封顶 10s、成功即复位）+ WebSocket 握手期限 30s + socket 生命周期取证（lost/reconnect/attempt-failed/disposed/opening-timeout/socket-silent）+ teardown 分支：逻辑流在其整个生命期内该 socket 零帧且生命期 ≥ 表值 SILENT_TEARDOWN_MIN_MS（15s）⇒ 同一条换 socket 升级（覆盖 20s 探针 abort 早于 30s 预算的已开启会话形态）+ 非 OPEN socket（closed/closing/CONNECTING）绕过 60s rebuild 窗并按 50ms 下限防抖 + 证据型拒绝在窗口边做一次延迟替换（可到达的两条腿：opening 期限——拒绝 reason 可为零帧派生的 socketNoFrame 或 openingStall；teardown 的 teardownNoFrame；执行器 arm 与 carrier-throttle-expired/carrier-rebuild 的取证都取 reducer 的裁决 reason，不取请求侧字面量；handshakeTimeout 在 union 里但本驱动无发射点：握手到期只 reject 连接候选，pre-OPEN 走 non-OPEN bypass 或泵的 maintain 退避）+ lane 拒绝不排期（启发式不是载波证据；排期它会把每窗口一次的上限变成健康载波上 60s 一次重建；分类由 dsh-stream-state 的穷尽表 + isEvidenceBackedRebuild 持有（reducer 包拥有策略，执行器只问一次））+ carrier-throttled/throttle-expired/carrier-rebuild-bypass 取证；alpha.1：新增 RemoteStreamCarrierFailure 接口 + RemoteStreamCarrierError（code=gateway/carrier-lost）+ isRemoteStreamCarrierFailure（排除 Host RemoteError）；connect 失败分类与 withReopenSpread 改 code 鸭子类型（chamber reopenJitter/取证补丁全保留） |
| `src/remote-error-codes.ts` | [patch-mod] | P1-3 auth close 词表：登记 gateway/auth{closeCode}，供 remote-stream 把 4401/4403 映射为终态 gateway/auth（不重试） |
| `tsconfig.client.json` | [patch-mod] | chamber client 构面（files 表随新增 client 文件同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（files 表随新增 client 文件同步） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `src/client/remote-retry-policy.ts` | [own] | chamber 载波退避纯函数（retry first/base/max 与无世代等待上限）+ 可中止等待 + 开帧身份键 streamOpeningKey + mux 自查重连重排区间 1s/10s（零 import，可脱离 vendor 图行为单测）；首帧期限、静默 teardown 下限与 WebSocket 握手期限均已单源于 @dsh-chamber/dsh-stream-state 的 tables.ts，本文件不再持有副本 |
| `src/client/stream-auth.ts` | [own] | chamber auth-close 判定叶（4401/4403 分类 + RemoteStreamAuthError 契约；零 import，可脱离 vendor 图单测） |
| `src/client/stream-carrier-fact.ts` | [own] | chamber 载波故障页面事实（有界计数 + dsh-chamber:stream-carrier-failed；零 import，可注入 dispatch 单测） |
| `src/client/stream-forensics.ts` | [own] | chamber 流生命周期取证事实（有界计数 + dsh-chamber:stream-forensics：socket lost/reconnect/disposed/silent、opening-timeout、generation ready/lost（detail 带 endpoint、streamId、waitedMs、best-effort sessionId）；零 import，可注入 dispatch 单测） |
| `src/client/stream-stall-policy.ts` | [own] | chamber 静默看门狗纯决策（阈值 + probe/wait 判定；零 import，可脱离 vendor 图行为单测） |
| `tsconfig.check-base.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `tsconfig.check-client.json` | [own] | chamber erasable-only 校验构面（files 与 client 同步） |
| `test/` | [own] | chamber 自有测试（退避真值表 + 可中止等待 + 载波事实契约 + patch 源文本锁 + 载波自救行为用例 test/behavior/mux-self-heal.test.ts） |
| `README.i18n.yaml` | [dropped] | 上游 README 不携带上游镜像；chamber 自有 README.md 以 [own-divergent] 登记，fork 描述仍在 package.json |
| `README.zh.md` | [dropped] | 上游 README 不携带上游镜像；chamber 自有 README.md 以 [own-divergent] 登记，fork 描述仍在 package.json |
| `locale/` | [dropped] | 上游 fork 文案目录整体不镜像（chamber 侧文案与多来源界面自有实现，该 fork 无 locale 消费面）——按目录前缀登记，免逐语言追加；该目录只承载发布面文案数据，若上游把代码/类型放进此目录需重裁。 |
| `src/access.ts` | [dropped] | 上游新增的 host-half RBAC 策略文件（gateway 宿主侧 decide/allows）；本仓 fork 只取 client half（与 src/index.ts、src/stream-server.ts、src/types.ts 同口径不复制）。 |
| `src/index.ts` | [dropped] | 上游 host 插件入口（chamber 不镜像 host 半） |
| `src/stream-server.ts` | [dropped] | 上游 host 半流服务器（dropped） |
| `src/types.ts` | [dropped] | 上游 host/aux 类型文件（源码与 inert ./types 子路径均已移除） |
| `tests/` | [dropped] | chamber 无 tsdown / 不镜像上游测试（dropped 噪声面：变化只报不计失败） |
| `tsconfig.host.json` | [dropped] | host 构面不镜像 |
| `tsdown.config.ts` | [dropped] | chamber 不构建 lib / 不镜像上游打包配置（dropped 噪声面） |
<!-- GENERATED:registry:touchpoints.fork-mirror.api-gateway:end -->

### 2.4 有意未镜像表（跨 fork 汇总）

host 插件入口/半、上游 `tests/`、`tsdown.config.ts`、上游 README 的镜像（chamber 自有 `README.md` 按 [own-divergent] 携带）、构建产物 `lib/` 一律不镜像；升级时按下列判据裁决，判据随重锚复核（逐 tag 叙述属 `CHANGELOG.md` 与 git 历史）：

- fork 面：上游 counterpart 的 `src/` 有改动 ⇒ 逐文件重放并更新 §2.1–§2.3 的分类与原因；只有 `package.json` 版本行变化 ⇒ 仅同步版本标记（C5 对拍）。上游 workspace 成员增删：vendor 链接集合与根 `pnpm-lock.yaml` 随之变化；新增成员按 §5 裁决是否属再生物，删除成员须确认 `restore-lockfile-vendor-records.mjs` 的守卫已跳过该记录（见 `dsh-upgrade-checklist.md` §4）；结构性触点：composite 首屏插件的 cordis `inject` 若由未覆盖的 extra row 提供，该行不挂载时首屏永远 PENDING；探针集合完全派生（记录与并集见 §3），上游改 inject 面无需登记名字。**平台词偏离的跨代耦合（后果登记于 `docs/progress/STATUS.md`）**：`ui-primitives` 不 seed、由 covered factory 回答（C3 偏差）；实例侧 `ui-sidebar-documentpreview` 的代码预览依赖与 composite 同代的 `ui-primitives`（`CodeBlock` 的 `contentRef` 与 `[data-code-block-content]` 是其唯一滚动/行定位锚点），composite 比实例旧一代时该行失去独立滚动区与行定位（纯文本仍可用）——版本歪斜把它变成可见功能面；平台词 vs host-graph 行：`client/web` 的平台词表（`platform.ts`/`seed.ts`）与 host-graph 行是互斥裁决——把行当平台词 seed 会让启动失败（C3 不变量）；上游新增平台词时先裁决归属。宿主半的 `webServer` 可选注入会影响 connection 宿主半的重放，须逐面复核。
### 2.5 `packages/dsh-chamber-seed-open-in`（上游 `packages/host/open-in-app`）

> chamber-named fork（design 20 §6，fork & supersede）：不覆盖上游包名、随 chamber 版本发布（`versionAnchor: chamber`，C5 版本等值豁免）；上游 `packages/host/open-in-app` 保留在 vendor 树作 C1 锚，因此不进 `EXCLUDED_UPSTREAM_DIRS`。分类表由 registry 生成：

<!-- GENERATED:registry:touchpoints.fork-mirror.seed-open-in:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.md` | [own-divergent] | chamber 包契约（职责/边界/模块；域语义见 design 20 §6），非上游镜像 |
| `package.json` | [patch-mod] | chamber seed package（自有名字/版本/构建入口；upstream 名与发布面不复制） |
| `src/index.ts` | [patch-mod] | typert 门面取代 webServer 路由 + Config schema + SSH 休眠门（design 20 §6.1） |
| `src/shared.ts` | [patch-mod] | wire 契约家：上游三条 webServer 路由常量 → typert Remote 方法名 + 域载体（design 20 §4.1/§6.1） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths + 本包 files） |
| `dist/index.js` | [own] | chamber 构建期生成产物（不提交；clean checkout 由 pnpm run build:artifacts 自举；C8 逐字节重建-比对；上游无对应文件） |
| `scripts/build.mjs` | [own] | chamber esbuild 产物构建 |
| `scripts/test.mjs` | [own] | chamber 测试清单委托共享 runner（scripts/lib/test-manifest.mjs）：文件表 + core.test.ts 的 transform-types/vendor-stub 加载参数 |
| `src/core.ts` | [own] | chamber 域核心：上游 apply() 的目录/图标/拉起状态机（去掉路由与 SSH 门） |
| `test/` | [own] | chamber 自有测试（域契约 + 载荷拒绝矩阵 + vendor stub loader） |
| `README.i18n.yaml` | [dropped] | 上游 README 不携带上游镜像；chamber 自有 README.md 以 [own-divergent] 登记，域语义见 design 20 §6 |
| `README.zh.md` | [dropped] | 上游 README 不携带上游镜像；chamber 自有 README.md 以 [own-divergent] 登记，域语义见 design 20 §6 |
| `locale/` | [dropped] | 上游 fork 文案目录整体不镜像（chamber 侧文案与多来源界面自有实现，该 fork 无 locale 消费面）——按目录前缀登记，免逐语言追加；该目录只承载发布面文案数据，若上游把代码/类型放进此目录需重裁。 |
| `src/internals.ts` | [dropped] | 上游测试接缝（本包的接缝走 OpenInAppCore 构造注入，不需要它） |
| `tests/` | [dropped] | 上游测试不镜像（本包 test/ 覆盖域契约） |
| `tsdown.config.ts` | [dropped] | 上游打包配置（本包走 scripts/build.mjs） |
<!-- GENERATED:registry:touchpoints.fork-mirror.seed-open-in:end -->

### 2.6 `packages/dsh-chamber-client-ui-layout`（上游 `packages/client/ui-layout`）

> chamber-named fork（design 06 — 侧栏宽度共享）：不覆盖上游包名，上游 `@deepseek-ai/dsh-client-ui-layout` 保留在 vendor 树（C1 锚）并被本 fork 深引其 frame 面（`AppFrame.tsx` 三列网格、`columns.ts` 几何、`service.ts` LayoutController、`theme-presenter.ts` 文档投影）——renderer 的 `deepseekSource` 别名编译真实上游源，本 fork 不重实现 shell。登记形态 = registry 的 chamber-named 类（`versionAnchor: chamber`，按 `registry.mjs` schema 记 `type: seed`）；上游包仍在官方/gateway 部署形态服役，故**不**进 `excludedUpstreamDirs`（那是三个同名 shadow 替换副本的清单）。覆盖 = C1/C3 分类表 + C2 的 tag 间报告 + 升级预检的 vendor-seam 面（预检的 `FORK_PATHS` 只含 shadow 副本，故本条的 client index/store 上游改动以 C2 报告与 vendor-seam 形式出现，不以 fork-replay 形式出现；把它错记成 shadow fork 会让深引的 frame 文件从 vendor-seam 降级成 fork-unregistered）。分类表由 registry 生成：

<!-- GENERATED:registry:touchpoints.fork-mirror.layout:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.md` | [own-divergent] | chamber fork 说明（动机/形状/深引 frame 面），非上游镜像 |
| `package.json` | [patch-mod] | chamber 自有包名/版本/测试脚本/deps·peerDeps 面（上游发布面与类型入口不复制；版本行不随上游） |
| `src/client/index.ts` | [patch-mod] | 上游 client index 逐字副本上的 chamber 增量：store 换本包 stores.ts（共享+持久侧栏宽度，design 06）+ 根 standard prop chamberFileApiBase（design 09 §3.6）+ 活动视图门控的文档级 theme 投影；frame/service/columns/theme-presenter 深引 vendor 源，inject 面、注册顺序与 priority 不变；alpha.1：页面级单例 ThemePresenter 创建处补 start?.()（MutationObserver 刷新 meta[name=theme-color]，仅创建时一次、永不 dispose；theme-presenter-lifecycle.test.ts 钉住，design 06 §4.6） |
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
| `locale/` | [dropped] | 上游 fork 文案目录整体不镜像（chamber 侧文案与多来源界面自有实现，该 fork 无 locale 消费面）——按目录前缀登记，免逐语言追加；该目录只承载发布面文案数据，若上游把代码/类型放进此目录需重裁。 |
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

> chamber-named fork（design 05 — 多来源侧栏）：不覆盖上游包名，上游 `@deepseek-ai/dsh-client-ui-sidebar` 保留在 vendor 树（C1 锚）并被本 fork 深引其同一 `shell.leading` 席位以自建 `SidebarLeadingControls`（上游同形 clone）占座；上游 `HeaderLeadingControls` 不镜像、也不被源码路径消费——本 fork 只在同一座位上重实现多来源列表、归档管理器与来源信号灯。登记形态 = registry 的 chamber-named 类（`versionAnchor: chamber`，`type: fork`；`registry.mjs` 的 chamberNamedForks 不变量接受 fork 与 seed 两种类型，两者都必须带文件级分类，否则 C1/C3 覆盖不到）。上游包仍在官方/gateway 部署形态服役，故**不**进 `excludedUpstreamDirs`。覆盖 = C1/C3 分类表 + C2 的 tag 间报告。分类表由 registry 生成：

<!-- GENERATED:registry:touchpoints.fork-mirror.ui-sidebar:begin -->
| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `README.i18n.yaml` | [own-divergent] | chamber README 对的哈希记录 |
| `README.md` | [own-divergent] | chamber 多来源侧栏说明，非上游镜像 |
| `README.zh.md` | [own-divergent] | 同 README.md（中文镜像） |
| `package.json` | [patch-mod] | chamber 包名/版本/测试脚本（版本行走 chamber 发布） |
| `src/client/SidebarRoot.module.css` | [patch-mod] | 重实现样式（多来源列表/行悬停卡/归档管理器/来源信号灯）；当前 pin 上游已包含 More 菜单样式（.moreAnchor 锚点包装、.panelRow[aria-expanded=true] 悬停底色、.moreMenu 288px + 视口上限）并把 .panelList 行距 4px→2px；本仓决定：不采纳（侧栏 More/条目 analytics 面），采纳时须整包重放该文件（design 06 §4.7；docs/progress/STATUS.md §4.2）；当前 pin 上游在本文件发布 --dsh-sidebar-* 变量契约与几何（inline-padding 8px、row-padding 12px、label-gap 6px、paint-inset 3px），本仓壳自持 12px inline padding 但发布其余三个词（消费方是随包出货的 ui-workspace/ui-settings-* CSS；这些组件在 .root 子树挂载就需要定义，缺失会让整条 calc/gap 声明失效——稳态它们不在场，当前只修官方 settings 壳的回落路径）；rc.3 对齐批：采纳上游 New-session 行几何（新增 .newSessionRow 行容器 + rail 纵排；.newSession 改为可伸缩内容、外边距归行，保留本仓自有 2px/12px 节奏），不搬 .railIn 入场动画与 [data-windows-titlebar] 行规则；More 菜单样式与 .panelList 行距仍不采纳；alpha.1：新增 .stateFailed 失败态 6px 圆点（与 .stateCompleted 同几何、--dsw-alias-state-error-primary 而非来源身份色） |
| `src/client/SidebarRoot.tsx` | [patch-mod] | 重实现：多来源会话列表（按工作区分组、搜索/排序/归档管理器/悬停卡片/来源信号灯）替换上游单来源 workspaces 浏览器；面板轴：宽态入口由每个来源自己的 server 头动作簇渲染（ServerSectionHeader：owning 来源用本壳 PanelHeaderEntry 真身；非活动来源经页面级 panel-axis 投影渲染 ForeignPanelHeaderEntry，未挂载且 connected 时回落 pin 默认组合的时钟快捷键），本文件的 sidebar.panellist 轴降为 rail-only（design 05 §2 / 06 §4.7）；当前 pin 上游已包含条目 analytics 与 More 启动器；本仓决定：不采纳（侧栏 More/条目 analytics 面），采纳时须整包重放该文件（design 05 §2 / 06 §4.7；docs/progress/STATUS.md §4.2）；rc.3 对齐批：New-session 行改为 .newSessionRow 容器并经 renderSlot("sidebar.session.action", { wide }, { children }) 渲染；More/条目 analytics 仍不采纳；alpha.1：行菜单 mark 已读/未读接线（onMarkSessionRead 经 keyed 漏斗，gate = 行自身来源的 reading 座席） |
| `src/client/contract/slots.ts` | [patch-mod] | chamber 座位契约（owner props 同名但按多来源扩展）；承接 ui-workspace 的 sidebar.session.row.{leading,hover} SlotMap 合并（座席所有权转移，vendor 补丁 13）；sidebar.panellist 的来源级措辞与面板选择器别名 PanelSelectorHook（= SnapshotSelectorHook<PanelInfo>）；当前 pin 上游已包含 sidebar.panellist.actions 洞与 SidebarPanelActionEntry/SidebarPanelActionsOwnerProps（entries/onOpen/onPinnedChange/onDismiss）、注入面 setPinned 与 trackEntryClick（ProductEventMap[sidebar_menu_click]）、hooks 的 entryPins/entryActions 快照，并把该洞并入根组件 props 的 slot 并集；本仓决定：不采纳（侧栏 More/条目 analytics 面，该洞与 panel-pins 一并 dropped），采纳时须整包重放该文件（design 05 §2 / 06 §4.7；docs/progress/STATUS.md §4.2）；rc.3 对齐批：采纳上游新增的 sidebar.session.action HOC 槽（SlotMap 行 + SidebarSessionActionOwnerProps { wide } + 根组件 props 并集）；alpha.1：E 两洞已裁（2026-11-23 用户授权推荐默认 = 不采纳）：本仓不声明 sidebar.panel.trailing / sidebar.panellist.trailing、无 owner props/工厂/组件（声明与实现均已删除），仅 vendor pin 保留声明（pin 事实登记于触点表 §4.6） |
| `src/client/index.ts` | [patch-mod] | apply：注册 chamber 侧栏 + 面板轴投影（sidebar.panellist 镜像 → 页面级 panel-axis 发布，供任意壳的非活动来源头渲染该来源自己的入口；一次性 selectPanel 意图由目标来源自己的壳消费；rail 供字形轴）+ workspace navigation 服务 + shell.leading 席位由本包 SidebarLeadingControls（上游同形 clone）占座；座席所有权转移后续：本包自行声明并渲染 sidebar.session.row.{leading,hover}（原声明由 vendor 补丁 13 删除）；当前 pin 上游在本文件接入 createPanelPins 与 entryActions、子洞表登记 sidebar.panellist.actions、注入面加 setPinned/trackEntryClick，并导出两个新 owner 类型；本仓决定：不采纳（侧栏 More/条目 analytics 面），采纳时须整包重放该文件（design 05 §2 / 06 §4.7；docs/progress/STATUS.md §4.2）；rc.3 对齐批：采纳 sidebar.session.action 的运行时子洞声明（{ kind: hoc, scope: root }）与 owner 类型导出；More/条目 analytics 面仍不采纳；alpha.1：inject 增嵌套 uiSession.sessionStatus（独立 ui-session-status 服务，未 inject 的嵌套 get 会抛）、删 sessionStatus 内联 cast（面归 session-status-face.ts）、订阅 readingReady 并发布页面级 reading 座席（publishReadingSeat，mark 门按行自身来源的座席）、E 两洞已裁（不采纳）：不再声明/注册 sidebar.panel.trailing，无自建工厂/组件 |
| `src/client/locales.ts` | [patch-mod] | chamber 文案表（含上游没有的工作区/来源操作）；当前 pin 上游已包含 panels.more（zh「更多」/ en「More」）一条 More 菜单文案；本仓决定：不采纳 More/条目 analytics 面，采纳时须整包重放该文件（design 05 §2 / 06 §4.7；docs/progress/STATUS.md §4.2）；alpha.1：采纳上游行菜单 mark 词典键 menu.markRead/menu.markUnread 与 status.failed（失败呈现），键为本仓并集 |
| `src/index.ts` | [patch-mod] | 包入口差异（module-system 宿主接线 + chamber 构面导出） |
| `tsconfig.json` | [patch-mod] | chamber 构面（vendor paths/检查面） |
| `scripts/test.mjs` | [own] | chamber 自有测试清单（按域分组的显式 manifest；verify:test-wiring 校验可达性） |
| `scripts/` | [own] | chamber 自有脚本（测试 manifest 与清单守卫） |
| `src/` | [own] | chamber 自有实现（多来源聚合、面板轴（panel-source 镜像 + ServerSectionHeader 头内紧凑入口）、来源降级、归档管理器、工作区变更/拖拽排序、client-plugin load kernel、席位 chrome、按上游逐字移植的 keyed-row FLIP 动画器 rows/animated-rows.* 等） |
| `test/` | [own] | chamber 自有测试（按域分组：session-rows/session-state/source-runtime/plugin-kernel…） |
| `locale/` | [dropped] | 上游 fork 文案目录整体不镜像（chamber 侧文案与多来源界面自有实现，该 fork 无 locale 消费面）——按目录前缀登记，免逐语言追加；该目录只承载发布面文案数据，若上游把代码/类型放进此目录需重裁。 |
| `src/client/HeaderLeadingControls.module.css` | [dropped] | 该组件的内部样式；上游文件不镜像、也不被消费——同一 shell.leading 席位由本包 SidebarLeadingControls.module.css（上游同形 clone）实现 |
| `src/client/HeaderLeadingControls.tsx` | [dropped] | 上游组件不镜像、不被源码路径消费；同一 shell.leading 席位由本包 SidebarLeadingControls.tsx 注册占座（src/client/index.ts；vendor-modules.d.ts 只声明本包用到的类型面） |
| `src/client/PanelIcon.tsx` | [dropped] | 上游当前 pin 新增的面板图标复用组件（sidebar.panel.icon factory 的图标面）：chamber 不采纳 More/panels 图标复用面、也不声明 sidebar.panel.icon 座位，故该文件无消费面——登记 dropped 以免 C1/C3 判为漏裁决（采纳 More 面时整包重放） |
| `src/client/panel-pins.ts` | [dropped] | 上游当前 pin 新增的面板固定/排序铺线（内存 store，无持久化）：chamber 未声明 sidebar.panellist.actions 洞、也不渲染上游的 More 菜单，故该文件无消费面——登记 dropped 以免 C1/C3 判为漏裁决（采纳 More 时整包再消费） |
| `src/client/scroll-handoff.ts` | [dropped] | 上游当前 pin 新增的滚动交接工具（sidebar.workspaces 的 useSectionScroller/hookContext 滚动交接面）：chamber 自绘多来源列表、不渲染 vendor sidebar.workspaces 座，故该文件无消费面——登记 dropped 以免 C1/C3 判为漏裁决 |
| `tests/` | [dropped] | 上游测试/快照不镜像（chamber 有自建 test/） |
| `tsdown.config.ts` | [dropped] | chamber 不构建 lib/（沿用上游模板形状但 chamber 树不产出该产物） |
<!-- GENERATED:registry:touchpoints.fork-mirror.ui-sidebar:end -->

## 3. deep-import 与 roster 登记

- renderer 深引 vendor：`@deepseek-ai/*` 一律经 vite workspace→src 别名与 `paths`；node 测试经桩 loader（`scripts/dev/test-loaders/test-connection-loader.mjs` 等）——不新增裸运行时 vendor 依赖。上游 patch 集合（§17-C，registry `patches`）与根/dev 腿的字节镜像 / 运行期派生见 §6 及 `registry.test.mjs` / `upstream-patches.test.mjs`；vendor 源直穿登记（门 = C16 + `verify:package-boundaries` 的 A 判据）：生产源里唯一「相对 import 出包到 `vendor/`」必须逐条登记在 registry 的 `vendorSourceConsumers`（consumer / vendorFile / symbols / reason / retiresWhen）；C16 双向判定——登记与真实 import 同时存在、符号集合逐条相等、每个符号在 vendor 文件里仍是 `export function`，未登记的 vendor 相对 import 一律红；A 门按同一块放行，不维护第二份白名单。当前唯一行 = renderer `src/host-graph.ts` ← dsh-client-modules `src/client/manifest.ts`（`optionalStringArray` / `stripClientSuffix`，退役条件见其 `retiresWhen`）；covered/factory：`packages/renderer/src/chamber-covered.ts` 的 `CHAMBER_COVERED_IDS` / `CHAMBER_COVERED_FACTORY_IDS`（chamber-entry 执行期断言 map == 列表）；新增官方 client 行先裁决（消费 / 镜像 / 替换）再登记 covered，删包 fail-loud 哨兵在 C4。typert remote 装配 = `EXPECTED_MOUNT_PACKAGES` 唯一顺序表（数量与内容以该表为准；import 选择无运行时顺序语义，按集合相等断言；gen-typert-remotes 与 C4 双向断言）；契约入口 `remotePackagesFromAssembly`/`remoteMountPackages`（`renderer/scripts/typert-remote-contract.mjs`）；版本锚与「活」版本字面量（门 = C10）：dsh 运行时版本单一来源 = 已提交的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`（同目录 `package.json` 被 gitignore，仅本地存在时交叉校验）；六个运行时线锚（`bundle-dsh.mjs` 兜底、vendor 锁文件、`release.yml` env、`install-gateway.sh`、gateway `dshAnchorVersion`、`release-preflight` `FORK_VERSION`）与三个 fork 副本必须等于它；生产源码/脚本/配置（非注释、非夹具、非产物）里不得出现其他 dsh 版本字面量，历史叙述只留注释，具名常量（如 `HOST_IDENTITY_METHOD_SINCE`）按「上限 1 处 + 理由」登记白名单。扫描面排除 `*/test/**` 的合成版本与本地派生状态（由 `.gitignore` 判定：`git ls-files --others --ignored --exclude-per-directory=.gitignore --directory`；不用 `--exclude-standard`，它会把 `core.excludesFile` 带进来），唯一例外是被忽略却必须扫的 `vendor/dsh/package.json`。
- vendor 源码补丁集（构建期改写，design 09 §3.6）：`packages/renderer/scripts/vendor-patches.mjs` 登记五类补丁（数量与锚点以该注册表为准），由 renderer 的 `deepseekSource().transform` 在构建期按精确上游文本改写，vendor 文件零写入。① 同源资源 URL 类（N-ctx 壳必须改写）：`ui-chat` 的 `api/file`（`AssistantMarkdown`/`ChatView` 两处解析器）、`client-file-upload` 的 `api/session/uploadFileBinary`、`ui-deliverables` 的 `api/present.host|open`、`api/changes.open|summary|diff`、`session-log-export` 的 `api/session.export`——上游现行路由已是 document-relative（单一 `document.baseURI`，per-entry 前缀无处承载），一律经 `ctx.get('chamberBasePath')`（组件类站点读 root 标准 prop `chamberFileApiBase`）归一为 `/api/i/<id>/` 前缀前置（markdown 图片 URL 以 `new URL(basePath + '/', document.baseURI)` 作解析基准），并保留「缺 base path → 回落上游 document-relative」的形状（`ctx.get` 对未 provide 返回 `undefined`；对**服务代理读属性**才抛错），相关包按 covered / covered-deferred 登记。
  ② 实测帧成本类（正确性优先）：`ui-conversation` 的三层 rAF 发布链（`ui-chat` 的 `ReasoningRow` 行 sweep 已由上游共享 TextShimmer 合成器 keyframes 承接、`GenericCommandCard` 行 sweep 已不存在）——条目必须把 A/B 实测写进 `reason`（同一机器/显示器、renderer+GPU 进程 CPU 累积差；Electron 归档面 `app.getAppMetrics`，Swift 出货面 Activity Monitor/`ps` + Web Inspector Layout 计数）；未附 A/B 的条目只能作工作树候选（reason 标 `ADMISSION PENDING`），不得与 release 同批。
  ③ 模块私有状态机的逻辑缺陷类（维护者裁决）：`ui-chat` 的 `chat/use-chat-reading.ts` 采样 settle——残余偏移在跟随容差（`FOLLOW_THRESHOLD`=24px）内不再保留（实测 12px 非 reader 偏移在 `data-chat-following-tail` 保持时永久残留、任一后续布局变化即回贴；触发侧为直接 bash 调用的 preparing→started 整行替换，scroll 侧成因未定，PTC 子调用不复现），上游携带修复后删除条目；第三类的第二实例 = `util-values` 的 `hasIntrinsicConstructor` 严格单行比较已退役、由 `RETIRED_PATCHES` 钉住上游的引擎无关比较句（症状/取舍/删除条件见 design 09 §3.6）。
  ④ 多实例正确性类（维护者裁决，四形态）：`ui-workspace` 的 `client/navigation.ts` 选择键 per-entry scope + 座席所有权转移 + `ui-attachment` 的 drag/drop per-mount DOM containment + `ui-theme` 的页面级单例（icon sprite，dedupe；维护者裁决已落库，见 design 09 §3.6 第四形态；同类的 theme 样式表补丁已随上游 plain CSS imports 移入 `RETIRED_PATCHES`）；座席转移、per-mount 与页面单例为 `noRetireForm`。
  门：C9（锚点**唯一命中**）+ `vendor-patches.test.mjs`（锚点/行为/id 形态）+ vite `buildEnd` 的 applied 覆盖（按注册表逐条，未 apply 即构建失败）+ `verify-vendor-patch-applied`（产物侧每补丁 present 标记）。新增补丁前先问「能否在 chamber 自己的包里修」；性能类还须先证明成本是每帧的、且 chamber 侧门控覆盖不到它；逻辑缺陷类（第三类）须写明实测症状、接受的取舍与删除条件。

## 4. contract-mirror 登记（按上游属主分组）

> **Electron 冻结（2026-11）**：本节与 §4.5 的 Electron 半为**归档参考**；升级 pin 只复核 Swift 腿与共享契约（ipc-events / host-edges / shell-core / wire），不再要求 Electron 侧同步（docs/progress/electron-frozen.md §5）。「怎么判」在各自脚本/测试头注；下表只写**契约**镜像点（每行一组上游属主 → chamber mirror 点；门与包测试入口单源 = `scripts/gates/registry/gate-surfaces.json` 与各包 `package.json`）：

- dsh-api-remotes（client）→ typert remote 装配（30）与 message-feedback / session-reference / subagent 等 wire 面；dsh-api-session-controller → api-gateway fork 的 journal-stream 帧（无游标 notification，形状在 `packages/dsh-api-gateway/src/stream-protocol.ts`；形状 = C1，行为 = 升级时人工重放一次）；client/connection（recovery）→ recovery-config 共享 schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` == schema 默认 `backoffMaxMs`）；dsh-api-session-controller（会话事实语义；人工登记，无 C 编号门）：运行位活性守卫押在四条上游语义上（design 14 §D4）：① sessions.refresh() → refreshList() 单飞并把权威 summary 的 running 回灌已物化会话（handleRunning）；② api-session/status 是 mode:emit 转发事件（无重传/无 ack）；③ session.list 拉取失败（result.ok===false，含 carrier 失败折叠成结果失败）时 refreshList() 照常 resolve、只把 listState 置 error，非 remote 异常仍 reject——故 probe 必须用独立权威读取判定（不依赖 refresh 成败）；④ ClientSessions.handleSessionStatus(sessionId, running) 是具体类公开方法（ISessions 契约只暴露 refresh()），一次调用同时写 list summaries、物化 Session 的 running 与 catalog activity——tier-3 写回押在它上面（只写 false、写后自校验、无 TTL；方法缺失即 WARN 一次并降级）。vendor 源锁步 = vendor-session-fact-contract.test.ts 的 6 断言（vendor 树未物化默认失败）；对话流健康臂另押三条事实（retain() 呈现即重入 Session.open()、Session.open() 在 open/在途 promise 短路、failEventStream() 锁 openState=error 并清空 promise），由 vendor-heal-contract.test.ts 钉住。
- dsh-api-session-controller（goal 投影 + activation；registry `mirror.dsh-api-session-controller-goal`）：① 只读 session/list 行带 projections.values.goal（嵌套 {goal:{id,revision,phase},updatedAt}，只取白名单、不激活 agent）；② $events 转发 goal/activation-changed（emit 形 {sessionId, goal?:{id,revision,activation}}，无重放）；③ activation 只进程内、$events ready 代际清空、绝不落盘；dsh-client-hmr（`pluginEvents` 宿主半；registry `mirror.dsh-client-hmr-plugin-events`）：chamber 在 `packages/renderer/src/hmr-events.ts` 按实例 `$mount` 生成物 `@deepseek-ai/dsh-client-hmr/remote` 并自持 `pluginEvents/follow` $stream（baseline 全量 + graph/rebuilt 增量，帧翻译回 live-graph 既有 JSON 文本）；官方客户端半身不加载（页面级 modules.entries 与 N-ctx 冲突）。旧 `/plugins/events` 宿主路由与页面通道 `pluginGraph` 族已退役。
- dsh-runtime（激活探针域）→ HOST_DOMAIN_PROBE_NAMES ↔ gateway HOST_PACKAGE_PROBE_DOMAINS（C7）；interaction/commands → 激活探针载荷键名 == 上游 execute(agent, line, submittedAttachments, signal) 的参数名（历代皆 submittedAttachments）；dsh-host-webserver（index-inject）→ boot 注入面（`__DSH_BOOT__` 等）；alpha.1 起 `__DSH_CONNECTION_RECOVERY__` 页面全局退役，recovery 时序走 connection 的 SyncedConfig 第二参（fork C1 的签名/读面由 client-apply.test.ts 钉住）；dsh-host-open-in-app + dsh-client-ui-open-in-app（官方两份）→ chamber fork（design 20 §2.2/§6）：宿主半 `packages/dsh-chamber-seed-open-in/`（src/{catalog,resolver,icons}.ts pure、{shared,index}.ts patched、其余 own/dropped），客户端半 `packages/dsh-chamber-client-ui-open-in/` 自有 wire 镜像；官方 client 行加载其文件级席位（右栏文档动作 + deliverables 文件动作），官方 host 行由控制面 --patch overlay 显式 disabled: true（OFFICIAL_OPEN_IN_DISABLE）；当前 pin 上游重写客户端半（header 席位移除、session 级入口改 session-open-with 子菜单），N-ctx 下 inert 属未证实推断 → registry seed.* 条目（C1/C3/C5 版本锚豁免）。
- dsh-client-ui-primitives（HoverCard/pointer-grace；vendor seam）→ 侧栏行卡片自持移植（RowHoverCard.tsx + client-core hover-intent.ts；页面级单卡、blur/hidden 关闭、两轴定位、copyEpoch），C15 硬失败门 + 真机核对 W-4b；overlayTopMargin 逐行镜像（max(min, (fullscreen ? 0 : 顶部净空) + 20)；darwin 48px / windows caption 40px ⇒ mac 68 / win 60 / 全屏 20）；@deepseek-ai/dsh-client-locale + dsh-client-ui-settings（页面语言归属，design 06 §4.6）→ `packages/renderer/src/locale-ownership.ts` 只依赖四条 vendor 事实（locale 服务名与 slots.installLocale；LOCALE_SETTINGS_NAMESPACE 与 ctx.configForms.get(locale) 形状；locale.subscribe(sync) 先于立即 sync()；每 namespace 的 status: persistence===host ? loading : unavailable 与 derive → ready/unavailable），无自动化锁步、pin 升级时人工复审。

## 4.5 桌面 seat 覆盖审计（`apps/desktop/src`）

> **Electron 冻结（2026-11）**：本审计表的 Electron 侧行仅作历史/复活参考；现行升级复核面 = Swift 腿 + 共享契约。

> I-8 的人工覆盖台账（registry 条目 + 本表两份同源；`verify-registry.mjs` ⑤E 做双向覆盖检查与 chamber 对照点路径存在性检查，非 C 编号门）：审计对象 = 当前 pin 的 vendor 子模块 `apps/desktop/src`（以 pin 树为准），逐文件裁决中**有 chamber 对照结论者逐行入表**；not-applicable 汇总面与 `login-shell-environment.ts` 见 §4.6，`apps/desktop-host/src` 的宿主侧文件按 §4.6「desktop-host 宿主侧文件」表登记。registry 落点 = 四条 mirror 条目：`mirror.dsh-desktop-carrier-seats`（data-platform/dshDesktop 载体/`__DSH_HOST_PATHS__`/浏览器 guest 载体）、`mirror.dsh-desktop-shortcuts-seat`（DOM 键桥与 chamber-settings 持久化的快捷键适配器）、`mirror.dsh-desktop-native-chrome-seats`（single-instance/quit-confirmation/startup-error）、`mirror.dsh-desktop-update-chain`（更新链：coordinator/schedule/journal/presentation，传输/弹窗面为收窄后的形态）；`upstream`/`ours` 字段受 schema 约束、必须是 pin 树内存在的单一路径（故四条仍写 `apps/desktop/src`，逐文件覆盖清单写在各条目 evidence 与本表行内；出货腿的 Swift 落点写在 evidence）；Swift 腿窗口量不单列条目，由 design 25 §5.6 逐值重锚（T-04 记明上游无 Sparkle、Swift 更新链自建；mobile anchors 门已随 mobile 包退役）。
> **官方 `ui-sidebar-browser` 客户端行**：pin 住的 `packages/bundle/web-app/cordis.patch.yml` 以 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` 停用该行；本仓托管宿主恒以 `--profile web` 启动（`packages/control-plane/src/spawn-dsh.ts`），故官方 ui-sidebar-browser 客户端行在 pin 的 web profile 不加载，页面浏览器行 = 本仓 deferred row（`packages/renderer/src/chamber-covered.ts`）；`browser-guests.ts` / `preload-browser.ts` 的 mirror 分类只表达载体语义对齐（design 28 / ADR-0004，唯一 delta = SSH 反代），不依赖官方客户端行加载。升级时按 §7 第 6 步逐条照面：`mirror` 行必须仍有对应 chamber 席位与门；`different-adopted` 行必须仍是显式取舍；`not-applicable` 行一旦被采用（chamber 开始渲染/依赖该上游产品面）即转 mirror 条目。

| 上游文件 | 分类 | chamber 对照点 | 一句理由 |
|---|---|---|---|
| `backend-controller.ts` | different-adopted | `packages/control-plane/src/local-connection.ts`、`packages/desktop/host-assembly.ts` | 本地 dsh 后端的启动/就绪/失败状态机归控制面持有，desktop 只消费 PlaneHandle，不再由 Electron 主进程自持 backend。 |
| `browser-guests.ts` | mirror | `macos/Sources/DSHChamber/{BrowserGuestRegistry.swift,BrowserGuestPolicy.swift}`、`macos/Sources/DSHChamber/Resources/bridge-shim.js` | 上游为 sidebar-browser 的 webview 租客做分区/租约/权限/导航门；本仓 Swift 原生 guest（每 tab 一个 WKWebView、非持久 data store）承载同一载体语义（design 28 / ADR-0004），唯一 delta = SSH 反代别名。 |
| `core-package-set.ts` | different-adopted | `packages/dsh-runtime/src/registry-integrity.ts`、`packages/dsh-runtime/src/anchor-version.ts`、`packages/desktop/vendor/dsh/pnpm-lock.yaml` | chamber 的运行树完整性由 registry 版本 + 已提交 lockfile 锚管理（design 18），不下载/校验上游 desktop-packages.json 的 tgz 包集与 sha512。 |
| `crash-report.ts` | mirror | `macos/Sources/DSHChamber/CrashDiagnostics.swift`、`packages/desktop/fatal-report.ts`（Electron 归档参考） | 落盘崩溃留证口径对齐（崩溃记录 + 启动期 marker）；本仓出货腿只有 shell-crash.log + marker，无 crash-*.log 报告文件/10 份轮转/Finder reveal（导出缺口见 STATUS §1.7），故 mirror 只钉留证位而非报告导出链。 |
| `device-info.ts` | different-adopted | `packages/desktop/shell-ipc-settings.ts`、`macos/Sources/DSHChamber/Resources/bridge-shim.js` | 上游 readDeviceInfo 的 platform/os/app_arch/cpu/memory_gib 同形实现由 sidecar 产出、carrier 按需读 info.deviceInfo；等价物已存在，故从「不适用汇总面」移入表内。 |
| `directory-picker.ts` | not-applicable | `packages/renderer/src/chamber-covered.ts` 有意跳过名单（directory-picker-native） | 上游为 native 目录选择行提供窗口级对话框 IPC；chamber 把该行列为「covered 但不加载」，picker 交互钉在 browse。 |
| `fatal-recovery.ts` | mirror | `macos/Sources/DSHChamber/NativeText.swift`、`packages/desktop/startup-error.ts`（Electron 归档参考） | 启动失败恢复框席位镜像（退出/重启/安全模式重启；安全项默认、Esc 落安全项；实现于 AppDelegate+StartupRecovery.swift）；动作集收窄：无「禁用第三方插件 + 备份 profile patch」与取报告（缺口见 STATUS §1.7），故 mirror 只钉恢复框存在与默认取向。 |
| `file-actions.ts` | not-applicable | `macos/Sources/DSHChamber/Resources/bridge-shim.js`；缺口见 `docs/progress/STATUS.md` §1.7 | 上游 save（另存为）/readClipboardImage 原生臂不采用：dshDesktop 缺 fileActions 成员，页面 BridgeFileActions 降级（另存为不可达、跨域原图走 fetch）；缺口登记 §1.7。 |
| `file-drag-files.ts` | not-applicable | `docs/progress/STATUS.md` §2.3（拖出原生臂缺载体） | 上游拖出原字节借用与临时文件保留（64MiB/60s）不采用；随包 ui-file-drag 走浏览器臂（objectURL + DownloadURL），拖到 Finder 是「下载式」。 |
| `file-drag.ts` | not-applicable | `docs/progress/STATUS.md` §2.3（拖出原生臂缺载体） | 上游 dshDesktop.fileDrag prepare/cancel/start/release 原生臂不采用（载体缺 fileDrag 成员），原因同上。 |
| `host-process.ts` | different-adopted | `packages/control-plane/src/spawn-dsh.ts`、`packages/control-plane/src/reaper.ts`、`packages/desktop/host-assembly.ts` | 本地 dsh 子进程的 spawn/就绪探测/回收在控制面，desktop 不做上游的 Electron 子进程协议与 quit inspection。 |
| `host-protocol.ts` | different-adopted | `packages/desktop/sidecar-entry.ts`（B 桥 NDJSON）、`packages/desktop/sidecar-exit-codes.ts` | chamber 的双 flavor 宿主协议是自持 B 桥与退出码分级，没有上游 Desktop host protocol v4 这一 Electron↔host 版本面。 |
| `ipc.ts` | mirror | `packages/desktop/ipc-events.ts`、`packages/desktop/shortcuts-bridge.ts`（DESKTOP_SHORTCUTS_CHANNELS 六个字面量与上游同名）、`packages/desktop/electron/preload.cts`、`packages/desktop/test/ipc/desktop-carrier-surface.test.ts` | 通道表与 DesktopUpdatePresentation/失败分类形状镜像上游；native-theme 通道改用 chamber 前缀 `dsh-chamber:native-theme-set`（upstream-seats 钉住）。 |
| `keybindings.ts` | mirror | `macos/Sources/DSHChamber/Resources/bridge-shim.js`（shortcutsDocument 经 chamber-settings `settings-get`/`settings-set` 持久化的适配器）、`packages/desktop/chamber-settings.ts`（`shortcutsDocument` 原始 JSON 文本字段）、`packages/desktop/shortcuts-bridge.ts`（Electron 归档参考） | 快捷键偏好席位镜像（revision 化事务、编辑/订阅/录制语义）；出货腿把 preferences 存 chamber-settings 的 `shortcutsDocument` 原始 JSON 文本（重启恢复）、不落 keybindings.json（差异 S-54 已登记）。 |
| `keyboard.ts` | mirror | `macos/Sources/DSHChamber/Resources/bridge-shim.js`（DOM keydown/keyup 归一）、`macos/Sources/DSHChamber/KeyboardBridge.swift`（guest 快捷键转发）、`packages/desktop/shortcuts-bridge.ts`（Electron 归档参考） | 键盘桥席位镜像（投递门与偏好事务）；出货腿为 DOM 键桥 + 经 chamber-settings 持久化的偏好适配器，无 before-input-event/子 frame/guest 源注入、无录制期菜单抑制、closeWindow loud reject（差异 S-54 已登记）。 |
| `locale-cache.ts` | different-adopted | `macos/Sources/DSHChamber/NativeText.swift`、`macos/Sources/DSHChamber/AppDelegate.swift` | 官方 locale 缓存 + AppleLanguages 面在壳侧复刻为「页面事实 → 原生文案/菜单重建 + AppleLanguages 所有权」；方向相反（页面事实驱动原生），保留 zh/en 与运行期 override。 |
| `locale.ts` | mirror | `macos/Sources/DSHChamber/NativeText.swift`、`macos/Sources/DSHChamber/AppDelegate.swift`、`packages/desktop/shell-locale.ts`（共享 typed 字典，Electron 归档参考） | 原生 chrome 语言归属席位镜像（typed 字典 + 语言判定方向）；范围收窄到 zh/en 且由页面事实驱动原生菜单/托盘重建（上游 8 语言 typed 字典不镜像）。 |
| `main.ts` | different-adopted | `packages/desktop/electron/main.ts`（单帧加载控制面 origin）、`packages/desktop/shell-core.ts`、`macos/Sources/DSHChamber/*` | 上游是单进程桌面宿主（web document + account + overlay + app menu）；chamber 是连接管理器单帧 + 双 flavor core，仅 win32 caption、darwin 窗口 chrome（hiddenInset/红绿灯/vibrancy/透明底逐值）、tray/quit 等席位是镜像子集；深链另有 `dsh-chamber://open` intent（前置已有主窗，官方 `dsh://open` 同义，design 16 §3.1）。 |
| `microphone-permissions.ts` | different-adopted | `packages/desktop/electron/main.ts`（setPermissionRequestHandler / setPermissionCheckHandler + isChamberPermissionGranted，归档参考）、`macos/Sources/DSHChamber/MainWindowController.swift`（媒体采集恒 deny） | chamber 的权限面是「默认拒绝，只放行 clipboard-sanitized-write」，不实现上游的麦克风主帧白名单；出货腿的媒体采集门在 MainWindowController 恒拒（无 NS*UsageDescription）。 |
| `node-environment.ts` | different-adopted | `packages/control-plane/src/spawn-dsh.ts`（resolveNodeExecutable）、`packages/desktop/host-assembly.ts`（pnpm 子进程 ELECTRON_RUN_AS_NODE 分支） | 同样用 Electron-as-node，但 node 解析由控制面单源（process.execPath + ELECTRON_RUN_AS_NODE + --expose-internals），无上游的 launcher 目录 / DSH_DESKTOP_NODE_EXECUTABLE / PATH 契约。 |
| `operation-history.ts` | not-applicable | `docs/progress/STATUS.md` §1.7 | 上游插件操作历史的有界读（64KiB/100 条）不采用：插件安装/启停不可取证、诊断报告无「最近插件操作」附节；缺口登记 §1.7。 |
| `operation-journal.ts` | not-applicable | `docs/progress/STATUS.md` §1.7 | 插件操作 journal（两段 256KiB/记录 4KiB）零实现；update-journal.ts 只记更新相位，不是该 journal。 |
| `operation-report-job.ts` | not-applicable | `docs/progress/STATUS.md` §1.7 | 诊断报告附节的任务采样（Worker 500ms 预算）不采用，原因同 operation-report。 |
| `operation-report-worker.ts` | not-applicable | `docs/progress/STATUS.md` §1.7 | 诊断报告 Worker 装配零实现（宿主侧 operation-diagnostics 无消费者）；缺口登记 §1.7。 |
| `operation-report.ts` | not-applicable | `docs/progress/STATUS.md` §1.7 | 诊断报告附节（插件操作记录/宿主输出）不采用；与 operation-history/journal 同属「取证链」缺口，统一登记 §1.7。 |
| `owned-directory.ts` | different-adopted | `packages/dsh-runtime/src/dsh-runtime-store.ts`、`packages/dsh-runtime/src/private-fs.ts` | chamber 的受管目录清理/校验在 dsh-runtime（lstat + 符号链接拒绝 + 私有 FS 纪律），没有上游那个专用于 Electron 递归 rm 的 junction-safe 删除助手。 |
| `paths.ts` | different-adopted | `packages/desktop/chamber-lock.ts`（`<userData>/.dsh-chamber.lock`）、`packages/desktop/host-root-lease.ts` | chamber 的路径根 = Electron userData + 双 flavor 锁/租约；上游 `profiles/desktop` profile 布局不采用。 |
| `preload-app.ts` | mirror | `packages/desktop/electron/preload.cts`（exposeDesktopCarrier：protocolVersion 1 + updates/keyboard/shortcuts；exposeHostPaths：webUtils.getPathForFile + painted-source 门控）、`macos/Sources/DSHChamber/Resources/bridge-shim.js`（dshDesktop + `__DSH_HOST_PATHS__`：HostPathCatalog 拖拽板快照 × 事件批次）、`packages/renderer/src/host-path-scope.ts`（data-chamber-painted-source）、`packages/desktop/upstream-seats.test.ts`（S-52/S-56） | dshDesktop 载体与 `__DSH_HOST_PATHS__` 宿主路径面的存在、成员、安装时机与值契约双 flavor 锁步（S-56）；成员级三分：fileActions/fileDrag 未实现（缺口见 STATUS §1.7）、browser 换成 `dshChamber.browser` 命名空间（design 28）、dshOnboarding/dshPlatform/dshDesktopBoot/`__DSH_LOCALE__`/`__DSH_DIRECTORY_PICKER__` 不采用（非目标/已登记）。 |
| `preload-browser.ts` | mirror | `macos/Sources/DSHChamber/{BrowserGuestRegistry.swift,BrowserGuestPolicy.swift}`、`macos/Sources/DSHChamber/Resources/bridge-shim.js` | 上游 sidebar-browser preload 的 acquire/release/onOpenRequested 改为 `dshChamber.browser` 命名空间的 Swift A 桥（design 28 / ADR-0004）；页面浏览器行 = 本仓 deferred row，官方客户端行不在 web profile 加载（见上方复核结论）。 |
| `preload-platform.ts` | mirror | `packages/desktop/electron/preload.cts`（markDocumentPlatform 逐字）、`packages/desktop/electron/main.ts`（全屏标记推送：进出全屏 + 装载后重放）、`macos/Sources/DSHChamber/ShellWindowFullscreenMark.swift`（fullscreen 原生半边）、`packages/desktop/upstream-seats.test.ts`（S-51/S-53） | `dataset.platform` 与 fullscreen 标记镜像上游；**两 flavor 都写 fullscreen**（Electron `main.ts` 的 pushFullscreenMark / Swift `ShellWindowFullscreenMark`，`dataset.fullscreen = 'true'` / `delete` 逐字同形，design 25 §5.6）。 |
| `preload-theme.ts` | mirror | `packages/desktop/electron/preload.cts`（syncNativeTheme observer）、`packages/desktop/shell-ipc-settings.ts`（NATIVE_THEME_SET）、`packages/desktop/electron/electron-edges.ts`（nativeTheme.themeSource）、`packages/desktop/node-edges.ts`（显式 no-op） | `data-ds-theme-source` 观察者与宿主投影镜像上游（macOS-only）；Swift 腿按页面事实跟随，通道保留成员。 |
| `preload-welcome.ts` | not-applicable | 无 | 欢迎页 preload；不采用。 |
| `preload-windows.ts` | mirror | `packages/desktop/electron/preload.cts`（markWindowsTitlebar：`data-windows-titlebar` + `--dsh-windows-titlebar-height`）、`packages/desktop/electron/main.ts`（titleBarStyle hidden + titleBarOverlay）、`windows-layout.ts` 常数 | Windows caption 席位逐值镜像（高度 40），preload/main 两份常数相等由 upstream-seats 钉住；darwin 唯一出货，Windows 面仅冻结/复活参考。 |
| `project-manager.ts` | different-adopted | `packages/dsh-runtime/src/runtime-installer.ts`、`packages/desktop/dsh-runtime-controller.ts` | chamber 用 registry 版本安装 + override 机制（design 18）管理运行树，不建上游的 desktop-runtime pnpm 工程/profile 元数据。 |
| `quit-confirmation.ts` | mirror | `packages/desktop/chamber-settings.ts`（computeQuitRisk）、`macos/Sources/DSHChamber/QuitCoordinator.swift`、`packages/desktop/electron/main.ts`（before-quit 对话框，归档参考） | 「退出会打断什么才确认」的席位镜像；检查面收窄为本地实例运行中（上游 = host 活跃/计划任务探测），Swift 执行线在 QuitCoordinator。 |
| `release.ts` | different-adopted | `packages/desktop/package.json`（version）、`packages/desktop/vendor/dsh/pnpm-lock.yaml`、`packages/desktop/primary-runtime-lock.json` | chamber 的版本身份单源 = 包版本 + lockfile 锚；不读上游 desktop-runtime.json 的 release 元数据（node/pnpm 版本）。 |
| `runtime-tree.ts` | different-adopted | `packages/dsh-runtime/src/dsh-runtime-store.ts`、`packages/desktop/runtime-tree-check.ts` | 运行树清单/校验在 dsh-runtime + 启动期闭包抽样，不采用上游 desktop-runtime.json 描述符与 shared package inventory。 |
| `settings.ts` | different-adopted | `packages/desktop/chamber-settings.ts` | 本仓壳配置 = chamber-settings.json（chamber-settings.ts），没有上游 desktop/settings.json 文档面；allowTestAuthPopupWindow 属强制更新面，不适用。 |
| `single-instance.ts` | mirror | `packages/desktop/chamber-lock.ts`（O_EXLOCK，冻结 Electron 归档参考）、`macos/Sources/DSHChamber/SidecarSupervisor.swift`（flock LOCK_EX/LOCK_NB，出货腿）、`macos/Sources/DSHChamber/AppDelegate.swift`（二次启动恢复与深链转发） | 单实例所有权与二次启动聚焦镜像上游，另加一层跨 flavor 目录锁（design 25 §6.3）；出货腿的锁实现与恢复入口在 Swift 侧。 |
| `startup-error.ts` | mirror | `packages/desktop/startup-error.ts`（desktopErrorState 同形） | 启动失败态的形状/文案投影与上游同名同义。 |
| `tray.ts` | mirror | `macos/Sources/DSHChamber/StatusItemIcon.swift`、`macos/Sources/DSHChamber/AppDelegate.swift`（NSStatusItem 恒建） | 托盘位语义镜像（常驻 = 回窗 + 显式退出）；官方 tray 构造点仅 win32、macOS 官方无托盘，本壳 NSStatusItem 是壳独有增量（EXTRA+），该行只钉「回窗/退出」位语义而非平台存在性。 |
| `update-attention.ts` | mirror | `macos/Sources/DSHChamber/MainWindowController.swift`（raiseUpdateAttention） | 更新就绪注意力席位镜像（每目标一次、聚焦闩锁）；官方该类只服务强制更新窗，本仓用于普通更新 downloaded 的 Dock 注意力，属壳增量用法。 |
| `update-channel.ts` | different-adopted | `macos/Sources/DSHChamber/AppUpdater.swift`（stable/beta 双 appcast + betaUpdates 偏好） | 上游当前 pin：默认渠道 = 安装包封签（manifest 的 `dshDesktopUpdateChannel`，nightly/stable；旧 manifest 缺键保持 nightly），另加用户选择的持久面（`userData/desktop/settings.json` 的 `updates.channel`，已保存选择优先）——默认渠道仍是安装包产物属性；本仓无安装包封签默认（beta 构建默认 stable，用户开开关才进 beta，用户裁决 v4），通道 = Sparkle 双 appcast + 用户 betaUpdates 订阅（env 可硬覆盖），属壳增量。 |
| `update-coordinator.ts` | mirror | `packages/desktop/updater.ts`（相位机/焦点 nudge/单飞/quitAndInstall 武装）、`packages/desktop/update-headless.ts`（Swift 腿同相位） | 更新编排的相位/注意力/安装语义镜像（§22.3.5）；上游当前 pin 另含渠道切换 generation 门（串行化 + 取消在途检查/下载 + discard 旧 target + 残留清理日志，落点 `updates/electron-updater/{channel,discard}.ts` 与 `update-cleanup-log.ts`）与下载失败细分——本仓渠道切换由 Sparkle feed 委托 + `resetUpdateCycle` 承担、无 discard 面，传输面有意不同（见 update-http-executor）。 |
| `update-dialog.ts` | different-adopted | `packages/dsh-chamber-client-ui-settings-bridge`（UpdateSection / update-store / update-gate） | chamber 的更新面是 settings 普通状态行，无对话框/遮罩窗口（design 11 §2 无弹窗硬约束）。 |
| `update-error.ts` | different-adopted | `packages/desktop/updater.ts`（failureKind + 相位保持 + 一次性 restartFailureText） | 上游当前 pin 的失败分类 = configuration（渠道配置不可读）+ download-{space,permission,busy}（由 `downloadFailureDetails` 从 ENOSPC / EACCES·EPERM·EROFS / EBUSY 推导）+ 既有 network 族；本仓 failureKind 只覆盖本模式可检测的网络类，无上游 preparationFailure 家族（停止失败/任务变更/任务不可用）——chamber 没有安装前任务检查面；安装前的唯一 preparation 失败 = `fullscreen-timeout`（设置行/页面「重启并安装」的全屏退出超时，拒绝安装且可重试）。 |
| `update-http-executor.ts` | different-adopted | `packages/desktop/updater.ts`（idle 看门狗 + 忽略迟到事件） | 上游当前 pin 已把该传输实现迁到 `updates/electron-updater/http-executor.ts`（仍是注入 electron-updater 私有传输）；registry 明载：chamber 不替换传输（需注入私有字段，Electron 升级即碎），改用外部 watchdog + 忽略迟到事件。 |
| `update-journal.ts` | mirror | `packages/desktop/update-journal.ts`、`packages/desktop/update-journal.test.ts` | 白名单字段 JSONL 取证日志同名镜像（同 env 开关 DSH_DESKTOP_UPDATE_JOURNAL_DIR、同白名单、失败自禁用）；已核验差异 = 本仓单文件追加、无 action 里程碑（上游 started/workspace-ready/安装确认等动作面未移植）。 |
| `update-overlay.ts` | different-adopted | `packages/desktop/electron/main.ts`（唯一 BrowserWindow）、settings-bridge UpdateSection | 上游用遮罩子窗阻塞父窗输入；chamber 只有一个主窗 + settings 状态行，无遮罩面。 |
| `update-presentation.ts` | mirror | `packages/desktop/electron/preload.cts`（toUpstreamUpdatePresentation 相位映射）、`packages/desktop/updater.ts`（failureKind）、`packages/desktop/upstream-seats.test.ts`（S-52 失败归类） | 对官方设置壳的相位/失败归类呈现契约镜像（downloaded→ready、downloading→download…）；上游当前 pin 的失败归类新增 configuration 与 download-{space,permission,busy} 摘要（`desktopUpdateFailureKind`），本仓呈现相位表无 verifying（及其进度呈现）、失败分类只覆盖本模式可检测的网络类；本仓失败行可展开行内 `<details>`「技术详情」复用已脱敏 `update.error`（空错误不渲染入口、无弹窗；上游 `technicalDetails` 字段未镜像）。 |
| `update-schedule.ts` | mirror | `packages/desktop/update-schedule.ts`、`packages/desktop/update-schedule.test.ts`、`macos/Sources/DSHChamber/AppUpdater.swift`（`nudgeBackgroundCheck`） | 600s 基准 ±20% 抖动、失败退避封顶 1h、同 env 名镜像；有意差异 = 非法 env 回退默认并 loud 警告而非抛错；native 腿节奏归 Sparkle（固定 600s，无抖动/退避），本文件调度只服务无原生腿的 sidecar；Swift 腿回前台/唤醒补充一次后台静默检查（相位门 + `checkInterval` + 60s 合并窗，不改周期/退避）。 |
| `update-window.ts` | different-adopted | `packages/desktop/updater.ts`、`macos/Sources/DSHChamber/AppUpdater.swift`；缺口见 `docs/progress/STATUS.md` §1.7 | 官方独立 update-dialog 窗口 + 安装前全屏退出准备；本仓是 Sparkle 标准窗 + 设置页状态行（design 11 无弹窗）；设置行/页面「重启并安装」路径已有全屏准备（5s 超时以 `fullscreen-timeout` 拒绝并保持重试），Sparkle 标准窗内二次确认路径仍无该准备（缺口见 `docs/progress/STATUS.md` §1.7）。 |
| `web-document.ts` | different-adopted | `packages/control-plane/src/static-serving.ts`、`packages/control-plane/src/instance-proxy.ts` | 不用 `dsh-app:` scheme：boot 注入与凭据注入由控制面以同源 HTTP + CSP nonce 完成（static-serving 注入 boot 对象、instance-proxy 注入凭据），不是「不做注入」。 |
| `welcome-backend.ts` | not-applicable | 无 | 欢迎后端连接（账号流）；不采用。 |
| `welcome-window.ts` | not-applicable | 无 | 欢迎窗口；不采用。 |
| `windows-layout.ts` | mirror | `packages/desktop/electron/main.ts`（WINDOWS_TITLEBAR_HEIGHT = 40）、`packages/desktop/electron/preload.cts`（同值副本） | caption 高度常数逐值镜像（上游 40），两份副本相等由 upstream-seats 钉住；darwin 唯一出货，Windows 面仅冻结/复活参考。 |

> **R9 冻结面汇总**：上游 Electron 桌面产品面中 18 个 not-applicable 文件（账号/欢迎/强制更新/平台视图/操作取证：account-backend / background-notice / client-metadata / client/WelcomePage.tsx / client/styles.d.ts / client/welcome.tsx / mandatory-update-* / platform-ipc / platform-view / policy-test-auth / preload-mandatory* / preload-menu / preload-platform-account / preload-update-dialog / preload-welcome / welcome-api）本仓均不采用；缺口与登录闭环登记见 docs/progress/STATUS.md §1.7·§4.2 与 TODO C§1，冻结面复活裁决见 docs/progress/electron-frozen.md §5。

> **R9 冻结面汇总**：上游 Electron 桌面产品面中 19 个 not-applicable 文件（账号/欢迎/强制更新/平台视图/操作取证）本仓均不采用——完整清单见下表保留行与本行括注：account-backend / background-notice / client-metadata / client/WelcomePage.tsx / client/styles.d.ts / client/welcome.tsx / mandatory-update-* / platform-ipc / platform-view / policy-test-auth / preload-mandatory* / preload-menu / preload-platform-account / preload-update-dialog / preload-welcome / welcome-api；缺口与登录闭环登记见 docs/progress/STATUS.md §1.7·§4.2 与 TODO C§1，冻结面复活裁决见 docs/progress/electron-frozen.md §5。

### 计数与落点

- 本表 56 行：mirror 22 / different-adopted 22 / not-applicable 11（另 18 行上游 Electron 桌面产品面的 not-applicable 已按 R9 汇总为上方一行）；mirror 行 = 四条 `mirror.dsh-desktop-*` 条目 + 各自 relatedGates；different-adopted 逐条写进对应 mirror 条目的 rationale / evidence；门与包测试入口单源 = `scripts/gates/registry/gate-surfaces.json` 与各包 `package.json`（逐文件测试引用不再列）。

## 4.6 手工移植登记（hand-transplant register）

本节登记**手工移植 / 镜像上游形态**的面：上游锚（当前 pin 的 vendor 树）→ 本仓落点、移植形态、有意分歧 / 我方增量、今日钉法、升 pin 复核触发。人工台账，与 §4.5 同规矩**无 C 编号门**；文件级分类（`[own]` / `[patch-*]` / `[pure]` / `[dropped]`）仍归 §2 / §9 生成块，本表不重复；版本值不进本表。**评审义务**：新增这样的面（或上游新增的占用者 / 键值被本仓接手）时，先补本表一行，并按 §7 第 5 步交用户裁决**采纳 / 跳过 / 替换**——默认处置只有「上报待裁」，不得默认拒绝、也不得静默跟随；升 pin 时按 §7 第 6 步逐行照面复核。**移植形态词**：形态副本（上游组件 / 标记的 markup 逐字复刻）｜逐字副本（源码级复刻）｜行为镜像（语义等价、实现不同）｜声明转移（座席 / 契约声明的所有权转移）。

> 每条「今日钉法」的测试文件清单按 R8 归单源：门与包测试入口 = `scripts/gates/registry/gate-surfaces.json` / 各包 `package.json`；升 pin 时按 §7 第 6 步逐行照面复核。

- `ArchiveSessionRowButton`（`sidebar.workspaces.session.row.action` order 100）→ 侧栏 `ServerSectionRows.tsx` 行悬停动作簇（形态副本；aria 名参数化、归档行翻转为「恢复」、拖拽尾随 click 门、类名 `.actionIcon`）；`ui-primitives` 的 `HoverCard`/`overlayTopMargin` → `RowHoverCard.tsx` + client-core `hover-intent.ts`（形态副本 + 行为镜像，C15 见 §4）；`AnimatedRows.tsx` → `rows/animated-rows.tsx`（逐字副本，props 接口留包内）；`useTitleMarquee` → `session-title-marquee.ts`（逐字副本，同常数；data-scrolled/data-clipped 由本仓样式消费）；`Rows.tsx` 行首/悬停座席（`sidebar.session.row.{leading,trailing,hover}`）→ `ServerSectionRows.tsx` + `index.ts` 声明 + `contract/slots.ts`（声明转移 + 行为镜像：只对本实例求值，外来源行不渲染该座席；守卫同上游 `!archived && !blank`；三席声明权本仓代持（vendor 补丁 13），trailing 不采纳）；`HeaderLeadingControls.tsx` → `SidebarLeadingControls.tsx`（形态副本 + 声明转移，`shell.leading` 占座）。
- 侧栏面板 `sidebar.panel.trailing` / `sidebar.panellist.trailing`（上游 `ui-sidebar` 的 `PanelTrailing` 与内联子洞）→ **E 已裁：不采纳（2026-11-23 用户授权推荐默认）**；本仓不声明、不注册、无自建组件（`panel-trailing.tsx` 已删）；vendor pin 仍声明两洞，仅作 pin 事实登记（design 05 §2 / 06 §4.7）。
- `SidebarRoot.tsx` 的 darwin 顶部带 + `.topStrip`/`.logoRow` → darwin 分支 + module.css（形态副本 + 几何值镜像；透明三组加 `[data-window-vibrancy]` 门）；`sidebar.panellist` 全局面板轴（`syncPanels` + `PanelRow` + `panels.label`）→ `ServerSectionHeader.tsx` 宽态紧凑入口 + `SidebarRoot.tsx` rail + client-core `panel-axis.ts`（行为镜像 + 位置有意偏差：宽态不再有上游 `nav[aria-label=panels.label]` 分组壳；宽态 20px `.actionIcon` 静息隐藏、rail 行 36px；上游点击埋点 `sidebar_menu_click` 未复制）；`SessionArchiveConfirmDialog`（`shell.overlay`）→ `SessionArchiveConfirmDialog.tsx` + `session-archive-confirm.ts`（形态副本 + 文案转录：Modal 与入口归本仓、generic 活动行阶梯、框内 `role=alert` 失败行、单层 Modal）；官方应用内 Modal chrome（删除工作区）→ `sidebar-root-dialogs.tsx`（行为镜像 + 文案转录：焦点入框/归还 opener、四开启点单层闸门、来源消失撤武装）。
- `PinSession.tsx` 两入口 + `PinnedIndicator` → 侧栏行菜单首项 + 悬停置顶钮 + 静息标记 + client-core 置顶集投影/unary 出口（形态副本，不注册官方座席；置顶渲染分区 `pin-partition.ts`：块内拖拽/账号写未做、unpin 回自然位；失败走行级 `rowErrors`；`pinSetKnown !== true` 时标记不出现）；`WorkspaceBrowser.tsx` 的 `ViewOptionsMenu` → `ServerSectionHeader.tsx` 视图选项菜单（形态副本；per-source 轴、密度 compact、`archiveSetKnown !== true` 时筛选轴禁用；排序偏差 B1）；`SectionMembers` 置顶分区 + `pin-order.ts` → client-core `pin-partition.ts`（行为镜像（选项1：不写账号）；manual 块内取宿主 `pinnedSessionIds`、updated 保持 account 序）；`owningParentFolder`/`groupByWorkspace` 前缀嵌套 → client-core `workspace-tree.ts` + `ServerSection.tsx`（行为镜像：家族优先（上游纯前缀，design 08 §3.3）、synthetic/未分组不嵌套、只缩进不改序）；`SessionMemberIds`/`deriveFlat` → client-core `flat-account.ts` + 平铺渲染（每来源一个平铺账号：manual=flatOrder[sourceId]、updated=NUL 哨兵，拖拽只写本地；成员集与 workspace 折叠无关）；归档行 unarchive 半支 → 归档行形态与恢复翻转（形态副本；搜索命中行用单一 button + 行后文本动作）。
- `RowActionToast` 归档通知（只剩 `archivedNotOpenable`）→ 来源内普通警示 + `sidebar-root-notices.ts`（形态副本/部分移植：落触发来源 section 内、折叠门内、per-shell 瞬态、无动作、3s；成功/失败另承载 `toast.sessionIdCopied`/`CopyFailed`；上游新增 `workspace/archive-notice`/`archive-followup-*` 通道不采纳，待裁见 STATUS §1.3）；`ui-workspace/session-actions/context-menus.tsx` 的 `SessionIdInjected` → 行菜单项 + `writeClipboard` + locales（行为镜像；`SourceNoticeKind` 三态）；`WorkspaceBrowser.tsx` 注意力水位 → `ServerSection.tsx` + client-core `session-row-window.ts`（行为镜像；注意力行抬前缀窗口、自动上限 50、每工作区单调 floor）；`ui-workspace`/`ui-sidebar` 的 `locales.ts` 键值 → 侧栏 `locales.ts`（形态副本，词典值逐字；键为本仓并集）；宿主 runtime service 的 fork 标题递增 → client-core `fork-titles.ts` 的 `increasedForkTitle(title, taken)`（递增逐字副本 + 两参 skip-taken；taken 由 `session-mutations.ts` 按来源汇合、含在飞预留——本仓增量）；brand 按钮（上游无 Tooltip 包裹）→ `SidebarRoot.tsx` brand 洞直接渲染 button（有意去掉包裹层，aria 保留）；`apps/desktop/src/login-shell-environment.ts` → `packages/control-plane/src/login-shell-env.ts` + `hostEnv`（行为镜像：显式 failures 进启动日志、进程级一次读取 memo、PROBE_ENVIRONMENT 键集与 `DSH_*`/`ELECTRON_*` 保护、候选链 `-ilc`/`env -0`/超时杀进程组、gateway 不调用）；`ui-sidebar-files` 的 `sidebar.right.tab.files.actions` 声明 + 官方 `ui-open-in-app` 占座 → `dsh-chamber-client-ui-open-in` 同槽占座（声明镜像 + 同槽占座，per-source 目录/记忆与远端门照旧）。
### desktop-host 宿主侧文件（非 `apps/desktop/src`）

> 上游 `apps/desktop-host/src` 是 Electron Desktop 的 Host 侧入口/适配层（Desktop profile 的 CLI/引导/诊断/退出/更新任务），**随 Electron 冻结仅作复活参考**：本仓以控制面宿主生命周期 + 共享 sidecar 装配替代多数面（逐文件落点/差异见 registry 四条 mirror 条目 evidence 与 docs/progress/electron-frozen.md §5；Windows 腿复活时按该文件复活清单重裁）。仍现行 = office 启动行与 `DSH_PRIMARY_RUNTIME` 姿态（S-58；缺件 fail-open 缺口登 STATUS §1.7，见 design 18 §4.2）。

## 5. 再生物登记

|再生物|源|提交纪律|
|---|---|---|
|renderer typert工件（gen-typert-remotes输出）|vendor typert/remote源码|**构建期生成、`.gitignore` 忽略，不提交**（`renderer/src/generated/`；升级后由 `build:renderer` 重生成）|
|host dist ×4（`dist/index.js`，含seed-open-in）+ `dsh-runtime/dist/index.js`|chamber host包src / dsh-runtime src|**构建期生成、`.gitignore` 忽略，不提交**（clean checkout 由 `pnpm run build:artifacts` 自举；C8 逐组重建-比对硬失败盯陈旧）；两个build脚本都带 `absWorkingDir`，产物与调用者CWD无关|
|boot manifest / perf-sizes|build:renderer|构建产物diff随批审查|
|schemastery桩loader（connection/web测试）|vendor source-only现实|新增vendor运行时导入面时同步补桩|

## 6. 保鲜自动化

- `node scripts/upstream/verify/verify-upstream-touchpoints.mjs`（除 C8 正常路径「重建-比对后原样还原」外只读；中断/并发/额外产物路径由整目录快照 + SIGINT/SIGTERM 处理器 + `wx` 独占锁兜底）。门清单 C1–C16 以脚本头注为权威（C1 pure 字节恒等 / C3 完整性 / C4 roster / C5 过期锚 / C6 EXCLUDED / C7 种子域 / C8 生成物重建 / C9 vendor 补丁锚 / C10 版本锚 / C11–C14 受保护集合与代耦合 / C15 悬停卡退役 / C16 vendor 源消费者；判据纯函数在 `plugin-protection-gate.mjs` / `verify-upstream-touchpoints-vendor.mjs`，负例随 `pnpm run test:upgrade-tools`）。CI 两条腿 Bootstrap 后 pre-install 跑 `--no-artifact-rebuild`（C1/C3–C16，C8 advisory）、post-install 跑完整门；C2 `--tags <old> <new>` 本地 advisory（遍历 registry 分类条目）；参数守卫与退出码（措辞与脚本头注同源）：默认模式会就地重建并还原构建期生成物（唯一写盘路径），因此未知参数/位置参数由 `verify-upstream-touchpoints-args.mjs` 判为用法错误——`--help`/`-h` = 打印权威用法文本、exit 0，不跑门、不写盘；未知参数（如拼错的 `--no-artifact-rebuid`）、位置参数、重复 flag 或 `--tags` 缺值 = exit 2 且不先跑门；门硬失败 = exit 1；全通过 = exit 0；registry 单一来源与生成闭环（`registry.json` 为唯一机器来源）：`registry-views.mjs --check|--write`（生成物保鲜；手改生成块 ⇒ `verify-registry` 红）、`verify-registry.mjs`（schema / canonical / 引用存在性 / deviations id / 覆盖面网（§2.x 标题 ↔ 条目、`chamberNamedForks` ↔ `versionAnchor: chamber`、`excludedUpstreamDirs` ↔ `ensure-harness-vendor` 的 EXCLUDED、§4.5 seat 审计表 ↔ mirror 条目 ⑤E）/ 生成块字节一致）、`check-anchors.mjs`（registry 符号锚可解析 + 遗留 `文件:行` 锚预算棘轮，只降不升；`--report` 出漂移与测试面三分类，`--fix --file <md> [--apply]` 只回写「同行唯一可解析符号」的锚点、拒绝生成块）；`scripts/upstream/pin/preflight-vendor-pin.mjs <tag>`（只读，§7 第 0 步）：覆盖三个 shadow fork 面，另报深引 vendor seam 文件、上游包集合增删、新增 client 行、运行时 npm 状态，以及两类「被吞掉的新增面」——dropped 面变化（带 drop 理由）与名词差集（上游新增而本仓副本没有的导出 / `@Remote` 方法 / 点号座席键）；纯函数单测随 `pnpm run test:upgrade-tools` 在 CI 跑。`update-vendor.mjs` 完成输出提示运行本脚本；不进 preinstall。

## 7. 每 tag 维护循环（预检 + 8 步）

> 分工：本节是**触点序**（预检 + 8 步，含 0.5）；**阶段序**见 [`dsh-upgrade-checklist.md`](./dsh-upgrade-checklist.md) §0–§7——同一循环的两个视图，都要走完；判据只在 §6 增删，本节不另立清单。
> 顺序硬约束：`pnpm install` 必须在 `ensure-harness-vendor.mjs`（或根 `preinstall`）之后——先 install 再 bootstrap 以 0 退出但只装 20/304 个 workspace 项目（vendor 依赖缺失），随后 `build:renderer` 才报 `Rollup failed to resolve import "lexical"`。CI 的 linux/win 两条腿都已是 `Bootstrap → install`。

0. 预检（动pin之前）：`node scripts/upstream/pin/preflight-vendor-pin.mjs <tag> --offline` —— 一次给出「fork pure/replay + **dropped 面变化（带 registry 的 drop 理由）** + 深引vendor seam文件 + 上游包增删 + 新增client行 + 运行时npm状态 + **名词差集**」；`--fail-on-replay` 可当硬门。（C2只报fork面，本脚本另覆盖seam与roster面；dropped 面变化与名词差集是「上游新功能被 chamber 改写吞掉」的两个预检口；名词差集只报不判，dropped 的测试/配置/README/文案数据 噪声面只报不计。）
0.5. 结构登记改动只改 `scripts/upstream/registry/registry.json`，然后 `node scripts/upstream/registry/registry-views.mjs --write` 重生成 §2/§9 的块，`node scripts/upstream/registry/verify-registry.mjs` 必须绿（手改生成块或漏改 registry 都红）。
1. 读C2报告逐面裁决；仍open的偏差登记进 `docs/progress/STATUS.md`——本表只更新结构登记行，
   不记版本值、不加「追踪 <tag>」行；
2. `node scripts/upstream/pin/update-vendor.mjs <tag>`（原子升级 + 锁文件重生成）；
3. C2触点报告（`--tags old new`）→ 逐文件裁决：重放 [pure]/[patch-*] 或改登记；
4. fork重放 + 版本标记同步（三副本 → 新版本）；
5. roster pass：covered/factory存在性、typert契约、新增官方行裁决；**侧栏新增内容面必须提请用户裁决，不得默认拒绝**——上游若在侧栏（`sidebar.*` 任一键：会话行/工作区行/页脚/设置/面板入口等）新增声明、新增占用者，或把内容注册进「已声明但本壳未渲染」的键，逐条列出并交用户裁决采纳/跳过/替换；默认处置只有一条：**上报待裁**，不得以「本壳不渲染」为由拒绝或静默丢弃（键仍被声明 ⇒ 第三方 `inject` 不会失败，面却不会出现，静默即漏裁决）。差集取法：`grep -rhoE "'sidebar\.[a-z.]+" vendor/harness-checkout/packages/client/ui-*/src/client/index.ts | sort -u` 对 chamber 侧栏 `packages/dsh-chamber-client-ui-sidebar/src/client/index.ts` 的声明表 + 各渲染点，逐键判定「已渲染 / 未渲染待裁」；裁决结果按 §2.7 登记行或 `STATUS.md` 偏差条落账；
6. 契约复验：contract-mirror 表逐行（§4）+ 相关测试；插件管理页容纳层的 DOM 缝先跑 §3 末条的锁步门（`pnpm --filter @dsh-chamber/dsh-chamber-client-ui-settings-plugin-manager test`；跑在 `test:plugin-manager` 腿里，红了即形状已变，按本步重锚），再按 §3 末条 grep 复核（`data-plugin-panel`、页头/More/详情三条 `data-window-drag`、页根直接子 `[data-slot]`、`settings.section` 的 `plugin-manager` 注册）：零命中或形状变化 ⇒ 按 STATUS 偏差条裁决。
7. 运行时线与源码线必须**同一提交**（C5「fork 版本 == 上游源码版本」与 C10「fork 活字面量 == 运行时锚」的联合不变量：拆批的任一中间态必红，历史 pin 升级均为单提交）；bundle-dsh 刷新 + 六锚 + bin.js 冒烟是其中的步骤；机械面单批跑 `node scripts/upstream/pin/pin-upgrade-pipeline.mjs <tag>`（打印六锚/3 fork 的 unified diff、派生锁文件只报重生成命令，随后 `registry-views --write` / `verify-i18n --write` / `verify-upstream-touchpoints` 收尾；不自动提交、不改判据，锚值仍人工按 diff 落笔）；
8. 文档回写：CHANGELOG/STATUS + registry 刷新后重生成本表 §2/§9（`registry-views.mjs --write`，`verify-registry.mjs` 绿；版本值不进 checklist）+ i18n 重录；另做两项**无门禁**的目检——① 全仓 docs/README 的「当前基线」版本/tag 字面量复扫（旧值只许留在历史叙述，如「…起」），② 运行时闭包 diff 的**非 experimental** 增删目检（C11 只双向看守 experimental 白名单，非 experimental 名字的进出没有信号；新锚点一律写符号锚，勿加 `文件:行`）。

## 8. PR 评审清单条目

改动含下列任一项 ⇒ **必须**登记/刷新本表与 verify 脚本（PR 模板已含自检项）：新增 `@deepseek-ai/*` 深导入或裸 vendor 运行时导入面（→ §3/§5）；修改 fork 副本文件（pure 面改动会被 C1 拦，`[patch-*]` 须同批更新登记原因）；镜像新上游 wire / 契约（→ §4）；新增再生物（→ §5）；covered/factory/assembly 行变化（→ §3）；触点/分类/契约结构变化 ⇒ 改 `scripts/upstream/registry/registry.json` 并重生成 §2/§9（`verify-registry` 是硬门）；新增文档锚点一律写符号锚 `path#symbol`，遗留 `文件:行` 锚只降不升（`check-anchors` 预算棘轮）。

## 9. 触点总表（生成）
> 由 `scripts/upstream/registry/registry.json` 生成；机械索引，表格**禁止**手改；散文在本表之外。

<!-- GENERATED:registry:touchpoints.index:begin -->
| id | 类型 | 上游 | 我方 | 判据 | 偏差 / 门 | 状态 |
|---|---|---|---|---|---|---|
| `fork.dsh-client-connection` | fork | `packages/client/connection` | `packages/dsh-client-connection` | C1, C2, C3, C5, C6 | — | aligned |
| `fork.dsh-client-web` | fork | `packages/client/web` | `packages/dsh-client-web` | C1, C2, C3, C5, C6 | packages/dsh-client-web/test/boot-nctx-dispose.test.ts, packages/dsh-client-web/test/seed-manifest.test.ts | aligned |
| `fork.dsh-api-gateway` | fork | `packages/api/gateway` | `packages/dsh-api-gateway` | C1, C2, C3, C5, C6 | G43, packages/dsh-api-gateway/test/behavior/carrier-code.test.ts, packages/dsh-api-gateway/test/behavior/client-unary-result.test.ts, packages/dsh-api-gateway/test/behavior/client-uplink-support.test.ts, packages/dsh-api-gateway/test/behavior/mux-self-heal.test.ts, packages/dsh-api-gateway/test/behavior/stream-auth-close.test.ts, packages/dsh-api-gateway/test/patch-lock/base-path-normalization-lock.test.ts, packages/dsh-api-gateway/test/patch-lock/journal-stall-watchdog-lock.test.ts, packages/dsh-api-gateway/test/patch-lock/remote-stream-carrier-retry-lock.test.ts, test:api-gateway, typecheck:api-gateway, typecheck:connection, verify:upstream-lifecycle-contract | open |
| `seed.dsh-chamber-seed-open-in` | seed | `packages/host/open-in-app` | `packages/dsh-chamber-seed-open-in` | C1, C2, C3, C5 | packages/dsh-chamber-seed-open-in/test/pure-copies-lockstep.test.ts | aligned |
| `seed.dsh-chamber-client-ui-layout` | seed | `packages/client/ui-layout` | `packages/dsh-chamber-client-ui-layout` | C1, C2, C3, C5 | packages/dsh-chamber-client-ui-layout/test/document-theme.test.ts, packages/dsh-chamber-client-ui-layout/test/layout-store.test.ts, packages/dsh-chamber-client-ui-layout/test/theme-presenter-lifecycle.test.ts, test:layout, typecheck:layout | aligned |
| `fork.dsh-chamber-client-ui-sidebar` | fork | `packages/client/ui-sidebar` | `packages/dsh-chamber-client-ui-sidebar` | C1, C2, C3, C5 | packages/dsh-chamber-client-ui-sidebar/test/plugin-kernel/foreign-panel-axis.test.ts, packages/dsh-chamber-client-ui-sidebar/test/plugin-kernel/panel-entry-placement.test.ts, packages/dsh-chamber-client-ui-sidebar/test/plugin-kernel/panel-source.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-rows/archived-filter.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-rows/flat-list.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-rows/pin-partition.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-rows/view-options-menu.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-rows/workspace-tree.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-state/session-status-alpha1.test.ts | aligned |
| `mirror.dsh-api-session-controller-goal` | mirror | `packages/api/session-controller` | `packages/control-plane` | — | packages/control-plane/test/protocol/session-mux.test.ts, packages/renderer/test/session-state/source-mux-facts-goal.test.ts | accepted |
| `mirror.dsh-session-status-write-face` | mirror | `packages/api/session-controller` | `packages/dsh-chamber-client-ui-sidebar/src/client/status-write-face.ts` | — | packages/dsh-chamber-client-ui-sidebar/test/session-state/session-status-alpha1.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-state/status-write-face.test.ts, packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts | accepted |
| `mirror.dsh-desktop-carrier-seats` | mirror | `apps/desktop/src` | `packages/desktop` | — | S-56, macos/Tests/DSHChamberTests/HostPathCatalogTests.swift, packages/desktop/test/ipc/bridge-shim-document.test.ts, packages/desktop/test/ipc/bridge-shim-host-paths.test.ts, packages/desktop/test/ipc/desktop-carrier-surface.test.ts, packages/desktop/upstream-seats.test.ts, packages/renderer/test/frame-chrome/host-path-scope.test.ts | accepted |
| `mirror.dsh-desktop-shortcuts-seat` | mirror | `apps/desktop/src` | `macos/Sources/DSHChamber/Resources/bridge-shim.js` | — | S-54, packages/desktop/test/ipc/bridge-shim-document.test.ts, packages/desktop/test/ipc/desktop-shortcuts-bridge.test.ts, packages/desktop/test/local-state/chamber-settings.test.ts | accepted |
| `mirror.dsh-desktop-native-chrome-seats` | mirror | `apps/desktop/src` | `packages/desktop` | — | packages/desktop/chamber-lock.test.ts, packages/desktop/shell-locale.test.ts, packages/desktop/test/desktop-shell/fatal-report.test.ts, packages/desktop/test/desktop-shell/startup-recovery.test.ts | accepted |
| `mirror.dsh-desktop-update-chain` | mirror | `apps/desktop/src` | `packages/desktop` | — | packages/desktop/test/desktop-shell/updater-attention.test.ts, packages/desktop/test/desktop-shell/updater-channel-seal.test.ts, packages/desktop/test/desktop-shell/updater-main-wiring.test.ts, packages/desktop/test/desktop-shell/updater-revision.test.ts, packages/desktop/test/desktop-shell/updater-watchdog.test.ts, packages/desktop/test/ipc/shell-ipc-update.test.ts, packages/desktop/update-journal.test.ts, packages/desktop/update-schedule.test.ts | accepted |
| `mirror.dsh-client-hmr-plugin-events` | mirror | `packages/client/hmr` | `packages/renderer/src/hmr-events.ts` | — | packages/renderer/test/lifecycle/hmr-events.test.ts, packages/renderer/test/lifecycle/live-graph.test.ts | accepted |
<!-- GENERATED:registry:touchpoints.index:end -->
