/**
 * dsh-quota-ring — Browser half.
 *
 * Plain JavaScript, no JSX, no build step. The DSH module loader hands us
 * `require`, and everything visual is built with React.createElement.
 *
 * Two seats are registered:
 *   conversation.composer.dock — the ambient row below the composer: the chip.
 *   settings.section — the "额度" page holding the three quota inputs.
 *
 * Money accounting lives entirely in the Host half; this file only renders and
 * posts the three limits back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-ring',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // ---------------------------------------------------------------------
    // Text
    // ---------------------------------------------------------------------
    const DICT = {
      zh: {
        sectionLabel: '额度',
        title: '额度明细',
        ringLabel: '周额度',
        day: '日',
        week: '周',
        month: '月',
        resetIn: '后重置',
        over: '已超额',
        today: '今日',
        cacheHit: '缓存命中',
        balance: '官方余额',
        balanceAccountScope: '账号级',
        balanceToday: '本日减少',
        balanceSince: (time) => `减少量自 ${time} 起算`,
        balanceLoading: '读取中…',
        balanceDisabled: '已在行配置关闭对账',
        balanceSignedOut: '未登录，读不到余额',
        balanceUnavailable: '账号服务不可用',
        balanceFailed: '余额查询失败',
        balanceToppedUp: '本日有充值',
        scopeNote: '额度按本机 DSH 会话计；官方余额是账号级，含其他设备与工具',
        phasePeak: '当前 峰价',
        phaseOff: '当前 谷价',
        reasonHoliday: '法定节假日',
        reasonWeekend: '周末',
        reasonOffHours: '非高峰时段',
        reasonPeak: '工作日高峰时段',
        reasonDisabled: '峰谷计价已关闭',
        loading: '读取中…',
        hostUnreachable: '插件宿主未就绪（需重启 DSH）',
        dayLimit: '日额度',
        weekLimit: '周额度',
        monthLimit: '月额度',
        unit: '元',
        saveHint: '修改后自动保存，立即生效。',
        saved: '已保存',
        saving: '保存中…',
        saveFailed: '保存失败',
        quotaHint: '额度用于角落那枚进度环与颜色提醒；留空或 0 表示不限制。',
        holidayMiss: (year) => `节假日表未覆盖 ${year} 年，该年工作日假期会被按峰价计算。`,
        overBy: (amount) => `超出 ¥${amount}`,
        noUsage: '暂无用量',
      },
      en: {
        sectionLabel: 'Quota',
        title: 'Quota detail',
        ringLabel: 'Week quota',
        day: 'Day',
        week: 'Week',
        month: 'Month',
        resetIn: 'until reset',
        over: 'over',
        today: 'Today',
        cacheHit: 'cache hit',
        balance: 'Balance',
        balanceAccountScope: 'account-wide',
        balanceToday: 'spent today',
        balanceSince: (time) => `decrease measured from ${time}`,
        balanceLoading: 'reading…',
        balanceDisabled: 'reconciliation off in row config',
        balanceSignedOut: 'not signed in',
        balanceUnavailable: 'account service unavailable',
        balanceFailed: 'balance query failed',
        balanceToppedUp: 'topped up today',
        scopeNote: 'Quotas count this machine\'s DSH sessions; the official balance is account-wide',
        phasePeak: 'Peak price',
        phaseOff: 'Off-peak price',
        reasonHoliday: 'public holiday',
        reasonWeekend: 'weekend',
        reasonOffHours: 'outside peak hours',
        reasonPeak: 'weekday peak hours',
        reasonDisabled: 'peak pricing disabled',
        loading: 'Loading…',
        hostUnreachable: 'Plugin host not ready (restart DSH)',
        dayLimit: 'Daily limit',
        weekLimit: 'Weekly limit',
        monthLimit: 'Monthly limit',
        unit: 'CNY',
        saveHint: 'Saved automatically as you type.',
        saved: 'Saved',
        saving: 'Saving…',
        saveFailed: 'Save failed',
        quotaHint: 'Limits drive the corner ring and its colour. Empty or 0 means unlimited.',
        holidayMiss: (year) => `Holiday table does not cover ${year}; weekday holidays bill at peak price.`,
        overBy: (amount) => `over by ¥${amount}`,
        noUsage: 'No usage yet',
      },
    }

    function pickLocale(raw) {
      return typeof raw === 'string' && raw.toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------
    function money(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n === 0) return '0.00'
      if (n < 0.01) return n.toFixed(3)
      if (n < 1) return n.toFixed(3)
      return n.toFixed(2)
    }

    function compact(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
      return String(Math.round(n))
    }

    function countdown(ms) {
      const s = Math.floor((Number(ms) || 0) / 1000)
      if (s <= 0) return '0m'
      const d = Math.floor(s / 86400)
      const hh = Math.floor((s % 86400) / 3600)
      const mm = Math.floor((s % 3600) / 60)
      if (d > 0) return `${d}d${hh}h`
      if (hh > 0) return `${hh}h${String(mm).padStart(2, '0')}m`
      return `${mm}m`
    }

    function clockTime(ms) {
      try {
        return new Date(Number(ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      } catch {
        return '—'
      }
    }

    function percent(ratio) {
      const n = Number(ratio) || 0
      const value = n * 100
      if (value > 0 && value < 1) return '<1%'
      return `${Math.round(value)}%`
    }

    // The ring is neutral while the quota is comfortable and only takes on a
    // warning colour when it has something to say. This is DSH's own convention:
    // the native usage ring beside it is plain grey at 45%. Painting the
    // comfortable state saturated green made the chip stand out from the row
    // rather than belong to it.
    const LEVEL_COLOR = {
      ok: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #8b8b93))',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      none: 'var(--dsw-alias-border-l2, #9aa0a6)',
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const CSS = `
/* The chip lives in the composer dock: the ambient row BELOW the composer,
   alongside the native status line ("缓存命中 98%"). Layout, spacing and
   typography there belong to DSH, so this contributes no surface of its own --
   it is an inline status item that tints on hover, like any other dock entry. */
.qr-root{position:relative;display:inline-flex;align-items:center;gap:6px;
  font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;
  /* Exactly the colour the native dock statistics use. Anything darker made the
     chip read as a different class of thing sitting in the same row. */
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#8b8b93));
  padding:0 6px;border-radius:6px;cursor:default;
  transition:background-color .15s ease,color .15s ease}
.qr-root:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary,#1a1a1a)}
.qr-root.qr-loading{cursor:default;opacity:.65}
.qr-root.qr-loading:hover{background:transparent;color:var(--dsw-alias-label-secondary,#6b7280)}
.qr-chip-label{white-space:nowrap}
.qr-chip-pct{white-space:nowrap}
.qr-chip-value{white-space:nowrap}
.qr-ring{display:block;flex:0 0 auto}
.qr-track{stroke:var(--dsw-alias-border-l1,rgba(128,128,128,.22))}
.qr-fill{transition:stroke-dasharray .4s ease,stroke .3s ease}
.qr-num{font-size:9px;font-weight:600;fill:var(--dsw-alias-label-primary,#1a1a1a)}
/* Opens UPWARD, because the dock sits at the bottom of the window, and centred
   on the chip so it never runs off either edge. */
.qr-panel{pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .14s ease,transform .14s ease;
  position:absolute;bottom:calc(100% + 10px);left:50%;margin-left:-145px;width:290px;padding:12px;border-radius:12px;z-index:20;
  background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff)));
  backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  box-shadow:0 10px 30px rgba(0,0,0,.16);text-align:left}
.qr-root:hover .qr-panel{pointer-events:auto;opacity:1;transform:translateY(0)}
.qr-panel-title{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#6b7280);margin:0 0 8px}
.qr-row{display:grid;grid-template-columns:34px 1fr auto;gap:8px;align-items:baseline;padding:5px 0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.qr-row:first-of-type{border-top:0}
.qr-row-name{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.qr-row-amount{font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);font-variant-numeric:tabular-nums}
.qr-row-pct{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.qr-row-reset{grid-column:2 / -1;font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af);margin-top:-2px}
.qr-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));margin:9px 0}
.qr-line{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.65;display:flex;justify-content:space-between;gap:10px}
.qr-line span{min-width:0}
.qr-line b{font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);font-variant-numeric:tabular-nums;white-space:nowrap}
.qr-note{font-size:10px;line-height:1.5;margin-top:5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#8b8b93))}
.qr-warn{font-size:11px;line-height:1.5;margin-top:6px;color:var(--dsw-alias-state-warn-primary,#b45309)}
.qr-err{font-size:11px;line-height:1.5;margin-top:6px;color:var(--dsw-alias-state-error-primary,#b91c1c)}
.qr-settings{display:flex;flex-direction:column;gap:14px;max-width:520px}
.qr-field{display:flex;flex-direction:column;gap:6px}
.qr-field label{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.qr-input-wrap{display:flex;align-items:center;gap:8px}
.qr-prefix{font-size:13px;color:var(--dsw-alias-label-secondary,#6b7280)}
.qr-input{flex:1;min-width:0;height:32px;padding:0 10px;border-radius:8px;font-size:13px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-1,transparent);
  color:var(--dsw-alias-label-primary,#1a1a1a);outline:none;font-variant-numeric:tabular-nums}
.qr-input:focus{border-color:var(--dsw-alias-brand-primary,#3b82f6)}
.qr-status{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);min-height:16px}
.qr-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.6}
`

    // ---------------------------------------------------------------------
    // A minimal observable store (no external state library).
    // ---------------------------------------------------------------------
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        get: () => snapshot,
        set: (next) => {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      const [snapshot, setSnapshot] = React.useState(store.get())
      React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store])
      return snapshot
    }

    /** Ticks once a second so countdowns advance without refetching. */
    function useTicker(enabled) {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        if (!enabled) return undefined
        const id = setInterval(() => setTick((n) => n + 1), 1000)
        return () => clearInterval(id)
      }, [enabled])
    }

    // ---------------------------------------------------------------------
    // Ring
    // ---------------------------------------------------------------------
    function Ring({ ratio, level, size = 36, stroke, showLabel = true }) {
      // The dock ring is tiny and carries no label; the bigger standalone ring
      // does. Deriving the stroke from the size keeps both proportional.
      const strokeWidth = Number(stroke) > 0 ? Number(stroke) : Math.max(2, Math.round(size / 9))
      const radius = (size - strokeWidth) / 2
      const circumference = 2 * Math.PI * radius
      const clamped = Math.max(0, Math.min(1, Number(ratio) || 0))
      const color = LEVEL_COLOR[level] ?? LEVEL_COLOR.none
      return h(
        'svg',
        { className: 'qr-ring', width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
        h('circle', {
          className: 'qr-track',
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          strokeWidth,
        }),
        h('circle', {
          className: 'qr-fill',
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          stroke: color,
          strokeWidth,
          strokeLinecap: 'round',
          strokeDasharray: `${circumference * clamped} ${circumference}`,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        }),
        showLabel
          ? h(
              'text',
              { className: 'qr-num', x: '50%', y: '50%', textAnchor: 'middle', dominantBaseline: 'central' },
              percent(ratio),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Bottom-right badge
    // ---------------------------------------------------------------------
    function QuotaBadge(props) {
      const store = props.store
      const snapshot = useStore(store)
      const [tickNow, setTickNow] = React.useState(Date.now())
      React.useEffect(() => {
        const id = setInterval(() => setTickNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [])

      const t = DICT[snapshot.locale] ?? DICT.zh
      const state = snapshot.state

      if (!state) {
        const text = snapshot.status === 'error' ? t.hostUnreachable : t.loading
        return h(
          'div',
          { className: 'qr-root qr-loading' },
          h(Ring, { ratio: 0, level: 'none', size: 15, stroke: 2, showLabel: false }),
          h('span', { className: 'qr-chip-label' }, text),
        )
      }

      const week = state.periods.week
      const rows = [
        ['day', t.day, state.periods.day],
        ['week', t.week, state.periods.week],
        ['month', t.month, state.periods.month],
      ]

      const phaseText = state.phase.peak ? t.phasePeak : t.phaseOff
      const reasonKey = {
        peak: t.reasonPeak,
        holiday: t.reasonHoliday,
        weekend: t.reasonWeekend,
        offhours: t.reasonOffHours,
        disabled: t.reasonDisabled,
      }[state.phase.reason]

      const cacheHitPct =
        state.today.cacheHitRate === null || state.today.cacheHitRate === undefined
          ? '—'
          : `${(state.today.cacheHitRate * 100).toFixed(1)}%`

      return h(
        'div',
        { className: 'qr-root' },
        h(
          'div',
          { className: 'qr-root' },
          h(Ring, {
            ratio: week.limit > 0 ? week.ratio : 0,
            level: week.limit > 0 ? week.level : 'none',
            size: 15,
            stroke: 2,
            showLabel: false,
          }),
          // The ring stroke carries the status colour, so the numbers stay
          // neutral and the row reads like any other dock statistic.
          h('span', { className: 'qr-chip-pct' }, percent(week.ratio)),
          h('span', { className: 'qr-chip-label' }, t.ringLabel),
          h(
            'span',
            { className: 'qr-chip-value' },
            week.limit > 0 ? `¥${money(week.used)} / ¥${money(week.limit)}` : `¥${money(week.used)}`,
          ),
          h(
            'div',
            { className: 'qr-panel' },
            h('p', { className: 'qr-panel-title' }, t.title),
            ...rows.map(([key, name, entry]) =>
              h(
                'div',
                { key, className: 'qr-row' },
                h('span', { className: 'qr-row-name' }, name),
                h(
                  'span',
                  { className: 'qr-row-amount' },
                  entry.limit > 0
                    ? `¥${money(entry.used)} / ¥${money(entry.limit)}`
                    : `¥${money(entry.used)} · ${t.noUsage}`,
                ),
                h(
                  'span',
                  { className: 'qr-row-pct', style: { color: LEVEL_COLOR[entry.level] } },
                  entry.limit > 0 ? percent(entry.ratio) : '—',
                ),
                h(
                  'span',
                  { className: 'qr-row-reset' },
                  entry.resetAt > tickNow
                    ? `${countdown(entry.resetAt - tickNow)} ${t.resetIn}`
                    : t.resetIn,
                ),
              ),
            ),
            h('div', { className: 'qr-sep' }),
            h(
              'div',
              { className: 'qr-line' },
              h('span', null, t.today),
              h('b', null, `${compact(state.today.totalTokens)} tok · ${t.cacheHit} ${cacheHitPct}`),
            ),
            h('div', { className: 'qr-line' }, h('span', null, '峰谷'), h('b', null, `${phaseText} · ${reasonKey}`)),
            ...balanceRows(state.official, t),
            ...rows
              .filter(([, , entry]) => entry.over > 0)
              .map(([key, name, entry]) =>
                h('div', { key: `over-${key}`, className: 'qr-err' }, `${name}${t.over}：${t.overBy(money(entry.over))}`),
              ),
            state.meta.holidayTableMiss
              ? h('div', { className: 'qr-warn' }, t.holidayMiss(state.meta.holidayTableMissYear))
              : null,
          ),
        ),
      )
    }

    /**
     * The reconciliation rows.
     *
     * The machine-scope quota and the account-scope balance legitimately differ
     * (other devices, other tools, and the billed calls DSH records no usage for),
     * so both are shown with their scope stated rather than a single number that
     * would look wrong against the platform's usage page.
     *
     * @param official - the Host's `official` state slice.
     * @param t - active dictionary.
     * @returns an array of panel rows (possibly with a trailing explanatory note).
     */
    function balanceRows(official, t) {
      if (!official || official.reconcile === false) {
        return [h('div', { className: 'qr-line' }, h('span', null, t.balance), h('b', null, t.balanceDisabled))]
      }
      const reasons = {
        loading: t.balanceLoading,
        disabled: t.balanceDisabled,
        'signed-out': t.balanceSignedOut,
        unavailable: t.balanceUnavailable,
        failed: t.balanceFailed,
      }
      if (official.status !== 'ready') {
        return [
          h('div', { className: 'qr-line' }, h('span', null, t.balance), h('b', null, reasons[official.status] ?? t.balanceLoading)),
        ]
      }
      const symbol = official.currency === 'USD' ? '$' : '¥'
      const money2 = (n) => `${symbol}${(Number(n) || 0).toFixed(2)}`
      const day = official.day
      const comparable = day && day.currency === official.currency && Number.isFinite(day.spend)
      // Keep the row itself short: a long label plus a long value wrapped into a
      // mess, so the qualifiers live in the note underneath.
      const right = comparable
        ? day.spend >= 0
          ? `${t.balanceToday} ${money2(day.spend)}`
          : t.balanceToppedUp
        : t.balanceAccountScope
      const note = comparable
        ? `${t.scopeNote} · ${t.balanceSince(clockTime(day.firstAt))}`
        : t.scopeNote
      return [
        h('div', { className: 'qr-line' }, h('span', null, t.balance), h('b', null, `${money2(official.total)} · ${right}`)),
        h('div', { className: 'qr-note' }, note),
      ]
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------
    function QuotaSettings(props) {
      const store = props.store
      const api = props.api
      const snapshot = useStore(store)
      const t = DICT[snapshot.locale] ?? DICT.zh
      const state = snapshot.state

      const [draft, setDraft] = React.useState({ dayLimit: '', weekLimit: '', monthLimit: '' })
      const [status, setStatus] = React.useState('idle')
      const seeded = React.useRef(false)
      const timer = React.useRef(null)

      // Seed the inputs once the first state arrives, but never while the user
      // is mid-edit.
      React.useEffect(() => {
        if (seeded.current || !state) return
        seeded.current = true
        setDraft({
          dayLimit: String(state.limits.dayLimit ?? ''),
          weekLimit: String(state.limits.weekLimit ?? ''),
          monthLimit: String(state.limits.monthLimit ?? ''),
        })
      }, [state])

      React.useEffect(() => () => clearTimeout(timer.current), [])

      const commit = (next) => {
        setDraft(next)
        setStatus('saving')
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          void (async () => {
            try {
              await api.saveLimits(next)
              setStatus('saved')
            } catch {
              setStatus('failed')
            }
          })()
        }, 400)
      }

      const fields = [
        ['dayLimit', t.dayLimit],
        ['weekLimit', t.weekLimit],
        ['monthLimit', t.monthLimit],
      ]

      const statusText =
        status === 'saving' ? t.saving : status === 'saved' ? t.saved : status === 'failed' ? t.saveFailed : ''

      return h(
        'div',
        { className: 'qr-settings' },
        ...fields.map(([key, label]) =>
          h(
            'div',
            { key, className: 'qr-field' },
            h('label', { htmlFor: `qr-${key}` }, label),
            h(
              'div',
              { className: 'qr-input-wrap' },
              h('span', { className: 'qr-prefix' }, '¥'),
              h('input', {
                id: `qr-${key}`,
                className: 'qr-input',
                type: 'number',
                min: '0',
                step: '1',
                inputMode: 'decimal',
                value: draft[key],
                disabled: !state,
                onChange: (event) => commit({ ...draft, [key]: event.target.value }),
              }),
            ),
          ),
        ),
        h('p', { className: 'qr-hint' }, t.quotaHint),
        h('p', { className: 'qr-hint' }, t.saveHint),
        h('p', { className: 'qr-status' }, statusText),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------
    function apply(ctx) {
      const store = createStore({ status: 'loading', state: null, error: null, locale: 'zh' })

      const readLocale = () => {
        try {
          const snapshot = ctx.get('locale')?.getSnapshot?.()
          return pickLocale(snapshot?.active)
        } catch {
          return 'zh'
        }
      }
      store.set({ ...store.get(), locale: readLocale() })

      let disposed = false
      let inflight = false

      async function refresh() {
        if (disposed || inflight) return
        inflight = true
        try {
          const response = await fetch('/__quota-ring/state', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (disposed) return
          store.set({ status: 'ready', state: payload?.state ?? null, error: null, locale: readLocale() })
        } catch (error) {
          if (disposed) return
          store.set({ ...store.get(), status: 'error', error: String(error?.message ?? error) })
        } finally {
          inflight = false
        }
      }

      async function saveLimits(next) {
        const payload = {}
        for (const key of ['dayLimit', 'weekLimit', 'monthLimit']) {
          const value = Number(next?.[key])
          payload[key] = Number.isFinite(value) && value > 0 ? value : 0
        }
        const response = await fetch('/__quota-ring/config', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
        if (!disposed) store.set({ ...store.get(), status: 'ready', state: body.state ?? store.get().state })
      }

      let lastFetchAt = Date.now()
      const trackedRefresh = () => {
        lastFetchAt = Date.now()
        return refresh()
      }
      const api = { refresh: trackedRefresh, saveLimits }

      const styleDispose = insertStyles()
      if (typeof styleDispose === 'function') {
        ctx.effect(() => () => styleDispose(), 'quota-ring: styles')
      }

      void trackedRefresh()

      // Poll on the cadence the Host advertises, but never while the tab is
      // hidden — a background tab must not keep waking the Host.
      const pollId = setInterval(() => {
        const state = store.get().state
        const every = Math.max(10, Number(state?.meta?.refreshSeconds) || 30) * 1000
        if (document.visibilityState === 'visible' && Date.now() - lastFetchAt >= every) void trackedRefresh()
      }, 1000)

      const onVisible = () => {
        if (document.visibilityState === 'visible') void trackedRefresh()
      }
      document.addEventListener('visibilitychange', onVisible)
      const onLocale = () => store.set({ ...store.get(), locale: readLocale() })
      window.addEventListener('languagechange', onLocale)

      ctx.effect(
        () => () => {
          disposed = true
          clearInterval(pollId)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('languagechange', onLocale)
        },
        'quota-ring: timers',
      )

      const slots = ctx.get('slots')
      if (!slots) {
        console.error('[quota-ring] slots 服务不可用，界面未挂载（inject 声明应当阻止走到这里）')
        return
      }

      // Registered in the composer dock (the ambient row below the composer,
      // beside the native status line) rather than the frame-wide overlay. A
      // floating overlay cannot belong to a layout -- it only sits on top of one
      // -- so the dock lets DSH own the alignment, spacing and typography.
      ctx.effect(
        () =>
          slots.inject('conversation.composer.dock', () =>
            slots.register(
              { name: 'conversation.composer.dock', id: 'quota-ring-chip', order: 5, inject: () => ({ store }) },
              QuotaBadge,
            ),
          ),
        'quota-ring: dock chip',
      )

      ctx.effect(
        () =>
          slots.inject('settings.section', () =>
            slots.register(
              {
                name: 'settings.section',
                id: 'quota-ring',
                order: 35,
                label: DICT[readLocale()].sectionLabel,
                inject: () => ({ store, api }),
              },
              QuotaSettings,
            ),
          ),
        'quota-ring: settings slot',
      )
    }

    /** Inserts our stylesheet once and returns its disposer. */
    function insertStyles() {
      if (typeof document === 'undefined') return null
      const element = document.createElement('style')
      element.setAttribute('data-quota-ring', '')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => element.remove()
    }

    // `inject: ['slots']` is REQUIRED, not decoration. Without it Cordis calls
    // apply() immediately at boot, which can be BEFORE the `slots` service is
    // provided -- the guard below then returns early and NOTHING registers. That
    // silently killed the whole UI half on a cold start while a hot install
    // (page already fully booted) worked, which made it look random.
    return { name: 'quota-ring', inject: ['slots'], apply }
  },
})
