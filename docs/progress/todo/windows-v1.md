# Windows v1：剩余（未实现 / 外部门禁）、基线登记口径与取舍

> 契约与决策：`docs/design/23-windows-support.md`（design 23）。M0–M4代码项已落地并通过POSIX单测（M0 CI契约腿、M1生命周期、
> M2a env门控、M3桌面打包、M4决策解锁）。本文只留未实现/外部门禁、
> 基线登记口径（原 `windows-baseline.md`）与取舍；每条须真实Windows/CI验证才算完成。

## 外部门禁（需真实 Windows runner / 实机 / 产物）

- M0：push后 `test-windows` 首跑绿（连续3次）；按 §基线登记口径把首份真实数据填入下表。
- M0.5：上游 `@deepseek-ai/dsh` win32-x64最小复现spawn + ready（阻断级R1）；NSIS是否写HKCU\Software\Classes（决定C17，需windows-2022最小构建实证）；Defender实扫计时；原生依赖预构建核对（koffi称预构建随包，仍以安装实测为准）。
- M1：test-windows腿上 `win32-lifecycle` 集成测试真实跑绿（CIM/netstat/taskkill实证）；design 02 §5.1落地契约改写；mac/linux全量回归。
- M2a：Windows runner上事务矩阵（安装→切换→探针失败→回滚→恢复，env门控开启态）+ `win32-readonly-rm` 决策门（Node rm对只读树行为）+ icacls实机输出核对。（：私有状态读写的win32身份回退已落地，事务首步不再因缺 `O_NOFOLLOW` 抛错；矩阵本身仍需runner。）
- M2b（纪律门禁：M2a全绿前不做）：`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS` 门控翻转（main.ts/dsh-runtime-controller/apply-now-gate/UI/i18n/版本chip）；win32测试diff对照基线全归因；Windows 11实机故障注入全链 + 只读投影文案移除。
- M3：design 23 §7实机矩阵全勾（托盘/关窗/唤醒/SSH密钥隧道/updater stable+beta/深链特殊字符URL/防火墙loopback无弹窗/ACL查询）+ 打包产物核对（图标/preload）。
- M4：登录自启注册表实测/卸载残留（nsis-uninstall-cleanup）、深链冷热启动 + `&` 字符URL、open-in盘符实机、NSIS protocols实证（与M0.5合并）。
- M5：Azure Trusted Signing/MSIX形态评估（需凭据/发行决策）；dry-run全链 + 实机Release安装 + 更新链路演练（design 23 §8）。
- M6：收口——妥协清单、支持矩阵文档与CHANGELOG条目随正式版本落定（design 23 §1分期表）。
- 遗留低优（记录在案）：supervisor win32 sendSignal无宽限重试（方向fail-closed）；双模块解析器重复（win-probes/windows-process互注 + 双端CI测试）；decideDeepLink platform入参保留为显式契约。

## 基线登记口径（M0 首跑后填写；原 windows-baseline.md）

> 用途：Windows首版修复前基线。第一次 `test-windows` CI腿跑绿后，把每个测试在win32的pass/skip集合与每个平台门控的
> 拒绝行为填入下表；此后每个里程碑的win32测试变化必须对照本表归因（diff = 预期解锁集，不允许「顺手改绿」）。行号以2026审计
> 快照为准，失效后以测试名/描述为锚（登记不全风险：本节只含审计时点快照，新增win32 skip于M2b diff归因时补录）。

### 测试腿基线

|套件|win32 pass|win32 skip（含文件:行理由）|首跑日期/commit|
|---|---|---|---|
|test:runtime|待填|待填|—|
|test:control-plane|待填|待填|—|
|test:desktop|待填|待填|—|
|test:gateway|待填|待填|—|
|typecheck全组|待填|—|—|

### 已知 skip 清单（翻转前的登记，2026 审计快照）

|位置|内容|翻转后去向|
|---|---|---|
|control-plane `test/protocol/protocol.test.ts` L738/822/865|Unix detached进程组契约|win32等价测试（M1 `win32-lifecycle.integration`）或POSIX-only注释|
|dsh-runtime `test/install/runtime-installer.test.ts` L547-686等、L365|进程组契约/不可变树/symlink fixture|实现类（树回收/清属性）后win32等价；symlink类标POSIX-only|
|dsh-runtime `test/store/metadata-authority.test.ts`（含authority-reader symlink、replaced-parent用例）、`snapshot-store` L398/554、`known-good-monitor` L162、`metadata-recovery` L522/672/733/881、`dsh-runtime-store`（eviction只读不可变树、原L440-527/L950）|symlink/权限/只读不可变树fixture|junction或普通文件替代后win32等价；eviction由 `win32-readonly-rm` 决策门（清属性实现或Node rm自带）决定|
|desktop `test/plugins/plugin-sync-apply.test.ts`（reaper fail-closes on PID identity reuse/kills a daemonized descendant）|本地插件写进程reaper杀死守护化后代（进程组契约，POSIX-only）|M1已落地等价：`taskkill /T /F` + CIM残余清扫（win-probes/win32-lifecycle）|
|gateway `test/auth/store-permissions.test.ts`（0700组）|POSIX 0700|有win32 ACL保留测试替代，保持skip|
|control-plane `test/host-lifecycle/reaper.test.ts` L95|symlink fixture（权限与平台相关）|POSIX-only注释|

### 平台门控拒绝码基线（现状断言，翻转时逐个销号）

|门控|现状（win32）|断言位置|目标|
|---|---|---|---|
|dsh运行时mutation|`platform_read_only`|gateway runtime-manager；desktop `runtimeManagementSupported=false`（env `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 开启验证态）|desktop解锁（仅M2a真实win32验证后，M2b）；gateway保持|
|SSH密码|IPC拒存（引导keys/Pageant）|`ssh-provider.ts` sshPasswordSupported/main门消息|保持；一键免密UI = 后续特性|
|登录自启|已解锁（代码）：supported=true、`setLoginItemSettings`（HKCU Run）|`chamber-settings.ts` computeSupported/`main.ts` applyLaunchAtLogin|runner/实机验证注册表与卸载清理|
|深链注册|已解锁（代码）：打包态register(no-args)，dev skip|`deep-link.ts` decideDeepLinkProtocolRegistration|runner实测注册表 + 冷热启动|
|open-in本地路径|已解锁（代码）：local走validateLocalPath（盘符/UNC）|`open-in.ts` runOpenInLaunch/finder|实机盘符路径打开验证|
|0700/0600语义|继承ACL + no-follow/identity + icacls启动收紧|store-permissions/private-file/win-acl.ts（main已接线）|runner/实机ACL查询核对|

## 仍生效的取舍

取舍唯一权威是 `docs/design/23-windows-support.md` §5「妥协点（发布附注，唯一权威）」与 `docs/progress/STATUS.md`「范围决策与必要取舍」：
F1无进程组等价、能力先于开关（M2a前只读/禁用）、Windows ACL权限语义、C16凭据仅内存、未签名发布身份均登记在彼，
本文不复述（避免第三份副本漂移）。
