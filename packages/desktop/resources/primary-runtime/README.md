# primary-runtime（primary runtime 载荷目录）

本目录是上游 primary runtime 载荷在本仓的**构建机落点**，内容由显式构建腿生成、不随仓库提交
（**只提交本说明文件**）。`resources/office-skills/` 是它的 sibling：Office 技能资产目录
（见 [office-skills](../office-skills/README.md)），由独立的 `prepare:office-assets` 生成。

## 内容与两份 flavor 的差别

**python-only（默认；Electron 打包腿）**：`runtime.json` + `dependencies/python/**`（CPython 解释器
+ 平台轮子/site-packages）。Electron 经 `build.extraResources` 投递到
`<resourcesPath>/primary-runtime`；本仓 Electron 分支当前没有启动行消费者（该分支未来移除，本轮
不接线）。

**full（Swift 本地腿）**：`prepare-python-payload.mjs --with-node --with-pnpm` 追加 node/pnpm；
`build:sidecar` 把它拷到 `<sidecar>/primary-runtime`（与 `<sidecar>/office-skills`、`sidecar.js`
平级），随 `build:swift-app` 进 `Contents/Resources/sidecar/primary-runtime`。Swift 用其中的
`dependencies/node/bin/node` 启动 `sidecar.js`，托管 dsh 用同一 `process.execPath`（细节见
`docs/design/25-macos-swift-native-shell.md` §3.2/§4.3）。

```
primary-runtime/
  runtime.json                  # 载荷清单（legacy components + pythonPackages + payloadDigest + layout）
  dependencies/
    python/                     # bin/python3、lib/pythonX.Y/site-packages（默认 / Electron）
    node/                       # bin/node、LICENSE、node_modules/README.txt（仅 --with-node / --with-pnpm）
    pnpm/                       # package.json、bin/pnpm.mjs、dist/**（仅 --with-pnpm）
```

## 命令

```sh
# 无网演练（只解析锁与布局；不联网、不写盘）：
node packages/desktop/scripts/prepare-python-payload.mjs --dry-run --target mac-arm64
# python-only（Electron 打包腿；版本与摘要的唯一来源 = packages/desktop/primary-runtime-lock.json）：
node packages/desktop/scripts/prepare-python-payload.mjs --target mac-arm64
# full（Swift 本地腿；--with-pnpm 隐含 --with-node）：
node packages/desktop/scripts/prepare-python-payload.mjs --target mac-arm64 --with-node --with-pnpm
# 完整性判定（缺 runtime.json/解释器/锁定发行版，或声明了 node/pnpm 而构件缺失即红）：
node packages/desktop/scripts/prepare-python-payload.mjs --verify packages/desktop/resources/primary-runtime
```

- **版本单源**：node 归档版本 + sha256、CPython 与 wheel 坐标来自 `primary-runtime-lock.json`；
  pnpm 版本读 desktop `package.json` 的 `dependencies.pnpm`（与设计 18 §4 的内嵌 pnpm 同一
  pin；仓库声明单源是根 `packageManager`，`pnpm-pin` 门禁锁步）。pnpm 从构建机
  `node_modules/pnpm` dereference 拷入（`--pnpm-source <dir>` 可显式注入），并 prune
  `dist/node_modules` 下与目标 platform/arch 不符的 optional 原生包。
- `--dry-run` / `--verify` 都不联网；真实下载只在显式 prepare 时发生。
- Office 资产是另一个命令的产物：`node packages/desktop/scripts/prepare-office-assets.mjs`
  （`--verify packages/desktop/resources/office-skills` 复核）。

## 安装语义（app 内只读源）

载荷的消费者是上游 `@deepseek-ai/dsh-tool-workspace-dependencies`，由本地启动行以
`config {source: <本目录>, root: <DSH_HOME>/dsh-runtimes/dsh-primary-runtime}` 挂载（启动行契约
见 `docs/design/09-client-plugin-runtime-loading.md` §3.5，载荷形状见
`docs/design/18-dsh-runtime-version.md` §4.2）。首次 `load_workspace_dependencies` 调用把 app 内
这份**只读**载荷复制到 `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime`，返回安装后的绝对路径；
app 内文件不被修改。上游不经 PATH/env 暴露资源——路径由工具返回值显式交给模型。

## 发布腿

- Swift 腿：`prepare-python-payload --with-node --with-pnpm` → `prepare-office-assets` →
  `build:sidecar --require-python --require-node --require-pnpm --require-office-assets` →
  `build:swift-app` → 对打包后的 `Contents/Resources/sidecar/primary-runtime` 与
  `.../office-skills` 再跑 `--verify`；
- Electron 腿保持原样：默认 python-only payload + `extraResources`，打包后对
  `<...>/Resources/primary-runtime` 跑 `--verify`；
- CI 的 compiled-sidecar smoke 用 `build:sidecar --skip-node`（调用者 node 启动 `sidecar.js`，
  本次不要求 payload node）。
