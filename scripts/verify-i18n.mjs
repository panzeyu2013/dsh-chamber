/**
 * Bilingual-pair consistency record (docs/i18n-record.json): the SHA-256 of
 * each side of every EN/中文 pair as of the last confirmed-consistent state.
 * Both languages carry equal authority; after editing either side, bring the
 * other along and re-record with `npm run verify:i18n -- --write`.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const PAIRS = [
  ['README.md', 'docs/README.zh-CN.md'],
  ['AGENTS.md', 'docs/AGENTS.zh-CN.md'],
  ['CONTRIBUTING.md', 'docs/CONTRIBUTING.zh-CN.md'],
]
const RECORD_FILE = 'docs/i18n-record.json'

function sha256(relPath) {
  return createHash('sha256').update(readFileSync(join(ROOT, relPath))).digest('hex')
}

const write = process.argv.includes('--write')
const recordPath = join(ROOT, RECORD_FILE)
let record = { files: {} }
try {
  record = JSON.parse(readFileSync(recordPath, 'utf8'))
} catch { /* first run */ }
record.files ??= {}

let drifted = false
for (const [en, zh] of PAIRS) {
  const hashes = { en: sha256(en), zh: sha256(zh) }
  const prev = record.files[en]
  const ok = prev !== undefined && prev.en === hashes.en && prev.zh === hashes.zh
  console.log(`${(write ? 'recorded' : ok ? 'consistent' : 'DRIFTED').padEnd(12)} ${en}`)
  if (write) record.files[en] = hashes
  else if (!ok) drifted = true
}

if (write) {
  writeFileSync(recordPath, `${JSON.stringify(record, undefined, 2)}\n`)
  console.log(`record written: ${RECORD_FILE}`)
} else if (drifted) {
  console.error('\none or more pairs drifted — sync the other side, then run: npm run verify:i18n -- --write')
  process.exit(1)
}
