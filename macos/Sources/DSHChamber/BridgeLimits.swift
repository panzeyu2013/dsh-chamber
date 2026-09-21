//
//  BridgeLimits.swift
//  DSHChamber
//
//  A/B 桥共享的尺寸预算（2026-12 单源化）。
//
//  4 MiB 同时是 A 桥信封上限（TrustGuard.maxMessageBytes，design 25 §4.4.1 ③
//  「信封结构/尺寸上限（≤4 MiB）」）与 B 桥单帧/行缓冲上限
//  （FrameCodec.maxFrameBytes，§4.4.2「帧长上限」）。两处此前各写一份字面量、
//  靠注释互指 + CrossLanguageLockstepTests 锁步；现由本文件单一定义，两处公共
//  常量成为同一值的别名（名字与可见性不变，调用点零改动）。
//
//  调整该值 = 同时改两桥的协议预算（跨语言约束：sidecar/control-plane 的
//  4 MiB 假设与 web 侧 shim 的尺寸门），必须作为协议变更评审。
//
import Foundation

public enum BridgeLimits {
    /// 两桥共享的 4 MiB 预算。
    public static let maxMessageBytes = 4 * 1024 * 1024
}
