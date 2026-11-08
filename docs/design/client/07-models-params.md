# 07 · 模型额外参数与默认推理等级（deferral）

> **性质：推迟（deferral）**——不实现，只保留上游阻塞点与每次 pin 升级的复查触发条件。
> 上游依赖跟踪位 = [`docs/progress/TODO.md`](../../progress/TODO.md) A 类（上游依赖）与 [`docs/progress/STATUS.md`](../../progress/STATUS.md) §1；官方 Models 页 = vendor `dsh-client-ui-settings-models`（只读，不 fork）。

## 1. 需求

1. 每模型「额外参数」（KV 行 + JSON 块），写后诚实标注「已生效 / 惰性」。
2. 新会话默认推理等级（一行下拉，写 `llm-deepseek.reasoningEffort`，profile 级）。

约束沿 [01](../01-overview.md) 全局原则：不重造执行面、vendor 只读、host 能力归 host；只用 wire 既有方法（`settings.mutate/describe`、`session.modelCatalog`）。

## 2. 上游阻塞点

| # | 能力 | 当前阻塞（上游事实） | 解锁条件 |
|---|---|---|---|
| B1 | 任意 extra 键上 wire | deepseek 序列化器只发固定字段（model/messages/stream/stream_options/thinking/reasoning_effort/tools/temperature/max_tokens/stop）；extra 键只能由适配器从配置读取并映射 | 适配器新增配置面并映射到 wire，或 host 侧出现可注入的 `agent/request` 消费者 |
| B2 | `temperature` 等采样参数从设置到请求 | serializer 支持但只有 `GenerateOptions` 携带，无配置消费方 | 上述消费方把配置并入 GenerateOptions |
| B3 | deepseek per-model 默认推理等级 | `DeepSeekCatalogModel` 无 per-model effort 字段（该默认只能是 profile 级） | 模型条目增加 effort/reasoning 元数据 |
| B4 | 设置页回显「当前默认选择」 | **无上游阻塞**：`settings.describe` 无 namespace 白名单、`agent-default-model` 经 installSection 注册，可读可写 | 无；但不在本 deferral 的优先序内 |
| B5 | 未知键持久化但不生效 | schemastery `z.object` 非严格模式保留未知键（能持久化、不影响请求） | 上游改用严格 schema 时重新评估 |

## 3. 复查触发条件（每次 pin 升级）

1. `serialize` 白名单是否扩增（新增从配置读取的字段）→ B1/B2。
2. deepseek `Config` / pi-ai profile schema 是否新增可消费字段 → B1/B2。
3. `DeepSeekCatalogModel` 是否出现 effort/extra 字段 → B3。
4. `agent/request` 是否出现官方监听者 → B1/B2。
5. `settings.describe` 是否重新引入 namespace 白名单门 → B4。
6. schemastery 未知键行为是否改变 → B5。
7. 已保存的 `agentDefaultModel` 选择在随包模型目录更新后是否仍有效；失效时新会话会指向不存在的模型，升级后实跑一次并记录失效应答。

关注文件（vendor 相对）：`dsh-llm-deepseek/src/{index,serialize,adapter}`、`dsh-llm-pi-ai/src/{adapter,provider,config}`、`dsh-agent-loop/src/agent.ts`、`schemastery/src/index.ts`。

## 4. 退出条件

任一阻塞行变为可行 → 在 TODO A 类登记该上游面，按 [05](../control-plane/05-connection-manager.md) §5 的 `settings.section` 契约重新立项；**不得**以「前端先填、后端忽略」的方式上线（违反诚实性原则），也不得用近似数据冒充「当前默认选择」。
