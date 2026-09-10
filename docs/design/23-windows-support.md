# 23. Windows 支持推进方案（Windows 11 x64 首版）

> **状态：未实现（Windows 首版支持推进；代码项已落地，真实 Windows runner / 实机门禁未过，2026）**——本文是
> dsh-chamber 桌面端（本地实例 + ssh/gateway 远程连接 + dsh 运行时版本管理）Windows 支持的权威契约（平台适配、运行时管理解锁纪律、妥协点与验收矩阵）；未完成门禁见 `docs/progress/STATUS.md`；执行台账:`docs/progress/todo/windows-v1.md`；测试基线台账:`docs/progress/windows-baseline.md`。
> 本设计只记录契约与决策，不重复实现过程。

## 1. 范围与总原则

- 目标形态:Windows 11 x64(打包态 NSIS)。macOS/Linux 契约不回退;每次合入保持
  mac/linux 全量回归绿。
- 纪律:
  1. **能力先于开关**:任何 mutation/功能解锁先经 env 门控或单测在后台验证,UI 开关最后翻;
  2. **基线先行**:win32 测试 pass/skip 集合与平台门控拒绝码先固化(`windows-baseline.md`),
     后续每个里程碑的测试变化必须对照基线归因;
  3. **fail-closed 不撤销**:不可证即保留/拒绝的语义在 Windows 适配中一律维持;
  4. **妥协即文档**:真实平台事实(见 §5)写入发布附注,不静默、不伪称等价;
  5. **验证门控不作发布开关**:`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 仅供开发/CI
     验证(默认关);打包发布版用户自行开启不受支持(路径未经真实 Windows 实机验证)。
- 分期标识(本文与配套文档按此引用;ID 为能力分期名,不代表进度):
  `M0` = `ci.yml` `test-windows`(windows-2022)契约腿 + 行为基线台账;
  `M0.5` = 能力前置核查(上游 dsh win32 可跑性、electron-builder NSIS protocols 实证、
  Defender 计时基线、原生依赖预构建核对,任务单见 `todo/windows-v1.md`);
  `M1` = 生命周期契约(win-probes 身份/端口/树终止 + reaper/spawn-dsh 平台自适应接线);
  `M2a` = 运行时管理后台能力(env 门控 mutation、安装子进程树回收、icacls ACL 收紧、
  只读属性清理、rename 续作);`M2b` = UI/门控翻转(纪律 1 门禁);
  `M3` = 桌面实机全链(托盘/关窗/通知/唤醒/updater)+ 打包闭包修复;
  `M4` = 决策解锁(登录自启、深链注册、open-in 本地路径、SSH 免密引导);
  `M5` = 发布面(Azure Trusted Signing / MSIX 评估、dry-run 全链演练,§8);
  `M6` = 收口(妥协清单、支持矩阵文档、CHANGELOG)。

## 2. 平台适配契约:进程探测与终止（M1）

`packages/control-plane/src/win-probes.ts` — Windows 探测/终止模块:
- **身份**(替代 `ps`):PowerShell `Get-CimInstance Win32_Process` 全表(只读、
  `-NoProfile -NonInteractive`、UTF-8 钉定、250ms 缓存);`windowsIdentity(pid)` 抛错
  语义与 `realPsIdentity` 一致(失败 → 记录保留)。
- **端口归属**(替代 lsof/ss/proc):`netstat -ano -p tcp` LISTENING 行解析;
  exec 失败 → null(探针不可用),无监听 → false。
- **树存活/终止**(替代进程组信号):`taskkill /PID <pid> /T /F`;leader 已死时的残余
  后代经 CIM 表逐棵清除;探针失败 fail-closed(报有残余/抛错,绝不假装干净)。
- 纯解析函数(POSIX CI 全跑):`parseCimProcessTable`/`descendantPidsOf`/
  `parseNetstatListeningPids`/`taskkillTreeArgs`/`classifyTaskkillOutput`。

接线:
- `reaper.ts resolveDeps`:win32 默认 = CIM 身份 + netstat + taskkill 信号 +
  `realAlive || hasWindowsResidualTree` 树存活;POSIX 默认零改动。
- `spawn-dsh.ts signalManagedGroup`:win32 → `treeKillWindows`(gone=false 即 ESRCH 等价);
  spawn 补 `windowsHide: true`(detached 子进程不弹控制台窗口)。
- 集成测试:`control-plane/test/win32-lifecycle.integration.test.ts`(win32-only,自 skip)。

**语义让步(记录)**:Windows 无 POSIX 信号 → SIGTERM 段与 SIGKILL 段同形(taskkill);
身份证明依赖 PowerShell 存在且同行权限可读 CommandLine;以上均 fail-closed。

## 3. 运行时管理解锁契约（M2a 能力 + M2b 门禁）

- dsh-runtime 核心设计本就 Windows 友好:指针为普通文件(禁 symlink)、文件级
  tmp+rename+fsync、pnpm 以 `node <pnpm.cjs>` 执行、候选经
  `ELECTRON_RUN_AS_NODE` 拉起。
- M2a 后台能力(已接线):desktop env 门控(`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`)、
  dsh-runtime `windows-process.ts`(supervisor 树终止 + 残余探测)、`rename-retry.ts`
  (snapshot-store 四处目录 rename,`WINDOWS_RENAME_RETRY_DELAYS_MS` 有界重试)、
  desktop `win-acl.ts`(icacls 收紧 + 验证 + 启动复合入口)、C16(gateway 凭据 win32
  无 safeStorage = 拒绝明文,store 内存驻留);只读属性清理以 win32-only 决策门测试
  定实现。
- **M2b 翻转前必须** M2a 在真实 win32 runner 全绿 + 实机故障注入矩阵记录;翻转点
  (接线全集):desktop `main.ts`(managementSupported 注入与决策点)、
  `dsh-runtime-controller.ts`(mutation 拦截)、`apply-now-gate.ts`、settings-bridge 段、
  版本 chip。
- Gateway 部署于 Windows:保持只读(服务器支持矩阵 = Linux/macOS,范围决策)。

## 4. 桌面打包态与系统集成解锁（M3/M4）

- **打包态身份**:`app.setAppUserModelId('com.dshchamber.desktop')`(win32)——通知/
  Action Center 归属与任务栏分组的前提。
- **托盘与 preload**:托盘图标候选收敛为只留真实打包资源(两条永不随包的候选路径
  是跨平台既有 P2，登记于 STATUS 与 design 22 §5);preload 缺失 loud 失败,不再
  静默回退源码 `.cts`。
- **登录自启**:win32 走 `app.setLoginItemSettings({ openAtLogin })`(Electron 写
  HKCU `...\Run`,当前用户、无需管理员),`supported` 恒 true;NSIS 卸载段 include
  (`packages/desktop/scripts/nsis-uninstall-cleanup.nsh`)清 `dsh-chamber` 与
  `@dsh-chamber/desktop` 两个 Run 值。
- **深链**:打包态走无参数 `setAsDefaultProtocolClient` 注册(dev 不注册);
  `build.protocols` 键已声明(name `dsh-chamber` / scheme `dsh-chamber`),NSIS 是否
  写 `HKCU\Software\Classes` 待 runner 实证(§6)。
- **open-in 本地路径**:本地实例(`instanceId='local'`)走 `validateLocalPath`
  (盘符/UNC),远程实例走 POSIX 口径 `validateRemotePath`。
- **SSH 密码门**:win32 无密码字段;密码认证被拒并给出主路径引导(密钥 /
  ssh-agent / Pageant)。一键免密(密钥推送)UI 为后续独立特性,未排期。
- **CI 无交互面**:契约腿 + 可选 Playwright 冒烟;人工矩阵只剩 OS 集成面。

## 5. 妥协点（发布附注，唯一权威）

**F1** 优雅停机不可达(SIGTERM dispose 无信号握手)→ 硬终止 + journal/指针/探针事务恢复
(Windows 全行业同此)。
**F2** 无目录 fsync → NTFS 日志 + 文件级 fsync + journal 重放(平台正确行为,非降级)。
**F3** Defender 实扫拖慢首次运行时安装 → 进度行 + 排除目录文档;MSIX 为结构替代(M5 评估)。
**F4** Gateway-on-Windows 运行时只读(范围决策)。
**F5** 非安装形态(便携)不承诺通知/托盘(AUMID/图标依赖安装形态,行业惯例)。
**F6** Authenticode 未签名(等待 Azure Trusted Signing;资源决策)。
**F7** 目录 rename 被第三方句柄占用时的瞬时重试窗口(续作 + 惰性删除后残余极小)。

审计标识对照(2026 审计 C1–C23 → 现行处置;审计 ID 供其他文档引用):

| 审计标识 | 事项 | 现行处置 |
|---|---|---|
| C1/C2 | 0700/uid 目录权限 | 不作让步:icacls 显式 ACL 收紧 + 启动验证(win-acl.ts) |
| C3 | 目录 fsync | 平台事实(F2):NTFS journal + 文件级 fsync + journal 重放 |
| C4 | 只读树删除 | 决策门:win32-only readonly-rm 测试定是否需清属性(runner 裁决) |
| C5 | 目录 rename | rename-retry + journal 续作 + 惰性删除(残余 F7) |
| C6/C7/C10 | 信号/双段/grace | 平台事实(F1):硬终止 + 事务恢复 |
| C8 | 身份弱化 | 不作让步:PowerShell CIM 命令行/PPID 身份(win-probes/windows-process) |
| C9 | 安装后代回收 | 不作让步:taskkill /T /F + 残余 CIM 清扫(supervisor 接线) |
| C11 | Defender 慢 | 接受(F3)+ 缓解:进度行/文档;MSIX 评估(M5) |
| C12 | 原生预构建 | 核查项:koffi 官方 win32-x64 预构建随包免编译器;其余逐个核对(M0.5) |
| C13 | 验证强度 | 注入矩阵与 POSIX 对齐(M2a/M3) |
| C14 | gateway win 只读 | 范围决策(F4),保持 |
| C15 | SSH 密码 | 产品增强:win32 门消息引导 keys/Pageant;密码字段隐藏/一键免密 UI = 后续特性 |
| C16 | 明文回退 | win32 不作让步:safeStorage-only;拒绝落盘,store 内存驻留 |
| C17 | 深链 | 打包态运行时注册已解锁(M4);NSIS protocols 注册行为待实证(§6) |
| C18 | 便携无通知 | 行业惯例(F5);打包态 AUMID 已接 |
| C19 | 卸载残留 | NSIS include 卸载段清 Run 键(打包验证待 runner) |
| C20 | safeStorage=DPAPI | 平台事实:Electron 封装即标准做法 |
| C21 | 签名 | 资源决策(F6):Azure Trusted Signing 评估(§8) |
| C22 | CI 无交互面 | 契约腿 + Playwright 冒烟(可选);人工矩阵仅剩 OS 集成面 |
| C23 | 图标资产 | 资源实现(M3 打包项) |

## 6. 风险登记

| 风险 | 触发动作 |
|---|---|
| 上游 dsh win32-x64 实际不可跑 | M0.5 最小复现;若阻断 → 降级 P2:Windows 仅远程连接端 |
| electron-builder NSIS 不写协议注册表 | 打包态运行时 no-args `setAsDefaultProtocolClient` 已备(M4,deep-link.ts);若 protocols 键实证不写注册表再补 NSIS include |
| 原生依赖预构建不随包(koffi 等) | M0.5 逐个核对;缺失则随包预构建或降级该能力 |
| icacls 收紧破坏升级路径 | 只作用于 `<userData>` 自有目录;升级实测入 M3 矩阵 |
| Defender 计时不可接受 | 文档 + 排除建议 + MSIX 评估(M5) |
| windows-2022 与 Win11 行为差异 | 契约腿在 runner,交互矩阵在真机(M3 双机对照) |

## 7. 实机验收矩阵（Windows 11 x64 打包态）

| 面 | 验收点 |
|---|---|
| 生命周期 | 冷启动 → 本地实例 ready;重启/退出全链;崩溃后 reaper(win 腿)回收或 fail-closed |
| 托盘/窗口 | 托盘出现与 tooltip;hide-to-tray/quit 两设置;退出确认(D2);无窗常驻恢复 |
| 通知 | Action Center 显示 + 点击聚焦/打开(AppUserModelID 验证);dev/便携不承诺 |
| 唤醒 | 睡眠唤醒即时重探重连 |
| 运行时(env 门控态) | 安装(Defender 计时)→ 切换 → 探针失败 → 回滚 → 数据恢复;只读投影对照 |
| SSH | 密钥隧道 + exec;Pageant/agent;win32 无密码字段 |
| updater | stable/beta 双通道、确认后下载、退出安装(未签名 SmartScreen 记录) |
| 权限 | icacls 收紧后 userData/secret 文件 ACL 查询结果符合 C1/C2 预期;升级路径不破坏 |
| 深链 | URL 含 `&`/中文等特殊字符冷/热启动 |
| 杂项 | loopback 端口无防火墙弹窗;双机对照 windows-2022(契约)vs Win11(交互) |

## 8. 发布面决策记录（M5）

- **签名路径**:候选 A = Azure Trusted Signing(云签名、CI 免密钥管理、成本低);候选 B = OV/EV 自购证书;
  候选 C = 维持未签名(SmartScreen 提示 + 发布说明明示)。**决策点**:首个正式 Windows 发布前定 A/B/C。
- **发布形态**:NSIS 为主;若 Defender 首装体验/分发问题成为用户痛点,评估 MSIX/AppX 附加形态
  (系统级安装事务、非逐文件实扫、深链/更新通道约束需重审计)。
- **演练门禁**(release-checklist §7b):dry-run 全链(validation → build-macos → build-windows →
  build-gateway → build-linux)→ 实机 GitHub Release 安装 → stable/beta 更新全链;未签名产物在
  演练中同步记录 SmartScreen 首屏路径。
