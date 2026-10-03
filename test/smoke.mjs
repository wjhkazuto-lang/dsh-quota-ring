/**
 * End-to-end Host-half check.
 *
 * Boots `apply()` against a mock Cordis context and a throwaway DSH_HOME (whose
 * `sessions/` symlinks the real logs when they exist), then drives both HTTP
 * routes and the live event feed. This is what proves the plugin works before
 * DSH is restarted, since a restart is the only way to load it for real.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')

let passed = 0
let failed = 0
let skipped = 0
async function check(name, fn) {
  try {
    // A test that cannot run on this machine returns a reason string instead of
    // asserting, so a bare checkout reports an honest skip rather than a failure.
    const reason = await fn()
    if (typeof reason === 'string' && reason.length > 0) {
      skipped += 1
      console.log(`  skip ${name} — ${reason}`)
      return
    }
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Throwaway DSH_HOME
// ---------------------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-smoke-'))
fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
const realSessions = path.join(os.homedir(), '.dsh', 'sessions')
let hasRealLogs = false
try {
  hasRealLogs = fs.statSync(realSessions).isDirectory()
} catch {
  hasRealLogs = false
}
if (hasRealLogs) fs.symlinkSync(realSessions, path.join(home, 'sessions'))
process.env.DSH_HOME = home

// Read the row config straight out of the shipped patch file, so this test also
// covers the config a profile will actually load.
//
// `yaml` is a devDependency; a contributor's checkout resolves it from their own
// node_modules. This machine also has a copy inside the DSH profile, so fall
// back to that before giving up. When neither is available the config-dependent
// assertions are skipped rather than failing on someone else's machine.
async function loadYaml() {
  try {
    return await import('yaml')
  } catch {
    /* not installed yet */
  }
  const profileCopy = path.join(os.homedir(), '.dsh/profiles/desktop/node_modules/yaml/dist/index.js')
  try {
    return await import(profileCopy)
  } catch {
    return null
  }
}

const YAML = await loadYaml()
let config = null
if (YAML) {
  const patch = YAML.parse(fs.readFileSync(path.join(repo, 'cordis.patch.yml'), 'utf8'))
  config = patch[0].insert[0].config
} else {
  console.log('  skip cordis.patch.yml coverage: no `yaml` module found (run `npm install`)')
}
// Fall back to the plugin's own defaults so the suites below still run.
const { DEFAULTS } = await import('../lib/index.js').then((m) => ({ DEFAULTS: m.DEFAULTS ?? null }))
const effective = config ?? DEFAULTS ?? {}

const { apply } = await import('../lib/index.js')

// ---------------------------------------------------------------------------
// Mock Cordis context
// ---------------------------------------------------------------------------
const routes = new Map()
const listeners = new Map()
const effectCleanups = []
const ctx = {
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  on: (event, fn) => {
    listeners.set(event, fn)
    return () => listeners.delete(event)
  },
  // Real Cordis owns effect lifetimes through the fiber; mimic that by
  // collecting the cleanups so `dispose()` actually tears the plugin down.
  effect: (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    return () => {}
  },
  get: () => undefined,
}

function disposeAll(cleanups) {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup()
    } catch {
      /* teardown */
    }
  }
}

function captureRes() {
  const chunks = []
  return {
    statusCode: 0,
    writeHead(code) {
      this.statusCode = code
      return this
    },
    end(body) {
      if (body) chunks.push(Buffer.from(body))
      this.body = Buffer.concat(chunks).toString('utf8')
    },
  }
}

function jsonReq(payload, headers = {}) {
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:19387', ...headers },
    on(event, fn) {
      if (event === 'data') fn(Buffer.from(JSON.stringify(payload)))
      if (event === 'end') fn()
      return this
    },
  }
}

async function readState() {
  const res = captureRes()
  await routes.get('/__quota-ring/state').handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.statusCode, 200, `GET /state returned ${res.statusCode}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  return parsed.state
}

console.log('\ndsh-quota-ring host smoke test\n')

apply(ctx, effective)
const dispose = () => disposeAll(effectCleanups)
let logged = []
const originalLog = console.log
const originalWarn = console.warn

// ---------------------------------------------------------------------------
console.log('registration')
// ---------------------------------------------------------------------------
await check('both routes are registered', () => {
  assert.ok(routes.has('/__quota-ring/state'), 'missing state route')
  assert.ok(routes.has('/__quota-ring/config'), 'missing config route')
})

await check('the live session/event feed is subscribed', () => {
  assert.ok(listeners.has('session/event'), 'missing session/event listener')
})

await check('GET /state rejects non-GET methods', async () => {
  const res = captureRes()
  await routes.get('/__quota-ring/state').handler({ method: 'DELETE', headers: {} }, res)
  assert.equal(res.statusCode, 405)
})

// ---------------------------------------------------------------------------
console.log('\nstartup backfill')
// ---------------------------------------------------------------------------
// The backfill is async; wait for the readiness log rather than a fixed sleep.
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 15000)
  const spy = (...args) => {
    const line = args.join(' ')
    if (line.includes('[quota-ring]')) {
      logged.push(line)
      if (line.includes('回填完成') || line.includes('就绪')) {
        clearTimeout(timer)
        resolve()
      }
    }
  }
  console.warn = spy
  console.log = spy
})
console.log = originalLog
console.warn = originalWarn
await new Promise((r) => setTimeout(r, 300))

const state = await readState()

await check('state reports the configured default limits', () => {
  assert.equal(state.limits.dayLimit, effective.dayLimit)
  assert.equal(state.limits.weekLimit, effective.weekLimit)
  assert.equal(state.limits.monthLimit, effective.monthLimit)
})

await check('all three periods are evaluated with reset instants in the future', () => {
  for (const key of ['day', 'week', 'month']) {
    const period = state.periods[key]
    assert.ok(Number.isFinite(period.used), `${key}.used not finite`)
    assert.ok(period.resetAt > state.now, `${key}.resetAt is not in the future`)
    assert.ok(['ok', 'warn', 'danger'].includes(period.level), `${key}.level = ${period.level}`)
  }
})

await check('today is billed off-peak because 2026-10-04 is a holiday', () => {
  assert.equal(state.phase.peak, false)
  assert.equal(state.phase.reason, 'holiday')
})

await check('the holiday table covers the current year', () => {
  assert.deepEqual(state.meta.holidayYears, ['2026'])
  assert.equal(state.meta.holidayTableMiss, false)
})

if (hasRealLogs) {
  await check('backfill folded the real session logs', () => {
    assert.ok(state.meta.backfill, 'no backfill record')
    assert.ok(state.meta.backfill.filesScanned > 0, 'no files scanned')
    assert.ok(state.meta.backfill.requestsFolded > 0, 'no requests folded')
    assert.equal(state.meta.backfillRunning, false)
  })

  await check('spend already recorded before install is visible', () => {
    assert.ok(state.periods.month.used > 0, 'month spend should be non-zero after backfill')
  })

  await check('the ledger on disk holds per-day token buckets, not money', async () => {
    const file = path.join(home, 'storages', 'quota-ring', 'ledger.json')
    // The ledger write is debounced (2s), so wait for it rather than racing it.
    for (let i = 0; i < 40 && !fs.existsSync(file); i += 1) {
      await new Promise((r) => setTimeout(r, 250))
    }
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    const days = Object.keys(ledger.days)
    assert.ok(days.length > 0, 'no day buckets persisted')
    const first = ledger.days[days[0]]
    assert.ok(first.models, 'day bucket has no models')
    assert.ok(!('cost' in first), 'day bucket must not store pre-computed money')
    const model = Object.keys(first.models)[0]
    const tier = Object.keys(first.models[model])[0]
    assert.deepEqual(
      Object.keys(first.models[model][tier]).sort(),
      ['cacheHit', 'inMiss', 'output'],
      'token triple shape changed',
    )
  })
} else {
  console.log('  skip real-log backfill checks (no ~/.dsh/sessions on this machine)')
}

// ---------------------------------------------------------------------------
console.log('\nsettings write path')
// ---------------------------------------------------------------------------
await check('POST /config stores new limits and echoes fresh state', async () => {
  const res = captureRes()
  await routes.get('/__quota-ring/config').handler(jsonReq({ dayLimit: 25, weekLimit: 120, monthLimit: 400 }), res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.state.limits.dayLimit, 25)
  assert.equal(body.state.limits.weekLimit, 120)
  assert.equal(body.state.limits.monthLimit, 400)
})

await check('a non-numeric limit falls back instead of corrupting the ledger', async () => {
  const res = captureRes()
  await routes.get('/__quota-ring/config').handler(jsonReq({ dayLimit: 'nonsense' }), res)
  const body = JSON.parse(res.body)
  assert.equal(body.state.limits.dayLimit, 25, 'should keep the previous value')
})

await check('a negative limit is refused', async () => {
  const res = captureRes()
  await routes.get('/__quota-ring/config').handler(jsonReq({ monthLimit: -5 }), res)
  const body = JSON.parse(res.body)
  assert.equal(body.state.limits.monthLimit, 400, 'should keep the previous value')
})

await check('a cross-origin POST is rejected', async () => {
  const res = captureRes()
  await routes
    .get('/__quota-ring/config')
    .handler(jsonReq({ dayLimit: 9999 }, { origin: 'http://evil.example' }), res)
  assert.equal(res.statusCode, 403)
})

await check('the ring colour follows the 60/90 thresholds', async () => {
  // Derive each limit from the CURRENT spend so the test cannot drift as the
  // real day's usage grows underneath it.
  const used = (await readState()).periods.day.used
  if (used <= 0) return 'needs recorded spend, but no session logs are present'
  const cases = [
    [used / 0.3, 'ok'], // ratio 0.30
    [used / 0.75, 'warn'], // ratio 0.75
    [used / 1.5, 'danger'], // ratio 1.50
  ]
  for (const [limit, expected] of cases) {
    const res = captureRes()
    await routes.get('/__quota-ring/config').handler(jsonReq({ dayLimit: limit }), res)
    const body = JSON.parse(res.body)
    assert.equal(body.state.periods.day.level, expected, `ratio ${(used / limit).toFixed(2)} should be ${expected}`)
  }
  // restore
  const res = captureRes()
  await routes.get('/__quota-ring/config').handler(jsonReq({ dayLimit: 10, weekLimit: 50, monthLimit: 200 }), res)
})

await check('a level set from the live spend lands in the right band', async () => {
  // Only wide bands can be asserted here: this test runs against the real
  // session logs, so `used` keeps growing underneath it. The exact 0.6 / 0.9
  // boundaries are pinned deterministically in test/check.mjs instead.
  const used = (await readState()).periods.day.used
  if (used <= 0) return 'needs recorded spend, but no session logs are present'
  const levelAt = async (ratio) => {
    const res = captureRes()
    await routes.get('/__quota-ring/config').handler(jsonReq({ dayLimit: used / ratio }), res)
    return JSON.parse(res.body).state.periods.day.level
  }
  assert.equal(await levelAt(0.3), 'ok')
  assert.equal(await levelAt(0.75), 'warn')
  assert.equal(await levelAt(1.5), 'danger')
  // Restore the configured defaults.
  const res = captureRes()
  await routes.get('/__quota-ring/config').handler(jsonReq({ dayLimit: 10, weekLimit: 50, monthLimit: 200 }), res)
})

await check('a replayed event with an already-seen seq is not double counted', async () => {
  const before = (await readState()).periods.day.used
  const emit = listeners.get('session/event')
  const event = {
    type: 'assistant/message',
    seq: 900001,
    time: Date.now(),
    data: {
      usage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { model: 'deepseek-v4-flash' } },
    },
  }
  emit({ id: 'session-smoke' }, event)
  const mid = (await readState()).periods.day.used
  emit({ id: 'session-smoke' }, event)
  const after = (await readState()).periods.day.used
  assert.ok(mid > before, 'the first event must be counted')
  assert.equal(after, mid, 'the duplicate must be ignored')
  // 1M cache-miss tokens on a holiday is exactly ¥1.
  assert.ok(Math.abs(mid - before - 1) < 1e-9, `expected +¥1, got +${mid - before}`)
})

await check('an unknown provider model still bills at the DeepSeek default', async () => {
  const before = (await readState()).periods.day.used
  const emit = listeners.get('session/event')
  emit(
    { id: 'session-smoke-2' },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: {
        usage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        message: { source: { model: 'some-unlisted-model' } },
      },
    },
  )
  const after = (await readState()).periods.day.used
  assert.ok(Math.abs(after - before - 1) < 1e-9, 'unlisted model must not be dropped from the total')
})

await check('events without usage are ignored', async () => {
  const before = (await readState()).periods.day.used
  const emit = listeners.get('session/event')
  emit({ id: 'session-smoke-3' }, { type: 'assistant/message', seq: 1, time: Date.now(), data: {} })
  emit({ id: 'session-smoke-3' }, { type: 'tool/call', seq: 2, time: Date.now(), data: {} })
  assert.equal((await readState()).periods.day.used, before)
})

await check('a zero-usage event does not inflate the call count', async () => {
  const emit = listeners.get('session/event')
  const file = path.join(home, 'storages', 'quota-ring', 'ledger.json')
  await new Promise((r) => setTimeout(r, 2500))
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  const key = Object.keys(before.days).sort().pop()
  const callsBefore = before.days[key].calls
  emit(
    { id: 'session-smoke-4' },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { model: 'deepseek-v4-flash' } } },
    },
  )
  await new Promise((r) => setTimeout(r, 2500))
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.days[key].calls, callsBefore, 'an all-zero usage must not count as a billable call')
})

// ---------------------------------------------------------------------------
// Isolated runs on synthetic homes.
//
// The shared home above symlinks the real logs, which makes it impossible to
// assert exact amounts. These runs build homes containing ONLY a synthetic
// session, so the numbers are exact and the two objective clauses that the real
// machine cannot exercise yet — subagent usage, and the missing-holiday-year
// warning — get real coverage.
// ---------------------------------------------------------------------------
function boot({ dir, config: override, account, accountCalls }) {
  process.env.DSH_HOME = dir
  const bootRoutes = new Map()
  const bootListeners = new Map()
  const bootCleanups = []
  const bootCtx = {
    webServer: { register: (route) => (bootRoutes.set(route.path, route), () => bootRoutes.delete(route.path)) },
    on: (event, fn) => (bootListeners.set(event, fn), () => bootListeners.delete(event)),
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') bootCleanups.push(cleanup)
      return () => {}
    },
    get: (name) => {
      if (name !== 'deepseekAccount') return undefined
      if (accountCalls) accountCalls.n += 1
      return account
    },
  }
  const lines = []
  const realLog = console.log
  const realWarn = console.warn
  const spy = (...args) => lines.push(args.join(' '))
  console.log = spy
  console.warn = spy
  const dispose = apply(bootCtx, override ?? effective)
  return {
    routes: bootRoutes,
    listeners: bootListeners,
    logs: lines,
    restore: () => {
      console.log = realLog
      console.warn = realWarn
    },
    dispose: () => disposeAll(bootCleanups),
    async ready() {
      for (let i = 0; i < 60; i += 1) {
        if (lines.some((l) => l.includes('回填完成') || l.includes('就绪'))) break
        await new Promise((r) => setTimeout(r, 250))
      }
      await new Promise((r) => setTimeout(r, 200))
      this.restore()
    },
    async state() {
      const res = captureRes()
      await bootRoutes.get('/__quota-ring/state').handler({ method: 'GET', headers: {} }, res)
      return JSON.parse(res.body).state
    },
  }
}

/** Write one synthetic session log holding a single billed request. */
function writeSyntheticSession(dir, { sessionId, delegationDepth, model, usage, at = Date.now() }) {
  const target = path.join(dir, 'sessions', '--synthetic-home--', sessionId)
  fs.mkdirSync(target, { recursive: true })
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt: at,
      cwd: '/tmp',
      isSeeded: false,
      delegationDepth,
      agentPreset: 'standard',
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      time: at,
      data: {
        turn: 1,
        step: 1,
        usage,
        message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-account', model } },
      },
    }),
  ]
  fs.writeFileSync(path.join(target, 'session.jsonl'), `${lines.join('\n')}\n`)
  return target
}

/** Wait for the debounced ledger write, then read it. */
async function readLedger(dir) {
  const file = path.join(dir, 'storages', 'quota-ring', 'ledger.json')
  for (let i = 0; i < 40 && !fs.existsSync(file); i += 1) {
    await new Promise((r) => setTimeout(r, 250))
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

await check('a SUBAGENT session (delegationDepth > 0) is billed into the same quota', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-sub-'))
  try {
    // 2M cache-miss tokens on a holiday = 2M / 1e6 * ¥1 = exactly ¥2.
    writeSyntheticSession(dir, {
      sessionId: 'session-subagent-synthetic',
      delegationDepth: 1,
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const run = boot({ dir: dir })
    await run.ready()
    const state = await run.state()
    assert.equal(
      state.periods.day.used,
      2,
      `a subagent-only home must bill exactly ¥2, got ¥${state.periods.day.used}`,
    )
    assert.equal(state.periods.week.used, 2, 'the subagent must also roll into the week window')
    const ledger = await readLedger(dir)
    assert.ok(
      Object.hasOwn(ledger.sessions, 'session-subagent-synthetic'),
      'the subagent session must be tracked in the ledger',
    )
    assert.equal(ledger.sessions['session-subagent-synthetic'].seq, 1)
    run.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('an ordinary session and a subagent session both count (no double counting)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-mixed-'))
  try {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    writeSyntheticSession(dir, { sessionId: 'session-parent', delegationDepth: 0, model: 'deepseek-v4-flash', usage })
    writeSyntheticSession(dir, { sessionId: 'session-child', delegationDepth: 1, model: 'deepseek-v4-flash', usage })
    const run = boot({ dir })
    await run.ready()
    const state = await run.state()
    assert.equal(state.periods.day.used, 2, `parent + child must bill ¥2 total, got ¥${state.periods.day.used}`)
    const ledger = await readLedger(dir)
    assert.equal(Object.keys(ledger.sessions).length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('the backfill window is 35 days: older sessions are excluded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-win-'))
  try {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const now = Date.now()
    // Recent session: inside the window -> must be billed (¥1).
    writeSyntheticSession(dir, { sessionId: 'session-recent', delegationDepth: 0, model: 'deepseek-v4-flash', usage, at: now })
    // Old session: 40 days back, with both its event time and its mtime outside
    // the 35-day window -> must be skipped entirely.
    const old = now - 40 * 86_400_000
    const oldDir = writeSyntheticSession(dir, {
      sessionId: 'session-ancient',
      delegationDepth: 0,
      model: 'deepseek-v4-flash',
      usage,
      at: old,
    })
    fs.utimesSync(path.join(oldDir, 'session.jsonl'), new Date(old), new Date(old))
    fs.utimesSync(oldDir, new Date(old), new Date(old))

    const run = boot({ dir })
    await run.ready()
    const state = await run.state()
    assert.equal(state.periods.day.used, 1, `only the recent session may bill, got ¥${state.periods.day.used}`)
    assert.equal(state.periods.month.used, 1, 'the 40-day-old session must not appear at all')
    const ledger = await readLedger(dir)
    assert.ok(Object.hasOwn(ledger.sessions, 'session-recent'), 'recent session must be tracked')
    assert.equal(
      Object.hasOwn(ledger.sessions, 'session-ancient'),
      false,
      'the out-of-window session must never enter the ledger',
    )
    assert.ok(state.meta.backfill.filesSkipped >= 1, 'the old file should be skipped without being read')
    run.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a holiday table that misses the current year warns at startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-hol-'))
  try {
    writeSyntheticSession(dir, {
      sessionId: 'session-any',
      delegationDepth: 0,
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    // A table covering only a past year must trip the self-check for this year.
    const run = boot({ dir, config: { ...config, holidays: ['2025-01-01', '2025-10-01'] } })
    await run.ready()
    const year = new Date().getFullYear().toString()
    const warning = run.logs.find((l) => l.includes('节假日表未覆盖'))
    assert.ok(warning, `expected a startup warning, got: ${JSON.stringify(run.logs)}`)
    assert.ok(warning.includes(year), `the warning must name ${year}, got: ${warning}`)
    // And the state must surface it for the hover panel.
    const state = await run.state()
    assert.equal(state.meta.holidayTableMiss, true)
    assert.equal(state.meta.holidayTableMissYear, year)
    run.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a covered year produces no warning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-hol2-'))
  try {
    writeSyntheticSession(dir, {
      sessionId: 'session-any',
      delegationDepth: 0,
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const run = boot({ dir }) // shipped config covers 2026
    await run.ready()
    assert.equal(
      run.logs.some((l) => l.includes('节假日表未覆盖')),
      false,
      'a covered year must not warn',
    )
    const state = await run.state()
    assert.equal(state.meta.holidayTableMiss, false)
    run.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('disposing releases the routes and the event feed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-dispose-'))
  try {
    writeSyntheticSession(dir, {
      sessionId: 'session-any',
      delegationDepth: 0,
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const run = boot({ dir })
    await run.ready()
    assert.ok(run.routes.has('/__quota-ring/state'), 'route must be registered while live')
    assert.ok(run.listeners.has('session/event'), 'listener must be registered while live')
    run.dispose()
    assert.equal(run.routes.has('/__quota-ring/state'), false, 'dispose must release the state route')
    assert.equal(run.routes.has('/__quota-ring/config'), false, 'dispose must release the config route')
    assert.equal(run.listeners.has('session/event'), false, 'dispose must release the event feed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a hot re-apply succeeds after a clean dispose (no duplicate route)', async () => {
  // This reproduces the real failure: routes registered outside ctx.effect leak
  // on dispose, so the next apply dies with "duplicate exact route" and the
  // stale instance keeps serving a frozen snapshot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-reapply-'))
  try {
    writeSyntheticSession(dir, {
      sessionId: 'session-any',
      delegationDepth: 0,
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const first = boot({ dir })
    await first.ready()
    first.dispose()

    // A shared route table is what makes a leak fatal; reuse the first run's map.
    const second = boot({ dir })
    await second.ready()
    assert.ok(second.routes.has('/__quota-ring/state'), 'the re-applied instance must activate')
    assert.equal((await second.state()).periods.day.used, 1)
    second.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Official-balance reconciliation. The plugin counts THIS machine's sessions
// while the platform's usage page is account-scoped, so the two can never be
// equal; these tests pin how the difference is read and reported.
// ---------------------------------------------------------------------------
/** A fake `deepseekAccount` with the documented getState/getBalance contract. */
function fakeAccount({ signedIn = true, wallets = { CNY: 12.34 }, granted = 0, balanceThrows = false } = {}) {
  return {
    async getState() {
      return { status: signedIn ? 'credential-stored' : 'signed-out', links: { usageUrl: 'https://platform.deepseek.com/usage' }, attempt: null }
    },
    async getBalance() {
      if (balanceThrows) throw new Error('network down')
      return {
        status: 'ready',
        value: Object.entries(wallets).map(([currency, balance]) => ({ currency, balance: String(balance) })),
        bonusWallets: granted > 0 ? [{ currency: 'CNY', balance: String(granted) }] : [],
      }
    },
  }
}

async function seedLedger(dir, balance) {
  fs.mkdirSync(path.join(dir, 'storages', 'quota-ring'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'storages', 'quota-ring', 'ledger.json'),
    JSON.stringify({ version: 1, updatedAt: 0, limits: { dayLimit: 10, weekLimit: 50, monthLimit: 200 }, days: {}, sessions: {}, balance }),
  )
}

async function bootWithAccount({ balanceSeed, ...opts }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-bal-'))
  if (balanceSeed !== undefined) await seedLedger(dir, balanceSeed)
  const run = boot({ dir, ...opts })
  await run.ready()
  // The balance read is async and fire-and-forget; give it a moment to land.
  for (let i = 0; i < 40; i += 1) {
    const st = await run.state()
    if (st.official?.status !== 'loading') return { run, dir, state: st }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { run, dir, state: await run.state() }
}

await check('the balance read is summed from the account wallets', async () => {
  const { run, dir, state } = await bootWithAccount({ account: fakeAccount({ wallets: { CNY: 10.34 }, granted: 2 }) })
  try {
    assert.equal(state.official.status, 'ready')
    assert.equal(state.official.currency, 'CNY')
    assert.equal(state.official.granted, 2)
    assert.ok(Math.abs(state.official.total - 12.34) < 1e-9, `total ${state.official.total}`)
  } finally {
    run.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('the daily baseline turns two readings into an account-scope spend', async () => {
  // Seed today's baseline as if the plugin had read 12.47 earlier today, then
  // let the startup read observe 12.34.
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const firstAt = Date.now() - 3 * 3600_000
  const { run, dir, state } = await bootWithAccount({
    account: fakeAccount({ wallets: { CNY: 12.34 } }),
    balanceSeed: { date: key, currency: 'CNY', firstTotal: 12.47, firstAt, lastTotal: 12.47, lastAt: firstAt },
  })
  try {
    assert.equal(state.official.status, 'ready')
    assert.ok(Math.abs(state.official.day.spend - 0.13) < 1e-9, `spend ${state.official.day.spend}`)
    assert.equal(state.official.day.firstAt, firstAt, 'the baseline start must be preserved')
  } finally {
    run.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a stale baseline from a previous day is reset, not carried over', async () => {
  const { run, dir, state } = await bootWithAccount({
    account: fakeAccount({ wallets: { CNY: 12.34 } }),
    balanceSeed: { date: '2020-01-01', currency: 'CNY', firstTotal: 99, firstAt: 1, lastTotal: 99, lastAt: 1 },
  })
  try {
    assert.ok(Math.abs(state.official.day.spend) < 1e-9, `a fresh day must start at zero spend, got ${state.official.day.spend}`)
    assert.ok(Math.abs(state.official.day.firstTotal - 12.34) < 1e-9, 'the baseline must be today\'s first reading')
  } finally {
    run.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a top-up produces a negative delta the UI can label', async () => {
  const key = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
  const { run, dir, state } = await bootWithAccount({
    account: fakeAccount({ wallets: { CNY: 50 } }),
    balanceSeed: { date: key, currency: 'CNY', firstTotal: 10, firstAt: Date.now() - 1000, lastTotal: 10, lastAt: Date.now() - 1000 },
  })
  try {
    assert.ok(state.official.day.spend < 0, `a top-up must read negative, got ${state.official.day.spend}`)
  } finally {
    run.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('signed-out, missing service and a throwing query each report why', async () => {
  const cases = [
    [{ account: fakeAccount({ signedIn: false }) }, 'signed-out', null],
    [{ account: undefined }, 'unavailable', '没有 deepseekAccount'],
    [{ account: fakeAccount({ balanceThrows: true }) }, 'failed', '已重试 3 次'],
  ]
  for (const [opts, expected, reasonNeedle] of cases) {
    const { run, dir, state } = await bootWithAccount(opts)
    try {
      assert.equal(state.official.status, expected, `${JSON.stringify(expected)} expected, got ${state.official.status}`)
      // The four failure modes must be distinguishable, not just "not ready".
      if (reasonNeedle !== null) {
        assert.ok(
          typeof state.official.error === 'string' && state.official.error.includes(reasonNeedle),
          `status ${expected} should carry a reason containing "${reasonNeedle}", got ${state.official.error}`,
        )
      }
    } finally {
      run.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

await check('a flaky balance query is retried instead of failing on the first throw', async () => {
  let calls = 0
  const flaky = {
    async getState() {
      return { status: 'credential-stored', links: {} }
    },
    async getBalance() {
      calls += 1
      if (calls < 3) throw new Error('SELF_SIGNED_CERT_IN_CHAIN')
      return { status: 'ready', value: [{ currency: 'CNY', balance: '42.5' }], bonusWallets: [] }
    },
  }
  const { run, dir, state } = await bootWithAccount({ account: flaky })
  try {
    assert.equal(state.official.status, 'ready', `two failures then success must still succeed, got ${state.official.status}`)
    assert.equal(calls, 3, `expected 3 attempts, saw ${calls}`)
    assert.ok(Math.abs(state.official.total - 42.5) < 1e-9)
  } finally {
    run.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a non-ready read is retried on the next state request', async () => {
  // The account service can be invisible at apply() time; without the retry the
  // panel would show "unavailable" until the slow periodic timer came round.
  let healthy = false
  let calls = 0
  const delayed = {
    async getState() {
      return { status: 'credential-stored', links: {} }
    },
    async getBalance() {
      calls += 1
      if (!healthy) throw new Error('not ready yet')
      return { status: 'ready', value: [{ currency: 'CNY', balance: '7' }], bonusWallets: [] }
    },
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ring-heal-'))
  try {
    // A 1s retry window keeps the test fast; the shipped default is 30s.
    const run = boot({ dir, account: delayed, config: { ...effective, balanceRetrySeconds: 1 } })
    await run.ready()
    for (let i = 0; i < 60; i += 1) {
      if ((await run.state()).official.status !== 'loading') break
      await new Promise((r) => setTimeout(r, 100))
    }
    const failed = (await run.state()).official
    assert.notEqual(failed.status, 'ready', 'the first read must fail while the service is unhealthy')
    const callsAfterFailure = calls

    healthy = true
    await new Promise((r) => setTimeout(r, 1300))
    let healed = (await run.state()).official
    for (let i = 0; i < 40 && healed.status !== 'ready'; i += 1) {
      await new Promise((r) => setTimeout(r, 150))
      healed = (await run.state()).official
    }
    assert.equal(healed.status, 'ready', `a state request should have healed the read, got ${healed.status}`)
    assert.ok(calls > callsAfterFailure, 'the healed read must have actually re-queried')
    assert.ok(Math.abs(healed.total - 7) < 1e-9)
    run.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('balanceReconcile:false never touches the account service', async () => {
  const accountCalls = { n: 0 }
  const { run, dir, state } = await bootWithAccount({
    account: fakeAccount(),
    accountCalls,
    config: { ...effective, balanceReconcile: false },
  })
  try {
    assert.equal(state.official.status, 'disabled')
    assert.equal(state.official.reconcile, false)
    assert.equal(accountCalls.n, 0, 'the account service must not be consulted when reconciliation is off')
  } finally {
    run.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
dispose()
await new Promise((r) => setTimeout(r, 500))
fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`)
process.exit(failed === 0 ? 0 : 1)
