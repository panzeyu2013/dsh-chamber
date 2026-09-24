//
//  RendererHangWatchdog.swift
//  DSHChamber
//
//  A live JS context does not prove that the page is producing frames. Probe
//  both JS replies and a page-owned requestAnimationFrame counter while the
//  window is visible. Input cannot reset the evidence: a frozen page can still
//  receive native key and mouse events. A navigation or hidden window pauses
//  the judgment because WebKit may legitimately suspend animation frames.
//  A slow JS reply is its own evidence: a long task blocks the probe round trip
//  while animation frames still advance (Electron's input-block leg, same table).
//
import Foundation

/// Visible-page responsiveness judgment, independent of WebKit. The caller
/// passes monotonic system uptime, so clock corrections cannot defer recovery.
struct RendererHangWatchdog {
    static let probeInterval: TimeInterval = 5
    static let probeTimeout: TimeInterval = 3
    static let maxStrikes = 3
    /// Input-block round-trip budget in seconds: the shared delivery ladder's
    /// `scheduleProbe.inputBlockRttMs` (1000 ms), the same leaf the Electron
    /// watchdog's `RENDERER_INPUT_BLOCK_RTT_MS` is locked to. The parity gate
    /// compares this constant with that shared-table leaf on every run (and the
    /// mirror decodes the leaf itself in CarrierDecision.swift), so the shell owns
    /// no independent copy - do not inline the number.
    static let inputBlockRtt: TimeInterval = 1

    enum Action: Equatable {
        case nothing
        case probe(UInt64)
        /// The JS thread answered, but past the round-trip budget: evidence of an
        /// input-blocked page, not (yet) a frame strike.
        case inputBlock(rtt: TimeInterval)
        case reload
    }

    private(set) var strikes = 0
    private(set) var inputBlockStrikes = 0
    private(set) var loadedOnce = false
    private var lastProbeAt: TimeInterval?
    private var probeInFlightSince: TimeInterval?
    private(set) var activeProbeID: UInt64?
    private var nextProbeID: UInt64 = 0
    private var lastFrameCount: Int?

    init() { }

    mutating func noteFirstLoadFinished() {
        loadedOnce = true
        reset()
    }

    /// Navigation, suspension, and recovery each begin a new evidence window.
    mutating func reset() {
        strikes = 0
        inputBlockStrikes = 0
        lastProbeAt = nil
        probeInFlightSince = nil
        activeProbeID = nil
        lastFrameCount = nil
    }

    /// A late callback from an expired probe or a previous navigation is inert.
    /// `rtt` (seconds) is the round trip the caller timed with the shell's
    /// monotonic clock. Over budget is input-block evidence even when a frame
    /// arrived: the frame count is still recorded as progress first, so a later
    /// healthy probe cannot turn it into a frame strike (Electron
    /// `RendererFrameWatchdog.succeeded`).
    mutating func noteProbeSucceeded(
        id: UInt64,
        frameCount: Int,
        rtt: TimeInterval? = nil
    ) -> Action {
        guard activeProbeID == id else { return .nothing }
        probeInFlightSince = nil
        activeProbeID = nil
        let progressed: Bool
        if let previous = lastFrameCount {
            progressed = frameCount > previous
        } else {
            progressed = true
        }
        lastFrameCount = frameCount
        if let rtt, rtt > Self.inputBlockRtt {
            inputBlockStrikes += 1
            if inputBlockStrikes >= Self.maxStrikes {
                reset()
                return .reload
            }
            return .inputBlock(rtt: rtt)
        }
        inputBlockStrikes = 0
        strikes = progressed ? 0 : strikes + 1
        return reachedLimit()
    }

    mutating func noteProbeFailed(id: UInt64) -> Action {
        guard activeProbeID == id else { return .nothing }
        probeInFlightSince = nil
        activeProbeID = nil
        strikes += 1
        return reachedLimit()
    }

    /// A one-second timer observes the real three-second deadline even though
    /// new probes are issued no more often than every five seconds.
    mutating func tick(now: TimeInterval) -> Action {
        guard loadedOnce else { return .nothing }
        if let started = probeInFlightSince {
            guard now - started >= Self.probeTimeout,
                  let id = activeProbeID else { return .nothing }
            return noteProbeFailed(id: id)
        }
        if let last = lastProbeAt,
           now - last < Self.probeInterval { return .nothing }
        nextProbeID &+= 1
        activeProbeID = nextProbeID
        lastProbeAt = now
        probeInFlightSince = now
        return .probe(nextProbeID)
    }

    private mutating func reachedLimit() -> Action {
        guard strikes >= Self.maxStrikes else { return .nothing }
        reset()
        return .reload
    }
}
