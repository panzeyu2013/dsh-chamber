# Electron flavor 冻结归档（frozen register）

> **状态：冻结归档（2026-11 用户裁决）**。本文件是 Electron flavor 冻结的唯一登记面：范围、归档清单、
> 仍共享的契约、被禁用的面、agent 规则与复活清单。相关：`AGENTS.md`「当前版本范围」、
> `docs/design/01-overview.md` §3/§4、`docs/progress/STATUS.md` 顶部范围行、`docs/progress/TODO.md` 顶部范围行。
>
> 纪律：**不删除文件、不删除历史文档**；Electron 归档面默认只读；恢复其能力 = 用户重开范围的裁决，
> 按 §6 执行。默认开发 / 门禁 / 发布只以 **macOS Swift + 共享契约**为范围。
>
> 落位以实际文件与 workflow / 检查单内的 ARCHIVED 标注为准；本文件是本批落定的最终登记面。

## 1. 冻结声明与范围

- **用户裁决（2026-11）**：唯一出货 flavor = **macOS Swift 原生壳**（`macos/` + 打包 Node sidecar，design 25）。
  默认开发、门禁、发布与文档维护只以 macOS Swift + 共享契约为范围。
- **Electron flavor = 冻结归档，不删除**：Electron 桌面壳（主进程入口 / edge / preload）、Electron 打包
  与更新腿、Windows/Linux 桌面平台腿全部冻结；文件与历史文档保留（原地或迁入归档目录），保留可复活形态。
- **Windows/Linux 桌面 = 冻结、不发布**（不是删除）：其设计（design 22/23）与实现分支归档保留;
  恢复需用户裁决。
- **例外——继续维护的面**：共享契约与 Swift 腿共用的代码（§3）；gateway / CLI / control-plane / renderer /
  client 插件 / dsh-runtime / seed 包 / wire 都是现行面，不因 Electron 冻结而停更。

## 2. 归档清单

| 路径 | 内容 | 处置 |
|---|---|---|
| `packages/desktop/electron/main.ts` | Electron 主进程入口：BrowserWindow 单 frame、App 生命周期 / 菜单 / 托盘 / 单实例 / 退出链、Electron edge 接线、IPC 注册点 | **归档，冻结**（迁移前在原 `packages/desktop/main.ts`；内容不变） |
| `packages/desktop/electron/electron-edges.ts` | Electron `HostEdges` 实现（Notification / tray / safeStorage / dialog / 窗口 / Dock 徽标 …） | **归档，冻结** |
| `packages/desktop/electron/preload.cts` | 沙箱 preload：`contextBridge` 暴露 `window.dshChamber`；A 桥 manifest 的命名空间 / 方法单源 | **归档，冻结**；仍被 bridge-manifest / mirror / shim 的生成与锁步测试读取。**类型镜像属共享契约、随契约演进**：共享设置类型新增字段时同批镜像（仅接口声明；`tsc` 类型擦除，Electron 运行期行为不变，编译产物不重建） |
| `packages/desktop/updater.ts` | 更新控制器（design 11；Electron 默认 seam） | **不移动、不整体冻结**：Swift flavor 的 `update-headless.ts` 复用其纯函数（`compareChamberVersions` / `isAllowedReleaseUrl` / `isStaleConfirmation` / `releaseUrlFor` / `sanitizeErrorText` / `STALE_CONFIRMATION_ERROR` / 类型），`shell-ipc-update.ts` / `shell-assembly-ctx.ts` 也 import 它；`electron` 只在缺省 seam 惰性 `require`（sidecar esbuild 把 electron 标 external）。冻结面 = Electron 默认 seam，共享纯函数继续维护 |
| Electron 打包 / 装配 | `packages/desktop/package.json` 的 `build` 键、`electron-builder.base.cjs`、`electron-builder.beta.yml`、`scripts/{electron-dev,electron-shared,before-pack,after-pack-adhoc-sign}.mjs`、`dist:*` 脚本 | **冻结**（配置与依赖声明保留作复活基线，不删依赖） |
| Electron 专属测试 | 只测 Electron 壳/工具链、不覆盖 Swift 腿的测试（FROZEN_GROUPS：`test/desktop-shell/{fatal-report,renderer-frame-watchdog,startup-recovery,updater-channel-seal,updater-main-wiring}.test.ts`、`shell-locale.test.ts`、`test/ipc/{desktop-shortcuts-bridge,renderer-trust}.test.ts`、`scripts/{after-pack-adhoc-sign,before-pack,electron-shared}.test.mjs`；清单以 `packages/desktop/scripts/test.mjs` 为准） | **默认测试组不跑**，`test:frozen` 是唯一入口；`verify-test-wiring` 仍须认为它们已登记。共享锁步（electron-free-gate / bridge-manifest / bridge-shim / bridge-shim-surface / ipc-surface-mirror / upstream-seats / node-edges / notifications / badge / **cross-package-contract** / **desktop-carrier-surface** / host-root-lease）**留在默认组**、不在 FROZEN（desktop-carrier-surface 含活 Swift shim + 共享 sidecar 断言，已回默认组） |
| CI / 发布腿 | `ci.yml` 的 Windows job（`test-windows` / `test-windows-pack`，**已删除**，原文见 git 历史）与 `test-macos-pack` 的 Electron 打包排练 / artifact 校验步（**已移除**）；`release.yml` 的 `build-windows` / `build-linux` 与 **`build-macos` 整个 job**（Electron 发布腿 = 该 job 全部；job 级 `if: ${{ false }}` + ARCHIVED 头注） | **冻结**：Windows CI job 已删、三条 Electron 发布腿恒 skipped（`finalize-release` 容忍该状态）、不再产出 Electron 产物/更新 feed；ARCHIVED 头注指回本文件，**不得按旧 TEMPORARY 注释恢复** |
| 打包闭包 / 发布检查单 | `docs/checklists/release/release-checklist.md`、`docs/checklists/release/packaging-closure-checklist.md` 的 Electron / Windows / Linux 项 | 已标 **ARCHIVED**（不删条目；只在按 §6 复活后执行） |
| 设计文档 | design 11 的 Electron / electron-updater 半边 = 归档参考（Swift 更新链见 design 25 §7，现行）；design 22（Linux）/ design 23（Windows）= ARCHIVED；design 02 的 Electron/Chromium 专属段（spawn-dsh 的 Electron 分支、运行期指纹、safeStorage、electron-updater 等）随 flavor 归档，其 control-plane 宿主生命周期契约仍现行；design 25 §5 E 表 = Electron → Swift 的历史映射 | **归档参考**，原文保留 |
| 发布产物 | Electron dmg / zip / NSIS / AppImage（以及 `verify-electron-artifacts` 相关步骤） | 不再产出；Swift 产物是唯一发布物 |

> 说明：本表的 `packages/desktop/electron/` 路径是归档迁移后的落位；迁移前旧路径为
> `packages/desktop/{main.ts,electron-edges.ts,preload.cts}`，两者内容一致，旧路径只留在 git 历史中。

## 3. 仍共享的契约（不冻结）

| 契约 / 文件 | 单源与落点 | 为什么必须继续维护 |
|---|---|---|
| `packages/desktop/ipc-events.ts` | `IPC_CHANNELS`：主进程侧通道名单一来源 | A 桥 / B 桥、manifest 生成物、preload 锁步测试都读它；新通道唯一入口 |
| `packages/desktop/host-edges.ts` | `HostEdges` 契约面 | sidecar 实现（`node-edges.ts`）与冻结的 Electron 实现共同遵守；Swift 腿继续用它 |
| `packages/desktop/shell-core.ts` | Electron-free 业务装配 + IPC 处理器注册面 | Swift sidecar 的运行核心 |
| `packages/desktop/host-assembly.ts` | 两 flavor 共享的宿主装配单一实现（`createHostAssembly(deps)`） | `main.ts`（冻结）与 `sidecar-ctx.ts`（现行）只注入各自 edge 差异；不得因冻结而拆回两套 |
| `packages/desktop/{shell-assembly-ctx,shell-ipc-*,runtime-startup-host,host-registry-transition,host-exit,node-edges,sidecar-entry,sidecar-ctx}.ts` | sidecar / 共享业务装配 | Swift 腿现行代码 |
| `packages/desktop/updater.ts` 的纯函数 | 更新控制器共享叶 | Swift `update-headless.ts` 直接复用（见 §2）；改动需双 flavor（Electron 冻结时只保证 Swift 腿 + 纯函数契约） |
| `packages/desktop/bridge-manifest.json` + `macos/Sources/DSHChamber/Generated/BridgeManifest.swift` + `macos/Sources/DSHChamber/Resources/chamber-bridge.stub.js` | A 桥 manifest 三生成物（`packages/desktop/scripts/emit-bridge-manifest.mjs` 产出） | Swift 白名单 / shim 的通道单源；生成器仍读 `ipc-events.ts` 与 `MAIN_SIDE_FILES`（含归档的 `electron/main.ts` / `electron-edges.ts`，见 §5 白名单政策） |
| `scripts/gates/verify-electron-artifacts.mjs`、`packages/desktop/scripts/electron-shared.mjs` | 归档件，但被**共享测试/工具只读引用** | 登记为只读依赖：`verify-electron-artifacts.mjs` 的纯判定函数仍被 `run-checks.test.mjs` 与 `after-pack-adhoc-sign.test.mjs` 引用（执行面 `--check-dir` 默认不跑）；`electron-shared.mjs` 仍被 renderer 构建路径契约 / `test:macos` 打包套件与 FROZEN `electron-shared.test.mjs` 引用。改这两个文件先确认引用方仍按只读语义使用 |
| `packages/desktop/bridge-manifest.test.ts`、`bridge-shim.test.ts` 生成物锁步；`electron-free-gate.test.ts` 的 core 零 electron import；`bridge-shim-surface.test.ts` / `ipc-surface-mirror.test.ts` 等镜像测试 | 契约锁步 | 冻结不等于放弃锁步：**生成物 == 提交物、Swift 白名单 == manifest、core 家族零 electron import** 必须继续绿；白名单项按 §5 豁免「两侧相等 / 每通道恰用一次」。镜像类测试以 `test.mjs` 的 FROZEN 清单为准：被冻结的镜像测试其契约结论由生成物 + Swift 侧测试承接，不得静默失去校验 |
| `packages/control-plane` / `packages/renderer` / `packages/dsh-chamber-*` / `packages/dsh-runtime` / `packages/gateway` / `packages/cli` / `macos/` | 现行包 | 与 Electron 无关的出货面 |

**A 桥通道计数**：以生成物 `packages/desktop/bridge-manifest.json` 的 `counts` 为准（本文件写作时为
58 invoke + 9 push = 67；旧文档里的 65/70 等数字已过期，改动通道时同批重生成三件）。

**Electron-free 门禁（归档后形态）**：`packages/desktop/electron-free-gate.test.ts` 的 `WHITELIST`
现在只有 `updater.ts`（共享面唯一允许 electron import 的顶层文件）；三个归档入口
`electron/main.ts` / `electron/electron-edges.ts` / `electron/preload.cts` 进 `ARCHIVED_ENTRY_FILES`——
归档目录不参与顶层「面 A」扫描，但按集合断言存在性、不得夹带未登记文件、且确实依赖 electron
（缺文件 / 逃出扫描面 / 丢依赖都红）；其余 core 家族仍须零 electron import。

## 4. 被禁用的面（默认不运行 / 不发布）

- Windows / Linux CI 与发布腿：`ci.yml` 的 `test-windows`、`test-windows-pack`（已删除，原文见 git 历史）；
  `release.yml` 的 `build-windows` / `build-linux` 与 `build-macos` **整个 job**（Electron 发布腿）
  以 job 级 `if: ${{ false }}` 恒 skipped + ARCHIVED 头注保留。**不按旧 TEMPORARY 注释恢复**，按 §6 复活。
- Electron 打包：`electron-builder` dist 脚本、`build.files` / `extraResources` 的 Electron 产物装配、
  packaging-closure 的 Electron 项。
- Electron 更新腿：`electron-updater` 打包 / 通道封签 / 发布 feed 校验。
- Electron 产物 smoke：`scripts/gates/verify-electron-artifacts.mjs`（ARCHIVED——断言 `dist/control-plane/index.js` 可启动应答 `/health`、`dist/preload.cjs` 在 node:vm 里可解析并暴露冻结面；默认门禁/CI/发布不再调用，`gate-surfaces.json` 已移除 `macos.electron-artifacts`）。
- Electron-only 工具链（全部冻结；native 替代见括号）：`scripts/perf/*` 的 CDP 驱动（→ `shell.log`/`[shell-fps]` + Safari Web Inspector）、`scripts/gui-acceptance/` 的 `--dev`/`--flavor electron`/`walkthrough.mjs`/`launch.mjs`/`packaged-ssh-smoke.mjs`/`mobile-walkthrough.mjs` 的 CDP 驱动（→ `run.mjs --flavor native` 与真机/目检）、`scripts/dev/ensure-electron.mjs`（原根 `postinstall`，→ 不需要 Electron 二进制）。
- 默认测试组里的 Electron-only 测试（FROZEN 组，见 §2）。
- Electron dev 工作流（`dev:desktop` 等）；门禁 proof 里的 Electron 打包步骤。
- 「同 tag 双端发布」流程：Electron 冻结后不再发布，native（Swift）产物按 release.yml 的 Swift 腿独立发布。

**不禁止**：读冻结文件、修共享契约、跑 manifest / 锁步生成器、跑 Swift 腿门禁；这些是维护共享契约的
必要动作。

## 5. agent 规则与 Swift-only A 桥 additions 政策

### 5.1 agent 默认规则

1. 默认只改 **Swift 腿（`macos/` + sidecar 运行面）与共享契约**；Electron 归档文件默认只读，不做
   「顺手同步」。
2. 确需改冻结面（或恢复其发布腿）= **用户重开范围的裁决**：先读本文件 §6，不自行解冻。
3. 改共享契约时只保证 **Swift 腿 + 契约单源 + 生成管线**一致；不再要求 Electron 侧同步注册。
4. 不删除归档文件 / 历史文档；不把「已冻结」写成「已删除」或「从未存在」。

### 5.2 Swift-only A 桥 additions 政策

只存在于 Swift shim、不需要 Electron preload / 主进程注册的通道（含命名空间 / 方法）必须登记在
**`packages/desktop/bridge-swift-only-additions.json`**，由 `packages/desktop/scripts/emit-bridge-manifest.mjs` 合入
manifest（方向必需），并豁免「两侧必须相等 / 每通道恰用一次」类锁步检查。默认空表时生成物逐字节不变。

**schema（当前初始 `entries: []`）**：

```jsonc
{
  "version": 1,
  "policy": "只登记只存在于 Swift shim、无需 Electron preload/主进程注册的 A 桥通道；新增必须过评审",
  "entries": [
    {
      "channel": "dsh-chamber:some-swift-only", // 必填：完整通道串（与 IPC_CHANNELS 值一致）
      "key": "SOME_SWIFT_ONLY",                  // 必填：ipc-events.ts 的 IPC_CHANNELS 常量名
      "direction": "invoke",                     // 必填：invoke | push（manifest 方向维度）
      "namespace": "desktopSsh",                 // 必填：preload / shim 命名空间面
      "method": "someMethod",                    // 必填：shim 方法名
      "reason": "为什么 Electron 侧不需要注册（必填，评审依据）",
      "design": "design 25 §4.4.3"               // 可选：设计指针
    }
  ]
}
```

规则（实现 = `packages/desktop/scripts/emit-bridge-manifest.mjs` 的 `loadSwiftOnlyAdditions` / `validateSwiftOnlyAdditions`，
violation 一律 loud 拒绝）：`channel` / `key` 必须与 `ipc-events.ts` 的 `IPC_CHANNELS` 常量一致（通道名单一
来源）；`key` 必须满足 `^[A-Z][A-Z0-9_]*$`；`direction` 必填且 ∈ {invoke,push}；`namespace` / `method` /
`reason` 为非空字符串；同一 key/channel 不得重复登记；**main 侧注册文件对该 key 的引用必须为零**
（两侧都注册的通道走常规通道，不得进白名单）；白名单项不得与 `dshDesktop`（官方 desktop carrier，单源
`shortcuts-bridge.ts` 的 `DESKTOP_SHORTCUTS_CHANNELS`）的 channel/key/namespace 冲突；空表恒 no-op（生成物
逐字节不变）；白名单项**不得**成为 Electron 运行时路径（冻结面不为它补实现）；增加白名单项必须同批重新生成
三件 manifest 产物并让锁步测试绿。已豁免白名单的锁步门：`emit-bridge-manifest.mjs`、`bridge-shim-surface.test.ts`、
`ipc-surface-mirror.test.ts`、`scripts/gates/verify-shim-payload-shape.mjs`（后者要求 shim 真实现、preload 不暴露、
manifest 已收录；空表输出逐字不变）。**首个白名单条目**会改变 manifest counts，同批还必须更新硬编码计数钉：
`packages/desktop/bridge-manifest.test.ts`、`packages/desktop/bridge-shim.test.ts`、
`macos/Tests/DSHChamberTests/BridgeManifestConsistencyTests.swift`（以及 A 桥 65/56/9/11 相关 payload 钉子）。

## 6. 复活清单（按序）

1. **用户裁决重开范围**：记录到 STATUS 范围决策（并同步 AGENTS.md 顶部范围段）；本文件状态改为 active
   （或按裁决删除）。
2. **取回归档文件**：从 git 历史取回（冻结前 tag/commit 保留旧路径与内容，冻结后历史保留
   `packages/desktop/electron/` 路径）；git 操作需用户明确要求。**不删除历史文档**。
   冻结落地后应打一个 tag（如 `electron-frozen-<日期>`）指向冻结前的最后一个提交；若尚未打，
   取本批变更的父提交。
3. **对齐 Electron pin**：当前 pin 见 `packages/desktop/package.json` 的 `electron` devDependency；若该 pin 不在 node-addon-require-builtin 的指纹表内（表以该包源码为准；design 02 §3.1、STATUS §三），宿主会
   `exit 1`。复活时 pin 对齐表内最新稳定版本，同批同步：
   `packages/desktop/package.json` 的 `electron` devDependency、`scripts/build-sidecar.mjs` 的
   `ELECTRON_NODE_PINS` + `DEFAULT_NODE_VERSION` + `PINNED_NODE_SHA256`、`pnpm-lock.yaml`
   （G37 / `build-sidecar.test.mjs` 的 lockstep 断言会红，必须同批改）。
4. **恢复装配（先确认已就位，再补真正缺失项）**：已就位（不用改）——`packages/desktop/package.json`
   的 `main` = `electron/main.ts`，`build.files` 已含 `electron/**/*.ts` / `electron/**/*.cts`，
   `scripts/main-side-files.mjs` 的 `MAIN_SIDE_FILES` 已指 `electron/`，`scripts/build-sidecar.mjs` 的
   `electron` external 与 `tsconfig.sidecar.build.json` / `tsconfig.preload.build.json` 的 exclude/include 已对齐。
   **真正缺失、复活时必须补**：① 根 `package.json` 的 `postinstall` / `scripts/dev/ensure-electron.mjs`（已从
   postinstall 移除）；② `packages/desktop/package.json` 的 `dev` / `test:win32` 脚本（已移除；`build:preload`
   保留）；③ `build:desktop` 的 preload 步骤（已移除）；④ Electron/Windows/Linux CI 与发布腿（见 §6.5）；
   ⑤ 默认测试组回插 FROZEN_GROUPS（含 `frozen-scripts` 的 after-pack / before-pack / electron-shared）；
   ⑥ `verify-electron-artifacts.mjs` 重新登记进 `gate-surfaces.json` / `run-checks`（默认门与 CI 已移除调用）；
   ⑦ 根 `tsconfig.json` 的 include 不含 `packages/desktop/electron/**`（有意避免冻结类型检查反向绑定共享契约改动）：
   复活时按需把 `packages/desktop/electron/**/*.ts` 加回 include（或在复活记录里明确接受 electron/ 不参与根 typecheck）。
5. **恢复 CI / 发布腿**：从 git 历史取回 `ci.yml` 的 `test-windows` / `test-windows-pack` job，恢复
   `test-macos-pack` 的 Electron 打包排练 / artifact 校验步；`release.yml` 三条 Electron 发布腿去掉
   job 级 `if: ${{ false }}`、把 ARCHIVED 头注改回现行发布说明（`finalize-release` 的 needs/条件复原）；
   `scripts/release/verify-release-ci-proof.mjs` 的 `REQUIRED_JOB_STEPS`、
   `scripts/gates/gate-surfaces.json` / `run-checks.mjs`、`scripts/release/release-workflow-policy.test.mjs`
   的断言同批改（见 `docs/checklists/release/release-checklist.md` / `packaging-closure-checklist.md`）。
6. **恢复默认测试组**：FROZEN 组并回 `test`（`packages/desktop/scripts/test.mjs`），
   `verify-test-wiring` 仍绿；确认 Electron-only 测试文件在 `test-manifest.mjs` 中仍登记。
7. **A/B 桥重建**：重生成 `bridge-manifest.json` / `BridgeManifest.swift` / `chamber-bridge.stub.js`，
   与 Swift 白名单锁步；评估 `bridge-swift-only-additions.json`：清空，或把「两侧都注册」的项迁为常规通道
   （白名单只留真正的 Swift-only 项）。
8. **打包 / 签名 / 发布验证**：按 `docs/checklists/release/release-checklist.md` 与
   `docs/checklists/release/packaging-closure-checklist.md` 全量走查（Electron mac 签名/公证、Windows 未签名让步、
   Linux AppImage 形态门等既有条目恢复引用）。
9. **文档回滚**：AGENTS.md 顶部范围段、STATUS/TODO 顶部横幅与冻结标注、design 11/22/23 的 ARCHIVED 横幅、
   design 02 的窄横幅、design 25 的「Electron 已冻结」句、**design 01 的文档状态表（11/19/22/23/25 行）**、
   README / docs README / DEVELOPMENT / **CONTRIBUTING（dev 命令与 build:preload）** 的范围说明、
   **docs/checklists/upgrade/upstream-touchpoints.md 的生成视图**（`registry-views.mjs --write` 重生成）、
   根 `tsconfig.json` 的 include（把 `packages/desktop/electron/**/*.ts` 加回，见 §6.4 ⑦），
   以及本文件自身（改 active 或删除）。
10. **验证**：`node scripts/gates/run-checks.mjs full`（Linux 上 Windows 腿不在模式内，见 STATUS §1.6）、
    `pnpm run test:macos`、Electron dev 手跑、release dry-run；跑不了或跳过项如实登记。

## 7. 政策指针

- 范围与 agent 规则：`AGENTS.md`「当前版本范围（2026-11 用户裁决）」。
- 仓库级索引：`docs/INDEX.md`（全局文档地图）、`docs/design/INDEX.md`（设计索引）、`docs/design/01-overview.md` §3/§4（定位与移出项）。
- 进度与计划：`docs/progress/STATUS.md` 顶部范围行、`docs/progress/TODO.md` 顶部范围行（B 平台条目已标冻结）。
- Swift 腿设计：`docs/design/desktop/25-macos-swift-native-shell.md`（§4.1/§4.4.3 共享装配与 A 桥；§5 E 表为历史映射；
  §7 Swift 更新链/Sparkle）。
- 共享宿主生命周期：`docs/design/runtime/02-host-management-deployment.md`（仍现行；Electron/Chromium 专属段归档）。
- 归档目录说明：`packages/desktop/electron/ARCHIVED.md`。
- Swift-only A 桥白名单：`packages/desktop/bridge-swift-only-additions.json`（政策见 §5.2）。
- 发布流程归档标注：`docs/checklists/release/release-checklist.md` / `packaging-closure-checklist.md`（ARCHIVED 条目）；
  `.github/workflows/ci.yml` / `release.yml` 的 ARCHIVED 文案；发布证明脚本 =
  `scripts/release/verify-release-ci-proof.mjs`。
