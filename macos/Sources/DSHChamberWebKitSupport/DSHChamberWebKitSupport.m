//
//  DSHChamberWebKitSupport.m
//  DSHChamberWebKitSupport
//
//  S-48 / design 25 §5.1：见头文件。刷新率部分只做三件事：按 key 找到该 WebKit 构建的
//  _WKFeature、置 NO、读回。全部 SPI 调用都有 respondsToSelector/@try 兜底——未来 OS
//  拿掉任一 SPI 时退化为「保持 WebKit 默认 + 日志」，绝不让壳崩溃。
//  W1/W2（2026-12 三轮独立复核）：本文件另承载 T-4 透明露底的异常安全 KVC BOOL 写入
//  （WKWebView 私有键 drawsBackground，不在公开头文件里；Swift 侧无法 catch ObjC 异常，
//  直设会 abort）——@try/@catch 吞掉 NSUnknownKeyException，返回结果而非崩溃。
//
#import "DSHChamberWebKitSupport.h"

// WKPreferencesPrivate.h 声明（上游：+_features 为 macOS 13.3+；
// _isEnabledForFeature:/_setEnabled:forFeature: 为 macOS 10.12+。本包下限 14.4，
// 故不需要 #available）。此处重复声明以免依赖 SDK 私有头；实现只在
// respondsToSelector 通过后调用。
@interface WKPreferences (DSHChamberPrivate)
+ (NSArray *)_features;
- (BOOL)_isEnabledForFeature:(id)feature;
- (void)_setEnabled:(BOOL)value forFeature:(id)feature;
@end

/// WebKit 生成偏好（WebPreferences）里该键的确切拼写（与
/// UnifiedWebPreferences.yaml 的键同名）。
static NSString *const DSHChamberPrefer60FPSFeatureKey = @"PreferPageRenderingUpdatesNear60FPSEnabled";

static id DSHChamberFeatureForKey(NSString *key)
{
    if (![WKPreferences respondsToSelector:@selector(_features)])
        return nil;

    NSArray *features = nil;
    @try {
        features = [WKPreferences _features];
    } @catch (__unused NSException *exception) {
        return nil;
    }

    if (![features isKindOfClass:[NSArray class]])
        return nil;

    for (id feature in features) {
        NSString *candidate = nil;
        @try {
            candidate = [feature valueForKey:@"key"];
        } @catch (__unused NSException *exception) {
            continue;
        }
        if ([candidate isKindOfClass:[NSString class]] && [candidate isEqualToString:key])
            return feature;
    }
    return nil;
}

/// 只读回当前状态（apply 内部收尾用；不导出——公共 C 面只留一个开关函数）。
static DSHChamberRefreshRatePreference DSHChamberRefreshRatePreferenceState(WKPreferences *preferences)
{
    if (!preferences)
        return DSHChamberRefreshRatePreferenceUnknown;

    id feature = DSHChamberFeatureForKey(DSHChamberPrefer60FPSFeatureKey);
    if (!feature || ![preferences respondsToSelector:@selector(_isEnabledForFeature:)])
        return DSHChamberRefreshRatePreferenceUnknown;

    BOOL enabled = YES;
    @try {
        enabled = [preferences _isEnabledForFeature:feature];
    } @catch (__unused NSException *exception) {
        return DSHChamberRefreshRatePreferenceUnknown;
    }
    return enabled ? DSHChamberRefreshRatePreferenceNearSixty : DSHChamberRefreshRatePreferenceDisplayRate;
}

DSHChamberRefreshRatePreference DSHChamberPreferDisplayRefreshRate(WKPreferences *preferences)
{
    if (!preferences)
        return DSHChamberRefreshRatePreferenceUnknown;

    id feature = DSHChamberFeatureForKey(DSHChamberPrefer60FPSFeatureKey);
    if (!feature || ![preferences respondsToSelector:@selector(_setEnabled:forFeature:)])
        return DSHChamberRefreshRatePreferenceUnknown;

    // read-back 必须**先证可用**再改：只有 setter 而 read-back 缺失/抛错时"改完再报
    // Unknown"会让调用方记「SPI 不可用(保持 WebKit 默认)」，而偏好其实已经被关掉
    // ——日志与事实相反。安全方向 = 不动（不动即 WebKit 默认），2026-12 独立复核。
    if (DSHChamberRefreshRatePreferenceState(preferences) == DSHChamberRefreshRatePreferenceUnknown)
        return DSHChamberRefreshRatePreferenceUnknown;

    @try {
        [preferences _setEnabled:NO forFeature:feature];
    } @catch (__unused NSException *exception) {
        return DSHChamberRefreshRatePreferenceUnknown;
    }
    // 残余（2026-12 二轮独立复核记录）：若 setter 在**已经改掉偏好之后**才抛错、或改动
    // 成功而这次回读抛错，本函数仍返回 Unknown，调用方会记「SPI 不可用(保持 WebKit 默认)」
    // ——日志与事实不符。2026-12 三轮独立复核用 swizzling 构造出了这个窗口
    // （改完偏好再让 setter 抛：调用方记"SPI 不可用"而偏好已被改掉），因此本残余
    // **不是不可构造**，只是没有测试覆盖（测试需要在进程内换掉 objc 方法实现）。真正的证据
    // 仍是 DSH_CHAMBER_SHELL_DEBUG 的 [shell-fps] A/B（S-48 实机三工况）。
    return DSHChamberRefreshRatePreferenceState(preferences);
}

#pragma mark - T-4 透明露底：异常安全 KVC BOOL 写入（W1/W2，2026-12 三轮独立复核）

/// 回读：nil 对象 / 键不存在（valueForKey: 抛异常）/ 值不是 NSNumber → NO。
/// 只有 @try 之外确定拿到 NSNumber 才写 outValue。
static BOOL DSHChamberReadBoolValue(id object, NSString *key, BOOL *outValue)
{
    if (!object || outValue == NULL)
        return NO;

    id raw = nil;
    @try {
        raw = [object valueForKey:key];
    } @catch (__unused NSException *exception) {
        return NO;
    }
    if (![raw isKindOfClass:[NSNumber class]])
        return NO;

    *outValue = [(NSNumber *)raw boolValue];
    return YES;
}

DSHChamberBoolKVCOutcome DSHChamberSetBoolValueForKey(id object, NSString *key, BOOL value)
{
    if (!object || key.length == 0)
        return DSHChamberBoolKVCOutcomeUnavailable;

    // 预期异常 = NSUnknownKeyException（键不存在/只读时 setValue:forKey: 的默认
    // setValue:forUndefinedKey: 抛出）。这里按 NSException 兜住整族：Swift 侧没有
    // 任何 catch 面，任何异常泄出去都是进程 abort。
    @try {
        [object setValue:@(value) forKey:key];
    } @catch (__unused NSException *exception) {
        return DSHChamberBoolKVCOutcomeUnavailable;
    }

    BOOL actual = NO;
    if (!DSHChamberReadBoolValue(object, key, &actual))
        return DSHChamberBoolKVCOutcomeReadBackMismatch;
    return actual == value ? DSHChamberBoolKVCOutcomeApplied
                           : DSHChamberBoolKVCOutcomeReadBackMismatch;
}

DSHChamberBoolKVCOutcome DSHChamberSetDrawsBackground(WKWebView *webView, BOOL drawsBackground)
{
    // 键名在此单点出现：KVC 私有键的拼写只依赖这一个字符串。
    return DSHChamberSetBoolValueForKey(webView, @"drawsBackground", drawsBackground);
}
