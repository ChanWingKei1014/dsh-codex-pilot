/**
 * dsh-codex-pilot —— 客户端半边(设置页「Codex 协作」大面板)。
 *
 * 加载方式: window.__ModuleLoader__.load({id, factory})(与 dsh-meme 同款),
 * **id 必须等于包名**,否则 ModuleLoader 会报 "loaded without registering"。
 *
 * 数据通道:
 *   - 首屏 GET  /dsh-codex-pilot/api/snapshot
 *   - 实时   SSE /dsh-codex-pilot/api/events
 *   - 动作   POST /dsh-codex-pilot/api/{answer,interrupt,open,settings,...}
 *
 * 页面结构: 大状态徽标(未干活/干活中/干活完成/干活失败/等你决策)
 *           → 四阶段进度条 → 需要你拍板时的操作区 → 会话列表 → 实时日志 → 设置
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-pilot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const API = '/dsh-codex-pilot/api'

    const CSS = `
.cxb-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);padding:2px 0 24px}
.cxb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.cxb-hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.cxb-badge{display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:999px;font-size:16px;font-weight:600;border:1px solid transparent}
.cxb-dot{width:12px;height:12px;border-radius:50%;flex:none}
.cxb-badge.idle{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.cxb-badge.idle .cxb-dot{background:#9aa0a6}
.cxb-badge.working{background:color-mix(in srgb,#3b82f6 14%,transparent);border-color:#3b82f6}
.cxb-badge.working .cxb-dot{background:#3b82f6;animation:cxb-pulse 1.1s ease-in-out infinite}
.cxb-badge.done{background:color-mix(in srgb,#22c55e 14%,transparent);border-color:#22c55e}
.cxb-badge.done .cxb-dot{background:#22c55e}
.cxb-badge.failed{background:color-mix(in srgb,#ef4444 14%,transparent);border-color:#ef4444}
.cxb-badge.failed .cxb-dot{background:#ef4444}
.cxb-badge.waiting{background:color-mix(in srgb,#f59e0b 16%,transparent);border-color:#f59e0b}
.cxb-badge.waiting .cxb-dot{background:#f59e0b;animation:cxb-pulse 1.1s ease-in-out infinite}
.cxb-heart{display:flex;align-items:flex-start;gap:9px;margin-top:10px;padding:9px 12px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.cxb-heart b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.cxb-heart .cxb-beat{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:cxb-pulse 1.6s ease-in-out infinite;flex:0 0 auto;margin-top:5px}
.cxb-heart.warn{background:color-mix(in srgb,#f59e0b 12%,transparent);border-color:#f59e0b;color:#a16207}
.cxb-heart.warn .cxb-beat{background:#f59e0b}
.cxb-heart.alarm{background:color-mix(in srgb,#ef4444 12%,transparent);border-color:#ef4444;color:#b91c1c}
.cxb-heart.alarm .cxb-beat{background:#ef4444;animation-duration:.7s}
@keyframes cxb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
.cxb-meta{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.cxb-meta b{color:var(--dsw-alias-label-primary);font-weight:600}
.cxb-steps{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.cxb-step{flex:1;min-width:130px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);position:relative;overflow:hidden}
.cxb-step .t{font-size:12px;font-weight:600}
.cxb-step .s{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.cxb-step.cur{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.cxb-step.ok{border-color:#22c55e}
.cxb-step.ok .t::after{content:" ✓";color:#22c55e}
.cxb-step.err{border-color:#ef4444}
.cxb-step.err .t::after{content:" ✕";color:#ef4444}
.cxb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cxb-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 13px;font-size:13px;cursor:pointer}
.cxb-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.cxb-btn:disabled{opacity:.5;cursor:default}
.cxb-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.cxb-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.cxb-btn.danger:hover{border-color:#ef4444;color:#ef4444}
.cxb-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.cxb-log{display:flex;flex-direction:column;gap:4px;max-height:340px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5}
.cxb-log .l{display:flex;gap:8px;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.cxb-log .l .ts{color:var(--dsw-alias-label-secondary);flex:none}
.cxb-log .l.tool{background:color-mix(in srgb,#3b82f6 8%,transparent)}
.cxb-log .l.reasoning{background:color-mix(in srgb,#8b5cf6 10%,transparent);font-style:italic}
.cxb-log .l.error{background:color-mix(in srgb,#ef4444 10%,transparent)}
.cxb-log .l.done{background:color-mix(in srgb,#22c55e 10%,transparent)}
.cxb-log .l.phase{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);font-weight:600}
.cxb-log .l.needs-you{background:color-mix(in srgb,#f59e0b 14%,transparent);font-weight:600}
.cxb-ask{border:1px solid #f59e0b;background:color-mix(in srgb,#f59e0b 10%,transparent);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.cxb-ask .q{font-size:13px}
.cxb-ask input,.cxb-ask textarea{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;width:100%;box-sizing:border-box;font-family:inherit}
.cxb-empty{color:var(--dsw-alias-label-secondary);padding:6px 0}
.cxb-thread{display:flex;gap:8px;align-items:center;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;flex-wrap:wrap}
.cxb-pill{font-size:11px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.cxb-settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.cxb-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.cxb-field label{color:var(--dsw-alias-label-secondary)}
.cxb-field select,.cxb-field input{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px}
.cxb-note{font-size:12px;color:var(--dsw-alias-label-secondary)}

/* ---- 输入框左下角的入口按钮(meme 右边) ---- */
.cxb-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;margin:0;transition:background .12s ease,color .12s ease,border-color .12s ease}
.cxb-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cxb-trigger.open{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cxb-trigger .cxb-trigger-dot{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;border:1.5px solid var(--dsw-alias-bg-layer-1);background:#9aa0a6}
.cxb-trigger .cxb-trigger-dot.working{background:#3b82f6;animation:cxb-pulse 1.1s ease-in-out infinite}
.cxb-trigger .cxb-trigger-dot.done{background:#22c55e}
.cxb-trigger .cxb-trigger-dot.failed{background:#ef4444}
.cxb-trigger .cxb-trigger-dot.waiting{background:#f59e0b;animation:cxb-pulse 1.1s ease-in-out infinite}

/* ---- 浮层面板(输入框按钮打开的那个) ---- */
.cxb-pop{position:fixed;z-index:901;left:16px;bottom:104px;width:min(520px,calc(100vw - 32px));max-height:min(76vh,760px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.30);padding:12px 14px}
.cxb-pop-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.cxb-pop-title{font-size:13px;font-weight:600}
.cxb-pop .cxb-card{padding:10px 12px;border-radius:10px}
.cxb-pop .cxb-log{max-height:220px}
.cxb-close{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:8px;width:26px;height:26px;line-height:1;cursor:pointer;font-size:15px}
.cxb-close:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.cxb-artifact{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;padding:2px 10px;border-radius:999px;font-family:inherit;transition:background .12s ease,border-color .12s ease}
.cxb-artifact:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);border-color:var(--dsw-alias-brand-primary)}
.cxb-conn-fail{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;padding:9px 12px;border-radius:10px;border:1px solid #ef4444;background:color-mix(in srgb,#ef4444 10%,transparent);font-size:12px;color:var(--dsw-alias-label-primary)}
`

    function injectCss() {
      const el = document.createElement('style')
      el.dataset.plugin = 'dsh-codex-pilot'
      el.textContent = CSS
      document.head.appendChild(el)
      return () => { try { el.remove() } catch { /* 忽略 */ } }
    }

    const STATUS_UI = {
      idle: { cls: 'idle', text: '未干活' },
      working: { cls: 'working', text: '干活中' },
      done: { cls: 'done', text: '干活完成' },
      failed: { cls: 'failed', text: '干活失败' },
      waiting_input: { cls: 'waiting', text: '等你决策' },
      waiting_approval: { cls: 'waiting', text: '等批准' },
    }

    const PHASES = [
      { id: 'requirements', name: '需求文档', by: 'codex' },
      { id: 'ui', name: 'UI 设计', by: 'codex' },
      { id: 'code', name: '写代码', by: 'DSH' },
      { id: 'acceptance', name: '测试验收', by: 'codex' },
    ]

    const fmtTime = (ms) => { try { return new Date(ms).toLocaleTimeString() } catch { return '' } }
    const shortId = (id) => (id ? String(id).slice(0, 8) + '…' : '')

    /**
     * 面板组件 —— 同一份实现复用到两个挂载点:
     *   mode='full'     → 设置页「Codex 协作」整页
     *   mode='popover'  → 输入框左下角按钮弹出的浮层(内容与交互完全一致,
     *                     只是收起设置区/历史任务,浮层里空间紧凑)
     */
    /**
     * 错误边界(函数式兜底): 面板内部任何渲染异常都只显示一张降级卡片,
     * 不让整个 slot 挂掉。
     *
     * 为什么必须有: slot 里的组件一旦抛错,DSH 会把那个 slot 的渲染拿掉 ——
     * 表现就是面板打不开、打开就闪退、输入框图标跟着消失。
     * 这里用 try/catch 包住真正的面板,任何异常都降级成一张可点"重试渲染"的卡片。
     */
    function PanelBoundary(props) {
      const [err, setErr] = React.useState(null)
      const [retryKey, setRetryKey] = React.useState(0)
      let child = null
      try {
        child = typeof props.children === 'function' ? props.children(retryKey) : props.children
      } catch (e) {
        try { console.error('[codex-pilot] 面板渲染出错:', e) } catch { /* 忽略 */ }
        if (!err) setErr(e)
        child = null
      }
      const errMsg = err ? String((err && err.message) || err) : null
      if (!errMsg) return child
      return React.createElement('div', { className: 'cxb-root' },
        React.createElement('div', { className: 'cxb-card' },
          React.createElement('div', { className: 'cxb-title' }, 'Codex 协作'),
          React.createElement('div', { className: 'cxb-empty' }, '⚠️ 面板渲染出错,已降级显示(不影响 Codex 干活):'),
          React.createElement('div', { className: 'cxb-empty', style: { fontFamily: 'ui-monospace,monospace', fontSize: 11 } },
            errMsg.slice(0, 300)),
          React.createElement('div', { className: 'cxb-row', style: { marginTop: 8 } },
            React.createElement('button', {
              className: 'cxb-btn',
              onClick: () => { setErr(null); setRetryKey((k) => k + 1) },
            }, '重试渲染'),
          ),
        ),
      )
    }

    function CodexPanel(props) {
      const mode = (props && props.mode) || 'full'
      const popover = mode === 'popover'
      /**
       * 会话 id: 从输入框按钮的 owner props 里拿(session 快照 / sessionId 都试)。
       * 有它 ⇒ 面板只显示"这个会话自己的任务";没有 ⇒ 设置页那种全局视角。
       */
      const panelSessionId = (props && (props.sessionId || (props.session && (props.session.id || props.session.sessionId)))) || null
      // initial: 仅供单元测试注入初始数据(真实环境靠下面的 effect 拉取)
      const initial = (props && props.initial) || null
      const [snap, setSnap] = React.useState(initial ? initial.snapshot : null)
      const [conn, setConn] = React.useState(initial ? initial.conn : null)          // {status, text, error}
      const [sessionRun, setSessionRun] = React.useState(initial ? initial.sessionRun : undefined) // undefined=还没拉到
      const [settings, setSettings] = React.useState(initial ? initial.settings : null)
      const [codexAvailable, setCodexAvailable] = React.useState(initial ? initial.codexAvailable !== false : true)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [answers, setAnswers] = React.useState({})
      const [err, setErr] = React.useState(null)
      // 心跳:每秒重算一次「已静默多久」,不依赖 SSE 推送
      const [nowTick, setNowTick] = React.useState(Date.now())
      React.useEffect(() => {
        const t = setInterval(() => setNowTick(Date.now()), 1000)
        return () => clearInterval(t)
      }, [])

      const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3200) }

      const load = React.useCallback(async () => {
        try {
          const qs = panelSessionId ? ('?sessionId=' + encodeURIComponent(panelSessionId)) : ''
          const r = await fetch(API + '/snapshot' + qs, { cache: 'no-store' })
          const j = await r.json()
          if (j.ok) {
            setSnap(j.snapshot)
            setCodexAvailable(Boolean(j.codexAvailable))
            setConn({ status: j.connection || 'disconnected', text: j.connectionText || '未连接', error: j.connectionError || null })
            setSessionRun(j.sessionRun || null)
          }
        } catch (e) { setErr(String(e && e.message || e)) }
      }, [panelSessionId])

      const loadSettings = React.useCallback(async () => {
        try {
          const r = await fetch(API + '/settings', { cache: 'no-store' })
          const j = await r.json()
          if (j.ok) setSettings(j.settings)
        } catch { /* 忽略 */ }
      }, [])

      React.useEffect(() => {
        load(); loadSettings()
        let es = null
        try {
          es = new EventSource(API + '/events')
          es.onmessage = (ev) => {
            try {
              const j = JSON.parse(ev.data)
              if (j.type === 'snapshot') {
                setSnap(j.snapshot)
                const c = j.snapshot && j.snapshot.connection
                if (c) setConn({ status: c.status, text: c.status === 'connected' ? '连接成功' : (c.status === 'connecting' ? '正在连接…' : (c.status === 'failed' ? '连接失败' : '未连接')), error: c.error })
                // 会话视角: SSE 推的是全量快照,自己按会话过滤一次
                if (panelSessionId) {
                  const mine = (j.snapshot.runs || []).filter((r) => r.sessionId === panelSessionId)
                  const active = mine.find((r) => r.id === j.snapshot.activeRunId)
                  setSessionRun(active || (mine.length ? mine.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)) : null))
                }
              }
            } catch { /* 忽略 */ }
          }
          es.onerror = () => { /* SSE 断了会自动重连 */ }
        } catch { /* 环境不支持 SSE 时退化为轮询 */ }
        const poll = setInterval(() => { if (!es || es.readyState !== 1) load() }, 5000)
        return () => { if (es) es.close(); clearInterval(poll) }
      }, [load, loadSettings])

      const run = panelSessionId
        ? (sessionRun === undefined ? undefined : sessionRun)   // 会话视角: 只认本会话的任务
        : (snap && snap.activeRunId ? (snap.runs || []).find((r) => r.id === snap.activeRunId) : null)
      const loading = run === undefined
      const status = loading ? 'idle' : (run ? run.status : 'idle')
      const ui = STATUS_UI[status] || STATUS_UI.idle
      // 连接态只在"还没开始干活"时占据大状态位;干活期间大状态位让给四态
      const showConn = !loading && !run && conn && conn.status !== 'connected'

      /*
       * 产物只展示"最新一轮干活"的产出。
       * 做法: 取 run.threads 里最后一个会话(最新一轮),只要它结束时间之后记录的产物。
       * 没有线程信息时退回最后一个产物时间戳窗口。
       */
      const latestArtifacts = (() => {
        if (!run) return []
        const arts = (run.artifacts || [])
        if (!arts.length) return []
        const threads = run.threads || []
        const last = threads[threads.length - 1]
        let window
        if (last && last.endedAt) {
          window = arts.filter((a) => (a.at || 0) >= (last.startedAt || 0) && (a.at || 0) <= (last.endedAt + 5000))
        } else {
          // 没有线程信息: 回退到最近一次批量产物(同一时刻附近 2 秒内)
          const lastAt = Math.max(...arts.map((a) => a.at || 0))
          window = arts.filter((a) => (a.at || 0) >= lastAt - 2000)
        }
        /*
         * 同一个文件被多轮改过会留下多条记录 —— 按路径去重,只保留最新那条。
         * 面板上要的是"本轮交付了哪些文件",不是"历史上被改过多少次"。
         */
        const byPath = new Map()
        for (const a of window) {
          const key = a.abs || a.path || a.kind
          const prev = byPath.get(key)
          if (!prev || (a.at || 0) >= (prev.at || 0)) byPath.set(key, a)
        }
        return [...byPath.values()].sort((x, y) => (x.at || 0) - (y.at || 0))
      })()
      const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || '文件'

      const lastAt = run ? (run.lastActivityAt || run.updatedAt || null) : null
      const silentSec = status === 'working' && lastAt ? Math.max(0, Math.floor((nowTick - lastAt) / 1000)) : 0
      const fmtSilent = (v) => (v < 60 ? v + ' 秒' : Math.floor(v / 60) + ' 分 ' + (v % 60) + ' 秒')
      const heartbeat = (() => {
        if (!run || status !== 'working') return null
        if (silentSec >= 180) return { cls: 'alarm', tip: '较久没动静了。多半在写大文件或长思考,先别急着中断;可以点「刷新」核对一下。' }
        if (silentSec >= 60) return { cls: 'warn', tip: '正在干活,安静是正常的(多在写文件或长思考)。' }
        return { cls: '', tip: '刚活动过。' }
      })()

      const post = async (path, body) => {
        setBusy(true)
        try {
          const r = await fetch(API + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          const j = await r.json().catch(() => ({}))
          if (!j.ok) flash(j.message || '操作失败')
          else flash(j.message || '已执行')
          await load()
          return j
        } catch (e) { flash(String(e && e.message || e)) ; return null } finally { setBusy(false) }
      }

      const saveSettings = async (patch) => {
        const next = { ...(settings || {}), ...patch }
        setSettings(next)
        setBusy(true)
        try {
          const r = await fetch(API + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const j = await r.json()
          if (j.ok) { setSettings(j.settings); flash('设置已保存') }
        } finally { setBusy(false) }
      }

      // 阶段状态推导: 已完成 / 当前 / 失败
      const phaseState = (idx) => {
        if (!run) return ''
        if (status === 'failed' && idx === run.phaseIndex) return 'err'
        if (idx < run.phaseIndex) return 'ok'
        if (idx === run.phaseIndex) return run.status === 'done' ? 'ok' : 'cur'
        return ''
      }

      const needsUser = run && run.needsUser
      /*
       * ⚠️ 必须强制成数组。踩过的坑: 验收阶段 codex 请求审批时,needsUser 里
       * questions 是 undefined(审批请求没有提问数组),这里如果漏成 undefined,
       * 下面 `questions.length` 直接抛错 → 整个面板组件渲染失败 → slot 连带消失,
       * 输入框左下角的图标按钮也跟着没了(用户看到的就是"面板打不开/打开了就消失")。
       * 顺带把非数组的脏数据也挡掉(历史状态里存过 null)。
       */
      const questions = Array.isArray(needsUser && needsUser.questions) ? needsUser.questions : []

      return React.createElement('div', { className: 'cxb-root' },
        // ---------- 顶部大状态 ----------
        React.createElement('div', { className: 'cxb-card' },
          React.createElement('div', { className: 'cxb-hero' },
            React.createElement('div', { className: 'cxb-badge ' + (showConn ? (conn.status === 'failed' ? 'failed' : 'waiting') : ui.cls) },
              React.createElement('span', { className: 'cxb-dot' }),
              showConn
                ? ('Codex: ' + (conn.status === 'connecting' ? '正在连接…' : conn.status === 'failed' ? '连接失败' : '未连接'))
                : 'Codex: ' + ui.text,
            ),
            React.createElement('div', { className: 'cxb-meta' },
              React.createElement('div', null, React.createElement('b', null,
                loading ? '读取中…' : (run ? (run.title || '未命名任务') : (panelSessionId ? '此会话还没让 Codex 干活' : '暂无任务')))),
              run ? React.createElement('div', null, '项目: ' + (run.projectName || '-') + (run.cwd ? ' · ' + run.cwd : '')) : null,
              run ? React.createElement('div', null, '会话: ' + (shortId(run.currentThreadId) || '尚未创建') + (run.model ? ' · 模型 ' + run.model : '')) : null,
              run ? React.createElement('div', null, '返工次数: ' + (run.reworkCount || 0)) : null,
              conn && conn.status !== 'disconnected'
                ? React.createElement('div', null, '连接: ' + (conn.text || '') + (conn.error ? '(' + conn.error + ')' : ''))
                : null,
              React.createElement('div', null, codexAvailable ? 'Codex CLI: 已找到' : '⚠️ 未找到 codex CLI,请设 DSH_CODEX_BIN'),
            ),
          ),
          // 连接失败时给一个明显的重试按钮(懒连接: 失败后不会自己一直重试)
          conn && conn.status === 'failed'
            ? React.createElement('div', { className: 'cxb-conn-fail' },
                React.createElement('span', null, '⚠️ 连接 Codex 失败' + (conn.error ? ': ' + String(conn.error).slice(0, 160) : '')),
                React.createElement('button', { className: 'cxb-btn primary', disabled: busy, onClick: () => post('/reconnect', {}) }, '重试连接'),
              )
            : null,
          heartbeat
            ? React.createElement('div', { className: 'cxb-heart ' + heartbeat.cls },
                React.createElement('span', { className: 'cxb-beat' }),
                React.createElement('span', null,
                  React.createElement('b', null, '仍在干活 · 已静默 ' + fmtSilent(silentSec)),
                  ' · ' + heartbeat.tip,
                ),
              )
            : (lastAt
                ? React.createElement('div', { className: 'cxb-heart' },
                    React.createElement('span', { className: 'cxb-beat', style: { animation: 'none', background: 'var(--dsw-alias-border-l1)' } }),
                    React.createElement('span', null, '上次动作: ' + fmtTime(lastAt)),
                  )
                : null),
          latestArtifacts.length
            ? React.createElement('div', { className: 'cxb-row', style: { marginTop: 10 } },
                React.createElement('span', { className: 'cxb-note' }, '本轮产出:'),
                ...latestArtifacts.map((a, i) => React.createElement('button', {
                  key: i,
                  className: 'cxb-pill cxb-artifact',
                  title: '点击在电脑上打开: ' + (a.abs || a.path || ''),
                  onClick: () => post('/open-artifact', { path: a.abs || a.path, runId: run.id }),
                }, basename(a.path || a.abs || a.kind || '文件'))),
              )
            : null,
          // ---------- 四阶段进度 ----------
          React.createElement('div', { className: 'cxb-steps' },
            ...PHASES.map((p, i) => React.createElement('div', {
              key: p.id,
              className: 'cxb-step ' + phaseState(i),
            },
              React.createElement('div', { className: 't' }, (i + 1) + '. ' + p.name),
              React.createElement('div', { className: 's' }, '负责: ' + p.by),
            )),
          ),
          // ---------- 操作区 ----------
          React.createElement('div', { className: 'cxb-row', style: { marginTop: 12 } },
            React.createElement('button', { className: 'cxb-btn', disabled: busy, onClick: () => post('/open', {}) }, '打开 Codex'),
            React.createElement('button', { className: 'cxb-btn danger', disabled: busy || !run, onClick: () => post('/interrupt', {}) }, '中断当前回合'),
            React.createElement('button', { className: 'cxb-btn', disabled: busy || !run, onClick: () => post('/run/clear-log', {}) }, '清空日志'),
            React.createElement('button', { className: 'cxb-btn', disabled: busy, onClick: () => { load(); loadSettings(); flash('已刷新') } }, '刷新'),
            toast ? React.createElement('span', { className: 'cxb-note' }, toast) : null,
            err ? React.createElement('span', { className: 'cxb-note', style: { color: '#ef4444' } }, err) : null,
          ),
        ),

        // ---------- 需要你拍板 ----------
        needsUser ? React.createElement('div', { className: 'cxb-card' },
          React.createElement('div', { className: 'cxb-ask' },
            React.createElement('div', { className: 'q' },
              needsUser.kind === 'approval'
                ? '⚠️ Codex 请求批准执行操作' + (needsUser.params && needsUser.params.command ? ': ' + String(needsUser.params.command).slice(0, 200) : '')
                : '⚠️ Codex 在向你提问,它被卡住等你回答',
            ),
            /*
             * ⚠️ 这里的兜底必须是 `: []` 而不是 `: null` ——
             * 展开 null 会抛 "object null is not iterable",把整个面板打崩。
             * 这正是"验收阶段面板打不开/打开就消失、输入框图标也跟着没了"的根因:
             * 验收时 codex 请求审批 ⇒ questions 为空数组 ⇒ 走 null 分支 ⇒ 崩。
             */
            ...(questions.length
              ? questions.map((q, i) => {
                  const key = q.id || q.title || ('q' + i)
                  return React.createElement('div', { key, className: 'cxb-field' },
                    React.createElement('label', null, q.title || q.question || key),
                    Array.isArray(q.options) && q.options.length
                      ? React.createElement('select', {
                          value: answers[key] || '',
                          onChange: (e) => setAnswers({ ...answers, [key]: e.target.value }),
                        },
                          React.createElement('option', { value: '' }, '请选择…'),
                          ...q.options.map((o) => React.createElement('option', { key: o, value: o }, o)),
                        )
                      : React.createElement('input', {
                          value: answers[key] || '',
                          onChange: (e) => setAnswers({ ...answers, [key]: e.target.value }),
                          placeholder: '输入你的回答',
                        }),
                  )
                })
              : []),
            React.createElement('div', { className: 'cxb-row' },
              needsUser.kind === 'approval'
                ? React.createElement(React.Fragment, null,
                    React.createElement('button', { className: 'cxb-btn primary', disabled: busy, onClick: () => post('/answer', { decision: 'accept' }) }, '批准'),
                    React.createElement('button', { className: 'cxb-btn', disabled: busy, onClick: () => post('/answer', { decision: 'acceptForSession' }) }, '批准(本会话不再问)'),
                    React.createElement('button', { className: 'cxb-btn danger', disabled: busy, onClick: () => post('/answer', { decision: 'decline' }) }, '拒绝'),
                  )
                : React.createElement('button', { className: 'cxb-btn primary', disabled: busy, onClick: () => post('/answer', { answers }) }, '提交回答'),
              React.createElement('button', { className: 'cxb-btn', disabled: busy, onClick: () => post('/open', {}) }, '我要去 Codex 里直接决定'),
            ),
          ),
        ) : null,

        // ---------- 会话列表 ----------
        React.createElement('div', { className: 'cxb-card' },
          React.createElement('div', { className: 'cxb-title' }, 'Codex 会话(每阶段一个新会话)'),
          run && run.threads && run.threads.length
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                ...run.threads.map((t, i) => React.createElement('div', { key: i, className: 'cxb-thread' },
                  React.createElement('span', { className: 'cxb-pill' }, t.phase),
                  React.createElement('span', null, shortId(t.threadId)),
                  React.createElement('span', { className: 'cxb-note' }, fmtTime(t.startedAt) + (t.endedAt ? ' → ' + fmtTime(t.endedAt) : ' (进行中)')),
                  React.createElement('span', { className: 'cxb-note' }, t.status || ''),
                  React.createElement('button', { className: 'cxb-btn', onClick: () => post('/open', { threadId: t.threadId }) }, '在 Codex 打开'),
                )),
              )
            : React.createElement('div', { className: 'cxb-empty' }, '还没有会话。让 DSH 起一条工作流后这里会显示每个阶段的会话。'),
        ),

        // ---------- 实时日志 ----------
        React.createElement('div', { className: 'cxb-card' },
          React.createElement('div', { className: 'cxb-title' }, '干活日志(实时)'),
          run && run.log && run.log.length
            ? React.createElement('div', { className: 'cxb-log' },
                ...run.log.slice(-120).map((l, i) => React.createElement('div', { key: i, className: 'l ' + String(l.kind || '') },
                  React.createElement('span', { className: 'ts' }, fmtTime(l.at)),
                  React.createElement('span', null, l.text),
                )),
              )
            : React.createElement('div', { className: 'cxb-empty' }, '暂无日志'),
        ),

        // ---------- 设置(仅整页模式显示) ----------
        popover ? null : React.createElement('div', { className: 'cxb-card' },
          React.createElement('div', { className: 'cxb-title' }, '设置'),          settings
            ? React.createElement('div', { className: 'cxb-settings' },
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, 'Codex 模型(留空用 Codex 默认)'),
                  React.createElement('select', {
                    value: settings.model || '',
                    onChange: (e) => saveSettings({ model: e.target.value }),
                  },
                    React.createElement('option', { value: '' }, '用 Codex 默认'),
                    ...[
                      'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
                      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-reserve',
                    ].map((m) => React.createElement('option', { key: m, value: m }, m)),
                  ),
                ),
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, '思考强度'),
                  React.createElement('select', {
                    value: settings.effort || 'high',
                    onChange: (e) => saveSettings({ effort: e.target.value }),
                  },
                    ...['low', 'medium', 'high', 'xhigh'].map((v) => React.createElement('option', { key: v, value: v }, v)),
                  ),
                ),
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, '思考摘要'),
                  React.createElement('select', {
                    value: settings.summary || 'detailed',
                    onChange: (e) => saveSettings({ summary: e.target.value }),
                  },
                    ...['none', 'concise', 'detailed'].map((v) => React.createElement('option', { key: v, value: v }, v)),
                  ),
                ),
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, 'Codex 沙箱(能写项目文件 / 能跑命令)'),
                  React.createElement('select', {
                    value: settings.sandbox || 'workspace-write',
                    onChange: (e) => saveSettings({ sandbox: e.target.value }),
                  },
                    ...[
                      ['read-only', '只读(不能改文件)'],
                      ['workspace-write', '可写工作区(推荐)'],
                      ['danger-full-access', '完全放开(慎用)'],
                    ].map(([v, label]) => React.createElement('option', { key: v, value: v }, label)),
                  ),
                ),
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, '审批策略'),
                  React.createElement('select', {
                    value: settings.approvalPolicy || 'never',
                    onChange: (e) => saveSettings({ approvalPolicy: e.target.value }),
                  },
                    ...[
                      ['never', '不打扰我(推荐)'],
                      ['on-request', '需要时问我'],
                      ['on-failure', '失败时问我'],
                    ].map(([v, label]) => React.createElement('option', { key: v, value: v }, label)),
                  ),
                ),
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, 'Codex 反问时自动打开桌面端'),
                  React.createElement('select', {
                    value: String(settings.autoOpenOnNeedsUser !== false),
                    onChange: (e) => saveSettings({ autoOpenOnNeedsUser: e.target.value === 'true' }),
                  },
                    React.createElement('option', { value: 'true' }, '打开'),
                    React.createElement('option', { value: 'false' }, '不打开'),
                  ),
                ),
                React.createElement('div', { className: 'cxb-field' },
                  React.createElement('label', null, '流程完成时发微信通知'),
                  React.createElement('select', {
                    value: String(settings.notifyOnFinish !== false),
                    onChange: (e) => saveSettings({ notifyOnFinish: e.target.value === 'true' }),
                  },
                    React.createElement('option', { value: 'true' }, '发'),
                    React.createElement('option', { value: 'false' }, '不发'),
                  ),
                ),
              )
            : React.createElement('div', { className: 'cxb-empty' }, '读取设置中…'),
        ),

        // ---------- 历史任务(仅整页模式显示,浮层里省掉) ----------
        popover ? null : (snap && snap.runs && snap.runs.length > 1)
          ? React.createElement('div', { className: 'cxb-card' },
              React.createElement('div', { className: 'cxb-title' }, '历史任务'),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                ...snap.runs.slice(0, 8).map((r) => React.createElement('div', { key: r.id, className: 'cxb-thread' },
                  React.createElement('span', { className: (STATUS_UI[r.status] || STATUS_UI.idle).cls + '' , style: { width: 8, height: 8, borderRadius: 4, background: 'currentColor', display: 'inline-block' } }),
                  React.createElement('span', null, r.title || r.id),
                  React.createElement('span', { className: 'cxb-note' }, (STATUS_UI[r.status] || STATUS_UI.idle).text),
                  React.createElement('span', { className: 'cxb-note' }, fmtTime(r.updatedAt)),
                  r.id === (snap.activeRunId || '')
                    ? React.createElement('span', { className: 'cxb-note' }, '当前')
                    : React.createElement('button', { className: 'cxb-btn', onClick: () => post('/run/activate', { runId: r.id }) }, '切到它'),
                )),
              ),
            )
          : null,
      )
    }

    const inject = ['slots']
    /**
     * 输入框左下角的入口按钮(meme 表情按钮右边)。
     * 点开是一个浮层,里面直接复用上面那块 CodexPanel(内容与交互一致)。
     * 按钮上带一个小状态点,不打开也知道 Codex 在干嘛。
     */
    function CodexInputTrigger(props) {
      const sessionId = (props && props.sessionId) || null
      const [open, setOpen] = React.useState(false)
      const [status, setStatus] = React.useState('idle')
      const wrapRef = React.useRef(null)

      /*
       * 点面板外部 / 按 Esc 关闭浮层。
       * 之所以不用全屏遮罩: 遮罩会挡住别的插件(z-index 更低的 meme 面板),
       * 用 document 级监听既能关闭,又不拦截其它插件的点击。
       */
      React.useEffect(() => {
        if (!open) return undefined
        const onDocDown = (e) => {
          const el = wrapRef.current
          if (!el) return
          // 点在浮层内部或触发按钮上 ⇒ 不关(按钮自己会 toggle)
          if (el.contains(e.target)) return
          if (e.target && e.target.closest && e.target.closest('.cxb-trigger')) return
          // 点表情包按钮时也关掉自己,避免两个面板叠在一起
          setOpen(false)
        }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDocDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDocDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      // 状态点靠轻量轮询(按钮每场景都在,SSE 由面板自己管,这里只要一个色点)。
      // 会话视角: 有 sessionId 时只认"本会话"的任务状态,别把别的会话的进度显示出来。
      React.useEffect(() => {
        let alive = true
        let es = null
        const pick = (snapObj) => {
          if (!snapObj) return 'idle'
          const runs = snapObj.runs || []
          if (sessionId) {
            const mine = runs.filter((r) => r.sessionId === sessionId)
            if (!mine.length) return 'idle'
            const active = mine.find((r) => r.id === snapObj.activeRunId)
            return (active || mine.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a))).status || 'idle'
          }
          const active = runs.find((r) => r.id === snapObj.activeRunId)
          return active ? active.status : 'idle'
        }
        const pull = async () => {
          try {
            const r = await fetch(API + '/snapshot', { cache: 'no-store' })
            const j = await r.json()
            if (alive && j && j.ok) setStatus(pick(j.snapshot))
          } catch { /* 忽略 */ }
        }
        pull()
        try {
          es = new EventSource(API + '/events')
          es.onmessage = (ev) => {
            try {
              const j = JSON.parse(ev.data)
              if (alive && j.type === 'snapshot') setStatus(pick(j.snapshot))
            } catch { /* 忽略 */ }
          }
        } catch { /* 无 SSE 时退化为轮询 */ }
        const t = setInterval(() => { if (!es || es.readyState !== 1) pull() }, 8000)
        return () => { alive = false; if (es) es.close(); clearInterval(t) }
      }, [sessionId])

      const dotCls = 'cxb-trigger-dot'
        + (status === 'working' ? ' working'
          : status === 'done' ? ' done'
            : status === 'failed' ? ' failed'
              : (status === 'waiting_input' || status === 'waiting_approval') ? ' waiting' : '')

      const h = React.createElement
      return h('div', { style: { display: 'inline-flex' } },
        h('button', {
          className: open ? 'cxb-trigger open' : 'cxb-trigger',
          title: 'Codex 协作(看 Codex 在干什么)',
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open) },
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, style: { display: 'block' }, 'aria-hidden': 'true' },
            // 终端窗口 + 闪电: 表示"在终端里跑 agent"的那个意思
            h('path', { d: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h14V7H5zm2.7 1.8 2.6 2.2-2.6 2.2.9 1.1 3.7-3.3-3.7-3.3-.9 1.1zm5.3 5.7h4v1.2h-4v-1.2z', fill: 'currentColor' }),
          ),
          h('span', { className: dotCls }),
        ),
        /*
         * 注意: 这里**不再使用全屏遮罩**。
         * 踩过的坑: 遮罩是 z-index:900 的全屏透明层,而 meme 表情包面板是 z-index:30,
         * 遮罩存在时会把表情包的点击全挡住 —— 用户会以为"表情包插件坏了"。
         * 现在改成: 点外部/按 Esc 关闭(监听 document),靠 wrapRef 判断是否点在面板内,
         * 完全不影响别的插件。
         */
        open
          ? h('div', { className: 'cxb-pop', ref: wrapRef, onClick: (e) => e.stopPropagation() },
              h('div', { className: 'cxb-pop-head' },
                h('span', { className: 'cxb-pop-title' }, 'Codex 协作'),
                h('button', { className: 'cxb-close', title: '关闭', onClick: () => setOpen(false) }, '×'),
              ),
              h(PanelBoundary, null, h(CodexPanel, { mode: 'popover', sessionId })),
            )
          : null,
      )
    }

    function apply(ctx) {
      const disposeCss = injectCss()
      try { ctx.effect?.(() => disposeCss, 'codex-pilot:css') } catch { /* 忽略 */ }
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'codex-pilot',
        order: 26,
        label: 'Codex 协作',
      }, () => React.createElement(PanelBoundary, null, () => React.createElement(CodexPanel, null))))

      // 输入框左下角:meme 表情按钮 order=5,这里用 6 排在它右边。
      // owner props 带会话快照(InputZone.session),把 sessionId 传给面板 ⇒ 面板跟会话走。
      slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: 'codex-panel-trigger',
        order: 6,
        label: 'Codex 协作',
      }, (ownerProps) => React.createElement(PanelBoundary, null, () =>
        React.createElement(CodexInputTrigger, {
          sessionId: (ownerProps && (ownerProps.sessionId
            || (ownerProps.session && (ownerProps.session.id || ownerProps.session.sessionId)))) || null,
        }),
      )))
    }

    exports.apply = apply
    exports.inject = inject
    // 测试钩子: 允许单测直接渲染面板/边界(生产代码不会用到)
    exports.__test = { CodexPanel, PanelBoundary, CodexInputTrigger }
    return module.exports
  },
})
