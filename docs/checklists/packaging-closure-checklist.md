# 打包完整性 Checklist（packaging closure）

> 触发时机：**新增/移动/重命名 desktop 主进程模块**，或改动任一打包产物路径 /
> 构建脚本 / `build.files` / `extraResources` 后执行。
> 依据：`packages/desktop/package.json` `build.files` / `extraResources` /
> `build.beforePack`、`packages/desktop/main.ts`、`packages/desktop/scripts/build-*.mjs`、
> `docs/design/05-connection-manager.md` §6。

## 1. 主进程模块闭包

- [ ] 计算 `packages/desktop/main.ts` 的**传递本地 import 闭包**（静态 import 与
      动态 `import()` 都要，含变量拼接路径如 `controlPlaneEntrySpecifier` 的
      定义），闭包中每个文件逐一核对是否在 `build.files` 清单内
      （`dist/**/*` 只覆盖 dist 下产物）。
- [ ] 新增主进程模块时，把「已进 build.files 清单」写入该模块头注释或 PR 描述。
- [ ] 核对 `main.ts` 的所有运行时文件路径引用：preload 路径
      （`dist/preload.cjs` vs `preload.cts` 回退分支）、控制面编译产物
      （`dist/control-plane/index.js`）、图标/tray 资源、crashReporter 目录、
      `existsSync`/`readFileSync` 引用的打包内文件。
- [ ] 核对 `preload.cts` 的本地依赖闭包（若有跨文件 import，确认编译产物
      `dist/preload.cjs` 已包含或文件在清单内）。
- [ ] 核对 `extraResources`：`vendor/dsh` 两段（manifest 三件套 +
      `node_modules/**`）与 `bundle-dsh.mjs` 产物、`spawn-dsh.ts` 运行时解析
      路径一致。

## 2. 构建链产物（改动构建脚本后必查）

- [ ] `build:control-plane`：`tsconfig.control-plane.build.json` 的 include
      覆盖 `packages/control-plane/src` 全部被 `index.ts` 传递引用的文件
      （新增源文件必须被编译进 `dist/control-plane/`）。
- [ ] `build:preload`：`tsconfig.preload.build.json` 输入与输出一致。
- [ ] `build:renderer`：`dist/assets/*` 与 `manifest.json` 的 entries 一一
      对应（`__DSH_BOOT__` 指向真实存在的 bundle）。
- [ ] host 包：`dsh-chamber-seed-client-graph` / `dsh-chamber-seed-git-worktree` 的
      `dist/index.js` 与 `host-graph-seed.ts` 的 seed 源路径一致；`package.json`
      `files` 含 dist。
- [ ] `build:desktop` 完整链在 `electron-builder` 前生成全部上述产物。

## 3. 打包态冒烟

- [ ] 打包产物**启动冒烟**：spawn 安装包/应用 → 等待主窗口出现 → 确认无
      `ERR_MODULE_NOT_FOUND` 等启动期异常 → 退出（信号路径与正常退出均验证
      资源回收）。
- [ ] 变更 `build.files` 后，mac + win 双平台打包产物内容抽查（app.asar 内
      文件列表 vs 模块闭包；打包链校验在 tag 触发的 release.yml 构建腿执行，
      改动后先用 `workflow_dispatch` dry_run 验证）。
- [ ] asar 内含 `node_modules/ws`（控制面编译产物 `dsh-client.ts` 的
      `await import('ws')` 依赖；2026-09 审计 P2-6 验证项）。
- [ ] afterPack 的 asar 断言**先归一化路径分隔符再比较**（`@electron/asar`
      `listPackage` 在 Windows 宿主返回反斜杠条目）。
- [ ] `build.beforePack` 钩子模块**导出默认函数**（electron-builder 直接调用）。
- [ ] `@dsh-chamber/dsh-runtime` 经 `build.beforePack`（`scripts/before-pack.mjs`）
      物化进 node_modules（`files` 的 `from/to` 映射对 node_modules 目标无效，
      勿回归）。
- [ ] 该物化是**进程内临时态**：`before-pack` 的默认导出必须在物化**之前**注册
      退出还原（含 SIGINT/SIGTERM/SIGHUP），使成功、失败与中断的打包都还原 pnpm 的
      workspace 链接（`before-pack.test.mjs` 用子进程覆盖退出路径）。不还原会让开发树
      永久丢掉 dsh-runtime 的类型面（`pnpm typecheck` 以 TS7016 失败，
      `pnpm install --frozen-lockfile` 修不回来）。

## 4. 快速清单速查（当前基线，2026-12 复核）

**glob 即闭包**：`packages/desktop/package.json` 的 `build.files` 用包根三条 glob
`*.ts` / `*.cts` / `*.mjs` 收取**全部**根级源模块（另含 `dist/**/*` 与
`package.json`）。新增根级运行模块因此**自动进包**——纪律落在「例外名单」而不是
「逐个补录」，需要人工保证的只有两件事：

1. 新增根级模块不得命中下面的 9 条 negate（尤其：测试文件必须用 `*.test.ts`
   后缀，否则会被打进包）；
2. `main.ts` / `preload.cts` 的传递 import 闭包不得指到 `scripts/`、`vendor/` 或
   未编译的 `node_modules/@dsh-chamber/control-plane/**`（见 §1、§2）。

当前被收取的根级模块（**37 个**，2026-12 全量核对；含 1 个仅被测试引用的惰性
模块 `registry-password-commit.ts`，随 glob 进包但无运行引用）：

`main.ts`、`preload.cts`、`control-plane-module.ts`、`ipc-events.ts`、
`apply-now-gate.ts`、`audit-log.ts`、`badge.ts`、`bounded-lines.ts`、
`chamber-settings.ts`、`connection-save.ts`、`credential-binding.ts`、`deep-link.ts`、
`disk-evidence-gate.ts`、`dsh-runtime-controller.ts`、`free-port.ts`、
`gateway-ipc-shared.ts`、`gateway-provider.ts`、`gateway-session-refresh.ts`、
`gateway-session.ts`、`gateway-sync-registry.ts`、`notifications.ts`、`open-in.ts`、
`owner-only-secret-file.ts`、`plugin-sync.ts`、`plugin-tarball.ts`、
`registry-password-commit.ts`、`renderer-trust.ts`、`sanitize-error.ts`、
`ssh-apply-rows.ts`、`ssh-config.ts`、`ssh-plugin-journal.ts`、`ssh-provider.ts`、
`store-file-hygiene.ts`、`transport-manager.ts`、`transport-provider.ts`、`updater.ts`、
`win-acl.ts`

复核命令（与 glob 同义，扣除 `!*.test.ts` 与两条测试夹具 negate）：

```sh
ls -1 packages/desktop/*.ts packages/desktop/*.cts packages/desktop/*.mjs \
  | grep -vE '\.test\.ts$|/(gateway-session-test-hooks|loopback-http-test-server)\.ts$'
```

**例外名单 = `build.files` 的 9 条 negate（勿删；顺序同 package.json）**：

| negate | 原因 |
|---|---|
| `!*.test.ts` | 30 个根级测试；`*.ts` glob 会收它们，只能靠后缀排除 |
| `!gateway-session-test-hooks.ts` | 测试夹具，仅 `gateway-session.test.ts` 引用 |
| `!loopback-http-test-server.ts` | 测试夹具（回环 HTTP 测试服务器） |
| `!dist/**/*.map` | source map 不随包（2026-09 P2，见 §5） |
| `!node_modules/@dsh-chamber/control-plane/**` | 用 `dist/control-plane` 编译产物替代 TS 源码（node_modules 内 .ts 无类型擦除） |
| `!dist/.vite/**` | vite 内部产物（2026-09 审计 P2-2） |
| `!vendor/**` | vendored dsh workspace 经 `extraResources` 投递，不进 asar |
| `!scripts/**` | 构建期脚本（`beforePack` / `build:*` 由 electron-builder 从开发树执行），不需要随包 |
| `!README.md` | 包内文档不随包 |

## 5. 2026-09 打包闭包审计 P2（2026-12 复核：全部关闭）

**已解决**：

- ~~preload 编译带出 3 个死文件~~（build-preload.mjs 改为临时目录 emit +
  只搬入 preload.cjs，2026-09 修复）。
- ~~lockfile 残留 @simplewebauthn/server 孤儿记录~~（2026-09 死依赖移除时
  一并剪除）。
- ~~托盘图标死候选~~（2026-12 复核：候选已收敛为**唯一**真实打包资源
  `resourcesPath/icon.png`——`packages/desktop/main.ts:764-766`；找不到时 loud
  记日志并跳过托盘，`main.ts:768-771`。图标投递只有 `extraResources` 的
  `resources/icon.png → icon.png` 一条）。
- ~~preload 静默回退~~（2026-12 复核：回退分支已删——`packages/desktop/main.ts:1333-1346`
  只解析 `dist/preload.cjs`，缺失即 loud `dialog.showErrorBox` + `app.exit(1)`，
  不再回退 `preload.cts`）。
- ~~源码映射随包发布~~（2026-12 复核：`build.files` 已含 `!dist/**/*.map`）。
- ~~共享 dist 目录~~（2026-12 复核：vite 的 outDir 已是 `../desktop/dist/web`
  ——`packages/renderer/vite.config.mjs:227-228`，而 vite 6.4.3 的 `emptyOutDir`
  只清空解析后的 outDir 本身（`node_modules/vite/dist/node/chunks/dep-*.js` 的
  `emptyDir(outDir, …)` 调用点），因此单独跑 `build:renderer` 不会再删掉
  `dist/preload.cjs` / `dist/control-plane/` / host 包产物。**仅在 outDir 改回
  `dist` 本身时才重新触发此条**）。

**仍开放**：无。

> 教训：手工维护 `files` 清单易漏——新增主进程模块时，把「进清单」写进
> 模块头注释或 PR 描述；长期建议在 CI 加"模块闭包 vs files 清单"自检脚本。
