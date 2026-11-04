<h1 align="center">cindy-qoder-bridge</h1>

<p align="center"><b>Bring the Qoder CN models you're already signed into onto Cindy — zero config, your own quota.</b></p>

<p align="center">
  English · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-the-panel-shows">Panel</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/linvisxie/cindy-qoder-bridge/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/linvisxie/cindy-qoder-bridge/releases"><img src="https://img.shields.io/github/v/release/linvisxie/cindy-qoder-bridge?style=flat-square&label=release&color=cb3837" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/linvisxie/cindy-qoder-bridge?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/linvisxie/cindy-qoder-bridge/stargazers"><img src="https://img.shields.io/github/stars/linvisxie/cindy-qoder-bridge?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/linvisxie/cindy-qoder-bridge/issues"><img src="https://img.shields.io/github/issues/linvisxie/cindy-qoder-bridge?style=flat-square" alt="issues"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/Cindy-%E2%89%A50.1.119-4c6ef5?style=flat-square" alt="cindy">
</p>

Plug the **Qoder CN** models you're already signed into into [Cindy](https://cindy.chat)
and use your own Qoder quota right from Cindy's model picker — no API key, no extra subscription.

The plugin serves a local endpoint at `127.0.0.1:47821` that speaks three protocols
(OpenAI Chat / Anthropic Messages / OpenAI Responses), so all three Cindy harness
engines (`pi` / `claude-code` / `codex`) can connect.

<p align="center">
  <img src="assets/panel.png" width="420" alt="Qoder bridge panel: account, model count, quota, quota reset, membership expiry, local port, daily check-in card and today's local usage">
</p>

The **Qoder bridge** tab in the right sidebar: account and status light, model count,
plan quota, membership expiry, local port — plus a separate **daily check-in** card
showing whether today is claimed, when the next round opens, and how many requests and
tokens you've spent locally today. **Copy config** puts the Base URL and API key on the
clipboard in one go.

The panel only reads Qoder's own endpoints and your local ledger. It will **never**
check in on your behalf — that click is always yours.

Model names carry their price factor (`· Free` / `· x0.2` / `· x1`) so you can see at a
glance which are cheap right in Cindy's provider list:

<p align="center">
  <img src="assets/models.png" width="620" alt="Model list on Cindy's provider page: DeepSeek-Flash · Free, DeepSeek-V4-Pro · x0.5, GLM-5.3-Flash · x0.1">
</p>

## How it works

```
A chat in Cindy
  -> one of OpenAI Chat / Anthropic Messages / OpenAI Responses
  -> http://127.0.0.1:47821/v1        local endpoint started by this plugin (loopback only)
  -> COSY signing + Encode permutation  upstream is not an OpenAI-compatible endpoint
  -> https://gateway.qoder.com.cn/     billed to your own Qoder account
  -> double-wrapped SSE
  -> translated back into the protocol you asked for
```

Qoder is not an OpenAI-compatible endpoint, so three things are needed:

1. **COSY signing headers** — every gateway request carries `Cosy-*` headers and
   `Authorization: Bearer COSY.<payload>.<sig>`.
2. **Permuted base64 request bodies** — `Encode=1` in the query string means the JSON body
   must be base64-encoded, substituted through a swapped alphabet, then rotated in thirds.
3. **Double-wrapped SSE** — each `data:` frame is an envelope object whose `body` field is
   itself a JSON string.

The login state is decrypted fresh from the Qoder CN client's `auth.v1.dat`
(OSCrypt v10 → DPAPI) on each read, **used only in memory, never written to disk**.

Four components:

| File | Role |
|---|---|
| `plugin/main.js` | The brain: forwards AI tool calls and panel requests to the worker |
| `plugin/node/worker.cjs` | Resident Node process: decrypts login state, serves HTTP, routes three protocols |
| `plugin/node/adapters.cjs` | Protocol translation between Anthropic / Responses and OpenAI Chat |
| `plugin/node/update.cjs` | Pure functions for self-update: version compare, digest check, unzip, script generation |
| `plugin/panel.*` | Right-side panel: account, quota, check-in, model list, Base URL / API key |

It **does not modify any Cindy file**, and it won't fill in the provider config for you
(Cindy doesn't expose an interface for that). It gives you an endpoint; the last step is
a few clicks in Cindy's UI.

## Requirements (check each one)

| Dependency | Requirement | Notes |
|---|---|---|
| OS | **Windows 10 / 11** | The one hard limit. Login state is decrypted with Windows DPAPI (`CryptUnprotectData`, via PowerShell); on macOS / Linux that step can't work and the plugin won't start. |
| Cindy client | **≥ 0.1.119** | That's the `minCindyVersion` in the manifest. Older builds have no `custom_providers` and no node worker. |
| Qoder CN client | Installed and **signed in** | China mainland only (client app id `com.qodercn.app.stable`). The international build (`qoder`) is not supported — personal quota there is usually 0. |
| Node.js | **≥ 22** (24 recommended) | Uses `fetch`, `AbortSignal.timeout`, `node:readline`. The worker runs on the Node bundled with Cindy; you only need your own to run the tests. |
| Network | Reachable `gateway.qoder.com.cn` / `openapi.qoder.com.cn` | Assumes a China network environment. |
| Disk | ~100 KB | Plugin itself. Runtime data (logs, usage ledger) is separate, under `%APPDATA%\CindyGlobal\qoder-bridge\`. |

> No API key, no OpenAI / Anthropic account, no extra subscription. It uses the quota your
> own Qoder account already has.

## Install

### 1. Get the package

Download `cindy-qoder-bridge.cindy` from [Releases](../../releases), or build it yourself:

```bat
cd plugin
npm run pack        :: produces dist\cindy-qoder-bridge.cindy
```

A `.cindy` is just a zip (with `ghost.json` at the root). `scripts/pack.cjs` is a
zero-dependency hand-rolled packer — same input, same bytes out.

> **Byte-for-byte reproducible since 0.1.20**: the same commit produces an identical
> sha256 in any timezone (UTC / UTC+8) and from any line-ending state (LF / CRLF worktree).
> Verify against `SHA256SUMS.txt` on the release page.

### 2. Install into Cindy

Cindy → Plugins → import the `.cindy` (or drag the file in).

The first install lists permissions for you to confirm. It declares a **resident Node
process** — which means **it can read and write files on your machine and reach the
network**. That's required to read Qoder's login state and serve a local endpoint.
Please make sure you're comfortable with that before installing.

### 3. Add the provider in Cindy (the only manual step)

After installing, a **Qoder bridge** tab appears in the right sidebar. It shows
**account / model count / quota / local port / Base URL / API key**, and **Copy config**
copies the Base URL and API key together.

Then: **Cindy Settings → Models → Add custom provider**

| Field | Value |
|---|---|
| Name | Anything, e.g. `Qoder` |
| Base URL | `http://127.0.0.1:47821/v1` (whatever the panel shows) |
| API Key | The token from the panel, exactly as shown |
| Model ID | Pick from the panel list and add them one by one |

**Protocol (by engine — pick wrong and that engine stays disabled):**

| Cindy engine | Required protocol |
|---|---|
| `pi` | Any of the three |
| `claude-code` | **Anthropic Messages** |
| `codex` | **OpenAI Responses** |

This is a hard rule in Cindy (`acceptsWireProtocol`: `claude-code` only accepts
`anthropic-messages`, `codex` only accepts `openai-responses`, `pi` accepts all). This
plugin supports all three.

Per model:

- **Context window**: reports **1,000,000** by default (Qoder's official tiers are
  200K / 400K / 1M, with 200K as the default). Set `CINDY_QODER_CONTEXT=default` to
  report 200K instead.
- **Vision input**: all CN-region models support it — turn it on.
- **Reasoning effort**: exposed in both the panel and `/v1/models` (`high` / `max` /
  `low` and friends). The ones that can be selected show up automatically.

### 4. Afterwards

Just start Cindy normally. The plugin is `resident`, so Cindy pulls the worker up to
`47821` on its own. The token persists in `state.json` and the provider config lives in
Cindy's own database — nothing else to manage.

**Only these three cases need you:**

1. Qoder login expired → sign in again in the Qoder CN client, then hit **Refresh** in the panel.
2. Port `47821` taken by something else → the worker falls through to `47822`… and the
   panel's Base URL changes, so update it in Cindy.
3. Uninstalling and reinstalling the plugin → you'll need to re-enter the provider.

## What the panel shows

- **Login state**: account name, green dot / red dot
- **Quota**: used / total, add-on pack quota, quota expiry, membership expiry
- **Daily check-in**: whether today is claimed, how many credits are available, countdown
  to the next 10:00 round, with a **Check in now** button
- **Today's usage**: requests / tokens / weighted amount (tokens × factor)
- **Model list**: each model's price factor (`· x0.2` / `· Free`) and reasoning efforts
- **Log**: path to `bridge.log` — look here first when something breaks
- **Check for updates**: the button to the right of **Copy config**. One click queries
  GitHub Releases; if there's a new version the button becomes **Install x.y.z** and a
  second click actually installs (the process exits and restarts, hence the two steps).
  Before overwriting it backs up the whole install directory to
  `<dir>.bak-<old version>`.

The AI side can ask too: five tools — `qoder_status`, `qoder_endpoint`, `qoder_refresh`,
`qoder_checkin`, `qoder_update`. Pass `action=apply` to `qoder_update` to download and
install.

## Where runtime data lives

| Path | Contents |
|---|---|
| `%APPDATA%\CindyGlobal\owners\<ownerKey>\cindy-brain\_ns\_root\qoder-bridge\` | The plugin itself (install location, managed by Cindy) |
| `%APPDATA%\CindyGlobal\qoder-bridge\state.json` | Local endpoint token + port |
| `%APPDATA%\CindyGlobal\qoder-bridge\models.json` | Model catalog cache (30 minutes) |
| `%APPDATA%\CindyGlobal\qoder-bridge\usage.json` | Local usage ledger (per day per model, kept 60 days) |
| `%APPDATA%\CindyGlobal\qoder-bridge\update\` | Downloaded packages, staging dirs and the replace script |
| `%APPDATA%\CindyGlobal\qoder-bridge\bridge.log` | Runtime log, rotates to `.1` past 2 MB |

**Your Qoder token is never written to any of these files** — it's decrypted fresh from
the Qoder client's `auth.v1.dat` each time and used only in memory.

Environment variables (rarely needed):

| Variable | Default | Purpose |
|---|---|---|
| `CINDY_QODER_PORT` | `47821` | Preferred port |
| `CINDY_QODER_DATA` | `%APPDATA%\CindyGlobal\qoder-bridge` | Runtime data directory |
| `CINDY_QODER_CONTEXT` | (empty, reports 1M) | Set to `default` to report 200K |

## Development and testing

Each script under `test/` is an independent, re-runnable check. Most **need Qoder CN
installed and signed in** (they read real login state and hit the real upstream);
`host-guard`, `responses-status`, `upstream-contract`, `update-chain` and
`review-regressions` are fully local. Without a login, `features` and `e2e-panel` mark login-dependent cases
`--` / `SKIP` instead of crashing — but that means they didn't really verify anything.

```bat
cd plugin && npm run verify     :: static manifest validation
cd plugin && npm run pack       :: build the package

node test\host-guard.js         :: Host guard, 13 cases (local, no login)
node test\responses-status.js   :: Responses status mapping, 19 cases (local, no login)
node test\upstream-contract.js  :: upstream contract, 16 cases (local: interleaved tool fragments / truncation / usage)
node test\update-chain.js       :: self-update chain, 52 cases (local: version compare / digest fail-closed / unzip / rollback script)
node test\review-regressions.js :: past review regressions, 40 cases (local: quota tolerance / error mapping / package identity)
node test\e2e-package.js        :: package end-to-end, 25 cases (unzip -> start worker -> real chat -> three protocols -> license files)
node test\e2e-panel.js          :: panel script, 10 cases
node test\e2e-brain.js          :: panel <-> brain over a real bus, 13 cases
node test\smoke-protocols.js    :: three protocol shapes, 19 cases
node test\smoke-tools.js        :: tool calls across three protocols, 11 cases
node test\wire-quirks.js        :: Cindy's /v1/v1 and [1m] quirks, 10 cases
node test\features.js           :: check-in / usage / log / price factor / error codes / input validation, 42 cases
```

To switch models: `node test\smoke-protocols.js <model id>` (defaults to `qfmodel`, free).
Each test opens its own temp directory and port so it won't collide with a running instance.

**Why the tests look like this**: every one of them guards a specific production incident.
`host-guard` guards against Cindy's proxy stripping the port from the Host header (which
makes the claude-code engine 403). `wire-quirks` guards against a Base URL that already
ends in `/v1` being doubled into `/v1/v1/messages`, and against Cindy encoding the model id
as `qfmodel[1m]` when 1M context is selected. `e2e-brain` guards against unwrapping only
one of the two layers of `cindy.node.request` (which makes the panel show
"not signed in / 0 models / —"). `responses-status` guards against the top-level and
per-item statuses disagreeing when a Responses stream is truncated or cut by a content
policy, and pins down that an item status may only be `in_progress` / `completed` /
`incomplete` — `failed` belongs to the top-level `Response` only. `update-chain` guards the
self-update path: that `0.1.15` sorts newer than `0.1.9` (segment-wise, not
string-wise), that a package whose sha256 doesn't match the release digest is rejected
before a single byte touches the install directory, and that the generated PowerShell
waits for the old process, backs up, then syncs Cindy's manifest snapshot.

## Local endpoint

| Path | Auth | Notes |
|---|---|---|
| `GET /healthz` | No | Liveness, returns only `{ok, port, modelCount}`. Unauthenticated, so it deliberately exposes nothing else |
| `GET /status` (`/v1/status` alias) | Yes | Full status: account, models, quota, check-in, local usage, log path |
| `GET /v1/models` | Yes | Model catalog (context window, price factor, reasoning efforts) |
| `POST /v1/chat/completions` | Yes | OpenAI Chat protocol |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | Yes | Anthropic Messages protocol |
| `POST /v1/responses` | Yes | OpenAI Responses protocol |

Auth is `Authorization: Bearer <the token from the panel>`.

## Known limitations

- **Windows only.** See Requirements above.
- **Qoder CN only.** The international build isn't implemented.
- **The "pricing" line on Cindy's detail page can't be fixed.** The custom-provider model
  parser (`parseModelsListResponse`) doesn't read `displayPricing` / `currency` / `cost`
  at all, so "no pricing data for this route" can't be removed; the price factor can only
  live in the model name and the panel.
- **Only one context window number can be reported.** Cindy's provider models accept a
  single value, so it reports the top tier, 1M.
- **Quota reset time isn't available.** Qoder's `/sash/api/v2/me/usage` doesn't return
  that field (confirmed: it's absent from the returned keys), so the panel says Qoder
  didn't provide it.
- **Depends on Qoder's internal endpoints.** When upstream changes, the plugin breaks.
  This is not a "long-term stable" thing.
- **Omitting `stream` returns a streaming response**, the opposite of the three official
  protocol defaults (non-streaming). This is a deliberate compatibility trade-off: Cindy's
  Anthropic probe omits `stream` and parses the reply as `text/event-stream`; adopting the
  official default would make that probe report the endpoint as incompatible. Standard SDKs
  that want a non-streaming reply should pass `stream: false` explicitly. See issue #15.
- **A credential format change breaks it.** The proprietary AES wrapper is
  reverse-engineered; if Qoder switches encryption (or rotates the salt), the plugin must
  be updated before it works again.

## Disclaimer

For personal study and research only, driving **your own** Qoder account from your own
machine. You are responsible for complying with Qoder's terms of service; the author
accepts no liability for consequences of use. This project is not affiliated with,
authorized by, or endorsed by Qoder or Cindy.

Every request the plugin makes except **daily check-in** is **read-only**. Check-in is the
only operation that changes anything on your Qoder account (claiming credits Qoder is
already offering **to your own account**), it never runs automatically, and it always
requires a manual click. Whether you use it — and whether it complies with Qoder's current
terms — is your call.

To be explicit about the risks:

1. **This is a reverse-engineered implementation, not an official API.** Requests
   impersonate the Qoder CLI identity (`session_type: "qodercli"`, `agent_id:
   "agent_common"`, etc.) against Qoder's own gateway. Qoder's terms most likely don't
   permit this kind of use.
2. **Use at your own risk.** It could get your account rate-limited, have your quota
   zeroed, or get you banned. The author accepts no responsibility and offers no warranty.
3. **Don't use it to violate upstream terms**, and don't use it to circumvent billing or
   quota limits — it circumvents nothing. It spends your own account's quota.
4. **Login state stays in local memory.** The plugin does not collect or upload your
   token, chat content, or any account information. If you want to audit: there are
   exactly two outbound domains — `gateway.qoder.com.cn` and `openapi.qoder.com.cn`.
5. Runtime logs and a usage ledger stay under `%APPDATA%\CindyGlobal\qoder-bridge\` —
   **read them before sharing**.

## License

Released under **MIT**. See [LICENSE](LICENSE).

The protocol layer (COSY signing, Encode permutation, OSCrypt decryption, message
conversion) is ported from
[`@eghrhegpe/dsh-connect-qoder`](https://github.com/eghrhegpe/dsh-connect-qoder) 0.7.6
(MIT, Copyright (c) 2026 eghrhegpe). Its copyright notice and full license text are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and **must be kept with this project**.

"Qoder", "Cindy" and other names and trademarks belong to their respective owners and are
used here for reference only.
