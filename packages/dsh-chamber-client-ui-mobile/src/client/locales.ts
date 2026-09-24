/** Mobile adaptation plugin dictionaries. zh is the key-set source of truth;
 *  en is type-forced to cover every key (family convention). */
export const zh = {
  'dsh-chamber.mobile.title': '移动视图',
  'dsh-chamber.mobile.drawer.open': '打开侧边栏',
  'dsh-chamber.mobile.drawer.close': '收起侧边栏',
  'dsh-chamber.mobile.stall.message': '会话载入似乎停滞了',
  'dsh-chamber.mobile.stall.messageFailed': '会话内容未能载入',
  'dsh-chamber.mobile.stall.action': '重新加载页面',
  'dsh-chamber.mobile.stall.dismiss': '继续等待',
} satisfies Record<string, string>

export type MobileKey = keyof typeof zh

export const en = {
  'dsh-chamber.mobile.title': 'Mobile view',
  'dsh-chamber.mobile.drawer.open': 'Open sidebar',
  'dsh-chamber.mobile.drawer.close': 'Close sidebar',
  'dsh-chamber.mobile.stall.message': 'Session loading appears stalled',
  'dsh-chamber.mobile.stall.messageFailed': 'Session content not loaded',
  'dsh-chamber.mobile.stall.action': 'Reload page',
  'dsh-chamber.mobile.stall.dismiss': 'Keep waiting',
} satisfies Record<MobileKey, string>
