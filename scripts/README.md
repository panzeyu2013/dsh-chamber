# scripts/ 目录约定与分类

脚本按**使用者与运行时机**分一级目录，大类内再按**角色**分二级目录（整理）。新增脚本时先选类、
再选二级目录，最后在根 `package.json`（或 CI / release workflow）接线，并同步更新引用方。

## 一级目录（按运行时机）

| 目录 | 面向 | 内容 | 入口 / 登记 |
|---|---|---|---|
| `scripts/`（根） | 用户 / 运维 | `install-gateway.sh`——Gateway 一键安装器（`install` / `update` / `restart` / `status` / `logs` / `uninstall`，交互向导 + 非交互模式）。以「从 GitHub 拉取即可运行、零仓库依赖」为原则（只依赖 bash/curl/node）。 | 部署文档 `docs/deploy/deploy-gateway.md` |
| `dev/` | 开发者 | 安装链引导（`bootstrap/`：ensure-harness-vendor = preinstall、ensure-artifacts、ensure-electron **ARCHIVED**）；客户端 typecheck 垫片（`typecheck/`，共享引擎 + 4 个入口）；测试 loader/register 桩（`test-loaders/`）；共享测试夹具（`test-support/`）；真机 SVG 探针 `svg-resource-probe.mjs`。 | 面向仓库开发的本地工具链，不在用户部署环境执行 |
| `gates/` | 每次 push 的门（本地 = CI 同源） | 机器源与基础设施（`registry/`：门清单 `gate-surfaces.json` + 校验/派生 `gate-registry.mjs` + workflow 生成块 `gate-workflow-views.mjs` + CI 变更判类 + god-file 预算表）；单一入口（`runners/`：`run-checks.mjs` 见下、`run-script-tests.mjs`、`run-swift-tests.mjs`）；单门实现（`checks/`：`verify-*.mjs`、装配冒烟、远程状态验收/注入矩阵、`assert-scoper-artifact.mjs`、ARCHIVED 的 `verify-electron-artifacts.mjs`）。 | `pnpm run check:static` / `check:tests`；新增门须同时进 `gate-surfaces.json`（机器源：id/title/命令/模式/表面/理由）与根 `package.json`；`run-checks.mjs` 只从 registry 派生模式，不再自带门名单 |
| `release/` | 发布链 | `preflight/`（发布预检 `release-preflight.mjs` + `release-semver.mjs`、产物清单/校验 `release-artifacts.mjs`、发布 CI 证明、pin 对齐、release workflow 策略与打包清单锁步测试）；`notices/`（第三方声明生成与随包载荷声明）；`feed/`（本版本 appcast 门禁 `verify-native-appcast.mjs`、滚动 beta feed 合并 `merge-native-feed.mjs`）。 | `pnpm run release:preflight` / `test:release-workflow`；流程见 `docs/checklists/release/release-checklist.md` |
| `upstream/` | 上游 pin 与触点 | `registry/`（**触点单一来源** `registry.json` + 序列化/生成视图/保鲜门 + 判据 id 表 + seat 审计）；`pin/`（pin 升级 `update-vendor.mjs`、升级前预检、机械面单批管线 `pin-upgrade-pipeline.mjs`（由 tag 推导六锚/3 fork 字面量并打印 diff，再跑生成视图与触点门收尾）、锁文件 vendor 记录恢复及其锁步测试）；`verify/`（C1–C16 上游触点门、能力面门、插件受保护集合门、产物门）；`anchors/`（符号锚探针与遗留行号锚预算棘轮）。 | **单一来源 `scripts/upstream/registry/registry.json`**（机械事实；生成视图与判据散文见 `docs/checklists/upgrade/upstream-touchpoints.md`）；升级流程 `docs/checklists/upgrade/dsh-upgrade-checklist.md` |
| `perf/` | 性能实测 | `boot/switch/eval-measure.mjs`、`measure-ui.mjs`、`disk-walk-baseline.mjs` + `data/`（结果入库）；CDP 采集腿（`boot-measure.mjs` / `cdp-lib.mjs` / `switch-frame-probe.mjs` / `switch-measure.mjs`）随 Electron 冻结为 **ARCHIVED**，仍被归档回归锁与 `remote-state-acceptance` 的 self-test 以 CLI 相对路径调用。 | 方法与环境纪律见同目录 `README.md`（只做同环境 A/B） |
| `acceptance/` | 需要特权/环境的验收 | `netem-link-health.mjs`——真实 tc netem + veth/netns + 真 transport manager/真代理的弱网链路验收（root + CAP_NET_ADMIN；`NETEM_BULK_UPLOAD=1` 追加 20MB@2Mbit 上传）。不入 CI，退出码 0/1，跑完自清理 veth/namespace。 | `pnpm run acceptance:netem`；判据见 design 27 §7 |
| `gui-acceptance/` | GUI 验收 | 单一入口与驱动（`drivers/`：`run.mjs` 入口、native 原生壳装配驱动、ARCHIVED 的 Electron CDP 驱动/走查）；纯判据层（`checks/`：`checks.mjs` / `mobile-checks.mjs` / probe 及其单测）；in-process fixture（`fixtures/`）。 | `pnpm run acceptance:gui`；流程见 `docs/checklists/acceptance/gui-acceptance-checklist.md`；v2 内嵌腿见同目录 `README.md` |
| `refactor/` | 一次性重构脚手架 | 差分等价回放门 `equivalence.mjs` 与 B7 指标快照工具 `stream-state-metrics.mjs` + `stream-state-baseline.json`。 | 临时面：B1/B7 收口后整批删除，见 `docs/progress/TODO.md` §1.8；收口前 `refactor.equivalence` 仍在门清单 |
| `lib/` | 跨类共享工具箱 | 仓库遍历 `walk.mjs`、包测试清单 runner `test-manifest.mjs`、CLI 尾部 `cli.mjs`、esbuild/seed 构建、sidecar 装配/启动、双语结构签名、PNG ink 解码等单一实现。 | 无独立入口；被 `dev/`、`gates/`、`perf/`、`gui-acceptance/` 与 macos 构建脚本 import；其单测随共享 runner 归入 `gates` 组运行 |

## 二级目录（按角色，大类超过约 20 个文件时拆分）

| 二级名 | 含义 |
|---|---|
| `registry/` | 机器源数据 + 其加载/校验/生成视图/派生基础设施（含 CI 变更判类；数据与判定分离，可被单测）。 |
| `runners/` | 该类唯一的门/测试 **runner**：解析参数、调度、打印 transcript；不内嵌判定逻辑。 |
| `checks/` | 单个门/冒烟的实现（`verify-*`、`*-smoke`、验收执行器）+ 同名单测。 |
| `bootstrap/` | 仓库/产物的引导与自举（install 链、产物 ensure）。 |
| `typecheck/` | 包/根程序的 typecheck 入口，共享引擎放这里。 |
| `test-loaders/` | 测试专用 ESM loader/register 桩（`--import` 消费）。 |
| `test-support/` | 共享测试夹具与纯辅助模块。 |
| `preflight/` | 发布前机械门禁、版本与产物校验、发布策略锁步测试。 |
| `notices/` | 第三方 / 随包载荷声明生成。 |
| `feed/` | 更新 feed 与 appcast 门禁。 |
| `pin/` | 上游 pin 生命周期：升级、预检、机械面单批管线（六锚/3 fork diff + 生成视图/触点门收尾）、锁文件修复。 |
| `verify/` | 上游触点/能力/受保护集合等校验门（`capabilities.json` 是能力面数据，与消费者同目录）。 |
| `anchors/` | 符号锚与锚预算。 |
| `drivers/` | 验收驱动层（启动、连接、走查、CDP——无纯判定逻辑）。 |
| `fixtures/` | 验收用 in-process 替身与 fixture 服务。 |
| `data/` | 入库的基线/快照数据（只读输入）。 |

## 分类规则

1. **一级按运行时机选目录**：开发期工具 → `dev/`；每次 push 的仓库门 → `gates/`；发布链 → `release/`；上游 pin 与触点 → `upstream/`；实测/验收工具箱 → `perf/`、`gui-acceptance/`、`acceptance/`（需要 root/系统工具的验收）；跨类共享实现 → `lib/`；面向用户的部署脚本留在根。
2. **二级按角色选目录**：机器源/数据 → `registry/`（或 `data/`）；单一入口 → `runners/`（或 `dev/*` 的入口目录）；单门实现与单测 → `checks/`；驱动层 → `drivers/`；夹具 → `fixtures/`。目录名取自上表；不要造同义新名。
3. **门禁脚本三纪律**：判定纯函数化（可与执行层分开单测）、失败响亮（绝不静默通过）、退出码固定（`0` 通过 / `1` 红 / `2` 用法错误）。
4. **测试命名与归类**：单测与实现同目录，文件名 = 被测模块名（同名 `<stem>.mjs` 必须存在）；对仓库文件做锁步、
   无可命名单模块的测试进 `scripts/gates/runners/run-script-tests.mjs` 的 `SUBJECT_TESTS`（附理由）——该清单是
   `scripts/` 测试的唯一权威并双向校验（磁盘上有未列出的 `*.test.mjs`、或列出的文件不存在，都直接红），
   测试按一级目录归入 `gates` / `upstream` / `release` / `gui-acceptance` 四组（`lib/` 与 `dev/` 的共享实现单测随 `gates` 组运行——共享 runner 的回归锁）。运行：`pnpm run test:scripts`
   （全组）或 `pnpm run test:scripts:<组>`；每个文件仍须被根脚本可达（`pnpm run verify:test-wiring`）。
   执行走与包清单同一个有界池（`runEntries`）：清单顺序 transcript、首败即停、零测试守卫同语义；
   全部测试都进入 `node:test`（共享零测试守卫）；如需自定义 harness 按退出码判定，必须在 `RAW_STATUS_TESTS` 显式登记（当前为空，无默认可选）。
   根 `package.json` 保留 `test:upgrade-tools`（= upstream 组）/ `test:release-workflow`（= release 组）/
   `test:gui-acceptance`（= gui-acceptance 组）三个兼容别名，供 CI、release 链与既有文档引用。
5. **引用一律写仓库根相对路径**（`scripts/<类>/<二级>/<文件>`）；移动脚本时同步更新引用方——根 `package.json`、`.github/workflows/*.yml`、`docs/**`、其他脚本的相对 `import`、以及 `harness.commit` 这类文件头注释。
6. **依赖纪律**：这些脚本不新增运行时依赖（node 内置 + 仓库已有依赖）；测量/验收入口遵循各自目录 README 的只读与脱敏纪律。
7. **冻结面**：Electron 冻结后的 ARCHIVED 脚本（`dev/bootstrap/ensure-electron.mjs`、`gates/checks/verify-electron-artifacts.mjs`、`gui-acceptance/drivers/{walkthrough,launch,cdp,packaged-ssh-smoke,mobile-walkthrough}.mjs`、`gui-acceptance/fixtures/ssh-fixture.mjs`、`perf/` 的 CDP 采集腿等）保留在二级目录内（不删除）、文件头标注 ARCHIVED；**CLI / 执行面不再被默认门禁与 CI 调用**，但其纯函数/源码文本/单测仍可能被默认测试组引用（回归锁，不是执行面）——这是刻意的只读依赖，见 `docs/progress/electron-frozen.md`；复活按其文件头与 §6 复活清单执行。
