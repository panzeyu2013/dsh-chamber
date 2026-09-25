//
//  CrashDiagnostics.swift
//  DSHChamber
//
//  P0.2 原生崩溃最小诊断（台账 docs/progress/swift-vs-upstream-differences.md §8.a
//  的「替代 Crashpad」半边；§8.c 明确不做 Crashpad / 不新增依赖）。
//
//  面（都在 <userData>/logs/，与 ShellLog 同目录同权限）：
//    - shell-crash.log    —— 一条崩溃记录（UTC 时间 / 信号或异常名 / bundle 版本 / pid）；
//    - shell-crash.marker —— 存在 ⇒ 上次进程未走正常退出路径。启动期消费（一行
//      shellLog 报告 + 清除），正常退出也清除。
//  覆盖：NSSetUncaughtExceptionHandler + SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE/SIGTRAP。
//
//  信号上下文纪律（本文件的硬约束，见 emit / handleSignal）：
//    - 信号处理器内只做 async-signal-safe 的事：安装期预格式化的字节 + write(2)
//      直写日志叶子与标记文件；崩溃时刻只把 epoch 用 time(2) + **纯整数
//      civil-date 换算**（utcCivilDate：epoch → y/m/d h:m:s UTC）+ 手写定宽十进制
//      拼进定长栈缓冲；标记用 open(O_CREAT|O_TRUNC|O_NOFOLLOW|O_NONBLOCK) +
//      fstat(常规文件且 nlink==1) + write + close。
//    - 只用 Darwin `man 2 sigaction` 名单内的调用：**gmtime_r 不在名单内**
//      （2026-12 审查方向 B B3），时间换算改成本文件内的整数运算；lstat 与
//      ftruncate 同样不在名单内，故标记判据只用 open+fstat（O_TRUNC 的残余见
//      openMarkerLeaf 注释）。
//    - 处理器内绝不做：Swift 分配（Array/字典/String 插值/Formatter）、锁、
//      FileManager、Objective-C 消息发送。时间戳格式与纯函数 formatRecord 锁步
//      （用例以同一 epoch 断言两者逐字节相同）。release 反汇编可验：emitSignal /
//      handleSignal 只调 renderTimestampPrefix/write/open/fstat/close/time/
//      signal/raise。
//    - **未捕获异常处理器是另一类上下文**（不是信号上下文）：它跑在 Objective-C
//      异常展开路径上，读 NSException.name 必然经 ObjC 属性桥接，无法做成零分配；
//      它同样不做 String 插值/Formatter/锁，只把异常名有界拷贝进同一栈缓冲，写
//      路径与信号处理器共用（writeRecord）。
//    - 写完记录后恢复 SIG_DFL 并重发信号：绝不吞信号——系统 DiagnosticReports 的
//      原生报告面（design 25 §5 E17 依赖它）保持不变。
//  明确不做：Crashpad、任何上报（网络）、新桥面/设置页展示（C 分层：页面面不变；
//  要把「上次异常退出」投影到设置页需另立页面/桥面契约，本文件只写日志）。
//
import Darwin
import Foundation

public enum CrashDiagnostics {

    // MARK: - 路径 / 名称 / 格式（纯函数）

    /// 崩溃记录文件名（与 ShellLog 同目录：<userData>/logs/）。
    public static let crashLogFileName = "shell-crash.log"
    /// 「上次异常退出」标记文件名（同目录；存在即异常，启动期消费后清除）。
    public static let markerFileName = "shell-crash.marker"
    /// 安装的致命信号集合（台账 §8.a「未捕获异常/信号」）。
    public static let defaultSignals: [Int32] = [SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP]
    /// 单字段字节上限（白名单化之后；异常名/版本超长截断）。
    public static let fieldByteLimit = 64
    /// 处理器内单条记录的定长栈缓冲（时间戳 23 + body；绝不堆分配）。
    static let stackRecordCapacity = 256
    /// 时间戳前缀 [2026-12-01T08:30:00Z] 的固定长度。
    static let timestampPrefixCapacity = 32

    public static func crashLogURL(userDataDir: String) -> URL {
        ShellLog.fileURL(userDataDir: userDataDir, fileName: crashLogFileName)
    }

    public static func markerURL(userDataDir: String) -> URL {
        ShellLog.fileURL(userDataDir: userDataDir, fileName: markerFileName)
    }

    /// 信号号 → 记录里的稳定名（纯函数）。
    public static func signalName(_ signo: Int32) -> String {
        switch signo {
        case SIGSEGV: return "SIGSEGV"
        case SIGABRT: return "SIGABRT"
        case SIGBUS: return "SIGBUS"
        case SIGILL: return "SIGILL"
        case SIGFPE: return "SIGFPE"
        case SIGTRAP: return "SIGTRAP"
        default: return "SIG\(signo)"
        }
    }

    /// 单行不变量：只保留 [A-Za-z0-9._+@-]，其余字节 → '_'，最多 limit 字节。
    /// 异常名/版本理论上可含换行，注入换行 = 伪造出多条记录（纯函数）。
    public static func sanitizedField(_ value: String, limit: Int = fieldByteLimit) -> String {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(min(max(0, limit), 64))
        for byte in value.utf8 {
            guard bytes.count < limit else { break }
            bytes.append(allowedFieldByte(byte) ? byte : UInt8(ascii: "_"))
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// 白名单判据（处理器内的 copySanitized 与本函数同一份判据）。
    static func allowedFieldByte(_ byte: UInt8) -> Bool {
        (byte >= 0x30 && byte <= 0x39)  // 0-9
            || (byte >= 0x41 && byte <= 0x5A)  // A-Z
            || (byte >= 0x61 && byte <= 0x7A)  // a-z
            || byte == 0x2E  // .
            || byte == 0x5F  // _
            || byte == 0x2B  // +
            || byte == 0x40  // @
            || byte == 0x2D  // -
    }

    /// 记录体（不含时间戳前缀与换行）：
    /// kind=signal name=SIGSEGV signo=11 pid=4242 version=0.16.0
    public static func recordBody(kind: String, name: String, signo: Int32?,
                                  bundleVersion: String, pid: Int32) -> String {
        var body = "kind=\(kind) name=\(sanitizedField(name))"
        if let signo { body += " signo=\(signo)" }
        body += " pid=\(pid) version=\(sanitizedField(bundleVersion))"
        return body
    }

    /// 一条完整崩溃记录（纯函数；处理器的手写路径产出同一字节串 + 换行）。
    public static func formatRecord(kind: String, name: String, signo: Int32?,
                                    bundleVersion: String, pid: Int32, epoch: Int64) -> String {
        "[\(iso8601Timestamp(epoch: epoch))] "
            + recordBody(kind: kind, name: name, signo: signo,
                         bundleVersion: bundleVersion, pid: pid)
    }

    /// epoch 秒 → 2026-12-01T08:30:00Z（纯路径；格式独立于处理器的手写路径，
    /// 处理器以 utcCivilDate 做同一 UTC 换算，用例断言两者逐字节相等）。
    public static func iso8601Timestamp(epoch: Int64) -> String {
        utcFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
    }

    /// epoch 秒 → UTC 年月日时分秒（**纯整数 civil-date 换算**；2026-12 审查
    /// 方向 B B3）。
    ///
    /// 为什么不用 libc 时间函数：处理器只能调 Darwin `man 2 sigaction` 名单内的
    /// async-signal-safe 调用，`gmtime_r` 不在名单里。这里实现 Howard Hinnant 的
    /// civil_from_days（1970-01-01 = day 0）并逐项取整，处理器与用例共用同一份
    /// 整数运算，因此记录的 ISO 文本与 `formatRecord` 逐字节锁步是构造保证。
    /// epoch 为负时先做向下取整的日/秒拆分（time(2) 实际恒非负，纯函数仍正确）。
    static func utcCivilDate(epoch: Int64) -> (year: Int, month: Int, day: Int,
                                               hour: Int, minute: Int, second: Int) {
        let secondsPerDay: Int64 = 86_400
        var days = epoch / secondsPerDay
        var remainder = epoch % secondsPerDay
        if remainder < 0 {
            days -= 1
            remainder += secondsPerDay
        }
        let secondsOfDay = remainder
        // civil_from_days：把 epoch 天数移到 0000-03-01 起算的纪元。
        let shifted = days + 719_468
        let era = (shifted >= 0 ? shifted : shifted - 146_096) / 146_097
        let dayOfEra = shifted - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        var year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime + (monthPrime < 10 ? 3 : -9)
        year += (month <= 2 ? 1 : 0)
        return (Int(year), Int(month), Int(day),
                Int(secondsOfDay / 3_600),
                Int(secondsOfDay % 3_600 / 60),
                Int(secondsOfDay % 60))
    }

    private static let utcFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// bundle 短版本（记录字段；dev / swift run = "unknown"——绝不猜）。
    public static func bundleVersion(infoDictionary: [String: Any]) -> String {
        guard let version = infoDictionary["CFBundleShortVersionString"] as? String,
              !version.isEmpty else { return "unknown" }
        return version
    }

    public static func currentBundleVersion() -> String {
        bundleVersion(infoDictionary: Bundle.main.infoDictionary ?? [:])
    }

    // MARK: - 安装（注入 seam，可单测）

    /// 安装结果：也用于正常退出时清标记。
    public struct Installation: Equatable {
        public let crashLogURL: URL
        public let markerURL: URL
        /// 崩溃记录叶子的裸 fd（-1 = 打开失败，此时标记仍会写）。
        public let logFD: Int32
        public let installedSignals: [Int32]
        public let exceptionHandlerInstalled: Bool

        /// 崩溃记录落盘是否可用。
        public var logActive: Bool { logFD >= 0 }

        /// 正常退出清除「上次异常退出」标记（幂等，失败静默）。
        public func clearMarker() {
            CrashDiagnostics.clearMarker(at: markerURL)
        }
    }

    /// 安装注入 seam：单测断言「装了什么」，绝不真接管测试进程的信号/异常处理器
    /// （真装会改写 XCTest 的崩溃语义）。
    public struct InstallSeams {
        public var openCrashLogLeaf: (URL, Int) -> Int32
        public var setExceptionHandler: (@escaping @convention(c) (NSException) -> Void) -> Bool
        public var installSignalHandler: (Int32, @escaping @convention(c) (Int32) -> Void) -> Bool
        public var currentExceptionHandler: () -> (@convention(c) (NSException) -> Void)?

        public init(
            openCrashLogLeaf: @escaping (URL, Int) -> Int32,
            setExceptionHandler: @escaping (@escaping @convention(c) (NSException) -> Void) -> Bool,
            installSignalHandler: @escaping (Int32, @escaping @convention(c) (Int32) -> Void) -> Bool,
            currentExceptionHandler: @escaping () -> (@convention(c) (NSException) -> Void)?
        ) {
            self.openCrashLogLeaf = openCrashLogLeaf
            self.setExceptionHandler = setExceptionHandler
            self.installSignalHandler = installSignalHandler
            self.currentExceptionHandler = currentExceptionHandler
        }

        /// 生产 seam：共享叶子路径 + 真 signal/NSSetUncaughtExceptionHandler。
        public static let live = InstallSeams(
            openCrashLogLeaf: { url, maxBytes in
                ShellLog.openSignalSafeLeaf(url: url, maxBytes: maxBytes)
            },
            setExceptionHandler: { handler in
                NSSetUncaughtExceptionHandler(handler)
                return true
            },
            installSignalHandler: { signo, handler in
                // 用 sigaction 而不是 signal()：@convention(c) 函数指针没有 ==
                //（无法与 SIG_ERR 比较），而 sigaction 的返回值（0/-1）本身就是判据。
                var action = sigaction()
                sigemptyset(&action.sa_mask)
                action.sa_flags = SA_RESTART
                action.__sigaction_u.__sa_handler = handler
                return sigaction(signo, &action, nil) == 0
            },
            currentExceptionHandler: { NSGetUncaughtExceptionHandler() })
    }

    /// 安装崩溃诊断。绝不抛错/绝不致命：打开失败（dev、权限被拒）时 logFD == -1，
    /// 标记仍可写；seam 失败只反映在返回值里，调用方一行 loud 日志即可。
    @discardableResult
    public static func install(userDataDir: String,
                               bundleVersion: String = CrashDiagnostics.currentBundleVersion(),
                               pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                               signals: [Int32] = CrashDiagnostics.defaultSignals,
                               seams: InstallSeams = .live) -> Installation {
        let logURL = crashLogURL(userDataDir: userDataDir)
        let markerURL = markerURL(userDataDir: userDataDir)
        let logFD = seams.openCrashLogLeaf(logURL, ShellLog.defaultMaxBytes)
        let context = buildContext(logFD: logFD, markerPath: markerURL.path, pid: pid,
                                   bundleVersion: bundleVersion, signals: signals,
                                   previousExceptionHandler: seams.currentExceptionHandler())
        if let existing = crashHandlerContextStorage { release(existing) }
        crashHandlerContextStorage = context
        var installed: [Int32] = []
        for signo in signals where seams.installSignalHandler(signo, dshCrashSignalHandler) {
            installed.append(signo)
        }
        let exceptionInstalled = seams.setExceptionHandler(dshCrashExceptionHandler)
        return Installation(crashLogURL: logURL, markerURL: markerURL, logFD: logFD,
                            installedSignals: installed,
                            exceptionHandlerInstalled: exceptionInstalled)
    }

    // MARK: - 上次异常退出（启动消费 / 正常退出清除）

    /// 判定（纯函数）：标记存在 = 上次未走正常退出路径。
    /// 边界：SIGKILL/断电等未捕获路径不会写标记（最小诊断的已知边界，见 §8.a）。
    public static func previousCrashDetected(markerExists: Bool) -> Bool { markerExists }

    /// 一行 shellLog 文案（纯函数）：含记录路径；能读到记录行时附上它（「给出原因」）。
    public static func previousCrashLogLine(crashLogPath: String, lastRecordLine: String?) -> String {
        if let line = lastRecordLine, !line.isEmpty {
            return "[shell] 上次异常退出：\(line)（记录：\(crashLogPath)）"
        }
        return "[shell] 上次异常退出：记录为空（记录：\(crashLogPath)）"
    }

    /// 启动期一次性消费（注入 IO，可单测）：标记存在 → 一行日志（含记录路径与
    /// 最近一条记录）+ 清除标记；不存在 → 什么都不做（返回 nil）。
    /// B6：清除失败必须 loud 出一行独立失败（含路径与后果）——旧实现静默吞掉
    /// 失败并照样返回报告行，标记清不掉时每次启动都会重复报同一条旧崩溃而无人知道。
    @discardableResult
    public static func reportPreviousCrashIfNeeded(
        userDataDir: String,
        io: PreviousCrashIO = .live
    ) -> String? {
        let marker = markerURL(userDataDir: userDataDir)
        guard previousCrashDetected(markerExists: io.markerExists(marker)) else { return nil }
        let logURL = crashLogURL(userDataDir: userDataDir)
        let line = previousCrashLogLine(crashLogPath: logURL.path,
                                        lastRecordLine: io.readLastRecordLine(logURL))
        io.log(line)
        if !io.removeMarker(marker) {
            io.log(markerRemovalFailureLine(markerPath: marker.path))
        }
        return line
    }

    /// 标记清除失败的 loud 文案（B6 纯函数）：带路径、后果与可执行动作。
    public static func markerRemovalFailureLine(markerPath: String) -> String {
        "[shell] 上次异常退出标记清除失败（\(markerPath)）——标记仍在，"
            + "下次启动会重复报告同一条旧崩溃；请手动删除该文件"
    }

    /// 标记读写 IO（注入 seam；live = FileManager + shellLog）。
    public struct PreviousCrashIO {
        public var markerExists: (URL) -> Bool
        public var readLastRecordLine: (URL) -> String?
        public var removeMarker: (URL) -> Bool
        public var log: (String) -> Void

        public init(markerExists: @escaping (URL) -> Bool,
                    readLastRecordLine: @escaping (URL) -> String?,
                    removeMarker: @escaping (URL) -> Bool,
                    log: @escaping (String) -> Void) {
            self.markerExists = markerExists
            self.readLastRecordLine = readLastRecordLine
            self.removeMarker = removeMarker
            self.log = log
        }

        public static let live = PreviousCrashIO(
            markerExists: { FileManager.default.fileExists(atPath: $0.path) },
            readLastRecordLine: { lastRecordLine(at: $0) },
            removeMarker: { url in
                guard FileManager.default.fileExists(atPath: url.path) else { return false }
                return (try? FileManager.default.removeItem(at: url)) != nil
            },
            log: { shellLog($0) })
    }

    /// 正常退出 / 启动消费后的清标记（不存在 = no-op；失败静默——清理绝不致命）。
    public static func clearMarker(at url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// 记录文件最后一条非空行（读失败 = nil；单行截到 512 字节，日志行不被拖爆）。
    static func lastRecordLine(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        let text = String(decoding: data, as: UTF8.self)
        guard let last = text.split(whereSeparator: \.isNewline).last else { return nil }
        let trimmed = String(last).trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(512))
    }

    // MARK: - 处理器核心（信号上下文；测试经 emitForTesting 直调）

    /// 安装期一次性写定的处理器上下文；处理器只读（全定长值/裸指针）。
    struct HandlerContext {
        var logFD: Int32
        var markerPath: UnsafeMutablePointer<CChar>?
        var signalEntries: UnsafeMutablePointer<SignalEntry>
        var signalEntryCount: Int
        var exceptionPrefix: UnsafeMutablePointer<UInt8>
        var exceptionPrefixCount: Int
        var exceptionSuffix: UnsafeMutablePointer<UInt8>
        var exceptionSuffixCount: Int
        var previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    }

    struct SignalEntry {
        var signo: Int32
        var body: UnsafeMutablePointer<UInt8>
        var bodyCount: Int
    }

    /// 测试 seam：直调处理器核心（不真发信号、不真抛异常）。返回 false = 未安装。
    @discardableResult
    static func emitForTesting(signal signo: Int32, epoch: Int64) -> Bool {
        guard let pointer = crashHandlerContextStorage else { return false }
        emitSignal(signo: signo, context: pointer.pointee, epoch: epoch)
        return true
    }

    /// 测试 seam：直调未捕获异常处理器核心。
    @discardableResult
    static func emitForTesting(exceptionName: String, epoch: Int64) -> Bool {
        guard let pointer = crashHandlerContextStorage else { return false }
        emitException(name: exceptionName, context: pointer.pointee, epoch: epoch)
        return true
    }

    /// 信号处理器核心：写记录 + 标记，然后恢复默认处置并重发（绝不吞信号）。
    static func handleSignal(_ signo: Int32) {
        guard let pointer = crashHandlerContextStorage else { return }
        // 异常路径已写过记录（异常处理器通常链回 abort() → SIGABRT）：不再写第二条
        // 信息更少的记录，只保持「不吞信号」。
        if crashExceptionRecordWritten == 0 {
            emitSignal(signo: signo, context: pointer.pointee, epoch: Int64(time(nil)))
        }
        signal(signo, SIG_DFL)
        raise(signo)
    }

    /// 未捕获异常处理器核心：写记录 + 标记，再链回安装前的处理器（AppKit 的默认
    /// 处理器负责打印/终止；没有则交回运行时，未捕获异常在处理器返回后仍终止进程）。
    /// 注意：**本函数不是信号上下文**（异常展开路径），读 name 会有 ObjC 桥接；
    /// 但同样不做 String 插值/Formatter/锁，写路径与信号处理器共用。
    static func handleUncaughtException(_ exception: NSException) {
        guard let pointer = crashHandlerContextStorage else { return }
        let context = pointer.pointee
        emitException(name: exception.name.rawValue, context: context, epoch: Int64(time(nil)))
        crashExceptionRecordWritten = 1
        context.previousExceptionHandler?(exception)
    }

    /// 组装并写出信号记录：时间戳前缀（手写）+ 安装期预格式化的 body。
    static func emitSignal(signo: Int32, context: HandlerContext, epoch: Int64) {
        guard let entry = signalEntry(forSigno: signo, context: context), entry.bodyCount > 0 else {
            return
        }
        withUnsafeTemporaryAllocation(of: UInt8.self, capacity: stackRecordCapacity) { buffer in
            guard let base = buffer.baseAddress else { return }
            var written = renderTimestampPrefix(epoch: epoch, into: base, capacity: buffer.count)
            written += copyBytes(entry.body, count: entry.bodyCount,
                                 into: base, offset: written, capacity: buffer.count)
            writeRecord(base, count: written, context: context)
        }
    }

    /// 组装并写出异常记录：时间戳前缀 + kind=exception name= + 白名单化异常名 +
    /// 安装期预格式化的 pid/版本后缀（异常名是动态值，只能在这条路径上拼）。
    static func emitException(name: String, context: HandlerContext, epoch: Int64) {
        withUnsafeTemporaryAllocation(of: UInt8.self, capacity: stackRecordCapacity) { buffer in
            guard let base = buffer.baseAddress else { return }
            var written = renderTimestampPrefix(epoch: epoch, into: base, capacity: buffer.count)
            written += copyBytes(context.exceptionPrefix, count: context.exceptionPrefixCount,
                                 into: base, offset: written, capacity: buffer.count)
            written += copySanitized(name.utf8, limit: fieldByteLimit,
                                     into: base, offset: written, capacity: buffer.count)
            written += copyBytes(context.exceptionSuffix, count: context.exceptionSuffixCount,
                                 into: base, offset: written, capacity: buffer.count)
            writeRecord(base, count: written, context: context)
        }
    }

    /// 三个去向依次写同一段字节：崩溃记录 fd、stderr（终端/log show 兜底）、标记
    /// 文件（O_TRUNC ⇒ 标记里就是最近一条记录）。任一步失败静默——诊断绝不成为
    /// 新的致命面。全程只用 write/open/fstat/close（都在 async-signal-safe 名单）。
    static func writeRecord(_ bytes: UnsafeMutablePointer<UInt8>, count: Int,
                            context: HandlerContext) {
        guard count > 0 else { return }
        if context.logFD >= 0 { _ = write(context.logFD, bytes, count) }
        _ = write(STDERR_FILENO, bytes, count)
        guard let markerPath = context.markerPath else { return }
        let descriptor = openMarkerLeaf(markerPath)
        guard descriptor >= 0 else { return }
        _ = write(descriptor, bytes, count)
        _ = close(descriptor)
    }

    /// 标记叶子的打开与判据（B5）：与 `ShellLog.openRegularLeafFD` 同一套
    /// 「常规文件 + nlink == 1」纪律，但只能用信号上下文名单内的调用——
    /// `lstat` / `ftruncate` 不在 Darwin 名单里，故这里只有 open → fstat → 判据。
    ///
    /// 顺序：open(O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW|O_NONBLOCK) → fstat →
    /// markerLeafAccepted。判据不成立时关闭 fd 并返回 -1，**绝不写字节**。
    /// 已知残余（如实登记，不假装等价）：O_TRUNC 发生在 fstat 之前，因此若标记
    /// 路径是硬链接或被换掉的叶子，最坏后果是那个 inode 被清零；记录内容绝不会
    /// 落到第二个名字。FIFO 无读者时 open 直接 ENXIO，有读者时 fstat 判据拒绝，
    /// 两种情况都不会阻塞（O_NONBLOCK）。
    static func openMarkerLeaf(_ path: UnsafePointer<CChar>) -> Int32 {
        let descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard descriptor >= 0 else { return -1 }
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              markerLeafAccepted(mode: info.st_mode, nlink: info.st_nlink) else {
            close(descriptor)
            return -1
        }
        return descriptor
    }

    /// 标记叶子判据（纯函数，与 `ShellLog.openRegularLeafFD` 逐条相同）：
    /// 常规文件且 nlink == 1；FIFO/socket/设备/目录/符号链接/硬链接一律不写。
    static func markerLeafAccepted(mode: mode_t, nlink: nlink_t) -> Bool {
        (mode & S_IFMT) == S_IFREG && nlink == 1
    }

    /// [2026-12-01T08:30:00Z] + 一个空格（23 字节）写入定长缓冲，返回长度。
    /// 只用 **纯整数 civil-date 换算**（utcCivilDate）+ 手写定宽十进制：信号上下文
    /// 不允许 Formatter/分配，`gmtime_r` 不在 async-signal-safe 名单里（B3）。
    static func renderTimestampPrefix(epoch: Int64, into buffer: UnsafeMutablePointer<UInt8>,
                                      capacity: Int) -> Int {
        guard capacity >= timestampPrefixCapacity else { return 0 }
        let date = utcCivilDate(epoch: epoch)
        var written = 0
        buffer[written] = UInt8(ascii: "["); written += 1
        written += writeFixedDigits(date.year, digits: 4, into: buffer, offset: written)
        buffer[written] = UInt8(ascii: "-"); written += 1
        written += writeFixedDigits(date.month, digits: 2, into: buffer, offset: written)
        buffer[written] = UInt8(ascii: "-"); written += 1
        written += writeFixedDigits(date.day, digits: 2, into: buffer, offset: written)
        buffer[written] = UInt8(ascii: "T"); written += 1
        written += writeFixedDigits(date.hour, digits: 2, into: buffer, offset: written)
        buffer[written] = UInt8(ascii: ":"); written += 1
        written += writeFixedDigits(date.minute, digits: 2, into: buffer, offset: written)
        buffer[written] = UInt8(ascii: ":"); written += 1
        written += writeFixedDigits(date.second, digits: 2, into: buffer, offset: written)
        buffer[written] = UInt8(ascii: "Z"); written += 1
        buffer[written] = UInt8(ascii: "]"); written += 1
        buffer[written] = UInt8(ascii: " "); written += 1
        return written
    }

    /// 定宽十进制（信号上下文手写；负数/越界只裁剪，绝不越界写）。
    static func writeFixedDigits(_ value: Int, digits: Int,
                                 into buffer: UnsafeMutablePointer<UInt8>,
                                 offset: Int) -> Int {
        guard digits > 0 else { return 0 }
        let remaining = max(0, value)
        var divisor = 1
        var step = 1
        while step < digits {
            divisor *= 10
            step += 1
        }
        for index in 0..<digits {
            let digit = (remaining / divisor) % 10
            buffer[offset + index] = UInt8(ascii: "0") + UInt8(digit)
            divisor = divisor / 10
        }
        return digits
    }

    /// 裸字节拷贝（有界；处理器内不做任何 Swift 语义分配）。
    static func copyBytes(_ source: UnsafeMutablePointer<UInt8>, count: Int,
                          into buffer: UnsafeMutablePointer<UInt8>,
                          offset: Int, capacity: Int) -> Int {
        var written = 0
        while written < count && offset + written < capacity {
            buffer[offset + written] = source[written]
            written += 1
        }
        return written
    }

    /// 白名单化 + 截断拷贝（与纯函数 sanitizedField 同一判据；处理器内不建 String）。
    static func copySanitized(_ bytes: String.UTF8View, limit: Int,
                              into buffer: UnsafeMutablePointer<UInt8>,
                              offset: Int, capacity: Int) -> Int {
        var written = 0
        for byte in bytes {
            guard written < limit, offset + written < capacity else { break }
            buffer[offset + written] = allowedFieldByte(byte) ? byte : UInt8(ascii: "_")
            written += 1
        }
        return written
    }

    /// 线性查表（安装的信号 ≤ 6 个；处理器内不做字典/哈希）。
    static func signalEntry(forSigno signo: Int32, context: HandlerContext) -> SignalEntry? {
        var index = 0
        while index < context.signalEntryCount {
            let entry = context.signalEntries[index]
            if entry.signo == signo { return entry }
            index += 1
        }
        return nil
    }

    // MARK: - 安装期内存（非信号上下文）

    private static func buildContext(
        logFD: Int32, markerPath: String, pid: Int32, bundleVersion: String,
        signals: [Int32],
        previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    ) -> UnsafeMutablePointer<HandlerContext> {
        let entries = UnsafeMutablePointer<SignalEntry>.allocate(capacity: max(1, signals.count))
        var count = 0
        for signo in signals {
            let (body, bodyCount) = makeBytes(
                recordBody(kind: "signal", name: signalName(signo), signo: signo,
                           bundleVersion: bundleVersion, pid: pid) + "\n")
            entries[count] = SignalEntry(signo: signo, body: body, bodyCount: bodyCount)
            count += 1
        }
        // 异常路径拆成前缀 + 前缀之后的后缀：异常名是崩溃时刻才知道的动态值，
        // 只把静态部分预格式化（前缀/suffix 由同一 recordBody 派生，格式不漂移）。
        let exceptionBody = recordBody(kind: "exception", name: "", signo: nil,
                                       bundleVersion: bundleVersion, pid: pid)
        let prefix = "kind=exception name="
        let suffix = String(exceptionBody.dropFirst(prefix.count)) + "\n"
        let (prefixBytes, prefixCount) = makeBytes(prefix)
        let (suffixBytes, suffixCount) = makeBytes(suffix)
        let context = UnsafeMutablePointer<HandlerContext>.allocate(capacity: 1)
        context.initialize(to: HandlerContext(
            logFD: logFD,
            markerPath: strdup(markerPath),
            signalEntries: entries,
            signalEntryCount: count,
            exceptionPrefix: prefixBytes,
            exceptionPrefixCount: prefixCount,
            exceptionSuffix: suffixBytes,
            exceptionSuffixCount: suffixCount,
            previousExceptionHandler: previousExceptionHandler))
        return context
    }

    private static func makeBytes(_ string: String) -> (UnsafeMutablePointer<UInt8>, Int) {
        let bytes = Array(string.utf8)
        let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: max(1, bytes.count))
        if !bytes.isEmpty { pointer.initialize(from: bytes, count: bytes.count) }
        return (pointer, bytes.count)
    }

    private static func release(_ context: UnsafeMutablePointer<HandlerContext>) {
        let value = context.pointee
        for index in 0..<value.signalEntryCount {
            value.signalEntries[index].body.deallocate()
        }
        value.signalEntries.deallocate()
        value.exceptionPrefix.deallocate()
        value.exceptionSuffix.deallocate()
        if let marker = value.markerPath { free(marker) }
        context.deinitialize(count: 1)
        context.deallocate()
    }
}

// MARK: - C 函数指针（不能捕获上下文；文件级全局是唯一载体）

/// 安装期写定的上下文。Swift 没有 C 静态变量，用文件级全局；处理器只做 load +
/// POSIX async-signal-safe 调用，绝不在这里写/分配。
private var crashHandlerContextStorage: UnsafeMutablePointer<CrashDiagnostics.HandlerContext>?

/// 异常路径已写记录（sig_atomic_t：处理器只做原子读写）。异常处理器链回上一处理器
/// 时通常触发 abort() → SIGABRT；若不设此门，会写出第二条信息更少的记录，标记里
/// 就只剩 SIGABRT。
private var crashExceptionRecordWritten: sig_atomic_t = 0

/// 信号处理器（文件级函数，无捕获）。
private func dshCrashSignalHandler(_ signo: Int32) {
    CrashDiagnostics.handleSignal(signo)
}

/// 未捕获异常处理器（文件级函数，无捕获）。
private func dshCrashExceptionHandler(_ exception: NSException) {
    CrashDiagnostics.handleUncaughtException(exception)
}
