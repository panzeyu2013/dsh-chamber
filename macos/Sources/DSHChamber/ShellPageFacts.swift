//
//  ShellPageFacts.swift
//  DSHChamber
//
//  页面 document 事实载波（S1；本地化/主题跟随的事实源）。
//
//  事实定义（冻结）：
//   - 语言 = documentElement.lang（zh 族 → zh，其它非空 → en，空 = 无事实）；
//   - 主题 = body[data-ds-dark-theme] 存在，或 html 内联 color-scheme 以 dark 开头。
//
//  链路：MainWindowController 以 WKUserScript（documentStart、仅主 frame、page
//  world）注入 ShellPageFactsScript.source()；页面 DOM 变化经独立消息通道
//  dshChamberFacts 上报 {lang, dark, revision}；didFinish 再用
//  snapshotSource() 对账一次。Store 持久化 last-known 于 UserDefaults，宿主
//  （AppDelegate，经 MainWindowController.pageFactsSink）据此改 AppleLanguages /
//  NSAppearance。
//
//  安全边界：本通道**不**属于 A 桥白名单/就绪门链路（事实必须在 sidecar ready
//  前可用）；文档面门为「主 frame + 同源」（MainWindowController.isSameOriginDocument：
//  scheme/host/port 与 cpOrigin 完全相同，不限定 pathname=/ 与 query——取舍见
//  acceptsReconcile 注记；A 桥仍保留 TrustGuard 的严格壳文档判定）。页面脚本能
//  影响的只有它自己确实改动的 DOM 事实本身，脚本不读页面 JS 变量。
//
import AppKit
import Foundation

/// 页面语言族（事实只有两族；具体 BCP-47 子标签不保留）。
public enum ShellPageLanguage: String, CaseIterable, Equatable {
    case zh
    case en

    /// 本地化标识符的**唯一入口**：.lproj 目录名、AppleLanguages 覆盖值、
    /// build-swift-app.mjs 的 LOCALIZATIONS、Package.swift 的 .process("…lproj")、
    /// Info.plist.template 的 CFBundleLocalizations 五处同源都以此为准
    /// （外壳脚本/清单不在 Swift 改动范围内，由 ShellIdentityTests 的锁步测试读
    /// 源码逐集合比对）。zh 用 Apple 的脚本拼写 zh-Hans，不用 zh_CN/zh-CN。
    public var localizationIdentifier: String {
        switch self {
        case .en: return "en"
        case .zh: return "zh-Hans"
        }
    }

    /// zh 族（zh、zh-Hans、zh_CN、zh-Hant-TW…）→ zh；其它非空 → en；
    /// nil/空白 → en（调用方按「无事实」处理，见 ShellPageFactsStore.ingest）。
    public static func resolve(lang: String?) -> ShellPageLanguage {
        guard let lang else { return .en }
        let trimmed = lang.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .en }
        let lower = trimmed.lowercased()
        if lower == "zh" || lower.hasPrefix("zh-") || lower.hasPrefix("zh_") {
            return .zh
        }
        return .en
    }
}

/// 一次已确认的页面事实快照。revision 单调递增（页面重载后脚本的计数会重置，
/// Store 取 max(上报值, 旧值 + 1) 保证全局单调）。
public struct ShellPageFacts: Equatable {
    public var language: ShellPageLanguage
    public var pageIsDark: Bool
    public var revision: Int

    public init(language: ShellPageLanguage, pageIsDark: Bool, revision: Int) {
        self.language = language
        self.pageIsDark = pageIsDark
        self.revision = revision
    }
}

/// 注入脚本（documentStart、仅主 frame、page world）。
public enum ShellPageFactsScript {
    /// 页面 → 壳的事实上报通道名（独立于 A 桥 dshChamber）。
    public static let messageName = "dshChamberFacts"

    /// dark 判定的唯一实现（S1 收口，2026-12）：body[data-ds-dark-theme] 存在，
    /// 或 html 内联 color-scheme 以 dark 开头（如 'dark' / 'dark light'）。
    /// source() 与 snapshotSource() 都插值本串，两份脚本不得各自维护判定
    /// （ShellPageFactsTests.testSharedDarkPredicateIsSingleSource 钉住两份产物
    /// 都含本实现，且各自的 body 深色判定各只出现一次）。
    private static let readDarkJS = """
    function readDark() {
      try {
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) {
          return true;
        }
        var root = document.documentElement;
        var inline = root && root.style ? root.style.colorScheme : '';
        if (typeof inline !== 'string') { return false; }
        var lead = inline.replace(/^\\s+/, '').slice(0, 4).toLowerCase();
        return lead === 'dark';
      } catch (e) { return false; }
    }
    """

    /// 注入源码：安装一次 MutationObserver，首次与每次变化上报。
    ///
    /// 观察面：documentElement 子树内
    ///   - html[lang]（语言事实）；
    ///   - html 内联 color-scheme（style 属性；主题事实）；
    ///   - body[data-ds-dark-theme]（body 插入 + 属性变化；主题事实）；
    ///   - meta[theme-color]（name/content；仅作为「可能变化」的触发面，
    ///     不参与 dark 判定）。
    /// 幂等：同一 (lang, dark) 快照不重复上报；document 上的一次性安装标记防止
    /// 同文档二次执行。全部逻辑 try/catch 包裹，任何异常都退化为「不上报」，
    /// 绝不影响页面自身。
    public static func source() -> String {
        """
        (function () {
          // # 防注入说明：本脚本只读取 DOM 事实（documentElement 的 lang 与内联
          // # color-scheme、body 的 data-ds-dark-theme、meta[theme-color] 的存在），
          // # 绝不读取、调用或 eval 页面的任何 JS 变量/函数；页面脚本能影响的只有
          // # 它自己确实改动的 DOM 事实本身。上报通道是壳注册的
          // # window.webkit.messageHandlers.\(messageName)。
          try {
            var STATE_KEY = '__dshChamberFactsState__';
            var doc = document;
            if (Object.prototype.hasOwnProperty.call(doc, STATE_KEY)) { return; }
            var state = { last: null, revision: 0, observer: null };
            doc[STATE_KEY] = state;

            function readLang() {
              try {
                return (document.documentElement && document.documentElement.lang) || '';
              } catch (e) { return ''; }
            }

            // dark 判定 = body[data-ds-dark-theme] 存在，或 html 内联
            // color-scheme 以 dark 开头（如 'dark' / 'dark light'）。
            // 实现单源：readDarkJS（与 snapshotSource 共用）。
            \(readDarkJS)

            function report() {
              try {
                var nextLang = readLang();
                var nextDark = readDark();
                var snapshot = nextLang + '\\u0000' + (nextDark ? '1' : '0');
                if (state.last === snapshot) { return; }
                state.last = snapshot;
                state.revision += 1;
                var handlers = window.webkit && window.webkit.messageHandlers;
                if (!handlers || !handlers.\(messageName)) { return; }
                handlers.\(messageName).postMessage({
                  lang: nextLang,
                  dark: nextDark,
                  revision: state.revision,
                });
              } catch (e) {}
            }

            function install() {
              try {
                if (state.observer || !document.documentElement) { return; }
                state.observer = new MutationObserver(report);
                state.observer.observe(document.documentElement, {
                  subtree: true,
                  childList: true,
                  attributes: true,
                  attributeFilter: ['lang', 'style', 'data-ds-dark-theme', 'name', 'content'],
                });
                report();
              } catch (e) {}
            }

            if (document.documentElement) {
              install();
            } else {
              document.addEventListener('DOMContentLoaded', install, { once: true });
            }
          } catch (e) {}
        })();
        """
    }

    /// didFinish 对账表达式（S1 追加；dark 判定与 source() 共用 readDarkJS，
    /// 2026-12 收口——两份脚本只此一个判定实现）。
    /// evaluateJavaScript 直接返回值，页面侧不产生副作用，revision 由 Store
    /// 补（对账路径无需版本号）。
    public static func snapshotSource() -> String {
        """
        (function () {
          try {
            var root = document.documentElement;
            \(readDarkJS)
            return {
              lang: (root && root.lang) || '',
              dark: readDark(),
            };
          } catch (e) { return null; }
        })();
        """
    }
}

/// last-known 页面事实的合并与持久化（主线程所有；UserDefaults 注入便于单测）。
public final class ShellPageFactsStore {
    /// 持久化键（UserDefaults 字典：language/pageIsDark/revision）。
    public static let defaultsKey = "native-shell.page-facts"

    /// revision 上界（防溢出：\(Int.max) 会随页面上报到达并被持久化，见 ingest）。
    /// revision 只用于排序/日志，不需要真实计数语义，故取一个远大于任何真实运行的界。
    public static let maxRevision = 1_000_000

    /// lang 纯防御上限（Z2，2026-12 二轮独立复核）：页面 postMessage 的 lang 实测可
    /// 抵达 5 MiB（不崩，但没有理由处理/落盘如此长的字符串）。超过本界的字符串**一律
    /// 忽略**（保留旧值、不构成事实）。现有取值域 zh/en 及其 BCP-47 子标签（如
    /// zh-Hant-TW）都远短于本界，故语义零变化；单位是 Swift Character，只作长度闸，
    /// 不做 Unicode 规范化。
    public static let maxLangLength = 256

    private let defaults: UserDefaults

    /// 当前已知事实；nil = 尚无任何已知事实（含持久化里也没有）。
    public private(set) var current: ShellPageFacts?

    public init(defaults: UserDefaults) {
        self.defaults = defaults
        self.current = Self.load(from: defaults)
    }

    /// 启动早期只读入口（AppDelegate 在窗口创建前也可调用；不写 UserDefaults）。
    public static func lastKnown(in defaults: UserDefaults) -> ShellPageFacts? {
        load(from: defaults)
    }

    /// 合并一次上报，返回是否产生变化。
    ///
    /// 合并语义：
    ///   - lang 为空（脚本的 documentElement.lang || ''）= 不构成事实，保留旧值
    ///     （旧值也没有 → 本次不构成事实，等下一次上报）；lang 超过 maxLangLength
    ///     （纯防御闸，Z2）同样按「不构成事实」处理；
    ///   - dark 缺失 = 保留旧值；
    ///   - 与旧值完全相等 → false（幂等，不重复打扰 sink / 不重复落盘）；
    ///   - revision 取 max(夹紧后的上报值, 旧值 + 1)：页面重载后脚本计数重置也不会
    ///     回退，对账路径（无 revision）同样得到严格递增值。
    ///     **夹紧是必需的安全边界**（2026-12 审计）：上报值来自页面 postMessage，
    ///     可被构造为 `1e300`（NSNumber.intValue = Int.max）；旧值若为 Int.max，
    ///     `old + 1` 在 Swift 里是**陷阱**（SIGTRAP 崩溃），且旧值会被持久化 →
    ///     一次污染即此后每次事实变化都崩。故取值被夹到 [0, maxRevision]，
    ///     旧值到界后不再自增。
    @discardableResult
    public func ingest(_ payload: [String: Any]) -> Bool {
        var language = current?.language
        var pageIsDark = current?.pageIsDark

        // lang：先过纯防御长度闸（Z2）——超长一律忽略、保留旧值。长度检查先于
        // trimming，5 MiB 级输入不做无谓的副本分配；再按既有契约「非空白才构成事实」。
        if let rawLang = payload["lang"] as? String,
           rawLang.count <= Self.maxLangLength,
           !rawLang.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            language = ShellPageLanguage.resolve(lang: rawLang)
        }
        if let value = payload["dark"] as? Bool {
            pageIsDark = value
        } else if let number = payload["dark"] as? NSNumber {
            pageIsDark = number.boolValue
        }

        guard let resolvedLanguage = language, let resolvedDark = pageIsDark else {
            return false
        }
        if let current, current.language == resolvedLanguage, current.pageIsDark == resolvedDark {
            return false
        }
        // 有界化（见 ingest 文档注释）：先夹上报值，再算"旧值 + 1"，且到界不再自增。
        let reportedRaw = (payload["revision"] as? NSNumber)?.intValue ?? 0
        let reported = min(max(reportedRaw, 0), Self.maxRevision)
        let previous = current?.revision ?? 0
        let next = previous >= Self.maxRevision ? Self.maxRevision : previous + 1
        let revision = max(reported, next)
        let facts = ShellPageFacts(language: resolvedLanguage,
                                   pageIsDark: resolvedDark,
                                   revision: revision)
        current = facts
        persist(facts)
        return true
    }

    private func persist(_ facts: ShellPageFacts) {
        defaults.set([
            "language": facts.language.rawValue,
            "pageIsDark": facts.pageIsDark,
            "revision": facts.revision,
        ], forKey: Self.defaultsKey)
    }

    private static func load(from defaults: UserDefaults) -> ShellPageFacts? {
        guard let record = defaults.dictionary(forKey: defaultsKey),
              let rawLanguage = record["language"] as? String,
              let language = ShellPageLanguage(rawValue: rawLanguage) else {
            return nil
        }
        let isDark = (record["pageIsDark"] as? Bool)
            ?? (record["pageIsDark"] as? NSNumber)?.boolValue
            ?? false
        // 落盘值同样夹紧：旧版本可能已经写进过一个被污染的上界值，
        // 载入时不夹紧会让下一次 ingest 直接踩溢出陷阱。
        let revision = min(max((record["revision"] as? NSNumber)?.intValue ?? 0, 0),
                           maxRevision)
        return ShellPageFacts(language: language, pageIsDark: isDark, revision: revision)
    }
}

/// AppleLanguages 覆盖策略：页面语言与系统语言族不同才覆盖（相同 → nil =
/// 跟随系统）。系统语言取第一个非空项；没有任何系统语言事实 → nil（无据不覆盖，
/// 保守跟随系统）。
public enum ShellLanguagePolicy {
    public static func appleLanguagesOverride(page: ShellPageLanguage,
                                              systemLanguages: [String]) -> [String]? {
        guard let first = systemLanguages.first(where: {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) else {
            return nil
        }
        guard ShellPageLanguage.resolve(lang: first) != page else { return nil }
        return [page.localizationIdentifier]
    }
}

/// NSAppearance 跟随策略：页面主题与系统主题相同 → nil（跟随系统）；不同 →
/// 固定对应外观名。
public enum ShellAppearancePolicy {
    public static func appearanceName(pageIsDark: Bool, systemIsDark: Bool) -> NSAppearance.Name? {
        guard pageIsDark != systemIsDark else { return nil }
        return pageIsDark ? .darkAqua : .aqua
    }
}

/// 页面事实变化接收方（AppDelegate 注册到 MainWindowController.pageFactsSink；
/// 回调在主线程）。
public protocol ShellPageFactsSink: AnyObject {
    func pageFactsDidChange(_ facts: ShellPageFacts, previous: ShellPageFacts?)
}
