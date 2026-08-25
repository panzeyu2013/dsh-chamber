# 09 · dsh 客户端插件运行时加载（已实现：方案 A）

> **状态：已实现（2026-08，方案 A）**——设计定稿自 `docs/todo/` 移入本文
> （原 设计 09）。本文记录「chamber 前端**运行时加载 dsh 客户端插件**
> （`dsh.client` 行）」的设计与最终实现形态：官方客户端插件机制在 chamber
> 底下的**断点定位**、**每实例合并宿主 boot 图**的方案对比（A/B）、信任边界、
> 分期与落地记录。与设计 08（git worktree 插件，**构建期强制打包**的 chamber
> 客户端插件）互补：08 走编译期打包，本文走**运行期加载**（第三方/自研
> `dsh.client` 包，装进 profile 后前端按实例加载，不重新构建 chamber 前端）。
> 落地记录与剩余偏差以 `docs/progress/STATUS.md` 为准（唯一进度记录）。

## 1. 背景：官方机制完整，chamber 前端断链

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

**chamber 的断点只在第 3 步**：控制面服务的是自建 dist（`packages/renderer` vite
产物），注入的是**构建期写死的单 entry 清单**（`packages/renderer/scripts/gen-boot-manifest.mjs` 写
`dist/manifest.json`，只有 `@dsh-chamber/app` 一个复合 entry，05 §6）；前端
**从不向宿主取图**。而第 1、2 步在 chamber 托管的本地实例上照常运行（本地 host 跑
官方 web profile，`dsh-web-app` 的 `cordis.patch.yml` 挂载 `modules` 行），
`/api/i/<id>/plugins/<id>/client.js` 也已被通用反代全量透传（03 §3，无方法白名单）。
链路是通的，只是没人消费。

推论（2026-08 核实，与用户问答结论一致）：

- **宿主侧插件**（服务/工具/API 行）→ 已可装：profile 装包 + `cordis.patch.yml`
  insert（机制即 `dsh plugin --profile <name> add <pkg>` 的 pnpm 转发 + 对账；
  本地实例 `$DSH_HOME = <userData>/state/dsh-home`，profile = `$DSH_HOME/profiles/web`）。
- **客户端插件**（`dsh.client` 行，带前端 UI 半身）→ 运行时装不了：界面部分不会
  出现；设置页 Plugins 卡只配置内置行、plugin inventory 只读（`dsh-host-plugin-inventory`
  仅 `list()`），都不是安装入口。

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

### 3.1 图来源（方案对比；A 已落地）

- **方案 A（已落地，2026-08）：chamber 自有 host 行暴露图**。chamber 自有小 host
  包 `@dsh-chamber/dsh-host-client-graph`（`packages/dsh-host-client-graph`，宿主
  侧，非 vendor），注册一个 Remote 暴露 `clientModules.graph()`（宿主 ctx 上
  `clientModules` 服务现成）。控制面在本地 profile seed 该行（`--patch` overlay，
  模块 B）——先例：`seedDshHomeDefaults` 已 seed `settings.yaml`；远程实例由部署侧
  同样 seed（**遗留**：部署说明未写，见 §6）。**包分发开放点（已定）**：seed 时
  控制面把模块 A 包（package.json + dist/index.js）裸包拷贝进
  `profiles/web/node_modules/@dsh-chamber/dsh-host-client-graph/`（免 pnpm 的裸包
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
- **覆盖集也是模块表的 factory 提供方（2026-08 修复）**：被跳过的覆盖行不是
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
  合法 require 目标。维护纪律（2026-08 加固）：首屏工厂 id 以
  `CHAMBER_COVERED_FACTORY_IDS`（chamber-covered.ts 的 leaf 契约）为可测试
  面——CI 单测断言每个 id ∈ `CHAMBER_COVERED_IDS`（host-graph.test.ts），
  chamber-entry 执行期断言 `COVERED_FACTORIES` 与该列表**精确一致**且每个
  id 均被覆盖（漏加即 fail-loud——漏加的 id 会以额外行执行官方 bundle，与
  复合 factory 重复注册；map 与列表漂移同理）。
- **首启竞态修复（2026-08，05 §4）**：额外 bundle 的脚本在**加载时即执行**
  并自注册 factory（script load 事件在求值后触发），注册 sink
  （`window.__ModuleLoader__`）必须先于任何 bundle 脚本存在。旧顺序（预加载
  → `AppWebEntry.run()` 才装表）下，页面**首个**带额外行的 boot 会让脚本在
  sink 安装前求值——官方 bundle 的无守卫顶层交接抛错、factory 永未注册、
  boot 以难懂的 "cannot resolve" 失败（实践中被宿主就绪时序掩盖：首 boot
  通常 503 降级装表，之后的 boot 才带额外行）。修复：boot.ts 导出幂等的
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
- 去重规则在合并层做死：entry id ∈ chamber 复合注册集（chamber-entry.ts import
  清单）或页面自有 id（被 chamber 替换的官方 ui-sidebar 注册、被 shell 内核收编
  的 `@deepseek-ai/dsh-client-modules`）→ 跳过；重复注册会 cordis 冲突（复合
  bundle 已挂载同名包 / 同名 provide），显式跳过而非靠加载失败兜底。遗漏的去重
  id 在 boot 时**响亮失败**（duplicate registration，共享模块表拒绝重复 factory）；
  多出的 id 无害（宿主图没有该 id 时不会被过滤）。

### 3.4 改动面（全部在可改范围内，vendor 零改动）

| 面 | 改动（已落地） |
|---|---|
| `packages/renderer` | `host-graph.ts`（`fetchHostGraph` wire 调用 + `dedupeHostEntries` 去重 + `toExtraRows` 注入反代前缀 + `collectExtraRows`/`preloadedExtraBundles`，AppWebEntry 构造前预加载额外 bundle，loadModuleBundle 依赖注入可测）+ `chamber-covered.ts`（去重集） |
| `packages/dsh-client-web`（拷贝包） | `boot.ts` `AppWebEntryOptions.extraRows` seam：额外 entry id 合并进 boot rows（N-ctx 模块表共享 seam 的扩展，见 05 §6） |
| 方案 A 附加 | 新 host 包 `packages/dsh-host-client-graph`（Remote `clientGraph/graph` 暴露图）+ 控制面 `host-graph-seed.ts`（seed 模块 A 包进 profile + 物化 `--patch` overlay，`packages/control-plane`） |
| 官方/宿主/vendor | 零改动 |

### 3.5 最终实现形态（落地契约）

- **端点契约（全局固定，其他 chamber 模块依赖）**：namespace `clientGraph`、
  method `graph` → wire 端点 `clientGraph/graph`。调用形状与既有 bridge-api 同款：
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
- **--patch seed（模块 B）**：`ensureHostGraphPackage(dshHome, sourceDir)` 把模块 A
  包（package.json + dist/index.js）幂等分发进
  `$DSH_HOME/profiles/web/node_modules/@dsh-chamber/dsh-host-client-graph/`（内容
  hash 一致跳过、漂移覆盖、0600 原子写；源目录缺失 = 优雅跳过，不报错）；
  `buildPatchOverlay(stateDir)` 物化 `<stateDir>/dsh-chamber-graph.patch.yml`——
  loader patch 列表格式（`[{insert:[{id:'client-graph',
  name:'@dsh-chamber/dsh-host-client-graph'}]}]`，与 bundle 的 cordis.patch.yml /
  dsh CLI `--patch <path>` overlay 同格式，`@deepseek-ai/dsh-app-boot`
  loadOverlayPatches 为权威），幂等自愈（内容一致不动、漂移重写）。spawn 每次
  注入 `--patch`：`webProfileArgs(port, patchPath?)`（须在 `--profile web` 之后、
  web-app 自有 flags 之前），经 local-connection 对每次 spawn/重启透传；模块 A
  产物（dist/index.js）缺失时不注 overlay——命令行保持 v4 基础（一个插了行却
  解析不到的 overlay 会让宿主 boot 响亮失败，缺失模块 A 必须等价于"未发货"）。
  已运行的本地实例在下一次重启按官方插件集变更节奏生效。
- **CHAMBER_COVERED_IDS（模块 C 去重集）**：`packages/renderer/src/chamber-covered.ts`
  维护两个家族——① chamber 复合 bundle 静态注册的全部客户端插件包名
  （chamber-entry.ts import 清单：connection/typert/gateway/remotes/runtime/locale/
  theme/layout/settings 族/conversation/ui-* 全量/自研 chamber 插件等；向
  chamber-entry.ts 加插件时**同批**追加）；② 页面自有 id：`@deepseek-ai/
  dsh-client-ui-sidebar`（官方注册被 chamber 侧边栏替换，加载会撞 sidebar 槽）
  与 `@deepseek-ai/dsh-client-modules`（shell 内核自行收编该 entry，二次 provide
  `modules` 冲突）。独立成模块（chamber-entry.ts 仅 re-export）是为避免 shell.ts
  把 chamber-entry 的模块表交接拉进主 chunk（同 chamber-knob.ts 模式）。
  与 §3.2 的 union-table 修复锁步：chamber-entry.ts 的 `COVERED_FACTORIES`
  （首屏静态导入族的模块表 factory 注册）中每个 id 必须在覆盖集内（执行期断言）。
- **extraRows seam（模块 D）**：`AppWebEntryOptions.extraRows`（`boot.ts`，可选、
  向后兼容）——chamber 侧已把额外 bundle 预加载完毕（bundle 执行时经
  `window.__ModuleLoader__.load({id, factory})` 自注册进共享模块表），seam 只把其
  id 合并进 boot rows（`loader.create` 经 `ClientModuleSystem.import()` 的 factories
  分支命中，无需 graph row），不 prefetch/不 fetch（chamber 侧统一预加载整个额外
  集合）。共享模块表拒绝重复 factory（system.ts 的 `__ModuleLoader__.load` sink），
  页面级一次加载保证由 host-graph.ts 的 `preloadedExtraBundles` Map 显式维护
  （成功后才标记：失败不标记 → 重试可重新预加载；同 id 异 rev 先到先得并
  上报 `restart-required`，用户不再面对静默版本复用）。
- **构建期 generated Remote seam（renderer glue）**：复合壳源码复用官方
  `dsh-api-remotes/client`，但受管 vendor 只有源码、没有上游 tsdown 生成的
  `lib/typert.remote-client.js`。`gen-typert-remotes.mjs` 因而以该官方 client
  汇编的 **value import 集合为唯一选择源**，逐包校验上游标准 `./remote`
  exports/files 契约，再把 Host face 产物写入 chamber-owned
  `renderer/src/generated/typert/`；Vite 的通用 `/remote` resolver 只消费这些产物。
  rc.2 当前 7 个 contribution（含 file/session reference）由独立锁步测试固定，
  避免手抄包表滞后后到 Rollup 阶段才报缺模块；vendor 始终只读。
- **失败降级与诊断语义（模块 C）**：图**通道**失败（fetch 网络错 / 非 2xx / 图畸形 /
  行缺 id/url/rev）→ 降级为无额外插件继续 boot + console.error，同时经 renderer-local
  chamberBridge 上报用户可见诊断（404/方法缺失 = `not-injected`，其余 =
  `graph-unreachable`；复合 bundle 仍
  提供完整官方壳，仅丢失 profile 新装的插件；畸形图响亮报错——错图是 boot 危害，
  不做猜测式合并）；503 `instance_unavailable` 是未就绪预期态，静默（图通道不可达
  时不会伪装成“本实例无额外插件”）。额外 **bundle 加载**失败**不降级**——响亮失败、
  该实例 boot 报错呈现（坏插件绝不静默消失，§4 fail-loud）。**分层表述（2026-08
  精度修订）**："加载"由 chamber 预加载层负责（host-graph.ts `collectExtraRows`
  的 `loadModuleBundle` 失败即 throw → 该实例 boot 响亮失败）；预加载成功后内核
  不再为额外行发起新加载（factory 已注册进共享模块表），故 boot 内核层见到的额外
  行失败只剩 materialize/apply 一类，按下一条降级——"加载失败响亮"与"apply 失败
  降级"各归各层，不重叠也不遗漏。
- **额外行 apply 失败降级（2026-08，版本容忍修订，模块 D）**：额外行**加载
  成功但 entry 未能 apply**（materialize 出非插件对象——如壳种子词表把
  `dsh-client-ui-attachment` 静态注册、rc.8 后端新增其 client half 后 seed 遮蔽
  factory 导致的 "invalid plugin"；注册进本壳未声明的槽；重复安装壳已提供的服务——
  rc.8 把 slot-renderer 安装移出壳进了 `ui-renderer` 行）→ **降级不致命**：
  console.error + status 'failed'，shell 照常 boot（boot.ts 对 extraRows 逐行
  容错 + sweep 排除）。理由：复合 bundle 固定一个 dsh client 版本，"后端 dsh 版本
  ≠ 壳版本"时新/旧核心行与壳不兼容是**正常条件**（特性缺席），不是损坏（§4
  fail-loud 保留给 manifest 行/app-shell 装配的损坏，以及额外 bundle 的加载失败——
  预加载层，传输/缺失才是损坏信号；boot 内核层对额外行只区分 materialize/apply）。
  诊断状态统一为：成功 `ok`，host gateway 未注入 `not-injected`，图通道失败
  `graph-unreachable`，额外 bundle 加载失败 `bundle-load-failed`，同 id 异 rev
  `restart-required`。来源标题只显示异常标记，设置的 Plugins 页显示状态、插件 id
  与原因。

## 4. 信任模型与边界（写进设计即写进契约；已同步进代码注释）

- **远程实例的 client bundle 会运行在本地 renderer 里**——与官方模型一致（官方
  web profile 同样加载宿主下发的一切：宿主是权威、loopback-only、v1 无认证面）。
  但这是安全相关事实，已在 `host-graph.ts` 与模块 A `src/index.ts` 的模块头注释中
  显式声明，不静默。
- 插件作者须提供**构建好的 `./client` bundle**（官方工具链产物；缺 bundle 时
  宿主 `ClientModuleRegistry` 激活即 fail-loud，chamber 侧同样报错不静默）。
- entry id 冲突 → 显式去重（§3.3）；`inject` 边缺失 → 官方机制已有的 loud 失败，
  不降级。
- 版本漂移：宿主图 rev 与 chamber 复合 bundle 的合并是 union 语义，不要求
  两图同 rev（chamber 复合由 chamber 构建管，宿主图由实例插件集管）。壳版本
  落后/超前于后端时，多出的核心行以"特性缺席"运行（§3.5 apply 降级），绝不使
  实例 boot 失败。**rc.2 后端适配（2026-08）**：壳种子词表与 rc.2 官方一致
  （平台词 = 永不成为图行的包，`dsh-client-ui-attachment` 等出种子词表），
  app-shell renderer 安装容错（后端 `ui-renderer` 行先装则采纳）。
  **rc.8 commands wire 兼容桥（已随 rc.8 baseline 对齐移除，2026-08）**：除
  boot/渲染外，rc.8 还改了宿主 `commands.execute` Typert Remote 签名（新增必填
  `images` 参数，上游 8d9fee19f9）——rc.7 形状客户端（旧壳）向 rc.8+ 宿主发命令
  会被网关严格参数核对拒绝或宿主崩溃，Access 权限芯片 `/permission` 切换等一切
  经 `session.command` 的斜杠命令静默失效。临时桥曾在 `dsh-client-connection`
  （rc8-commands-compat.ts + rpc.ts）按 `host.describe` 权威版本为 rc.8+ 宿主
  注入 `images: []`，rc.7 宿主不受影响；**rc.8 baseline 对齐后已整体移除**——
  dsh-client-connection 拷贝随 rc.8 的 fixture/index/依赖面 re-sync，rc.8
  客户端自带 `images` 参数，`commands.execute` 不再有版本判定注入。
  **rc.8 baseline 完整对齐（2026-08，已落地）**：harness.commit →
  141eb6fef8（dsh 0.1.0-rc.8），vendor 源物化为仓库内真实目录
  `vendor/harness-checkout`（pnpm 11 剪枝规避：符号链接指向仓库外源时重写锁文件
  会剪除 vendor importer 记录，仓库内真实目录则保留；`pnpm install
  --frozen-lockfile` 已验证）。对齐内容：复合延迟族 +3 覆盖（ui-attachment /
  ui-brand-official / ui-reference，chamber-entry.ts registerDeferred +
  chamber-covered.ts）；**ui-renderer 归 page-own**（renderer 移入
  dsh-client-ui-renderer 源，boot.ts 内核收编其 client half——与 modules 同款
  bootstrap 注册 + 内核 loader 行，挂载经 `ctx.uiRenderer`）；**boot.tsx 迁
  rc.8 模块系统 bootstrap API**（boot.ts 类结构 AppWebEntry + `__ModuleLoader__`
  queue-mode facade 自装 + BootPage 无框架加载页 + assertEntriesActive chamber
  容错版）；web-react / schema-form 深导入随删/迁移（渲染装配移入 ui-renderer
  行；settings 系包迁 `dsh-client-ui-renderer/src/client/bind` 与
  `SettingsSchemaService`）。rc.7 宿主（无 `images` 参数）随对齐移出支持面
  （rc.8 客户端自带 `images` 参数，rc.7 宿主会拒绝多余字段）——与版本容忍
  §3.3 的"特性缺席"语义一致：壳与后端版本必须同代。

## 5. 实施分期（M1–M4 均已落地；验证记录见 git 历史与 CHANGELOG，STATUS 只记录剩余项）

| 里程碑 | 内容 | 落地与验证 |
|---|---|---|
| M1 | 图通道：方案 A host 包 + Remote + 每实例取图 | ✅ 模块 A+B：host-graph-seed 单测 8 项（overlay 幂等/0600/自愈、seed 首拷/跳过/漂移覆盖/缺源跳过、`--patch` 注入位置、patchPath 到 spawn 的接线）；实机 E2E：seed → `--patch` spawn → 宿主内插件装载 → 反代 wire 调用 `clientGraph/graph` 返回 38 条真实 boot graph 行，宿主日志无 client-graph 错误 |
| M2 | 合并加载：boot 流程去重 + 加载额外 entry + `inject`/`immediately` 尊重 | ✅ 模块 C+D：renderer host-graph 单测 12 项（wire 调用形状/503 静默/畸形图响亮/去重/toExtraRows 前缀）、`build:renderer` 通过 |
| M3 | N-ctx 与远程：远程实例宿主图加载、各自 ctx 子集、断开清理 | ◐ 链路同构（远程反代同一条 `/api/i/<id>/*` 透传，前端无本地/远程分支）；**远程 seed 编排已落地**（设计 13 M2：`seedRemoteHostGraph` 经 exec write-file 原语把模块 A 包落到远端平铺 fallback `profiles/node_modules` + `cordis.patch.yml` 列表 insert + restart，见 §6 遗留 1 更新）；远程实例图通道不可达时按降级语义运行（无额外插件，不报错） |
| M4 | 收尾：信任声明入代码注释、STATUS/文档同步、失败路径（缺 bundle/坏图） | ✅ 信任声明已入 `host-graph.ts` / 模块 A `index.ts` 注释；失败路径实现 + 单测覆盖（图通道降级、畸形图/坏 bundle 响亮、503 静默）；本文定稿与 STATUS 同步完成（验证记录见 git 历史） |

## 6. 风险与开放问题（按落地后更新）

- **图通道方案取舍：已定（方案 A）**。A 的包分发经「seed 裸包拷贝进 profile
  node_modules」落地（免 pnpm，模块 B 行内注释记录）；B 保留为兜底思路（A 为
  长期契约）。
- **遗留 1：远程实例 seed——编排已落地（2026-08，设计 13 M2），已接线并可见化**：
  远端 `$DSH_HOME` 经 `seedRemoteHostGraph`（exec write-file 原语）落地模块 A 包到
  平铺 fallback `profiles/node_modules`（跨 `dsh plugin` pnpm 操作持久）+
  `cordis.patch.yml` 列表 insert（生效节奏 = 官方插件集变更：重启后生效，seed 本身
  不重启远端）。接线（2026-08）：desktop main 在 SSH 实例转 ready 时自动 seed
  （幂等 hash-skip，单飞守卫），插件管理 UI（远端同步视图）实时探测并展示注入状态
  （installed/patched），未注入时提供「注入」按钮（`desktop_ssh_seed_host_graph`
  IPC 的显式调用路径）——注入不再是静默修改；本地列表视图同样展示本地注入状态。
  注入结果（成功 wrote/patched 或失败原因）写入实例环形缓冲日志
  （transport-manager 公开 `appendLog`），连接设置页的远端日志面板可见。
  部署说明并入 02 §3.9 的远端部署单元说明仍待做（开放项：02 §2.6 已覆盖
  本地 seed 接线，远端 systemd 单元的 chamber 双包部署说明尚未补入 02 §3.9）。
- **遗留 2：打包态分发——已接线（2026-08）**：desktop main 打包态传
  `hostGraphPackageSourceDir = pkgDir/dist/host-graph-package`（asar 内），
  `build-host-graph-package.mjs` 产出、electron-builder `files` 含 `dist/**/*`，
  开发态走 repo 源码树。
- **遗留 3（已完成，2026-08）**：图通道失败、bundle 失败与版本冲突均有 UI 诊断；
  来源标题显示异常标记，Plugins 设置页显示五态与详细原因。
- **插件生态成熟度**：当前 dsh 生态的第三方 `dsh.client` 包尚少，本方案是
  "机制先备"。
- **与 05 契约的关系：已修订（2026-08，本文定稿同批）**——05 §2/§6 与 04 §5 的
  `__DSH_BOOT__` 单 entry 表述已改为「单 entry + 每实例宿主图额外 entry」，05 §6
  构建链补充 host 包与 seed 说明。
- **与 STATUS 预留通道的关系**：settings 页 `ns.inject('settings.section')` 通道
  仍可用于后续插件化——本方案是通用客户端插件运行时加载，settings 区只是
  一种座位，两者不冲突（本方案落地后该通道仍可用）。
- **Windows**：首版暂缓（与「Windows 首版支持暂缓」全局状态一致）。

## 7. 相关文档

- `docs/design/01-overview.md` §3 文档地图（本文条目，状态已更新）
- `docs/design/05-connection-manager.md` §6（前端复合 bundle、启动图清单、N-ctx
  seam、host 包与 seed；单 entry 表述已修订）
- `docs/design/04-control-plane-api-data.md` §5（`__DSH_BOOT__` 单条目表述已修订）
- `docs/design/08-git-worktree-plugin.md`（构建期打包的客户端行 + 实例内 host 包，与本方案互补）
- `docs/progress/STATUS.md`（唯一进度记录；本方案落地记录与遗留）
