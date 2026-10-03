/**
 * Renders the REAL client half to a static HTML preview.
 *
 * The browser half cannot be seen until DSH restarts, so this loads client.js
 * through the same module-loader stub the render check uses, renders the actual
 * badge (collapsed and hover-open) and the actual settings page, and serialises
 * them against the plugin's own stylesheet and DSH's theme tokens.
 *
 * The output is a preview of real component output, not a screenshot of the
 * running plugin — hover state and live data are simulated.
 *
 * Run: node test/preview.mjs   ->  test/preview.html
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')

// ---------------------------------------------------------------------------
// Same minimal React runtime as the render check.
// ---------------------------------------------------------------------------
let hooks = []
let hookIndex = 0
const effectCleanups = []
const React = {
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: flat } }
  },
  useState(initial) {
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    const setState = (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }
    return [hooks[index], setState]
  },
  useEffect(effect) {
    // Run effects so the settings page really seeds its inputs, exactly as the
    // render check does.
    const index = hookIndex++
    if (index in hooks) return
    hooks[index] = true
    const cleanup = effect()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  },
  useRef(initial) {
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = { current: initial }
    return hooks[index]
  },
}

function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  if (!node.props) return node
  return { ...node, props: { ...node.props, children: resolve(node.props.children) } }
}

function render(Component, props) {
  hooks = []
  hookIndex = 0
  let tree = resolve(Component(props))
  // Re-render until state set inside an effect has propagated, the way a real
  // React commit would. Effects are guarded by hook slot, so they only run once.
  for (let pass = 0; pass < 4; pass += 1) {
    hookIndex = 0
    tree = resolve(Component(props))
  }
  return tree
}

// ---------------------------------------------------------------------------
// DOM / loader stubs (only to capture the stylesheet and the components)
// ---------------------------------------------------------------------------
const styleElements = []
globalThis.document = {
  visibilityState: 'visible',
  head: { appendChild: (el) => styleElements.push(el) },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load: (entry) => (globalThis.window.__entry = entry) },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: null }) })

await import(path.join(repo, 'client.js'))
const plugin = await globalThis.window.__entry.factory((name) => (name === 'react' ? React : undefined))

const registrations = []
plugin.apply({
  get: (name) => {
    if (name === 'slots')
      return {
        inject: (key, cb) => {
          cb()
          return () => {}
        },
        register: (registration, Component) => {
          registrations.push({ registration, Component })
          return () => {}
        },
      }
    if (name === 'locale') return { getSnapshot: () => ({ active: 'zh-CN' }) }
    return undefined
  },
  effect: (fn) => {
    fn()
    return () => {}
  },
})

const CSS = styleElements[0].textContent
const badge = registrations.find((r) => r.registration.id === 'quota-ring-chip').Component
const settings = registrations.find((r) => r.registration.id === 'quota-ring').Component
const settingsProps = registrations.find((r) => r.registration.id === 'quota-ring').registration.inject()

// ---------------------------------------------------------------------------
// Fixture state: a mid-week afternoon, holiday-tagged, with the week at 62%.
// ---------------------------------------------------------------------------
const now = Date.now()
function period(used, limit, resetInMs) {
  const ratio = limit > 0 ? used / limit : 0
  return {
    used,
    limit,
    ratio,
    level: ratio >= 0.9 ? 'danger' : ratio >= 0.6 ? 'warn' : 'ok',
    over: limit > 0 ? Math.max(0, used - limit) : 0,
    resetAt: now + resetInMs,
  }
}

const state = {
  version: 1,
  now,
  limits: { dayLimit: 10, weekLimit: 50, monthLimit: 200 },
  periods: {
    day: period(1.82, 10, 6 * 3600_000 + 7 * 60_000),
    week: period(31.0, 50, 2 * 86400_000 + 11 * 3600_000),
    month: period(12.4, 200, 27 * 86400_000),
  },
  today: {
    cost: 1.82,
    tokens: { inMiss: 208_000, cacheHit: 31_040_000, output: 142_000 },
    totalTokens: 31_390_000,
    cacheHitRate: 0.989,
  },
  phase: { peak: false, reason: 'holiday', windows: [{ start: 1, end: 4 }, { start: 6, end: 10 }] },
  official: {
    status: 'ready', at: now, currency: 'CNY', recharge: 9.21, granted: 3.13, total: 12.34, reconcile: true,
    day: { date: '2026-10-04', currency: 'CNY', firstTotal: 12.47, firstAt: now - 3 * 3600_000, lastTotal: 12.34, lastAt: now, spend: 0.13 },
  },
  meta: {
    currency: 'CNY',
    symbol: '¥',
    thresholds: { warn: 0.6, danger: 0.9 },
    ledgerUpdatedAt: now,
    holidayYears: ['2026'],
    holidayTableMiss: false,
    holidayTableMissYear: null,
    models: ['deepseek-flash'],
    backfill: { at: now, durationMs: 75, filesScanned: 3, filesSkipped: 0, requestsFolded: 363, since: now - 35 * 86400_000 },
    backfillRunning: false,
    refreshSeconds: 30,
  },
}

function store(stateValue) {
  const snapshot = { status: 'ready', state: stateValue, error: null, locale: 'zh' }
  return { get: () => snapshot, subscribe: () => () => {}, set: () => {} }
}

// ---------------------------------------------------------------------------
// Element tree -> HTML
// ---------------------------------------------------------------------------
const VOID_TAGS = new Set(['input', 'circle', 'br', 'hr', 'img', 'path', 'meta'])
const ATTR_NAMES = {
  className: 'class',
  htmlFor: 'for',
  strokeWidth: 'stroke-width',
  strokeDasharray: 'stroke-dasharray',
  strokeLinecap: 'stroke-linecap',
  textAnchor: 'text-anchor',
  dominantBaseline: 'dominant-baseline',
  inputMode: 'inputmode',
  'aria-hidden': 'aria-hidden',
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function styleToCss(style) {
  return Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';')
}

function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (!node || typeof node !== 'object') return ''

  const { type, props = {} } = node
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || value === undefined || value === null || value === false) continue
    if (key === 'style' && typeof value === 'object') {
      attrs.push(`style="${escapeHtml(styleToCss(value))}"`)
      continue
    }
    if (value === true) {
      attrs.push(ATTR_NAMES[key] ?? key)
      continue
    }
    attrs.push(`${ATTR_NAMES[key] ?? key}="${escapeHtml(value)}"`)
  }
  const open = `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
  // SVG child elements MUST be self-closed. Inside <svg> the HTML parser uses
  // foreign-content rules, so a bare <circle> would swallow every following
  // sibling as a child and the arc and label would never render.
  if (VOID_TAGS.has(type)) return `${open.slice(0, -1)} />`
  return `${open}${toHtml(props.children)}</${type}>`
}

// ---------------------------------------------------------------------------
// Compose the page
// ---------------------------------------------------------------------------
function panel({ theme, title, badgeTree, settingsTree }) {
  const tokens =
    theme === 'light'
      ? `--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f5f6f8;--dsw-alias-bg-overlay:#ffffff;
         --dsw-alias-border-l1:rgba(0,0,0,.08);--dsw-alias-border-l2:rgba(0,0,0,.16);
         --dsw-alias-label-primary:#1a1a1c;--dsw-alias-label-secondary:#6b7280;
         --dsw-alias-state-success-primary:#16a34a;--dsw-alias-state-warn-primary:#d97706;
         --dsw-alias-state-error-primary:#dc2626;--dsw-alias-state-idle-primary:#9aa0a6;
         --dsw-alias-brand-primary:#3b82f6;`
      : `--dsw-alias-bg-base:#17171a;--dsw-alias-bg-layer-1:#212125;--dsw-alias-bg-layer-2:#2a2a2f;--dsw-alias-bg-overlay:#26262b;
         --dsw-alias-border-l1:rgba(255,255,255,.10);--dsw-alias-border-l2:rgba(255,255,255,.20);
         --dsw-alias-label-primary:#f2f2f4;--dsw-alias-label-secondary:#a1a1aa;
         --dsw-alias-state-success-primary:#4ade80;--dsw-alias-state-warn-primary:#fbbf24;
         --dsw-alias-state-error-primary:#f87171;--dsw-alias-state-idle-primary:#71717a;
         --dsw-alias-brand-primary:#60a5fa;`

  // The popover grows upward from the dock, so the open variant gets a stage
  // tall enough to contain it; otherwise it spills across neighbouring sections.
  const dock = (open) => `
      <div class="dock-stage ${open ? 'tall' : ''}">
        <div class="dock ${open ? 'open' : ''}">
          ${toHtml(badgeTree)}
          <span class="dock-native">45.4M tok · 缓存命中 98%</span>
          <span class="dock-native">35%</span>
        </div>
      </div>`

  return `
  <section class="panel ${theme}" style="${tokens}">
    <h2>${title}</h2>
    <div class="mock-composer">
      <div class="mock-input">发消息或创建任务，/ 调用指令，@ 文件或对话</div>
      <div class="mock-toolbar"><span>+</span><span class="mock-pill">工作区内修改</span><span class="mock-model">DeepSeek-V41-Flash High</span><span class="mock-send">↑</span></div>
    </div>
    <div class="slot">
      <span class="slot-label">输入框下方状态行（真实位置 · 收起态）</span>
      ${dock(false)}
    </div>
    <div class="slot">
      <span class="slot-label">悬停展开（预览中强制打开）</span>
      ${dock(true)}
    </div>
    <div class="slot">
      <span class="slot-label">设置 → 额度</span>
      <div class="settings-box">${toHtml(settingsTree)}</div>
    </div>
  </section>`
}

const collapsed = render(badge, { store: store(state) })
const settingsTree = render(settings, { ...settingsProps, store: store(state) })

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-quota-ring 预览</title>
<style>
  ${CSS}
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:#0c0c0e; color:#e7e7ea;
         font-family:-apple-system,"SF Pro Text","PingFang SC",system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  .sub { font-size:12px; color:#8b8b93; margin-bottom:22px; line-height:1.7; }
  .panels { display:flex; flex-direction:column; gap:18px; }
  .panel h2 { font-size:13px; margin:0 0 14px; font-weight:600; color:var(--dsw-alias-label-secondary); letter-spacing:.03em; }
  .slot { display:flex; flex-direction:column; gap:8px; margin-top:16px; }
  .slot-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
  /* A stand-in for the real composer card, so the dock chip is shown where it lives. */
  .mock-composer { border-radius:14px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); padding:12px 14px; }
  .mock-input { font-size:13px; color:var(--dsw-alias-label-secondary); opacity:.75; padding-bottom:14px; }
  .mock-toolbar { display:flex; align-items:center; gap:10px; font-size:12px; color:var(--dsw-alias-label-secondary); }
  .mock-pill { padding:1px 8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); }
  .mock-model { margin-left:auto; }
  .mock-send { width:22px; height:22px; border-radius:50%; background:var(--dsw-alias-brand-primary); color:#fff;
               display:grid; place-items:center; font-size:12px; }
  /* The dock row, styled like DSH's status line so alignment is visible. */
  .dock-stage { display:flex; align-items:flex-end; }
  .dock-stage.tall { height:372px; }
  .dock { position:relative; display:flex; align-items:center; justify-content:center; gap:14px; width:100%;
          font-size:12px; line-height:20px; color:var(--dsw-alias-label-secondary);
          padding:6px 10px; border-radius:8px; border:1px dashed var(--dsw-alias-border-l1); }
  .dock-native { white-space:nowrap; }
  /* Force the hover panel open for the preview. */
  .dock.open .qr-panel { opacity:1; transform:none; pointer-events:auto; }
  .settings-box { border-radius:12px; background:var(--dsw-alias-bg-layer-2); border:1px dashed var(--dsw-alias-border-l1); padding:16px; }
  .settings-box .qr-settings { max-width:none; }
  .settings-box .qr-input { background:var(--dsw-alias-bg-base); }
</style>
</head>
<body>
  <h1>dsh-quota-ring · 界面预览</h1>
  <p class="sub">
    由 <code>test/preview.mjs</code> 用真实的 <code>client.js</code> 组件渲染，配插件自身的样式表与 DSH 主题 token。<br>
    数据为模拟值（周额度 ¥31.00 / ¥50.00 = 62%，节假日 → 谷价）。位置不再是浮层，而是注册进 <code>conversation.composer.dock</code>，<br>
    与原生「缓存命中 98% · 35%」同一行，对齐与字型由 DSH 接管；芯片本身不带底色，仅悬停时按原生 interactive-bg-hover 着色。<br>
    悬停态在预览中强制展开（真实为向上弹出）；非真实运行截图。
  </p>
  <div class="panels">
    ${panel({ theme: 'light', title: '浅色主题', badgeTree: collapsed, settingsTree })}
    ${panel({ theme: 'dark', title: '深色主题', badgeTree: collapsed, settingsTree })}
  </div>
</body>
</html>`

const out = path.join(here, 'preview.html')
fs.writeFileSync(out, html)
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`)

// The plugin schedules a poll timer, which would keep the loop alive forever.
process.exit(0)
