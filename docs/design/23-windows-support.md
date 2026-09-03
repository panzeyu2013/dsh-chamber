# 23. Windows 支持推进方案(v3,反思修订版)

> 范围:dsh-chamber 桌面端(本地实例 + ssh/gateway 远程连接 + dsh 运行时版本管理)在
> Windows 上的首版支持推进。权威进度记录:`docs/progress/STATUS.md`;执行台账:
> `docs/progress/todo/windows-v1.md`;测试基线台账:`docs/progress/windows-baseline.md`。
> 本设计只记录契约与决策,不重复实现过程。

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

## 2. 里程碑(M0–M6)

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | `ci.yml` `test-windows`(windows-2022)契约腿 + 行为基线台账 | **代码就绪(待首个真实 runner 跑绿)** |
| M0.5 | 能力前置核查:上游 dsh win32 可跑性、electron-builder NSIS protocols 实证、Defender 计时基线、原生依赖预构建核对 | **待执行**(任务单见 todo/windows-v1.md) |
| M1 | 生命周期契约:win-probes(CIM 身份 / netstat 端口 / taskkill 树终止)+ reaper/spawn-dsh 平台自适应接线 + win32-only 集成测试 | **代码已合入形态(win-probes + 接线 + 单测);win32 真机腿待 runner 跑绿** |
| M2a | 运行时管理后台能力:env 门控 mutation、安装子进程树回收、icacls ACL 收紧、只读属性清理、rename 续作 | **核心已就绪**:desktop env 门控(`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`)、dsh-runtime `windows-process.ts`(supervisor 树终止 + 残余探测)、`rename-retry.ts`(snapshot-store 四处目录 rename)、desktop `win-acl.ts`(icacls 收紧+验证+启动复合入口,已接线 main)、C16(gateway 凭据 win32 无 safeStorage = 拒绝明文,store 内存驻留);只读属性清理以 win32-only 决策门测试定实现;剩余仅 runner 事务矩阵与实机核对(外部门禁) |
| M2b | UI/门控翻转(仅 M2a 在真实 win32 验证后) | 待执行(纪律 1 门禁) |
| M3 | 桌面实机全链(托盘/关窗/通知/唤醒/updater)+ 打包闭包 P2 修复 | 代码项已接:打包态 `app.setAppUserModelId`(win32)、托盘图标候选路径收敛(只留真实打包资源)、preload 缺失 loud 失败(不再静默回退 .cts);§8 实机矩阵与打包态验证为外部门禁 |
| M4 | 决策解锁:登录自启、深链注册、open-in 本地路径、SSH 免密引导 | **代码已解锁**:登录自启 win32(`setLoginItemSettings` + HKCU Run;supported 恒 true)、深链打包态注册(no-args 形态;dev 不注册)、open-in 本地盘符/UNC 路径(local 走 `validateLocalPath`)、NSIS 卸载 Run 键清理 include、SSH 密码门消息引导(keys/Pageant);**外部门禁**:Windows runner/实机验证(注册表实测、NSIS protocols 实证、登录自启/深链/open-in 实机矩阵);一键免密(密钥推送)UI 为后续独立特性 |
| M5 | 发布面:Azure Trusted Signing / MSIX 评估、dry-run 全链演练 | 决策框架与决策记录见 §9;执行待发布前 |
| M6 | 收口:妥协清单、支持矩阵文档、CHANGELOG | 待执行 |

## 3. M1 落地契约(本设计承载的代码事实)

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

## 4. 运行时管理解锁(M2,纪律门禁)

- dsh-runtime 核心设计本就 Windows 友好:指针为普通文件(禁 symlink)、文件级
  tmp+rename+fsync、pnpm 以 `node <pnpm.cjs>` 执行、候选经
  `ELECTRON_RUN_AS_NODE` 拉起。
- 解锁点(接线全集):desktop `main.ts`(managementSupported 注入与决策点)、
  `dsh-runtime-controller.ts`(mutation 拦截)、`apply-now-gate.ts`、settings-bridge 段、
  版本 chip。**M2b 翻转前必须** M2a 在真实 win32 runner 全绿 + 实机故障注入矩阵记录。
- Gateway 部署于 Windows:保持只读(服务器支持矩阵 = Linux/macOS,范围决策)。

## 5. 最终妥协点(发布附注,唯一权威)

**F1** 优雅停机不可达(SIGTERM dispose 无信号握手)→ 硬终止 + journal/指针/探针事务恢复
(Windows 全行业同此)。
**F2** 无目录 fsync → NTFS 日志 + 文件级 fsync + journal 重放(平台正确行为,非降级)。
**F3** Defender 实扫拖慢首次运行时安装 → 进度行 + 排除目录文档;MSIX 为结构替代(M5 评估)。
**F4** Gateway-on-Windows 运行时只读(范围决策)。
**F5** 非安装形态(便携)不承诺通知/托盘(AUMID/图标依赖安装形态,行业惯例)。
**F6** Authenticode 未签名或等待 Azure Trusted Signing(资源决策)。
**F7** 目录 rename 被第三方句柄占用时的瞬时重试窗口(续作 + 惰性删除后残余极小)。

已被标准实践替代而从妥协清单移除的项(仅记录,不再列为让步):ACL 收紧(icacls,
C1/C2)、CIM 命令行身份(C8)、清属性删除(C4)、rename 续作/惰性删除(C5)、
taskkill 树杀(C9)、safeStorage-only 不落明文(C16,win32)、卸载 Run 键清理(C19)、
koffi 等预构建(上游事实核查,C12)、SSH 免密引导(C15,门消息已落地)。
**C17(深链)未列入移除清单**:打包态运行时注册代码已解锁,但 electron-builder
`protocols` 键的 NSIS 注册行为仍待实证(§7 C17 行状态一致)。

## 6. 风险登记

| 风险 | 触发动作 |
|---|---|
| 上游 dsh win32-x64 实际不可跑 | M0.5 最小复现;若阻断 → 降级 P2:Windows 仅远程连接端 |
| electron-builder NSIS 不写协议注册表 | 打包态运行时 no-args `setAsDefaultProtocolClient` 已备(M4,deep-link.ts);若 protocols 键实证不写注册表再补 NSIS include |
| icacls 收紧破坏升级路径 | 只作用于 `<userData>` 自有目录;升级实测入 M3 矩阵 |
| Defender 计时不可接受 | 文档 + 排除建议 + MSIX 评估(M5) |
| windows-2022 与 Win11 行为差异 | 契约腿在 runner,交互矩阵在真机(M3 双机对照) |

## 7. 妥协映射表(2026 审计 C1–C23 → 终态)

| 原妥协 | 终态 | 去向 |
|---|---|---|
| C1/C2 0700/uid | **撤销** | icacls 显式 ACL 收紧 + 启动验证(M2a,win-acl.ts) |
| C3 目录 fsync | **撤销(平台事实)** | NTFS journal + 文件级 fsync + journal 重放;表述修正 |
| C4 只读树 | 降级为决策门 | win32-only readonly-rm 测试定是否需清属性(runner 裁决) |
| C5 目录 rename | **撤销(残余 F7)** | rename-retry + journal 续作 + 惰性删除 |
| C6/C7/C10 信号/双段/grace | **平台事实(F1)** | 硬终止 + 事务恢复(全行业同此) |
| C8 身份弱化 | **撤销** | PowerShell CIM 命令行/PPID 身份(M1,win-probes/windows-process) |
| C9 安装后代回收 | **撤销(残余≈0)** | taskkill /T /F + 残余 CIM 清扫(supervisor 接线) |
| C11 Defender 慢 | 接受(F3)+ 缓解 | 进度行/文档;MSIX 评估(M5) |
| C12 原生预构建 | **撤销(核查项)** | koffi 官方:win32-x64 预构建随包免编译器;其余逐个核对(M0.5) |
| C13 验证强度 | 验收强度问题 | 注入矩阵与 POSIX 对齐(M2a/M3) |
| C14 gateway win 只读 | 范围决策(F4) | 保持 |
| C15 SSH 密码 | **产品增强替代(部分落地)** | win32 门消息引导 keys/Pageant(main 已改);密码字段隐藏/一键免密 UI = 后续特性 |
| C16 明文回退 | **撤销(win32)** | safeStorage-only;拒绝落盘,store 内存驻留(main.ts 已接) |
| C17 深链 | **撤销(代码)/待实证** | 打包态运行时注册已解锁(M4);NSIS 注册行为实证(→ runner) |
| C18 便携无通知 | 行业惯例(F5) | 保持;打包态 AUMID 已接 |
| C19 卸载残留 | **撤销(代码)** | NSIS include 卸载段清 Run 键(packages/desktop/scripts/nsis-uninstall-cleanup.nsh);打包验证待 runner |
| C20 safeStorage=DPAPI | 平台事实 | Electron 封装即标准做法 |
| C21 签名 | 资源决策(F6) | Azure Trusted Signing 评估(§9) |
| C22 CI 无交互面 | 部分撤销 | 契约腿 + Playwright 冒烟(可选);人工矩阵仅剩 OS 集成面 |
| C23 图标资产 | 实现项 | 资源实现(M3 打包 P2) |

## 8. M3 实机验收矩阵(Windows 11 x64 打包态,勾选模板)

| 面 | 验收点 |
|---|---|
| 生命周期 | 冷启动 → 本地实例 ready;重启/退出全链;崩溃后 reaper(win 腿)回收或 fail-closed |
| 托盘/窗口 | 托盘出现与 tooltip;hide-to-tray/quit 两设置;退出确认(D2);无窗常驻恢复 |
| 通知 | Action Center 显示 + 点击聚焦/打开(AppUserModelID 验证);dev/便携不承诺 |
| 唤醒 | 睡眠唤醒即时重探重连 |
| 运行时(env 门控态) | 安装(Defender 计时)→ 切换 → 探针失败 → 回滚 → 数据恢复;只读投影对照 |
| SSH | 密钥隧道 + exec;Pageant/agent;win32 无密码字段 |
| updater | stable/beta 双通道、确认后下载、退出安装(未签名 SmartScreen 记录) |
| 权限 | icacls 收紧后 userData/secret 文件 ACL 查询结果符合 §C1 预期;升级路径不破坏 |
| 深链(如 M4 解锁) | URL 含 `&`/中文等特殊字符冷/热启动 |
| 杂项 | loopback 端口无防火墙弹窗;双机对照 windows-2022(契约)vs Win11(交互) |

## 9. 发布面决策记录(M5,决策点已定义,执行待发布前)

- **签名路径**:候选 A = Azure Trusted Signing(云签名、CI 免密钥管理、成本低);候选 B = OV/EV 自购证书;
  候选 C = 维持未签名(SmartScreen 提示 + 发布说明明示)。**决策点**:首个正式 Windows 发布前定 A/B/C。
- **发布形态**:NSIS 为主;若 Defender 首装体验/分发问题成为用户痛点,评估 MSIX/AppX 附加形态
  (系统级安装事务、非逐文件实扫、深链/更新通道约束需重审计)。
- **演练门禁**(release-checklist §7b):dry-run 全链(validation → build-macos → build-windows →
  build-gateway)→ 实机 GitHub Release 安装 → stable/beta 更新全链;未签名产物在演练中同步记录 SmartScreen 首屏路径。
