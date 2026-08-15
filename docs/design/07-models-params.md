# 07 · 模型额外参数与默认推理等级（设计先行，实现待上游）

> 本文档是**推迟项**：需求已确认、链路已查清、chamber 侧实现方案已定稿，
> 但关键能力受上游（vendor，只读）约束，**实现暂缓**，等待上游 dsh 演进。
> 上游更新阶段（harness.commit 升级）须按 §5 清单复查，条件满足即按
> §6 蓝本实现。本文档 + 05 为实现契约（05 的 settings.section 槽位契约见
> 05 §5；官方 Models 页为 vendor `dsh-client-ui-settings-models`）。

## 0. 范围与状态

| 项 | 内容 | 状态 |
|---|---|---|
| A | 每模型额外参数（KV 行 + JSON 块），"已生效/惰性"诚实标注 | **推迟**（透传受上游白名单约束，§3） |
| B | 新会话默认推理等级（一个下拉，写 `llm-deepseek.reasoningEffort`） | **推迟**（本身可行，与 A 同批落地） |
| — | 默认 maxTokens / 默认上下文窗口行 | **不做**（需求裁剪，仅保留 reasoningEffort） |
| — | 通用 extra 参数透传到 API 请求（temperature/top_p 等） | **不可做（v1）**：wire 白名单 + host 组合不可注入，§3.3 |

约束沿 01 全局原则：不重造执行面、vendor 只读、host 能力归 host；
不发明协议——只用 wire 既有方法（settings.mutate/describe、llm.models）。

## 1. 需求

1. 模型设置面板提供"额外参数"支持：`+` 按钮逐行增加 参数名/值 行；支持
   JSON 块解析（粘贴 JSON 合并进该模型）。
2. 提供一行 `default reasoning effort`，作为新会话默认推理等级，避免每次
   在会话选择器里重选。

## 2. 现状事实（链路证据，2026-08-15 核）

### 2.1 新会话默认模型选择：官方机制已存在

- `sessions.selectModel` 每次选择（含 reasoningEffort）都会顺带保存为默认：
  api-proxy.ts:2307-2321 `saveDefaultModelSelection` → `agent-default-model`
  设置节 `{provider, model, reasoningEffort}`（dsh-agent-default-model/src/
  index.ts:34-38,98-104）。
- 新会话（create/resume）取回顺序：本会话选择 → 会话日志 request/header →
  默认选择（api-proxy.ts:1154-1177）；`installModelSelection` 经
  `agent/request` waterfall 把 provider/model/reasoningEffort 注入首个请求
  （dsh-agent/src/model-selection.ts:54-70）。
- **结论**：选择器里选过一次，新会话自动继承——"避免每次选择"官方已满足，
  缺的只是设置页回显/设置入口。

### 2.2 设置页可写的默认等级：`llm-deepseek.reasoningEffort`（profile 级）

- schema 字段（dsh-llm-deepseek/src/index.ts:70,94-95），已暴露给客户端
  （exposedNamespaces = 模型 provider 命名空间，dsh-host-apiproxy/src/
  api-proxy.ts:1953-1958），设置 UI 可读可写。
- 生效路径：profile `reasoningEffort` → 每模型 `defaultEffort`
  （dsh-llm-deepseek/src/adapter.ts:194-210）→ 无显式 effort 的请求自动套用
  （dsh-llm/src/index.ts:754-762）→ wire `reasoning_effort`
  （dsh-llm-deepseek/src/serialize.ts:179-181）。
- 联动约束：`thinking: disabled` 时仅允许 `off`/Default，否则适配器拒收并
  保留旧配置（dsh-llm-deepseek/src/index.ts:162-166）。
- **注意**：deepseek 模型目录类型（DeepSeekCatalogModel，adapter.ts:30-41）
  **没有 per-model effort 字段**——该默认是 profile 级，非 per-model。

### 2.3 wire 请求是封闭白名单：extra 键不会泛化透传

- deepseek 序列化器只发固定字段（serialize.ts:173-186）：
  `model / messages / stream / stream_options / thinking / reasoning_effort /
  tools / temperature / max_tokens / stop`。
- extra 键上 wire 的唯一途径是**适配器从配置读它并映射到这些字段**
  （适配器 = vendor 只读）；请求由 host 进程构造（agent-loop agent.ts:407-470，
  `agent/request` waterfall 是唯一注入点），host 组合是上游 `--profile web`
  （control-plane spawn-dsh.ts:59），chamber 无法注入 host 插件。
- 逐层透传事实表（2026-08-15 核）：

| 键落在 | 是否上 wire | 证据 |
|---|---|---|
| deepseek profile `reasoningEffort`/`thinking`/`maxTokens` | 是 | §2.2 + resolveCallFor 默认物化（dsh-llm/src/index.ts:740-742） |
| pi-ai profile `headers`（dict） | 是（作为请求头，保留名除外） | dsh-llm-pi-ai/src/adapter.ts:172-176,319-321 |
| pi-ai per-model `reasoningEfforts`/`input`/`compat` | 是 | dsh-llm-pi-ai/src/config.ts:203-221 |
| deepseek per-model 非目录字段 | **否**（resolveModels 重建条目时丢弃） | dsh-llm-deepseek/src/index.ts:139-145 |
| `temperature` | **否（从设置无法到达）** | serializer 支持，但仅 GenerateOptions 携带，无配置消费方 |
| `top_p` 等其余任何键 | **否** | serializer 根本不发 |

- schemastery `z.object` 非严格模式保留未知键（schemastery/src/index.ts:
  752-763；`schema(x)` 直调 strict=false，index.ts:240-242）——未知键能
  持久化并出现在 resolved 设置文档里，但**不影响请求**。

### 2.4 客户端访问边界

- `agent-default-model` 命名空间**不在** exposedNamespaces（api-proxy.ts:
  1953-1958，仅模型 provider + WEB_SETTINGS_NAMESPACES +
  PRODUCT_SETTINGS_NAMESPACES）——设置 API 对客户端读写它均拒绝
  （`settings-not-exposed`，api-proxy.ts:2009）；也无专用读 RPC。
  → chamber 无法回显"当前默认选择"。
- 可用数据面：`settings.mutate/describe`（模型 provider 命名空间）、
  `llm.models`（session 无关目录）、`sessions.selectModel` 副作用写默认。

## 3. 阻塞点与解锁条件（上游）

| # | 能力 | 上游解锁条件 | 关注文件 |
|---|---|---|---|
| 1 | 泛化透传/任意 extra 键生效 | 适配器从 profile/models 读取额外字段并映射到 wire（或新增配置面），或 host 侧出现消费 `agent/request` 的官方/可注入插件 | `dsh-llm-deepseek/src/{index,serialize}.ts`、`dsh-llm-pi-ai/src/provider.ts` |
| 2 | `temperature` 等采样参数从设置到达请求 | 上述消费方把配置采样参数并入 GenerateOptions | 同上 + `dsh-agent-loop/src/agent.ts` |
| 3 | 设置页回显/设置默认选择（agent-default-model） | 该命名空间进入 exposedNamespaces，或新增专用 RPC | `dsh-host-apiproxy/src/api-proxy.ts:1953-1958`、`src/api/llm.ts` |
| 4 | per-model 默认推理等级（deepseek） | `DeepSeekCatalogModel` 增加 effort 字段，或模型条目标注 reasoning 元数据 | `dsh-llm-deepseek/src/adapter.ts:30-41` |

## 4. 更新阶段复查清单（每次 harness.commit 升级）

1. `serialize.ts` 白名单是否扩增（是否出现从配置读取的字段）。
2. `dsh-llm-deepseek Config` / `dsh-llm-pi-ai profile` schema 是否新增字段。
3. `exposedNamespaces` 是否包含 `agent-default-model`。
4. `agent/request` 是否有官方监听者（`grep -rn "agent/request"` vendor）。
5. `DeepSeekCatalogModel` 是否出现 effort/extra 字段。
6. schemastery object 未知键行为是否改变（v4 更新期的已知风险面）。

条件满足（任一条使 §3 表格某行变为可行）→ 按 §6 实现并更新本文状态。

## 5. 已定的 chamber 实现蓝本（上游解锁后按此落地）

### 5.1 形态：扩展而非替换

- 新增 `packages/dsh-chamber-client-ui-settings-models-params`（结构镜像
  `dsh-chamber-client-ui-settings-connections`）：注册 `settings.section`
  （id `model-params`，nav 位置紧邻官方"模型"页）。
- **不 fork 官方 Models 页**：vendor 页活跃演进，fork 维护成本高；且默认
  等级是 profile 级，独立 section 可统一覆盖 deepseek/pi-ai 全部路由；
  两页写入互不冲突（vendor pathOps 只写其渲染键、draft 结构开放保留未知键，
  ProviderEditor.tsx:105-122）。
- 数据面：`ctx.remote`（IApiClient：settings.mutate/describe、llm.models、
  credentials），与 vendor ModelsSection 同一 wire 面。

### 5.2 A 区：新会话默认推理等级（唯一默认行）

- 下拉 `Default / off / high / max` → path op 写/清 `llm-deepseek.
  reasoningEffort`（expectedRevision + 冲突重读重试，镜像 ProviderEditor
  pathOps 语义）。
- `thinking: disabled` 时收敛为 `off`/`Default`（§2.2 联动约束）。
- 文案说明三层关系：① 本行设置模型 Default 档；② 会话选择器选过的模型/
  等级自动成为新会话初始选择（官方行为，§2.1）；③ 显式选择 > Default 档；
  ④ 已选过模型的会话不受影响（request/header 已固化）。

### 5.3 B 区：每模型额外参数

- 每模型展开区：`+ 添加参数` → 行 = 参数名 + 值 + 删除；值类型化解析
  （`true`/`3`/`"x"`/对象），提交 JSON 规范化。
- 参数名自动补全：`rehydrateSchema` 枚举该路径（`models[i]` /
  `providers.<r>.models[i]`）schema 已知键。
- 模型底部 JSON 块：`JSON.parse` 行内报错，成功 spread 进 draft，与 KV 行
  双向同步。
- **诚实标注**：写后对比 `settings.describe()` 的 `user` vs `value`
  （resolved）+ schema 已知键集合，每键标 `✓ 已生效` / `⚠ 惰性（适配器
  不读取，不会随请求发送）`；页面顶部固定说明"请求透传为白名单制"（§2.3）。
- 已知取舍：vendor 页"重置模型目录"会清空整个 user 层 models 数组（含本页
  写入的 extra），可接受且可见。

### 5.4 验证与文档

- `parse.ts` 纯函数（类型化解析/JSON 合并/未知键判定/冲突重试）node:test
  单测；`pnpm run build:renderer` + `pnpm run verify:i18n` + 手动 smoke。
- 落地时更新本文状态表、05 §5、`docs/progress/STATUS.md`。

## 6. 移出项（v1 明确不做）

| 项 | 处置 |
|---|---|
| 通用 extra 参数透传 / temperature / top_p | 上游解锁前不可做（§3 #1/#2）；**不得**以"前端先填、后端忽略"的方式上线（违反诚实性原则） |
| 设置页回显会话默认选择 | 上游解锁前不可做（§3 #3） |
| deepseek per-model 推理等级 | 上游解锁前不可做（§3 #4） |
