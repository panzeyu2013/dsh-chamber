# 09 · dsh 客户端插件运行时加载（todo：设计定稿，实现未排期）

> **状态：todo**——设计草案定稿（2026-08），实现未排期。本文记录「chamber 前端
> **运行时加载 dsh 客户端插件**（`dsh.client` 行）」的设计：官方客户端插件机制在
> chamber 底下的**断点定位**、**每实例合并宿主 boot 图**的方案、信任边界与分期。
> 与 todo 08（git worktree 插件，**构建期强制打包**的 chamber 客户端插件）互补：
> 08 走编译期打包，本文走**运行期加载**（第三方/自研 `dsh.client` 包，装进
> profile 后前端按实例加载，不重新构建 chamber 前端）。

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
产物），注入的是**构建期写死的单 entry 清单**（`scripts/gen-boot-manifest.mjs` 写
`dist/manifest.json`，只有 `@dsh-chamber/app` 一个复合 entry，05 §2/§4）；前端
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
- 宿主侧插件安装流程改造（装法维持，见 todo 09 范围外）；
- 跨来源插件数据融合（插件仍是每实例一个 ctx 的普通 cordis 插件）；
- 运行时热装（改 `cordis.patch.yml` 后仍按官方节奏：重启生效；config-only HMR
  已有，不扩展）。

## 3. 设计：每实例合并宿主 boot 图

### 3.1 图来源（二选一）

- **方案 A（推荐）：chamber 自有 host 行暴露图**。新增 chamber 自有小 host 包
  （`@dsh-chamber/*`，宿主侧，非 vendor），注册一个 Remote 暴露
  `clientModules.graph()`（宿主 ctx 上 `clientModules` 服务现成）。控制面在
  本地 profile 的 `cordis.patch.yml` seed 该行（先例：`seedDshHomeDefaults`
  已 seed `settings.yaml`；远程实例由部署侧同样 seed）。**包分发开放点**：host
  行要求包可从 profile 解析——候选：seed 时控制面写入小型 chamber host 包到
  `profiles/web/node_modules/@dsh-chamber/…`（免 pnpm 的裸包拷贝，行内注释
  记录），或随部署安装。
- **方案 B（零宿主改动，备选）：前端提取宿主注入的图**。`GET /api/i/<id>/` 反代
  到宿主根路径，宿主返回官方 web-app index.html（`modules` 行 tap 注入
  `window.__DSH_BOOT__`），前端正则提取。零 host/部署改动、远程天然可用；代价是
  HTML 解析脆弱（依赖官方 index 结构），作为 v1 兜底而非主路径。
- **变体（不推荐首期）**：控制面在宿主 ready 时拉图并经管理 API 中继给前端。
  缺点：图随 `cordis.patch.yml` HMR 变化，中继需要刷新协议，比前端直取复杂。

### 3.2 合并与加载

- 合并语义：**union + 按 entry id 去重**。chamber 复合 bundle 已含全部官方
  `ui-*` 包（`chamber-entry.ts` 静态注册），宿主图里这些 id **跳过**，只加载
  chamber 复合未覆盖的新 entry（用户新装包）。
- 加载：`ClientModuleSystem.load('/api/i/<id>/plugins/<pkg>/client.js')` —— browser
  half 本就支持任意 entry 的加载/物化/缓存/依赖边；bundle 自注册进共享模块表
  （N-ctx seam 已存在），与官方 shell 加载方式一致。`?rev=` 沿用宿主图（缓存锚），
  `immediately`/`inject` 边在激活时尊重（官方 system.ts 逻辑复用，不重写）。
- 生效节奏：与官方一致，插件集变化在实例重启后生效（图来自宿主现成组合）。

### 3.3 N-ctx 与去重

- 额外 entry **按实例**加载：本地与远程宿主插件集不同，各自 ctx 只激活自己的
  子集；共享模块表可容纳并集（表已共享，05 §4）。
- 去重规则在合并层做死：entry id ∈ chamber 复合注册集 → 跳过；重复注册会
  cordis 冲突（复合 bundle 已挂载同名包），显式跳过而非靠加载失败兜底。

### 3.4 改动面（全部在可改范围内，vendor 零改动）

| 面 | 改动 |
|---|---|
| `packages/renderer` | boot 流程：每实例 boot 时取宿主图 → 去重 → 加载额外 entry（现状：只消费控制面注入的单 entry 清单） |
| `packages/dsh-client-web`（拷贝包） | `boot.tsx` N-ctx 模块表共享 seam 扩展：额外 entry 的注册/激活/清理（seam 已存在，见 05 §6） |
| 方案 A 附加 | 新 `@dsh-chamber/*` host 包（Remote 暴露图）+ 控制面 seed 本地 profile 行（`packages/control-plane`） |
| 官方/宿主/vendor | 零改动 |

## 4. 信任模型与边界（写进设计即写进契约）

- **远程实例的 client bundle 会运行在本地 renderer 里**——与官方模型一致（官方
  web profile 同样加载宿主下发的一切：宿主是权威、loopback-only、v1 无认证面）。
  但这是安全相关事实，必须在设计文档/代码注释中显式声明，不得静默。
- 插件作者须提供**构建好的 `./client` bundle**（官方工具链产物；缺 bundle 时
  宿主 `ClientModuleRegistry` 激活即 fail-loud，chamber 侧同样报错不静默）。
- entry id 冲突 → 显式去重（§3.3）；`inject` 边缺失 → 官方机制已有的 loud 失败，
  不降级。
- 版本漂移：宿主图 rev 与 chamber 复合 bundle 的合并是 union 语义，不要求
  两图同 rev（chamber 复合由 chamber 构建管，宿主图由实例插件集管）。

## 5. 实施分期

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M1 | 图通道：方案 A host 包 + Remote（或方案 B 提取器）+ 每实例取图 | host 包单测、`GET /api/i/<id>/plugins/<id>/client.js` 透传实测 |
| M2 | 合并加载：boot 流程去重 + 加载额外 entry + `inject`/`immediately` 尊重 | 本地 profile 装一个带 `dsh.client` 的测试包 → 界面出现；build:renderer |
| M3 | N-ctx 与远程：远程实例宿主图加载、各自 ctx 子集、断开清理 | 手测 remote + 双实例共存 |
| M4 | 收尾：信任声明入代码注释、STATUS/文档同步、失败路径（缺 bundle/坏图） | verify:i18n、手测失败路径 |

## 6. 风险与开放问题

- **图通道方案取舍**：A（干净、需 seed/分发机制）vs B（零改动、脆）——首期若
  只想解锁本地，B 更轻；要长期契约建议 A。开放问题：A 的包分发（seed 裸包 vs
  部署安装）需在 M1 定。
- **插件生态成熟度**：当前 dsh 生态的第三方 `dsh.client` 包尚少，本方案是
  "机制先备"——不排期的原因之一。
- **与 05 契约的关系**：05 是 v1 表面契约（前端 = chamber 复合 bundle）；本文
  若落地需修订 05 §2/§6 与 `__DSH_BOOT__` 单 entry 表述（04 §5），届时设计定稿
  移入 `docs/design/`。
- **与 STATUS 预留通道的关系**：STATUS 提到 settings 页 `ns.inject('settings.section')`
  通道可用于后续插件化——本方案是通用客户端插件运行时加载，settings 区只是
  一种座位，两者不冲突（本方案落地后该通道仍可用）。

## 7. 相关文档

- `docs/design/01-overview.md` §3 文档地图（本文条目）
- `docs/design/05-connection-manager.md` §2/§6（前端复合 bundle、N-ctx seam；落地时修订）
- `docs/design/04-control-plane-api-data.md` §5（`__DSH_BOOT__` 单 entry 表述；落地时修订）
- `docs/todo/08-todo-git-worktree-plugin.md`（构建期打包形态，与本方案互补）
- `docs/progress/STATUS.md`（唯一进度记录；本文实现未排期）
