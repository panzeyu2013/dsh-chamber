/**
 * Shared plugin-sync chamber projection fixtures built from the dynamic
 * registry (CHAMBER_HOST_PACKAGES): one row per control-plane host package
 * plus the four-fact (installed/patched/version/live) accessors.
 * Bare helper file — never registered in scripts/test.mjs.
 */

import assert from 'node:assert/strict'
import { CHAMBER_HOST_PACKAGES, type ChamberHostPackageState, type ChamberInjectionState } from '../../plugin-sync.ts'

export function chamberPackageOf(chamber: ChamberInjectionState, name: string): ChamberHostPackageState {
  assert.ok(chamber.ok, 'chamber probe failed')
  const found = chamber.packages.find(pkg => pkg.name === name)
  assert.ok(found !== undefined, `chamber package ${name} missing from the projection`)
  return found
}

/** The dynamic registry projection (one row per CHAMBER_HOST_PACKAGES entry);
 *  redaction fixtures build the real shape instead of casting a fixed
 *  `hostGraph`/`gitWorktree` literal under `as never`. */
export function chamberProjection(
  overrides: Record<string, Partial<ChamberHostPackageState>> = {},
): ChamberInjectionState {
  return {
    ok: true,
    packages: CHAMBER_HOST_PACKAGES.map(descriptor => ({
      insertId: descriptor.insert.id,
      name: descriptor.insert.name,
      probe: descriptor.probe.method,
      installed: false,
      patched: false,
      version: null,
      live: null,
      ...(overrides[descriptor.insert.name] ?? {}),
    })),
  }
}

export function chamberFacts(chamber: ChamberInjectionState): Record<string, { installed: boolean; patched: boolean; version: string | null; live: boolean | null }> {
  assert.ok(chamber.ok, 'chamber probe failed')
  return Object.fromEntries(chamber.packages.map(pkg => [pkg.name, {
    installed: pkg.installed, patched: pkg.patched, version: pkg.version, live: pkg.live,
  }]))
}

/** The four probed facts of one package (the registry identity fields are
 *  covered by the registry-driven assertions below). */
export function chamberStateOf(chamber: ChamberInjectionState, name: string): { installed: boolean; patched: boolean; version: string | null; live: boolean | null } {
  const pkg = chamberPackageOf(chamber, name)
  return { installed: pkg.installed, patched: pkg.patched, version: pkg.version, live: pkg.live }
}
