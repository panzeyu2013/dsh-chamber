# overscroll-probe（视口越界策略的验收探针）

视口越界策略（design 25 §5.1 / deviations S-48）的**可复跑**证据。它把仓库的
`macos/Sources/DSHChamberPoc/ShellOverscrollPolicy.swift` 与探针一起编译：策略模式
注入的就是 `makeUserScript()` 的真实产出，没有"手抄成文件"这一步，所以 B1 那类
"占位符没被 Swift 插值"的缺陷会在这里直接现形。

```
node macos/scripts/overscroll-probe/typecheck.mjs      # 编译面（无 GUI；已接入 darwin 门禁）
node macos/scripts/overscroll-probe/run.mjs            # 效果面：打印观测与检查
node macos/scripts/overscroll-probe/run.mjs --assert   # 效果面：断言失败 → 退出码 1
```

- **分工**：编译面在 CI darwin 腿（`scripts/gates/run-checks.mjs` 的 `MACOS_CHECKS`）里跑，
  挡"策略源 API 漂移 / 探针烂掉"；**效果面手动运行**（需要已登录的 GUI 会话——会建 accessory
  窗口并合成连续相位滚轮：began + 8×changed，按住不发 ended），CI 的 headless runner 不保证可跑。
- 判据信号：`window.visualViewport.pageTop`（视口被弹性平移的量）与 `#main.scrollTop`。
  不要用 0x0 合成层 position——同一场景它在 0..40 之间抖，单用它做结论会假阴性。
- 断言（`--assert`）：
  * baseline 三场景出现位移：`bar-up` / `content-top-up` 负向 `vvTopMin ≤ −8`、
    `content-bottom-down` 正向 `vvTopMax ≥ 8`；
  * policy 四场景视口位移为 0（判据 |vvTop| ≤ 1pt 容差）；
  * **正常滚动**用同一条确实驱动内层滚动器的手势（`bar-down`：`#main` 0→810）在两态比对；
  * `scope`（无手势）：主文档 `styleCount ≥ 1` 且 computed `none`、iframe 子文档
    `styleCount = 0` 且 computed `auto`——把 `forMainFrameOnly` 改成 false 会让它变红；
  * `causal` 三步：策略在 0 → 运行时移除注入样式（位移回来）→ 重新执行策略源（回 0）；
  * `policyBytes`/`policySHA256` 与 `run.mjs` 里签入的 `POLICY_SHA256_PIN` 比对：有意改
    注入串必须同步更新锚，并复核 design 25 §5.1 / deviations S-48。
- `content-mid` 只打印不设断言（指针落点不是断言维度，见下）。
- **采样失败不当 0**：`evaluateJavaScript` 超时/异常/解析失败一律打成 `HARNESS-ERROR` 并非零
  退出——否则"只在手势期间采样超时"会被读成 policy 零位移的假绿。
- **指针落点不是断言维度**：合成事件的 NSEvent `windowNumber=0`，WebKit 的命中语义不由装置
  保证；场景名只表示滚动方向与滚动器状态，不代表"指针稳定停在顶栏/内容区"。
- 探针用 `nonPersistent` WebsiteDataStore：不写用户 WebKit 目录，也不跨轮带 cookie/cache。
- 装置只发合成滚轮：能证明/证伪"视口越界是否被抑制""正常滚动是否受影响"，**不代表**真实
  触控板惯性、键盘滚动、滚动条拖拽、缩放、全屏等（那些归打包态实机走查）。
