//
//  CarrierDecision.swift
//  Swift mirror - the shell-side authority for the three carrier decisions.
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
    let openingTimeoutMs: Double
    let silentTeardownMinMs: Double
    let openingStallStreak: Int
    /// The visible-page frame probe shared by both shells (delivery.scheduleProbe).
    let scheduleProbeIntervalMs: Double
    let scheduleProbeTimeoutMs: Double
    let scheduleProbeStrikes: Int
    let scheduleProbeInputBlockRttMs: Double
    /// The delivery ladder's cheapest tier and its unresolved-retry bound.
    let deliveryResyncGraceMs: Double
    let deliveryResyncMax: Int
    let deliveryUnresolvedRetryMax: Int
    /// The delivery ladder's stuck-evidence tiers (instance reboot / document reload).
    let deliveryRebootAfterMs: Double
    let deliveryRebootCooldownMs: Double
    let deliveryRebootMax: Int
    let deliveryReloadAfterMs: Double
    let deliveryReloadCooldownMs: Double
    let deliveryReloadMax: Int
    /// The carrier's own bounds: the WebSocket handshake deadline and the
    /// opening-ledger key cap (top-level `tables` leaves).
    let handshakeTimeoutMs: Double
    let openingEpisodeKeysMax: Int

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
        guard let ladders = tables["ladders"] as? [String: Any],
              let delivery = ladders["delivery"] as? [String: Any],
              let scheduleProbe = delivery["scheduleProbe"] as? [String: Any] else {
            throw CarrierTableError.missingField("ladders.delivery")
        }
        func nestedNumber(_ object: [String: Any], _ key: String) throws -> Double {
            guard let value = object[key] as? NSNumber else {
                throw CarrierTableError.missingField("ladders.delivery." + key)
            }
            return value.doubleValue
        }
        return CarrierTables(
            rebuildWindowMs: try number("rebuildWindowMs"),
            maxRebuildsPerWindow: try integer("maxRebuildsPerWindow"),
            minRebuildSpacingMs: try number("minRebuildSpacingMs"),
            inFlightGraceMs: try number("inFlightGraceMs"),
            openingTimeoutMs: try number("openingTimeoutMs"),
            silentTeardownMinMs: try number("silentTeardownMinMs"),
            openingStallStreak: try integer("openingStallStreak"),
            scheduleProbeIntervalMs: try nestedNumber(scheduleProbe, "intervalMs"),
            scheduleProbeTimeoutMs: try nestedNumber(scheduleProbe, "timeoutMs"),
            scheduleProbeStrikes: Int(try nestedNumber(scheduleProbe, "strikes")),
            scheduleProbeInputBlockRttMs: try nestedNumber(scheduleProbe, "inputBlockRttMs"),
            deliveryResyncGraceMs: try nestedNumber(delivery, "resyncGraceMs"),
            deliveryResyncMax: Int(try nestedNumber(delivery, "resyncMax")),
            deliveryUnresolvedRetryMax: Int(try nestedNumber(delivery, "unresolvedRetryMax")),
            deliveryRebootAfterMs: try nestedNumber(delivery, "rebootAfterMs"),
            deliveryRebootCooldownMs: try nestedNumber(delivery, "rebootCooldownMs"),
            deliveryRebootMax: Int(try nestedNumber(delivery, "rebootMax")),
            deliveryReloadAfterMs: try nestedNumber(delivery, "reloadAfterMs"),
            deliveryReloadCooldownMs: try nestedNumber(delivery, "reloadCooldownMs"),
            deliveryReloadMax: Int(try nestedNumber(delivery, "reloadMax")),
            handshakeTimeoutMs: try number("handshakeTimeoutMs"),
            openingEpisodeKeysMax: try integer("openingEpisodeKeysMax")
        )
    }
}

enum CarrierTableError: Error, Equatable {
    case missingTablesObject
    case missingField(String)
}

/// The three carrier decisions, mirroring `packages/dsh-stream-state/src/carrier.ts`.
enum CarrierDecision {
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
        // G-F: a clock the shell cannot compare never authorizes a replacement.
        // Without this guard every comparison against NaN/Infinity is false and the
        // carrier rebuilds on an unusable timestamp.
        if !at.isFinite { return false }
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
