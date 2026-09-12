# 上游触点登记与保鲜（upstream touchpoints）

> 面向维护者：登记 dsh-chamber 对上游 dsh（deepseek-harness）的**全部接触面**——fork 副本逐文件
> 纯度、深引 vendor 内部、契约镜像、covered/assembly 行、生成物——并给出每次升级 tag 后的保鲜闭环。
> 机器侧门 = `scripts/dev/verify-upstream-touchpoints.mjs`（C1–C10；CI 两条腿在 Bootstrap 后 pre-install 跑
> `--no-artifact-rebuild`（C1/C3–C10，C8 advisory）、post-install 跑完整门（C8 重建-比对硬失败）；C2 本地 advisory）；
> 本文件与脚本内的登记表**同源**，改动时两侧同步。
> 基准值不在本表：源码线 pin 的单一来源是 `harness.commit`（== submodule gitlink），运行时锚的
> 单一来源是 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 的 `@deepseek-ai/dsh` specifier，
> fork 版本以各 fork `package.json` 为准（对拍门 = C5/C10）。本表只登记**结构性触点与判据**；
> 每次重锚按 §7 循环复核结构，逐 tag 的升级叙述写 `CHANGELOG.md` 发布节与 git 历史。

## 0. 结构速查（只登记结构与判据，不记录版本值）

| 项 | 值 / 判据 |
|---|---|
| vendor 链接数 | 284（ensure-harness-vendor 断言 == 锁文件 importer 集合） |
| typert remote 装配契约 | 15（C4；+command-feedback/+workspace-files） |
| covered / factory | **57 / 26**（live 计数；factory ⊆ covered，chamber-entry 锁步断言；+`ui-dockkit`、+`client-file-upload` covered factory，四轮再 +`session-log-export`（deferred）与两个 page-own 跳过 id） |
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
| `src/boot.ts` | [patch-mod] | N-ctx boot kernel（extraRows / `__ModuleLoader__` / configureContext / 异步 dispose） |
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
`lib/` 一律不镜像。本表**不记录逐 tag 的升级叙述**（那属于 `CHANGELOG.md` 发布节与 git 历史）；
升级时按下列**判据**裁决，判据本身随重锚复核：

- **fork 面**：上游 counterpart 的 `src/` 有改动 ⇒ 逐文件重放并更新 §2.1–§2.3 的分类与原因；
  只有 `package.json` 版本行变化 ⇒ 仅同步版本标记（C5 对拍）。
- **上游 workspace 成员增删**：vendor 链接集合与根 `pnpm-lock.yaml` 随之变化；新增成员按 §5
  裁决是否属再生物，删除成员须确认 `restore-lockfile-vendor-records.mjs` 的守卫已跳过该记录
  （见 `dsh-upgrade-checklist.md` §4）。
- **「首屏依赖 extra row 服务」触点（结构性，与 tag 无关）**：composite 首屏插件的 cordis
  `inject` 若由**未覆盖**的 extra row 提供，该行不挂载时首屏永远 PENDING。探针集合自
  2026-09-11 起**完全派生**——`chamber-entry.ts` 的 `register(id, plugin)` 与
  `registerDeferred` 记录每个（首屏与延迟）命名空间导出的 `inject` 面，
  `injectedServices`/`missingInjectedServices`（`required-extra-rows.ts`）取并集后探测
  （上游同 fact：`Object.keys(entry.fiber.inject)`）。上游改 inject 面**无需登记名字**；
  唯一派生面看不见的漂移（命名空间不再导出 `inject`）由
  `packages/renderer/test/required-extra-rows.test.ts` 的逐 id 表钉住。
- **平台词偏离的跨代耦合（后果登记于 `docs/progress/STATUS.md`）**：`ui-primitives` 不 seed、
  由 covered factory 回答（C3 偏差）；实例侧 `ui-sidebar-documentpreview` 的代码预览**行为上
  依赖**与 composite 同代的 `ui-primitives`（`CodeBlock` 的 `contentRef` 与
  `[data-code-block-content]` 是其唯一滚动/行定位锚点）。composite 比实例旧一代时该行失去
  独立滚动区与行定位（纯文本仍可用）——版本歪斜把这条体积优化变成可见功能面。
- **平台词 vs host-graph 行**：`client/web` 的平台词表（`platform.ts`/`seed.ts`）与 host-graph
  行是互斥裁决——把行当平台词 seed 会让启动失败（C3 不变量）；上游新增平台词时先裁决归属。
  宿主半的 `webServer` 可选注入会影响 connection 宿主半的重放，须逐面复核。

## 3. deep-import 与 roster 登记

- renderer 深引 vendor：`@deepseek-ai/*` 一律经 vite workspace→src 别名与 `paths`；node 测试经
  桩 loader（`scripts/dev/test-connection-loader.mjs` 等）——不新增裸运行时 vendor 依赖。
- covered/factory：`packages/renderer/src/chamber-covered.ts`（CHAMBER_COVERED_IDS /
  CHAMBER_COVERED_FACTORY_IDS）；chamber-entry 执行期断言 map==列表；新增官方 client 行须
  登记 covered（precedent：ui-open-in-app 行随 a2 登记；该行现行理由 = 官方注册被
  chamber fork **替换**，见设计 20 §2.2）。删包 fail-loud 哨兵在 verify 脚本 C4。
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
  判定来源是 `.gitignore` 本身（门用 `git ls-files --others --ignored --exclude-per-directory=.gitignore
  --directory` 取该集合，git 缺席时**才**退回脚本内同名静态清单），因为「fresh checkout 不存在」与
  「被忽略」是同一件事，
  而只有 `.gitignore` 是其单一来源。**不用** `--exclude-standard`：它同时吃 `.git/info/exclude` 与
  开发机全局 `core.excludesFile`，会让本地少扫、CI 多扫，正好抹掉 C10 想消掉的那条差异——当初的四个具名条目（`packages/desktop/release/` 打包产物、
  `packages/desktop/.dev-user-data/` dev 应用数据、`packages/gateway/host-packages/`、
  `packages/renderer/.cache/`）正是促成该规则的路径。**唯一的例外**是被忽略却**故意要扫**的
  `packages/desktop/vendor/dsh/package.json`（bundle 清单交叉校验，见上），所以文件级跳过只作用于
  常规分支，不越过该特例——2026-09 本地重放发现这些目录内残留的旧代际字面量会让**干净工作区**误红
  （tracked 文件零命中），CI 因无这些目录而不受影响。
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
- **复合首屏 ← 未覆盖官方行（反向依赖，2026-09 二轮登记；三轮收敛为 1 条；
  2026-09-11 起为派生集合）**：
  `ui-chat` ← `sidebarRight`（`ui-sidebar-right` 行提供）。二轮曾把 `fileUpload`
  （`ui-conversation`/`api-session-controller` 根 inject）与 `resources`（渲染期
  `useResource` 座，非 inject）列入；三轮把 `client-file-upload` **改为 covered**
  （既消除 extra row 依赖，也让构建期补丁能覆盖它的同源绝对 URL）并删掉 `resources`
  这一条不成立的理由。登记点 = `packages/renderer/src/chamber-entry.ts` 的
  `register(id, plugin)` 调用表（每个首屏挂载记录该命名空间导出的 `inject` 面）
  + `packages/renderer/src/required-extra-rows.ts` 的
  `registeredInjectMembers`/`injectedServices`/`missingInjectedServices`
  + `required-extra-rows.test.ts`；集合本身**派生**、不再手写（原
  `REQUIRED_EXTRA_ROW_SERVICES` 已删除）。上游新增/改名首屏 inject 成员时，
  两侧（`host-graph.ts` 降级注释 + 本行）按 design 09 §3.2 复核即可——探针自动覆盖
  新的未覆盖 provider。
- `remotePackagesFromAssembly`（renderer/scripts/typert-remote-contract.mjs）为装配契约唯一入口。

## 4. contract-mirror 登记（按上游属主分组）

| 上游属主 | chamber 契约镜像点 | 保鲜 |
|---|---|---|
| dsh-api-remotes（client） | typert remote 装配（15）/ message-feedback、session-reference、subagent 等 wire 面 | gen-typert-remotes + C4 |
| dsh-api-session-controller | api-gateway fork journal-stream 帧（无游标 notification） | fork 重放 + 升级复验 |
| client/connection（recovery） | recovery-config 共享 schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` 10_000 == schema 默认 backoffMaxMs） | liveness-triggers 钉值 + C1 |
| dsh-runtime（激活探针域） | `HOST_DOMAIN_PROBE_NAMES` ↔ gateway `HOST_PACKAGE_PROBE_DOMAINS` | C7 + gateway 运行时 fail-loud |
| interaction/commands（`commands/execute` 第三参数） | 激活探针载荷的键名 == 上游 `execute(agent, line, submittedAttachments, signal)` 的参数名（现行各代皆为 `submittedAttachments`；历史线曾用 `images`，`attachments` 从不是上游线名） | `runtime-probes.test.ts`：读 vendor 签名逐字比对 + 夹具按真实 typert gateway 校验参数键集（**2026-09 实机：一次升级中写错的 `attachments` 使每条激活探针失败、每次首装本地实例被隔离，直至验收轮才发现**） |
| dsh-host-webserver（index-inject） | `__DSH_CONNECTION_RECOVERY__` 全局注入（connection host 半） | fork C1（src/index.ts pure） |
| dsh-host-open-in-app + dsh-client-ui-open-in-app（官方 open-in 两份） | **chamber fork（已落地）**（设计 20 §2.2/§6，2026-09-11 fork & supersede）：宿主半 `packages/dsh-chamber-seed-open-in/`（fork 自上游 `packages/host/open-in-app`；`src/{catalog,resolver,icons}.ts` 逐字节 `pure`，`src/{shared,index}.ts` `patched`，`src/core.ts`/`scripts/`/`test/`/`dist/index.js` `own`，上游 `src/internals.ts`/`README*`/`tsdown.config.ts`/`tests/` `dropped`）、客户端半 `packages/dsh-chamber-client-ui-open-in/`（自有 wire 镜像 `shared/open-in-wire.ts` + 自有 `app.*` 标签表，取代原路由/标签镜像）。官方两份都不加载/不调用：官方 client 行沿用 page-own 跳过，官方 host 行保持挂载但无调用方 | **已登记 verify 脚本的 `FORKS` 表**（与本文档 §4 同源，`versionAnchor: 'chamber'`）：C1（未登记差异即硬失败）/ C3（每文件必须有 pure·patched·own·dropped 分类）/ C5（版本锚豁免：seed 包随 chamber 发版，不与上游版本相等）——上游漂移会在门里直接红；有意分歧逐条写在 `patched`/`dropped` 原因里（删 SSH 休眠门、HTTP 路由 → typert Remote `openInApp/*`、Config 形状、协议与标签所有权），fork 自身 `test/` 覆盖解析/校验/图标逻辑，跨半契约由客户端 `test/open-in-wire-lockstep.test.ts` 钉住 |

## 5. 再生物登记

| 再生物 | 源 | 提交纪律 |
|---|---|---|
| renderer typert 工件（gen-typert-remotes 输出） | vendor typert/remote 源码 | **构建期生成、`.gitignore` 忽略，不提交**（`renderer/src/generated/`；升级后由 `build:renderer` 重生成） |
| host dist ×4（`dist/index.js`，含 seed-open-in）+ `dsh-runtime/dist/index.js` + mobile `dist/index.js`/`lib/index.js`/`lib/client.js`(+map) | chamber host 包 src / dsh-runtime src / mobile src | `build:host-packages` / `build:dsh-runtime` / mobile `build` 后提交（C8 共 6 组）。C8 **重建-比对硬失败**盯陈旧（mobile 产物由 gateway 逐字节 seed，陈旧即线上锚点失效）；两个 build 脚本都带 `absWorkingDir`，产物与调用者 CWD 无关 |
| boot manifest / perf-sizes | build:renderer | 构建产物 diff 随批审查 |
| schemastery 桩 loader（connection/web 测试） | vendor source-only 现实 | 新增 vendor 运行时导入面时同步补桩 |

## 6. 保鲜自动化

`node scripts/dev/verify-upstream-touchpoints.mjs`（除 C8 在**正常路径**下「重建-比对后原样还原」外只读；中断/并发/额外产物路径由整目录快照 + SIGINT/SIGTERM 处理器 + `wx` 独占锁兜底）：
- **参数守卫与退出码（2026-12 review P2；措辞与脚本头注同源）**：默认模式会**就地重建并还原**提交态生成物（唯一写盘路径），因此任何未知参数/位置参数都由 `verify-upstream-touchpoints-args.mjs` 判为用法错误——`--help`/`-h` = 打印权威用法文本、**exit 0，不跑任何门、不写盘**；未知参数（如拼错的 `--no-artifact-rebuid`）、位置参数、重复 flag 或 `--tags` 缺值 = **exit 2（用法错误）且不先跑门**；门硬失败 = exit 1；全部通过 = exit 0。一个拼错的 flag 以前会被静默忽略并照跑全量写盘门，故这里是响亮失败而非容错。判定逻辑是纯函数（单测 `verify-upstream-touchpoints-args.test.mjs`）。
- C1 pure 字节恒等 / C3 完整性（fork 每文件分类、上游每文件裁决，漏 = 硬失败）/
  C5 过期锚扫描 / C6 EXCLUDED 存在性 —— **CI 在 Bootstrap 后 fail-loud**；
- C4 roster（covered/factory 哨兵 + remote 契约 15 的集合与顺序）—— 本地/CI 均可；
- C7 种子域锁步、C8 **提交态生成物 == src**（重建-比对，硬失败；写后原样还原，`--no-artifact-rebuild` 退回 mtime advisory）、C9 **vendor 补丁锚唯一命中**（硬失败）、C10 **版本锚一致性 + 活版本字面量白名单**（硬失败：运行时版本单一来源 = **已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml`，见 §3；同目录 `package.json` 被 gitignore、属派生本地状态，仅本地存在时与锁文件交叉校验；六锚 + 3 fork 必须等于该锁文件；生产源码/脚本/配置里出现未登记的「活」版本字面量即红——历史叙述只能留在注释里，具名诊断常量按上限 1 处白名单登记）—— CI 与本地均跑（CI 分 pre/post-install 两段）。
- C2 `--tags <old> <new>`：tag 间**全部已登记 fork 面**的重放差异报告（advisory；C2 遍历 `FORKS` 全表，故三条 shadow 副本与 `seed-open-in` 都在内），升级前先跑。
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
   2026-09 加，layout 阻塞点即由此显式暴露。）
1. 读 C2 报告逐面裁决；仍 open 的偏差登记进 `docs/progress/STATUS.md`——本表只更新结构登记行，
   不记版本值、不加「追踪 <tag>」行；
2. `node scripts/dev/update-vendor.mjs <tag>`（原子升级 + 锁文件重生成）；
3. C2 触点报告（`--tags old new`）→ 逐文件裁决：重放 [pure]/[patch-*] 或改登记；
4. fork 重放 + 版本标记同步（三副本 → 新版本）；
5. roster pass：covered/factory 存在性、typert 契约、新增官方行裁决；
6. 契约复验：contract-mirror 表逐行（§4）+ 相关测试；
7. 运行时线单独提交（bundle-dsh 刷新 + 四锚 + bin.js 冒烟）；
8. 文档回写：CHANGELOG/STATUS + 本表**结构登记行**刷新（版本值不进 checklist）+ i18n 重录。

## 8. PR 评审清单条目

改动含下列任一项 ⇒ **必须登记/刷新本表与 verify 脚本**（PR 模板已含自检项）：
- 新增 `@deepseek-ai/*` 深导入或裸 vendor 运行时导入面（→ §3/§5）；
- 修改 fork 副本文件（pure 面改动会被 C1 拦；[patch-*] 须同批更新登记原因）；
- 镜像新上游 wire / 契约（→ §4）；
- 新增再生物（→ §5）；
- covered/factory/assembly 行变化（→ §3）。
