/**
 * Codex 编排层 —— 通过 codex app-server 建会话、派任务、监控干活过程。
 *
 * 协议要点(实测 + 生成 schema 核实, 见 codex-appserver-protocol-research.md):
 * - 传输是 **NDJSON**(每条消息一行 JSON),信封**没有 jsonrpc 字段**,
 *   请求只有 {id, method, params},响应 {id, result|error},通知 {method, params}。
 * - 服务端**会主动发请求**(审批 / 反问用户): 形如 {id, method, params},
 *   必须用 {id, result} 回,否则回合会一直挂在 waitingOnApproval。
 * - 动态改模型只有一条路: `turn/start` 的 `model` 字段(没有 thread/settings/update)。
 * - "完成但在等人"是显式建模的: thread/status/changed 带 activeFlags,
 *   取值 waitingOnApproval / waitingOnUserInput。
 *
 * 关键环境变量:
 *   CODEX_INTERNAL_ORIGINATOR_OVERRIDE="Codex Desktop"
 *   不设置的话会话在 Codex 桌面端侧边栏**看不见**(被 originator 白名单过滤)。
 *   这是实测踩过的坑,别删。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Codex CLI 候选路径(不在 PATH 里,藏在 ChatGPT.app 内) */
const CLI_CANDIDATES = [
  process.env.DSH_CODEX_BIN,
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/usr/local/bin/codex',
  '/opt/homebrew/bin/codex',
].filter(Boolean)

export const ORIGINATOR = 'Codex Desktop'

export function findCodexBin() {
  for (const p of CLI_CANDIDATES) {
    try { if (existsSync(p)) return p } catch { /* 继续找 */ }
  }
  return null
}

/** 服务端主动请求 → 需要人类拍板的两类 */
export const SERVER_REQUESTS = {
  'item/tool/requestUserInput': 'input',        // codex 反问,要你回答
  'execCommandApproval': 'approval',
  'applyPatchApproval': 'approval',
  'item/commandExecution/requestApproval': 'approval',
  'item/fileChange/requestApproval': 'approval',
  'item/permissions/requestApproval': 'approval',
  'item/tool/call': 'tool',                     // 动态工具调用(一般不需要人工)
}

/** 审批决定取值(按 schema 的 CommandExecutionApprovalDecision 等枚举,取公共子集) */
export const DECISION = {
  ACCEPT: 'accept',
  ACCEPT_FOR_SESSION: 'acceptForSession',
  DENY: 'decline',
  CANCEL: 'cancel',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 一个 codex app-server 连接(进程 + NDJSON 通道 + 状态机回调)。
 *
 * 事件(通过 on 注册):
 *   thread-start  {threadId, model}
 *   turn-start    {threadId, turnId}
 *   item          {threadId, turnId, item, phase:'started'|'completed'}
 *   reasoning     {threadId, text}           推理摘要增量
 *   agent-text    {threadId, text}           最终回复增量
 *   status        {threadId, activeFlags}    waitingOnApproval / waitingOnUserInput
 *   needs-user    {kind:'input'|'approval', request}
 *   turn-done     {threadId, turnId, status, error, finalMessage}
 *   error         {error}
 *   exit          {code, signal}
 */
export class CodexConnection extends EventTarget {
  constructor({ bin, cwd, onLog } = {}) {
    super()
    this.bin = bin || findCodexBin()
    this.cwd = cwd
    this.onLog = onLog || (() => {})
    this.proc = null
    this.nextId = 1
    this.pending = new Map()      // 我方请求: id -> {resolve, reject, timer}
    this.buf = ''
    this.logs = []
    this.closed = false
    /**
     * 服务端主动请求登记表: id -> {method, params, kind, at}
     * 实测教训: `turn/completed` 到了**不代表任务完成** ——
     * 只要这张表非空,就是在等人拍板(审批/回答),不能判"干活完成"。
     */
    this.serverRequests = new Map()
    /** 线程活跃标记: threadId -> ThreadActiveFlag[] */
    this.activeFlags = new Map()
    /** 最近一条 agentMessage(判断 questions / phase 用) */
    this.lastAgentMessage = new Map()
  }

  get available() {
    return Boolean(this.bin)
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  on(type, fn) {
    const h = (e) => fn(e.detail)
    this.addEventListener(type, h)
    return () => this.removeEventListener(type, h)
  }

  #log(text, level = 'info') {
    const entry = { at: Date.now(), level, text }
    this.logs.push(entry)
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400)
    this.onLog(entry)
  }

  /** 启动 app-server 子进程。返回 this(可链式) */
  async start() {
    if (!this.bin) throw new Error('找不到 codex CLI,请设置 DSH_CODEX_BIN 环境变量')
    if (this.proc) return this

    const env = { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: ORIGINATOR }
    this.proc = spawn(this.bin, ['app-server', '--stdio'], {
      cwd: this.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#log(`已启动 codex app-server (pid=${this.proc.pid})`)

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.#onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.#log('stderr: ' + text.slice(0, 400), 'debug')
    })
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      /*
       * 进程退出时把在途请求全部 reject。
       * ⚠️ 必须给被 reject 的 promise 挂一个 noop catch:
       * 坏二进制(code=1 立即退出)时,initialize 的 pending 会被 exit 抢先 reject,
       * 裸 reject 变成 unhandled rejection,直接把整个 DSH 进程打崩(实测踩到过)。
       */
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        const err = new Error(`codex app-server 已退出 (code=${code} signal=${signal})`)
        // 用 p.settle 统一收口: 它内部会先给 promise 挂 catch 再 reject
        if (typeof p.settle === 'function') p.settle(err)
      }
      this.pending.clear()
      this.#log(`app-server 退出 code=${code} signal=${signal}`, 'warn')
      this.emit('exit', { code, signal })
    })

    try {
      await this.request('initialize', {
        clientInfo: { name: 'Codex Desktop', title: 'DSH Codex Bridge', version: '0.1.0' },
        capabilities: null,
      })
    } catch (e) {
      // 初始化失败: 收拾干净再抛,上层据此把连接状态标成 failed
      this.closed = true
      try { this.proc.kill() } catch { /* 忽略 */ }
      throw e
    }
    return this
  }

  #onData(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      try { this.#dispatch(msg) } catch (e) { this.#log('消息处理异常: ' + (e && e.message), 'warn') }
    }
  }

  #dispatch(msg) {
    // 1) 我方请求的响应
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
      return
    }
    // 2) 服务端主动请求(审批 / 反问) —— 必须回,否则回合影住
    if (msg.id !== undefined && msg.method) {
      const kind = SERVER_REQUESTS[msg.method] || 'other'
      this.serverRequests.set(msg.id, { method: msg.method, params: msg.params || {}, kind, at: Date.now() })
      this.#log(`服务端请求: ${msg.method} (${kind})`)
      this.emit('needs-user', {
        kind,
        request: msg,
        threadId: (msg.params || {}).threadId,
        respond: (result) => this.respond(msg.id, result),
      })
      return
    }
    // 3) 通知
    if (msg.method) this.#onNotification(msg.method, msg.params || {})
  }

  #onNotification(method, p) {
    switch (method) {
      case 'thread/status/changed': {
        const status = p.status || p
        const flags = p.activeFlags || status.activeFlags || (status.type === 'active' ? status.activeFlags : null) || []
        const threadId = p.threadId
        if (threadId) this.activeFlags.set(threadId, flags)
        this.emit('status', { threadId, activeFlags: flags, type: status.type || p.type })
        break
      }
      case 'serverRequest/resolved': {
        // 服务端确认某条主动请求已解决(我方回过 {id,result} 后也会推)
        if (p.requestId !== undefined) this.serverRequests.delete(p.requestId)
        this.emit('request-resolved', { threadId: p.threadId, requestId: p.requestId })
        break
      }
      case 'turn/started':
        this.emit('turn-start', { threadId: p.threadId, turnId: p.turnId || p.turn?.id })
        break
      case 'turn/completed': {
        const turn = p.turn || {}
        const items = turn.items || []
        const last = [...items].reverse().find((i) => i.type === 'agentMessage')
        if (p.threadId && last) this.lastAgentMessage.set(p.threadId, last)
        this.emit('turn-done', {
          threadId: p.threadId,
          turnId: turn.id || p.turnId,
          status: turn.status || 'completed',
          error: turn.error || null,
          finalMessage: last ? extractItemText(last) : null,
          questions: (last && last.questions) || null,
          usage: p.usage || turn.usage || null,
        })
        break
      }
      case 'item/started':
        this.emit('item', { threadId: p.threadId, turnId: p.turnId, item: p.item, phase: 'started' })
        break
      case 'item/completed':
        this.emit('item', { threadId: p.threadId, turnId: p.turnId, item: p.item, phase: 'completed' })
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.emit('reasoning', { threadId: p.threadId, text: p.delta || p.text || '' })
        break
      case 'item/agentMessage/delta':
        this.emit('agent-text', { threadId: p.threadId, text: p.delta || p.text || '' })
        break
      case 'error': {
        const err = p.error || p
        this.#log(`codex 报错: ${err.message || JSON.stringify(err)}`, 'warn')
        this.emit('error', { error: err, willRetry: Boolean(p.willRetry) })
        break
      }
      default:
        this.emit('notification', { method, params: p })
    }
  }

  /** 发一条请求,等响应(带超时) */
  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (!this.proc || this.closed) return Promise.reject(new Error('codex app-server 未运行'))
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params }) + '\n'
    /*
     * 单层结构: pending 里直接存 {promise, reject, timer, method}。
     * ⚠️ 关键: 必须给返回的 promise 挂 noop catch —— 坏二进制(立即 exit)时
     * initialize 的请求会先被 exit 事件 reject,若没人接就变成 unhandled rejection,
     * 直接把整个 DSH 进程打崩(实测踩到过)。挂一个 catch 不影响真正的等待方。
     */
    /*
     * 单层结构: pending 里存 {promise, resolve, reject, timer, method}。
     * ⚠️ 关键: 返回的 promise 必须自带 noop catch —— 坏二进制(立即 exit)时
     * initialize 请求会先被 exit 事件 reject;若没人接就变成 unhandled rejection,
     * 直接把整个 DSH 进程打崩(实测踩到过)。挂 catch 不影响真正的等待方。
     */
    /*
     * 单层 + 兜底: 返回的 promise 自带 noop catch;所有"拒收"都走 rejectOnce(),
     * 它保证先挂 catch 再 reject —— 坏二进制(立即 exit)时 initialize 的请求
     * 会先被 exit 事件拒收,若没人接就是 unhandled rejection,会把 DSH 打崩(实测踩到)。
     */
    let entry = null
    let rejectOnce = null
    const promise = new Promise((resolve, reject) => {
      rejectOnce = (err) => {
        // 先挂 noop catch,防"还没人 await"时崩进程
        promise.catch(() => {})
        reject(err)
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectOnce(new Error(`请求超时: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      entry = { resolve, reject: rejectOnce, timer, method, settle: rejectOnce }
      this.pending.set(id, entry)
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          rejectOnce(err)
        }
      })
    })
    promise.catch(() => {})
    return promise
  }

  /** 回服务端主动请求({id, result}),审批/反问都走这里 */
  respond(id, result) {
    if (!this.proc || this.closed) return false
    try {
      this.proc.stdin.write(JSON.stringify({ id, result }) + '\n')
      return true
    } catch (e) {
      this.#log('回请求失败: ' + (e && e.message), 'warn')
      return false
    }
  }

  /** 新建一个 codex 会话(不要传 -m,模型必须由调用方显式给) */
  async startThread({ cwd, model, approvalPolicy = 'never', sandbox = 'workspace-write', effort, summary, instructions }) {
    const params = {
      model: model || undefined,
      cwd: cwd || this.cwd,
      approvalPolicy,
      sandbox,
      threadSource: 'user',
    }
    const config = {}
    if (effort) config.model_reasoning_effort = effort
    if (summary) config.model_reasoning_summary = summary
    if (Object.keys(config).length) params.config = config
    if (instructions) params.developerInstructions = instructions
    const res = await this.request('thread/start', params, { timeoutMs: 60000 })
    const threadId = res.thread?.id || res.threadId
    this.#log(`新建会话 ${String(threadId).slice(0, 8)}… model=${res.model || model || '(默认)'}`)
    this.emit('thread-start', { threadId, model: res.model })
    return { threadId, model: res.model, raw: res }
  }

  /** 派一个任务(一个回合)。extra 可覆盖 model/effort/summary/cwd/sandbox */
  async sendTurn(threadId, text, extra = {}) {
    const params = {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }
    for (const k of ['model', 'effort', 'summary', 'cwd', 'approvalPolicy', 'sandboxPolicy']) {
      if (extra[k] !== undefined && extra[k] !== null) params[k] = extra[k]
    }
    const res = await this.request('turn/start', params, { timeoutMs: 60000 })
    const turnId = res.turn?.id || res.turnId
    this.#log(`派发任务 回合=${String(turnId).slice(0, 8)}…`)
    this.emit('turn-start', { threadId, turnId })
    return { turnId, raw: res }
  }

  /** 中断某个回合(用户点"停止") */
  async interrupt(threadId, turnId) {
    try {
      await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 15000 })
      this.#log('已请求中断回合')
      return true
    } catch (e) {
      this.#log('中断失败: ' + (e && e.message), 'warn')
      return false
    }
  }

  /** 增量读取会话里的条目(type:'item' + itemId 作为锚点) */
  async listItems(threadId, { turnId, afterItemId, limit = 200 } = {}) {
    const params = { threadId, limit }
    if (turnId) params.turnId = turnId
    if (afterItemId) params.anchor = { type: 'item', itemId: afterItemId }
    const res = await this.request('thread/items/list', params, { timeoutMs: 20000 })
    return res.items || res.data || []
  }

  async readThread(threadId) {
    return this.request('thread/read', { threadId }, { timeoutMs: 20000 })
  }

  async setThreadName(threadId, name) {
    try { return await this.request('thread/name/set', { threadId, name }, { timeoutMs: 10000 }) }
    catch { return null }
  }

  /** 未解决的服务端请求(审批/反问) */
  pendingRequests(threadId) {
    const all = [...this.serverRequests.entries()].map(([id, r]) => ({ id, ...r }))
    return threadId ? all.filter((r) => !r.params?.threadId || r.params.threadId === threadId) : all
  }

  hasPendingApproval(threadId) {
    return this.pendingRequests(threadId).some((r) => r.method.endsWith('requestApproval') || r.method === 'mcpServer/elicitation/request')
  }

  hasPendingInput(threadId) {
    return this.pendingRequests(threadId).some((r) => r.method === 'item/tool/requestUserInput')
  }

  /**
   * 判定一个回合结束后到底是"完成"还是"在等人"。
   * 依据三层建模(见协议报告 §5): 回合状态 + 未解决服务端请求 + agentMessage.questions。
   * 返回 { done, needsApproval, needsInput, waiting, error }
   */
  judge(threadId, turn, { error, questions } = {}) {
    const status = turn?.status || 'completed'
    const flags = this.activeFlags.get(threadId) || []
    const pending = this.pendingRequests(threadId)
    const failed = status === 'failed' || (status === 'completed' && error != null)
    const needsApproval = this.hasPendingApproval(threadId) || flags.includes('waitingOnApproval')
    const needsInput = this.hasPendingInput(threadId)
      || flags.includes('waitingOnUserInput')
      || (questions && questions.length > 0)
    const waiting = pending.length > 0 || needsApproval || needsInput
    return {
      failed,
      needsApproval,
      needsInput,
      waiting,
      pendingCount: pending.length,
      done: !failed && !waiting,
    }
  }

  async stop() {
    if (!this.proc || this.closed) return
    this.closed = true
    try { this.proc.stdin.end() } catch { /* 忽略 */ }
    await sleep(200)
    if (!this.proc.killed) {
      try { this.proc.kill('SIGTERM') } catch { /* 忽略 */ }
    }
  }
}

/** 从一个 item 里抠出可读文本(agentMessage / reasoning 通用) */
export function extractItemText(item) {
  if (!item) return ''
  if (typeof item.text === 'string') return item.text
  const parts = []
  const push = (v) => {
    if (typeof v === 'string' && v) parts.push(v)
    else if (Array.isArray(v)) for (const x of v) push(x)
    else if (v && typeof v === 'object') push(v.text ?? v.summary ?? v.content ?? '')
  }
  push(item.content)
  push(item.summary)
  return parts.join('\n').trim()
}

/**
 * 打开 Codex 桌面端并定位到某个会话。
 * 用 codex:// URL scheme(Info.plist 已注册);失败则退回按工作区路径打开。
 */
export async function openInDesktop(threadId, cwd) {
  const { execFile } = await import('node:child_process')
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err) => resolve(!err))
  })
  if (threadId) {
    if (await run('open', [`codex://threads/${threadId}`])) return { ok: true, via: 'thread-url' }
  }
  const bin = findCodexBin()
  if (bin) {
    if (await run(bin, ['app', cwd || '.'])) return { ok: true, via: 'app-cwd' }
  }
  if (await run('open', ['-a', 'ChatGPT'])) return { ok: true, via: 'app-only' }
  return { ok: false }
}
