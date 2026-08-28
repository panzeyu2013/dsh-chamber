/**
 * dsh-chamber 架构重构编排 workflow（评审报告 P0–P4）。
 *
 * 阶段：
 *  0. 常量导出基线（agent-exports，串行前置）：control-plane 导出端口常量，
 *     供后续各 agent 引用（命名约定由此 agent 固定）。
 *  1. 并行包重构（5 个 agent，文件集互不重叠）：
 *     - agent-cp           control-plane 包：A3 死代码 / A5-cp 拆 static-serving / B6 reaper 测试 / B1-cp catalog 死方法
 *     - agent-desktop      desktop 包：A1 main.ts 拆 wiring / B7 砍 direct-endpoint / B8 IPC 通道常量
 *     - agent-frontend     前端插件 + renderer 非 App 部分：A4 类型收敛 / A6 幽灵依赖 / B2 REST 客户端共享化
 *     - agent-renderer-core renderer App.tsx/shell.ts：A5-renderer 拆 ShellRegistry（小步、行为不变）
 *     - agent-eng          根文件 + CI：B4 清单 glob 化 / B5 测试入口收敛 / B1-eng cli 端口常量
 *  2. 跨包共享协议（agent-shared，串行）：A2 RPC 信封 + cordis insert 单源化（control-plane 提供，desktop 双路径消费）
 *  3. 文档同步（agent-docs，串行）：STATUS.md / desktop README / 设计文档契约修订
 *
 * 所有 agent 只改代码 + 静态自查；父代理在 workflow 返回后统一跑
 * typecheck/test/build 验收，发现问题再派修复 agent（goal continuation）。
 */

const REPO = '/Users/panzeyu2013/Library/Application Support/@dsh-chamber/desktop/state/dsh-home/worktrees/dsh-chamber-b26b76e57655/architecture'
const NODE_BIN = '/Users/panzeyu2013/.nvm/versions/node/v22.22.3/bin'

const reportSchema = {
  type: 'object',
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['filesChanged', 'summary', 'issues'],
  additionalProperties: false,
}

const COMMON = `
工作树：${REPO}（先 pwd 确认）。环境：node/pnpm 在 ${NODE_BIN}（如需要运行命令，先 export PATH="$NODE_BIN:$PATH"）。
仓库背景（必读）：根 AGENTS.md（包边界、正确性不变量、validation 契约）；相关设计文档在 docs/design/；docs/progress/STATUS.md 是唯一进度记录。
纪律：只改你任务范围内的文件（见"不要动"清单）；保持行为完全不变（重构不是功能变更）；删除代码时同步删除其专属测试；新增/删除导出时更新 import；所有修改必须与设计文档契约一致（proxy honesty、SSH 材料永不进 renderer、IPC 围栏语义等不变量）。
验证：如果 node_modules/.bin/tsc 已存在（依赖安装完成），运行相关 typecheck/单测（命令见 AGENTS.md Validation 节）；否则做静态自查——重读你改动的每个文件，核对 import/导出/类型自洽、无残留引用。严禁运行 git 命令。不要修改 vendor/（只读）与 node_modules/。
时间预算：40 分钟内完成核心任务，报告聚焦，不要逐行读无关文件。
报告：filesChanged（你修改/新建的文件相对仓库根的路径列表）、summary（做了什么、验证结果、遗留）、issues（无法完成或有风险的点）。
`

// ───────────────────────── Phase 0 ─────────────────────────

const EXPORTS_PROMPT = `${COMMON}
任务（agent-exports）：在 control-plane 包固定端口常量导出，供后续重构引用。只改 control-plane 包内文件 + 其测试。
1. packages/control-plane/src/index.ts：导出 \`export const DEFAULT_CONTROL_PLANE_PORT = 17500\`（带注释说明是桌面/CLI/前端 URL 的基准默认），\`createControlPlane\` 的 \`options.port ?? 17500\` 改为引用该常量。
2. packages/control-plane/src/spawn-dsh.ts：现有 BASE_DHSPORT=17510（本地实例起始端口）改为导出 \`DEFAULT_DSH_START_PORT\`，包内引用同步。
3. packages/control-plane/test/ 下散落的裸 17510/17500 字面量（m1-dsh-client.ts、protocol.ts、manager-api.ts 等）改为引用上述常量（如无法 import 就用与生产一致的单一常量来源，保持测试语义不变）。
不要动：其他包；index.ts 的静态服务部分（A5 由 agent-cp 处理）；任何行为变化。
完成后确认：pnpm --filter @dsh-chamber/control-plane 相关测试可跑则跑（node packages/control-plane/test/*.ts 各文件），否则静态自查。`

// ───────────────────────── Phase 1 ─────────────────────────

const CP_PROMPT = `${COMMON}
任务（agent-cp）：control-plane 包内四项重构。只改 packages/control-plane/ 下文件。
1. 【A3 死代码删除】packages/control-plane/src/dsh-client.ts：删除 v2 会话运行时遗留——respond（498-558）、openEventStream（573-658）、pendingEnvelope 相关（246-254, 262-289）、PendingCapExceededError、invalidateCapabilities（683-686）、信封观察批次逻辑（147-228 的 pendingTable 缩小为 settle-once 最小表，仅服务 call()）。生产路径只保留 call 与 describeCapabilities。同步裁剪 test/protocol.ts、test/m1-dsh-client.ts 中只测死代码的用例；模块头注释（1-39 行）改写为"v4 仅 unary 客户端"。
2. 【A5-cp 拆静态服务】把 index.ts 内嵌的静态前端服务（约 434-632 行：MIME_TYPES/COMPRESSIBLE_TYPES/gzipCached/acceptsGzip/resolveStatic/readBootManifest/serveStatic/jsonStaticError）拆为独立模块 src/static-serving.ts（导出 createStaticServing 之类纯装配），index.ts 只留装配引用；CSP/安全头常量留在 index.ts 或随模块（保持响应行为逐字节一致）。test/static-serving.ts 改为直接测新模块（可保留整机用例）。
3. 【B6 reaper 测试】packages/control-plane/src/reaper.ts（281 行，三重置信校验/lsof-ss 端口归属/killAndConfirm）当前零测试。新增 test/reaper.ts：覆盖身份不匹配保留、端口归属失败保留、owner 存活保留、孤儿回收、killAndConfirm 序列（SIGTERM→SIGKILL）。reaper 的依赖（ps/lsof/ss 命令）需可注入，若当前不可注入则做最小注入改造（DI seam，不改变默认行为）。
4. 【B1-cp 死导出】catalog.ts 中仅测试消费的方法（save/listConnections/removeConnection/mutate/getSnapshot/snapshotHealth 约 6 个）删除或降级为内部；同步裁剪 test/storage.ts 对应用例；catalog.ts 头部文档中 If-Match/409 协议的承诺同步修正（若 mutate 删除）。
不要动：host-graph-seed.ts 的 cordis insert 渲染/解析（A2 由 agent-shared 统一）；index.ts 的端口常量导出（agent-exports 已做，如未完成则顺带补）；spawn-dsh.ts 的 BASE_DHSPORT 改名（agent-exports 已做）。
验证：node packages/control-plane/test/protocol.ts storage.ts m1-dsh-client.ts host-logs.ts manager-api.ts local-connection.ts spawn-dsh.ts instance-proxy.ts ws-frames.ts static-serving.ts host-graph-seed.ts 以及新增 reaper.ts（node 直跑，需 node>=22.18 类型擦除）。`

const DESKTOP_PROMPT = `${COMMON}
任务（agent-desktop）：packages/desktop/ 三项重构。只改 packages/desktop/ 下文件（新增 wiring 模块文件也在此包）。
1. 【A1 拆 main.ts】main.ts（1839 行，whenReady 约 870 行）按领域抽取 wiring 模块，如 ipc-ssh.ts / ipc-plugin-sync.ts / ipc-settings.ts / ipc-notifications.ts / ipc-update.ts / ipc-open-in.ts / ipc-deep-link.ts（命名可按桌面现状微调），每个导出 register(ctx)（ctx 注入 trustedIpc、transportManager、mainWindow getter、quit gate、drain 队列等依赖）；main.ts 收敛为窗口生命周期 + 退出清理 + wiring 装配的薄引导。trustedIpc 围栏（现 main.ts:1020 附近，签名 (...args:any[])）抽为独立可测函数 createTrustedIpc（语义不变：sender 校验 + ipc_sender_forbidden）。把 drain 队列（pendingIntents/pendingNotificationOpens 相关，约 1792-1837）、close-to-tray 门控、退出状态机（859-970）中可纯函数化的决策抽为纯函数并新增对应单测（仿现有 notifications.test.ts 风格，electron-free）。
2. 【B7 砍投机面】transport-provider.ts：删除 direct-endpoint 模式（buildStartArgs 缺省 direct 分支、probeTarget/endpointUrl、TransportKind 开放联合改收窄、TRANSPORT_KINDS 调整、Ssh* 兼容别名）；transport-manager.ts 中 direct-endpoint 运行时分支（约 618-637、794-798）删除；transport-manager.test.ts 的 direct-endpoint 用例删除或改为验证删除后的契约。**保留 verifyUp 钩子**（ssh 的 host.describe 探测有真实消费）。
3. 【B8 IPC 通道常量】main.ts 约 34 个 ipcMain.handle 通道字符串字面量集中为常量（放 ipc-events.ts 或新 channels.ts）；**preload.cts 受单文件自包含构建约束（build-preload.mjs：运行时 import 会产出死文件），禁止让 preload import 该常量模块**——改为升级 ipc-surface-mirror.test.ts 为字符串级守卫：断言 main.ts 侧 handle 的通道字面量集合与 preload.cts 侧 invoke 字面量集合相等（可扫描源码文本或 import 后收集）。
不要动：ssh-provider.ts 的 RPC 信封构造与 cordis insert 相关（verifyDshEndpoint/probeRemoteMethod/plugin-sync.ts 的 YAML 渲染——A2 由 agent-shared 统一处理，你只做 A1 拆分时必要的搬移，信封逻辑本身保持原样）；根 tsconfig.json / 根 package.json / .github/（agent-eng 管，新增文件如未进根 tsconfig 白名单属预期，agent-eng 的 glob 化会覆盖）。
关键约束：拆分是纯结构性重构——IPC 通道名、消息形状、退出清理顺序（before-quit/will-quit 并行 + 5s 强退）、单飞确认、状态推送门控等语义必须逐字节一致。`

const FRONTEND_PROMPT = `${COMMON}
任务（agent-frontend）：前端插件包 + renderer 非 App 部分。可改：packages/dsh-chamber-client-ui-sidebar/、packages/dsh-chamber-client-ui-settings-bridge/、packages/dsh-chamber-client-ui-settings-connections/、packages/renderer/（除 src/App.tsx 与 src/shell.ts 外）、packages/renderer/vite.config.mjs。
1. 【A4 类型收敛】PluginGraphDiagnostic 类型当前三份定义（sidebar src/shared/aggregate-store.ts:49-56、renderer src/host-graph.ts:33-36、renderer src/vendor-modules.d.ts:267 附近）。收敛为 sidebar shared 单一来源：aggregate-store.ts（或新 shared/plugin-diagnostic.ts）导出，renderer 两处改为从 '@dsh-chamber/dsh-client-ui-sidebar/shared' 导入（host-graph.ts 的 re-export 保留给既有消费方）。若 vendor-modules.d.ts 中声明与真实定义冲突，以真实定义为准删镜像。
2. 【A6 幽灵依赖】settings-bridge（SettingsShell.tsx:30）直接源码深导入 settings-connections 的 ConnectionsSection.tsx，但 settings-bridge package.json 未声明依赖。修复：settings-connections 在 package.json exports 增加稳定导出子路径（如 "./section" → ./src/client/ConnectionsSection.tsx，参考现有 "./client" 形态）；settings-bridge package.json 声明对 settings-connections 的依赖（peerDependencies 或 dependencies，与现有 peer 模式一致）；SettingsShell.tsx 改 import 新子路径；renderer/vite.config.mjs 中该深导入的专用 alias 规则相应更新（若子路径命中现有规则则删除专用规则）；ambient/connections-section.d.ts 同步。确保两个包的独立 typecheck（typecheck:settings-bridge / typecheck:connections）都通过。
3. 【B2 REST 客户端共享化】renderer/src/api.ts 与 settings-connections/src/client/control-plane.ts 是两份同源控制面 REST 客户端（已漂移）。收敛：把客户端（ApiErrorBody/ApiError/controlPlaneUrl/request 及 health/connections/logs 方法面）移入 sidebar src/shared/ 新模块（如 control-plane-client.ts，与 chamberBridge 同层，renderer 与插件都依赖 sidebar/shared 的既有依赖关系成立）；renderer/src/api.ts 改为 re-export 或薄封装（保持 App.tsx 等既有 import 面不变）；settings-connections/src/client/control-plane.ts 改为引用共享模块（其扩展的插件管理方法面保留在 settings-connections 本地或一并共享——按依赖合理性决定）；vite.config.mjs 若需新 alias 则补。注意浏览器端不能 import Node 包，共享模块必须纯浏览器实现。
4. 【B1-fe 前端 URL 常量】renderer/api.ts 与 settings-connections 的 DEFAULT_CONTROL_PLANE_URL='http://127.0.0.1:17500' 随 B2 共享化自然收敛为单一来源（放共享模块）。
不要动：renderer/src/App.tsx、renderer/src/shell.ts（agent-renderer-core 管）；renderer/src/host-graph.ts 的 RPC envelope 实现（仅类型收敛，见任务 1）；desktop/、control-plane/（其他 agent 管）。
验证：pnpm run typecheck:sidebar / typecheck:settings-bridge / typecheck:connections / typecheck:layout / typecheck:open-in / typecheck:git / typecheck:client-web（如依赖已装）；pnpm run test:sidebar / test:settings-bridge / test:connections / test:client-web / test:connection；build:renderer 由父代理统一验证（可跳过）。`

const RENDERER_CORE_PROMPT = `${COMMON}
任务（agent-renderer-core）：renderer 的 N-ctx 编排层小步重构。只改 packages/renderer/ 下文件（重点是 src/App.tsx 与 src/shell.ts，可新建模块文件）。
1. 【A5-renderer】App.tsx（1567 行）与 shell.ts 的 N-ctx 生命周期状态碎片化：shell.ts 模块级单例（bootChain/bootGenerations/cancelledBoots/entries/pendingDisposes/pendingOpens 等）与 App.tsx 的回收 effect（约 398-519 行，手工修剪 14 个并行键空间）无单测。小步重构（禁止重写渲染路径）：
   a. 把回收/驱逐决策逻辑从 App.tsx 的 useEffect 中提出为纯函数模块（如 src/recycle-policy.ts，可测），App.tsx 只做调用；补对应单测（仿 eviction-policy.test.ts 风格）。
   b. 把 shell.ts 的模块级状态收敛为一个显式 registry 对象（如 ShellRegistry 类或 createShellRegistry() 工厂，仍模块级单例但状态封装、方法化），对外行为逐字节不变（boot 串行、cancelledBoots 语义、pendingDisposes 等待、openInstanceSession 排队）。
   c. 顺带修 shell.ts 中 BUNDLE_LOAD_TIMEOUT_MS 在使用（约 81 行）后才声明（约 92 行）的阅读性倒置（把常量移到使用前）。
2. 现有测试必须保持通过：shell.test.ts（经 scripts/test-shell-register.mjs 钩子）、eviction-policy.test.ts、aggregate-refresh.test.ts、pending-open-queue.test.ts、notification-edges.test.ts、host-graph.test.ts。新增纯函数测试按上述 a 步。
不要动：src/App.tsx 的 UI 渲染与视图切换逻辑本身、chamber-entry.ts、host-graph.ts、api.ts（agent-frontend 管）、控制面接口。
关键约束：这是行为不变重构——任何现有测试语义变化都算失败；先跑 test:renderer-shell（如果依赖已装）。`

const ENG_PROMPT = `${COMMON}
任务（agent-eng）：仓库根工程化。可改：根 tsconfig.json、根 package.json、.github/workflows/ci.yml、.github/workflows/release.yml、packages/cli/src/index.ts、packages/control-plane/src/standalone.ts、scripts/ 下脚本（如需要）。
1. 【B4 清单 glob 化】根 tsconfig.json include 目前逐文件白名单 desktop 模块（已漏 4 个测试文件：plugin-sync.test.ts、chamber-settings.test.ts、notifications.test.ts、ipc-surface-mirror.test.ts——它们不在 include 内、仅靠 main.ts 传递覆盖实现文件、测试文件本身完全漏检）。修复：desktop 相关 include 改目录 glob（如 "packages/desktop/*.ts"、"packages/desktop/*.cts"）或补全清单（glob 优先）；packages/desktop/package.json 的 electron-builder build.files 逐文件 13 个主进程文件改 glob（如 "*.ts"、"*.cts" 保留现有排除规则 !node_modules/...、!vendor/**、!scripts/**、!README.md 等，注意排除 *.test.ts 不进包——确认现有 files 是否已含测试文件，若含则 glob 需显式排除 *.test.ts）。
2. 【B5 测试入口收敛】根 package.json 新增 "test:control-plane" 脚本（按 AGENTS.md Validation 节的权威清单：node packages/control-plane/test/protocol.ts storage.ts m1-dsh-client.ts host-logs.ts manager-api.ts local-connection.ts spawn-dsh.ts instance-proxy.ts ws-frames.ts static-serving.ts host-graph-seed.ts，另加 agent-cp 可能新增的 reaper.ts）；.github/workflows/ci.yml 与 release.yml 两处 control-plane 测试清单改为 pnpm run test:control-plane；test:desktop 评估改 node --test 聚合（node --test packages/desktop/*.test.ts，注意 node:test 对 .ts 的支持与现有直跑语义一致，若 node --test 与现有直跑行为有差异则保留直跑但保持清单与 tsconfig 一致）；修正 packages/control-plane/test/m1-dsh-client.ts 头部注释中不存在的 smoke.mjs 引用（改为 test/smoke.ts 与 pnpm run smoke 的实情）。
3. 【B1-eng 端口常量】packages/cli/src/index.ts 的 17500（DEFAULT_URL 与 serve 默认端口）改为 import '@dsh-chamber/control-plane' 的 DEFAULT_CONTROL_PLANE_PORT（若 agent-exports 已完成导出；未完成则自行在 control-plane 导出并同步）；packages/control-plane/src/standalone.ts 的 DEFAULT_PORT=3001 与 cli serve 的默认端口统一为 17500（**这是有意行为变更**：消除双 serve 默认端口不一致，standalone 与 cli serve 统一默认；HELP 文本同步）。
不要动：packages/desktop/*.ts 内容（agent-desktop 管）；ci.yml/release.yml 中除 control-plane 测试清单外的其他内容；packages/cli 的其余逻辑。
验证：pnpm run typecheck（根程序，若依赖已装）、pnpm run test:control-plane、pnpm run test:desktop。`

// ───────────────────────── Phase 2 ─────────────────────────

const SHARED_PROMPT = `${COMMON}
任务（agent-shared）：跨包协议单源化（A2）。这是 Phase 1 之后的串行阶段——Phase 1 已改过 desktop/main.ts（A1 拆分后）与 control-plane（A3 后），你的改动叠加其上。
背景：dsh RPC 信封 {type:'client-request', rpcId, method, payload:{args}} 与 server-response 校验现有三个实现（desktop/ssh-provider.ts verifyDshEndpoint 305-386、probeRemoteMethod 420-497、control-plane/dsh-client.ts call()）；cordis.patch.yml insert 格式（- insert:\\n  - id: X\\n    name: 'Y'）解析/渲染两份实现（desktop/plugin-sync.ts 1034-1269 手写 YAML 子集、control-plane/host-graph-seed.ts 78-93/169-271）。
落地方式（已定，遵守）：
1. 共享实现放 control-plane 包内新增模块：src/rpc-envelope.ts（client-request 信封构造 + server-response 解析校验 + 调用封装，吸收三处公共逻辑；dsh-client.ts 的 call() 改为复用，行为不变）与 src/cordis-inserts.ts（insert 渲染/解析/冲突判定，吸收两处逻辑；host-graph-seed.ts 改为复用，输出格式逐字节一致）。两模块从 src/index.ts 导出。
2. desktop 消费：desktop 打包态不能 import node_modules 里的 workspace 包（Node 类型擦除不覆盖 node_modules；build-control-plane.mjs 把 control-plane/src 编译进 desktop/dist/control-plane/）。仿 main.ts 现有双路径模式（main.ts:147-152：app.isPackaged ? import('./dist/control-plane/index.js') : import('@dsh-chamber/control-plane')）：新建 packages/desktop/control-plane-module.ts 把该双路径解析提升为共享模块（导出 createRpcEnvelope/rpcEnvelope 相关函数与 cordis-inserts 函数），main.ts 与 ssh-provider.ts、plugin-sync.ts 都改为从它取用；main.ts 现有 controlPlaneModule 逻辑收敛进该模块（保持 createControlPlane 导出）。
3. 测试：control-plane 侧新增 rpc-envelope/cordis-inserts 单测；desktop 侧新增或扩展测试断言：desktop 的 insert 渲染输出与 control-plane 的渲染对同一输入**逐字节一致**（跨包契约测试，仿 ipc-surface-mirror.test.ts 的 golden 精神）；ssh-provider 的 verifyDshEndpoint/probeRemoteMethod 改为复用共享 envelope 后原测试（ssh-provider.test.ts）必须保持通过。
4. 顺带：插件侧 renderer/src/host-graph.ts:68 的手写信封若有独立实现且适合复用共享模块，则改为复用（renderer 是浏览器端，若共享模块在 control-plane（Node 包）则不能 import——**这种情况下不改 renderer**，保持其本地实现并加注释指向 control-plane 为权威）。
不要动：Phase 1 已落地的其他内容；信封/YAML 的 wire 形状（逐字节一致是硬约束）；vendor/。
验证：pnpm run typecheck、test:desktop、control-plane 全部单测（node packages/control-plane/test/*.ts）。`

// ───────────────────────── Phase 3 ─────────────────────────

const DOCS_PROMPT = `${COMMON}
任务（agent-docs）：文档同步（Phase 2 之后，所有代码改动已落地）。先读代码确认实际状态再写文档，不要照搬旧描述。
1. docs/progress/STATUS.md：新增一节记录本次架构重构（2026 批次）：完成的项（A1–A6/B1–B10 对应条目简述 + 指向代码位置）、性能/卫生延后项更新（如 SidebarRoot.tsx 2891 行拆分、App.tsx 后续深化、A4 paths 映射远期方案）；若某设计未决项已解决（如响应头白名单双处同步——若本次未动则保留）。
2. 设计文档契约修订（按代码实际变更）：05 §7.6 transport-provider 描述（若 B7 删除了 direct-endpoint/probeTarget/endpointUrl 则删除对应文字，保留 verifyUp）；05 §6/§7 中 IPC 通道与构建链描述（若 A1/A2 改变了模块结构——注意：模块拆分不改变通道名与契约，只在必要时补 wiring 模块说明）；设计 02 §3.3 的 binary 字段语义（若 A3/B1-cp 修了 spawn-dsh.ts 的 binary 字面量则同步文档；未修则注明遗留）。
3. packages/desktop/README.md：IPC 通道表补全（当前停在 22 个通道，缺 settings/system-resume/notifications/open-in/deep-link/update 族）或改为"以 design 05 §7.4 为权威，本文不重复维护通道清单"的指针式表述（推荐后者，避免再次漂移）；模块地图补 chamber-settings/plugin-sync/deep-link/open-in/notifications/ssh-config/renderer-trust（若 A1 拆分后模块结构变化，按新结构写）。
4. 若 A2 新增了共享模块（control-plane rpc-envelope/cordis-inserts、desktop control-plane-module）：在 AGENTS.md 的 Runtime Boundaries 相应包条目补一句职责描述（**只补描述，不改变边界文字**）。
不要动：vendor/、docs/design/ 中未受影响的文档；代码文件。`

// ───────────────────────── 执行 ─────────────────────────

phase('常量导出基线（Phase 0）')
log('启动 agent-exports：control-plane 端口常量导出')
const exportsResult = await agent(EXPORTS_PROMPT, { schema: reportSchema, label: 'agent-exports', phase: '常量导出基线' })

phase('并行包重构（Phase 1）')
log('并行启动 5 个包重构 agent（文件集互不重叠）')
const phase1 = await parallel([
  () => agent(CP_PROMPT, { schema: reportSchema, label: 'agent-cp', phase: '并行包重构' }),
  () => agent(DESKTOP_PROMPT, { schema: reportSchema, label: 'agent-desktop', phase: '并行包重构' }),
  () => agent(FRONTEND_PROMPT, { schema: reportSchema, label: 'agent-frontend', phase: '并行包重构' }),
  () => agent(RENDERER_CORE_PROMPT, { schema: reportSchema, label: 'agent-renderer-core', phase: '并行包重构' }),
  () => agent(ENG_PROMPT, { schema: reportSchema, label: 'agent-eng', phase: '并行包重构' }),
])

phase('跨包共享协议（Phase 2）')
log('启动 agent-shared：RPC 信封 + cordis insert 单源化')
const sharedResult = await agent(SHARED_PROMPT, { schema: reportSchema, label: 'agent-shared', phase: '跨包共享协议' })

phase('文档同步（Phase 3）')
log('启动 agent-docs：STATUS.md + 设计文档 + README 同步')
const docsResult = await agent(DOCS_PROMPT, { schema: reportSchema, label: 'agent-docs', phase: '文档同步' })

const failed = [exportsResult, ...phase1, sharedResult, docsResult].filter((r) => r === null)
return {
  phase0: exportsResult,
  phase1: {
    cp: phase1[0],
    desktop: phase1[1],
    frontend: phase1[2],
    rendererCore: phase1[3],
    eng: phase1[4],
  },
  phase2: sharedResult,
  phase3: docsResult,
  failedAgentCount: failed.length,
  note: '验证（typecheck/test/build）由父代理在 workflow 返回后统一执行；failedAgent 需父代理补派。',
}
