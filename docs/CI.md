# CI / CD

这个仓库的自动化分三层，各管一件事，互不越界：

| 工作流 | 何时跑 | 干什么 | 会不会发版 |
| --- | --- | --- | --- |
| `ci.yml` | 推送到 `main` / `fix/**` / `feat/**` / `ci/**`，以及所有指向 `main` 的 PR | 语法、清单、版本号、离线测试矩阵、打包校验、CodeQL | 不会 |
| `shared-drift.yml` | `.github/**` 或 `plugin/node/update.cjs` 有改动时 | 与另一个桥仓库比对共享骨架是否还能逐字对上 | 不会 |
| `release.yml` | 只有人手动点，或推了 `v*` tag | 全量测试、两次打包比对、产物校验、建 Release、上传资产 | 会（且必须手动确认） |

日常提交只跑前三层里的前两层。**发版永远不是 push 的副作用。**

## 本地跑测试

不需要装任何依赖，只需 Node ≥ 22（仓库零第三方依赖）。

```bat
:: 仓库根目录
node .github\scripts\ci-run.cjs --mode offline       :: CI 跑的那一组，约 30 秒
node .github\scripts\ci-run.cjs --mode live          :: 需要本机已登录上游客户端，约 2 分钟
node .github\scripts\ci-run.cjs --only update-chain  :: 只跑一个脚本
node .github\scripts\ci-run.cjs --mode offline --list :: 看 CI 会跑哪些
```

`--mode offline` 与 GitHub 上跑的是同一份编排器、同一份分类表，所以本地过了云端基本不会红。

`--mode live` 会真读本机登录态、真打上游、真花额度。它**不会**在 CI 上跑（见下文「未迁移的测试」）。

运行产物落在 `artifacts/`（已被 `.gitignore` 忽略）：

- `ci-logs/<脚本>.log`：每个脚本的完整原始输出
- `junit-offline.xml`：JUnit 报告
- `summary-offline.md`：汇总表，与 GitHub Step Summary 同一份
- `ci-results-offline.json`：机器可读的逐项结果

## 测试怎么分类

分类表在 `test/ci-config.json`，只有两档：

- `offline`：不读任何本机登录态，托管 Runner 上能跑。进 CI 矩阵。
- `live`：要真登录态、真上游。只在开发机上手动跑。

**新增 `test/*.js` 必须在这里登记**，否则 `ci-run.cjs` 直接报错退出（不会静默跳过）。这条规则是故意的：漏跑的测试比失败的测试更危险。

## 看 CI 结果

1. 打开仓库的 **Actions** 页，点对应那次运行。
2. 左侧每个 job 一个方块：`静态检查`、`工作流语法检查`、`代码安全扫描`、`离线测试 / <脚本名>`、`构建产物`。
3. 失败时点开那个 job，日志里每个脚本是折叠的一组，展开即完整输出（与本地 `artifacts/ci-logs/` 一致）。
4. 该次运行的 **Summary** 页有测试汇总表，含每个脚本的通过/失败/跳过数与耗时。

失败的 job 右侧有 `Re-run jobs`。重跑不会污染任何缓存或产物。

## 下载构建产物

每次 CI 的 `构建产物` job 都会上传：

- `.cindy` 安装包（`built-package` 这个 artifact 名）
- `SHA256SUMS.txt`
- `package-verification.json`（逐项校验结果）

在 Actions 运行页面底部 **Artifacts** 区下载，保留 14 天。测试日志单独存，保留 5 天。

## 发起正式发布

发布分三步，缺一不可。

### 1. 提升版本号

三处必须同时改（CI 会查，不一致直接红）：

- `plugin/ghost.json` 的 `version` 与 `releaseNotes`
- `plugin/package.json` 的 `version`
- `CHANGELOG.md` 新增 `## <版本>` 小节（发布说明就是从这里抽的）

版本号只能往上走。`check-version.cjs` 会读 CHANGELOG 里出现过的最高版本，比它低或没有自己小节的都会失败。

### 2. 打 tag 并推送

```bat
git tag v0.1.20
git push origin v0.1.20
```

推 tag 只会触发一次**草稿** Release（`release.yml` 里 push 分支固定走 `mode=draft`），不会公开。

### 3. 人工确认发布

到 Actions 页选 **Release** → **Run workflow**：

| 输入 | 填什么 |
| --- | --- |
| `tag` | `v0.1.20`（必须已存在，且指向要发布的那个提交） |
| `confirm` | 填 `PUBLISH` 才真正发布；填别的只演练 |
| `draft` | 想先看效果就勾上；确认无误再取消勾选重跑 |

发布 job 走 `release` environment。第一次用需要在 Settings → Environments 里建它，并加 required reviewers —— 这样即使有人误点 `PUBLISH`，也需要第二个人批准。

### 发布流程做了什么

1. 校验 tag 与清单版本一致、tag 指向的提交就是当前检出的提交
2. 全量离线测试（不通过就到此为止）
3. 打包两次，比对 sha256 证明可复现
4. 产物校验：内容清单、与源码逐字一致、无凭证样式字符串、包内 worker 能启动
5. 从 `CHANGELOG.md` 抽当前版本正文生成 Release Notes
6. 建 Release、上传 `.cindy` 与 `SHA256SUMS.txt`
7. 打印 Release 链接与资产清单

### 重跑安全吗

安全。同一个 tag 重跑时：

- Release **已公开** → 不动它的说明、不动已有资产，只补缺失的
- Release 是**草稿** → 更新说明后继续
- 资产已存在且 digest 一致 → 跳过上传
- 资产已存在但**内容不同** → 直接失败，拒绝覆盖已发布版本（要发新内容请提升版本号）

## CI 失败了怎么查

按 job 定位，别从头读日志：

| 失败的 job | 先看什么 |
| --- | --- |
| `静态检查` | 日志里会直接列出语法错的文件；`verify-manifest` 会指出清单哪条规则不符 |
| `工作流语法检查` | actionlint 的输出带行号，通常是 YAML 缩进或 `${{ }}` 表达式写错 |
| `代码安全扫描` | Security → Code scanning 里有具体位置；这类告警是分析结果，不是构建失败 |
| `离线测试 / xxx` | 展开折叠组，`FAIL` 行带 `got=`，直接是断言失败的实际值 |
| `构建产物` | 大多数情况是 `verify-package` 报「包内每个文件都与仓库当前提交逐字一致」失败 —— 说明 `dist/` 里躺着旧包，本地重跑 `node plugin/scripts/pack.cjs` 即可 |

本地复现最快的办法就是拿 CI 里那条命令原样跑一遍，例如：

```bat
node .github\scripts\ci-run.cjs --mode offline --only e2e-panel
```

## 维护工作流

### 改共享骨架要改两处

`.github/scripts/` 与 `plugin/node/update.cjs`、`plugin/node/adapters.cjs` 在两个桥仓库里是**逐字相同的副本**（`adapters.cjs` 允许注释不同）。改了一个仓库，必须同步另一个，否则 `shared-drift.yml` 会指出具体行号。

注意它**在 PR 上严格失败、在 main 上只提示**：两个仓库是依次合并的，先合并的一方在另一仓跟上之前副本必然不一致，那段窗口是预期的。所以：

- **PR 红** = 真的忘了同步，必须修
- **main 上出现 warning** = 可能是"另一半还没合并"，等另一仓合并后手动重跑即可；不会把主分支长期判红

### 第三方 Action 一律钉提交 SHA

工作流里的 `uses:` 全部固定到 40 位提交 SHA，后面用注释标明版本号。升级时：

```bat
:: 查最新 tag 对应的提交
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq .object.sha
```

注意 annotated tag 拿到的是 tag 对象 SHA，要再查一层 `git/tags/<sha>` 才是提交 SHA。

### 权限最小化

顶层只有 `contents: read`。写权限只出现在 `release.yml` 的 `publish` job（`contents: write`），以及 `ci.yml` 的 `codeql` job（`security-events: write`，用于上传分析结果）。

`checkout` 全部带 `persist-credentials: false`，避免 token 留在工作区的 git 配置里被后续脚本读到。

### 成本

只用公开仓库免费的标准 Runner：`windows-latest`（插件只支持 Windows，必须用它真起 worker）、`ubuntu-latest`（工作流 lint 与漂移检查）。没有付费 Runner、没有第三方 CI、没有付费 API。

缓存：本项目零第三方依赖，`setup-node` 不配 cache —— 没有 `package-lock.json`，配了反而每次警告。

## 未迁移到 CI 的测试

`live` 那 5 个脚本（`e2e-package`、`e2e-brain`、`smoke-protocols`、`smoke-tools`、`wire-quirks`）**没有**在托管 Runner 上跑，原因是它们必须：

- 读到真实的 Qoder CN / Trae CN 登录凭据（存在本机 `%APPDATA%` 下，CI 没有）
- 真向上游发请求（会产生真实用量）

这些能力无法用 Mock 替代而不降低验证价值：它们验的正是「和真上游对不对得上」。

它们的验收方式是在开发机上跑 `--mode live`。CI 里 `workflow_dispatch` 选 `live` 会显式失败并说明原因，避免有人误以为「没报错 = 通过」。
