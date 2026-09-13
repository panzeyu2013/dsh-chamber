/**
 * Cell dispatch tests (2026-09-11 upstream-alignment T4): the official outlet's
 * keyed and list branches, as plain unit tests.
 *
 * The contract under test is the difference between the raw ledger
 * (`entries`: every live registration) and the shadowing winners per cell
 * (`entriesOfSlot`) — a cell whose registrations all abdicated has no winner but
 * is still OCCUPIED, and the official outlet renders an addressable crash face
 * for it instead of the owner's natural-empty fallback. The chamber panel's
 * outlet used to fall through to the fallback there, which made a crashed
 * section indistinguishable from an unregistered one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchKeyedCell, dispatchListCells, type DispatchEntry } from '../src/client/cell-dispatch.ts';

/** One ledger entry as the registries store it. */
function entry(options: DispatchEntry['options']): DispatchEntry {
  return { options };
}

test('keyed dispatch: the shadowing winner for the requested key renders', () => {
  const winner = entry({ key: 'deepseek-official' });
  const loser = entry({ key: 'deepseek-official', priority: 1 } as DispatchEntry['options']);
  const cell = dispatchKeyedCell([winner, loser], [winner], 'deepseek-official');
  assert.deepEqual(cell, { kind: 'entry', entry: winner });
});

test('keyed dispatch: an occupied key with no winner is a dead cell, never the fallback', () => {
  // The registration exists on the raw ledger (so the key IS occupied) but every
  // candidate abdicated: `entriesOfSlot` skipped it.
  const abdicated = entry({ key: 'card-a' });
  assert.deepEqual(dispatchKeyedCell([abdicated], [], 'card-a'), { kind: 'dead' });
  // A different, unregistered key keeps the owner's fallback.
  assert.deepEqual(dispatchKeyedCell([abdicated], [], 'card-b'), { kind: 'fallback' });
  // No key requested at all: also the owner's fallback (upstream `opts?.entryKey`).
  assert.deepEqual(dispatchKeyedCell([abdicated], [], undefined), { kind: 'fallback' });
});

test('list dispatch: winners render in order, dry cells keep their row', () => {
  const models = entry({ id: 'models', order: 10 });
  const crashed = entry({ id: 'acme', order: 20 });
  const rows = dispatchListCells([models, crashed], [models], undefined);
  assert.deepEqual(rows, [
    { entry: models, id: 'models', order: 10 },
    // Dry cell: the id is anchored at the crashed head's declared order, so the
    // addressable crash row keeps the nav position the registration asked for.
    { entry: undefined, id: 'acme', order: 20 },
  ]);
});

test('list dispatch: `only` filters winners and dry cells alike', () => {
  const models = entry({ id: 'models', order: 10 });
  const crashed = entry({ id: 'acme', order: 20 });
  assert.deepEqual(dispatchListCells([models, crashed], [models], 'acme'), [
    { entry: undefined, id: 'acme', order: 20 },
  ]);
  assert.deepEqual(dispatchListCells([models, crashed], [models], 'models'), [
    { entry: models, id: 'models', order: 10 },
  ]);
  assert.deepEqual(dispatchListCells([models, crashed], [models], 'absent'), []);
});

test('list dispatch: order refines the ledger sequence, registration order breaks ties', () => {
  const late = entry({ id: 'late', order: 30 });
  const early = entry({ id: 'early', order: 5 });
  const tie = entry({ id: 'tie', order: 5 });
  assert.deepEqual(
    dispatchListCells([late, early, tie], [late, early, tie], undefined).map(row => row.id),
    ['early', 'tie', 'late'],
  );
  // A registration without an explicit order reads as 0 (the default every
  // official list projection uses).
  const defaulted = entry({ id: 'defaulted' });
  assert.deepEqual(
    dispatchListCells([late, defaulted], [late, defaulted], undefined).map(row => row.id),
    ['defaulted', 'late'],
  );
});
