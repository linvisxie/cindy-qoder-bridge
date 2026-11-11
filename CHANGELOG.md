# 更新记录

版本号跟着 Cindy 插件清单（`plugin/ghost.json` 的 `version`）走。

## 0.1.21

**2026-11-11** · 审查硬化、协议修复与 Qoder 凭据实时读取

本节纳入此前未发布审查改动。公开发行状态以 GitHub Releases 为准，发布不等于本机安装；下方历史记录原样保留，不代表本轮验证结果。

- 旧 issue #15（stream 默认值）与 #19（Responses reasoning）同属本轮剩余问题范围，不再暂缓：三协议仅 `stream === true` 返回 SSE，缺省或 `false` 返回单个 JSON；上游仍可 `stream: true` 后聚合。Responses 流式 / 非流式提供含 `summary_text` 的 reasoning item；流式使用标准 `response.reasoning_summary_part.*` / `response.reasoning_summary_text.*` 事件，不虚构推理内容或 usage。依赖旧默认流式行为的调用方需显式传 `stream: true`。
- 新增 `test/protocol-defaults-reasoning.js`，覆盖协议默认值与 Responses reasoning 回归；实际结果以测试命令输出为准，不固定断言数，不把未运行 / SKIP 记作通过。

- 共享适配器流中错误统一走 worker `formatError` 中文分类，保留已获 usage，并以失败终止。
- 更新强制校验合法的 64 位十六进制 SHA-256，不再允许 size 降级。新增 `download.cjs`：严格限制 GitHub HTTPS repo / tag / asset、逐跳重定向域名、32 MiB 包大小及最多 5 跳。
- 新增 `bootstrap.cjs`，清单 `node.entry` 为 `node/bootstrap.cjs`：先由 `ownership.cjs` 按 `INSTALL_DIR`（`install`）→ `DATA_DIR`（`data`）固定顺序取得 OS 独占锁，之后才加载全部业务模块 / worker。同一安装目录即使数据目录不同也拒绝同时运行；多实例的安装目录和数据目录必须都不同，换端口不能绕过。Windows 命名管道，Linux abstract socket 仅供 offline CI；不扩大权限或平台支持。
- **Qoder #31**：移除 `refreshCredential` 五分钟 time-only fastpath；普通读取立即观察 logout / delete / replace，明确退出或缺失立即清除旧缓存，仅 `temporary` 失败允许旧票 fallback，过期按当前时间判断。DPAPI key 仍按 `Local State` 身份缓存，身份变化使 key cache 失效；key helper 合并单 profile inflight，失败后冷却 1 秒，auth 仍逐次读取。凭据读取区分 `valid` / `absent` / `logged-out` / `temporary`。
- **凭据验收完成**：本机已有布尔验收记录 `stage=complete`、`ok=true`；回归结果以 `node test/credential-reading.js`、`node test/review-regressions.js` 的实际输出为准。真实 Qoder CN 由用户退出后，普通路径立即清缓存；重新登录恢复 `valid`。真实 auth 文件短暂 rename 移除后返回 `absent`、清缓存，并无覆盖地恢复；真实 `Local State` 逐字未改，最终真实登录正常。
- **副本实测边界**：临时副本上的真实 auth 载荷配合 Windows DPAPI 保护的新 AES key 轮换通过，key cache invalidated；副本临时损坏保留旧票，VM 局部推进时间验证 expired，临时副本已删除。未修改 / 轮换 Windows 系统根密钥，也未证明真实客户端自然生成新 key；全程无上游请求。详见 [凭据验收记录](docs/CREDENTIAL-ACCEPTANCE-2026-11-11.md)。独立真实 profile 复读已确认 valid、未过期且与 cache 一致，未修改真实 profile、无上游请求；见[永久布尔证据](docs/credential-acceptance-2026-11-11.json)。
- 安装器等待旧 PID 退出，未退出则停止；退出后同样按 install → data 顺序取得双锁并在安装全过程持有。取得两锁后校验 `latest-attempt.json` 的 attempt 身份，迟到脚本若指针换代或不存在即拒绝复制。持久化每次 journal attempt / result；复制失败尝试回滚，rollback 不覆盖 journal，失败保留诊断与 backup。
- 持久更新目录统一为 `UPDATE_DIR = canonicalDirectory(INSTALL_DIR) + '.updates'`，即规范化安装目录同级的 `<安装目录>.updates`，不再使用数据目录的 `update/`。bootstrap、worker 与安装器都检查此 journal，与 `DATA_DIR` 无关，换数据目录不能绕过。
- 新增 `update-status.cjs`：中断的 copy / rollback 阻止 boot；journal `begin` 与 `applyUpdate` 禁止覆盖尚未恢复的 attempt 指针，`begin` 拒绝 previous `handed_off`。pending handoff 未确认结果时不能新更新，要先检查 `<安装目录>.updates/attempt-*/install.log`，不承诺自动重试。
- **恢复步骤**：Cindy 原生导入完整包不会清除安装目录同级的 journal，也不会自动解除阻断。中断 copy / rollback 失败后保留所有日志与 backup；原生导入完整 `.cindy` 包并确认成功后，停用插件，将 `<安装目录>.updates/latest-attempt.json` 重命名保留诊断，再启用。不要删除备份和日志。
- **不再自动同步 Cindy 宿主安装快照**：移除直接修改 `ghost-install-state` 安装收据以及通过 `process.execPath` 执行同步脚本的做法。运行文件更新成功不等于宿主安装记录刷新；Cindy 0.1.128 没有已验证的公开插件自写收据 API，用户须通过 Cindy 原生导入完整 `.cindy` 包刷新记录。
- 新增登记为 offline 的 `test/bootstrap.js`：以临时安装副本、临时数据目录与独立端口隔离，验证双锁前不加载业务模块 / worker 及目录冲突拒绝启动，不触碰真实安装或依赖登录态。新增 `test/ownership.js`、`test/update-download.js`、`test/update-install-results.js`、`test/update-status.js`、`test/credential-reading.js`、offline `test/credential-key-cache.js`；DPAPI helper 与 credential-reading 回归均已通过，具体结果以命令输出为准。更新共享回归、打包与 CI 登记。执行 `node .github/scripts/ci-run.cjs --mode offline` 及 README 所列脚本获取实际结果，不沿用旧测试计数。
- 验证边界：Cindy 0.1.128 以 `require` 加载 Node entry，已验证 bootstrap 与该方式兼容，公开发行状态以 GitHub Releases 为准，发布不等于本机安装。Windows 安装故障测试使用真实临时目录，不是真实插件安装；本版 Qoder 真实用户退出 / 重登凭据验收已完成，范围与副本实测边界见上文。未运行 / SKIP 不等于通过，不承诺无 bug。

## 0.1.20

**2026-11-04** · 工程质量版本：七个已确认缺陷修复 + CI/CD 门禁 + 可复现构建

这一版几乎没有新功能，重点是把过去几轮代码复审确认的缺陷补齐，并把发布流程做成有据可查的自动化。

### 更新器安全性（改动最大）

**digest 校验不再降级放行。** 以前 `verifyDigest` 遇到两种"信息不全"的情况会静默放行：digest 给了但格式非法会退回"只看文件大小"；digest 与 size 都没有则零校验安装。更新是全链路风险最高的动作，不该存在"信息缺失也装"。现在一律 fail-closed：校验不过就一个字节都不写进安装目录，当前版本继续跑。

**安装脚本失败会回滚。** 以前覆盖中途失败（例如旧进程文件仍被锁）会留下新旧混杂的安装目录，只能靠用户手工拿 `.bak` 还原。现在 catch 里清空安装目录并从备份恢复，然后如实抛错。

**备份不再陈旧。** 备份目录名按旧版本固定，同版本重试时会沿用上次的旧备份，回滚点比预期更老。现在每次覆盖前先删旧备份再建。

### 并发与错误处理

**更新按钮双处理器并发。** `panel.js` 里 `addEventListener` 绑了检查逻辑，同一个按钮又被赋 `btn.onclick` 做安装。两个处理器不会互相注销，进入"安装"状态后点一次按钮，检查和安装会**同时**触发；worker 侧 `applyUpdate` 也没有互斥，存在两次下载、两个安装脚本抢同一安装目录的可能。现在面板是单一处理器 + `updateMode` 状态分支，worker 侧加了 `updateInFlight` 在途锁。

**非流式响应中途出错回裸 500。** 上游开流成功但中途断流或回错误帧时，三条协议的非流式路径以前会把异常冒泡到顶层兜底，回 HTTP 500 + 原始英文异常，绕过了本文件专门写的 `errorStatusOf/errorBodyOf`（排队应 503、上游 401/403/429 应原样透传）。现在三处统一包 catch 走同一套映射；Chat 路径在 catch 里照常 `recordUsage`，不再漏记失败轮次。

### 面板与输入健壮性

**JSON `null` 请求体会 500 并泄漏内部异常。** Chat 端点拿到 `null` 时直接读 `payload.model`，抛 `TypeError` 落到顶层 catch，回 500 + `Cannot read properties of null (reading 'model')`。修法是把 payload 归一化：非对象一律当空对象，让后续校验按 400 回。实测验证：`null` / `{}` / `42` 三种输入现在都进入正常校验路径。

**reqId 去重丢结果。** 电子脑用 `seen` 对 reqId 去重后，同一 reqId 的重发被直接丢弃，不会把已算好的结果再发一次。面板靠每 400ms 重发等回执，一旦回执丢失，面板只能等满超时（签到 30s / 更新 120s）报失败——但签到、`applyUpdate` 这类有副作用的动作可能已经成功，会误导用户重复操作。现在缓存已发出的结果：重发时有结果就重发，还在算就等它算完。

### 额度

**无效额度响应覆盖有效旧额度。** HTTP 200 但内容是无效结构时，以前会把有效旧额度覆盖成 0 并显示"无配额"。现在用 `validUsageResponse()` 校验已知结构，非法响应进入错误路径：保留旧值并标记 `stale`，同时回退到 legacy 接口。

### CI/CD 建设（本版首次引入）

新增三个 GitHub Actions 工作流：

| 工作流 | 作用 |
| --- | --- |
| `ci.yml` | 语法/清单/版本一致性 → 7 个离线测试矩阵 → 打包 + 14 项产物校验；另含 actionlint 与 CodeQL |
| `release.yml` | 只能手动发起；推 `v*` tag 只建草稿 |
| `shared-drift.yml` | 与 trae 仓库比对共享骨架是否同构 |

配套脚本零第三方依赖。测试编排器会核对 `test/` 与分类表是否一致 —— 漏登记的测试直接报错退出，不会静默跳过。需要真实登录态的 5 个脚本明确标为「未运行」而非「通过」。

### 可复现构建（从本版开始）

**从 0.1.20 起，正式资产在同一提交上是字节级可复现的**：任何时区、任何换行状态都产出相同 sha256。

两处修正：

1. **zip 时间戳改用 UTC 分量。** 以前 `dosTime()` 用 `getHours()` 等本地时间字段编码，而传入的是固定时间 `2026-10-29T00:00:00Z`。同一个提交在北京打出 08:00、在 UTC 机器打出 00:00，哈希不同。CI 里的"打两次比对"在同一台机器上跑，发现不了这种漂移。
2. **产物校验对比 git blob，而非工作区文件。** 以前工作区文件被编辑器存成 CRLF 时，包会比提交内容多出几百字节，却照样"校验通过"。现在用 `git cat-file blob` 取提交内容比对，不一致时把字节数差异也打出来。

已验证：本地（Asia/Shanghai）与 GitHub Actions（UTC）打出的包 sha256 完全一致。

### 关于历史版本资产

**此前认为"历史资产不可复现"，实测后需要修正**：它们只是需要当时的构建条件，并非无法复现。

| 资产 | 复现条件 | 实测结果 |
| --- | --- | --- |
| `v0.1.19` | tag 源码 + Asia/Shanghai 时区 + `main.js` 为 CRLF | 得到 `ad490292…`，与 Release 完全一致 |

原因：那份包的 `main.js` 是 9597 字节（CRLF），而 git 里存的是 9363 字节（LF）；打包脚本按工作区读取，所以当时工作区是 CRLF 状态。加上 zip 时间戳用本地时区，两个变量叠加。

**这说明历史资产没有损坏**，内容正确。从 0.1.20 起这两项依赖都被消除。验证旧包完整性请直接用 Release 上的 sha256，不要重打比对。

### 测试

离线 7 个脚本全绿（189 项）。需要真实登录态的 5 个 live 脚本本机实测通过（78 项）。Windows 实机验证了安装、回滚、旧进程占位、陈旧备份四种场景，以及装后启动。

### 仍未解决

- **#15 三协议 `stream` 默认值**：调查确认 Cindy 的 Anthropic 接入探测不传 `stream` 且按 SSE 解析。改成官方语义会让探测失败。当前默认值是刻意的兼容取舍。
- **#19 Responses 链路丢弃 reasoning 内容**：已实证——推理内容不输出，但 `reasoning_tokens` 照常上报。修复需先确定 Responses 输出形态。

---

## 0.1.19

**2026-11-04** · 修缓存命中率被算低（缓存 token 被算了两遍）

### 现象

「缓存拆分」那一行能看到读数（比如 `读 3.0M`），但命中率明显偏低。之前以为是上游没给数据，实际是我们映射错了。

### 原因

Cindy 算命中率用的是（见 `app.asar` 里的 `sI()`）：

```
命中率 = cacheRead / (input_tokens + cacheRead + cacheWrite)
```

两套协议的 `input_tokens` 语义不一样：

| 协议 | 含义 |
| --- | --- |
| OpenAI | `prompt_tokens` = 输入**总量**，已经包含命中缓存的部分 |
| Anthropic | `input_tokens` = 输入里**没走缓存**的净额 |

旧实现把 `prompt_tokens` 直接当 `input_tokens` 发出去，同一批缓存 token 在分子和分母各算一次。

### 实测证据

```
修复前：读=2355  输入=2361  → 2355/(2361+2355) = 49.94%
修复后：读=2355  输入=6     → 2355/(6+2355)    = 99.75%  ← 真值
```

总量守恒：`6 + 2355 = 2361`，与冷启动那轮的 2361 完全一致，说明减法做对了。

Cindy 自己的 OpenAI 路径也是这么减的：`input = max(0, prompt - cached - write)`。

### 改了什么

1. **`anthropicUsage` 扣除缓存**（P1）。`input_tokens = max(0, prompt_tokens - cached - write)`，夹 0 是为了防上游计价边界让 `cached + write` 略大于 `prompt` 时出现负数（负的 `input_tokens` 会让下游除法变 NaN）。
2. **两个缓存字段无条件带上**（P1）。Cindy 用 `hasOwnProperty` 检查 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` 四个字段，缺一个就 `complete=false`，那一轮被当成未结算，连命中率都不显示。
3. **账本不再把未知模型记成 `unknown`**（P2）。`recordUsage(entry, …)` 以前在 `entry` 为 undefined 时只能记 `unknown`，但真实模型名就在 `displayModel` 里。现已改为 `entry || { model: displayModel }`，与 trae 仓库对齐 —— 两个仓库同一件事行为不一致，往往就是 bug 藏身处。

### 边界说明

qoder 上游**只报缓存读、不报缓存写**。实测三次全新前缀的冷启动请求 `cache_creation_input_tokens` 全是 0，而紧接着重复同一前缀能拿到 `read=1154` —— 缓存确实在工作，但建立那一步上游不计「写」。所以界面上的「写 0」是数据源缺失，客户端补不出来，不是这一版能改的。

### 测试

`review-regressions` 新增 9 条断言（含「旧的 49.94% 必须不再出现」这条防回退）、34/34 通过。另：`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0`、`update-chain 51/0`、`features 42/0`、`e2e-package 25/0`、`e2e-panel 10/10`、`e2e-brain 13/13`、`verify-manifest PASS`。

---

## 0.1.18

**2026-11-04** · 修两处「数字变成 0」的假象，以及一条永不消失的红字

### 修了什么

1. **缓存命中率恒为 0，但上游其实命中了**（P1）。Cindy 里「缓存 读 0 · 写 0 · 命中 0%」看着像上游不支持缓存，实际是适配层把真值丢了：`input_tokens_details.cached_tokens` 和 `output_tokens_details.reasoning_tokens` 都硬编码成 0。上游给的是真的——实测同一个前缀连发三次，`cached_tokens` 稳定为 **1792 / 2034（命中 88%）**。现在 `census()` 把两项原样透传，只在上游真没给时才落 0。

2. **Anthropic 协议根本不报缓存命中**。`/v1/messages` 的 `message_delta` 以前只有 `input_tokens` / `output_tokens`，而 Cindy 算命中率读的是 `cache_read_input_tokens`，字段不存在自然就是 0%。现在补上；该字段只在真有命中时出现，避免把「不支持缓存」和「命中 0」混为一谈。

3. **一条瞬时失败会永久挂在面板上**（P2）。线上实测：worker 启动后 10 秒，后台补额度失败一次（`fetch failed`）；8 分钟后额度其实已经刷新成功（`quota.stale = false`、数字是新的），面板那行红字却还在——因为 `lastError` 在整个文件里**只有赋值，没有任何一处清空**。现在按来源分别记账（`models` / `usage`）：

   - 成功刷新只清自己那一项，模型成功不会误清额度错误，反之亦然；
   - 错误带时间戳，显示成「（12 分钟前）额度读取失败：…」，一眼看出是旧账；
   - 额度是旧值时面板在数字后标「（旧值）」，不让上一次的数字冒充当前的。

### 加了什么

- 8 项离线回归：缓存/推理明细必须透传、真实 0 不能被当成缺失、Anthropic 必须报 `cache_read_input_tokens`、成功刷新必须清掉自己的失败、不同来源互不误清、时间戳分档（秒/分钟/小时）、`quotaStale` 标记。
- `adapters.cjs` 导出 `anthropicUsage` / `responsesUsage` / `census` 以便测试。

### 测试

`review-regressions 27/27`、`update-chain 51/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0（1 跳过）`、`features 42/0`、`e2e-package 25/0`、`e2e-brain 13/13`、`verify-manifest PASS`。

**边界**：命中率是否真在 Cindy 界面显示出来，需要桌面端实际对话一次才看得到；本轮只验证到端点返回的 usage 已带真值。

## 0.1.17

**2026-11-03** · 修输入用量记账与自更新的两个假象（issue #10）

### 修了什么

1. **输入用量记的是估算值，不是上游真实值**（P2）。`/v1/messages` 与 `/v1/responses` 的 `opts.inputTokens` 来自 `adapters.estimateTokens(chat.messages)`，是本地按字符估的；上游在 `usage.prompt_tokens` 里给了真值也不看。所以上游说输入 123，账本照样记 1。现在优先用 `opts.usage.prompt_tokens`，拿不到才退回估算，且用 `??` 而非 `||` —— **真实的 0 不会被当成「没有值」再估一遍**。Anthropic 侧的 `input_tokens` 同步修正：流式在 `message_delta` 里补上 `input_tokens`（原来只报了 `output_tokens`），非流式的响应体也不再报本地估算。

2. **自更新只看摘要，不校验包的身份**（P2）。上一轮加了 sha256 校验，但摘要只能证明「下载的字节和发布记录一致」，证明不了「这个包是 Qoder 桥、版本对、入口齐全」。一个 SHA 正确但里面装着别的插件 `ghost.json`、没有 `main.js` 的 ZIP 照样会进安装流程。现在 `validatePackage()` 在解包**之前**先读中央目录逐条校验：条目路径合法且不重复（挡 `../` 与重复项）、有 `ghost.json` 且是合法 JSON、`id` 必须等于 `qoder-bridge`、`schemaVersion` 必须为 3、版本必须等于目标发布且**严格高于当前版本**（挡降级和原地重装）、`entry` / `node.entry` / `panel.html` 与 `main.js` / `panel.js` / `panel.html` / `node/worker.cjs` 以及 `node/adapters.cjs`、`node/update.cjs` 必须都在包里。

3. **解包目录可能被旧残留补齐**（P2）。暂存目录原来是 `stage-<版本>`，同名目录里上次失败留下的文件会混进来，让本该缺失的入口「看起来存在」。现在用 `mkdtempSync` 建唯一目录，`.ps1` / `.cjs` / `.cindy` 也各自带唯一名，顺带隔离并发更新。

4. **安装器根本没启动，却报告 applied 并退出**（P2）。`spawn()` 返回子进程时，`ENOENT`（`powershell.exe` 找不到）和 `EACCES` 是通过**异步 `error` 事件**发出的，原实现没等这个事件，于是先 `return applied: true`、再 `setTimeout(process.exit, 800)` —— 结果就是脚本没跑、worker 却退干净了，插件直接挂掉等人手动重启。现在用 `waitForSpawn()` 等 `spawn` 或 `error`：启动失败就删掉本次的暂存目录与三个临时文件，**抛错且不安排退出**，当前 worker 继续服务。提示语也从「已交给后台脚本」改成「已成功启动后台安装脚本」，不再承诺未发生的事。

### 加了什么

- **`test/review-regressions.js`**，19 项离线行为回归：用 `vm` 加载真实 `worker.cjs`、假上游、假安装器，不联网、不用真实凭据、不执行覆盖安装。覆盖真实输入 123 与 0（流式/非流式 × Anthropic/Responses）、错误插件包、缺 `main.js`、非法入口、`ENOENT`/`EACCES`、以及「启动成功才安排退出」。
- `updater` 导出 `validatePackage` 与 `waitForSpawn`。

### 测试

`review-regressions 19/19`（新）、`update-chain 51/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0（1 跳过）`、`features 42/0`、`e2e-package 25/0`、`e2e-panel 10/10`、`e2e-brain 13/13`、`verify-manifest PASS`。

**边界**：Windows 真机覆盖升级、Cindy 桌面导入、真实账号换票与真实上游对话未在本机独立验证；`spawn` 成功也不等于后续安装一定完成。

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
