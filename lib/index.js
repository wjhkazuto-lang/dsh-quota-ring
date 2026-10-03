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
