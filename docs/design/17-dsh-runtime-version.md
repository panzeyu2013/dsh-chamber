# 17 · dsh 运行时版本管理（npm 拉取安装，2026-08 现行）

> **状态：现行实现；M0/M2/M4 done，M1/M3 partial。** M1 的开发树安装
> 与 hermetic fake-registry 验收已完成，macOS 打包态执行夹具已就绪，但本轮按
> 用户要求未生成或检查真实 `.app`；Windows 管理面保持只读。唯一权威的当前进度、
> 已执行验证与验收边界见 `docs/progress/STATUS.md`（design 17 条目）；本文只保留
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
  v0.1.3，M1 回填实测值）；本地 dsh 版本号已投影（`dsh-chamber:info.dshVersion`）
  但**全仓库零 UI 消费**。
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

`<userData>/dsh-runtime/`：

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
- **恢复内建**：删除 override（连带 pending）→ 回落内建链（§3.5）。dev/env
  覆盖下的语义见 §3.5/§3.6。

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
  `session-not-found`，只验证 wire 解码且不进入 CommandRuntime；session/workspace
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
记录 `{shellVersion, chosenVersion, resolvedVersion, pending, swapAttempted}`。

- **失效规则（覆盖 override 与 pending）**：启动时 `shellVersion ≠ 当前壳版本`
  → override 与 pending **一并失效**。**失效 = 标记失效（保留记录、版本树与快照）**
  而非删除——F4「自动恢复上一 override 树」依赖记录存活；「恢复内建」才是显式
  删除。
- **回落保护（F4）**：回落内建树后跑数据可读性探测——用户曾用较新运行时并迁移
  过数据、内建 pin（默认 0.1.1-rc.2，不随壳移动）可能读不了新格式数据；探测失败
  → **自动恢复上一 override 树（受保护类，仍在）+ 响亮提示**。「单调向前」**仅对
  壳版本成立**（§7）。
- **失效的用户可见记录（R3-3 UX-P1-F1）**：壳更新导致运行时选择失效时，settings
  记录一行「因应用更新，dsh 运行时已回落内建 vX（原选择 vY 保留，可重新选用）」——
  用户的运行时选择**绝不无声消失**。
- **pending 清除与重放**：pending 清除与探针裁决**同一次原子写**（override.json
  单一事务）；重放幂等——当前指针版本 == pending 版本 → 跳过切换直接探针；快照
  记录 pre-swap 时间戳。
- **恢复内建在 dev/env**：`DSH_CHAMBER_DSH_PATH` 优先于 override → UI 对 env 来源
  显示标记「(env)」；恢复内建 = 删除 override 回落现有 fallback 链。
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
- **applying 相位门控（R3-3 UX-P1-F2）**：applying（快照分钟级）期间，connections
  本地卡片「启动」按钮与任何实例 spawn 入口**门控禁用**（状态行「应用 dsh vY…」），
  杜绝与「未决切换前绝不 spawn」竞态。
- **快照失败的中止态（R3-3 UX-P1-F4）**：快照失败 → 中止本次 + **置「快照失败」
  标记（settings 可见 + [重试应用] / [恢复内建] 动作），不再自动每启重试**——
  磁盘持续不足时用户有明确出口，不反复延迟 spawn。
- settings「通用」段「更新」控制组扩展：应用更新块（现状 `UpdateSection`）+
  **dsh 运行时块**——当前版本行（内建 vA / 用户选择 vB / env 标记）+ 版本选择器
  （registry 版本列表，默认推荐 `dist-tags.latest`，当前版本置顶，兼容基线以下
  版本带提示，**离线时含缓存版本**——自由回滚的 UI 基础）+ 动作（更新到 vY /
  回滚到 vZ / 恢复内建）+ 失败记录行（失败原因 + 建议）+ 数据快照状态行。
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

**前端显示规格（2026-08 用户拍板：registry 源用户自设 + 双版本区分显示）**——两块
显示面，单一口径（「内建 vA」= resourcesPath manifest；「激活 vX」= resolve 结果；
「最新 vY」= registry metadata；「版本源」= chamber-settings.json，非秘密）：

**A. settings「通用」段「更新」控制组 →「dsh 运行时」块**（延续设计 15 平铺控制组）：

1. **版本概览行（双版本，呼应「运行期拉 + 打包内建」）**：
   - 主行「dsh 运行时 v0.1.2（激活）」+ 来源 tag：`[内建]` / `[用户选择]` / `[env]`；
   - 副行（仅当激活 ≠ 内建）「随应用内建 v0.1.1-rc.2」；
   - env 来源时 tag 显 `(env)`，选择器与动作禁用，提示「由 DSH_CHAMBER_DSH_PATH 指定」。
2. **版本选择器**（下拉）：置顶当前版本（「当前」）→ `dist-tags.latest`（「推荐」）→
   其余 registry 版本降序 → 离线时追加缓存版本（「已缓存」）；兼容基线以下版本加
   「可能无法 boot」警示。
3. **动作**（依状态切换）：`[更新到 vY]`（较新）/ `[回滚到 vZ]`（较旧）/
   `[恢复内建]`（清 override 含 pending）；pending/applying 期间除 `[恢复内建]` 外
   禁用；选当前版本 = 无操作。
4. **版本源设置行**（registry 源用户自设）：下拉 `npmjs（默认）` / `npmmirror` /
   `自定义…`；自定义走 §6 URL 白名单校验（origin 精确、拒绝 userinfo、decode
   归一化）；附 `[测试连通]`（主进程 spawn 一条 metadata 请求，回显「连通/超时/失败」）；
   小字说明「安装与版本检查均来自所选源，切换源即切换信任边界」。
5. **状态/进度行**（上下文驱动）：idle「已是最新版本 / 有可用更新 vY」；checking
   「检查更新中…」；installing「安装 dsh vY…」；pending「将于下次启动切换到 vY」；
   applying「应用 dsh vY…」；applied「已更新到 vY」；rollback/failed「错误文案（脱敏）」。
6. **失败记录行**（仅失败时）：「vY 安装失败：<原因> — 建议升级 dsh-chamber / 重试」。
7. **数据快照状态行**：「数据快照 N 份（最近 <时间>）」；快照失败态「快照失败：<原因>
   [重试应用] [恢复内建]」。

**B. connections 本地实例卡片**：加一行/chip「dsh v0.1.2」，读同一 resolve 结果，
与 settings 块同源一致（M0 接线）。

**页面结构与样式设计（对齐设计 15 平铺控制组 + 官方 settings-panel 设计语言）**：

**页面结构（组件树）**：

- settings 壳：`GeneralView`（`__general` 视图）内、`UpdateSection` 之后新增
  `DshRuntimeSection`（chamber-global，不占 child ctx、不依赖选中服务器，与
  `UpdateSection` 平级、同为「更新」控制组扩展）。
- `DshRuntimeSection` 内部行序（自上而下，与上列显示规格一一对应）：
  ```
  .runtimeSection（复用 .updateSection 词汇：列向 gap 8px）
    h3.generalGroupTitle             「dsh 运行时」（复用组标题词汇）
    .runtimeVersionRow               版本概览（主行 + 来源 tag + 内建副行）
    .runtimeFieldRow                 版本选择器（field label + select）
    .runtimeFieldRow                 版本源（field label + select + [测试连通]）
    .runtimeActionsRow               动作按钮组（更新 / 回滚 / 恢复内建）
    .runtimeStatus                   状态/进度行（aria-live="polite"）
    .runtimeFailureRow               失败记录（仅失败时，role="alert"）
    .runtimeSnapshotRow              快照状态行
  ```
- connections 壳：`ConnectionsSection` 的本地卡 `.localCard` → `.localMeta` 追加
  一个版本 chip（`.mono` 字体），与端口 / label 同一行内联，不新增独立卡片区。

**样式设计（全部走 `--dsw-alias-*` token，复用既有 class 词汇）**：

- 容器 `.runtimeSection`：复用 `.updateSection`（列向 / gap 8px）；组标题复用
  `.generalGroupTitle`（12px / 600 / letter-spacing .06em / uppercase /
  `--dsw-alias-label-tertiary`）。
- 版本概览行 `.runtimeVersionRow`：复用 `.updateVersionRow`（flex / space-between /
  align-center / gap 10px）；主行 `.runtimeVersionLabel` 13px / primary；来源 tag
  `.sourceTag` 用 `.badge` 词汇（border-radius 999px / padding 1px 8px / 11px /
  border l2 / tertiary）；内建副行 `.runtimeBundledRow` 12px / tertiary（= `.generalHint`）。
- 字段行 `.runtimeFieldRow`：复用 `.generalRow`（列向 gap 6px，field label
  `.generalFieldLabel` 14px / 500）；下拉 `.runtimeSelect` 用 `.dropdownTrigger`
  词汇（border l2 / radius 10px / bg layer-3 / 13px，focus 时 border brand）。
- 动作按钮：主按钮「更新到 vY」复用 `.updatePrimaryButton`（dense capsule 28px /
  radius 14px / `--dsw-alias-button-primary-fill` / label-primary-foreground）；
  次按钮「回滚到 vZ」「恢复内建」复用 `.updateButton`（透明 + border l2 / radius
  14px）；禁用态 opacity .4。
- 状态/进度行 `.runtimeStatus`：block（aria-live，Chromium 不暴露 display:contents）；
  `.runtimeStatusText` 13px / primary；失败行 `.runtimeFailureRow` 12px /
  `--dsw-alias-state-error-primary`（= `.generalError`）；快照行 `.runtimeSnapshotRow`
  12px / tertiary。
- connections 本地卡版本 chip `.localVersion`：`.mono` 字体 / 12px /
  `--dsw-alias-label-secondary`，插入 `.localMeta` 行尾。
- 空/占位纪律：桥未水合时控件 disabled + 占位值，**绝不假「off」/ 假「已是最新」**
  （与 GeneralView / UpdateSection 同款 honest-signal 纪律）。
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
  版本不成立，诚实声明）；简略 packument 无 hasInstallScript（实测），白名单覆盖
  校验以捆绑基线 lockfile 为准（M2 测试）。
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
[恢复内建版本] → 删除 override（连带 pending），回落内建链（§3.5 回落保护）
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
  既有 `desktop_npm_search`（main.ts:1171-1199）并入同一口径 + 行为保持测试
  （R3-5 P2-6）。
- **错误脱敏**：`sanitizeErrorText`（updater.ts:109-113）提取为共享模块并导出，
  评估相对路径覆盖。
- **出网面**：仅主进程访问 npm registry；控制面零出网、loopback 闭环不变。
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
  安装捆绑的 dsh（随应用更新移动）；**用户选择** = override 记录（`<userData>`，
  非秘密，不进 `ssh-instances.json`/registry）。
- **「单调向前」仅对壳版本成立**：应用整包更新后回落内建（新壳重基代）；运行时
  版本失效（用户选择）非单调向前——用户可显式选更旧版本，失效回落带数据可读性
  探测保护（§3.5）。
- **chamber 发版版本集（口径修正）**：7 个发版包（根/desktop/control-plane/
  renderer/cli/dsh-host-client-graph/**dsh-chamber-host-git-worktree**，以
  release.yml 断言集为唯一权威）；客户端插件包 5 个（sidebar/connections/
  settings-bridge/layout/git）不参与发版版本集。**运行时版本（npm 用户可选）不在
  该集合内**——与 chamber 发版正交，release.yml 断言不受影响。
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

## 9. 关联文档

- `01-overview.md` §3 文档地图（本文档编号 17，2026-08 新增）；
- `docs/progress/STATUS.md`（design 17 条目）；
- 设计 11（应用本体更新——双通道并存见 §7；§8 版本集口径与 release.yml 对齐）；
  设计 15（settings「通用」段承载）；设计 14（退出生命周期——install 子进程回收
  与退出路径的衔接，§4）；设计 02 §3.5/§3.6（健康/restart-exhausted——§3.4 回退
  分支的宿主）；设计 09 §3.5/§4（版本漂移容忍，纵深防御）；设计 13（远端插件
  管理——远端 dsh 版本仍无关）。
- 正交事项（非本设计范围，记录在案）：更新带宽差分优化（design 11 §6 遗留，
  electron-builder 差分/blockmap 重评估）——与运行时通道正交，可独立评估。
