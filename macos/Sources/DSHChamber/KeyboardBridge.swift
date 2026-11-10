//
//  KeyboardBridge.swift — guest 聚焦时的壳快捷键转发（design 28 v3 §4.5）
//
//  语义与上游 keyboard.ts:128-203 等价：guest 成为 firstResponder 时，落在 renderer
//  上报 keymap 内的组合 → 推 browser-input 进页面 shortcut 管线；**表外一概不消费**
//  （不存在「已消费未处理」的丢键）。AppKit 菜单 keyEquivalent 与页面内快捷键并存；
//  IME/编辑键归 guest（无映射键 = pass-through）。
//
//  纯逻辑部分（domCode 映射 / 组合匹配）不依赖 NSEvent 之外的状态，供单测直测。
//

import AppKit

/// 一个可转发的组合（renderer browser.keymap 的项）。
struct BrowserKeyboardCombo: Equatable, Hashable {
    let code: String
    let primary: Bool
    let alt: Bool
    let shift: Bool
    let control: Bool
}

/// 一次按键的归一化事实（测试可直接构造）。
struct BrowserKeyStroke: Equatable {
    let code: String
    let primary: Bool
    let alt: Bool
    let shift: Bool
    let control: Bool
    let isRepeat: Bool
}

/// guest 快捷键桥。
@MainActor
final class KeyboardBridge {
    /// renderer 上报的键位表（按 tab 记账；当前只消费活动 tab 的表）。
    private var keymaps: [String: Set<BrowserKeyboardCombo>] = [:]
    /// 当前活动 guest 的 tabId（由 registry 在 setActive 时同步）。
    var activeTabId: String?
    /// 推送出口（controller 注入；走 A 桥 push）。
    var onInput: ((_ tabId: String, _ stroke: BrowserKeyStroke) -> Void)?
    /// 焦点门：当前 firstResponder 是否属于**活动 guest**（controller 注入；缺省/失败 = false，
    /// 即一律 pass-through）。E4c 修正：只有 guest 持有焦点时才消费键，壳页输入框里的
    /// Cmd+键不得被吞（design 28 v3 §4.5「firstResponder 属于 guest」）。
    var isGuestFocused: (() -> Bool)?
    private var monitor: Any?

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    /// 安装本地 keyDown 监视器（幂等）。
    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            return self.handle(event: event)
        }
    }

    /// 卸载（退出/壳重载）。
    func invalidate() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// 更新某 tab 的键位表（browser.keymap）。
    func setKeymap(tabId: String, combos: [BrowserKeyboardCombo]) {
        keymaps[tabId] = Set(combos)
    }

    /// RT-05：guest 释放/崩溃/重建时清该 tab 的键位表（防陈旧表继续吞键）。
    func removeKeymap(tabId: String) {
        keymaps.removeValue(forKey: tabId)
    }

    /// 处理一次 keyDown：命中表 → 推送并吞掉；否则原样返回（pass-through）。
    /// - Parameter event: 本地监视器收到的事件
    /// - Returns: 交给系统的 NSEvent（nil = 已消费）
    func handle(event: NSEvent) -> NSEvent? {
        guard event.window != nil else { return event }
        guard let stroke = Self.stroke(from: event) else { return event }
        guard let decision = Self.consumeDecision(activeTabId: activeTabId,
                                                  guestFocused: isGuestFocused?() ?? false,
                                                  stroke: stroke,
                                                  combos: activeTabId.flatMap { keymaps[$0] }) else {
            return event
        }
        onInput?(decision.tabId, stroke)
        return nil
    }

    /// 消费决策（纯逻辑，单测直测）：**焦点门是第一判据**——firstResponder 不在活动
    /// guest 上时，即使键位表命中也不消费（原样交系统）。其余判据：有活动 tab、
    /// 键位表存在且精确匹配。
    /// - Returns: 命中时的 (tabId, combo)；nil = pass-through。
    /// nonisolated：纯值判定，测试可从任意上下文直调（不依赖 MainActor）。
    nonisolated static func consumeDecision(activeTabId: String?,
                                guestFocused: Bool,
                                stroke: BrowserKeyStroke,
                                combos: Set<BrowserKeyboardCombo>?) -> (tabId: String, combo: BrowserKeyboardCombo)? {
        guard guestFocused, let tabId = activeTabId, let combos,
              let combo = matches(stroke: stroke, combos: combos) else { return nil }
        return (tabId, combo)
    }

    // MARK: - 纯逻辑（单测直测）

    /// NSEvent → 归一化按键事实；无法映射的键（无 domCode）返回 nil。
    static func stroke(from event: NSEvent) -> BrowserKeyStroke? {
        guard let code = domCode(keyCode: event.keyCode,
                                 charactersIgnoringModifiers: event.charactersIgnoringModifiers) else { return nil }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        return BrowserKeyStroke(code: code,
                                primary: flags.contains(.command),
                                alt: flags.contains(.option),
                                shift: flags.contains(.shift),
                                control: flags.contains(.control),
                                isRepeat: event.isARepeat)
    }

    /// 命中表项（精确匹配 code + 四个修饰位）。nonisolated：纯值判定，单测直调。
    nonisolated static func matches(stroke: BrowserKeyStroke, combos: Set<BrowserKeyboardCombo>) -> BrowserKeyboardCombo? {
        combos.first { combo in
            combo.code == stroke.code && combo.primary == stroke.primary && combo.alt == stroke.alt
                && combo.shift == stroke.shift && combo.control == stroke.control
        }
    }

    /// macOS 虚拟键码 → DOM KeyboardEvent.code（ANSI 布局；未知键返回 nil）。
    /// 与上游 keyboard.ts 的 input.code 语义对齐（只覆盖可绑定的常用键）。
    /// 表外键码的字符兜底同样返回 **DOM code**（D18：字母 → KeyX、数字 → DigitN），
    /// 不再返回裸字符——否则 keymap 表项（renderer 上报 KeyX/DigitN）永远命不中。
    /// nonisolated：纯值映射，单测直调。
    nonisolated static func domCode(keyCode: UInt16, charactersIgnoringModifiers: String?) -> String? {
        if let mapped = ansiKeyCodes[keyCode] { return mapped }
        guard let characters = charactersIgnoringModifiers?.uppercased(), characters.count == 1,
              let scalar = characters.unicodeScalars.first, scalar.isASCII else { return nil }
        if (65...90).contains(scalar.value) { return "Key" + characters }
        if (48...57).contains(scalar.value) { return "Digit" + characters }
        return nil
    }

    nonisolated private static let ansiKeyCodes: [UInt16: String] = [
        0: "KeyA", 1: "KeyS", 2: "KeyD", 3: "KeyF", 4: "KeyH", 5: "KeyG", 6: "KeyZ", 7: "KeyX",
        8: "KeyC", 9: "KeyV", 11: "KeyB", 12: "KeyQ", 13: "KeyW", 14: "KeyE", 15: "KeyR",
        16: "KeyY", 17: "KeyT", 18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 22: "Digit6",
        23: "Digit5", 25: "Digit9", 26: "Digit7", 28: "Digit8", 29: "Digit0", 31: "KeyO", 32: "KeyU",
        34: "KeyI", 35: "KeyP", 37: "KeyL", 38: "KeyJ", 40: "KeyK", 41: "Semicolon", 42: "Backslash",
        43: "Comma", 44: "Slash", 45: "KeyN", 46: "KeyM", 47: "Period", 48: "Tab", 49: "Space",
        50: "Backquote", 51: "Backspace", 53: "Escape", 36: "Enter",
        96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9", 109: "F10", 103: "F11",
        111: "F12", 122: "F1", 120: "F2", 118: "F4",
        123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
        115: "Home", 119: "End", 116: "PageUp", 121: "PageDown", 117: "Delete"
    ]
}
