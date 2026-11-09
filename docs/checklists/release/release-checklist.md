# 发布 Checklist（release）

- 阶段：release
- 触发：把 `main` 上的精确提交作为正式版本发布（stable `X.Y.Z` 或 beta `X.Y.Z-beta.N`），或改任何发布链脚本 / 工作流 / 打包面
- Owner：发布负责人（发版执行 + 证据归集）；门禁与契约判据由各 owner 文档持有
- Timebox：一次发布 ≤1 个工作日（预检 + 全量套件 + 构建 + dry-run + 正式 tag；不跨窗口混做）
- 退出标准：本清单所有 ❌ 清零；发布产物与 appcast 可复核；`release.yml` 在发布提交上通过且 draft 已转公开
- 自动化入口：`pnpm run release:preflight <版本>`、`node scripts/gates/runners/run-checks.mjs full`、`pnpm run test:macos`、`.github/workflows/release.yml`
- 证据：PR Validation 表（命令 + 结果）；发布正文 = `CHANGELOG.md` 的 `## [<版本>]` 段；构建/签名/更新链证据随发布记录留档

> 范围：现行出货形态 = **macOS Swift 原生壳** + 共享契约（design 25）；Electron / Windows / Linux 桌面腿**冻结归档**（[electron-frozen.md](../../progress/electron-frozen.md)），其打包/更新/发布条目在本清单内标 **ARCHIVED**，只在显式重开范围后执行。门禁成员与落位以 [gate-surfaces.json](../../../scripts/gates/registry/gate-surfaces.json)（机器单源）与 [.github/workflows/release.yml](../../../.github/workflows/release.yml) 为准，本清单不复制门列表；版本值单源 = `harness.commit`（源码线）、`packages/desktop/vendor/dsh/pnpm-lock.yaml`（运行时线）与各 `package.json`。
> 打包闭包（`build.files` / `extraResources` / sidecar+app 装配 / 载荷）另有 [packaging-closure-checklist.md](./packaging-closure-checklist.md)，改动打包面时必须同批执行。

## 0. 发布资格与基线（只读照面）

- [ ] 范围裁决已落文档：冻结面（Electron / Windows / Linux）本版不发布；Swift 腿 + 共享契约是唯一出货面（[AGENTS.md](../../../AGENTS.md)「当前版本范围」、[electron-frozen.md](../../progress/electron-frozen.md)）。
- [ ] 发布提交 = `main` 上已通过 CI 的精确提交（`verification` 侧的 release CI proof 由 workflow 在本提交上自动校验，本地不重复实现）；工作区干净、无未提交迁移残留（`git status` 人工核对；`release-preflight` 的 git 干净项是机械检查）。
- [ ] 本版阻断项已清零：本清单与 [packaging-closure-checklist.md](./packaging-closure-checklist.md) 的 ❌ 项逐条关闭或经裁决降级并登记（发布阻断只在本清单登记）；功能/契约开放项不随发布打包。
- [ ] 凭据齐备：macOS 发布需 Apple Developer ID 签名 + 公证凭据（`release.yml` 在**任何** Release 变更前 fail-closed 校验）；Sparkle appcast 签名私钥 / 公钥按 design 25 §7 准备。
- [ ] 发布类型确定：stable（`X.Y.Z`）或 beta（`X.Y.Z-beta.N`）；beta 是 GitHub prerelease、更新走滚动 beta 通道（design 25 §7 / [merge-native-feed.mjs](../../../scripts/release/feed/merge-native-feed.mjs)）。
- [ ] ARCHIVED（本版不执行）：Electron dmg/zip 打包与更新 feed、Windows（NSIS）与 Linux（AppImage）发布腿——对应 workflow job 恒 skipped，见 §7 与 [electron-frozen.md](../../progress/electron-frozen.md)。

## 1. 版本 bump 与 CHANGELOG（同一批）

- [ ] 根 `package.json` 与本仓拥有的全部 `@dsh-chamber/*` 包**同批** bump 到目标版本；三个 fork 副本（`dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）保留上游版本、种子包随 chamber 发版——扫描由 `release-preflight --versions-only` 数据驱动完成，不手抄包列表。
- [ ] 版本值只写单源文件，不在 design/checklists 里复写（[docs/AGENTS.md](../../AGENTS.md) §3）；installer / gateway / release workflow 的 dsh 锚常量与运行时线由 `release-preflight` 的版本统一性与 pin 对齐项机械校验。
- [ ] `CHANGELOG.md` 写入本版发布节（发布时才写，禁止 `[Unreleased]` 边实现边写）——只记**相邻正式版本之间的差异**；正式版前的 beta 系列聚合成一个发布级 delta，beta 节仍需存在（`release.yml` 用 `## [<版本>]` 段作为 Release body）。
- [ ] 双语镜像同批更新：`docs/CHANGELOG.en-US.md` 与主档结构一致；改过双语对后由协调者统一 `node scripts/gates/checks/verify-i18n.mjs --write` 重录 [i18n-record.json](../../i18n-record.json)，并跑 `verify-i18n` 确认一致。
- [ ] 生成物同步：`pnpm run gen:notices` 后 `THIRD_PARTY_NOTICES.md` / `docs/THIRD_PARTY_NOTICES.en-US.md` 无未提交 diff（或改动已包含在发布提交内）。

## 1.5 机械预检（承接 §1/§2/§4/§5 的机械项）

- [ ] `pnpm run release:preflight <版本>`（完整跑；逃生舱 `--offline` / `--skip-install` 只用于网络受限场景，且必须打印 SKIP 提示）。它机械承接：版本统一性、运行时/源码双线 pin、CHANGELOG 段存在、双语与 i18n 记录、actions SHA 解析（网络）、冲突标记、`FIXME` 门（发布阻断；`--allow-fixme` 是需记录的裁决）、git 干净、frozen install、release workflow 策略（`test:release-workflow`）。
- [ ] 版本 bump 后、commit 前跑一次；push/tag 前再跑一次（同 §7）。
- [ ] CI 侧动作：`.github/workflows/release.yml` 的 `validation-metadata` job 会跑 `release-preflight --actions-only`（网络 SHA 解析）；`create-release` 在触碰任何 Release 前校验 macOS 凭据并重跑 `--versions-only`。

## 2. 依赖、锁文件与生成物面

- [ ] frozen 安装通过：`pnpm install --frozen-lockfile`；workflow 侧 `git diff --exit-code -- pnpm-lock.yaml`（Assert lockfile not rewritten）必须为空。
- [ ] 运行时 pin 对齐（只读）：`node scripts/release/preflight/verify-pin-alignment.mjs` 全绿；升级过 pin 的版本同批执行 [pin-alignment-checklist.md](../upgrade/pin-alignment-checklist.md)。
- [ ] vendor 树由 `node scripts/dev/bootstrap/ensure-harness-vendor.mjs` 建链，且与 `harness.commit` 一致；构建期产物（C8）由 `node scripts/dev/bootstrap/ensure-artifacts.mjs --check` / 全新重建核对。
- [ ] 上游触点面（改了 pin 或触点时）：`node scripts/upstream/registry/verify-registry.mjs`、`node scripts/upstream/anchors/check-anchors.mjs`、`node scripts/upstream/verify/verify-upstream-touchpoints.mjs`、`node scripts/upstream/verify/verify-capabilities.mjs` 全绿（升级流程见 [dsh-upgrade-checklist.md](../upgrade/dsh-upgrade-checklist.md)）。
- [ ] ARCHIVED（本版不执行）：Electron 侧 `build.files` / `extraResources` / dmg/zip feed 的旧清单与 revive 基线保留在 [electron-frozen.md](../../progress/electron-frozen.md) §5，不随发布执行。

## 3. 精确发布提交上的全量套件（§3 = 完整单测，不在 preflight 里跑）

- [ ] 在**精确 release 提交**上跑全量门：`node scripts/gates/runners/run-checks.mjs full`（static + typecheck + tests；linux 跑不含 darwin-only 的门，darwin-only 门在 macOS 腿补齐）。
- [ ] `pnpm run test:scripts`（scripts 四组单测单入口）与 `pnpm run verify:test-wiring`。
- [ ] CI 已达到：`ci.yml` 在发布提交上的 `test`（linux）+ `test-macos` + `test-macos-pack` 全绿——`release.yml` 的 `validation` job 用 `node scripts/release/preflight/verify-release-ci-proof.mjs` 机械证明该提交在 `main` 上通过 CI，本项以 workflow 结果为准、不手工复跑 linux 腿。
- [ ] macOS-only 腿：`pnpm run test:macos`（darwin 锁断言 + 打包脚本套件）与 `pnpm run test:swift`（Swift 套件）。
- [ ] 产物新鲜度（发布侧）：`node scripts/gates/checks/verify-artifact-freshness.mjs --require-compare`（在构建后执行；`release.yml` 的构建/校验步内也会调用对应检查）。
- [ ] 未跑项必须显式登记（env / 平台 / 网络）到 PR 证据；不得以「本地绿」代替 CI 腿。

## 4. 构建、打包与打包态验收

- [ ] 构建链按序：`pnpm run build:dsh-runtime` → `pnpm run build:host-packages` → `pnpm run build:sidecar` → `pnpm run build:swift-app`；renderer 产物按需 `pnpm run build:renderer`（打包态 `dist/web` 由 sidecar 静态伺服）。命令与旗标以 [docs/DEVELOPMENT.md](../../DEVELOPMENT.md) §4 与 [packaging-closure-checklist.md](./packaging-closure-checklist.md) 为准。
- [ ] 打包闭包全绿：执行 [packaging-closure-checklist.md](./packaging-closure-checklist.md)（载荷、单 Node、`info.plist`/本地化、签名前置、闭包复核命令）。
- [ ] 产物名义校验：`node scripts/release/preflight/release-artifacts.mjs <版本> --check-dir macos/release`（native 产物命名/清单；Electron 名族为 ARCHIVED 复活基线）。
- [ ] 编译 sidecar 冒烟：`pnpm run test:sidecar:compiled`（`compiled-sidecar-smoke.mjs`，需已构建 sidecar）。
- [ ] 原生装配门：`node scripts/gui-acceptance/drivers/run.mjs --flavor native --require-assembly --web-dist packages/desktop/dist/web`；真机/打包态 GUI 走查按 [gui-acceptance-checklist.md](../acceptance/gui-acceptance-checklist.md) §4.2 执行并留证据。
- [ ] 打包态真机验收（发布阻断项，本清单登记）：无系统 node/python 的机器上 Office 能力（`load_workspace_dependencies` + docx 编辑/渲染/PDF 导出）与 primary-runtime 首装；不得以 dev 状态代替打包态。
- [ ] 更新链（ARCHIVED 部分不执行）：Sparkle stable/beta 通道、appcast 双 feed、beta 滚动 feed 的形状与签名按 [design 25](../../design/desktop/25-macos-swift-native-shell.md) §7 与 §6 验证；Electron electron-updater feed 为 ARCHIVED（[electron-frozen.md](../../progress/electron-frozen.md)）。

## 5. 签名、公证与 appcast（正式发布 fail-closed）

- [ ] `.app` 用 Developer ID 签名并公证、staple；`codesign --verify --deep --strict <App>.app` 通过；`spctl --assess` 通过；bundle 内无逃逸 symlink（见 packaging 闭包清单）。
- [ ] 嵌套可执行签名权限正确：sidecar payload Node 用 `entitlements.node.plist`；LibreOffice kit 的 native helper 只用 `allow-jit` 的 `entitlements.jit.plist`（[build-swift-app.mjs](../../../macos/scripts/build-swift-app.mjs) 头注）。
- [ ] DMG 与 zip 是发布产物；appcast 逐条 Ed25519 验签：`node scripts/release/feed/verify-native-appcast.mjs`（`--single-item` / `--expect-final-item` / `--expect-delta-from` / `--signatures-dir` + `--public-key` 形态，按本版发布形态选旗标）。
- [ ] 凭据缺失即阻断：`release.yml` `create-release` 在正式发布（非 dry-run）要求全部 Apple 凭据，缺项直接红。

## 6. 发布态验证（发布后按实际产物复核）

- [ ] 先 `workflow_dispatch` **dry-run** 跑通 `release.yml`：dry-run 不创建/修改 Release、不上传资产、清空签名/公证环境与 `GH_TOKEN`（`--publish=never`）；重点验证本版新增/修改的 workflow、脚本路径与 action SHA 已在真实 CI 上生效。
- [ ] 正式 tag push 后：`create-release`（draft）→ 各构建腿上传 → `finalize-release` 转公开；beta 版本 `prerelease=true, make_latest=false`，stable 反之。
- [ ] 产物清单可审计：`node scripts/release/preflight/release-artifacts.mjs <版本> --check-dir <发布腿输出目录>` 与 draft 资产逐条对照；appcast 引用的每个 zip 可下载（enclosure 可解析）。
- [ ] 更新链实机：stable 客户端收 stable final；beta 客户端收 beta.N+1 与 final（滚动 feed 行为见 `merge-native-feed.mjs` 与 design 25 §7）。
- [ ] 下载/安装/启动/深链/通知/退出等安装态行为按 [gui-acceptance-checklist.md](../acceptance/gui-acceptance-checklist.md) §4.2 复验（安装态而非 dev）。

## 7. 提交、tag 与推送（顺序固定）

- [ ] 提交发布内容（版本 bump + CHANGELOG + 生成物）；**再跑一次** `pnpm run release:preflight <版本>`（§1.5）确认提交后工作区仍干净。
- [ ] 在精确提交上打 annotated tag `v<版本>`；tag 与提交一一绑定（`release.yml` 的 `create-release` 会 peel tag 并拒绝不一致的 checkout）。
- [ ] 顺序：先 dry-run（§6）→ 再正式 push tag（或 `workflow_dispatch`）；`release.yml` 的 `validation` 用 `verify-release-ci-proof` 证明该提交在 `main` 上跑过成功 CI，未证明即红。
- [ ] 发布提交必须已在 `main` 上（不在分支/临时 HEAD 上打 tag）；tag 后不改工作流、不改脚本路径（会破坏 action SHA 与 workflow pin 证据）。

## 8. 收口、回滚与记录

- [ ] draft → public 后核对 Release 资产与 `CHANGELOG.md` 段落一致、正文非空（`release.yml` 缺段即红）。
- [ ] 失败处置：任何红都 fail-closed（不发半成品）；已转公开的 Release 不可变，修正需新版本；stale draft 只能整体重建（`release.yml` 的「Refuse published release and replace stale drafts」语义）。
- [ ] 回滚 = 发布一个修复版本（tag 不可移动）；紧急下架只改 Release 状态/资产，不删 tag，并在 `CHANGELOG.md` 发布节记录。
- [ ] 记录纪律：发布叙述只进 `CHANGELOG.md` 发布节；仍 open 的发布阻断项留在本清单（❌），已落地判据归 design；本清单只留流程，不写版本值、不写门禁计数。
