# 23 · Windows 支持（Windows 11 x64，归档基线）

> **ARCHIVED（2026-11 用户裁决）**：Electron flavor 已冻结归档，**Windows 桌面腿冻结、不发布、不排期**（[electron-frozen.md](../../progress/electron-frozen.md)）。本文保留为**复活基线**：下方是归档腿的平台适配契约、妥协点与验收面；恢复该腿需用户重开范围并按 [electron-frozen.md](../../progress/electron-frozen.md) §6 的复活清单执行。

## 1. 范围与总原则

- 目标形态：Windows 11 x64（打包态 NSIS）；macOS/Linux 契约不回退，每次合入保持 mac/linux 全量回归绿。
- 纪律：① **能力先于开关**——任何 mutation/功能解锁先经 env 门控或后台单测验证，UI 开关最后翻；② **基线先行**——win32 测试 pass/skip 集合与平台门控拒绝码先固化，每个变更的测试变化必须对照基线归因；③ **fail-closed 不撤销**——不可证即保留/拒绝的语义在 Windows 适配中一律维持；④ **妥协即文档**——真实平台事实（§4）写入发布附注，不静默、不伪称等价；⑤ **验证门控不作发布开关**——`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 仅供开发/CI 验证（默认关），发布版用户自行开启不受支持（路径未经真实 Windows 实机验证）。

## 2. 平台适配契约：进程探测与终止

`packages/control-plane/src/win-probes.ts`（探测/终止模块）：

- **身份**（替代 `ps`）：PowerShell `Get-CimInstance Win32_Process` 全表（只读、`-NoProfile -NonInteractive`、UTF-8 钉定、250ms 缓存）；`windowsIdentity(pid)` 抛错语义与 `realPsIdentity` 一致（失败 → 记录保留）。
- **端口归属**（替代 lsof/ss/proc）：`netstat -ano -p tcp` LISTENING 行解析；exec 失败 → null（探针不可用），无监听 → false。
- **树存活/终止**（替代进程组信号）：`taskkill /PID <pid> /T /F`；leader 已死后残余后代经 CIM 表逐棵清除；探针失败 fail-closed（报有残余/抛错，绝不假装干净）。
- 纯解析函数（POSIX CI 全跑）：`parseCimProcessTable`/`descendantPidsOf`/`parseNetstatListeningPids`/`taskkillTreeArgs`/`classifyTaskkillOutput`。

接线：

- `reaper.ts resolveDeps`：win32 默认 = CIM 身份 + netstat + taskkill 信号 + `realAlive || hasWindowsResidualTree` 树存活；POSIX 默认零改动。
- `spawn-dsh.ts signalManagedGroup`：win32 → `treeKillWindows`（gone=false 即 ESRCH 等价）；spawn 补 `windowsHide: true`（detached 子进程不弹控制台窗口）。
- 集成测试：`control-plane/test/windows/win32-lifecycle.integration.test.ts`（win32-only，自 skip）。
- **远端浏览器 forward（design 28）**：每条 forward 一条 `ssh -N -L` child，停止/回收复用本节 `taskkill /PID <pid> /T /F` 树终止，**不引入 Job Object**（无原生 addon）；进程身份由 `remote-forward-windows.ts` 查 `Win32_Process` 的 `CreationDate`/`CommandLine`（纯解析单测），证不出即不杀（fail-closed）。仅密码主机可用 askpass，不做 key-only 升级。

**语义让步（记录）**：Windows 无 POSIX 信号 → SIGTERM 段与 SIGKILL 段同形（taskkill）；身份证明依赖 PowerShell 存在且同行权限可读 CommandLine；以上均 fail-closed。

## 3. 运行时管理解锁契约

- dsh-runtime 核心本就 Windows 友好：指针为普通文件（禁 symlink）、文件级 tmp+rename+fsync、pnpm 以 `node <pnpm.cjs>` 执行、候选经 `ELECTRON_RUN_AS_NODE` 拉起。
- 后台能力：desktop env 门控（纪律⑤）、dsh-runtime `windows-process.ts`（supervisor 树终止 + 残余探测）、`rename-retry.ts`（snapshot-store 四处目录 rename，`WINDOWS_RENAME_RETRY_DELAYS_MS` 有界重试）、desktop `win-acl.ts`（icacls 收紧 + 验证 + 启动复合入口）、C16（gateway 凭据 win32 无 safeStorage = 拒绝明文，store 内存驻留）；只读属性清理以 win32-only 决策门测试定实现。
- **门控翻转前置**：上述能力在真实 win32 runner 全绿 + 实机故障注入矩阵记录后才翻 UI 开关；翻转点（接线全集）：desktop `electron/main.ts`（`managementSupported` 注入与决策点，**归档面**）、`dsh-runtime-controller.ts`（mutation 拦截）、`apply-now-gate.ts`、settings-bridge 段、版本 chip。gateway 部署于 Windows 保持只读（服务器支持矩阵 = Linux/macOS，范围决策）。

## 4. 桌面打包态与系统集成

- **打包态身份**：`app.setAppUserModelId('com.dshchamber.desktop')`（通知/Action Center/任务栏分组前提）；preload 缺失 loud 失败。
- **登录自启**：`app.setLoginItemSettings({openAtLogin, name: AUMID})`（读回键同名）；NSIS 卸载段 include 清 `dsh-chamber`/`@dsh-chamber/desktop`/AUMID 三个 Run 值。
- **深链/路径/SSH 密码**：打包态无参 `setAsDefaultProtocolClient`（dev 不注册）；本地 open-in 走盘符/UNC 校验、远程走 POSIX 口径；win32 无密码字段，密码认证拒绝并引导密钥/agent/Pageant。
- **CI 无交互面**：契约腿 + 可选 Playwright 冒烟；人工矩阵只剩 OS 集成面。

## 5. 妥协点（发布附注，唯一权威）

- **F1** 优雅停机不可达（SIGTERM dispose 无信号握手）→ 硬终止 + journal/指针/探针事务恢复（Windows 全行业同此）。
- **F2** 无目录 fsync → NTFS 日志 + 文件级 fsync + journal 重放（平台正确行为，非降级）。
- **F3** Defender 实扫拖慢首次运行时安装 → 进度行 + 排除目录文档；MSIX 为结构替代评估。
- **F4** Gateway-on-Windows 运行时只读（范围决策）。
- **F5** 非安装形态（便携）不承诺通知/托盘（AUMID/图标依赖安装形态，行业惯例）。
- **F6** Authenticode 未签名（等待 Azure Trusted Signing；资源决策）。
- **F7** 目录 rename 被第三方句柄占用时的瞬时重试窗口（续作 + 惰性删除后残余极小）。
- **F8** win32 无 `O_NOFOLLOW`/`O_DIRECTORY`：dsh-runtime 私有状态读写退化为**身份校验回退**（open 前后 `lstat` 拒符号链接 + dev/ino 复验，任一步不可证即 fail-closed），不再直接抛错（`packages/dsh-runtime/src/private-fs.ts` `resolveNoFollowFlags`/`openPrivateNoFollowSync`；与 gateway 的 win32 旁路 `runtime-manager.ts` 及 control-plane `private-file.ts` 同构）。残余：非写路径在 `lstat` 与 `open` 之间存在 TOCTOU 窗口（无内核旗标可消除）；打开后复验失败即拒绝，只影响并发替换攻击面，不影响普通读写与只读投影。

### 审计标识对照（审计 ID 供其他文档引用）

| 审计标识 | 事项 | 现行处置 |
|---|---|---|
| C1/C2 | 0700/uid 目录权限 | icacls 收紧 + 启动验证（win-acl.ts），不作让步 |
| C3 / C6-C7 / C10 | fsync、信号、双段、grace | 平台事实（F2/F1）：NTFS journal + 文件级 fsync + journal 重放；硬终止 + 事务恢复 |
| C4 / C5 / C7 | 只读树删除、目录 rename、残余 | 决策门 + rename-retry + journal 续作 + 惰性删除（残余 F7） |
| C8 / C9 | 身份弱化、安装后代回收 | 不作让步：PowerShell CIM 身份；taskkill /T /F + 残余 CIM 清扫 |
| C11-C13 / C16-C20 | Defender 慢、原生预构建、验证强度、明文回退、深链、便携、卸载、DPAPI | 见 F3/F5/F6 与矩阵；win32 safeStorage-only（C16）；其余逐项按 §5/§6 记录 |
| C14 / C15 / C21-C23 | gateway 只读、SSH 密码、签名、CI、图标 | 范围决策 F4；密码引导 keys/Pageant；签名候选中待裁决；资源/打包项 |

## 6. 复活验收矩阵（Windows 11 x64 打包态）

复活验收矩阵按 [gui-acceptance-checklist](../../checklists/acceptance/gui-acceptance-checklist.md) 与 [release-checklist](../../checklists/release/release-checklist.md) 执行。

## 7. 复活风险与发布面

- 风险：上游 win32-x64 可跑性、NSIS 协议注册、原生预构建、icacls 升级路径、Defender 计时、双机行为差异；签名候选 = Azure Trusted Signing / OV-EV / 未签名（首发前裁决）。
- 发布形态：NSIS 为主（MSIX 按痛点评估）；演练门禁按 [release-checklist](../../checklists/release/release-checklist.md)（dry-run → 实机安装 → stable/beta 更新全链）。

## 相关文档

- [electron-frozen.md](../../progress/electron-frozen.md)（冻结/复活）、[22](./22-linux-desktop.md)（Linux 归档腿）、[16](../desktop/16-vscode-deeplink.md)（深链）、[11](./11-auto-update.md)（更新通道）、[18](../runtime/18-dsh-runtime-version.md)（运行时管理核心）。
