# todo · server 之间的拖拽排序

> 状态：**已实现（2026-09，方案 1）**——见 `docs/progress/STATUS.md`
> （server 折叠 + 显示序拖拽）。记录于 2026-08-16。
>
> 2026-10 review 收窄（F1/F2，契约见 06 §2.4）：ESC 取消守卫对 dragend
> 时 `dataTransfer` 为 null（Safari 曾有）同样视为取消；拖拽期间指针离开
> 所有来源 section 即清除 marker——**列表外释放 = 取消**（整组位移影响面
> 大，故比 §2.2"drop/end 提交最后 marker"严格）；header 按钮上起手的
> 拖拽手势不启动拖拽（F3，按钮保持纯点击）。

## 动机

侧边栏按来源分组展示（本地 + 各远程服务器）。希望服务器（来源分组）之间可
拖拽排序——调整来源分组的显示顺序；以及 / 或者跨来源拖拽移动会话。

## 现状对照

- **来源内拖拽排序已落地**（06 §2：workspace 组内会话行 / workspace 组头重排，
  wire `insertSessionBefore` / `insertBefore`）。
- **跨来源移动被明确排除**（06 §0"不做跨来源移动（拖拽按来源在代码层阻断）"、
  STATUS"不做（v1）：跨来源移动会话"）——会话属于各实例自己的权威数据面，
  控制面不消费宿主会话；wire 上无跨来源移动方法。
- 来源分组**顺序本身目前无排序 / 持久化**（来源顺序来自注册表 / 启动序）。

## 两种解读（设计时二选一或分两期）

1. **来源分组排序**（✅ 已实现，2026-09）：仅本地视图偏好——拖拽调整来源
   分组显示顺序，沿用 06 §3 view-prefs 的**共享视图偏好存储**
   （`dsh-chamber.sidebar.v1`，localStorage 持久化、跨 ctx 实时联动），
   不涉及任何 wire 与跨实例语义。实现细节：
   - `ChamberSidebarViewPrefs.serverOrder?: string[]`——sourceId 有序数组
     （可选字段，v 保持 1）；渲染侧 `derive.orderServersForDisplay` 应用
     （存储序优先 + 未知 id 跳过 + 未列出 id 按投影序尾随）；拖拽提交经
     `updateViewPrefs` 写回；裁剪规则同 orderBy（本会话见过、现已消失的
     来源才裁）。
   - 配套的 **server 级收拢**（同一存储的 `sourceFolded?: Record<sourceId,
     boolean>`）：来源头 hover 弹出折叠箭头（与 workspace 同样的 folder↔
     chevron 槽位互换），点击收拢**整个 workspace 列表**——刻意独立于
     每 workspace 的 `folded`，**不折叠 workspace 内的对话**（用户明确
     规则），展开后各 workspace 会话原样恢复。
   - 拖拽交互镜像 06 §2.2：header 为拖柄 + section 边界 drop marker
     （`dropBefore`/`dropAfter`），提交锚点数学同 workspace 提交；
     App 层 N-ctx 常驻/预热/注册表顺序完全不动（导航按 id 键控）。
2. **跨来源移动会话**：与"每实例会话权威"哲学冲突，需先定义语义（迁移 =
   目标实例新建会话并拷贝上下文？复制？）；v1 明确不做，除非需求升级论证。

## 关联

- `docs/design/06-sidebar-enhancements.md` §2（来源内拖拽）/ §3（视图持久化）
- `docs/progress/STATUS.md`（"不做（v1）：跨来源移动会话"）
