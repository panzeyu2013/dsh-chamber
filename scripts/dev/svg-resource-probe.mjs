/**
 * 真机验收探针：文档级 SVG 资源 id 失绘不变量（design 05 §4.2）。
 *
 * 为什么存在：这条修复的唯一权威证据是 macOS WKWebView 上的实际绘制行为 —— 单元测试只能钉住
 * DOM 变换契约。本脚本把**仓库里真实的** `packages/renderer/src/svg-resource-scope.ts`（类型
 * 剥离后）注入宿主 WKWebView，重放触发序列，用可判定的不变量代替人眼看图。
 *
 * 用法（需要控制面已在跑；默认 http://localhost:17500）：
 *   node scripts/dev/svg-resource-probe.mjs
 *   node scripts/dev/svg-resource-probe.mjs --url http://localhost:17500 --out /tmp/probe --keep
 *
 * 用法补充：--expect-artifact 把「注入前页面已自带 scoper」也当作硬判据（用于**重建产物**的交付验收）。
 *
 * 判据（fix 组，注入 scoper）
 *   1. 文档里每个 <svg> 都带 data-chamber-svg-scope；
 *   2. 资源属性引用到的 id 在文档里只有一份定义（重复定义=0）；
 *   3. 设置面板每一行导航图标的包围盒内都能测到绘制（ink ≥ 阈值）。
 * 对照组（control 组，不注入 scoper）本应**复现**空白：存在重复定义，且至少一行 ink = 0；
 * 例外：服务页面**已自带 scoper**（注入前就有标记，= 产物已含本次修复）时对照天然不适用——脚本只告警、
 * 不判失败，此时的交付判据是 --expect-artifact + fix 组不变量；既未复现又未自带 scoper ⇒ 判据不可信，非零退出。
 *
 * 退出码：0 判据全过；1 判据失败/对照组未复现；2 环境不可用（非 macOS / 无 swiftc / 页面不响应）。
 *
 * 注意：这是一个**人工验收工具**，不是 CI 门禁（它要求一个活着的控制面）。所以它不注册测试
 * 清单；改动渲染器后请手动跑一次（STATUS 开放项①）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodePng } from '../lib/png-ink.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const MODULE_PATH = join(REPO, 'packages', 'renderer', 'src', 'svg-resource-scope.ts')
const INK_THRESHOLD = 5

function parseArgs(argv) {
  const options = { url: 'http://localhost:17500', out: null, keep: false, expectArtifact: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--url') options.url = argv[++index]
    else if (token === '--out') options.out = argv[++index]
    else if (token === '--keep') options.keep = true
    else if (token === '--expect-artifact') options.expectArtifact = true
    else if (token === '--help') { console.log('usage: node scripts/dev/svg-resource-probe.mjs [--url U] [--out DIR] [--keep] [--expect-artifact]'); process.exit(0) }
    else { console.error('unknown argument: ' + token); process.exit(2) }
  }
  return options
}

/** 把仓库里真实的 scoper 源码变成可注入的脚本（去 export、IIFE 自执行安装）。 */
function buildScopeInjection() {
  const source = readFileSync(MODULE_PATH, 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' })
  const body = stripped.replace(/^export /gm, '')
  return '(function(){' + body + '\n if (typeof installSvgResourceScope !== "function") return "missing";'
    + ' installSvgResourceScope(); return "installed"; })()'
}

const PRECHECK = '(function(){'
  + 'window.__preScoped = document.querySelectorAll("[data-chamber-svg-scope]").length;'
  + 'return "precheck";'
  + '})()'

const CLONE_SHELL = '(function(){'
  + 'var view=document.querySelector(".instance-view");'
  + 'if(!view||!view.parentElement) return "no-instance-view";'
  + 'var holder=document.createElement("div");'
  + 'holder.className="instance-view instance-hidden";'
  + 'holder.setAttribute("data-probe-clone","1");'
  + 'holder.innerHTML=view.outerHTML;'
  + 'var ids=holder.querySelectorAll("[id]");'
  + 'var PREFIX="chamber-csvg";'
  + 'for (var i=0;i<ids.length;i++){'
  + '  var old=ids[i].id; if(old.indexOf(PREFIX)!==0) continue;'
  + '  var k=PREFIX.length; while(k<old.length){ var c=old.charCodeAt(k); if(c<48||c>57) break; k++; }'
  + '  if(old.charAt(k)!=="-") continue;'
  + '  ids[i].id=old.slice(k+1);'
  + '}'
  + 'var marked=holder.querySelectorAll("[data-chamber-svg-scope]");'
  + 'for (var m=0;m<marked.length;m++) marked[m].removeAttribute("data-chamber-svg-scope");'
  + 'view.parentElement.appendChild(holder);'
  + 'return "cloned";'
  + '})()'

const OPEN_SETTINGS = '(function(){'
  + 'var buttons=Array.prototype.slice.call(document.querySelectorAll("button"));'
  + 'var trigger=buttons.filter(function(b){ return b.getAttribute("aria-label")==="设置" && !b.closest("[data-probe-clone]"); })[0];'
  + 'if(!trigger) return "no-trigger";'
  + 'trigger.click(); return "clicked";'
  + '})()'

const AUDIT = '(function(){'
  + 'var attrs=["clip-path","mask","filter","fill","stroke"];'
  + 'var svgs=document.querySelectorAll("svg");'
  + 'var scoped=0, refIds={};'
  + 'for (var i=0;i<svgs.length;i++){'
  + '  var svg=svgs[i]; if(svg.getAttribute("data-chamber-svg-scope")!==null) scoped++;'
  + '  var nodes=[svg].concat(Array.prototype.slice.call(svg.querySelectorAll("[clip-path],[mask],[filter],[fill],[stroke]")));'
  + '  for (var n=0;n<nodes.length;n++){ for (var a=0;a<attrs.length;a++){'
  + '    var value=nodes[n].getAttribute(attrs[a]); if(!value) continue;'
  + '    var lower=value.toLowerCase(), pos=0;'
  + '    while(true){ var at=lower.indexOf("url(#",pos); if(at<0) break; var end=value.indexOf(")",at); var id=value.slice(at+5,end); if(id) refIds[id]=1; pos=end+1; }'
  + '  } }'
  + '}'
  + 'var single=0, duplicates=0;'
  + 'for (var key in refIds){'
  + '  var count=document.querySelectorAll("[id=\\"" + key + "\\"]").length;'
  + '  if(count===1) single++; else duplicates++;'
  + '}'
  + 'var panels=Array.prototype.slice.call(document.querySelectorAll("[role=dialog][aria-modal=true]"))'
  + '  .filter(function(p){ return !p.closest("[data-probe-clone]"); });'
  + 'var rows=[];'
  + 'if (panels.length>0){'
  + '  var buttons=panels[0].querySelectorAll("nav button");'
  + '  for (var b=0;b<buttons.length;b++){'
  + '    var icon=buttons[b].querySelector("svg")||buttons[b];'
  + '    var rect=icon.getBoundingClientRect();'
  + '    rows.push({ label:(buttons[b].textContent||"").trim().slice(0,12), x:rect.left, y:rect.top, w:rect.width, h:rect.height });'
  + '  }'
  + '}'
  + 'return { viewport:[window.innerWidth,window.innerHeight], preScoped:(typeof window.__preScoped === "number" ? window.__preScoped : -1), svgTotal:svgs.length, scopedSvg:scoped,'
  + '  distinctRefIds:Object.keys(refIds).length, refIdsWithSingleDef:single, refIdsWithDuplicateDefs:duplicates,'
  + '  panelOpened:panels.length>0, panelRows:rows };'
  + '})'

const DRIVER = [
  'import AppKit',
  'import Foundation',
  'import WebKit',
  '',
  'let argv = CommandLine.arguments',
  'let target = URL(string: argv[1])!',
  'let mode = argv[2]',
  'let stepsDir = argv[3]',
  'let pngPath = argv[4]',
  '',
  'func stepFile(_ name: String) -> String {',
  '  return (try? String(contentsOfFile: stepsDir + "/" + name, encoding: .utf8)) ?? ""',
  '}',
  '',
  'final class Driver: NSObject, WKNavigationDelegate {',
  '  var steps: [String] = []',
  '  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {',
  '    steps.append(stepFile("precheck.js"))',
  '    if mode == "fix" { steps.append(stepFile("scope.js")) }',
  '    steps.append(stepFile("clone.js"))',
  '    steps.append(stepFile("open.js"))',
  '    steps.append("window.__probeAudit = " + stepFile("audit.js"))',
  '    DispatchQueue.main.asyncAfter(deadline: .now() + 12.0) { self.runStep(webView) }',
  '  }',
  '  func runStep(_ webView: WKWebView) {',
  '    if steps.isEmpty { finish(webView); return }',
  '    let js = steps.removeFirst()',
  '    webView.evaluateJavaScript(js) { _, error in',
  '      if let error = error {',
  '        print("step error: " + String(describing: error))',
  '      }',
  '      DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.runStep(webView) }',
  '    }',
  '  }',
  '  func finish(_ webView: WKWebView) {',
  '    webView.evaluateJavaScript("JSON.stringify(window.__probeAudit())") { result, error in',
  '      if let text = result as? String { print("PROBE_JSON " + text) }',
  '      else { print("PROBE_ERROR " + String(describing: error)) }',
  '      let config = WKSnapshotConfiguration()',
  '      webView.takeSnapshot(with: config) { image, _ in',
  '        if let image = image, let tiff = image.tiffRepresentation,',
  '           let rep = NSBitmapImageRep(data: tiff),',
  '           let png = rep.representation(using: .png, properties: [:]) {',
  '          try? png.write(to: URL(fileURLWithPath: pngPath))',
  '        }',
  '        exit(0)',
  '      }',
  '    }',
  '  }',
  '}',
  '',
  'let configuration = WKWebViewConfiguration()',
  'configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()',
  'let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1400, height: 900), configuration: configuration)',
  'let driver = Driver()',
  'web.navigationDelegate = driver',
  'web.load(URLRequest(url: target))',
  'DispatchQueue.main.asyncAfter(deadline: .now() + 90.0) { exit(3) }',
  'RunLoop.main.run()',
  '',
].join('\n')

function measureInk(image, rect, scale) {
  const x0 = Math.max(0, Math.round(rect.x * scale))
  const y0 = Math.max(0, Math.round(rect.y * scale))
  const x1 = Math.min(image.width, Math.round((rect.x + rect.w) * scale))
  const y1 = Math.min(image.height, Math.round((rect.y + rect.h) * scale))
  let ink = 0
  for (let y = y0; y < y1; y += 1) {
    const row = image.rows[y]
    if (row === undefined) continue
    for (let x = x0; x < x1; x += 1) {
      const at = x * image.channels
      const r = row[at] ?? 255
      const g = row[at + 1] ?? r
      const b = row[at + 2] ?? r
      if ((r + g + b) / 3 < 170) ink += 1
    }
  }
  return ink
}

function requireMac() {
  if (process.platform !== 'darwin') { console.error('probe requires macOS (WKWebView)'); process.exit(2) }
  const probe = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' })
  if (probe.status !== 0) { console.error('probe requires the Xcode command line tools (xcrun swiftc)'); process.exit(2) }
}

function runGroup(workDir, driverPath, url, mode) {
  const pngPath = join(workDir, 'shot-' + mode + '.png')
  // WKWebView writes its WebsiteData under HOME; point HOME/TMPDIR at the work dir so the
  // probe never needs write access outside it.
  mkdirSync(join(workDir, 'tmp'), { recursive: true })
  const run = spawnSync(driverPath, [url, mode, workDir, pngPath], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, HOME: workDir, CFFIXED_USER_HOME: workDir, TMPDIR: join(workDir, 'tmp') },
  })
  const output = (run.stdout ?? '') + (run.stderr ?? '')
  const match = output.match(/PROBE_JSON (.+)/)
  if (match === null) {
    console.error('probe[' + mode + '] produced no audit: ' + output.slice(-400))
    process.exit(2)
  }
  const audit = JSON.parse(match[1])
  if (audit.svgTotal === 0) { console.error('probe[' + mode + '] page has no <svg>: is the control plane up at ' + url + '?'); process.exit(2) }
  const image = decodePng(readFileSync(pngPath))
  const scale = image.width / audit.viewport[0]
  const rows = audit.panelRows.map(row => ({ ...row, ink: measureInk(image, row, scale) }))
  return { audit, rows, pngPath }
}

const options = parseArgs(process.argv.slice(2))
requireMac()
const workDir = options.out ?? mkdtempSync(join(tmpdir(), 'svg-resource-probe-'))
// 任何退出路径（含环境错误早退）都要清理自建的临时目录。
if (options.out === null) process.on('exit', () => { rmSync(workDir, { recursive: true, force: true }) })
mkdirSync(workDir, { recursive: true })
writeFileSync(join(workDir, 'scope.js'), buildScopeInjection())
writeFileSync(join(workDir, 'precheck.js'), PRECHECK)
writeFileSync(join(workDir, 'clone.js'), CLONE_SHELL)
writeFileSync(join(workDir, 'open.js'), OPEN_SETTINGS)
writeFileSync(join(workDir, 'audit.js'), AUDIT)
const driverSource = join(workDir, 'driver.swift')
writeFileSync(driverSource, DRIVER)
const driverPath = join(workDir, 'driver')
const build = spawnSync('xcrun', ['swiftc', '-O', '-o', driverPath, driverSource, '-framework', 'WebKit', '-framework', 'AppKit'], {
  encoding: 'utf8',
  timeout: 300000,
  env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(workDir, 'clang-cache'), SWIFT_MODULE_CACHE_PATH: join(workDir, 'swift-cache') },
})
if (build.status !== 0) {
  console.error('swiftc failed:\n' + ((build.stdout ?? '') + (build.stderr ?? '')).slice(-1500))
  process.exit(2)
}

const control = runGroup(workDir, driverPath, options.url, 'control')
const fix = runGroup(workDir, driverPath, options.url, 'fix')

const controlBlank = control.rows.filter(row => row.ink < INK_THRESHOLD)
// 服务页面已自带 scoper（产物已重建）时，control 组天然复现不出缺陷：判据不适用而非失败。
const controlUsable = control.audit.preScoped === 0
const fixBlank = fix.rows.filter(row => row.ink < INK_THRESHOLD)
const artifactPrewired = fix.audit.preScoped > 0
if (!controlUsable) {
  console.log('warn: 服务页面已自带 scoper（注入前已有标记 ' + control.audit.preScoped + ' 个）——control 组不适用；'
    + '交付验收应改跑 --expect-artifact 并核对 fix 组不变量。')
}
const checks = [
  ...(controlUsable
    ? [['对照组复现空白（触发序列有效）', control.audit.refIdsWithDuplicateDefs > 0 && controlBlank.length > 0]]
    : []),
  ['fix：每个 <svg> 都带 scope 标记', fix.audit.svgTotal > 0 && fix.audit.scopedSvg === fix.audit.svgTotal],
  ['fix：被引用 id 全部单定义', fix.audit.distinctRefIds > 0 && fix.audit.refIdsWithDuplicateDefs === 0],
  ['fix：设置面板每行图标都有绘制', fix.audit.panelOpened && fix.rows.length > 0 && fixBlank.length === 0],
]
if (options.expectArtifact) checks.push(['fix：服务端产物自带 scoper（注入前已有标记）', artifactPrewired])

console.log('control: svg=' + control.audit.svgTotal + ' scoped=' + control.audit.scopedSvg
  + ' 重复定义 id=' + control.audit.refIdsWithDuplicateDefs + ' 空白行=' + controlBlank.length + '/' + control.rows.length)
console.log('fix:     svg=' + fix.audit.svgTotal + ' scoped=' + fix.audit.scopedSvg
  + ' 重复定义 id=' + fix.audit.refIdsWithDuplicateDefs + ' 空白行=' + fixBlank.length + '/' + fix.rows.length)
for (const row of fix.rows) console.log('  ' + (row.ink >= INK_THRESHOLD ? 'OK  ' : 'BLANK') + ' ' + row.label.padEnd(10) + ' ink=' + row.ink)
if (!options.expectArtifact) console.log('info: 注入前已带标记的 svg = ' + fix.audit.preScoped + (artifactPrewired ? '（服务端产物已含本次修复）' : '（当前服务的是旧产物；fix 组验证的是算法本身）'))
let failed = 0
for (const [label, ok] of checks) { console.log((ok ? '✓ ' : '✗ ') + label); if (!ok) failed += 1 }
if (options.keep || options.out) console.log('artifacts: ' + workDir)
process.exit(failed === 0 ? 0 : 1)
