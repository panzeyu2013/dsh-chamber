# primary-runtime（python 载荷目录）

本目录是 python 载荷（上游 primary runtime 的 python 半边）的落点，两份 flavor 共用同一份内容：

- Electron：`build.extraResources` 投递到 `<resourcesPath>/primary-runtime`；
- Swift：`build:sidecar` 拷到装配目录的 `primary-runtime/`，随 `build:swift-app` 进
  `Contents/Resources/sidecar/primary-runtime`。

**只提交本说明文件**。真实载荷（`runtime.json` + `dependencies/python/**`）由显式构建腿生成，
不随仓库提交：

```sh
# 无网演练（只校验锁与布局）：
node packages/desktop/scripts/prepare-python-payload.mjs --dry-run --target mac-arm64
# 真实下载 + sha256 校验 + 落位（需要网络；版本与摘要的唯一来源是
# packages/desktop/primary-runtime-lock.json）：
node packages/desktop/scripts/prepare-python-payload.mjs --target mac-arm64
# 完整性判定（缺 runtime.json / 缺解释器 / 缺任一锁定发行版即红）：
node packages/desktop/scripts/prepare-python-payload.mjs --verify packages/desktop/resources/primary-runtime
```

发布腿在打包前跑 prepare、打包后用 `--verify` 对**已打包 bundle 内的路径**复核；
`build:sidecar --require-python` 让 Swift 腿的缺件也 fail-closed。
载荷的消费者口径见 `docs/design/25-macos-swift-native-shell.md` 与
`docs/progress/swift-vs-upstream-differences.md` §5.2：上游不做 env 注入，
而是用宿主工具 `load_workspace_dependencies` 把绝对路径交给模型；本仓尚未运行
上游 desktop-host 的 office 组装，故当前语义是「随包存在」，由发布腿的完整性校验兜底。
