//  main.swift —— 程序入口（顶层代码即 main）
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03，design 25 §8.1
//
//  无 Info.plist/bundle 场景下手动驱动 NSApplication（NSApplicationMain 依赖
//  Info.plist 中的 NSMainNibFile/NSPrincipalClass，此处不可行）：
//  先 finishLaunching()（内部会向 delegate 发 applicationDidFinishLaunching，
//  窗口与 bridge 启动都在那里完成），再进入事件循环 run()。
import AppKit

// Phase 0 观测（《最终设计方案 v2》）：进程内最早的 Swift 时间点。顶层语句在
// NSApplication 建立之前求值；`static let` 惰性初始化会丢掉这段，故在顶层显式
// 记账，之后所有 boot 行都以它为相对零点（ShellPerf.bootLine）。
ShellPerf.markProcessStart(Date())

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // 命令行进程默认 .prohibited，需 regular 才能出窗
app.finishLaunching()
app.run()
