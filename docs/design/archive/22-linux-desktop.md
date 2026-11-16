# 22 · Linux 桌面支持（发行形态 / 自动更新形态门 / 系统集成）

> **ARCHIVED（2026-11 用户裁决）**：Electron flavor 已冻结归档，**Linux 桌面腿冻结、不发布、不排期**（[electron-frozen.md](../../progress/electron-frozen.md)）。本文保留为**复活基线**：下方是归档腿的契约事实与平台纪律，恢复该腿需用户重开范围并按 [electron-frozen.md](../../progress/electron-frozen.md) §6 的复活清单执行。

## 1. 范围与形态

- **发行形态 = AppImage（x64）**；`deb`/`rpm` 与 `arm64` 未排期（arm64 需原生 arm runner 腿 + 分架构 feed）。`dir` 不是默认 `linux.target`（仍可用 `electron-builder --dir` 显式构建）。`packages/desktop/package.json` 的 `build.linux` = `target: ["AppImage"]` + `desktop.entry`（Name/Comment/Icon/StartupWMClass）。
- **Linux 自动更新 = 解锁，但按「运行形态」门控**：electron-updater 的 AppImage updater 靠**替换正在运行的 .AppImage 文件**完成安装，故只有「打包 且 `$APPIMAGE` 为绝对路径、常规文件、父目录可写」时可用；dev / 解包目录 / deb 等形态保持 inert 状态与同一 blocked 文案，无 UX 回退（按钮门控见 §2）。
- **CI 构建基线 = ubuntu-22.04**（glibc 2.35）：AppImage 的 glibc 下限 = 构建机，在 24.04 构建会排除 22.04 时代桌面；与本仓库测试机基线一致，形成「构建 → 实机验证」闭环（§6）。
- Windows 支持（design 23，归档）与 Linux 相互独立：Linux 走完整 POSIX 变更路径，不复制 win32 只读门（运行时核心的平台范围本就是 macOS/Linux）。
- **Linux 就绪面**：运行时核心的 macOS/Linux mutation 契约、gateway 即 Linux 服务器产品、CI 全量测试跑 ubuntu、askpass（`SSH_ASKPASS_REQUIRE=force`，ssh-provider）、reaper 的 `lsof → ss → /proc/net/tcp` 三级端口探针、私有目录 0600/0700 + fchmod 复验、spawn 的 node 定位（Electron-as-node / PATH / known roots）。本设计承载发行物、更新形态门、桌面集成与 §4 的平台适配。

## 2. 自动更新形态门（updater.ts）

- `probeLinuxAppImage()`：按 AppImageUpdater 的真实替换语义（quit 时 `unlink` 旧文件 + 移入新文件，两者都是父目录操作）判定——① 启动形态确属 AppImage（execPath 位于 `/tmp/.mount_*` 挂载或 `/tmp/appimage_extracted_*` 提取目录；防「解包目录 + 残留 `$APPIMAGE`」误开门，否则 quit 会 unlink 外来文件）；② `$APPIMAGE` 绝对路径且 stat 为常规文件；③ **父目录** `access(W_OK)`（文件自身 mode 与替换无关）。任一失败即 null（fail-closed，绝不半开）；控制器创建时单次求值，运行中修权限需重启才重探。
- `platformBlockedReason` 的 Linux 分支 = `app.isPackaged && probe !== null ? null : LINUX_UPDATE_UNSUPPORTED_REASON`。该字符串（`'auto-update is not supported on this platform'`）是 settings-bridge `updateCheckPlatformBlocked` 的键控值——非 AppImage 形态保持原串、按钮自动禁用；AppImage 形态为 null，检查/下载/退出安装全链与 mac/win 同路径。
- `start()`/`checkNow()` 无 `platform === 'linux'` 无条件特判，改为 `platform === 'linux' && installBlockedReason !== null` 才跳过/拒绝。
- feed 文件名：stable = `latest-linux.yml`，beta = `beta-linux.yml`（electron-updater linux 命名），由 release.yml build-linux 腿生成并断言互斥。
- 升级后 .desktop 路径变化：协议条目每次启动重写（§3），AppImage 自更新替换文件后下次启动即注册新路径。

## 3. 桌面集成（.desktop 纪律）

AppImage 的 `process.execPath` 是每次启动的 squashfs 挂载点（`/tmp/.mount_*`），**任何持久化 .desktop 条目不得引用它**——一律解析为 `$APPIMAGE`（绝对路径），否则重启即失效（自启/深链/升级均同此规则）。

- **登录自启**（`main.ts` applyLaunchAtLogin / `deep-link.ts` 的 `linuxAutostartDesktopEntry` + `linuxAutostartDirectory`）：目录 = `$XDG_CONFIG_HOME/autostart`（**仅绝对路径生效**，相对/空/~ 按 XDG Base Dir Spec 视为未设），未设则 `~/.config/autostart`；内容含 Name/Exec(APPIMAGE)/Terminal=false/X-GNOME-Autostart-enabled/StartupWMClass/Icon；0600；**禁用分支同时清理 XDG 位置与 ~/.config 遗留位置**。
- **协议 handler**（`deep-link.ts` `ensureLinuxProtocolDesktopFile` + `linuxProtocolDesktopEntry`）：打包态每次启动写入 `$XDG_DATA_HOME/applications/dsh-chamber.desktop`（未设则 `~/.local/share/applications`；XDG 值同样只认绝对路径），`Exec=<launch> %u` + `MimeType=x-scheme-handler/dsh-chamber;`，`NoDisplay=true`；随后仍调用 Electron `setAsDefaultProtocolClient`。
- **Electron 侧注册机制**：Linux 上 `setAsDefaultProtocolClient` 从不创建/覆盖 .desktop——它读 `$CHROME_DESKTOP`（缺省为 app id）定位**已存在**的条目并 `g_app_info_set_as_default_for_type(x-scheme-handler/<scheme>)`，故先写自有条目是注册载体；`main.ts` 在调用前以 `CHROME_DESKTOP ??= 'dsh-chamber.desktop'` 指回该条目（不覆盖用户/启动器已设值）。
- Exec 引号/转义遵循 Desktop Entry Spec（`quoteDesktopExecValue`，含字面 `%` 双写为 `%%`，防路径被解析为字段码）；scheme 白名单要求 ASCII 字母开头（RFC 3986 / Electron `IsValidProtocolScheme`）。

## 4. 发布流水线与平台适配

- release.yml `build-linux` 腿（ubuntu-22.04、x64、SHA 钉死、beta 用 beta 配置、dry_run 清 `GH_TOKEN`）验证 AppImage 存在、feed 互斥、无 `.blockmap`；不设独立 verify 脚本。
- 构建机 glibc 下限 = 构建机（ubuntu-22.04）；runner 退役需预登记迁移方案。
- 平台适配：`spawn-dsh.ts` node 兜底表加 `~/.local/bin`/`/snap/bin`；目录 fsync 仅吞 EINVAL/ENOTSUP（平台无关）；托管宿主 pnpm 走随包 wrapper；远端浏览器 forward 每进程组 + fail-closed reaper（design 28）；已知未动项见 STATUS。
- **已知未动项**：托盘图标候选两死路径（跨平台既有边界）；pnpm home 的 XDG_DATA_HOME 偏移未覆盖（低优；macOS `~/Library/pnpm` 超出 Linux 范围）；`private-fs.ts` syncPinnedDirectory（private-file 的兄弟站点）保持严格无容错、未并入；gateway 裸 CLI 默认 stateDir 与 control-plane standalone 共享 `~/.dsh-chamber`（文档提示）。

## 5. 不做 / 边界

- Linux 更新不引入 .blockmap 差分（全量下载，与 win/mac 现状一致）。
- 不为 Linux 增加执行面/认证面/权威源：控制面 loopback-only、渲染投影不变。
- 深链/托盘/通知/焦点等 DE 相关行为只能在真实桌面验收；无头 CI 只保证 fail-soft 与打包正确性。
- 不把 win32 门控反向铺到 Linux（如 launchAtLogin/askpass/运行时 mutation）。

## 6. 复活验收矩阵（归档基线）

复活验收按 [gui-acceptance-checklist](../../checklists/acceptance/gui-acceptance-checklist.md) 的 Linux 腿执行。

## 相关文档

- [electron-frozen.md](../../progress/electron-frozen.md)（冻结/复活）、[18](../runtime/18-dsh-runtime-version.md)（runtime mutation）、[16](../desktop/16-vscode-deeplink.md)（深链）、[14](../runtime/14-sleep-background.md)（自启/托盘/关窗）、[11](./11-auto-update.md)（更新通道）、[23](./23-windows-support.md)（Windows 归档腿）。
