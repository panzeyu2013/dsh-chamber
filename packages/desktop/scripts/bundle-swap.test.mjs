import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitBundleSwap, recoverBundleSwap } from './bundle-swap.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-bundle-swap-'));
  return {
    root,
    dest: path.join(root, 'dsh'),
    work: path.join(root, 'work'),
    backup: path.join(root, '.dsh-backup'),
  };
}

function seed(dir, value) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'marker'), value);
}

test('commitBundleSwap publishes verified work and removes the old backup', () => {
  const f = fixture();
  try {
    seed(f.dest, 'old');
    seed(f.work, 'new');
    commitBundleSwap(f.work, f.dest, f.backup);
    assert.equal(readFileSync(path.join(f.dest, 'marker'), 'utf8'), 'new');
    assert.equal(existsSync(f.backup), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('commitBundleSwap restores the last-known-good bundle when publishing fails', () => {
  const f = fixture();
  try {
    seed(f.dest, 'old');
    assert.throws(() => commitBundleSwap(f.work, f.dest, f.backup));
    assert.equal(readFileSync(path.join(f.dest, 'marker'), 'utf8'), 'old');
    assert.equal(existsSync(f.backup), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('recoverBundleSwap restores an interrupted old-bundle move', () => {
  const f = fixture();
  try {
    seed(f.backup, 'old');
    assert.equal(recoverBundleSwap(f.dest, f.backup), 'restored');
    assert.equal(readFileSync(path.join(f.dest, 'marker'), 'utf8'), 'old');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
