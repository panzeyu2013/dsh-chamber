/**
 * Shared gateway-runtime status fixture (design 18 §9.3): one idle/ready
 * snapshot the status-view, confirm-guard and action-gate suites override per
 * case. The factory itself is the shared test-support module (2026-12
 * single-sourcing pass); this file stays as the settings-bridge import path.
 */
export { remoteStatus } from '../../../../scripts/dev/test-support/gateway-runtime-fixture.ts'
