#!/usr/bin/env node
/**
 * Chamber-owned static gate for `packages/dsh-client-connection`.
 *
 * The engine (programs to run, vendor-diagnostic filtering, failure shape) is
 * scripts/dev/typecheck-sdk-copy.mjs; this entry keeps the package argument and
 * the gate label so the root manifest's `typecheck:connection` command is unchanged.
 */
import { runTypecheckCopy } from './typecheck-sdk-copy.mjs'

if (!runTypecheckCopy({
  packageDir: 'dsh-client-connection',
  label: 'typecheck:connection',
  projects: ['client', 'host'],
})) process.exit(1)
