/**
 * 通知层 —— 工作流结束时/需要用户拍板时提醒用户。
 *
 * 三条通道(按可用性自动选择, 任一成功即可):
 *   1. 微信: ~/.dsh/skills/wechat-send/send.mjs(DSH 微信桥接的官方入口)
 *      返回 `ret=-2 prepare failed` = 会话窗口过期(腾讯限制: bot 只能在用户刚发过消息的窗口内下发),
 *      此时用 --wait 变体,等用户下次发消息后自动补发。
 *   2. macOS 系统通知: osascript display notification(即时,无窗口限制)
 *   3. 面板内: 由 SSE 推送,前端弹 toast(始终可用,兜底)
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const WECHAT_SCRIPT = join(homedir(), '.dsh', 'skills', 'wechat-send', 'send.mjs')

function runNode(script, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err })
    })
  })
}

function runCmd(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err })
    })
  })
}

/** macOS 系统通知(即时) */
export async function notifySystem(title, message) {
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&')
  const script = `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`
  return runCmd('osascript', ['-e', script])
}

/** 微信通知(走 DSH 微信桥接);wait=true 时窗口过期会挂起等待用户发消息 */
export async function notifyWeChat(message, { wait = false } = {}) {
  if (!existsSync(WECHAT_SCRIPT)) {
    return { ok: false, reason: 'no-script', message: '未找到微信发送脚本 ' + WECHAT_SCRIPT }
  }
  const args = wait ? ['--wait', message] : [message]
  const res = await runNode(WECHAT_SCRIPT, args, wait ? 10 * 60 * 1000 : 30000)
  const out = (res.stdout + res.stderr).trim()
  const windowExpired = /ret=-2|prepare failed|窗口/.test(out)
  return {
    ok: res.ok && !windowExpired,
    windowExpired,
    out: out.slice(0, 400),
  }
}

/** 统一入口: 先微信,失败则系统通知兜底(消息不丢) */
export async function notifyUser({ title = 'DSH × Codex', message, wechat = true, system = true, wait = false } = {}) {
  const results = {}
  if (wechat) {
    results.wechat = await notifyWeChat(message, { wait })
    // 窗口过期(腾讯限制: bot 只能在用户刚发过消息的窗口内下发)时自动转 --wait 补发:
    // 脚本会等用户下次给 bot 发消息后立刻把这条送出去。
    // 不阻塞调用方 —— 活已经干完了,通知晚到总比不到好(实测窗口过期是很常见的状态)。
    if (!results.wechat.ok && results.wechat.windowExpired && !wait && process.env.DSH_CODEX_NO_WAIT_RETRY !== '1') {
      results.wechatRetry = '已转入 --wait 模式等待补发: 你在微信里给 bot 发一条消息后,这条就送达'
      notifyWeChat(message, { wait: true })
        .then((r) => { if (!r.ok) console.warn('[codex-pilot] 微信 --wait 补发失败:', r.out) })
        .catch(() => {})
    }
  }
  if (system && (!results.wechat || !results.wechat.ok)) {
    results.system = await notifySystem(title, message)
  } else if (system) {
    // 微信成功就不再发系统通知(避免打扰);仅在微信失败时兜底
    results.system = { ok: true, skipped: true }
  }
  return results
}

/** 工作流完成时的固定文案(简单一句,按用户要求) */
export function completionMessage({ title, phases = [] } = {}) {
  const head = title ? `「${title}」` : ''
  const tail = phases.length ? ` ${phases.join(' → ')}` : ''
  return `${head}已全部完成 ✅${tail}`
}

/** codex 反问时的文案 */
export function needsInputMessage({ title, question }) {
  return `Codex 在等你拍板${title ? `(${title})` : ''}: ${String(question || '').slice(0, 120)}`
}
