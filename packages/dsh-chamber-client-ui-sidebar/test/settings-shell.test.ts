/**
 * settings-shell.ts tests (2026-12): the reserved `sidebar.settings` seat
 * contract. The failure mode under test is a third-party plugin registering
 * BELOW the reserved shadow range and silently replacing the whole chamber
 * settings surface (server dropdown + every per-source plugin section).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SHELL_ENTRY_ID,
  SETTINGS_SHELL_SHADOW_PRIORITY,
  classifySettingsSeatOccupant,
  settingsSeatTakeoverMessage,
} from '../src/shared/settings-shell.ts';

test('classifySettingsSeatOccupant: the chamber shell owns the seat', () => {
  assert.equal(classifySettingsSeatOccupant({ options: { id: SETTINGS_SHELL_ENTRY_ID, priority: SETTINGS_SHELL_SHADOW_PRIORITY } }), 'chamber');
});

test('classifySettingsSeatOccupant: no occupant / official SettingsRoot / higher-priority entries are never a takeover', () => {
  assert.equal(classifySettingsSeatOccupant(undefined), 'pending');
  // The official SettingsRoot registers at 0 during the deferred-cluster window.
  assert.equal(classifySettingsSeatOccupant({ options: { id: 'official-root', priority: 0 } }), 'pending');
  assert.equal(classifySettingsSeatOccupant({ options: { id: 'x', priority: SETTINGS_SHELL_SHADOW_PRIORITY + 1 } }), 'pending');
  assert.equal(classifySettingsSeatOccupant({ options: {} }), 'pending');
});

test('classifySettingsSeatOccupant: a registrant BELOW the reserved range is a takeover', () => {
  assert.equal(classifySettingsSeatOccupant({
    options: { id: 'rogue-shell', priority: SETTINGS_SHELL_SHADOW_PRIORITY - 1 },
  }), 'taken-over');
});

test('settingsSeatTakeoverMessage: names the occupant and the reserved range', () => {
  const message = settingsSeatTakeoverMessage('rogue-shell');
  assert.match(message, /rogue-shell/);
  assert.match(message, new RegExp(String(SETTINGS_SHELL_SHADOW_PRIORITY)));
  assert.match(message, /sidebar\.settings/);
});
