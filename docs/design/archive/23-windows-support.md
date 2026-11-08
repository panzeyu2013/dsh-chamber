# 23 · Windows 支持（Windows 11 x64，归档基线）

> **ARCHIVED（2026-11 用户裁决）**：Electron flavor 已冻结归档，**Windows 桌面腿冻结、不发布、不排期**（[electron-frozen.md](../../progress/electron-frozen.md)）。本文保留为**复活基线**：下方是归档腿的平台适配契约、妥协点与验收面；恢复该腿需用户重开范围并按 [electron-frozen.md](../../progress/electron-frozen.md) §6 的复活清单执行。

## 1. 范围与总原则

- 目标形态：Windows 11 x64（打包态 NSIS）；macOS/Linux 契约不回退，每次合入保持 mac/linux 全量回归绿。
- 纪律：① **能力先于开关**——任何 mutation/功能解锁先经 env 门控或后台单测验证，UI 开关最后翻；② **基线先行**——win32 测试 pass/skip 集合与平台门控拒绝码先固化，每个变更的测试变化必须对照基线归因；③ **fail-closed 不撤销**——不可证即保留/拒绝的语义在 Windows 适配中一律维持；④ **妥协即文档**——真实平台事实（§4）写入发布附注，不静默、不伪称等价；⑤ **验证门控不作发布开关**——`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 仅供开发/CI 验证（默认关），发布版用户自行开启不受支持（路径未经真实 Windows 实机验证）。
- 能力分期（ID 为能力名，不代表进度）：M1 = §2 生命周期契约；M2a = §3 运行时管理后台能力；M2b = UI/门控翻转（纪律①门禁）；M3 = 桌面实机全链（托盘/关窗/通知/唤醒/updater）+ 打包闭包修复；M4 = §4 决策解锁；M5 = 发布面（§7）。

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

- **打包态身份**：`app.setAppUserModelId('com.dshchamber.desktop')`（win32）——通知/Action Center 归属与任务栏分组的前提。
- **托盘与 preload**（Electron 归档面：preload 在 `packages/desktop/electron/preload.cts`）：托盘图标候选收敛为只留真实打包资源（两条永不随包的候选路径为跨平台既有边界）；preload 缺失 loud 失败，不静默回退源码 `.cts`。
- **登录自启**：win32 走 `app.setLoginItemSettings({ openAtLogin, name: WINDOWS_APP_USER_MODEL_ID })`（Electron 43.4.0 在 win32 以该 name 写 HKCU `...\Run`，当前用户、无需管理员；`getLoginItemSettings` 的读回键同为该 name，故读回校验一致——传其它 name 会让读回永久失败），`supported` 恒 true；NSIS 卸载段 include（`packages/desktop/scripts/nsis-uninstall-cleanup.nsh`）清 `dsh-chamber`、`@dsh-chamber/desktop` 与 AUMID `com.dshchamber.desktop` 三个 Run 值（前两个覆盖旧版本/双 flavor 残留）。
- **深链**：打包态走无参数 `setAsDefaultProtocolClient` 注册（dev 不注册）；`build.protocols` 键已声明（name `dsh-chamber` / scheme `dsh-chamber`），NSIS 是否写 `HKCU\Software\Classes` 以 runner 实证为准（复活前置）。
- **open-in 本地路径**：本地实例（`instanceId='local'`）走 `validateLocalPath`（盘符/UNC），远程实例走 POSIX 口径 `validateRemotePath`。
- **SSH 密码门**：win32 无密码字段；密码认证被拒并给出主路径引导（密钥 / ssh-agent / Pageant）。一键免密（密钥推送）UI 为后续独立特性。
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
| C1/C2 | 0700/uid 目录权限 | 不作让步：icacls 收紧 + 启动验证（win-acl.ts） |
| C3 | 目录 fsync | 平台事实（F2）：NTFS journal + 文件级 fsync + journal 重放 |
| C4 | 只读树删除 | 决策门：win32-only readonly-rm 测试定是否需清属性（runner 裁决） |
| C5 | 目录 rename | rename-retry + journal 续作 + 惰性删除（残余 F7） |
| C6/C7/C10 | 信号/双段/grace | 平台事实（F1）：硬终止 + 事务恢复 |
| C8 | 身份弱化 | 不作让步：PowerShell CIM 命令行/PPID 身份（win-probes） |
| C9 | 安装后代回收 | 不作让步：taskkill /T /F + 残余 CIM 清扫（supervisor 接线） |
| C11 | Defender 慢 | 接受（F3）+ 缓解：进度行/文档；MSIX 评估 |
| C12 | 原生预构建 | 核查项：koffi 官方 win32-x64 预构建随包免编译器；其余逐个核对 |
| C13 | 验证强度 | 注入矩阵与 POSIX 对齐 |
| C14 | gateway win 只读 | 范围决策（F4），保持 |
| C15 | SSH 密码 | 产品增强：win32 门消息引导 keys/Pageant；密码字段隐藏/一键免密 UI = 后续特性 |
| C16 | 明文回退 | win32 不作让步：safeStorage-only；拒绝落盘，store 内存驻留 |
| C17 | 深链 | 打包态运行时注册已解锁；NSIS protocols 注册行为以 runner 实证为准 |
| C18 | 便携无通知 | 行业惯例（F5）；打包态 AUMID 已接 |
| C19 | 卸载残留 | NSIS include 卸载段清 Run 键（打包验证以 runner 为准） |
| C20 | safeStorage=DPAPI | 平台事实：Electron 封装即标准做法 |
| C21 | 签名 | 资源决策（F6）：Azure Trusted Signing 评估 |
| C22 | CI 无交互面 | 契约腿 + Playwright 冒烟（可选）；人工矩阵仅剩 OS 集成面 |
| C23 | 图标资产 | 资源实现（打包项） |

## 6. 复活验收矩阵（Windows 11 x64 打包态）

| 面 | 验收点 |
|---|---|
| 生命周期 | 冷启动 → 本地实例 ready；重启/退出全链；崩溃后 reaper（win 腿）回收或 fail-closed |
| 托盘/窗口 | 托盘出现与 tooltip；hide-to-tray/quit 两设置；退出确认；无窗常驻恢复 |
| 通知 | Action Center 显示/点击聚焦/打开（AppUserModelID 验证）；dev/便携不承诺 |
| 唤醒 | 睡眠唤醒即时重探重连 |
| 运行时（env 门控态） | 安装（Defender 计时）→ 切换 → 探针失败 → 回滚 → 数据恢复；只读投影对照 |
| SSH | 密钥隧道 + exec；Pageant/agent；win32 无密码字段 |
| updater | stable/beta 双通道、确认下载、退出安装（未签名 SmartScreen） |
| 权限 | icacls 收紧后 userData/secret 文件 ACL 查询结果符合 C1/C2 预期；升级路径不破坏 |
| 深链 | URL 含 `&`/中文等特殊字符冷/热启动 |
| 杂项 | loopback 端口无防火墙弹窗；双机对照 windows-2022（契约）vs Win11（交互） |

## 7. 复活风险与发布面

- 风险：上游 dsh win32-x64 实际不可跑（最小复现；若阻断则降级为「Windows 仅远程连接端」）；electron-builder NSIS 不写协议注册表（运行时 no-args 注册已备，必要时补 NSIS include）；原生依赖预构建不随包（koffi 等，逐个核对或随包预构建）；icacls 收紧破坏升级路径（只作用于 `<userData>` 自有目录，升级实测入矩阵）；Defender 计时不可接受（文档 + 排除建议 + MSIX 评估）；windows-2022 与 Win11 行为差异（契约腿在 runner，交互矩阵在真机双机对照）。
- 签名路径候选：A = Azure Trusted Signing（云签名、CI 免密钥管理、成本低）；B = OV/EV 自购证书；C = 维持未签名（SmartScreen 提示 + 发布说明明示）——首个正式 Windows 发布前决策。
- 发布形态：NSIS 为主；Defender 首装体验/分发成为用户痛点时评估 MSIX/AppX 附加形态（系统级安装事务、非逐文件实扫、深链/更新通道约束需重审计）。
- 演练门禁（按 [release-checklist.md](../../checklists/release/release-checklist.md)）：dry-run 全链 → 实机 GitHub Release 安装 → stable/beta 更新全链；未签名产物在演练中同步记录 SmartScreen 首屏路径。

## 相关文档

- [electron-frozen.md](../../progress/electron-frozen.md)（冻结范围与复活清单）
- [22-linux-desktop.md](./22-linux-desktop.md)（Linux 归档腿）
- [16-vscode-deeplink.md](../desktop/16-vscode-deeplink.md)（深链契约）、[11-auto-update.md](../archive/11-auto-update.md)（更新通道模型，归档参考）
- [18-dsh-runtime-version.md](../runtime/18-dsh-runtime-version.md)（运行时管理核心）
