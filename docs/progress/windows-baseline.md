# Windows 行为基线台账(M0)

> 用途:Windows 首版推进(design 21)的**修复前基线**。第一次 `test-windows` CI 腿跑绿后,
> 把每个测试在 win32 上的 pass/skip 集合与每个平台门控的拒绝行为填入下表;此后每个
> 里程碑的 win32 测试变化必须对照本表归因(diff = 预期解锁集,不允许"顺手改绿")。

## 1. 测试腿基线(首跑后填写)

| 套件 | win32 pass | win32 skip(含文件:行理由) | 首跑日期/commit |
|---|---|---|---|
| test:runtime | 待填 | 待填 | — |
| test:control-plane | 待填 | 待填 | — |
| test:desktop | 待填 | 待填 | — |
| test:gateway | 待填 | 待填 | — |
| typecheck 全组 | 待填 | — | — |

## 2. 已知 skip 清单(翻转前的登记,来自 2026 审计)

> 行号以 2026 审计快照为准;如后续失效,以**测试名/描述**为准锚定(独立验收 2026 注记)。
> 登记不全风险:本节只登记审计时点快照;新增 win32 skip 于 M2b diff 归因时补录。

| 位置 | 内容 | 归类(翻转后去向) |
|---|---|---|
| control-plane/test/protocol.test.ts L738/822/865 | Unix detached 进程组契约 | win32 等价测试(M1,win32-lifecycle.integration)或 POSIX-only 注释 |
| dsh-runtime/test/runtime-installer.test.ts L547-686 等 | 进程组契约/不可变树/symlink fixture | 实现类(树回收/清属性)后 win32 等价;symlink 类标 POSIX-only |
| dsh-runtime/test/dsh-runtime-store.test.ts L440-527、snapshot-store L398/554、known-good-monitor L162、metadata-recovery L522/672/733/881 | symlink/权限 fixture | junction 或普通文件替代后 win32 等价;否则 POSIX-only |
| desktop/plugin-sync.test.ts L1701-1703 | 本地插件写进程 reaper 杀死守护化后代(进程组契约,POSIX-only) | M1 已落地等价:taskkill /T /F + CIM 残余清扫(win-probes/win32-lifecycle);非 symlink 类 |
| gateway/store-permissions.test.ts(0700 组)| POSIX 0700 | 有 win32 ACL 保留测试替代,保持 skip |
| control-plane/test/reaper.test.ts L95 | symlink fixture(symlink 权限与平台相关) | POSIX-only 注释 |
| dsh-runtime/test/dsh-runtime-store.test.ts L325-326、L950 | L325-326 symlink race fixture;L950 只读不可变树 eviction(与 M2a win32-readonly-rm 决策门直接相关) | symlink 类 POSIX-only;L950 由决策门结果决定(清属性实现或 Node rm 自带) |
| dsh-runtime/test/runtime-installer.test.ts L365 | 不可变树(immutable-tree)契约 | 决策门同 L950 |

## 3. 平台门控拒绝码基线(现状断言,翻转时逐个销号)

| 门控 | 现状(win32) | 断言位置 | 目标 |
|---|---|---|---|
| dsh 运行时 mutation | platform_read_only | gateway runtime-manager;desktop runtimeManagementSupported=false(env `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 开启验证态) | desktop 解锁(仅 M2a 真实 win32 验证后,M2b);gateway 保持 |
| SSH 密码 | IPC 拒存(引导 keys/Pageant) | ssh-provider.ts sshPasswordSupported / main 门消息 | 保持;一键免密 UI = 后续特性 |
| 登录自启 | **已解锁(代码)**:supported=true、`setLoginItemSettings`(HKCU Run) | chamber-settings.ts computeSupported / main.ts applyLaunchAtLogin(测试 19/19 绿) | runner/实机验证注册表与卸载清理 |
| 深链注册 | **已解锁(代码)**:打包态 register(no-args),dev skip | deep-link.ts decideDeepLinkProtocolRegistration(测试 60/60 绿) | runner 实测注册表 + 冷热启动 |
| open-in 本地路径 | **已解锁(代码)**:local 走 validateLocalPath(盘符/UNC) | open-in.ts runOpenInLaunch/finder(新增 4 用例,39/39 绿) | 实机盘符路径打开验证 |
| 0700/0600 语义 | 继承 ACL + no-follow/identity + icacls 启动收紧 | store-permissions/private-file/win-acl.ts(main 已接线) | runner/实机 ACL 查询核对 |
