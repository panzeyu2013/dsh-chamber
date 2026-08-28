# 打包完整性 Checklist（packaging closure）

> 面向维护者/发布者：每次**新增/移动/重命名 desktop 主进程模块**、或改动
> 任一打包产物路径后执行。目的：防止"运行时引用的文件不在打包清单内"类
> 缺陷（2026-09 教训：`notifications.ts` 漏列于 `build.files`，打包态应用
> 启动即 `ERR_MODULE_NOT_FOUND`——该文件被 `main.ts` 静态 import 而
> electron-builder 自定义 `files` 清单替换默认 `**/*`，未列出的文件不进
> app.asar）。
>
> 依据：`packages/desktop/package.json` `build.files` / `extraResources`、
> `packages/desktop/main.ts`（入口，Node 22 原生类型擦除运行 .ts）、
> `packages/desktop/scripts/build-*.mjs` 构建链、`docs/design/05-connection-manager.md` §6。

## 1. 主进程模块闭包（每次必查）

- [ ] 计算 `packages/desktop/main.ts` 的**传递本地 import 闭包**（静态 import
      与动态 `import()` 都要，含变量拼接路径如 `controlPlaneEntrySpecifier`
      的定义），对闭包中每个文件逐一核对是否在 `build.files` 清单内
      （`dist/**/*` 只覆盖 dist 下产物）。
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

## 3. 打包态冒烟（发布前必做）

- [ ] 打包产物**启动冒烟**：spawn 安装包/应用 → 等待主窗口出现 →
      确认无 `ERR_MODULE_NOT_FOUND` 等启动期异常 → 退出（信号路径与正常
      退出均验证资源回收）。
- [ ] 变更 `build.files` 后至少做一次 mac + win 双平台打包产物内容抽查
      （app.asar 内文件列表 vs 模块闭包）。
- [ ] asar 内含 `node_modules/ws`（控制面编译产物 `dsh-client.ts` 的
      `await import('ws')` 依赖；2026-09 审计 P2-6 验证项）。

## 4. 快速清单速查（当前基线，2026-09）

`build.files` 以根级 `*.ts` / `*.cts` glob 收取，并用 `!*.test.ts` 排除测试；
当前运行闭包包括：

- `main.ts`、`preload.cts`、`control-plane-module.ts`、`wiring.ts`、
  `ipc-events.ts`、全部 `ipc-*.ts`，以及 `updater.ts`、
  `chamber-settings.ts`、`transport-provider.ts`、`transport-manager.ts`、
  `ssh-provider.ts`、`ssh-config.ts`、`renderer-trust.ts`、`plugin-sync.ts`、
  `deep-link.ts`、`notifications.ts`、`open-in.ts`；另含 `dist/**/*` 与
  `package.json`。新增根级运行模块会自动进入，新增测试必须保持
  `*.test.ts` 后缀。

已生效的排除（勿删）：

- `!node_modules/@dsh-chamber/control-plane/**`（用 dist/control-plane
  编译产物替代 TS 源码——node_modules 内 .ts 无类型擦除）。
- `!dist/.vite/**`（vite 内部产物，2026-09 审计 P2-2 加入）。

## 5. 2026-09 打包闭包审计已知 P2（择机处理，非阻塞）

**已解决**：

- ~~preload 编译带出 3 个死文件~~（build-preload.mjs 改为临时目录 emit +
  只搬入 preload.cjs，2026-09 修复）。
- ~~lockfile 残留 @simplewebauthn/server 孤儿记录~~（2026-09 死依赖移除时
  一并剪除）。

**仍开放**：

- **托盘图标死候选**（`main.ts` 托盘创建处）：`resourcesPath/icons/tray.png` 与
  `resourcesPath/tray.png` 永不存在（extraResources 只投递 `icon.png`），
  仅靠第三条兜底；`main.ts` 托盘注释已过期。建议补 tray.png 或删死候选。
- **源码映射随包发布**：`dist/**/*.map` 未被排除；可加 `!dist/**/*.map`
  （泄露风险低——renderer 源码本仓库开源）。
- **preload 回退分支**（`main.ts` preload 路径解析处）：`dist/preload.cjs` 缺失时回退
  `preload.cts` 在打包态沙箱内会 SyntaxError（纯 CJS、无类型擦除）——建议
  回退改 loud 报错。当前无实害：build:desktop 链总是先产出产物。
- **共享 dist 目录**：vite `emptyOutDir: true` 会清空 desktop/dist——
  `build:desktop` 链顺序安全，但单独跑 `build:renderer` 会删掉
  preload/control-plane/host 包产物（dev 有懒构建自愈）。

> 教训：手工维护 `files` 清单易漏——新增主进程模块时，把「进清单」写进
> 模块头注释或 PR 描述；长期建议在 CI 加"模块闭包 vs files 清单"自检脚本。
