# Windows v1 推进执行台账(M0–M6)

> 契约与决策:docs/design/23-windows-support.md。基线:docs/progress/windows-baseline.md。
> 勾选原则:代码就绪 + 对应验证通过才算完成;凡需真实 Windows/CI 的项必须标注"外部门禁"。

## M0 — CI 契约腿与基线
- [x] ci.yml 新增 `test-windows`(windows-2022,autocrlf/symlinks 前置 + 关键套件)
- [x] 首跑归因(2026-09-03,d12c5ef):pin 守卫 Windows 路径分隔符 bug 已修;全量
      POSIX 套件在 win32 不可跑属设计事实(private-fs 无 O_NOFOLLOW fail-closed,
      M2b 前无 win32 语义)——腿收敛为 **Windows 有效子集**:dsh-runtime
      (test:win32 清单 = windows-process/rename-retry/win32-readonly-rm 决策
      门/dist-sync/sanitize-error)+ control-plane(test:win32 = win-probes/
      win32-lifecycle 集成)+ desktop(test:win32 = win-acl);**清单即单一事实源**
      (per-package package.json,CI 只消费清单,YAML 无测试文件名),全量套件归
      POSIX 腿,M2b 解锁后在各包 test:win32 内扩展。
- [ ] **外部门禁**:push 后 `test-windows` 首次跑绿(连续 3 次)
- [ ] windows-baseline.md 首份真实数据入库(首跑结果)

## M0.5 — 能力前置核查(外部门禁,需真实 Windows/产物)
- [ ] 上游 @deepseek-ai/dsh win32-x64:最小复现 spawn + ready(阻断级风险 R1)
- [ ] electron-builder v26 NSIS 是否写 HKCU\Software\Classes dsh-chamber(决定 C17)
- [ ] Defender 实扫计时基线(33k 文件安装耗时)
- [ ] 原生依赖预构建核对表(其余逐个核对)

**已知证据(2026 审计/官方源,核查时可引用)**:
- koffi 官网支持矩阵:Windows x64 ✅ / ARM64 ✅,且"prebuilt binary is included in
  the NPM package … install Koffi without a C++ compiler"(koffi.dev,2026)——win32-x64
  原生依赖大概率无需 VS 工具链,仍以安装实测为准。
- electron-builder v26+ 配置 API 存在顶层 `protocols` 键(electron.build/docs/configuration),
  但 NSIS 是否自动写注册表未在代码模板中证实(master installer.nsi 未见协议宏;
  installSection.nsh 抓取 404)→ 必须 windows-2022 最小构建实证(先查产物再决定 M4 形态)。
- Node `fs.rm` 对 FILE_ATTRIBUTE_READONLY 树的行为:由 win32-only 决策门测试
  (dsh-runtime/win32-readonly-rm.integration.test.ts)在 Windows CI 腿直接裁决。
- PowerShell 5.1 为 Windows 10+/Server 2016+ 必带(含 windows-2022 runner);wmic 已弃用不用。
- windows-2022(runner)带 VS 2022 工具链;windows-latest 的 VS 18 不被 node-gyp 正确识别
  (release.yml 既有注释)——Windows 构建腿固定 windows-2022。

## M1 — 生命周期契约
- [x] `control-plane/src/win-probes.ts`:CIM 身份/netstat 端口/taskkill 树终止/纯解析函数
- [x] `reaper.ts` resolveDeps 平台自适应默认 + `realManagedTreeAlive` 残余树感知
- [x] `spawn-dsh.ts` signalManagedGroup win32 树杀 + `windowsHide: true`
- [x] 单测:`win-probes.test.ts`(POSIX 全绿 9/9)
- [x] `win32-lifecycle.integration.test.ts`(win32-only,自 skip;POSIX 侧验证装载)
- [x] 注册进 `control-plane/scripts/test.mjs`
- [x] 回归:reaper.test 12/12、spawn-dsh.test 15/15(POSIX,本机 node 24)
- [ ] **外部门禁**:test-windows 腿上集成测试真实跑绿(CIM/netstat/taskkill 行为实证)
- [ ] design 02 §5.1 改写为落地契约;windows-baseline 已知 skip 清单销号/归类
- [ ] 全量 mac/linux 回归绿(依赖仓库 CI;本机无 node_modules 无法全跑——已跑受触面)

## M2a — 运行时管理后台能力(env 门控)
- [x] desktop main.ts:管理面仍只读,`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 为开发态后台验证门控(UI 翻转 M2b 前默认关)
- [x] dsh-runtime `windows-process.ts`:taskkill 树终止 + CIM 残余后代探测(纯解析 + win32 门控;5 单测绿)
- [x] runtime-installer supervisor 接线:win32 信号 = 树终止(`killWindowsTreeWithResidual`),死 leader 残余经 CIM 判定(`hasWindowsDescendants`);POSIX 回归 35/35 绿
- [x] `rename-retry.ts` + snapshot-store 四处目录 rename 接线(快照发布/backup/publish/回滚暂存;有界重试 100ms→1s,终错诚实上抛;POSIX 单路径零行为变化;31/31 绿)
- [x] desktop `win-acl.ts`:icacls `/inheritance:r /grant:r` 收紧 + 二次查询验证(fail-closed;含启动复合入口 `applyWindowsAclTightening`,6 单测绿)
- [x] icacls **主进程接线点**:main.ts whenReady 对 userData/state 目录与既有 secret 叶文件执行收紧(OI)(CI) 继承覆盖未来子项;失败 loud 不阻塞
- [x] win32 safeStorage-only(C16):main.ts gateway 凭据在 win32 且 DPAPI 不可用时**拒绝明文回退**,store 转内存驻留(file=null);S22 明文兜底仅限非 win32
- [x] eviction 只读属性:新增 win32-only 决策门测试 `win32-readonly-rm.integration.test.ts`(Node rm 对 readonly 树的行为实证,决定是否需要清属性实现;POSIX 自 skip)
- [ ] **外部门禁**:windows runner 上 M2a 事务矩阵(安装→切换→探针失败→回滚→恢复;env 门控开启态)+ readonly-rm 决策门结果 + icacls 实机输出核对

## M2b — UI/门控翻转(纪律门禁:M2a 全绿前不做)
- [ ] 翻转清单:main.ts(managementSupported 注入 + L4350/4413/4458/4733 决策点)、
      dsh-runtime-controller(mutation 拦截/known-good 调度)、apply-now-gate、UI/i18n、版本 chip
- [ ] win32 测试 diff 对照基线全归因
- [ ] **外部门禁**:Windows 11 实机故障注入全链 + 只读投影文案移除记录

## M3 — 桌面实机全链 + 打包修复
- [x] 打包态 `app.setAppUserModelId('com.dshchamber.desktop')`(win32,whenReady 顶部;design 23 M3)
- [x] 打包闭包 P2 代码(全闭环):托盘候选收敛;preload 缺失 loud(对话框+exit(1));
      `!dist/**/*.map` 出包排除;renderer 输出隔离 `dist/web`(standalone build:renderer
      不再清空共享 dist)——打包验证以 CI/release 产物为准
- [ ] **外部门禁**:§8 实机矩阵全勾(托盘/关窗/唤醒/SSH 密钥隧道/updater stable+beta/
      深链特殊字符 URL/防火墙 loopback 无弹窗/ACL 查询结果)+ 打包产物核对(图标/preload)

## M4 — 决策解锁(代码已全部解锁;验证为外部门禁)
- [x] 登录自启:`computeSupported` win32 解锁 + `applyLaunchAtLogin` win32 分支
      (`setLoginItemSettings`,HKCU Run)+ reconcile 全平台 + UI 文案 + 测试(19/19 绿)
- [x] NSIS 卸载清理 include:`packages/desktop/scripts/nsis-uninstall-cleanup.nsh` + package.json `build.nsis.include` 接线
      (customUnInstall 宏删 Run 值;打包验证待 runner)
- [x] 深链:打包态注册解锁(no-args 形态;dev 仍 skip);deep-link.ts/main 注释与测试同步(60/60 绿)
- [x] open-in 本地路径:`runOpenInLaunch`/finder 按 local 选 `validateLocalPath`
      (盘符/UNC);新增 4 用例(39/39 绿);design 20 注记见 design 23 §7
- [x] SSH:win32 密码门消息带 keys/Pageant 引导(main);一键免密(密钥推送)UI = 后续独立特性
- [ ] **外部门禁**:登录自启注册表实测/卸载残留、深链冷热启动 + `&` 字符 URL、open-in 盘符
      实机、NSIS protocols 实证(与 M0.5 合并)

## M5 — 发布面
- [x] 决策记录与评估框架落盘(design 23 §9:签名 A/B/C、NSIS↔MSIX、dry-run 演练门禁);
      workflow YAML(ci/release)校验通过
- [ ] Azure Trusted Signing / MSIX 形态评估执行(需凭据/发行决策)
- [ ] **外部门禁**:dry-run 全链 + 实机 Release 安装 + 更新链路演练

## M6 — 收口
- [x] STATUS.md Windows 条目逐项状态 + 妥协清单引用;README FAQ(双语)Windows 四条已补
- [x] design 23/todo/基线台账同步;DEVELOPMENT(双语)Windows 支持矩阵段已补
- [x] design 02 §5.1 / 14 D6 / 16 §4.3 / 20 §9 历史门控表述已改写(design 23 M1/M4 落地)
- [ ] CHANGELOG 条目(随正式版本)
- [x] **第二轮独立检查(3 个全新 subagent,2026)已汇入并修复**:修复核验全部通过;
      空白面补扫:windowsHide 误报(windows-process 创建时已含)、killFailedSpawn 无生产调用方
      (docstring 已注明 await+捕获)、verify-first 已实现(稳态省 6 次 icacls)、env 打包态风险句
      已入 design 23 纪律、deep-link platform 显式契约注记;终态一致性 4 low 已修(design02
      L299 括注/design09 L372 指针/STATUS 腿归属/todo nsis.include 措辞);CIM 缓存 TTL
      双模块统一 500ms(互指注释)。修复后 8 套件全绿(9/15/5/60/7/19/39/12)。
- [x] **独立验收(3 个 subagent,2026)已汇入并修复**:报告覆盖平台门控纪律/fail-closed/
      POSIX 回归(control-plane+dsh-runtime)、desktop M3-M4 改动与遗留引用、文档/CI/台账
      一致性。修复清单:win32-lifecycle 集成测试生成脚本路径 JSON 转义(high)、taskkill
      gone 判定本地化兜底(kill(0) 实探,双模块)、CIM 缓存时间戳后置、win-acl principal
      精确匹配(域前缀,弃 substring)+ 本地化近似注记、preload 缺失改对话框+exit(1)
      (打包态 UX)、注释/文档漂移(chamber-settings/preload.cts/open-in/README 双语/
      design15/baseline 行号与登记/design 23 §5-§6)。修复后 8 套件+2 集成装载全绿。
      未修复(记录在案):supervisor win32 sendSignal 无宽限重试(low,方向 fail-closed);
      双模块解析器重复(low,已加互指注释+双端 CI 测试);decideDeepLink 的 platform
      入参保留为显式契约(nit)。
