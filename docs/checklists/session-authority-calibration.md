# 会话事实单一权威 · 真机校准清单（design 14 §D4）

> 本文件是**程序**，不是记录：不写版本号、提交、基线快照或轮次台账。
> 校准数值的单一来源是 `packages/dsh-stream-state/tables.json` 的 `ladders.authority`
> （probeAfterMs / probeCoalesceMs / probeWindowMs / maxProbesPerWindow / reconnectAfterMs /
> reconnectCooldownMs / maxReconnects / noticeAfterMs）；改值 = design 14 §D4 的
> BEHAVIOR_CHANGES 条目，必须同步 TS 字面量（`src/tables.ts`）与该 JSON，并跑
> `node scripts/gates/verify-ladder-table-parity.mjs`。

## 1. 目的

验证「静默完成」在真机上由单一权威链收敛：宿主已 idle 而状态帧丢失 / 载波静默半死时，
运行位在预算内掉落、完成通知恰好一次；宿主确实在跑（长工具/长推理）时零误写回、
零误 reconnect。

## 2. 前置

- 打包态（或带控制面日志的 dev 实例）各一：本地来源 + 一个 ssh/dsh 远端来源。
- 可检索的落盘面：`<stateDir>/logs/control-plane.log`、原生壳
  `<userData>/logs/sidecar.log`（启用 `DSH_CHAMBER_SHELL_DEBUG=1` 时另有 shell 行）；
  renderer console 可附着。
- 记录基线：每个来源的 `runtimeFacts[source].sessionAuthority`（`runningSince` /
  `progressStamp` / `recent`）与打开会话的 `running` 位。

## 3. 注入（每次只改一个变量）

- **A 丢单帧**：status 帧投递路径丢一帧（dev fixture 的 `__fxTiming` 钩子可用时优先）。
- **B 载波半死**：socket 保持 OPEN 而停止投递（`breakStreams` / 暂停上游转发）。
- **C 宿主确实在跑**：长工具或长推理，合法静默 ≥ 一个 probe 周期。
- **D ssh 远端**：对远端来源重复 A/B，观测写回（官方写面）的端到端时延。
- **E 官方收敛**：refresh 可用时观察运行位是否自然掉落（recent 里不应出现 correct）。

## 4. 采集

- renderer：`authority action <probe|read-failed|correct|correct-failed|complete|recovered>`
  行与 `[chamber] session authority …`；快照 `sessionAuthority.recent`（有界 ring）。
- 控制面：`WebSocket stream <id> closed (<cause>, <ms>ms)` 与 `heartbeat lost …`。
- 机内持久环：`localStorage['dsh-chamber.authority-log.v1']`（每来源最近
  `AUTHORITY_LOG_MAX_PER_SOURCE` 条、最多 `AUTHORITY_LOG_MAX_SOURCES` 个来源；跨重载/重启
  可回读；Electron 与 Swift 两 flavor 共用同一 web renderer 的 profile store）。
- 时间线：宿主真实结束 t0 → 运行位掉落 t1 → 通知到达 t2（外部秒表或 perf marks）。

## 5. 判据（全满足才判 PASS）

- A/B/D：位在「probe 期限 + 一次 N=2 读 + 写回自校验」内掉落；通知恰好一条、无重复。
- C：无 `correct` / `complete` / reconnect；`progressStamp` 前进（健康裁决）。
- 每个 running 时段不超过配额；无 reconnect 风暴（每来源每小时 reconnect ≤ maxReconnects）。
- E：自然掉落路径不出现多余写回。
- 事故后能从控制面日志回读 A/B 的断开行，并能从 ring/console 回读 authority 动作。

## 6. 失败处置

- **假阴性**（位未掉）：记录 t0/t1、`recent`、控制面日志；确认 probe 是否发出、权威读
  返回什么；按 design 14 §D4 的残余窗口排查（宿主返回不完整列表 / 写面缺失 /
  `refresh()` 缺失）。
- **假阳性**（宿主在跑却写回或重连）：记录该会话与 `recent`；把相应表值改动按
  BEHAVIOR_CHANGES 回退，并把证据写回 `docs/progress/STATUS.md` 的「会话运行位卡死」开项。
- 阈值改动必须配对更新 `tables.ts` ↔ `tables.json` 并通过锁步门。

## 7. 关联

- 契约：design 14 §D4「会话事实单一权威」；通知面 design 19 §3.2。
- 语料：`packages/dsh-stream-state/test/authority/`、
  `packages/renderer/test/aggregate/notification-projection.test.ts`。
- 上游残余：`docs/progress/todo/upstream-proposals.md` §4。
