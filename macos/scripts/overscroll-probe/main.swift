//  overscroll-probe —— 视口越界策略的手动验收探针（design 25 §5.2 / deviations S-50）
//
//  为什么入库：S-50 声称的效果此前只有一次性 /tmp 装置做证，不可复跑。本探针与仓库
//  的 ShellOverscrollPolicy.swift **一起编译**，策略模式注入的就是
//  ShellOverscrollPolicy.makeUserScript() 的真实产出——不存在"手抄串"这一步，
//  因此 B1（占位符未插值）那类缺陷会被直接照出来。
//
//  用法（经同目录 run.mjs 调用，需已登录的 GUI 会话）：
//      osc-probe <baseline|policy> <scenario>
//  scenario ∈ bar-up | bar-down | content-top-up | content-bottom-down | content-mid | causal
//  输出 MEASURE / HARNESS 行；判据与阈值在 run.mjs 的 --assert 里。
//
//  判据信号用 window.visualViewport.pageTop（视口被弹性平移的量；本机稳定可读），
//  不用 0x0 合成层 position——后者同场景在 0..40 之间抖，单用它做结论会假阴性。
//  装置只发合成连续相位滚轮（began + 8×changed，按住不发 ended）：能证明/证伪
//  "视口越界是否被抑制""正常滚动是否不受影响"，不代表真实触控板惯性。

import AppKit
import CryptoKit
import WebKit

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "baseline"
let scenario = args.count > 2 ? args[2] : "bar-up"
let policySource = ShellOverscrollPolicy.makeUserScript().source
let policyBytes = policySource.lengthOfBytes(using: .utf8)
let policySHA = SHA256.hash(data: Data(policySource.utf8)).map { String(format: "%02x", $0) }.joined()

func fmt(_ v: Double) -> String { String(format: "%.2f", v) }
func pump(_ t: TimeInterval) {
    let end = Date().addingTimeInterval(t)
    while Date() < end { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
}
var gWV: WKWebView!
var gWin: NSWindow!

func js(_ code: String) -> String {
    var out = "TIMEOUT"; var done = false
    gWV.evaluateJavaScript(code) { v, e in
        out = e == nil ? String(describing: v ?? "nil") : "ERROR:\(e!)"
        done = true
    }
    let end = Date().addingTimeInterval(8)
    while !done && Date() < end { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    return out
}

func sendScroll(_ vp: NSPoint, _ dy: Double, _ phase: UInt32) {
    let sp = gWin.convertPoint(toScreen: vp)
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0) else { return }
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(dy))
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase))
    cg.location = sp
    if let e = NSEvent(cgEvent: cg) { gWV.scrollWheel(with: e) }
}

let sampleJS = "(function(){var vv=window.visualViewport;var m=document.getElementById('main');"
    + "return JSON.stringify({v:vv?vv.pageTop:null,k:m?m.scrollTop:null,"
    + "n:document.querySelectorAll('style[" + ShellOverscrollPolicy.styleElementAttribute + "]').length,"
    + "de:getComputedStyle(document.documentElement).overscrollBehavior});})()"

struct Sample { var vv = 0.0; var main = 0.0; var styles = 0; var de = "?"; var ok = false }

/// 采样失败（超时/异常/解析不了）**绝不能当成 0**：对抗复核 A 指出，若只在手势期间采样超时，
/// policy 四个场景会读成 |vvTop| = 0 而整轮 --assert 假绿。ok = false 由调用方转 HARNESS-ERROR。
func sample() -> Sample {
    let raw = js(sampleJS)
    var s = Sample()
    if raw == "TIMEOUT" || raw.hasPrefix("ERROR:") || raw == "nil" { return s }
    guard let data = raw.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return s }
    if let v = obj["v"] as? NSNumber { s.vv = v.doubleValue }
    if let k = obj["k"] as? NSNumber { s.main = k.doubleValue }
    if let n = obj["n"] as? NSNumber { s.styles = n.intValue }
    if let d = obj["de"] as? String { s.de = d }
    s.ok = true
    return s
}

/// 作用域检查（不需要手势）：主文档必须有注入样式且 computed = none；iframe 子文档必须**没有**
/// （forMainFrameOnly = true 的可观测面——把它改成 false 会让 iframe 也拿到样式，本检查随即变红）。
let scopeJS = "(function(){function de(d){try{return d.defaultView.getComputedStyle(d.documentElement).overscrollBehavior}"
    + "catch(e){return 'ERR'}}"
    + "var out={ms:document.querySelectorAll('style[" + ShellOverscrollPolicy.styleElementAttribute + "]').length,md:de(document),is:-1,id:'MISSING'};"
    + "var f=document.getElementById('fr');"
    + "try{var d=f.contentDocument;out.is=d.querySelectorAll('style[" + ShellOverscrollPolicy.styleElementAttribute + "]').length;out.id=de(d)}"
    + "catch(e){out.id='ERR:'+e.name}"
    + "return JSON.stringify(out)})()"

/// 按住不放的连续相位手势：began + 8×changed，每次 changed 后采样 vvTop。
func measure(_ label: String, _ setup: String, _ x: Double, _ y: Double, _ dy: Double) {
    _ = js(setup)
    var failures = 0
    let before = sample()
    if !before.ok { failures += 1 }
    var vvMin = Double.greatestFiniteMagnitude
    var vvMax = -Double.greatestFiniteMagnitude
    sendScroll(NSPoint(x: x, y: y), dy, UInt32(CGScrollPhase.began.rawValue))
    var ticks = 0
    while ticks < 8 {
        pump(0.05)
        sendScroll(NSPoint(x: x, y: y), dy, UInt32(CGScrollPhase.changed.rawValue))
        pump(0.05)
        let s = sample()
        if !s.ok { failures += 1 } else {
            if s.vv < vvMin { vvMin = s.vv }
            if s.vv > vvMax { vvMax = s.vv }
        }
        ticks += 1
    }
    let after = sample()
    if !after.ok { failures += 1 }
    sendScroll(NSPoint(x: x, y: y), dy, UInt32(CGScrollPhase.ended.rawValue))
    if failures > 0 {
        print("HARNESS-ERROR scenario=" + label + " failedSamples=" + String(failures))
        exit(3)
    }
    print("MEASURE mode=" + mode + " scenario=" + label
        + " vvTopMin=" + fmt(vvMin) + " vvTopMax=" + fmt(vvMax)
        + " mainBefore=" + fmt(before.main) + " mainAfter=" + fmt(after.main)
        + " styleCount=" + String(after.styles) + " de=" + after.de)
    pump(0.25)
}

/// 作用域检查：不需要手势，直接把主文档/iframe 的注入样式与 computed 值打出来。
func measureScope() {
    let raw = js(scopeJS)
    guard raw != "TIMEOUT", !raw.hasPrefix("ERROR:"), raw != "nil",
          let data = raw.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        print("HARNESS-ERROR scenario=scope sample=" + raw)
        exit(3)
    }
    func field(_ k: String) -> String {
        if let n = obj[k] as? NSNumber { return n.stringValue }
        return (obj[k] as? String) ?? "?"
    }
    print("MEASURE mode=" + mode + " scenario=scope mainStyles=" + field("ms") + " mainDe=" + field("md")
        + " iframeStyles=" + field("is") + " iframeDe=" + field("id"))
}

let barY = 570.0, midY = 300.0, up = 90.0, down = -90.0
let page = "<html><head><meta charset='utf-8'><style>"
    + "html,body{height:100%;margin:0;background:#fafafa}"
    + "#bar{position:fixed;top:0;left:0;right:0;height:56px;background:#33456b;z-index:10}"
    + "#side{position:fixed;left:0;top:56px;bottom:0;width:220px;background:#1d2635;z-index:9}"
    + "#main{position:absolute;left:220px;right:0;top:56px;bottom:0;overflow:auto}"
    + ".rows{display:flex;flex-direction:column;gap:8px;padding:16px}.row{height:44px;background:#eef2f7;border-radius:8px}"
    + "</style></head><body><div id='bar'></div><div id='side'></div><div id='main'><div class='rows'>"
    + String(repeating: "<div class='row'>row</div>", count: 80)
    + "</div></div></body></html>"

/// 作用域检查页：主文档 chrome + 一个自带滚动器的 iframe（srcdoc）。
let scopePage = page.replacingOccurrences(of: "</body>",
    with: "<iframe id='fr' style='position:absolute;left:220px;top:56px;width:660px;height:500px;border:0' "
        + "srcdoc=\"<html><head><style>html,body{height:100%;margin:0}#s{position:absolute;inset:0;overflow:auto}</style></head>"
        + "<body><div id='s'><div style='height:4000px'>x</div></div></body></html>\"></iframe></body>")

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()   // 不写用户 WebKit 目录，也不跨轮带 cookie/cache
if mode == "policy" { cfg.userContentController.addUserScript(ShellOverscrollPolicy.makeUserScript()) }
gWV = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: cfg)
gWin = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                styleMask: [.titled], backing: .buffered, defer: false)
gWin.contentView = gWV
gWin.setFrameOrigin(NSPoint(x: 40, y: 40))
gWin.orderFrontRegardless()
gWV.loadHTMLString(scenario == "scope" ? scopePage : page, baseURL: nil)
pump(scenario == "scope" ? 2.5 : 2.0)

print("HARNESS mode=" + mode + " scenario=" + scenario + " policyBytes=" + String(policyBytes) + " policySHA256=" + policySHA)

switch scenario {
case "bar-up":
    measure("bar-up", "'ok'", 450, barY, up)
case "bar-down":
    measure("bar-down", "'ok'", 450, barY, down)
case "content-top-up":
    measure("content-top-up", "var m=document.getElementById('main');m.scrollTop=0;'ok'", 500, midY, up)
case "content-bottom-down":
    measure("content-bottom-down", "var m=document.getElementById('main');m.scrollTop=m.scrollHeight;'ok'", 500, midY, down)
case "content-mid":
    measure("content-mid", "var m=document.getElementById('main');m.scrollTop=1000;'ok'", 500, midY, down)
case "scope":
    measureScope()
case "causal":
    // 因果链：策略在 → 0；运行时移除注入 style → 回弹回来；重新执行策略源 → 0
    measure("causal-with-policy", "'ok'", 450, barY, up)
    _ = js("var s=document.querySelector('style[" + ShellOverscrollPolicy.styleElementAttribute + "]');if(s)s.remove();'ok'")
    pump(0.6)   // 让引擎重算视口越界行为（移除后立刻手势可能读到旧状态）
    measure("causal-after-remove", "'ok'", 450, barY, up)
    _ = js(ShellOverscrollPolicy.source)
    pump(0.6)
    measure("causal-after-readd", "'ok'", 450, barY, up)
default:
    print("MEASURE mode=" + mode + " scenario=unknown")
}
print("RESULT mode=" + mode + " scenario=" + scenario + " done")
exit(0)
