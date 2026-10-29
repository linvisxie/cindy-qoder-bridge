// Qoder 桥 · Node 工作进程（JSON-RPC stdio）
// 拥有宿主账号的本机权限：读 Qoder 的 auth.v1.dat、调 DPAPI、起本地 HTTP 服务。
// stdout 只能写协议消息，日志一律写 stderr。
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { join } = require('node:path');
const { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createDecipheriv, createCipheriv, createHash, randomUUID, publicEncrypt, constants: cryptoConstants } = require('node:crypto');
const { execFile } = require('node:child_process');
const adapters = require('./adapters.cjs');

// ============================================================
// 协议层（移植自 @eghrhegpe/dsh-connect-qoder 0.7.6，MIT）
// ============================================================

const COSY_VERSION = '1.1.38';
const DATA_POLICY = 'disagree';
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const ENCODE_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < t.length; i++) t[i] = i;
  for (let i = 0; i < 64; i++) t[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  t['='.charCodeAt(0)] = '$'.charCodeAt(0);
  return t;
})();

function encodeBody(plaintext) {
  const std = (Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)).toString('base64');
  const n = std.length;
  const third = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let d = 0;
  for (let i = n - third; i < n; i++) out[d++] = ENCODE_TABLE[std.charCodeAt(i)] ?? 0;
  for (let i = third; i < n - third; i++) out[d++] = ENCODE_TABLE[std.charCodeAt(i)] ?? 0;
  for (let i = 0; i < third; i++) out[d++] = ENCODE_TABLE[std.charCodeAt(i)] ?? 0;
  return out;
}

function aesCbcB64(plain, keyStr) {
  const key = Buffer.from(keyStr);
  const c = createCipheriv('aes-128-cbc', key, key);
  return c.update(plain, 'utf8', 'base64') + c.final('base64');
}

const MACHINE_OS = process.platform === 'win32'
  ? (process.arch === 'arm64' ? 'aarch64_windows' : 'x86_64_windows')
  : process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'aarch64_darwin' : 'x86_64_darwin')
    : (process.arch === 'arm64' ? 'aarch64_linux' : 'x86_64_linux');

function signaturePath(url) {
  let p = new URL(url).pathname;
  if (p.startsWith('/algo')) p = p.slice(5);
  return p;
}

function authHeaders(body, url, cred) {
  const aesKey = randomUUID().replace(/-/g, '').slice(0, 16);
  const infoB64 = aesCbcB64(JSON.stringify({
    uid: cred.userID,
    security_oauth_token: cred.token,
    name: cred.name ?? '',
    aid: '',
    email: cred.email ?? '',
  }), aesKey);
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(aesKey)).toString('base64');
  const ts = Math.floor(Date.now() / 1e3).toString();
  const payloadB64 = Buffer.from(JSON.stringify({
    version: 'v1', requestId: randomUUID(), info: infoB64,
    cosyVersion: COSY_VERSION, ideVersion: '',
  })).toString('base64');
  const path = signaturePath(url);
  const bodyBytes = body ?? Buffer.alloc(0);
  const sig = createHash('md5')
    .update(payloadB64).update('\n')
    .update(cosyKey).update('\n')
    .update(ts).update('\n')
    .update(bodyBytes).update('\n')
    .update(path).digest('hex');
  const mid = cred.machineID ?? '';
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': cred.userID,
    'Cosy-Date': ts,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': mid,
    'Cosy-Machinetoken': mid,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': MACHINE_OS,
    'Cosy-Clienttype': '5',
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': createHash('md5').update(bodyBytes).digest('hex'),
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': path,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': 'v2',
    'X-Request-Id': randomUUID(),
  };
}

function decryptOscrypt(blob, key) {
  if (blob.length < 31) return undefined;
  if (blob.subarray(0, 3).toString('latin1') !== 'v10') return undefined;
  const body = blob.subarray(3);
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(12, body.length - 16);
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return undefined; }
}

const REGIONS = [{
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  appNames: ['com.qodercn.app.stable'],
  baseUrl: 'https://gateway.qoder.com.cn/',
  openApiUrl: 'https://openapi.qoder.com.cn',
}];

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QoderDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$statePath = Join-Path $env:QODER_APP_DIR 'Local State'
$json = Get-Content $statePath -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($json.os_crypt.encrypted_key)
if ($raw.Length -le 5) { throw 'encrypted_key too short' }
$key = [QoderDpapi]::U($raw[5..($raw.Length - 1)])
Write-Output ([Convert]::ToBase64String($key))
`;

const keyCache = new Map();

function localStateIdentity(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return undefined; }
}

/** 解主密钥。异步版：走 execFile，不阻塞事件循环。 */
function oscryptKeyFor(appDir) {
  return new Promise((resolve) => {
    const statePath = join(appDir, 'Local State');
    const identity = localStateIdentity(statePath);
    if (identity === undefined) { resolve(undefined); return; }
    const cached = keyCache.get(appDir);
    if (cached && cached.identity === identity) { resolve(cached.key); return; }
    const b64 = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', b64,
    ], {
      env: { ...process.env, QODER_APP_DIR: appDir },
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) { log('dpapi failed', err.message.slice(0, 200)); resolve(undefined); return; }
      const key = Buffer.from(String(stdout).trim(), 'base64');
      if (key.length !== 32) { resolve(undefined); return; }
      keyCache.set(appDir, { identity, key });
      resolve(key);
    });
  });
}

function appDataRoot() {
  if (process.platform === 'win32') return process.env.APPDATA ?? '';
  if (process.platform === 'darwin') return join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
}

function machineIdFor(appDir) {
  for (const n of ['auth.machine-id', 'machineid', 'machineId']) {
    const p = join(appDir, n);
    if (!existsSync(p)) continue;
    const v = readFileSync(p, 'utf8').trim();
    if (v.length > 0) return v;
  }
  return 'cindy-qoder-bridge';
}

function loadNewCredential(region, appDir, key) {
  const file = join(appDir, 'auth.v1.dat');
  if (!existsSync(file)) return undefined;
  const plain = decryptOscrypt(readFileSync(file), key);
  if (plain === undefined) return undefined;
  let s;
  try { s = JSON.parse(plain); } catch { return undefined; }
  if (!s || typeof s !== 'object') return undefined;
  if (typeof s.token !== 'string' || s.token.length === 0) return undefined;
  const u = s.user && typeof s.user === 'object' ? s.user : {};
  if (typeof u.id !== 'string' || u.id.length === 0) return undefined;
  const exp = Date.parse(String(s.expiresAt));
  return {
    region: region.id,
    userID: u.id,
    name: typeof u.name === 'string' ? u.name : '',
    email: typeof u.email === 'string' ? u.email : '',
    token: s.token,
    expiresAt: Number.isFinite(exp) ? exp : 0,
    expired: Number.isFinite(exp) && exp > 0 ? exp <= Date.now() : false,
    machineID: machineIdFor(appDir),
  };
}

async function loadCredential(region) {
  const root = appDataRoot();
  for (const appName of region.appNames) {
    const appDir = join(root, appName);
    if (!existsSync(appDir)) continue;
    const key = await oscryptKeyFor(appDir);
    if (key === undefined) continue;
    const cred = loadNewCredential(region, appDir, key);
    if (cred !== undefined) return cred;
  }
  return undefined;
}

function modelListUrl(region) { return `${region.baseUrl}algo/api/v2/model/list?Encode=1`; }
function chatUrl(region) { return `${region.baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`; }

function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let t = '';
  for (const b of c) if (b && b.type === 'text') t += typeof b.text === 'string' ? b.text : '';
  return t;
}

function toQoderMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') { out.push({ role: 'system', content: textOf(m.content) }); continue; }
    if (m.role === 'user') {
      const parts = []; let hasImg = false;
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'text') parts.push({ type: 'text', text: b.text ?? '' });
          else if (b && (b.type === 'image_url' || b.type === 'image')) {
            const url = b.image_url && b.image_url.url ? b.image_url.url
              : (typeof b.data === 'string' ? `data:${b.mimeType || 'image/png'};base64,${b.data}` : undefined);
            if (url) { hasImg = true; parts.push({ type: 'image_url', image_url: { url } }); }
          }
        }
      }
      out.push({ role: 'user', content: hasImg ? parts : textOf(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      let text = ''; const calls = [];
      if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.id !== 'string' || !c.id) throw new Error('assistant tool_call 缺 id');
        const name = (c.function && c.function.name) || c.name;
        if (typeof name !== 'string' || !name) throw new Error(`tool_call "${c.id}" 缺函数名`);
        calls.push({ id: c.id, type: 'function', function: {
          name,
          arguments: typeof (c.function && c.function.arguments) === 'string'
            ? c.function.arguments : JSON.stringify((c.function && c.function.arguments) || c.arguments || {}),
        } });
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'text') text += b.text ?? '';
          else if (b && b.type === 'toolCall') {
            if (typeof b.id !== 'string' || !b.id) throw new Error('toolCall 块缺 id');
            calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.arguments || {}) } });
          }
        }
      } else text = textOf(m.content);
      const e = { role: 'assistant', content: text };
      if (calls.length) e.tool_calls = calls;
      out.push(e); continue;
    }
    if (m.role === 'toolResult' || m.role === 'tool') {
      const id = m.toolCallId || m.tool_call_id;
      if (typeof id !== 'string' || !id) throw new Error('tool 结果缺 tool_call_id');
      out.push({ role: 'tool', tool_call_id: id, content: textOf(m.content) });
    }
  }
  return out;
}

function toQoderTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t, i) => {
    if (t && t.function && typeof t.function === 'object') {
      if (typeof t.function.name !== 'string' || !t.function.name) throw new Error(`第 ${i} 个工具缺函数名`);
      return { type: 'function', function: {
        name: t.function.name,
        description: t.function.description ?? '',
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
      } };
    }
    if (typeof t?.name !== 'string' || !t.name) throw new Error(`第 ${i} 个工具缺 name`);
    return { type: 'function', function: {
      name: t.name, description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    } };
  });
}

// ============================================================
// 运行时状态
// ============================================================

const DATA_DIR = process.env.CINDY_QODER_DATA || join(os.homedir(), 'AppData', 'Roaming', 'CindyGlobal', 'qoder-bridge');
const PREFERRED_PORT = Number(process.env.CINDY_QODER_PORT || 47821);
const STATE_FILE = join(DATA_DIR, 'state.json');

let region = REGIONS[0];
let credential;
let credentialAt = 0;
let models = [];
let modelsAt = 0;
let server;
let actualPort = 0;
let token = '';
let lastError = '';
let lastQuota;
let bootedAt = 0;
let lastCheckin;
let lastUsage;

const LOG_FILE = join(DATA_DIR, 'bridge.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// Cindy 只把 node worker 的 stderr 挂到自己那儿，重启就没了。这里同时落一份盘，
// 出问题能翻历史；超过 2MB 就轮转成 bridge.log.1，不会无限长。
function writeLogFile(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const st = statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) {
        try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
      }
    } catch {}
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function log(...args) {
  const line = `[${new Date().toISOString()}] [qoder-bridge] ${args.join(' ')}\n`;
  process.stderr.write(line);
  writeLogFile(line);
}

function loadState() {
  try { const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')); if (s && typeof s === 'object') return s; } catch {}
  return {};
}

function saveState(patch) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 1));
  } catch (e) { log('state write failed', e.message); }
}

async function refreshCredential(force) {
  if (!force && credential && Date.now() - credentialAt < 5 * 60 * 1000) return credential;
  const c = await loadCredential(region);
  if (c) { credential = c; credentialAt = Date.now(); }
  return credential;
}

function normalizeModel(m) {
  const cfg = m.thinking_config;
  const efforts = cfg && cfg.enabled && cfg.enabled.efforts && typeof cfg.enabled.efforts === 'object'
    ? Object.keys(cfg.enabled.efforts) : [];
  const win = m.context_config;
  let ctx = Number(m.max_input_tokens) || 0;
  const opts = [];
  if (win && typeof win === 'object') {
    for (const v of Object.values(win)) {
      const n = Number(v && v.token_count);
      if (Number.isFinite(n) && n > 0) { opts.push(n); if (v && v.is_default === true) ctx = n; }
    }
    opts.sort((a, b) => a - b);
    if (ctx === 0 && opts.length) ctx = opts[opts.length - 1];
  }
  // Qoder 每模型给的是三档窗口（200K / 400K / 1M），is_default 那档是 200K。
  // DSH 那边有 useMaximumContextWindow 开关，Cindy 没有，所以默认由我们报最大档，
  // 想改回默认档设 CINDY_QODER_CONTEXT=default。
  const widest = opts.length ? opts[opts.length - 1] : ctx;
  const useMax = String(process.env.CINDY_QODER_CONTEXT || 'max').toLowerCase() !== 'default';
  return {
    contextWindow: useMax && widest > ctx ? widest : ctx,
    contextWindowDefault: ctx,
    contextWindowMax: widest,
    contextOptions: opts,
    key: m.key,
    name: typeof m.display_name === 'string' ? m.display_name : m.key,
    isVL: m.is_vl === true,
    isReasoning: m.is_reasoning === true || cfg !== undefined,
    alwaysThinking: efforts.length > 0 && cfg && cfg.disabled === undefined,
    effortLevels: efforts,
    priceFactor: typeof m.price_factor === 'number' ? m.price_factor : undefined,
  };
}

async function refreshModels(force) {
  if (!force && models.length && Date.now() - modelsAt < 30 * 60 * 1000) return models;
  const cache = join(DATA_DIR, 'models.json');
  const cred = await refreshCredential(force);
  if (!cred) {
    try { models = JSON.parse(readFileSync(cache, 'utf8')); } catch {}
    return models;
  }
  const url = modelListUrl(region);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders(Buffer.alloc(0), url, cred) },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const chat = data && data.chat;
    if (!Array.isArray(chat)) throw new Error('响应里没有 chat 组');
    models = chat
      .filter((m) => m && typeof m.key === 'string' && m.key && m.enable !== false)
      .map(normalizeModel);
    modelsAt = Date.now();
    saveState({});
    try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(cache, JSON.stringify(models, null, 1)); } catch {}
    return models;
  } catch (e) {
    lastError = `模型目录刷新失败：${e.message}`;
    log(lastError);
    try { models = JSON.parse(readFileSync(cache, 'utf8')); } catch {}
    return models;
  }
}

function openApiHeaders(cred, extra) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${cred.token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
    ...(extra || {}),
  };
}

async function openApiGet(path) {
  const cred = await refreshCredential(false);
  if (!cred) return { ok: false, why: 'not-signed-in' };
  try {
    const res = await fetch(`${region.openApiUrl}${path}`, {
      headers: openApiHeaders(cred), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) { return { ok: false, why: e.message }; }
}

// Qoder 的时间字段有 ISO 串、epoch 秒、epoch 毫秒三种写法，统一成毫秒。
function toEpochMs(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return toEpochMs(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function pickNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// 额度桶：有的版本给 total/used/remaining，有的只给 total/used。
function normalizeBucket(src) {
  if (!src || typeof src !== 'object') return undefined;
  const total = pickNumber(src.total, src.totalAmount, src.quota, src.amount);
  if (!(total > 0)) return undefined;
  const used = pickNumber(src.used, src.usedAmount, src.consumed) ?? 0;
  const remaining = pickNumber(src.remaining, src.left, src.balance) ?? Math.max(0, total - used);
  return {
    total, used, remaining,
    percentage: Math.min(1, Math.max(0, used / total)),
    unit: typeof src.unit === 'string' && src.unit ? src.unit : 'credits',
  };
}

// 用量面板：先走 /sash/api/v2/me/usage（给会员到期日、附加包、展示模式），
// 失败再退回 /api/v2/quota/usage（老接口，只有一份 userQuota）。
async function refreshUsage(force) {
  if (!force && lastUsage && Date.now() - lastUsage.at < 60 * 1000) return lastUsage;

  let payload;
  let source = '';
  const presentation = await openApiGet('/sash/api/v2/me/usage');
  if (presentation.ok && presentation.json) {
    payload = presentation.json.qoderUsage ?? presentation.json.data ?? presentation.json;
    source = 'me/usage';
  } else {
    const legacy = await openApiGet('/api/v2/quota/usage');
    if (legacy.ok && legacy.json) {
      payload = legacy.json.qoderUsage ?? legacy.json.data ?? legacy.json;
      source = 'quota/usage';
    } else {
      lastUsage = { ...(lastUsage || {}), at: Date.now(), error: `HTTP ${presentation.status ?? '?'} ${legacy.status ?? ''}`.trim() };
      return lastUsage;
    }
  }

  const root = payload && typeof payload === 'object' ? payload : {};
  const userQuota = normalizeBucket(root.userQuota ?? root.user_quota);
  const addOnQuota = normalizeBucket(root.addOnQuota ?? root.add_on_quota) ?? normalizeBucket(root.addonQuota);
  const expiresAt = toEpochMs(
    root.expiresAt ?? root.expires_at
    ?? root.userType?.expiresAt ?? root.user_type?.expiresAt
    ?? root.membership?.expiresAt ?? root.subscription?.expiresAt
  );
  const resetAt = toEpochMs(
    root.resetAt ?? root.reset_at ?? root.nextResetAt ?? root.next_reset_at
    ?? root.quotaResetAt ?? root.quota_reset_at ?? root.periodEnd ?? root.period_end
    ?? root.userQuota?.resetAt ?? root.user_quota?.reset_at
    ?? root.userQuota?.expiresAt ?? root.user_quota?.expires_at
  );

  lastUsage = {
    at: Date.now(),
    source,
    userQuota,
    addOnQuota,
    expiresAt,
    resetAt,
    exceeded: root.isQuotaExceeded === true || root.is_quota_exceeded === true,
    userType: typeof root.userType === 'string' ? root.userType : (typeof root.user_type === 'string' ? root.user_type : undefined),
    // 字段名留一份，方便以后 Qoder 改结构时对着看
    keys: Object.keys(root).slice(0, 40),
  };

  // 兼容老代码路径：lastQuota 仍在用
  lastQuota = userQuota
    ? {
      total: userQuota.total, used: userQuota.used, remaining: userQuota.remaining,
      exceeded: lastUsage.exceeded,
      ...(addOnQuota ? { addOn: addOnQuota } : {}),
      ...(resetAt ? { resetAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }
    : { total: 0, used: 0, remaining: 0, exceeded: lastUsage.exceeded, note: '该账号套餐没有 Credits 配额（可能是免费额度）' };

  return lastUsage;
}

// ---------- 每日签到 ----------

const CLAIM_BENEFIT = 'CLAIM_BENEFIT';
const CLAIMED_STATUSES = new Set(['CLAIMED', 'ALREADY_CLAIMED', 'DONE']);

function campaignWindowOpen(c, nowMs) {
  const start = toEpochMs(c?.startAt ?? c?.start_at ?? c?.beginAt ?? c?.begin_at);
  const end = toEpochMs(c?.endAt ?? c?.end_at);
  if (start !== undefined && nowMs < start) return false;
  if (end !== undefined && nowMs > end) return false;
  return true;
}

// 只看 claimStatus 会误打那条订阅推广（actionType=VIEW_DETAILS，claimStatus 也是 CLAIMED），
// 所以两个条件都得满足：actionType 必须是 CLAIM_BENEFIT，且窗口开着。
function checkinCampaignOf(payload) {
  const list = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
  const now = Date.now();
  return list.find((c) => c
    && c.actionType === CLAIM_BENEFIT
    && campaignWindowOpen(c, now)
    && !CLAIMED_STATUSES.has(String(c.claimStatus || '').toUpperCase()));
}

function checkinSummary(payload) {
  const list = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
  const campaign = checkinCampaignOf(payload);
  const benefit = campaign?.benefit;
  const amount = Number(benefit?.amount);
  const target = campaign || list.find((c) => c && c.actionType === CLAIM_BENEFIT);
  return {
    active: Boolean(target),
    claimable: Boolean(campaign),
    todayCheckedIn: Boolean(target) && !campaign,
    ...(Number.isFinite(amount) && amount > 0 ? { amount } : {}),
    ...(benefit?.kind ? { kind: benefit.kind } : {}),
    ...(Number.isFinite(Number(benefit?.validity?.days)) ? { validDays: Number(benefit.validity.days) } : {}),
    ...(campaign ? { campaignId: campaign.id ?? campaign.campaignId ?? undefined } : {}),
    ...(toEpochMs(target?.endAt ?? target?.end_at) ? { endsAt: toEpochMs(target.endAt ?? target.end_at) } : {}),
  };
}

async function refreshCheckin(force) {
  if (!force && lastCheckin && Date.now() - lastCheckin.at < 5 * 60 * 1000) return lastCheckin;
  const r = await openApiGet('/sash/api/v1/me/campaigns');
  if (!r.ok || !r.json) {
    lastCheckin = { at: Date.now(), active: false, error: r.why || `HTTP ${r.status}` };
    return lastCheckin;
  }
  const payload = r.json.qoderUsage ?? r.json.data ?? r.json;
  lastCheckin = { at: Date.now(), ...checkinSummary(payload) };
  return lastCheckin;
}

// Qoder 每天 10:00(UTC+8) 换新 campaign，每轮只能领一次；重复领上游会回 replayed=true，
// 不扣东西，所以这里不做本地去重，点了就发。
async function claimCheckin() {
  const r = await openApiGet('/sash/api/v1/me/campaigns');
  if (!r.ok || !r.json) throw new Error(`取签到列表失败：${r.why || `HTTP ${r.status}`}`);
  const payload = r.json.qoderUsage ?? r.json.data ?? r.json;
  const campaign = checkinCampaignOf(payload);
  if (!campaign) {
    const s = checkinSummary(payload);
    return { claimed: false, already: s.todayCheckedIn, message: s.todayCheckedIn ? '今天已经签过了' : '现在没有可领的签到活动' };
  }
  const id = campaign.id ?? campaign.campaignId;
  if (id === undefined || id === null || id === '') throw new Error('签到活动没有 id，无法领取');

  const cred = await refreshCredential(false);
  if (!cred) throw new Error('Qoder 未登录');
  const res = await fetch(`${region.openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(id)}/claim`, {
    method: 'POST',
    headers: openApiHeaders(cred, { 'Content-Type': 'application/json' }),
    body: '{}',
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`签到失败：HTTP ${res.status} ${text.slice(0, 160)}`);

  const body = (json && typeof json.data === 'object' && json.data) ? json.data : (json || {});
  const replayed = body.replayed === true;
  const granted = replayed || body.status === 'CLAIMED' || body.success === true;
  const amount = Number(campaign.benefit?.amount);
  lastCheckin = undefined;
  await refreshCheckin(true);
  await refreshUsage(true);
  return {
    claimed: granted,
    replayed,
    ...(granted && !replayed && Number.isFinite(amount) && amount > 0 ? { amount } : {}),
    message: replayed ? '今天已经领过了' : granted ? '签到成功' : '上游没有确认领取成功',
  };
}

// ---------- 本地用量账本 ----------

const USAGE_FILE = join(DATA_DIR, 'usage.json');

// 签到轮次按 Qoder 的规矩每天 10:00(UTC+8) 换新，没拿到 campaign 时也能告诉用户下次什么时候来。
// 这里不查时区库，直接按 UTC+8 算（Qoder 的 CN 区就是这个时区）。
function nextCheckinAt(nowMs) {
  const t = nowMs + 8 * 3600 * 1000;
  const d = new Date(t);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0) - 8 * 3600 * 1000;
  return at > nowMs ? at : at + 24 * 3600 * 1000;
}

function checkinScheduleForCredential(cred) {
  return {
    nextAt: nextCheckinAt(Date.now()),
    ...(cred?.expiresAt ? { memberExpiresAt: toEpochMs(cred.expiresAt) } : {}),
    ...(cred?.plan ? { plan: cred.plan } : {}),
  };
}

function loadUsageBook() {
  try {
    const s = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    if (s && typeof s === 'object' && s.days && typeof s.days === 'object') return s;
  } catch {}
  return { days: {} };
}

function localDayKey(atMs) {
  // 按本机时区算自然日，用户看到的就是「今天」
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function recordUsage(entry, wire, tokensIn, tokensOut) {
  try {
    const book = loadUsageBook();
    const day = localDayKey(Date.now());
    const bucket = book.days[day] || (book.days[day] = { requests: 0, models: {}, wires: {} });
    const key = entry?.key || entry?.model || 'unknown';
    const m = bucket.models[key] || (bucket.models[key] = { requests: 0, in: 0, out: 0, factor: entry?.priceFactor ?? null });
    bucket.requests += 1;
    m.requests += 1;
    m.in += Number(tokensIn) || 0;
    m.out += Number(tokensOut) || 0;
    if (m.factor === null && typeof entry?.priceFactor === 'number') m.factor = entry.priceFactor;
    bucket.wires[wire] = (bucket.wires[wire] || 0) + 1;
    book.updatedAt = Date.now();

    // 只留最近 60 天，账本不能无限长
    const keys = Object.keys(book.days).sort();
    while (keys.length > 60) delete book.days[keys.shift()];

    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(book, null, 1));
  } catch (e) { log('usage write failed', e.message); }
}

// 今天 + 最近 7 天的汇总，给面板用。倍率是 Qoder 的 price_factor（0.5 = 半价），
// 「折算 tokens」= (输入 + 输出) × 倍率，只是量级参考，不等于账单。
function usageSummary() {
  const book = loadUsageBook();
  const today = localDayKey(Date.now());
  const days = Object.keys(book.days).sort().slice(-7);
  const sumOf = (list) => {
    const out = { requests: 0, in: 0, out: 0, weighted: 0, byModel: {} };
    for (const d of list) {
      const b = book.days[d];
      if (!b) continue;
      out.requests += b.requests || 0;
      for (const [k, m] of Object.entries(b.models || {})) {
        out.in += m.in || 0;
        out.out += m.out || 0;
        const f = typeof m.factor === 'number' ? m.factor : 1;
        out.weighted += ((m.in || 0) + (m.out || 0)) * f;
        const t = out.byModel[k] || (out.byModel[k] = { requests: 0, tokens: 0, weighted: 0, factor: m.factor });
        t.requests += m.requests || 0;
        t.tokens += (m.in || 0) + (m.out || 0);
        t.weighted += ((m.in || 0) + (m.out || 0)) * f;
      }
    }
    return out;
  };
  const todayBucket = book.days[today] || { requests: 0, models: {} };
  let todayTokens = 0; let todayWeighted = 0;
  for (const m of Object.values(todayBucket.models || {})) {
    const f = typeof m.factor === 'number' ? m.factor : 1;
    todayTokens += (m.in || 0) + (m.out || 0);
    todayWeighted += ((m.in || 0) + (m.out || 0)) * f;
  }
  return {
    today: { requests: todayBucket.requests || 0, tokens: todayTokens, weighted: Math.round(todayWeighted) },
    week: sumOf(days),
    days,
  };
}

// ---------- 上游流式对话 ----------

async function* streamChat(cred, req, signal) {
  const recordID = randomUUID();
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
      : '';

  const parameters = {};
  if (Number.isSafeInteger(req.maxTokens) && req.maxTokens > 0) parameters.max_tokens = req.maxTokens;
  if (req.enableThinking === true) {
    parameters.enable_thinking = true;
    if (typeof req.reasoningEffort === 'string' && req.reasoningEffort) parameters.reasoning_effort = req.reasoningEffort;
  } else if (req.alwaysThinking !== true) parameters.enable_thinking = false;

  const body = {
    request_id: randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: req.sessionId || `cindy-${randomUUID()}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages: req.messages,
    tools: req.tools || [],
    parameters,
    chat_context: {
      chatPrompt: '', imageUrls: null,
      extra: { context: [], modelConfig: { key: req.model, is_reasoning: req.enableThinking === true }, originalContent: lastText },
      features: [], text: lastText,
    },
    model_config: { key: req.model, source: 'system', is_reasoning: req.enableThinking === true },
    business: {
      product: 'cli', version: '1.0.0', type: 'agent', stage: 'start',
      id: randomUUID(), name: lastText.slice(0, 30), begin_at: Date.now(),
    },
  };

  const url = chatUrl(region);
  const bytes = encodeBody(Buffer.from(JSON.stringify(body)));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': String(req.model),
      'X-Model-Source': 'system',
      ...authHeaders(bytes, url, cred),
    },
    body: bytes,
    redirect: 'error',
    signal: signal === undefined ? AbortSignal.timeout(180000) : AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });

  if (!res.ok) {
    const t = (await res.text()).slice(0, 400);
    const e = new Error(`upstream HTTP ${res.status}: ${t}`);
    e.status = res.status;
    e.upstreamCode = String(res.status);
    throw e;
  }
  if (!res.body) throw new Error('上游没有响应体');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  try {
    while (!done) {
      const step = await reader.read();
      if (step.done) { buf += dec.decode(); if (buf.trim()) buf += '\n'; }
      else buf += dec.decode(step.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p) continue;
        if (p === '[DONE]') { done = true; break; }
        let env;
        try { env = JSON.parse(p); } catch { continue; }
        let chunk = env;
        if (typeof env?.body === 'string') { try { chunk = JSON.parse(env.body); } catch { continue; } }
        else if (env?.body !== undefined && typeof env.body === 'object') chunk = env.body;
        if (chunk?.choices !== undefined || (chunk?.usage !== undefined && chunk.usage !== null)) { yield chunk; continue; }
        if (chunk?.code != null || chunk?.errorCode != null || typeof chunk?.message === 'string') {
          const code = String(chunk.code ?? chunk.errorCode ?? '');
          const detail = String(chunk.message ?? chunk.errorMessage ?? '').slice(0, 300);
          if (code || detail) {
            const e = new Error(`上游错误帧 [${code}] ${detail}`);
            e.upstreamCode = code;
            throw e;
          }
        }
      }
      if (step.done) break;
    }
  } finally { try { await reader.cancel(); } catch {} }
}

function queueWaitMs(err) {
  const code = String(err?.upstreamCode ?? '');
  const text = String(err?.message ?? '');
  if (code !== '403' && code !== '429' && !text.includes('RESOURCE_LIMIT')) return undefined;
  const m = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(text) || /"waitTime"\s*:\s*(\d+)/.exec(text);
  const s = m ? Number(m[1]) : 30;
  return (Number.isFinite(s) && s > 0 ? Math.min(s, 120) : 30) * 1000;
}

// 第 4 项：把上游错误码翻成人话。Qoder 网关的错误码来自它自己的协议：
// 10605 排队、110 当日账单上限、105 登录失效、403/429 限流。
// Cindy 只会把 message 原样显示给用户，所以原始细节留在 detail 里，message 给人看。
function humanizeUpstreamError(err) {
  const raw = String(err?.message ?? '');
  const code = String(err?.upstreamCode ?? '');
  const detail = raw.slice(0, 500);

  const pick = (msg, extra) => ({ message: msg, detail, ...(extra || {}) });

  if (code === '105' || /TOKEN_EXPIRE|TOKEN_INVALID|token expired|unauthoriz/i.test(raw)) {
    return pick('Qoder 登录失效了：请打开 Qoder CN 客户端重新登录，然后回来点面板上的「刷新」。', { type: 'auth_expired' });
  }
  if (code === '110' || /daily.{0,8}limit|DAILY_LIMIT|账单上限/i.test(raw)) {
    return pick('Qoder 今天的用量到上限了（每日账单上限）。等明天额度刷新，或者在 Qoder 里升级套餐。', { type: 'daily_limit' });
  }
  if (code === '10605' || /RESOURCE_LIMIT|10605/i.test(raw)) {
    return pick('Qoder 那边正在排队（免费/低峰额度被抢满了），稍等一会儿再发一次就行。', { type: 'rate_limit' });
  }
  if (code === '429') return pick('Qoder 限流了，等几十秒再试。', { type: 'rate_limit' });
  if (code === '403') return pick('Qoder 拒绝了这次请求（403）。常见原因是账号被限制，或者模型需要会员。', { type: 'upstream_error' });
  if (code === '401') return pick('Qoder 不认当前凭证（401）。请在 Qoder 客户端重新登录后点「刷新」。', { type: 'auth_expired' });
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|AbortError/i.test(raw)) {
    return pick('连不上 Qoder 服务器：检查一下网络和代理，然后重试。', { type: 'upstream_error' });
  }
  if (code === '500' || code === '502' || code === '503' || code === '504') {
    return pick(`Qoder 服务器出错了（${code}），过一会儿再试。`, { type: 'upstream_error' });
  }
  return pick(`Qoder 返回错误：${raw.slice(0, 200)}`, { type: 'upstream_error' });
}

// ---------- 本地 HTTP ----------

function sendJson(res, status, v) {
  const b = Buffer.from(JSON.stringify(v), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function writeSse(res, v) { res.write(`data: ${JSON.stringify(v)}\n\n`); }

async function readBody(req) {
  const chunks = []; let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 20 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isLoopbackAddr(a) {
  if (!a) return false;
  const s = String(a).toLowerCase();
  return s === '::1' || s === '127.0.0.1' || s.startsWith('127.') || s === '::ffff:127.0.0.1';
}

// 只放行 loopback。以前是按字符串前缀判 `127.0.0.1:`（要求带冒号带端口），
// 结果不带端口的 Host（部分 SDK / 代理会去掉默认端口）直接被 403 —— claude-code
// 引擎走 Cindy 的 anthropic-compat-proxy 中转时就踩了这个坑。
// 现在按 hostname 判，端口可有可无，[::1] 与 ::1 都认。
function hostOk(req) {
  const raw = String(req.headers.host || '').toLowerCase().trim();
  if (!raw) return isLoopbackAddr(req.socket && req.socket.remoteAddress);
  let hostname = raw;
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end !== -1 ? hostname.slice(0, end + 1) : hostname;
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon !== -1 && hostname.indexOf(':') === colon) hostname = hostname.slice(0, colon);
  }
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function authOk(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7).trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 面板与 /v1/models 共用的模型标题：倍率必须一眼看见，Cindy 的自定义供应商不解析
// cost / displayPricing（parseModelsListResponse 里没有这两个字段），只能塞名字里。
function modelLabel(m) {
  const f = m.priceFactor;
  const tag = f === 0 ? ' · 免费' : typeof f === 'number' ? ` · x${f}` : '';
  const eff = m.effortLevels && m.effortLevels.length ? ` · 档位 ${m.effortLevels.join('/')}` : '';
  return `${m.name}${tag}${eff}`;
}

async function handle(req, res) {
  if (!hostOk(req)) { sendJson(res, 403, { error: { message: 'Host 必须是 loopback' } }); return; }
  const rawUrl = (req.url || '/').split('?')[0];
  // Cindy 的供应商 Base URL 约定带 /v1（http://127.0.0.1:47821/v1），而 claude-code 走
  // anthropic-compat-proxy 时会把 basePath 拼在 SDK 的 /v1/messages 前面，于是上游收到
  // /v1/v1/messages → 我们回 404，Cindy 报「端点不存在（404）」。这里折叠重复的 /v1。
  let url = rawUrl;
  while (/^\/v1\/v1(\/|$)/.test(url)) url = url.slice(3);
  if (url === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, await buildStatus());
    return;
  }
  if ((url === '/v1/models' || url === '/v1/models/') && req.method === 'GET') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: '本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。' } }); return; }
    sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.key, object: 'model', created: 0, owned_by: region.id,
        // 倍率只写进 name：Cindy 的自定义供应商不解析 cost / displayPricing
        // （parseModelsListResponse 里根本没有这两个字段），所以倍率只能靠名字带。
        name: modelLabel(m),
        context_window: m.contextWindow || 200000,
        max_context_window: m.contextWindowMax || m.contextWindow || 200000,
        // Cindy 只认 MODEL_METADATA_FIELDS 白名单字段，推理档位必须挂在 reasoning.supported_efforts 下
        reasoning: m.effortLevels && m.effortLevels.length
          ? { supported_efforts: m.effortLevels, default_effort: m.effortLevels.includes('low') ? 'low' : m.effortLevels[m.effortLevels.length - 1] }
          : { supported_efforts: [] },
        supports_image_input: m.isVL,
        // 旧契约保留，给非 Cindy 调用方
        reasoning_efforts: m.effortLevels,
        price_factor: m.priceFactor,
      })),
    });
    return;
  }
  if ((url === '/v1/chat/completions' || url === '/v1/chat/completions/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: '本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。' } }); return; }
    await chatCompletions(req, res);
    return;
  }
  // Cindy 的 acceptsWireProtocol 规定：claude-code 只接 anthropic-messages，
  // codex 只接 openai-responses，pi 接任意。只给 chat/completions 时只剩 pi 能选。
  if ((url === '/v1/messages' || url === '/v1/messages/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: '本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。' } }); return; }
    await anthropicMessages(req, res);
    return;
  }
  if ((url === '/v1/messages/count_tokens' || url === '/v1/messages/count_tokens/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: '本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。' } }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { error: { message: `请求体不是 JSON：${e.message}` } }); return; }
    const chat = adapters.anthropicRequestToChat(body);
    sendJson(res, 200, { input_tokens: adapters.estimateTokens(chat.messages) });
    return;
  }
  if ((url === '/v1/responses' || url === '/v1/responses/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: '本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。' } }); return; }
    await openaiResponses(req, res);
    return;
  }
  sendJson(res, 404, { error: { message: `没有这个路由：${req.method} ${url}` } });
}

// Cindy 把「上下文窗口 ≥ 1M」编码成模型 id 后缀 [1m]（asar 里 toSdkModelString /
// claudeSubagentModelWithContextWindow 都是 `n>=1e6 ? \`${id}[1m]\` : id`），于是上游
// 收到 `qfmodel[1m]`，我们按原样转发会被 Qoder 网关拒掉。这里把后缀剥掉再匹配。
function normalizeModelKey(id) {
  if (typeof id !== 'string') return '';
  const s = id.trim();
  return /\[1m\]$/i.test(s) ? s.slice(0, -4) : s;
}

async function chatCompletions(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { sendJson(res, 400, { error: { message: `请求体不是 JSON：${e.message}` } }); return; }

  const displayModel = normalizeModelKey(payload.model);
  const entry = models.find((m) => m.key === displayModel);
  const cred = await refreshCredential(false);
  if (!cred) { sendJson(res, 401, { error: { message: 'Qoder 未登录或凭证无法解密' } }); return; }

  const enableThinking = typeof payload.reasoning_effort === 'string' && payload.reasoning_effort
    ? payload.reasoning_effort !== 'off' && payload.reasoning_effort !== 'none'
    : entry?.isReasoning === true;

  const request = {
    model: displayModel,
    messages: toQoderMessages(payload.messages || []),
    tools: toQoderTools(payload.tools),
    maxTokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined,
    enableThinking,
    alwaysThinking: entry?.alwaysThinking === true,
    reasoningEffort: enableThinking
      ? (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort ? payload.reasoning_effort
        : (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined))
      : undefined,
    sessionId: typeof payload.user === 'string' ? payload.user : undefined,
  };

  const wantStream = payload.stream !== false;
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let iterator, first;
  try {
    let attempt = 0;
    for (;;) {
      try {
        iterator = streamChat(cred, request, controller.signal);
        first = await iterator.next();
        break;
      } catch (e) {
        attempt += 1;
        const wait = queueWaitMs(e);
        if (wait === undefined || attempt >= 3) throw e;
        log(`排队等待 ${wait}ms（第 ${attempt} 次）`, displayModel);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  } catch (e) {
    log('对话失败', displayModel, e.message.slice(0, 200));
    const queued = queueWaitMs(e);
    const nice = humanizeUpstreamError(e);
    sendJson(res, queued === undefined ? 502 : 503, {
      error: {
        message: nice.message,
        type: nice.type ?? (queued === undefined ? 'upstream_error' : 'rate_limit'),
        detail: nice.detail,
        ...(queued === undefined ? {} : { retry_after_seconds: Math.ceil(queued / 1000) }),
      },
    });
    return;
  }

  if (!wantStream) {
    const content = []; const calls = new Map(); let finish = 'stop'; let usage;
    for (let s = first; !s.done; s = await iterator.next()) {
      const c = s.value;
      if (c?.usage != null) usage = c.usage;
      const ch = c?.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      if (typeof d.content === 'string') content.push(d.content);
      if (Array.isArray(d.tool_calls)) for (const t of d.tool_calls) {
        const i = t.index ?? 0;
        const cur = calls.get(i) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) cur.id = t.id;
        if (t.function && t.function.name) cur.function.name = t.function.name;
        if (t.function && t.function.arguments) cur.function.arguments += t.function.arguments;
        calls.set(i, cur);
      }
      if (typeof ch.finish_reason === 'string') finish = ch.finish_reason;
    }
    const message = { role: 'assistant', content: content.join('') };
    if (calls.size) message.tool_calls = [...calls.values()];
    recordUsage(entry, 'chat', usage?.prompt_tokens, usage?.completion_tokens);
    sendJson(res, 200, {
      id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
      object: 'chat.completion', created: Math.floor(Date.now() / 1e3),
      model: displayModel,
      choices: [{ index: 0, message, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1e3);
  let sentRole = false;
  let streamUsage;
  try {
    for (let s = first; !s.done; s = await iterator.next()) {
      const c = s.value;
      if (c?.usage != null) { streamUsage = c.usage; writeSse(res, { id, object: 'chat.completion.chunk', created, model: displayModel, choices: [], usage: c.usage }); }
      const ch = c?.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      const out = { role: 'assistant' };
      if (typeof d.content === 'string' && d.content) out.content = d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) out.reasoning_content = r;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.tool_calls = d.tool_calls;
      const finish = ch.finish_reason;
      if (!sentRole) sentRole = true;
      else if (Object.keys(out).length === 1 && finish === undefined) continue;
      writeSse(res, { id, object: 'chat.completion.chunk', created, model: displayModel,
        choices: [{ index: 0, delta: out, finish_reason: finish ?? null }] });
    }
  } catch (e) {
    log('流中断', displayModel, e.message.slice(0, 200));
    const nice = humanizeUpstreamError(e);
    res.write(`data: ${JSON.stringify({ error: { message: nice.message, type: nice.type ?? 'upstream_error', detail: nice.detail } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage(entry, 'chat', streamUsage?.prompt_tokens, streamUsage?.completion_tokens);
    return;
  }
  res.write('data: [DONE]\n\n');
  res.end();
  recordUsage(entry, 'chat', streamUsage?.prompt_tokens, streamUsage?.completion_tokens);
}

// 两种新协议共用的上游开启逻辑：凭证、重试排队、错误落盘。
// 返回 {ok:true, iterator, first} 或 {ok:false}（已经回过错误响应）。
async function openUpstream(req, res, request, displayModel) {
  const cred = await refreshCredential(false);
  if (!cred) { sendJson(res, 401, { error: { message: 'Qoder 未登录或凭证无法解密' } }); return { ok: false }; }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let iterator, first;
  try {
    let attempt = 0;
    for (;;) {
      try {
        iterator = streamChat(cred, request, controller.signal);
        first = await iterator.next();
        break;
      } catch (e) {
        attempt += 1;
        const wait = queueWaitMs(e);
        if (wait === undefined || attempt >= 3) throw e;
        log(`排队等待 ${wait}ms（第 ${attempt} 次）`, displayModel);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  } catch (e) {
    log('对话失败', displayModel, e.message.slice(0, 200));
    const queued = queueWaitMs(e);
    const nice = humanizeUpstreamError(e);
    sendJson(res, queued === undefined ? 502 : 503, {
      error: {
        message: nice.message,
        type: nice.type ?? (queued === undefined ? 'upstream_error' : 'rate_limit'),
        detail: nice.detail,
        ...(queued === undefined ? {} : { retry_after_seconds: Math.ceil(queued / 1000) }),
      },
    });
    return { ok: false };
  }
  return { ok: true, iterator, first };
}

async function anthropicMessages(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { sendJson(res, 400, { error: { message: `请求体不是 JSON：${e.message}` } }); return; }

  const chat = adapters.anthropicRequestToChat(payload);
  const displayModel = normalizeModelKey(chat.model);
  const entry = models.find((m) => m.key === displayModel);

  const reasoningEffort = chat.thinking
    ? (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined)
    : (entry?.isReasoning === true
      ? (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined)
      : undefined);

  const request = {
    model: displayModel,
    messages: toQoderMessages(chat.messages),
    tools: toQoderTools(chat.tools),
    maxTokens: chat.maxTokens,
    enableThinking: chat.thinking || entry?.isReasoning === true,
    alwaysThinking: entry?.alwaysThinking === true,
    reasoningEffort,
  };

  const up = await openUpstream(req, res, request, displayModel);
  if (!up.ok) return;

  const opts = { model: displayModel, inputTokens: adapters.estimateTokens(chat.messages) };
  if (chat.stream) await adapters.writeAnthropicStream(res, up.first, up.iterator, opts);
  else sendJson(res, 200, await adapters.anthropicMessage(up.first, up.iterator, opts));
  // 适配层不回传上游 usage，本地账本按估算输入 + 0 输出记一笔，至少能看请求次数与量级
  recordUsage(entry, 'anthropic', opts.inputTokens, 0);
}

async function openaiResponses(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { sendJson(res, 400, { error: { message: `请求体不是 JSON：${e.message}` } }); return; }

  const chat = adapters.responsesRequestToChat(payload);
  const displayModel = normalizeModelKey(chat.model);
  const entry = models.find((m) => m.key === displayModel);

  const asked = chat.reasoningEffort;
  const enableThinking = asked ? asked !== 'off' && asked !== 'none' : entry?.isReasoning === true;

  const request = {
    model: displayModel,
    messages: toQoderMessages(chat.messages),
    tools: toQoderTools(chat.tools),
    maxTokens: chat.maxTokens,
    enableThinking,
    alwaysThinking: entry?.alwaysThinking === true,
    reasoningEffort: enableThinking
      ? (asked || (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined))
      : undefined,
  };

  const up = await openUpstream(req, res, request, displayModel);
  if (!up.ok) return;

  const opts = { model: displayModel, inputTokens: adapters.estimateTokens(chat.messages) };
  if (chat.stream) await adapters.writeResponsesStream(res, up.first, up.iterator, opts);
  else sendJson(res, 200, await adapters.responsesMessage(up.first, up.iterator, opts));
  recordUsage(entry, 'responses', opts.inputTokens, 0);
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

// 探测该端口上跑的是不是另一个「还算正常」的 Qoder 桥——是的话本进程就没必要再起一个
function portIsOurs(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 2000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 8192) res.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          resolve(Boolean(j && j.ok === true && typeof j.port === 'number' && 'modelCount' in j));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('handler error', e.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
      else res.end();
    });
  });

  // 端口必须咬死：Cindy 里的自定义供应商 Base URL 是手填一次的，端口一漂就变成
  // 「网络一直连接不上」。所以占用了就等（多半是上一个 worker 还没退干净），不顺延。
  let bound = 0;
  const tryListen = async (p) => {
    try { bound = await listenOn(p); return true; }
    catch (e) {
      if (e.code !== 'EADDRINUSE') { log('listen failed', e.message); throw e; }
      return false;
    }
  };

  if (!(await tryListen(PREFERRED_PORT))) {
    for (let waited = 1; waited <= 30 && !bound; waited++) {
      log(`端口 ${PREFERRED_PORT} 被占用，等 ${waited}s 再看`);
      await new Promise((r) => setTimeout(r, 1000));
      if (await tryListen(PREFERRED_PORT)) break;
    }
  }

  if (!bound) {
    // 等满 30s 还是占着：如果是另一个正常的 Qoder 桥，就让它继续服务，本进程退出，
    // 免得两个 worker 互相抢端口把地址搞乱。
    if (await portIsOurs(PREFERRED_PORT)) {
      log(`127.0.0.1:${PREFERRED_PORT} 上已有一个正常的 Qoder 桥，本进程退出`);
      process.exit(0);
    }
    for (let i = 1; i < 20 && !bound; i++) {
      const p = PREFERRED_PORT + i;
      if (!(await tryListen(p))) log(`端口 ${p} 被占用，试下一个`);
    }
  }

  if (!bound) throw new Error(`端口 ${PREFERRED_PORT}..${PREFERRED_PORT + 19} 都被占用`);
  actualPort = bound;
  saveState({ port: actualPort, token });
  log(`已在 127.0.0.1:${actualPort} 监听`);
}

async function boot() {
  bootedAt = Date.now();
  mkdirSync(DATA_DIR, { recursive: true });
  const st = loadState();
  token = typeof st.token === 'string' && st.token.length >= 16 ? st.token : crypto.randomBytes(24).toString('base64url');
  await refreshCredential(true);
  await refreshModels(true);
  await startServer();
  // 用量与签到要打 OpenAPI，慢的时候十几秒；不挡端口起来，放后台补。
  refreshUsage(true).then(() => refreshCheckin(true)).catch((e) => log('refresh usage failed', e.message));
}

async function buildStatus() {
  const cred = await refreshCredential(false);
  // boot 里这两项是后台跑的（不挡端口起来），面板第一次问状态时补一次，
  // 之后都走各自的缓存。给 4 秒上限：面板 12 秒超时，不能让它等到网络超时。
  if (!lastUsage || !lastCheckin) {
    const first = (async () => {
      if (!lastUsage) await refreshUsage(false);
      if (!lastCheckin) await refreshCheckin(false);
    })();
    await Promise.race([first, new Promise((r) => setTimeout(r, 4000))]);
  }
  const scheduled = await checkinScheduleForCredential(cred);
  return {
    ok: true,
    signedIn: Boolean(cred && cred.expired !== true),
    user: cred?.name || (cred?.email ?? '') || '',
    expired: cred?.expired === true,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    token,
    modelCount: models.length,
    models: models.map((m) => ({
      id: m.key, name: m.name, label: modelLabel(m),
      contextWindow: m.contextWindow || 200000,
      priceFactor: m.priceFactor, isVL: m.isVL,
      effortLevels: m.effortLevels,
    })),
    quota: lastQuota,
    usage: lastUsage,
    checkin: { ...(lastCheckin || { active: false }), ...scheduled },
    localUsage: usageSummary(),
    logFile: LOG_FILE,
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    lastError,
    ...(cred ? {} : { hint: '请先在 Qoder CN 客户端登录，然后在插件里点「刷新」。' }),
  };
}

// ============================================================
// JSON-RPC over stdio
// ============================================================

function reply(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || req.type === 'notification') return;
  const id = req.id;
  const method = req.method;

  try {
    let result;
    if (method === 'qoder/status') {
      if (!server) await boot();
      result = await buildStatus();
    } else if (method === 'qoder/endpoint') {
      if (!server) await boot();
      if (!models.length) await refreshModels(true);
      result = {
        ok: models.length > 0,
        ...(models.length === 0 ? { message: '还没有可用模型，请确认 Qoder 已登录后重试' } : {}),
        baseUrl: `http://127.0.0.1:${actualPort}/v1`,
        token,
        models: models.map((m) => ({ id: m.key, name: m.name, contextWindow: m.contextWindow || 200000 })),
      };
    } else if (method === 'qoder/refresh') {
      if (!server) await boot();
      await refreshCredential(true);
      await refreshModels(true);
      await refreshUsage(true);
      await refreshCheckin(true);
      result = await buildStatus();
    } else if (method === 'qoder/checkin') {
      if (!server) await boot();
      await refreshCredential(false);
      const claimed = await claimCheckin();
      await refreshUsage(true);
      result = { ...claimed, status: await buildStatus() };
    } else if (method === 'qoder/boot') {
      if (!server) await boot();
      result = await buildStatus();
    } else {
      reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    reply({ jsonrpc: '2.0', id, result: { ok: true, result } });
  } catch (e) {
    log('rpc error', method, e.message);
    reply({ jsonrpc: '2.0', id, result: { ok: false, message: e.message } });
  }
});

// resident：进程一起来就把服务拉好，不等第一次工具调用
boot().catch((e) => log('boot failed', e.stack || e.message));

process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', String(e)));

