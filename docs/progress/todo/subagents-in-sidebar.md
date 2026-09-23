# todo · session 的 subagents 在侧边栏中的显示

> 状态：想法（未设计、未排期）。记录于。

## 动机

侧边栏现只展示session/workspace行（`docs/design/06-sidebar-enhancements.md`）；会话运行时的subagents（子代理）仅会话内可见，望侧边栏给出子层级/计数/状态。

## 现状对照

- 侧边栏 = 每来源分组 + workspace/未分组桶 + session行（06定稿）；行尾状态槽表达running/completed/pending。
- 计数/状态解读已覆盖：06 §4.5已实现 `runningSubagents` 计数徽标（会话行尾「N个子代理运行中」圆环 + tooltip，经运行时事实通道上报；逐父会话计数经vendor `indexSubagentDescendants` 路由）。
- 剩余开放（06未做）：会话行下嵌套子层级（subagent行缩进显示其状态/会话）、层级折叠/截断、跨会话总览视图。
- 宿主覆盖（2026审计，原"需调研"已闭合）：逐子代理的可浏览行级列表面仍不存在（未发现其他命名暴露逐项事实的wire/store/UI）；形态评估（chamber插件vs不做）按08先例留待设计。

## 开放问题（设计时再定）

- 事实来源与拉取节奏：聚合轮询/运行时通道（06 §4.2 chamberBridge runtime report）/ 会话详情按需。
- 呈现形态：会话行下嵌套subagent行（缩进）、行尾徽标计数、还是仅当前会话内面板（会话内若已有，侧边栏是否必要）。
- 层级深度（subagent的subagent）与大量subagent时的折叠/截断。
- 跨来源投影（远程实例的subagent在本地侧边栏的呈现）与断连清理。

## 关联

- `docs/design/06-sidebar-enhancements.md`（侧边栏形态、运行时事实通道）
- `docs/progress/STATUS.md`（"不做（v1）"清单）
