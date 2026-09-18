//
//  DSHChamberWebKitSupport.m
//  DSHChamberWebKitSupport
//
//  S-48 / design 25 §5.1：见头文件。实现只做三件事：按 key 找到该 WebKit 构建的 _WKFeature、
//  置 NO、读回。全部 SPI 调用都有 respondsToSelector/@try 兜底——未来 OS 拿掉
//  任一 SPI 时退化为「保持 WebKit 默认 + 日志」，绝不让壳崩溃。
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
    // ——日志与事实不符。窗口要求 SPI 本身在改完之后变成 flaky，实测无法构造；真正的证据
    // 仍是 POC_DEBUG 的 [native-fps] A/B（S-48 实机三工况）。
    return DSHChamberRefreshRatePreferenceState(preferences);
}
