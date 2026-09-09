// swift-tools-version: 5.9
//
//  Package.swift —— dsh-chamber Swift 壳 P0（W-03，design 25 §8.1；
//  todo companion macos-swift-v1 §0.2④）
//
//  结构说明：
//  - 单 executableTarget「DSHChamberPoc」（Sources/DSHChamberPoc）承载 P0 全部
//    Swift 代码：本窗口壳（main/AppDelegate/MainWindowController，W-03）与
//    W-04 的 A/B 桥文件（BridgeShimInjector/MessageHandler/AnyCodable/
//    FrameCodec/BridgeClient，其他作者创建）同 target，模块内直接互引共享契约。
//  - resources .process("Resources")：bridge-shim.poc.js 随包编译为
//    DSHChamberPoc_DSHChamberPoc.bundle；运行时由 ChamberResources 定位
//    （resourceURL → bundleURL → 可执行目录；**不用 Bundle.module**——装配态
//    .app 与 dev `swift run` 两种布局都要覆盖，见 ChamberResources.swift 头注释）。
//  - testTarget「DSHChamberPocTests」（Tests/DSHChamberPocTests，测试文件由
//    主 agent 后续创建）直接依赖 executable target：SwiftPM 允许测试依赖
//    executable（@testable import DSHChamberPoc，构建期加 -enable-testing，
//    main.swift 顶层代码不干扰测试链接）。若日后需更强的模块隔离，可再拆出
//    library target + 薄壳 executable，P0 从简即用本方案。
//  - 零第三方依赖；仅系统框架 AppKit/WebKit/Foundation。
//  - 语言模式：swift-tools-version 5.9 → Swift 5 模式（无 strict concurrency）。
import PackageDescription

let package = Package(
    name: "DSHChamberPoc",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "DSHChamberPoc",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "DSHChamberPocTests",
            dependencies: ["DSHChamberPoc"]
        )
    ]
)
