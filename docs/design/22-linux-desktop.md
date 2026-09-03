# 22 · Linux 桌面支持(发行形态 / 自动更新形态门 / 系统集成)

> **状态:现行(2026-12 落地)**。本文档记录 Linux 桌面从「仅 dir 打包、无更新、
> 深链静默失效」到「AppImage 发行 + 形态门自动更新 + 桌面集成修复」的范围与决策。
> 运行时核心(macOS/Linux mutation 契约)见设计 18;深链契约见设计 16;自启/托盘/
> 关窗行为见设计 14;更新通道模型见设计 11。

## 1. 范围与决策(2026-12 用户拍板)

1. **发行形态 = AppImage(x64 首版)**;`deb`/`rpm` 与 `arm64` 后续排期(arm64 需原生
   arm runner 腿 + 分架构 feed,镜像 OpenChamber 矩阵)。`dir` 不再作为默认
   `linux.target`(仍可用 `electron-builder --dir` 显式构建)。
2. **Linux 自动更新 = 解锁,但按"运行形态"门控**:electron-updater 的 AppImage
   updater 靠**替换正在运行的 .AppImage 文件**完成安装,因此只有
   「打包 且 `$APPIMAGE` 为绝对路径、常规文件、可写(W_OK)」时更新可用;dev /
   解包目录 / deb 等形态保持历史 inert 状态与同一 blocked 文案,settings「检查
   更新」按钮按既有字符串门自动禁用,无 UX 回退。
3. **CI 构建基线 = ubuntu-22.04**(glibc 2.35):AppImage 的 glibc 下限 = 构建机,
   在 24.04 构建会排除 22.04 时代桌面;22.04 与本仓库测试机基线一致,形成
   「构建 → 实机验证」闭环。
4. Windows 支持推进(design 23,首版未出)与 Linux 相互独立:Linux 走完整 POSIX
   变更路径,不得复制 win32 只读门(设计 18 平台范围本就是 macOS/Linux)。

## 2. 现状盘点(落地前的真实基线)

代码面早已大面积 Linux-ready(审计结论):运行时核心 macOS/Linux mutation 契约、
gateway 即 Linux 服务器产品、CI 全量测试跑 ubuntu、askpass(SSH_ASKPASS_REQUIRE=force)
非 win32 即用、reaper 的 `lsof → ss → /proc/net/tcp` 三级端口探针按 Linux 现实设计、
目录 0600/0700 + fchmod 复验、spawn 的 node 定位(Electron-as-node/PATH/known roots)
等。真正缺口:

| 缺口 | 位置(落地前) | 处置 |
|---|---|---|
| 无发行物 | `build.linux.target=["dir"]`,无 .desktop | AppImage target + desktop.entry |
| 深链无注册载体 | Linux 协议分发靠 .desktop(MimeType=x-scheme-handler),dir 不生成 | AppImage/deb 由 electron-builder 生成;再加运行时每启重写用户级 .desktop |
| 自动更新恒拒 | `updater.ts` platform==='linux' 三处硬门 | 形态门(见 §3) |
| 自启绕过 XDG_CONFIG_HOME、AppImage 下 Exec 固化挂载路径 | `main.ts` applyLaunchAtLogin | XDG_CONFIG_HOME(仅绝对路径)+ $APPIMAGE + Icon/StartupWMClass;禁用双位置清理 |
| node 兜底表 mac 化;目录 fsync 无平台无关容错(仅 recovery 处有 win32 特判) | spawn-dsh / private-file / host-logs / runtime-metadata-recovery | 平台分表 + X_OK;EINVAL/ENOTSUP 平台无关容忍 |
| resolvePnpmBinDir 漏 Linux 安装根 | plugin-sync | 增补 ~/.local/share/pnpm、~/.local/bin |
| 发布无 Linux 腿 | release.yml(3 腿) | build-linux 腿 + finalize needs + 策略测试 4 腿 |

## 3. 自动更新形态门(updater.ts)

- `probeLinuxAppImage()`(2026-12 review 加固):按 **electron-updater
  AppImageUpdater 的真实替换语义**(quit 时 `unlink` 旧文件 + 移入新文件,两个
  都是父目录操作)判定——① 启动形态确属 AppImage(execPath 位于
  `/tmp/.mount_*` 挂载或 `/tmp/appimage_extracted_*` 提取目录;防"解包目录 +
  残留 $APPIMAGE"误开门,否则 quit 会 unlink 外来文件);② `$APPIMAGE` 绝对
  路径且 stat 为常规文件;③ **父目录** `access(W_OK)` 通过(文件自身 mode 与
  替换无关)。任一失败即 null(fail-closed,绝不半开);在控制器创建时单次求值,
  运行中修权限需重启才重探。
- `platformBlockedReason` Linux 分支 = `app.isPackaged && probe !== null ? null :
  'auto-update is not supported on this platform'`。**该字符串是 settings-bridge
  `updateCheckPlatformBlocked` 的键控值**——非 AppImage 形态保持原串,按钮自动禁用;
  AppImage 形态为 null,检查/下载/退出安装全链与 mac/win 同路径。
- `start()`/`checkNow()` 删 platform==='linux' 无条件特判,改为
  `platform==='linux' && installBlockedReason !== null` 才跳过/拒绝。
- feed 文件名:stable=`latest-linux.yml`,beta=`beta-linux.yml`(electron-updater
  linux 命名),由 release.yml build-linux 腿生成并断言互斥。
- 升级后 .desktop 路径变化:协议 .desktop 每次启动重写(§4),AppImage 自更新
  替换文件后下次启动即注册新路径。
- **退出安装链实机门禁**(无头无法验证,登记 §8):已下载→退出→$APPIMAGE 原位
  替换→重启为新版;二次更新;单实例锁与 quit 时同步重拉的互斥。

## 4. 桌面集成(.desktop 纪律)

AppImage 的 `process.execPath` 是每次启动的 squashfs 挂载点(`/tmp/.mount_*`),
**任何持久化 .desktop 条目不得引用它**——一律解析为 `$APPIMAGE`(绝对路径),
否则重启即失效(自启/深链/升级均同此规则;镜像 OpenChamber linux-autostart)。

- **登录自启**(main.ts applyLaunchAtLogin / deep-link.ts
  `linuxAutostartDesktopEntry` + `linuxAutostartDirectory`):目录 =
  `$XDG_CONFIG_HOME/autostart`(**仅绝对路径生效,相对/空/~ 按 XDG Base Dir Spec
  视为未设**)未设则 `~/.config/autostart`;内容含 Name/Exec(APPIMAGE)/
  Terminal=false/X-GNOME-Autostart-enabled/StartupWMClass/Icon;0600;**禁用分支
  同时清理 XDG 位置与 ~/.config 遗留位置**(env 变更/旧版残留不复活)。
- **协议 handler**(deep-link.ts `ensureLinuxProtocolDesktopFile` +
  `linuxProtocolDesktopEntry`):每次打包态启动写入
  `$XDG_DATA_HOME/applications/dsh-chamber.desktop`(未设则
  `~/.local/share/applications`;XDG 值同样只认绝对路径),`Exec=<launch> %u` +
  `MimeType=x-scheme-handler/dsh-chamber;`,`NoDisplay=true`;随后仍调用
  Electron `setAsDefaultProtocolClient`。
- **Electron 侧注册机制(2026-12 review 以 43.4.0 源码确认)**:Linux 上
  Electron 的 setAsDefaultProtocolClient 从不创建/覆盖 .desktop——它读
  `$CHROME_DESKTOP`(缺省为 app id)定位**已存在**的 .desktop 并
  `g_app_info_set_as_default_for_type(x-scheme-handler/<scheme>)`。因此先写
  自有条目是注册载体;main.ts 在调用前以 `CHROME_DESKTOP ??=
  'dsh-chamber.desktop'` 指回该条目(不覆盖用户/启动器已设值)。真机行为
  (DE/portal 下默认路由是否生效)列入 §8 门禁。
- Exec 引号/转义遵循 Desktop Entry Spec(`quoteDesktopExecValue`,含字面 `%`
  双写为 `%%`,防路径被解析为字段码);scheme 白名单要求 ASCII 字母开头
  (RFC 3986 / Electron IsValidProtocolScheme)。

## 5. 发布流水线

`release.yml` 新增 `build-linux` 腿(ubuntu-22.04、x64、`ref: ${{ github.sha }}`
钉 SHA、beta 带 electron-builder.beta.yml、dry_run 清 GH_TOKEN),验证:
runner=linux-x64、打包 dsh runtime `platform.startsWith('linux-')`、AppImage 存在、
非 dry_run 时 feed 互斥(`latest-linux.yml` vs `beta-linux.yml`)且无 .blockmap。
`finalize-release.needs` 含 build-linux;`scripts/dev/release-workflow-policy.test.mjs`
切片/计数同步为 4 腿(3→4)。**取舍登记**:不做 OpenChamber 式独立
verify-linux-appimage 脚本——以 afterPack 钩子断言 + workflow 内联 verify +
人工无头冒烟(AppImage 提取/解包目录双形态)覆盖,实机门禁见 §8;
ubuntu-22.04 runner 退役窗口(26.04 GA 后)需预登记迁移方案(24.04 + 文档修订,
或 docker ubuntu:22.04 容器构建保 glibc floor)。

## 6. 控制面/运行时随行修复(审计发现)

- `spawn-dsh.ts`(control-plane):node 兜底表平台分表——nvm 布局 darwin/linux
  相同(`~/.nvm/current` 需 NVM_SYMLINK_CURRENT 才存在,两平台默认都没有,故以
  `~/.nvm/alias/default` 优先 + `~/.nvm/versions/node/*/bin` 数值降序扫描为准,
  全部 fs 访问 try/catch,兜底永不 throw);linux 增 `~/.local/bin`、`/snap/bin`
  (用户态 node 先于发行版 /usr/bin,注释明示);候选统一 X_OK + isFile 校验
  (防同名目录/不可执行文件 EACCES 陷阱,跟随符号链接语义正确)。
- 目录 fsync 容错:**EINVAL/ENOTSUP 是文件系统属性不是 Windows 属性**
  (NFS/CIFS/FUSE 可能拒绝 O_RDONLY 目录 fsync)。`packages/control-plane`
  private-file.ts syncParent、host-logs.ts syncDirectory,以及 **packages/dsh-runtime
  共享核心**(desktop 与 gateway 双 owner,改动同时影响 gateway/Linux server 与
  macOS 桌面)runtime-metadata-recovery.ts fsyncRealDirectory,一律平台无关地
  只吞这两个错误码,身份复验保留,EIO 等仍 loud。既有 private-fs.ts
  syncPinnedDirectory(兄弟站点)保持严格无容错——审计结论登记,未并入。
- `plugin-sync.ts` resolvePnpmBinDir:增补 Linux 官方安装根
  `~/.local/share/pnpm`、`~/.local/bin`(XDG_DATA_HOME 偏移的 pnpm home 未覆盖,
  登记为低优;macOS ~/Library/pnpm 超出 Linux 范围)。
- 已知未动(登记):托盘图标候选两死路径(跨平台既有 P2,见 STATUS)、gateway 裸
  CLI 默认 stateDir 与 control-plane standalone 共享 ~/.dsh-chamber(文档提示,
  见 STATUS)。

## 7. 不做 / 边界

- Linux 更新不引入 .blockmap 差分(全量下载,与 win/mac 现状一致)。
- 不为 Linux 增加执行面/认证面/权威源:控制面 loopback-only、渲染投影不变。
- 深链/托盘/通知/焦点等 DE 相关行为只能在真实桌面验收(§8),无头 CI 只保证
  fail-soft 与打包正确性。
- 不把 win32 门控反向铺到 Linux(如 launchAtLogin/askpass/运行时 mutation)。

## 8. 剩余验收(实机门禁,登记 STATUS)

真实 Linux 桌面矩阵(Ubuntu 22.04/24.04 GNOME X11+Wayland、KDE 抽验):
XDG_CONFIG_HOME 定制自启(目录解析已单测,DE 生效待验)、深链冷/热启动、
**CHROME_DESKTOP 路由与升级/迁移后重注册**(含 xdg-mime default 指向)、托盘
可见性(AppIndicator)、通知点击、safeStorage 有无 keyring、SSH 密码全链、本地
运行时安装/切换/apply-now/restartLocal 打包态全链、**自动更新端到端(已下载→
退出→$APPIMAGE 原位替换→重启为新版;stable+beta;二次更新)**、AppImage 沙箱
(userns/--no-sandbox)、Wayland 焦点。userData 目录名已在无头机实测
(`~/.config/@dsh-chamber/desktop`,功能无碍;统一为 dsh-chamber 属可选优化)。
