# 决策记录（ADR）

> 记录跨域 / 架构决策：背景、决定、被否方案、后果。ADR 不可变；只追加新记录或把旧记录标为 `superseded` / `deprecated`。契约正文仍在 owning design；ADR 只链接，不复制。

## 状态

| 状态 | 含义 |
|---|---|
| proposed | 提议中，未作为现行约束 |
| accepted | 已采纳，现行有效 |
| superseded | 被新 ADR 取代（链接新 ADR） |
| deprecated | 仍记录但不再推荐 |
| rejected | 已否决，保留理由 |

## 索引

| ADR | 标题 | 状态 |
|---|---|---|
| [ADR-0001](./0001-docs-layered-by-type-and-stage.md) | 文档按类型与生命周期分层 | accepted |
| [ADR-0002](./0002-swift-only-flavor.md) | 唯一出货 flavor = macOS Swift 原生壳 | accepted |
| [ADR-0003](./0003-remote-browser-v2-iframe.md) | 右栏浏览器 v2：上游 iframe path fork + SSH alias | accepted |

## 何时写 / 不写

- 写：跨包或跨域边界、协议/形态取舍、发布/平台范围、治理流程；影响超过一个 design 或一个包。
- 不写：单包内部实现细节（放 design / 代码注释）、进度与验收（STATUS）、可机械核对的清单（单源脚本）。
- 模板：[`_template.md`](./_template.md)。
