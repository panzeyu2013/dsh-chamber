# dsh v0.1.2-alpha.1 迁移设计与执行方案（临时工作文档）

> 依据:`docs/tmp-dsh-upgrade-audit.md`(审计结论,含证据行)。本文是**执行蓝图**:决策已定、
> 按工作包(WP)分阶段执行,每阶段有验证门与完成标准。临时文档,迁移完成后按 checklist §7 归档/删除。
> 约束(AGENTS.md):只改 chamber 侧,不动 vendor/submodule 源码;pin 升级唯一入口
> `scripts/update-vendor.mjs <tag>`;锁文件非 frozen 不得改写;同批提交 gitlink+harness.commit+pnpm-lock.yaml。

---

## 1. 目标与范围

**目标**:把 chamber 源码线完整迁移到上游 `dsh-v0.1.2-alpha.1`(commit `cd5ef81`),达到
「代码适配完成 + pin 已升 + 锁文件稳定 + 全量 typecheck/测试/构建/i18n 绿」。

**范围外(明确不做,记录待办)**:
- **运行时线(2026 fix-sa4 已闭环)**:原阻塞为 `@deepseek-ai/dsh@0.1.2-alpha.1` **未发布**
  (npm latest/next=0.1.1-rc.2)→ bundle-dsh / install-gateway.sh / release.yml env /
  `packages/desktop/vendor/dsh/pnpm-lock.yaml` 保持 0.1.1-rc.2;上游改发
  `@deepseek-ai/dsh@0.1.2-alpha.2`(npm 已发布)后,上述四处已**全部同步 0.1.2-alpha.2**,
  双线一致性门禁(checkRuntimeSourceLine)放行。
- **设计 07 功能落地**(D4):#3 已解锁但本次不实现,仅更新文档/STATUS。
- 提交/发布流程:本迁移产出留在工作树,提交与发布按 checklist 由维护者执行。

## 2. 已拍板决策

| 决策 | 选择 |
|---|---|
| D1 推流 base-path | **方案 A**:fork `dsh-api-gateway` 客户端为 chamber 副本(ensure EXCLUDED + packages/dsh-api-gateway + `remoteStreamUrl` base-path 补丁) |
| D2 版本芯片 | 控制面实例事实投影(探不到隐藏) |
| D3 boot 取舍 | 采纳 `__DSH_BOOT_READY__` 门;保留 chamber prefetch 守卫 |
| D4 设计 07 | 仅记录解锁,实现后期排期 |
| D5 小符号 | deep-source import(与 layout fork 同款) |
| D6 新官方行 | ui-session/ui-chat/ui-approval 进复合;ui-cordis 忽略 |

## 3. 迁移设计(按模块)

### M1 `packages/dsh-client-connection`(WP1,P0)
- **来源**:上游 `packages/client/connection`(37 文件改动)。
- **动作**:① 删除 `src/client/web-api-client.ts`、`src/websocket-downlink.ts`(上游已删);
  ② 干净采纳新文件:index.ts(host 半,async apply+BrowserAuth)、client/api.ts、client/fixture.ts、
  rpc-host.ts、rpc.ts、api-request-trust.ts、http-bridge.ts、invariant.ts、新增 browser-auth.ts、rpc-schema.ts;
  ③ **在新实现上重打 chamber base-path 补丁**:
  - `api-path.ts`:保留 `resolveInstanceBasePath`/`__DSH_BASE_PATH__`,删 `MUX_EVENTS_PATH`/`HOST_EVENTS_PATH`;
  - `client/rpc.ts`:`createWebConnectionRpc(doFetch?, openStream?)` 中 URL 构造加 `${basePath}${channel}/${endpoint}`,
    保留 options-overload,透传 openStream;
  - `client/connection.ts`:新 `ConnectionGenerationSource` 构造器上重打 basePath config 字段、
    `CONNECTION_BACKOFF_MAX_MS`、loopEpoch 守卫(`streamOpenTimeoutMs`→`generationReadyTimeoutMs`);
  - `client/index.ts`:保留 `apply(ctx, config?)`(chamber-entry 传 `{basePath}`);handle 新面
    `{rpc,generation,registerGenerationSource,start}` 上保留 `handle.basePath`;carrier-assembly 退化为只组装 rpc;
    liveness-triggers 的 restart 改 handle 级;删 `handle.api`/`hostDescription` 组装。
- **包级**:deps 删 `ws` 增 `zod`;peer/devDeps 删 `dsh-host-apiproxy`/`dsh-tools`,增 credentials/brand/
  host-directory-picker/settings/tool-todo;tsconfig 删 apiproxy paths。version → 0.1.2-alpha.1。
- **验证**:`pnpm run test:connection` + `typecheck:connection`(pin bump 后)。

### M2 `packages/dsh-client-web`(WP2,P0)
- `src/platform.ts`/`src/seed.ts`:`PLATFORM_MODULES`/staticModules 增 `@deepseek-ai/dsh-client-store`;
- `package.json`:devDep runtime→store;version→0.1.2-alpha.1;`tsconfig.json` 删 runtime path mapping;
- `boot.ts`:采纳 `__DSH_BOOT_READY__` 门(D3);保留 prefetch 守卫;
- 注释(boot.ts:220 / boot-tolerance.ts:82)改指新家;测试 fixture 更新(runtime 引用)。
- **验证**:`test:client-web` + `typecheck:client-web`。

### M3 `packages/dsh-api-gateway` fork(WP3,P0 — D1 方案 A)

> **审查修正(plan-review P0-1/P0-2/P2-15)**:base-path 数据源**不是全局**,而是 per-entry `ctx.chamberBasePath`;
> 复制范围含 `src/stream-protocol.ts`;包级 exports/deps 复刻;AGENTS.md「可改 dsh 源」清单同步增列本副本。

- **复制范围**:上游 `packages/api/gateway` 的 `src/client/*`(**6 个文件**)+ **`src/stream-protocol.ts`**(被
  stream-client.ts:8 / remote-events.ts:28 import,必须连同复制;含 `REMOTE_STREAM_MUX_PATH` 常量)。
  上游 `src/index.ts` 是纯 host 半(TypertGatewayService),**不复制**。
- **接入**:`scripts/dev/ensure-harness-vendor.mjs` 的 `EXCLUDED` 加入 `dsh-api-gateway`(suffix 机制已验证
  支持:ensure-harness-vendor.mjs:49,182);workspace 同名副本解析已验证(锁文件 :1360 同款 `link:../../../../packages/`)。
- **补丁**:`RemoteStreamMuxClient` 构造器加 `basePath` 字段;fork 的 `apply(ctx)` 读 **`ctx.chamberBasePath`**
  (chamber-entry.ts:332-345 的 per-entry 注入;chamber-entry 里 `ctx.plugin(ConnectionPlugin,{basePath})` 同款机制),
  显式传入 mux client;`remoteStreamUrl()` 改读实例字段 → `new URL(\`${basePath}/api/remote.mux\`, base)`;
  可用 connection 副本的 `resolveInstanceBasePath(basePath)` 规范化(尾斜杠)。**禁止依赖 `window.__DSH_BASE_PATH__`(无写点)**。
- **包级**:package.json 复刻上游 exports(`.`/`./client`/`./types`/`./src/*`)+ `dsh.client.inject` 元数据 +
  依赖(`@deepseek-ai/dsh-util-crypto`、`dsh-typert-protocol`、peer `dsh-client-connection`/`dsh-brand`/cordis);
  **必须完整导出 client 面符号**:`RemoteJournalStream`/`RemoteSnapshotStream`/`RemoteStreamCarrierError`/
  `RemoteStreamError`/`ClientRemote`(新 session/workspace-controller 的 client 半值 import 它们)。
- **验证**:`build:renderer` + boot 冒烟;`<basePath>/api/remote.mux` WS 经反代可达;combo URL/`??`/`&` pathname 经
  instance-proxy 运行时复核(P2-13)。

### M4 六个 chamber 客户端插件迁移(WP4,P0/P1)
统一迁移(每个插件:src import + vendor-modules.d.ts + package.json):
- `ClientContext`(runtime/client)→ `import type { Context as ClientContext } from '@deepseek-ai/cordis'`;
- `SlotRegistry` → `@deepseek-ai/dsh-client-ui-renderer/client`;
- store 类型(`defineStore`/`EngineStoreHandle`/`ObservableSnapshot`/…)→ `@deepseek-ai/dsh-client-store`;
- `SessionListState`/`SessionSummary` → `@deepseek-ai/dsh-api-session-controller/client`;
- `WorkspaceId`/`WorkspaceView` → `@deepseek-ai/dsh-api-workspace-controller/client`;
- `package.json` 中 `@deepseek-ai/dsh-client-runtime: workspace:^` 依赖全部删除/重指
  (**pin bump 硬前置**)。

分插件要点:
- **sidebar**(P0/P1):`client/index.ts` `WorkspaceListState`→按 `WorkspaceSnapshot` 重构
  (`projectInstanceSnapshot`,**删 `baselinesReady` 检查**);`indexSubagentDescendants`→
  ui-workspace deep-source;`DirectoryBrowseError`→ui-workspace navigation.ts deep-source(D5);
  `ctx.workspaces.startSession`→`ctx.uiWorkspace.startSession()`;`ctx.connection.hostDescription`→
  `connection.generation`;
  **版本芯片接线(P1-7)**:旧源(握手 host.describe)已断——新数据源 = 控制面/桌面已探测的实例
  `dsh --version` 事实(经 chamberBridge/实例事实投影;local-connection `getHostDescribe` 改用 session/list
  后不再含版本,须确认消费方),探不到隐藏芯片;
  **instance-api 目录动词(P1-5)**:`:202/227` `host.listDirectory/createDirectory`(SidebarRoot.tsx:1090/1097
  的 in-app browse 对话框消费)→ `directoryPicker.list/createDirectory`(payload `{args:{...}}` 位置参数面,
  `DirectoryListing` 形状核对);`WorkspaceCreateError`→api-workspace-controller/client;
  `SessionSummary` 字段抽查(title/updatedAt 保留、phase 等新增)。
- **layout**(P0/P1):store-core/stores 换 store 源;`index.ts` 补 `'locale'` inject + register
  `locale: 'common'`(新 vendor AppFrame 需要)。
- **settings-bridge**(P0,最大):`bridge-context.ts` `SlotRegistry`/`ClientContext` 迁移 +
  **stub remote 扩展**(settings/credentials/llm/agentPresets/session faces,否则子 ctx 5s 挂载门 fail-loud);
  `bridge-api.ts` wire 重写:dotted id→Typert id(`settings/describe|update|replace|mutate|openSettingsDocument`,
  `credentials/…`,`llm/listProviders`+`llm/listConfigurableProviders`+`session/modelCatalog`,
  `agentPresets/list|read|copy|deletePreset|select`),envelope `{args}` + 新响应形态;
  `PermissionRow.tsx` 补 `RiskConfirmation` 的 `closeLabel`(必填)。
- **settings-connections**(P0):settings/credentials wire 调用迁移 + vendor-modules.d.ts。
- **git**(P0):`ClientContext`→cordis;instance-api 的 `workspace.list`→`workspace/follow` stream(P1)。
- **open-in**(P0):`ClientContext`→cordis。

### M5 renderer 复合层(WP5,P0)
- `scripts/gen-boot-manifest.mjs`:输出新 wire——`{rev, entries:[…], batches:[{phase:'bootstrap'|'application',url,rev,entries:[…]}]}`,
  每 entry 恰属一个 batch;entry 语义按新 `BootModuleRow`(initialUrl/inject)。
- `chamber-covered.ts` / `chamber-entry.ts`:
  - 删 `@deepseek-ai/dsh-client-runtime`(covered 与 factories 两表);
  - 增 `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-api-session-controller`、
    `@deepseek-ai/dsh-api-workspace-controller`、`@deepseek-ai/dsh-client-ui-session`、
    `@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-approval`(D6);
  - `COVERED_FACTORIES`/`CHAMBER_COVERED_FACTORY_IDS` 锁步;CI 锁步测试同步;
  - `__DSH_BASE_PATH__` 实例注入机制保持(connection patch 依赖)。
- `vendor-modules.d.ts`:`dsh-client-runtime` 声明删除,补 store/controllers/ui-session 声明;
  connection 声明按新 handle 面。
- `host-graph.ts`:`ExtraModuleRow`/`BootModuleRow` 补 `initialUrl`/`inject`;**combo URL 去重预载**
  (多 entry 共享 combo,逐 URL 只加载一次)。
- `shell.ts`:`ctx.sessions` 新 ISessions face 核对(list.byId/open 保留)。
- `vite.config.mjs`:删 `dsh-host-apiproxy` 特例;`deepseekSource` 覆盖新包
  (dsh-client-store、api-*-controller、ui-session/ui-chat/ui-approval、dsh-api-gateway 副本)。

### M6 control-plane 探针(WP6,P0)
- `spawn-dsh.ts:651` 就绪探针 `host.describe` → `session/list`(斜杠 POST);
- `spawn-dsh.ts:678` browse 探针 `host.listDirectory` → `directoryPicker.list`(payload `{args:{}}`);
  错误码 `directory-picker-unavailable` 语义按新 `requireCapability` 重查(:111 保留);
- **`local-connection.ts` 周期健康探针(P0-3,审查新发现)**:`:501` `performHealthCheck` →
  `describeCapabilities` → `dsh-client.ts:811` `call(baseUrl,'host.describe',{})` → **换 `session/list` 斜杠 POST**
  (否则就绪后 30s 探针连败 → `noteHealthFailure` 累计触发 `triggerRestart` 反复重启);
  确认 `getHostDescribe`/`lastDescribe`(local-connection.ts:849-850)消费方——D2 版本芯片候选数据源之一;
- `proxy-forward.ts:196` `WS_STREAM_PATHS` → `/api/remote.mux`(WP10);
- 300MiB 注释版本号对齐(W10:值不变);
- **同步更新测试 fixture(P1-8)**:control-plane/test/{protocol,spawn-dsh,m1-dsh-client,rpc-envelope,instance-proxy,manager-api}.ts
  (protocol.ts:159/264/292、spawn-dsh.ts:179 `/api/host.describe` marker server、instance-proxy.ts events.mux upgrade fixtures、
  m1-dsh-client.ts:138 pathname 断言)。
- **验证**:`test:control-plane`(protocol/…/spawn-dsh/instance-proxy/ws-frames 等)。

### M7 dsh-runtime 探针(WP7,P0/P1)
- `runtime-probes.ts:241/255`:`host.describe`+`workspace.list` → 替换为 `session/list`(斜杠)+
  新 workspace 源(workspace/follow 或删);`commands.execute` 形参变化后 miss 语义重查;
  全部方法串 dot→slash;`settings.describe` 的 `.namespaces` 校验保持。
- **验证**:`test:runtime` + `typecheck:runtime`。

### M8 desktop 探针(WP8,P1)
- `ssh-provider.ts`:`verifyDshEndpoint`(POST /api/host.describe,~:346)、`probeDshSignature`
  (GET /api/events.mux,~:285)→ 新身份/签名探针(`session/list` 斜杠 POST 或 `/api/remote.mux`
  upgrade + `$events` ready 帧);
- `gateway-provider.ts:807-875` 身份握手同款替换。
- **验证**:`test:desktop`。

### M9 gateway wire(WP9,P1)
- `features/schedule.ts:84`:`session.prompt` payload 加 `requestId`(随机 UUID);注释更新;
- **`features/git.ts`(P1-4,审查新发现)**:`:236` `listWorkspaces` 调 `workspace.list`(已删)→
  `workspace/follow` stream / WorkspaceSource 读面(注意 stream 与 unary 语义不兼容);`:292` `listSessions`
  `session.list` → `session/list`;同步改 `git-feature.test.ts:182/227` fixtures;
- `features/index.ts`(:319/:331)+ `notify.ts` + `dispatch.ts`(**:533**,sa2 行号偏,实际特判在此):
  events.mux/events.host 帧 → `session/control`(SessionControlBaseline)+ `session/follow` Remote stream;
  upgrade 特判改 `/api/remote.mux`;
- 方法改名:`session.history`→`session/page`、`session.models`→`session/modelCatalog`、全部 dot→slash;
- **同步更新测试 fixture(P1-8)**:gateway/test/{git-feature,feature-lifecycle,index-boundary,dispatch-composition,gateway-proxy}.ts;
  `feature-lifecycle.test.ts:364` 同步 requestId 断言;
- **验证**:`test:gateway`。

### M10 proxy-forward(WP10,P1)
- `WS_STREAM_PATHS` → `{'/api/remote.mux'}`;注释版本号对齐。验证:`test:control-plane`(gateway-transport)。

### M11 版本常量(WP11,P0)
- `packages/dsh-client-connection/package.json:4`、`packages/dsh-client-web/package.json:4` version → 0.1.2-alpha.1;
- `scripts/dev/release-preflight.mjs:15,67` FORK_VERSION 默认 → 0.1.2-alpha.1;
- **不动**:release.yml env / install-gateway.sh / bundle-dsh 兜底(运行时线,等 npm)。
  *(fix-sa4 已闭环:npm 发布 0.1.2-alpha.2 后,release.yml env / install-gateway.sh /
  bundle-dsh 兜底 / vendor/dsh 锁文件已同步为 0.1.2-alpha.2,双线门禁放行。)*
- 验证:`test:release-workflow` + `release-preflight --versions-only`(以新 FORK_VERSION)。

### M12 pin bump 与锁文件(WP12,P0)
1. 前置:WP1–WP11 完成(7 包 runtime 依赖 + connection apiproxy 依赖已重指,**否则 pnpm 解析失败**);
2. `node scripts/update-vendor.mjs dsh-v0.1.2-alpha.1`(fetch+复核 tag → checkout → harness.commit →
   差量建链(自动删 5 链/建 25 链)→ 锁文件重生成 → restore → frozen 验证);
3. **手工补齐 25 个新 vendor 包 importer 记录**(不在 HEAD 锁文件):零依赖单行 `…: {}`;
   有依赖按 pnpm-lock.yaml:1518 `dsh-authorization` 块格式(devDependencies + workspace:^ + link:../<sibling>);
   **EXCLUDED 副本例外(P1-6)**:依赖 `dsh-client-connection`/`dsh-client-web`/`dsh-api-gateway`(M3 后为
   chamber 副本,无 vendor 链接)时用 `link:../../../../packages/<name>`(参照现行锁文件 :1360 同款记录;
   新 `dsh-api-session-controller`/`dsh-api-workspace-controller` 的 deps 含 api-gateway+connection,必命中此例外);
4. 三连验证:`pnpm install --frozen-lockfile` + `node scripts/dev/ensure-harness-vendor.mjs --check` +
   `git diff --exit-code -- pnpm-lock.yaml`;
   **链接数口径(P1-9)**:期望 **259**(262 上游包 − 3 EXCLUDED 副本),update-vendor 差量建链删 **6**(5 上游删除 + dsh-api-gateway 链接)/建 25;
5. 提交集(维护者):submodule gitlink + harness.commit + pnpm-lock.yaml;提交 gitlink 前不跑 `git submodule update`。

### M13 全量验证(WP13)
- typecheck 全套:根 + runtime + sidebar + layout + connections + settings-bridge + git + open-in +
  client-web + connection + host-graph + host-git + gateway;
- 测试全套:`test:control-plane` + `test:desktop` + `test:gateway` + `test:cli` + `test:renderer-shell` +
  `test:git` + `test:host-git` + `test:sidebar` + `test:settings-bridge` + `test:connections` +
  `test:client-web` + `test:connection` + `test:layout` + `test:open-in` + `test:runtime`;
- 构建:`pnpm run build:renderer`;`pnpm run verify:i18n`;`pnpm run smoke`(未捆绑 SKIP);
- 残留扫描:`grep -rn "0\.1\.0-rc\.8\|141eb6f" packages/ scripts/ harness.commit`(仅历史叙述)。

## 4. 执行阶段(顺序执行,门控推进)

| 阶段 | 内容 | 执行方式 | 验证门(完成标准) |
|---|---|---|---|
| P0 | 环境准备:物化 submodule(旧 pin)→ ensure 建链 → `pnpm install --frozen-lockfile` | 直跑(后台) | install 成功;基线:跑受影响测试冒烟 |
| P1 | M11 + M1 + M2 + M3(核心副本+常量) | subagent×3 并行 | 文件级自检清单;无 runtime/apiproxy 残留 import(除计划内) |
| P2 | M4 六插件 | subagent×3 并行(按插件分) | 同上;`grep -rn "dsh-client-runtime\|dsh-host-apiproxy" packages/` 清零(除注释/历史) |
| P3 | M5 renderer 复合层 | subagent×1-2 | gen-boot-manifest 输出含 batches;covered 锁步测试同步 |
| P4 | M6–M10 探针与 wire | subagent×2-3 并行 | 方法串 dot→slash 全量核对;无 host.describe/workspace.list/events.mux 残留(除注释) |
| P5 | M12 pin bump + importer | 直跑(前台,长任务) | update-vendor 成功;25 importer 补齐;frozen+ensure --check+漂移断言通过 |
| P6 | M13 全量验证 | 直跑(后台批次) | typecheck 全绿;测试全绿;build:renderer 过;verify:i18n 无 DRIFT |
| P7 | WP14 review-fix loop | 每轮 1 个全新独立 subagent 审查(不代入记忆)→ 修复 → 再审,直至"无错误报告" | 审查报告 0 错误 |
| P8 | WP15 最终报告 + 文档归档 | 直跑 | 结果报告交付;STATUS/CHANGELOG 迁移条目草案 |

## 5. 风险与回退

| 风险 | 缓解/回退 |
|---|---|
| pin bump 后 pnpm 解析失败(依赖重指遗漏) | WP1–WP11 完成度是 P5 前置门;失败时 `git -C vendor/harness-checkout checkout --detach <旧pin>` 回退 + harness.commit 未提交可恢复 |
| update-vendor 锁文件不稳定(frozen 改写) | 脚本自带 sha256 前后比对,失败即中止;25 个 importer 手工补齐后重试 |
| M3 api-gateway fork 破坏流协议 | 副本只改 `remoteStreamUrl` 一处;对照上游 client 半逐字节 diff 审查;若 deep-source 解析失败,回退为方案 B(rpc.open)前先验证 |
| 迁移后行为回归(探针/wire) | P4 后全量测试门;gateway schedule 有 feature-lifecycle 测试锁定 |
| 上游 boot 期新 DSH_HOME 写入(chamber spawn 栅栏) | P2 观察项,升级后实机验证 |
| 运行时线阻塞(npm 未发布) | 明确范围外;STATUS 记录待办,发布后按 checklist §2/§5 补齐 |
| 本地 submodule 物化状态与 pin 不一致 | P0 先 `git submodule update --init` 物化并核对 HEAD==harness.commit |

## 6. 完成标准

1. `grep -rn "dsh-client-runtime\|dsh-host-apiproxy" packages/ scripts/` 仅剩注释/历史叙述/文档;
   `grep -rn "host\.describe\|workspace\.list\|session\.history\|session\.models\|events\.mux\|events\.host\|host\.listDirectory" packages/ scripts/`
   仅剩注释/历史叙述/文档(不含 fixture.ts 整体替换);
2. vendor 链接 **259** 个,ensure `--check` 通过;锁文件 frozen 稳定;
3. 全量 typecheck + 测试 + build:renderer + verify:i18n 绿;
4. 独立 subagent review 连续一轮 0 错误;
5. 变更文档/STATUS 迁移记录草案完成;运行时线待办明确;
6. **审查修正登记**:plan-review 的 P0-1/P0-2/P0-3 与 P1-4~P1-9 全部落实(见 §7);
   AGENTS.md「可改 dsh 源」清单增列 `packages/dsh-api-gateway`(P2-15)。

## 7.6 P0 修复:0.1.2 BrowserAuth 门禁(审查轮次 3-C)

**上游事实**:dsh-v0.1.2-alpha.1 的 web-profile host 对 /api 与 /api/remote.mux 施加无条件签名 cookie 门禁
(client/connection rpc-host.ts requestRejection = Host 栅栏 + browserAuth.isAuthenticated → 无 cookie 401;
api/gateway mux 升级同门禁;launch token 为进程内存随机数,官方流程=浏览器以 ?token= 访问首载换 cookie)。

**chamber 适配(本地实例,已实现)**:
1. spawn-dsh 并发扫描子进程 stdout 的 `dsh web: <url>?token=<t>` 行(printUrl 默认 true;rc.2 无 token 则跳过);
2. `exchangeLaunchToken` 执行 `GET /?token=` 交换(303+Set-Cookie),cookie 仅存控制面进程内存(browser-auth-cookie.ts 注册表;启动行令牌对日志脱敏,round5);
   - **旧 host(rc.2)引导语义**:URL 行无 token 时 bootstrap 返回未铸 cookie,探针不带 cookie 直接成功(rc.2 无门禁)——此处「operation continues as before」仅指引导回退,不改变双线互斥窗口的整体状态(源码线 0.1.2 + 运行时线 rc.2 时,rc.2 运行时自身点号端点与 0.1.2 探针不匹配,spawn 必败,release-preflight 硬门禁拦截发布);
3. `call()` 按 baseUrl 自动注入 cookie(探针/健康/网关调用全自动);instance-proxy 的 HTTP 转发与 mux WS 升级注入 cookie(渲染器全链路免改);
4. spawn 中止/失败/实例停止时清除 cookie;探针 401 且 bootstrap 失败 → 明确报错。

**远端(ssh/http 附加)**:launch token 在远端进程内存,隧道不可恢复 → verifyDshEndpoint 对 401 返回 terminal 明确分类
("remote dsh 0.1.2 requires the browser-auth launch token, which chamber cannot recover over SSH…"),
登记为硬阻断(上游需提供 token 检索机制);本地线不受影响。

**测试**:browser-auth-cookie 单测、call() 注入、proxy 转发注入、spawn 端到端(伪 host 401→交换→cookie→探针过)、ssh 401 分类。



**round4 追加修复**:gateway-proxy HTTP/WS 注入 browser-auth cookie(P1-1)、网关 openRemoteStream WS 握手带 cookie(P1-2)、ssh/gateway-provider 401 签名探针细化分类、index title:null 行保留、browse 探针注释、host-graph 重试默认对齐 10、spawn 扫描器清理与失败清 cookie、browser-auth 负路径与本地升级路径测试补强。

**已修复(round3)**:双线互斥窗口硬门禁(release-preflight `checkRuntimeSourceLine`,全量+versions-only 双路径;STATUS.md 已声明);
index 健康路径轮询常开+控制流并发(新会话增删实时刷新);应答 SSE 去重(notifier 回调单发);
STATUS.md 迁移基线记录;control 流帧解码单元测试 2 项(3-B P1-1);
死 mock 分支/死 ambient/陈旧注释/header 措辞清理。

**已知偏差(登记不改)**:① workspace 面退化(workspaceId 不派生、fail-closed、follow TODO)——WP9 已登记;
② api-gateway fork exports 的 `.`/`./types`/`./invariant` 指向构建产物 lib/(源码线约定,与 connection/web 副本同形;未来 bare 导入需先构建);
③ release 预检当前必红=双线门禁刻意治理(见 §7.5 上条);
④ 版本芯片隐藏(D2-PENDING,后续排期);
⑤ `$events` pending 行滞留:上游 cancel 帧是客户端→服务器方向(stream-protocol.ts,网关侧不接收),0.1.2 无 host 驱动的 resolved 事件——pending 行在应答或流重连时清理(answer-driven 是 0.1.2 语义,round4 确认非缺陷);
⑥ cookie Max-Age=30 天:长跑实例在到期点由健康重启/重spawn 自然重换(无会话中重换,round5 注记);**量级注记(round6)**:cookie 过期后探针 401 → 健康判定失败约 20×30s≈10 分钟死窗才触发重启换新——自愈但存在可达的中断窗口,后续排期在重试链中加入「cookie 过期即重交换」;
⑦ 索引 per-key seq 水位线已删除:轮询快照可能短暂覆盖更新的流投影(≤10s 自愈,round5 注记);
⑧ remote-stream 接收面帧校验宽松于上游 exactKeys(接受未知/额外键):故意的前向兼容容差(接收面拒绝新键会杀 socket),已登记;
⑨ agentPresets/select 潜伏面:bridge stub 以 {agentId:'',agentPreset} 发出(typert wire 将 Agent 参数投影为 agentId 键,round7a 证实),seat fiber 不激活则不可达,一旦被调宿主必 400——已登记;
⑩ cookie 端口碰撞理论面:远端隧道复用本地端口时注册表键同形(实际不可达:远端实例的 cookie 经桌面注册表另键注册),round7a 注记;
⑪ round8a P1 驳斥(commands/execute 探针期望码):8-A 声称真实 wire 产生 lookup-not-found/internal 而非 session-not-found——经上游链核实为误报:
   session-controller agent.ts:146-149 的 agent lookup provider 对缺失会话**抛出** `TypertLookupFailure(found.error)`(resolve 路径 catch ApiSessionNotFound → `{error:{code:'session-not-found'}}`,agent.ts:203),
   网关 index.ts:1004 `error instanceof TypertLookupFailure → return error.failure as ConnectionRpcError` 将其**解包为域错误**——客户端收到的正是 session-not-found;
   `lookup-not-found` 分支(index.ts:865-873)只适用于**返回 undefined** 的 provider,不适用本端点。探针语义与单测均正确(round-1 审查深挖同一链后亦确认)。登记此证据防止后续审查重复误报。
⑮ 0.1.2-alpha.2 升级注记(round1/2 检查):P1-1 两个 git 追踪 dist 已重建同步(runtime-probes/host-git 新错误码);P1-2 提交时与 gitlink+harness.commit 同批;P1-3(round2c)bridge-context stub remote 补 `$host:{home:undefined,isLoopback:true}`(alpha.2 设置插件 apply 期解引用,否则设置壳打开失败)——修复已合入,但 **mountBridgeSession 全链测试不可行**(cordis 为源码树无 lib,node 测试无法解析裸导入),盲区登记:需 build 后实机/浏览器面验证设置壳打开;2-A P2(web fork 空 PRELOADED_CLIENT_EXTERNALS 删除、api-gateway exports 惰性子路径、fork tsconfig erasableSyntaxOnly:false 覆盖)与 2-B P2(typecheck-api-gateway.mjs 日志标签已修、aggregate-store 注释已修、release-checklist 示例版本已修)均已处理或为既有登记决策。
⑭ round9a 注记:reaper 回收孤儿 host 不清 cookie(死进程 cookie 残留,进程退出即消,无安全影响);spawn 行缓冲未终止行不 flush(日志观感,对脱敏反而安全);AUTH_COOKIES 注册表无界 Map(键=本地实例数,量级可忽略)——均为非功能性观察。
⑬ round9c 注记:AUTH_BOOTSTRAP_WAIT_MS=15s 对慢冷启动偏紧(URL 行晚于 15s 则 loud-fail,有界可重试——鲁棒性观察,非缺陷);exchangeLaunchToken 单 Set-Cookie 假设(上游现恰单 cookie,不触发);host-graph 测试夹具已全部对齐 0.1.2 combo 形(`/plugins/??<id>&rev=`);帧字节记账已改 UTF-8 字节口径。
⑫ round8b 注记:remote-stream 帧字节记账已改为逐帧尺寸精确记账(round8b P2-1);protocol.ts 的 openEventStream 死测试面保留(deprecated 函数行为钉住,无生产调用);测试 mock cookie 名为虚构字面(browser-auth 而非 dsh-auth-<sha256>,注册表存整对、名称不参与逻辑,round8b P2-2);spawn-dsh 测试 finally 硬编码默认端口(测试隔离性注记,round8b P2-2);session-index 投影帧 title:null 不覆盖旧值(≤10s 轮询纠正,round8b P2-3);
⑥ submodule 内解析 shim node_modules(ensure 脚本的既有机制,gitignored);
⑦ `PRELOADED_CLIENT_EXTERNALS` 未引入 web 副本(上游导出,chamber 无此结构,预存决策);
⑧ README:64/deploy-gateway:29/design 07§4 文档陈旧——WP15/P8 归档时统一更新。



| 编号 | 问题 | 落实位置 |
|---|---|---|
| P0-1 | M3 base-path 数据源:用 `ctx.chamberBasePath`,禁全局 | M3(已改) |
| P0-2 | M3 复制范围 + src/stream-protocol.ts + package.json exports/deps/符号导出 | M3(已改) |
| P0-3 | control-plane 健康探针 local-connection.ts:501 host.describe | M6(已改) |
| P1-4 | gateway features/git.ts workspace.list(:236)+ 测试 | M9(已改) |
| P1-5 | sidebar instance-api 目录动词 host.listDirectory/createDirectory(:202/227) | M4(已改) |
| P1-6 | importer 对 EXCLUDED 副本 link:../../../../packages/<name> | M12(已改) |
| P1-7 | D2 版本芯片接线 | M4(已改,执行时确认消费方) |
| P1-8 | 测试 fixture 迁移范围枚举 | M6/M9(已改)+ P4 门 grep |
| P1-9 | 链接数 259 / 删 6 | M12/§6(已改) |
| P2-10 | typert 生成器自动推导(gen-typert-remotes 不改代码,P6 验证产物) | M5 验证项 |
| P2-11 | M5 措辞:per-entry base-path 注入机制(非全局) | M5 执行时按 ctx 机制 |
| P2-12 | dispatch.ts:533 特判行号 | M9(已改) |
| P2-13 | combo URL 经反代运行时复核 | M3/M5 验证项 |
| P2-14 | scripts/e2e-gateway-harness.ts:187-202 host.describe 探针 | P4 顺手更新 |
| P2-15 | AGENTS.md 可改源码清单增列 dsh-api-gateway | §6 完成标准 |
| P2-16 | 文档清单:design 07 §4/09/11/18、README:64、deploy-gateway:29、spawn-dsh 注记、proxy-forward/03 注释 | P8 归档 |
| P2-17 | 各插件新 dev/peer 依赖目标由 import 迁移推导并写明 | P2 执行时 |
| P2-18 | WorkspaceCreateError/SessionSummary 抽查、HoverCard label | M4(已改,部分 P2) |
| P2-19 | 风险补充:submodule 脏态/P1–P4 禁 install/rebase 交互/fork 长期维护 | §5 风险表 + P0 步骤 |
