/**
 * Mobile adaptation plugin dictionaries. `zh` is the key-set source of
 * truth; `en` is type-forced to cover every key (family convention).
 */
export const zh = {
  'dsh-chamber.mobile.title': '移动视图',
  'dsh-chamber.mobile.drawer.open': '打开侧边栏',
  'dsh-chamber.mobile.drawer.close': '收起侧边栏',
} satisfies Record<string, string>

export type MobileKey = keyof typeof zh

export const en = {
  'dsh-chamber.mobile.title': 'Mobile view',
  'dsh-chamber.mobile.drawer.open': 'Open sidebar',
  'dsh-chamber.mobile.drawer.close': 'Close sidebar',
} satisfies Record<MobileKey, string>
