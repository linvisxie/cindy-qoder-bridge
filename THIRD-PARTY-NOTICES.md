# 第三方声明

本项目包含来自下列第三方作品的代码。原文版权与许可如下，**分发本项目时必须一并保留本文件**。

---

## @eghrhegpe/dsh-connect-qoder

- 版本：`0.7.6`
- 版权：Copyright (c) 2026 eghrhegpe
- 许可：MIT
- 仓库：<https://github.com/eghrhegpe/dsh-connect-qoder>

### 本项目用到了它的哪些部分

`plugin/node/worker.cjs` 的协议层是从该项目的 `lib/index.js` 移植而来（已按 Cindy 的运行环境改写，逻辑等价）：

| 内容 | 出处（该项目 `lib/index.js` 行号） |
|---|---|
| COSY 签名头（`Authorization: Bearer COSY.<payload>.<md5sig>` 与 `Cosy-*` 系列头） | 约 1628–1690 |
| Encode 置换 base64（自定义字母表、`=` → `$`、三分旋转） | 约 1543–1600 |
| 常量 `COSY_VERSION = "1.1.38"`、`DATA_POLICY = "disagree"` | 约 1483–1485 |
| OSCrypt v10（AES-256-GCM）解密 + DPAPI 解 key（PowerShell `CryptUnprotectData`） | 约 5000–5055、4180–4270 |
| 区域描述符（`gateway.qoder.com.cn` / `openapi.qoder.com.cn` / app 目录名） | 区域表定义处 |
| `toQoderMessages` / `toQoderTools` / `textOf` 消息与工具转换 | 约 2487–2630 |
| 模型目录与对话端点 URL 构造 | 约 1904–1908 |
| 用量 `readUsageShape` / `normalizeQuotaBucket` / `quotaAmountsOf` 的字段口径 | 用量读取处 |
| 签到 `claimableCampaignOf` / `checkinStateFrom` / `normalizeClaimResult` 的判据 | claim 相关函数 |

`plugin/node/adapters.cjs` 为 Cindy 侧新增，不含上述项目代码（其中引用的 Cindy 内部行为是观察所得的事实，非复制代码）。

### 原许可全文

```
MIT License

Copyright (c) 2026 eghrhegpe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 名称与商标

「Qoder」「Qoder CN」「Cindy」等名称与商标归各自所有者所有。本项目仅将其用于指代相应的软件与服务，不表示任何隶属、赞助或背书关系。
