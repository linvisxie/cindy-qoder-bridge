# 更新记录

版本号跟着 Cindy 插件清单（`plugin/ghost.json` 的 `version`）走。

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
