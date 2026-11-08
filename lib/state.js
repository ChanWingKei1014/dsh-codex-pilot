/**
 * 状态存储 —— 工作流的持久化。
 *
 * 存储位置: ~/.dsh/dsh-codex-pilot.json
 * (与 dsh-meme 的 ~/.dsh/dsh-expression.json 同一惯例: 放 ~/.dsh 下,
 *  不受插件包升级/重装影响,重启 DSH 不丢历史。)
 *
 * 设计要点:
 * - 单文件 JSON,进程内用内存副本 + 防抖落盘,避免高频写盘。
 * - 环形日志(每条 run 最多 LOG_LIMIT 条),面板只读最近 N 条。
 * - 所有写入都经过 setRun/updateRun,保证 lastActivityAt 与 SSE 推送同步。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const LOG_LIMIT = 500
export const RUN_LIMIT = 50

/** Codex 的四态 + 两个等待态(等待态是"卡在等人类拍板",不是干活中也不是失败) */
export const STATUS = {
  IDLE: 'idle',                        // 未干活
  WORKING: 'working',                  // 干活中
  DONE: 'done',                        // 干活完成
  FAILED: 'failed',                    // 干活失败
  WAITING_INPUT: 'waiting_input',      // codex 在反问,等你决策
  WAITING_APPROVAL: 'waiting_approval', // codex 请求执行某个操作,等你批准
}

export const STATUS_LABEL = {
  idle: '未干活',
  working: '干活中',
  done: '干活完成',
  failed: '干活失败',
  waiting_input: '等你决策',
  waiting_approval: '等批准',
}

/**
 * Codex 连接状态 —— 在"干活状态"之外单独一个维度。
 * 懒连接策略: 不主动连,第一次派活时才连;连上之后一直复用。
 *   disconnected 未连接(还没派过活)
 *   connecting   正在连接
 *   connected    连接成功
 *   failed       连接失败(面板给重试按钮)
 */
export const CONN = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
}

export const CONN_LABEL = {
  disconnected: '未连接',
  connecting: '正在连接…',
  connected: '连接成功',
  failed: '连接失败',
}

/** 工作流阶段(按用户描述的流程) */
export const PHASES = [
  { id: 'requirements', name: '需求文档', by: 'codex', desc: '头脑风暴 + 编写需求文档' },
  { id: 'ui', name: 'UI 设计', by: 'codex', desc: '根据需求文档做 UI 设计' },
  { id: 'code', name: '写代码', by: 'dsh', desc: 'DSH 按需求文档实现代码' },
  { id: 'acceptance', name: '测试验收', by: 'codex', desc: 'codex 按需求文档测试与验收' },
]

export const PHASE_IDS = PHASES.map((p) => p.id)
export const MAX_REWORK = 3

function statePath() {
  if (process.env.DSH_CODEX_PILOT_STATE) return process.env.DSH_CODEX_PILOT_STATE
  const now = join(homedir(), '.dsh', 'dsh-codex-pilot.json')
  // 兼容旧名: 插件曾叫 dsh-codex-bridge,老用户的状态文件别丢
  const legacy = join(homedir(), '.dsh', 'dsh-codex-bridge.json')
  try {
    if (!existsSync(now) && existsSync(legacy)) return legacy
  } catch { /* 忽略 */ }
  return now
}

const EMPTY = {
  version: 1,
  activeRunId: null,
  runs: [],
  settings: {},
  // 连接状态(独立于"干活状态"): 懒连接,第一次派活才连
  connection: { status: CONN.DISCONNECTED, error: null, updatedAt: null },
}

export class StateStore {
  constructor(path = statePath()) {
    this.path = path
    this.state = this.#load()
    this.listeners = new Set()
    this.timer = null
    this.loadedMtimeMs = this.#mtime()
    this.loadedSize = this.#size()
  }

  #mtime() {
    try { return statSync(this.path).mtimeMs } catch { return 0 }
  }

  #size() {
    try { return statSync(this.path).size } catch { return 0 }
  }

  /**
   * 外部改动检测: 状态文件被别的进程改过时(另一个 DSH 实例、或用户手工编辑),
   * 把内存副本换成磁盘上的新内容。
   *
   * 为什么需要: 状态在内存里 + 防抖落盘,同一状态文件被两个进程同时用时,
   * 后写者会覆盖先写者 —— 实测踩到过(在另一个进程派活,活着的 GUI 宿主读不到)。
   * 保守策略: 只有自己当前没有待落盘改动时才接受外部版本。
   */
  reloadIfChanged() {
    if (this.timer) return false          // 自己有未落盘的改动,别覆盖
    const m = this.#mtime()
    const z = this.#size()
    if (m === this.loadedMtimeMs && z === this.loadedSize) return false
    this.state = this.#load()
    this.loadedMtimeMs = m
    this.loadedSize = z
    this.#emit(this.activeRun())
    return true
  }

  #load() {
    try {
      if (!existsSync(this.path)) return structuredClone(EMPTY)
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      return { ...structuredClone(EMPTY), ...raw }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  #flush() {
    this.timer = null
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.state, null, 2))
      // 记下自己写出来的 mtime/size,免得下次 reloadIfChanged 把自己写的内容当成外部改动
      this.loadedMtimeMs = this.#mtime()
      this.loadedSize = this.#size()
    } catch (e) {
      console.error('[codex-pilot] 状态落盘失败:', e && e.message)
    }
  }

  #schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => this.#flush(), 300)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * 立刻落盘(不等防抖)。
   * 必须用于"任务终态"这类关键写入: 防抖计时器是 unref 的,
   * 进程退出/插件卸载时会把待写内容丢掉 —— 实测就丢过一次 finishRun 的结果。
   */
  flushNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.#flush()
  }

  /** 订阅状态变更(面板 SSE 用)。返回取消订阅函数。 */
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  #emit(run) {
    for (const fn of this.listeners) {
      try { fn(run, this.state) } catch (e) { console.error('[codex-pilot] 订阅者异常:', e && e.message) }
    }
  }

  /** 覆盖写盘并广播 */
  save(run) {
    this.#schedule()
    this.#emit(run)
  }

  snapshot() {
    return {
      version: this.state.version,
      activeRunId: this.state.activeRunId,
      settings: this.state.settings || {},
      connection: this.state.connection || { status: CONN.DISCONNECTED, error: null, updatedAt: null },
      runs: this.state.runs,
    }
  }

  // ------------------------------------------------ 连接状态(懒连接)

  get settings() {
    return this.state.settings || (this.state.settings = {})
  }

  setSetting(key, value) {
    this.settings[key] = value
    this.#schedule()
    this.#emit(this.activeRun())
  }

  get connection() {
    if (!this.state.connection) this.state.connection = { status: CONN.DISCONNECTED, error: null, updatedAt: null }
    return this.state.connection
  }

  connStatus() {
    return this.connection.status
  }

  setConnection(status, error = null) {
    this.connection.status = status
    this.connection.error = status === CONN.FAILED ? String(error || '未知错误') : null
    this.connection.updatedAt = Date.now()
    this.#schedule()
    this.#emit(this.activeRun())
    this.flushNow()   // 连接状态是低频关键写入,直接落盘
    return this.connection
  }

  // ------------------------------------------------ 会话 ↔ 任务映射

  /**
   * 按会话 id 找这个会话自己的任务(取最新一个)。
   * 面板跟"会话"走: 一个从没让 Codex 干过活的会话 ⇒ 返回 null ⇒ 面板显示初始状态。
   */
  runsForSession(sessionId) {
    if (!sessionId) return null
    const list = this.state.runs.filter((r) => r.sessionId === sessionId)
    if (!list.length) return null
    // 该会话里正在跑的任务优先,否则取最近更新
    const active = list.find((r) => r.id === this.state.activeRunId)
    if (active) return active
    return list.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a))
  }

  /** 某个会话的"面板视角"状态: 没任务 ⇒ idle */
  statusForSession(sessionId) {
    const run = this.runsForSession(sessionId)
    return run ? run.status : STATUS.IDLE
  }

  getRun(runId) {
    return this.state.runs.find((r) => r.id === runId) || null
  }

  activeRun() {
    return this.state.activeRunId ? this.getRun(this.state.activeRunId) : null
  }

  /** 当前 codex 状态 —— 面板顶部那个大状态就用它 */
  currentStatus() {
    const run = this.activeRun()
    if (!run) return STATUS.IDLE
    return run.status
  }

  newRun({ title, cwd, projectName, model, phase = PHASE_IDS[0], meta = {}, sessionId = null }) {
    const now = Date.now()
    const run = {
      id: 'run_' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      title: title || '未命名任务',
      cwd,
      projectName: projectName || (cwd ? cwd.split('/').pop() : ''),
      model: model || null,
      /** 发起这条工作流的 DSH 会话 id —— 面板靠它把任务绑到会话上(exec.agent.id) */
      sessionId: sessionId || null,
      status: STATUS.IDLE,
      phase,
      phaseIndex: Math.max(0, PHASE_IDS.indexOf(phase)),
      reworkCount: 0,
      // codex 侧标识(每个阶段新开一个会话)
      threads: [],          // [{phase, threadId, turnId, startedAt, endedAt, status, finalMessage}]
      currentThreadId: null,
      currentTurnId: null,
      needsUser: null,      // {kind:'input'|'approval', questions, message, threadId, requestedAt}
      log: [],
      artifacts: [],        // [{phase, path, kind}]
      error: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      meta,
    }
    this.state.runs.unshift(run)
    if (this.state.runs.length > RUN_LIMIT) this.state.runs.length = RUN_LIMIT
    this.state.activeRunId = run.id
    this.appendLog(run, 'info', `创建任务: ${run.title}`)
    this.save(run)
    return run
  }

  updateRun(runOrId, patch) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    Object.assign(run, patch, { updatedAt: Date.now(), lastActivityAt: Date.now() })
    this.save(run)
    return run
  }

  setStatus(runOrId, status, extra = {}) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    if (run.status !== status) {
      this.appendLog(run, 'status', `状态: ${STATUS_LABEL[run.status] || run.status} → ${STATUS_LABEL[status] || status}`)
    }
    return this.updateRun(run, { status, ...extra })
  }

  setPhase(runOrId, phase, extra = {}) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    const info = PHASES.find((p) => p.id === phase)
    this.appendLog(run, 'phase', `进入阶段: ${info ? info.name : phase}`)
    return this.updateRun(run, { phase, phaseIndex: Math.max(0, PHASE_IDS.indexOf(phase)), ...extra })
  }

  appendLog(runOrId, kind, text, data = null) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    const entry = { at: Date.now(), kind, text: String(text || '') }
    if (data !== undefined && data !== null) entry.data = data
    run.log.push(entry)
    if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT)
    run.lastActivityAt = entry.at
    this.save(run)
    return entry
  }

  /** 记录一个 codex 会话(每阶段一个新会话) */
  startThread(runOrId, { phase, threadId, model, sessionKey }) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    const rec = {
      phase, threadId, model: model || null,
      /** 会话分组键: 同 key 的活复用同一会话(见 workflows 的 sessionKey 策略) */
      sessionKey: sessionKey || phase,
      /** 这个会话已经连续用了几轮(到上限换新会话) */
      turns: 0,
      startedAt: Date.now(), endedAt: null, status: STATUS.WORKING,
      turnId: null, finalMessage: null,
    }
    run.threads.push(rec)
    this.appendLog(run, 'codex', `新开 Codex 会话 ${String(threadId).slice(0, 8)}… (${phase})`)
    return this.updateRun(run, { currentThreadId: threadId })
  }

  endThread(runOrId, threadId, { status, finalMessage, turnId }) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    const rec = run.threads.find((t) => t.threadId === threadId)
    if (rec) {
      rec.endedAt = Date.now()
      rec.status = status
      rec.finalMessage = finalMessage || null
      if (turnId) rec.turnId = turnId
    }
    return this.updateRun(run, {})
  }

  addArtifact(runOrId, artifact) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    run.artifacts.push({ at: Date.now(), ...artifact })
    return this.updateRun(run, {})
  }

  /** 完成收尾: 清 activeRunId,避免面板一直显示"干活中" */
  finishRun(runOrId, status, { error = null, summary = null } = {}) {
    const run = typeof runOrId === 'string' ? this.getRun(runOrId) : runOrId
    if (!run) return null
    run.log.push({ at: Date.now(), kind: 'status', text: `任务结束: ${STATUS_LABEL[status] || status}` })
    if (error) run.log.push({ at: Date.now(), kind: 'error', text: String(error) })
    Object.assign(run, { status, error, summary, updatedAt: Date.now(), lastActivityAt: Date.now(), needsUser: null })
    this.state.activeRunId = null
    this.save(run)
    this.flushNow()   // 终态必须立刻落盘,不能等防抖
    return run
  }

  setActive(runId) {
    this.state.activeRunId = runId
    this.#schedule()
    this.#emit(this.getRun(runId))
  }

  clearLog(runId) {
    const run = this.getRun(runId)
    if (!run) return null
    run.log = []
    return this.updateRun(run, {})
  }

  deleteRun(runId) {
    const i = this.state.runs.findIndex((r) => r.id === runId)
    if (i >= 0) this.state.runs.splice(i, 1)
    if (this.state.activeRunId === runId) this.state.activeRunId = null
    this.#schedule()
    this.#emit(null)
  }
}
