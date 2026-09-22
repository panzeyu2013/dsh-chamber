/** Register the connection client test loader. */
import { register } from 'node:module'

register('./test-connection-loader.mjs', import.meta.url)
