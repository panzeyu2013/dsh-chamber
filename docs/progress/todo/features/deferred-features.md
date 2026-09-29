# todo · 延后功能（未排期想法）

> 分类：C · 未实现功能想法｜状态权威：STATUS「范围决策」相关条

> 定位：`docs/progress/todo/` 的未实现想法；设计定稿（形成契约）即移入 `docs/design/0X-*.md` 并从本文件移除，
> 落地或明确不做则移出（结论进 `docs/progress/STATUS.md`）。本文合并原 `subagents-in-sidebar.md` 与
> `open-in-superset-batches.md` 两个未排期想法，保留各自动机与边界；S4 与「复制 ssh/深链」已裁不做（结论在
> STATUS「open-in 超集口径」条），仍开放的是 S1/S2 与「复制路径」。

## 1. session 的 subagents 在侧边栏中的显示

> 未设计、未排期。

### 动机

侧边栏现只展示session/workspace行（`docs/design/06-sidebar-enhancements.md`）；会话运行时的subagents（子代理）仅会话内可见，望侧边栏给出子层级/计数/状态。

### 现状对照

- 侧边栏 = 每来源分组 + workspace/未分组桶 + session行（06定稿）；行尾状态槽表达running/completed/pending。
- 计数/状态解读由 06 §4.5 的 `runningSubagents` 计数徽标承担（会话行尾「N个子代理运行中」圆环 + tooltip，经运行时事实通道上报；逐父会话计数经vendor `indexSubagentDescendants` 路由）。
- 剩余开放（06未做）：会话行下嵌套子层级（subagent行缩进显示其状态/会话）、层级折叠/截断、跨会话总览视图。
- 宿主覆盖（原"需调研"项）：逐子代理的可浏览行级列表面仍不存在（未发现其他命名暴露逐项事实的wire/store/UI）；形态评估（chamber插件vs不做）按08先例留待设计。

### 开放问题（设计时再定）

- 事实来源与拉取节奏：聚合轮询/运行时通道（06 §4.2 chamberBridge runtime report）/ 会话详情按需。
- 呈现形态：会话行下嵌套subagent行（缩进）、行尾徽标计数、还是仅当前会话内面板（会话内若已有，侧边栏是否必要）。
- 层级深度（subagent的subagent）与大量subagent时的折叠/截断。
- 跨来源投影（远程实例的subagent在本地侧边栏的呈现）与断连清理。

### 关联

- `docs/design/06-sidebar-enhancements.md`（侧边栏形态、运行时事实通道）
- `docs/progress/STATUS.md`（"不做（v1）"清单）

## 2. open-in：超集分批（S1/S2/S3）与降级留档形态

> fork & supersede 的契约见
> `docs/design/20-open-in-registry.md`（§4契约、§6 host包与八处接线、§8文件清单、§9验证门）；实机验收与实施后开放项在
> `docs/progress/STATUS.md`（design 20 §1指向）。本文只留未排期超集分批、不做的边界与两份降级留档形态。

### 1. 超集分批（S1/S2/S3 未排期；S4 不做）

每批独立PR、各自测试、不引入新运行时依赖。优先级与范围：

- S1远程provider家族：主进程注册表加Insiders/Cursor/Windsurf/JetBrains Gateway/`ssh://` 终端——只构造URL交OS、不启动进程；每项需实机scheme语义验证（本机现只注册 `Visual Studio Code → [vscode]` 与 `iTerm → […, ssh, …]`）。
- S2远程文件级打开：远程来源允许文件路径（纯URL构造，不经host包）；本地仍目录限定。
- S3收窄为「复制路径」（唯一保留的非启动出口）：侧栏既有复制模式上暴露工作区/会话路径——会话行已带 `cwd`（`sidebar/src/shared/instance-api.ts` 的 `SessionRow.cwd?`），既有 `HoverCard` 支持 `copyText`（现只复制会话标题，`ServerSection.tsx`；该行本体 `:2027`）⇒ 零新IPC、零新依赖、纯渲染层。「复制 `ssh user@host`/复制VS Code深链」不做（结论在 STATUS「open-in 超集口径」条；该形态的完整设计已按纪律移出）。
- S4多入口：不做（理由登记STATUS）：header按钮与目标会话同排相邻，侧栏入口边际价值有限；会话行动作在行菜单（置顶/重命名/分叉/归档）+ 行内悬停归档钮与置顶钮（`packages/dsh-chamber-client-ui-sidebar/src/client/ServerSectionRows.tsx`），新增入口要么重复要么推翻它——不要把「会话行刻意没有kebab」当理由（该行自T2a起就有kebab；刻意无kebab的是worktree派生的workspace行，`:1288-1290`）。快捷键缺基建（vendor无keybinding注册表，只有聊天输入框keymap），自建document级监听还要处理「哪个entry是活跃视图」与chord冲突（该形态的完整设计已按纪律移出）。

### 2. 边界（不做，登记在 design 20 §7.3）

- 远端宿主侧打开（需ssh/http cookie注入 + UI明示，与「远程只用vscode部分」契约冲突）；
- fork官方catalog再扩本地应用集合之外的本地执行面（如「在终端里打开」的本地实现）；
- 主进程自行枚举本机应用（重开Batch 3 Phase 2关闭的红线）。

