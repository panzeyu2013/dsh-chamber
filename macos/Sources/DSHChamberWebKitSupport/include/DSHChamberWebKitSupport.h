//
//  DSHChamberWebKitSupport.h
//  DSHChamberWebKitSupport
//
//  S-48（2026-12 实机裁决，design 25 §5.1）：WebKit 默认把页面渲染更新压到 ~60fps
//  （UnifiedWebPreferences.yaml: PreferPageRenderingUpdatesNear60FPSEnabled
//  defaultValue=true）；准确说只在 nominal > 60 时起作用，且整数商为 1 的 61–119Hz 屏
//  不受限（100Hz 屏仍是 100fps）。120Hz ProMotion 屏在缺省偏好、未换屏/未重启 WebContent 的
//  稳态下 rAF 为 60fps；低电量模式下
//  WebKit 再按 IntervalThrottlingFactor=2 放大帧间隔（→30fps）。Safari 在 ProMotion 上跑满
//  120Hz 属实测推断（本仓未定位其关该偏好的代码路径）；不碰它的第三方 WKWebView 客户端按缺省
//  被压到 60fps——本 target 承载这一个开关。
//
//  为什么需要独立 C target：该偏好只有私有 SPI（WKPreferencesPrivate.h 的
//  _features / _setEnabled:forFeature:）可改，Swift 侧没有可直调面。
//
#pragma once

#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

/// 页面渲染更新的偏好状态（与 WebKit 的 PreferPageRenderingUpdatesNear60FPSEnabled 同义）。
typedef NS_ENUM(NSInteger, DSHChamberRefreshRatePreference) {
    /// SPI 不可用（未来 OS 移除该偏好/方法）——保持 WebKit 默认，不致命。
    DSHChamberRefreshRatePreferenceUnknown = 0,
    /// WebKit 默认：页面更新靠近 60fps，即使显示器能跑 120Hz。
    DSHChamberRefreshRatePreferenceNearSixty = 1,
    /// 已关闭该偏好：页面更新跟随显示器最大刷新率（ProMotion 自动）。
    DSHChamberRefreshRatePreferenceDisplayRate = 2,
};

/// 关闭 PreferPageRenderingUpdatesNear60FPSEnabled，让页面渲染更新跟随显示器
/// 最大刷新率（本机实测：插电 60fps → 120fps）。
///
/// **必须在用该 WKPreferences 构造 WKWebView 之前调用**：页面创建后再改实测不生效
/// （稳态条件下——未换屏、未发生节流原因变化、未重启 WebProcess；同进程内 rAF 仍为 60fps）。
///
/// 返回调用后的实际状态；SPI 缺失时返回 Unknown（调用方只记日志，绝不 fatal）。
FOUNDATION_EXPORT DSHChamberRefreshRatePreference
DSHChamberPreferDisplayRefreshRate(WKPreferences * _Nullable preferences);

NS_ASSUME_NONNULL_END
