//
//  CarrierDecision.swift
//  B5 (Swift mirror) - the shell-side authority for the three carrier decisions.
//
//  WHY THIS FILE EXISTS. The Swift shell's recovery policy and the page's carrier
//  reducer are two implementations of one contract. Today they share no source, so
//  a threshold fixed on one side silently stays wrong on the other. This file is
//  the SWIFT side of the shared table: it reads the same
//  `packages/dsh-stream-state/tables.json` the TS package projects, and the parity
//  gate (`scripts/gates/verify-stream-state-swift-parity.mjs`) fails when either
//  side drifts.
//
//  PURITY. Foundation only, no AppKit/WebKit: this file must compile and run on
//  every platform swiftc supports, so the CI macOS leg can compile it together
//  with the app AND a plain `swiftc` invocation can run it on Linux (which is how
//  the parity gate executes in environments without the macOS SDK).
//
//  SCOPE. This is a MIRROR of the pure decisions, not the shell's state machine:
//  deciding WHEN to rebuild is here; owning the WKWebView, timers and sidecar is
//  the shell's job (design 25). The mirror exists so the numbers and the
//  predicates have exactly one definition.
//

import Foundation

/// Thresholds, loaded from the shared JSON projection.
struct CarrierTables: Equatable {
    let rebuildWindowMs: Double
    let maxRebuildsPerWindow: Int
    let minRebuildSpacingMs: Double
    let inFlightGraceMs: Double
    let openingTimeoutLadderMs: [Double]
    let silentTeardownMinMs: Double
    let openingStallStreak: Int

    /// Load from `tables.json`. Throws (never defaults) on a missing or malformed
    /// file: a shell running on an unchosen default is the failure mode this whole
    /// table exists to prevent.
    static func load(from url: URL) throws -> CarrierTables {
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tables = root["tables"] as? [String: Any] else {
            throw CarrierTableError.missingTablesObject
        }
        func number(_ key: String) throws -> Double {
            guard let value = tables[key] as? NSNumber else { throw CarrierTableError.missingField(key) }
            return value.doubleValue
        }
        func integer(_ key: String) throws -> Int {
            guard let value = tables[key] as? NSNumber else { throw CarrierTableError.missingField(key) }
            return value.intValue
        }
        guard let ladder = tables["openingTimeoutLadderMs"] as? [NSNumber], !ladder.isEmpty else {
            throw CarrierTableError.missingField("openingTimeoutLadderMs")
        }
        return CarrierTables(
            rebuildWindowMs: try number("rebuildWindowMs"),
            maxRebuildsPerWindow: try integer("maxRebuildsPerWindow"),
            minRebuildSpacingMs: try number("minRebuildSpacingMs"),
            inFlightGraceMs: try number("inFlightGraceMs"),
            openingTimeoutLadderMs: ladder.map(\.doubleValue),
            silentTeardownMinMs: try number("silentTeardownMinMs"),
            openingStallStreak: try integer("openingStallStreak")
        )
    }
}

enum CarrierTableError: Error, Equatable {
    case missingTablesObject
    case missingField(String)
}

/// The three carrier decisions, mirroring `packages/dsh-stream-state/src/carrier.ts`.
enum CarrierDecision {
    /// Opening deadline for an episode that has already timed out `streak` times.
    /// Mirrors `openingBudgetMs` (clamped index into the ladder).
    static func openingBudgetMs(streak: Int, tables: CarrierTables) -> Double {
        let index = streak > 0 ? streak : 0
        let capped = Swift.min(index, tables.openingTimeoutLadderMs.count - 1)
        return tables.openingTimeoutLadderMs[capped]
    }

    /// May the physical carrier be replaced now?
    /// Mirrors `decideRebuild`: closed carriers never rebuild; an in-flight rebuild
    /// inside its grace window blocks; the rolling window and the spacing are
    /// enforced together.
    static func shouldRebuild(
        phaseClosed: Bool,
        pendingRebuildInFlight: Bool,
        rebuildsAt: [Double],
        at: Double,
        tables: CarrierTables
    ) -> Bool {
        if phaseClosed { return false }
        let latest = rebuildsAt.max() ?? -Double.infinity
        if pendingRebuildInFlight && at - latest < tables.inFlightGraceMs { return false }
        let inWindow = rebuildsAt.filter { $0 > at - tables.rebuildWindowMs }.count
        if inWindow >= tables.maxRebuildsPerWindow { return false }
        if latest.isFinite && at - latest < tables.minRebuildSpacingMs { return false }
        return true
    }

    /// Is a stall escalation allowed? Mirrors the reducer's threshold branch:
    /// `reason == openingStall` requires `streak >= openingStallStreak`.
    static func stallEscalationAllowed(streak: Int, tables: CarrierTables) -> Bool {
        streak >= tables.openingStallStreak
    }

    /// May a teardown judge its socket silent? Mirrors the teardown branch:
    /// a whole-life frame delta of zero on a stream that lived long enough.
    static func teardownMayJudgeSilent(
        frameDelta: Double,
        streamLifeMs: Double,
        tables: CarrierTables
    ) -> Bool {
        if !frameDelta.isFinite { return false }
        return frameDelta <= 0 && streamLifeMs >= tables.silentTeardownMinMs
    }
}
