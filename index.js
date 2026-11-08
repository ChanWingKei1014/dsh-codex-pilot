/**
 * dsh-codex-pilot —— 宿主半边。
 *
 * 让 DSH 把 Codex 当"协作工友"使唤:
 *   - 注册一组工具: 起工作流 / 派阶段任务 / 代答 Codex 的提问 / 查看状态 / 中断 / 打开桌面端
 *   - 注册 HTTP + SSE 路由: 给客户端面板提供实时状态(四态 + 阶段进度 + 日志)
 *
 * 四阶段工作流: 需求文档(codex) → UI 设计(codex) → 写代码(DSH) → 测试验收(codex, 失败自动返工)
 * 每个 codex 阶段都新开一个会话(用户要求),并且设了 originator 覆盖,
 * 保证会话在 Codex 桌面端侧边栏可见。
 *
 * Web 路由(无鉴权,仅供本机 127.0.0.1 使用 —— 与 DSH 自建路由的既有约束一致):
 *   GET  /dsh-codex-pilot/api/snapshot        全量状态
 *   GET  /dsh-codex-pilot/api/events          SSE 实时推送
 *   POST /dsh-codex-pilot/api/answer          代答 Codex 提问/审批
 *   POST /dsh-codex-pilot/api/interrupt       中断当前回合
 *   POST /dsh-codex-pilot/api/open            打开 Codex 桌面端并定位会话
 *   POST /dsh-codex-pilot/api/settings        面板设置(模型/沙箱/审批策略)
 *   POST /dsh-codex-pilot/api/run/clear-log   清空当前任务日志
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StateStore, STATUS, STATUS_LABEL, PHASES, PHASE_IDS, MAX_REWORK, CONN, CONN_LABEL } from './lib/state.js'
import { CodexConnection, findCodexBin, openInDesktop, extractItemText } from './lib/codex-client.js'
import { WorkflowRunner, parseVerdict, phaseInfo } from './lib/workflows.js'
import { notifyUser, completionMessage, needsInputMessage } from './lib/notify.js'

/**
 * 解析 defineTool。
 * 正常安装时 `@deepseek-ai/dsh-tools` 由 DSH profile 提供;但直接用 Node 跑这个文件
 * (开发/自检)时,包解析会从本文件所在目录往上找,找不到就退回到 DSH 的安装位置。
 */
async function loadDefineTool() {
  try {
    return (await import('@deepseek-ai/dsh-tools')).defineTool
  } catch (e) {
    const cands = [
      join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'),
      join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh-tools',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh-tools',
    ]
    for (const dir of cands) {
      const pkg = join(dir, 'package.json')
      if (!existsSync(pkg)) continue
      try {
        const pj = JSON.parse(readFileSync(pkg, 'utf8'))
        const entry = join(dir, pj.module || pj.main || 'index.js')
        const mod = await import(pathToFileURL(entry).href)
        if (mod.defineTool) {
          console.log('[codex-pilot] defineTool 回退解析自', dir)
          return mod.defineTool
        }
      } catch { /* 试下一个 */ }
    }
    throw new Error('找不到 @deepseek-ai/dsh-tools(defineTool 不可用): ' + (e && e.message))
  }
}

const defineTool = await loadDefineTool()

/**
 * 本插件的工具统一形态: 输出都是一个对象(至少含 message),
 * 用一个通用 render 把它变成模型可读的文本块。省得每个工具重复写 output。
 */
const tool = (options) => defineTool({
  ...options,
  output: options.output || {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: renderToolText(value) }],
  },
})

/** 把工具返回值渲染成给模型看的文本 */
function renderToolText(value) {
  if (value == null) return '(无输出)'
  if (typeof value === 'string') return value
  const parts = []
  if (value.message) parts.push(String(value.message))
  const rest = { ...value }
  delete rest.message
  // 只把有信息量的字段附上,避免把整份快照灌给模型
  for (const k of ['runId', 'status', 'statusText', 'phase', 'phaseName', 'threadId', 'verdict', 'reworkCount']) {
    if (rest[k] !== undefined && rest[k] !== null && rest[k] !== '') parts.push(`${k}: ${rest[k]}`)
    delete rest[k]
  }
  if (value.finalMessage) parts.push('\n[Codex 结论]\n' + String(value.finalMessage))
  if (Array.isArray(value.log) && value.log.length) parts.push('\n[日志]\n' + value.log.join('\n'))
  return parts.join('\n') || JSON.stringify(value).slice(0, 4000)
}

export const name = 'dsh-codex-pilot'
export const inject = ['tools', 'webServer']

const ROUTE = '/dsh-codex-pilot'
const API = ROUTE + '/api'

/** 默认设置(面板可改,持久化到 ~/.dsh/dsh-codex-pilot.json 的 settings) */
const DEFAULT_SETTINGS = {
  model: '',              // 空 = 用 codex 自己的默认模型
  effort: 'high',
  summary: 'detailed',
  sandbox: 'workspace-write',
  approvalPolicy: 'never',
  autoOpenOnNeedsUser: true,   // codex 反问时自动打开桌面端
  notifyOnFinish: true,        // 全流程完成发微信
  notifyOnNeedsUser: true,     // 需要拍板时提醒
  sessionTurnLimit: 8,         // 同一 Codex 会话最多连续用几轮就换新(避免撞上下文窗口)
}

export function apply(ctx, config = {}) {
  const store = new StateStore()
  // 用默认值补齐缺失设置(不覆盖用户已存的)
  let settingsDirty = false
  for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...(config.settings || {}) })) {
    if (store.settings[k] === undefined) { store.settings[k] = v; settingsDirty = true }
  }
  if (settingsDirty) store.setSetting('_init', true)

  const s = () => ({ ...DEFAULT_SETTINGS, ...store.settings })
  const log = (...a) => console.log('[codex-pilot]', ...a)

  const bin = findCodexBin()
  if (!bin) {
    console.error('[codex-pilot] 找不到 codex CLI —— 工具仍会注册,但派活会失败。请设置 DSH_CODEX_BIN。')
  } else {
    log('codex CLI:', bin)
  }

  const client = new CodexConnection({ bin, onLog: (e) => { if (e.level !== 'debug') log(e.text) } })
  const runner = new WorkflowRunner({ store, client, log })
  let starting = null

  /**
   * 懒连接: 不主动连,第一次真正要派活时才连。
   * 连接过程会写进 store.connection,面板据此显示 未连接 → 正在连接… → 连接成功 / 连接失败。
   * 失败时面板给"重试"按钮,走 /api/reconnect(或再派一次活)。
   */
  async function ensureClient() {
    if (client.proc && !client.closed) {
      if (store.connStatus() !== CONN.CONNECTED) store.setConnection(CONN.CONNECTED)
      return client
    }
    if (!starting) {
      store.setConnection(CONN.CONNECTING)
      starting = client.start()
        .then((c) => {
          starting = null
          store.setConnection(CONN.CONNECTED)
          log('codex 连接成功')
          return c
        })
        .catch((e) => {
          starting = null
          store.setConnection(CONN.FAILED, e && e.message)
          log('codex 连接失败:', e && e.message)
          throw e
        })
    }
    return starting
  }

  /**
   * 统一"派活前确保已连接"的包装。
   *
   * 为什么要包: ensureClient() 的失败(坏二进制 / 启动超时)如果直接冒出去,
   * 会变成未捕获异常把宿主进程打断(实测踩到过: 接错 codex 路径时整个 DSH 崩)。
   * 这里把它转成工具能正常返回的失败结果,并把连接状态留在面板上(带重试按钮)。
   */
  async function withConnection(fn) {
    try {
      await ensureClient()
    } catch (e) {
      const msg = (e && e.message) || String(e)
      return {
        ok: false,
        status: STATUS.FAILED,
        connection: store.connStatus(),
        message: [
          '❌ 连接 Codex 失败:' + msg,
          '',
          '连接状态已记录在 codex 协作面板上,面板会显示失败原因和「重试连接」按钮。',
          '可以先排查(DSH_CODEX_BIN 路径 / Codex 是否安装 / 是否有其他实例占着),',
          '然后调用 codex_status 查看,或让用户点面板上的重试;修好后再次派活即可。',
        ].join('\n'),
      }
    }
    return fn()
  }

  /** 手动重连(面板上的"重试"按钮走这里) */
  async function reconnect() {
    try { await client.stop() } catch { /* 忽略 */ }
    starting = null
    try {
      await ensureClient()
      return { ok: true, status: store.connStatus(), message: '已重新连接成功' }
    } catch (e) {
      return { ok: false, status: store.connStatus(), error: store.connection.error, message: '重连失败: ' + (e && e.message) }
    }
  }

  // ---------------------------------------------------------------- 小工具

  /** 从 agent 执行上下文里取工作目录(DSH 不同版本字段可能不同,做兼容) */
  function cwdOf(exec) {
    const cand = exec?.cwd || exec?.workspaceRoot || exec?.workspace?.root || exec?.context?.cwd
    return cand || process.cwd()
  }

  /**
   * 取发起本次调用的 DSH 会话 id。
   * dsh-tools 的 ToolRunContext 上有 `agent`(Agent.id 就是 SessionId,见 dsh-agent runtime-types)。
   * 面板靠它把任务绑到"当前会话"上: 没让 Codex 干过活的会话 ⇒ 面板显示初始状态。
   * 多路径兜底: 不同 DSH 版本可能把会话 id 挂在 agent / session / 顶层不同位置。
   */
  function sessionIdOf(exec) {
    if (!exec) return null
    const cand = [
      exec.agent && exec.agent.id,
      exec.agent && exec.agent.sessionId,
      exec.agent && exec.agent.session && exec.agent.session.id,
      exec.session && exec.session.id,
      exec.session,
      exec.sessionId,
    ]
    for (const v of cand) if (typeof v === 'string' && v) return v
    return null
  }

  function requireActiveRun() {
    const run = store.activeRun()
    if (!run) throw new Error('当前没有进行中的 Codex 任务。先调用 codex_workflow_start。')
    return run
  }

  function statusLine() {
    const run = store.activeRun()
    if (!run) return 'Codex 状态: 未干活'
    const ph = phaseInfo(run.phase)
    // 注意别在这里写“状态: …”: 这段文本会进 toolResult 的 message,
    // 早前版本因此污染了 status 字段(消息里出现“状态: 干活中 → 干活完成”)。
    return `当前: ${STATUS_LABEL[run.status] || run.status} | 阶段: ${ph?.name || run.phase} | 会话: ${String(run.currentThreadId || '').slice(0, 8)}…`
  }

  /** 把 needsUser 变成给 agent 的清晰指令(agent 要么问用户,要么调 codex_choose 代答) */
  function needsUserHint(result) {
    if (!result?.needsUser) return ''
    const n = result.needsUser
    if (n.kind === 'approval') {
      const cmd = n.params?.command ? `要执行: ${n.params.command}` : ''
      return [
        '',
        '⚠️ Codex 请求批准一个操作(它现在被卡住,不会继续):',
        `  请求方法: ${n.method}`,
        cmd ? `  ${cmd}` : '',
        '请把这件事告诉用户并征求同意;同意就调用 codex_choose(decision="accept" 或 "acceptForSession"),不同意用 "decline"。',
      ].filter(Boolean).join('\n')
    }
    const qs = n.questions || []
    const lines = ['', '⚠️ Codex 在向用户提问(它被卡住,等回答):']
    for (const q of qs) {
      lines.push(`  · ${q.title || q.question || JSON.stringify(q)}`)
      if (q.options?.length) lines.push(`    选项: ${q.options.join(' / ')}`)
    }
    lines.push('请把问题转达给用户 —— **优先用 DSH 自带的 ask_user_question 工具**把问题做成选项问用户;')
    lines.push('拿到答案后调用 codex_choose(answers={...}) 代答。')
    lines.push('如果用户想去 Codex 里亲自决定,调用 codex_open 打开桌面端定位到那个会话。')
    return lines.join('\n')
  }

  // ---------------------------------------------------------------- 工具注册

  const tools = ctx.tools

  tools.register(tool({
    name: 'codex_workflow_start',
    description: '启动一条"DSH × Codex"协作工作流(需求文档 → UI设计 → 写代码 → 测试验收)。' +
      '当用户提出要做某个功能/产品,并且需要先头脑风暴+写需求文档、再设计 UI、再实现、最后验收时使用。' +
      '调用后请在 Codex 干活的整个过程中持续用 codex_status 汇报进度(面板也会实时显示)。',
    parameters: {
      requirement: { type: 'string', description: '用户的原始需求描述(尽量完整,越具体越好)' },
      title: { type: 'string', description: '任务短标题(用于面板与会话命名),可选' },
      model: { type: 'string', description: '可选。codex 模型,如 gpt-6.1-sol / gpt-6-sol / gpt-5.6-terra;不传用设置里的默认' },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const title = String(args.title || args.requirement || '').trim().slice(0, 60) || '未命名任务'
      const sessionId = sessionIdOf(exec)
      const run = store.newRun({ title, cwd, sessionId, model: args.model || s().model || null, meta: { requirement: args.requirement } })
      log(`新任务 ${run.id} | ${title} | ${cwd}`)
      return {
        ok: true,
        runId: run.id,
        title: run.title,
        cwd,
        phases: PHASES.map((p) => `${p.name}(${p.by})`).join(' → '),
        message: `工作流已创建。建议下一步调用 codex_requirements 让 Codex 头脑风暴并写需求文档。\n${statusLine()}`,
      }
    },
  }))

  tools.register(tool({
    name: 'codex_requirements',
    description: '阶段一: 让 Codex 与用户头脑风暴并编写需求文档 docs/requirements.md。' +
      '会在项目目录里为 Codex 新开一个会话。返回后按 needsUser 提示决定是否要问用户。',
    parameters: {
      brief: { type: 'string', description: '给 Codex 的需求说明/补充(把用户的原话尽量带上)' },
    },
    async execute(args) {
      return withConnection(async () => {
        const run = requireActiveRun()
        const res = await runner.runPhase(run, 'requirements', { brief: args.brief || run.meta?.requirement || '', effort: s().effort, summary: s().summary })
        return toolResult('需求文档', res)
      })
    },
  }))

  tools.register(tool({
    name: 'codex_ui_design',
    description: '阶段二: 让 Codex 根据需求文档做 UI 设计,产出 docs/ui-design.md 与可点击 HTML 原型 docs/ui-prototype.html。',
    parameters: {
      brief: { type: 'string', description: '补充说明(如风格偏好、必须包含的页面),可选' },
    },
    async execute(args) {
      return withConnection(async () => {
        const run = requireActiveRun()
        // 同阶段同类活复用会话: 这条工作流已有设计会话就续用,没有才新开
        const hasUiThread = (run.threads || []).some((t) => (t.sessionKey || t.phase) === 'ui')
        const res = await runner.runPhase(run, 'ui', {
          brief: args.brief || '',
          effort: s().effort,
          summary: s().summary,
          sessionKey: 'ui',
          freshSession: !hasUiThread,
        })
        return toolResult('UI 设计', res)
      })
    },
  }))

  tools.register(tool({
    name: 'codex_design_change',
    description: '让 Codex 处理一次"设计层面的改动"(配色/字体/间距/布局/组件形态/交互流程/文案层级/图标/空态错误态等)。' +
      '在调用 codex_code_begin 写代码之前,凡是用户提出的设计调整都必须先走这个工具,由 Codex 更新 docs/ui-design.md 与 docs/ui-prototype.html;' +
      '写代码过程中又出现设计修改,也先走它再回来改代码。纯实现层面的决定(用哪个库、函数怎么写)不需要它。',
    parameters: {
      change: { type: 'string', description: '要改什么(把用户的原话带上): 例如"主按钮从蓝色改成品红""列表项改成卡片式"' },
    },
    async execute(args) {
      return withConnection(async () => {
      const run = requireActiveRun()
      const change = String(args.change || '').trim()
      if (!change) return { ok: false, message: '请把要改的设计内容写进 change 参数' }
      store.appendLog(run, 'info', `设计改动交给 Codex: ${change.slice(0, 120)}`)
      const res = await runner.runPhase(run, 'ui', {
        brief: '这是一次**增量设计改动**(不是从零设计),请只改受影响的部分:\n' + change,
        effort: s().effort,
        summary: s().summary,
        sessionKey: 'ui',
        freshSession: false,   // 设计修改一律续用同一个设计会话
      })
      return toolResult('设计改动', res)
      })
    },
  }))

  tools.register(tool({
    name: 'codex_code_begin',
    description: '阶段三开始标记: 告诉面板"接下来 DSH 自己写代码"。在开始改代码前调用一次,写完代码后调用 codex_code_done。',
    parameters: {
      note: { type: 'string', description: '本轮实现要点,可选(会记录到日志)' },
    },
    async execute(args) {
      const run = requireActiveRun()
      /*
       * 设计闸门: 用户这次的任务里含"设计意图",但 Codex 还没出过设计 ⇒ 不给门票。
       *
       * 为什么要在代码层面拦: 光靠系统提示词约束不住 —— 实测 DSH 会在用户说
       * "改一下设计"时自己动手改样式(觉得那是"实现细节")。这里按 note/需求里的
       * 设计关键词做硬约束。纯后端 / 纯 CLI 任务不含这些词,不会被误拦。
       */
      const note = String(args.note || '')
      const requirement = String(run.meta?.requirement || '')
      const DESIGN_WORDS = /设计|配色|颜色|颜色值|主色|字体|字号|间距|布局|样式|组件形态|卡片|按钮|图标|图标库|交互|动画|视觉|UI|UX|空态|错误态|主题|深浅色|圆角|阴影/
      const mentionsDesign = DESIGN_WORDS.test(note) || DESIGN_WORDS.test(requirement)
      const hasDesign = run.threads.some((t) => t.phase === 'ui')
      if (mentionsDesign && !hasDesign) {
        store.appendLog(run, 'warn', '拦截: 任务涉及设计,但 Codex 还没出设计稿,不许开始写代码')
        return {
          ok: false,
          blocked: true,
          runId: run.id,
          message: [
            '⛔ 已拦截: 这次任务涉及设计层面,但这条工作流还没有任何 Codex 设计产出。',
            '',
            '按规则,设计层面的事(配色/字体/间距/布局/组件形态/交互/空态错误态…)全部归 Codex。',
            '请先调用 codex_design_change,把用户这次要改的设计内容原话传进 change 参数',
            '(例如"主按钮从蓝色改成品红,列表改成卡片式"),等 Codex 更新完 docs/ui-design.md 与',
            'docs/ui-prototype.html,再调用 codex_code_begin 进入写代码。',
          ].join('\n'),
        }
      }
      await runner.runLocalPhase(run, 'code', note)
      return { ok: true, runId: run.id, message: `面板已切到"写代码(DSH)"阶段。${note ? '要点: ' + note : ''}` }
    },
  }))

  tools.register(tool({
    name: 'codex_code_done',
    description: '阶段三结束标记: 告诉面板 DSH 写完代码了,并记录提交说明(会作为验收阶段给 Codex 的上下文)。',
    parameters: {
      summary: { type: 'string', description: '实现说明: 改了哪些文件、实现了哪些需求条目' },
      files: { type: 'string', description: '关键文件清单(逗号分隔),可选' },
    },
    async execute(args) {
      const run = requireActiveRun()
      const artifacts = String(args.files || '').split(/[,,\n]/).map((f) => f.trim()).filter(Boolean)
        .map((path) => ({ kind: 'code', path }))
      runner.finishLocalPhase(run, 'code', { summary: args.summary || '', artifacts })
      return { ok: true, message: '已标记代码完成。下一步建议调用 codex_acceptance 让 Codex 做测试验收。' }
    },
  }))

  tools.register(tool({
    name: 'codex_acceptance',
    description: '阶段四: 让 Codex 按需求文档对当前项目做测试与验收,产出 docs/acceptance-report.md 并给出 PASS/FAIL 结论。' +
      '返回 FAIL 时表示需要 DSH 返工,请按报告里的问题清单修复后再次调用本工具(最多自动返工 ' + MAX_REWORK + ' 次)。',
    parameters: {
      brief: { type: 'string', description: '给验收阶段的补充说明(例如重点验证什么、如何启动项目)' },
    },
    async execute(args) {
      return withConnection(async () => {
      const run = requireActiveRun()
      const res = await runner.runPhase(run, 'acceptance', { brief: args.brief || '', effort: s().effort, summary: s().summary })
      if (res.needsUser || res.status === STATUS.WAITING_INPUT) return toolResult('测试验收', res)

      const verdict = res.ok ? (res.verdict || parseVerdict(res.finalMessage)) : null
      let extra = ''
      if (verdict === 'FAIL') {
        run.reworkCount = (run.reworkCount || 0) + 1
        store.appendLog(run, 'warn', `验收未通过,返工计数 ${run.reworkCount}/${MAX_REWORK}`)
        store.updateRun(run, {})
        if (run.reworkCount >= MAX_REWORK) {
          extra = `\n⛔ 已连续返工 ${run.reworkCount} 次仍未通过。请把剩余问题告诉用户,让用户决定是否继续。`
        } else {
          extra = `\n🔁 需要返工: 请按验收报告的问题清单修复代码,然后再次调用 codex_acceptance(第 ${run.reworkCount + 1} 次)。`
        }
      } else if (verdict === 'PASS') {
        extra = '\n✅ 验收通过。整条流程已走完,可以通知用户完成了(调用 codex_finish 收尾)。'
      } else if (res.ok) {
        extra = '\n⚠️ 没能从回复里解析出 PASS/FAIL 结论,请读 docs/acceptance-report.md 自行判断后再决定是否返工。'
      }
      return { ...toolResult('测试验收', res), verdict, reworkCount: run.reworkCount || 0, message: (toolResult('测试验收', res).message + extra) }
      })
    },
  }))

  tools.register(tool({
    name: 'codex_choose',
    description: '代 Codex 做决定: 它请求批准某个操作时用 decision 批准/拒绝;它向你提问时用 answers 回答。必须先看 codex_status 或上一步工具返回的 needsUser。',
    parameters: {
      decision: { type: 'string', enum: ['accept', 'acceptForSession', 'decline', 'cancel'], description: '审批类请求的答复(仅当 Codex 请求批准操作时使用)' },
      answers: { type: 'object', additionalProperties: true, description: '问答类请求的答复: {questionId 或问题标题: 答案}。仅当 Codex 提问时使用' },
      note: { type: 'string', description: '可选。给用户看的说明' },
    },
    async execute(args) {
      const run = requireActiveRun()
      const res = runner.answerPending(run, { decision: args.decision, answers: args.answers })
      return { ...res, runId: run.id, note: args.note || undefined }
    },
  }))

  tools.register(tool({
    name: 'codex_status',
    description: '查看 Codex 当前状态(未干活/干活中/干活完成/干活失败/等你决策)、阶段进度、最近日志与产出文件。干活过程中随时调用。',
    parameters: {
      tail: { type: 'number', description: '日志条数(默认 15)' },
    },
    async execute(args) {
      const run = store.activeRun()
      if (!run) {
        const recent = store.snapshot().runs.slice(0, 3).map((r) => `- ${r.title} (${STATUS_LABEL[r.status]})`)
        return { ok: true, status: 'idle', message: 'Codex 未干活。\n最近任务:\n' + (recent.join('\n') || '(暂无)') }
      }
      const tail = Math.max(1, Math.min(100, Number(args.tail) || 15))
      const logs = run.log.slice(-tail).map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.kind}: ${l.text}`)
      return {
        ok: true,
        runId: run.id,
        status: run.status,
        statusText: STATUS_LABEL[run.status] || run.status,
        phase: run.phase,
        phaseName: phaseInfo(run.phase)?.name || run.phase,
        threadId: run.currentThreadId,
        needsUser: run.needsUser || null,
        reworkCount: run.reworkCount || 0,
        artifacts: run.artifacts,
        log: logs,
        message: [
          statusLine(),
          `进度: ${PHASES.map((p, i) => (i === run.phaseIndex ? `【${p.name}】` : p.name)).join(' → ')}`,
          run.reworkCount ? `返工次数: ${run.reworkCount}` : '',
          run.artifacts.length ? `产出: ${run.artifacts.map((a) => a.path).filter(Boolean).join(', ')}` : '',
          '',
          '最近日志:',
          ...logs,
          needsUserHint({ needsUser: run.needsUser }),
        ].filter(Boolean).join('\n'),
      }
    },
  }))

  tools.register(tool({
    name: 'codex_open',
    description: '打开 Codex 桌面端并定位到当前会话 —— 当 Codex 提问而用户想直接去 Codex 里拍板时调用。',
    parameters: {},
    async execute() {
      const run = store.activeRun()
      const res = await openInDesktop(run?.currentThreadId, run?.cwd)
      return { ok: res.ok, via: res.via, threadId: run?.currentThreadId || null, message: res.ok ? '已打开 Codex 桌面端' : '打开失败,请手动打开 Codex' }
    },
  }))

  tools.register(tool({
    name: 'codex_interrupt',
    description: '中断 Codex 当前正在干的活(用户在面板或对话里要求停止时使用)。',
    parameters: {
      reason: { type: 'string', description: '中断原因,可选' },
    },
    async execute(args) {
      const run = requireActiveRun()
      const ok = await client.interrupt(run.currentThreadId, run.currentTurnId)
      store.appendLog(run, 'warn', `用户中断: ${args.reason || '未说明原因'}`)
      if (ok) store.setStatus(run, STATUS.FAILED, { error: '已中断: ' + (args.reason || '用户主动停止') })
      return { ok, message: ok ? '已请求中断 Codex 回合' : '中断失败(可能没有进行中的回合)' }
    },
  }))

  tools.register(tool({
    name: 'codex_finish',
    description: '收尾: 整条流程完成后调用 —— 标记任务完成,并按设置给用户发一条微信/系统通知。',
    parameters: {
      summary: { type: 'string', description: '一句话总结这次干了什么,可选(会写进通知)' },
      notify: { type: 'boolean', description: '是否发通知(默认按设置,true)' },
    },
    async execute(args) {
      const run = store.activeRun() || store.snapshot().runs[0]
      if (!run) return { ok: false, message: '没有可收尾的任务' }
      const phases = PHASES.map((p) => p.name)
      store.finishRun(run, STATUS.DONE, { summary: args.summary || null })
      let notified = null
      if (args.notify !== false && s().notifyOnFinish) {
        notified = await notifyUser({
          title: 'DSH × Codex',
          message: completionMessage({ title: run.title, phases }) + (args.summary ? `\n${args.summary}` : ''),
          wechat: true,
          system: true,
        })
      }
      return { ok: true, runId: run.id, notified, message: '已标记完成' + (notified ? '(已尝试发送微信/系统通知)' : '') }
    },
  }))

  /** 工具返回的统一封装 */
  function toolResult(phaseName, res) {
    const parts = []
    if (!res.ok && res.error) {
      parts.push(`❌ Codex 干「${phaseName}」失败: ${res.error.message || res.error}`)
    } else if (res.status === STATUS.WAITING_APPROVAL || res.status === STATUS.WAITING_INPUT) {
      parts.push(`⏸️ Codex 干「${phaseName}」时停下等人(状态: ${STATUS_LABEL[res.status] || res.status})。`)
    } else if (res.ok) {
      parts.push(`✅ Codex 完成「${phaseName}」(工具调用 ${res.toolCount ?? 0} 次)。`)
    }
    if (res.finalMessage) parts.push('', 'Codex 的结论:', String(res.finalMessage).slice(0, 3000))
    if (res.reasonText) parts.push('', '思考摘要(节选):', String(res.reasonText).slice(-1200))
    const hint = needsUserHint(res)
    if (hint) parts.push(hint)
    return {
      ok: Boolean(res.ok),
      status: res.status,
      threadId: res.threadId,
      finalMessage: res.finalMessage || null,
      needsUser: res.needsUser ? { kind: res.needsUser.kind, method: res.needsUser.method, questions: res.needsUser.questions || null } : null,
      message: parts.filter(Boolean).join('\n'),
    }
  }

  // ---------------------------------------------------------------- 系统提示注入
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    assembled.sections.push({
      name: 'dsh-codex-pilot',
      text: [
        '你可以调用本机 Codex(通过 codex-pilot 插件)来协作干活。判断标准:',
        '- 用户提出"做个功能/产品"且需要先写需求文档、做 UI 设计、实现、验收 —— 用 codex_workflow_start 起流程,',
        '  然后按 codex_requirements → codex_ui_design → codex_code_begin/codex_code_done → codex_acceptance 推进。',
        '- 需求文档、UI 设计、测试验收这三件事交给 Codex;写代码由你自己完成。',
        '- **设计改动一律交给 Codex**。在调用 codex_code_begin 开始写代码之前,凡是涉及设计层面的调整',
        '  (配色/字体/间距/布局/组件形态/交互流程/文案层级/图标/空态与错误态等),',
        '  都必须先调用 codex_design_change 让 Codex 更新设计文档与原型,**不要自己就地改样式**。',
        '  只有纯实现层面的决定(用什么库、怎么写函数、文件怎么拆)才由你自己定。',
        '  写代码过程中用户又提了设计修改,同样先走 codex_design_change 再回来改代码。',
        '- Codex 干活期间用 codex_status 汇报进度(面板会实时显示四态: 未干活/干活中/干活完成/干活失败)。',
        '- Codex 反问或请求批准时,它会停下等你;把问题如实转达给用户 —— 优先用 ask_user_question',
        '  把 Codex 的问题做成选项问用户,拿到答复后用 codex_choose 代答,',
        '  或者用 codex_open 让用户直接在 Codex 桌面端里决定。',
        '- 用户只是闲聊、问问题、改点小东西时**不要**拉 Codex 干活,别浪费额度。',
        '- 整条流程结束后用 codex_finish 收尾,它会按设置发一条微信通知给用户。',
      ].join('\n'),
    })
    return assembled
  })

  // ---------------------------------------------------------------- HTTP / SSE
  const webServer = ctx.webServer ?? ctx.get('webServer')
  const sseClients = new Set()

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
      req.on('end', () => {
        if (!data) return resolve({})
        try { resolve(JSON.parse(data)) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  /** 把当前快照推给所有 SSE 订阅者 */
  function broadcastSnapshot() {
    if (!sseClients.size) return
    const payload = JSON.stringify({ type: 'snapshot', snapshot: store.snapshot() })
    for (const res of sseClients) {
      try { res.write(`data: ${payload}\n\n`) } catch { sseClients.delete(res) }
    }
  }

  store.subscribe(() => broadcastSnapshot())

  // 外部改动轮询: 状态文件被别的进程写(另一个 DSH 实例 / 脚本)时,
  // reloadIfChanged 会换掉内存副本 —— 但那条路径不经过 store.save(),
  // 所以订阅者收不到通知(实测: SSE 只收到初始帧,面板得等 5s 轮询才刷新)。
  // 这里周期性对一次账,有变化就主动推一帧。
  {
    const t = setInterval(() => {
      try { if (store.reloadIfChanged()) broadcastSnapshot() } catch { /* 忽略 */ }
    }, 2000)
    if (typeof t.unref === 'function') t.unref()
  }

  if (webServer) {
    webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const path = url.pathname
        const method = (req.method || 'GET').toUpperCase()

        try {
          // 状态文件可能被别的进程改过(另一个 DSH 实例 / 手工编辑),
          // 每次请求先对齐一次,免得面板读到过期的内存副本。
          store.reloadIfChanged()

          // --- SSE: 面板实时状态 ---
          if (path === `${API}/events` && method === 'GET') {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            res.write(': connected\n\n')
            res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: store.snapshot() })}\n\n`)
            sseClients.add(res)
            const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* 忽略 */ } }, 20000)
            if (typeof ping.unref === 'function') ping.unref()
            req.on('close', () => { clearInterval(ping); sseClients.delete(res) })
            return
          }

          // --- 全量状态 ---
          if (path === `${API}/snapshot` && method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') || ''
            // 面板跟会话走: 带 sessionId 时返回该会话自己的任务(没有 ⇒ null ⇒ 前端显示初始态)
            const sessionRun = sessionId ? store.runsForSession(sessionId) : null
            const conn = store.connection
            return sendJson(res, 200, {
              ok: true,
              snapshot: store.snapshot(),
              status: store.currentStatus(),
              statusText: STATUS_LABEL[store.currentStatus()],
              connection: conn.status,
              connectionText: CONN_LABEL[conn.status] || conn.status,
              connectionError: conn.error,
              sessionId: sessionId || null,
              sessionRun,                                  // 该会话自己的任务(可能为 null)
              sessionStatus: sessionRun ? sessionRun.status : STATUS.IDLE,
              phases: PHASES,
              codexAvailable: Boolean(bin),
              codexBin: bin || null,
            })
          }

          // --- 手动重连(连接失败时面板的"重试"按钮) ---
          if (path === `${API}/reconnect` && method === 'POST') {
            const out = await reconnect()
            return sendJson(res, out.ok ? 200 : 500, out)
          }

          // --- 代答 Codex 提问 / 审批 ---
          if (path === `${API}/answer` && method === 'POST') {
            const body = await readBody(req)
            const run = store.getRun(body.runId) || store.activeRun()
            if (!run) return sendJson(res, 404, { ok: false, message: '没有进行中的任务' })
            const out = runner.answerPending(run, { decision: body.decision, answers: body.answers })
            return sendJson(res, out.ok ? 200 : 400, out)
          }

          // --- 中断 ---
          if (path === `${API}/interrupt` && method === 'POST') {
            const body = await readBody(req)
            const run = store.getRun(body.runId) || store.activeRun()
            if (!run) return sendJson(res, 404, { ok: false, message: '没有进行中的任务' })
            const ok = await client.interrupt(run.currentThreadId, run.currentTurnId)
            if (ok) {
              store.setStatus(run, STATUS.FAILED, { error: '用户从面板中断' })
              store.appendLog(run, 'warn', '用户从面板点了中断')
            }
            return sendJson(res, ok ? 200 : 400, { ok, message: ok ? '已请求中断' : '中断失败(可能没有进行中的回合)' })
          }

          // --- 打开 Codex 桌面端 ---
          if (path === `${API}/open` && method === 'POST') {
            const body = await readBody(req)
            const run = store.getRun(body.runId) || store.activeRun()
            const out = await openInDesktop(body.threadId || run?.currentThreadId, run?.cwd)
            return sendJson(res, out.ok ? 200 : 500, { ok: out.ok, via: out.via, threadId: run?.currentThreadId || body.threadId || null })
          }

          // --- 在用户电脑上打开一个产物文件(面板上点产物标签) ---
          if (path === `${API}/open-artifact` && method === 'POST') {
            const body = await readBody(req)
            const run = store.getRun(body.runId) || store.activeRun()
            const raw = String(body.path || '').trim()
            if (!raw) return sendJson(res, 400, { ok: false, message: '缺少 path 参数' })
            // 绝对路径直接用;相对路径按任务工作目录解析
            const abs = raw.startsWith('/') ? raw : join(run?.cwd || process.cwd(), raw)
            if (!existsSync(abs)) {
              return sendJson(res, 404, { ok: false, message: '文件不存在: ' + abs })
            }
            const opened = await new Promise((resolve) => {
              execFile('open', [abs], { timeout: 10000 }, (err) => resolve(!err))
            })
            if (opened) return sendJson(res, 200, { ok: true, path: abs, message: '已用系统默认程序打开' })
            // open 失败时退一层: 在 Finder 里显示
            const revealed = await new Promise((resolve) => {
              execFile('open', ['-R', abs], { timeout: 10000 }, (err) => resolve(!err))
            })
            return sendJson(res, revealed ? 200 : 500, {
              ok: revealed,
              path: abs,
              message: revealed ? '没有默认打开方式,已在 Finder 中定位该文件' : '打开失败',
            })
          }

          // --- 设置读写 ---
          if (path === `${API}/settings`) {
            if (method === 'GET') return sendJson(res, 200, { ok: true, settings: s(), codexAvailable: Boolean(bin) })
            const body = await readBody(req)
            for (const k of Object.keys(DEFAULT_SETTINGS)) {
              if (body[k] !== undefined) store.settings[k] = body[k]
            }
            store.setSetting('_updatedAt', Date.now())
            return sendJson(res, 200, { ok: true, settings: s() })
          }

          // --- 工具清单(给面板"能干什么"用) ---
          if (path === `${API}/tools` && method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              tools: TOOL_DOCS,
            })
          }

          // --- 清空当前任务日志 ---
          if (path === `${API}/run/clear-log` && method === 'POST') {
            const body = await readBody(req)
            const run = store.getRun(body.runId) || store.activeRun()
            if (run) store.clearLog(run.id)
            return sendJson(res, 200, { ok: true })
          }

          // --- 切换活跃任务 ---
          if (path === `${API}/run/activate` && method === 'POST') {
            const body = await readBody(req)
            if (store.getRun(body.runId)) store.setActive(body.runId)
            return sendJson(res, 200, { ok: true, snapshot: store.snapshot() })
          }

          return sendJson(res, 404, { ok: false, message: '未知端点: ' + path })
        } catch (e) {
          log('路由异常', path, e && e.message)
          return sendJson(res, 500, { ok: false, message: e && e.message })
        }
      },
    })
    log('已注册路由', ROUTE)
  } else {
    console.error('[codex-pilot] 没有 webServer 服务,面板将无法读取状态(工具仍可用)')
  }

  // 卸载清理
  ctx.effect?.(() => async () => {
    for (const res of sseClients) { try { res.end() } catch { /* 忽略 */ } }
    sseClients.clear()
    await client.stop().catch(() => {})
  }, 'codex-pilot:dispose')
}

/** 面板"能力说明"用(纯展示) */
const TOOL_DOCS = [
  { name: 'codex_workflow_start', desc: '起一条协作工作流(需求→UI→代码→验收)' },
  { name: 'codex_requirements', desc: '阶段一 需求文档(codex)' },
  { name: 'codex_ui_design', desc: '阶段二 UI 设计(codex)' },
  { name: 'codex_design_change', desc: '设计改动交 codex(写代码前必须走它)' },
  { name: 'codex_code_begin', desc: '阶段三 开始写代码(DSH)' },
  { name: 'codex_code_done', desc: '阶段三 代码写完(DSH)' },
  { name: 'codex_acceptance', desc: '阶段四 测试验收(codex,失败自动返工)' },
  { name: 'codex_choose', desc: '代答 codex 的提问/审批' },
  { name: 'codex_status', desc: '查看 codex 状态与日志' },
  { name: 'codex_open', desc: '打开 Codex 桌面端定位会话' },
  { name: 'codex_interrupt', desc: '中断 codex 当前回合' },
  { name: 'codex_finish', desc: '收尾并发通知' },
]
