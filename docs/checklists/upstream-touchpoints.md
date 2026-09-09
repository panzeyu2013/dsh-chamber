# 上游触点登记与保鲜（upstream touchpoints）

> 面向维护者：登记 dsh-chamber 对上游 dsh（deepseek-harness）的**全部接触面**——fork 副本逐文件
> 纯度、深引 vendor 内部、契约镜像、covered/assembly 行、生成物——并给出每次升级 tag 后的保鲜闭环。
> 机器侧门 = `scripts/dev/verify-upstream-touchpoints.mjs`（C1–C8；CI 在 Bootstrap 后跑 C1/C3/C5/C6，
> 其余本地跑）；本文件与脚本内的登记表**同源**，改动时两侧同步。
> 基准：本表以 **dsh-v0.1.3-alpha.2（82a5fd61a7，harness.commit）** 与 fork 版本标记
> 0.1.3-alpha.2 为锚（C5 校验）；重锚（Batch 2 一次性重锚）后本表随维护循环刷新。

## 0. 基线速查

| 项 | 当前值 |
|---|---|
| 源码线 pin（harness.commit == submodule gitlink） | `82a5fd61a7cf5c293cec4bdff68f455398d685e9`（dsh-v0.1.3-alpha.2） |
| 运行时线锚（npm `@deepseek-ai/dsh`） | 0.1.3-alpha.2（bundle-dsh 兜底 / desktop vendor 锁文件 / release.yml env / install-gateway.sh / gateway `dshAnchorVersion`） |
| fork 版本标记 ×3 | 0.1.3-alpha.2（connection / client-web / api-gateway） |
| vendor 链接数 | 271（ensure-harness-vendor 断言 == 锁文件 importer 集合） |
| typert remote 装配契约 | 13（C4） |
| covered / factory | 52 / 24（live 计数；factory ⊆ covered，chamber-entry 锁步断言） |
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
| `src/api-path.ts` | [patch-mod] | 追加 `resolveInstanceBasePath` + 头部 chamber 说明（basePath 语义，design 05 §3.6） |
| `src/client/connection.ts` | [patch-mod] | **仅** erasableSyntaxOnly 显式字段改写（两个构造参数属性）+ 顶部 chamber 说明；其余逐字节上游（Batch 2 重锚：loopEpoch 代际守卫与 `CONNECTION_BACKOFF_MAX_MS` 导出退役，活性触发改用原生 `reconnect()`/`setNetworkAvailable()`） |
| `src/client/index.ts` | [patch-mod] | `apply(ctx)` 读 `ctx.chamberBasePath` → 载波装配 + `SYSTEM_RESUME_EVENT`/liveness 触发（design 14 D4）+ 头部 chamber 说明 |
| `src/client/rpc.ts` | [patch-mod] | basePath 前缀拼装 + `WebConnectionRpcOptions`（chamber 选项对象）+ 头部 chamber 说明 |
| `tsconfig.client.json` / `tsconfig.host.json` | [patch-mod] | chamber 构面（extends/rootDir/vendor paths）；`files` 列表与上游增量同步维护（脚本按 patched 登记） |
| `src/client/carrier-assembly.ts`、`src/client/liveness-triggers.ts` | [own] | chamber 自有（载波装配策略 / sleep-wake 活性触发：原生 reconnect + 离线门） |
| `tsconfig.check-base/client/host.json` | [own] | chamber erasable-only 校验构面 |
| `test/` | [own] | chamber 自有测试 + fixtures（含 schemastery/fixture/recovery-config 桩 loader） |
| `tsdown.config.ts`、上游 `tests/` | [dropped] | chamber 无 tsdown/镜像上游测试 |

### 2.2 `packages/dsh-client-web`（上游 `packages/client/web`）

pure **5**：`src/base.css`（Batch 2 恢复逐字节一致——chamber token 表改由 renderer 入口
CSS `packages/renderer/src/styles.css` 引入）+ client 构面未列出的小项（以脚本计数为准）。

| 文件 | 标记 | 原因/补丁说明 |
|---|---|---|
| `package.json` | [patch-mod] | 描述/测试脚本/deps·peerDeps·files 面差异；版本行随上游 |
| `README.md` / `README.zh.md` / `README.i18n.yaml` | [patch-mod] | chamber 说明（N-ctx boot kernel），非上游镜像（脚本按 patched 登记） |
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
| `src/client/index.ts` | [patch-mod] | `apply(ctx)` 读 `ctx.chamberBasePath` → `/api/remote.mux` 落到实例前缀（design 05 §3.6） |
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

## 3. deep-import 与 roster 登记

- renderer 深引 vendor：`@deepseek-ai/*` 一律经 vite workspace→src 别名与 `paths`；node 测试经
  桩 loader（`scripts/dev/test-connection-loader.mjs` 等）——不新增裸运行时 vendor 依赖。
- covered/factory：`packages/renderer/src/chamber-covered.ts`（CHAMBER_COVERED_IDS /
  CHAMBER_COVERED_FACTORY_IDS）；chamber-entry 执行期断言 map==列表；新增官方 client 行须
  登记 covered（precedent：ui-open-in-app 行随 a2 登记）。删包 fail-loud 哨兵在 verify 脚本 C4。
- typert remote 装配：`vendor/…/dsh-api-remotes/src/client/index.ts` 契约 == 13（gen-typert-remotes
  与 C4 双向断言）；上游新增 remote 包 = 先裁决（是否 chamber 消费/镜像）再登记。
- `remotePackagesFromAssembly`（renderer/scripts/typert-remote-contract.mjs）为装配契约唯一入口。

## 4. contract-mirror 登记（按上游属主分组）

| 上游属主 | chamber 契约镜像点 | 保鲜 |
|---|---|---|
| dsh-api-remotes（client） | typert remote 装配（13）/ message-feedback、session-reference、subagent 等 wire 面 | gen-typert-remotes + C4 |
| dsh-api-session-controller | api-gateway fork journal-stream 帧（无游标 notification） | fork 重放 + 升级复验 |
| client/connection（recovery） | recovery-config 共享 schema（`DEFAULT_MIN_RESTART_INTERVAL_MS` 10_000 == schema 默认 backoffMaxMs） | liveness-triggers 钉值 + C1 |
| dsh-runtime（激活探针域） | `HOST_DOMAIN_PROBE_NAMES` ↔ gateway `HOST_PACKAGE_PROBE_DOMAINS` | C7 + gateway 运行时 fail-loud |
| dsh-host-webserver（index-inject） | `__DSH_CONNECTION_RECOVERY__` 全局注入（connection host 半） | fork C1（src/index.ts pure） |
| dsh-host-open-in-app（官方 open-in 宿主路由） | chamber open-in 插件本地镜像 `shared/open-in-app-protocol.ts`（三条路由 + 载荷形状）与 `locales.ts` 的 `app.*` 标签表 | open-in 插件 `test/open-in-app-protocol.test.ts`（读 vendor `shared.ts`/`OpenInAppAction.tsx` 逐字比对） |

## 5. 再生物登记

| 再生物 | 源 | 提交纪律 |
|---|---|---|
| renderer typert 工件（gen-typert-remotes 输出） | vendor typert/remote 源码 | 升级后重生成 diff 随批提交（Batch 0 §2.5） |
| host dist ×3（`dist/index.js`） | chamber host 包 src | `build:host-packages` 后提交（C8 advisory 盯陈旧） |
| mobile `lib/client.js`（+map） | mobile src | mobile build 随命名/升级批重建 |
| boot manifest / perf-sizes | build:renderer | 构建产物 diff 随批审查 |
| schemastery 桩 loader（connection/web 测试） | vendor source-only 现实 | 新增 vendor 运行时导入面时同步补桩 |

## 6. 保鲜自动化

`node scripts/dev/verify-upstream-touchpoints.mjs`（只读、exit-code 语义）：
- C1 pure 字节恒等 / C3 完整性（fork 每文件分类、上游每文件裁决，漏 = 硬失败）/
  C5 过期锚扫描 / C6 EXCLUDED 存在性 —— **CI 在 Bootstrap 后 fail-loud**；
- C4 roster（covered/factory 哨兵 + remote 契约 13）—— 本地/CI 均可；
- C7 种子域锁步、C8 生成物陈旧（advisory）—— 本地跑。
- C2 `--tags <old> <new>`：tag 间三 fork 面重放报告（advisory），升级前先跑。
- update-vendor.mjs 完成输出提示运行本脚本；不进 preinstall。

## 7. 每 tag 维护循环（8 步）

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
