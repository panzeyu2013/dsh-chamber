# todo 12 · 已归档会话管理（剩余未实现面；调研事实保留）

> **状态（2026 收口）**：已实现面 = design 24 的**已归档内容清理**（宿主域
> `archiveCleanup/{preview,purge(sessionIds?)}` + 归档管理器 UI，本地形态已实跑；
> 契约见 `docs/design/24-archived-session-cleanup.md`）。本文保留的**未实现面**：
> **A（已归档浏览区）**——design 24 的可选前置/后续，未单独排期；**B（特权层直删）**
> ——冻结（理由见下）；**C（上游 wire）**——根治草案（§5），上游落地前 chamber 不发明。
>
> 根因（代码核实，2026-08）：dsh 归档**单向且不可见**——上游只有
> `workspace.archiveSession`（追加进 registry-global 集合，幂等），无
> unarchive/delete-session；官方与 chamber 投影同规则排除归档行（`!archived.has(id)`）；
> 数据未丢（sessions.list/search 均返回归档会话，集合持久化于
> `<DSH_HOME>/profiles/web/**/workspace.json` 的 `global.archivedSessionIds`）。
> OpenCode/OpenChamber 范式对照：harness 提供可逆归档 + 删除 + 归档可见查询，
> manager 只做 UI——dsh 三项全缺，chamber 无法只靠前端补全。

## A · 「已归档」浏览区（可选前置/后续，未排期）

列出/打开/重命名/搜索归档会话（不动 05 §2.2 红线）。要点（详细设计见 2026-08
调研与 design 24 关联登记，git 历史）：
- 桥契约每来源归档桶 + derive 纯函数 + 侧边栏「查看已归档」独立视图
  （OpenChamber ArchiveView 式；PAGE_SIZE=100 分批，防长列表卡顿）；
- 归档桶按 `updatedAt` 降序（dsh 归档集合无时间戳）；断连来源随聚合快照同一生命周期；
- 行动作走该来源自己的 API（打开/重命名/本地标题搜索；**不做**恢复/删除——等 C）。

## B · 控制面/主进程特权层直接清（冻结）

违反 05 §2.2「wire 缺失的方法不做（如删除会话），不发明协议」、AGENTS「会话业务是
dsh 前端运行时的事」与 P3 收敛移出项纪律；且运行中宿主内存持有域全局态，直接编辑
`workspace.json` 会被下一次 `setState` 覆盖。**除非用户明确拍板改契约并经设计评审，
否则不实施**（design 24 §2 的实例进程内宿主域例外是独立动议，不是 B 的翻版）。

## C · 上游 wire 契约草案（根治，对齐 OpenCode 模型）

> 上游 = `deepseek-harness`（外部仓库，chamber 不可改；落地前以 vendor
> `dsh-client-modules/src/client/manifest.ts` 为权威复查）。设计 24 域随上游
> `sessions.delete` wire 落地后**退休**。

1. `workspace.unarchiveSession({ sessionId })`——与 `archiveSession` 对称，幂等移除；
   复用既有 `host/archived-sessions-changed` 事件与 `workspace.list.archivedSessionIds`
   投影，客户端零新协议。
2. `sessions.delete({ sessionId })`（或 workspace 下同义）——服务端删会话目录 +
   级联 subagent 起源子会话 + workspace 成员账目自愈（header 索引重建剔除已删 id）+
   从 archived 集合清理；复用 `host/session-removed` 事件。
3. （可选）`sessions.list` 行加 `archived` 标志或查询参数。若保持 registry-set 形态，
   仅补 1+2 即可让 A 区补上恢复/删除——最小改动优先。
