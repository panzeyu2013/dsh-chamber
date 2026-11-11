/**
 * 设置触发行 + 更新指示器的结构锁（P02 / design 05 §5 / design 15 §1）。
 *
 * 本包没有 React 渲染测试设施（不新增 jsdom/react-dom，同 settings-groups.test.ts:236-239
 * 的既有纪律）：宽/窄两态的「显示什么」由 update-gate.test.ts 的纯门真值表覆盖，这里只
 * pin 源码接线（wide 分支、指示器挂载、点击打开 __general、CSS 行度量恢复、无可见 label），
 * 真机目检见 design 25 §8.5。P05 的 details 样式与 P20-B 的专用行同在这一 CSS 模块里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const readClient = (name: string): string => readFileSync(path.resolve(here, '../../src/client', name), 'utf8');
const shell = readClient('SettingsShell.tsx');
const indicator = readClient('UpdateIndicator.tsx');
const css = readClient('SettingsShell.module.css');

test('⟨P02⟩ 触发行接线：wide 用 triggerRow 行包按钮 + 指示器，rail 保持单按钮', () => {
  // wide 分支：上游 42px 行 + 指示器。
  assert.match(shell, /\{wide \? \(/);
  assert.match(shell, /<div className=\{css\.triggerRow\}>/);
  assert.match(shell, /<UpdateIndicator wide=\{wide\} view=\{updateView\} t=\{t\} onOpen=\{openUpdateSection\} \/>/);
  // rail 分支：只有按钮（指示器仅 wide；组件自身也以 !wide 返回 null）。
  assert.match(shell, /className=\{clsx\(css\.trigger, css\.rail\)\}/);
  // 指示器只出现在 wide 的 triggerRow 里：rail 分支不挂载它。
  assert.equal((shell.match(/<UpdateIndicator /gu) ?? []).length, 1);
});

test('⟨P02⟩ 指示器点击 = 打开设置并落在客户端页的更新组（不消费 updates.open，不滚动）', () => {
  assert.match(shell, /const openUpdateSection = useCallback\(\(\) => \{\s*openSection\(GENERAL_SECTION_ID\)\s*\}, \[openSection\]\)/);
  // 零新通道/零新弹窗：入口即既有 openSection（setActiveId + setOpen）；不调用
  // updates.open 通道、不引入滚动机制（注释里的差异说明不算消费）。
  assert.doesNotMatch(shell, /updates\.open\s*\(/);
  assert.doesNotMatch(shell, /scrollIntoView/);
});

test('⟨P02⟩ 同一 update-store 单例投影（不新开订阅、不新开发现腿）', () => {
  assert.match(shell, /useSyncExternalStore\(subscribeUpdateState, getUpdateState\)/);
  assert.match(shell, /const updateView = updateIndicatorView\(update, wide\)/);
  // 官方组件不 import（跨插件禁令；自持实现）。
  assert.doesNotMatch(indicator, /dsh-client-ui-settings-general/);
  // 指示器自身不订阅：纯门投影由 shell 传入（只检查 import/调用面，注释可提 update-store）。
  assert.doesNotMatch(indicator, /useSyncExternalStore/);
  assert.doesNotMatch(indicator, /from '\.\/update-store\.ts'/);
});

test('⟨P02⟩ UpdateIndicator：icon + Tooltip + aria-label，无可见 label；busy/download/error 三态', () => {
  assert.match(indicator, /<Tooltip label=\{label\} side="top">/);
  assert.match(indicator, /aria-label=\{label\}/);
  assert.match(indicator, /if \(!wide \|\| view\.kind === 'none' \|\| view\.labelKey === null\) return null/);
  assert.match(indicator, /t\(view\.labelKey\)/);
  // 三态图标：转圈 / 下载 / 红点。
  assert.match(indicator, /IconLoadingOutlineRegular className=\{css\.updateIndicatorSpinner\} size=\{14\}/);
  assert.match(indicator, /IconDownloadOutlineRegular size=\{14\}/);
  assert.match(indicator, /css\.updateIndicatorErrorDot/);
  // 无可见文本：label 只进 tooltip 与 aria-label，绝不渲染成文本节点。
  assert.doesNotMatch(indicator, /\{label\}\s*<\/span>/);
  assert.doesNotMatch(indicator, /triggerLabel/);
});

test('⟨P02⟩ CSS：恢复上游 triggerRow 行度量，trigger 行内 flex:1，rail 单按钮不自适应', () => {
  // 行：flex + 42px 节奏 + 折回的行度量（原本折叠在按钮上）。
  assert.match(css, /\.triggerRow \{[\s\S]*?display: flex;[\s\S]*?gap: 8px;[\s\S]*?width: calc\(100% \+ 4px\);[\s\S]*?margin: 4px -2px;[\s\S]*?\}/);
  // 按钮在行内让位给指示器。
  assert.match(css, /\.trigger \{[\s\S]*?flex: 1;[\s\S]*?min-width: 0;[\s\S]*?width: auto;[\s\S]*?height: 42px;[\s\S]*?margin: 0;[\s\S]*?\}/);
  // rail 仍是单个 36x36 圆形按钮（无行容器，不能被 flex:1 拉伸）。
  assert.match(css, /\.trigger\.rail \{[\s\S]*?flex: none;[\s\S]*?width: 36px;[\s\S]*?height: 36px;/);
  // 旧注释明写「chamber 只渲染按钮」——行为已反转，注释不得留下矛盾表述。
  assert.doesNotMatch(css, /renders the\s+button alone/);
  // 指示器自身的三个状态类存在（组件 className 必须有样式）。
  for (const cls of ['updateIndicator', 'updateIndicatorIcon', 'updateIndicatorErrorDot', 'updateIndicatorSpinner']) {
    assert.match(css, new RegExp('\\.' + cls + ' \\{'), cls + ' 缺 CSS 规则');
  }
});

test('⟨P05⟩ CSS：技术详情 details/pre 行内样式存在（P05 组件接线在 update-gate.test.ts）', () => {
  assert.match(css, /\.updateTechDetails \{[\s\S]*?flex-basis: 100%;[\s\S]*?\}/);
  assert.match(css, /\.updateTechDetails pre \{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;[\s\S]*?\}/);
});
