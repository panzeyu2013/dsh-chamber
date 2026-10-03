/**
 * Registers the shell test loader in web-only mode: maps `@deepseek-ai/dsh-client-web`
 * to the committed fixture but does NOT replace `@dsh-chamber/dsh-chamber-client-core`
 * with the narrow shim. Used by tests whose module graph already loads the real
 * client-core barrel (a module importing `shell.ts` from an app hook), where the shim's
 * intentionally small face would fail link time. See test-shell-loader.mjs.
 */
import { register } from 'node:module'

register('./test-shell-loader.mjs', import.meta.url, { data: { shimClientCore: false } })
