/**
 * dsh-quota-ring — Host half.
 *
 * Owns the money accounting and the ledger, and exposes it to the browser half
 * over two same-origin JSON routes. Nothing here renders.
 *
 * Data flow:
 *   session logs on disk  ──(startup backfill, last N days)──┐
 *                                                            ├─> ledger.json ─> /__quota-ring/state
 *   live `session/event`  ──(assistant/message usage)────────┘
 *
 * The ledger stores TOKENS SPLIT BY TIER AND MODEL, never money. Pricing is
 * applied when the state is built, so editing the price table or the holiday
 * list re-prices all history instead of leaving stale amounts behind.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  HOLIDAYS_2026,
  PEAK_EFFECTIVE_AT,
  PEAK_WINDOWS,
  PRICE_TABLE,
  billingPhaseAt,
  costOfDay,
  dayStart,
  emptyTriple,
  evaluateQuota,
  holidayTableYears,
  isPeak,
  isZeroTriple,
  localDayKey,
  localDayKeysBetween,
  monthStart,
  periodEnd,
  priceEntryFor,
  sumDays,
  tripleFromUsage,
  tripleTokens,
  weekStart,
} from './quota.mjs'

export const name = 'quota-ring'

// `webServer` is all we need: the browser half reaches us over same-origin
// fetch. We deliberately take no storage/Remote dependency so the plugin keeps
// working across DSH releases.
export const inject = ['webServer']

const LEDGER_VERSION = 1
const MAX_BODY_BYTES = 64 * 1024
const WRITE_DEBOUNCE_MS = 2000
const SESSION_STATE_RETENTION_DAYS = 45

const DEFAULTS = {
  dayLimit: 10,
  weekLimit: 50,
  monthLimit: 200,
  thresholds: { warn: 0.6, danger: 0.9 },
  backfillDays: 35,
  retentionDays: 400,
  peakEnabled: true,
  refreshSeconds: 30,
  // Reading the official account balance is what makes the machine-scope /
  // account-scope gap visible instead of confusing. It is the ONE thing here
  // that reaches the network (indirectly, through DSH's own account service),
  // so it stays switchable: `balanceReconcile: false` restores zero network I/O.
  balanceReconcile: true,
  balanceRefreshMinutes: 5,
  // How soon a state request may nudge a retry after a read that did not
  // succeed. Keeps a transient failure from pinning the panel for minutes.
  balanceRetrySeconds: 30,
  holidays: null,
  prices: null,
  peakWindows: null,
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

function sendJson(res, status, body) {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
  })
  res.end(encoded)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('payload too large')
        error.statusCode = 413
        reject(error)
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        const error = new Error('invalid json')
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Same-origin guard: the routes only ever mutate local single-user state. */
function isSameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true // same-origin fetches may omit Origin
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    const parsed = new URL(origin)
    return parsed.host === host
  } catch {
    return false
  }
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ---------------------------------------------------------------------------
// Reading compressed session logs
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xfd2fb528
const READ_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Walk the zstd frame structure of a buffer and return complete frames.
 *
 * Session logs are a concatenation of independent zstd frames appended as the
 * run progresses, so a single `zstdDecompressSync` call would only ever return
 * the first event. A torn trailing frame (crash) is dropped by returning early.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return frames // reserved bits: malformed
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerBytes) return frames
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return frames // reserved block type: malformed
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Highest-generation log file inside one session directory. */
function sessionLogGeneration(fileName) {
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(fileName)
  if (!match) return null
  const version = Number(match[1] ?? 0)
  if (!Number.isSafeInteger(version)) return null
  return { version, compressed: Boolean(match[2]) }
}

/** Enumerate `{ sessionId, file, compressed }` for the newest generation. */
function listSessionLogs(root) {
  const out = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = path.join(root, project.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionPath = path.join(projectPath, session.name)
      let entries = []
      try {
        entries = fs.readdirSync(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }
      const candidates = []
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const generation = sessionLogGeneration(entry.name)
        if (!generation) continue
        candidates.push({ name: entry.name, ...generation })
      }
      candidates.sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
      const chosen = candidates[0]
      if (!chosen) continue
      out.push({
        sessionId: session.name,
        file: path.join(sessionPath, chosen.name),
        compressed: chosen.compressed,
      })
    }
  }
  return out
}

/**
 * Decode one session log into its JSONL text.
 *
 * Reads in chunks so a very large log never materialises whole twice, and
 * decompresses frame by frame.
 */
async function readSessionLogText(file, compressed) {
  const handle = await fsp.open(file, 'r')
  try {
    const pieces = []
    let carry = Buffer.alloc(0)
    const buffer = Buffer.alloc(READ_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
      const frames = scanZstdFrames(chunk)
      if (!compressed) {
        pieces.push(chunk.toString('utf8'))
        carry = Buffer.alloc(0)
        continue
      }
      if (frames.length === 0) {
        carry = chunk
        continue
      }
      const last = frames[frames.length - 1]
      for (const frame of frames) {
        try {
          pieces.push(zlib.zstdDecompressSync(chunk.subarray(frame.start, frame.end)).toString('utf8'))
        } catch {
          /* a frame we cannot read is skipped rather than failing the backfill */
        }
      }
      carry = chunk.subarray(last.end)
    }
    // A trailing partial frame is dropped on purpose (crash-truncated tail).
    return pieces.join('')
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const config = {
    ...DEFAULTS,
    ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
    thresholds: { ...DEFAULTS.thresholds, ...(rawConfig?.thresholds ?? {}) },
  }
  const holidays =
    Array.isArray(config.holidays) && config.holidays.length > 0
      ? config.holidays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      : HOLIDAYS_2026
  const prices =
    config.prices && typeof config.prices === 'object' ? config.prices : PRICE_TABLE
  const peakWindows =
    Array.isArray(config.peakWindows) && config.peakWindows.length > 0
      ? config.peakWindows
      : PEAK_WINDOWS

  const home = dshHome()
  const ledgerDir = path.join(home, 'storages', 'quota-ring')
  const ledgerFile = path.join(ledgerDir, 'ledger.json')
  const sessionsRoot = path.join(home, 'sessions')

  /** @type {{ version:number, updatedAt:number, limits:object, days:object, sessions:object }} */
  let ledger = {
    version: LEDGER_VERSION,
    updatedAt: 0,
    limits: {
      dayLimit: config.dayLimit,
      weekLimit: config.weekLimit,
      monthLimit: config.monthLimit,
    },
    days: {},
    sessions: {},
    // Per-day official-balance baseline, so the account-scope spend since the
    // first reading of the day can be shown next to the machine-scope spend.
    balance: null,
  }

  let writeTimer = null
  let dirty = false
  let ready = false
  // Set during teardown: a best-effort final flush may still fail (its storage
  // directory can already be gone), and that is not worth alarming the user's
  // log about while the plugin is on its way out.
  let shuttingDown = false
  let lastBackfill = null
  let pendingLive = []
  let backfilling = true

  // -- ledger persistence ---------------------------------------------------

  function scheduleWrite() {
    dirty = true
    if (writeTimer !== null) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      void flush()
    }, WRITE_DEBOUNCE_MS)
    if (typeof writeTimer.unref === 'function') writeTimer.unref()
  }

  async function flush() {
    if (!dirty) return
    dirty = false
    ledger.updatedAt = Date.now()
    try {
      await fsp.mkdir(ledgerDir, { recursive: true })
      const tmp = `${ledgerFile}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(ledger), 'utf8')
      await fsp.rename(tmp, ledgerFile)
    } catch (error) {
      if (!shuttingDown) console.error('[quota-ring] 账本写入失败:', error?.message ?? error)
    }
  }

  async function loadLedger() {
    try {
      const raw = await fsp.readFile(ledgerFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      ledger = {
        version: LEDGER_VERSION,
        updatedAt: Number(parsed.updatedAt) || 0,
        limits: {
          dayLimit: positiveNumber(parsed.limits?.dayLimit, config.dayLimit),
          weekLimit: positiveNumber(parsed.limits?.weekLimit, config.weekLimit),
          monthLimit: positiveNumber(parsed.limits?.monthLimit, config.monthLimit),
        },
        days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        balance: parsed.balance && typeof parsed.balance === 'object' ? parsed.balance : null,
      }
    } catch {
      /* first run */
    }
  }

  // -- folding --------------------------------------------------------------

  function dayBucket(dateKey) {
    let day = ledger.days[dateKey]
    if (!day) {
      day = { models: {}, calls: 0 }
      ledger.days[dateKey] = day
    }
    return day
  }

  function tierBucket(day, model, peak) {
    const key = peak ? 'peak' : 'off'
    let perModel = day.models[model]
    if (!perModel) {
      perModel = {}
      day.models[model] = perModel
    }
    if (!perModel[key]) perModel[key] = emptyTriple()
    return perModel[key]
  }

  /**
   * Fold one billed request into the ledger.
   *
   * `sessionId` + `seq` make this idempotent, which is what lets the startup
   * backfill and the live event feed both run without double counting.
   */
  function foldUsage({ sessionId, seq, atMs, model, usage }) {
    if (!Number.isFinite(atMs)) return false
    const triple = tripleFromUsage(usage)
    if (isZeroTriple(triple)) return false

    if (typeof sessionId === 'string' && sessionId) {
      const known = ledger.sessions[sessionId]
      if (Number.isFinite(seq)) {
        if (known && Number.isFinite(known.seq) && seq <= known.seq) return false
        ledger.sessions[sessionId] = { seq, at: atMs }
      }
    }

    const peak = isPeak(atMs, {
      enabled: config.peakEnabled,
      effectiveAtMs: Date.parse(PEAK_EFFECTIVE_AT),
      windows: peakWindows,
      holidays,
    })
    const day = dayBucket(localDayKey(atMs))
    const bucket = tierBucket(day, model || 'unknown', peak)
    bucket.inMiss += triple.inMiss
    bucket.cacheHit += triple.cacheHit
    bucket.output += triple.output
    day.calls += 1
    return true
  }

  function pruneSessions() {
    const cutoff = Date.now() - SESSION_STATE_RETENTION_DAYS * 86400000
    for (const [id, state] of Object.entries(ledger.sessions)) {
      if (!state || !Number.isFinite(state.at) || state.at < cutoff) delete ledger.sessions[id]
    }
  }

  function pruneDays() {
    const cutoffKey = localDayKey(Date.now() - config.retentionDays * 86400000)
    for (const key of Object.keys(ledger.days)) {
      if (key < cutoffKey) delete ledger.days[key]
    }
  }

  // -- backfill -------------------------------------------------------------

  /**
   * Fold the last `backfillDays` of session logs.
   *
   * Money already spent today is the whole point of a quota ring, so the ring
   * must not start at zero just because the plugin was installed mid-day. Files
   * whose mtime predates the window are skipped without being read.
   */
  async function backfill() {
    const started = Date.now()
    const since = started - config.backfillDays * 86400000
    const logs = listSessionLogs(sessionsRoot)
    let scanned = 0
    let folded = 0

    for (const log of logs) {
      try {
        const stat = await fsp.stat(log.file)
        if (stat.mtimeMs < since) continue
      } catch {
        continue
      }
      let text = ''
      try {
        text = await readSessionLogText(log.file, log.compressed)
      } catch (error) {
        console.error(`[quota-ring] 读取会话日志失败 ${path.basename(log.file)}:`, error?.message ?? error)
        continue
      }
      scanned += 1

      // Collect this session's billed events, then apply in seq order so the
      // idempotence check sees a monotonic sequence.
      const events = []
      for (const line of text.split('\n')) {
        if (!line) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record?.type !== 'assistant/message') continue
        const atMs = Number(record.time)
        if (!Number.isFinite(atMs) || atMs < since) continue
        const usage = record.data?.usage
        if (!usage) continue
        events.push({
          sessionId: log.sessionId,
          seq: Number(record.seq),
          atMs,
          model: record.data?.message?.source?.model ?? 'unknown',
          usage,
        })
      }
      events.sort((a, b) => (Number.isFinite(a.seq) ? a.seq : 0) - (Number.isFinite(b.seq) ? b.seq : 0))
      for (const event of events) if (foldUsage(event)) folded += 1
    }

    pruneSessions()
    pruneDays()
    lastBackfill = {
      at: Date.now(),
      durationMs: Date.now() - started,
      filesScanned: scanned,
      filesSkipped: Math.max(0, logs.length - scanned),
      requestsFolded: folded,
      since,
    }
    if (folded > 0) scheduleWrite()
    console.log(
      `[quota-ring] 回填完成:扫描 ${scanned} 个会话日志(跳过 ${lastBackfill.filesSkipped} 个过旧文件),` +
        `折叠 ${folded} 条计费请求,耗时 ${lastBackfill.durationMs}ms`,
    )
  }

  // -- state -----------------------------------------------------------------

  function tokensAndCacheHit(days) {
    const { tokens } = sumDays(days, prices)
    const total = tripleTokens(tokens)
    const cacheHitRate = total > 0 ? tokens.cacheHit / total : null
    return { tokens, total, cacheHitRate }
  }

  // -- official account balance (the reconciliation half) --------------------
  //
  // Everything else in this plugin counts THIS machine's DSH sessions. The
  // platform's own usage page is ACCOUNT-scoped: it also includes other
  // devices, other tools, and the handful of billed calls DSH does not record
  // usage for (session-title generation, web-search model calls). Those two
  // numbers can never be identical, so the gap is shown rather than hidden.
  //
  // The read goes through DSH's own account service -- the plugin issues no
  // HTTP request itself -- and the whole feature is switchable off.

  /** @type {{ status: string, at?: number, error?: string, usageUrl?: string }} */
  let lastBalance = { status: config.balanceReconcile === false ? 'disabled' : 'loading' }
  let balanceBusy = false
  /**
   * The account service, obtained through `ctx.inject` below.
   *
   * A plain `ctx.get('deepseekAccount')` from this plugin's own context does NOT
   * see it: the account row is a SIBLING in the profile tree, and service lookup
   * walks ancestors, not siblings. Declaring the dependency gets it -- but as an
   * optional child fiber, not a hard `inject`, so a build without the account
   * service (a web profile) cannot stop this plugin from activating at all.
   */
  let accountService = null

  const sumWallets = (wallets, currency) =>
    (Array.isArray(wallets) ? wallets : [])
      .filter((w) => w?.currency === currency)
      .reduce((total, w) => total + (Number(w.balance) || 0), 0)

  /**
   * Fold one successful reading into the per-day baseline.
   *
   * The first reading of a local day becomes that day's baseline, so the
   * reported decrease covers "from the first reading of today", not necessarily
   * from local midnight -- the UI states the time rather than implying midnight.
   */
  function recordBalance(currency, total, at) {
    const date = localDayKey(at)
    const previous = ledger.balance
    ledger.balance =
      !previous || previous.date !== date || previous.currency !== currency
        ? { date, currency, firstTotal: total, firstAt: at, lastTotal: total, lastAt: at }
        : { ...previous, lastTotal: total, lastAt: at }
    dirty = true
    scheduleWrite()
  }

  const balanceRetryMs = Math.max(1, Number(config.balanceRetrySeconds) || 30) * 1000
  const BALANCE_ATTEMPTS = 3

  /**
   * Declare this client's identity to the account service, as the contract asks.
   * Mirrors what other consumers do: the platform uses it for language and
   * timeout conversion.
   */
  function balanceClient() {
    return {
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
      locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  async function refreshBalance() {
    if (config.balanceReconcile === false || balanceBusy) return
    balanceBusy = true
    const at = Date.now()
    try {
      const account = accountService
      if (account === null || account === undefined || typeof account.getBalance !== 'function') {
        // Carry WHY: "service missing", "signed out" and "query failed" must not
        // look identical in the panel, or the next diagnosis starts from zero.
        lastBalance = {
          status: 'unavailable',
          at,
          error: account === null || account === undefined
            ? '尚未拿到 deepseekAccount 服务（非桌面账号构建，或该服务还没就绪）'
            : 'deepseekAccount 上没有 getBalance',
        }
        return
      }
      let view
      try {
        view = await account.getState()
      } catch {
        view = undefined
      }
      const usageUrl = view?.links?.usageUrl
      if (view !== undefined && view?.status === 'signed-out') {
        lastBalance = { status: 'signed-out', at, usageUrl }
        return
      }
      // The platform endpoint behind this is intermittently flaky (TLS
      // interception makes it fail at random), so a single failure means very
      // little -- wait for an attempt that succeeds.
      let details = null
      let lastThrew = null
      for (let attempt = 0; attempt < BALANCE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt))
        try {
          details = await account.getBalance(balanceClient())
          lastThrew = null
        } catch (error) {
          lastThrew = error
          continue
        }
        if (details !== null && details !== undefined && details.status === 'ready') break
      }
      if (lastThrew !== null && (details === null || details === undefined)) {
        lastBalance = { status: 'failed', at, usageUrl, error: `余额查询抛错（已重试 ${BALANCE_ATTEMPTS} 次）: ${String(lastThrew?.message ?? lastThrew)}` }
        return
      }
      if (details === null || details === undefined) {
        lastBalance = { status: 'signed-out', at, usageUrl }
        return
      }
      if (details.status !== 'ready') {
        lastBalance = { status: 'failed', at, usageUrl, error: '平台余额查询未就绪' }
        return
      }
      // Reconcile in one currency only; mixing wallets would silently add CNY to USD.
      const wallets = [...(details.value ?? []), ...(details.bonusWallets ?? [])]
      const currency = wallets.some((w) => w?.currency === 'CNY') ? 'CNY' : 'USD'
      const recharge = sumWallets(details.value, currency)
      const granted = sumWallets(details.bonusWallets, currency)
      recordBalance(currency, recharge + granted, at)
      lastBalance = { status: 'ready', at, usageUrl, currency, recharge, granted, total: recharge + granted }
    } finally {
      balanceBusy = false
    }
  }

  /** The `official` slice of the state: live reading merged with the day baseline. */
  function balanceState() {
    const base = ledger.balance
    const spend = base ? base.firstTotal - base.lastTotal : null
    return {
      ...lastBalance,
      reconcile: config.balanceReconcile !== false,
      day: base
        ? {
            date: base.date,
            currency: base.currency,
            firstTotal: base.firstTotal,
            firstAt: base.firstAt,
            lastTotal: base.lastTotal,
            lastAt: base.lastAt,
            // Negative means the account was topped up during the day, which is
            // not a spend; the client renders that case differently.
            spend,
          }
        : null,
    }
  }

  function buildState(now = Date.now()) {
    const daysByKey = ledger.days
    const dayFrom = dayStart(now)
    const weekFrom = weekStart(now)
    const monthFrom = monthStart(now)

    const pick = (from) => {
      const keys = localDayKeysBetween(from, now)
      return keys.map((k) => daysByKey[k]).filter(Boolean)
    }

    const dayUsed = sumDays(pick(dayFrom), prices).cost
    const weekUsed = sumDays(pick(weekFrom), prices).cost
    const monthUsed = sumDays(pick(monthFrom), prices).cost

    const day = {
      ...evaluateQuota(dayUsed, ledger.limits.dayLimit, config.thresholds),
      resetAt: periodEnd(dayFrom, 'day'),
    }
    const week = {
      ...evaluateQuota(weekUsed, ledger.limits.weekLimit, config.thresholds),
      resetAt: periodEnd(weekFrom, 'week'),
    }
    const month = {
      ...evaluateQuota(monthUsed, ledger.limits.monthLimit, config.thresholds),
      resetAt: periodEnd(monthFrom, 'month'),
    }

    const todayStats = tokensAndCacheHit(pick(dayFrom))
    const phase = billingPhaseAt(now, {
      enabled: config.peakEnabled,
      effectiveAtMs: Date.parse(PEAK_EFFECTIVE_AT),
      windows: peakWindows,
      holidays,
    })

    const coveredYears = holidayTableYears(holidays)
    const todayYear = new Date(now).getFullYear().toString()
    const holidayTableMiss = !coveredYears.includes(todayYear)
    const modelIds = new Set()
    for (const dayRecord of Object.values(daysByKey)) {
      for (const model of Object.keys(dayRecord?.models ?? {})) modelIds.add(model)
    }

    return {
      version: LEDGER_VERSION,
      now,
      limits: { ...ledger.limits },
      periods: { day, week, month },
      today: {
        cost: dayUsed,
        tokens: todayStats.tokens,
        totalTokens: todayStats.total,
        cacheHitRate: todayStats.cacheHitRate,
      },
      phase: {
        peak: phase.peak,
        reason: phase.reason,
        windows: peakWindows,
      },
      official: balanceState(),
      meta: {
        currency: 'CNY',
        symbol: '¥',
        thresholds: config.thresholds,
        ledgerUpdatedAt: ledger.updatedAt,
        holidayYears: coveredYears,
        holidayTableMiss,
        holidayTableMissYear: holidayTableMiss ? todayYear : null,
        models: [...modelIds].sort(),
        backfill: lastBackfill,
        backfillRunning: backfilling,
        refreshSeconds: config.refreshSeconds,
      },
    }
  }

  // -- routes ----------------------------------------------------------------

  function registerRoutes() {
    return [
      ctx.webServer.register({
        kind: 'exact',
        path: '/__quota-ring/state',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405).end()
            return
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'cache-control': 'no-store' }).end()
            return
          }
          // Self-heal: the first read can land before the account service is
          // visible, and the periodic timer alone would leave the panel showing
          // "unavailable" for minutes. A state request retries sooner instead.
          if (
            config.balanceReconcile !== false &&
            lastBalance.status !== 'ready' &&
            Date.now() - (lastBalance.at ?? 0) > balanceRetryMs
          ) {
            void refreshBalance()
          }
          sendJson(res, 200, { ok: true, state: buildState() })
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/__quota-ring/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end()
            return
          }
          if (!isSameOrigin(req)) {
            sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          let body
          try {
            body = await readJson(req)
          } catch (error) {
            sendJson(res, error?.statusCode ?? 400, { ok: false, error: error?.message ?? 'bad request' })
            return
          }
          // The settings page owns exactly these three numbers; everything else
          // is the plugin row config's business.
          const next = {
            dayLimit: positiveNumber(body.dayLimit, ledger.limits.dayLimit),
            weekLimit: positiveNumber(body.weekLimit, ledger.limits.weekLimit),
            monthLimit: positiveNumber(body.monthLimit, ledger.limits.monthLimit),
          }
          ledger.limits = next
          dirty = true
          await flush()
          sendJson(res, 200, { ok: true, state: buildState() })
        },
      }),
    ]
  }

  // Routes and the event feed live inside ONE `ctx.effect` so the plugin's fiber
  // owns their lifetimes.
  //
  // This is not cosmetic. Registering a route outside an effect leaves it behind
  // when the plugin is disposed: a hot re-apply then dies with
  // "webserver: duplicate exact route", and the stale instance keeps serving a
  // frozen snapshot (its listener is gone, so nothing updates) while the new
  // instance never activates.
  ctx.effect(() => {
    const disposers = registerRoutes()

    // Ask for the account service without gating activation on it. When it shows
    // up the child fiber runs, we capture the service and read immediately; if it
    // never shows up this simply never runs and the plugin keeps working.
    if (config.balanceReconcile !== false) {
      ctx.inject(['deepseekAccount'], (accountCtx) => {
        const account = accountCtx.get?.('deepseekAccount') ?? accountCtx.deepseekAccount ?? null
        accountService = account
        accountCtx.effect(() => () => {
          accountService = null
        }, 'quota-ring: account service')
        void refreshBalance()
      })
    }

    // The balance is a network-backed read, so it runs on a slow timer rather
    // than on every state request.
    let balanceTimer = null
    if (config.balanceReconcile !== false) {
      const everyMs = Math.max(1, Number(config.balanceRefreshMinutes) || 5) * 60_000
      balanceTimer = setInterval(() => void refreshBalance(), everyMs)
      if (typeof balanceTimer.unref === 'function') balanceTimer.unref()
    }

    // The live feed. It is opened BEFORE the backfill so no request that happens
    // during startup is lost; those events are buffered and applied afterwards,
    // where the `seq` idempotence check absorbs anything the backfill already
    // folded.
    disposers.push(
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'assistant/message') return
        const usage = event.data?.usage
        if (!usage) return
        const entry = {
          sessionId: session?.id ?? event.sessionId ?? null,
          seq: Number(event.seq),
          atMs: Number(event.time),
          model: event.data?.message?.source?.model ?? 'unknown',
          usage,
        }
        if (backfilling) {
          pendingLive.push(entry)
          return
        }
        if (foldUsage(entry)) scheduleWrite()
      }),
    )

    return () => {
      shuttingDown = true
      if (writeTimer !== null) clearTimeout(writeTimer)
      if (balanceTimer !== null) clearInterval(balanceTimer)
      void flush()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* shutting down */
        }
      }
    }
  }, 'quota-ring: routes and event feed')

  void (async () => {
    await loadLedger()
    // Kick the first balance read off early: it is network-backed and slow, and
    // the earlier the day's baseline lands the more of today it covers.
    void refreshBalance()
    // Seed the runtime limits from the row config on first run only; after that
    // the settings page is the source of truth.
    if (!Number.isFinite(ledger.limits?.dayLimit)) ledger.limits.dayLimit = config.dayLimit
    await backfill()
    backfilling = false
    for (const entry of pendingLive) if (foldUsage(entry)) dirty = true
    pendingLive = []
    ready = true
    if (dirty) scheduleWrite()

    const covered = holidayTableYears(holidays)
    const year = new Date().getFullYear().toString()
    if (!covered.includes(year)) {
      console.warn(
        `[quota-ring] 节假日表未覆盖 ${year} 年,该年工作日假期会被按高峰价计算。` +
          `请在插件行配置的 holidays 里补录,或在 quota.mjs 更新 HOLIDAYS_${year}。`,
      )
    }
    console.log(`[quota-ring] 就绪,节假日表覆盖: ${covered.join(', ') || '无'}`)
  })().catch((error) => {
    console.error('[quota-ring] 启动失败:', error?.message ?? error)
  })
}

// Re-exported so the test harness can exercise the accounting, and read the
// shipped defaults, without booting the plugin.
export { DEFAULTS, costOfDay, priceEntryFor, sumDays, tripleFromUsage }
