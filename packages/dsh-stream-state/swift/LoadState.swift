//
//  LoadState.swift
//  Swift mirror - the shell's explicit load state machine.
//
//  WHY THIS FILE EXISTS. Three independent booleans cannot express the load state
//  safely: a `didStartLoading` latch with no reset point, a `webViewContentAlive`
//  that stays true through a failure face, and a probe error recorded as success.
//  The TS package owns the machine
//  (`packages/dsh-stream-state/src/load-state.ts`); this file is the SWIFT mirror the
//  shell actually runs, so the phase names, the generation fence and the thresholds
//  have one definition on both sides.
//
//  PURITY. Foundation only, no AppKit/WebKit: the parity gate
//  (`scripts/gates/verify-stream-state-swift-parity.mjs`) compiles this file with a
//  plain `swiftc` on any platform, and the CI macOS leg compiles it with the app.
//
//  SCOPE. The pure machine only. Owning the WKWebView, the timers and the sidecar is
//  the shell's job (design 25); this file decides, it does not execute.
//

import Foundation

/// The phases, in the order a healthy shell visits them.
public enum LoadPhase: String, CaseIterable, Equatable {
  case cold
  case probing
  case loading
  case loaded
  case retrying
  case failurePage
}

public struct LoadEnv: Equatable {
  /// Failed probes before the shell moves to `retrying`.
  public let probeStrikeLimit: Int
  /// Retries before the give-up gate may fire.
  public let retryLimit: Int
  /// Loads this long without content are late (the reported progress SLA).
  public let progressSlaMs: Double

  public init(probeStrikeLimit: Int, retryLimit: Int, progressSlaMs: Double) {
    self.probeStrikeLimit = probeStrikeLimit
    self.retryLimit = retryLimit
    self.progressSlaMs = progressSlaMs
  }
}

public struct LoadState: Equatable {
  public var phase: LoadPhase
  /// Every event belongs to a generation; a stale one is ignored.
  public var generation: Int
  /// Consecutive failed probes in THIS generation (reset by a success).
  public var probeStrikes: Int
  /// A crash recovery is in flight: cleared when content is honestly alive.
  public var recoveringFromCrash: Bool
  /// The one-shot give-up gate: consumed when the failure page is shown.
  public var giveUpSpent: Bool
  /// When the current load armed, for the progress SLA. Nil while not loading.
  public var loadingSinceMs: Double?

  public init(
    phase: LoadPhase, generation: Int, probeStrikes: Int,
    recoveringFromCrash: Bool, giveUpSpent: Bool, loadingSinceMs: Double?
  ) {
    self.phase = phase
    self.generation = generation
    self.probeStrikes = probeStrikes
    self.recoveringFromCrash = recoveringFromCrash
    self.giveUpSpent = giveUpSpent
    self.loadingSinceMs = loadingSinceMs
  }

  public static let initial = LoadState(
    phase: .cold, generation: 0, probeStrikes: 0,
    recoveringFromCrash: false, giveUpSpent: false, loadingSinceMs: nil
  )

  /// The honest answer to "webViewContentAlive": NOT a flag the page sets, but this
  /// predicate. Only `loaded` counts.
  public var contentIsBelievable: Bool { phase == .loaded }

  /// Whether the load has outlived its progress SLA. A predicate: the retry schedule
  /// is what acts on it.
  public func isLate(now: Double, env: LoadEnv) -> Bool {
    guard let since = loadingSinceMs else { return false }
    return now - since > env.progressSlaMs
  }
}

public enum LoadEffect: Equatable {
  case scheduleRecovery(generation: Int)
  case showFailurePage
  case log(name: String, detail: String)
}

public enum LoadEvent: Equatable {
  case generationStarted(generation: Int, at: Double)
  case loadStarted(generation: Int, at: Double)
  case contentAlive(generation: Int, at: Double)
  case probeSucceeded(generation: Int, at: Double)
  case probeFailed(generation: Int, at: Double)
  case recoveryScheduled(generation: Int, at: Double)
  case recoveryFailed(generation: Int, at: Double)
  case crashRecovered(generation: Int, at: Double)

  public var generation: Int {
    switch self {
    case let .generationStarted(g, _), let .loadStarted(g, _), let .contentAlive(g, _),
      let .probeSucceeded(g, _), let .probeFailed(g, _), let .recoveryScheduled(g, _),
      let .recoveryFailed(g, _), let .crashRecovered(g, _):
      return g
    }
  }

  public var at: Double {
    switch self {
    case let .generationStarted(_, t), let .loadStarted(_, t), let .contentAlive(_, t),
      let .probeSucceeded(_, t), let .probeFailed(_, t), let .recoveryScheduled(_, t),
      let .recoveryFailed(_, t), let .crashRecovered(_, t):
      return t
    }
  }

  public var isGenerationStarted: Bool {
    if case .generationStarted = self { return true }
    return false
  }
}

public enum LoadStateMachine {
  /// The generation fence lives here, in one place: every event except a NEW
  /// generation is dropped when it belongs to a superseded one, so a
  /// `didStartLoading` latch cannot exist.
  public static func reduce(
    _ state: LoadState, _ event: LoadEvent, _ env: LoadEnv
  ) -> (state: LoadState, effects: [LoadEffect]) {
    if !event.isGenerationStarted && event.generation != state.generation {
      return (state, [])
    }

    switch event {
    case let .generationStarted(generation, _):
      if generation <= state.generation { return (state, []) }
      var next = state
      next.phase = .cold
      next.generation = generation
      next.probeStrikes = 0
      next.giveUpSpent = false
      next.loadingSinceMs = nil
      return (next, [.log(name: "load-generation", detail: String(generation))])

    case let .loadStarted(_, at):
      var next = state
      next.phase = .loading
      next.loadingSinceMs = at
      return (next, [])

    case .contentAlive:
      var next = state
      next.phase = .loaded
      next.probeStrikes = 0
      next.recoveringFromCrash = false
      next.loadingSinceMs = nil
      return (next, [])

    case .probeSucceeded:
      var next = state
      next.phase = .loaded
      next.probeStrikes = 0
      return (next, [])

    case let .probeFailed(_, at):
      // A failed probe is a STRIKE. It never marks the shell loaded.
      let strikes = state.probeStrikes + 1
      var next = state
      next.probeStrikes = strikes
      if strikes >= env.probeStrikeLimit {
        next.phase = .retrying
        if next.loadingSinceMs == nil { next.loadingSinceMs = at }
        return (next, [
          .log(name: "probe-failed", detail: String(strikes)),
          .scheduleRecovery(generation: state.generation),
        ])
      }
      if state.phase == .loaded { next.phase = .probing }
      return (next, [.log(name: "probe-failed", detail: String(strikes))])

    case let .recoveryScheduled(_, at):
      var next = state
      next.phase = .retrying
      next.recoveringFromCrash = true
      if next.loadingSinceMs == nil { next.loadingSinceMs = at }
      return (next, [])

    case .recoveryFailed:
      // The give-up gate is one-shot per generation.
      if state.giveUpSpent {
        return (state, [.log(name: "recovery-failed-again", detail: String(event.generation))])
      }
      var next = state
      next.phase = .failurePage
      next.giveUpSpent = true
      next.recoveringFromCrash = false
      return (next, [.showFailurePage])

    case .crashRecovered:
      var next = state
      next.recoveringFromCrash = false
      next.phase = .probing
      next.probeStrikes = 0
      return (next, [])
    }
  }
}
