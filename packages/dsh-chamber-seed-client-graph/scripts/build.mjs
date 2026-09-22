#!/usr/bin/env node
/** Bundle @dsh-chamber/dsh-chamber-seed-client-graph into its build-time dist/index.js (shared bundler: scripts/lib/seed-build.mjs). */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSeedBundle } from '../../../scripts/lib/seed-build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
await buildSeedBundle({
  packageRoot: join(here, '..'),
  entry: 'src/index.ts',
  outfile: 'dist/index.js',
  external: ['@deepseek-ai/*'],
})
