# ADR-0002：唯一出货 flavor = macOS Swift 原生壳

- 状态：accepted
- 日期：2026-11-08

## 背景

2026-11 用户裁决：macOS Swift 原生壳 + 打包 Node sidecar 是唯一出货 flavor；Electron flavor 冻结归档。范围、归档清单、仍共享的契约与复活步骤已有单一登记面。

## 决定

开发、门禁、发布与文档维护只以 **macOS Swift + 共享契约**为范围；Electron 入口/边沿、Electron 打包/更新/Windows/Linux 发布腿与默认测试组中的 Electron-only 测试退出默认路径。冻结不删除文件；复活需用户重新裁决并按登记面执行。

## 被否方案

- **双 flavor 并行维护**：否决——发布与测试成本翻倍，且 Swift 腿是当前唯一出货面。
- **删除 Electron 代码与文档**：否决——保留可复活形态；历史与差异登记仍有价值。

## 后果

- Electron 面默认不改、不「顺手同步」；跨 flavor 共享契约仍由 Swift 腿与共享包维护。
- 范围细节、禁令与复活清单只在 [`progress/electron-frozen.md`](../../progress/electron-frozen.md) 维护；本 ADR 不复制。
- owning design：[`desktop/25-macos-swift-native-shell.md`](../desktop/25-macos-swift-native-shell.md)；范围规则见根 [`AGENTS.md`](../../../AGENTS.md)。
