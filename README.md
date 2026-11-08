# dsh-codex-pilot

> **Let DSH direct Codex: requirements → UI design → code → acceptance, with a live status panel.**

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 插件,把本机 **Codex** 变成你的协作工友:
**DSH 负责编排与写代码,Codex 负责需求文档 / UI 设计 / 测试验收**,你可以在面板里实时看着它干活。

```
你在 DSH 里说需求
   ↓
DSH 起一条工作流(codex_workflow_start)
   ↓
① 需求文档(Codex)  →  ② UI 设计(Codex)  →  ③ 写代码(DSH)  →  ④ 测试验收(Codex)
                                                                   ↓ 验收 FAIL
                                                                   └─→ 回到 ③ 自动返工(最多 3 次)
   ↓
全部完成 → 发通知(配了微信就发微信,否则发 macOS 通知)
```

---

## 特性

- **四阶段工作流** —— 需求文档 → UI 设计(含可点击 HTML 原型)→ DSH 写代码 → 严格验收(PASS/FAIL 结论 + 证据)。
- **验收失败自动返工** —— Codex 判 FAIL 时,DSH 按缺陷清单修复并重跑验收(次数可配)。
- **设计改动一律交给 Codex** —— 配色/间距/布局/组件/交互等设计层改动都走 Codex 增量更新设计稿;
  `codex_code_begin` 里还有一道硬闸门:有设计意图但还没 Codex 设计产出时,拒绝开始写代码。
- **会话复用** —— UI 设计 + 后续所有设计修改共用**同一个 Codex 会话**(Codex 记得上下文);
  跨阶段各自新开;同一会话连续超过 N 轮自动换新,避免撞上下文窗口。
- **实时状态面板** —— 四态(未干活/干活中/干活完成/干活失败)+ 两个等待态(等你决策/等批准),
  四阶段进度、每阶段 Codex 会话(可一键在 Codex 桌面端打开)、实时工具调用与推理日志。
- **面板跟会话走** —— 输入框那个按钮打开的面板只显示**当前 DSH 会话**自己的 Codex 任务;
  从没用过 Codex 的会话显示初始状态。
- **连接生命周期** —— 懒连接(第一次派活才连):`未连接 → 正在连接… → 连接成功 / 连接失败`,
  失败时面板给**重试**按钮。
- **产物展示** —— 只显示**最新一轮**产出,以可点击的文件名标签呈现,点一下在你电脑上打开。
- **反问处理** —— Codex 提问/请求审批时会被面板和工具捕获;DSH 可以用 `ask_user_question` 转达、
  用 `codex_choose` 代答,或直接用 `codex://threads/<id>` 深链把 Codex 桌面端打开让你亲自决定。

## 环境要求

- **macOS**(插件用到 `open`、`osascript`,以及 Codex 桌面端的 CLI)
- **DeepSeek Harness**,且有 `web` profile(`dsh web`)
- **Codex** —— 装了 Codex 桌面端(ChatGPT.app),或 `codex` CLI 在 `PATH` 里
- 可选:微信发送通道(用于完成通知;没有就退回 macOS 系统通知)

插件**不包含也不安装** Codex,它通过 stdio 驱动 Codex CLI 的 `app-server`。

## 安装

### 方式 A —— 直接从 GitHub 装

```bash
dsh plugin --profile web add git+https://github.com/ChanWingKei1014/dsh-codex-pilot.git
```

然后重启 DSH(或热挂载),刷新页面。面板出现在 **设置 → Codex 协作**。

### 方式 B —— clone 后本地 link(开发用)

```bash
git clone https://github.com/ChanWingKei1014/dsh-codex-pilot.git
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-pilot
```

然后重启 DSH 并刷新页面。

> **必须重启**:宿主半边是插件 entry,不重启的话 API 路由和客户端 bundle 不会被下发;
> 客户端半边还需要刷新一次页面。

## 定位 Codex CLI

按以下顺序查找:

1. `$DSH_CODEX_BIN`
2. `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`(Codex 桌面端自带)
3. `/usr/local/bin/codex`、`/opt/homebrew/bin/codex`

装在其他位置就显式指定:

```bash
export DSH_CODEX_BIN=/path/to/codex
```

## 面板

两个入口,同一份组件:

- **设置 → Codex 协作** —— 完整大页(含设置项与历史任务)
- **输入框左下角**(表情包按钮右边)—— 图标按钮,点开浮层;按钮右上角带状态点

状态点颜色:灰=未干活 / 蓝闪=干活中 / 绿=完成 / 红=失败 / 黄闪=等你决策。

| Codex 状态 | 含义 |
|---|---|
| 未干活 | 没有进行中的任务 |
| 干活中 | Codex 正在执行回合(带脉冲动画) |
| 干活完成 | 这个阶段干完了 |
| 干活失败 | 回合失败 / 超时 / 被中断 |
| 等你决策 | Codex 用文字提问,被卡住等你回答 |
| 等批准 | Codex 请求执行某个操作,等你批准 |

| 连接状态 | 含义 |
|---|---|
| 未连接 | 还没派过活(懒连接) |
| 正在连接… | 正在拉起 codex app-server |
| 连接成功 | 已连通 |
| 连接失败 | 失败,面板显示原因 + **重试连接** 按钮 |

## 注册的工具

| 工具 | 作用 |
|---|---|
| `codex_workflow_start` | 起一条协作工作流(需求 + 项目目录) |
| `codex_requirements` | 阶段一:Codex 写 `docs/requirements.md` |
| `codex_ui_design` | 阶段二:Codex 写 `docs/ui-design.md` + `docs/ui-prototype.html` |
| `codex_design_change` | **设计改动走它**:Codex 增量更新设计稿 |
| `codex_code_begin` / `codex_code_done` | 阶段三:标记 DSH 开始/结束写代码 |
| `codex_acceptance` | 阶段四:Codex 按需求文档验收,产出 `docs/acceptance-report.md` + PASS/FAIL |
| `codex_choose` | 代答 Codex 的提问(`answers`)或审批(`decision`) |
| `codex_status` | 查状态 / 阶段 / 日志 / 产物 |
| `codex_open` | 打开 Codex 桌面端并定位当前会话 |
| `codex_interrupt` | 中断当前回合 |
| `codex_finish` | 收尾并发通知 |

插件还会注入一段系统提示:闲聊别拉 Codex;开始写代码前的**所有设计层改动**必须先走 `codex_design_change`。

## 设置

持久化在 `~/.dsh/dsh-codex-pilot.json`(旧版 `dsh-codex-bridge.json` 会自动兼容读取)。

| 键 | 默认 | 说明 |
|---|---|---|
| `model` | 空 | 留空用 Codex 默认;如 `gpt-6.1-sol`、`gpt-5.6-terra` |
| `effort` | `high` | 思考强度 `low/medium/high/xhigh` |
| `summary` | `detailed` | 思考摘要 `none/concise/detailed` |
| `sandbox` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `approvalPolicy` | `never` | `never` / `on-request` / `on-failure` |
| `sessionTurnLimit` | `8` | 同一会话最多连续跑几轮就换新 |
| `autoOpenOnNeedsUser` | `true` | Codex 反问时把桌面端带到前台 |
| `notifyOnFinish` | `true` | 全流程完成发通知 |

## HTTP API(仅回环)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-codex-pilot/api/snapshot` | 全量状态(支持 `?sessionId=` 只看该会话) |
| GET | `/dsh-codex-pilot/api/events` | SSE 实时推送 |
| GET/POST | `/dsh-codex-pilot/api/settings` | 读写设置 |
| POST | `/dsh-codex-pilot/api/reconnect` | 重连 Codex |
| POST | `/dsh-codex-pilot/api/answer` | 代答提问 / 审批 |
| POST | `/dsh-codex-pilot/api/interrupt` | 中断当前回合 |
| POST | `/dsh-codex-pilot/api/open` | 打开 Codex 桌面端定位会话 |
| POST | `/dsh-codex-pilot/api/open-artifact` | 在本机打开产物文件 |
| POST | `/dsh-codex-pilot/api/run/activate` | 切换活跃任务 |
| POST | `/dsh-codex-pilot/api/run/clear-log` | 清空当前任务日志 |

> 这些自建路由**没有鉴权**(DSH 自建路由本身也不提供认证/TLS)。请只在本机 `127.0.0.1` 使用,不要暴露到公网。

## 实现要点(踩过的坑)

### 会话必须通过 app-server 建,不能用 `codex exec`

`codex exec` 建的会话**永远不会出现在 Codex 桌面端侧边栏** —— 桌面端按 originator 过滤会话。
所以插件启动 app-server 时设置:

```js
CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop'
```

并在 `thread/start` 传 `threadSource: 'user'`。

### 协议信封里没有 `jsonrpc` 字段

```jsonc
{ "id": 1, "method": "thread/start", "params": { ... } }   // 请求
{ "id": 1, "result": { ... } }                             // 响应
{ "method": "turn/completed", "params": { ... } }          // 通知
{ "id": 99, "method": "item/commandExecution/requestApproval", "params": { ... } } // 服务端→客户端请求(必须回)
```

### `turn/completed` ≠ 任务完成

真正的完成判定靠三层:

1. `thread/status/changed` 的 `activeFlags` 含 `waitingOnApproval` / `waitingOnUserInput`
2. 未解决的服务端请求(审批 / 提问)
3. `agentMessage.questions`

Codex 经常不用 `request_user_input` 而是直接在文字里提问,所以还有一层启发式:
**有交付物就不算卡住;没交付物且在等答复才算**。

### 其他坑

- `defineTool` 必须给 `output: { schema, render }`,object 参数必须显式声明 `additionalProperties`。
- 状态落盘有防抖,**终态写入要 `flushNow()`**,否则进程退出会丢。
- 没有 `thread/settings/update`,改模型只能走 `turn/start.model`。
- app-server 意外退出时,在途请求要挂 catch 再 reject,否则 unhandled rejection 会把宿主进程打崩。

## 排障

**面板显示"连接失败"** —— 查 `DSH_CODEX_BIN`、Codex 是否安装、是否被别的进程占用;修好后点面板上的**重试连接**。

**Codex 桌面端看不到会话** —— 确认 originator 覆盖生效(插件会自动设置)。

**收不到微信通知** —— 微信通道是可选的,没有就退回 macOS 系统通知。
若返回 `ret=-2 prepare failed`,是腾讯限制(bot 只能在用户刚发过消息的窗口内下发),
插件会自动转 `--wait` 模式补发。

**设计改动还是 DSH 自己改了** —— 系统提示 + `codex_code_begin` 的设计闸门双重约束。
闸门按任务/需求里的设计关键词触发;如果需求描述完全没提设计,闸门不会拦。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
