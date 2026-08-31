# 18 · dsh 运行时版本管理（npm 拉取安装，2026-08 现行）

> **状态：现行实现；M0/M2/M4 done，M1/M3 partial。** M1 的开发树安装
> 与 hermetic fake-registry 验收已完成，macOS 打包态执行夹具已就绪，但本轮按
> 用户要求未生成或检查真实 `.app`；Windows 管理面保持只读。唯一权威的当前进度、
> 已执行验证与验收边界见 `docs/progress/STATUS.md`（design 18 条目）；本文只保留
> 架构与行为契约，不以历史验证记录冒充当前结果。
>
> 决策记录（2026-08 多轮讨论，用户拍板）：
> 1. **通道保留**；**获取方式 = 运行期从 npm 拉取 `@deepseek-ai/dsh` 安装进壳**
>    ——「dsh 可以使用 npm 等方式拉取最新的包，然后装到 chamber 的壳里」，
>    **不是** chamber 每次发版捆绑对应的 dsh 版本；
> 2. **无验证区分**：高速开发期不做「已验证/未验证」徽标，不区别对待版本；
> 3. **默认推荐最新版**，用户可自由选择/回滚任一版本；
> 4. **三版本缓存**：可正常运行版本 / 失败版本（保留现场）/ 尝试中的版本；
> 5. 应用时机 = **下次启动**（不动退出路径）；探针门控激活 + 自动回退；
> 6. **显示本地 dsh 版本号**（补上零消费的 `dshVersion` 投影）。
> 7. **完全移除 Provider B**（2026-08 用户拍板）：运行期 npm 安装为唯一获取方式，
>    不再有发布侧自动预打包的降级 provider。
> 8. **registry 源用户自设**（2026-08 用户拍板）：软件内 settings 显式设置（默认
>    npmjs，白名单镜像可选，自定义走 URL 白名单校验），**不做按 locale 的静默默认
>    切换**——语言≠地理位置，静默换 registry 等于静默换信任锚。
> 9. **宿主范围扩展（§9 已实现）**：运行时管理核心抽取为共享包
>    `@dsh-chamber/dsh-runtime`（无 Electron/IPC 依赖），desktop 主进程与
>    gateway 服务进程为两个宿主，经真实 DI seam（`StartupDeps`/`ApplyDeps`/
>    `InstallerDeps`；`ControllerDeps` 为 desktop 侧绑定层）注入状态根、内建锚、
>    Node/pnpm 执行器、spawn/probe 与子进程回收（`RuntimeHostAdapter` 为 §9.1
>    文档草图，非宿主实际 seam）；核心裁决逻辑零分叉。gateway
>    侧存储根 `<stateDir>/dsh-runtime`、解析链 `DSH_GATEWAY_DSH_PATH` → override
>    → `--dsh-path` 内建锚、`/chamber/runtime` 管理面——细节见 §9。
> 10. **设置落点 per-server 化（§3.6，2026-09 用户拍板，已实现）**：dsh 运行时设置
>     从「通用」视图迁出，成为每个服务器自己的设置段（agent 预设之后，
>     `settings.section` id `dsh-runtime`）；local/gateway/ssh 三种来源行为
>     按 §3.6 分支。
>
> 平台范围（2026-08 审查明确）：**macOS/Linux 是运行时安装、切换与数据恢复的
> 管理契约目标**；Windows 会投影版本与状态，但安装、选择、切换、清理等 mutation
> 在 controller/main/UI 三层均门控为**只读**，不把未经 Windows 实机验证的恢复与
> 进程组语义声明为可用。
>
> 审查记录（2026-08，三轮共 4 次独立审查）：
> - 自审 17 项（P0×4/P1×6/P2×7）→ 已吸收；
> - 独立边界审查 17 项（P0×2/P1×10/P2×5）→ 已吸收（修订标注 F1–F17）；
> - 独立代码事实核对（10 清单全对码，无 WRONG；P2×7/P3×1）→ 已吸收；
> - 第三轮 5 视角并行审查（修订后一致性 P1×3/P2×11；Provider A 安装深度 P0×0/
>   P1×4/P2×多；UX 与状态机 P1×4/P2×11/P3×4；测试计划 P1×3/P2×9；发布/版本纪律
>   P1×2/P2×6/P3×3）→ 本节已吸收全部 P1 与主要 P2，修订标注 R3-*。

## 1. 需求与动机

- 现状：dsh 运行时随 chamber 捆绑（`vendor/dsh` → extraResources →
  `resourcesPath/vendor/dsh`），dsh 更新只能随 chamber 整包更新（设计 11），
  每次全量下载 100–140MB（win exe ~97.5MB / mac zip ~139.7MB，**外部实测**
  v0.1.3，M1 回填实测值）；设计前本地 dsh 版本号已投影
  （`dsh-chamber:info.dshVersion`）但全仓库零 UI 消费——M0 起该投影接入
  settings「dsh 运行时」块与 connections 本地卡片。
- 目标（用户拍板）：
  1. **dsh 版本更新不等 chamber 发版**——运行期从 npm 拉取最新包安装进壳；
  2. **版本选择/回滚**：settings 里用户自由选版本（默认推荐最新），坏了可回滚，
     或升级应用本体求兼容；
  3. **显示本地 dsh 版本号**。

## 2. 关键技术事实（设计前提）

- npm 上的 `@deepseek-ai/dsh` 是**包**（含依赖声明与构建好的 lib 产物），**不是**
  chamber 运行需要的「裁剪后完整运行时树」（hoisted `node_modules` + 平台原生
  二进制 + prune）。`bundle-dsh.mjs` 干的活（精确版本 → pnpm install hoisted →
  allowBuilds 白名单 → prune → 冒烟 → 原子发布）在运行期必须重演。
- 因此「从 npm 拉最新装进壳」= **运行期安装**：下载 tarball → 校验 integrity →
  pnpm install（hoisted + allowBuilds）→ prune → `bin.js --version` 冒烟 → 发布为
  版本树。即 **bundle-dsh 语义从构建期搬到运行期**。
- 运行期安装的**额外收益**：安装在目标机执行 → 原生模块自动是本机平台 →
  **省掉 per-platform 资产矩阵**。
- 运行期安装的**代价/风险**（M1 平台验证范围）：
  - 原生模块 prebuilt 与否（node-pty prebuilt ✓；koffi 3.x optionalDeps prebuilt
    结构已由 lockfile 证实，其 install 脚本 `cnoke --prebuild` 先 require 探测；
    开发树 Electron-as-node 安装链已有记录，**真实打包 `.app` 内的 koffi load 仍以
    STATUS 的 M1 边界为准**）；
  - 浮动依赖解析（运行期无 frozen lockfile）；
  - 安装耗时/体积（预估 2–10 分钟、数百 MB 解压）；
  - 内嵌 pnpm（npm 包实测 37MB，**删 artifacts 后 ~19MB 可正常运行**，
    开发树记录）；
  - **Electron-as-node 跑 pnpm 全链路（ESM shim/worker_threads）**：开发树路径
    已实测；打包态 extraResources 路径由 acceptance harness 覆盖，但没有真实
    `.app` 结果时不得视为通过（R3-2 F2）。

## 3. 架构

### 3.1 获取层：运行期 npm 安装（单一实现，2026-08 用户拍板移除 Provider B）

```
dsh-runtime-updater.ts（客户端）
  feed = npm registry metadata（versions / dist-tags.latest）
  将 registry origin + 精确版本 + dist.tarball + dist.integrity 绑定为一次安装解析
  同源重定向约束下只下载一次顶层 tarball，流式校验 SRI，落到私有 work 目录
  pnpm install file:./dsh-runtime-package.tgz（内嵌 pnpm，hoisted + allowBuilds）
  prune + 冒烟 + 关键文件摘要 + 只读原子发布
  —— 平台无关、不等 chamber 发版、无预打包
```

- **顶层包不二次解析**：pnpm 接收的是已校验的本地 `file:` tarball，不再按包名/
  版本向 registry 重新选择顶层包；因此 metadata 检查与安装之间即使 registry
  发生变化，也不能替换已绑定的顶层字节。传递依赖仍由 pnpm 从同一显式 registry
  解析，并按各自 npm integrity 校验。
- 客户端数据面：「目录里有版本树 → 切指针 → 探针门控 → 回退」。
- **无降级 provider**：运行期安装是唯一获取方式（完全移除 Provider B 预打包方案）。
  M1 平台验收只确认实现细节（Electron-as-node、原生模块与打包资源等），不过则
  修实现，不再有 A/B 分支。

### 3.2 存储模型：不可变版本树 + 原子指针切换（R3-1 P1-1/P2-5）

**宿主根（§9 扩展）**：desktop = `<userData>/dsh-runtime/`；gateway =
`<stateDir>/dsh-runtime/`（与 gateway state 同目录，权限纪律并入 design 17 §12：
目录 0700、JSON/secret 0600）。两个宿主各自管理自己托管实例的运行时，状态
零交叉。树形与保留策略两侧完全同构：

- `<version>/` —— **不可变版本树**（安装完成即只读；manifest 记录
  `dependencies["@deepseek-ai/dsh"]` 与 `dsh.platform`，与捆绑树同形）；
- `current` —— **指针文件**（JSON `{version}`），**切换 = 指针的原子写**
  （tmp + rename），不 rename 任何目录树——Windows 文件锁问题在切换路径上
  基本消失；**指针用普通文件，禁用 symlink**（Windows 无开发者模式时创建失败）；
- `snapshots/<源版本>-<时间戳>/` —— DSH_HOME 快照（§3.7；**命名 = 源版本**，
  即切换前活跃版，R3-1 P1-3）；
- `failures/<version>.json` —— 失败现场记录（§3.7）；
- `override.json` —— override 标记（原子写 + 损坏保留 *.corrupt，非秘密）；
- **保留策略（无矛盾版本，R3-1 P1-1）**：受保护类版本——当前指针指向、known-good、
  pending 指向、`.failed` 失败现场——**绝不逐出**；其余版本树由自动清理按上限
  逐出；**用户显式选择安装过的版本树保留到显式清理**（registry yank 后缓存树仍
  可用——「自由回滚」的物理基础）。即：「自动清理」只逐出**不受保护**类版本，
  不与「保留到显式清理」冲突。
- **恢复内建**：写 `reset-builtin` intent → 停机/快照 → 原子清 `current` →
  内建锚全量探针；失败回旧指针并恢复快照，成功才删除 override/journal（连带
  pending）。dev/env 覆盖下的语义见 §3.5/§3.6。

### 3.3 应用时机 = 下次启动的异步相位（R3-1 P2-7）

**不在模块级 `resolveDshWorkspace` 里做快照/切换**。pending 应用移入 **whenReady
后的异步启动相位**，**固定顺序**：

```
reaper（回收孤儿实例）→ 快照 DSH_HOME（§3.7，断言无存活写者的静止拷贝）→
切指针（原子写）→ spawn 本地实例 → 探针门控
```

- 快照先于任何可能写 DSH_HOME 的动作；指针切换先于 spawn（未决切换前绝不 spawn）。
- 应用期间 UI 状态行「应用 dsh vY…」；**应用期间挂起周期检查与手动检查**。
- **换树（指针写）失败路径**：指针原子写几乎不会失败；若失败 → 跳过 pending、
  保留现有树继续 spawn、响亮提示；**swap-attempted 标记**——仅在阻塞消失（用户
  再次操作）后重试，避免每次启动重复警告。
- **崩溃安全**：指针写本身原子；快照/恢复的中断协议见 §3.7（含 restore-in-
  progress 标记的幂等补完）。
- `resolveDshWorkspace` 改造为**读取 current 指针**（override 生效时），保持同步
  轻量。

### 3.4 激活门控与回退（自由选择模型的唯一安全网，R3-1 P2-4/P2-8/P2-12）

换树后、宣布生效前跑探针列表（全部复用现有设施，**全部只读、无副作用**）：

- `host.describe`；`commands.execute` 以固定不存在 session 调用并精确期待
  `session/not-found`，只验证 wire 解码且不进入 CommandRuntime；session/workspace
  **只读 list**（绝不 create）；graph 通道 `clientGraph/graph`；host settings
  只读 RPC `settings.describe`；`gitWorktree/previewCreate` 以空输入精确期待
  `invalid-input`，在 Git 进程/仓库扫描前停止；**带既有 `$DSH_HOME` profile 数据
  boot + 数据
  可读性探测**（settings.yaml 可解析、会话列表可读）。
- **探测窗口与裁决**：默认 ≤60s 超时；超时**不立即判失败**——进入「继续观察 +
  延迟裁决」（给慢迁移二次确认窗口），再失败才回退。
- **回退目标（统一口径，R3-1 P2-4）**：**自动回退目标 = 切换前版本（若其曾探针
  通过或为 known-good），否则最近 known-good**——与 §5「切回旧指针」一致，绝不在
  两棵坏树间交替。
- **known-good 维护**：显式 known-good 标记——探针通过 + **连续健康 24h
  且至少 1 次成功 boot** 才推进（离线墙钟时间不算健康时间）；「上一可运行版本」= 最近的
  known-good。**回退连续失败一次即落内建树 + 响亮终态**。
- **延迟崩溃（F7）**：探针通过后 30s 才崩——**restart-exhausted（窗口内 M=5 次
  重启，设计 02 §3.6；注意与连续探活失败阈值 N=20 区分）且激活树是 override →
  触发一次自动回退**（复用本路径），作为状态机分支。
- **激活门控边界（诚实声明）**：探针是 **host 侧**探测；**渲染侧**（chamber
  前端 boot 实例 web 资产）不在门控内——渲染侧不兼容以首屏 boot 结果呈现（boot
  容错降级，设计 09 §3.5/§4），boot 失败则 fatal 覆盖层出现，用户经 settings 换
  版本恢复。
- **隐式兼容下限（F15，措辞修正 R3-1 P2-12）**：探针 wire 形状随壳重基代漂移
  （rc.8 `commands.execute` 增 `images` 参数先例——方向是新宿主拒旧客户端；反方向
  新客户端探测旧宿主同样有拒收面）；**基线以下版本探针失败风险高**（不承诺
  「必然」）——选择器对 chamber 兼容基线以下版本给提示「可能无法 boot，chamber
  已移出支持面」。

### 3.5 `resolveDshWorkspace` 与失效规则（R3-1 P2-6；R3-3 UX-P1-F1）

优先级：`DSH_CHAMBER_DSH_PATH`（env）→ userData override（未失效时）→
`resourcesPath/vendor/dsh`（dev：ref-dsh → pkgDir/vendor/dsh → null）。override
记录 `{shellVersion, chosenVersion, resolvedVersion, pending, swapAttempted, selectedOnly?}`。

**gateway 解析链（§9.3）**：`DSH_GATEWAY_DSH_PATH`（env，恒最高）→
override（未失效时）→ 内建锚（`--dsh-path` ?? `findDshWorkspace`）。失效基准
`shellVersion` = gateway 包版本；"恢复内建" = 经 §3.3/§3.7 完整激活事务回落
锚链，成功裁决才删除 override/journal。既有
"仅设 `DSH_GATEWAY_DSH_PATH`"的部署行为不变（env 恒最高）。

- **gateway staged selection 证明**：gateway 的 select/apply 分步。仅当 select 当下
  `current` 本来就缺失（内建锚是权威）时写 `selectedOnly:true`，允许“已缓存/已安装但
  尚未 apply”的选择与空 pointer 共存；若用户树 v1 正在生效而只 stage v2，必须写
  false/省略，随后 v1 pointer 丢失仍 fail closed，绝不能借 staged v2 静默回落内建。
  apply/rollback 会清除此证明并写 pending；解析器只接受完整、未失效的 staged 形态。

- **失效规则（覆盖 override 与 pending）**：启动时 `shellVersion ≠ 当前壳版本`
  → override 与 pending **一并失效**。**失效 = 标记失效（保留记录、版本树与快照）**
  而非删除——F4「自动恢复上一 override 树」依赖记录存活；「恢复内建」仅在
  内建锚探针通过后显式删除。
- **回落保护（F4）**：回落内建树后跑数据可读性探测——用户曾用较新运行时并迁移
  过数据、内建 pin（默认 0.1.2-alpha.2，不随壳移动）可能读不了新格式数据；探测失败
  → **自动恢复上一 override 树（受保护类，仍在）+ 响亮提示**。「单调向前」**仅对
  壳版本成立**（§7）。
- **失效的用户可见记录（R3-3 UX-P1-F1）**：壳更新导致运行时选择失效时，settings
  记录一行「因应用更新，dsh 运行时已回落内建 vX（原选择 vY 保留，可重新选用）」——
  用户的运行时选择**绝不无声消失**。
- **pending 清除与重放**：pending 清除与探针裁决**同一次原子写**（override.json
  单一事务）；重放幂等——当前指针版本 == pending 版本 → 跳过切换直接探针；快照
  记录 pre-swap 时间戳。
- **恢复内建在 dev/env**：`DSH_CHAMBER_DSH_PATH` 优先于 override → UI 对 env 来源
  显示标记「(env)」且禁用版本 mutation；非 env 的 dev 来源仍走 reset-builtin
  完整事务，成功后回落现有 fallback 链。
- **dev 工作流边界（2026-08 补）**：override 统一优先于 dev 的 ref-dsh 回退——dev
  下若用户选/装了运行时版本，实例将从「跑 ref-dsh 源码」切换为「跑 npm 装好的树」；
  要持续用 ref-dsh 源码开发的，显式设 `DSH_CHAMBER_DSH_PATH`（env 恒最高优先）即可
  无视 override。dev 的 userData 由 `electron-dev.mjs --user-data-dir` 隔离到
  `packages/desktop/.dev-user-data`（已 gitignore），override/版本树/快照与打包版
  真实 userData 零交叉。

### 3.6 状态机与 UI（R3-1 P2-7；R3-3 UX-P1-F2/F3/F4）

**状态转移表（实现与验收契约，含全部转移，R3-1 P2-7）**：

```
idle → checking → available → downloading → installing → installed/pending
  →（下次启动）applying → applied | rollback | failed
pending → [恢复内建]（清 pending）→ idle/checking
applying → 回退连续失败 → 落内建树（终态）
applied → 下一周期 checking；rollback/failed → 终态（回滚后可再选版本）
任意态 → error（网络/校验/安装/探测失败，带 error 分支）
```

- **pending / applying 为终态门**：pending 期间除 [恢复内建]（连带清 pending）
  外其余动作禁用；选择当前激活版本为无操作；**单飞守卫覆盖整个 install 窗口**；
  apply 期间挂起周期/手动检查。
- **gateway 安装与激活隔离分层**：`installing` 只锁 runtime writer/registry 变更并投影
  下载进度，当前 dsh proxy 与 feature consumers 保持可用；只有 snapshot→switch→probe
  的 activation quarantine 才令 `canExposeLocal=false` 并 detach dsh 派生 feature。
  candidate/rollback candidate 的瞬时 ready 在 probe verdict 前不得 attach，裁决结束
  必须显式按权威 connectionState 重同步，不能依赖可能已被消费的 ready edge。
- **applying 相位门控（R3-3 UX-P1-F2）**：applying（快照分钟级）期间，connections
  本地卡片「启动」按钮与任何实例 spawn 入口**门控禁用**（状态行「应用 dsh vY…」），
  杜绝与「未决切换前绝不 spawn」竞态。
- **快照失败的中止态（R3-3 UX-P1-F4）**：快照失败 → 中止本次 + **置「快照失败」
  标记（settings 可见 + [重试应用] / [恢复内建] 动作），不再自动每启重试**——
  磁盘持续不足时用户有明确出口，不反复延迟 spawn。
- settings 落点（2026-09 用户拍板，per-server 化）：dsh 运行时不再是 chamber
  全局「通用」设置，而是**服务器相关配置**——在每个选中服务器自己的设置段列表
  里、**agent 预设（agent-presets）之后**新增「dsh 运行时」段（与 connections
  段同款的 `settings.section` 注册模式，05 §5；本地实例 = 完整管理面，gateway
  服务器 = 经反代触达该 gateway 的 `/chamber/runtime` 面，§9.3；ssh 服务器 =
  版本只读说明行 + 经 systemd 的重启动作，远端运行时版本随 systemd 部署、
  不在本设计 mutation 范围）。内容：
  当前版本行（内建 vA / 用户选择 vB / env 标记）+ 版本选择器（registry 版本
  列表，默认推荐 `dist-tags.latest`，当前版本置顶，兼容基线以下版本带提示，
  **离线时含缓存版本**——自由回滚的 UI 基础）+ 动作（更新到 vY / 回滚到 vZ /
  恢复内建 / 重启 dsh）+ 失败记录行（失败原因 + 建议）+ 数据快照状态行。
- **结果文案按分支（R3-3 UX-P1-F3，绝不无条件「数据已恢复」）**：
  - 完整恢复 →「dsh 运行时已回退 vX，数据已恢复」；
  - 半态（树已回旧、数据未恢复）→「运行时已回退 vX，**数据恢复失败**（保留现场
    .old），可重试恢复或联系排查」；
  - 启动补完失败（restore-in-progress 标记 + 快照缺失）→「数据恢复未完成（现场
    保留），请勿删除 userData 中的 dsh-runtime 目录」+ [重试恢复]。
- **M4 验收要求（R3-3 终审建议）**：「**状态 × 可见动作 × 文案**」矩阵覆盖
  全部状态（含 error / swap-attempted / 快照失败中止 / 半态 / 恢复失败），每行 =
  该状态下可见的动作按钮与状态行文案；纯矩阵、UI 与主进程合法转移边表已接线。
  损坏元数据的恢复能力也由主进程权威投影，renderer 不能伪造路径、版本或 capability。
- **版本来源双读**：「内建 vA」（resourcesPath）+「激活 vX」（resolve 结果）；
  `readDshVersion` 按 resolve 结果读取激活版本（M0 接线）。
- connections 本地实例卡片回显「dsh 运行时 vX」。
- zh/en 文案走 `dsh-chamber.settings.bridge` 命名空间（**key 集由
  `typecheck:settings-bridge` 的 Record 类型强制；verify:i18n 只查文档对，不覆盖
  插件文案——如需内容级防护为 locales.ts 建 hash-record 对，R3-4 F4**）。

**前端显示规格（2026-08 用户拍板：registry 源用户自设 + 双版本区分显示；2026-09
用户拍板：从「通用」迁为 per-server 段）**——两块显示面，单一口径（「内建 vA」=
resourcesPath manifest；「激活 vX」= resolve 结果；「最新 vY」= registry metadata；
「版本源」= chamber-settings.json，非秘密）：

**A. 每个服务器自己的设置段列表 →「dsh 运行时」段（agent-presets 之后）**：

1. **版本概览行（双版本，呼应「运行期拉 + 打包内建」）**：
   - 主行「dsh 运行时 v0.1.2（激活）」+ 来源 tag：`[内建]` / `[用户选择]` / `[env]`；
   - 副行（仅当激活 ≠ 内建）「随应用内建 v0.1.2-alpha.2」；gateway 宿主副行口径
     「部署锚 vX（`--dsh-path`/`DSH_GATEWAY_DSH_PATH`）」——gateway 的"内建"
     是部署者提供的锚，不是随包版本（§9.3/§7 口径）；
   - env 来源时 tag 显 `(env)`，版本选择/registry/restore mutation 禁用，提示
     「由 env 路径指定」；来源无关的 `[重启 dsh]` 在进程 ready/degraded 时仍可用
     （desktop = `DSH_CHAMBER_DSH_PATH`；gateway = `DSH_GATEWAY_DSH_PATH`）。
2. **版本选择器**（下拉）：置顶当前版本（「当前」）→ `dist-tags.latest`（「推荐」）→
   其余 registry 版本降序 → 离线时追加缓存版本（「已缓存」）；兼容基线以下版本加
   「可能无法 boot」警示。
3. **动作**（依状态切换）：`[更新到 vY]`（较新）/ `[回滚到 vZ]`（较旧）/
   `[恢复内建]`（清 override 含 pending）/ `[重启 dsh]`（见 8；运行中可用——
   applying/pending/checking/downloading/installing 拒绝；env 源不禁 restart）；
   pending/applying 期间除 `[恢复内建]` 外禁用；选当前版本 = 无操作。
4. **版本源设置行**（registry 源用户自设）：下拉 `npmjs（默认）` / `npmmirror` /
   `自定义…`；自定义走 §6 URL 白名单校验（origin 精确、拒绝 userinfo、decode
   归一化）；附 `[检查更新]`（宿主进程执行一次检查：desktop 主进程 / gateway 进程，
   metadata 请求 + 更新判定，失败回显原因）；
   小字说明「安装与版本检查均来自所选源，切换源即切换信任边界」。
5. **状态/进度行**（上下文驱动）：idle「已是最新版本 / 有可用更新 vY」；checking
   「检查更新中…」；installing「安装 dsh vY…」；pending「将于下次启动切换到 vY」；
   applying「应用 dsh vY…」；applied「已更新到 vY」；rollback/failed「错误文案（脱敏）」。
6. **失败记录行**（仅失败时）：「vY 安装失败：<原因> — 建议升级 dsh-chamber / 重试」。
7. **数据快照状态行**：「数据快照 N 份（最近 <时间>）」；快照失败态「快照失败：<原因>
   [重试应用] [恢复内建]」。
8. **重启 dsh**（2026-09 用户需求：刷新插件挂载）——`[重启 dsh]` 次按钮，
   二次确认后执行**受控进程重启**（不是版本切换）：优雅停止（SIGTERM 进程组
   → 1s → SIGKILL，02 §3.7）→ 重新 spawn（同端口 / P+1 退让）→ 就绪探测。
   **刷新语义**（重启生效的一切，02 §2.6/设计 13）：chamber host 包 seed thunk
   每次 spawn 前重新求值（client-graph/git-worktree 挂载行按当前构建产物重建）；
   dsh boot 重读 DSH_HOME profiles + `--patch` overlay（`dsh plugin` 装/删的
   插件生效）；前端 N-ctx shell 经 WS 断开重连后重新 boot（design 09 每实例
   boot graph 重新合并）。**互斥与门控**：与健康状态机 `restarting` 单飞行
   互斥；applying 期间禁用（同「应用 dsh vY…」门控）；执行期间状态行
   「重启 dsh…」→「已重启」（就绪探测通过）/ 诚实失败文案（附 host-logs
   入口）。失败不回滚、不改指针——重启前后运行同一棵激活树，仅进程级刷新。
   per-server 分支：local = 控制面新增事务接口 `restartLocal()`（与健康状态机
   重启单飞行串行化，**不用** `stopLocal()`+`startLocal()` 裸组合——会与
   健康"进程死亡即重启"分支交错，§9.3）；gateway = `POST /chamber/runtime/restart`
   （202 + status 轮询/SSE，§9.3）；ssh = 既有 `restart_service` systemd IPC
   （03 §2.2）重启远端 dsh——设计 13 的"远端插件重启后加载新 row"同路径；
   远端重启窗口内隧道 phase 保持 `ready`（隧道未断）、实例反代对目标连接
   拒绝返回显式 503（诚实失败，03 §3），会话/侧边栏短时错误属预期。
   Electron 壳无需重启：插件
   挂载在每次 dsh 进程 boot 时重新确定，不是 Electron 会话级事实（02 §2.6）。

**B. connections 本地实例卡片**：加一行/chip「dsh v0.1.2」，读同一 resolve 结果，
与 settings 块同源一致（M0 接线）。

**页面结构与样式设计（per-server 段；对齐官方 settings-panel 设计语言）**：

**页面结构（组件树，2026-09 per-server 修订）**：

- settings 壳：`SettingsShell` 服务器下拉选中任一服务器后，该服务器的设置段
  列表在 **agent-presets（agent 预设）之后**追加 chamber 自研段「dsh 运行时」
  （子上下文 `settings.section`，id `dsh-runtime`、order 31；connections 为
  壳的固定 nav 入口、在分隔线之下，不占 ledger order——视觉顺序即
  agent-presets → dsh-runtime）。**不再出现在 `__general`（通用）视图**——
  `GeneralView` 只保留设计 15 的控制组（启动与关闭 / 运行 / 更新），运行时块
  从中移除。
- 每服务器行为按来源分支（同一段、同一视觉，事实与动作随实例路由）：
  - **local**：完整管理面（本段显示规格 1–8 全量）；事实读主进程权威投影，
    动作走既有 IPC（design 18 §3.6 状态机同口径）；重启 = 控制面事务接口
    `restartLocal()`（§9.3，与健康重启单飞行串行化）；
  - **gateway**：同一段内容，但事实与动作经该实例反代触达 gateway 的
    `/chamber/runtime`（`/api/i/gateway-<id>/chamber/runtime/*`，§9.3），
    不接触 token（design 17 §7.2/§12 纪律）；状态机文案矩阵同口径；
    重启 = `POST /chamber/runtime/restart`。gateway 分支已落地完整 per-server
    管理面：版本选择器、状态/失败、快照、更新/回滚/恢复内建、registry 与
    restart 均经认证反代代理；剩余仅为 STATUS 登记的组件级与实机验收门禁
    （§9.5），不再以缩减视图作为产品契约；
  - **ssh**：版本只读——显示远端 dsh 版本行（实例面可得时）与「运行时由远端
    systemd 部署管理」说明，无版本 mutation 控件（远端运行时版本随 systemd，
    设计 13/18 口径）；**唯一动作 `[重启远端 dsh]`** = 既有 `restart_service`
    systemd IPC（03 §2.2）——刷新远端插件挂载（设计 13 §3 重启后加载新 row
    同路径），同样二次确认 + 状态行；
  - **dsh（http 直连）**：**不挂载**——无管理面、无 ssh 通道、无 `/chamber`
    面（design 17 §3 能力差异表），该来源设置段不渲染 dsh-runtime 分节、
    无任何版本/重启动作。
- `DshRuntimeSection` 内部行序（自上而下，与上列显示规格一一对应）：
  ```
  .runtimeSection（官方 settings-section 词汇：列向 gap 8px）
    h3.sectionGroupTitle             「dsh 运行时」（官方段标题词汇）
    .runtimeVersionRow               版本概览（主行 + 来源 tag + 内建副行）
    .runtimeFieldRow                 版本选择器（field label + select）
    .runtimeFieldRow                 版本源（field label + select + [检查更新]）
    .runtimeActionsRow               动作按钮组（更新 / 回滚 / 恢复内建 / 重启 dsh）
    .runtimeStatus                   状态/进度行（aria-live="polite"）
    .runtimeFailureRow               失败记录（仅失败时，role="alert"）
    .runtimeSnapshotRow              快照状态行
  ```
- connections 壳：`ConnectionsSection` 的本地卡 `.localCard` → `.localMeta` 追加
  一个版本 chip（`.mono` 字体），与端口 / label 同一行内联，不新增独立卡片区。

**样式设计（全部走 `--dsw-alias-*` token，复用官方 settings-section 词汇）**：

- 容器 `.runtimeSection`：与官方设置段同款列向 gap 8px；组标题复用官方
  section 组标题词汇（12px / 600 / letter-spacing .06em / uppercase /
  `--dsw-alias-label-tertiary`）。
- 版本概览行 `.runtimeVersionRow`：flex / space-between / align-center /
  gap 10px；主行 `.runtimeVersionLabel` 13px / primary；来源 tag `.sourceTag`
  用 `.badge` 词汇（border-radius 999px / padding 1px 8px / 11px / border l2 /
  tertiary）；内建副行 `.runtimeBundledRow` 12px / tertiary（= `.generalHint`）。
- 字段行 `.runtimeFieldRow`：复用 `.generalRow`（列向 gap 6px，field label
  `.generalFieldLabel` 14px / 500）；下拉 `.runtimeSelect` 用 `.dropdownTrigger`
  词汇（border l2 / radius 10px / bg layer-3 / 13px，focus 时 border brand）。
- 动作按钮：主按钮「更新到 vY」复用 `.updatePrimaryButton`（dense capsule 28px /
  radius 14px / `--dsw-alias-button-primary-fill` / label-primary-foreground）；
  次按钮「回滚到 vZ」「恢复内建」「重启 dsh」复用 `.updateButton`（透明 +
  border l2 / radius 14px）；禁用态 opacity .4。
- 状态/进度行 `.runtimeStatus`：block（aria-live，Chromium 不暴露 display:contents）；
  `.runtimeStatusText` 13px / primary；失败行 `.runtimeFailureRow` 12px /
  `--dsw-alias-state-error-primary`（= `.generalError`）；快照行 `.runtimeSnapshotRow`
  12px / tertiary。
- connections 本地卡版本 chip `.localVersion`：`.mono` 字体 / 12px /
  `--dsw-alias-label-secondary`，插入 `.localMeta` 行尾。
- 空/占位纪律：桥未水合时控件 disabled + 占位值，**绝不假「off」/ 假「已是最新」**
  （honest-signal 纪律沿用）；ssh 段无占位假控件——只显示说明行。
- i18n：新增 key 全部入 `dsh-chamber.settings.bridge` 命名空间（`Record` 类型强制 +
  `verify:i18n`）；zh/en 文案 key 集与 M4「状态 × 可见动作 × 文案」矩阵同源维护。

### 3.7 用户数据保护（跨版本数据安全，R3-1 P1-3/P2-9）

**事实基础**：运行时树与用户数据（DSH_HOME = `<userData>/state/dsh-home`）物理
分离——切指针不动数据目录；chamber 自有数据完全不在切换链路上。真实风险只有：
① 新版本读旧格式数据不兼容；② 回滚后旧版本读新版本写过的数据失败。

**方案（单一 DSH_HOME 跨版本共享 + 切换前自动快照）**：

- **数据跨版本延续**：DSH_HOME 恒定，升级后会话/工作区无缝可见；
- **快照**：每次切换前，在 **reaper 之后、spawn 之前**（§3.3 顺序），对 DSH_HOME
  做**静止拷贝**（断言无存活写者）到 tmp → 原子发布到
  `snapshots/<源版本>-<时间戳>/`（**源版本 = 切换前活跃版**）。**不变量：无快照
  不切指针**——快照失败（ENOSPC/权限）→ 中止 + 快照失败标记（§3.6）；
- **数据可读性探测**（§3.4）：新版本启动后校验 settings.yaml 可解析、会话列表
  可读；
- **失败回退 = 切回旧指针 + 恢复快照**。**恢复协议（两阶段 + 幂等补完）**：
  写 `restore-in-progress` 标记 → `DSH_HOME → DSH_HOME.old` → `snapshot →
  DSH_HOME` → 删标记。**补完只按持久 phase 与精确路径状态推进（R3-1 P2-9）**，
  不再以“目录非空”猜完成；快照缺失时保留 `.old` 与 marker 并响亮失败（§3.6
  文案分支）。restore marker 通过有界 `O_NOFOLLOW` 描述符读取、单硬链接与父目录/
  inode 前后复验；dangling/external symlink、多硬链接或不安全 staging/home/backup
  目录一律视为未完成，绝不跟随、chmod 或清 marker。数据与树的回退**分别跟踪**
  （半态显式可辨）。`dsh-runtime`、`snapshots`、`pre-rollback` 与 DSH_HOME 父目录
  同样要求真实目录及稳定 parent identity；root symlink 时快照、遍历、prune/cleanup
  整轮 fail-closed，绝不向外部目录写入或删除。
- **手动回滚数据语义（R3-1 P1-3，显式取舍）**：**手动回滚 = 恢复到目标版本上次
  活跃期的数据**（= 该版本作为源版本时的快照）；回滚前**当前活跃数据暂存
  `<dsh-runtime>/pre-rollback/<时间戳>/`**（保留至下次切换，上限 1 份）——回滚不
  丢弃当前数据，且用户可反悔。目标版本无快照（保留范围外）→ 用当前数据 + 探针
  兜底（既有路径）。
- **快照保留**：当前/known-good 每个来源版本保留最新一份；激活 journal 与失败
  现场精确引用的快照绝不删除；另保留最近 3 份未受保护快照；pre-rollback 暂存
  上限 1 份。恢复标记或 retention 元数据损坏时清理 fail-closed（保留而非猜删）。
- **损坏选择元数据的显式恢复**：`current` / `override` / activation journal 损坏时
  本地实例先隔离；主进程仅在 writer/reaper/restore 均静止且内建版本可验证时投影
  [保留数据并恢复内建]。原生确认后先把完整 DSH_HOME 发布到私有 recovery stash，
  再逐个原子归档原始元数据字节，最后隔离启动内建树并执行完整探针；任一崩溃点都由
  durable marker 幂等续作，探针未全绿绝不开放代理。正常 profile 与 dangling symlink
  只按链接实体保存、绝不读取目标；目录身份复制前后复验，多硬链接与特殊文件
  fail-closed，避免 TOCTOU 越界或改写旧证据。
- **恢复标记自身损坏（二阶恢复）**：仅普通、可读、单硬链接 marker 可由同一无参
  可信动作显式 rescue。实现使用独立 `metadata-recovery-rescue-data/<id>`，在新完整
  DSH_HOME stash 与旧 marker 的长度/SHA256/身份副本均落稳后，以一次 rename 提交
  新 marker；旧 `metadata-recovery-data` 整树不改，commit 后仍复用普通续作的
  archive/probe/finalize。marker 是 symlink、特殊文件、不可读或多硬链接时保持隔离并
  保留现场，不猜测修复；rescue data 与 commit 前 orphan 均纳入逻辑磁盘配额。

**诚实边界（写进契约）**：chamber 保证「数据不因版本切换而丢失/损坏不可恢复」
（快照兜底 + 两阶段恢复 + 幂等补完 + 无快照不切换 + pre-rollback 暂存）；**不
保证**「新版本 dsh 一定能读懂旧数据」——数据迁移是 dsh 官方责任。读不懂走回退，
数据仍在快照里。

## 4. 运行期安装细节（R3-2 F1/F3/F4/F5/F6/F7/F11/F15/F21/F24；R3-5 P1-1/P1-2）

- **内嵌 pnpm（新增运行时依赖，显式声明）**：desktop dependencies 增加 `pnpm`
  **钉精确版本 11.21.0（对齐 BUNDLE_PNPM_VERSION）**——AGENTS.md「不新增运行时
  依赖」纪律的刻意偏差（与 design 11 引入 electron-updater 同性质）；**放置位置
  定案 = extraResources（实体盘，非 asar 内）**——规避 asar 内 .cjs 仅 Electron-
  node 可读、allowBuilds 生命周期子进程需继承 ELECTRON_RUN_AS_NODE 的整类问题
  （R3-5 P1-1）；体积 npm 包实测 37MB → 删 artifacts 后 ~19MB（开发树记录）。
  spawn 用 `resolveNodeExecutable`（Electron 分支），直接 `node pnpm.cjs` 跨平台
  无需 shell；**install 子进程纳入 will-quit 回收**（与 transport 同款
  TERMINATE_GRACE，work 目录记 pid 供启动清理判活，R3-2 F11）。
- **安装命令**：work manifest 先写
  `dependencies["@deepseek-ai/dsh"] = "file:./dsh-runtime-package.tgz"`，再执行
  `node <pnpm>/bin/pnpm.cjs install --config.node-linker=hoisted --store-dir
  <userData>/dsh-runtime/.pnpm-store --cache-dir <userData>/dsh-runtime/.pnpm-cache
  --registry <所选源> --fetch-retries=0`（+ 壳级总超时，R3-2 F4/F5）。注：
  `--no-update-notifier` 在 pnpm 11 已移除，命令中不含该旗标。
- **源钉死（R3-2 F1，P1）**：用户 `~/.npmrc` 会被 pnpm 读取，可覆盖 registry
  使安装源漂移、供应链锚点与白名单矛盾——安装子进程 env **scrubbing**（只保留
  PATH 与 HTTP(S)/NO_PROXY 基础项，剥离用户 npm config/凭据）+ HOME 与
  XDG_CACHE_HOME 分别钉到 `<dsh-runtime>/.install-home` / `.xdg-cache` +
  **`NPM_CONFIG_USERCONFIG` 指向壳自管空文件** + **显式 `--registry`**。
  **registry 源用户自设
  （R3-2 F12，2026-08 用户拍板）**：检查/安装均由主进程 spawn 执行，registry 源
  在软件内由用户显式设置（settings「版本源」下拉：npmjs 默认 / 白名单镜像 /
  自定义 HTTPS registry，走 §6 URL 白名单校验，存 chamber-settings.json，非秘密）；
  **不做按 locale 的静默默认切换**——语言≠地理位置，且静默换 registry 等于静默换
  信任锚。默认 npmjs；用户切换后 metadata 与 integrity 一并来自所选源，信任边界
  显式可见。
- **allowBuilds（R3-2 F6/F7，P1）**：白名单（node-pty/koffi/protobufjs/
  @google/genai/@deepseek-ai/dsh-subprocess-local）**单一来源常量**（bundle-dsh.mjs
  与运行期安装器编译产物同源，R3-5 P2-3）；运行期 work 目录只写 `true`、**绝不写
  `false`**（显式 false 实测静默跳过脚本，破坏 fail-safe）；**work 目录必须先写
  pnpm-workspace.yaml 再跑 pnpm**（完全缺失 allowBuilds 配置实测硬失败），且
  work 目录不得位于含 pnpm-workspace.yaml 的祖先下（向上探测实测报错）；**白名单
  miss 是硬失败**（实测 ERR_PNPM_IGNORED_BUILDS）→ 新 dsh 引入新 build-script
  依赖时安装失败，UI 给出「请升级 dsh-chamber」指引（「不等 chamber 发版」对这类
  版本不成立，诚实声明）；简略 packument 无 hasInstallScript（实测），且捆绑基线
  lockfile（`packages/desktop/vendor/dsh/pnpm-lock.yaml`）同样不记录
  `hasInstallScript` 字段——因此**无法从 lockfile 推导 build-script 覆盖**，白名单
  覆盖以「单一来源常量 + 漂移钉死测试 + 白名单 miss 硬失败」三层兜底（allow-builds
  测试钉死 5 项；新增 build-script 依赖的检测由真实安装的 ERR_PNPM_IGNORED_BUILDS
  显式失败暴露，UI 引导升级，不静默跳过）。
- **prune 打包纪律**：`packages/desktop/prune-runtime.mjs` 由 desktop `files`
  显式枚举，打包态不依赖会被排除的根 `scripts/`；**版本切换 = current
  指针原子写（新小模块），不搬 bundle-swap 的目录
  rename 交换**（那是 F12 否决的模型）；仅 §3.7 DSH_HOME 两阶段恢复借鉴
  dest→backup→new→cleanup 模式（R3-1 P1-2）。
- **供应链信任声明**：运行期安装执行白名单内依赖构建脚本；信任模型 = npm
  registry（钉源后）+ 精确版本 + integrity + 白名单 fail-safe；用户选择安装即
  显式接受。koffi optional dep 瞬时下载失败会 fallback 到 cmake 源码构建、无
  toolchain 时硬失败——**安装失败重试一次并呈现 pnpm 日志摘要**（R3-2 F8）；
  Windows Defender 实时扫描 ~33k 新文件拖慢首次安装属预期，UI 安装状态行注明
  （R3-2 F17）。
- **浮动解析让步**：无 frozen lockfile → pnpm 解析最新传递依赖；冒烟（`bin.js
  --version` == 目标版本）+ 探针兜底；override 记录 resolvedVersion 与依赖快照。
- **路径安全**：registry 返回的版本串进入任何路径前强制 EXACT_SEMVER 预校验 +
  拒绝 `/`、`\`、`..`；tarball 302 重定向**最终** origin 同样白名单 + 强制 HTTPS。
- **磁盘与残留治理**：安装中断/退出残留的 work 目录与部分 tarball
  启动判活清理；版本树/store/cache/install-home/XDG/work/failure（含原子发布
  中断留下的隐藏 publish-backup）/snapshot/pre-rollback/restore-backup 均纳入
  分类与逻辑总量，新安装超过 10 GiB
  软阈值时 fail-closed（缓存树切换/恢复不受限）。用户清理只允许 inactive 且
  explicit-retained 版本，main 确认前后重读，writer fence 内再权威重读
  current/pending/journal/known-good/candidate/failure 保护集；受保护必须响亮拒绝。
  成功后执行 `pnpm store prune` 并刷新投影；维护清理保留最新 1 份已完成
  restore backup，restore marker 损坏时 fail-closed（R3-2 F21）。
- **manifest 发布时机**：prune + 冒烟之后写入精确版本、源、SRI 与关键文件
  SHA-256，原子发布（tmp + rename）为只读版本树，并在发布后复验；半成品目录绝不
  当作已装，既有有效树绝不覆盖（R3-2 F15）。
- **一次 source-bound 顶层下载（R3-2 F24）**：metadata 的
  `{origin, version, tarball, integrity}` 先绑定；壳只下载该 tarball 一次并流式 SRI
  校验，随后 pnpm 从本地 `file:` spec 安装。pnpm 不再对顶层包发起 registry
  解析/下载；这同时消除旧方案的「壳门禁下载一次 + pnpm 顶层再下载一次」。
- **registry metadata 用简略格式**（`Accept: application/vnd.npm.install-v1+
  json`，实测含 dist-tags.latest / dist.{tarball,integrity,unpackedSize}）；
  `dist-tags.latest` 缺失/畸形 → 回退 max semver 或报「无法推荐」。
- **integrity 粒度（诚实声明）**：顶层 tarball 字节由 source-bound SRI 钉死；
  传递依赖由 pnpm 按同一 registry metadata 的各自 integrity 校验，再由关键文件
  摘要、冒烟与激活探针兜底。

## 5. 数据流与 UX（R3-1 P2-4 回退目标对齐）

```
启动（延迟 15s）→ 静默读 registry metadata（不下载）
  ├─ 有可用版本 → settings「dsh 运行时」块「当前 vX，最新 vY」
  │     ├─ [选择版本]（默认推荐 latest）→ 用户确认 → 绑定源/版本/tarball/SRI
  │     │   → 一次下载 + SRI → pnpm `file:` install + prune + 冒烟
  │     │   （状态行「安装 dsh vY…」）
  │     │   → installed/pending（终态门）→ 下次启动异步相位：
  │     │     reaper → 快照 DSH_HOME（无快照不切换）→ 切指针 → spawn →
  │     │     探针门控（只读、有界窗口 + 延迟裁决）
  │     │       ├─ 通过 → applied（known-good 候选，数据无缝延续）
  │     │       └─ 失败 → 保留现场 + 回退目标（切换前版本或最近 known-good）+
  │     │           恢复快照（两阶段 + 幂等补完）+ settings 按分支文案
  │     └─ 不选择 → 永不下载（仅状态行）
  ├─ 无新版本 → 「已是最新版本」
  └─ 失败（metadata/绑定/下载/SRI/安装/探测）→ 「无法检查更新/安装失败/已回退」
      （静默日志或响亮，绝不假成功）
用户主动 [选择版本]（任意 registry 或缓存版本，含回滚）→ 同一条路径
[恢复内建版本] → reset-builtin intent → 停机/快照/清指针/内建锚全探针 →
  成功后删除 override+journal；失败回旧指针并恢复快照（§3.5/§3.7）
失败现场：<userData>/dsh-runtime/failures/<version>.json + .failed 树
数据快照：<userData>/dsh-runtime/snapshots/<源版本>-<时间戳>/
回滚暂存：<userData>/dsh-runtime/pre-rollback/<时间戳>/（上限 1 份）
恢复协议：restore-in-progress 标记 + 两阶段 rename + 幂等补完（§3.7）
```

## 6. 安全与已知让步（R3-1 P2-13 引用修正；R3-5 P2-6）

- **完整性**：顶层 tarball 一次 source-bound 下载并做 SRI；传递依赖由 pnpm 校验
  registry integrity；发布树再做关键文件摘要、冒烟/探针。版本选择器只允许
  registry 真实版本或已验证缓存树（精确 semver + 路径预校验）。
- **源钉死**：`--registry` + `NPM_CONFIG_USERCONFIG` + env scrubbing（§4）；
  registry 源由用户在 settings 显式设置（默认 npmjs，白名单镜像可选，§3.6/§4）。
- **URL 白名单**：registry 域（metadata / tarball 最终 origin / **search 端点
  `/-/v1/search`**）同款校验结构（new URL + origin + userinfo 拒绝 + decode 后
  前缀），为 registry 域新写实例（`isAllowedReleaseUrl` 硬编码 github 不可复用）；
  既有 `desktop_npm_search`（main.ts:1544 起）并入同一口径 + 行为保持测试
  （R3-5 P2-6）。
- **错误脱敏**：`sanitizeErrorText`（sanitize-error.ts:18 导出）提取为共享模块并
  导出，评估相对路径覆盖。
- **出网面**：desktop = 仅主进程访问 npm registry；gateway = 仅 gateway 进程
  访问（§9.3），控制面与 spawn 的 dsh 子进程两侧都保持零出网、
  loopback 闭环不变。
- **隐私**：不携带用户/SSH 材料；失败记录仅版本/时间戳/探测结果/脱敏路径。
- **已接受让步（用户拍板）**：无验证 + 自由选版本 = 壳可能跑在未重基的 dsh 上；
  安全网 = 探针门控（含延迟裁决）+ known-good 终态 + 三版本现场 + 无快照不切换
  + 两阶段恢复 + pre-rollback 暂存 + 一键恢复 + 失败记录引导「升级应用求兼容」。
  boot 层版本漂移容忍（设计 09 §3.5/§4）作纵深防御。
- **平台范围**：macOS/Linux 为 mutation 契约目标；Windows 仅展示只读状态，安装、
  切换、回滚、清理等动作由 controller/main/UI 三层拒绝。
- **单飞与幂等**：切换单飞守卫覆盖 install+apply 全程；选择当前版本无操作；周期/
  手动检查同路径；apply 期间挂起检查。

## 7. 版本管理与数据兼容（R3-5 P2-1 版本集口径修正）

- **目录版本** = npm registry 中 chamber 侧可安装的 dsh 版本；**内建基线** = 当前
  安装捆绑的 dsh（随应用更新移动；gateway 宿主 = 部署者提供的 `--dsh-path`/
  `findDshWorkspace` 锚，§9.3）；**用户选择** = override 记录
  （desktop `<userData>` / gateway `<stateDir>/dsh-runtime`，非秘密，不进
  `ssh-instances.json`/registry）。
- **「单调向前」仅对壳版本成立**：应用整包更新后回落内建（新壳重基代）；运行时
  版本失效（用户选择）非单调向前——用户可显式选更旧版本，失效回落带数据可读性
  探测保护（§3.5）。
- **chamber 发版版本集（口径修正）**：根包 + 全部非 fork
  `@dsh-chamber/*` 包（当前 14 个）统一 bump；`release-preflight.mjs` 的数据驱动扫描与
  release.yml 断言集是唯一权威，新增 chamber 包会自动纳入。两个
  `@deepseek-ai/dsh-client-*` fork 保持上游基线版本。`packages/dsh-runtime` 虽随
  chamber 版本集锁步并嵌入 desktop/gateway 产物，但按 §9.6 D2 不作为独立 npm
  发布物；这与用户在 registry 中选择的 **dsh 运行时版本**仍完全正交。
- 运行时替换后 `$DSH_HOME` 数据跨版本兼容：dsh 自身迁移责任；激活门控含数据
  可读性探测；跨版本数据安全由 §3.7 兜底。
- 双更新通道并存（design 11 + 本设计）：不同存储路径、不同状态机；失效规则覆盖
  override 与 pending（含用户可见记录）。

## 8. 实现分期（M0–M4）、当前判定与验收边界

> 本节给出里程碑定义与当前判定摘要；**STATUS 是唯一权威进度记录**。`done`
> 表示该里程碑的代码/自动化契约已闭环，`partial` 表示仍有明确未完成的实机证据或
> 生产接线，不把“已有脚本”写成“已经跑过”。

| 里程碑 | 当前判定 | 已落地 | 尚未声明完成的边界 |
|---|---|---|---|
| M0 版本显示 | **done** | 激活/内建版本双来源投影；settings 与 connections 本地卡回显；zh/en | — |
| M1 平台前置验证 | **partial** | 内嵌 pnpm 与 extraResources/asar-unpack/afterPack 静态门；开发树 Electron-as-node 安装记录；macOS packaged smoke harness 可校验 pnpm、koffi、dsh CLI 与 entitlement | 本轮按用户要求不构建、签名、公证或运行真实 `.app`，因此没有 packaged smoke 结果；Windows mutation 不在范围内，保持只读 |
| M2 获取/安装/磁盘数据面 | **done** | 简略 metadata、latest 回退、同源重定向、source binding、一次 tarball 下载 + SRI + pnpm `file:` install、allowBuilds、prune/冒烟/关键摘要/只读原子发布、全分类磁盘统计（含二阶恢复数据与 orphan）与 10 GiB 新安装软阈值、writer fence 内权威保护重读后清理、store prune/维护清理、IPC 与打包清单；loopback fake-registry 验收覆盖真实 pnpm 子进程 | fake-registry 使用开发树 Node/pnpm，不等价于 packaged Electron；该差异归 M1/M3 实机边界 |
| M3 激活/回退/数据保护 | **partial** | whenReady 活路径、durable activation journal、reaper → 快照 → 指针 → spawn → 全量只读探针、一次延迟裁决、自动/手动回退、两阶段恢复与启动补完、F4/F7、24h + 1 boot 连续健康 known-good、快照/失败保留、writer fence 与进程组静默门 | 尚无真实 packaged Electron 壳中“安装候选 → 全探针 → 故障 → 回退/恢复”的端到端记录 |
| M4 UI/状态矩阵 | **done** | 版本/源选择、检查/安装/回滚/恢复、失败与快照/磁盘投影、失效通知、平台/env 门控、状态 × 动作纯矩阵、i18n 与主进程合法转移边表；selection metadata 与普通损坏 recovery marker 均有无路径、主进程二次复核的显式恢复出口 | 不安全/不可读的 recovery marker 保持 fail-closed，属于安全终态而非自动修复能力 |

> **M4 证据口径（2026-09 修订注，随后由五路评审修正）**：M4 的 UI 证据针对 §3.6 修订前的
> 「通用」视图落点。per-server 段迁移（§3.6 修订）与「重启 dsh」动作**已随 §9 的
> M5–M7 落地（2026-09，见 §9 状态与本段修订注 9/10、STATUS）**——M4 done 覆盖修订前
> 矩阵与投影本身，per-server 化以 §9/STATUS 记录为准，不得把 M4 读成旧落点仍为当前实现。

### 验收边界

- `pnpm run acceptance:runtime:fake-registry` 已以 loopback `node:http` fixture 验证：
  简略 packument、`latest` 缺失回退、metadata/tarball 302、精确同源绑定、单次顶层
  tarball、SRI、真实 pnpm `file:` 安装、prune/冒烟与发布，结果以 STATUS 记录为准。
- `pnpm run acceptance:runtime:mac-packaged` 是**可执行夹具，不是已有 PASS 记录**。
  它要求真实 `.app`，会用 packaged Electron 执行内嵌 pnpm、require koffi、执行 dsh
  CLI 并检查 `disable-library-validation`。本轮用户明确不要求打包/签名/公证，故该项
  作为验收边界保留，不列为本轮代码验收阻断，也不得写成已通过。
- afterPack 的静态/fixture 测试只证明清单、entitlement 配置与断言逻辑；不能替代
  `.app` 的 Mach-O、签名或原生模块运行结果。
- Windows 明确为只读平台：可查看版本/状态，但不能安装、选择、应用、回滚或清理
  运行时；不以未跑 Windows mutation 测试为本轮偏差，因为该能力不在契约内。

### 仍开放但不阻断当前代码验收

- 真实 `.app` 中运行 packaged smoke，以及更强的 packaged fake-registry 安装 + web
  host + 全激活探针端到端；按用户要求本轮未执行。
- 快照体积实测与可再生物排除优化、安装耗时/磁盘体积的更多机器样本。
- 兼容基线下限随壳重基代维护。

## 9. 服务端化与共享核心（gateway 宿主 + desktop 迁移）

> 状态：**已实现（M5–M7 落地，2026-09；剩余实机门禁见 STATUS）**。本节把本设计的运行时管理能力扩展到
> gateway 服务端形态（修订 design 17 §2.1/§4/§8.4/§10/§11/§12/§13，S17–S20），
> 并把实现核心从 desktop 主进程抽取为共享包。关键代码事实（已核对）：
> control-plane 已有运行时切换 seam `getDshWorkspacePath()` / `canStartLocal()` /
> `canExposeLocal()`（`packages/control-plane/src/index.ts:129-137`，desktop
> `main.ts` 已完整使用）——版本切换路径 **control-plane 零改动**；「重启 dsh」
> 动作额外需要一个**增量的 `restartLocal()` 事务接口**（§9.3，与健康状态机
> 重启单飞行串行化，避免 stop/start 与健康自动重启交错）；gateway 的
> `dshWorkspacePath` 目前是构造时固定字符串（`cli.ts` → `config.ts` →
> `createControlPlane`）。

### 9.1 共享核心抽取：`packages/dsh-runtime`

- 新 workspace 包 `@dsh-chamber/dsh-runtime`：**纯 Node 22+**，不 import
  Electron/desktop/gateway/control-plane；依赖方向 = desktop 与 gateway →
  `dsh-runtime`（dsh-runtime 无 chamber 依赖）；gateway 构建沿用
  `scripts/build.mjs` esbuild 模式与 control-plane 一起打入 `dist/`。
- 迁入模块（自 `packages/desktop`，保持文件名与行为）：`dsh-runtime-updater`、
  `runtime-installer`、`dsh-runtime-store`、`runtime-state-machine`、
  `runtime-startup`、`apply-phase`、`override-lifecycle`、`activation-gate`、
  `runtime-probes`、`runtime-metadata-recovery`、`runtime-operation-fence`、
  `sanitize-error`，以及依赖模块 `snapshot-store`、`known-good-monitor`、
  `restart-exhausted-rollback`、`version-safety`、`registry-url`、
  `registry-integrity`、`registry-metadata`，外加 `allow-builds.mjs` 与
  `prune-runtime.mjs`（allowBuilds 白名单与 prune 常量/规则，见 §9.4）。
  desktop 改为 import/re-export
  共享包，现有 runtime 测试
  原样搬迁跟随（迁移期的行为等价证明）。allowBuilds 白名单、10 GiB 软阈值、
  保留策略等**单一来源常量**随共享包搬迁。
- 宿主适配接口 `RuntimeHostAdapter`（desktop 与 gateway 各实现一份；
  **核心裁决逻辑零分叉**，分叉只允许出现在适配器）。**本接口是草图**：
  M5 实现时以 desktop 现有 `StartupDeps`/`ApplyDeps` 的并集 + gateway 需求
  为权威定型，其中已确认必须覆盖的 seam——时钟注入（`now`/`nowMs`，
  apply-phase 既有依赖）、abort 信号源（`runtimeOperationAbort` 既有）、
  出网代理环境（install 子进程 env scrubbing 的 HTTP(S)/NO_PROXY 保留项）、
  进度投影粒度（notify）、`restartHost()`（§9.3 事务重启）。**M5 交付物
  强制包含一个纯 Node 的 fake host adapter 测试夹具**：共享包全部测试经该
  夹具运行（不依赖 Electron/userData/IPC），desktop 与 gateway 的宿主绑定层
  各自补一层薄适配测试——"现有测试原样搬迁"不成立（现测试耦合 desktop
  fixture 与路径），行为等价证明 = 共享包测试 + 双宿主绑定层回归：

```ts
interface RuntimeHostAdapter {
  stateRoot(): string            // desktop <userData>/dsh-runtime；gateway <stateDir>/dsh-runtime
  dshHome(): string              // desktop <userData>/state/dsh-home；gateway <stateDir>/dsh-home
  builtinAnchors(): { path: string; version: string }[]  // desktop packaged vendor/dsh；gateway --dsh-path/findDshWorkspace
  envOverridePath(): string | null  // DSH_CHAMBER_DSH_PATH / DSH_GATEWAY_DSH_PATH
  shellVersion(): string         // app version / gateway 包版本（override 失效基准）
  nodeExecutable(): { cmd: string; args: string[]; env: Record<string, string> }
  pnpmBin(): string              // desktop extraResources 副本 / gateway 依赖 resolve（§9.2）
  spawnAndProbe(version: string, isBuiltin: boolean, signal?: AbortSignal): Promise<ProbeResult[]>
  stopHost(): Promise<void>
  restartHost(): Promise<void>   // 事务重启：plane.restartLocal()（§9.3）
  registerInstallChild(child: ChildProcess): void  // desktop will-quit / gateway stop() 回收
  notify(snapshot: RuntimeStatusProjection): void  // desktop IPC / gateway SSE/poll
  platformGate(): { mutationsAllowed: boolean; reason?: string }  // Windows 只读
}
```

### 9.2 内嵌 pnpm 承载（决策 D1）

- 定案"内嵌 pnpm 钉精确版本 11.21.0"（对齐 `BUNDLE_PNPM_VERSION`），禁止系统
  pnpm 漂移；desktop 维持 extraResources 副本（实体盘）；
- gateway 新增**钉版本运行时依赖** `pnpm@11.21.0`（与 desktop 同源版本）。
  pack 后 npm 安装会把 pnpm 装入依赖树（解压 ~37MB，运行前不删 artifacts——
  与 extraResources 裁剪版不同，属已知取舍）；pack/install smoke 必须覆盖
  "依赖安装成功 + `gateway --help`"；
- 备选（不推荐）：`--pnpm-path` 注入 + PATH 探测——版本漂移违背内嵌定案。

### 9.3 gateway 宿主

**存储模型**：`<stateDir>/dsh-runtime/`，树形与 §3.2 同构（`<version>/` 不可变
树、`current` 指针（普通文件禁 symlink）、`snapshots/`、`failures/`、
`override.json`、activation journal、`.pnpm-store`/`.pnpm-cache`/`.install-home`/
work 目录）。权限纪律并入 design 17 §12（目录 0700、JSON/secret 0600、每次
加载/写入复验；corrupt 元数据 → 隔离 + 响亮失败，复用 metadata-recovery
语义）。磁盘治理随共享包带走，gateway 启动相位执行同一清理。**与 desktop 状态
零交叉**——两个 owner 各自管理自己托管实例的运行时。**单进程不变量**：一个
`stateDir` 同时只允许一个 gateway 进程（runtime 树/指针/快照无跨进程锁，
与 design 02 §2.5 的控制面仲裁同理，但 dsh-runtime 目录不设仲裁器——由
`owner.json` 以 `open(..., 'wx')` O_EXCL 排他创建守卫：并发 owner 得 EEXIST
fail-loud、存活 pid 拒绝启动、死 pid（ESRCH）接管，关闭 read-check-write
TOCTOU；违反部署纪律（如克隆 stateDir）仍是损坏风险）。

**解析链**（§3.5 已并入）：`DSH_GATEWAY_DSH_PATH`（env 恒最高）→ override
（未失效时）→ 内建锚（`--dsh-path` ?? `findDshWorkspace`）。`--dsh-path` 从
"唯一路径"降级为"内建/回退锚"；"恢复内建" = 先写 `reset-builtin` intent，
再走停机 → 快照 → 原子清指针 → 内建锚全量探针 → 失败回滚/恢复的完整激活事务，
仅探针成功后删除 override/journal。兼容
规则：既有"仅设 `DSH_GATEWAY_DSH_PATH`"的部署行为不变（env 恒最高）；CLI
仅在锚缺失时报错。失效规则同 §3.5（shellVersion = gateway 包版本），失效有
可见记录。

**控制面接线（版本切换零改动 + 增量 `restartLocal()`）**：`createGateway`
内部把静态 `dshWorkspacePath` 改为三个惰性 seam（镜像 desktop `main.ts` 用法）：

```ts
const plane = createControlPlane({
  ...,
  getDshWorkspacePath: () => {
    if (runtimeTransactionWorkspace !== null) return runtimeTransactionWorkspace
    const resolved = resolveActiveRuntime(runtimeBaseDir) // desktop 单参形态；gateway 侧为 runtimeManager.resolveWorkspace()
    if (resolved.path === null) throw new Error(resolved.blockedReason ?? 'dsh workspace not found')
    return resolved.path
  },
  canStartLocal: () => runtimeStartBlocked && !runtimeInternalStart
    ? { ok: false, reason: runtimeStartBlockedReason } : { ok: true },
  canExposeLocal: () => !runtimeStartBlocked,
})
```

静态 `dshWorkspacePath` 字段保留作内建锚与 boot 日志；`runtimeTransactionWorkspace`
在激活事务期间指向候选树，事务结束即清空。

**启动顺序（design 17 §4.1 修订）**：在 `startLocal()` 之前插入运行时启动
事务（共享包 `runtime-startup`）：残留 install 清理 → 逐出 → interrupted-restore
幂等补完 →（有 pending 时）快照 `<stateDir>/dsh-home` → 原子切指针 → 经
`startLocal()` spawn 候选（`canExposeLocal` 隔离）→ 全量只读探针 + ≤60s 窗口 +
延迟裁决；通过 → 开放投影；失败 → 回退目标（切换前/最近 known-good）+ 快照
恢复（两阶段 + 幂等补完）；快照失败 → 中止 + 可见标记（不自动每启重试）。
无 pending 仅清理/补完。`stop()` 先回收 runtime install 子进程，再关 feature
consumers，再停 plane。`spawnAndProbe`/`stopHost` = `plane.startLocal()`/
`plane.stopLocal()`（既有 `PlaneHandle` seam）。探针清单同 §3.4 全量，共享包
提供，gateway 零新探针。

Gateway 在 `DSH_GATEWAY_DSH_PATH` env 来源下，startup core 的 `env-override` bypass
标记归一为健康结果：status 不得显示 blocked/error。env 只禁止版本、registry 与
restore mutation；来源无关的受控 `restartLocal()` 仍可用。

**重启 dsh 事务接口（增量，`PlaneHandle.restartLocal()`）**：用户触发的
「重启 dsh」**不得**用 `stopLocal()`+`startLocal()` 裸组合——优雅停止会让
健康监控看到"进程死亡"并触发自动重启分支（02 §3.5 进程死亡 → 直接重启），
与用户的 start 交错成双 spawn/端口竞争。新增 `restartLocal()`：与健康状态机
的重启单飞行（`currentRestartPromise`）**共用同一串行化**——(1) 事务内
SIGTERM→1s→SIGKILL 停止；(2) 窗口内挂起健康触发重启（单飞行合并，绝不双
respawn）；(3) 重新 spawn（同端口 / P+1 退让）+ 就绪探测；(4) 成功后清零健康
失败计数（一次就绪 = 清零，02 §2.4）；(5) 每次重启（含成功）计入 restart 背压窗口（与 02 §3.6 一致——
窗口内重启次数 ≥ M 即耗尽），`restart-exhausted` 语义不变；(6) applying 期间由 `canStartLocal` 门直接拒绝。
desktop 与 gateway 均经 control-plane 的 `PlaneHandle.restartLocal()`（§9.3）
共享同一原语（`RuntimeHostAdapter.restartHost()` 仅为 §9.1 草图口径）。HTTP
语义：`POST /chamber/runtime/restart` 返回 **202**（接受即返回，不阻塞等
ready——就绪窗口可达 90s），进度与结果经 `GET /chamber/runtime/status` 轮询
或 SSE 推送；installing/applying/pending/已有 restart 在途时 409。

**管理面 `/chamber/runtime`（gateway 自有 runtime 控制器，认证后，design 17
§4/§8.4 已登记）**：

| 路由 | 语义 |
|---|---|
| `GET /chamber/runtime/status` | 固定身份 `kind:'dsh-chamber-gateway-runtime'` + 实际生效版本/来源 tag（内建锚/用户选择/env）+ 状态机态 + pending + operation/restart + 失败记录（脱敏）+ restore/pre-rollback + 快照 + 安装进度 + 全分类磁盘统计 |
| `GET /chamber/runtime/versions` | registry metadata（简略 packument）+ 全部有效缓存版本；离线仍返回缓存，当前 builtin 只标 active、不误标 cached |
| `POST /chamber/runtime/select` | 绑定源/版本/tarball/SRI → 下载+SRI → pnpm `file:` install → prune → 冒烟 → 只读原子发布（异步 job，进度经 SSE/poll） |
| `POST /chamber/runtime/apply` | 置 pending（下次 gateway 重启应用） |
| `POST /chamber/runtime/rollback` | 手动回滚（pre-rollback 暂存 + 快照语义同 §3.7） |
| `POST /chamber/runtime/restore-builtin` | 写 `reset-builtin` intent 后执行与版本切换相同的数据安全事务：停机 → 快照 → 原子清指针 → 内建锚全量探针；失败切回旧指针并恢复快照，只有成功才删除 override/journal。snapshot-failed 恢复未改动来源，其余硬恢复阻塞保持 dsh 停机且管理面可轮询 |
| `POST /chamber/runtime/retry-apply` | 恢复被中断的指针切换（swap-attempted）或快照失败（snapshot-failed）：清标志 → 重跑启动事务 → 干净时拉起 dsh（desktop retry-apply 对齐） |
| `POST /chamber/runtime/retry-restore` | 从持久 journal 继续被中断的快照恢复（restore-half/restore-incomplete）：重跑启动事务续作 |
| `POST /chamber/runtime/restart` | 受控重启 gateway 托管的 dsh 进程（§3.6 项 8：刷新插件挂载；指针不动、无快照/探针；`syncFeatures` 随 ready 变化 detach/attach）；202 接受、结果经 status().restart（running/ok/failed）+ operationError 轮询，resolve ≠ success |
| `GET/PUT /chamber/runtime/registry` | registry 源设置（owner-only 0600；URL 白名单校验同 §6；仅文件真实缺失时回默认 npmjs；损坏/符号链接/硬链接隔离保留并响亮失败；原子写，激活/安装期间禁止换源） |

普通 `phase:'pending'` 是 core + route + 两套 UI 的一致终态门：除
`restore-builtin` 外，select/apply/rollback/retry/restart/registry mutation 全部拒绝
`409 runtime_pending`；snapshot-failed/swap-attempted/restore-half 等持久记录虽可能仍含
pending，但属于显式 recovery phase，只开放各自 retry 与 restore-builtin，不能被普通
pending 分支吞掉或被 select 清除。

状态机 × 可见动作 × 文案矩阵沿用 §3.6 M4 口径；`/chamber/` 浏览器页提供
完整 runtime 块（实际/内建/选择版本、select/apply/rollback/restore/retry/restart、
registry、进度、失败、restore/pre-rollback、快照与磁盘，规格同 §3.6）。Desktop
settings-bridge 对固定身份做精确校验并透传同一投影，不能把普通 dsh 响应误认成
Gateway runtime。**blocked 启动保持存活（2026-09 评审落地）**：启动事务返回
`swap-attempted`/`restore-half`/`restore-incomplete` 时 gateway **不**中止
启动——管理面保持可轮询、托管 dsh 停机，`status().startupBlockedReason`
投影原因，恢复面为 `retry-apply`/`retry-restore`（镜像 desktop
blocked-but-alive 语义）；元数据损坏（journal/current/override corrupt、
journal-mismatch）仍是 FATAL，拒启保护 DSH_HOME。**挂载点纪律（不随 ready
detach）**：runtime 面**不是** ready 门控的 feature host 一部分——feature
host（session index / approvals / notify / scheduler / git）在 dsh 离开 ready
时 detach，但 runtime 管理面管理的是 dsh
本身，**必须全程可轮询**（重启/applying 期间 UI 要靠它拿进度）。实现 = 挂在
gateway dispatch 面的自有 runtime 控制器（与 auth/dispatch 同级），dsh 派生
字段（如 `connectionState`）在停机窗口诚实降级为 `stopped/starting`，绝不
伪装。**restart 语义（§3.6 项 8）**：事务接口见上；指针不动、无快照/探针；
每次 spawn 前 chamber host 包 seed thunk 重新求值、dsh boot 重读插件清单 →
插件挂载刷新；`syncFeatures` 随 ready 过渡 detach/attach **dsh 派生** feature
面（runtime 控制器不 detach）。安全：全部认证后；
token/password 不进 runtime 日志；registry 配置损坏不得静默改用 npmjs（信任锚
只能由用户显式修复），离线版本列表仍保留所有通过树校验的缓存版本；install 子进程
env scrubbing + `NPM_CONFIG_USERCONFIG` 空文件 + 显式 `--registry`（§4 源钉死
原样适用）；registry 源切换即信任边界切换。**出网面**：仅 gateway 进程访问
npm registry（§6 已并入）；spawn 的 dsh 子进程与控制面保持零出网。gateway
的 Node 执行器走 `resolveNodeExecutable` 纯 node 分支——安装链路比 desktop 简单。
**向前兼容注记**：runtime mutation 是全权操作；若未来 gateway 引入 per-principal
角色，runtime 写路由必须 operator-scoped（当前 password/token 均为全权，无此问题）。

**desktop 对 gateway 服务器的投影（§3.6 A 已并入）**：settings-bridge 的
「dsh 运行时」段对 `gateway` server 经 `/api/i/gateway-<id>/chamber/runtime/*`
反代触达上述面（只读状态 + 远端动作），不接触 token（design 17 §7.2/§12 纪律）。

### 9.4 desktop 迁移（迁移期）

- desktop 的 runtime 家族改为 import/re-export 共享包（§9.1 清单），宿主适配器
  在 `main.ts` 装配（现有 `buildStartupDeps` 大部分直接由共享包提供，仅 §9.1
  差异注入保留在 desktop）；
- 行为等价证明：desktop 现有 runtime 测试全量回归；打包不变
  （`prune-runtime.mjs`、extraResources pnpm 副本、`resolveDshWorkspace`
  优先级维持 §3.5 契约）；dev 隔离（`.dev-user-data`）不变。

### 9.5 分期与验收（服务端化部分）

| 里程碑 | 内容 | 判定证据 |
|---|---|---|
| M5 共享核心 | §9.1 抽取 + fake host adapter 测试夹具 + desktop 适配装配 | 共享包测试经纯 Node fake adapter 全绿；desktop 绑定层回归全绿；共享包 typecheck/test |
| M6 gateway 接线 | §9.3 解析链 + 控制面接线（含 `restartLocal()` 事务接口）+ 启动事务（先无管理面，env/锚可切换） | lifecycle 测试（启动顺序/失败回滚/stop 回收/restart 与健康重启单飞行交错）；CLI 契约测试 |
| M7 管理面 | §9.3 `/chamber/runtime`（不随 ready detach 的 runtime 控制器）+ `/chamber/` 页面块 + §3.6 per-server 段（local/gateway/ssh 分支） | 路由权限测试（含 restart 202/poll、applying 409、dsh 停机窗口 status 可轮询）；settings-bridge 回归；**fake-registry acceptance 的 gateway 形态移植与 ssh `restart_service` 回归为剩余门禁（STATUS 登记）** |

验收门禁：自动化（共享包/gateway typecheck+test；desktop 全量回归；
`build:gateway` + pack/install smoke 含 pnpm 依赖；frozen lockfile；i18n）；
实机（服务端安装候选 → 重启 gateway → 探针 → 故障注入回退 → DSH_HOME 数据
恢复（Linux server 记录）；生产 TLS 反代下 `/chamber/runtime` SSE/poll 与认证
行为）；Windows 只读口径沿用。

### 9.6 打包与依赖决策（D2/D3）

- **D2 `packages/dsh-runtime` 发版形态**：作为 desktop/gateway 的 workspace
  依赖打入产物、不单独进 npm 发版集（推荐；若评审要求独立发版，需同步修订
  §7 版本集口径与 release.yml 断言）；
- **D3 lockfile 纪律**：新增 workspace 包与 pnpm 依赖后，按 AGENTS.md 用带
  vendor 树的现场重新生成 lockfile 并 frozen 验证（pnpm 11 prunes
  `vendor/harness-packages/@deepseek-ai/*` importer 记录的已知坑）；
- **D4 依赖偏差登记（实现时）**：gateway 新增运行时依赖 `pnpm@11.21.0`
  属于 AGENTS.md「不新增运行时依赖」纪律的显式偏差（与 design 11 引入
  electron-updater、design 18 桌面引入 pnpm 同性质），实现 PR 须同步在
  AGENTS.md 的 current set 登记。

### 9.7 安全不变量（单一权威 = design 17 §17 续号 S17–S20）

本设计的安全不变量**不在两处重复表述**（防双处漂移，04 §7.1 同款纪律）：
S17–S20 的权威表格在 `design/17-server-side-gateway.md` §17，本节只引用。
要点：无快照不切指针（S17）、探针全绿才宣布（S18）、runtime 凭据不进日志 +
0600/0700 + install 源钉死（S19）、不削弱 S12 且 `/chamber/runtime` 全认证
（S20）。restart 动作不引入新编号——它受既有 S4（诚实失败）与 02 §3.5 健康
状态机契约约束。

## 10. 关联文档

- `01-overview.md` §3 文档地图（本文档编号 18，2026-08 新增）；
- `docs/progress/STATUS.md`（design 18 条目）；
- `17-server-side-gateway.md`（gateway 宿主的启动顺序/路由/状态目录/不变量
  修订，§9 的 gateway 面）；
- 设计 11（应用本体更新——双通道并存见 §7；§8 版本集口径与 release.yml 对齐）；
  设计 15（settings「通用」段承载——运行时块已迁出，见 §3.6 修订）；设计 14
  （退出生命周期——install 子进程回收与退出路径的衔接，§4）；设计 02 §3.5/§3.6
  （健康/restart-exhausted——§3.4 回退分支的宿主）；设计 09 §3.5/§4（版本漂移
  容忍，纵深防御）；设计 13（远端插件管理——远端 dsh 版本仍无关）；设计 05 §5
  （「dsh 运行时」per-server 设置段注册）。
- 正交事项（非本设计范围，记录在案）：更新带宽差分优化（design 11 §6 遗留，
  electron-builder 差分/blockmap 重评估）——与运行时通道正交，可独立评估。
