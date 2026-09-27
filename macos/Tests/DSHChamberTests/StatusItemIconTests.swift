//
//  StatusItemIconTests.swift
//  DSHChamberTests
//
//  状态栏图标（托盘，T-15）的自持几何不变量。那一格的尺寸来自 item 首次布局时读到的
//  图片几何；共享的 NSApp.applicationIconImage（自然几何 256px@2x ⇒ 128pt）实机曾被观测到
//  在启动期回到自然尺寸（触发点未定位），一旦布局读到它，按钮长成 22×128、菜单栏只露中间一条。
//  这里锁源码侧两件事：①纯函数产出的图 size 与每个 rep 的 size 都是 18pt、且与源图无共享
//  关系；②installStatusItem 只交付这张自持图，不再改写共享图标的 size。真机观感（菜单栏
//  不出现被裁的大图）由实机验收负责——运行时竞态无法在单测里重现，不在此假装复现。
//
import XCTest
@testable import DSHChamber

final class StatusItemIconTests: XCTestCase {

    // MARK: - 自持几何

    func testMakeReturnsAn18ptImageWhoseRepresentationsAreAlso18pt() {
        let source = Self.solidImage()
        let icon = StatusItemIcon.make(from: source)
        XCTAssertEqual(icon.size, NSSize(width: 18, height: 18))
        XCTAssertFalse(icon === source, "必须是自持图：不能把源图（或共享的应用图标对象）交给按钮")
        XCTAssertTrue(icon.representations.contains { $0.pixelsWide >= 36 }, "至少一档 2x 像素（Retina 清晰度）")
        for rep in icon.representations {
            XCTAssertEqual(rep.size, NSSize(width: 18, height: 18),
                           "rep 的自然几何也必须 18pt：布局若回退到 rep 几何，仍不能撑大那一格")
        }
        source.size = NSSize(width: 999, height: 999)
        XCTAssertEqual(icon.size, NSSize(width: 18, height: 18), "源图事后被改动不得影响这张自持图")
    }

    func testRepresentationsAreFullyCoveredByTheSourceDraw() {
        // 若绘制域与 rep.size 不一致（例如把 18pt 画进 36pt 的坐标系），
        // 源图只会落在 rep 的一角；按四角 + 中心取样，钉住「铺满」。
        let icon = StatusItemIcon.make(from: Self.solidImage())
        let reps = icon.representations.compactMap { $0 as? NSBitmapImageRep }
        XCTAssertTrue(reps.contains { $0.pixelsWide >= 36 }, "2x 档必须在（该档最容易暴露绘制域错误）")
        for rep in reps {
            let w = rep.pixelsWide, h = rep.pixelsHigh
            XCTAssertEqual(w, h)
            for point in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w / 2, h / 2)] {
                let color = rep.colorAt(x: point.0, y: point.1)
                XCTAssertNotNil(color)
                XCTAssertGreaterThan(color?.alphaComponent ?? 0, 0.9,
                                     "rep \(w)px 的 (\(point.0),\(point.1)) 应被源图铺满（绘制域 = rep.size）")
            }
        }
    }

    func testNilSourceStillYieldsAn18ptImage() {
        let icon = StatusItemIcon.make(from: nil)
        XCTAssertEqual(icon.size, NSSize(width: 18, height: 18))
        for rep in icon.representations {
            XCTAssertEqual(rep.size, NSSize(width: 18, height: 18))
        }
    }

    // MARK: - 源码锁：installStatusItem 只交付自持图

    func testInstallStatusItemHandsTheButtonTheOwnedImageAndNeverMutatesTheSharedIcon() throws {
        let body = try Self.installStatusItemBody()
        XCTAssertFalse(body.isEmpty, "installStatusItem 源码体未取到")
        XCTAssertTrue(body.contains("button.image = StatusItemIcon.make(from: NSApp.applicationIconImage)"),
                      "托盘图标必须走 StatusItemIcon.make（自持 18pt）")
        XCTAssertFalse(body.contains("applicationIconImage?.size"),
                       "不得改写共享的 applicationIconImage.size：那是布局读到 128pt 的入口")
        XCTAssertFalse(body.contains("icon?.size"),
                       "不得回到「取共享图标 → 改 size → 赋给按钮」的旧形态")
        XCTAssertNil(body.range(of: #"\.size\s*=\s*NSSize"#, options: .regularExpression),
                     "体内不得出现任何「改图片 size」的赋值（换名字的等价回归也要红）")
    }

    // MARK: - helpers

    /// 源图只需「能画」：绘制域是否正确由被测输出的 rep 像素断言，夹具不必自带像素。
    private static func solidImage() -> NSImage {
        NSImage(size: NSSize(width: 256, height: 256), flipped: false) { rect in
            NSColor.systemBlue.setFill()
            rect.fill()
            return true
        }
    }

    private static func installStatusItemBody() throws -> String {
        // #filePath = <repo>/macos/Tests/DSHChamberTests/StatusItemIconTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        let text = try String(contentsOf: macosDir.appendingPathComponent("Sources/DSHChamber/AppDelegate.swift"),
                              encoding: .utf8)
        guard let start = text.range(of: "private func installStatusItem()") else { return "" }
        let rest = text[start.upperBound...]
        let end = rest.range(of: "\n\n    /// ")?.lowerBound ?? rest.endIndex
        // 只匹配未注释代码：先切掉行尾 // 之后的内容，再整段去掉块注释
        return rest[..<end]
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let slash = line.range(of: "//") else { return String(line) }
                return String(line[..<slash.lowerBound])
            }
            .joined(separator: "\n")
            .replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
    }
}
