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
- [ ] host 包：`dsh-host-client-graph` / `dsh-chamber-host-git-worktree` 的
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
      `await import('ws')` 依赖）。
- [ ] afterPack 的 asar 断言**先归一化路径分隔符再比较**（`@electron/asar`
      `listPackage` 在 Windows 宿主返回反斜杠条目）。
- [ ] `build.beforePack` 钩子模块**导出默认函数**（electron-builder 直接调用）。
- [ ] `@dsh-chamber/dsh-runtime` 经 `build.beforePack`（`scripts/before-pack.mjs`）
      物化进 node_modules（`files` 的 `from/to` 映射对 node_modules 目标无效，
      勿回归）。
- [ ] 核对 `build.files` 含以下根级模块与基线（随 §1 增删）：
      `main.ts`、`preload.cts`、`updater.ts`、`chamber-settings.ts`、
      `transport-provider.ts`、`transport-manager.ts`、`ssh-provider.ts`、
      `ssh-config.ts`、`renderer-trust.ts`、`plugin-sync.ts`、`deep-link.ts`、
      `notifications.ts`、`open-in.ts` + `dist/**/*` + `package.json`。
- [ ] 核对排除模式保持生效：`!node_modules/@dsh-chamber/control-plane/**`
      （node_modules 内 .ts 无类型擦除，用 dist/control-plane 产物替代）、
      `!dist/.vite/**`。
