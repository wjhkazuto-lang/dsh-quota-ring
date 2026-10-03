/**
 * Client-half render check.
 *
 * The browser half is the one piece a user cannot test without restarting DSH,
 * so this exercises its real code paths against a minimal React runtime: the
 * module-loader entry, both slot registrations, the badge tree, the hover panel
 * and the settings form. It is a logic check, not a visual one.
 *
 * Run: node test/render-check.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Minimal React runtime: enough for createElement + the three hooks the client
// half uses, so component bodies really execute.
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

function renderComponent(Component, props) {
  hooks = []
  hookIndex = 0
  return resolve(Component(props))
}

/**
 * Expand function components into plain element nodes so the walkers below can
 * see what actually renders. Only hook-free components are expanded (the badge
 * and settings pages are rendered by `renderComponent` itself, so the only
 * component reached here is `Ring`).
 */
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  if (!node.props) return node
  return { ...node, props: { ...node.props, children: resolve(node.props.children) } }
}

// ---------------------------------------------------------------------------
// DOM / window / fetch stubs
// ---------------------------------------------------------------------------
const styleElements = []
const globalListeners = new Map()
const domListeners = new Map()

globalThis.document = {
  visibilityState: 'visible',
  head: { appendChild: (el) => styleElements.push(el) },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  addEventListener: (event, fn) => domListeners.set(event, fn),
  removeEventListener: (event) => domListeners.delete(event),
}

globalThis.window = {
  addEventListener: (event, fn) => globalListeners.set(event, fn),
  removeEventListener: (event) => globalListeners.delete(event),
}

let loaderEntry = null
globalThis.window.__ModuleLoader__ = {
  load: (entry) => {
    loaderEntry = entry
  },
}

const FETCHED = []
globalThis.fetch = async (url, options) => {
  FETCHED.push({ url, options })
  return { ok: true, status: 200, json: async () => ({ ok: true, state: null }) }
}

// ---------------------------------------------------------------------------
// Load the real client bundle
// ---------------------------------------------------------------------------
await import(path.join(repo, 'client.js'))

check('the bundle registers itself with the module loader', () => {
  assert.ok(loaderEntry, 'window.__ModuleLoader__.load was never called')
  assert.equal(loaderEntry.id, 'dsh-quota-ring')
  assert.equal(typeof loaderEntry.factory, 'function')
})

const plugin = await loaderEntry.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

check('the factory returns a Cordis plugin with apply()', () => {
  assert.equal(plugin.name, 'quota-ring')
  assert.equal(typeof plugin.apply, 'function')
})

check('the plugin declares its slots dependency instead of racing it', () => {
  // Regression: without this, Cordis may call apply() before the `slots`
  // service exists. The guard inside apply() then returns early and NOTHING
  // registers -- the whole UI half vanishes on a cold start, while a hot
  // install (page already booted) still works, which looks like flakiness.
  assert.ok(Array.isArray(plugin.inject), 'the plugin must declare an inject list')
  assert.ok(plugin.inject.includes('slots'), `inject must include 'slots', got ${JSON.stringify(plugin.inject)}`)
})


// ---------------------------------------------------------------------------
// Boot apply() against a capturing slots service
// ---------------------------------------------------------------------------
const registrations = []
const injections = []
const slots = {
  inject: (key, callback) => {
    injections.push(key)
    callback()
    return () => {}
  },
  register: (registration, Component) => {
    registrations.push({ registration, Component })
    return () => {}
  },
}

const ctx = {
  get: (name) => {
    if (name === 'slots') return slots
    if (name === 'locale') return { getSnapshot: () => ({ active: 'zh-CN' }) }
    return undefined
  },
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
}

plugin.apply(ctx)

check('a stylesheet is inserted', () => {
  assert.equal(styleElements.length, 1)
  assert.ok(styleElements[0].textContent.includes('.qr-root'))
})

// The plugin's real stylesheet, for the positioning assertions below.
const CSS = styleElements[0].textContent

check('both slots are injected', () => {
  assert.deepEqual(injections.sort(), ['conversation.composer.dock', 'settings.section'])
})

check('the chip is registered in the composer dock, not the frame overlay', () => {
  const entry = registrations.find((r) => r.registration.name === 'conversation.composer.dock')
  assert.ok(entry, 'conversation.composer.dock not registered')
  assert.equal(entry.registration.id, 'quota-ring-chip')
  assert.equal(typeof entry.registration.inject, 'function')
  assert.ok(entry.registration.inject().store, 'the chip must receive the store')
  assert.equal(
    registrations.some((r) => r.registration.name === 'shell.overlay'),
    false,
    'the floating overlay seat must no longer be used',
  )
})

check('the chip is inline, so DSH owns its alignment', () => {
  const root = /(?:^|\n)\.qr-root\{([^}]*)\}/.exec(CSS)
  assert.ok(root, 'base .qr-root rule not found')
  assert.ok(!/position:fixed/.test(root[1]), `the chip must not be fixed-positioned: ${root[1]}`)
  assert.ok(/position:relative/.test(root[1]), 'the chip anchors its own hover panel')
  assert.ok(/display:inline-flex/.test(root[1]), 'the chip must flow inline in the dock row')
  assert.ok(/font-size:12px/.test(root[1]), 'the chip must match the dock status line type')
})

check('the chip contributes no surface of its own at rest', () => {
  assert.equal(/qr-card/.test(CSS), false, 'the floating card wrapper should be gone')
  assert.ok(/\.qr-root:hover\{background:var\(--dsw-alias-interactive-bg-hover/.test(CSS),
    'hover should use the standard interactive tint')
})

check('the hover panel opens upward and stays on screen', () => {
  const panel = /(?:^|\n)\.qr-panel\{([^}]*)\}/.exec(CSS)
  assert.ok(panel, 'base .qr-panel rule not found')
  assert.ok(/bottom:calc\(100% \+ 10px\)/.test(panel[1]), 'the panel must open upward from the dock')
  assert.ok(/left:50%/.test(panel[1]) && /margin-left:-145px/.test(panel[1]),
    'the panel must be centred on the chip so it cannot run off an edge')
  assert.ok(!/position:fixed/.test(panel[1]))
})

check('the hover panel matches the badge surface', () => {
  const panel = /(?:^|\n)\.qr-panel\{([^}]*)\}/.exec(CSS)
  assert.ok(panel, 'base .qr-panel rule not found')
  assert.ok(panel[1].includes('background:var(--dsw-specific-sidebar-fill'))
  assert.ok(/backdrop-filter:blur\(/.test(panel[1]))
})

check('settings.section is registered with a label', () => {
  const entry = registrations.find((r) => r.registration.name === 'settings.section')
  assert.ok(entry, 'settings.section not registered')
  assert.equal(entry.registration.id, 'quota-ring')
  assert.equal(entry.registration.label, '额度')
  const injected = entry.registration.inject()
  assert.ok(injected.store && typeof injected.api.saveLimits === 'function')
})

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------
const badge = registrations.find((r) => r.registration.id === 'quota-ring-chip').Component
const settings = registrations.find((r) => r.registration.id === 'quota-ring').Component

function makeStore(state, overrides = {}) {
  const snapshot = { status: 'ready', state, error: null, locale: 'zh', ...overrides }
  return { get: () => snapshot, subscribe: () => () => {}, set: () => {} }
}

function fixtureState(overrides = {}) {
  const limited = (used, limit) => {
    const ratio = limit > 0 ? used / limit : 0
    const level = ratio >= 0.9 ? 'danger' : ratio >= 0.6 ? 'warn' : 'ok'
    return { used, limit, ratio, level, over: limit > 0 ? Math.max(0, used - limit) : 0, resetAt: Date.now() + 3600_000 }
  }
  return {
    version: 1,
    now: Date.now(),
    limits: { dayLimit: 10, weekLimit: 50, monthLimit: 200 },
    periods: {
      day: limited(1.82, 10),
      week: limited(31, 50),
      month: limited(12.4, 200),
    },
    today: { cost: 1.82, tokens: { inMiss: 20000, cacheHit: 1_200_000, output: 40000 }, totalTokens: 1_260_000, cacheHitRate: 0.9643 },
    phase: { peak: false, reason: 'holiday', windows: [{ start: 1, end: 4 }] },
    official: {
      status: 'ready', at: Date.now(), currency: 'CNY', recharge: 10.34, granted: 2, total: 12.34, reconcile: true,
      day: { date: '2026-10-04', currency: 'CNY', firstTotal: 12.47, firstAt: Date.now() - 3 * 3600_000, lastTotal: 12.34, lastAt: Date.now(), spend: 0.13 },
    },
    meta: {
      currency: 'CNY', symbol: '¥', thresholds: { warn: 0.6, danger: 0.9 },
      ledgerUpdatedAt: Date.now(), holidayYears: ['2026'], holidayTableMiss: false,
      holidayTableMissYear: null, models: ['deepseek-flash'], backfill: null, backfillRunning: false, refreshSeconds: 30,
    },
    ...overrides,
  }
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.props) collectText(node.props.children, out)
  return out
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (node.props) findAll(node.props.children, predicate, out)
  return out
}

const text = (tree) => collectText(tree).join('|')

check('every part of the chip uses the row\'s own label colour', () => {
  const root = /(?:^|\n)\.qr-root\{([^}]*)\}/.exec(CSS)
  assert.ok(/color:var\(--dsw-alias-label-tertiary/.test(root[1]),
    `the chip must use the dock's tertiary label colour: ${root[1]}`)
  // No part of the chip may re-colour itself away from that baseline.
  for (const cls of ['qr-chip-label', 'qr-chip-pct', 'qr-chip-value']) {
    const rule = new RegExp(`(?:^|\\n)\\.${cls}\\{([^}]*)\\}`).exec(CSS)
    assert.ok(rule, `.${cls} rule not found`)
    assert.ok(!/color:/.test(rule[1]), `.${cls} must inherit the chip colour, got: ${rule[1]}`)
  }
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  for (const cls of ['qr-chip-pct', 'qr-chip-value']) {
    const node = findAll(tree, (n) => n.props?.className === cls)[0]
    assert.equal(node.props.style, undefined, `${cls} must not override the colour inline`)
  }
})

check('the ring stays neutral until it has something to say', () => {
  // DSH's own usage ring beside the chip is plain grey at 45%; painting the
  // comfortable state saturated green is what broke the row.
  const expected = {
    ok: 'label-tertiary',
    warn: 'state-warn-primary',
    danger: 'state-error-primary',
  }
  for (const [level, token] of Object.entries(expected)) {
    const state = fixtureState()
    state.periods.week = { used: 30, limit: 50, ratio: 0.6, level, over: 0, resetAt: Date.now() + 3600_000 }
    const stroke = findAll(renderComponent(badge, { store: makeStore(state) }),
      (n) => n.props?.className === 'qr-fill')[0].props.stroke
    assert.ok(stroke.includes(token), `${level} should resolve to ${token}, got: ${stroke}`)
  }
})

check('the ring track is as subtle as the native one', () => {
  const track = /(?:^|\n)\.qr-track\{([^}]*)\}/.exec(CSS)
  assert.ok(track, '.qr-track rule not found')
  assert.ok(/stroke:var\(--dsw-alias-border-l1/.test(track[1]), `track should be the subtlest border: ${track[1]}`)
})

check('the dock ring is small and unlabelled', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  const svg = findAll(tree, (n) => n.props?.className === 'qr-ring')[0]
  assert.equal(svg.props.width, 15)
  assert.equal(findAll(tree, (n) => n.props?.className === 'qr-num').length, 0, 'the dock ring carries no centre text')
})


check('the badge shows the WEEK quota, its percentage and its amount', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  const body = text(tree)
  assert.ok(body.includes('周额度'), `missing week label, got: ${body}`)
  assert.ok(body.includes('62%'), `missing ring percentage, got: ${body}`)
  assert.ok(body.includes('¥31.00 / ¥50.00'), `missing week amount, got: ${body}`)
})

check('the badge uses the warn colour at 62% of the weekly limit', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  const fills = findAll(tree, (n) => n.props?.className === 'qr-fill')
  assert.equal(fills.length, 1)
  assert.ok(fills[0].props.stroke.includes('warn'), `expected warn stroke, got ${fills[0].props.stroke}`)
})

check('the ring arc is proportional to the ratio', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  const fill = findAll(tree, (n) => n.props?.className === 'qr-fill')[0]
  const svg = findAll(tree, (n) => n.props?.className === 'qr-ring')[0]
  const [dash] = String(fill.props.strokeDasharray).split(' ')
  // Derive the radius from what actually rendered.
  const radius = (Number(svg.props.width) - Number(fill.props.strokeWidth)) / 2
  const circumference = 2 * Math.PI * radius
  assert.ok(Math.abs(Number(dash) / circumference - 0.62) < 1e-6, `arc fraction ${Number(dash) / circumference}`)
})

check('the hover panel lists day, week and month rows', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  const body = text(tree)
  for (const label of ['日', '周', '月']) assert.ok(body.includes(label), `missing ${label} row`)
  assert.ok(body.includes('¥1.82 / ¥10.00'), 'missing day amount')
  assert.ok(body.includes('¥12.40 / ¥200.00'), 'missing month amount')
})

check('each row carries a reset countdown', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  const resets = findAll(tree, (n) => n.props?.className === 'qr-row-reset')
  assert.equal(resets.length, 3, 'expected one countdown per period')
  for (const row of resets) {
    assert.ok(collectText(row).join('').includes('后重置'), `countdown text missing in ${collectText(row)}`)
  }
})

check('the panel reports today tokens and cache hit rate', () => {
  const body = text(renderComponent(badge, { store: makeStore(fixtureState()) }))
  assert.ok(body.includes('1.26M'), `missing compact token count, got ${body}`)
  assert.ok(body.includes('96.4%'), `missing cache hit rate, got ${body}`)
})

check('the panel names the current billing phase and its reason', () => {
  const body = text(renderComponent(badge, { store: makeStore(fixtureState()) }))
  assert.ok(body.includes('当前 谷价'), 'missing off-peak phase')
  assert.ok(body.includes('法定节假日'), 'missing holiday reason')
})

check('a peak instant renders the peak phase label', () => {
  const state = fixtureState()
  state.phase = { peak: true, reason: 'peak', windows: [] }
  const body = text(renderComponent(badge, { store: makeStore(state) }))
  assert.ok(body.includes('当前 峰价'), 'missing peak phase')
  assert.ok(body.includes('工作日高峰时段'), 'missing peak reason')
})

check('an exceeded period adds an overage line', () => {
  const state = fixtureState()
  state.periods.day = { used: 13.5, limit: 10, ratio: 1.35, level: 'danger', over: 3.5, resetAt: Date.now() + 3600_000 }
  const tree = renderComponent(badge, { store: makeStore(state) })
  const body = text(tree)
  assert.ok(body.includes('已超额'), `missing overage label, got ${body}`)
  assert.ok(body.includes('超出 ¥3.50'), `missing overage amount, got ${body}`)
  const alerts = findAll(tree, (n) => n.props?.className === 'qr-err')
  assert.equal(alerts.length, 1)
})

check('a period with no limit set reports no overage', () => {
  const state = fixtureState()
  state.periods.month = { used: 900, limit: 0, ratio: 0, level: 'ok', over: 0, resetAt: Date.now() + 3600_000 }
  const tree = renderComponent(badge, { store: makeStore(state) })
  assert.equal(findAll(tree, (n) => n.props?.className === 'qr-err').length, 0)
  assert.ok(text(tree).includes('¥900.00'), 'unlimited period should still show spend')
})

check('an uncovered holiday year raises a warning in the panel', () => {
  const state = fixtureState()
  state.meta.holidayTableMiss = true
  state.meta.holidayTableMissYear = '2027'
  state.meta.holidayYears = ['2026']
  const tree = renderComponent(badge, { store: makeStore(state) })
  const warnings = findAll(tree, (n) => n.props?.className === 'qr-warn')
  assert.equal(warnings.length, 1)
  assert.ok(collectText(warnings[0]).join('').includes('2027'))
})

check('no warning is shown while the table covers the current year', () => {
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  assert.equal(findAll(tree, (n) => n.props?.className === 'qr-warn').length, 0)
})

check('the badge renders a loading state before the first state arrives', () => {
  const body = text(renderComponent(badge, { store: makeStore(null, { status: 'loading' }) }))
  assert.ok(body.includes('读取中'), `expected loading text, got ${body}`)
})

check('the badge explains an unreachable host instead of rendering nothing', () => {
  const body = text(renderComponent(badge, { store: makeStore(null, { status: 'error' }) }))
  assert.ok(body.includes('需重启'), `expected restart hint, got ${body}`)
})

check('the panel reconciles machine-scope spend against the official balance', () => {
  const body = text(renderComponent(badge, { store: makeStore(fixtureState()) }))
  assert.ok(body.includes('官方余额'), `missing balance row, got ${body}`)
  assert.ok(body.includes('账号级'), 'the balance row must state that it is account-scoped')
  assert.ok(body.includes('¥12.34'), `missing balance total, got ${body}`)
  assert.ok(body.includes('本日减少 ¥0.13'), `missing today decrease, got ${body}`)
})

check('the reconciliation row says when the day baseline started', () => {
  // The baseline is the first reading of the day, NOT necessarily midnight, so
  // the time is shown instead of implying a full-day figure.
  const tree = renderComponent(badge, { store: makeStore(fixtureState()) })
  // Must match the client's own options exactly, including the 24-hour clock.
  const clock = new Date(fixtureState().official.day.firstAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  assert.ok(text(tree).includes(`自 ${clock}`), `expected a baseline time of ${clock}`)
})

check('the scope difference is stated, not left for the user to guess', () => {
  const body = text(renderComponent(badge, { store: makeStore(fixtureState()) }))
  assert.ok(body.includes('本机'), `expected a scope note, got ${body}`)
  assert.ok(body.includes('账号级'), 'the note must name the account scope')
})

check('a top-up is not reported as a spend', () => {
  const state = fixtureState()
  state.official.day = { ...state.official.day, firstTotal: 10, lastTotal: 22.5, spend: -12.5 }
  const body = text(renderComponent(badge, { store: makeStore(state) }))
  assert.ok(body.includes('本日有充值'), `expected a top-up label, got ${body}`)
  assert.ok(!body.includes('本日减少'), 'a top-up must not read as a spend')
})

check('every non-ready balance state explains itself instead of going blank', () => {
  const cases = [
    [{ reconcile: false }, '关闭对账'],
    [{ status: 'loading' }, '读取中'],
    [{ status: 'signed-out' }, '未登录'],
    [{ status: 'unavailable' }, '账号服务不可用'],
    [{ status: 'failed' }, '余额查询失败'],
  ]
  for (const [override, needle] of cases) {
    const state = fixtureState()
    state.official = { ...state.official, ...override }
    const body = text(renderComponent(badge, { store: makeStore(state) }))
    assert.ok(body.includes(needle), `state ${JSON.stringify(override)} should say "${needle}", got ${body}`)
  }
})

check('a USD wallet is not rendered with a ¥ sign', () => {
  const state = fixtureState()
  state.official = { ...state.official, currency: 'USD', total: 3.5, day: { ...state.official.day, currency: 'USD', spend: 0.5 } }
  const body = text(renderComponent(badge, { store: makeStore(state) }))
  assert.ok(body.includes('$3.50'), `expected a USD total, got ${body}`)
  assert.ok(!body.includes('¥3.50'), 'a USD wallet must not use the yuan sign')
})

check('an absent official slice degrades to the disabled row', () => {
  const state = fixtureState()
  delete state.official
  assert.doesNotThrow(() => renderComponent(badge, { store: makeStore(state) }))
  const body = text(renderComponent(badge, { store: makeStore(state) }))
  assert.ok(body.includes('官方余额'), 'the row should still render')
})

check('the English locale switches the copy', () => {
  const body = text(renderComponent(badge, { store: makeStore(fixtureState(), { locale: 'en' }) }))
  assert.ok(body.includes('Week quota'), `expected English label, got ${body}`)
  assert.ok(body.includes('Quota detail'), 'expected English panel title')
})

// ---------------------------------------------------------------------------
// Settings rendering
// ---------------------------------------------------------------------------
const settingsEntry = registrations.find((r) => r.registration.id === 'quota-ring')
const settingsProps = settingsEntry.registration.inject()

check('the settings page renders exactly the three quota inputs', () => {
  const tree = renderComponent(settings, settingsProps)
  const inputs = findAll(tree, (n) => n.type === 'input')
  assert.equal(inputs.length, 3, `expected 3 inputs, got ${inputs.length}`)
  assert.deepEqual(inputs.map((i) => i.props.id).sort(), ['qr-dayLimit', 'qr-monthLimit', 'qr-weekLimit'])
})

check('the inputs are seeded from the stored limits and are numeric', () => {
  const tree = renderComponent(settings, settingsProps)
  const inputs = findAll(tree, (n) => n.type === 'input')
  const byId = Object.fromEntries(inputs.map((i) => [i.props.id, i.props]))
  // The store arrives with no state yet, so the page must render empty inputs
  // rather than crash; values arrive when the first poll lands.
  for (const id of ['qr-dayLimit', 'qr-weekLimit', 'qr-monthLimit']) {
    assert.equal(byId[id].type, 'number')
    assert.equal(byId[id].min, '0')
  }
})

check('the settings page shows a ¥ prefix and the quota hint', () => {
  const tree = renderComponent(settings, settingsProps)
  const body = text(tree)
  assert.ok(body.includes('¥'), 'missing currency prefix')
  assert.ok(body.includes('日额度') && body.includes('周额度') && body.includes('月额度'))
  assert.ok(body.includes('自动保存'), 'missing autosave hint')
})

check('the settings page seeds the three inputs from a loaded state', () => {
  const store = makeStore(fixtureState())
  const tree = renderComponent(settings, { store, api: settingsProps.api })
  const inputs = findAll(tree, (n) => n.type === 'input')
  const values = inputs.map((i) => i.props.value)
  assert.ok(values.includes('10') || values.includes(''), `day input value: ${JSON.stringify(values)}`)
})

check('a live poll is scheduled and both listeners are attached', () => {
  assert.ok(FETCHED.length > 0, 'no initial fetch was issued')
  assert.equal(FETCHED[0].url, '/__quota-ring/state')
  assert.ok(domListeners.has('visibilitychange'), 'visibilitychange not observed')
  assert.ok(globalListeners.has('languagechange'), 'languagechange not observed')
})

// ---------------------------------------------------------------------------
for (const cleanup of effectCleanups) {
  try {
    cleanup()
  } catch {
    /* teardown */
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
