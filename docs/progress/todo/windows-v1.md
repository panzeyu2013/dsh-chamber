# Windows v1：剩余（未实现 / 外部门禁）、基线登记口径与取舍

> 契约与决策：`docs/design/23-windows-support.md`（design 23）。M0–M4 的代码项
> 已全部落地并通过 POSIX 单测（M0 CI 契约腿、M1 生命周期、M2a env 门控后台能力、
> M3 桌面打包代码、M4 决策解锁——历史执行记录见 git 历史与 design 23）。本文只保留
> **未实现 / 外部门禁**、**基线登记口径**（原 `windows-baseline.md` 合并于此）与仍生效的
> 取舍；每条须真实 Windows/CI 验证才算完成。

## 外部门禁（需真实 Windows runner / 实机 / 产物）

- **M0**：push 后 `test-windows` 首跑绿（连续 3 次）；按 §基线登记口径把首份真实数据填入下表。
- **M0.5**：上游 `@deepseek-ai/dsh` win32-x64 最小复现 spawn + ready（阻断级 R1）；NSIS
  是否写 HKCU\Software\Classes（决定 C17，需 windows-2022 最小构建实证）；Defender
  实扫计时；原生依赖预构建核对（koffi 官网声称预构建随包，仍以安装实测为准）。
- **M1**：test-windows 腿上 `win32-lifecycle` 集成测试真实跑绿（CIM/netstat/taskkill
  实证）；design 02 §5.1 落地契约改写；mac/linux 全量回归。
- **M2a**：Windows runner 上事务矩阵（安装→切换→探针失败→回滚→恢复，env 门控开启态）
  + `win32-readonly-rm` 决策门结果（Node rm 对只读树行为）+ icacls 实机输出核对。
  （2026-12：私有状态读写的 win32 身份回退已落地，事务首步不再因缺 `O_NOFOLLOW` 抛错；矩阵本身仍需 runner。）
- **M2b（纪律门禁：M2a 全绿前不做）**：`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS` 门控
  翻转（main.ts/dsh-runtime-controller/apply-now-gate/UI/i18n/版本 chip）；win32 测试
  diff 对照基线全归因；Windows 11 实机故障注入全链 + 只读投影文案移除。
- **M3**：design 23 §7 实机矩阵全勾（托盘/关窗/唤醒/SSH 密钥隧道/updater stable+beta/
  深链特殊字符 URL/防火墙 loopback 无弹窗/ACL 查询）+ 打包产物核对（图标/preload）。
- **M4**：登录自启注册表实测/卸载残留（nsis-uninstall-cleanup）、深链冷热启动 + `&`
  字符 URL、open-in 盘符实机、NSIS protocols 实证（与 M0.5 合并）。
- **M5**：Azure Trusted Signing / MSIX 形态评估（需凭据/发行决策）；dry-run 全链 +
  实机 Release 安装 + 更新链路演练（design 23 §8）。
- **M6**：收口——妥协清单、支持矩阵文档与 CHANGELOG 条目随正式版本落定（design 23 §1 分期表）。
- **遗留低优（记录在案）**：supervisor win32 sendSignal 无宽限重试（方向 fail-closed）；
  双模块解析器重复（win-probes/windows-process 互注 + 双端 CI 测试）；decideDeepLink
  platform 入参保留为显式契约。

## 基线登记口径（M0 首跑后填写；原 windows-baseline.md）

> 用途：Windows 首版推进的**修复前基线**。第一次 `test-windows` CI 腿跑绿后，把每个测试
> 在 win32 上的 pass/skip 集合与每个平台门控的拒绝行为填入下表；此后每个里程碑的 win32
> 测试变化必须对照本表归因（diff = 预期解锁集，不允许「顺手改绿」）。行号以 2026 审计
> 快照为准，失效后以**测试名/描述**为锚（登记不全风险：本节只含审计时点快照，新增 win32
> skip 于 M2b diff 归因时补录）。

### 测试腿基线

| 套件 | win32 pass | win32 skip（含文件:行理由） | 首跑日期/commit |
|---|---|---|---|
| test:runtime | 待填 | 待填 | — |
| test:control-plane | 待填 | 待填 | — |
| test:desktop | 待填 | 待填 | — |
| test:gateway | 待填 | 待填 | — |
| typecheck 全组 | 待填 | — | — |

### 已知 skip 清单（翻转前的登记，2026 审计快照）

| 位置 | 内容 | 翻转后去向 |
|---|---|---|
| control-plane `test/protocol/protocol.test.ts` L738/822/865 | Unix detached 进程组契约 | win32 等价测试（M1 `win32-lifecycle.integration`）或 POSIX-only 注释 |
| dsh-runtime `test/install/runtime-installer.test.ts` L547-686 等、L365 | 进程组契约 / 不可变树 / symlink fixture | 实现类（树回收/清属性）后 win32 等价；symlink 类标 POSIX-only |
| dsh-runtime `test/store/metadata-authority.test.ts`（含 authority-reader symlink、replaced-parent 用例）、`snapshot-store` L398/554、`known-good-monitor` L162、`metadata-recovery` L522/672/733/881、`dsh-runtime-store`（eviction 只读不可变树、原 L440-527/L950） | symlink / 权限 / 只读不可变树 fixture | junction 或普通文件替代后 win32 等价；eviction 由 `win32-readonly-rm` 决策门（清属性实现或 Node rm 自带）决定 |
| desktop `test/plugins/plugin-sync-apply.test.ts`（reaper fail-closes on PID identity reuse / kills a daemonized descendant） | 本地插件写进程 reaper 杀死守护化后代（进程组契约，POSIX-only） | M1 已落地等价：`taskkill /T /F` + CIM 残余清扫（win-probes/win32-lifecycle） |
| gateway `test/auth/store-permissions.test.ts`（0700 组） | POSIX 0700 | 有 win32 ACL 保留测试替代，保持 skip |
| control-plane `test/host-lifecycle/reaper.test.ts` L95 | symlink fixture（权限与平台相关） | POSIX-only 注释 |

### 平台门控拒绝码基线（现状断言，翻转时逐个销号）

| 门控 | 现状（win32） | 断言位置 | 目标 |
|---|---|---|---|
| dsh 运行时 mutation | `platform_read_only` | gateway runtime-manager；desktop `runtimeManagementSupported=false`（env `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 开启验证态） | desktop 解锁（仅 M2a 真实 win32 验证后，M2b）；gateway 保持 |
| SSH 密码 | IPC 拒存（引导 keys/Pageant） | `ssh-provider.ts` sshPasswordSupported / main 门消息 | 保持；一键免密 UI = 后续特性 |
| 登录自启 | 已解锁（代码）：supported=true、`setLoginItemSettings`（HKCU Run） | `chamber-settings.ts` computeSupported / `main.ts` applyLaunchAtLogin | runner/实机验证注册表与卸载清理 |
| 深链注册 | 已解锁（代码）：打包态 register(no-args)，dev skip | `deep-link.ts` decideDeepLinkProtocolRegistration | runner 实测注册表 + 冷热启动 |
| open-in 本地路径 | 已解锁（代码）：local 走 validateLocalPath（盘符/UNC） | `open-in.ts` runOpenInLaunch/finder | 实机盘符路径打开验证 |
| 0700/0600 语义 | 继承 ACL + no-follow/identity + icacls 启动收紧 | store-permissions/private-file/win-acl.ts（main 已接线） | runner/实机 ACL 查询核对 |

## 仍生效的取舍

取舍的唯一权威是 `docs/design/23-windows-support.md` §5「妥协点（发布附注，唯一权威）」与
`docs/progress/STATUS.md`「范围决策与必要取舍」：F1 无进程组等价、能力先于开关（M2a 前只读/
禁用）、Windows ACL 权限语义、C16 凭据仅内存、未签名发布身份均登记在彼，本文不复述（避免
第三份副本漂移）。
