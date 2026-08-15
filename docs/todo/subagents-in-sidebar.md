# todo · session 的 subagents 在侧边栏中的显示

> 状态：**想法**（未设计、未排期）。记录于 2026-08-16。

## 动机

侧边栏目前只按来源分组展示 session / workspace 行（`docs/design/06-sidebar-enhancements.md`）。
会话运行时产生的 subagents（子代理）只能在会话内部看到；希望在侧边栏也能看到
它们——会话行下的子层级 / 计数 / 状态，便于跨会话总览与快速定位。

## 现状对照

- 侧边栏 = 每来源分组 + workspace / 未分组桶 + session 行（06 定稿）；行尾
  状态槽只表达 running / completed / pending（06 §4.3）。
- **宿主覆盖情况需调研**：在 vendored dsh 包中未检索到 `subagent` 命名的
  事实面（wire / store / UI）。需要先确认宿主前端是否以其他命名（如 agents /
  children / 会话详情 unary）暴露该事实；若宿主无此面，按 08 的先例评估
  形态（chamber 插件 vs 不做）——插件绝不重造 dsh 宿主执行面。

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
