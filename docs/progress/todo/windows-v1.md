# Windows v1 剩余（未实现 / 外部门禁）与取舍

> 契约与决策：`docs/design/23-windows-support.md`（design 23）。M0–M4 的代码项
> 已全部落地并通过 POSIX 单测（M0 CI 契约腿、M1 生命周期、M2a env 门控后台能力、
> M3 桌面打包代码、M4 决策解锁——历史执行记录见 git 历史与 design 23）。本文只保留
> **未实现 / 外部门禁**项与仍生效的取舍；每条须真实 Windows/CI 验证才算完成。

## 外部门禁（需真实 Windows runner / 实机 / 产物）

- **M0**：push 后 `test-windows` 首跑绿（连续 3 次）；windows-baseline.md 首份真实数据入库。
- **M0.5**：上游 `@deepseek-ai/dsh` win32-x64 最小复现 spawn + ready（阻断级 R1）；NSIS
  是否写 HKCU\Software\Classes（决定 C17，需 windows-2022 最小构建实证）；Defender
  实扫计时；原生依赖预构建核对（koffi 官网声称预构建随包，仍以安装实测为准）。
- **M1**：test-windows 腿上 `win32-lifecycle` 集成测试真实跑绿（CIM/netstat/taskkill
  实证）；design 02 §5.1 落地契约改写；mac/linux 全量回归。
- **M2a**：Windows runner 上事务矩阵（安装→切换→探针失败→回滚→恢复，env 门控开启态）
  + `win32-readonly-rm` 决策门结果（Node rm 对只读树行为）+ icacls 实机输出核对。
- **M2b（纪律门禁：M2a 全绿前不做）**：`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS` 门控
  翻转（main.ts/dsh-runtime-controller/apply-now-gate/UI/i18n/版本 chip）；win32 测试
  diff 对照基线全归因；Windows 11 实机故障注入全链 + 只读投影文案移除。
- **M3**：design 23 §7 实机矩阵全勾（托盘/关窗/唤醒/SSH 密钥隧道/updater stable+beta/
  深链特殊字符 URL/防火墙 loopback 无弹窗/ACL 查询）+ 打包产物核对（图标/preload）。
- **M4**：登录自启注册表实测/卸载残留（nsis-uninstall-cleanup）、深链冷热启动 + `&`
  字符 URL、open-in 盘符实机、NSIS protocols 实证（与 M0.5 合并）。
- **M5**：Azure Trusted Signing / MSIX 形态评估（需凭据/发行决策）；dry-run 全链 +
  实机 Release 安装 + 更新链路演练；CHANGELOG 条目（随正式版本）。
- **遗留低优（记录在案）**：supervisor win32 sendSignal 无宽限重试（方向 fail-closed）；
  双模块解析器重复（win-probes/windows-process 互注 + 双端 CI 测试）；decideDeepLink
  platform 入参保留为显式契约。

## 仍生效的取舍（design 23 / STATUS）

- **无进程组等价**（妥协 F1）：win32 用硬终止 + 事务恢复，detached/进程组/SIGTERM
  dispose 语义不可等价。
- **能力先于开关**：dsh-runtime mutation 与 SSH askpass 密码认证在 M2a 验证完成前
  保持只读/禁用门控；UI 翻转列 M2b。
- **权限语义诚实**：Gateway owner-private 目录在 Windows 只验证
  real-dir/no-follow/identity 并继承 OS ACL（icacls 显式收紧已接线）；Node 的
  mode/chmod 无法诚实证明 POSIX 0700，不把该让步写成已有等价保障。
- **凭据存储**：win32 上 DPAPI（safeStorage）不可用时拒绝明文落盘（C16/S22 明文兜底
  仅限非 win32）——凭据仅内存驻留，每次连接需重录。
- **发布身份**：x64 安装包未做 Authenticode 签名，SmartScreen 提示为已知取舍；feed
  sha512 只证明下载完整性，不等价于发行者签名。
