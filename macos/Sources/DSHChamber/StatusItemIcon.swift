//
//  StatusItemIcon.swift
//  DSHChamber
//
//  状态栏图标（托盘，T-15）：把应用图标烘成**自持**的 18pt 图。
//
//  为什么不是「取 applicationIconImage、改 size、再赋给按钮」：
//  菜单栏那一格的几何是在 item **首次布局**时读「图片当时的几何」的（实测：布局前改 size
//  → 按钮 22×128；布局后再改 → 仍 22×22）。而 applicationIconImage 是 AppKit 的**共享**
//  对象（多次读取同一实例，自然几何 = 256px@2x ⇒ 128pt）：实机曾观测到它在启动期回到自然
//  尺寸（**触发点未定位**，本修复不依赖这个因果假设）；一旦首次布局读到的就是 128pt，
//  按钮长成 22×128，菜单栏只露中间 33pt，
//  图标被放大裁切成巨块（2026-09-27 本机实机现象）。让 size 与**每个 rep 的 size** 都固定
//  18pt，并且不再把共享对象交给按钮，「读 size」与「读 rep 几何」两条通路就都是 18pt，
//  该类失败在几何上不可能发生（单测 StatusItemIconTests 锁这两条；实机观感走实机验收）。
//
import AppKit

enum StatusItemIcon {

    /// 状态栏图标目标尺寸（沿用旧实现的 18pt；菜单栏额外项常规 16–19pt。
    /// Electron 侧未做同尺寸化，见 STATUS 开放项）。
    static let size = NSSize(width: 18, height: 18)

    /// 从任意源图（通常是 NSApp.applicationIconImage）烘一张自持状态栏图：
    /// - 返回图不是源图本身，源图之后被谁改动都影响不到它；
    /// - image.size 与每个 rep 的 size 都是 size（1x = 18px、2x = 36px）；
    /// - 源图为 nil 或绘制失败时返回同规格空图：那一格仍是 18pt，不会再被撑大。
    static func make(from source: NSImage?) -> NSImage {
        let image = NSImage(size: size)
        for scale in [1, 2] {
            let pixels = Int(size.width) * scale
            guard let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: pixels, pixelsHigh: pixels,
                bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0
            ) else { continue }
            // rep.size 必须先定：绘制域 = rep.size，否则 18pt 只会落在 rep 的一角。
            rep.size = size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            source?.draw(in: NSRect(origin: .zero, size: size))
            NSGraphicsContext.restoreGraphicsState()
            image.addRepresentation(rep)
        }
        return image
    }
}
