/**
 * SPKI certificate-pin helpers — single source for the desktop identity probe
 * and the control-plane proxy forwarding gate: both reject any peer whose
 * certificate public key does not match the user's pinned fingerprint.
 *
 * Mechanism: checkServerIdentity cannot enforce a pin (it is ignored with
 * `rejectUnauthorized: false`, and an internal-CA chain fails before it runs
 * with `true`), so the check runs on the TLS socket's 'secureConnect' event
 * with `rejectUnauthorized: false` (the pin alone decides trust) and
 * `agent: false` (fresh connection each request, so 'secureConnect' always
 * fires). A mismatch destroys the request with SPKI_PIN_MISMATCH_CODE (caller
 * turns it into a 502 / loud probe failure). Callers must not write/end until
 * this gate dispatches: a wrong-key peer sees zero headers or credential bytes.
 */

import { createHash, X509Certificate } from 'node:crypto'
import type { ClientRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'

/** A valid SPKI pin: exactly 64 hex chars (hex sha256 of the SPKI DER). */
export const SPKI_PIN_PATTERN = /^[0-9a-fA-F]{64}$/

/** Error code attached to the destroy() error of a rejected pin. */
export const SPKI_PIN_MISMATCH_CODE = 'ERR_SPKI_PIN_MISMATCH'

/** The hex sha256 of a peer certificate's SPKI DER (the value the user pins);
 *  `rawDer` is the peer certificate DER (getPeerCertificate().raw). */
export function spkiPinOfPeerCertificate(rawDer: Buffer): string {
  return createHash('sha256')
    .update(new X509Certificate(rawDer).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}

/** Attach the pre-write SPKI pin gate to an outbound https request: on TLS
 * handshake completion the peer certificate's SPKI digest is compared
 * case-insensitively with the pinned value; a mismatch destroys the request
 * with SPKI_PIN_MISMATCH_CODE, a match invokes `dispatch` exactly once.
 * Callers MUST NOT write/end anywhere else and MUST pass
 * `rejectUnauthorized: false` (the pin replaces CA trust) and `agent: false`
 * (so 'secureConnect' always fires). */
export function attachSpkiPinVerifier(req: ClientRequest, pin: string, dispatch: () => void): void {
  let dispatched = false
  req.on('socket', (socket: NodeJS.Socket) => {
    ;(socket as TLSSocket).once('secureConnect', () => {
      let digest: string
      try {
        digest = spkiPinOfPeerCertificate((socket as TLSSocket).getPeerCertificate().raw)
      } catch {
        const error: NodeJS.ErrnoException = new Error('the gateway certificate could not be read for the SPKI pin check')
        error.code = SPKI_PIN_MISMATCH_CODE
        req.destroy(error)
        return
      }
      if (digest.toLowerCase() !== pin.toLowerCase()) {
        const error: NodeJS.ErrnoException = new Error('SPKI pin mismatch')
        error.code = SPKI_PIN_MISMATCH_CODE
        req.destroy(error)
        return
      }
      if (req.destroyed || dispatched) return
      dispatched = true
      dispatch()
    })
  })
}
