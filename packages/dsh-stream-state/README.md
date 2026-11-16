# @dsh-chamber/dsh-stream-state

纯的会话/流生命周期状态（[design 14](../../docs/design/runtime/14-sleep-background.md) §D4）：观察进、带类型的恢复动作出；阈值只在 `src/tables.ts`。零运行期依赖、无 timer、无 DOM；核心模块不读时钟（观察时间由调用方 stamp），注入边缘的默认时钟是 `Date.now`（`src/injection.ts`）。

## 契约与边界

- 纯函数 + 数据；时钟与调度由调用方注入（`src/time.ts` 只做归一）。
- 不解释 UI、不发请求、不写存储；动作落地归 renderer 与连接客户端。
- Swift 镜像只保留 `CarrierDecision.swift`，其余契约由本包持有。

## 主要模块

- `src/state.ts` / `src/ladder.ts` / `src/carrier.ts` — 生命周期、阶梯恢复与载波决策。
- `src/session-authority.ts` / `src/presentation.ts` / `src/evidence.ts` — 权威判定、呈现仲裁与观察有效性。
- `src/tables.ts` — 唯一阈值表。

开放项见 [STATUS](../../docs/progress/STATUS.md)。
