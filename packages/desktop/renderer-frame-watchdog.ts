/** Visible renderer frame-scheduling probe for the Electron shell.
 *
 * A responsive IPC/JS context can coexist with a stopped animation loop. The
 * main process therefore samples a page-owned rAF heartbeat while the window
 * is focused and visible. One frame per second is enough to prove scheduling
 * without adding another 60/120 Hz callback to the renderer's hot path.
 * This is evidence of rAF scheduling, not a claim that pixels were composited.
 */

export const RENDERER_FRAME_PROGRESS_SCRIPT = `
(function () {
  if (document.visibilityState !== 'visible') return null;
  var name = '__dshChamberFrameProgress';
  if (!window[name]) {
    var state = { frames: 0 };
    Object.defineProperty(window, name, { value: state });
    function frame() {
      // Acceptance injection (cross-shell harness): an armed 'frame-stop' fault
      // stops the loop for real, which is what the probe must observe.
      var injected = window.__dshChamberInjection;
      if (injected && typeof injected.armed === 'function'
          && injected.armed().indexOf('frame-stop') !== -1) return;
      state.frames += 1;
      setTimeout(function () { requestAnimationFrame(frame); }, 1000);
    }
    requestAnimationFrame(frame);
  }
  return window[name].frames;
})()
`;

export const RENDERER_FRAME_PROBE_INTERVAL_MS = 5_000;
export const RENDERER_FRAME_PROBE_TIMEOUT_MS = 3_000;
export const RENDERER_FRAME_MAX_STRIKES = 3;
/** Main-process round trip above which the renderer's JS thread is input-blocked
 *  (a long task can delay the probe while rAF still advances). Locked to
 *  tables.ladders.delivery.scheduleProbe.inputBlockRttMs by the ladder parity gate. */
export const RENDERER_INPUT_BLOCK_RTT_MS = 1_000;

/** Strike counters exposed to the renderer: the page cannot see a stopped rAF
 *  loop or its own input-blocked JS thread, the main-process probe can. Evidence
 *  only - the shell's own bounded reload remains the acting path. */
export interface RendererFrameObservation {
  readonly scheduleStrikes: number
  readonly inputBlockStrikes: number
}

export type RendererFrameAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'probe'; readonly id: number }
  | { readonly kind: 'input-block'; readonly rttMs: number }
  | { readonly kind: 'reload' };

/** One probe belongs to one navigation; late answers can never clear a strike. */
export class RendererFrameWatchdog {
  private nextId = 0;
  private active: { id: number; startedAt: number } | null = null;
  private lastProbeAt: number | null = null;
  private lastFrameCount: number | null = null;
  private strikes = 0;
  private inputBlockStrikes = 0;
  private lastEmitted = '0:0';

  /** Fired on every strike-counter change (including clears). */
  onChange: ((observation: RendererFrameObservation) => void) | null = null;

  private emitChange(): void {
    const key = this.strikes + ':' + this.inputBlockStrikes;
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.onChange?.({ scheduleStrikes: this.strikes, inputBlockStrikes: this.inputBlockStrikes });
  }

  reset(): void {
    this.active = null;
    this.lastProbeAt = null;
    this.lastFrameCount = null;
    this.strikes = 0;
    this.inputBlockStrikes = 0;
    this.emitChange();
  }

  tick(now: number): RendererFrameAction {
    if (this.active !== null) {
      if (now - this.active.startedAt < RENDERER_FRAME_PROBE_TIMEOUT_MS) return { kind: 'none' };
      return this.failed(this.active.id);
    }
    if (this.lastProbeAt !== null && now - this.lastProbeAt < RENDERER_FRAME_PROBE_INTERVAL_MS) {
      return { kind: 'none' };
    }
    const id = ++this.nextId;
    this.active = { id, startedAt: now };
    this.lastProbeAt = now;
    return { kind: 'probe', id };
  }

  succeeded(id: number, frameCount: number, rttMs?: number): RendererFrameAction {
    if (this.active?.id !== id) return { kind: 'none' };
    this.active = null;
    // The frame count is valid evidence even when the round trip was slow: record
    // progress first so a later healthy probe cannot turn it into a frame strike.
    const progressed = this.lastFrameCount === null || frameCount > this.lastFrameCount;
    this.lastFrameCount = frameCount;
    if (rttMs !== undefined && rttMs > RENDERER_INPUT_BLOCK_RTT_MS) {
      this.inputBlockStrikes++;
      if (this.inputBlockStrikes >= RENDERER_FRAME_MAX_STRIKES) {
        this.reset();
        return { kind: 'reload' };
      }
      this.emitChange();
      return { kind: 'input-block', rttMs };
    }
    this.inputBlockStrikes = 0;
    this.strikes = progressed ? 0 : this.strikes + 1;
    const action = this.finishStrike();
    this.emitChange();
    return action;
  }

  failed(id: number): RendererFrameAction {
    if (this.active?.id !== id) return { kind: 'none' };
    this.active = null;
    this.strikes++;
    const action = this.finishStrike();
    this.emitChange();
    return action;
  }

  /** A document declared hidden; only the current probe may suspend judgment. */
  suspended(id: number): void {
    if (this.active?.id === id) this.reset();
  }

  private finishStrike(): RendererFrameAction {
    if (this.strikes < RENDERER_FRAME_MAX_STRIKES) return { kind: 'none' };
    this.reset();
    return { kind: 'reload' };
  }
}
