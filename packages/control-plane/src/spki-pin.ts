/**
 * SPKI certificate-pin helpers — single source for the desktop identity
 * probe AND the control-plane proxy forwarding gate (design 17 §13.4.2 /
 * S23): the user pins the expected gateway server certificate's SPKI
 * fingerprint and BOTH the desktop login probe and the reverse proxy reject
 * any peer whose public key does not match.
 *
 * These helpers used to exist as byte-identical copies in
 * desktop/gateway-provider.ts and control-plane/proxy-forward.ts, kept in
 * sync by a comment ("the packaged desktop cannot import the control
 * plane"). The desktop's dual-path facade (control-plane-module.ts +
 * build:control-plane dist artifact) removed that packaging constraint, so
 * the copy was deleted and both owners import this module.
 *
 * Mechanism note (verified on Node 22.22.3): checkServerIdentity's error
 * return is silently IGNORED when `rejectUnauthorized: false`, and with
 * `rejectUnauthorized: true` an untrusted (internal-CA) chain fails BEFORE
 * checkServerIdentity runs — so neither combination can enforce a pin against
 * an internal CA. The pin check therefore runs on the TLS socket's
 * 'secureConnect' event with `rejectUnauthorized: false` (the pin alone
 * decides trust) and `agent: false` (every pinned request opens a fresh
 * connection, so 'secureConnect' always fires): a mismatch destroys the
 * request with SPKI_PIN_MISMATCH_CODE, which the caller's upstream 'error'
 * path turns into an explicit 502 upstream_failed (proxy) or a loud probe
 * failure (desktop). Crucially, callers do not call `end`/`write` until this
 * gate invokes `dispatch`: a wrong-key peer sees zero HTTP headers,
 * credential bytes, or login body.
 */

import { createHash, X509Certificate } from 'node:crypto'
import type { ClientRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'

/** A valid SPKI pin: exactly 64 hex chars (hex sha256 of the SPKI DER). */
export const SPKI_PIN_PATTERN = /^[0-9a-fA-F]{64}$/

/** Error code attached to the destroy() error of a rejected pin. */
export const SPKI_PIN_MISMATCH_CODE = 'ERR_SPKI_PIN_MISMATCH'

/** The hex sha256 of a peer certificate's SPKI DER (S23) — the digest the
 * user pins. `rawDer` is the peer certificate's DER (TLSSocket
 * getPeerCertificate().raw): X509Certificate exposes the KeyObject whose
 * SPKI export is the canonical fingerprint. */
export function spkiPinOfPeerCertificate(rawDer: Buffer): string {
  return createHash('sha256')
    .update(new X509Certificate(rawDer).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}

/** Attach the pre-write SPKI pin gate to an outbound https request (S23): on TLS
 * handshake completion the peer certificate's SPKI digest is compared
 * case-insensitively with the pinned value; a mismatch destroys the request
 * with SPKI_PIN_MISMATCH_CODE, while a match invokes `dispatch` exactly once.
 * The caller MUST NOT write/end the request anywhere else: this is what keeps
 * HTTP headers and bodies behind the authenticated handshake. Callers must
 * ALSO pass `rejectUnauthorized:
 * false` (the pin replaces CA trust for this connection — the internal-CA use
 * case) and `agent: false` (so 'secureConnect' always fires). */
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
