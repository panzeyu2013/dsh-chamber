/**
 * Control-plane instance identity (design 02 §2.5): a UUID persisted at
 * <stateDir>/instance-id on first run; every spawn record carries it — the
 * multi-instance diagnostic base. Concurrent first runs race on an O_EXCL
 * ('wx') create: the winner's id is shared, the loser re-reads.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read <stateDir>/instance-id or persist a fresh UUID via an O_EXCL create
 * (concurrent first runs share the winner's id — the loser's create gets
 * EEXIST and re-reads).
 * @param stateDir - the control-plane state root.
 * @param deps - {randomUUID?} injectable for deterministic tests.
 * @returns the instance id.
 */
export function ensureInstanceId(stateDir: string, deps: { randomUUID?: () => string } = {}): string {
  const uuid = deps.randomUUID ?? randomUUID
  const file = join(stateDir, 'instance-id')
  mkdirSync(stateDir, { recursive: true })
  let existing = ''
  try {
    existing = readFileSync(file, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== '') return existing
  const created = uuid()
  try {
    writeFileSync(file, `${created}\n`, { flag: 'wx' })
    return created
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readFileSync(file, 'utf8').trim()
    if (raced !== '') return raced
    throw new Error('instance-id file raced to empty; fix <stateDir>/instance-id manually')
  }
}
