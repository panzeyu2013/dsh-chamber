//
//  ThemedBackgroundTests.swift
//  DSHChamberTests
//
//  原生"露底"色的两段语义——首帧跟页面骨架常量（页面骨架与主题无关，
//  见 packages/renderer/index.html），页面事实到达后按主题换色。
//
import XCTest
@testable import DSHChamber

final class ThemedBackgroundTests: XCTestCase {

    private func srgb(_ color: NSColor) -> (CGFloat, CGFloat, CGFloat) {
        let converted = color.usingColorSpace(.sRGB) ?? color
        return (converted.redComponent, converted.greenComponent, converted.blueComponent)
    }

    private func assertSameRGB(_ a: NSColor, _ b: NSColor, file: StaticString = #filePath, line: UInt = #line) {
        let lhs = srgb(a), rhs = srgb(b)
        XCTAssertEqual(lhs.0, rhs.0, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(lhs.1, rhs.1, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(lhs.2, rhs.2, accuracy: 0.001, file: file, line: line)
    }

    /// 无事实 / 暗色主题 → 与页面骨架常量同值（首帧不反向闪色）。
    func testSkeletonColorUntilFactsSayLight() {
        assertSameRGB(MainWindowController.themedBackgroundColor(pageIsDark: nil),
                      MainWindowController.windowBackgroundColor)
        assertSameRGB(MainWindowController.themedBackgroundColor(pageIsDark: true),
                      MainWindowController.windowBackgroundColor)
        let skeleton = srgb(MainWindowController.windowBackgroundColor)
        XCTAssertEqual(skeleton.0, 15.0 / 255.0, accuracy: 0.001)
        XCTAssertEqual(skeleton.2, 21.0 / 255.0, accuracy: 0.001)
    }

    /// 浅色主题 → 白（dsh 浅色内容底），不露深色骨架。
    func testLightThemeUsesLightBackground() {
        let light = srgb(MainWindowController.themedBackgroundColor(pageIsDark: false))
        XCTAssertEqual(light.0, 1.0, accuracy: 0.001)
        XCTAssertEqual(light.1, 1.0, accuracy: 0.001)
        XCTAssertEqual(light.2, 1.0, accuracy: 0.001)
    }
}
