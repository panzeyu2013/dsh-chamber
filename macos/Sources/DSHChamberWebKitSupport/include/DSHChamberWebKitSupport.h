//
//  DSHChamberWebKitSupport.h
//  DSHChamberWebKitSupport
//
//  WebKit 默认把页面渲染更新压到 ~60fps（design 25 §5.1）：
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

/// KVC BOOL 写入结果。
typedef NS_ENUM(NSInteger, DSHChamberBoolKVCOutcome) {
    /// 对象为 nil / 键不存在 / 只读 / 设置路径抛异常（预期为
    /// NSUnknownKeyException）：对象未被改动，调用方降级，绝不 fatal。
    DSHChamberBoolKVCOutcomeUnavailable = 0,
    /// 写入未抛异常且回读值 == 目标值。
    DSHChamberBoolKVCOutcomeApplied = 1,
    /// 写入调用未抛异常但回读值与目标不一致（或回读不是布尔）——如实报出，
    /// 不假装成功也不假装失败。
    DSHChamberBoolKVCOutcomeReadBackMismatch = 2,
};

/// 异常安全地把 WKWebView 的私有键 drawsBackground 设为指定值（KVC）。
///
/// 为什么存在这层包装：drawsBackground **不在公开头文件**里
/// （公开面只有 underPageBackgroundColor，只能改「露底色」本身）；透明露底依赖该
/// 私有键，而私有存取器 _drawsBackground/_setDrawsBackground: 是否存在随 OS
/// 版本而变。**Swift 无法 catch ObjC 异常**，Swift 侧直设 KVC 在缺该存取器的构建
/// 上会以 NSUnknownKeyException 直接 abort 进程（实测 exit_code=134）；故设置必须
/// 经本函数：@try/@catch 吞掉 NSUnknownKeyException 并返回结果，设置失败不崩。
///
/// 返回调用后的实际结论；Unavailable 时对象未被改动（保持 WebKit 默认）。
FOUNDATION_EXPORT DSHChamberBoolKVCOutcome
DSHChamberSetDrawsBackground(WKWebView * _Nullable webView, BOOL drawsBackground);

/// 通用异常安全 KVC BOOL 写入（DSHChamberSetDrawsBackground 的可直测接缝，
/// 单测覆盖「键存在」「键不存在且不崩」两条路径；无新依赖）。
FOUNDATION_EXPORT DSHChamberBoolKVCOutcome
DSHChamberSetBoolValueForKey(id _Nullable object, NSString *key, BOOL value);

NS_ASSUME_NONNULL_END
