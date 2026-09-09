# todo · session 的 subagents 在侧边栏中的显示

> 状态：**想法**（未设计、未排期）。记录于 2026-08-16。

## 动机

侧边栏目前只按来源分组展示 session / workspace 行（`docs/design/06-sidebar-enhancements.md`）。
会话运行时产生的 subagents（子代理）只能在会话内部看到；希望在侧边栏也能看到
它们——会话行下的子层级 / 计数 / 状态，便于跨会话总览与快速定位。

## 现状对照

- 侧边栏 = 每来源分组 + workspace / 未分组桶 + session 行（06 定稿）；行尾
  状态槽表达 running / completed / pending，且 **06 §4.5（2026-08）已实现
  `runningSubagents` 计数徽标**（会话行尾「N 个子代理运行中」圆环 + tooltip，
  经运行时事实通道上报）——本 todo 的"计数 / 状态徽标"解读已被覆盖。
- **剩余开放范围**（06 未做）：会话行下**嵌套子层级**（subagent 行缩进显示
  子代理自身的状态/会话）与**层级折叠 / 截断**、跨会话总览视图。
- **宿主覆盖情况（2026 审计结论，原"需调研"问句已闭合）**：计数解读已由
  运行时事实通道落地（06 §4.5：`runningSubagents` 每父会话计数 + tooltip，
  经 vendor `indexSubagentDescendants` 路由），**逐子代理的可浏览行级列表
  面仍不存在**（未发现以其他命名暴露逐项事实的 wire / store / UI）——
  嵌套行/总览解读保持未排期（见上），形态评估（chamber 插件 vs 不做）
  留待设计时按 08 先例定夺。

## 开放问题（设计时再定）

- 事实来源与拉取节奏：聚合轮询 / 运行时通道（06 §4.2 chamberBridge runtime
  report）/ 会话详情按需。
- 呈现形态：会话行下嵌套 subagent 行（缩进）、行尾徽标计数、还是仅当前
  会话内面板（会话内若已有，侧边栏是否必要）。
- 层级深度（subagent 的 subagent）与大量 subagent 时的折叠 / 截断。
- 跨来源投影（远程实例的 subagent 在本地侧边栏的呈现）与断连清理。

## 关联

- `docs/design/06-sidebar-enhancements.md`（侧边栏形态、运行时事实通道）
- `docs/progress/STATUS.md`（"不做（v1）"清单）
