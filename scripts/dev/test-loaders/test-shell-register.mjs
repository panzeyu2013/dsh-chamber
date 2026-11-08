/**
 * Registers the shell test loader (node >= 22 `module.register`; used via
 * `--import` so no `--experimental-loader` deprecation path is needed).
 * See test-shell-loader.mjs for what it maps and why.
 */
import { register } from 'node:module'

register('./test-shell-loader.mjs', import.meta.url)
