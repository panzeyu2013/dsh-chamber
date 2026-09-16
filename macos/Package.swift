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
//  - resources 显式列出 .process("Resources/bridge-shim.poc.js")：只有 A 桥 shim
//    随包编译为 DSHChamberPoc_DSHChamberPoc.bundle（扁平）；运行时由
//    ChamberResources 定位（resourceURL → bundleURL → 可执行目录；**不用
//    Bundle.module**——装配态 .app 与 dev `swift run` 两种布局都要覆盖，见
//    ChamberResources.swift 头注释）。**不要**把 Resources/ 整目录 process：
//    同目录的 chamber-bridge.stub.js 是 JS 侧锁步生成物（测试断言它在源码树里
//    存在），没有任何运行期代码加载它，打进 bundle 只会多一份可被替换/审计的
//    JS 资产（2026-12 P8）。
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
    dependencies: [
        // 应用内更新（2026-12 裁决 D-1 选 B / 台账 S-01）：Sparkle 2 承担下载 /
        // 安装 / 重启。**这是本包唯一的第三方依赖**——上游头注释里的「零第三方
        // 依赖」不变式已被该裁决显式取代（运行时依赖红线由用户批准）。
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.0")
    ],
    targets: [
        .executableTarget(
            name: "DSHChamberPoc",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle")
            ],
            // JS 锁步生成物（chamber-bridge.stub.js）留在源码树供测试断言，
            // 但不属于 Swift target 的输入——不 exclude 会得到 SwiftPM 的
            // "unhandled file" 警告（2026-12 P8）。
            exclude: [
                "Resources/chamber-bridge.stub.js"
            ],
            resources: [
                .process("Resources/bridge-shim.poc.js")
            ]
        ),
        .testTarget(
            name: "DSHChamberPocTests",
            dependencies: ["DSHChamberPoc"]
        )
    ]
)
