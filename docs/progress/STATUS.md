# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不再在此
> 复述实现过程与验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/todo/12-todo-archived-sessions.md`。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化
  透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游
  解锁（07 §3/§4）。设计见 `docs/design/07-models-params.md`。
- **SSH 密码认证可选增强（05 §8 例外主体已落地）**：未做（可选）——一键
  免密引导、系统钥匙串。
- **Windows 首版支持暂缓**：detached/进程组/lsof 降级路径；Unix 为契约
  目标。
- **dsh 运行时服务端化 + per-server 设置段（设计 18 §9 + §3.6 修订，已实现 M5–M7）**：
  共享核心抽取（`packages/dsh-runtime`）+ gateway 解析链/启动切换相位/
  `/chamber/runtime` 管理面（含 `POST /chamber/runtime/restart`）+ desktop 迁移；
  「dsh 运行时」设置从「通用」迁为 per-server 段（agent 预设后，
  `settings.section` id `dsh-runtime`），三种来源均含**「重启 dsh」动作**
  （local 控制面事务接口 `restartLocal()`、gateway `/chamber/runtime/restart`
  （202 + 轮询，runtime 控制器不随 ready detach）、ssh `restart_service`
  systemd IPC）刷新插件挂载（§3.6 项 8/§9.3）。**已落地**：control-plane
  的 `PlaneHandle.restartLocal()` 事务原语（与健康状态机重启单飞行串行化，
  design 18 §9.3，覆盖 `packages/control-plane/test/restart-local.ts`）；
  **M5 共享核心**（§9.1）：runtime 核心迁入 `packages/dsh-runtime`
  （真实 seam 为 StartupDeps/ApplyDeps/InstallerDeps；`RuntimeHostAdapter` 为文档草图 + 纯 Node `test/fake-adapter.ts` 夹具；desktop
  改薄 shim 引用共享包；`pnpm run test:runtime` / `typecheck:runtime` 已登记 +
  ci.yml 接入）；**M6 gateway**（§9.3）：`runtime-manager.ts`（env→override→锚
  解析链、单进程 owner 守卫、启动事务）、`runtime-routes.ts`（不随 ready detach
  控制器：status/versions/select/apply/rollback/restore-builtin/retry-apply/
  retry-restore/restart/registry，restart 202 + 轮询、applying 409）、dispatch
  3.5 认领、CLI 锚语义、gateway
  `pnpm@11.21.0` 运行时依赖（D1），`test/runtime-routes.test.ts` 用例随第六轮
  补至与文件同步；
  **M7 per-server 段**（§3.6）：settings-bridge 注册 `settings.section` id
  `dsh-runtime` order 31 + GeneralView 出户 + 三分支 restart 动作 +
  `dsh-chamber:runtime-restart` IPC + i18n。**分阶段偏差（已登记）**：
  settings gateway 分支当前为缩减视图（remote 版本行 + 重启按钮 + 轮询），
  完整 per-server 段（版本选择器/状态/快照/变更经 `/api/i/<id>/chamber/runtime/*`
  代理）属后续阶段，DshRuntimeSection 头部注释与本节为准。
  **剩余实机/打包门禁**：真实 dsh 的 gateway 启动事务端到端（pending 快照→切
  指针→探针→回退）、desktop 打包态（dist/asar 含共享包，机制与 control-plane
  同款已核但未跑 `dist:desktop:mac`）、`runtime-fake-registry-acceptance` 的
  gateway 形态移植、gateway restart 窗口前端重连实机、ssh `restart_service`
  systemd IPC 端到端回归（分支仅 `deriveRuntimeSource` 有派生测试）。desktop
  dsh-runtime dist 的打包覆盖已改显式（afterPack 校验 app.asar 内
  `node_modules/@dsh-chamber/dsh-runtime/dist/index.js`，@electron/asar devDep），
  实机仍待 `dist:desktop:mac` 实跑确认。
  restart-local 测试用立即 resolve 的 stop mock，未覆盖真实 1s SIGTERM→SIGKILL
  窗口与 grace 期间健康计时器交互（V2 M6，覆盖缺口）。
  **第五轮评审修复（2026-09，V1–V4 维度化复查）**：🔴 gateway 从内建锚首次
  安装→apply 必然 snapshot-failed（V1 以 /tmp 假 dsh 夹具 + 真实 pnpm + fake
  registry 端到端实证；根因 activationFacts 内建时 sourceVersion=null 而
  apply-phase 拒绝 null——desktop 用 bundledVersion 真 semver，gateway 分叉）
  → 新增 `readBuiltinVersion()` 读锚包版本 + manager `activationFacts()`
  accessor（内建时用锚 semver 作快照源，不可读时 fail-loud），补 2 个回归
  测试；select 对「已装未激活」树改记录选择（不再被 installer 拒覆写），
  补测试；V2：gateway dispose() 改 await install 子进程回收（S17 停止序）、
  共享 installer disposing 标志 dispose 后复位（同进程 stop→start 不再永久
  拒安装）、triggerRestart 尾部 catch（catalog 写失败不再升级为
  unhandledRejection→app.exit）、desktop restart handler 持 writer fence
  租约（与 runtime 事务互斥双向化）、在途 health probe 结果在 restart 期间
  抑制、UI 双击重入闸 + server 切换清 remoteRuntime + poll sleep abort；
  V3：AGENTS Validation 补 typecheck:gateway/test:cli/test:release-workflow、
  S19 脱敏统一（select 改 sanitizeRouteError + 补 passwd/cookie/冒号形态）、
  RuntimeHostAdapter 口径改文档草图（真实 seam = StartupDeps/ApplyDeps/
  InstallerDeps）、settings-bridge→renderer 投影 seam 入 AGENTS 登记、
  design 18 §3.6 保守矩阵/§9.1 模块清单/design 02 §3.6 计数歧义修订；
  V4：fakePlane 可变化 + live 连接态投影/restart 失败→operationError 脱敏
  /registry·owner 0600/env 409 路由/degraded 202/semver 双实现锁步（移入
  runtime-lockstep）测试补齐。
  React 组件级缺口（R10 点名）：gateway `remoteRuntime` useEffect 的 server
  切换重取/取消、`fence.busy → restart reject → actionError` 链路、
  ssh 分支 hostId 截取均无组件单测（纯函数已测）。契约见
  `docs/design/18-dsh-runtime-version.md` §9/§3.6（并修订
  design 17 §2.1/§4/§8.4/§10/§11/§12/§13、design 05 §5、design 02 §2.6、
  design 01 §3/§4；AGENTS.md 新增 `packages/dsh-runtime` 边界条目 +
  current set 登记 gateway pnpm）。
  **评审轮修复（2026-09，五路只读评审后）**：gateway 状态根 baseDir 双嵌套
  （F1，store/install/snapshot 统一以 stateDir 为 baseDir）、install 子进程
  env scrub 绕过（F2，node env={}）、known-good 接线（F3）、select/apply/
  rollback 语义（F4：select 记录选择、apply 置 pending、rollback 走
  manualRollback intent + pre-rollback 暂存）、错误脱敏加 URL/token 模式
  （F5）、owner 守卫改 `wx` 排他创建（F8）；共享核心打包断裂（P0：dist 产物
  + `types` 指 src + 根 `build:dsh-runtime` 入 `build:desktop`）、Electron 分叉
  移出共享核心（P1：desktop 经 deps.node 注入）；per-server 段注册移入子
  cordis 上下文（原注册在 app 上下文为死代码）+ source 按选中服务器派生 +
  三段重启失败诚实化（local reject / ssh result.error / gateway 202 后轮询）；
  restart-dsh 在 snapshot-failed/env 源被矩阵禁用的口径比 §3.6「非 applying」
  更保守——**保留保守口径**（env 源由 env 路径支配、快照失败态存在未完成
  事务，重启不应绕过）。
  **第二轮评审修复（2026-09，R6 复核 13/13 ✅ + R7 全新找茬 + R8 测试充分性）**：
  restoreBuiltin 清 activation journal（否则下次启动 journal-mismatch FATAL，
  评审员已实证）；apply/restoreBuiltin 补 activation 栅栏 + Windows 只读门
  （消除与 select 的丢失更新竞态）；/select、/restart 同步拒绝改 4xx（不再
  吞成假 202），异步失败经 status().operationError 可观测，pollGatewayReady
  识别 error/restart-exhausted 透出原因；status 在 env override 下不再误报
  pending；rollback 去掉孤儿急 stash（交给启动事务记账）；feature 订阅移到
  启动事务之后（探针瞬态 ready 不再提前启动消费者）+ 事务后
  refreshLocalExposure()（公共快照不卡 quarantine）；desktop runtime-restart
  忙态改 reject（不再静默成功）；dispatch/runtime-routes 前缀改精确边界
  （/chamber/runtimeevil 不误认领）；restart-local.ts 接入 ci.yml（原为
  CI 孤儿）；sanitizeRouteError 导出 + 单测；owner ESRCH 接管、401 经
  dispatch 端到端、pollGatewayReady 成功/超时/abort/失败单测。”
  **第三轮评审修复（2026-09，R9 部署/打包 + R10 desktop/UI + R11 文档/CI）**：
  gateway `pnpmEntry()` 改经 `require.resolve('pnpm')`（package.json 入口）+ 手拼
  `bin/pnpm.cjs`——pnpm 的 exports 隐藏该子路径，原写法
  ERR_PACKAGE_PATH_NOT_EXPORTED 使 select 安装必 500（评审员实测复现），补回归
  测试；install-gateway.sh：env 锚捕获（不再覆写空 `DSH_GATEWAY_DSH_PATH`）、
  非 purge 卸载后允许原地重装、锚校验与 gateway `isDshWorkspace` 对齐
  （npm 形态 + 源码检出形态、存在即可）、卸载清残留启动器/run 文件、
  status 探针对 401 给出诚实提示、port_free 无 GNU timeout 时退化直连；
  dsh-runtime dist 改 committed artifact（.gitignore 豁免，host-graph 先例）、
  根 `build:gateway`/CI gateway 步骤/`dev:desktop` 链入 `build:dsh-runtime`
  （干净检出可用）；design 05 §7.3 补 `restartLocal()`/`refreshLocalExposure()`、
  design 18 §9.3 单进程守卫措辞改 O_EXCL owner 文件（EEXIST fail-loud/ESRCH
  接管）、AGENTS Validation 同步 restart-local 与 gateway/cli/release-workflow 校验、
  STATUS 剩余门禁补 ssh `restart_service` 回归。
  **第四轮全新评审修复（2026-09，F1–F4 零前提复查）**：gateway `dispose()`
  回收 install 子进程（原 `installChildren` 死代码，停止时 pnpm 孤儿会让下次
  cleanupStaleInstalls 拒启动，S17）+ 退出清 owner 记录；解析链 override 分支
  遵守 `shouldInvalidate` + 启动前写 shell-invalidation intent（F4 回落内建，
  与 desktop 同款）；`snapshot-failed` 移出 FATAL（继续当前树 + status 相位投影，
  给用户管理面出口）；owner 接管改 rename 原子夺权；空串 env 按未设置；
  operationError/日志用 sanitizeRouteError（抽独立模块）；restart 在途 409；
  「选当前版本=无操作」；env 锚激活时 select/apply/rollback/restore-builtin 全部
  409 拒绝；installer env 白名单补小写代理变量；新增 dist-sync 锁步测试
  （committed dist 与 src 导出集一致）；test:gateway 去重 transport 用例；
  desktop 重启 handler 在 restart-exhausted/error 时诚实 reject + 补
  error 态/耗尽二次拒绝/workspace thunk 重解析三测试（restart-local 15 用例）；
  UI 补「dsh 已重启」成功文案；design 18 §9.3(5) 措辞改「每次重启计入窗口」、
  design 02 §3.5 图改 respawn→ready；install-gateway.sh 锚改 `--dsh-path`
  （原写 DSH_GATEWAY_DSH_PATH 会把所有脚本装机钉死 env 源、静默禁用切换）、
  env 行仅在用户显式 env 锚时写回、--local 启动器改经 current 符号链接
  （升级不再跑旧二进制）、beta 过滤 prerelease、uninstall -y 可脚本化。
  STATUS 剩余门禁补 ssh `restart_service` 回归。
  **第六轮评审修复（2026-09，五路只读评审 + 独立实证后修复）**：typecheck:
  runtime 门禁修复（dist-sync 动态 import 改 string 化 specifier，原 TS7016
  必红 CI）；desktop prune 路径补 Electron-as-node 注入（与 install 同款，
  修复移动后静默分叉）+ restart IPC 把 stopped 结局计入诚实失败 + install
  deps 合并而非覆盖；afterPack 校验 app.asar 内含 dsh-runtime dist
  （@electron/asar devDep + fixture 测试）；gateway：owner 接管写失败改
  fail-loud（不再无记录继续、静默禁用单进程守卫）、restart 期间
  select/apply/rollback/restore-builtin 全部 409（双向 fence）、restart 结局
  投影（status().restart = running/ok/failed，轮询可区分 202 后入口拒绝与
  成功）、swap-attempted/restore-half/restore-incomplete 移出 FATAL（gateway
  保持存活 + dsh 停机 + status 投影 blockedReason + POST /chamber/runtime/
  retry-apply|retry-restore 恢复面，镜像 desktop blocked-but-alive 语义）、
  connection_busy/no_retry_target → 409、413 先写响应再 destroy socket、
  async catch 统一 sanitizeRouteError、CLI --dsh-path 帮助改锚语义；
  core：disposeRuntimeInstaller 成功后复位 supervisor（同进程 stop→start
  可再安装，补回归测试）、restart-dsh 矩阵测试、小写代理白名单测试；
  lockstep：renderer/main 矩阵改双向相等断言 + semver corpus 补对抗用例；
  settings-bridge：gateway 轮询 4xx 快速失败（401/403/404 不再盲轮 90s）、
  restart:failed 终态识别、local 分支 surface 缺失不再假成功；设计 18
  M4 修订注矛盾修正 + note 9 改真实 seam 口径 + dsh-runtime package.json
  描述同步；本段 M7 补 gateway 缩减视图偏差登记。
  **第七轮评审修复（2026-09，模块化复查后的补充修复）**：gateway restart
  结局严格化（resolve ≠ success——restartLocal() 从 restart-exhausted/error/
  stopped 结算也 resolve，现按连接态判 failed 并抛错，轮询终态优先于 ok
  双保险）；/select 在 restart 在途时同步 409（fire-and-forget 202 不再吞
  静默拒绝）；retry-apply 接受 snapshot-failed（desktop canRetryApply 对齐，
  gateway 获得非破坏性快照失败恢复面）；restoreBuiltin 清内存
  startupBlockReason/operationError（不再投影陈旧 blocked 相位）；CLI 启动
  日志按连接态诚实输出（blocked 启动不再谎报 "local dsh is ready"）；
  assertSingleOwner 去未用参数 + stale 残留注释；core dispose 回归测试重写
  为走默认 supervisor 路径（原测试注入 deps.run 绕过被复位对象，修复前也
  绿——现用 pruneRuntimeStore 默认 runFn 验证 latch）；run() 关闭闩改
  writerUnsafeError 分类；lifecycle 补 blocked-start 组合测试 + FATAL 回滚
  测试；settings remote 分支补渲染成功 note + ssh docblock 修正 + source/id
  不匹配防御性 throw；设计 18 §9.3(3) 改 PlaneHandle.restartLocal() 口径 +
  §9.3 伪代码符号修正；RuntimeHostAdapter 残留旧口径清理（index.ts、
  runtime-host-adapter.ts 首段、design 18:769）。
  **第八轮评审修复（2026-09，第三轮模块化复查）**：gateway 事务写路径
  select/apply/rollback 全部清 lastOutcome/lastError（快照失败后重新选择+
  apply 不再在下次启动被 runStartupPhase 再次阻断，desktop 换新记录对齐）；
  restart 成功判定改白名单（仅 ready/degraded；epoch bump 时 'restarting'
  残留态不再误判 ok，desktop IPC 同改）；restoreBuiltin 清 restartOutcome
  （与 operationError 对称）；CLI blocked 提示改「重启 gateway 服务」（无
  start 路由）；core createOperationDeadline 的 shutting-down 门闩改
  writerUnsafeError（与 run() 守卫分类统一）；settings 轮询终态集补
  'stopped'（与 desktop/gateway 两消费方一致）+ 新增「终态优先于 ok」矩阵
  测试 + gateway 409 拒绝透出服务端 error 文案（不再只有裸状态码）；文档：
  design 18 §9.3 伪代码符号真正修正（resolveActiveRuntime 单参，gateway 侧
  注明 resolveWorkspace）、§9.3 路由表补 retry-apply/retry-restore + blocked
  启动保持存活语义、design 17 §8.4 与 STATUS M6 路由枚举同步、
  AGENTS.md 去掉 restartHost seam 措辞 + test:desktop 清单补
  dsh-runtime-controller/bundle-swap/after-pack 三套件。
  **第九轮评审修复（2026-09，第四轮最终检查）**：gateway 陈旧 intent
  journal 陷阱根治——rollback 写 intent journal 后若用户重新 select 其他版本
  （再 apply），journal 目标与 pending 不匹配会在下次启动 FATAL
  journal-mismatch（或 select 不 apply 时陈旧 intent 在启动时生效）；修复 =
  select 清「intent 相位」陈旧 journal（不动 monitoring/在途事务证据），
  apply 写与 pending 匹配的 intent（manualRollback 按下探计算，desktop
  对齐；在途事务诚实 409），补 rollback→select→apply 回归测试（routes 32
  用例）。
  **第十轮评审修复（2026-09，第四轮最终检查收尾）**：rollback 改先写
  intent journal 再写 override（崩溃不再丢失 manualRollback 标记）；
  select/apply/rollback 清内存 startupBlockReason（与 restoreBuiltin
  对齐，status 不再投影陈旧 blocked 相位）；轮询超时 90s→120s（匹配
  restart 背压窗口内多轮退避 + spawn，避免慢机器误报失败）；轮询旧版
  gateway fallback 接受 degraded（与白名单语义一致）；/restart 409 文案
  去掉不存在的 start 路由、指向 restore-builtin/retry 恢复面；
  createOperationDeadline 门闩补直接测试（ERR_DSH_WRITER_UNSAFE 分类）；
  settings gateway 分支透出 connectionState（非 ready 时显示，i18n 新增
  dshRuntimeRemoteConnState zh/en）；design 18 §9.1 迁入模块清单补
  allow-builds/prune-runtime；AGENTS Gateway packaging 措辞对齐 CI。
  **第十一轮实机测试修复（2026-09，192.168.110.172 全流程测试）**：
  install-gateway.sh npm 全局 dsh 锚路径语义修复——verify_dsh 期望 workspace
  形态（$ws/node_modules/@deepseek-ai/dsh），但全局分支与 install_dsh 传入
  npm root -g（本身已是 node_modules 目录）导致安装后验证必失败，且即使
  通过，--dsh-path <npmRoot> 也会让 gateway 的 readBuiltinVersion/spawn
  找不到树；修复 = 全局分支与安装后统一转换 workspace 形态
  （dirname(npmRoot)）；gateway 部署缺 chamber host 包（dsh-host-client-graph
  / dsh-chamber-host-git-worktree）——打包 gateway 不含它们时 REPO_ROOT 在
  npm 全局安装下解析到全局 node_modules、seed 被静默跳过，托管 dsh 无
  chamber RPC，全量激活探针集（含 chamber 域）必失败 → 每次运行时切换都在
  探针门回退（本测试实证：切换 → 快照恢复 → 内建回退探针失败）；修复 =
  build.mjs 把两个 host 包（package.json + committed dist/index.js）复制进
  packages/gateway/host-packages/ 并随 tarball 发布，createGateway 经
  hostGraphPackageSourceDir/hostGitWorktreePackageSourceDir 注入控制面，
  seed 恢复（启动日志：seeded @dsh-chamber/dsh-host-client-graph /
  dsh-host-git-worktree），切换事务全探针通过；实测覆盖：全新安装（离线
  tgz + npm dsh 锚 + systemd）、401 边界、select 真实安装（首次遇 pnpm
  EAGAIN 瞬时失败、重试成功、失败投影诚实）、apply + 重启切换
  （0.1.1-rc.2 → 0.1.0-rc.8 降级，manualRollback 路径）、restart 202+轮询
  ok、restore-builtin 回落、restart 在途 select 409、坏 body 400、
  status/logs/uninstall 子命令。
  **第十二轮受控锚决策（2026-09，用户拍板）**：gateway 的 dsh 内建锚不再使用
  npm 全局安装——dsh 运行时由 gateway 拥有（desktop 同理打包自带 dsh，
  互不共享）。install-gateway.sh 改为把锚安装到受控位置
  `${GATEWAY_DIR}/dsh-anchor`（`npm install --prefix`，workspace 形态），
  detect 不再探测/复用 npm 全局树（保留 --dsh-path 显式锚与 env 锚）；
  运行期版本仍由 gateway 嵌入式 pnpm 经 /chamber/runtime/select 安装到
  `<stateDir>/dsh-runtime/`。实测（移除全局 dsh 后全流程）：受控锚安装 →
  select 0.1.0-rc.8（树落 stateDir/dsh-runtime）→ apply + 重启切换（运行中
  dsh = 受控 runtime 树）→ restart 202+ok → restore-builtin 回落受控锚 →
  restart 在途 select 409。另记录：该机 ZFS 文件系统下 pnpm 全新 store
  克隆偶发 ERR_PNPM_EAGAIN（瞬时资源抖动，失败投影诚实、重试恢复、无数据
  损坏；系统化缓解（克隆并发上限）留待后续）。

## 部分完成（剩余验收 / 剩余实现）

- **桌面通知（设计 19，已实现）**：剩余 macOS 系统通知权限实机验收（M3，
  打包态冒烟）。契约见 `docs/design/19-notifications.md`。
- **VS Code 深链 + open-in 打开注册表（设计 16/20，M0–M3 已实现）**：
  剩余实机验收——macOS 深链冷/热启动、打包态、托盘/退出在途、N-ctx、
  VS Code 缺失、sshPort≠22、dev 深链 argv 注入测试路径、Finder 下拉在
  vendor 头部的定位/层叠、远程来源仅 vscode。契约见
  `docs/design/16-vscode-deeplink.md` / `docs/design/20-open-in-registry.md`。
- **Git Worktree 插件（设计 08，v1 已落地）**：M4 尚余真实远程 Linux +
  Git 仓库的端到端验收（含首次 ready-time seed 后重启生效、Git LFS/filter
  提示边界）。契约见 `docs/design/08-git-worktree-plugin.md`。
- **远程实例插件管理（设计 13，M1–M4 已落地）**：剩余——本地 `dsh plugin`/
  `pnpm pack` 依赖本机 pnpm（`resolvePnpmBinDir` 扫描 PATH + nvm/volta/
  homebrew，打包态 best-effort）。契约见 `docs/design/13-remote-plugin-management.md`。
- **桌面端更新（设计 11，已实现）**：剩余——配置真实签名秘密后的 release
  CI 上传/公证/验签实测，双平台实机检查/下载/退出安装；mac 安装腿未配置
  Developer ID 时 settings 响亮提示手动安装。契约见 `docs/design/11-auto-update.md`。

- **认证服务端 Gateway（设计 17，已实现）**：剩余发布前门禁——生产 TLS
  反代（Caddy 等）的 Host/Origin/XFF/Secure-cookie 实机验证（基础形态已在
  远程容器实测）、真实 dsh 的 events.mux/host 双 WS 断线恢复与插件 bundle、
  打包 Desktop 的 Gateway/N-ctx/token 撤销实测、真 Git 仓库的并发 session
  删除竞态与恢复测试、macOS Developer ID 公证安装及 Windows 签名安装；
  session.list→Git mutation 的 TOCTOU 以 realpath fail-closed + 两次 live
  check + non-force 缩小（上游根治待原子 session lease）。**范围偏差
  （2026-08 用户决策）**：`--no-auth` 显式开关允许无认证外部绑定覆盖 S1
  硬门（默认 fail closed，仅显式传参放行并打印醒目安全告警，仅限可信网络）；
  **已记录风险**：N-ctx 单文档模型使'连接一个远端服务器'的信任边界扩大到
  '同一渲染文档内所有实例'（恶意远端实例前端可同源读取/操作其他实例），
  `--no-auth` 误用于不可信网络同理——产品形态决策，待中期缓解（per-ctx
  会话令牌/实例隔离）。契约见 `docs/design/17-server-side-gateway.md`。
- **dsh 运行时版本管理（设计 18，M0/M2/M4 done）**：M1/M3 partial——打包态
  实机验收待真实 `.app`（安装/切换/回滚/快照清理的 packaged 路径）；macOS
  /Linux 可管理，Windows 只读。契约见 `docs/design/18-dsh-runtime-version.md`。

## 设计未决（02 §5 / 04 §7）

- **起始端口偏移**：本地默认起始端口（17510）与控制面端口（17500）相邻；
  是否可配 / 每实例偏移未定——当前以"固定起始端口 + P+1 重试 + 记录仲裁"
  落地（02 §5.2）。
- **trusted-host 自定义 Host**：`--trusted-host 127.0.0.1:<port>` 对应反代
  转发 Host 头（保持实例自身 host:port，不改写）；若引入自定义 Host 场景需
  同步扩展 trusted-host 集（05 §7.5 固定形态）。
- **多控制面 `$DSH_HOME` 冲突**：宿主 `DSH_HOME` 固定 `<stateDir>/dsh-home`，
  多控制面共享 stateDir 才共享 home——会话 JSONL 追加式多写安全，settings
  last-writer-wins 由 dsh `settings-conflict` 仲裁；不同 stateDir 互不相干
  （02 §5.6）。
- **响应头白名单双处同步**：上游引入新必需响应头需同步 03 §3.4 与 04 §4.3
  （一处契约两处表述）——建议单源化（04 §7.1）。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状随 dsh `parseBootManifest`
  契约（vendor 源码为准）维护；构建链变更见 05 §6（04 §7.2）。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话 cookie/
  client token/限流/审计 SQLite）、控制面薄壳聊天/会话列表/审批弹窗、控制面
  会话运行时/统一索引/交互管线、连接注入适配器/broker/绑定、walkthrough、
  通知中心、cron、文件夹/笔记、web 预览、MCP、目标/终端等宿主 UI 职责面
  （处置映射见 01 §4；git/GitHub 例外：插件化，见 01 §4 / 设计 08）。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话
  实时推送同步、远程实例管理 UI 外壳。
- **推迟**：flat 单列表模式（与「仅按来源分类」呈现原则张力）。
- **设置壳偏差（持续成立）**：未连接实例不装配子 ctx（配置在目标机器上，
  物理不可达）；stub remote 无 WS 失效流；设置壳不渲染官方 SettingsRoot；
  子 ctx 懒装配；服务器选择器使用 body portal + viewport 翻转/钳位（含窄
  视口缩放）+ 名称/实例 ID 搜索，超长 roster 内部纵向滚动；在线/离线状态
  同时使用文字与色点，搜索输入位于 listbox 外；离线远端仍可选并显示明确
  不可达占位与「前往连接管理」动作；chrome 跟随宿主 locale、子 ctx 跟随
  目标实例 locale。
- **默认排序 manual（06 §3.1）**：每来源会话排序默认 `manual`（保持 wire
  序），与官方默认 `updated` 不同——有意取舍；`orderBy[sourceId]` 持久化于
  `dsh-chamber.sidebar.v1`。
- **窗口标题冻结（桌面壳故意偏差）**：桌面壳冻结原生标题栏为 `dsh-chamber`
  （单 frame 品牌恒定），会话名仍在应用内呈现。
- **Electron 二进制惰性安装（2026-08 用户决策）**：根 postinstall
  `ensure-electron.mjs` 默认 SKIP，仅 `DSH_CHAMBER_ELECTRON=1`（或
  `electron-dev` 首启自动补装）时经 electron_mirror 下载；server 部署
  （gateway/control-plane/CLI）不携带桌面二进制；electron-builder 打包走
  自身缓存。
- **dev 实例隔离（dev 契约）**：`electron-dev.mjs` 以独立 `--user-data-dir`
  （`packages/desktop/.dev-user-data`）+ dev 控制面端口 17520
  （`DSH_CHAMBER_CP_PORT` 覆盖）启动，并清除继承的 `ELECTRON_RUN_AS_NODE`——
  dev 与运行中的打包版实例（同一应用名 → 同 userData/单实例锁、占 17500）
  可共存；打包版默认端口/数据路径不变。
