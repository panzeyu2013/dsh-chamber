# 11 · 桌面端更新提示与通道（Electron / electron-updater 半边，归档参考）

> **ARCHIVED REFERENCE（2026-11 用户裁决）**：Electron flavor 已冻结归档（[electron-frozen.md](../../progress/electron-frozen.md)）。本文的 **Electron / electron-updater 半边 = 归档参考**，保留其既有行为与发布侧纪律作为复活基线；**现行更新契约 = Swift 腿的 Sparkle 链，见 [25-macos-swift-native-shell.md](../desktop/25-macos-swift-native-shell.md) §7（Sparkle 版本单源 = `macos/Package.swift`）**。文件与历史文档不删除；恢复该腿需用户重开范围。

## 1. 契约范围

更新目标是 **dsh-chamber 自身**，不是远端 dsh 实例。归档形态的闭环：后台静默检查（stable/beta 通道）→ settings 的 chamber 全局「更新」组低调提示「有新版本 vY」→ **用户明确点击「更新」后才后台下载** → 退出时自动安装；界面内另有「重启并安装」按钮控制安装时机。全程无弹窗。

## 2. 目标与硬边界

- **无弹窗**：主进程 dialog、托盘气泡、系统通知一律不出现。
- **低打扰**：settings 内只用普通状态行展示（无高亮徽标/角标/横幅/开机即弹）。
- **下载以用户确认为前提**：`autoDownload=false`——无用户点击，检查只访问更新发现 API/feed，不产生包下载或安装副作用。
- 检查器/下载器只进 `packages/desktop` 主进程；控制面保持 loopback-only、零出网；渲染层不参与检查逻辑，只经 IPC 呈现状态。
- **不涉及远端 dsh**：chamber 升级自带新 dsh runtime（`extraResources` 的 `vendor/dsh`），远端实例版本无关（`verifyUp` 按 dsh 特征签名兼容新旧）。
- 不引入认证面，不改控制面契约（[05-connection-manager.md](../control-plane/05-connection-manager.md) §7.4 为 IPC 权威）。

## 3. 机制（electron-updater，github provider）
- **检查（stable）**：electron-updater GitHub provider 读正式 release 的 `latest.yml`（mac 为 `latest-mac.yml`）。
- **检查（beta）**：主进程用 Electron `net.fetch` 请求 Releases list API（10s、≤100 条），只接受 `draft=false`、`prerelease=true` 且 tag 精确匹配 `vX.Y.Z-beta.N` 的发布，切 exact-tag Generic provider 读 `beta*.yml`；发现失败不回落 stable。
- **下载/安装**：`autoDownload=false`（无用户点击不下载）；`autoInstallOnAppQuit:true`（退出安装、无弹窗）；`downloaded` 提供 [重启并安装]（仅 macOS/Windows；Linux 保留退出腿）。
- **关窗次序不变量**：`quitAndInstall` 先关闭全部窗口再退出；控制器在调用前武装 `updaterQuitArmed`（武装期 `shouldHideToTray` 恒 false，失败/停滞撤回并拉回窗口）；原生 `before-quit-for-update` 桥 + 5s 宽限自退兜底。
- **签名前置（非 UX 分支）**：Squirrel.Mac 要求 Developer ID 签名；`codesign -dv` 探测失败置 `installBlockedReason` 并提示手动安装；dry-run ad-hoc 资产不公开。
- **通道细节**：打包 beta 以构建期封签为准（`extraMetadata.dshChamberUpdateChannel` → `resolveChannel`），无封签退 canonical `-beta.N`；`DSH_CHAMBER_UPDATE_CHANNEL=beta` 仅 opt-in；stable 用 `app-update.yml`，beta 显式 `setFeedURL` + `allowPrerelease`、`allowDowngrade=false` 最后生效。
- **Linux 形态门**：仅打包且从可写 `$APPIMAGE` 启动才启用（`probeLinuxAppImage`）；否则 `platformBlockedReason` 禁用检查/下载。

## 4. 呈现面（settings 的 chamber 全局「更新」组）
- 状态流：主进程 `updater.ts`（idle→checking→up-to-date→available→downloading→downloaded/error）经 preload IPC 到 settings 壳；「更新」组挂 `__general` 固定入口底部（结构权威 = design 15）。
- 纪律：`up-to-date` 与 `idle` 区分；`downloaded` 终态不回退；检查失败清空 `latestVersion`；下载在途闸防重复；状态推送优先于查询快照。
- 内容：当前版本、[检查更新]、有新版「新版本 vY」+[更新]、已下载「已下载，退出时安装」+[重启并安装]、无新版「已是最新版本」；失败文案脱敏（绝对路径只留主进程日志）。
- IPC/文案：`dsh-chamber:update-state` / `update-state-changed` / `update-check` / `update-download` / `update-restart` / `open-release`（revision 护栏 + trustedIpc 复核）；zh/en 走 `dsh-chamber.settings.bridge` 命名空间。

## 5. 启动清理已安装版本的更新缓存

electron-updater 6.x 安装成功后不删下载产物，控制器启动即做保守清理：
- `resolveUpdaterCacheDir` 按 electron-updater 同款推导缓存目录（含 `updaterCacheDirName`；拒绝分隔符与 `.`/`..` 逃逸；dev 不解析），读 `pending/update-info.json` 解析缓存版本。
- **仅当缓存版本 ≤ 运行版本**才整目录删除；更新的未装版本、缺元数据、不可解析一律保留（失败保守，绝不误删）；fire-and-forget 永不 throw；DI seam `UpdateControllerDeps.staleCache`。
- 整目录删除安全的前提 = feed 从不发布 blockmap（release.yml 删 mac `.zip.blockmap` 且断言无侧车；win `nsis.differentialPackage=false`）；**若重新发布 blockmap**，该删除点必须改为保留 update.zip（LATENT COUPLING）。

## 6. 通道模型（beta → stable）

- **stable（默认）**：读最新正式 release 的 `latest.yml` / `latest-mac.yml`。
- **beta**：优先读构建期封签的通道（`normalizeSealedChannel` + `resolveChannel`），制品自证通道、与版本号后缀解耦；无封签时 canonical `X.Y.Z-beta.N` 应用按自身版本自动进入 beta；开发/显式 opt-in 用 `DSH_CHAMBER_UPDATE_CHANNEL=beta`（恒最强，只能加 beta）。封签与版本后缀不一致 = 误配制品，**封签为准并 loud 记录**。消费侧只从最高规范 published beta 的精确 tag 读 `beta.yml` / `beta-mac.yml`；发现失败 fail closed，不尝试 `latest*`；settings 组标注「beta 通道」。Swift 腿的生效通道是纯用户偏好（`betaUpdates` 设置项 + `DSH_CHAMBER_UPDATE_CHANNEL`，契约见 [25-macos-swift-native-shell.md](../desktop/25-macos-swift-native-shell.md) §7）；封签只落 Electron 腿。
- **发布侧**：beta = 版本精确匹配 canonical `X.Y.Z-beta.N` → 独立 `electron-builder.beta.yml` 显式产 `beta*.yml`；stable 用默认配置只产 `latest*.yml`；`alpha`、`rc` 与其他 prerelease 一律版本门禁拒绝。GitHub Release 的 prerelease 标志由已校验的 canonical beta 版本推导（非 workflow 输入）。验证通过后发正式版本（`latest*.yml`）——先内测、后提升，契合既有 draft → finalize 手动节奏。

## 7. 数据流与失败语义

状态流与确认语义见 §3/§4；失败一律静默或 settings 内响亮（安装失败绝不假装成功），不阻塞启动、不静默降级；确认回答带渲染快照 `revision`，主进程拒收过期并重推当前状态。

- **失败语义**：检查/下载/校验/安装任何失败 → 静默或 settings 内响亮（安装失败绝不假装成功），绝不阻塞启动、绝不静默降级（`allowDowngrade=false`）。
- **确认回答一致性**：点击「更新」/「重启并安装」时页面回传渲染快照的 `revision`（`UpdateState.revision` 每次状态推进 +1；IPC 载荷 `{revision}`）；主进程发现过期即 loud 拒绝并重推当前状态（页面就地自愈），并在 settings 行内给出可见文案（`updateActionRefused`）。原生（Swift）腿同形：revision 护栏在转发 Sparkle 之前生效。
- **无弹窗清单**：主进程 dialog、托盘气泡、系统通知、settings 外的任何提示一律不出现。

## 8. 发布流程与构建产物
- **feed 产物**：mac `dmg`+`zip`（不产 update-info 的 dmg 保留首装）；beta 用 `electron-builder.beta.yml` 显式产 `beta*.yml`，stable 只产 `latest*.yml`；不发布 blockmap（win 关差分 + mac finalize 前删 asset）。
- **发布必须走 `--publish` 且 SHA 钉死**：`--publish=never` 不生成 update-info；release.yml actions 钉 40 位 commit SHA；build `--publish=always` 上传产物进 draft。
- **发布门**：`version` 输入校验 canonical stable/beta 且等于根+全部 chamber package 版本（数据驱动扫描）；draft `target_commitish` 绑定同一 SHA；已公开 release 不可变，只删同 tag 陈旧 draft；dry_run 清空签名/公证环境与 `GH_TOKEN`。
- **macOS 签名**：正式发布缺凭据在 Release mutation 前阻断；签名/stapler/spctl 失败在 finalize 前阻断；仅 dry-run 允许 ad-hoc。

## 9. 安全与已知让步
- **完整性**：`latest*.yml` 内 sha512 校验下载包；正式 mac 发布必须 Developer ID 签名/公证/stapler/spctl 全过。
- **出网面**：仅主进程访问 GitHub API/feed（HTTPS），控制面零出网；检查/下载不携带用户/SSH 材料。
- **用户确认闸**：`autoDownload=false`——无点击不产生下载流量；打开链接白名单仅 `https://github.com/panzeyu2013/dsh-chamber/*`。
- **失败语义**：超时/网络静默 + 日志；settings 显示「无法检查更新」而非假成功；安装失败响亮。

## 10. 版本管理与数据兼容
- chamber 版本集 = 根 + 全部非 fork `@dsh-chamber/*` 包（数据驱动扫描，单源 `release-preflight.mjs`）；三个 fork 副本保持上游基线。更新只替换应用本体，`userData`（注册表/state/凭据）天然保留；未来格式变化走首启迁移（幂等、失败响亮）。

## 被否方案
- **被否方案**：上游 COS 人工 dispatch 发布链、`update-http-executor` 传输替换、`mandatory-update` 家族、main-owned 确认对话框、百分比灰度（需自托管 feed）、上游相位词表（`downloaded` 已等价）、自托管静态 feed——均不采纳，理由分别 = 依赖私有字段/无需求/UX 契约冲突/规模未到/无独立行为面。

## 相关文档
- 现行更新契约 = [25 §7](../desktop/25-macos-swift-native-shell.md)（Sparkle）；冻结范围/复活清单 = [electron-frozen](../../progress/electron-frozen.md)；Linux 形态门 = [22](./22-linux-desktop.md)；关窗行为 = [14](../runtime/14-sleep-background.md) D1；settings 结构 = [15](../client/15-chamber-settings-page.md)；发布清单 = [release-checklist](../../checklists/release/release-checklist.md)。
