# 打包完整性 Checklist（packaging closure）

> 触发：新增/移动/重命名desktop主进程模块，或改动任一打包产物路径 / 构建脚本 / `build.files` / `extraResources` 之后。依据：`packages/desktop/package.json` 的 `build.*`、`packages/desktop/main.ts`、`packages/desktop/scripts/build-*.mjs`、`docs/design/05-connection-manager.md` §6。本文件只写检查项；版本值与审计叙述见 `CHANGELOG.md` / git历史。

## 1. 主进程模块闭包

- [ ] 算 `packages/desktop/main.ts` 的传递本地import闭包（静态import与动态 `import()` 都要，含变量拼接路径如 `controlPlaneEntrySpecifier`），逐文件核对是否在 `build.files` 内（`dist/**/*` 只覆盖dist产物）。
- [ ] 新增主进程模块时，把「已进 `build.files`」写进该模块头注释或PR描述。
- [ ] 核对 `main.ts` 的全部运行时路径引用：preload（`dist/preload.cjs`，无 `preload.cts` 回退）、`dist/control-plane/index.js`、图标/tray、crashReporter目录、`existsSync`/`readFileSync` 引用的打包内文件。
- [ ] 核对 `preload.cts` 本地依赖闭包（有跨文件import时 `dist/preload.cjs` 必须包含）。
- [ ] 核对 `extraResources`：`vendor/dsh` 两段（manifest三件套 + `node_modules/**`）与 `bundle-dsh.mjs` 产物、`spawn-dsh.ts` 的运行时解析路径一致。
- [ ] 上游client-plugin闭包抽样：afterPack断言 `resources/vendor/dsh/node_modules/@deepseek-ai/` 下 `dsh-client-ui-sidebar-right`（sidebarRight行唯一provider）/ `dsh-client-resources` / `dsh-client-ui-chat` 三个包的 `package.json` 都在（`after-pack-adhoc-sign.mjs` 的 `PACKAGED_CLIENT_CLOSURE_SAMPLE`）—— `node_modules/**` 是无界glob，缺一个上游包时安装/打包全绿、前端只在运行期静默少一行；启动期 `runtime-tree-check.ts` 对已安装树做同一抽样，缺件大声 `console.error`。

## 2. 构建链产物（改构建脚本后必查）

- [ ] `build:control-plane`：`tsconfig.control-plane.build.json` 的include覆盖 `index.ts` 传递引用的全部源文件。
- [ ] `build:preload`：`tsconfig.preload.build.json` 输入与输出一致。
- [ ] `build:renderer`：`dist/assets/*` 与 `manifest.json` entries一一对应（`__DSH_BOOT__` 指向真实bundle）。
- [ ] host包：四个 `dsh-chamber-seed-*` 的 `dist/index.js` 与 `host-graph-seed.ts` 的seed源路径一致、`files` 含dist；前三个随 `build:host-graph-package` 拷进 `desktop/dist/host-*-package`（远端seed与gateway上传同源）；**open-in的 `dist/host-open-in-package` 只供本地控制面seed**（`chamberHostSourceDirs` 刻意不含该行，registry `localOnly`，design 20 §6）——打包后确认远端/网关目标收不到它。
- [ ] `build:desktop` 完整链在electron-builder前生成全部上述产物。

## 3. 打包态冒烟

- [ ] 产物启动冒烟：spawn安装包/应用 → 主窗口出现 → 无 `ERR_MODULE_NOT_FOUND` 等启动期异常 → 退出（信号路径与正常退出都验证资源回收）。
- [ ] 改 `build.files` 后mac + win双平台抽查asar文件列表vs模块闭包；打包链校验在tag触发的release.yml构建腿执行，改动后先用 `workflow_dispatch` dry_run验证。
- [ ] asar内含 `node_modules/ws`（控制面编译产物 `dsh-client.ts` 的 `await import('ws')`）。
- [ ] afterPack的asar断言先归一化路径分隔符再比较（`@electron/asar` 在Windows宿主返回反斜杠条目）。
- [ ] `build.beforePack` 钩子模块导出默认函数（electron-builder直接调用）。
- [ ] `@dsh-chamber/dsh-runtime` 经 `before-pack.mjs` 物化进node_modules（`files` 的 `from/to` 对node_modules目标无效，勿回归）；物化是进程内临时态：默认导出必须在物化之前注册退出还原（SIGINT/SIGTERM/SIGHUP全覆盖），使成功、失败与中断的打包都还原pnpm的workspace链接（`before-pack.test.mjs` 用子进程覆盖退出路径）——不还原会让开发树永久丢掉dsh-runtime的类型面（`typecheck` TS7016，`pnpm install --frozen-lockfile` 修不回来）。

### 3.1 原生壳（`macos/`）专属检查

- [ ] `build:sidecar` 载荷完整：`node`（官方tar + SHA校验）、`dist/web`、四个host包、`vendor/dsh`、内嵌 `pnpm` 全部就位（缺项fail-closed；`--skip-*` 只用于本地试跑）。
- [ ] `build:swift-app` 装配：`Contents/Resources/sidecar`、`Sparkle.framework` 嵌入 `Contents/Frameworks`、rpath指向 `@executable_path/../Frameworks`、bundle内无逃逸符号链接、`codesign --verify --deep --strict` 通过；资源包形态随后端（native 扁平 / swiftbuild `Contents/Resources`）由装配归一为扁平，缺 `bridge-shim.js` 即 loud；`--dry-run` 必须能报出解析后的路径/feed/产物名计划。
- [ ] 产物命名与形态：`dsh-chamber-<ver>-macos-arm64.{dmg,zip}` 与Electron产物共存不覆盖；两侧release腿按精确产物名验证/上传（不再 `find|head` 或glob），避免复用输出目录带入旧版本。
- [ ] 更新腿装配：`CFBundleShortVersionString`/`CFBundleVersion` 与tag一致，且beta与同基版本正式号不同、单调；`SUFeedURL` 按通道注入；`SUPublicEDKey` 与appcast签发私钥**必须成对**（公钥在而私钥缺、私钥在而公钥缺都是发布 FAIL；只有两把都缺才是 loud 降级「更新腿关闭」）；beta appcast的beta条目enclosure指向滚动release上真实存在的zip与`*.delta`（先传归档后传appcast），合并进来的final条目在beta腿指向版本固定的`releases/download/v<正式版tag>/`（不用会被后续正式版移走的`releases/latest`），stable刷新后则改指滚动前缀（两条路径不同）；滚动appcast同时带当前beta与最新final条目（没有keyed final时loud降级）。
- [ ] `LSMinimumSystemVersion` 与Electron `build.mac.minimumSystemVersion`、`Package.swift` 平台声明三处同源一致（数值由 `scripts/release/release-workflow-policy.test.mjs` 钉住；SwiftPM只能写major平台，精确下限由 `Info.plist.template` 承担——本清单不记版本数值）。
- [ ] 打包态启动冒烟（原生腿）：双击 `.app` → sidecar spawn → 页面加载 → 关窗仅隐藏 → 退出回收sidecar（本机/CI任一环境执行并记录证据；CI目前不启动打包产物）。
- [ ] 视口越界策略实机目检：滚到端点 / 停在不可滚动chrome上滚动，确认整页不平移（无自动化探针，判据见design 25 §5.2）。
- [ ] DMG与zip均公证 + `stapler staple` + `stapler validate`（DMG卷本身也要装订）。
- [ ] DMG拖拽引导：卷内 `.background/background.tiff` 存在、`/Applications` 是指向 /Applications的软链；背景资产保持electron-builder同款双rep TIFF（540×380@72dpi + 1080×760@144dpi，Retina清晰）；`macos/scripts/dmg.mjs` 产完即**内容级**自校验——只读挂载成品读 `.DS_Store`：`backgroundType=2`、非空且指向卷内背景图的别名、`iconSize`、窗口尺寸、两条图标坐标（`.DS_Store`/`.background` 的存在性只是前置；失败loud，不发无提示卷）；实机目检一次：打开卷 = 背景箭头 + 两个图标就位。

## 4. 快速清单速查（`build.files` 复核用）

glob即闭包：`packages/desktop/package.json` 的 `build.files` 用包根三条glob `*.ts` / `*.cts` / `*.mjs` 收全部根级源模块（另含 `dist/**/*` 与 `package.json`）。新增根级运行模块自动进包，纪律落在「例外名单」而不是「逐个补录」，需人工保证的只有两件事：

1. 新增根级运行模块不得命中下面的9条negate。测试的常规位置是 `packages/desktop/test/<domain>/`（包根三条glob不收取）；例外：9个Swift/POC专属测试（bridge-manifest / bridge-shim / bridge-shim-surface / chamber-lock / chamber-lock-wiring / electron-free-gate / node-edges / sidecar-stdio / update-headless）留在包根——由 `scripts/test.mjs` 清单显式接线、`ci.yml` 的 `test-macos` 桥面锁步步骤按包根路径调用，故 `!*.test.ts` negate载荷相关（勿删）；
2. `main.ts` / `preload.cts` 的传递import闭包不得指到 `scripts/`、`vendor/` 或未编译的 `node_modules/@dsh-chamber/control-plane/**`（见 §1、§2）。

被收取的根级模块（含1个仅被测试引用的惰性模块 `registry-password-commit.ts`，随glob进包但无运行引用）：

`main.ts`、`preload.cts`、`control-plane-module.ts`、`ipc-events.ts`、
`apply-now-gate.ts`、`audit-log.ts`、`badge.ts`、`bounded-lines.ts`、
`chamber-lock.ts`、`chamber-settings.ts`、`connection-save.ts`、
`credential-binding.ts`、`deep-link.ts`、`disk-evidence-gate.ts`、
`dsh-runtime-controller.ts`、`electron-edges.ts`、`free-port.ts`、
`gateway-ipc-shared.ts`、`gateway-provider.ts`、`gateway-session-refresh.ts`、
`gateway-session.ts`、`gateway-sync-registry.ts`、`host-package-dirs.ts`、
`node-edges.ts`、
`notifications.ts`、`open-in.ts`、`owner-only-secret-file.ts`、`plugin-sync.ts`、
`plugin-tarball.ts`、`pnpm-launcher.ts`、`sidecar-stub.ts`、`registry-password-commit.ts`、
`renderer-trust.ts`、`runtime-probe-detail.ts`、`runtime-tree-check.ts`、`sanitize-error.ts`、
`shell-core.ts`、`sidecar-console-redirect.ts`、`sidecar-ctx.ts`、
`sidecar-entry.ts`、`sidecar-exit-codes.ts`、`ssh-apply-rows.ts`、`ssh-config.ts`、
`ssh-plugin-journal.ts`、`ssh-provider.ts`、`store-file-hygiene.ts`、
`transport-manager.ts`、`transport-provider.ts`、`update-headless.ts`、`updater.ts`、
`win-acl.ts`

复核命令（与glob同义，扣除两条测试夹具negate与包根 `.test.ts`；自检式：输出必须等于上方名单的模块数，名单与计数同改，任一漂移即红）：

```sh
count=$(ls -1 packages/desktop/*.ts packages/desktop/*.cts packages/desktop/*.mjs \
  | grep -vE '/(gateway-session-test-hooks|loopback-http-test-server)\.ts$' \
  | grep -vc '\.test\.ts$')
echo "root-level collected modules: $count"
test "$count" = 51 || { echo "STALE: 名单/计数需同步（见上方 51 个）"; exit 1; }
```

**例外名单 = `build.files` 的9条negate（勿删；顺序同package.json）**：

|negate|原因|
|---|---|
|`!*.test.ts`|载荷相关：常规测试在 `test/<domain>/`，9个Swift/POC专属根级测试留在包根、靠后缀排除（清单见本节）；勿删|
|`!gateway-session-test-hooks.ts`|测试夹具，被 `test/gateway/gateway-session-spki.test.ts`、`test/gateway/gateway-provider.test.ts`、`test/transport/ssh-provider-endpoint-auth.test.ts` 引用（可执行路径不受 `!*.ts` 收包glob影响）|
|`!loopback-http-test-server.ts`|测试夹具（回环HTTP测试服务器）|
|`!dist/**/*.map`|source map不随包|
|`!node_modules/@dsh-chamber/control-plane/**`|用 `dist/control-plane` 编译产物替代TS源码（node_modules内 .ts无类型擦除）|
|`!dist/.vite/**`|vite的临时构建目录|
|`!vendor/**`|vendored dsh workspace经 `extraResources` 投递，不进asar|
|`!scripts/**`|构建期脚本（`beforePack` / `build:*` 由electron-builder从开发树执行），不需要随包|
|`!README.md`|包内文档不随包|
