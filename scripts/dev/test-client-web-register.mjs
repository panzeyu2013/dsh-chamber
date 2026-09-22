/** Register the real boot.ts test loader. */
import { register } from 'node:module'

register('./test-client-web-loader.mjs', import.meta.url)
