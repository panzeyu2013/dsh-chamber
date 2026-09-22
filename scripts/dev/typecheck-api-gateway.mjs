#!/usr/bin/env node
/**
 * Chamber-owned static gate for `packages/dsh-api-gateway`.
 *
 * The engine (programs to run, vendor-diagnostic filtering, failure shape) is
 * scripts/dev/typecheck-sdk-copy.mjs; this entry keeps the package argument and
 * the gate label so the root manifest's `typecheck:api-gateway` command is unchanged.
 */
import { runTypecheckCopy } from './typecheck-sdk-copy.mjs'

if (!runTypecheckCopy({
  packageDir: 'dsh-api-gateway',
  label: 'typecheck:api-gateway',
  projects: ['client'],
})) process.exit(1)
