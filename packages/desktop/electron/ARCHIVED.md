# packages/desktop/electron/ — ARCHIVED (Electron flavor, frozen)

**状态：冻结归档（2026-11 用户裁决）。本目录不是现行开发面。**

Electron flavor 已冻结：默认开发、门禁、发布与文档维护只以 **macOS Swift 原生壳**
（`macos/` + 打包 Node sidecar）为范围。本目录保留 Electron 独有的入口/边沿/preload 源码，
**文件不删除**，供将来按复活清单恢复；不参与默认测试组、默认构建与发布。

完整冻结范围、仍共享的契约、禁用面与复活清单见
[`docs/progress/electron-frozen.md`](../../../docs/progress/electron-frozen.md)。

## 归档文件（old → new，文件名保留）

| 原路径 | 现路径 | 说明 |
|---|---|---|
| `packages/desktop/main.ts` | `packages/desktop/electron/main.ts` | Electron 主进程入口：单窗口单 frame、control-plane 生命周期、Electron edge 接线、退出清理与 IPC 注册点 |
| `packages/desktop/electron-edges.ts` | `packages/desktop/electron/electron-edges.ts` | Electron 的 HostEdges flavor 实现（`createElectronEdges`） |
| `packages/desktop/preload.cts` | `packages/desktop/electron/preload.cts` | 沙箱 preload 源码（`window.dshChamber` / `window.dshDesktop` 载体）；仍编译为 `dist/preload.cjs` |

迁移时同步做了两件必须保持的事：三个文件内部的相对 import 全部上移一层（入口文件到
`packages/desktop/` 的共享模块），`main.ts` 的 `pkgDir` 仍解析为 `packages/desktop`
（`package.json` / `dist/` / `vendor/` 锚点不变）。

## `updater.ts` 保留原位（不归档）

`packages/desktop/updater.ts` **不移动、不冻结**。它是 electron-free 的共享模块：typed 的
`UpdateState` / `UpdatePhase` 等类型与纯决策函数同时被 `shell-assembly-ctx.ts`、
`update-headless.ts`、`shell-ipc-update.ts` 与 preload 的类型面引用；Swift sidecar 的无头更新
控制器也在使用它的纯函数。design 25 曾以「4 文件 Electron 专属」口径列出
（main / electron-edges / preload / updater），该口径在此纠正为 **3 个归档文件 + updater.ts 留在
共享面**。

## 冻结规则（agent 默认禁止修改）

- 默认任务**不改**本目录与 Electron 打包/更新/CI 腿；「顺手同步」也禁止。
- 本目录只作为参考实现：Electron 侧不再要求与新 A 桥通道/命名空间同步；只存在于 Swift 腿的
  桥面登记到 `packages/desktop/bridge-swift-only-additions.json`（政策见
  `docs/progress/electron-frozen.md` §5）。
- 若某改动确实必须触及冻结面，属于用户重开范围的裁决：先读
  `docs/progress/electron-frozen.md` 的复活清单再执行，不得在常规任务里自行解冻。

## 复活入口（最小校验清单）

1. 读 `docs/progress/electron-frozen.md`（冻结范围 + 复活清单）；
2. **确认已就位（不用重复改）**：`packages/desktop/package.json` 的 `main` 已是 `electron/main.ts`，
   electron-builder `files` 已含 `electron/**/*.ts` / `electron/**/*.cts`，`scripts/main-side-files.mjs`
   的 `MAIN_SIDE_FILES` 已指 `electron/` 前缀；复活时只核对，不再重复添加；
3. 恢复 Electron/Windows/Linux 的 CI 与发布腿、默认测试组中的 Electron-only 测试；
4. 按 pin / ELECTRON_NODE_PINS / lockfile 清单重建 Electron 无头 Node 闭包，再跑 A/B 与文档回滚。

自检提示：本目录源码的 import 解析、`tsconfig.preload.build.json` 的 include、以及
`scripts/main-side-files.mjs` 的名单位置均按 `electron/` 前缀维护；复活前先用
`node --check`/`tsc` 复用这些入口，不要手抄路径。
