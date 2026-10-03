/**
 * Pure quota/accounting logic for dsh-quota-ring.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested against the real numbers recorded by dsh-cost-meter's ledger.
 *
 * Three independent concerns live in this file:
 *   1. Price table  — official DeepSeek CNY prices, per 1M tokens.
 *   2. Peak/off-peak — the official billing window rule.
 *   3. Quota periods — the user's day/week/month budget boundaries.
 *
 * (2) follows BEIJING time (the official rule is stated in 北京时间 and the
 * peak windows are given in UTC hours). (3) follows the machine's LOCAL time,
 * which the user chose. The two coincide on this machine (UTC+8) but are kept
 * separate on purpose: changing the machine timezone must not silently move
 * DeepSeek's peak windows.
 */

// ---------------------------------------------------------------------------
// 1. Price table — official DeepSeek CNY prices, CNY per 1M tokens.
// ---------------------------------------------------------------------------
//
// Official rule: 空闲时段价格为高峰时段价格的一半. So `peak` is the reference
// price and `offPeak` is exactly half of it.
//
// These are the current (post-2026-09-10) official CNY numbers, which happen to
// be round: ¥0.02 / ¥1 / ¥4 off-peak and ¥0.04 / ¥2 / ¥8 at peak.
export const PRICE_TABLE = {
  'deepseek-v4-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-flash-vision-exp': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4.1-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
}

/** Fallback entry for any model id the table does not name. */
export const DEFAULT_PRICE = PRICE_TABLE['deepseek-v4-flash']

/** Model ids that are aliases of the Flash price. */
const FLASH_ALIASES = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4.1-flash',
  'deepseek-flash',
  'deepseek-chat',
])

/**
 * Resolve the price entry for one model id.
 *
 * The user only ever routes to the DeepSeek API, so an unknown model id is
 * treated as Flash pricing rather than an error — a missing price must never
 * silently drop a request from the total.
 *
 * @param model - provider model id as recorded on the request.
 * @param table - price table override (row config).
 * @returns the tiered price entry.
 */
export function priceEntryFor(model, table = PRICE_TABLE) {
  const id = typeof model === 'string' ? model.trim() : ''
  if (id && Object.hasOwn(table, id)) return table[id]
  const lower = id.toLowerCase()
  if (FLASH_ALIASES.has(lower)) return table['deepseek-v4-flash'] ?? DEFAULT_PRICE
  if (lower.startsWith('deepseek-v4-pro')) return table['deepseek-v4-pro'] ?? DEFAULT_PRICE
  if (lower.startsWith('deepseek')) return table['deepseek-v4-flash'] ?? DEFAULT_PRICE
  return table['deepseek-v4-flash'] ?? DEFAULT_PRICE
}

/** The tier object for one entry and billing phase. */
function tierOf(entry, isPeak) {
  if (isPeak) return entry.peak ?? entry.offPeak ?? entry
  return entry.offPeak ?? entry.peak ?? entry
}

// ---------------------------------------------------------------------------
// 2. Peak / off-peak billing windows (BEIJING calendar).
// ---------------------------------------------------------------------------
//
// Official rule (DeepSeek 模型 & 价格, footnote 2):
//   北京时间 周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰时段;
//   其余时段,包括周末及中国法定节假日全天均为空闲时段。
//
// The windows below are therefore UTC hours, half-open [start, end):
//   UTC 01:00–04:00 == Beijing 09:00–12:00
//   UTC 06:00–10:00 == Beijing 14:00–18:00
export const PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

// The weekend/holiday all-off-peak rule took effect 2026-08-23 00:00 Beijing.
export const WEEKEND_OFFPEAK_EFFECTIVE_AT = '2026-08-22T16:00:00Z'

// Peak/off-peak billing itself took effect here; earlier usage bills at the
// pre-peak base price (constant across the day).
export const PEAK_EFFECTIVE_AT = '2026-08-01T00:00:00Z'

const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const DAY_MS = 86400000

/**
 * 2026 Chinese public holidays, Beijing calendar days.
 *
 * Source: 国务院办公厅 2026 年部分节假日安排 (国办发明电〔2025〕7 号), as
 * published by the community DSH pricing plugins.
 *
 * Only days OFF are listed. 调休补班日 (make-up workdays) always land on a
 * weekend, and weekends are already all-day off-peak, so they need no entry.
 *
 * This table is the one thing that needs a yearly update. The plugin warns at
 * startup when a billing date falls outside every year it covers, and the whole
 * list can be replaced from the plugin's row config.
 */
export const HOLIDAYS_2026 = expandRanges([
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午
  ['2026-09-25', '2026-09-27'], // 中秋
  ['2026-10-01', '2026-10-07'], // 国庆
])

/** Inclusive date-range list -> flat sorted list of YYYY-MM-DD strings. */
export function expandRanges(ranges) {
  const out = []
  for (const [from, to] of ranges) {
    let at = Date.parse(`${from}T00:00:00Z`)
    const end = Date.parse(`${to}T00:00:00Z`)
    if (!Number.isFinite(at) || !Number.isFinite(end)) continue
    for (; at <= end; at += DAY_MS) out.push(new Date(at).toISOString().slice(0, 10))
  }
  return [...new Set(out)].sort()
}

/** Beijing calendar day key (YYYY-MM-DD) for an instant. */
export function beijingDayKey(atMs) {
  const day = Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS)
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** Beijing weekday for an instant: 0 = Sunday … 6 = Saturday. */
export function beijingWeekday(atMs) {
  const day = Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS)
  // 1970-01-01 was a Thursday (4).
  return (day + 4) % 7
}

/** Whether an instant sits on a weekend (Beijing calendar). */
export function isWeekend(atMs) {
  const weekday = beijingWeekday(atMs)
  return weekday === 0 || weekday === 6
}

/** Whether an instant sits on a listed Chinese public holiday. */
export function isHoliday(atMs, holidays) {
  if (!Array.isArray(holidays) || holidays.length === 0) return false
  return holidays.includes(beijingDayKey(atMs))
}

/**
 * Whether one instant bills at the peak price.
 *
 * Weekends and holidays short-circuit to off-peak for the whole day, so the
 * hour windows only ever apply on a Beijing weekday.
 *
 * @param atMs - billing instant (epoch ms).
 * @param settings - { enabled, effectiveAtMs, windows, holidays }.
 * @returns true when the peak tier applies.
 */
export function isPeak(atMs, settings = {}) {
  const {
    enabled = true,
    effectiveAtMs = Date.parse(PEAK_EFFECTIVE_AT),
    windows = PEAK_WINDOWS,
    holidays = HOLIDAYS_2026,
  } = settings
  if (!Number.isFinite(atMs)) return false
  if (enabled === false) return false
  if (Number.isFinite(effectiveAtMs) && atMs < effectiveAtMs) return false
  if (!Array.isArray(windows) || windows.length === 0) return false
  if (atMs >= Date.parse(WEEKEND_OFFPEAK_EFFECTIVE_AT)) {
    if (isWeekend(atMs) || isHoliday(atMs, holidays)) return false
  }
  const hour = new Date(atMs).getUTCHours()
  return windows.some((w) => {
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    return hour >= start || hour < end // cross-midnight, kept for completeness
  })
}

/**
 * Why the current instant bills the way it does, for the hover panel.
 *
 * @returns { peak, reason } where reason is 'peak' | 'holiday' | 'weekend' | 'offhours' | 'disabled'.
 */
export function billingPhaseAt(atMs, settings = {}) {
  const {
    enabled = true,
    windows = PEAK_WINDOWS,
    holidays = HOLIDAYS_2026,
  } = settings
  if (enabled === false) return { peak: false, reason: 'disabled' }
  if (Number.isFinite(atMs) && atMs < Date.parse(WEEKEND_OFFPEAK_EFFECTIVE_AT)) {
    return { peak: isPeak(atMs, settings), reason: isPeak(atMs, settings) ? 'peak' : 'offhours' }
  }
  if (isHoliday(atMs, holidays)) return { peak: false, reason: 'holiday' }
  if (isWeekend(atMs)) return { peak: false, reason: 'weekend' }
  const peak = isPeak(atMs, { ...settings, enabled, windows, holidays })
  return { peak, reason: peak ? 'peak' : 'offhours' }
}

/** Calendar years the holiday table covers. */
export function holidayTableYears(holidays) {
  const years = new Set()
  for (const day of holidays ?? []) {
    if (typeof day === 'string' && /^\d{4}-/.test(day)) years.add(day.slice(0, 4))
  }
  return [...years].sort()
}

// ---------------------------------------------------------------------------
// 3. Quota periods (LOCAL time, as chosen by the user).
// ---------------------------------------------------------------------------

/** Local midnight at the start of the day containing `atMs`. */
export function dayStart(atMs) {
  const d = new Date(atMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Start of the week containing `atMs`, with the week beginning on SUNDAY
 * (the user's choice).
 */
export function weekStart(atMs) {
  const d = new Date(dayStart(atMs))
  d.setDate(d.getDate() - d.getDay())
  return d.getTime()
}

/** Start of the month containing `atMs`, local midnight on the 1st. */
export function monthStart(atMs) {
  const d = new Date(atMs)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

/** Exclusive end of the day/week/month window starting at `startMs`. */
export function periodEnd(startMs, period) {
  const d = new Date(startMs)
  if (period === 'day') d.setDate(d.getDate() + 1)
  else if (period === 'week') d.setDate(d.getDate() + 7)
  else if (period === 'month') d.setMonth(d.getMonth() + 1)
  else throw new Error(`unknown period ${period}`)
  return d.getTime()
}

/** Local day key (YYYY-MM-DD), used as the ledger's bucket key. */
export function localDayKey(atMs) {
  const d = new Date(atMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local day keys covering [startMs, endMs], inclusive of both ends. */
export function localDayKeysBetween(startMs, endMs) {
  const keys = []
  const cursor = new Date(dayStart(startMs))
  const last = dayStart(endMs)
  while (cursor.getTime() <= last) {
    keys.push(localDayKey(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

// ---------------------------------------------------------------------------
// 4. Usage folding and costing.
// ---------------------------------------------------------------------------

/** An all-zero usage triple. */
export function emptyTriple() {
  return { inMiss: 0, cacheHit: 0, output: 0 }
}

/**
 * Fold one recorded `data.usage` object into a token triple.
 *
 * Cache writes bill at the cache-miss rate (DeepSeek publishes no separate
 * cache-write price), so they are added to `inMiss`.
 *
 * @param usage - the `data.usage` payload of an assistant message.
 * @returns { inMiss, cacheHit, output } token counts.
 */
export function tripleFromUsage(usage) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    inMiss: num(usage?.inputTokens) + num(usage?.cacheWriteTokens),
    cacheHit: num(usage?.cacheReadTokens),
    output: num(usage?.outputTokens) + num(usage?.reasoningTokens),
  }
}

/** Add triple `b` into triple `a` (in place) and return `a`. */
export function addTriple(a, b) {
  a.inMiss += b.inMiss
  a.cacheHit += b.cacheHit
  a.output += b.output
  return a
}

/** Whether a triple carries no billable tokens. */
export function isZeroTriple(t) {
  return !t || (t.inMiss === 0 && t.cacheHit === 0 && t.output === 0)
}

/**
 * Cost in CNY of one token triple at one tier.
 *
 * @param triple - { inMiss, cacheHit, output }.
 * @param entry - a price table entry.
 * @param isPeakPhase - which tier to charge.
 */
export function costOfTriple(triple, entry, isPeakPhase) {
  const tier = tierOf(entry, isPeakPhase)
  const per1M = (tokens, rate) => (Number(tokens) || 0) / 1e6 * (Number(rate) || 0)
  return (
    per1M(triple?.inMiss, tier.cacheMiss) +
    per1M(triple?.cacheHit, tier.cacheHit) +
    per1M(triple?.output, tier.output)
  )
}

/**
 * Cost in CNY of one day bucket.
 *
 * The ledger stores tokens split by tier and model, never a pre-computed money
 * amount, so editing the price table re-prices all history instead of leaving
 * stale totals behind.
 *
 * @param day - one ledger day record.
 * @param table - price table.
 * @returns total CNY for that day.
 */
export function costOfDay(day, table = PRICE_TABLE) {
  let total = 0
  for (const [model, tiers] of Object.entries(day?.models ?? {})) {
    const entry = priceEntryFor(model, table)
    if (tiers?.peak) total += costOfTriple(tiers.peak, entry, true)
    if (tiers?.off) total += costOfTriple(tiers.off, entry, false)
  }
  return total
}

/** Total tokens of one triple. */
export function tripleTokens(t) {
  return (Number(t?.inMiss) || 0) + (Number(t?.cacheHit) || 0) + (Number(t?.output) || 0)
}

/** Sum tokens and cost over a list of ledger day records. */
export function sumDays(days, table = PRICE_TABLE) {
  const tokens = { inMiss: 0, cacheHit: 0, output: 0 }
  let cost = 0
  let calls = 0
  for (const day of days) {
    for (const tiers of Object.values(day?.models ?? {})) {
      if (tiers?.peak) addTriple(tokens, tiers.peak)
      if (tiers?.off) addTriple(tokens, tiers.off)
    }
    cost += costOfDay(day, table)
    calls += Number(day?.calls) || 0
  }
  return { tokens, cost, calls }
}

// ---------------------------------------------------------------------------
// 5. Quota evaluation.
// ---------------------------------------------------------------------------

/**
 * Evaluate one period against its limit.
 *
 * @param used - CNY spent inside the window.
 * @param limit - the user's limit in CNY (0/absent disables the ring fill).
 * @param thresholds - { warn, danger } ratios at which the level escalates.
 * @returns { used, limit, ratio, level, over, resetAt }.
 */
export function evaluateQuota(used, limit, thresholds = { warn: 0.6, danger: 0.9 }) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 0
  const ratio = safeLimit > 0 ? used / safeLimit : 0
  const warn = Number(thresholds?.warn ?? 0.6)
  const danger = Number(thresholds?.danger ?? 0.9)
  let level = 'ok'
  if (ratio >= danger) level = 'danger'
  else if (ratio >= warn) level = 'warn'
  return {
    used,
    limit: safeLimit,
    ratio,
    level,
    // With no limit there is nothing to exceed, so overage stays zero rather
    // than reporting the whole spend as an excess.
    over: safeLimit > 0 ? Math.max(0, used - safeLimit) : 0,
  }
}
