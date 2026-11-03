# 更新记录

版本号跟着 Cindy 插件清单（`plugin/ghost.json` 的 `version`）走。

---

## 0.1.16

**2026-11-03** · 把自更新链路补成可靠的，并加英文 README

### 修了什么

1. **自更新不校验下载包**（P1）。`applyUpdate()` 以前下载完直接 `extractZipTo` 覆盖安装目录，没有任何完整性校验 —— CDN 截断或中间人替换时，worker 已经 `process.exit(0)`，Cindy 拉起的就是一份坏代码，只能靠 `.bak-<旧版本>` 手工回滚。现在下载后先比 `asset.digest`（GitHub Releases 自带 `sha256:…`，与本机 dist 包、Cindy 记的 `packageSha256` 三方一致），不一致就抛错、**一个字节都不写进安装目录**，当前版本继续跑。没有 digest 时退回按 `size` 校验；两者都没有才放行并记日志。

2. **自更新成功后不刷新 Cindy 的清单快照**（P1）。Cindy 的「插件管理」页读的是 `ghost-install-state/_ns/_root/<id>.json` 的 `manifest` 与 `plugin-instances.v2.json` 的 `packageSha256`，不是运行中的 `ghost.json`。自更新只覆盖运行文件，于是管理页会退回旧版本 —— 正是 0.1.7 那条 CHANGELOG 自己写的问题。现在替换脚本会在装完后调一个自动生成的 node 脚本同步两处，`receiptRevision` 也一并换新。owner 目录从安装位置反推，不写死任何本机路径。

3. **暂存目录与下载包失败时残留**（P2）。清理以前只写在 PowerShell 脚本最后一行，`$ErrorActionPreference='Stop'` 一旦中途抛错就跳过清理，反复失败会一直往 `update/` 里堆。现在清理放进 `finally`，且下载包和临时同步脚本也一并删。

### 加了什么

- **`plugin/node/update.cjs`**。把版本比较、digest 校验、zip 解包、PowerShell 脚本生成、清单快照同步脚本生成这几段纯函数从 `worker.cjs` 里抽出来。抽出来的理由是它们本来就能离线验证，却因为藏在 worker 里（一 `require` 就 `boot()`）而一条测试都没有。
- **`test/update-chain.js`**，50 项离线回归：`0.1.15` 必须比 `0.1.9` 新（按段比，不是按字符串比）、哈希不符必须拒绝、zip slip 必须挡住、生成的脚本必须等旧进程 / 备份 / 同步快照、路径里的单引号必须正确转义、两份 `update.cjs` 必须逐字相同。
- **英文 README**（`README.en.md`），两个语言版本顶部互相可点切换。

### 顺带

- `parseDigest` 对 `SHA256:` 这种大写算法名原本返回 `undefined`（正则没加 `i`），导致一条合法 digest 被当成「没有 digest」而静默降级。已修，并有测试钉住。
- `pack.cjs` 清单加上 `node/update.cjs`；`e2e-package.js` 的必需文件断言同步加上。

### 测试

`update-chain 50/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0`、`e2e-package 25/0`、`e2e-panel 10/10`、`e2e-brain 13/13`、`verify-manifest PASS`。

## 0.1.15

**2026-11-03** · 新增「检查更新」

### 加了什么

1. **面板按钮**。「复制配置」右边多一个「检查更新」。点一下打 GitHub Releases 查最新版；没新版就写「已是最新版本（当前）」，有新版按钮变成「安装 x.y.z」。装的时候会把 `.cindy` 下载下来解到数据目录，然后交给一个独立的 PowerShell 脚本：等当前 worker 进程退出 → 备份整个安装目录成 `<目录>.bak-<旧版本>` → 覆盖文件 → 删临时目录。Cindy 约 24 秒后用新文件重新拉起 worker。**要点两次**（先「检查」再「安装」），因为装完进程会退出重启，不该被误触。
2. **`qoder_update` 工具**。同一个能力给 agent 用：`action=check` 只查（默认），`action=apply` 下载安装后自动重启。用户问「插件能不能更新 / 有没有新版」时会走到它。

### 为什么要独立脚本

Windows 上正在运行的 `.js` 是被锁住的，worker 覆盖自己一定 `EBUSY` / `EPERM`。所以 `applyUpdate()` 只负责下载 + 解包 + 生成脚本 + 用 `detached` 方式启动它，然后 `setTimeout(() => process.exit(0), 800)` 主动退出（留 800ms 把 RPC 回包写完 stdout）。脚本里的 `Wait-Process -Id <pid> -Timeout 60` 等到进程真没了才开始复制。

### 顺带改的文案

- 面板「在 Cindy 里接入」不再只写 OpenAI 一种协议：现在列出 Chat Completions / Responses / Anthropic Messages 三选一，并说明 Responses 保留 Base URL 末尾的 /v1、Anthropic 用同一个 Base URL 与同一个 API Key。三套协议本来就都实现了（/v1/chat/completions、/v1/responses、/v1/messages），只是面板一直没写。
- ghost.json 的 description / whenToUse 重写：说明起的是三协议本地端点、模型元数据由插件自己公布；适用场景补上「问该选哪个协议」「问上下文窗口填多少」「问有没有新版本」。

### 其它

- 安装目录从 `ghost.json` 的位置反推（`join(__dirname, '..')`），不写死 Cindy 的 `owners/.../_ns/_root` 路径。
- 仓库名可用环境变量 `QODER_BRIDGE_REPO` 覆盖，默认 `linvisxie/cindy-qoder-bridge`。

---

## 0.1.14

**2026-11-03** · 修代码审查（issue #9）报的 7 项

### 修了什么

1. **并行工具调用被拆坏**（P1）。上游把两次工具调用的分片交错着发：首帧 A/B 各带 id 和半截参数，次帧只带参数增量、`name` 是空串。旧实现的 `writeAnthropicStream` 见到新 index 就 `closeOpen()` 把已开的块全关掉，结果是 4 个 `tool_use` 块、后两个名字是空。现在按上游 index 独立累计 id/name/arguments，整轮读完再逐个吐完整块；文本仍照常流式。
2. **缺结束信号就 EOF 被当成正常说完**（P1）。上游会在结束时给 `[DONE]` 或带 `finish_reason` 的帧，两个都没等到就断流，说明这条流是被掐断的。旧实现照常收尾，半截回答会被当完整结果交给 Cindy。现在四个出口（Anthropic 流/非流、Responses 流/非流）以及 Qoder 私有流都要求见到明确结束信号，否则抛「上游在结束信号到达前就断开了连接」。
3. **下游断开不取消上游**（P2）。原先只听 `req` 的 `close`，但客户端断开时请求流往往已经 end 过、事件早发完了。现在同时听 `res` 的 `close`，且只在 `!res.writableEnded` 时 abort；正常结束时摘掉监听。
4. **Anthropic / Responses 两路本地账本漏记输出 token**（P2）。之前无论上游给不给 usage，这两路都固定记 `输出 = 0`。现在适配器把真实 usage 回传，worker 优先记真实值，缺失才当 0。
5. **上游明确的 4xx/5xx 被一律盖成 502**（P2）。`errorStatusOf()` 先看能不能排队重试（→503），再看 `err.status` 是不是合法 4xx/5xx（照原样透出），实在分不清才 502。
6. **.cindy 包里没有许可与第三方声明**（P2）。MIT 要求分发时随附许可与版权声明，而装到别人机器上的包才算真分发。`pack.cjs` 的清单改成 `{from, name}` 结构，从仓库根一并打进 `LICENSE` / `NOTICE` / `THIRD-PARTY-NOTICES.md`。
7. **强制刷新读不到凭据时仍返回内存里的旧 token**（P2）。面板上点「刷新」本意是「重新读一次登录态」，但 `refreshCredential(true)` 只在读到新凭据时覆盖，读不到就继续拿旧 token 去求上游，一路 401 让人以为插件坏了。现在 force 且读不到时清空 `credential` / `credentialAt`，面板会直接显示未登录。

### 另外

- 新增 `test/upstream-contract.js`：把上面第 1、2、4 项做成纯离线回归（交错分片、四种出口的截断判定、usage 回传），不需要登录态和额度。
- `test/e2e-package.js` 增加三条断言：包里必须含 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`。

---

## 0.1.13

修「模型选择器被撑开，整排控件被推离麦克风」。

**现象**：Cindy 输入框右边本来贴着麦克风，装了 Qoder 桥之后模型选择器往左挪了一大截，模型名还被省略号截断。

**原因**：把推理档位拼进了模型显示名。实测长度 `Qwen3.8-Max · x0.2 · 档位 xhigh/low/medium` = 40 字符、`Kimi-K2.8-Preview · x0.8 · 档位 high/low/max` = 42 字符。Cindy 的模型选择器按钮是按名字宽度撑开的，名字一长，整排控件就被往左挤。而档位本来就通过 `/v1/models` 的 `reasoning.supported_efforts` 交给 Cindy，由它自己渲染成独立的下拉控件（界面上显示为「π 低」这类标记），名字里再写一遍是纯冗余。

**改法**：`modelLabel()` 去掉「 · 档位 …」那一段，只留倍率。

```js
function modelLabel(m) {
  const f = m.priceFactor;
  const tag = f === 0 ? ' · 免费' : typeof f === 'number' ? ` · x${f}` : '';
  return `${m.name}${tag}`;
}
```

倍率保留，因为 Cindy 的自定义供应商不解析 `cost` / `displayPricing` 字段，倍率只能塞名字里，而且它短。

**效果**：最长模型名从 42 字符降到 25 字符（`MiniMax-M3.1-Flash · x0.1`），选择器回到麦克风旁边。档位功能一点没少 —— `/v1/models` 的 `reasoning.supported_efforts` 照旧（`qmodel_38max` / `qfmodel` → `xhigh/low/medium`，`dmodel` → `high/max`，`auto` → 空）。

## 0.1.12

处理代码审查（issue #8）报的一轮测试与状态语义问题。

**一、没登录 Qoder 的机器上跑测试不再误报失败**

以前在没装/没登录 Qoder CN 的机器上跑 `node test/features.js` 是 31 通过 2 失败、`node test/e2e-panel.js` 是 3/4 通过。失败项跟功能无关，全是「依赖登录态却硬断言」：

- `features.js` 的「额度重置/会员到期字段存在（可为空）」——未登录时 `refreshUsage` 走的是错误分支，只写 `{at, error}`，压根不会写 `resetAt` / `expiresAt` 这两个键。现在未登录打 `--` 跳过。
- `features.js` 的「/v1/models 可用」——原来把「返回 200」和「模型数 > 0」写进同一条断言，未登录 0 个模型必挂。现在拆开：200 硬断言（接口能用跟登没登录无关），模型列表非空在 0 个时打 `--` 跳过。
- `e2e-panel.js` 的「绿灯」——面板的指示灯本来就是登录绿、未登录红（`panel.js` 里 `signedIn ? 'ok' : 'err'`，未登录给红点才是正确表现），测试却硬断言 `dot ok`。现在断言改成「指示灯状态跟登录态一致」。

**二、Responses 的子项状态跟整体对不上**

`finish_reason` 是 `content_filter` 时，以前顶层报 `failed`（带 `error.code`），子项却因为 `itemStatus` 只有两档而标成 `incomplete`，同一个响应里自相矛盾。

审查建议的修法是「failed 时子项跟随 failed」，但这条**没法照抄**：OpenAI Responses 的 output 项（`message` / `function_call`）`status` 枚举只有 `in_progress` / `completed` / `incomplete`，`failed` 只属于顶层 `Response`。子项标 `failed` 会产出不合 schema 的响应。

所以改的是顶层：内容策略中断和 `max_tokens` 截断一样，本质都是「产出被提前掐掉」，归 `incomplete`，区别只在 `incomplete_details.reason`（`max_output_tokens` / `content_filter`）。这样顶层与子项自洽，`response.incomplete` 事件也带上了 `reason`。`response.failed` 仍然保留给「上游直接报错、压根没产出」那条路径（`upstream_error`）。

**三、补一套离线单元测试**

新增 `test/responses-status.js`（19 项）：不开 worker、不联网、不需要登录，直接把假的 chat chunk 喂给 `responsesMessage` 和 `writeResponsesStream`，检查三种 `finish_reason` 下顶层 status、`incomplete_details.reason`、每个子项 status，以及流式发的终止事件类型。测试里专门有一条「子项 status 只用合法枚举」，防止以后有人照 issue 的建议把 `failed` 写进子项。

变化幅度：`features.js` 42 项全绿、`e2e-panel.js` 10 项全绿（登录态下语义不变），新增的 19 项全绿。

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
