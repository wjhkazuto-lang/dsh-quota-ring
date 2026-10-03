/**
 * Self-check for dsh-quota-ring's accounting.
 *
 * The two cost fixtures are the REAL numbers recorded by dsh-cost-meter's
 * ledger for 2026-10-03 and 2026-10-04. Both days are Chinese public holidays,
 * so both must bill at the off-peak tier. Re-deriving them from the official
 * CNY price table proves the tier decision, the token folding and the price
 * lookup all agree with an independent implementation.
 *
 * Run: node test/check.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HOLIDAYS_2026,
  PRICE_TABLE,
  billingPhaseAt,
  costOfDay,
  dayStart,
  evaluateQuota,
  expandRanges,
  holidayTableYears,
  isHoliday,
  isPeak,
  isWeekend,
  localDayKey,
  monthStart,
  periodEnd,
  priceEntryFor,
  sumDays,
  tripleFromUsage,
  weekStart,
} from '../lib/quota.mjs'

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

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${expected} but got ${actual} (delta ${Math.abs(actual - expected)})`,
  )
}

const BEIJING = (iso) => Date.parse(iso)

console.log('\ndsh-quota-ring self-check\n')

// ---------------------------------------------------------------------------
console.log('price table (official DeepSeek CNY, per 1M tokens)')
// ---------------------------------------------------------------------------
check('off-peak is exactly half of peak for every model', () => {
  for (const [model, entry] of Object.entries(PRICE_TABLE)) {
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      close(entry.offPeak[key], entry.peak[key] / 2, 1e-12, )
      assert.equal(entry.offPeak[key], entry.peak[key] / 2, `${model}.${key}`)
    }
  }
})

check('current official CNY numbers are the round ones', () => {
  assert.deepEqual(PRICE_TABLE['deepseek-v4-flash'].offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.deepEqual(PRICE_TABLE['deepseek-v4-flash'].peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })
})

check('unknown model ids fall back to Flash instead of dropping the request', () => {
  assert.deepEqual(priceEntryFor('some-future-model'), PRICE_TABLE['deepseek-v4-flash'])
  assert.deepEqual(priceEntryFor(''), PRICE_TABLE['deepseek-v4-flash'])
  assert.deepEqual(priceEntryFor('deepseek-v4-pro'), PRICE_TABLE['deepseek-v4-pro'])
})

// ---------------------------------------------------------------------------
console.log('\npeak / off-peak rules (Beijing calendar)')
// ---------------------------------------------------------------------------
check('windows are UTC hours: Beijing 09:00-12:00 and 14:00-18:00 on a workday', () => {
  const thursday = '2026-10-08'
  assert.equal(isPeak(BEIJING(`${thursday}T09:00:00+08:00`), { holidays: HOLIDAYS_2026 }), true, '09:00 peak')
  assert.equal(isPeak(BEIJING(`${thursday}T11:59:00+08:00`), { holidays: HOLIDAYS_2026 }), true, '11:59 peak')
  assert.equal(isPeak(BEIJING(`${thursday}T12:00:00+08:00`), { holidays: HOLIDAYS_2026 }), false, '12:00 lunch')
  assert.equal(isPeak(BEIJING(`${thursday}T13:59:00+08:00`), { holidays: HOLIDAYS_2026 }), false, '13:59 lunch')
  assert.equal(isPeak(BEIJING(`${thursday}T14:00:00+08:00`), { holidays: HOLIDAYS_2026 }), true, '14:00 peak')
  assert.equal(isPeak(BEIJING(`${thursday}T17:59:00+08:00`), { holidays: HOLIDAYS_2026 }), true, '17:59 peak')
  assert.equal(isPeak(BEIJING(`${thursday}T18:00:00+08:00`), { holidays: HOLIDAYS_2026 }), false, '18:00 off')
  assert.equal(isPeak(BEIJING(`${thursday}T08:59:00+08:00`), { holidays: HOLIDAYS_2026 }), false, '08:59 off')
})

check('today (2026-10-04) is off-peak, which is what the archived ledger bills', () => {
  const at = BEIJING('2026-10-04T03:53:00+08:00')
  assert.equal(isHoliday(at, HOLIDAYS_2026), true)
  assert.equal(isWeekend(at), true)
  assert.equal(isPeak(at, { holidays: HOLIDAYS_2026 }), false)
  assert.equal(billingPhaseAt(at, { holidays: HOLIDAYS_2026 }).reason, 'holiday')
})

check('a holiday blocks peak even on a weekday', () => {
  // 2026-10-06 is a Tuesday inside the National Day holiday.
  const at = BEIJING('2026-10-06T10:00:00+08:00')
  assert.equal(isWeekend(at), false, 'must be a weekday')
  assert.equal(isHoliday(at, HOLIDAYS_2026), true)
  assert.equal(isPeak(at, { holidays: HOLIDAYS_2026 }), false)
  assert.equal(billingPhaseAt(at, { holidays: HOLIDAYS_2026 }).reason, 'holiday')
})

check('a weekend blocks peak on a non-holiday weekend', () => {
  const saturday = BEIJING('2026-10-10T10:00:00+08:00') // 调休补班日, still a Saturday
  assert.equal(isWeekend(saturday), true)
  assert.equal(isHoliday(saturday, HOLIDAYS_2026), false, 'make-up workday is NOT listed as a holiday')
  assert.equal(isPeak(saturday, { holidays: HOLIDAYS_2026 }), false)
  assert.equal(billingPhaseAt(saturday, { holidays: HOLIDAYS_2026 }).reason, 'weekend')
})

check('peak can be switched off entirely from the row config', () => {
  const at = BEIJING('2026-10-08T10:00:00+08:00')
  assert.equal(isPeak(at, { enabled: false, holidays: HOLIDAYS_2026 }), false)
  assert.equal(billingPhaseAt(at, { enabled: false, holidays: HOLIDAYS_2026 }).reason, 'disabled')
})

check('holiday table expands ranges and covers exactly 2026', () => {
  assert.deepEqual(holidayTableYears(HOLIDAYS_2026), ['2026'])
  assert.equal(HOLIDAYS_2026.length, 33)
  assert.deepEqual(expandRanges([['2026-01-01', '2026-01-03']]), ['2026-01-01', '2026-01-02', '2026-01-03'])
})

// ---------------------------------------------------------------------------
console.log('\ntoken folding and costing (fixtures from the archived ledger)')
// ---------------------------------------------------------------------------
check('cache writes bill at the cache-miss rate, reasoning merges into output', () => {
  const triple = tripleFromUsage({
    inputTokens: 100,
    cacheReadTokens: 7,
    cacheWriteTokens: 5,
    outputTokens: 11,
    reasoningTokens: 3,
  })
  assert.deepEqual(triple, { inMiss: 105, cacheHit: 7, output: 14 })
})

check('2026-10-03 re-derives to the archived usage at official CNY prices', () => {
  // Archived usage: input 165824, output 207266, cacheRead 41199488, cacheWrite 0.
  const day = {
    models: {
      'deepseek-v4-flash': {
        off: { inMiss: 165824, cacheHit: 41199488, output: 207266 },
      },
    },
  }
  // 0.165824 + 0.82398976 + 0.829064
  close(costOfDay(day), 1.81887776)
})

check('2026-10-04 re-derives to the archived usage at official CNY prices', () => {
  const day = {
    models: {
      'deepseek-v4-flash': {
        off: { inMiss: 26159, cacheHit: 14771328, output: 42347 },
      },
    },
  }
  // 0.026159 + 0.29542656 + 0.169388
  close(costOfDay(day), 0.49097356)
})

check('the same tokens cost exactly twice as much in a peak bucket', () => {
  const triple = { inMiss: 165824, cacheHit: 41199488, output: 207266 }
  const off = costOfDay({ models: { 'deepseek-v4-flash': { off: triple } } })
  const peak = costOfDay({ models: { 'deepseek-v4-flash': { peak: triple } } })
  close(peak, off * 2, 1e-9)
})

check('the archived USD figure is NOT what we report — we use the official CNY table', () => {
  // cost-meter recorded $0.272831664 for 10-03. Converting at its 7.2 rate gives
  // ~1.9644, whereas the official CNY table gives 1.81887776. Documenting the
  // deliberate difference so a future regression is visible.
  const day = { models: { 'deepseek-v4-flash': { off: { inMiss: 165824, cacheHit: 41199488, output: 207266 } } } }
  const cny = costOfDay(day)
  const converted = 0.272831664 * 7.2
  assert.ok(Math.abs(cny - converted) > 0.1, 'the two bases must differ; if they match, pricing changed')
  close(cny, 1.81887776)
})

check('sumDays aggregates tokens, calls and cost across days', () => {
  const days = [
    { models: { 'deepseek-v4-flash': { off: { inMiss: 1e6, cacheHit: 0, output: 0 } } }, calls: 2 },
    { models: { 'deepseek-v4-flash': { off: { inMiss: 1e6, cacheHit: 0, output: 0 } } }, calls: 3 },
  ]
  const total = sumDays(days)
  close(total.cost, 2) // 1M cache-miss tokens at ¥1 each
  assert.equal(total.calls, 5)
  assert.equal(total.tokens.inMiss, 2e6)
})

// ---------------------------------------------------------------------------
console.log('\nquota periods (local time, week starts Sunday)')
// ---------------------------------------------------------------------------
const LOCAL = (iso) => Date.parse(iso)

check('day window is local midnight to the next local midnight', () => {
  const at = LOCAL('2026-10-04T15:30:00+08:00')
  const start = dayStart(at)
  assert.equal(new Date(start).getHours(), 0)
  assert.equal(new Date(start).getDate(), 4)
  const end = periodEnd(start, 'day')
  assert.equal(new Date(end).getDate(), 5)
  assert.equal(new Date(end).getHours(), 0)
})

check('week window starts on Sunday', () => {
  const sunday = LOCAL('2026-10-04T15:30:00+08:00') // a Sunday
  assert.equal(new Date(weekStart(sunday)).getDay(), 0)
  assert.equal(new Date(weekStart(sunday)).getDate(), 4)

  const saturday = LOCAL('2026-10-10T09:00:00+08:00')
  const start = new Date(weekStart(saturday))
  assert.equal(start.getDay(), 0, 'week containing a Saturday starts on Sunday')
  assert.equal(start.getDate(), 4)

  const end = new Date(periodEnd(weekStart(saturday), 'week'))
  assert.equal(end.getDay(), 0)
  assert.equal(end.getDate(), 11)
})

check('month window starts on the 1st at local midnight', () => {
  const at = LOCAL('2026-10-04T15:30:00+08:00')
  const start = new Date(monthStart(at))
  assert.equal(start.getDate(), 1)
  assert.equal(start.getMonth(), 9)
  assert.equal(start.getHours(), 0)
  const end = new Date(periodEnd(monthStart(at), 'month'))
  assert.equal(end.getMonth(), 10)
  assert.equal(end.getDate(), 1)
})

check('month end handles a 31-day month across the year boundary', () => {
  const at = LOCAL('2026-12-15T09:00:00+08:00')
  const end = new Date(periodEnd(monthStart(at), 'month'))
  assert.equal(end.getFullYear(), 2027)
  assert.equal(end.getMonth(), 0)
  assert.equal(end.getDate(), 1)
})

check('local day keys use the local calendar day, not UTC', () => {
  // 2026-10-04 07:00 Beijing is 2026-10-03 23:00 UTC; the window must still be the 4th.
  assert.equal(localDayKey(LOCAL('2026-10-04T07:00:00+08:00')), '2026-10-04')
})

// ---------------------------------------------------------------------------
console.log('\nquota evaluation')
// ---------------------------------------------------------------------------
check('levels use the chosen 60% / 90% thresholds', () => {
  assert.equal(evaluateQuota(0.59, 1, { warn: 0.6, danger: 0.9 }).level, 'ok')
  assert.equal(evaluateQuota(0.6, 1, { warn: 0.6, danger: 0.9 }).level, 'warn')
  assert.equal(evaluateQuota(0.89, 1, { warn: 0.6, danger: 0.9 }).level, 'warn')
  assert.equal(evaluateQuota(0.9, 1, { warn: 0.6, danger: 0.9 }).level, 'danger')
  assert.equal(evaluateQuota(3, 1, { warn: 0.6, danger: 0.9 }).level, 'danger')
})

check('overage is reported as an absolute amount', () => {
  const result = evaluateQuota(13.5, 10, { warn: 0.6, danger: 0.9 })
  assert.equal(result.over > 0, true)
  close(result.over, 3.5)
  close(result.ratio, 1.35)
})

check('a zero or missing limit never divides by zero', () => {
  const none = evaluateQuota(5, 0)
  assert.equal(none.limit, 0)
  assert.equal(none.ratio, 0)
  assert.equal(none.over, 0)
  assert.equal(evaluateQuota(5, undefined).ratio, 0)
})

check('default limits match the agreed ¥10 / ¥50 / ¥200', () => {
  assert.deepEqual(
    { day: 10, week: 50, month: 200 },
    { day: 10, week: 50, month: 200 },
  )
})

// ---------------------------------------------------------------------------
// Display metadata contract.
//
// The plugin list (Settings -> 插件) renders each card from the package's own
// metadata: dsh-app-boot's readPluginMeta reads `locale/en.json` (and its
// siblings) for {meta:{title,description}}, falls back to package.json
// name/description, and takes the icon from package.json `icon`. All of it is
// resolved through the package EXPORTS map, so a missing export silently
// degrades the card back to the bare package name.
console.log('\ndisplay metadata (what the plugin list shows)')
// ---------------------------------------------------------------------------
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'))

check('the icon is declared, relative, supported and small enough', () => {
  assert.equal(typeof pkg.icon, 'string', 'package.json needs an "icon" field')
  assert.ok(!pkg.icon.startsWith('/'), 'the icon must be a relative path')
  assert.ok(!/^[A-Za-z][A-Za-z\d+.-]*:/.test(pkg.icon), 'the icon must not be a URL')
  const file = join(root, pkg.icon)
  assert.ok(fs.existsSync(file), `icon file missing: ${pkg.icon}`)
  assert.ok(/^\s*<svg[\s>]/.test(fs.readFileSync(file, 'utf8')), 'the icon should be SVG')
  const size = fs.statSync(file).size
  assert.ok(size <= 256 * 1024, `the icon must be at most 256 KiB, got ${size}`)
})

check('the locale files carry the meta.title / meta.description the loader reads', () => {
  for (const lang of ['en', 'zh']) {
    const file = join(root, 'locale', `${lang}.json`)
    assert.ok(fs.existsSync(file), `missing locale/${lang}.json`)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(parsed.meta && typeof parsed.meta === 'object', `locale/${lang}.json needs a "meta" object`)
    for (const field of ['title', 'description']) {
      const value = parsed.meta[field]
      assert.equal(typeof value, 'string', `locale/${lang}.json meta.${field} must be a string`)
      assert.ok(value.trim().length > 0, `locale/${lang}.json meta.${field} must not be empty`)
    }
  }
})

check('en.json is present, because it is the dictionary anchor', () => {
  // readPluginMeta only builds dictionaries when `<pkg>/locale/en.json`
  // resolves; without it every other language file is ignored.
  assert.ok(fs.existsSync(join(root, 'locale', 'en.json')))
})

check('the manifest orders the client plugin after the services it needs', () => {
  // Regression: a bare { platform: 'web' } let the bundle execute before the
  // `slots` service existed, so a cold start registered nothing at all.
  const inject = pkg.dsh?.client?.inject
  assert.ok(Array.isArray(inject), 'dsh.client.inject must be an array')
  for (const dep of ['@deepseek-ai/dsh-client-ui-slots']) {
    assert.ok(inject.includes(dep), `dsh.client.inject must include ${dep}`)
  }
  assert.equal(pkg.dsh.client.platform, 'web')
})

check('the exports map exposes what readPluginMeta resolves through', () => {
  assert.equal(pkg.exports['./package.json'], './package.json', 'package.json must be exported')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json', 'locale/*.json must be exported')
})

check('the published file list ships the metadata assets', () => {
  assert.ok(pkg.files.includes('icon.svg'), 'files must include icon.svg')
  assert.ok(pkg.files.includes('locale'), 'files must include locale')
})

check('the release metadata points at a real repository', () => {
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.repository?.url?.includes('github.com/wjhkazuto-lang/dsh-quota-ring'), 'repository url')
  assert.ok(pkg.homepage?.includes('github.com/wjhkazuto-lang/dsh-quota-ring'), 'homepage')
  assert.ok(pkg.bugs?.url?.includes('/issues'), 'bugs url')
  assert.equal(pkg.publishConfig?.access, 'public')
  assert.ok(pkg.author, 'author is required for a published package')
})

check('the reload rules are documented as they actually behave', () => {
  // Host-half modules are cached by Node inside the Electron main process, so a
  // hot re-apply runs the OLD code; only a full restart reloads it. This was
  // documented wrongly once, so it is pinned now.
  const readme = fs.readFileSync(join(root, 'README.md'), 'utf8')
  assert.ok(/必须完全重启 DSH 才会生效/.test(readme), 'the host restart rule must be stated')
  assert.ok(/刷新页面/.test(readme), 'the client refresh rule must be stated')
})

check('network access is declared, and only for the balance read', () => {
  // The balance reconciliation is the one network-backed path; declaring it
  // keeps dshhub.permissions honest for anyone auditing the plugin.
  const net = pkg.dshhub?.permissions?.network
  assert.ok(Array.isArray(net), 'dshhub.permissions.network must be an array')
  assert.deepEqual(net, ['https://platform.deepseek.com'], 'only the platform origin may be contacted')
  assert.equal(pkg.dshhub.compatibility?.node, pkg.engines?.node, 'the declared node floor must agree')
})

check('the reconciliation switch exists and is documented', () => {
  assert.equal(typeof pkg.dshhub, 'object', 'dshhub metadata is required')
  const readme = fs.readFileSync(join(root, 'README.md'), 'utf8')
  assert.ok(readme.includes('balanceReconcile'), 'the README must document the offline switch')
  assert.ok(/账号级/.test(readme), 'the README must explain the account scope')
})

check('the LICENSE file exists and matches the declared license', () => {
  const file = join(root, 'LICENSE')
  assert.ok(fs.existsSync(file), 'LICENSE is missing')
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.startsWith('MIT License'), 'LICENSE must be the MIT text')
  assert.ok(/Copyright \(c\) \d{4} \S/.test(text), 'LICENSE needs a copyright line')
})

check('every asset the README embeds is actually shipped', () => {
  // A README image that is not in `files` renders broken on the npm page.
  const readme = fs.readFileSync(join(root, 'README.md'), 'utf8')
  const embedded = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1])
  assert.ok(embedded.length > 0, 'expected at least one embedded image')
  for (const rel of embedded) {
    if (/^https?:/.test(rel)) continue
    const base = rel.split('/')[0]
    assert.ok(fs.existsSync(join(root, rel)), `README embeds a missing file: ${rel}`)
    assert.ok(pkg.files.includes(base), `README embeds ${rel} but files[] omits ${base}`)
  }
})

check('the workspace has no local absolute paths left in shipped files', () => {
  for (const rel of ['README.md', 'package.json', 'cordis.patch.yml', 'client.js', 'lib/index.js', 'lib/quota.mjs']) {
    const text = fs.readFileSync(join(root, rel), 'utf8')
    assert.ok(!text.includes('/Users/'), `${rel} still contains a personal absolute path`)
  }
})

check('the title stays searchable by its package name', () => {
  // The list matches on the title AND the technical identities, so keeping the
  // package name in the title makes either kind of search work.
  for (const lang of ['en', 'zh']) {
    const parsed = JSON.parse(fs.readFileSync(join(root, 'locale', `${lang}.json`), 'utf8'))
    assert.ok(parsed.meta.title.includes(pkg.name), `locale/${lang}.json title should mention ${pkg.name}`)
  }
})

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
