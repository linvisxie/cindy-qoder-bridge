# Qoder 0.1.21 凭据验收记录

文档更新日期：2026-11-11。返回 [中文 README](../README.md) · [English README](../README.en.md) · [更新日志](../CHANGELOG.md)。

## 证据与发行状态

本机 lifecycle 验收报告为 `stage: complete`、`ok: true`，LastWriteTime 已确认为本机时间 `2026-11-11 23:39:03`。独立最终真实 profile 复读报告也为 `ok: true`，确认凭据 valid、未过期且与 cache 一致，未修改真实 profile、无上游请求。两份脱敏布尔记录保存在[永久验收证据](credential-acceptance-2026-11-11.json)，不包含 auth、token 或 key 内容。

公开发行状态以 GitHub Releases 为准，发布不等于本机安装。本记录不是已发布、已安装或全部 live 上游测试通过的声明；未运行 / SKIP 不等于通过。Trae 0.1.13 仅包含共享硬化 / 协议修复，不包含本页 Qoder 专有功能或验收结果。

## #31 行为修复

- 移除 `refreshCredential` 五分钟 time-only fastpath，普通读取立即观察 logout / delete / replace，不必等待五分钟或强制刷新。
- 读取区分 `valid` / `absent` / `logged-out` / `temporary`；明确缺失 / 退出清除旧缓存，仅 `temporary` 失败允许旧票 fallback，按当前时间判断过期。
- DPAPI key 仍按 `Local State` 身份缓存，身份改变使 key cache 失效；key helper 合并单 profile inflight，失败后冷却 1 秒，auth 仍逐次读取，不是每次都重新执行 DPAPI。
- offline `test/credential-key-cache.js` 覆盖 key inflight 合并与失败冷却；DPAPI helper 与 credential-reading 回归均已通过。使用 `node test/credential-reading.js`、`node test/credential-key-cache.js`、`node test/review-regressions.js` 和 `node .github/scripts/ci-run.cjs --mode offline` 获取实际结果，不硬编码脚本或断言数，也不沿用历史统计。

## 真实客户端与真实文件验收

- 找到生产前缀及单一真实 profile；初始真实 DPAPI 凭据有效、未过期，同 VM 缓存有效。
- 用户在真实 Qoder CN 客户端退出后，普通路径立即清除旧缓存；用户重新登录后返回 `valid`。
- 真实 auth 文件仅短暂 rename 移除，读取返回 `absent` 并清缓存；无覆盖地恢复原文件后读取有效。
- 真实 `Local State` 逐字未改，最终真实 profile 登录正常。

## 临时副本实测（不是对真实客户端的密钥轮换）

- 在临时副本使用真实 auth 载荷，旧 key 可读取，载荷可解密。
- 在副本上使用 Windows DPAPI 保护的新 AES key 轮换，通过同一 token 的有效读取及 OSCrypt key cache invalidation 验证。
- 副本临时损坏 / 强制刷新时，`temporary` 失败保留旧票。
- 仅在 VM 局部推进时间验证 expired，不修改系统时钟。
- 临时副本已删除。

**未修改或轮换 Windows 系统根密钥（master key），未验证真实客户端自然生成新 key，也没有轮换真实 `Local State` 中的 key。副本中的新 AES key 受 Windows DPAPI 保护，不等于 Windows 系统根密钥轮换。**

## 独立最终复读与离线回归

- 独立最终 profile 复读先独立 `loadCredential`，再比较 cache，避免副本 fallback 掩盖真实 profile 读取失败；valid、unexpired、cache matches 均为 true。
- 独立复读未修改真实 profile、无上游请求；检查时间见[永久布尔证据](credential-acceptance-2026-11-11.json)的 `independentFinalRead.checkedAt`。
- DPAPI helper 与 credential-reading 回归已通过；全量 offline 结果以 `node .github/scripts/ci-run.cjs --mode offline` 实际输出为准，不以局部回归代替全量验证。

## 验证边界

本次凭据验收全程无上游请求，不消耗上游模型额度；不验证真实上游对话或服务端票据轮换。真实用户退出 / 重登已经验收，但不等于真实插件安装或覆盖升级验收。通过不代表无 bug，不扩大权限。
