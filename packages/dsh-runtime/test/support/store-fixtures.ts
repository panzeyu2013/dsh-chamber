/**
 * Shared fixtures for the packages/dsh-runtime/test/store/ store-suite split
 * (P0): temp base, version-tree builder, activation-journal record. Test-only.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ActivationJournal } from '../../src/dsh-runtime-store.ts';

export const freshBase = (): string => mkdtempSync(path.join(tmpdir(), 'dsh-runtime-store-'));

/** The dsh tree's critical-file digests (package.json + lib/bin.js). */
export function criticalFilesFor(tree: string): Record<string, string> {
  return Object.fromEntries([
    'node_modules/@deepseek-ai/dsh/package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].map(relativePath => [
    relativePath,
    `sha256-${createHash('sha256').update(readFileSync(path.join(tree, relativePath))).digest('base64')}`,
  ]));
}

export function makeVersionTree(base: string, version: string, platform = `${process.platform}-${process.arch}`): string {
  const tree = path.join(base, 'dsh-runtime', version);
  const binDir = path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'bin.js'), '// fixture', 'utf8');
  writeFileSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version,
  }), 'utf8');
  const criticalFiles = criticalFilesFor(tree);
  writeFileSync(path.join(tree, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform, criticalFiles },
  }), 'utf8');
  return tree;
}

const DEFAULT_JOURNAL: Omit<ActivationJournal, 'phase'> = {
  schemaVersion: 1,
  targetVersion: '2.0.0',
  targetIsBuiltin: false,
  manualRollback: false,
  intentKind: 'version-switch',
  sourceVersion: '1.0.0',
  sourceIsBuiltin: false,
  sourceWasKnownGood: true,
  knownGoodVersion: '1.0.0',
  preSwapSnapshotName: '1.0.0-1724371200000',
  manualDataSnapshotName: null,
  preRollbackStashName: null,
  rollbackTarget: null,
  nextIntent: null,
  startedAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}

/** A journal builder bound to a suite's own durable defaults. */
export function journalBuilder(
  defaults: Partial<ActivationJournal> = {},
): (phase: ActivationJournal['phase'], patch?: Partial<ActivationJournal>) => ActivationJournal {
  return (phase, patch = {}) => ({ ...DEFAULT_JOURNAL, ...defaults, phase, ...patch })
}

export function journalFixture(
  phase: ActivationJournal['phase'] = 'prepared',
  patch: Partial<ActivationJournal> = {},
): ActivationJournal {
  return journalBuilder()(phase, patch)
}
