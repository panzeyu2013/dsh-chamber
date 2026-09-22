//  main.swift —— 程序入口（顶层代码即 main）
//  DSHChamber（macos/ SwiftPM POC 壳）：design 25 §8.1
//
//  无 Info.plist/bundle 场景下手动驱动 NSApplication（NSApplicationMain 依赖
//  Info.plist 中的 NSMainNibFile/NSPrincipalClass，此处不可行）：只调 run()。
//  run() 自己完成 finishLaunching 并发 willFinish → didFinish（窗口与 bridge
//  启动都在 didFinish 完成；run-only 启停输出 "WILLFIN → DIDFIN"）。不得手工提前
//  调用 finishLaunching()：它只发 willFinish，随后 run() 会再发一遍，一次启动
//  willFinish 跑两遍；且 ShellLog.configure 在 didFinish 才执行，willFinish 的
//  启动日志只进 stdout。
import AppKit

// 观测（《最终设计方案 v2》）：进程内最早的 Swift 时间点。顶层语句在
// NSApplication 建立之前求值；`static let` 惰性初始化会丢掉这段，故在顶层显式
// 记账，之后所有 boot 行都以它为相对零点（ShellPerf.bootLine）。
ShellPerf.markProcessStart(Date())

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // 命令行进程默认 .prohibited，需 regular 才能出窗
app.run()
