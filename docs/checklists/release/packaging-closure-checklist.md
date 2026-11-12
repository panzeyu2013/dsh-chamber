# 打包闭包 Checklist（release）

- 阶段：release（主流程见 [release-checklist.md](./release-checklist.md) §4；本清单是它的打包面展开）
- 触发：改任何打包/装配面——packaged modules、构建脚本（`build:sidecar` / `build:swift-app` / `bundle:dsh` / host 包构建）、`build.files` / `extraResources`、seed 宿主包、macos 装配或 `Info.plist` 模板、运行时/载荷 pin、primary-runtime / office-skills 资源
- Owner：打包链负责人（构建 + 闭包证据）；签名/公证凭据由发布负责人提供
- Timebox：一次发布 1–2 小时（构建 + 闭包复核；不含真机安装验收）
- 退出标准：装配链可复现、载荷完整且 fail-closed、闭包复核命令全绿、签名/本地化/资源落位与 design 25 §3.2 一致
- 自动化入口：`pnpm run build:sidecar` / `pnpm run build:swift-app` / `pnpm run test:macos` / `node scripts/release/preflight/packaging-manifest-lockstep.test.mjs` / `node scripts/gates/checks/compiled-sidecar-smoke.mjs`
- 证据：本地构建 transcript + 闭包命令输出；发布 PR / Release 记录附产物清单；载荷/签名证据留档

> 判据权威：装配布局与载荷契约在 [design 25](../../design/desktop/25-macos-swift-native-shell.md) §3.2/§8.4（Swift 壳）与 [design 18](../../design/runtime/18-dsh-runtime-version.md)（runtime/prune/pnpm）；包清单与过滤器同源由 [packaging-manifest-lockstep.test.mjs](../../../scripts/release/preflight/packaging-manifest-lockstep.test.mjs) 锁步；本清单只固定流程与复核命令，不复制载荷清单/数字。
> 范围：现行 = **macOS Swift 原生壳**（`build:sidecar` → `build:swift-app`）；Electron 打包 / `extraResources` 的 Electron 产物面 **ARCHIVED**（[electron-frozen.md](../../progress/electron-frozen.md)），只在显式重开范围后执行（§6）。

## 1. 触发面与单源

- [ ] 本清单触发面：packaged modules、构建脚本、`build.files` / `extraResources`、seed 宿主包、macos 装配链、`primary-runtime-lock.json` / pin、payload 资源（primary-runtime / office-skills）。任一改动 = 必须重跑本清单，并在 PR 说明替代了哪条闭包约束。
- [ ] 包清单/过滤器单源：`HOST_PACKAGES`、`PNPM_BIN_FILES`、`VENDOR_DSH_FILES`（[build-sidecar.mjs](../../../packages/desktop/scripts/build-sidecar.mjs)）与 control-plane 缺省源常量、root `build:host-packages` 链、`HOST_PACKAGE_BUILD_ROWS`、`AppDelegate.swift` 的宿主行**五处同源**；锁步门 `node scripts/release/preflight/packaging-manifest-lockstep.test.mjs` 必须绿。
- [ ] 版本/摘要单源：Node/CPython/wheel 坐标与 sha256 以 `packages/desktop/primary-runtime-lock.json` 为准；pnpm 版本声明单源是根 `package.json#packageManager`，镜像由 `node scripts/gates/checks/verify-workflow-action-pins.mjs`（pnpm-pin 腿）锁步。

## 2. 装配链（顺序固定）

- [ ] 构建 runtime 中间产物：`pnpm run build:dsh-runtime`；构建 host 包：`pnpm run build:host-packages`（顺序与包名是单源，见 §1）。
- [ ] 构建前端产物（sidecar 静态伺服需要时）：`pnpm run build:renderer`（产物落 `packages/desktop/dist/web`，`*.map` 与 `.vite/` 被过滤）。
- [ ] 组装 sidecar：`pnpm run build:sidecar`（`packages/desktop/scripts/build-sidecar.mjs`：tsc 编译闭包校验 → esbuild `sidecar.js` → 拷贝 control-plane 产物 → payload/office 资产拷贝/门控）。刻意缺省开关（`--skip-node` / `--skip-pnpm` / `--skip-python` / `--skip-office-assets` / `--skip-host-packages` / `--skip-vendor`）只表达「本次不要求该项」，且必须产生缺位、不继承旧产物；CI 的 push 腿装配形态 = `pnpm run build:sidecar --skip-node --skip-vendor --skip-host-packages`。
- [ ] 组装 Swift `.app`：`pnpm run build:swift-app`（`macos/scripts/build-swift-app.mjs`：swift build → 拷贝 sidecar + `dist/web` → 架构一致性断言（lipo）→ `Info.plist` 渲染 + `plutil -lint` → 嵌套签名 → 主签名 → zip/dmg）。离线/复用：`--skip-build` / `--skip-sidecar`；分步：`--no-sign` / `--no-zip` / `--no-dmg`；计划校验：`--dry-run`（不写盘，但会断言已解析计划/feed 形状）。
- [ ] 构建产物新鲜度：`node scripts/gates/checks/verify-artifact-freshness.mjs --require-compare` 在构建后跑（已提交产物与 src 一致；release workflow 的构建/校验步同义）。
- [ ] ARCHIVED（不执行）：Electron 的 `build:preload` / electron-builder dmg-zip 打包 / `extraResources` Electron 产物；复活见 §6。

## 3. 载荷与更新链闭包

### 3.1 更新链（Sparkle；Electron updater 为 ARCHIVED）

- [ ] appcast 双通道形状：stable `appcast-swift.xml`、beta `appcast-swift-beta.xml`；beta 发布是 GitHub prerelease（`releases/latest` 解析不到），beta appcast 与引用的 zip 覆盖到滚动 beta tag/release，且 beta feed 同时收最新 final 条目。
- [ ] 本版本 appcast 门禁：`node scripts/release/feed/verify-native-appcast.mjs` 按发布形态带旗标（`--single-item` / `--expect-final-item` / `--expect-delta-from <上一个版本>` / `--expect-delta-count <n>`；签名逐条 Ed25519 真验：`--signatures-dir <dir> --public-key <base64>`）。
- [ ] 滚动 feed 合并：`node scripts/release/feed/merge-native-feed.mjs`（stable final 条目复制进滚动 feed、保留旧 beta 条目并按 `--beta-item-limit` 截断）。
- [ ] 更新源注入：构建未注入两条通道 feed URL 时，应用内 beta 订阅开关禁用并显示原因（design 25 §7）；beta 构建默认只收正式版，打开订阅后继续接收 beta。
- [ ] ARCHIVED：Electron `latest-mac.yml` / `beta-mac.yml` 与 electron-updater 链（[electron-frozen.md](../../progress/electron-frozen.md)）。

### 3.2 载荷闭包（单 Node 裁决 + 资源落位）

- [ ] sidecar 装配目录含 `sidecar.js`、`dist/control-plane/**`、`primary-runtime/**`、`office-skills/**`、`package.json`；**单 Node 裁决**：装配内唯一 Node = `primary-runtime/dependencies/node/bin/node`（无独立 helper），`sidecar/package.json` 版本必须等于壳版本（build 时断言）。
- [ ] payload 完整且 fail-closed（发布腿在打包产物上验，本地可在源目录先验）：`node packages/desktop/scripts/prepare-python-payload.mjs --verify "macos/release/dsh-chamber.app/Contents/Resources/sidecar/primary-runtime"`、`node packages/desktop/scripts/prepare-office-assets.mjs --verify "macos/release/dsh-chamber.app/Contents/Resources/sidecar/office-skills"`（源目录形态 = `packages/desktop/resources/primary-runtime` / `.../office-skills`；缺件/摘要不符即红，`--require-python` / `--require-office-assets` 把缺件升级为 fail-closed）。
- [ ] Office 资产面与启动行单挂：`office-skills/**` 只含 skill-office 包当前资产清单的 SKILL.md（清单单源 = `prepare-office-assets.mjs` 的 `OFFICE_SKILL_FILES`，改资产面时同批同步 `startup-plugin-rows.ts` 的 `OFFICE_SKILL_NAMES` 门控与测试）；上游 web-app bundle 也挂 `skill-office` 行（读包内 assets，prune 会裁掉），本地 overlay 必须带该行的 id-targeted disable（`bundle-row-disables.ts`），启动日志/插件图确认 `dsh-office` provider 只注册一次。
- [ ] runtime 载荷的源码/文档面：打包产物内 `.../sidecar/vendor/dsh/node_modules/@deepseek-ai/dsh/docs` 在场且可读（dsh-doc 资料面），闭包内包级 `src` 保留、`.d.ts`/`.map` 仍被裁剪；prune 规则未变时 `dsh.pruneRevision` 不动（规则/版本改一处必须同批 bump 并改 `prune-runtime.test.ts` 的 revision 断言）。
- [ ] runtime 载荷与 prune 纪律：`packages/desktop/vendor/dsh` 的 runtime 树由 `bundle:dsh` 生成（`pnpm run build:desktop` 链内），prune 规则/版本写在 manifest 的 `dsh.pruneRevision`，声明目标（`docs/DETAIL*.md` 等）删掉即封装失败（design 18）。
- [ ] 资源落位：`icon.icns`、SwiftPM 资源包 `DSHChamber_DSHChamber.bundle`、`en.lproj` / `zh-Hans.lproj` 必须在 `Contents/Resources` 根（放错被 codesign 判未密封内容/本地化解析不到）；`Info.plist` 由模板渲染（版本占位替换）、`plutil -lint` 通过；`assertLocalizationsPresent` 缺席即装配失败。
- [ ] 第三方声明：`pnpm run gen:notices` 的 `THIRD_PARTY_NOTICES.md` 与随包载荷（primary runtime）声明同批更新；`release.yml` 的「Third-party notices current」步以 git diff 判。
- [ ] 共享契约面：`node scripts/gates/checks/verify-shim-payload-shape.mjs`（preload ↔ shim ↔ manifest 三方锁步）与 `node scripts/gates/checks/verify-test-wiring.mjs` 的生成物锁步必须绿。

## 4. 闭包复核命令（发布前逐条跑）

- [ ] 包清单五处同源：`node scripts/release/preflight/packaging-manifest-lockstep.test.mjs`。
- [ ] 编译 sidecar 冒烟：`pnpm run test:sidecar:compiled`（等价 `DSH_CHAMBER_SIDECAR_COMPILED=1 node scripts/gates/checks/compiled-sidecar-smoke.mjs`，需已构建 sidecar；`SMOKE PASS` 打印才算过）。
- [ ] 打包脚本套件：`pnpm run test:macos`（darwin 打包脚本 + `harness.commit` 锁断言；含 `build-sidecar.test.mjs` / `build-swift-app.test.mjs` / `after-pack-adhoc-sign` 等）与 `pnpm run test:swift`（`.app`/桥/本地化锁步）。
- [ ] 根模块数复核（`build.files` 的 `*.ts` glob 展开的非测试根模块）：`ls packages/desktop/*.ts | grep -v '\.test\.ts$' | wc -l`；与上一发布基线比较，新增/删减的根模块必须已在 design/登记面说明（数字不以文档为准，**不手抄**）。
- [ ] 产物名义与清单：`node scripts/release/preflight/release-artifacts.mjs <版本> --check-dir macos/release`（native 产物名/清单；Electron 名族是 ARCHIVED 复活基线）。
- [ ] 签名复核（装配期已 fail-closed）：`codesign --verify --deep --strict <App>.app`；zip 解包后的 `.app` 复验；bundle 内无逃逸 symlink（构建期 `assertNoEscapingSymlinks` 直判，逃逸即失败）。
- [ ] 架构一致性：.app 可执行与 payload Node 的 `lipo` 比对在构建期断言（不一致的包能签名、运行时才崩——因此不在发布后补查）。
- [ ] 安装态启动：打包态 `.app` 能起窗、sidecar ready 帧、控制面 `/health`；原生装配门 `node scripts/gui-acceptance/drivers/run.mjs --flavor native --require-assembly --web-dist packages/desktop/dist/web`。

## 5. 签名、公证、本地化与权限

- [ ] Developer ID 签名 + 公证 + staple：正式发布凭据缺失时 `release.yml` 在任何 Release 变更前 fail-closed；本地构建默认 ad-hoc。
- [ ] 嵌套签名权限最小化：payload Node 用 `entitlements.node.plist`；LibreOffice kit native helper 只用 `allow-jit` 的 `entitlements.jit.plist`（[build-swift-app.mjs](../../../macos/scripts/build-swift-app.mjs)）。
- [ ] 本地化三处同源：`LOCALIZATIONS`、`Info.plist.template` 的 `CFBundleLocalizations`、`Package.swift` 两个 `.process("…lproj")`；`ShellIdentityTests` 的锁步测试必须绿（拼写变体/多缺即红）。
- [ ] `spctl --assess` / `xcrun stapler validate`（`.app`、dmg、zip 解包后）按 [release-checklist.md](./release-checklist.md) §5 执行。

## 6. ARCHIVED 边界（本版不执行）

- [ ] Electron 打包面：electron-builder dmg/zip、`build:preload`、`extraResources` 的 Electron 产物、`latest-mac.yml`/`beta-mac.yml` 更新 feed——冻结归档（[electron-frozen.md](../../progress/electron-frozen.md)、design 11（ARCHIVED）、[release-artifacts.mjs](../../../scripts/release/preflight/release-artifacts.mjs) 头注）。
- [ ] Windows（NSIS）/ Linux（AppImage）桌面腿：不发布、不排期；`release.yml` 对应 job 恒 skipped。
- [ ] 复活条件：仅按 [electron-frozen.md](../../progress/electron-frozen.md) §6 复活清单执行；本清单的 ARCHIVED 条目保留原地，不删除。

## 7. 失败处置与记录纪律

- [ ] 装配期失败一律 fail-closed：不产出半成品、不静默降级（缺 Node/pnpm/office 资产/架构不符/本地化缺失/逃逸 symlink 都直接红）。
- [ ] 闭包命令变红时，先定位到**单源**（包清单/过滤器/lock/pin），不在 checklist 或构建脚本里加例外；需要放宽先改 owning 文档与测试。
- [ ] 证据：发布 PR / Release 记录附构建链命令、闭包命令输出与产物清单；本清单不写版本值、不复制载荷清单、不记门禁计数（单源见 [package.json](../../../package.json)、`primary-runtime-lock.json`、[packaging-manifest-lockstep.test.mjs](../../../scripts/release/preflight/packaging-manifest-lockstep.test.mjs)）。
