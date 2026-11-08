/**
 * 非活动来源（foreign source）的面板轴回落（design 05 §2 / design 06 §4.7 的两档补充）。
 *
 * 页面级两档真相：每个已挂载壳的侧栏把自己的 `sidebar.panellist` 注册发布到 client-core 的
 * 页面单例（panel-axis），非活动来源的 server 头因此能渲染「该来源自己的」真实条目
 * （{id, order, label} 全部由该来源的壳发布）；未挂载但可连接的来源没有发布快照，按 pin 的
 * 默认组合回落一个 chamber 自有的时钟快捷键。本模块只拥有回落表与默认组合投影，点击链与
 * 激活语义在 ServerSectionHeader / index.ts。
 */
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { PagePanelAxisEntry } from '@dsh-chamber/dsh-chamber-client-core'

/**
 * 已知上游面板 id 的字形回落表（本壳不能 import 上游插件组件——它们不在本 bundle 里，且
 * 每个来源的 glyph 由该来源自己 ctx 的 renderSlot 渲染；非活动来源没有可用的 renderSlot
 * 绑定，只能按 id 回落 chamber 自有的同形字形）。当前唯一的 panellist 注册者是 ui-schedule
 * （`id: 'schedules'`，vendor ui-schedule TaskManagerIcon.tsx 用 IconClockOutlineRegular）。
 * **上游新增 panellist 注册者时必须在此补映射并上报待裁**；未映射的 id 不渲染。
 */
const FOREIGN_PANEL_GLYPHS: Readonly<Record<string, ReactNode>> = {
  schedules: <IconClockOutlineRegular size={14} />,
}

/**
 * 一个非活动来源面板 id 的回落字形；`undefined` = 未知面板，**不渲染**：宁可少一个入口，
 * 也不给一个无意义的图标或一个点不开的快捷键。
 */
export function foreignPanelGlyph(id: string): ReactNode | undefined {
  return FOREIGN_PANEL_GLYPHS[id]
}

/** 默认组合里唯一已知的面板 id（pin 的 web-app bundle 无条件挂载 ui-schedule）。 */
export const DEFAULT_FOREIGN_PANEL_ID = 'schedules'

/**
 * 未挂载来源的默认组合回落。**只用于**「该来源未挂载且 connected（可切换）」的 server 头：
 * 已挂载来源必须用页面级发布的真实条目（id/order/label 各自权威），不得用本回落。
 * label 由侧栏命名空间的 `panel.schedules` 提供（转录上游 ui-schedule
 * task-manager-locales.ts 的 `panel` 文案；vendor 行见该文件 en:49 / zh:215）。
 */
export function defaultForeignPanelEntries(t: (key: string) => string): readonly PagePanelAxisEntry[] {
  return [{ id: DEFAULT_FOREIGN_PANEL_ID, order: 10, label: t('panel.schedules') }]
}
