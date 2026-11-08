# 25 · macOS Swift 原生壳（WKWebView + Node sidecar 全复用，唯一出货 flavor）

> **现行契约**：dsh-chamber 唯一出货 flavor = macOS Swift 原生壳（`macos/` + 打包 Node sidecar）。Electron flavor 已冻结归档（[electron-frozen.md](../../progress/electron-frozen.md)）——**本设计只维护 Swift 腿**；正文中裸写的 `main.ts` / `electron-edges.ts` / `preload.cts` 均指归档后的 `packages/desktop/electron/` 同名文件，只作共享契约与历史映射参考。
> **形态**：Swift/AppKit 只做壳（窗口、WKWebView、菜单/托盘/通知/角标/深链/对话框/外部打开），壳内不承载业务；业务 = control-plane + desktop 纯 Node 模块，打包为 sidecar 子进程（B 桥 stdio JSON-RPC）；Web UI 100% 复用，仅把 preload 的 `window.dshChamber` 换成 shim（A 桥）。
> **相关契约**：[05-connection-manager.md](../control-plane/05-connection-manager.md) §7.4（IPC 白名单）/§7.5（本地实例）、[electron-frozen.md](../../progress/electron-frozen.md)（冻结面）、[11-auto-update.md](../archive/11-auto-update.md)（Electron 更新腿归档参考）、[14-sleep-background.md](../runtime/14-sleep-background.md)、[16-vscode-deeplink.md](../desktop/16-vscode-deeplink.md)、[17-server-side-gateway.md](../gateway/17-server-side-gateway.md)、[18-dsh-runtime-version.md](../runtime/18-dsh-runtime-version.md)（含 apply-now）、[19-notifications.md](../client/19-notifications.md)、[20-open-in-registry.md](../desktop/20-open-in-registry.md)、[21-gateway-plugin-parity.md](../gateway/21-gateway-plugin-parity.md)、[24-archived-session-cleanup.md](../plugins/24-archived-session-cleanup.md)。§5.3 原生席位 = `macos/Sources/DSHChamber/NativeText.swift#NativeTextKey`（文案键表）与 `#NativeText`（取值链）+ `macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFacts`（页面语言/主题事实载波）。
> **架构决策**见 [ADR-0002 swift-only-flavor](../decisions/0002-swift-only-flavor.md)。

## 0. 摘要

- **可行性**：见 §2（复用面、控制面握手、Node 进程与 A 桥计数的前提事实）。
- **不做**：不重写 UI（全原生 UI = 3–6 人月 + 永久上游 parity 维护）；不在 Swift 重写宿主服务（自研 desktop-host = 路线 B）；不碰 gateway。

## 1. 目标与非目标

### 1.1 目标

1. macOS 上交付与 Electron 版功能对等的原生应用（原生窗口/菜单/Dock/通知/深链/系统集成），去掉 Electron/Chromium 运行时。
2. **零业务重写**：control-plane、desktop 纯 Node 模块、dsh-runtime 及其测试原样进 sidecar；现有单测/镜像测试继续跑同一 JS 代码面。
3. 单一业务源码：两 flavor 共享同一份 core（main.ts 拆分为前提），行为差异只允许出现在宿主边沿适配层，且有镜像测试与双端冒烟背书。
4. 信任模型不弱化：B 桥语义校验仍在 sidecar，Swift 只做传输层护栏；凭据依旧 write-only、永不进 renderer。

### 1.2 非目标（明确不做）

- 不重写任何 Web UI/插件（renderer、dsh 官方前端、chamber 插件面）。
- 不做 Swift 原生 UI 渐进替换（路线 B/C，按 [ADR-0002](../decisions/0002-swift-only-flavor.md) 单独评估）。
- 不做第二个 gateway、不进匿名控制面的执行域（根 AGENTS.md 硬纪律）。
- 不做 Sparkle 全自动安装之外的更新路径（§7 为现形）。

## 2. 关键设计前提（复用可行性）

- **Electron-free 复用面**：真实依赖 Electron 仅 `main.ts`、`electron-edges.ts`、`preload.cts`、`updater.ts`（清单以 `electron-free-gate.test.ts` 的登记为准）；其余纯 Node 模块零 import、测试直接 `node *.test.ts` 可跑（`electron-free-gate.test.ts` 传递闭包断言）。
- **控制面握手**：`createControlPlane(options)` 作为 sidecar 内的唯一控制面构造入口（§3.1 的 core 拆分前提）。
- **dsh 实例是 Node 进程**：`spawn-dsh.ts` → `process.execPath`；Swift 单 Node 的捆绑基名表 = `{node,node.exe}`，payload 的 `primary-runtime/dependencies/node/bin/node` 直用（§4.3）。
- **A 桥计数不手抄**：通道数与命名空间成员数以 `bridge-manifest.json` 的 `counts` 与 preload 暴露面为准（§4.4.3）。

## 3. 总体架构

### 3.1 进程模型

```text
┌─────────────────────────────────────────────────────────────┐
│ Swift 应用进程（macos/ 壳）                                   │
│  AppDelegate / MainWindowController                          │
│  WKWebView ── A 桥（注入 shim ↔ WKScriptMessageHandler）      │
│  原生边沿：菜单/托盘/UNUserNotificationCenter/角标/           │
│            NSWorkspace(open-in/外链)/NSOpenPanel/NSAlert/     │
│            SMAppService(登录项)/深链 application(_:open:)     │
│  SidecarSupervisor（spawn/守护/重启/日志/fatal 分流）          │
└───────────────┬─────────────────────────────────────────────┘
                │ B 桥：stdin/stdout 行式 JSON-RPC（受信，本机）
┌───────────────▼─────────────────────────────────────────────┐
│ sidecar 子进程（打包的 Node + JS bundle，纯 Node 无 Electron）│
│  = main.ts 拆分出的 core（§4.1）                             │
│    transport-manager / ssh-provider / gateway-provider/…     │
│    invoke 处理器（含 info）+ push 事件源（数量以 manifest    │
│    counts 为准）                                             │
│  + control-plane（createControlPlane，loopback HTTP/WS）      │
│  + dsh-runtime / pnpm（运行时版本管理、安装）                 │
│  + 数据面：userData/{state, ssh-instances.json,              │
│    ssh-passwords.json, gateway-secrets.json,                 │
│    chamber-settings.json, audit-log.jsonl, dsh-runtime trees,│
│    日志}                                                     │
└───────────────┬─────────────────────────────────────────────┘
                │ spawn（resolveNodeExecutable 纯 Node 分支：payload node，基名 node）
        ┌───────▼────────┐        ┌──────────────────────┐
        │ dsh web profile │  …N 个  │ 远程宿主（ssh/gateway） │
        │ 实例（Node）     │        │ 经系统 ssh / HTTP      │
        └────────────────┘        └──────────────────────┘
```

- **Swift 壳**不 import 业务模块，只是「边缘执行器 + 传输层护栏 + 窗口」；业务状态全在 sidecar。
- **sidecar** = 打包产物，传输恒为 **stdio**（未实现的 `--socket` 不作接口面）。启动命令 = **payload Node**：`<sidecar>/primary-runtime/dependencies/node/bin/node <sidecar>/sidecar.js`（单 Node：没有独立的 `dsh-chamber-helper`）。实参同 `sidecar-entry.ts`：`--user-data-dir <dir> [--dsh-path <dir>] [--web-dist-dir <dir>] [--host-graph-dir <dir>] [--host-git-dir <dir>] [--host-archive-dir <dir>] [--host-open-in-dir <dir>] [--port <n>] [--native-updater <feed|off>]`（pnpm/host 路径由内部布局解析，无 `--pnpm-dir`）。stdout/stderr 不混业务：**入口把存量 console.log/console.debug 重定向到 stderr**（main.ts 业务日志如端口行、will-quit 完成串——实机门禁断言该串），否则 B 桥首发即撞非协议行；

  fail-loud 只针对重定向后泄漏；stderr 是唯一日志通道（`~/Library/Logs/` 或 userData/logs）。**sidecar stderr 透传行另有独立有界落盘** `<userData>/logs/sidecar.log`（`ShellLog.sidecar.configureSidecar` + `BridgeClient.sidecarLogSink`；规格：单文件 256 KiB、单份轮转 `sidecar.log.1`（名按实例文件名派生）、目录 0700 / 文件 0600、写失败静默退 stdout——同 [02-host-management-deployment.md](../runtime/02-host-management-deployment.md) §3.8 控制面 sink 的权限纪律、保留量更小）。**壳自身日志** `<userData>/logs/shell.log`（`ShellLog.shared`，同 256 KiB / 单份 `.1` / 0700-0600）记启动、sidecar spawn/退出、导航失败、更新相位与退出链关键行（经 `shellLog` 同写）。

  **两链关系**：控制面 `<stateDir>/logs/control-plane.log` 是 WS splice 归因行的权威去向（两 flavor 都有，`createControlPlane` 无条件包装，02 §3.8）；`sidecar.log` 是原生壳兜底（覆盖控制面 sink 建立前的 stderr，如 fatal 启动输出；同批 console 行存两份）。**flavor 偏差（已登记 deviations）**：Electron 1 份 `control-plane.log`（2 MiB × 3 = 6 MiB），原生壳 2 份（另有 `sidecar.log` 256 KiB × 2 轮转环 = 512 KiB），合计 6 MiB + 512 KiB。
- dsh 实例与控制面关系不变（05 §7.5：`PlaneHandle.startLocal()` 预启动、按需 spawn、reaper）；**迁移后 dsh 子进程 Node = sidecar 自身可执行文件**（即 payload Node `primary-runtime/dependencies/node/bin/node`；`spawn-dsh` 经 `process.execPath` 直用，§3.3）。
- **资源路径注入**：Swift 无 isPackaged/resourcesPath 概念，sidecar-entry 以参数注入 .app 内路径：builtin dsh workspace（`Resources/sidecar/vendor/dsh`）、webDistDir（**Resources/dist/web**，由 AppDelegate 按候选解析：resourceURL/dist/web → sidecar/dist/web）、四个宿主包 sourceDir（`Resources/sidecar/dist/<pkg>`；含 localOnly 的 open-in）、pnpm（`Resources/sidecar/pnpm`；sidecar-ctx 探测 moduleDir/pnpm → moduleDir/../pnpm → dev node_modules/pnpm）。对应 main.ts 约 15 处直拼点的参数化（§3.1）。

### 3.2 仓库落位与打包

```text
macos/                          # SwiftPM 可执行包
  Package.swift
  Sources/DSHChamber/…        # 可执行 target（AppKit 壳 + A/B 桥 + 宿主腿同 target；
                                 #  product 化拆 target 未排期，见 Package.swift 头注释）
  Sources/DSHChamberWebKitSupport/… # 静态 C support target（§5.1：关 WebKit prefer-60fps 偏好）
  Sources/DSHChamber/Generated/BridgeManifest.swift   # 构建脚本生成（随提交，防漂移）
  Tests/…                        # XCTest（信封解析、护栏、监督、协议）
  Resources/bridge-shim.js   # A 桥注入 shim 真身（bridge-shim-surface 锁步）
  Resources/chamber-bridge.stub.js # manifest 生成物（锁步样本，不随 .app 打包）
  Info.plist.template / entitlements*.plist # 渲染/签名输入
macos/scripts/build-swift-app.mjs       # 调 pnpm 产物 + swift build + 资源装配
packages/desktop/scripts/build-sidecar.mjs  # sidecar 装配
packages/desktop/scripts/emit-bridge-manifest.mjs # IPC 通道 manifest → Swift 枚举 + stub 锁步样本（§4.4.3）
```

- sidecar 的 JS 面不动仓库布局：`packages/desktop` 仍是宿主核心包（Electron entry `main.ts` 保留为冻结归档（`packages/desktop/electron/main.ts`），不随默认开发演进；`sidecar-entry.ts` 及 host-edge 适配见 §4.1）。sidecar 打包布局 = **编译产物 `dist/control-plane/` + host 包 `dist/dsh-chamber-seed-*/` + 内嵌 `vendor/dsh/` 与 `pnpm/` + `primary-runtime/`（全量 payload：node/pnpm/python）+ `office-skills/`**；renderer 产物 `dist/web` 属 .app 的 `Contents/Resources/dist/web`（不在 sidecar 目录内）。复用 build-control-plane.mjs 的「双路径解析」（打包态 import 编译产物、dev/测试走 pnpm 符号链接，`control-plane-module.ts` 注释）——sidecar 与 Electron 共享 `packages/desktop/dist/control-plane`；**host 包不同源**：Electron 走 `build-host-graph-package.mjs` 产的 `dist/host-*-package`，sidecar 直接读 `packages/dsh-chamber-seed-*/{package.json,dist/index.js}` 拷进自己的 `dist/dsh-chamber-seed-*/`（两条腿别混目录名）。
- **装配目录**（`packages/desktop/scripts/build-sidecar.mjs` 的 `sidecarLayout`）：`<out>/{sidecar.js, package.json, dist/control-plane/, dist/dsh-chamber-seed-*/, vendor/dsh/, pnpm/, primary-runtime/, office-skills/}`。要点：`sidecar.js` = esbuild 入口（shell-core 全家 + sidecar-ctx + node-edges + dsh-runtime）；`@dsh-chamber/control-plane`、`electron` 与 `./dist/control-plane/index.js` 为运行期外部；装配目录必须带 `package.json`（`{type:'module'}` + chamber 版本）——shell-core 模块级 `version` 读取（`new URL('./package.json', import.meta.url)`）与 ESM 判定依赖它。
- **四个 chamber host 包**（`packages/dsh-chamber-seed-{client-graph,git-worktree,archive-cleanup,open-in}`）：拷贝进 `<out>/dist/<同名>/`，Swift 侧按 `--host-graph-dir/--host-git-dir/--host-archive-dir/--host-open-in-dir` 注入同一基名（`BuildSidecar.HOST_PACKAGES` 单源；`sidecar-ctx` 的 `hostPackageSourceDir` dev 兜底按同名在 `packages/` 探测）——`scripts/release/preflight/packaging-manifest-lockstep.test.mjs` 在 build-sidecar / control-plane / 根构建链 / `HOST_PACKAGE_BUILD_ROWS` / AppDelegate 五处锁步，改名/加包要一起改。
- **open-in 是 localOnly 行**（[20-open-in-registry.md](../desktop/20-open-in-registry.md) §6）：随 .app 分发、只喂本地实例播种（`sidecar-entry --host-open-in-dir` → control-plane 的 `hostOpenInPackageSourceDir`）；远端（SSH）种子表永不携带它（`sidecar-ctx` 远端种子仍三项可移植行，`portableChamberHostPackageSeeds` 按 registry 的 `localOnly` 过滤，与 Electron 侧 `chamberHostSourceDirs` 同源）——加进远端 seed 会把本地形态专属域上传到别人的机器。
- **运行期标记**：Swift Supervisor 装配态 spawn 注入 `DSH_CHAMBER_SIDECAR_COMPILED=1`（`control-plane-module.isPackagedSidecarRuntime`）→ control-plane 走相对编译入口；装配目录无 node_modules，裸说明符不可解析。
- **单 Node（无 dsh-chamber-helper）**：装配内唯一的 Node 在 `primary-runtime/dependencies/node/bin/node`（payload 的 node 半边；路径单源 = `scripts/lib/sidecar-assembly.mjs` 的 `PAYLOAD_NODE_RELATIVE`/`payloadNodePath`）。装配目录顶层没有 `node`/`dsh-chamber-helper`；`build-sidecar` 在开工时清理这两个旧布局产物，`build-swift-app` 对顶层 `node`/`node.exe`/`dsh-chamber-helper` 旧布局条目一律 loud（fail-closed）。Node 版本与 sha256 的唯一来源 = `primary-runtime-lock.json` 的 `nodeVersion`/`nodeSha256`（随 payload 下载校验；sidecar 不再有独立 pin，§3.3）。
- **payload（`primary-runtime/`）**：`runtime.json` + `dependencies/{node,pnpm,python}`，由 `prepare-python-payload --with-node --with-pnpm` 生成（`--with-pnpm` 隐含 `--with-node`；默认仍 python-only，Electron/gateway 现行为不变）。`--require-python`/`--require-node`/`--require-pnpm` 三个门各自 fail-closed；`--skip-node` 只表达「本次不要求 payload node」（dev/CI 的 compiled-sidecar smoke 用调用者 node 启动 sidecar.js）。pnpm = 构建机 `node_modules/pnpm`（版本单源 = desktop `dependencies.pnpm`）整包拷到 `dependencies/pnpm`，按目标 platform/arch prune 外平台原生包，入口 `bin/pnpm.mjs`。
- **office-skills/**：8 个 markdown（7×SKILL.md + `office/references/sidecar.md`），与 primary-runtime 平级；`--require-office-assets` 缺件 fail-closed。Office 能力只在本地 Swift 实例提供（范围裁决：Electron flavor 不接线、Electron 发布腿与 ci.yml 排练不做 Office 改动），故只有 Swift 装配链携带该目录；仓库内 `packages/desktop/resources/office-skills/` 只是构建期落点（.gitignore 忽略资产、只提交 README）。
- **.app 装配**（`macos/scripts/build-swift-app.mjs`）：`<App>.app/Contents/{Info.plist, MacOS/dsh-chamber, Resources/{icon.icns, DSHChamber_DSHChamber.bundle, sidecar/, dist/web}}`。约束：**SwiftPM 资源包必须放 `Contents/Resources`**（放 .app 根会被 codesign 判为「unsealed contents present in the bundle root」；`Bundle.module` 只查 `Bundle.main.bundleURL` 与构建目录，打包态改用 `ChamberResources`（resourceURL → bundleURL → 可执行目录））；**entitlements plist 不能带 XML 注释**（codesign 的 AMFIUnserializeXML 解析失败）；壳侧最小集 = `disable-library-validation`（加载装配目录内独立签名的 payload Node 与运行时安装的未签名原生模块）；payload Node 另加 `allow-jit` / `allow-unsigned-executable-memory`（`entitlements.node.plist`，`build-swift-app` 按精确路径 `isBundledPayloadNode` 给嵌套签名）。
- **LibreOffice kit helper 的签名面**：vendor 运行时线里的原生 helper（`<sidecar>/vendor/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-<arch>/bin/libreoffice-kit`）只带 `com.apple.security.cs.allow-jit` 一项权限（`macos/entitlements.jit.plist`；`build-swift-app` 按精确路径给嵌套签名，签名后立即用 `codesign -d --entitlements` 核验、缺失 fail-closed，与上游 desktop 的 `jit-entitlements.plist` 同口径），其余嵌套 Mach-O（`.node`/`dylib` 与除该 helper 外的引擎内二进制）保持裸 hardened runtime。理由：LibreOffice 的 C++/binary UNO bridge 运行期生成机器码（上游 `sysui/desktop/macosx/hardened_runtime.xcent.in` 注释即此；上游 `fix(desktop): unpack and verify native Office conversion` 提交为对拍依据——历史证据 `54d46ad4d4`，不随本仓 pin 移动）。缺该权限时 helper 在引擎引导即 SIGTRAP 后 SIGABRT，CLI 报 `LibreOffice helper returned an invalid response`。
- **构建期引擎断言**：`build:sidecar` 在拷贝 `vendor/dsh` 前对运行时清单做 fail-closed 断言——运行时闭包带 `@deepseek-ai/libreoffice-kit` 时，目标平台引擎包必须在场（linux 目标为 `libreoffice-kit-wasm`；darwin/win32 为 `libreoffice-kit-<platform>`，其 `prebuilds.json` 的 `engine.executable` 是实际可执行面），缺引擎即失败（G39；判据 = `build-sidecar` 的 G39/G39b 用例）。
- **control-plane 只能经 `control-plane-module` facade 取**：装配目录无 node_modules，裸说明符 `@dsh-chamber/control-plane` 会 `ERR_MODULE_NOT_FOUND`；facade 在装配态加载 `<sidecar>/dist/control-plane/index.js`。
- **签名顺序** = 嵌套 Mach-O（payload Node、LibreOffice kit helper、.node/dylib）→ 嵌套 bundle（Sparkle / LibreOfficeDev.app 等，由深到浅）→ 主 app；Developer ID 带 hardened runtime（公证前置），ad-hoc 不带。正式发布前置 = Apple Developer ID 凭据（签名/公证）。

**Rejected alternatives（LibreOffice kit helper 的权限面）**：① helper 裸 hardened runtime——引擎在 UNO bridge bootstrap 阶段崩溃（SIGTRAP → SIGABRT），否；② 给 helper 复用 `entitlements.node.plist`（`allow-jit` + `allow-unsigned-executable-memory` + `disable-library-validation`）——权限面大于需要，也与上游「helper 只带 JIT」的判据相悖，否；③ 只给 `disable-library-validation`——helper 不加载未签名库，缺的是 JIT，不解决引导崩溃，否。结论 = 只给 `com.apple.security.cs.allow-jit` 一项。

### 3.3 启动序列（状态机）

1. Swift `applicationDidFinishLaunching`：解析 argv/深链 → 计算 userData dir（§6.1）→ **目录锁**（§6.3）→ 启动 SidecarSupervisor；启动链 reconcile `<userData>/chamber-settings.json` 的 `keepAwake`（缺文件 = off 且无日志、损坏 = loud + off、合法 = 经与 settings UI 同一个 `setKeepAwake` 宿主腿应用；`AppDelegate.swift#=literal:StartupSettings.apply(StartupSettings.readKeepAwake` / `StartupSettings.swift`）。同一处按持久值 reconcile `debug.enabled`（§5.1.1：缺文件 = 不动作且无日志；文件级损坏 = loud + 不动作；合法文件——含缺 debug 键的——按文件值经同一个 `setDebugMode` 腿应用），回读暂存，等 sidecar ready 帧后再上报。
2. Supervisor：spawn `<sidecar>/primary-runtime/dependencies/node/bin/node <sidecar>/sidecar.js`；sidecar 完成 Electron 版 main.ts 的启动职责（目录锁在 sidecar 内复验但不二次 flock）→ `createControlPlane`（**端口由 Swift 解析后以 `--port` 注入**：打包态固定 17500、无退避，EADDRINUSE 即 loud 失败；dev 态按 `DSH_CHAMBER_SHELL_PORT` > `DSH_CHAMBER_CP_PORT` > 17520 起 bind 探测首个空闲端口（200 个候选；`ControlPlanePort.swift`）；**dsh 实例端口从 17510 起 +1 ≤5 次**——05 §3.3 注）→ 输出 **ready 帧最小化 {port, shellVersion}**（其余身份字段走既有 `dsh-chamber:info`，保留其 10×50ms 重试与 null 兜底，防双源漂移）→ 异步启动尾部 `runStartupTail` 内 pre-spawn 本地实例（**绝不使 ready 帧延迟**；与 main.ts 同序——`controlPlane.start()` → 建窗/ready → `runStartupTail()`）。**overlap 只在 Electron 腿成立**：main.ts 不等本地 dsh，spawn 与页面加载重叠；Swift 腿的首帧被 (3) 的就绪门挡住（`starting`/`restarting` 期间不导航），首次冷启 = 等整段 runtime 安装收敛，**Swift 腿不重叠**。等待期深链不丢：`DeepLinkBuffer`（RendererRecovery.swift）有界暂存到 ready，`handleSidecarReady` 的 `markReady()` 按序补发；也没有 host 侧 ready 超时会被这段等待耗尽（门只消费控制面相位、深链缓冲只有容量上界，两者都无期限）。
3. Swift 收到 ready → 以 `/health` 做首载门；HTTP 2xx 后继续检查 `dsh.status`，分三类：**在途相位**（只有 `starting`/`restarting`）与**事实缺失**（2xx 但 `dsh.status` 缺失/不可解析/为空，按「还没到」等待、绝不读成终态）都按有界退避节拍持续探测、不先渲染半初始化的会话 UI——退避 0.5→5s（0.5s 起 ×2 递增、单步封顶 5s），独立计数、**不消耗 `navRetries`**；**静止相位**立即载入（`ready` → 应用；`stopped`/`error`/`degraded`/`restart-exhausted` 以及词表外的未知词 → 控制面，以开放诊断与恢复入口）。壳不设等待总期限：收敛由控制面状态机负责（在途相位必然终止于静止态），壳只消费静止态，时间只有一个所有者。事实缺失分支只在 2xx 来自非控制面时才可达：控制面 `/health` 恒带 `dsh.status`（`getHealth`），端口由 sidecar 独占、EADDRINUSE 即 loud fatal，故它是对陌生 2xx 的防御性等待，正常路径不经过。A 桥注入时机见 §4.4.1 D1。
4. 运行时故障分级：
   - sidecar 崩溃/非零退出 → Supervisor 按重启退避重启（**无 Electron 先例，退避语义另立**：cp.start 失败 = fatal 退出；运行中崩溃 = 退避重启，上限与 renderer 恢复参数化同族）；fatal 边界 = stderr 记录 + 非零退出码分级（启动失败 vs 崩溃），Supervisor 据码分流 NSAlert 文案。
   - WebView 进程终止 → `webViewWebContentProcessDidTerminate` 恢复循环 + ready 位复位 + in-flight requeue（§5 E19 三事件映射，对照 `installRendererRecovery`：500ms 延迟重载、**60s 滚动窗口内至多 3 次**、15s unresponsive 探测——Swift v1 无 unresponsive 事件，该腿不可移植或换心跳探测）；重复崩溃 → NSAlert 停止自动恢复。**5×500ms 是 renderer-ready 握手（deep-link-ready/notifications-ready）重试语义（05 §7.4），不是崩溃恢复——勿混用**。
   - 退出链复刻 before-quit/will-quit（§5 E9/E12/E20）：确认-取消-重建三分支（mac close-behavior='quit' 时窗口已关 → 取消后重建）、keep-awake 停 → badge 清 → 并行回收（传输层 → 控制面 → 本地 dsh 实例 → runtime 资源）→ **5s 硬顶强退**（Swift terminate 超时 = exit(_:)）；「本地实例在跑」判据 = cp.localProcessAlive + LOCAL_RUNNING_STATES 同款，勿只看 connectionState。
5. SIGTERM/SIGINT：Swift 捕获后转 `terminate` 优雅路径；sidecar 自身也处理信号——纯 Node 下 `process.on('SIGTERM')` 真实可达（Electron 43 下是死代码）。

**Rejected alternatives（首屏就绪门）**：只等 sidecar ready 帧或 `/health` 2xx 会把「控制面开始监听」误当成「本地 dsh 已 ready」，因为 `runStartupTail()` 有意异步启动本地实例；对所有状态无限等待又会把终态错误的诊断/恢复 UI 一并藏掉（`stopped`/`restart-exhausted` 正是「重试已停止、需手动启动」的终态），因此只等待**在途状态与事实未达**，其余一律呈现；也不再给等待加第二个时间所有者（壳侧总期限会把控制面已经在管的事再管一遍，并让「超时之后显示什么」变成新的兜底）。

## 4. 复用与拆分（核心工程）

### 4.1 main.ts 拆分：core / host-edge 契约

现状：`main.ts` 已拆为纯编排；业务装配与 Electron 边沿调用分别在 `shell-core.ts` / `host-edges.ts` / `host-assembly.ts`（行数预算见 `scripts/gates/registry/file-budgets.json`）。拆分原则：**只做搬运与参数化，不改语义、不重排状态机**。目标形态：

- `shell-core.ts`（Electron-free）：原样搬入全部业务装配、invoke 处理器体（含 info）+ 事件源（语义校验原地保留）、退出状态机、深链 intent 队列、通知 click 有界 ACK 队列/去重/限速（notifications.ts 纯逻辑 + main.ts 队列语义）、资源路径参数化收口。
- `HostEdges` 依赖注入面（下述）。判定标准：core 对 `electron` 零 import（CI lint 门禁，electron-free-gate.test.ts）；Electron 版全部桌面测试继续绿。
- `electron-edges.ts`（Electron flavor，归档）：HostEdges → Electron API。**Electron 应用菜单现状 = 未自定义（默认菜单含 Edit role，Cmd+C/V 靠它）**——保持不动。
- `node-edges.ts`（Swift flavor）：HostEdges → B 桥（Swift 执行边沿）。

HostEdges 落定契约（字段语义与实现一一对应）：

```ts
// 落定契约（packages/desktop/host-edges.ts，逐成员 doc 注释）
interface HostEdges {
  // 渲染器投递（单窗身份，返回 false = 当前无存活主窗）
  rendererPush(channel: string, payload: unknown): boolean
  // 原生显示/系统集成
  showNativeNotification(spec, clickRoute): {
    dispose(): void
    shown: Promise<{shown:true} | {shown:false; error:string}>
  }
  notificationSupported(): boolean
  setBadge(count: number): HostSetBadgeResult                  // 判别形态
  badgeCountApiAvailable(): boolean
  trayAvailable(): boolean
  setKeepAwake(on: boolean): void
  onSystemResume(cb: (ts: number) => void): void
  onMainWindowShown(cb: () => void): void                    // held-resume 补发点
  isFocused(): boolean
  focusMainWindow(): Promise<void>                            // 通知 click 激活腿
  webViewLoading(): boolean                                   // 渲染器可用性门
  webViewContentAlive(): boolean
  mainWindowAlive(): boolean                                  // 渲染器可用性门族
  retireNotificationsForSources(ids: ReadonlySet<string>): number // 通知 registry 私有
  // 打开/拉起
  openExternal(url: string): Promise<void>                    // 预算/冷却/规范化在 core
  openPath(p: string): Promise<void>
  showItemInFolder(p: string): void
  launchApp(appId: string, path: string): Promise<boolean>    // 契约保留；两 flavor 均无实现（S-05：等第一个消费者）
  showError(title: string, detail: string): void
  showMessage(opts: HostMessageOptions): Promise<number>      // buttonId 收敛为 number
  // 系统/身份/资源
  setLoginItem(enabled: boolean): void
  isPackaged: boolean                                         // 能力位
}
```

> 注：`showNativeNotification` 带 `clickRoute` 并返回 `{dispose, shown}`；`setBadge` 判别形态、`showMessage` 归 number；`desktop_pick_directory` 在 `IPC_CHANNELS`（通道计数以 `bridge-manifest.json` 的 `counts` 为准）与 preload 中均不存在。宿主对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification、淘汰=evicted.close()）留 electron-edges，core 只持有界 ACK 队列/去重/限速。
> **`notifyClicked` 与 `resolveResource` 已作为零消费者死契约删除**（`host-edges.ts` 头注：Swift 对经 `notify` 到达的 clicked 判 unexpected 并 loud 忽略；resources 推送无人消费，未知事实键按前向兼容忽略）。零 core 消费者的保留面（`isPackaged`、`trayAvailable`、`focusMainWindow`、`launchApp`、同步 `setKeepAwake`/`setLoginItem`——settings 路径走装配 ctx 的 async 叶）为有意保留。

### 4.2 复用清单

| 资产 | 规模（非测试行） | Electron 依赖 | 去向 |
|---|---|---|---|
| control-plane（含 proxy/ws/静态伺服/seed/reaper） | 约 14.2k | 无 | sidecar 原样（编译产物复用 build-control-plane 模式） |
| dsh-runtime | 约 11.5k | 无 | sidecar 原样 |
| transport-manager / ssh-provider / gateway-provider / gateway-session(+refresh) / plugin-sync / connection-save / ssh-config / notifications(裁决) / deep-link(解析) / audit-log / badge(裁决) / chamber-settings / dsh-runtime-controller / apply-now / disk-evidence / 凭据文件事务族 / sidecar-ctx / shell-core | 零 Electron import（electron-free-gate.test.ts 传递闭包断言） | 无 | core 原样 |
| open-in（分类/校验）+ 本地拉起 | 纯逻辑 | 拉起点在 edges | 决策全在 core；本地拉起由实例内 host 包 `openInApp/*` 负责，壳不实现 launchApp（S-05） |
| main.ts 编排 + electron-edges + preload + updater | 以仓库实测文件行为准（`wc -l` 四文件之和） | **4 文件，全部** | 拆分；updater 走 §7 |
| ipc-events.ts IPC_CHANNELS + ipc-surface-mirror 测试 | — | — | manifest 单源（§4.4.3），不动 |
| 资源/打包路径直拼点 | main.ts 残余直拼点（builtin dsh / pnpm / webDistDir / 图标等） | 部分 | 参数化进 HostEdges.resolveResource |

### 4.3 Node 运行时分发（sidecar 的运行时底座）

- **单 Node（payload）**：Swift flavor 只有一份 Node——primary-runtime payload 的 `dependencies/node/bin/node`（payload 形状见 [18-dsh-runtime-version.md](../runtime/18-dsh-runtime-version.md)）。sidecar.js 由它启动（`<sidecar>/primary-runtime/dependencies/node/bin/node <sidecar>/sidecar.js`），托管 dsh 实例使用同一 `process.execPath`（`spawn-dsh.ts#resolveNodeExecutable` 的纯 Node 分支对基名 `{node,node.exe}` 直用，否则才回落 PATH/knownNodeLocations）。路径单源 = `scripts/lib/sidecar-assembly.mjs` 的 `PAYLOAD_NODE_RELATIVE`/`payloadNodePath`；没有独立的 `dsh-chamber-helper`，`build-sidecar` 也不再有第二份 Node 下载/摘要表。
- **版本与完整性**：Node 归档版本/`sha256` 唯一来源 = `packages/desktop/primary-runtime-lock.json` 的 `nodeVersion`/`nodeSha256`（`prepare-python-payload --with-node` 按锁下载并逐件校验；`--dry-run` 离线只校验布局）。`build:sidecar --require-node` 只做常规文件 + 可执行位校验，不另立 pin；升级 lock 的 `nodeVersion` 是全链路行为变化（payload node、托管 dsh、签名/公证都要重验）。
- **进程归因**：payload Node 不重命名（保持上游官方 payload 的字面名 `node`，工具装到 DSH_HOME 后返回的也是该布局）；监控不依赖特制基名把进程归属到 app，而是按**应用派生的子进程关系**（app 的 spawn 树）归属——这是**设计约定，不是自动探针**（本仓未实现进程归因探针，按名字/启动树归属由系统监控工具侧承担）。`spawn-dsh` 的捆绑 Node 基名表收敛为 `{node,node.exe}`；Electron 分支仍走 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `--expose-internals`（dsh loader 的 node-addon-require-builtin 需要；updater 的 runtimeNodeExecutor 同构）。
- **签名**：payload Node 是 .app 内的嵌套 Mach-O。`build-swift-app` 的全嵌套遍历对它单独签名，并只对它使用 `entitlements.node.plist`（`allow-jit`/`allow-unsigned-executable-memory`；判定 = 精确路径 `isBundledPayloadNode`，不靠基名猜测）；壳侧最小集保持 `disable-library-validation`。签名顺序 = 嵌套 Mach-O（payload Node、LibreOffice kit helper、.node/dylib）→ 嵌套 bundle（Sparkle / LibreOfficeDev.app 等，由深到浅）→ 主 app（与 §3.2 同序）；`codesign --verify --deep --strict` 是装配期 fail-closed 门。嵌套签名面另含 vendor 运行时线的 LibreOffice kit helper（只带 `com.apple.security.cs.allow-jit`；判定同为精确路径）。
- **必须绑 Node**：dsh 实例本身是 Node 进程（vendor dsh 由 pnpm 安装），控制面 spawn 它、dsh-runtime 安装它；钉版本 `pnpm`（版本单源 = 根 `package.json` 的 `packageManager`）已随 desktop 依赖，两份同源供给：sidecar 目录内嵌 `<sidecar>/pnpm`（运行时安装 / 宿主插件管理器，02 §3.1 的 pnpm shim）与 payload `primary-runtime/dependencies/pnpm`（工具/受管宿主侧，入口 `bin/pnpm.mjs`）。宿主插件管理器的供给见 02 §3.1（入口仍由各 flavor 解析后交给控制面，控制面按宿主 PATH 决定是否前置 wrapper）。
- **dsh-runtime 默认执行器恒纯 Node**（`{file: process.execPath}`，runtime-installer.ts）。

**Rejected alternatives（单 Node 合并）**：① 保留独立 `dsh-chamber-helper` + payload 再带一份 Node——同一 .app 两份约 110MB 运行时、两条版本/摘要轴与两套签名面，且「payload full = node+pnpm+python」裁决已把 Node 收进 payload，否；② 给 payload Node 造第二个名字（构建期硬链接/符号链接/重命名）——布局必须与上游官方 payload 一致（工具把 payload 装到 DSH_HOME 后返回的是 `dependencies/node/bin/node` 布局），改名制造布局偏差；bundle 多目录项与封签/更新叙事同样成立，否；③ 保留 helper 作 `--python-only` 过渡双轨——契约不留长期双轨：回滚 = 整批 revert 或限时演练 `--python-only`（payload 只 python，不挂 Node 相关能力），不保留 helper 代码路径，否；④ 只改监控规则、不改启动链（继续让进程名 `node` 的多个进程混在一起再按名字区分）——单 Node 后启动树是确定的，按应用派生子进程关系归属即可，不需要「靠名字」第二条判别轴，否。结论 = 唯一 Node = payload `dependencies/node/bin/node`（不重命名；`build-sidecar` 清理旧 `<out>/node` / `<out>/dsh-chamber-helper`，`build-swift-app` 拒绝任何顶层 `node`/`node.exe`/`dsh-chamber-helper` 旧布局条目；`sidecar.js` 由它启动）。

### 4.4 桥接设计（本方案的信任核心）

#### 4.4.1 A 桥（web ↔ Swift，preload 等价物）

- preload 职责：`contextBridge.exposeInMainWorld('dshChamber', {…})` = **info 标量与命名空间面**（`preload.cts` 的 `DshChamberBridge` 为单源，命名空间清单不在此手抄；`bridge-manifest.json` 的 `counts` 与 preload 共同给出通道/成员计数）。Swift 注入 `bridge-shim.js`（WKUserScript、page world、documentStart；资源名 = `MainWindowController.swift` 的 `shimResourceName`）定义同形 API：
  - **挂出时机**：documentStart 定义内部管路（resolve/emit/rehydrate，带窗口随机令牌），**`dsh-chamber:info` 成功后**才暴露 `dshChamber`；info 未就绪/失败期 invoke 回 `ipc_not_ready`（1 次 + 10 次 50ms 重试），渲染端走既有 surface 缺失链自愈；全败分支与 preload 同形（surface 在、标量 null）。
  - 方法面：按 manifest 生成 `dshChamber.<ns>.<method>(args)` → postMessage({id, method, payload})，以 id 关联 Promise（info 的 10×50ms 重试照搬——仅 reject 时重试）。事件面：9 个 push → shim 订阅表，Swift `evaluateJavaScript("__dshChamberEmit(event,payload)")` 派发（通道名/载荷以 IPC_CHANNELS/05 §7.4 为权威）。防护：Object.defineProperty 非可配置挂载防页面覆盖。
- Swift `WKScriptMessageHandler` 护栏（只做传输层，语义校验在 sidecar）：① 主 frame；② **壳文档判定**（origin === 当前控制面 origin **且** pathname == "/" 且无 query——与 Electron `isTrustedRendererUrl` 对齐；port 只在 ready 帧后放开）；③ 信封结构/尺寸上限（≤4 MiB）、method ∈ manifest 白名单；④ 不响应「新窗口/导航」（WKUIDelegate 建窗返回 nil + decidePolicyFor 阻断离开 origin；外链交 NSWorkspace——含 mailto:/vscode:// 等非 http(s) scheme 导航策略）。语义校验（payload schema、来源指纹、generation、ACK 队列等）全部留在 sidecar 原处理器。

#### 4.4.2 B 桥（Swift ↔ sidecar，本机受信通道）

- 传输：sidecar stdin/stdout 行式 JSON-RPC（NDJSON）；stderr 独立为日志。sidecar-entry 入口必须把存量 console.* 重定向到 stderr（§3.1）。
- 信封：`{id, method, payload}` / `{id, ok, result|error}` / `{notify, payload}`（唯一推送面）/ `edge:*`（sidecar→Swift 的 HostEdge 请求，Swift 执行后回响应）；id 单调。`event` 族随 `onEvent` 订阅面一并退役（桩已迁 notify；`FrameCodec` 不再分类，旧桩 event 行落未知帧丢弃）。
- **保留入站 method（Swift → sidecar，不在 manifest 内；单源 = `packages/desktop/node-edges.ts` `HOST_INBOUND`）**：`__host.hostFacts`、`__host.notifyClicked`、`__host.systemResume`、`__host.mainWindowShown`、`__host.deepLink {url}`（§4.5：`application(_:open:)` 冷/热启动统一入口 → core `enqueueDeepLink`）、`__host.rendererLifecycle {event}`（§5 E19 三事件映射：did-start-loading / did-finish-load / crashed / closed → core `onRendererLifecycle` 复位 ready 位 + in-flight requeue/drain）、`__host.quitFacts {quitRequested, recoveryAvailable}` → **决策投影**（§5 E1/E9/E20：core 依 chamber settings 的 `windowCloseBehavior`/`quitConfirmation` + `LOCAL_RUNNING_STATES × localProcessAlive` 用既有纯函数 `shouldHideToTray`/`computeQuitRisk` 合成，返回 `{hideOnClose, quitNeedsConfirm, quitReasons}`——判据单源在 core，Swift 只执行隐藏/退出链，绝不复制决策）。Swift 拼写单源 = `HostInboundMethod`，与 TS 表锁步由 `HostInboundMethodTests` 断言。
- 退出纪律：清理后入站 invoke 一律回 `{error:'app is quitting', code:'app_quitting'}`（与 renderer-trust 的 `createTrustedIpc` 同码同语义）；清理自身 4.5s 硬顶（`QUIT_CLEANUP_TIMEOUT_MS=5_000` − 500，早于宿主 5s SIGKILL grace 留 500ms 余量；`shell-core.ts#QUIT_CLEANUP_TIMEOUT_MS` / `sidecar-entry.ts` 的同一硬顶 `QUIT_CLEANUP_DEADLINE_MS`）。
- 护栏：Swift 只接受自己 spawn 的进程 fd；帧长上限与超时；非协议帧 fail-loud。事件推送经 B 桥到 Swift → A 桥 emit，事件名清单 = manifest。
- **出站写与期限**：Swift 的 invoke 和 edge 应答共用每个 sidecar 会话独立的串行写器；排队上限为 64 帧 / 16 MiB（另有正在写的单帧 ≤4 MiB）。edge 应答越过尚未写出的普通请求，满队列时可淘汰排队请求并将其明确结算为写失败。invoke 在登记 pending 时启动全程期限（缺省 60s，页面普通 45s、长交互 720s），涵盖排队、管道背压、sidecar 执行与响应读取；过期排队帧在真正写入前丢弃。单次物理写超过 20s 时重建 sidecar；stop / 自然退出立即作废旧写器，重启使用新写器。写抛错可能留下半帧，因此同样作废整条出站传输并终止本代 sidecar，由 Supervisor 建立新协议会话。已经进入内核的写不能撤回，超时后的远端副作用须靠宿主事实对账；sidecar 对未收到 edge 应答另设普通 30s / 交互 660s 期限。

**Rejected alternatives（B 桥写出）**：继续在 invoke / stdout 回调线程持锁直接写 stdin，会让满管道绕过 invoke 期限并堵住 edge 应答；只把同步写包进全局串行队列，会让旧会话的阻塞写占住新会话；写失败后继续使用同一 NDJSON 管道，可能把新帧拼到半帧后面。每会话有界写器把这些风险分别收敛到请求期限、会话代际和协议重建。

#### 4.4.3 通道 manifest（防双份漂移）

- 单源：`IPC_CHANNELS`（ipc-events.ts）+ preload 的 invoke/on 字面量集。`ipc-surface-mirror.test.ts` 锁步通道名字符串集合 + 类型/字段镜像；`packages/desktop/scripts/emit-bridge-manifest.mjs` 解析三处 main 侧注册点，产出提交物 `packages/desktop/bridge-manifest.json`（通道 + 方向 invoke|push + IPC_CHANNELS 键）→ 生成 `macos/Sources/DSHChamber/Generated/BridgeManifest.swift`（提交物）与 `Resources/chamber-bridge.stub.js`（提交物；不进 Swift target、不随 .app 打包，仅锁步样本，见 `Package.swift` 的 `exclude`）。**命名空间归属不由 manifest 承载**：preload/shim 暴露面是唯一单源，`bridge-shim-surface.test.ts` 逐命名空间断言 shim 方法集与 preload 一一对应。
- 三件锁步测试：`bridge-manifest.test.ts`（重生成 == 提交物 + 通道数与「命名空间成员 + info + native-theme-set」守恒断言 + 无死键）、`bridge-shim.test.ts`（`chamber-bridge.stub.js` 重生成逐字节 == 提交物 + invoke/push 数组与计数）、`BridgeManifestConsistencyTests`（Swift 白名单 == JSON）；Swift 产品代码禁止手写通道字符串。
- `ipc-surface-mirror.test.ts` 的 `MAIN_SIDE_FILES = ['main.ts', 'shell-core.ts', 'electron-edges.ts']` 覆盖三处注册者文件，badge pin 断言等源码锚点随之（renderer-trust.test.ts、transport-manager.test.ts）。

### 4.5 通知点击与深链去重语义（design 19 §3.3 / 16 §4.2 的宿主移植）

- 通知 click：`pendingNotificationOpens` 有界 ACK 队列与去重/限速留 core；**click 回执路由的存活期 = dispose / 来源退役 / 有界淘汰**——显示成功不得注销（否则 Swift flavor 点击命中不到路由；`node-edges.ts` 的审计修复）。来源退役经 `sourceId` 扣掉路由（`showNativeNotification` 载荷携带 `sourceId`），Swift `NotificationDeliveryRegistry`（sourceId → identifier，FIFO 16）在 retire 时用 `removeDeliveredNotifications` 移除已投递横幅。非 silent 通知用系统默认声（Electron darwin 具名 `Glass` 在 UNUserNotificationCenter 无对应资源——差异已登记，`SwiftEdgeHostLegs.swift`）。**对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification 宿主对象）属 electron-edges**（core 不能持有宿主对象；UNUserNotificationCenter 的 delegate 由系统持有、Swift 无防 GC 坑也无 close 事件需登记）。HostEdges showNativeNotification 返回 click 回执绑定；**click 顺序** = NSApp.activate + 窗口 orderFront（含无窗重建，applicationShouldHandleReopen 同路）→ 回 B 桥 notification-clicked → core 队列 → 窗口就绪后 push。就绪/重建竞态兜底 = **事件映射**（§5 E19；WKWebView 三个触发点 → 4 个 wire 事件，含窗口关闭 `closed`）：didStartProvisionalNavigation（复位 ready 位 + requeue in-flight）/ didFinish（drain）/ `webViewWebContentProcessDidTerminate`（复位 + requeue + 有界重载）。
- 深链：**macOS = open-url 事件 + argv 防御式扫描双路径**（归一化 intent key 去重）——Swift 侧 = `application(_:open:)`（冷启动先于 ready → Swift 暂存，ready 后按序转交）+ 二次启动 argv 深链（`AppDelegate` 的 secondaryDeepLink 私有通知，与二次启动显窗请求同路）→ B 桥 deep-link(url) → core enqueueDeepLink 原逻辑（归一化去重、VS Code intent、proof 队列不动）；Win/Linux 的 second-instance argv 扫描仅 Electron flavor 保留。

## 5. 原生边沿逐项设计（Electron → Swift 映射）

本节的 Swift 实现均在 `macos/Sources/DSHChamber/` 下（XCTest 在 `macos/Tests/DSHChamberTests/`），符号名以该树为单源；行号不写进设计（按符号 grep 现取）。

| # | Electron 现状（main.ts/…，归档面） | Swift 对应 | 备注 |
|---|---|---|---|
| E1 | `BrowserWindow` + `loadURL` + hide-to-tray/close 语义 | `NSWindow` + `WKWebView`；`windowShouldClose` 按 [14-sleep-background.md](../runtime/14-sleep-background.md) D1（hide 而非关；mac Dock 恒为恢复入口 → orderOut） | 关窗隐藏/恢复、重建窗口只允许单窗 |
| E2 | `Tray`（打包态，resources/icon.png） | v1：mac 用 Dock 常驻即可，`trayAvailable()=true`；恒建 NSStatusItem（自持 18pt 图，T-15） | 托盘缺失回退关窗即退（mac 不会缺） |
| E3 | **未自定义应用菜单**（默认菜单含 Edit role，Cmd+C/V 靠它） | NSMenu 标准菜单 + **Edit 项（copy/paste/selectAll 走 first responder → WKWebView）** + **窗口项（Cmd+M 最小化 / Cmd+W 关闭）** | 缺菜单会丢 Cmd+C/V/全选；Edit + 窗口菜单 |
| E4 | `Notification` + `Notification.isSupported`；**session 权限 handler 显式拒绝网页 Notification** | `UNUserNotificationCenter`；授权请求时机与现状一致 | **网页 Notification 双路径风险**：WKWebView 无等价预拒绝 API，网页 requestPermission 会绕过 chamber 裁决直发——以实测官方 UI 是否存在网页通知入口并处置 |
| E5 | `app.setBadgeCount`（平台门 + badgeEnabled 裁决在 core） | `NSApp.dockTile.badgeLabel` | 门控逻辑留 core（badge.ts） |
| E6 | `powerMonitor.on('resume')` + held lastResume 补发（挂在 win.on('show')） | `NSWorkspace.didWakeNotification` + HostEdges.onMainWindowShown（窗口显示/恢复事件）→ core 补发语义原样 | 推送 `dsh-chamber:system-resume {timestamp}` |
| E7 | `powerSaveBlocker`（keep-awake 断言） | `ProcessInfo.beginActivity(.idleSystemSleepDisabled…)` 或 IOKit 断言 | 触发条件随 core 状态机原样（网关会话保持等，14）；**启动期 reconcile** `<userData>/chamber-settings.json` 的 `keepAwake`（缺省 off / 损坏 loud+off） |
| E8 | `dialog.showOpenDialog`（唯一 = 插件源 folder\|.tgz 一体化 picker，darwin 双模式） | `NSOpenPanel`（canChooseDirectories + canChooseFiles 双模式） | 归档清理（design 24）无任何文件对话框 |
| E9 | `dialog.showErrorBox/showMessageBox`（fatal 启动/前端崩溃/退出确认 D2）+ fatal 边界（uncaughtException → app.exit(1)） | `NSAlert`（sheet 或 app-modal）+ **sidecar fatal 边界：stderr + 非零退出码分级，Supervisor 分流文案** | 退出确认三分支与 5s 硬顶（§2.3） |
| E10 | `shell.openExternal`（外链/发布页/`openVscodeUrl`） | `NSWorkspace.shared.open(URL)`（URL 规范化/预算/冷却在 core） | open-release 亦此 |
| E11 | `shell.openPath/showItemInFolder` | NSWorkspace `open(_:)` / `activateFileViewerSelecting` | 失败模式语义照搬 |
| E12 | open-in 拉起 Finder/VS Code/应用 | **实例内 host 包** `dsh-chamber-seed-open-in`（`openInApp/*`，[20-open-in-registry.md](../desktop/20-open-in-registry.md) §6）负责目录/图标/拉起；壳只执行 `openExternal`（vscode 远程深链等）；`HostEdges.launchApp` 契约保留但两 flavor 均无实现（S-05） | 注册表/设置/可用性/URL 规则只在 core（`open-in.ts`/`deep-link.ts`） |
| E13 | 深链注册（打包态 `dsh-chamber://`） | Info.plist `CFBundleURLTypes` + `application(_:open:)` | 冷/热启动入队语义见 §4.5 |
| E14 | `app.setLoginItemSettings(openAtLogin)` | macOS 14.4+ `SMAppService.mainApp`；旧系统 NSLoginItem 兜底在新下限下不可达（无实现，见 deviations T-26） | 设置面语义不变（14） |
| E15 | `safeStorage`（gateway-secrets v3） | **不移植**：Swift flavor 走既有「诚实 0600 明文」回退；旧 safeStorage 密文「保留禁用待重录」（判别单测 S1，编号避开 E 表） | 更强者加密 → 决策 7 |
| E16 | `session` 权限 handler：只放行 clipboard-sanitized-write（写） | WebKit：写 = 用户手势自动放行（无需弹窗）；**读走 NSPasteboard 用户授权** | 对拍含「粘贴（富文本/图片）与剪贴板读」 |
| E17 | `crashReporter.start` + `child-process-gone` 诊断 | 不移植（macOS 崩溃报告原生 + Supervisor 日志）；child-process-gone 留 electron-edges | — |
| E18 | `requestSingleInstanceLock`/second-instance | NSRunningApplication 或锁文件二次激活（bundle id 相同时 LaunchServices 已保证） | 双 flavor 互斥见 §6.3 |
| E19 | renderer 崩溃/卡死恢复（installRendererRecovery：render-process-gone、unresponsive 与前台 JS/rAF 进度探针；共用有界重载预算） | **三事件映射**：didStartProvisionalNavigation（复位 + requeue）/ didFinish（drain）/ webViewWebContentProcessDidTerminate（复位 + requeue + 500ms 有界重载，60s ≤3 次 + NSAlert） | **unresponsive 腿 v1 不可移植**（WKWebView 无该事件）→ 以心跳探针替代（`RendererHangWatchdog`：didFinish 后武装，前台可见且无导航时每 5s 取 JS 回执与主动 rAF 计数；连续 3 次 3s 超时/求值失败/帧计数不前进后共用有界重载；键鼠输入不清除证据，隐藏或导航复位，迟到回调按探针编号丢弃；期限使用单调系统 uptime，免受系统时钟调整影响；导航抢先发生时取消待执行重载并退还该次预算）。boot 死区收敛后，**前端 boot 不 settle 的逃生由页面侧拥有**（[05-connection-manager.md](../control-plane/05-connection-manager.md) §4.3：可操作遮罩 + 相位感知就绪门 + ⌘R 提示），原生仍不观察/不超时前端 boot 状态。**崩溃归因轮**：崩溃日志行带「距上次加载完成 X.XXs（boot 窗口内/已稳定）+ 本窗口第 N 次崩溃」，恢复落地再记一条「崩溃后 X.XXs 重载完成」（`RendererCrashAttribution` 纯值 + `RendererRecoveryTests` 单测；`MainWindowController` 记 `lastLoadFinishedAt`/`crashesSinceLoad`/`recoveringFromCrash`）。**候选放大器（待真机验证）**：P2b facts 观察者的 45s 静默换代机制与实测数字由 [19-notifications.md](../client/19-notifications.md) §3.5 单源持有；本条只保留本机验收：同窗口 30 分钟前台 soak 的页面 socket 连续性（已采：2 socket / 0 换代） |
| E20 | `app.on('activate'/'window-all-closed')`（darwin 且 close-behavior='quit' 时也必须 quit） | `applicationShouldHandleReopen` 等 + windowShouldClose 判 close-behavior：'quit' → NSApp.terminate 走完整确认链，绝不无窗常驻 | 14 D1 语义 |

**Rejected alternatives（E2 的托盘图标产出方式）**：① 继续把共享的 `NSApp.applicationIconImage` 改 size 再交给按钮——除首次布局竞态外还有全局副作用（Sparkle/关于面板等消费者会看到被改成 18pt 的共享图），否；② 专用菜单栏资产（36px PNG / asset catalog）——观感更常规，但要连带改 `Package.swift` 的逐条 `.process` 资源、`build-swift-app.mjs` 的 icns 装配链与本表 E2 行 / T-15 的「图标=应用图标」语义，属独立变更，不夹带；③ `isTemplate` 模板图——把彩色应用图标变单色剪影，改外观契约，否；④ `NSImage(size:flipped:drawingHandler:)`——代码更短，但 rep 是 0px 延迟 rep，「绘制域 = rep.size」这条唯一真会回归的断言无法表达，否；⑤ 只留单个 rep——非 Retina 外接屏走降采样发虚，收益极小，否。结论 = 自持 18pt 位图副本（`StatusItemIcon`），几何与时序无关。

### 5.1 刷新率（ProMotion 120Hz，裁决）

**问题**：原生壳在 120Hz ProMotion 机器上默认跑不出 120fps（思考流式滚动发涩），同机 Electron/Chromium 为 120fps。实测（M5 Pro / 内置 3024×1964 120Hz 屏 / macOS 26.5，单位 = 页面 rAF 实测 fps，vsync 与 `CVDisplayLink` 均 120Hz）：

| 引擎与配置 | 低电量模式 | 实测 |
|---|---|---|
| WKWebView 默认配置 | 关 | 60.0fps |
| WKWebView（关闭 prefer-60fps 偏好） | 关 | 120.0fps |
| WKWebView 默认配置 | 开 | 30.0fps |
| Chromium（同机同时刻，Chrome 152） | 开 | 120fps |

- **根因（WebKit 源码定位）**：① `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml` 的 `PreferPageRenderingUpdatesNear60FPSEnabled` `defaultValue: default: true`——WKWebView 默认把页面渲染更新压到「靠近 60fps」；**只在 nominal > 60 且整数商 > 1 时才有影响**——61–119Hz 屏（如 100Hz）本就不受限，120Hz 上才表现为 60fps。② `ScriptedAnimationController::preferredScriptedAnimationInterval()` 调 `preferredFrameInterval(throttlingReasons(), page->displayNominalFramesPerSecond(), settings().preferPageRenderingUpdatesNear60FPSEnabled())`；常量在 `AnimationFrameRate.h`（`FullSpeedFramesPerSecond = 60`、`IntervalThrottlingFactor = 2`、`FullSpeedAnimationInterval = 15ms`），半速集合在 `AnimationFrameRate.cpp` 顶部（`{ LowPowerMode, NonInteractedCrossOriginFrame, VisuallyIdle, AggressiveThermalMitigation }`）；低电量模式经 `Page::handleLowPowerModeChange()` → `adjustRenderingUpdateFrequency()` 生效。本仓折算（`RefreshRatePolicy`）与上游 `framesPerSecondNearestFullSpeed` 同式（含其整数除法）。代入本机：默认偏好 + 120Hz → 1/60；关闭偏好 + 120Hz → 1/120；再叠低电量模式 ×2。
- **决议**：**关闭该偏好**——`WKPreferences` 只有私有 SPI（`WKPreferencesPrivate.h` 的 `_features` / `_setEnabled:forFeature:`，`_features` 需 macOS 13.3+），Swift 无直调面 ⇒ 新增独立 C target `macos/Sources/DSHChamberWebKitSupport`（唯一职责 = 关偏好；公共 C 面只一个函数，零状态、零第三方依赖）。**必须在构造 `WKWebView(frame:configuration:)` 之前调用**（创建后再改不生效；稳态前提 = 未换屏、未发生节流原因变化、未重启 WebProcess）：偏好变更会下发 WebProcess，但偏好变更路径不重设刷新节奏——节奏只在 `RenderingUpdateScheduler::adjustRenderingUpdateFrequency()` 的既有触发点（页面创建、换屏、节流原因变化）更新，`Page::settingsDidChange()` 不做。装配点 = `MainWindowController.setupWindow()`；折算与日志在 `RefreshRatePolicy`（纯逻辑，可单测）。
- **低电量模式 ×2 不覆盖（accepted）**：该状态由 WebContent 进程内 `WebCore::LowPowerModeNotifier` 直读系统状态；WebKit 内确有强制「关」的钩子（`Page::setLowPowerModeEnabledOverrideForTesting(false)` + `m_throttlingReasonsOverridenForTesting`），但只经 `Internals`（`window.internals`）暴露给布局测试，WKWebView/UI 进程无可达面 ⇒ 结论是「无应用级开关」，不是「不存在能强制关的钩子」。关闭偏好后低电量模式页面更新上限 = 显示器刷新率 ÷ 2（120Hz 屏 = 60fps；偏好仍开时是 nearest(nominal) ÷ 2 = 30fps）；要满 120fps 只能退出低电量模式（系统设置 > 电池），壳只如实写日志。系统级限制按 accepted 登记差异，不追求注入 bundle 覆盖原型。
- **`DSH_CHAMBER_SHELL_DEBUG` 帧率观测**：`DSH_CHAMBER_SHELL_DEBUG=1` 注入 rAF 计数（每 2s 一行 `[shell-fps]`，走既有 shellConsole 回传）；缺省/打包态不注入（S14/T-11 调试面纪律不变）。
- **启动日志（唯一对照口径）**：`[shell] 刷新率：显示器刷新率 120fps（当前模式）；prefer-60fps 偏好=已关闭(跟随显示器刷新率)；低电量模式=开 → 页面更新上限约 60fps（…）`——由 `RefreshRatePolicy.startupLogLine` 产出。刷新率取窗口所在屏的当前模式（`CGDisplayCopyDisplayMode`；取不到回落面板上限 `NSScreen.maximumFramesPerSecond` 并标「面板上限」）；建窗后立即记一次，并在换屏/屏幕参数变化（同屏改刷新率）/低电量模式切换/首次获得 key（上屏兜底）时按值去重补记（`MainWindowController.logRefreshRateIfChanged`）。`RefreshRatePolicyTests` 钉住 60/120/30 三个实测点、上游整数除法折算、接线时序（apply 先于 `WKWebView` 构造）与 SPI 不可用时的诚实降级（unknown 按 WebKit 默认折算，绝不虚报 120）；同屏改刷新率时 WebKit 是否重读 nominal 未证实，验收以 `[shell-fps]` 实测为准。

**Rejected alternatives（本决策）**：① 接受 60fps、不做——同机 Electron/Chromium 是 120fps，双 flavor 刷新率不同且原生侧更差，无产品理由保留；关闭偏好只是一个 SPI 调用的成本。② 等 WebKit 公开开关——无时间表，期间 60fps 上限持续（S-48）；落地已按「SPI 缺失即 Unknown 降级」设计，换公开 API 只需替换 `apply(to:)` 一处。③ 页面内规避（CSS 合成/自绘）——节流点在引擎调度器，页面拿不到旁路；流式文本必须走渲染更新。④ 按显示器能力门控（仅 `NSScreen.maximumFramesPerSecond > 60` 时关偏好）——页面创建后再改偏好不生效，换屏后无法重配；60Hz 屏 `nominal = 60`、`framesPerSecondNearestFullSpeed(60) = 60` 本不额外限制；建窗前 `NSScreen.main` 未必是最终屏。⑤ 覆盖低电量模式（injected bundle / UI 进程转发 / dyld interpose）——注入面（`_WKProcessPoolConfiguration.injectedBundleURL`，所属类自 macOS 12 deprecated）存在但未实测，覆盖需自建 bundle 并链接 WebCore 测试钩子，代价远超收益；UI 进程不转发。⑥ 换渲染引擎（Chromium/CEF）——唯一能在低电量模式拿满 120fps 的路径，但超出路线 A 定义，发布/签名代价巨大；电池场景替代品是 Electron flavor（已归档）。

### 5.1.1 调试模式（发布态可开检查器）

**问题**：WKWebView 无 CDP；原生检查器由 `WKWebView.isInspectable`（macOS 13.3+ 公开 API，可运行期改）经 Safari「开发」菜单暴露。`#if DEBUG` 构建把该值置真，发布包对用户不可达——本机调试（页面内测量、GUI 走查、真机取证）因此只能换 DEBUG 构建，而两 flavor 共用目录锁、不能并跑。

**决议**：release 默认仍关，新增**运行期、持久化、显式**的用户开关。

- **落点**：设置 → 通用 → 「更新」组内；标签「调试模式」，默认关。
- **设置键**：`chamber-settings.json` 的嵌套块 `debug: { enabled: boolean }`（与 `notifications`/`sessionTodo` 同形：partial patch 深合并、未知嵌套键 loud 拒绝、损坏块整文件不采信）。缺省 = 关：读不懂的块绝不用来打开调试面。
- **宿主腿**：新 edge `setDebugMode`（Electron 腿不接线，`supported.debugInspectable=false` ⇒ UI 禁用开关并给出原因，绝不呈现一个永远无效的开关）。Swift 腿施加 `webView.isInspectable` 后**回读实测值** `{inspectable, apiAvailable, reason?}`——回读优先于推断，腿失败/无窗 = `inspectable:false` + 原因，绝不把「用户想开」上报成「已开」。
- **状态可见性**：设置行状态 = settings 投影里的 `debugRuntime`（缺省 = 本次进程尚未应用过 →「未知」，绝不按 `enabled` 回声）；宿主侧每次施加（切换或启动重放）写一行 `[shell] 调试模式已开启：请求 enabled=true → 实测 isInspectable=true（Safari → 开发 → 本机 → dsh-chamber）`（请求值与实测值都记）。程序化查询「是否已被附着」无公开 API，Safari 侧只能人工看。
- **启动重放**：Swift 启动时按持久值经**同一条腿**应用（看门人只此一处）。回读经 `__host.debugModeApplied` 报给 sidecar，使用户打开设置页前投影已带事实。
- **投递时机 = ready 门**：该上报只在 sidecar ready 帧之后发出（sidecar 侧 `installIpcHandlers` 先于 ready，装配前到达的入站会被 loud 拒绝），且**每次 ready 都重报**（含 sidecar 崩溃重启后的新 ready）：`debugRuntime` 是 sidecar 进程内的内存投影，而检查器状态活在 Swift 进程里——只报启动那一刻会让重启后的投影把「其实还开着」低报成「尚未应用」。重报读的是当下事实（`MainWindowController.currentInspectable()` + 设置文件里的持久意图），不是启动快照。
- **信任边界**：开启 = 本机任意程序可读页面内容并可注入 JS；默认关、只对本机、不涉网关/隧道/远程实例，文案在开关旁明写。

**Rejected alternatives**：① 维持 `#if DEBUG` 单一入口——正是发布包无检查器的痛点；② 单独分发 debug 构建——第二份签名/公证产物 + 用户手上永远不是 release，验证价值反降；③ 环境变量开关（`DSH_CHAMBER_SHELL_DEBUG` 一类）——打包态被硬剥离（T-11 纪律），且对 GUI 用户不可达，GUI 设置是唯一不破坏该纪律的用户面；④ 默认开、允许关——发布包默认降低信任边界，不可接受；⑤ 自建调试端口 / CDP 兼容面——WKWebView 无 CDP 实现，自造协议等于新增监听端口与长期维护面，而 `isInspectable` 直接复用 Safari 官方检查器（零新端口）。

### 5.2 视口越界（根级弹性回弹）与壳侧策略

macOS WebKit 在**视口层**实现弹性越界：指针停在不可滚动 chrome（顶栏、侧栏头部）上滚动，或滚动器到端点后继续滚时，越界量落在视口，**整页（含 position: fixed 层）被平移再弹回**。按 CSS Overscroll Behavior 规范，视口越界效果由根元素的 `overscroll-behavior` 决定，故壳在 configuration 段以 WKUserScript（documentStart、仅主 frame）注入根规则 `html, body { overscroll-behavior: none !important; }`（`ShellOverscrollPolicy.swift`，装配点 `MainWindowController.swift#setupWindow` 的 `ShellOverscrollPolicy.install(config:)`）：

- **只落文档根**：不改任何滚动容器的滚动范围，也不改文档内链式滚动（`none` 管的是视口越界效果与向视口外链接）；页面结构、上游代码零改动。
- **`!important` + 样式元素标记**（`data-dsh-shell-overscroll`）：`!important` 压过页面普通声明；**层叠边界**——页面若在根上再声明同属性 `!important`（同特异性、文档序靠后）或根元素内联 `!important` 仍可翻转。当前上游无根级声明（`packages/dsh-client-web` 全目录 `overscroll` 命中 0；其余命中是滚动容器的 `contain`，无一定在文档根），故为理论边界；author 源内也挡不住页面 JS。将来上游若在根声明，升级手段 = documentEnd 再追加一次（文档序靠后）或对 documentElement 设内联 `important`；打包态可用 `getComputedStyle(document.documentElement).overscrollBehavior` 自检。
- **时机与作用域**：documentStart、仅主 frame（iframe 子文档保持自身行为）；崩溃/卡死恢复只 reload，注入随每次导航生效。本机实测 documentStart 时序 = readyState=loading、documentElement 已存在、head 尚不存在；落点始终优先 documentElement（保住「页面重写 head 也删不掉」的免疫），两者都取不到时才走一次 DOMContentLoaded。
- **证据**：契约有单测（`macos/Tests/DSHChamberTests/ShellOverscrollPolicyTests.swift` 锁 CSS 串、documentStart/仅主 frame 注入与「不得逐容器 contain」反例）；行为效果实机目检：滚到端点或指针停在不可滚动 chrome 上滚动，整页不得平移。
- **范围**：只关视口越界与链式越界；内层滚动器局部回弹不在范围内。
- **CSP 依赖（指令级守卫）**：注入的 `<style>` 依赖控制面 CSP 的 `style-src 'self' 'unsafe-inline'`（`packages/control-plane/src/index.ts#createControlPlane` 的响应头组装处：注释 + 指令同段）。页面当前没有 meta CSP；即便将来加入 meta `style-src 'self'`，documentStart 注入也早于其解析（本地 fixture 实测），唯一真实耦合是响应头 CSP。对抗验证（本地 HTTP fixture + 真实 WKWebView）实测三种同样静默失效的改法：① 删掉 `'unsafe-inline'`；② 同一 `style-src` 再加 `'nonce-…'`/`'sha256-…'`（CSP3：出现 nonce/hash 即忽略 unsafe-inline）；③ 新增 `style-src-elem`（覆盖 style-src 对 `<style>` 的管辖）——都让 computed 回 `auto`、回弹复现。守卫：`packages/control-plane/test/proxy/static-serving.test.ts` 按指令解析响应头（同一 policy 内重复指令首次生效；逗号分隔的每个 policy 都生效），要求每一条生效的 `style-src` 保留 `'unsafe-inline'`、不带 nonce/hash、不出现 `style-src-elem`/`style-src-attr`；校验边界：子串正则会绕过 `style-src 'self' 'unsafe-inline', style-src 'none'` 这类多 policy 写法。改 CSP 必须同时复核本策略与 S-50。
- **双 flavor 差异**：Electron 未同步，登记见 deviations S-50。

**Rejected alternatives（本策略）**：逐个滚动容器加 `overscroll-behavior: contain`（含按上游类名选择）——管不到「指针停在非滚动 chrome 上」，且要按上游结构改上游滚动语义，拒；改 `packages/dsh-client-web/src/base.css` 等上游 shell 副本——给上游打补丁 + 重建前端产物，本方案零页面改动，拒；私有 SPI `_setRubberBandingEnabled:`——非公开接口，发行风险与逐系统复核成本高于一条标准 CSS，拒；JS `wheel` 事件拦截——逐事件逻辑，WebKit 对合成/惯性相位事件的可取消性不由页面保证，最易回归，拒；把固定 chrome 移出 WKWebView（原生分层自绘）——不阻止内容区位移，且要重做命中测试/主题投影，代价与收益不成比例，拒。

### 5.3 原生席位：语言与外观跟随

**控件与事实源**：语言与主题的**唯一权威是页面 document 事实**（控件 = 页面设置面，壳不是事实源）；语言 = `documentElement.lang`（zh 族 → zh，其它非空 → en，空 = 无事实），主题 = `body[data-ds-dark-theme]` 存在或 html 内联 `color-scheme` 以 dark 开头（`ShellPageLanguage`、`ShellPageFacts`）。壳**只读、不回写页面**；无事实（首次安装/从未记录）时保持系统默认。

**载波（脚本 + 独立 handler + 对账 + last-known）**：

- **脚本** `ShellPageFactsScript`（WKUserScript、documentStart、仅主 frame、page world）观察 html[lang]、html 内联 style（color-scheme）、body[data-ds-dark-theme]、meta[theme-color]（仅变化触发面，不参与 dark 判定）；观察面只挂在 `documentElement`（属性 + 直接子节点）与 `head`/`body` 本身（childList / 属性），**绝不订阅整棵子树**——childList 全树会让页面每一次节点增删（流式 token、虚拟列表换行）都生成 MutationRecord 并回调本壳，而事实只需要上述四处；body/head 晚于 documentElement 出现或被整段替换时在每次回调里补挂（幂等）。同文档一次性安装 + (lang,dark) 快照去重，全部 try/catch（异常退化为不上报）；只留一次性安装标记 `__dshChamberFactsState__`，不改 DOM、不读页面变量、绝不回写；装配点 `MainWindowController.swift#setupWindow`。
- **独立 handler**：消息名 `ShellPageFactsScript.messageName`（dshChamberFacts），由 `MainWindowController.swift#ShellPageFactsMessageHandler` 消费——**不**进 A 桥白名单/就绪门（事实须在 sidecar ready 前可用）；护栏 = 名称 + 主 frame（`accepts`）+ 同源 `MainWindowController.swift#isSameOriginDocument`（委托 `TrustGuard.swift#isTrustedOrigin`：仅 scheme/host/port 全等，不限定 pathname="/"、不限定无 query）。严格壳文档判定 `TrustGuard.swift#isTrustedDocument` 只留给 A 桥（首载归一化 `AppDelegate.swift#applicationDidFinishLaunching` 与 A 桥消息门）：本通道只带 lang/dark 两个非敏感事实，且 SPA 路由 pushState/replaceState 会让 frameInfo.request.url 变化、严格门会把同一文档判成不可信 ⇒ 事实通道静默断链到下次 didFinish 才对账恢复。主 frame + 同源 + 导航护栏足以挡住失败页/about:blank 与异源文档。
- **对账**：`MainWindowController.swift#reconcilePageFacts` 在 didFinish 以 `snapshotSource()` 再读（同 dark 判定），覆盖首次上报窗口；回调先过 `acceptsReconcile`（与观察器路径共用 `isSameOriginDocument`）才 ingest，失败页/about:blank 静默丢弃；loud 只针对 `evaluateJavaScript` 错误（不致命，观察器路径仍在）。
- **last-known**：`ShellPageFactsStore` 合并上报并持久化（lang 空/dark 缺失 = 保留旧值；不变即幂等；revision = max(夹紧后的上报值, 旧值 + 1) 且夹在 [0, `maxRevision`=1_000_000]——上报值由页面 postMessage 提供，可构造 `Int.max`，未夹紧时「旧值 + 1」即整型溢出陷阱，落盘载入同样夹紧），键 `native-shell.page-facts`；启动早期只读入口 = `MainWindowController.swift#lastKnownPageFacts`。

**本地化资源与装配**：壳内建文案走 `NativeText.swift#NativeTextKey`（键表）与 `NativeText.swift#NativeText`（取值链优先语言覆盖包 → Bundle.main → SwiftPM 资源包 → rawValue；缺资源显示键名、不谎报翻译）。两份 `Localizable.strings` 在 `macos/Sources/DSHChamber/Resources/{en,zh-Hans}.lproj/`，经 `macos/Package.swift#=literal:defaultLocalization: "en"` 与两个 `.process("…lproj")` 进资源包；装配腿 `macos/scripts/build-swift-app.mjs#LOCALIZATIONS` 的三处同源 = 该常量、Info.plist.template 的 `CFBundleLocalizations`（dry-run 逐字比对）、Package.swift 两个 `.process` 的产物（装配期断言两个 `.lproj` 都在，不做文本解析）；装配腿把 `.lproj` 平移到 `<App>.app/Contents/Resources`（Bundle.main 与系统框架的 preferredLocalizations 只看这一层，资源包内那份只服务 Bundle.module）；`assertLocalizationsPresent` 缺席即 fail，`plistLocalizations` 让 dry-run 声明面与资源面同源。壳内标识符以 `ShellPageLanguage` 的 `localizationIdentifier` 为唯一入口（zh 用 Apple 拼写 `zh-Hans`）；该集合由 `ShellIdentityTests.swift#testLocalizationIdentifiersLockstepAcrossBuildInputs` 机械锁步（读源码比对上述三处 + `LOCALIZATIONS`，少/多/拼写变体即红）；`NativeTextLanguageOverrideTests` 只作「两个方向都能解析到随包 .lproj」的隐式兜底。`CFBundleLocalizations` 是进程偏好集合的声明面（不是翻译清单）：它决定 preferredLocalizations 允许的本地化全集；盘上 .lproj 也参与 Foundation 解析，两者叠加会让 localizations 出现重复项（无功能影响），真正文案来自随包 .lproj。

**应用点与生效时机**（入口：启动期 `AppDelegate.swift#applicationWillFinishLaunching`（last-known，早于 didFinishLaunching 的主菜单构造）与事实变化 `AppDelegate.swift#pageFactsDidChange`）：

- **自建文案即时**：页面语言变化 → `NativeText.swift#setLanguageOverride` 先换运行期语言覆盖（显式加载目标语言 .lproj；CFBundle 的 preferredLocalizations 是进程启动期解析并缓存的，只写 `AppleLanguages` 不会让运行期取串换语言——这是「重建菜单」真正换文案的前提），再由 `AppDelegate.swift#installMainMenu` 重建主菜单（接线一律按 tag：appSectionTag…helpSectionTag/servicesItemTag，绝不按本地化后的标题查找）；托盘标题由 `AppDelegate.swift#refreshStatusItemTitles` 在事实变化时按 key 重取；对话框/失败页在下一次取串时跟随。
- **进程级 = 下次启动生效**：框架与 Sparkle 标准窗的本地化在进程启动时按 bundle 偏好集合解析、运行期不可变；`AppDelegate.swift#applyLanguage` 把页面语言写进本 app 域的 `AppleLanguages`，仅当页面语言族与系统语言族不同才写，且所有权以本壳写入的确切值为准（记录键 `native-shell.appleLanguagesWritten`）：app 域已有值且 ≠ 记录 ⇒ 视为用户/系统设置，不覆盖；回收仅当「当前值 == 记录」才删，值被外部改过就作废记录、绝不删值；旧布尔标记 `native-shell.appleLanguagesOwned` 只清理。系统设置「语言与地区 → 应用程序」写的是同一个 app 域键；已知边界：用户显式设置的语言恰等于上次写入值时无法区分（同键双写者固有歧义）。系统语言读取显式排除本 app 写过的覆盖（`AppDelegate.swift#systemLanguageIdentifiers`）。
- **右键菜单同属进程级**（语言随 `AppleLanguages`；平台默认项集不可定制）。

**两层语义**：壳自建文案跟随应用内设置（页面语言，切换即生效：菜单/托盘/对话框/失败页/面板）；系统与框架面默认跟随系统语言（Sparkle 标准窗与其提示、AppKit 内建按钮与 About 标签、WebKit 右键菜单、Services 子项与帮助搜索框）。只有语言族不同（中文 ↔ 非中文）时才写 `AppleLanguages` 把这些面一起切到应用内语言（下次启动生效）；同族不覆盖是有意选择（例：日/韩/法/德系统 + 英文页面 ⇒ 框架面保持系统语言；zh-Hant 系统 + 简体页面 ⇒ 框架面保持繁体）。语言匹配已本机实测（`Bundle.preferredLocalizations`）：`["zh-Hans"]→zh_CN`、`["zh-Hans-CN"]→zh_CN`、`["en"]→en`、`["ja-JP"]→ja`、`["zh-Hant-TW"]→zh_TW`。

**外观**：默认 nil（跟系统；HIG 不鼓励 app 专属外观开关）；仅页面显式主题与系统主题不同才覆盖为 darkAqua/aqua（`ShellAppearancePolicy`，应用点 `AppDelegate.swift#applyAppearance`），页面回到「跟随系统」即重置 nil；系统深浅读 `AppleInterfaceStyle`，不读被覆盖后的 effectiveAppearance。

**露底色的两段语义**：① 建窗即按 last-known 对账：`#setupWindow` 末尾调 `reconcileThemedBackground`（读 `ShellPageFactsStore.lastKnown` 幂等收敛），首帧不再是骨架常量；只有无事实时才用骨架常量 `#0f1115`——页面骨架与主题无关（`packages/renderer/index.html` 明示「不跟随 prefers-color-scheme」），跟骨架走才不会首帧反向闪色。② 透明露底经异常安全包装：WKWebView 缺省白底会首帧/重载白闪，故经包装置 `drawsBackground` = false；包装失败仅降级 WebKit 白底 + 日志，绝不崩（`responds(to:)` 探测实测恒 false，不再作门）。③ 事实到达后按主题换 `underPageBackgroundColor` 与窗口底色（`themedBackgroundColor`：light → 浅色内容底、dark/无事实 → 骨架常量；装材质后窗口底转 clear、露底色在 WebKit 真能透明时也转 clear，见 §5.6），缩放/全屏/重载的露底与页面一致。

**右键菜单不可定制的取舍**：WKWebView（macOS）公开面无右键菜单定制 API（`contextMenu*` 属 UIKit/SwiftUI 控件层；`#setupWindow` 无任何 menu/contextmenu 覆写）；AppKit `willOpenMenu:withEvent:`/`didCloseMenu:` 属视图自有 NSMenu，对网页内部菜单是否生效未验证；故保持平台默认项集，不改项、不禁用。语义命令（Cmd+C/V/全选等）由 `#installMainMenu` 的 Edit 主菜单承担；语言随进程、外观随 `NSApp.appearance`。退役判据 = Apple 放出 WKWebView 右键菜单 API（或 NSView 回调对网页菜单确实生效）时重评并回写本节与 [deviations.md](../../progress/deviations.md) S-11。

**Rejected alternatives**：在 `chamber-settings.json` 加全局 `language`/`theme` 键——页面语言/主题是按实例投影的，全局键与「页面 document 是唯一事实源」冲突（同窗口切换实例即失配），且会与布局 store 的文档级投影互写，拒；壳写回页面——制造第二个事实源，页面重载即被自身投影覆盖，且与 active view 的主题所有权打架，拒；语言只靠 `AppleLanguages`（不设运行期覆盖）——preferredLocalizations 进程启动期解析并缓存（实测写后同进程取串不变），等于「语言下次启动才跟随」，故自建文案另加显式 .lproj 覆盖，框架/Sparkle/右键菜单保持进程级，拒前者单用；框架面一律强制应用内语言（跨族也写覆盖）——会把日/韩/法/德系统的 Sparkle 与 AppKit 内建串强制成英文，也会给「页面是 ja/ko」的情形制造错误覆盖，拒；首帧就按系统外观解析动态露底色——页面骨架恒 `#0f1115` 且与主题无关，浅色系统上会在深色骨架前反向闪色，拒「一次解析」；暴露 app 专属外观开关（含 `NSApp.appearance` 常驻值）——HIG 不鼓励，且让「页面说了算」变成「壳说了算」，拒；覆写 WKWebView 右键菜单项集——无公开 API，任何实现都是私有 SPI 或重做上下文菜单，发行风险与逐系统复核成本不成比例，拒（退役判据见上）。

**已知边界**：本壳只随包 en/zh-Hans，而 `ShellPageLanguage.resolve` 把 `zh-*`（含 zh-Hant）折叠为 zh ⇒ zh-Hant 页面/系统下壳自建文案按简体渲染（与页面 frame 自身的折叠规则一致：`packages/renderer/src/locales.ts` 的 zh 字典即简体），未覆盖的系统框架/Sparkle 则按系统 zh-Hant 显示；简繁混排是否可接受需实机判断，若要收口须先决定是否随包 zh-Hant。

### 5.4 原生崩溃最小诊断（替代 Crashpad）

「原生崩溃最小诊断」（`macos/Sources/DSHChamber/CrashDiagnostics.swift`）：**不引入任何第三方依赖**（明确不做 Crashpad），原生壳自己给出「闪退后可考古、可给出原因」的最小面。落点全在 `<userData>/logs/`（与 `shell.log` 同目录同权限纪律）：

- **记录**：`shell-crash.log` 一行一条（UTC 时间 / `kind=signal|exception` / 信号或异常名 / bundle 短版本 / pid / `source=native-shell` / `phase=startup|running`），例 `[2023-11-14T22:13:20Z] kind=signal name=SIGSEGV signo=11 pid=4242 version=0.16.0 source=native-shell phase=running`。`source`/`phase` 让「启动期崩的」与「跑起来之后崩的」在同一台账里可区分；`phase` 由 `markPhaseRunning()`（sidecar ready 后）翻转——处理器里只读一个对齐 `Int32`，两个相位变体在安装期就预格式化好，绝不在信号上下文做字符串工作。`CrashDiagnostics.formatRecord` 是纯函数，处理器的手写路径与它逐字节锁步（用例以同一 epoch 断言两者相等）。处理器侧的 UTC 换算 = `utcCivilDate` 的纯整数 civil-date：不经任何 libc 时间函数，`gmtime_r` 不在 async-signal-safe 名单里。
- **标记**：`shell-crash.marker` 存在 ⇒ 上次进程未走正常退出路径。启动期消费 = 一行 `shellLog`（含记录路径与最近一条记录行 ⇒「闪退后日志能给出原因」），随后清除；`applicationWillTerminate`（正常退出）也清除。标记写入与记录叶子共用同一纪律：`open(O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW|O_NONBLOCK)` 后 `fstat` 判 `S_IFREG && nlink == 1`（`lstat`/`ftruncate` 不在安全名单，故顺序是 open→fstat，O_TRUNC 的残余已登记在 `openMarkerLeaf`）。启动期清除失败必须 loud 一行（路径 + 后果 + 手动删除动作），否则标记清不掉时每次启动都会重复报告同一条旧崩溃而无人能分辨。
- **覆盖**：`NSSetUncaughtExceptionHandler` + SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE/SIGTRAP。
- **信号上下文纪律**（本节硬约束）：处理器内只做 async-signal-safe 的事——记录 body 在安装期预格式化为字节，崩溃时刻只把 epoch 用 `time(2)` + 纯整数 civil-date 换算 + 手写定宽十进制写进定长栈缓冲，随后 `write(2)` 直写日志叶子、`open`+`fstat`+`write`+`close` 建标记；绝不做 Swift 分配 / String 插值 / 锁 / FileManager / ObjC 消息。写完记录恢复 `SIG_DFL` 并重发信号——绝不吞信号，系统 DiagnosticReports 的原生报告面保持不变。异常处理器链回安装前的处理器；异常路径已写过记录时信号处理器不再写第二条（否则标记里只剩 SIGABRT）。release 反汇编可验：`emitSignal`/`handleSignal` 只调 `renderTimestampPrefix`（纯整数换算）/`write`/`open`/`fstat`/`close`/`time`/`signal`/`raise`，无任何分配/retain/ObjC 调用。未捕获异常处理器是另一类上下文（ObjC 异常展开路径）：读 `NSException.name` 必然经 ObjC 属性桥接，无法零分配；它同样不做 String 插值/Formatter/锁，写路径与信号处理器共用（`writeRecord`）。
- **叶子复用**：`ShellLog.openSignalSafeLeaf` 与实例写路径共用同一套纪律（目录 0700、叶子 0600、目录与叶子符号链接拒绝、lstat + `open(O_NOFOLLOW|O_NONBLOCK|O_APPEND)` + fstat 三段常规文件判据），但返回裸 fd 供信号上下文使用。唯一差异 = 轮转：信号上下文不做 rename 轮转，改为安装期按上限清零——单份有界日志保留最近一次崩溃。
- **可测性**：安装注入 seam（打开器 / 异常处理器安装器 / sigaction 安装器 / 上一处理器），标记读写注入 IO；处理器核心以固定 epoch 直调（不真发信号——真发会杀掉测试进程）。
- **不做**（页面面不变）：Crashpad、任何上报（网络）、设置页展示——把「上次异常退出」投影到页面需要新的页面/桥面契约，本项只写 `shellLog` 与日志文件。
- **已知边界**：SIGKILL/断电等不可捕获路径不写标记（下次启动不会报告）；诊断写失败一律静默降级（绝不成为新的致命面）。

**Rejected alternatives**：Crashpad / 任一第三方崩溃 SDK——新增运行时依赖 + 自带上报面，与「不新增依赖」红线冲突；最小诊断已满足「闪退后日志能给出原因」的判据。在处理器里用 Swift String/Array/Formatter 格式化记录——崩溃时分配器与锁状态未知，可能死锁或二次崩溃；改为安装期预格式化 + 定长栈缓冲手写时间戳。处理器内做 `shell.log` 式 rename 轮转——会把记录搬去 `.1`，启动期读「最近一条」就落空，且徒增信号上下文里的文件系统操作；改为安装期清零。处理器写完就 `_exit`（或吞掉信号）——会丢掉系统 DiagnosticReports 的原生崩溃报告；改为恢复 `SIG_DFL` + `raise`。设置页展示「上次异常退出」——需要新桥面/页面契约，本期不做。在处理器里继续用 `gmtime_r`（或任何不在 `man 2 sigaction` 名单里的 libc 调用）——与「只做 async-signal-safe」声明矛盾，改为纯整数 civil-date 换算。启动期清除标记失败保持静默——标记清不掉时每次启动都会重复报告同一条旧崩溃，改为 loud 一行失败。

### 5.5 窗口拖拽（`-webkit-app-region` 的等价面）

窗口形态是「隐藏标题栏 + 内容延伸进标题栏」（`titlebarAppearsTransparent` + `fullSizeContentView`），红绿灯内缩到页面 chrome 行（§5.6）、页面按 `data-platform=darwin` 自己留白——整窗因此没有原生可拖区域：`isMovableByWindowBackground` 判的是命中视图的 `mouseDownCanMoveWindow`，而 WKWebView 恒 `false`（本机实测：900×600 窗 + WKWebView 作 contentView + 该开关为 true（容器化后 contentView 是材质容器、WKWebView 是其子视图；命中仍落 WKWebView），`hitTest` 命中 WKWebView、`canMove=false`，合成 `leftMouseDown` 后窗口不动；只有命中 AppKit 自有视图的位置才吃该开关）。页面用 `data-window-drag` 标记窗口 chrome 行（单一真源 `packages/dsh-client-web/src/window-drag/regions.ts#DRAG_MARK`；必带行清单 = `vendor/harness-packages/@deepseek-ai/dsh-client-ui-theme/tests/app-region-styles.client.spec.ts` 的 `CHROME_ROWS`；chamber 侧栏的顶部带与 logo 行同款，`packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx`）。Electron（Chromium）原生消费 `-webkit-app-region`，WKWebView 不认，故壳自建等价面（`macos/Sources/DSHChamber/ShellWindowDrag.swift`）：

- **注入**：configuration 段以 WKUserScript（documentStart、仅主 frame）装一条 capture 段 `mousedown` 监听；命中标记行且未命中控件时 `preventDefault + stopPropagation`，再经独立通道 `dshChamberWindowDrag` 交回壳（载荷只有 `{kind:"drag"}`）。
- **判定三条纪律**：① 只有标记行是拖拽面（未标记处永不触发）；② **控件优先**——`button/a/input/…`（`ShellWindowDragScript.interactiveSelector` 与 `regions.ts#INTERACTIVE_SELECTOR` 逐项锁步）命中即不拖，点击、焦点、文本选择与页签原行为不变；③ ⌘/⌃/⌥/⇧ 按下时不拖。命中用 DOM 真实命中（按下的元素链上最近的匹配者）而不是 app-region 的几何盒序：可见且被按下的那一层决定结果；`data-window-drag-recall` 脉冲只被「认识」、不参与判定（壳不缓存几何）。
- **起拖**：消息回调（主线程）里用当前鼠标位置（`NSEvent.mouseLocation` → `convertPoint(fromScreen:)` 窗口坐标）合成 `leftMouseDown` 事件调 `NSWindow.performDrag`，AppKit 的窗口拖拽循环接管到抬键。位置取窗口坐标系 ⇒ 起拖瞬间抓取偏移为零、窗口不跳；「按下与消息到达之间已抬键」不会挂住壳（实测：未按键时 `performDrag` 立即返回、不挪窗）。不可移动/最小化窗口直接弃。
- **安全边界**：mousedown 是页面事件，本通道不接受页面指定「拖哪个窗、挪到哪」——窗口与位置都取自壳自己的事实；准入 = 通道名 + 主 frame + 同源文档（`MainWindowController.isSameOriginDocument`，与页面事实通道同款门）。本通道不并入 A 桥白名单/就绪门（sidecar ready 前窗口就该能拖）。
- **行为锁**：`ShellWindowDragTests.swift` 直测围栏真值表与事件合成字段，并在 JavaScriptCore + 最小假 DOM 下跑注入脚本本身（13 个场景：标记行/控件/未标记/修饰键/非左键/页面已 preventDefault/recall 标记/portal 层/非元素目标 + 幂等）；TS 侧锁步在 `CrossLanguageLockstepTests.swift#testWindowDragMarkAndInteractiveSelectorLockstep`（标记属性与选择器逐项同序）。
- **范围**：iframe 子文档不注入（只有主 frame）；非左键、双击与页面自己的 `preventDefault` 一律原样放行；Electron 腿的窗口同样走 darwin 分支（`hiddenInset` + 灯组 (16,18) + vibrancy），标记在那条腿同样是拖拽面（deviations T-30）——拖拽面本身两腿同源（同一批标记）。

**Rejected alternatives**：让 `isMovableByWindowBackground` 生效（子类化 WKWebView 覆写 `mouseDownCanMoveWindow`，或让命中视图不再是 WebView）——命中视图是 WebKit 自己的内层视图，覆写不到；把整窗设成拖拽面又会吃掉文本选择、滚动条与画布拖拽，拒；原生覆盖层（把 `data-window-drag` 盒镜像成一组 `mouseDownCanMoveWindow = true` 的透明 NSView）——要几何镜像 + 布局变化时重采集，陈旧矩形会把控件「盖死」，失败模式更重，拒；自己跑拖拽循环（mousemove 报偏移 → `setFrameOrigin`）——逐帧 IPC，跟手感与多屏/缩放边界处理都差，拒；在 ui-web 副本里加 Swift 专用分支——本方案零页面改动（标记是上游本来就有的属性），拒；把 `-webkit-app-region: drag` 留在页面上等 WKWebView 支持——无此计划，且窗口整场不能移动，拒。

### 5.6 窗口 chrome 面（hiddenInset / 全屏标记 / 侧栏材质的等价面）

§5.5 的窗口形态还需要三个上游等价面，否则页面按 `data-platform=darwin` 画的顶部带与真实窗口不成一条带。上游的量取自官方 desktop 主进程的 darwin 分支（`vendor/harness-checkout/apps/desktop/src/main.ts` 与 `preload-platform.ts`：`titleBarStyle:'hiddenInset'`、`trafficLightPosition:{x:16,y:18}`、`vibrancy:'sidebar'`、`visualEffectState:'active'`、`backgroundColor:'#00000000'`）与 preload（`dataset.fullscreen`）；本壳的量全部由本机同形窗探针实测；Electron 归档腿也按同一组 darwin 值收口（`packages/desktop/electron/main.ts` 的 darwin 分支，锁 = `packages/desktop/upstream-seats.test.ts` S-54），两 flavor 共用同一份页面几何（`--dsh-frame-top-clearance: 48px`、`.topStrip`、`[data-fullscreen]`）：

| 面 | 上游 | 本壳等价物 |
|---|---|---|
| 红绿灯行 | `hiddenInset` + `trafficLightPosition:{x:16, y:18}`：灯组左上角钉在 (16,18)（ui-sidebar 侧注释同写 "(16, 18)"；ui-layout 把 `--dsh-frame-leading-clearance: 160px` 拆成「灯到 x 68，控件自 88 起（28+8+28），尾留 8px」） | `macos/Sources/DSHChamber/ShellTrafficLightInset.swift`：建窗后把三灯整组平移到首灯目标中心 (23,25) = 上游 pin (16,18) + 本机灯盒半宽/半高（本机灯盒 14×14、中心距 23；y 与页面 chrome 行 25 同值，第三灯右沿 76 < 88 不压控件），保持 AppKit 自己的灯距/尺寸。AppKit 默认中心 (16,16)（实测：标题栏带 32pt、`NSTitlebarView` 非 flipped、frame (9,9,14,14)）比页面那条带高 9pt ⇒ 整条顶部带不成一行。重排时机：缩放（`setFrame`/`zoom(_:)`，实测）、跨屏 / backing 变化 / 最小化恢复（防御性订阅）与进出全屏都进 `reapplyNotifications`（进场时 AppKit 在 `didEnterFullScreen` 之前还会再静默排一次——本机真全屏探针：该通知同一轮读到的仍是默认位，故处理器在下一轮主循环再补一次，那一轮才是进场真正落位的一次；出全屏时同步那次已落位，补做是幂等 no-op）；标题换值同样重排且不发任何窗口通知（实测），由 `MainWindowController.setWindowTitle` 在写标题后无条件重做（`apply` 幂等、约 1µs，顺带自愈任何一次错位；`translatesAutoresizingMaskIntoConstraints = true` 实测挡不住重排） |
| 全屏状态 | preload 的 `syncWindowFullscreen` 在每次切换与每次装载后把状态写到 html（`dataset.fullscreen = 'true'` / delete）；ui-layout / ui-sidebar 的全屏规则据此把灯带让给座位（leading 160→84、`.leadingSeat` 12px、`.topStrip` 左对齐） | `macos/Sources/DSHChamber/ShellWindowFullscreenMark.swift`：`didEnter/didExitFullScreen` 两侧通知各写一次，`didFinish` 按窗口 `styleMask` 重放（导航会重置 document）；写入与上游同形——`document.documentElement.dataset.fullscreen = 'true'` / `delete document.documentElement.dataset.fullscreen` |
| 侧栏材质 | Electron `vibrancy:'sidebar'` + `visualEffectState:'active'`（vendor 注释明确拒用 followWindow："'followWindow' washes the sidebar out behind an unfocused window"）+ `backgroundColor:'#00000000'`；页面在 darwin 下把自己的底设为透明（ui-web `base.css`："the window's sidebar vibrancy shows only through a transparent page background"） | `macos/Sources/DSHChamber/ShellWindowMaterial.swift`：内容视图换成「材质 + 页面」容器，`material = .sidebar`、`blendingMode = .behindWindow`（采样窗后桌面 = 真 vibrancy）、`state = .active`（AppKit 默认正是 `followsWindowActiveState`＝上游拒用的那个形态，故必须显式写出）；窗口 `isOpaque = false` + 底色 clear。露底色按 `underPageColor(usesTransparentPage:themed:)`：只在 `drawsBackground` 私有键**真生效**时 clear（建窗收尾即转 clear——窗口在首个 didCommit 前不呈现、页面骨架不透明，故不白闪）；键不可用时 WebKit 不透明绘制，露底色必须留主题色。窗口底归材质面独家：`install` 置 clear，`applyBackdrop` 在最小化/隐藏期置兜底色。最小化/隐藏兜底（上游 darwin 对 minimize/hide/restore/show 切 `setVibrancy(null)` + `chromeFallbackFill()` 的等价面，成因 electron#25368 的 deminiaturize 材质重挂间隙）：本壳材质是 contentView 的常驻子视图（探针：最小化后仍在层级里、`hidden=false`），仍按上游同形面防御——抑制期 `effect.isHidden = true` + 窗口转兜底色 `#1b1b1c`/`#f9fafb`（＝上游 `chromeFallbackFill()`，与侧栏填充同 token），恢复期切回 clear + `isHidden = false`（等价于上游 null→'sidebar' 的强制重挂），四个时机 = `didMiniaturize`/`didDeminiaturize` + 应用 `didHide`/`didUnhide`。Reduce Transparency：系统把 vibrancy 层压平成实色，页面侧 vendor `AppFrame` 的 `prefers-reduced-transparency` 规则把 `.sidebarCol` 换成同 token 的 90% 不透明填充（双主题各一条），壳侧无需另作处理 |

**材质可见面的前提**：材质只在页面存在透明区域时才可见，上游的形态是「侧栏列透明、中列不透明」。完整链是四层：ui-web `base.css` 的 `html/body` → AppFrame 的 `.frame` 与半透明 `.sidebarCol` tint → 侧栏 `.root`（ui-sidebar 在 darwin 下 transparent，vendor 注释："an opaque fill here would sit on top of it and block the window vibrancy"）→ renderer 的 `.app`/`.instance-view` 两个 chamber 容器（`packages/renderer/src/styles.css`；不透明时整视口盖住材质）。自建侧栏 fork 的三组 darwin 规则（`.root` 透明、`.newSession` 白色洗染、`.brand` `cursor: default`）与上游逐字一致（`packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.module.css`，规则体与 vendor 同名文件逐条一致，由测试比对）。四层统一按 `data-window-vibrancy` 门控（两 flavor 的 documentStart 都落：Swift 壳的 `bridge-shim.js` 与 Electron preload 的 darwin 分支）：窗口背后真有材质才命中；无材质的 darwin 窗口形态（不落标记）不会被误透明化——只按 `data-platform` 跟着透明会把侧栏 tint 与中列一起压到窗口底色上（浅色主题下侧栏≈rgb(107,109,113) 对白中列）。中列在 darwin 下保持不透明 `--dsw-alias-bg-base`；骨架 `.dsh-boot` 铺满 #0f1115 只在 React 挂载前可见（不白闪），失败说明页自带不透明底。故实机判据 = 侧栏列可见窗后模糊、中列仍是不透明底。

- **行为锁**：`ShellWindowChromeTests.swift`（目标值、位移折返、通知真值表与写入表达式、露底色真值表）+ `ShellIdentityTests#testWindowChromeUpstreamFacesAreWired`（建窗/重排/标题/材质接线与属性的非注释源码锁，含标题写入的计数锁：非注释源码 `window?.title =` 0 次、`window.title =` 恰 2 次）+ `CrossLanguageLockstepTests#testWindowVibrancyMarkerLockstep`（shim 的 `data-window-vibrancy` ↔ renderer/侧栏 CSS 的门控）+ `packages/dsh-chamber-client-ui-sidebar/test/leading/macos-top-strip.test.ts`（三组 darwin 规则体与 vendor 同名文件逐条比对）。本机同形窗探针实测：应用后三灯中心 = (23,25)/(46,25)/(69,25)（距窗口上沿），二次应用 `false`（幂等）；缩放/zoom/标题换值后的重做与幂等同样由探针覆盖。

**Rejected alternatives**：只应用一次（或把按钮的 `translatesAutoresizingMaskIntoConstraints` 置 true 顶住重排）——实测两者都被 AppKit 的重排覆盖（`setFrame`/`zoom(_:)` 后三灯回 (16,16)），改为在缩放与进出全屏的通知上重做；标题换值是第四个时机、没有任何可接的通知，单独由 `setWindowTitle` 在写标题后兜住（KVO 未采用：NSWindow.h 未把 title 列为 KVO compliant）；红绿灯写死偏移 (+9,+9)——AppKit 的灯距/尺寸随系统版本可动，写死会在别的版本上叠错，改为「整组平移到首灯目标中心」，只锁两个数；材质用 `.followsWindowActiveState`（Electron 的 followWindow 默认）——上游试过并明确拒用，且它正是 AppKit 默认值，写成它等于没有等价面，拒；全屏标记写 `toggleAttribute`（属性值空串）——CSS 今天只判存在、行为等价，但上游 preload 写的是 `dataset.fullscreen = 'true'`，值形状照抄可避免将来任何值比较/快照断言分叉，拒空串形态；

自绘窗口按钮或隐藏系统红绿灯——丢掉系统全屏/最小化/关闭语义与辅助功能，拒；全屏标记走 A 桥或新消息通道——状态源在壳（窗口），而 A 桥是页面→壳的白名单/就绪门，方向相反且要过 sidecar-ready 门，拒；材质用 `.withinWindow`，或只把窗口底设成半透明色——`.withinWindow` 采样的是窗内背板，得不到窗后桌面的模糊，等于没有 vibrancy，拒；保留不透明窗底当作材质——页面在 darwin 下的透明区域就会露出那层色，与上游观感不是一回事，拒；透明规则完全照抄 vendor 选择器（只按 `data-platform='darwin'`）——「有 material」是窗口选项而非平台事实，同一平台仍可建出无材质的窗口形态（嵌入/预览），只按平台门控会在那些形态把侧栏 tint 与中列一起压到窗口底色上；改挂 `data-window-vibrancy`（有材质的窗口才落标记），代价是选择器与 vendor 不再逐字（规则体仍逐字，由测试锁住），拒照抄；用 6 条 Auto Layout 约束把三灯钉在 titlebar 上（探针可行：位置在缩放/改标题/最小化/全屏下全保持，零重排开销，约 8 行 vs 约 60 行）——会让 AppKit 自带的 12 条按钮约束消失、依赖私有 `NSTitlebarView` 的约束可被系统重建顶掉且没有任何通知可补救，标题换值时也要等下一轮布局才纠正；

事件驱动自愈没有这些前提，拒；`setWindowTitle` 保留「同值早退」——只省一次约 1µs 的幂等 apply，却让任何绕过接缝的写入永久留在默认位，拒早退；最小化/隐藏不做材质兜底——上游 darwin 明确做了（electron#25368 的材质重挂间隙）；本壳材质是常驻子视图、本机探针未见间隙，但兜底只是四个幂等通知 + 一次底色切换，且与上游同形，拒不做。

### 5.7 宿主路径引用面（`__DSH_HOST_PATHS__`）

composer 的拖入/回形针入稿有两条分支（上游 `apps/desktop/src/preload-app.ts` 的载体，消费点在 `ui-conversation` 的 `hostPathBridge()`/`addFiles` 与 `ui-attachment` 的 drop 监听）：有宿主路径 ⇒ 记成 `@相对路径`（文件夹带尾斜杠的 folder chip、非图片文件是同形引用），没有 ⇒ 文件回退上传——**文件夹在远端来源**（载体存在但 painted 门控为假）得到上游的 `attachment.pathUnavailable`「无法获取文件夹路径，请重新拖入」（重试指引不成立，且上游在该分支整批作废——同批文件既不上传也不成引用；残余登记于 S-56），只有纯浏览器（无载体）才是上游「只有桌面端支持添加文件夹」文案。两 flavor 均提供该载体（下表）；缺载体时桌面壳里的文件夹拖入退化成浏览器分支。

| 面 | Electron（镜像上游） | Swift（WKWebView 无该 API） |
|---|---|---|
| 取路径 | `packages/desktop/electron/preload.cts` 的 `exposeHostPaths()`：`webUtils.getPathForFile(file)`（Electron 29+；无 `webUtils` 则不暴露全局 = 浏览器分支） | DOM `File` 不携带路径，只能「事件前快照 + 事件中同步配对」：`macos/Sources/DSHChamber/HostPathCatalog.swift` 的主线程 `.common` Timer 观察 `NSPasteboard(name:.drag)`（拖拽开始即有内容，`changeCount` 变化才读；读门=可见+按键+指针在窗内，清门只看几何/可见性——释放不清快照），`NSOpenPanel` 回执走 `adoptPicked`；`bridge-shim.js` 在捕获相位记录本次投递的 File 名单（`drop` 在 window、`change` 在 document） |
| 配对 | `webUtils` 按 File 身份精确 | `pathFor(file)` = 作用域门 → 批次 → 目录条目（**唯一匹配**：目录按名（size===0 或列表无同名文件条目时可作候选），**文件要求精确字节数**；候选 0 个或 ≥2 个一律回退上传——同名同 size、同名目录+空文件跨类都不猜路径），批次只由可信事件（`event.isTrusted`：drop / 文件面板回执的 change）装填，目录快照必须比上一次投递更新（否则旧手势残留条目被拒绝）、可信 `paste` 直接清批，批次与条目各消费一次、批次门 5s、目录快照不设 TTL（慢速悬停没有上限；新鲜度由批次门与整体换代保证）、上限 256；配不到即 `''` |
| 入稿归属（intake） | 两 flavor 共用 vendor 补丁：`ui-attachment` 的 document 级 drop 监听按本壳自己的 `[data-instance]` 子树做 containment（`packages/renderer/scripts/vendor-patches.mjs` 两条精确改写，构建期生效、vendor 树零写入；产物 marker 由 `verify-vendor-patch-applied` 验证）——同一次 drop 只由落点所在的那个壳入稿，隐藏远端壳不再扇出（同时修掉既有的图片双附缺陷）；dragenter/dragover/dragleave 的副作用（dropEffect 否决、遮罩层、深度计数）与 drop 入稿同一归属判定。已接受取舍：落在所有实例壳之外的 drag/drop（chamber 侧栏、壳 chrome、跨实例 portal）不再由任何 composer 入稿（那些位置没有可达 composer）；布局里根本没有 `[data-instance]` 时按上游放行、有壳却解析不到自身则拒绝 |
| 范围门控 | 两 flavor 共用：文档根 `data-chamber-painted-source`（`packages/renderer/src/host-path-scope.ts` 的 `publishHostPathScope`，由屏上 `InstanceView` 按 active 发布 = App 的 paintedView，不是选择语义的 activeView；离开屏上 compare-and-clear）。只有屏上为本地实例才返回路径 | 同左（shim 读同一属性） |

**信任定位（重要）**：`data-chamber-painted-source` 是**协作路由标记，不是安全边界**——远端实例的 client bundle 与本页同 world（[09-client-plugin-runtime-loading.md](../client/09-client-plugin-runtime-loading.md) §4），可以写属性或在 composer 之前调用 `pathFor`，而 `pathFor(file)` 也拿不到调用者身份。把三条低成本滥用路径封死：合成事件（`isTrusted`）、全系统拖拽板（Swift 指针门：窗口可见 + 按键按下 + 指针在窗框内，离开即清）、名字猜配（文件精确 size）。剩余面 =「用户真实投递 + 同页恶意代码」，登记为残余（S-56）。**flavor 范围**：这三条封堵只对 Swift 腿成立——Electron 腿的 `pathFor` = painted 门 + `webUtils.getPathForFile(file)`（镜像上游，无批次/TTL/一次性消费），同页代码持任一真实 `File` 引用即可随时取宿主路径，不需要「本批次内投递」。

**粘贴的 flavor 分叉**：Electron 腿照上游（dropped/picked/pasted）天然覆盖粘贴；Swift 腿 v1 只覆盖拖入与回形针（读 `NSPasteboard.general` 有隐私面与时序耦合，列后续项），且 shim 在可信 `paste` 时清批以免粘贴借用上一手势条目。实机矩阵按 flavor 分开验。

**回形针的顺序假设**：`adoptPicked` 的 push 走异步 `evaluateJavaScript`，源码序（先推快照后回执）不等于执行序；实机判据含「回形针若改走上传即假设不成立」（fail-closed，不会给出错路径）。**参数面差异**：Swift 的 `pathFor` 接受任意 `{name,size}` 对象（同页代码可达，残余②），Electron/上游要求真 `File`（非 File 抛错→`''`）。**稳态成本**：隐藏到托盘时 0.15s 定时器仍走（容差 10%）；实测约 0.126% 单核，选择不按可见性停表（5+ 条 AppKit 通知的漏接风险大于收益）。

- **行为锁**：`packages/desktop/upstream-seats.test.ts`（S-56：双 flavor 载体 + painted 门控属性与 'local' 值锁步）、`packages/desktop/test/ipc/bridge-shim-host-paths.test.ts`（门控/可信事件/精确 size/目录按名/消费一次/TTL/代际/封顶/载荷失败闭合）、`macos/Tests/DSHChamberTests/HostPathCatalogTests.swift`（顺序/去重/封顶/指针门/载荷形状）、`packages/renderer/test/frame-chrome/host-path-scope.test.ts`（标记写入/清理与接线）、`packages/renderer/scripts/vendor-patches.test.mjs`（containment 执行测试 + 未打补丁负控制 + marker 锁步；产物门 = `verify-vendor-patch-applied`）。

**Rejected alternatives**：WKWebView 子类实现拖放目的地（`draggingEntered`/`performDragOperation` 读 `draggingPasteboard`）——能否收到回调取决于 WebKit 内部拖放目标的解析（内容视图 vs WKWebView 本体），未证；且若真成为目的地，WebKit 不再合成 DOM drop，必须自己消费并重放事件；拖拽板轮询与该解析无关，先采用可验证的一条。原生消费 drop 后合成 DOM 事件——需要伪造 `DataTransferItem.webkitGetAsEntry`（客户端据它判目录），且与 WebKit 自身合成的 drop 二选一，事件可信度/维护面都差，拒。同步 `prompt()` 桥（WKUIDelegate 的 runJavaScriptTextInputPanel）取精确路径——阻塞 JS、非常规用法，且拖拽结束后拖拽板可能已换代；作为轮询失效时的后手保留，不进 v1。私有 SPI `_dragDestinationAction`——本仓只容忍已有那一个 WebKit SPI（刷新率，有独立 C target 与探针），不为本面再引入，拒。不做（维持浏览器分支）——用户可感的桌面识别缺口（本地拖入文件夹被当作浏览器），且与上游桌面行为分叉，拒。把粘贴（general pasteboard）一并纳入 v1——读取 `NSPasteboard.general` 会把用户为别的 App 复制的文件路径读进页面（隐私面），且轮询时序与 ⌘C→⌘V 间隔耦合；v1 先覆盖拖入与回形针，粘贴列为后续项（残余登记见 STATUS）。把 painted 门控当安全边界，或按调用者身份门控——同一 JS realm 内没有页面可写的标记可被信任；上游签名（只有 File）也给不出调用者身份；要真边界只能把远端 client bundle 移进独立 realm/iframe，或对远端实例整体不暴露该全局——架构级改动，不在本次范围；只封低成本滥用面并如实登记残余。

## 6. 数据、状态兼容与共存

### 6.1 userData 目录

- 目录名机制：Electron userData = appData + `app.getName()`（取 package.json 顶层 `productName`、其次 `name`）。本仓 `productName` 只在 electron-builder 的 `build.productName`（只影响 .app/DMG 名），顶层没有 ⇒ 实际取到包名 ⇒ **实根 `~/Library/Application Support/@dsh-chamber/desktop`**（GUI 验收：运行中的打包宿主 `--user-data-dir=…/@dsh-chamber/desktop`；同源声明见 `packages/desktop/scripts/electron-dev.mjs`）。Swift 版**同根**（`PackagedLayout.userDataDir`，由 `packages/desktop/chamber-lock.test.ts` ⑦ lockstep 断言钉住：Swift 常量必须等于「顶层 productName ?? name」推导；改 identity 同步两侧）；sidecar 以 `--user-data-dir` 接收。
- 直拼点全集（参数化收口）：chamber-settings.json；runtime 基目录 = userData 本体（dsh-runtime 树在 `<userData>/dsh-runtime/…`）；stateDir = `userData/state`（localDshHome=state/dsh-home）；ssh-passwords.json；gateway-secrets.json；audit-log.jsonl；ssh-instances.json。
- 旧版 Electron 保留物 `*.corrupt` 保留禁用、不主动清理。
- 验证项 U1（实机）：Swift 计算的根与 Electron 打包实根一致。`PackagedLayout` 已按 `isPackaged` 解析——装配态 userData 与 Electron `app.getPath('userData')` 同根，payload-node/sidecar/vendor-dsh/web-dist 全 bundle-relative（唯一 Node 在 primary-runtime payload 内）；`DSH_CHAMBER_SHELL_*` 仍优先，dev 态保持 `dsh-chamber-dev` 隔离。验证 = `PackagedLayoutTests` + `chamber-lock.test.ts` ⑦ 跨语言 lockstep。

### 6.2 bundle id 与双 flavor 共存

- Swift 版 bundle id `com.dshchamber.native`，与 Electron 版（`com.dshchamber.desktop`）区分是硬前提；代价 = 通知授权按新 id 重新请求（风险 R4）。
- **WebKit 存储隔离**：WKWebView 的 WKWebsiteDataStore 落 `~/Library/WebKit/<新 bundle id>/`，与 Electron userData cookie/缓存是不同 jar——§6.1「同根零改动」不含 WebKit 存储；无跨进程共享开关；dsh web profile 的 launch-token 登录态在 WebKit jar 下的保持/重建属 P0 实测项（G 门）。
- 不迁移既有目录（避免改写/降级风险）。

### 6.3 互斥与单实例（flock）

- 同一 userData 根**绝不允许两 flavor 并发**（registry/凭据事务/runtime 树无跨进程锁）。实现（kernel-backed lock，不用 pidfile/mkdir stale 模式）：
  - 双 flavor 同持 `<userData>/.dsh-chamber.lock` 的 **flock(LOCK_EX|LOCK_NB)**（O_CREAT|O_NOFOLLOW，0600，原子创建）；fd 常驻进程寿命，进程死亡内核自动释放——天然免 stale。
  - 文件内 pid/启动时间**只作诊断与 sidecar 复验**（不是仲裁依据——仲裁始终是 flock 本身）。
  - **防自锁**：sidecar 若在新 fd 上再 flock 会与 Swift 首锁互斥（flock 按 open file description 计）——复验 = 读锁文件记录校验父 pid，**绝不二次 flock**。复验语义：记录 pid 是持锁方（Swift 壳）的 pid，sidecar 是其直接子进程 → `record.pid === process.ppid` =「我方父进程持锁」放行；`record.pid ∉ {self, ppid}` 且该 pid 仍存活 =「另一 flavor/实例占用」→ loud `exit 3`（Supervisor 对 exit 3 走 fatal、不重启）；`record.pid` 已死 = 陈旧记录（flock 随进程死亡由内核释放）→ 放行。
  - 锁文件与秘密文件同纪律（0600、no-follow、原子创建）；已登记进根 `AGENTS.md` 秘密文件纪律清单。
  - **Electron 侧同锁**（`packages/desktop/chamber-lock.ts`，归档面）：Node 无 flock API，但 Darwin `open(2)` 的 `O_EXLOCK|O_NONBLOCK` 可经 `fs.open` 数值 flags 使用（实测：同进程再次 open 得 EAGAIN、close 后可重取）——Electron main 在 whenReady 首步取同一把锁，失败 fail-closed 弹窗退出（`dialog.showErrorBox` + `app.exit(1)`），`app.on('quit')` 释放（清理链 settle 之后）。平台范围（有意收窄）：`O_EXLOCK` 为 BSD/Darwin 专有，Linux 需 flock(2)（Node 未导出）、Windows 无等价物；Swift flavor 仅 macOS，故非 darwin 返回 `unsupported` 并放行（调用方 loud 记录该范围，绝不假装已互斥）。
- 与既有机制：RuntimeOperationFence/RuntimeWriterFence（进程内单飞，dsh-runtime/runtime-operation-fence.ts）与跨进程 flock 正交互补。
- **state 根写者租约（L2）**：与上方 app 实例锁（L1，`<userData>/.dsh-chamber.lock`）不同 scope——L2 的单一文件是 `<stateRoot>/owner.json`（桌面/CLI 默认 `<userData>/state/owner.json`；host-root 另取 `<userData>/owner.json`，`scope` 字段区分），契约模块 `packages/control-plane/src/state-root-lease.ts`：no-follow O_EXCL + 回读终验、身份核实的活持有者拒绝（结构化 `state_root_locked` + holder pid/flavor + 判定依据；记录带 `identity{machineId,bootId,pidNamespace,procStartTicks}`；Linux 上重启/pid 复用按陈旧接管，macOS/Windows 读不到 bootId/ticks（身份字段全为 null），只做「写于本次开机之前」的代际推断、同一启动内的 pid 复用保守锁定——见 [17-server-side-gateway.md](../gateway/17-server-side-gateway.md) §12 与 STATUS 的跨平台残差）、陈旧记录 rename 认领 + 字节/identity 证明、token+inode 精确 release（不匹配 `state_root_not_owner` 且绝不删除）、未知 `schemaVersion` fail-closed、同进程同根 `state_root_duplicate`。
- gateway 在首次 store 写之前取锁并把**同一 handle** 传 store/plane/runtime-manager（它们只 `assertCurrent`，仅顶层 owner 在其写者静止后 release）；**同一 state 根只有一个写者**，第二写者 fail-closed 退出 3（gateway/CLI/standalone 形态；确定性冲突，systemd 单元不自动重启，其余启动失败仍为 1），逃生口由单一 `resolveStateRoot` 承担（`--state-dir` > `DSH_<FLAVOR>_STATE` > `DSH_CHAMBER_STATE` > `~/.dsh-chamber`）。Swift 时序：壳先持 L1 flock → spawn sidecar → sidecar 取 host-root（L2）→ 装配期经 plane 取 state-root（L2，严格先于 `start` 的 reaper）；host-root 或 state-root 冲突时 sidecar stderr 输出 `state_root_locked` + holder pid/flavor + root 并以 `EXIT_STARTUP_FAILURE=70` 退出（Supervisor 按 fatal 不重启；70 是 sidecar 自己的分级，L1 目录锁的 3 另有所指）。

### 6.4 凭据与安全文件

- SSH 密码镜像（ssh-passwords.json v2）：endpoint-bound 0600 明文，Swift flavor 语义不变。
- gateway-secrets（v3，safeStorage|plaintext 判别）：Swift flavor 无 safeStorage → 新写一律 plaintext 判别 + 0600 原子写（既有诚实回退）；读旧 safeStorage 判别条目 → 解密不可用 → **保留文件与绑定、标记禁用待重录**（复用「legacy 保留禁用」语义；判别路径补单测 S1）。
- 静态加密按决策 7（Keychain 持随机文件密钥 + HostEdges encrypt/decrypt edge）设计，不在当前范围。

## 7. 更新（design 11 的 Swift 侧形态）

- Electron 版维持 electron-updater（GitHub provider、zip target）不动（归档参考，见 [11-auto-update.md](../archive/11-auto-update.md)）。
- **Swift 版更新链 = Sparkle 2（「D-1 选 B」）**：壳内 `AppUpdater`（`macos/Sources/DSHChamber/AppUpdater.swift`）持 `SPUStandardUpdaterController`，承担检查 → 下载 → 重启并安装。安装必须由 bundle 外 helper 完成（运行中的 .app 不能覆盖自己），更新包以 **EdDSA 公钥**（`SUPublicEDKey`）鉴权（与 Developer ID 签名/公证两回事：后者分发信任，前者更新通道鉴权）。
- **装配**：`Info.plist` 的 `SUFeedURL`/`SUPublicEDKey` 由 `build-swift-app` 的 `--sparkle-feed`/`--sparkle-public-key` 注入（占位符 `__SPARKLE_FEED_URL__` / `__SPARKLE_PUBLIC_ED_KEY__`）；任一为空 = 更新不可用（菜单「检查更新…」禁用，不声明 `--native-updater sparkle`）。`SUEnableAutomaticChecks` 模板常量 **true**：每次启动强制一次后台检查（S-37），此后 `SUScheduledCheckInterval=600`（10 min；与 `update-schedule.ts` 的默认 600_000ms 同值，可经环境覆盖，退避上限 1h）；scheduled 标准窗被壳内抑制（`SPUStandardUserDriverDelegate` 把展示权收回壳 → 相位进设置页），用户手动的「检查更新…」仍走标准窗。
- **最低系统版本**：两 flavor 同为 **macOS 14.4**（`build.mac.minimumSystemVersion` 与 `LSMinimumSystemVersion` 写精确 14.4；`Package.swift` 的 `.macOS` 只能写 major，故写 `.macOS(.v14)`，精确下限由 Info.plist 承担；三处一致由 release 策略测试钉住）。**为什么 14.4**：OS WebKit 的出货 bundle 在多处构造路径直接调 `Promise.withResolvers`，该 API 自 Safari 17.4 / macOS 14.4 才有（13.x 与 14.0–14.3 会构造期 TypeError）；Electron 自带 V8 不受影响，但同一支持矩阵只保留一个下限（抬高下限，不加 polyfill）。
- **feed 必须 appcast**：Sparkle 只读 appcast（XML feed + EdDSA 签名），不消费 GitHub REST API 或 `latest-mac.yml`；`SUFeedURL` 指向本仓 release 自带资产：稳定通道 `releases/latest/download/appcast-swift.xml`，beta 通道 `releases/download/appcast-swift-beta/appcast-swift-beta.xml`（滚动 tag `appcast-swift-beta`，每 beta `--clobber` 覆盖 ⇒ beta.N 见 beta.N+1）。
- **双 flavor 分工**：壳声明原生更新器可用时检查也由壳承担——页面「检查更新」经 `updateNativeAction kind=check` 转 Sparkle，页面只消费壳推回的 `dsh-chamber:update-state-changed` 相位（checking/available/downloading/downloaded/installing/failed），不再发 GitHub Releases 查询；Electron（无原生腿）保留 headless GitHub 检查。sidecar 清空 `installBlockedReason`，「更新 / 重启并安装」经 edge（`updateNativeCapability` / `updateNativeAction`）：`kind=check` → 壳内检查，`kind=download|install` → Sparkle 标准窗口（无「仅下载」公开 API），忙碌/未配置/未知 kind 如实拒绝；能力查询回 `{available, error}`，坏 feed/密钥不再「假装可用」（S-38/S-39）；无原生腿时仍回显「原生壳不支持自动安装」。
- **安装前清理**：`SPUUpdaterDelegate.updater(_:willInstallUpdate:)` 先停受管 sidecar、收 keep-awake 与 Dock 角标（安装路径不保证先走我们的退出链）。打包：`build-swift-app` 把 `Sparkle.framework` 嵌入 `Contents/Frameworks`、补 `@executable_path/../Frameworks` rpath 并校验（嵌入先于签名）。
- **发布（增量更新）**：`SPARKLE_PUBLIC_ED_KEY` 注入 feed/公钥、`SPARKLE_PRIVATE_KEY` 签名 appcast；**单钥匙是发布 FAIL**（公钥在而私钥缺 = 壳会轮询没人签的 feed；私钥在而公钥缺 = 会发布一个「带签名 appcast 却检查不到更新」的包，而且它的 zip 之后会被当成产不出 delta 的基线），两钥匙都缺才是 loud 降级（照常出包、自动更新关闭）。**stable 与 beta 的收件目录/feed 上传面完全分开**（`/tmp/appcast-in-stable` / `/tmp/appcast-in-beta`）：generate_appcast 按归档内嵌 `SUFeedURL` 的文件名分组，两通道归档同目录 + `-o` 会直接失败 `multiple appcasts found`。每通道 stage 本通道前 K 个历史 zip（`SPARKLE_DELTA_SOURCES`，默认 2、上限 5；两个通道都保留双版本增量覆盖）。两个通道都要求基线自带与当前发布公钥一致的非空 `SUPublicEDKey`、且与当前 app 同分支（同 `LSMinimumSystemVersion`；解包主 app 的 `Info.plist` 判定，stable 侧再要求那次 release 带过 `appcast-swift.xml` 作廉价预筛）——没有公钥的旧 app，Sparkle 既不产 delta 也不写放弃标记；

  空 key/密钥轮换后的旧 key 会产出「任何公钥都验不过」的 delta；跨分支的历史包会让 feed 出现第二个条目。这些都只降覆盖率、不作基线（loud notice））→ 产出 `<sparkle:deltas>`（Sparkle 原生增量，客户端零改动、失败回退整包）：stable 用 `--maximum-versions 1` 保持单条目（历史 zip 只当 delta 基线、不进 feed，避免 `releases/latest` 死链），beta 保留最近 3 条（合并时把旧 feed 的 beta 条目也并回来并以 `--beta-item-limit` 截断：staging 少收归档时旧 beta 不许消失）；verify 在没有任何放弃/丢失时按最新基线精确断言 `deltaFrom` 且 delta 条数 = staged 基线数，否则只要求已核实的匹配数；并另有逐基线账目——每个 staged 基线要么在 appcast 里有它自己的 `deltaFrom`、要么 Sparkle 为（新构建号, 它）写了放弃标记 `*.ignore`，两者都不是即点名 FAIL（逐条归因才挡得住「多 branch / 多条 feed 的标记互相顶替」，且全部被放弃时门禁也不退化）；

  此外 verify 会用 `SPARKLE_PUBLIC_ED_KEY` 对本版本 zip 与每个 delta 逐条做 Ed25519 真验签（`--signatures-dir` 提供真实字节）——只查「签名存在」挡不住密钥轮换后那个任何公钥都验不过的签名。**Sparkle 主动放弃 ≠ 链路退化**：它按体积规则（delta > 7/8 整包）放弃时只在收件缓存写 `*.ignore`、stdout 无提示——发布腿据此把那些基线降级为 loud 警告 + 整包下载，只有「没有放弃标记却没产出 delta」才 FAIL。**enclosure 必须可解析**：beta 生成时 `--download-url-prefix` 指向滚动 tag，当前 beta zip 与本次新 delta 先传滚动 release 再传 appcast（S-36）；stable 不传前缀（形状除新增 `<sparkle:deltas>` 外不变），delta 随 draft 上传。**stable appcast 从不发布到滚动 release**；S-23 刷新只把 final zip + stable delta 推到滚动 release（先归档后 feed），并覆盖滚动 beta feed。

  **S-23 改法**：beta feed 的 final 条目由 `scripts/release/feed/merge-native-feed.mjs` 从已发布 stable feed 复制并改挂版本固定前缀 `releases/download/<stable-tag>/`（缺 stable feed 时保留上次滚动 feed 里的 final 条目，绝不删可见性）；stable 发布时以「已发布滚动 feed 的 beta 条目 + 本次 final 条目（URL 改写为滚动前缀）」合并刷新滚动 feed。**两个前缀是契约**：beta 期抄来的 final 走版本固定前缀（`releases/latest` 会被后续正式版移走 ⇒ 404），stable 刷新后的 final 走滚动前缀；beta.N 见 beta.N+1 与后发 final（S-22/S-23）。契约：`UpdateController.restartAndInstallAsync?()` 为原生腿提供异步面（IPC 处理器优先用它），Electron 的同步实现与页面契约不变。
- **同版本重跑**：滚动 release 是公开面，重跑时先比对同名 zip 的字节——一致才允许覆盖（幂等重跑），不一致直接 FAIL 并提示提升 beta 号（否则已发布 feed 的签名指向的字节变了，客户端先验签失败）。
- **公证重叠**：.app 与 .dmg 各自需要 Apple 票据，但 dmg 提交在 .app 装订、zip/dmg 生成之后转入后台，与随后的 appcast 生成（staging + delta）重叠；verify 步轮询状态文件（900s 上限；PID 消失且无状态即 fail-fast）后才 staple/validate dmg，超时或非零即 fail-closed。dmg 失败会在 appcast 之后、upload 之前才报出（appcast 只落盘，不提前上传）。这不是跳过 dmg 公证，也不改变「.app staple 先于最终归档」的顺序。
- **draft 面顺序**：appcast 在 zip/delta 之后才上传到 draft（S-36 的「归档先于 feed」不再依赖「draft 不可见」）。
- **预览通道订阅（`betaUpdates`，设置页开关，纯用户偏好）**：更新通道只由用户偏好决定，与安装包版本后缀无关。`<userData>/chamber-settings.json` 的 `betaUpdates?: boolean`（缺省未设置 = 关；false = 明确关闭）持久保存；生效通道 = `DSH_CHAMBER_UPDATE_CHANNEL=beta`（恒最强，仅加 beta）或（本构建的两条通道 feed URL 可用且 `betaUpdates=true`）→ beta，否则 stable。两条 feed 都构建期注入（stable/beta 两种 native 构建都注入同一对 URL）：`SUFeedURL` 保持现状（发布链按归档内嵌 feed 分组生成 appcast，不得改烤值）、`DSHChamberStableFeedURL`（稳定 appcast，`releases/latest/download/appcast-swift.xml`）与 `DSHChamberBetaFeedURL`（滚动 beta appcast）由 `build-swift-app --sparkle-stable-feed/--sparkle-beta-feed` 注入，两条 URL 必须成对（只缺一个 = 装配 FAIL；都缺 = 旧构建，开关不可用）；`AppUpdater` 的 `feedURLString(for:)`：beta 通道 → beta URL，stable 通道 → stable URL（未配置则 nil 走 `SUFeedURL`，仅旧构建）。
- **beta 构建默认也是 stable 通道**：开关关闭时只收正式版（该系列 final 发布时版本更高，仍会被推送并自动收口）；打开开关一次后偏好持久，之后每轮 beta 都会继续收到。**季节性生命周期**：正式期里 beta feed 的最新条目就是正式版（S-23），订阅在正式期无副作用。**运行期生效**：设置变更经 settings-changed → 壳重读 `chamber-settings.json` → `applyBetaUpdates` 重算通道；变化时在空闲期发起一次后台检查（忙态 `resetUpdateCycle()` 延后），不弹 Sparkle 标准窗、不降级；发现单源不变（仍只有壳内 Sparkle）。**UI**：设置 → 通用 → 更新组一行「接收预览版（beta）更新」开关（所有构建都是普通开关；构建未注入通道 URL 时禁用并给原因；开关状态回读壳的生效通道）。**边界**：beta 周期中途关闭开关只影响后续检查（不降级；已下载的更新仍按原相位安装）；跨通道切换通常整包下载（beta feed 的 delta 基线是 beta 构建）。**Electron 冻结腿不消费该字段**（其更新腿只认封签/`DSH_CHAMBER_UPDATE_CHANNEL`）。
- **shell-flavor 判别字段**：`dsh-chamber:info` 载荷带 `flavor`（`main.ts` 的 `hostFacts`；镜像面仍 4 标量），但共享 renderer 至今无消费者——UI 能力门（更新文案/重启安装按钮）实际由 `installBlockedReason` 与原生能力位驱动；字段保留备查（用前须补消费者与 preload.cts/global.d.ts 镜像测试）。
- **检查腿的宿主叶**：headless 控制器 `setState` 时逐个 listener 走 try/catch，推送腿抛错绝不反噬控制器（`update-headless.ts`）；sidecar-ctx 的 HostEdges 必须**显式**提供惰性 `disarmUpdaterQuit: () => {}`（`sidecar-ctx.ts` 的 `disarmUpdaterQuit`）——methodStub 把「缺失成员」变成调用即抛的 `sidecar-ctx-unavailable:*` 递归 stub（`sidecar-ctx.ts` 的 `methodStub`），省略会让首次「检查更新」抛错、checking 卡死；这是有意的惰性契约叶，不是死代码。

**Rejected alternatives（更新链）**：① 两通道共用一个收件目录——首个正式版原生包落地时必报 `multiple appcasts found`，否；② beta 腿下载最新正式版 zip 放进收件目录（S-36 旧做法）——每次 beta 多下 83MB，且 final 条目 URL 依赖可变的 `releases/latest`，改为从已发布 stable feed 复制条目；③ 用「放弃标记计数」精确复现 Sparkle 的 7/8 体积规则并硬 FAIL——合法的大改版会误红正式发布，改为标记存在即 loud 降级、无标记才 FAIL（签名失败另行硬失败）；④ 把 delta 期望逐条绑到每个基线——`--maximum-deltas` 与 branch point 会让合法放弃变成红，改为「最新基线精确 + 条数 ≥ 剩余基线数 + 账目守恒」；⑤ stable 保留多条历史条目——历史条目会引用 `releases/latest/download/<旧 zip>` 死链，改为 `--maximum-versions 1`；⑥ beta 降为 1 个 delta 基线——可省约 1m11s job 墙钟，但要求 beta 与 stable 一样保留双版本增量覆盖，不采纳，保留 2；⑦ 让 dmg 公证继续阻塞——3m47s 与 appcast 串行相加；让 app/dmg 两个提交真正并发——dmg 必须在 app 装订前生成，装订后重做 dmg 会使票据失效；把 dmg 拆独立 job——再付一次 runner 排队与产物传输。均否决，改为「dmg 后台提交 + verify 有界等待」。
**Rejected alternatives（beta 通道）**：① 让 beta 构建把 `SUFeedURL` 改烤 stable feed、再靠 delegate 切回 beta——发布链按归档内嵌 `SUFeedURL` 分组生成 appcast（`multiple appcasts found` 纪律），改烤值会让 beta 通道归档被按 stable 分组，风险远大于多注入一条 URL；② 保留「beta 构建 = beta 通道」（版本后缀入表）——用户裁决通道是纯偏好，beta 构建默认应只收正式版；③ 单 appcast + `<sparkle:channel>`——须改 appcast 生成/合并/校验，且每次 beta 都要刷新 stable feed。

### 7.1 差异复核方法：可达性优先

双端差异复核顺序固定为**可达性 → 用户可见性 → 最小改动位置**（来源：open-in 复核，见 [deviations.md](../../progress/deviations.md) §7）：① 先查调用点/消费者（`grep "edges\.<member>("\`、A 桥通道消费者、host 包域使用者）；无调用点 = 潜伏差异，不进修复队列；② 只修「可达且用户可见」的差异，位置优先 `macos/`；③ 跨出 `macos/` 必须给出调用点证据：只有新增能力/通道/契约才动共享面，否则只登记；④ **契约面 ≠ 功能面**：`HostEdges` 有成员不等于用户路径有行为（潜伏 10 / 可达 6）。`SwiftEdgeHostLegs` 能力分三栏：**共享执行面（可达，必须与 Electron 逐字一致）**、**壳侧执行面（shell-internal/超集，不宣称共享契约）**、**潜伏契约面（保留形状，等第一个消费者）**。

## 8. 验证与测试

### 8.1 验证门（P0 判定：G1–G5 + C1/C2）

P0 判定全过才继续：**G1** 主界面（多实例/会话/设置页）在 WebKit 渲染无功能缺口；**G2** 剪贴板复制粘贴（含富文本）、文件拖拽（附件/file input）、外链跳转、非 http(s) scheme 导航；**G3** 侧栏插件（git/open-in/settings-bridge）可用；**G4** 深链冷启动不丢、通知点击可激活会话；**G5** 退出/隐藏/唤醒补发语义与 Electron 版一致，且 hide 后 ≥30s 的 SSE/WS 心跳与唤醒即时重连实测（C1：backgroundThrottling:false 无 WKWebView 等价物）；**C2** 双 flavor 交替用同一 userData/dsh 实例时 WebKit 独立存储 jar 下会话 cookie/登录态实测并定共存语义。任一实质失败 → 回路线评估（ADR-0002）；C1 失败 = 登记已知降级或走 keep-alive/唤醒补发，C2 = 定共存语义后继续。P0 预检：双端同机跑 boot 参考点（方法见 `scripts/perf/README.md`），只为尽早暴露引擎级数量级异常，不作定标。

A 桥 P0 判定：`macos/` 最小壳加载控制面 origin 的壳文档（`/`），dev 后端 = `sidecar-entry.ts`（`DSH_CHAMBER_SHELL_*` 可覆盖 userData/port/dsh path）；`info`、`desktop_ssh_instances_get`、`desktop_ssh_status_changed` 推送与通知 click 真实回环接通。

自动化门：`node scripts/gates/runners/run-checks.mjs static`（含 electron-free-gate / bridge-manifest / bridge-shim / bridge-shim-surface / ipc-surface-mirror 等锁步）+ `test:desktop` + `test:macos`（darwin 锁断言与打包脚本套件）+ `swift build`/XCTest；侧车协议面由 `sidecar-stdio.test.ts` 的假 Swift 驱动冒烟全通道（写 Swift 前先用现有 JS 测试资产钉住 B 桥协议）。

### 8.2 测试分层

| 层 | 内容 | 契约 |
|---|---|---|
| JS 业务 | desktop/control-plane/runtime 现有单测与镜像测试 | 原样复用（拆分后跑同一文件集 + 3 个文本锚点测试随迁） |
| B 桥 | 信封/帧长/超时/乱序/edge 往返 | node 侧假 Swift 驱动（`sidecar-stdio.test.ts`）+ Swift 侧 XCTest（`BridgeClient*Tests`） |
| A 桥/护栏 | shim 与 manifest 一致性（bridge-manifest / bridge-shim / bridge-shim-surface）、origin 门、尺寸门 | 有测试覆盖 |
| 集成 | node 集成测试拉起 Swift harness 断言真实窗口/通知/深链 | 无 GUI 通道冒烟有；真实窗口 harness（`swift-harness-driver`）需 GUI 会话 |
| 壳视图策略 | 视口越界策略（§5.2）与刷新率策略（§5.1）的注入契约与装配点 | `ShellOverscrollPolicyTests` / `RefreshRatePolicyTests` 有单测锁定契约；视口与刷新率实际效果属实机目检 |
| 实机 | 打包态全链走查（控制面起动/本地实例预启动/连接/网关凭据重录/运行时版本管理与回退/插件同步/归档管理器入口/通知点击/深链/隐藏恢复/唤醒补发/退出确认）与 WKWebView parity（W1 剪贴板、W2 菜单快捷键、W3 富文本粘贴与拖拽、W4 打印/查找、W5 字体/滚动/IME、W6 后台节流对 SSE/WS、W7 刷新率三工况） | 按 [gui-acceptance-checklist.md](../../checklists/acceptance/gui-acceptance-checklist.md) §4.2 执行 |
| 性能与体积 | 双端同环境 A/B 纪律（方法与环境见 `scripts/perf/README.md`）；双端性能/产物体积验收协议 = 相对门/绝对预算/能力门、注入式探针平移四场景、M5 双端同 tag 的 .app/dmg/zip 目标 ≤ Electron × 0.75 | 见 `scripts/perf/README.md` 与 gui-acceptance-checklist |

### 8.3 Swift 壳 v1 实施与双端 harness

E1–E20 按 §5 实现（E15 走 §6.4）；manifest 生成与三件锁步护栏（§4.4.3）；Supervisor 与启动序列（§3.3）；A 桥 shim 全通道对拍；双端 harness 冒烟（`swift-harness-driver`：node 集成测试拉起 Swift harness 断言真实窗口/桥，`loopback-http-test-server.ts` 同款思路）需 GUI 会话，验收按 [gui-acceptance-checklist.md](../../checklists/acceptance/gui-acceptance-checklist.md)。

### 8.4 发布产物装配与桌面集成（DMG / SwiftPM 资源 / 构建链）

- **DMG 拖拽引导**：与 Electron 同款——背景 = electron-builder 模板的双 rep TIFF（540×380@72dpi + 1080×760@144dpi；`macos/resources/dmg-background.tiff`，署名见 THIRD_PARTY_NOTICES），图标坐标取 electron-builder 默认 contents（app 130,220 / Applications 410,220），窗口尺寸 = 背景 1x 尺寸。单一来源 = `macos/scripts/dmg.mjs`（本地装配腿 import，release.yml 正式腿调 CLI）：UDRW 可写镜像 → 挂载 `/Volumes/<卷名>` → osascript 驱动 Finder 写 `.DS_Store` → 等内容级布局落盘（`.icvp` 的 `backgroundType=2` + 指向卷内背景图的别名）→ detach → UDZO → 产物级校验（只读挂载成品读 `.DS_Store`：`backgroundType=2`、非空且指向卷内背景图的别名、`iconSize`、窗口尺寸、两条图标坐标；`.app`/`/Applications` 软链/`.background` 的存在性只是前置）。别名的可解析性由 Carbon `FSResolveAliasWithMountFlags` 在最终 UDZO 上实测确认（挂载态 RESOLVED；Finder 自己并不校验别名），门禁只断言必要条件：别名字节同时含卷内相对路径与本卷卷名。失败一律 loud（回退成「没有提示的 DMG」等于把缺陷重新发出）。**被否决的替代**：`dmg-builder` 下载的 dmgbuild（不驱动 Finder，要引入 electron-builder 内部下载器/缓存）；手绘 1x PNG（分辨率低、不像 Electron）；静态 `.DS_Store` 模板 + `hdiutil -srcfolder`（alias 与卷名/CNID 绑定，跨构建脆弱）；只留软链不做引导；用 `plutil -extract <key> raw -o -` 逐键读布局而不自写二进制 plist 读取器（为让事实提取成为零子进程、可注入的纯函数；代价是自守有符号整数读取）。
- **SwiftPM 资源包形态**：包内形态随后端——`native` 扁平 `<bundle>/bridge-shim.js`，`swiftbuild`（Swift 6.4+ 默认）为 `<bundle>/Contents/Resources/bridge-shim.js`。装配腿 `resourceBundleResourcesDir()` 统一收敛为扁平（与 release.yml 的资源断言、运行期查找同契约），运行期 `ChamberResources.candidateURLs()` 兼容嵌套形态（dev `swift run`）。备选 ① 显式 `--build-system native`（已 deprecated、且管不到 dev/test 与 `swift run`）、② 重指 `macos/.build/release` 到 native 产物（只治标、两种形态照旧）——都被否。
- **构建链与 CI**：`prepare-python-payload --with-node --with-pnpm` + `prepare-office-assets` + `build:sidecar --require-python --require-node --require-pnpm --require-office-assets`（缺件 fail-closed），打包后 `--verify` 复核 payload（node/pnpm/python）与 office 8 文件内容；`build-swift-app.mjs` 装配断言 payload Node 与 office 结构、拒绝旧布局 node/node.exe/dsh-chamber-helper；CI = GitHub Actions macOS runner（`swift build` + XCTest + 打包 + ad-hoc / Developer ID + notarize——mac 发布前置 = Apple 凭据），图标/资源复用（icon.icns 平移）。

- **键盘快捷键桥（rc.2）**：官方 `dsh-client-shortcuts` provider 在 desktop 运行时要求 `window.dshDesktop.keyboard`（缺即构造期 `Desktop keyboard bridge unavailable`）。Electron 腿由主进程 `before-input-event` 产出规范化 input（命中组合才投递、`setIgnoreMenuShortcuts`、blur/导航复位），偏好经 `ShortcutPersistence` 落 `<userData>/keybindings.json`（0600 原子写）；Swift 腿在 documentStart 注入的 `dshDesktop` 里以主文档 keydown/keyup 归一化投递，revision 由会话内适配器持有。Swift 边界（accepted，登记 deviations S-54）：不能 `preventDefault`（页面同样收到该键）、无子 frame/webview 与原生菜单源、偏好仅会话内存、`closeWindow` loud reject（Cmd+W 由原生菜单承担）。
### 8.5 实机矩阵（打包态全链 + W1–W7）

双端性能/产物体积 A/B（方法与环境见 `scripts/perf/README.md`）：相对门 / 绝对预算 / 能力门、注入式探针平移四场景、M5 双端同 tag 的 .app/dmg/zip 目标 ≤ Electron × 0.75。

打包态全链逐项走查：控制面起动/本地实例预启动/连接/网关凭据重录/运行时版本管理与回退/插件同步/归档管理器入口/通知点击/深链/隐藏恢复/唤醒补发/退出确认；更新通道订阅、`.app` 双击/首启、WKWebView 页面装载与 §5.2 视口、C1/C2（含 S-10 隐藏态/App Nap 与心跳）、刷新率三工况（S-48）、通知音效回落、键盘桥（S-54）、macOS 14.4 首启（S-50）、Developer ID/公证/stapler/spctl 与首个 build-swift 发布腿。

**WKWebView parity 判定（W1–W7）**：

| 项 | 通过判据 | 失败处置 |
|---|---|---|
| W1 剪贴板（富文本复制/粘贴） | 会话复制富文本（代码块/表格）粘贴进外部富文本 app 保结构；页内粘贴正常 | 仅纯文本/结构丢/粘贴被吞，或写剪贴板需弹权限而 UI 无流程 → 归因（渲染 vs 权限），修复预算 ≤2–3 人-日；超预算或 P0 期失败 → 回退路线评估（G1–G5/C1/C2 门） |
| W2 菜单快捷键 | Cmd+C/V/A/全选与 Electron 一致 | 快捷键无响应（first-responder 断）→ 必修 |
| W3 富文本粘贴 + 文件拖拽 | 拖文件进 composer 成附件；拖进归档对话框入口可用 | 拖拽无反应或触发导航 → 同 W1 |
| W4 打印/查找 | Cmd+P 弹系统打印对话框且内容合理；Cmd+F 若 dsh UI 未实现查找则 N/A（登记不视为失败） | 打印无对话框/空白 → N/A 不阻断；真失败按渲染差异排查 |
| W5 字体/滚动/IME | 中文输入无吞字/乱序；长会话滚动无感卡顿；无方块字 | IME 丢字；滚动明显劣于 Electron；字体破损 → 归因 WebKit 渲染差异，按 W1 预算 |
| W6 后台节流对 SSE/WS | 隐藏/失焦后 SSE/WS 心跳不断、恢复即时（≤现 Electron 语义） | 后台 WS 掉线且无法自动重连或恢复 >30s → 归因 WebKit 节流，改 keep-alive/唤醒补发（core 具备） |
| W7 刷新率三工况 | 打包态：插电 120fps；电池 + 低电量模式 60fps（系统级帧间隔 ×2）；60Hz 外接屏不回退 | 任一工况达不到，或启动日志与 `[shell-fps]` 实测矛盾 → 归因（渲染侧偏好 vs 系统节流）；日志标「面板上限」时以 `[shell-fps]` 实测为准 |

### 8.6 验收程序

按 [gui-acceptance-checklist.md](../../checklists/acceptance/gui-acceptance-checklist.md) §4.2 执行并记录证据；性能口径见 `scripts/perf/README.md`。

## 9. 风险与限制

- **R1 双业务源码漂移**：core 拆分后 Electron 版独立演进会让 Swift 版滞后。缓解：单 repo 单 core；host-edge 契约评审门禁；mirror + bridge-manifest 双锁步（含 `bridge-shim-surface.test.ts`）；同 tag 双壳发布。
- **R2 WKWebView 差异**：渲染引擎/权限模型/devtools 不同；无 backgroundThrottling/unresponsive 等价物（C1）；无网页 Notification 预拒绝 API；存储独立 jar（C2）。缓解：P0 先行证伪（G1–G5 + C1/C2），见 §8 实机列。
- **R3 Node 版本与架构**：单 Node 后不再有独立 sidecar Node pin——版本/摘要随 `primary-runtime-lock.json`（`nodeVersion`，§4.3），升级 lock 是全链路行为变更（payload node/托管 dsh/签名公证重验）；v1 为 arm64-only（x86_64/universal2 未出货，决策 6 剩余项）。
- **R4 通知授权身份变更**：新 bundle id → 用户需重新授权通知。
- **R5 目录并发互斥**：§6.3 flock 为仓库首个跨进程锁，协议需新定义（格式/诊断字段/双进程复验）；与进程内围栏正交。
- **R6 旧 safeStorage 密文迁移**：Swift flavor 首启遇旧 gateway 凭据不可解密——「保留禁用待重录」（S1 单测）。
- **R7 Swift 代码面安全评审**：桥护栏（§4.4.1/§4.4.2）是新信任边界；负例测试覆盖伪造 frame/超大帧/非协议流/伪造事件名/越 origin。
- **R8 更新密钥与回滚**：Sparkle 密钥/回滚面单独评审（§7）。
- **R9 维护负担**：Swift 壳新增一门语言/一条 macOS CI；需有人持续负责 Swift 侧。
- **R10 开发期双后端竞态**：Electron dev 与 sidecar dev 共享 cp 端口族 → 各自退避 + 端口钉死 + 独立 .dev-user-data。
- **R11 Swift 侧人手单点**：护栏规则集中 DSHChamber 单 target + Generated 产物减少手写面。
- **R12 manifest 解析脆弱性**：正则扫字面量会漏新写法 → 复用 mirror 解析函数 + 通道数守恒断言（数值以 `bridge-manifest.json` 的 `counts` 与测试为准，不手抄）。
- **R13 WKWebView devtools**：默认关；发布态由设置页运行期开关显式开启（§5.1.1），`#if DEBUG` 构建仅在无设置文件/文件级损坏（不动作）时保留开发便利的默认开。inspector 属信任边界。

**Rejected alternatives（架构调整）**：**装配保持两份**（main.ts 与 sidecar-ctx.ts 各自维护整套装配）：否决——去空白后 186 行逐字重复且已出现微差漂移；改为 `packages/desktop/host-assembly.ts` 的 `createHostAssembly(deps)` 单实现，两 flavor 只留各自 edge 接线（实测重复 186→3；差异全部经 `HostAssemblyDeps` 显式注入，体内零 flavor 分支）。**深链 scheme 放 shell-core、deep-link 反向 import**：否决——shell-core 顶层 `new BoundedVscodeIntentQueue(...)` 来自 deep-link.ts，反向 import 形成 ESM 值依赖环并命中 class TDZ；改为零依赖 leaf `deep-link-scheme.ts`，两侧比较收敛为 `isDeepLinkUrl`/`isDeepLinkProtocol`。**state 根沿用三把锁**（gateway `.gateway.lock` + `dsh-runtime/owner.json` + serve/standalone 无锁入口）：否决——三处语义不同，且无锁入口可与运行中 gateway 双写同一 state 根；改为单一 `<stateRoot>/owner.json` 租约模块（`state-root-lease.ts`，§6.3 的 L2），L1 app 实例 flock 保持不动（不同文件、不同 scope）。**把 Swift 布局锚点迁移与 R1/R2 同批做**：推迟——`PackagedLayoutTests.swift` 文本锁 sidecar-ctx 的七个助手与 `resolvePnpmEntry` 候选顺序，迁移属 macOS 实机门；本次保持锚点逐字成立（静态核对通过）。

### 9.1 A 桥导航与 sidecar 重启的时序契约

每个注入文档生成独立 `documentId`，与请求 ID 一起进入信封并由 Swift 回显。页面只接受同文档回执，避免重载后旧文档的 `id=1` 结算新文档的 `id=1`。B 桥调用按方法设置期限；导航只需丢弃旧文档回执，sidecar 退出会作废全部在途调用。新 ready 帧触发 `info` 再水化、通知监听重新握手与会话事实对账。WebContent 自动重载期间窗口标题显示本地化恢复状态，导航完成后清除。

**Rejected alternatives**：只用请求 ID 无法区分导航前后的重复编号；只重新读取 `info` 会让通知打开监听与事实基线保持在旧 sidecar 世代；把普通调用无限等待会让宿主重启后页面永久悬挂；用 `evaluateJavaScript("1")` 证明内容已绘制不成立，它只证明 JS 上下文应答。可见页的主动 rAF 心跳证明帧调度仍在前进，但 WKWebView 不向宿主暴露最终合成帧的提交游标；JS 与 rAF 同时正常而像素仍停滞时，宿主依旧无法单凭该探针自动重载。
**Rejected alternatives（恢复预算）**：把排定后被新导航取消的重载仍计入 60s 配额，会让零次实际重载也耗尽三次预算；取消时退还该次计数，并用排程代际阻断取消后迟到执行的 work item。

## 相关文档

- [ADR-0002 swift-only-flavor](../decisions/0002-swift-only-flavor.md)（唯一出货 flavor / Electron 冻结的架构决策）
- [electron-frozen.md](../../progress/electron-frozen.md)（冻结范围、共享契约、复活清单）
- [05-connection-manager.md](../control-plane/05-connection-manager.md) §7.4/§7.5（IPC 白名单、本地实例）
- [02-host-management-deployment.md](../runtime/02-host-management-deployment.md) §3.8（日志 sink 纪律）
- [14-sleep-background.md](../runtime/14-sleep-background.md)（关窗/托盘/唤醒）
- [19-notifications.md](../client/19-notifications.md)（通知投影与未读徽标）
- [11-auto-update.md](../archive/11-auto-update.md)（Electron 更新腿归档参考）
- [gui-acceptance-checklist.md](../../checklists/acceptance/gui-acceptance-checklist.md)（实机走查程序）
- [deviations.md](../../progress/deviations.md)（双 flavor 差异与可达性纪律，历史参考）

