/**
 * 工作流编排 —— 四阶段 + 验收失败自动返工。
 *
 * 阶段与负责方(按用户定义的流程):
 *   1. requirements  需求文档    codex  (与用户头脑风暴后写成文档)
 *   2. ui            UI 设计     codex  (设计说明 + 可点击 HTML 原型)
 *   3. code          写代码      dsh    (DSH 自己干)
 *   4. acceptance    测试验收    codex  (按需求文档验收, 不通过则回到第 3 步返工)
 *
 * 每个 codex 阶段都**新开一个会话**(用户明确要求"在同一个项目里重新开一个新会话")。
 * codex 反问时不自动回答 —— 交给上层决定(打开桌面端让用户拍板 / 或由 DSH 代答)。
 */
import { PHASES, PHASE_IDS, MAX_REWORK, STATUS } from './state.js'

/**
 * 同一会话最多连续跑多少轮就换新会话。
 * 目的: 设计迭代复用同一会话(上下文连贯),但别撞 Codex 的上下文窗口。
 * 可在面板设置里用 sessionTurnLimit 覆盖。
 */
export const SESSION_TURN_LIMIT = 8

/** 每个阶段的提示词模板。占位符: {brief} {projectName} {cwd} {reworkNote} */
export const PHASE_PROMPTS = {
  requirements: [
    '你是需求分析专家。当前项目目录: {cwd}(项目名: {projectName})。',
    '',
    '用户的原始需求:',
    '{brief}',
    '',
    '任务:',
    '1. **先动手产出**: 基于现有信息直接在 `docs/requirements.md` 写一份需求文档。',
    '   文档包含: 背景与目标、用户与场景、功能需求(编号条目)、边界与非目标、验收标准。',
    '   信息不完整的地方,按最合理的常规默认假设补上,并在文档里用"【假设】"标注。',
    '2. 只有在**继续干下去会导致方向性错误**时,才向用户提 1-3 个关键问题。',
    '   提问题时**不要**只说问题就结束 —— 先把带假设的文档写完,再在回复末尾列出问题,',
    '   这样用户可以直接基于文档给意见,而不是面对一片空白。',
    '3. 结束前用一段话总结: 文档路径 + 关键决策 + 你假设了什么 + 是否需要用户确认。',
    '',
    '要求: 需求条目必须可验收(能对应到具体测试或检查),不要写空话。',
  ].join('\n'),

  ui: [
    '你是 UI/UX 设计专家。当前项目目录: {cwd}(项目名: {projectName})。',
    '',
    '需求文档在 `docs/requirements.md`,请先读它(如果不存在,先按用户下面这段说明推导):',
    '{brief}',
    '',
    '任务:',
    '1. **直接产出**(不要先反问): 基于需求做 UI 设计,写 `docs/ui-design.md`:',
    '   信息架构、页面清单、每页布局与交互说明、组件清单、配色与字体规范、状态(空/加载/错误)设计。',
    '2. 另外产出一个**可直接在浏览器打开的高保真原型** `docs/ui-prototype.html`:',
    '   单文件、内联 CSS、不依赖任何外部资源(不引 CDN),覆盖主要页面与交互。',
    '3. 需要拍板的设计取舍,先按你的专业判断定下来并在文档里标"【设计决策】",',
    '   把不确定的点写在回复末尾问用户,而不是先停下来等。',
    '4. 写完后总结: 产出文件路径 + 设计要点 + 有哪些决策需要用户确认。',
    '',
    '如果上面 {brief} 说的是**一次增量设计改动**(例如"把主色改成品红"):',
    '先读现有的 `docs/ui-design.md` 与 `docs/ui-prototype.html`,只改受影响的部分,其余保持不变,',
    '并在设计文档末尾追加一条改动记录(时间 / 改了什么 / 为什么)。',
  ].join('\n'),

  acceptance: [
    '你是严格的测试与验收专家。当前项目目录: {cwd}(项目名: {projectName})。',
    '',
    '需求文档在 `docs/requirements.md`,UI 设计在 `docs/ui-design.md`。请先把它们读完。',
    '',
    'DSH 刚完成了代码实现,提交说明:',
    '{brief}',
    '{reworkNote}',
    '',
    '任务:',
    '1. **逐条**核对需求文档里的每个需求条目是否实现,用工具实际验证(跑测试、跑构建、启动服务、读代码),不要只看代码猜。',
    '2. 在项目目录写验收报告 `docs/acceptance-report.md`,格式: 每一条需求 → 结论(PASS/FAIL) → 证据(命令+输出/文件行号) → 缺陷说明。',
    '3. 最后必须给出**明确的一行结论**,二选一:',
    '   - `验收结论: PASS`',
    '   - `验收结论: FAIL`(并列出必须修复的问题清单,按严重程度排序)',
    '',
    '要求: 宁可 FAIL 也不要放过未验证的条目。',
  ].join('\n'),
}

export function buildPhasePrompt(phase, { brief = '', cwd, projectName, reworkNote = '' }) {
  const tpl = PHASE_PROMPTS[phase]
  if (!tpl) throw new Error('未知阶段: ' + phase)
  return tpl
    .replaceAll('{brief}', brief)
    .replaceAll('{cwd}', cwd || '')
    .replaceAll('{projectName}', projectName || '')
    .replaceAll('{reworkNote}', reworkNote)
}

/** 从验收报告/回复里解析 PASS / FAIL 结论 */
export function parseVerdict(text) {
  if (!text) return null
  const t = String(text)
  const fail = /验收结论[:：]\s*FAIL/i.test(t) || /结论[:：]\s*FAIL/i.test(t)
  const pass = /验收结论[:：]\s*PASS/i.test(t) || /结论[:：]\s*PASS/i.test(t)
  if (fail) return 'FAIL'
  if (pass) return 'PASS'
  // 退路: 出现明显失败词但没写规范结论
  if (/FAIL\b|未通过|不通过/.test(t)) return 'FAIL'
  if (/全部通过|均通过|PASS\b/.test(t)) return 'PASS'
  return null
}

/**
 * 判断 codex 是不是在"用大白话反问用户"。
 *
 * 为什么需要: codex 只有主动调用 request_user_input 工具时才发结构化提问,
 * 实测它经常直接在回复里写问题。但**不能见问号就用**(实测误报过一次:
 * "建议用户确认: xxx 是否定位为自检工具" 这种补充建议被当成了卡住等人,
 * 结果面板显示"等你决策"、需求阶段白多等了 180 秒)。
 *
 * 判定收紧为: 必须"有交付物 + 明确在等答复"才算等人。
 *   - 没有任何交付物(文件路径/产出声明)且末句是问句 ⇒ 大概率在等你 ⇒ 等人
 *   - 有交付物 ⇒ 顶多是顺手建议 ⇒ 算完成(问题会照样展示给用户)
 */
export function looksLikeQuestion(text) {
  if (!text) return false
  const t = String(text).trim()
  if (!t || t.length > 2000) return false

  const delivered = extractArtifacts(t).length > 0
    || /已(写|生成|完成|创建|实现)|产出|交付/.test(t)

  // 明确的"停下来等你回答"措辞
  const blockingAsk = /(请\s*(确认|选择|告诉|提供|明确|补充|回复)|需要你(确认|回答|提供|决定)|等你(确认|回答|决定)|你(想|偏好)哪)/i.test(t)
  const numberedQs = (t.match(/[?？]/g) || []).length >= 2
  const endsWithQ = /[?？]\s*$/.test(t)

  if (delivered) return false               // 先交付了就不算卡住
  if (blockingAsk) return true              // 没交付 + 明确在等 ⇒ 卡住了
  if (numberedQs) return true               // 没交付 + 好几个问号 ⇒ 在问一串问题
  return endsWithQ                          // 没交付 + 纯问句结尾
}

/** 从回复里抽出文件路径(用于记录产出,让面板显示交付物) */
export function extractArtifacts(text) {
  if (!text) return []
  const out = new Set()
  // markdown 链接 [x](path) 与裸路径
  const patterns = [
    /\[[^\]]*\]\(([^)\s]+)\)/g,
    /(?:^|[\s`(])((?:\.{0,2}\/)?(?:docs|src|app|lib|test|tests|public)\/[\w./-]+\.\w+)/g,
    /(?:^|[\s`(])([\w-]+\.(?:md|html|css|js|mjs|ts|tsx|json|py|yml|yaml|txt))/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text))) {
      const p = m[1].replace(/^file:\/\//, '').replace(/[.,;:]+$/, '')
      if (!p || p.length >= 200) continue
      if (/^https?:/.test(p)) continue
      // 排掉 "Node.js" / "Vue.js" 这类在正文里当名词用的写法(实测误报过一次)
      if (!p.includes('/')) {
        if (/^(node|vue|next|nuxt|react|express|three|nest|socket|ember|backbone|angular)\.js$/i.test(p)) continue
        if (!/\.(md|html|css|mjs|json|py|yml|yaml|txt|toml|sh|sql|vue|svelte)$/.test(p)) continue
      }
      out.add(p)
    }
  }
  return [...out]
}

/** 把一段文字里的问题抽出来(用于面板/通知展示) */
export function extractQuestions(text) {
  if (!text) return []
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
  const qs = lines.filter((l) => /^\d+[.、)]/.test(l) || /[?？]$/.test(l))
  return qs.length ? qs.slice(0, 6) : [String(text).trim().slice(0, 200)]
}

export function phaseInfo(phase) {
  return PHASES.find((p) => p.id === phase) || null
}

export function nextPhase(phase) {
  const i = PHASE_IDS.indexOf(phase)
  if (i < 0 || i >= PHASE_IDS.length - 1) return null
  return PHASE_IDS[i + 1]
}

/**
 * 工作流运行时 —— 把 state / codex 连接 / 通知 串起来。
 *
 * 用法:
 *   const wf = new WorkflowRunner({ store, client, notify })
 *   const res = await wf.runPhase(run, 'requirements', { brief })
 *   // res: { ok, status, finalMessage, error, needsUser, verdict }
 *
 * 注意: runPhase 会**一直等到 codex 真的干完**(或进入等人状态/失败),
 * 所以上层工具调用是同步阻塞语义 —— 这正是我们想要的 "发任务并监控整个干活过程"。
 */
export class WorkflowRunner {
  constructor({ store, client, notify, logger } = {}) {
    this.store = store
    this.client = client
    this.notify = notify
    this.log = logger || (() => {})
  }

  /**
   * 跑一个 codex 阶段。
   *
   * 会话复用策略(按需求优化):
   *   - **同一阶段的同类型活复用同一个会话**: 例如 ui 阶段从零设计 + 后续所有设计修改,
   *     都在同一个会话里做 —— Codex 记得上下文,设计决策前后连贯,也不用反复重读设计稿。
   *   - **跨阶段新开会话**: 需求 / UI / 验收性质不同,混在一起会串味。
   *   - **同一会话连续跑超过 SESSION_TURN_LIMIT 轮** 就自动新开,避免撞上下文窗口。
   *
   * @param {object} opts
   * @param {'requirements'|'ui'|'acceptance'} phase 阶段
   * @param {string} [opts.sessionKey] 会话分组键,默认 = phase。同 key 复用,不同 key 新开。
   * @param {boolean} [opts.freshSession] 强制新开(例如从零做一次全量设计)
   */
  async runPhase(run, phase, { brief = '', model, effort = 'high', summary = 'detailed', timeoutMs = 30 * 60 * 1000, sessionKey = null, freshSession = false } = {}) {
    const info = phaseInfo(phase)
    if (!info) throw new Error('未知阶段: ' + phase)
    if (info.by !== 'codex') throw new Error(`阶段 ${phase} 由 ${info.by} 执行,不该走 codex`)

    const reworkNote = phase === 'acceptance' && run.reworkCount > 0
      ? `\n注意: 这是第 ${run.reworkCount + 1} 次验收(之前验收未通过,DSH 已按你上次的缺陷清单返工)。请重点复核上次的失败项。\n`
      : ''

    this.store.setPhase(run, phase)
    this.store.setStatus(run, STATUS.WORKING)

    const useModel = model || run.model || this.store.settings?.model || undefined
    const key = sessionKey || phase

    // ---- 找可以复用的会话 ----
    const reusable = freshSession ? null : this.#findReusableThread(run, key)
    let threadId = reusable ? reusable.threadId : null
    if (threadId) {
      this.store.appendLog(run, 'info', `复用 ${info.name} 会话 ${String(threadId).slice(0, 8)}…(同一类活不新开)`)
      this.store.updateRun(run, { currentThreadId: threadId, currentTurnId: null })
    } else {
      this.store.appendLog(run, 'info', `派发任务给 Codex: ${info.name}(新开会话)`)
      const created = await this.client.startThread({
        cwd: run.cwd,
        model: useModel,
        approvalPolicy: this.store.settings?.approvalPolicy || 'never',
        sandbox: this.store.settings?.sandbox || 'workspace-write',
        effort,
        summary,
      })
      threadId = created.threadId
      this.store.startThread(run, { phase, threadId, model: useModel, sessionKey: key })
      await this.client.setThreadName(threadId, `[DSH] ${run.title} · ${info.name}`)
    }

    const prompt = buildPhasePrompt(phase, {
      brief,
      cwd: run.cwd,
      projectName: run.projectName,
      reworkNote,
    })

    const result = await this.#awaitTurn(run, threadId, prompt, { model: useModel, timeoutMs })
    // 记下这一轮用掉的轮次数(用于判断是否该换新会话)
    const rec = run.threads.find((t) => t.threadId === threadId)
    if (rec) {
      rec.turns = (rec.turns || 0) + 1
      this.store.updateRun(run, {})
    }
    return result
  }

  /** 同一 sessionKey 且没超轮次上限的最近一个会话 */
  #findReusableThread(run, sessionKey) {
    const limit = this.store.settings?.sessionTurnLimit || SESSION_TURN_LIMIT
    const cands = (run.threads || []).filter((t) => (t.sessionKey || t.phase) === sessionKey)
    if (!cands.length) return null
    const latest = cands[cands.length - 1]
    if ((latest.turns || 0) >= limit) {
      this.store.appendLog(run, 'info', `会话已连续使用 ${latest.turns} 轮,达到上限 ${limit},下次换新会话`)
      return null
    }
    return latest
  }

  /** 发一个回合并等终态(核心监控循环) */
  async #awaitTurn(run, threadId, prompt, { model, timeoutMs } = {}) {
    const client = this.client
    let finalMessage = ''
    let reasonText = ''
    let toolCount = 0
    let error = null
    let needsUser = null
    let verdict = null
    let settled = false

    const offs = []
    const cleanup = () => { for (const off of offs) { try { off() } catch { /* 忽略 */ } } }

    const waitFor = new Promise((resolve) => {
      const finish = (payload) => { if (!settled) { settled = true; cleanup(); resolve(payload) } }

      // 推理摘要(思考过程) → 面板实时显示
      offs.push(client.on('reasoning', ({ text }) => {
        if (!text) return
        reasonText += text
        this.store.appendLog(run, 'reasoning', text.slice(-300))
      }))

      offs.push(client.on('agent-text', ({ text }) => { if (text) finalMessage += text }))

      offs.push(client.on('item', ({ item, phase: p }) => {
        if (p !== 'completed' || !item) return
        const type = item.type
        if (type === 'agentMessage') {
          const t = typeof item.text === 'string' ? item.text : ''
          if (t) finalMessage = t
          if (item.questions && item.questions.length) {
            needsUser = { kind: 'input', questions: item.questions, message: t, threadId }
          }
        } else if (type === 'reasoning') {
          const t = typeof item.text === 'string' ? item.text : ''
          if (t) reasonText += '\n' + t
        } else if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'webSearch') {
          toolCount++
          this.store.appendLog(run, 'tool', describeItem(item))
        }
      }))

      // codex 反问 / 请求审批 —— 不自动批准,登记后交由上层决定
      offs.push(client.on('needs-user', ({ kind, request, threadId: tid, respond }) => {
        const params = request.params || {}
        needsUser = { kind, method: request.method, params, threadId: tid || threadId, respond }

        /*
         * 安全命令自动放行。
         *
         * 为什么要有: 用户把审批策略设成 on-request 后,codex 连 `npm test`
         * 这种只读/建类命令都会停下来等批准 —— 验收阶段因此常年卡在"等批准"
         * (实测就是这样卡住的)。这里对白名单里的命令直接 acceptForSession,
         * 既不打扰用户,又不会把危险的写操作/网络请求放过去。
         */
        const cmd = String(params && (params.command || params.reason || '') || '')
        if (kind === 'approval' && isSafeCommand(cmd)) {
          const auto = request.method === 'item/commandExecution/requestApproval' || request.method === 'execCommandApproval'
          if (auto) {
            this.store.appendLog(run, 'info', `自动放行安全命令: ${cmd.slice(0, 120)}`)
            try { respond({ decision: 'acceptForSession' }) } catch { /* 忽略 */ }
            needsUser = null
            return
          }
        }

        if (kind === 'approval') {
          this.store.setStatus(run, STATUS.WAITING_APPROVAL, {
            needsUser: { kind: 'approval', method: request.method, params, threadId: tid || threadId, requestedAt: Date.now() },
          })
        } else {
          this.store.setStatus(run, STATUS.WAITING_INPUT, {
            needsUser: { kind: 'input', method: request.method, params, questions: params.questions, threadId: tid || threadId, requestedAt: Date.now() },
          })
        }
        const label = kind === 'approval' ? 'Codex 请求批准执行操作' : 'Codex 在向你提问'
        this.store.appendLog(run, 'needs-you', label)
      }))

      offs.push(client.on('turn-done', ({ turnId, status, error: err, finalMessage: msg, questions }) => {
        if (msg) finalMessage = msg
        const verdictJudge = client.judge(threadId, { status }, { error: err, questions })
        if (verdictJudge.failed) {
          error = err || { message: '回合失败' }
          this.store.appendLog(run, 'error', 'Codex 回合失败: ' + (err?.message || status))
          finish({ ok: false })
          return
        }
        if (verdictJudge.waiting || needsUser) {
          // 在等人 —— 状态已是 waiting_*,停下等上层处理
          finish({ ok: true, waiting: true })
          return
        }
        finish({ ok: true, waiting: false, turnId })
      }))

      offs.push(client.on('error', ({ error: err, willRetry }) => {
        if (!willRetry && err) { error = err; finish({ ok: false }) }
      }))

      offs.push(client.on('exit', () => {
        if (!settled) { error = { message: 'codex app-server 进程退出' }; finish({ ok: false }) }
      }))

      // 派发任务(放在事件注册之后,避免漏掉最早的通知)
      client.sendTurn(threadId, prompt, { model }).then(({ turnId }) => {
        this.store.updateRun(run, { currentTurnId: turnId })
      }).catch((e) => {
        error = { message: e?.message || String(e) }
        finish({ ok: false })
      })
    })

    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, timeout: true }), timeoutMs)
      if (typeof t.unref === 'function') t.unref()
    })

    const res = await Promise.race([waitFor, timeout])
    cleanup()

    if (res.timeout) {
      error = { message: `等待 Codex 超时(${Math.round(timeoutMs / 1000)}s)` }
      this.store.appendLog(run, 'error', error.message)
      const exited = await this.client.interrupt(threadId, run.currentTurnId).catch(() => false)
      return { ok: false, status: STATUS.FAILED, error, threadId, interrupted: exited }
    }

    if (!res.ok) {
      this.store.endThread(run, threadId, { status: STATUS.FAILED, finalMessage })
      this.store.setStatus(run, STATUS.FAILED, { error: error?.message || '未知错误' })
      return { ok: false, status: STATUS.FAILED, error, threadId, finalMessage, reasonText }
    }

    if (res.waiting || needsUser) {
      // 记录到线程 + 保持 waiting 状态,等用户决策/DSH 代答
      this.store.endThread(run, threadId, { status: STATUS.WAITING_INPUT, finalMessage })
      return {
        ok: true,
        status: run.status, // waiting_input / waiting_approval
        threadId,
        needsUser,
        finalMessage,
        reasonText,
        toolCount,
      }
    }

    // 记录这一轮交付的文件(让面板"产出"区显示出来)
    const arts = extractArtifacts(finalMessage)
    for (const p of arts) {
      // 相对路径按会话工作目录补全,方便用户直接点开
      const abs = p.startsWith('/') ? p : (run.cwd ? run.cwd.replace(/\/$/, '') + '/' + p.replace(/^\.\//, '') : p)
      this.store.addArtifact(run, { phase: run.phase, kind: 'codex', path: p, abs })
    }
    if (arts.length) this.store.appendLog(run, 'info', `产出文件: ${arts.join(', ')}`)

    // 正常完成 —— 但如果它在用大白话反问,就当"等人",别误报"干活完成"
    if (looksLikeQuestion(finalMessage) && (run.phase === 'requirements' || run.phase === 'ui')) {
      const qs = extractQuestions(finalMessage).map((title, i) => ({ id: 'q' + (i + 1), title }))
      this.store.endThread(run, threadId, { status: STATUS.WAITING_INPUT, finalMessage })
      this.store.setStatus(run, STATUS.WAITING_INPUT, {
        needsUser: { kind: 'input', method: 'codex/freeTextQuestion', questions: qs, threadId, requestedAt: Date.now() },
      })
      this.store.appendLog(run, 'needs-you', 'Codex 用文字向你提问(等你回答)')
      return {
        ok: true, status: STATUS.WAITING_INPUT, threadId, finalMessage, reasonText, toolCount,
        needsUser: { kind: 'input', method: 'codex/freeTextQuestion', questions: qs, message: finalMessage, threadId },
      }
    }

    if (run.phase === 'acceptance') verdict = parseVerdict(finalMessage)
    this.store.endThread(run, threadId, { status: STATUS.DONE, finalMessage, turnId: res.turnId })
    this.store.setStatus(run, STATUS.DONE, { needsUser: null })
    this.store.appendLog(run, 'done', `Codex 完成 ${phaseInfo(run.phase)?.name || run.phase}(工具调用 ${toolCount} 次)`)
    return { ok: true, status: STATUS.DONE, threadId, finalMessage, reasonText, toolCount, verdict, needsUser: null }
  }

  /** 向已挂起的 codex 请求回一个答复(用户在 DSH 里回答了 codex 的提问) */
  answerPending(run, answers) {
    const req = run.needsUser
    if (!req) return { ok: false, message: '当前没有等待答复的 Codex 请求' }
    const pending = this.client.pendingRequests(req.threadId)
    const hit = pending.find((r) => r.method === req.method) || pending[0]
    if (!hit) return { ok: false, message: '该请求可能已解决' }
    const result = req.kind === 'approval'
      ? { decision: answers?.decision || 'accept' }
      : { answers: answers?.answers || {} }
    const ok = this.client.respond(hit.id, result)
    this.store.appendLog(run, 'info', ok
      ? (req.kind === 'approval' ? '已批准 Codex 的操作请求,它会继续干活' : '已代答 Codex 的提问')
      : '代答失败(请求已失效)')
    /*
     * 答完之后状态必须回到"干活中"。
     * 踩过的坑: 只清 needsUser 不清 status,面板会一直显示"等批准",
     * 而 Codex 其实已经继续在干活了 —— 用户看到的就是状态卡住不动。
     */
    this.store.updateRun(run, { needsUser: null, status: STATUS.WORKING })
    return { ok, message: ok ? '已答复 Codex,它会继续干活' : '答复失败' }
  }

  /** dsh 自己干的阶段(写代码),只做状态与日志记录 */
  async runLocalPhase(run, phase, note = '') {
    const info = phaseInfo(phase)
    this.store.setPhase(run, phase)
    this.store.setStatus(run, STATUS.WORKING)
    this.store.appendLog(run, 'dsh', `DSH 开始干活: ${info?.name || phase}${note ? ' — ' + note : ''}`)
    return { ok: true }
  }

  /** dsh 阶段结束 */
  finishLocalPhase(run, phase, { summary = '', artifacts = [] } = {}) {
    for (const a of artifacts) this.store.addArtifact(run, { phase, ...a })
    this.store.appendLog(run, 'done', `DSH 完成 ${phaseInfo(phase)?.name || phase}${summary ? ': ' + summary : ''}`)
    return this.store.setStatus(run, STATUS.DONE)
  }
}

/**
 * 安全命令白名单判定 —— 只读、只跑测试、只构建类命令不需要人工批准。
 *
 * 刻意保持保守: 包含删除/写入系统路径/网络外发/提权的都不算安全。
 * 判不准就返回 false,交给人来决定,别替用户做主。
 */
export function isSafeCommand(cmd) {
  const c = String(cmd || '').trim()
  if (!c) return false
  // 出现这些就直接判不安全(交给人)
  if (/(rm\s+-[rf]|rmdir|sudo|chmod|chown|mkfs|dd\s+if=|:>|>[^&]|\|\s*(ba)?sh\b|curl|wget|nc\s|ssh\s|scp\s|git\s+push|npm\s+publish|pip\s+install|brew\s+install|docker\s+run)/i.test(c)) return false
  if (/\b(\/etc\/|\/usr\/|\/System\/|~\/\.ssh)/.test(c)) return false
  // 明确的白名单模式(只读/测试/构建)
  const safePatterns = [
    /^(npm|pnpm|yarn)\s+(test|run\s+(test|build|lint|check|typecheck|tsc))\b/i,
    /^npx\s+(tsc|vitest|jest|eslint|prettier)\b/i,
    /^(node|python3?|bun|deno)\s+(--check|-c|--version|-v)\b/i,
    /^(node|python3?)\s+[\w./-]*(test|spec)[\w./-]*\.(m?js|cjs|ts|py)\b/i,
    /^(git\s+(status|diff|log|show|branch|rev-parse|ls-files))\b/i,
    /^(ls|pwd|cat|head|tail|wc|tree|find|file|stat|du|df|echo|which|type|env)\b/i,
    /^(rg|grep|sed\s+-n|awk|jq|column|sort|uniq|cut|tr)\b/i,
    /^(test|\[)\s/i,
    /^(curl\s+-s?\s*-?[oO]?\s*\S*\s*-X\s*(GET|HEAD))\b/i,
  ]
  return safePatterns.some((re) => re.test(c))
}

/** 把 codex 的工具调用条目转成一句人话日志 */
export function describeItem(item) {
  switch (item.type) {
    case 'commandExecution':
      return `执行命令: ${String(item.command || '').slice(0, 160)}`
    case 'fileChange': {
      const files = (item.changes || item.files || []).map((c) => c.path || c.file || c).filter(Boolean)
      return `改文件: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` 等 ${files.length} 个` : ''}`
    }
    case 'mcpToolCall':
      return `调用工具: ${item.tool || item.name || 'mcp'}`
    case 'webSearch':
      return `联网搜索: ${String(item.query || '').slice(0, 120)}`
    default:
      return `条目: ${item.type}`
  }
}
