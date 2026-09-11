/**
 * Upstream-alignment source locks (2026-09-11 batch): T2, T3, T4, T7, T8, T9,
 * A2, A3 and the two「small invented bits」.
 *
 * These pin CONTRACTS the panel depends on and the traps it must not fall back
 * into. They are source-text locks on purpose (plain node, no DOM, no cordis
 * runtime) — the same technique `settings-extensions.test.ts` already uses in
 * this package. The locks match the source with comments STRIPPED
 * (`stripComments`): comments next to this code describe the very invariants
 * pinned here, so a raw-text match could be satisfied by a comment alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read one source file of this package. */
function code(relative: string): string {
  return stripComments(raw(relative));
}

/** Read one source file of this package with its comments intact. */
function raw(relative: string): string {
  return readFileSync(join(HERE, relative), 'utf8');
}

/** Every .ts/.tsx source file under one directory (absolute paths, sorted). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Remove line/block comments while preserving string and template literals. */
function stripComments(source: string): string {
  let out = '';
  let quote: string | undefined;
  let line = false;
  let block = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (line) {
      if (ch === '\n') { line = false; out += ch; } else out += ' ';
      continue;
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1; } else out += ch === '\n' ? ch : ' ';
      continue;
    }
    if (quote !== undefined) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue; }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

test('T4: every outlet render is anchored by a display:contents [data-slot] wrapper', () => {
  const outlet = code('../src/client/bridge-outlet.tsx');
  assert.ok(outlet.includes("const ANCHOR_STYLE = { display: 'contents' } as const"),
    'the outlet must expose the official anchor style constant');
  assert.ok(/return \(\s*<div data-slot=\{slotKey\} style=\{ANCHOR_STYLE\}>\s*\{renderOutletContent\(/.test(outlet),
    'the anchor must wrap the WHOLE dispatch result (winner, fallback and crash paths alike), not one branch');
  assert.ok(outlet.includes('data-slot-error={slotKey}'),
    'the addressable crash face stays inside the anchor');
  // The dispatch runs inside the anchor, so an early return in the component
  // body would reintroduce the flicker the anchor contract prevents.
  const component = outlet.slice(
    outlet.indexOf('export function BridgeOutlet('),
    outlet.indexOf('function renderOutletContent('),
  );
  assert.ok(component.length > 0 && !/return (null|<)/.test(component.replace(/return \(\s*<div data-slot/g, 'return (')),
    'the outlet component must only return the anchored wrapper — never an unanchored early path');
  assert.ok(/function renderOutletContent\(/.test(outlet),
    'the kind dispatch (winner / dead cell / dry cell / fallback / undeclared) lives behind the anchor');
});

test('T4: the occupied-but-absent keyed cell renders the addressable dead cell', () => {
  const outlet = code('../src/client/bridge-outlet.tsx');
  assert.ok(outlet.includes('dispatchKeyedCell('),
    'the keyed branch must dispatch through the shared cell logic');
  assert.ok(outlet.includes('slots.entries(slotKey)') && outlet.includes('slots.entriesOfSlot(slotKey)'),
    'the dead-cell decision needs BOTH ledger views (raw entries vs shadowing winners)');
  assert.ok(/cell\.kind === 'dead'[\s\S]{0,120}data-slot-error=\{slotKey\}/.test(outlet),
    'an occupied key with no winner must render the crash face, not the owner fallback');
  assert.ok(outlet.includes('dispatchListCells('),
    'the list branch mirrors the same contract: dry cells keep an addressable row');
});

test('T3: the shell coordinates its OWN ctx onboarding stage, mounting exactly one step', () => {
  const shell = code('../src/client/SettingsShell.tsx');
  assert.ok(shell.includes("getSettingsSourceFace(chamberInstanceId)"),
    'the stage reads the shell’s OWN ctx ledger (the ctx-side face half published by this plugin)');
  assert.ok(shell.includes('sessionsSeatOf(props)'),
    'readiness comes from the sessions seat the renderer delivered to this shell');
  assert.ok(shell.includes('useActiveView(chamberInstanceId)'),
    'the stage is gated on the chamber active-view fact (a hidden shell must not pop a dialog over another view)');
  const hooks = code('../src/client/onboarding-hooks.ts');
  assert.ok(hooks.includes('chamberBridge.getActiveSource()') && hooks.includes('chamberBridge.onActiveSource('),
    'the gate reads and subscribes to the EXISTING App-published active-view fact — no new channel');
  assert.ok(shell.includes('nextOnboardingStep(onboardingSteps, completedOnboarding)'),
    'exactly one step is selected: the first ordered entry not yet completed');
  assert.ok(shell.includes("slotKey=\"settings.onboarding\""),
    'the step is mounted from the source ledger through the bridge outlet');
  assert.ok(shell.includes('opts={{ only: onboardingStep.id }}'),
    'the outlet dispatches ONLY the selected step id');
  assert.ok(shell.includes('complete: () => { completeOnboardingStep(onboardingStep.id) }'),
    'the step receives the coordinator’s complete callback');
  assert.ok(shell.includes('openSection') && /const openSection = useCallback/.test(shell),
    'the step owns its route into the panel (openSection)');
  assert.ok(/BridgeEntryBoundary containAll slotKey="settings.onboarding"/.test(shell),
    'a crashed foreign step must not abdicate the chamber-owned shell');
  // The stage is per-ctx, never re-derived from the panel's selected source, and
  // the chamber never invents its own copy of a step.
  assert.ok(!/onboardingSteps[\s\S]{0,80}usableFace/.test(shell),
    'the stage must not be driven by the panel’s selected-source face');
  assert.ok(!/dshRuntimeOnboarding|welcomeNotice|apiKeyOnboarding/.test(shell),
    'the chamber must not invent its own onboarding copy');
});

test('T7: 42px trigger row, one page title, focus returns to the trigger', () => {
  const shell = code('../src/client/SettingsShell.tsx');
  const css = code('../src/client/SettingsShell.module.css');
  assert.ok(/\.trigger \{[\s\S]*?height: 42px;/.test(css),
    'the trigger keeps upstream’s 42px row height (the sidebar foot CSS is upstream-identical)');
  assert.ok(/\.trigger \{[\s\S]*?padding: 0 10px 0 8px;/.test(css),
    'the trigger keeps upstream’s row padding');
  assert.ok(!shell.includes('headerTitle') && !css.includes('headerTitle'),
    'the duplicated content-header title is gone (each section renders its own <h2>)');
  assert.ok(shell.includes('headerSub'),
    'the server sub-line (the N-source addition) stays');
  assert.ok(/ref=\{triggerButton\}/.test(shell),
    'the trigger element is tracked for focus restore');
  assert.ok(/if \(wasOpen\.current && !open\) triggerButton\.current\?\.focus\(\)/.test(shell),
    'closing the dialog returns focus to the trigger (upstream wasOpen effect)');
  assert.ok(css.includes('border-radius: 32px;'),
    'the panel takes upstream’s actual r32 rule');
});

test('T8: the chamber-global nav entry no longer collides with the official section name', () => {
  const locales = code('../src/locales.ts');
  const shell = code('../src/client/SettingsShell.tsx');
  assert.ok(!locales.includes('generalNav') && !locales.includes('generalTitle'),
    'the colliding keys are gone');
  assert.ok(/clientNav: '(客户端|桌面)'/.test(locales) && /clientNav: 'Desktop'/.test(locales),
    'the renamed entry is unambiguous in both locales');
  assert.ok(shell.includes("t('clientNav')"),
    'the nav cell renders the renamed entry');
  const view = code('../src/client/GeneralView.tsx');
  assert.ok(view.includes("<h2 className={css.generalTitle}>{t('clientNav')}</h2>"),
    'the page heading shares the nav entry’s name (one name for that page)');
});

test('T9: the switch and the action capsules are the shared primitives', () => {
  const view = code('../src/client/GeneralView.tsx');
  const shell = code('../src/client/SettingsShell.tsx');
  const css = code('../src/client/SettingsShell.module.css');
  assert.ok(view.includes("import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'"),
    'GeneralView imports the shared controls');
  assert.ok(/<Switch\s+checked=\{/.test(view),
    'the badge switch is the primitive');
  assert.ok(/<DisclosureSwitch/.test(view) && /aria-expanded=\{expanded\} aria-controls=\{controls\}/.test(view),
    'the disclosure rows keep aria-expanded/aria-controls on the wrapper');
  for (const dead of ['generalSwitchInput', 'generalSwitchThumb', 'updateButton', 'updatePrimaryButton']) {
    assert.ok(!view.includes(dead) && !shell.includes(dead) && !css.includes(dead),
      `the hand-rolled ${dead} vocabulary must be gone`);
  }
  const runtime = code('../src/client/DshRuntimeSection.tsx');
  const update = code('../src/client/UpdateSection.tsx');
  for (const [name, source] of [['DshRuntimeSection.tsx', runtime], ['UpdateSection.tsx', update], ['GeneralView.tsx', view]] as const) {
    assert.ok(!/<button[\s\S]{0,200}?className=\{css\.update/.test(source),
      `${name} must not hand-roll an action capsule`);
    assert.ok(/<Button variant="(outline|primary)" size="sm"/.test(source),
      `${name} uses the shared Button recipe`);
  }
});

test('A2/A3: the upstream symbols are imported, not re-implemented', () => {
  const rows = code('../src/client/section-rows.ts');
  assert.ok(rows.includes("import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'"),
    'the nav projection imports upstream’s exported label resolver');
  assert.ok(!rows.includes('typeof entry.options.label ==='),
    'the local label-fallback copy is gone');
  const outlet = code('../src/client/bridge-outlet.tsx');
  assert.ok(outlet.includes("import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'"),
    'the outlet binds hooks with the renderer’s own exported factory');
  assert.ok(!outlet.includes('hookCache') && !outlet.includes('bindSnapshotSelector'),
    'the local observable-hook copy is gone');
  assert.ok(outlet.includes('observableHook(source)') && outlet.includes('observableHook(store)'),
    'both binding sites (inject hooks compartment, store seat) use it');
});

test('small invented bits: the empty-ledger reason is explicit and the r24 comment stays honest', () => {
  const shell = code('../src/client/SettingsShell.tsx');
  assert.ok(shell.includes("t('sectionsEmpty')"),
    'the empty-ledger placeholder is a deliberate, documented N-source state');
  const css = code('../src/client/SettingsShell.module.css');
  assert.ok(!css.includes('border-radius: 24px;'),
    'the panel radius follows upstream’s rule, not its stale comment');
});

test('T2: no live native confirm survives anywhere in this package', () => {
  // Every .ts/.tsx under src, comments stripped: the rationale comments in
  // DshRuntimeSection.tsx name the removed API, so the lock must read code.
  const files = sourceFiles(join(HERE, '../src'));
  assert.ok(files.length > 20, 'the walk must actually reach the package sources');
  for (const relative of files) {
    const source = stripComments(readFileSync(relative, 'utf8'));
    assert.ok(!/window\s*\.\s*confirm/.test(source),
      `${relative} must not call the native confirm dialog`);
    assert.ok(!/\bconfirm\s*\(/.test(source),
      `${relative} must not call a bare confirm(...)`);
  }
  // The old split claim is gone from the raw text too (doc and code must not
  // contradict each other again).
  for (const relative of ['../src/client/DshRuntimeSection.tsx', '../src/locales.ts']) {
    const source = raw(relative);
    for (const claim of ['desktop = native dialog', 'gateway = UI window.confirm', '桌面侧同文案走原生确认']) {
      assert.ok(!source.includes(claim), `${relative} must not claim the removed native/gateway split (${claim})`);
    }
  }
});

test('T2: the confirmation is the official Modal with a cancel that performs nothing', () => {
  const runtime = code('../src/client/DshRuntimeSection.tsx');
  assert.ok(runtime.includes("import { Button, IconChevronDownOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'"),
    'the section imports the official Modal');
  assert.ok(/function RuntimeConfirmDialog\(/.test(runtime),
    'the section renders ONE confirmation dialog component');
  assert.ok(/<Modal\s+open\s+onClose=\{onCancel\}\s+title=\{request\.title\}\s+closeLabel=\{t\('close'\)\}/.test(runtime),
    'the dialog is the official Modal (title + required close label)');
  assert.ok(runtime.includes('description={request.description}'),
    'the copy the native confirm showed is the dialog description');
  assert.ok(runtime.includes("className={css.deleteDialog}"),
    'the dialog takes the compact confirm width');
  assert.ok(runtime.includes("className={css.deleteConfirm}"),
    'the destructive confirm is the error-toned outline capsule');
  assert.ok(runtime.includes("role=\"status\"") && runtime.includes('{request.pendingLabel}'),
    'the pending row is an aria-live status row');
  assert.ok(runtime.includes('disabled={pending}'),
    'both dialog actions are disabled while the action runs');
  // The transitions come from the pure machine: cancel drops the request, and
  // only accept launches a runner (pinned behaviourally in confirm-machine.test.ts).
  assert.ok(runtime.includes("from './confirm-machine.ts'") && runtime.includes('acceptConfirmStep(confirmState'),
    'the dialog is driven by the shared armed-confirmation machine');
  assert.ok(runtime.includes('confirmLaunchRef.current') && runtime.includes('if (confirmLaunchRef.current) return'),
    'a same-frame double click cannot stack a second launch');
});

test('T2: every destructive action asks first, in both shapes', () => {
  const runtime = code('../src/client/DshRuntimeSection.tsx');
  // Each handler's body must arm the confirmation — the old code called the
  // action directly after a native prompt.
  for (const handler of [
    'onRestoreBuiltin', 'onRetryApply', 'onRetryRestore', 'onCleanupRemote',
    'onRestorePreRollbackRemote', 'onRecoverMetadataRemote', 'onApplyNowRemote', 'onRestartDsh',
  ]) {
    const start = runtime.indexOf(`const ${handler} = useCallback(`);
    assert.ok(start !== -1, `${handler} must exist`);
    const end = runtime.indexOf('\n  const ', start + 10);
    const body = runtime.slice(start, end === -1 ? undefined : end);
    assert.ok(body.includes('askConfirm({'),
      `${handler} must arm the in-app confirmation instead of running directly`);
    assert.ok(body.includes('run:'),
      `${handler} must hand its action to the dialog as the confirmed runner`);
  }
  // The shared restart path (both shapes) and the gateway mutations render the
  // same dialog: one render site per shape, one state machine.
  const sites = runtime.match(/request=\{confirmState\.request\}/g) ?? [];
  assert.equal(sites.length, 2, 'the dialog renders in both the gateway and the local branch');
  assert.equal((runtime.match(/useState<ConfirmState<RuntimeConfirmRequest>>/g) ?? []).length, 1,
    'exactly one armed-confirmation state machine exists in the section');
  // No action may run without having gone through the dialog: the runners all
  // live inside `run:` closures of an armed request.
  assert.ok(runtime.includes('run: runRestartDsh'), 'the restart runner is the armed request’s runner');
});
