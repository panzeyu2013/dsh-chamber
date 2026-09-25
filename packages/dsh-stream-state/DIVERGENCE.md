# DIVERGENCE：新旧行为差异登记（重构期）

> 归属：差分回放门（`scripts/refactor/equivalence.mjs`，`run-checks.mjs` 的等价性步）。差分回放器
> 允许的差异**只有**三类：① 措辞/日志文本；② 同一拍内动作的顺序；③ 新增观测面。
> 除这三类外的任何差异都属于**行为变更**，必须在本文件有一条具名记录，否则差分门判红。

## 允许差异类别（固定三类）

| 类别 | 含义 | 判据 |
|---|---|---|
| D-WORD | 纯措辞/日志文本变化 | 归一化器折叠为同一 reason 类别；不产生条目 |
| D-ORDER | 同一拍内动作顺序不同（集合相同） | `compareTraces()` 按多重集比较；不产生条目 |
| D-OBS | 新增观测事实（forensic 只增不减） | 归一化器允许新增、拒绝删除；不产生条目 |

## A. 可差分验证的行为变更（下表编号必须被向量引用，反之亦然）

| # | 现象（新旧差异） | 判据（向量 id） | 为何是修复 | 退役条件 |
|---|---|---|---|---|
| **D-1** | teardown 零帧分支**不查**停滞冷却，可与停滞升级/车道重连同拍替换；新路共用同一节流表，第二次请求降级为 `throttled` | `defect-teardown-ignores-cooldown` | `remote-retry-policy.ts:302-304` 自称「≥30s 节奏」，而 teardown 调用点不写 `lastOpeningEscalationAt`，文档与实现不符 | `stream-client.ts` 三条替换入口删除、`CarrierSupervisor` 唯一所有者后该形态结构上不可达 |
| **D-2** | 同一秒内 teardown 判静默 + 车道重连：旧路两条都执行，新路第二条降级 `throttled` | `defect-correlated-replacements` | 同拍双拆链是审计记录的现场；`replaceSocket` 会取消自己刚启动的重连，socket 永不稳定 | 同上 |
| **D-3** | 车道重连**无任何节流**，一分钟内可拆链四次；新路受 60s 窗口 ≤1 次约束 | `defect-lane-unbounded` | 这是 `control-plane.log` 里 3 天 233 次浏览器主动 close（寿命 17.4–21.1s）的直接机制 | 车道重连改由 `rebuildCarrier(laneReconnect)` 单一命令表达后，节流由表承担 |

## B. 已登记的差异但**不可差分验证**（轨迹形状不变；必须带 Proof）

| # | 现象 | Proof（钉住它的用例） | 为何是修复 | 退役条件 |
|---|---|---|---|---|
| **D-4** | 加宽预算的**归属**从「endpoint+payload 键」改为「逻辑流 episode」（2026-12 落地为 stream-client 的 owner 账本：每 open 以本地 `baseStreak` 认领、仅 owner 可发布、live 兄弟不继承、仅死前驱传递；digest 保留为请求身份）：预算所有权变化，替换次数与时刻都不变，因此差分器看不到 | `Proof: packages/dsh-stream-state/test/carrier/carrier-lifecycle.test.ts`（`openingBudgetMs` 阶梯真值表，含 `-1`/`99` 退化输入） | 旧键在消费者 dispose 后无人清除，重进同一会话从 60–300s 起步（审计 §4.3 的加宽存活洞） | 已按逻辑流所有权收紧，键的存活期等于逻辑流存活期；**彻底删除 digest 仅剩的上游条件** = 领域 opener 转发 episode 参数（vendor 触点，提案见 `docs/progress/todo/upstream-proposals.md`） |

## C. 实测撤销的记录（防止重造差异）

不参与机器校验；留档的意义是**假设必须让位于实测**。

| # | 曾假设 | 实测结论 | 现在的判据 |
|---|---|---|---|
| — | 旧路对首次带帧超时会立即升级停滞 | **不成立**：两侧动作序列逐项相同 | 向量 `one-miss-with-frames-does-not-escalate`（等值） |
| — | 零帧连续两次超时时旧路会双替换 | **不成立**：旧路 `else` 被 silent 分支挡住，两侧都恰好两次替换 | 向量 `defect-double-replace-zero-frames-streak2`（已改判等值） |

## 记录纪律

- 新增差异 = 一次行为变更提交（单独 commit + 单独登记），**不得**混入结构重构提交；
- **先测、后登记**：先跑 `node scripts/refactor/equivalence.mjs` 看实测，不按假设登记（上表两处撤销就是假设被实测推翻的例子）；
- A 段条目退役后移入下方「退役记录」；B 段条目退役后同样移入并保留 Proof 溯源；
- 本文件是差分门的**唯一授权来源**：`equivalence.mjs` 只检查「是否登记」与「是否按登记表现差异」。

## 退役记录

（暂无。B1 完成、三条旧入口删除后回填。）
