# 09 · dsh 客户端插件运行时加载（方案 A：每实例合并宿主 boot 图）

> **状态：现行（方案 A：chamber 自有 host 行暴露宿主 boot 图，前端按实例合并加载，2026-12）**——本文是客户端插件运行时加载的权威行为契约：官方 `dsh.client` 链路与 chamber 消费点、每实例宿主图合并与去重、N-ctx 生命周期、失败降级与诊断分类、vendor 补丁集与信任边界；未完成门禁见 `docs/progress/STATUS.md`。与设计 08（git worktree 插件，**构建期强制打包**的 chamber 客户端插件）互补：08 走编译期打包，本文走**运行期加载**（第三方/自研 `dsh.client` 包，装进 profile 后前端按实例加载，不重新构建 chamber 前端）。

## 1. 背景：官方机制与 chamber 的消费点

dsh 官方 web 的客户端插件链路是完整的（已核 vendor 源码）：

1. 宿主 Loader 的行 → 包声明 `dsh.client: {platform:'web'}` + `exports["./client"]`
   → 即为客户端插件（boot 图 entry，id = 包名）；
2. `dsh-client-modules`（宿主行，web profile 默认挂载）扫描这些行，组合 boot 图
   `{rev, entries:[{id, url:'/plugins/<id>/client.js?rev=…', rev, inject?, immediately?}]}`
   （`src/index.ts` 的 `ClientModuleRegistry`），tap index 把图注入 `window.__DSH_BOOT__`，
   并服务 `/plugins/<id>/client.js`（含 source map）；
3. 前端 shell 读 `window.__DSH_BOOT__` → `parseBootManifest` → 模块表 →
   按需 `load(url)` 加载每个 entry（browser half `ClientModuleSystem`，自注册进
   `window.__ModuleLoader__`，物化/缓存/依赖边齐全）。

**chamber 侧的消费点在第 3 步**：控制面服务自建 dist（`packages/renderer` vite
产物），注入的是**构建期写死的复合 entry 清单**（`scripts/gen-boot-manifest.mjs` 写
`dist/manifest.json`，只有 `@dsh-chamber/app` 一个复合 entry，05 §6）；除此之外
chamber 自有 host 行把宿主图按实例暴露给前端，前端**每实例合并**该图并加载复合
bundle 未覆盖的 entry（方案 A，§3）。第 1、2 步在 chamber 托管的本地实例上照常运行
（本地 host 跑官方 web profile，`dsh-web-app` 的 `cordis.patch.yml` 挂载 `modules` 行），
`/api/i/<id>/plugins/<id>/client.js` 也已被通用反代全量透传（03 §3，无方法白名单）。

推论（与用户问答结论一致）：

- **宿主侧插件**（服务/工具/API 行）→ 可装：profile 装包 + `cordis.patch.yml`
  insert（机制即 `dsh plugin --profile <name> add <pkg>` 的 pnpm 转发 + 对账；
  本地实例 `$DSH_HOME = <userData>/state/dsh-home`，profile = `$DSH_HOME/profiles/web`）。
- **客户端插件**（`dsh.client` 行，带前端 UI 半身）→ 界面半身由 chamber 前端按实例
  运行时加载（本文方案）；设置页 Plugins 卡只配置内置行、plugin inventory 只读
  （`dsh-host-plugin-inventory` 仅 `list()`），都不是安装入口。

## 2. 目标与非目标

### 目标

- 任何**已装进 profile 的 `dsh.client` 包** → chamber 前端**按实例运行时加载**：
  装法维持官方语义（profile 装包 + `cordis.patch.yml` 加行），宿主图变化后
  chamber 前端自然看到新插件（重启实例即可，与官方一致：插件集变化在重启生效）。
- 本地与远程实例同等（远程宿主插件集不同，各自 ctx 加载自己的子集）。
- 宿主侧 / vendor **零改动**：图是现成的、bundle 是现成的、反代是现成的。

### 非目标（明确不做）

- chamber 自己的插件市场 / 安装 UI（安装入口仍是宿主侧 `cordis.patch.yml`）；
- 宿主侧插件安装流程改造（装法维持，见 设计 09 范围外）；
- 跨来源插件数据融合（插件仍是每实例一个 ctx 的普通 cordis 插件）；
- 运行时热装（改 `cordis.patch.yml` 后仍按官方节奏：重启生效；config-only HMR
  已有，不扩展）。

## 3. 设计：每实例合并宿主 boot 图

### 3.1 图来源（方案 A 现行，B 备选）

- **方案 A（现行契约）：chamber 自有 host 行暴露图**。chamber 自有小 host
  包 `@dsh-chamber/dsh-chamber-seed-client-graph`（`packages/dsh-chamber-seed-client-graph`，宿主
  侧，非 vendor），注册一个 Remote 暴露 `clientModules.graph()`（宿主 ctx 上
  `clientModules` 服务现成）。控制面在本地 profile seed 该行（`--patch` overlay，
  模块 B）——先例：`seedDshHomeDefaults` 已 seed `settings.yaml`。本文的模块 A
  为单包；同 seed 机制的 chamber 宿主包现为三个（+git-worktree（设计 08）、
  +archive-cleanup（设计 24）），机制同构、清单以 05 §6/02 §2.6 为权威。**包分发
  契约**：seed 时
  控制面把模块 A 包（package.json + dist/index.js）裸包拷贝进
  `profiles/web/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/`（免 pnpm 的裸包
  拷贝，行内注释记录），`--patch` 行经 profile node_modules 锚点解析。
- **方案 B（备选，未采用）：前端提取宿主注入的图**。`GET /api/i/<id>/` 反代到
  宿主根路径，宿主返回官方 web-app index.html（`modules` 行 tap 注入
  `window.__DSH_BOOT__`），前端正则提取。零 host/部署改动、远程天然可用；代价是
  HTML 解析脆弱（依赖官方 index 结构）。保留为兜底思路而非主路径（A 是长期契约）。
- **变体（不采用）**：控制面在宿主 ready 时拉图并经管理 API 中继给前端。
  缺点：图随 `cordis.patch.yml` HMR 变化，中继需要刷新协议，比前端直取复杂。

### 3.2 合并与加载

- 合并语义：**union + 按 entry id 去重**。chamber 复合 bundle 已含全部官方
  `ui-*` 包（`chamber-entry.ts` 静态注册），宿主图里这些 id **跳过**，只加载
  chamber 复合未覆盖的新 entry（用户新装包）。去重集 = `CHAMBER_COVERED_IDS`
  （`packages/renderer/src/chamber-covered.ts`，见 §3.5）。
- **反向依赖（现行仅 1 条；名单自 2026-09-11 起为派生）**：覆盖集解决的是
  「复合行不需要宿主图」，但反向依赖仍在——复合内首屏家族的 cordis inject 成员
  里，只有 `ui-chat` ← `sidebarRight`（`ui-sidebar-right` 行提供）来自**未覆盖**
  行（`ui-conversation`/`api-session-controller` 的 `fileUpload` 依赖已随
  `client-file-upload` **转为 covered** 消除，见 §3.6；渲染期 `useResource` 座
  `resources` 因「非任何复合插件的 inject、且不可能单独缺失」不再登记）。
  宿主图通道降级（返回 `[]`）
  或该行 apply 失败时，`ui-chat` 的 fiber 停在 PENDING、整个 apply 被跳过——会话视图
  不注册——而 boot 仍报成功。**两级自愈（2026-09-10）**：① 取图撞上
  `503 instance_unavailable`（实例仍在启动）时，shell 经 App 注入的 `waitForServing`
  门**等来源就绪**再取一次（`host-graph.ts` 的 `MAX_SERVING_WAITS` /
  `SERVING_HEAL_BUDGET_MS`，App 侧门上限 60s），而不是在固定预算（10×500ms）用尽后
  丢掉整套 profile 客户端插件——冷启动与重启跨越窗口正是这样丢的；② 门也用尽、或该行
  仍不 apply 时 boot **不再静默**：发布 `graph-unreachable` 诊断 + `console.error`
  点名 instance，并把 `ShellState.degraded`（`graph-unavailable` /
  `required-services-missing`）交给 App，由 App 在该来源 ready 时**自动重挂一次**
  （每个 ready 世代一次，纯判定在 `degraded-retry.ts`；此前只有整页 reload 能恢复）。
  ③ 同一道门被**设置壳**复用：`waitForSourceServing`（shared face
  `serving-gate.ts`，读 chamberBridge 投影的 `connected`）——桥的图读取在
  `instance_unavailable` / `dsh_not_ready` 这类**冷启动拒绝**上等来源并重试一次，
  不再把"实例还在启动"报成"插件图不可达"；终态来源（error/stopped/
  restart-exhausted）与未知来源**立即**失败，真实原因照旧呈现。
  `chamber-entry.ts` 的 `assertRequiredExtraRowServices`（名字不变；纯判定在
  `required-extra-rows.ts`）在 5s 内探测**派生并集**里仍未被 provide 的服务，点名
  「服务 + 注入它的已注册插件」，并把判词经 shell 的
  `chamberReportBootDegraded` 上报（**仍是诊断，不是启动门**：gateway/移动形态可合法
  不加载该行）。
  **被探测集合是派生的，不是手写清单（2026-09-11 upstream-alignment）**：首屏每个
  挂载都经 `chamber-entry.ts` 的 `register(id, plugin)`，由各命名空间**导出的
  `inject` 面**推导并集（`registeredInjectMembers` / `injectedServices` /
  `missingInjectedServices`，`required-extra-rows.ts`）——这正是上游
  `assertEntriesActive` 读的事实 `Object.keys(entry.fiber.inject)`
  （`packages/client/web/src/boot.ts:138-158`，本仓副本
  `packages/dsh-client-web/src/boot.ts` 另含版本容忍规则）；`register` 还用挂载
  fiber 的 inject 面作**见证**：命名空间若不再导出 inject 面而 cordis 仍读到成员，
  当场抛错（派生名单只会收缩、不会静默漏探，正是探针要堵的盲区）。延迟簇不进名单：
  其 chunk 在探测开始时尚未求值，且延迟拆分不变式（模块头）已把它们的 inject 成员
  固定在首屏服务内。名单成员变更即改 `chamber-entry.ts` 的 `register(...)` 调用，
  不维护第二张表；口径变更须同步 `host-graph.ts` 的降级注释与
  `docs/checklists/upstream-touchpoints.md` §2/§3 登记行。
- **覆盖集也是模块表的 factory 提供方**：被跳过的覆盖行不是
  "不存在"，而是由复合 bundle 替代——共享模块表对 fetch bundle 的**同步 require
  边**只有 seed → statics → 已物化缓存（loadCache）→ 已注册 factory 一条解析路径
  （client-modules system.ts），官方图靠"每行一个 row-factory"回答这些边；chamber 把覆盖行的
  bundle 换成了复合 bundle，就必须由复合 bundle 注册这些 factory，否则覆盖
  包的 require 边落空。首个实机案例：官方工具链的 store-engine 豁免
  （upstream tsdown.client.ts `RUNTIME_STORE_EXEMPTION`）使每个值导入
  `createSnapshotStore` 的 client bundle 都会 emit
  `require("@deepseek-ai/dsh-client-runtime/client")`——runtime 是覆盖行，而
  默认 web profile 的 `dsh-session-log-export`（非覆盖的额外行）正是这种
  bundle，boot 在物化其 factory 时响亮失败。修复：chamber-entry.ts 在 bundle
  执行时（早于任何 entry 物化）为**每个首屏静态导入的覆盖包**注册一个
  factory，返回复合 bundle 内联的同一命名空间（require 边与 ctx 服务同实例）。
  deferred 家族不注册（其 chunk 在 settle 后才到；官方也只保证 immediately
  层级的同步 require，且 purity gate 本就禁止值导入 ui-* 包）；page-own 覆盖
  id（modules、被 chamber 替换的官方 sidebar/layout 注册）无命名空间、不是
  合法 require 目标。维护纪律：首屏工厂 id 以
  `CHAMBER_COVERED_FACTORY_IDS`（chamber-covered.ts 的 leaf 契约）为可测试
  面——CI 单测断言每个 id ∈ `CHAMBER_COVERED_IDS`（host-graph.test.ts），
  chamber-entry 执行期断言 `COVERED_FACTORIES` 与该列表**精确一致**且每个
  id 均被覆盖（漏加即 fail-loud——漏加的 id 会以额外行执行官方 bundle，与
  复合 factory 重复注册；map 与列表漂移同理）。
- **首启竞态纪律（05 §4）**：额外 bundle 的脚本在**加载时即执行**
  并自注册 factory（script load 事件在求值后触发），注册 sink
  （`window.__ModuleLoader__`）必须先于任何 bundle 脚本存在。若先预加载后
  `AppWebEntry.run()` 才装表，页面**首个**带额外行的 boot 会让脚本在
  sink 安装前求值——官方 bundle 的无守卫顶层交接抛错、factory 永未注册、
  boot 以难懂的 "cannot resolve" 失败（实践中被宿主就绪时序掩盖：首 boot
  通常 503 降级装表，之后的 boot 才带额外行）。因此 boot.ts 导出幂等的
  `ensureWebModuleSystem`（首次装表 + 注册 statics，其后复用），shell.ts 在
  `collectExtraRows` 预加载**之前**调用它；`AppWebEntry.run()` 经同一 helper
  收编（N-ctx 复用分支成为唯一路径）。manifest 缺失/畸形时跳过额外预加载
  （无 sink 不执行任何 bundle），boot 照常以同一错误响亮失败。
- 加载：`ClientModuleSystem.load('/api/i/<id>/plugins/<pkg>/client.js')` —— browser
  half 本就支持任意 entry 的加载/物化/缓存/依赖边；bundle 自注册进共享模块表
  （N-ctx seam 已存在），与官方 shell 加载方式一致。`?rev=` 沿用宿主图（缓存锚），
  `immediately`/`inject` 边在激活时尊重（官方 system.ts 逻辑复用，不重写）。
- 生效节奏：与官方一致，插件集变化在实例重启后生效（图来自宿主现成组合）。

### 3.3 N-ctx 与去重

- 额外 entry **按实例**加载：本地与远程宿主插件集不同，各自 ctx 只激活自己的
  子集；共享模块表可容纳并集（表已共享，05 §4）。
- 页面级模块物化的 60s queue 护栏只允许**其他 instance**绕过一个不 settle 的
  boot；相同 instance 由 per-id boot tail 严格等前代 `run()` settle + 异步
  `ctx.fiber.dispose()` 完成才建新 Context；有同 id 前代时，后继连 host graph fetch /
  extra-bundle 执行也须延后到该 tail 释放（它们会修改共享模块表），无同 id 前代的
  不同来源仍可 eager prefetch。这样跨来源保留并发，却不会让同容器出现双 React root、
  也不会让旧/新 ctx 的 producer 注册顺序反转。
  迟到 graph 诊断受 current-generation 门控；runtime/snapshot 投影则由每 ctx 注册的
  producer token 门控，旧 ctx 的异步 report/cleanup 不得覆盖或清掉新代。
- 去重规则在合并层做死：entry id ∈ chamber 复合注册集（chamber-entry.ts import
  清单）或页面自有 id（被 chamber 替换的官方 ui-sidebar 注册、被 shell 内核收编
  的 `@deepseek-ai/dsh-client-modules`）→ 跳过；重复注册会 cordis 冲突（复合
  bundle 已挂载同名包 / 同名 provide），显式跳过而非靠加载失败兜底。遗漏的去重
  id 在 boot 时**响亮失败**（duplicate registration，共享模块表拒绝重复 factory）；
  多出的 id 无害（宿主图没有该 id 时不会被过滤）。

### 3.4 改动面（全部在可改范围内，vendor 零改动）

| 面 | 改动（现行） |
|---|---|
| `packages/renderer` | `host-graph.ts`（`fetchHostGraph` wire 调用 + `dedupeHostEntries` 去重 + `toExtraRows` 注入反代前缀 + `collectExtraRows`，AppWebEntry 构造前预加载额外 bundle，`loadModuleBundle` 依赖注入可测）+ `chamber-covered.ts`（去重集）+ `required-extra-rows.ts`（首屏 inject 并集派生 + 缺失服务点名，§3.2）；页面级一次性加载与 rev 认领由共享 kernel（shared face `client-plugin-loader.ts`）维护 |
| `packages/dsh-client-web`（拷贝包） | `boot.ts` `AppWebEntryOptions.extraRows` seam：额外 entry id 合并进 boot rows（N-ctx 模块表共享 seam 的扩展，见 05 §6） |
| 方案 A 附加 | host 包 `packages/dsh-chamber-seed-client-graph`（Remote `clientGraph/graph` 暴露图）+ 控制面 `host-graph-seed.ts`（seed 宿主包进 profile + 物化 `--patch` overlay，`packages/control-plane`）；打包态分发：desktop main 传 `hostGraphPackageSourceDir = pkgDir/dist/host-graph-package`（asar 内，`build-host-graph-package.mjs` 产出、electron-builder `files` 含 `dist/**/*`），开发态走 repo 源码树 |
| 官方/宿主/vendor | 文件零改动（**唯一例外**是 §3.6 的构建期 vendor 补丁集：不改文件、只在我们自己的 vite transform 里按精确锚点改写，上游漂移即构建失败） |

### 3.5 加载契约（端点、seed 与去重集）

- **端点契约（全局固定，其他 chamber 模块依赖）**：namespace `clientGraph`、
  method `graph` → wire 端点 `clientGraph/graph`。调用形状与既有自建载体同款
  （如侧边栏 `instance-api.ts`；曾与之同款的 settings-bridge `bridge-api.ts` 已随
  2026-12 完整桥接修订删除）：
  `POST {base}/api/clientGraph/graph`（`{base}` = `/api/i/<id>` 反代前缀），body =
  `{type:'client-request', rpcId: crypto.randomUUID(), method:'clientGraph/graph',
  payload:{args:{}}}`，响应 envelope `{rpcId, result:{ok, value?, error?}}`。
  返回值 = `clientModules.graph()` 的 WebBootGraph 形状
  `{rev, entries:[{id, url, rev, inject?, immediately?}]}`——wire 形状单一来源 =
  vendor `dsh-client-modules/src/client/manifest.ts`。机制（已核实并原样采用）：
  宿主侧 TypertGatewayService（vendor `@deepseek-ai/dsh-api-gateway`）的 SRC 发现
  自动认领任何 TypertRemoteService 子类 + `@Remote` 标记的方法端点，无需 typert
  生成产物（参考 vendor `packages/host/plugin-inventory` 的
  `PluginInventoryGateway`）。gateway 为**纯只读投影**：不写、不执行、不触 Loader，
  每次调用直接返回 `this.ctx.clientModules.graph()`（无本地缓存——图在插件 fiber
  事件间是稳定对象，读即单一事实源）；`static inject=['clientModules']` 保证排在
  client-modules 宿主行之后启动。
- **图的行校验照上游、解析本身刻意更宽（A4，2026-09-11 upstream-alignment）**：
  `host-graph.ts` 的字段校验改用上游自己那两个纯 wire helper
  （`optionalStringArray` / `stripClientSuffix`，`manifest.ts`；后者取代此前内联的
  `endsWith('/client')` 切片），但**解析仍是本地的、且刻意比上游
  `parseBootManifest` 松**（`manifest.ts:167-256`）：上游要把整个
  `window.__DSH_BOOT__` manifest 解成两个消费视图，因此额外要求 `batches` 是数组
  （:186-188）、每个 entry 必须恰好属于某个 initial-load batch（:238-253）；chamber
  只读 `entries`（多 id combo 的 `batches` 被忽略——每行自带单 id combo url，见
  `toExtraRows`），所以**没有 batches、或某行没被宿主排进 batch 的图，仍是可用的
  chamber 图**，不得因此判 boot 失败（`host-graph.ts:185-198` 注释）。本地解析
  检查的每一项就是上游检查的那一项；present-but-malformed 的可选字段现在**抛错**
  而不再静默丢弃（丢 `external` 会藏掉延迟依赖诊断唯一要指认的那条 require 边）。
- **--patch seed（模块 B）**：`ensureSeedPackage(dshHome, packageName, sourceDir)` 把宿主
  包（package.json + dist/index.js）幂等分发进（同一入口按控制面注册表
  `CHAMBER_HOST_PACKAGES` 逐包分发；旧单包入口 `ensureHostGraphPackage` 已删除）
  `$DSH_HOME/profiles/web/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/`（内容
  hash 一致跳过、漂移覆盖；`web/node_modules`→scope→chamber package→dist 的每个
  owned 最终目录逐级 no-follow 校验，target 以稳定有界 no-follow 读取、随机 O_EXCL
  temp + file/parent fsync 原子写；源 package 仍是普通只读分发边界并允许打包 symlink；
  源目录缺失 = 优雅跳过，不报错）；
  `buildPatchOverlay(stateDir)` 物化 `<stateDir>/dsh-chamber-graph.patch.yml`——
  loader patch 列表格式（`[{insert:[{id:'client-graph',
  name:'@dsh-chamber/dsh-chamber-seed-client-graph'}]}]`，与 bundle 的 cordis.patch.yml /
  dsh CLI `--patch <path>` overlay 同格式，`@deepseek-ai/dsh-app-boot`
  loadOverlayPatches 为权威），幂等自愈（内容一致不动、漂移重写）。spawn 每次
  注入 `--patch`：`webProfileArgs(port, patchPath?)`（须在 `--profile web` 之后、
  web-app 自有 flags 之前），经 local-connection 对每次 spawn/重启透传；模块 A
  产物（dist/index.js）缺失时不注 overlay——命令行保持 v4 基础（一个插了行却
  解析不到的 overlay 会让宿主 boot 响亮失败，缺失模块 A 必须等价于"未发货"）。
  已运行的本地实例在下一次重启按官方插件集变更节奏生效。
  同一 spawn gate 内的首次 `settings.yaml` 默认值也复用 owner-private O_EXCL writer：
  `dsh-home` 最终目录必须真实，任何既有 settings leaf（包括用户自管 symlink）只视为
  “已有配置”且绝不打开写入，不再用递归 mkdir + 普通 `writeFileSync` 穿越 owned root。
- **远程实例 seed（设计 13 M2）**：远端 `$DSH_HOME` 经
  `seedRemoteChamberHostPackages`（exec write-file 原语）落地宿主包到
  平铺 fallback `profiles/node_modules`（跨 `dsh plugin` pnpm 操作持久）+
  `cordis.patch.yml` 列表 insert（生效节奏 = 官方插件集变更：重启后生效，seed 本身
  不重启远端）。接线：desktop main 在 SSH 实例转 ready 时自动 seed
  （幂等 hash-skip，单飞守卫）；插件管理 UI（远端同步视图）实时探测并展示注入状态
  （installed/patched），未注入时提供「注入」按钮（`desktop_ssh_seed_host_graph`
  IPC 的显式调用路径）——注入不是静默修改；本地列表视图同样展示本地注入状态。
  注入结果（成功 wrote/patched 或失败原因）写入实例环形缓冲日志
  （`transport-manager.appendLog`），连接设置页的远端日志面板可见。远程实例图通道
  不可达时按降级语义运行（无额外插件，不报错）。
- **CHAMBER_COVERED_IDS（模块 C 去重集）**：`packages/renderer/src/chamber-covered.ts`
  维护两个家族——① chamber 复合 bundle 静态注册的全部客户端插件包名
  （chamber-entry.ts import 清单：connection/typert/gateway/remotes/runtime/locale/
  theme/layout/settings 族/conversation/ui-* 全量/自研 chamber 插件等；向
  chamber-entry.ts 加插件时**同批**追加）；② 页面自有 id：`@deepseek-ai/
  dsh-client-ui-sidebar`（官方注册被 chamber 侧边栏替换，加载会撞 sidebar 槽）
  与 `@deepseek-ai/dsh-client-modules`（shell 内核自行收编该 entry，二次 provide
  `modules` 冲突）。独立成叶模块（chamber-entry.ts 仅 re-export）是为避免 shell.ts
  把 chamber-entry 的模块表交接及整棵复合插件图拉进主 chunk。
  与 §3.2 的 union-table 修复锁步：chamber-entry.ts 的 `COVERED_FACTORIES`
  （首屏静态导入族的模块表 factory 注册）中每个 id 必须在覆盖集内（执行期断言）。
- **extraRows seam（模块 D）**：`AppWebEntryOptions.extraRows`（`boot.ts`，可选、
  向后兼容）——chamber 侧已把额外 bundle 预加载完毕（bundle 执行时经
  `window.__ModuleLoader__.load({id, factory})` 自注册进共享模块表），seam 只把其
  id 合并进 boot rows（`loader.create` 经 `ClientModuleSystem.import()` 的 factories
  分支命中，无需 graph row），不 prefetch/不 fetch（chamber 侧统一预加载整个额外
  集合）。共享模块表拒绝重复 factory（system.ts 的 `__ModuleLoader__.load` sink），
  页面级一次加载保证由共享 kernel（shared face `client-plugin-loader.ts` 的
  `preloadedCombos`/`preloadedIds`）显式维护
  （成功后才标记；普通失败删除后可重试；DOM script 超时因移除元素不能可靠取消，
  先保留临时 tombstone 并观察明确的 `BundleLoadTimeoutError.bundleOutcome`：迟到 load
  收敛为成功，迟到 error 才删除并允许重试，绝不并发执行同 id 第二份 bundle；同 id
  异 rev 先到先得并上报 `restart-required`，用户不再面对静默版本复用）。
   **跨实例版本漂移**：同 id 异 rev 且首次认领该 id 的是
   **另一个实例**（如本地实例与 gateway 实例挂载同一插件、两个宿主运行在
   不同 dsh 运行时版本）→ 改报 `instance-version-conflict`——任何重启都
   无法切换（页级 first-load-wins 会原样重演），如实提示「对齐两个实例的
   dsh 运行时版本后可切换」；同实例异 rev（重建的插件）保持
   `restart-required`。跨实例**同 rev** 依旧复用、无诊断（模块表页级共享，
   同 id 同 rev = 同一 factory）。
- **同包 N-ctx 生命周期 seam（05 §4）**：`AppWebEntryOptions`
  另有同步 `configureContext(ctx)`，在 Context 构造后、任何 await/plugin
  materialization 前执行；`dispose()` 返回 Promise 并等待 root fiber teardown，
  `runtimeCtx` 在 dispose 开始即失效。该顺序由 `test:client-web` 的真实
  `AppWebEntry.run()` configure-context 用例固定，shell 的 same-id boot tail/
  per-id teardown barrier 再保证下一代不会与旧 Context 重叠；它不是页面级 knob。
- **构建期 generated Remote seam（renderer glue）**：复合壳源码复用官方
  `dsh-api-remotes/client`，但受管 vendor 只有源码、没有上游 tsdown 生成的
  `lib/typert.remote-client.js`。`gen-typert-remotes.mjs` 因而以该官方 client
  汇编的 **value import 集合为唯一选择源**，逐包校验上游标准 `./remote`
  exports/files 契约，再把 Host face 产物写入 chamber-owned
  `renderer/src/generated/typert/`；Vite 的通用 `/remote` resolver 只消费这些产物。
  当前 15 个 contribution（`EXPECTED_REMOTE_PACKAGES`，含 file/session/workspace
  reference）由独立锁步测试固定，
  避免手抄包表滞后后到 Rollup 阶段才报缺模块；vendor 始终只读。
- **失败降级与诊断语义（模块 C）**：图**通道**失败（fetch 网络错 / 非 2xx / 图畸形 /
  行缺 id/url/rev）→ 降级为无额外插件继续 boot + console.error，同时经 renderer-local
  chamberBridge 上报用户可见诊断（404/方法缺失 = `not-injected`，其余 =
  `graph-unreachable`；复合 bundle 仍
  提供完整官方壳，仅丢失 profile 新装的插件；畸形图响亮报错——错图是 boot 危害，
  不做猜测式合并）；503 `instance_unavailable` 是未就绪预期态，静默（图通道不可达
  时不会伪装成“本实例无额外插件”）。额外 **bundle 加载**失败**不降级**——响亮失败、
  该实例 boot 报错呈现（坏插件绝不静默消失，§4 fail-loud）。**实例重启跨代恢复
  （一轮有界恢复）**：普通加载失败先经**一轮有界恢复**再响亮失败——上游
  bundle rev 是**每进程随机 nonce + 行序号**（`dsh-client-modules`
  `allocateInitialRevision`，非内容哈希），实例每次重启都会令上一进程代的
  所有 bundle URL 失效；boot 的拉图与 bundle 加载若跨过重启（运行时切换 /
  restart-dsh / 插件同步重启均为 chamber 常规生命周期），未加载行会以陈旧 rev
  全部 404。`collectExtraRows` 因而对普通失败行重拉一次宿主图（同一 503 重试
  预算）并按 fresh URL 重载；仍失败（真插件问题——同 rev 重试也失败，或恢复
  期间再次重启）才响亮失败。DOM script **超时**不进恢复轮（tombstone 语义
  不变：迟到 load 收敛成功、迟到 error 允许后续重试）。恢复成功的行以 fresh
  url/rev 返回 boot 内核（旧代 URL 已死，不得作为可加载源下发）。
  **根治方向在上游（vendor 只读，登记不修）**：`allocateInitialRevision`
  改用内容哈希即可让 rev 跨重启稳定、整类 404 消失——激活扫描本就把每个
  bundle 读入内存（`initialBundleSnapshot`），哈希近乎零成本；chamber 侧
  恢复轮是约束下的缓解，非根治。
  **分层表述**："加载"由 chamber 预加载层负责（host-graph.ts `collectExtraRows`
  的 `loadModuleBundle` 失败即 throw → 该实例 boot 响亮失败）；预加载成功后内核
  不再为额外行发起新加载（factory 已注册进共享模块表），故 boot 内核层见到的额外
  行失败只剩 materialize/apply 一类，按下一条降级——"加载失败响亮"与"apply 失败
  降级"各归各层，不重叠也不遗漏。
- **额外行 apply 失败降级（模块 D）**：额外行**加载
  成功但 entry 未能 apply**（materialize 出非插件对象——如壳种子词表把某包
  静态注册、后端新增其 client half 后 seed 遮蔽
  factory 导致的 "invalid plugin"；注册进本壳未声明的槽；重复安装壳已提供的服务）→ **降级不致命**：
  console.error + status 'failed'，shell 照常 boot（boot.ts 对 extraRows 逐行
  容错 + sweep 排除）。理由：复合 bundle 固定一个 dsh client 版本，"后端 dsh 版本
  ≠ 壳版本"时新/旧核心行与壳不兼容是**正常条件**（特性缺席），不是损坏（§4
  fail-loud 保留给 manifest 行/app-shell 装配的损坏，以及额外 bundle 的加载失败——
  预加载层，传输/缺失才是损坏信号；boot 内核层对额外行只区分 materialize/apply）。
  诊断状态统一为：成功 `ok`，host gateway 未注入 `not-injected`，图通道失败
  `graph-unreachable`，额外 bundle 加载失败 `bundle-load-failed`，同 id 异 rev
  `restart-required`（同实例重建的插件），跨实例版本漂移
  `instance-version-conflict`（异 rev 且异 owner 实例，见 §3.5——任何重启
  都无法切换，须对齐两个实例的 dsh 运行时版本）。**诊断呈现面**：
  来源标题**不显示任何插件诊断标记**（侧边栏 `!` 徽标整体移除，含异常态与
  信息态）；状态、插件 id 与原因只显示在连接设置页与**每实例的插件管理弹窗**
  （设计 13 §6）——官方 dsh「插件」settings section 是 host inventory，不承载
  chamber 自有诊断。
  诊断发布还必须同时命中 boot 的 current generation 与未取消阈值；同 id
  retry 已开始后，旧 graph Promise 的迟到成功/失败都没有发布权。
  **通道类诊断自愈复检**：诊断按其语义分为两类——
  `not-injected`/`graph-unreachable` 是 **host-graph 通道事实**（记录于该来源
  最近一次 shell boot），可能**不经重 boot 自愈**（gateway 受管 dsh 在 boot 记下
  404 之后才带桌面同步的 chamber host 包受控重启；ssh 目标宿主包种子落地；传输
  恰好未就绪）；`bundle-load-failed`/`restart-required`/
  `instance-version-conflict` 是 **boot 事实**——只有重 boot 才能改变合并结果，
  任何通道复检不得触碰。连接设置页与插件弹窗因此对通道类诊断执行**复检**：
  连接页激活时与弹窗打开/刷新时，按 boot 拉图同一 wire（`/api/i/<id>/api/
  clientGraph/graph`、同一 envelope 与状态分类、同一消息文案）重新判定并写回
  chamberBridge（shared 面单源：`plugin-graph-recheck.ts`）。**写回纪律（防循环
  与新鲜度的契约前提）**：仅当判定**状态**与已记录诊断**不同**才写回——消息级
  漂移（如非确定性网络错误文案）永不写回，杜绝自触发乒乓；写回前同步重读
  store，记录若在拉图期间已被权威写入者（shell boot/退役清除）改动则放弃本次
  判定——迟到的复检判定绝不覆盖更新的记录；503 `instance_unavailable`（实例
  启动中/传输缺失）视为"无法判定"，永不写回。boot 仍是诊断的权威写入者；复检
  只是把已自愈的通道事实收敛为 `ok`，把仍坏的通道事实留在原样，等待下一次
  boot 或下一次复检。

### 3.6 vendor 源码补丁集（构建期改写）

N-ctx 同源壳要求每个实例的 API 走自己的反代前缀 `/api/i/<id>/*`。传输载波已由三个
fork 副本覆盖（connection / web / api-gateway）；**非载波**的官方绝对 URL 没有接缝——
`ui-chat` 的 `AssistantMarkdown` 用 `${window.location.origin}/api/file?path=…` 取
Markdown 里的本地图片，在同源壳里 origin 是控制面，于是 404（用户可见的坏图）。

裁决（以上游为准 + 最小侵入）：**不为一行 URL 去 fork 整个 `ui-chat`（82 文件 /
~11.3k 行）**，改为登记式 vendor 补丁集。

**本集合不含 open-in**：桌面打开面的本地目录自 2026-09-11 起改由实例进程内的
chamber host 包提供（`dsh-chamber-seed-open-in`，设计 20 §2.2/§6 的 fork & supersede），
既不读官方路由也无需任何同源 URL 补丁；客户端半是我们自己的插件，
base path 从每个 entry 的私有 ctx 取。

- 注册表 `packages/renderer/scripts/vendor-patches.mjs`：每条补丁 = 文件 + 理由 +
  一到多处 `expect`→`replace`，`expect` 必须**恰好命中一次**（0 次或多次 = 构建期
  抛错，绝不静默发出未打补丁的 bundle）。
- 应用点：renderer 的 `deepseekSource().transform`（我们的 vite 配置），vendor 文件
  **零写入**；模块 id 同时接受软链形式与 `realpathSync` 后的子模块形式（vite 实际
  给的是后者）。
- 落点（共 7 个文件 / 21 处锚点，逐锚点由触点表 C9 与
  `scripts/vendor-patches.test.mjs` 校验）：
  ① `ui-chat` 的 `chat/AssistantMarkdown.tsx` + `chat/AssistantNodeView.tsx` 读取新增
  root 标准 **prop** `chamberFileApiBase`（chamber layout fork 经
  `ctx.slots.provideRoot({ props })` 提供，值 = 本 entry 的 `ctx.chamberBasePath`；
  vendor 的 scoped-slots 把 root 标准源合并进**每个**作用域的 standard props，所以
  session 作用域的 chat 节点也能拿到）；② `client-file-upload` 的
  `client/runtime.ts`（`/api/session/uploadFileBinary`）改从服务自身的 `ctx` 读
  `chamberBasePath`——**该包已转为 composite covered**，因为 extra-row bundle 由实例
  提供、永远不经过我们的构建；③④ `ui-deliverables` 的 `client/present-open.ts` +
  `client/index.ts`（`/api/present.host|open`），控制器由 `apply(ctx)` 构造时接收
  base path；⑤⑥ `session-log-export` 的 `client/controller.ts` + `client/index.ts`
  （`/api/session.export`，控制器字段；该包转 **covered-deferred**，否则 extra-row bundle
  不经过构建）。全部保留「base path 缺失 → 回落上游行为」的形状，读取一律用
  `ctx.get('chamberBasePath')`（cordis 代理对未 provide 的服务**抛错**，属性读取会炸）。
- 保鲜门：`verify-upstream-touchpoints.mjs` **C9** 对 pin 住的 vendor 文件逐锚点校验
  （硬失败），`scripts/vendor-patches.test.mjs` 另在 CI 侧验证锚点唯一、改写后的函数
  行为（含上游回落分支）与 id 形态匹配。

登记纪律：新增补丁前先问「能否在 chamber 自己的包里修」；只有同源绝对 URL 一类
硬假设才登记，并优先采用「可选的 chamber 标准 prop + 上游回落」的形状，使官方布局
部署保持正确。

## 4. 信任模型与边界（写进设计即写进契约；已同步进代码注释）

- **远程实例的 client bundle 会运行在本地 renderer 里**——与官方模型一致（官方
  web profile 同样加载宿主下发的一切：宿主是权威、loopback-only、v1 无认证面）。
  但这是安全相关事实，已在 `host-graph.ts` 与模块 A `src/index.ts` 的模块头注释中
  显式声明，不静默。
- 插件作者须提供**构建好的 `./client` bundle**（官方工具链产物；缺 bundle 时
  宿主 `ClientModuleRegistry` 激活即 fail-loud，chamber 侧同样报错不静默）。
- entry id 冲突 → 显式去重（§3.3）；`inject` 边缺失 → 官方机制已有的 loud 失败，
  不降级。
- **设置面不装载插件（2026-12 完整桥接修订）**：桌面设置壳**不再**为选中来源
  二次装载任何插件行。设置面渲染的是该来源自己 boot ctx 的 `settings.section`
  台账与它自己的标准座（design 05 §5），所以：①执行面回到「已打开/被面板要求挂载的
  来源自己的 ctx」，面板只保证该 ctx **挂在屏外也保持挂载**（`chamberBridge.setSettingsTarget`），
  关闭面板即撤除该保证；②没有第二次实例化 ⇒ 没有重复注册、没有跨来源模块共享报告、
  没有「未激活」报告，插件作者契约回到普通插件契约（模块级无状态仍是好习惯，
  但不再是设置面引入的额外约束）；③面板**不再**读 `clientGraph/graph`、**不再**经
  页面级 kernel 装载 bundle，`client-plugin-loader.ts` 的每实例图缓存只服务 boot 路径；
  ④来源自己的 `remote` 就是真 remote（WS 流在），不存在手工面与能力降级；
  ⑤未挂载完成的来源显示「正在启动该实例的前端」中间态，绝不伪造内容。
- **设置面贡献通道**：settings 页 `slots.inject('settings.section')` 通道**已接线**——
  第三方插件的设置贡献在**它自己那台实例**的 ctx 上注册（与该实例自己的前端完全同一份
  注册），桌面设置壳渲染该台账，因此「插件设置用不上/看不到」这一类问题由构造消除
  （design 05 §5）。上游声明式贡献描述符 / 设置面服务契约 / Remote descriptor 上行通道
  仍是可选提案（`docs/progress/todo/settings-surface-upstream-contributions.md`），
  不再是完整桥接的前置条件。
- 版本漂移：宿主图 rev 与 chamber 复合 bundle 的合并是 union 语义，不要求
  两图同 rev（chamber 复合由 chamber 构建管，宿主图由实例插件集管）。壳版本
  落后/超前于后端时，多出的核心行以"特性缺席"运行（§3.5 apply 降级），绝不使
  实例 boot 失败。
- **壳与后端必须同代（当前基线）**：受管 vendor 源以 `harness.commit` 的 pin 为
  单一事实来源——当前 pin = dsh `0.1.5-rc.1`（`packages/desktop/vendor/dsh/
  pnpm-lock.yaml` 的 `@deepseek-ai/dsh` specifier 同值），三个 fork 副本与
  `release-preflight.mjs` 的 `FORK_VERSION` 同步；vendor 树是仓库内 git submodule
  （gitlink = pin，升级走 `scripts/dev/update-vendor.mjs <tag>`）。宿主 wire 只增
  不改——`commands.execute` 新增必填 `images` 参数即一例：旧形状客户端（旧壳）向
  新宿主发命令会被网关严格参数核对拒绝或宿主崩溃，经 `session.command` 的斜杠命令
  （Access 权限芯片 `/permission` 等）静默失效。因此壳种子词表、boot 模块系统、
  复合覆盖集与 fork 副本都按该基线对齐：平台词（永不成为图行的包，如
  `dsh-client-ui-attachment` 这类由种子词表提供的包）不进 boot 图；app-shell
  renderer 安装容错（后端 `ui-renderer` 行先装则采纳，其 client half 由 boot 内核
  收编、挂载经 `ctx.uiRenderer`）；复合延迟族覆盖 ui-attachment /
  ui-brand-official / ui-reference；boot 模块系统走基线 bootstrap API
  （`AppWebEntry` + `__ModuleLoader__` queue-mode facade + 无框架加载页 +
  `assertEntriesActive` 的 chamber 容错版）；web-react / schema-form 深导入已删除/
  迁移（渲染装配移入 ui-renderer 行；settings 系包迁
  `dsh-client-ui-renderer/src/client/bind` 与 `SettingsSchemaService`）。跨代宿主
  （如无 `images` 参数的旧宿主）在新壳下会被拒绝多余字段——与 §3.5 的"特性缺席"
  语义一致，不支持跨代混跑。

## 5. 风险与开放问题

- **插件生态成熟度**：当前 dsh 生态的第三方 `dsh.client` 包尚少，本方案是
  "机制先备"。
- **远程实例部署说明（开放项）**：远端 seed 的机械编排已接线（§3.5），
  把该部署单元说明并入 design 02 §3.9 的远端部署说明仍待做。
- **vendor 侧根治（开放项，登记不修）**：上游 `dsh-client-modules` 的
  `allocateInitialRevision` 改用内容哈希即可让 bundle rev 跨实例重启稳定、整类
  陈旧 rev 404 消失（§3.5）；vendor 只读，chamber 侧只能保留一轮有界恢复。
- **Windows**：支持推进见 design 23（首版发布未出；插件运行时 win32 验证随
  design 23 §7 矩阵的实机门禁，见 STATUS）。

## 6. 相关文档

- `docs/design/01-overview.md` §3 文档地图（本文条目）
- `docs/design/05-connection-manager.md` §2/§6（前端复合 bundle、启动图清单、N-ctx
  seam、host 包与 seed）：`__DSH_BOOT__` 表述为「单 entry + 每实例宿主图额外 entry」，
  05 §6 构建链补充 host 包与 seed 说明
- `docs/design/04-control-plane-api-data.md` §5（`__DSH_BOOT__` 单条目表述同批修订）
- `docs/design/08-git-worktree-plugin.md`（构建期打包的客户端行 + 实例内 host 包，与本方案互补）
- `docs/progress/STATUS.md`（唯一进度记录；本方案未闭环的实机与开放项）
