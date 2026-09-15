# 未实现功能记录（docs/progress/todo）

> 本目录只记录**想到但尚未实现**的功能想法（todo）与仍需执行的外部门禁，每条一个
> 文件，粒度停留在想法/待设计。设计一旦定稿（形成契约），移入 `docs/design/0X-*.md`
> 并同步 `docs/progress/STATUS.md`；已落地 / 明确不做的项直接移出本表，不保留历史
> 记录（已执行计划的台账随实施完毕从本目录删除——留存于 git 历史）。

## 目录

| # | 文件 | 主题 | 状态 |
|---|---|---|---|
| 1 | [subagents-in-sidebar.md](subagents-in-sidebar.md) | session 的 subagents 在侧边栏中的显示 | 想法，未设计 / 未排期 |
| 2 | [12-todo-archived-sessions.md](12-todo-archived-sessions.md) | 已归档会话管理剩余面：「已归档」浏览区（A，design 24 可选后续，未排期）；特权层直删（B，冻结）；上游 wire 草案（C，上游落地前不发明） | A 未排期；B 冻结；C 待上游 |
| 3 | [windows-v1.md](windows-v1.md) | Windows v1 剩余外部门禁与取舍（design 23 companion；代码项已就绪） | 外部门禁待真实 runner/实机 |
| 4 | [settings-surface-upstream-contributions.md](settings-surface-upstream-contributions.md) | 设置面的上游声明式贡献通道（T3 提案：`dsh.client.contributes.settings` / 设置面服务契约 / descriptor 上线通道）；chamber 侧**不再需要**它们——2026-12 完整桥接修订后设置面直接渲染来源自己 boot ctx 的台账（design 05 §5 / 09 §4），三条降级为「通用宿主复用」提案 | 上游提案，未排期；已非 chamber 前置 |
| 5 | [open-in-ownership-and-enhancements.md](open-in-ownership-and-enhancements.md) | open-in **实机验收与超集分批**（fork & supersede 已落地，契约见 design 20）：真机验收九项、`ctx.subprocess` 旧 runtime 探针等开放项、分批结论（S1/S2 待排期；S3 收窄为「复制路径」；S4 不做）+ §5 附录留档的完整形态 | 实施已完成；本表剩真机 + S1/S2 + 可选小批次 |
| 6 | [client-store-scoping-upstream.md](client-store-scoping-upstream.md) | 上游：N-壳宿主下持久化 selection（`dsh.sessions.current`）需按 shell/入口作用域——它是"每次冷 boot 都新建空白会话"的根因；chamber 侧无法根治（vendor store 不在 fork 副本内，逐入口 localStorage 代理不安全），已用本地回显缓解（design 05 §2.2.1 修订） | 上游提案，未排期 |
| 7 | [macos-swift-v1.md](macos-swift-v1.md) | macOS Swift 原生壳 v1 实施细化计划（design 25 路线 A companion：M0–M5 六门 + WBS W-01…W-32 + P0 runbook + 门禁/中止条件） | M0 未签核（D1–D7 待用户）；代码级 M2 ✅ / M3 ✅（W-15 Supervisor、E19 崩溃重载、E13 深链、E1/E9/E20 关窗退出链）/ M4 ✅（W-22 更新 blocked-available、W-23 sidecar 打包、W-24 `.app` 打包、W-26 CI/release 腿、W-27 演练准备 + Electron 侧同锁）；剩余 = 实机 G 门与 Apple 凭据类外部阻断 + 少量已登记开放项（CLI 命令面测试、两 owner activationFacts 分歧、Swift 日志分级/死代码，见 companion「仍开放」段）|
| 8 | [product-freshness-guards.md](product-freshness-guards.md) | 产物新鲜度守卫：2026-12 产物普查（9 行清单）+ G1–G8 最小守卫建议（P0/P1/P2，含适用产物/成本/收益） | 想法，未排期；缺口现状登记在 STATUS |
| 9 | [audit-2026-12-findings.md](audit-2026-12-findings.md) | 2026-12 四路审计发现台账：A1 状态呈现 7+6 疑似 / A2 尺度错配 7 / A3 聚合吞未检 15+13 疑似 / A4 无 / A5 守卫缺口；逐条 file:line + 证据来源 + 严重度 + 建议 + 状态（已修/已派修/未动/需产品裁决） | 台账：task-17/18/20 在修；其余未动或待裁决 |

## 纪律

- 每条 todo 以想法级粒度记录：动机、现状对照（相关设计 / 已落地面 / 宿主覆盖情况）、开放问题。
- 设计定稿 → 移至 `docs/design/0X-*.md`，更新本表并同步 STATUS。
- 落地 / 明确不做 → 从本表移除，结论记入 `docs/progress/STATUS.md`。
