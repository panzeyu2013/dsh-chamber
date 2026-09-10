# 上游触点登记与保鲜（upstream touchpoints）

> 面向维护者：登记 dsh-chamber 对上游 dsh（deepseek-harness）的**全部接触面**——fork 副本逐文件
> 纯度、深引 vendor 内部、契约镜像、covered/assembly 行、生成物——并给出每次升级 tag 后的保鲜闭环。
> 机器侧门 = `scripts/dev/verify-upstream-touchpoints.mjs`（C1–C10；CI 两条腿在 Bootstrap 后 pre-install 跑
> `--no-artifact-rebuild`（C1/C3–C10，C8 advisory）、post-install 跑完整门（C8 重建-比对硬失败）；C2 本地 advisory）；
> 本文件与脚本内的登记表**同源**，改动时两侧同步。
> 基准：本表以 **dsh-v0.1.5-rc.1（183f08e9c6dd，harness.commit）** 与 fork 版本标记
> 0.1.5-rc.1 为锚（C5 校验）；每次重锚后本表随维护循环刷新（§0 基线速查同步）。

## 0. 基线速查

| 项 | 当前值 |
|---|---|
| 源码线 pin（harness.commit == submodule gitlink） | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`（dsh-v0.1.5-rc.1） |
| 运行时线锚（npm `@deepseek-ai/dsh`） | 0.1.5-rc.1（bundle-dsh 兜底 / desktop vendor 锁文件 / release.yml env / install-gateway.sh / gateway `dshAnchorVersion` / release-preflight `FORK_VERSION`） |
| fork 版本标记 ×3 | 0.1.5-rc.1（connection / client-web / api-gateway） |
| vendor 链接数 | 284（ensure-harness-vendor 断言 == 锁文件 importer 集合） |
| typert remote 装配契约 | 15（C4；+command-feedback/+workspace-files） |
| covered / factory | **57 / 26**（live 计数；factory ⊆ covered，chamber-entry 锁步断言；+`ui-dockkit`、+`client-file-upload` covered factory，四轮再 +`session-log-export`（deferred）与两个 page-own 跳过 id） |
| 种子域 | `clientGraph/graph`、`gitWorktree/previewCreate`、`archiveCleanup/probe`（C7 双门） |

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

## 2. fork-mirror 登记（逐 fork）

### 2.1 `packages/dsh-client-connection`（上游 `packages/client/connection`）

pure **16**：`src/http-bridge.ts`、`src/rpc.ts`、`src/rpc-host.ts`、`src/rpc-schema.ts`、
`src/loopback-hostname.ts`、`src/index.ts`、`src/recovery-config.ts`、`src/browser-auth.ts`、
`src/client/api.ts`、`src/client/fixture.ts`、`src/client/random-uuid.ts`、`README.md`、
`README.zh.md`、`README.i18n.yaml`（+client 构面未列出的小项以脚本计数为准）。
`src/browser-auth.ts` 于 Batch 2 恢复逐字节一致（303 重定向 no-referrer 的说明移入
design 05 / STATUS）。

| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-add] | 仅追加 chamber test 脚本；其余与上游一致 |
| `src/api-path.ts` | [patch-mod] | 追加 `resolveInstanceBasePath` + 头部 chamber 说明（basePath 语义，design 05 §6） |
| `src/client/connection.ts` | [patch-mod] | **仅** erasableSyntaxOnly 显式字段改写（两个构造参数属性）+ 顶部 chamber 说明；其余逐字节上游（Batch 2 重锚：loopEpoch 代际守卫与 `CONNECTION_BACKOFF_MAX_MS` 导出退役，活性触发改用原生 `reconnect()`/`setNetworkAvailable()`） |
| `src/client/index.ts` | [patch-mod] | `apply(ctx)` 读 `ctx.chamberBasePath` → 载波装配 + `SYSTEM_RESUME_EVENT`/liveness 触发（design 14 D4）+ recovery-policy 转出 + 头部 chamber 说明 |
| `src/client/rpc.ts` | [patch-mod] | basePath 前缀拼装 + `WebConnectionRpcOptions`（chamber 选项对象）+ 头部 chamber 说明 |
| `tsconfig.client.json` / `tsconfig.host.json` | [patch-mod] | chamber 构面（extends/rootDir/vendor paths）；`files` 列表与上游增量同步维护（脚本按 patched 登记） |
| `src/client/carrier-assembly.ts`、`src/client/liveness-triggers.ts`、`src/client/recovery-policy.ts` | [own] | chamber 自有（载波装配策略 / sleep-wake 活性触发：原生 reconnect + 离线门 + 唤醒事件旁路 / 每来源恢复时序策略：远端 45s·5s，本地默认） |
| `tsconfig.check-base/client/host.json` | [own] | chamber erasable-only 校验构面 |
| `test/` | [own] | chamber 自有测试 + fixtures（含 schemastery/fixture/recovery-config 桩 loader） |
| `tsdown.config.ts`、上游 `tests/` | [dropped] | chamber 无 tsdown/镜像上游测试 |

### 2.2 `packages/dsh-client-web`（上游 `packages/client/web`）

pure **5**：`src/base.css`（Batch 2 恢复逐字节一致——chamber token 表改由 renderer 入口
CSS `packages/renderer/src/styles.css` 引入）+ client 构面未列出的小项（以脚本计数为准）。

| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | 描述/测试脚本/deps·peerDeps·files 面差异；版本行随上游 |
| `README.md` / `README.zh.md` / `README.i18n.yaml` | [own-divergent] | chamber 说明（N-ctx boot kernel），非上游镜像（脚本同在 patched 桶，标签一致） |
| `src/boot.ts` | [patch-mod] | rc.8 N-ctx boot kernel（extraRows / `__ModuleLoader__` / configureContext / 异步 dispose） |
| `src/index.ts` | [patch-mod] | 入口差异（module-system 宿主接线） |
| `src/platform.ts` | [patch-mod] | PLATFORM_MODULES / 静态表 chamber 接线（C3 偏差：ui-primitives 不 seed） |
| `src/seed.ts` | [patch-mod] | seed 行 chamber 接线（extraRows / `__ModuleLoader__`；C3 偏差同步） |
| `tsconfig.json` | [patch-mod] | chamber 构面（脚本按 patched 登记） |
| `src/boot-rows.ts`、`src/boot-tolerance.ts` | [own] | chamber 自有（每实例 boot-rows / boot 容忍恢复） |
| `test/` | [own] | chamber 自有测试 + fixtures |
| `tsdown.config.ts`、上游 `tests/` | [dropped] | 同上 |

### 2.3 `packages/dsh-api-gateway`（上游 `packages/api/gateway`，client 半）

pure **6**（以脚本计数为准）。

| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | description/peer 集裁剪（host 依赖 dropped）；版本行随上游 |
| `src/client/index.ts` | [patch-mod] | `apply(ctx)` 读 `ctx.chamberBasePath` → `/api/remote.mux` 落到实例前缀 + `start(sinks, recoveryOverridesForTransport(transport))`（design 05 §6） |
| `src/client/stream-client.ts` | [patch-mod] | per-entry basePath（流载波 URL 拼装） |
| `tsconfig.json` / `tsconfig.client.json` | [own-divergent] | chamber 构面 |
| `tsconfig.check-base/client.json` | [own] | chamber erasable-only 校验构面 |
| `test/` | [own] | chamber 自有测试（若有） |
| `README.*`、`src/index.ts`、`src/stream-server.ts`、`src/types.ts`、`tsconfig.host.json` | [dropped] | host 半与上游文档不镜像（exports 保留 inert `./types` 子路径） |
| `tsdown.config.ts`、上游 `tests/` | [dropped] | 同上 |

### 2.4 有意未镜像表（跨 fork 汇总）

host 插件入口/半、上游 `tests/`、`tsdown.config.ts`、上游 README（api-gateway）、构建产物
`lib/`。每次 delta 日志（升级重放时追记）：
- dsh-v0.1.3-alpha.1：connection 流式 body 路由/fixture session-format v2 重放；api-gateway
  journal-stream 无游标 notification 帧；web 版本行。
- dsh-v0.1.3-alpha.2：connection recovery-config 抽取重放（本表 §2.1）；api-gateway/web 版本行。
- dsh-v0.1.5-alpha.2（b2e3b2a01258，**已升级**）：connection 纯文件重放（README×3 +
  `src/client/fixture.ts` + `src/index.ts` 宿主半 webServer 可选注入，实测 fork-pure）、
  client-web 版本行 + `ui-dockkit` 偏差注释（走 covered factory，不 seed；上游
  `tsconfig.json` 的 `../ui-dockkit` reference 有意不镜像——chamber 构面用 paths，无
  references）、api-gateway 版本行；客户端外壳两代槽位模型重放见 `CHANGELOG.md`
  发布节与 design 05 §2 / design 06 的槽位模型契约。
- dsh-v0.1.5-rc.1（183f08e9c6dd，**已升级**）：三个 fork 副本**仅版本行**——上游
  counterpart 的 `src/` 零改动（connection 连 README/宿主半都未动，client-web 的
  `platform.ts`/`seed.ts`/`boot.ts` 未动，api-gateway 仅版本行），实测 preflight
  pure 0 / 需重放 3（即三个 `package.json`）/ dropped 0。上游 workspace 成员集合不变
  （vendor 链接仍 **284**：三个同名 fork 与 `website`/`examples`/`python` 三个根一律不镜像，
  同时含上游 `vendor/*` 根的 cordis 家族 9 个成员）、**无新增 client 行、`dsh.client` 元数据零变化**（官方 client
  行 **57** 条，两侧集合与元数据逐字相同：47 条由 composite covered、10 条走 extra row）、vendor 补丁集 7 文件 / 21 锚点零漂移、深引 seam
  （`ui-layout`/`ui-renderer`）仅 `package.json` 版本行。唯一非版本 manifest 变更 =
  `dsh-llm-deepseek` 新增 `@deepseek-ai/dsh-attachment-local`（host 半依赖，chamber
  构建面不消费；其锁文件 importer 记录由 `update-vendor` 重生成时带上，见
  `dsh-upgrade-checklist.md` §4）。上游实质源码改动（23 文件）全部落在不被 chamber
  构建面接管的面上：`ui-sidebar-{files,right,documentpreview}` 三行的 guide/preview
  精修（extra row，由实例侧 bundle 提供；含 `definition.ts`→`.tsx` 包内改名）、
  `ui-chat` StatsPills 的条件统计行、`ui-primitives` `CodeBlock` 新增
  `contentRef` + `[data-code-block-content]` 包装、`ui-dockkit` 两条 `z-index`、
  `cordis-client-runner` 的 slot-catalog 文档指针；base bundle 默认模型
  `deepseek-v4-flash` → **`deepseek-flash`**（见 CHANGELOG 发布节）。新登记：
  `SidebarRightGuideEntry.description?`（可选，纯增量）、`sidebar.right.tab.document`
  槽 props 新增**必填** `scrollportRef`（chamber 未实现该槽渲染器）。
- **平台词 `ui-primitives` 的跨代耦合（rc.1 新增，登记于 STATUS）**：实例侧
  `ui-sidebar-documentpreview` 的代码预览现在**行为上依赖**与 composite 同代的
  `ui-primitives`（`CodeBlock` 的 `contentRef` 经 `[data-code-block-content]` 成为其
  唯一滚动/行定位锚点）。composite 比实例旧一代时，该行失去独立滚动区、代码行
  定位失效（纯文本仍可用）——即 C3「不 seed ui-primitives、由 covered factory 回答」
  这一偏差在版本歪斜下从「体积优化」升级为「可见功能面」。
- **契约镜像补充（alpha.2 新增，2026-09 复核）**：composite 首屏 `ui-chat` 的 cordis
  inject 新增 `sidebarRight`（由 host-graph extra row `ui-sidebar-right` 提供）与
  `resources`（`client-resources` 行）——chamber-entry 新增
  `assertRequiredExtraRowServices` 有界探针（纯判定在 `src/required-extra-rows.ts`，
  定时器挂 ctx 生命周期）。该「首屏依赖 extra row 服务」耦合是本表 §4 之外的**新触点类别**：
  上游新增 client 行若被复合首屏 inject，需同步登记并在探针集合里加名。
  **后续收敛（勿按本条误读现状）**：`fileUpload` 于三轮转为 covered、`resources`
  于四轮以「非 inject 座、与 sidebarRight 同源」删除——探针集合现为
  `['sidebarRight']` 一条（权威在 `required-extra-rows.ts` 头注）；rc.1 该集合不变。
- **历史动向记录（2026-09 只读调研，当时 pin 仍 82a5fd61a7cf）**：上游 tag
  `dsh-v0.1.5-alpha.1`（5dda764e）。三个 fork 的**客户端恢复模型零改动**
  （`connection/src/client/{connection,index}.ts` 未变；变的是 fixture、宿主半
  `src/index.ts` 的 `webServer` 可选注入重构、README/版本行）；`client/web` 新增平台词
  `@deepseek-ai/dsh-client-ui-dockkit`（+ 保留 ui-primitives）。**升级时注意**：
  dockkit 是「平台词还是 host-graph 行」必须先裁决（seed 词 = 行 ⇒ 启动失败，本仓
  的 C3 不变量），宿主半的 `webServer` 可选注入会影响 connection 宿主半的重放。

## 3. deep-import 与 roster 登记

- renderer 深引 vendor：`@deepseek-ai/*` 一律经 vite workspace→src 别名与 `paths`；node 测试经
  桩 loader（`scripts/dev/test-connection-loader.mjs` 等）——不新增裸运行时 vendor 依赖。
- covered/factory：`packages/renderer/src/chamber-covered.ts`（CHAMBER_COVERED_IDS /
  CHAMBER_COVERED_FACTORY_IDS）；chamber-entry 执行期断言 map==列表；新增官方 client 行须
  登记 covered（precedent：ui-open-in-app 行随 a2 登记）。删包 fail-loud 哨兵在 verify 脚本 C4。
- typert remote 装配：`vendor/…/dsh-api-remotes/src/client/index.ts` 契约 == **15**（集合与顺序；gen-typert-remotes
  与 C4 双向断言）；上游新增 remote 包 = 先裁决（是否 chamber 消费/镜像）再登记。
- **版本锚与「活」版本字面量（2026-09 四轮登记，门 = C10）**：dsh 运行时版本的**单一来源**
  是**已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`（`bundle:dsh` 生成；同目录的
  `package.json` 被 gitignore，fresh checkout 不存在，仅本地存在时与锁文件交叉校验）；六个运行时
  线锚（`bundle-dsh.mjs` 兜底、`vendor/dsh` 锁文件、`release.yml` env、`install-gateway.sh`、
  gateway `dshAnchorVersion`、`release-preflight` `FORK_VERSION`）与三个 fork 副本的版本必须等于它。
  生产源码/脚本/配置（非注释、非测试夹具、非产物）里**不得**再出现其他 dsh 版本字面量：历史
  叙述只允许留在注释里；确有语义的具名常量（如 `HOST_IDENTITY_METHOD_SINCE`「身份探针自哪一代
  起注册」与其跨包镜像）按「上限 1 处 + 理由」登记在 C10 白名单。测试夹具里的合成版本视为
  fixture，不在扫描面内（`*/test/**`、`*.test.ts|mjs`）。**本地派生状态**同样不在扫描面内：
  判定来源是 `.gitignore` 本身（门用 `git ls-files --others --ignored --exclude-standard --directory`
  取该集合，git 缺席时退回脚本内同名静态清单），因为「fresh checkout 不存在」与「被忽略」是同一件事，
  而只有 `.gitignore` 是其单一来源——当初的四个具名条目（`packages/desktop/release/` 打包产物、
  `packages/desktop/.dev-user-data/` dev 应用数据、`packages/gateway/host-packages/`、
  `packages/renderer/.cache/`）正是促成该规则的路径。**唯一的例外**是被忽略却**故意要扫**的
  `packages/desktop/vendor/dsh/package.json`（bundle 清单交叉校验，见上），所以文件级跳过只作用于
  常规分支，不越过该特例——2026-09 本地重放发现这些目录内残留的旧代际字面量会让**干净工作区**误红
  （232 处、全为 0.1.1-rc.2、tracked 文件零命中），CI 因无这些目录而不受影响。
- **vendor 源码补丁集（构建期改写，2026-09 三轮登记，design 09 §3.6）**：
  `packages/renderer/scripts/vendor-patches.mjs` 登记「同源绝对 URL」类硬假设的补丁，
  由 renderer 的 `deepseekSource().transform` 在构建期按**精确上游文本**改写，
  vendor 文件零写入。当前 **7 条（7 文件 / 21 处锚点）**：① `ui-chat`
  （`/api/file`，读 chamber layout fork 提供的 root 标准 prop `chamberFileApiBase`
  = `ctx.chamberBasePath`）；② `client-file-upload`（`/api/session/uploadFileBinary`，
  从服务自身的 ctx 读 `chamberBasePath`——该包已转为 **covered**，否则 extra-row
  bundle 不经过我们的构建）；③④ `ui-deliverables`（`/api/present.host|open`，
  控制器构造时接收 base path）；⑤⑥ `session-log-export`（`/api/session.export`，控制器字段，
  该包已转 covered-deferred）。全部保留「缺 base path → 回落上游」的形状，读取一律走
  `ctx.get('chamberBasePath')`（cordis 代理对未 provide 的服务是抛错而非 undefined）。
  门：**C9**（锚点必须唯一命中，漂移即硬失败）+ `scripts/vendor-patches.test.mjs`
  （锚点/行为/id 形态）。新增补丁前先问「能否在 chamber 自己的包里修」。
- **复合首屏 ← 未覆盖官方行（反向依赖，2026-09 二轮登记；三轮收敛为 1 条）**：
  `ui-chat` ← `sidebarRight`（`ui-sidebar-right` 行提供）。二轮曾把 `fileUpload`
  （`ui-conversation`/`api-session-controller` 根 inject）与 `resources`（渲染期
  `useResource` 座，非 inject）列入；三轮把 `client-file-upload` **改为 covered**
  （既消除 extra row 依赖，也让构建期补丁能覆盖它的同源绝对 URL）并删掉 `resources`
  这一条不成立的理由。登记点 = `packages/renderer/src/required-extra-rows.ts` 的
  `REQUIRED_EXTRA_ROW_SERVICES` + `required-extra-rows.test.ts`；上游新增/改名首屏
  inject 成员时，先在此清单与 `host-graph.ts` 降级注释同步（design 09 §3.2）。
- `remotePackagesFromAssembly`（renderer/scripts/typert-remote-contract.mjs）为装配契约唯一入口。

## 4. contract-mirror 登记（按上游属主分组）

| 上游属主 | chamber 契约镜像点 | 保鲜 |
|---|---|---|
| dsh-api-remotes（client） | typert remote 装配（15）/ message-feedback、session-reference、subagent 等 wire 面 | gen-typert-remotes + C4 |
| dsh-api-session-controller | api-gateway fork journal-stream 帧（无游标 notification） | fork 重放 + 升级复验 |
| client/connection（recovery） | recovery-config 共享 schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` 10_000 == schema 默认 backoffMaxMs） | liveness-triggers 钉值 + C1 |
| dsh-runtime（激活探针域） | `HOST_DOMAIN_PROBE_NAMES` ↔ gateway `HOST_PACKAGE_PROBE_DOMAINS` | C7 + gateway 运行时 fail-loud |
| interaction/commands（`commands/execute` 第三参数） | 激活探针载荷的键名 == 上游 `execute(agent, line, submittedAttachments, signal)` 的参数名（`images` ≤0.1.2；**自 0.1.3-alpha.1 起各代皆为 `submittedAttachments`**，`attachments` 从不是上游线名） | `runtime-probes.test.ts`：读 vendor 签名逐字比对 + 夹具按真实 typert gateway 校验参数键集（**2026-09 实机：0.1.3-alpha.1 升级时写错的 `attachments` 使每条激活探针失败、每次首装本地实例被隔离，直至验收轮才发现**） |
| dsh-host-webserver（index-inject） | `__DSH_CONNECTION_RECOVERY__` 全局注入（connection host 半） | fork C1（src/index.ts pure） |
| dsh-host-open-in-app（官方 open-in 宿主路由） | chamber open-in 插件本地镜像 `shared/open-in-app-protocol.ts`（三条路由 + 载荷形状）与 `locales.ts` 的 `app.*` 标签表。**为何不直接 import 官方 `./shared`（2026-09 三轮裁决）**：该 export 指向 `lib/types/shared.js`，源码态 vendor 只有 `src/`，本仓 tsconfig 又排除 `vendor/**` ⇒ 镜像 + 字节级锁步是可行等价物 | open-in 插件 `test/open-in-app-protocol.test.ts`（读 vendor `shared.ts`/`OpenInAppAction.tsx` 逐字比对） |

## 5. 再生物登记

| 再生物 | 源 | 提交纪律 |
|---|---|---|
| renderer typert 工件（gen-typert-remotes 输出） | vendor typert/remote 源码 | **构建期生成、`.gitignore` 忽略，不提交**（`renderer/src/generated/`；升级后由 `build:renderer` 重生成） |
| host dist ×3（`dist/index.js`）+ `dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/index.js`/`lib/client.js`(+map) | chamber host 包 src / dsh-runtime src / mobile src | `build:host-packages` / `build:dsh-runtime` / mobile `build` 后提交（C8 共 5 组）。C8 **重建-比对硬失败**盯陈旧（mobile 产物由 gateway 逐字节 seed，陈旧即线上锚点失效）；两个 build 脚本都带 `absWorkingDir`，产物与调用者 CWD 无关 |
| boot manifest / perf-sizes | build:renderer | 构建产物 diff 随批审查 |
| schemastery 桩 loader（connection/web 测试） | vendor source-only 现实 | 新增 vendor 运行时导入面时同步补桩 |

## 6. 保鲜自动化

`node scripts/dev/verify-upstream-touchpoints.mjs`（除 C8 在**正常路径**下「重建-比对后原样还原」外只读；中断/并发/额外产物路径由整目录快照 + SIGINT/SIGTERM 处理器 + `wx` 独占锁兜底，exit-code 语义）：
- C1 pure 字节恒等 / C3 完整性（fork 每文件分类、上游每文件裁决，漏 = 硬失败）/
  C5 过期锚扫描 / C6 EXCLUDED 存在性 —— **CI 在 Bootstrap 后 fail-loud**；
- C4 roster（covered/factory 哨兵 + remote 契约 15 的集合与顺序）—— 本地/CI 均可；
- C7 种子域锁步、C8 **提交态生成物 == src**（重建-比对，硬失败；写后原样还原，`--no-artifact-rebuild` 退回 mtime advisory）、C9 **vendor 补丁锚唯一命中**（硬失败）、C10 **版本锚一致性 + 活版本字面量白名单**（硬失败：运行时版本单一来源 = **已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`，见 §3；同目录 `package.json` 被 gitignore、属派生本地状态，仅本地存在时与锁文件交叉校验；六锚 + 3 fork 必须等于该锁文件；生产源码/脚本/配置里出现未登记的「活」版本字面量即红——历史叙述只能留在注释里，具名诊断常量按上限 1 处白名单登记）—— CI 与本地均跑（CI 分 pre/post-install 两段）。
- C2 `--tags <old> <new>`：tag 间三 fork 面重放报告（advisory），升级前先跑。
- `scripts/dev/preflight-vendor-pin.mjs <tag>`（只读，§7 第 0 步）：C2 的**超集**——
  额外报深引 vendor seam 文件、上游包集合增删、新增 client 行、运行时 npm 状态；
  纯函数单测随 `pnpm run test:upgrade-tools` 在 CI 跑。
- update-vendor.mjs 完成输出提示运行本脚本；不进 preinstall。

## 7. 每 tag 维护循环（预检 + 8 步）

> **顺序硬约束（2026-09 三轮 W5 实测）**：`pnpm install` 必须在
> `ensure-harness-vendor.mjs`（或根 `preinstall`）**之后**——先 install 再 bootstrap
> 会以 0 退出但只装 20/304 个 workspace 项目（vendor 成员的依赖缺失），随后
> `build:renderer` 才以 `Rollup failed to resolve import "lexical"` 报错。CI 的
> linux/win 两条腿都已是 `Bootstrap → install`。

0. 预检（动 pin **之前**）：`node scripts/dev/preflight-vendor-pin.mjs <tag> --offline`
   —— 一次给出「fork pure/replay/dropped + 深引 vendor seam 文件 + 上游包增删 +
   新增 client 行 + 运行时 npm 状态」；`--fail-on-replay` 可当硬门。
   （工具与 C2 的分工：C2 只报 fork 面，本脚本额外覆盖 seam 与 roster 面；
   2026-09 加，0.1.5 的 layout 阻塞点即由此显式暴露。）
1. 登记：STATUS/本表加「追踪 <tag>」行，读 C2 报告；
2. `node scripts/dev/update-vendor.mjs <tag>`（原子升级 + 锁文件重生成）；
3. C2 触点报告（`--tags old new`）→ 逐文件裁决：重放 [pure]/[patch-*] 或改登记；
4. fork 重放 + 版本标记同步（三副本 → 新版本）；
5. roster pass：covered/factory 存在性、typert 契约、新增官方行裁决；
6. 契约复验：contract-mirror 表逐行（§4）+ 相关测试；
7. 运行时线单独提交（bundle-dsh 刷新 + 四锚 + bin.js 冒烟）；
8. 文档回写：CHANGELOG/STATUS/本表 §0 基线速查刷新 + i18n 重录。

## 8. PR 评审清单条目

改动含下列任一项 ⇒ **必须登记/刷新本表与 verify 脚本**（PR 模板已含自检项）：
- 新增 `@deepseek-ai/*` 深导入或裸 vendor 运行时导入面（→ §3/§5）；
- 修改 fork 副本文件（pure 面改动会被 C1 拦；[patch-*] 须同批更新登记原因）；
- 镜像新上游 wire / 契约（→ §4）；
- 新增再生物（→ §5）；
- covered/factory/assembly 行变化（→ §3）。
