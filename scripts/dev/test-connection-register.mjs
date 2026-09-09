/** Register the connection client test loader without the deprecated CLI flag. */
import { register } from 'node:module'

register('./test-connection-loader.mjs', import.meta.url)
