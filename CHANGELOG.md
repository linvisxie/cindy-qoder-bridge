# 更新记录

版本号跟着 Cindy 插件清单（`plugin/ghost.json` 的 `version`）走。

---

## 0.1.11

修一个 codex 引擎必踩的坑：**助手先说一句话、紧接着发起函数调用，整条链路就断**。

报错长这样：

```
{"error":{"message":"请求格式不对: Cannot read properties of undefined (reading 'push')","type":"invalid_request_error"}}
```

原因在 Responses 适配层。`responsesRequestToChat` 把 Responses 的 input 数组翻成 chat 的 messages 时，纯文本的 assistant 消息由 `pushMessage` 造，只有 `{role, content, __assistant:true}`；而 `function_call` 由 `pushCall` 处理，逻辑是「上一条是 assistant 就复用，否则新建一条带 `tool_calls: []` 的」。复用路径没有补数组，`last.tool_calls.push(...)` 就砸在 `undefined` 上。

所以触发条件是「assistant 先输出文本 → 后面跟 function_call」，而这正是 codex 引擎最常见的形态（模型习惯先说「我先看一下」再调工具）。

**这个 bug 0.1.9 就有，不是 0.1.10 引入的**——用 `git show 0c824db:plugin/node/adapters.cjs` 跑同一段复现，一样抛。只是 0.1.10 之前它落进通用 catch 报 500，看不出门道；0.1.10 统一成 `400 请求格式不对：…` 之后才浮出水面。

修法是复用前补一句 `if (!Array.isArray(last.tool_calls)) last.tool_calls = [];`。

实测：assistant 文本 + `function_call` + `function_call_output` 的组合现在 200；连续两个 `function_call` 合成一条 assistant 消息；带 `tools` 且模型真返回 `function_call` 时，输出项类型正确为 `function_call`（`arguments` 原样透传）。八套测试仍全绿。

---

## 0.1.10

处理一轮代码审计报出来的问题。修的都是「出错时表现错了」这一类，正常路径的行为没动：

- **`/healthz` 不再泄露 API Key**：以前它直接吐完整的 `buildStatus()`，任何能连上 `127.0.0.1` 的进程都能拿到本地 Token。现在只回 `{ok, port, modelCount}` 三个字段（端口探测和 Host 守卫要的就是这三个），完整状态挪到需要鉴权的 `GET /status`（`/v1/status` 同义）。
- **端口全占后不再变僵尸**：起监听失败时把 `server` 置回 `null`，否则后续 RPC 看到的是个死对象、`if (!server) await boot()` 不再触发。同时 `buildStatus()` 在没绑上端口时不再谎报 `ok: true`。
- **请求体错误的状态码**：超过 20 MB 回 `413`（以前落进通用 catch 变 500）；JSON 坏掉、请求体为空回 `400`，并说明哪里不对。
- **三条协议统一先校验后鉴权**：`chat` / `messages` / `responses` / `count_tokens` 现在都是「解析 → 翻译 → 查登录态」，畸形 tool 输入一律 `400 请求格式不对：…`，而不是没登录时先报 401、登录后报 500 各说各话。
- **Responses 不再假装成功**：按 `finish_reason` 给状态——`length` → `incomplete` + `incomplete_details.reason: "max_output_tokens"`，`content_filter` → `failed`，其余 `completed`。流式和非流式都改了。
- **Anthropic 流的事件顺序**：工具块之后再来文本时，先 `content_block_stop` 关掉工具块再开文本块，不会出现两个块叠着开。
- **Anthropic 工具参数不再静默变空**：`arguments` 解析失败时保留原文（`__unparsed_arguments`），不当成 `{}` 调用；`tool_result` 缺 `tool_use_id`、`function_call_output` 缺 `call_id` 直接报错，不静默丢。
- **本地账本原子写**：`usage.json` 先写临时文件再 `rename`，并发写不会互相截断；Windows 上 rename 偶发被占用时退回复写并清理临时文件。
- **额度读取失败会说了**：失败时把原因写进 `lastError`，并在 `lastQuota` 上标 `stale` / `staleReason`，面板不再默默显示旧数字。
- **签到不再误判**：「今天已签」现在要求那轮活动窗口真的开着——Qoder 会提前下发明天那轮，以前头天晚上就会显示已签。
- **面板去重表不再全清**：`reqId` 去重从「超 200 条整体清空」改成淘汰最早一条。
- **测试能离线跑了**：`test/features.js` 从 `state.json` 取 token 打 `/status`，未登录时自动跳过需要登录态的用例并打印 `--`（以前模型列表为空会 `TypeError` 崩掉）；`test/e2e-panel.js` 同理，未登录时打 `SKIP` 而不判失败。

测试：host-guard 13、features 42、smoke-protocols 19、smoke-tools 11、wire-quirks 10、e2e-package 21、e2e-panel 10、e2e-brain 13，全绿。

---

## 0.1.9

补齐七件「和 DSH 插件对齐」的体验：

- **每日签到**：面板显示今天签没签、可领多少 Credits、下一次 10:00 的倒计时，带「立即签到」按钮；AI 侧多了 `qoder_checkin` 工具。判据是 `actionType === "CLAIM_BENEFIT"` + `claimStatus` 未领——只看 `claimable` 会把订阅推广（`VIEW_DETAILS`）误当签到。
- **额度与到期**：改用 `/sash/api/v2/me/usage`（失败降级 `/api/v2/quota/usage`），面板多显示「额度重置 / 会员到期」两行。Qoder 接口不给重置时间，此时明说「Qoder 接口没给」而不是画个 `—`。
- **本地用量**：`usage.json` 按天按模型记账，面板显示今日请求数 / tokens / 折算量（token × 倍率），留 60 天。
- **错误码讲人话**：登录失效（105）、每日账单上限（110）、排队（10605 / `RESOURCE_LIMIT`）、限流（429）、网络不通，各自给一句能照着做的中文提示，替换原来直接透传的上游原文。
- **日志落盘**：`bridge.log`，带 ISO 时间戳，超 2 MB 滚成 `.1`。以前日志只进 stderr，Cindy 一重启就没了。
- **倍率可见**：`/v1/models` 的 `name` 带 `· 免费` / `· x0.2` 与推理档位，面板模型列表同样显示，并额外输出 `price_factor` 字段。
- **401 提示**：从 `bad token` 改成「本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。」

已知修不掉的：Cindy 的自定义供应商模型解析器不读 `displayPricing` / `currency` / `cost`，详情页那句「该路由没有报价数据」删不掉。

## 0.1.8

修两处 Cindy 发来的变形请求：

- Base URL 带 `/v1` 时，claude-code 引擎经 `anthropic-compat-proxy` 会拼成 `/v1/v1/messages`，原来回 404。现在折叠重复的 `/v1`。
- 上下文选 1M 时，Cindy 把模型 id 编成 `qfmodel[1m]`，上游不认。现在三条协议入口都先剥掉 `[1m]` 后缀。

新增 `test/wire-quirks.js`（10 项）防回归。

## 0.1.7

端口咬死：优先 `47821`，被占就等最多 30 秒（等上一个 worker 退干净）；仍然占着但对方是健康的 Qoder 桥就让位退出，只有占位者不是本插件时才顺延。修「Cindy 里配好的 Base URL 因为端口漂移失效、界面一直显示重新连接中」。

## 0.1.6

修 claude-code 引擎的 `403 Host 必须是 loopback`：Cindy 的代理转发时把 `Host` 头改成不带端口（`127.0.0.1`），旧守卫要求必须带端口。新增 `test/host-guard.js`（13 项）。

## 0.1.5

补两条协议路由：`POST /v1/messages`（Anthropic）、`POST /v1/responses`（OpenAI Responses）。此前只有 `/v1/chat/completions`，而 Cindy 规定 `claude-code` 只接 `anthropic-messages`、`codex` 只接 `openai-responses`，所以供应商里只剩 `pi` 一个引擎能选。新增 `test/smoke-protocols.js`（19 项）与 `test/smoke-tools.js`（11 项）。

## 0.1.4

修模型元数据形状：Cindy 的解析器只保留白名单字段，顶层 `reasoning_efforts` 与 `context_window` 会被丢弃。改成 `reasoning: { supported_efforts, default_effort }` + `context_window` / `max_context_window`，推理档位与 1M 上下文的选项才出现。

## 0.1.3

修面板显示「未登录 / 0 个 / —」：`cindy.node.request` 返回的是双层信封（宿主 invoke 信封里再套 worker 的 `{ok, result}`），之前只剥一层。

## 0.1.2

端口复用 + 面板脚本外挂。

## 0.1.1

修面板一直显示「正在叫醒插件…」：Cindy 的 CSP 同源但不放行内联 `<script>`，脚本必须外挂成 `panel.js`。

## 0.1.0

首版：读 Qoder CN 登录态，起本地 OpenAI Chat 兼容端点（`/v1/models` + `/v1/chat/completions`），右侧栏面板显示账号与模型。
