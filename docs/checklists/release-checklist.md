# 发布前 Checklist

> 按序执行，任何 ❌ 都阻断发布。依据 `.github/workflows/release.yml` 与 `docs/DEVELOPMENT.md` §5。命令前先
> `nvm use`（或等价方式）让 `node --version` 的主版本与 `.nvmrc` 一致——本清单只写流程，不写版本字面值。
> 只写可复用流程：某次发布的叙述写 `CHANGELOG.md` 发布节，仍open的门禁写 `STATUS.md`。
>
> **范围（2026-11 用户裁决）**：唯一出货 flavor = macOS Swift 原生壳。Electron flavor 已冻结归档
> （`docs/progress/electron-frozen.md`），Windows/Linux 桌面腿不发布。下方标 **ARCHIVED** 的条目
> 只在按复活清单重开 Electron 范围后才适用；默认发布**不执行**这些条目。

```
本地: preflight → changelog/i18n → check:full（精确发布提交）→ 构建自检 → 工作区健康 → commit+tag
CI:   dry_run 先行 → 正式 tag push → 监控 → 发布后核对
```

## 0. 版本与内容确认

- [ ] 版本号只允许 `X.Y.Z` 或 `X.Y.Z-beta.N`；`alpha`/`rc` 与其他prerelease fail closed；changelog无待收尾条目。
- [ ] 发布内容已全部合入发布分支，本地无未提交改动。
- [ ] 工作树换代是**已执行的一次性历史迁移**（旧池清空前提、filters/LFS 降级、opt-in 开关/重启、Swift 保留与 node 分 flavor，见 `CHANGELOG.md` 对应发布节与 design 08 §7.4）；从更早版本直接升级的用户按该节操作，本清单不再把它作为每次发布的阻断项。
- [ ] 自上次发布以来改过workflow / 脚本路径 / action SHA → 先 `workflow_dispatch` dry_run全链（§7），不上正式tag。

## 1. 版本断言（release.yml 硬校验，preflight 同源扫描）

- [ ] 根 `package.json` 与全部 `@dsh-chamber/*` 包version = 目标版本（新增包自动纳入）。
- [ ] 三个fork副本（`dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）= 上游基线版本，不随发布版本。
- [ ] dsh运行时版本常量三源一致：`scripts/install-gateway.sh` 的 `DSH_CHAMBER_DSH_VERSION`、`release.yml` 的 `env.DSH_CHAMBER_DSH_VERSION`、`packages/gateway/package.json` 的 `dshAnchorVersion`。

## 2. 机械门禁：release:preflight

- [ ] `node scripts/release/release-preflight.mjs <版本>` 全绿：版本统一性（含fork副本与三源dsh常量）、changelog中英对等、`verify:i18n`、全部workflow action SHA可解析（`--offline` 跳过网络）、冲突标记、git干净、frozen install、`test:release-workflow`。CI的test job已内置 `--actions-only`。
- [ ] push前再跑一遍 `release:preflight`（§7）。

## 3. changelog 与 i18n

- [ ] `CHANGELOG.md` 与 `docs/CHANGELOG.en-US.md` 均有 `## [<version>]` 节且条目对等（release.yml提取为发布正文，缺失即失败）。
- [ ] 版本节结构完整，无重复版本标题。
- [ ] `pnpm run verify:i18n` 全 `consistent`（改动任一语对后须 `-- --write` 刷新记录）。
- [ ] 发布说明与 CHANGELOG 一致；历史迁移前提引用对应版本节，不重写旧叙述，也不宣称移除仍在的形态（如 Swift/sidecar）。

## 4. 测试与构建（在精确发布提交上执行）

- [ ] 架构门 `verify:import-cycles` / `verify:file-budgets` / `verify:package-boundaries` 在普通 CI、发布验证及本地全量套件中执行；文档门 `verify:i18n` 在 ci.yml `test` 与 release.yml `validation` 的 pre-install 生成块内执行（file-only）；其余质量辅助门 `verify:md-links` / `verify:test-wiring` / `verify:no-dead-exports` / `verify:styles` 仍按 local-only 决策由本地全量套件覆盖。所有门必须在下一条的本地绿色记录里出现，发布提交上不许漏跑。
- [ ] 全量套件：`pnpm run check:full`（= `node scripts/gates/run-checks.mjs full`：static + typecheck + 全部包测试）；darwin 上 `tests` 模式按 `scripts/gates/gate-surfaces.json` 的 `macos.*` 门（platform=darwin）追加 Swift/打包腿类，CI 侧对应 ci.yml 手写的 `test-macos`（Swift 构建/测试）与 `test-macos-pack`（`test:macos`、compiled sidecar / native GUI 装配 / Electron 产物门）两个 job——它们不在生成块内，登记见 `docs/progress/STATUS.md` §1.6，且都被发布 proof 按 job 名钉住。冒烟是独立入口。上一提交的记录不算数；失败必须定位，不能用重跑代替结论。
- [ ] full之外的发布项（**现行**）：`build:dsh-runtime`、`typecheck:host-graph` / `typecheck:host-git` / `typecheck:host-archive-cleanup` / `typecheck:host-open-in`。
- [ ] **ARCHIVED（Windows 腿已删）** `test:win32`：Windows 桌面腿冻结后不再有 CI 入口，默认发布不执行。
- [ ] 旧版本号残留扫描：`grep -rn "<上一发布版本>" packages/*/test* packages/*/scripts/*.test.mjs` 为空（硬编码旧shellVersion会误触发壳升级路径）。
- [ ] `pnpm install --frozen-lockfile` 通过；`build:renderer`、`build:host-packages`、`build:desktop` 通过。
- [ ] 产物建成后（`build:renderer` / `build:host-packages` / `build:desktop`）跑一次 `node scripts/gates/verify-artifact-freshness.mjs --require-compare`：严格档把「一类都没比过」判红，防止 clean checkout 的 SKIP 冒充通过（该门不在 `check:full`/`tests` 内，仅本清单在构建后手动跑）。
- [ ] **ARCHIVED（Electron 冻结）** Electron 打包完整性自检（`packaging-closure-checklist.md` §1–§2 的 Electron 部分）：`electron/main.ts` 传递 import 闭包 ⊆ `build.files`；Electron 产物齐全（`dist/preload.cjs` 等）。
- [ ] **现行（Swift 侧）** Swift 载荷/装配自检（`packaging-closure-checklist.md` §3.2 的 Swift 部分、`build:sidecar` / `build:swift-app --dry-run`）：见下方“Swift 本地载荷与 Office 资产装配”条。
- [ ] **ARCHIVED（Linux 冻结）** Linux腿（CI）：build-linux产AppImage(x64)（随 Electron 冻结，不再发布）。
- [ ] **打包载荷与双形态**：forge bundle + 六个依赖包（七个 package.json；`worktree` / `tool-worktree` / `forge` / `forge-github` / `forge-session` / `client-ui-forge`）在 Electron 的 `resources/vendor/dsh/node_modules/@deepseek-ai/` 与 Swift sidecar 的 `vendor/dsh/node_modules/@deepseek-ai/` 内均有 `package.json`；实例前端 Plugins → More 可见 opt-in 开关，启用后 `forge-github` 行 disabled；Electron **打包态 + Finder 启动**下四项 UI、同池三条、node 实际创建成功；Swift 壳内同样四项 UI、同池三条、node 实际创建通过（design 08 §7.3）。任一 ❌ = 发布阻断。
- [ ] **Swift 本地载荷与 Office 资产装配（Swift 腿专属）**：Swift 腿打包前准备全量 primary-runtime（python+node+pnpm；`prepare-python-payload` 带 `--with-node --with-pnpm`）与 office-skills（`prepare-office-assets`），并以 `build:sidecar --arch arm64 --require-python --require-node --require-pnpm --require-office-assets` 装配——缺件 fail-closed（`--require-*` 缺省只 warn，发布腿不允许）；装配后按 release.yml 对 `<sidecar>/primary-runtime` 与 `<sidecar>/office-skills` 各跑一次对应 `--verify`。`.app` 结构断言：`<Resources>/sidecar/primary-runtime/dependencies/node/bin/node` 可执行、`runtime.json` 与 `office-skills/office/SKILL.md` 在场、`sidecar.js` 在场、装配顶层没有任何独立 Node 条目（单 Node：唯一 Node 在 payload 内）、payload Node 的 lipo 架构含 arm64；payload/资产脚本单测随 `pnpm run test:desktop`（scripts 组），装配脚本单测随 darwin 上的 `pnpm run test:macos` 覆盖。Electron 腿保持现状（python-only payload + 既有 afterPack 断言），不做 Office 相关改动；CI 排练仍以 `build:sidecar --skip-node` 装配、用调用者 node 跑 `test:sidecar:compiled`。任一 ❌ = 发布阻断。
- [ ] **Swift 单 Node 与本地 Office 实机验收**：在**没有系统 node/python** 的机器上安装 Swift 包并启动本地实例——sidecar 与托管 dsh 都运行在 app 内 payload 的 node 上（进程名即 `node`，按应用派生的子进程关系归因）、装配顶层没有独立 Node（旧布局）条目；实例内 7 个 Office 技能可见，`load_workspace_dependencies` 返回 python/node 路径，docx 创作与 render/export-pdf 可用（首次调用把只读载荷装到 `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime`，app 内文件未被修改）。缺 payload/资产时宿主正常启动、启动行不挂、能力如实缺席。发布阻断项。
- [ ] `pnpm run smoke` 通过（未封装dsh时SKIP属正常）。
- [ ] 原生壳视口越界策略实机目检（无自动化探针）：滚到端点、指针停在不可滚动chrome上滚动，整页不平移。

## 5. 工作区健康

- [ ] `git status --short` 无未跟踪文件（无UPGRADE-*.md / .DS_Store / 临时文件）；`git stash list` 空。
- [ ] 无冲突标记（用 `release-preflight --offline` 的行首扫描；裸 `grep '<<<<<<<'` 会自匹配本清单示例行）。
- [ ] 旧pin残留扫描：`grep -rn "<上一版 pin 的版本字面量>\|<上一版 commit 短哈希>" packages/ scripts/ harness.commit` 仅剩历史文档/迁移条目（与 `dsh-upgrade-checklist.md` §6同一纪律，清单本身只写占位符）。

## 6. 签名 / 公证（全部由 CI 处理，本地不配密钥）

- [ ] Sparkle更新密钥：公钥有而私钥缺 = FAIL；**私钥有而公钥缺 = FAIL**（否则发布「带签名appcast却检查不到更新」的包，且下一次发布会把它的zip当作产不出delta的基线）；私钥有而appcast缺 = FAIL；两把都缺 = loud降级（照常出包，客户端看不到更新）。EdDSA与Developer ID/公证互不替代。资产：stable = `appcast-swift.xml`（enclosure 走 `releases/latest/download/`，含 `*.delta`）；beta = 滚动tag `appcast-swift-beta` 的 `appcast-swift-beta.xml`——其中 beta 条目 enclosure 走滚动下载目录；从已发布 stable feed 合并进来的 final 条目在 **beta 腿**走**版本固定**前缀 `releases/download/v<正式版tag>/`，而 stable 发布**刷新滚动 feed**时该 final 条目改走**滚动**前缀——两条路径前缀不同，不要互相「修正」；`*.zip` 与 `*.delta` 都必须在 feed 之前上传（S-36；draft 上也一样——appcast 在归档之后才上传）。**同一 beta 号重跑**：滚动 release 上同名 zip 必须与本次构建字节一致才允许覆盖（发布腿用 `cmp` 判定），字节不同 = FAIL 并要求提升 beta 号（已发布 feed 的签名指向的字节不能变）。基线还要求旧 zip 自带 `SUPublicEDKey`（解包主 app 的 `Info.plist` 判定，无公钥的归档既不产 delta 也不写放弃标记）。`generate_appcast` 可能按体积规则（delta > 7/8 整包）主动放弃某个增量包：那是 loud warning + 该基线本次走整包，不是链路失败。
- [ ] 正式腿缺Developer ID/公证凭据 → 创建或变更draft前fail-closed；构建后签名 / stapler / spctl任一失败阻断finalize。Swift腿同纪律：staple先于归档、zip解包后复核codesign/stapler/spctl与arm64。
- [ ] dmg 公证后台等待：dmg 提交与 appcast 重叠，verify 轮询状态文件（**900s 上限**，PID 消失且无状态即 fail-fast，超时/非零即阻断）后才 staple/validate，upload 在其后；首次带此改动的正式发布确认「dmg 状态出现 → verify 等到 → staple/validate」链路实际走通。
- [ ] dry-run强制unset全部签名/公证环境与 `GH_TOKEN`，只产ad-hoc包：不建/改Release、不上传资产。Windows首版未签名（design 11 §7的让步），不把sha512称作签名。

## 7. 提交、tag 与 CI

- [ ] `git commit -m "release(v<版本>): …"`；amend已推送提交用 `--amend --no-edit` + `--force-with-lease`。
- [ ] `git tag -a v<版本> -m "…"`（重推前先删旧tag：`git tag -d v<版本> && git push origin :v<版本>`）。
- [ ] dry-run先行：push分支 → Actions手动 `release.yml`（`version=<版本>`、`dry_run=true`）→ create-release断言 + validation + 全部构建腿绿。任一步失败：修复 → 本地复验 → 再dry-run。
- [ ] 发布提交的CI证明：`validation` 硬断言该提交在 `main` 上有完整成功运行（linux `test` + `test-windows`/`test-windows-pack` + `test-macos`/`test-macos-pack`，各腿承载步全success）。本地可预检：`GITHUB_TOKEN=<token> node scripts/release/verify-release-ci-proof.mjs --sha <commit>`。
- [ ] 正式发布：`git push origin <分支> && git push origin v<版本>` → 监控create-release → validation → build-macos/windows/linux/gateway/swift → finalize-release；确认validation的 "Set up job" 通过（action SHA解析失败在此暴露）。

## 8. 发布后

- [ ] Release正文 = changelog `[<version>]` 节（自动提取）。
- [ ] CI产物齐全：Electron mac `dsh-chamber-electron-*` 与Swift `dsh-chamber-*` 的 `.dmg`/`.zip`（两族前缀互不包含，不碰撞）、win `.exe`、Gateway `.tgz` + `.tgz.sha256`；无 `.blockmap`；Gateway不经npm发布。
- [ ] 更新源按通道存在：stable仅 `latest.yml`/`latest-mac.yml`，beta仅 `beta.yml`/`beta-mac.yml`；beta Release为prerelease且不占GitHub latest。
- [ ] Swift更新面齐全（原生壳）：stable tag 有 `appcast-swift.xml` + `dsh-chamber-<ver>-macos-arm64.zip` + `*.delta`，enclosure 相对 `releases/latest/download/` 逐条可下载；滚动 tag `appcast-swift-beta` 仍为 prerelease，其 `appcast-swift-beta.xml` 的每条 enclosure（当前 beta zip、新 delta、合并进来的 final zip/delta）都能下载（S-36 的公开面人工核对——目前没有脚本自动核公开 URL）。
