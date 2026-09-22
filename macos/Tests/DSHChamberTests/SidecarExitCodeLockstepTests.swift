//
//  SidecarExitCodeLockstepTests.swift
//  DSHChamberTests
//
//  sidecar 退出码 0/1/3/70 的跨语言锁步。单源是 TS
//  `packages/desktop/sidecar-exit-codes.ts`；Swift 侧
//  `SidecarSupervisor.handleTermination` 按 0/3/70 显式分级，其余非零
//  （含 1 = 运行期崩溃）落崩溃退避配额。
//
//  两侧各自测各自时，把 TS 的 70 改成 71 仍两侧全绿，而 Swift 会把
//  启动失败当崩溃退避重启。本测试逐值解析两份源文本并互相锁定——任一侧改值、
//  改名、删码或让崩溃码变成特判，立即红。读源模式沿用
//  CrossLanguageLockstepTests 的 #filePath 约定。
//
import XCTest
@testable import DSHChamber

final class SidecarExitCodeLockstepTests: XCTestCase {

    /// #filePath = <repo>/macos/Tests/DSHChamberTests/SidecarExitCodeLockstepTests.swift
    private func repoRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// 解析 TS 单源的 `export const NAME = <int>`。
    private func tsValue(_ text: String, constant: String) -> Int? {
        guard let regex = try? NSRegularExpression(pattern: "export const \(constant) = (\\d+)") else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              match.numberOfRanges == 2,
              let valueRange = Range(match.range(at: 1), in: text) else { return nil }
        return Int(text[valueRange])
    }

    /// Swift 源里 `status == <int>` 的特判集合。
    private func statusLiterals(in text: String) -> Set<Int> {
        guard let regex = try? NSRegularExpression(pattern: "status == (\\d+)") else { return [] }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return Set(regex.matches(in: text, range: range).compactMap { match in
            guard match.numberOfRanges == 2,
                  let literalRange = Range(match.range(at: 1), in: text) else { return nil }
            return Int(text[literalRange])
        })
    }

    func testSidecarExitCodesStayInLockstepWithTypeScriptSingleSource() throws {
        let ts = try source("packages/desktop/sidecar-exit-codes.ts")
        let supervisor = try source("macos/Sources/DSHChamber/SidecarSupervisor.swift")

        // 设计锚（design 25 §3.3(4)/B7）：四个角色各一值且互异。
        let expected: [(name: String, value: Int)] = [
            ("EXIT_GRACEFUL", 0),
            ("EXIT_RUNTIME_CRASH", 1),
            ("EXIT_LOCK_CONFLICT", 3),
            ("EXIT_STARTUP_FAILURE", 70),
        ]
        var values: [String: Int] = [:]
        for entry in expected {
            guard let value = tsValue(ts, constant: entry.name) else {
                return XCTFail("sidecar-exit-codes.ts 缺少 export const \(entry.name) = <int>")
            }
            XCTAssertEqual(value, entry.value, "\(entry.name) 的设计值应为 \(entry.value)")
            values[entry.name] = value
        }
        XCTAssertEqual(Set(values.values).count, expected.count, "退出码不得重复")

        let graceful = values["EXIT_GRACEFUL"] ?? -1
        let runtimeCrash = values["EXIT_RUNTIME_CRASH"] ?? -1
        let lockConflict = values["EXIT_LOCK_CONFLICT"] ?? -1
        let startupFailure = values["EXIT_STARTUP_FAILURE"] ?? -1

        // 正向：Swift 是否按 TS 当前值分级（TS 改值而 Swift 不动 = 红）。
        for (value, role) in [(graceful, "EXIT_GRACEFUL"),
                              (lockConflict, "EXIT_LOCK_CONFLICT"),
                              (startupFailure, "EXIT_STARTUP_FAILURE")] {
            XCTAssertTrue(supervisor.contains("status == \(value)"),
                          "SidecarSupervisor 缺少 \(role)=\(value) 的显式分级——TS 单源已改为该值")
        }
        // 崩溃码走 fall-through（其余非零 → 退避配额），绝不能被特判。
        XCTAssertFalse(supervisor.contains("status == \(runtimeCrash)"),
                       "EXIT_RUNTIME_CRASH=\(runtimeCrash) 不得被特判：运行期崩溃必须落入崩溃退避路径")

        // 反向：Swift 特判的退出码集合必须恰好来自 TS 单源（TS 删码而 Swift
        // 留分支同样红），且不含崩溃码。
        let specialCased = statusLiterals(in: supervisor)
        XCTAssertEqual(specialCased, Set([graceful, lockConflict, startupFailure]),
                       "SidecarSupervisor 特判集合必须 = {EXIT_GRACEFUL, EXIT_LOCK_CONFLICT, EXIT_STARTUP_FAILURE}")
        XCTAssertFalse(specialCased.contains(runtimeCrash),
                       "崩溃退避路径不得显式特判 EXIT_RUNTIME_CRASH")
    }
}
