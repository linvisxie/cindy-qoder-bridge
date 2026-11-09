// 自更新链路的纯函数：版本比较、digest 校验、zip 解包、替换脚本生成。
//
// 为什么单独抽一个文件：worker.cjs 一被 require 就会 boot()（起 HTTP 服务、读凭据），
// 测试里没法直接拿到它的内部函数。而这一段的逻辑（版本比较、完整性校验、解包、
// PowerShell 脚本拼装）全部可以离线验证，不该只能靠「真装一次试试」。
//
// 两个仓库（cindy-qoder-bridge / trae-cindy-bridge）的这份文件**逐字相同**，
// 跟 adapters.cjs 一样：改一处必须改两处。
'use strict';

const zlib = require('node:zlib');
const { join, dirname } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');

// ---------- 版本比较 ----------

function versionParts(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((x) => Number(x.replace(/\D/g, '')) || 0);
}

// 比版本：a 比 b 新返回正数，相同 0，旧负数。逐段比，缺的段按 0 算。
function compareVersion(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------- 完整性校验 ----------
//
// GitHub Releases 的 REST 接口现在自带 asset.digest（形如 "sha256:abc…"，2025 年起提供）。
// 这个值与本机 dist 包、以及 Cindy 记在 plugin-instances.v2.json 里的 packageSha256
// 三方一致，所以自更新必须在覆盖安装目录**之前**比一次 —— 下载被截断或中间人替换时，
// worker 已经 process.exit(0) 了，覆盖上去就是让 Cindy 拉起一份坏代码，只能靠 .bak 手工回滚。

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseDigest(value) {
  if (typeof value !== 'string') return undefined;
  // 大小写都认：GitHub 现在给的是 "sha256:<小写>"，但没理由假设它永远不变。
  const m = /^([a-z0-9]+):([0-9a-f]+)$/i.exec(value.trim());
  if (!m) return undefined;
  return { alg: m[1].toLowerCase(), hex: m[2].toLowerCase() };
}

/**
 * 校验下载到的字节。
 * 返回 { ok:true, ... } 或 { ok:false, reason }。
 * SHA256 是必需项；size 仅做附加校验，绝不降级成只校验大小。
 */
function verifyDigest(buf, digest, size) {
  const parsed = parseDigest(digest);
  if (!parsed) {
    return {
      ok: false,
      reason: `发布记录里的 digest 格式无法解析（期望 sha256:<十六进制>），已放弃安装，安装目录未改动。`,
    };
  }
  if (parsed) {
    if (parsed.alg !== 'sha256') {
      return { ok: false, reason: `发布记录里的 digest 用的是不认识的算法 ${parsed.alg}，只支持 sha256` };
    }
    if (parsed.hex.length !== 64) {
      return { ok: false, reason: 'sha256 digest 必须是 64 位十六进制，已放弃安装。' };
    }
    const actual = sha256Hex(buf);
    if (actual === parsed.hex) {
      if (typeof size === 'number' && size > 0 && buf.length !== size) {
        return { ok: false, reason: `下载包大小 ${buf.length} 与发布记录 ${size} 不符，已放弃安装。` };
      }
      return { ok: true, expected: parsed.hex, actual };
    }
    return {
      ok: false,
      expected: parsed.hex,
      actual,
      reason: `下载包的 sha256 与发布记录不符（期望 ${parsed.hex.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）。包可能在下载中被截断或被替换，已放弃安装，安装目录未改动。`,
    };
  }
}

// ---------- zip 解包 ----------
//
// .cindy 就是普通 zip，只需要「列条目 + 解到目录」这一件事。
// （test/_unzip.cjs 是同一份逻辑，但测试目录不会被打进插件包，所以这边独立一份。）

function readZipEntries(buf) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录条目签名不对');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地文件头签名不对：' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);
    out.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function extractZipTo(buf, targetDir) {
  const names = [];
  for (const e of readZipEntries(buf)) {
    const rel = e.name.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('包里有不安全路径：' + e.name);
    const dest = join(targetDir, ...rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
    names.push(rel);
  }
  return names;
}

// Validate the archive itself before extraction: a stale directory must not fill missing entries.
function validatePackage(entries, expected) {
  const files = new Map();
  const safePath = (value) => {
    if (typeof value !== 'string' || !value || /[\\:]/.test(value) || value.startsWith('/')) return false;
    return value.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.cindy-trust.json');
  };
  for (const entry of entries) {
    if (!safePath(entry.name) || files.has(entry.name)) throw new Error('更新包条目路径无效或重复：' + entry.name);
    files.set(entry.name, entry.data);
  }
  if (!files.has('ghost.json')) throw new Error('更新包缺少 ghost.json');
  let manifest;
  try { manifest = JSON.parse(files.get('ghost.json').toString('utf8')); }
  catch { throw new Error('更新包 ghost.json 不是合法 JSON'); }
  if (!manifest || manifest.id !== expected.id) throw new Error('更新包插件 ID 不匹配');
  if (manifest.schemaVersion !== 3) throw new Error('更新包清单版本不受支持');
  if (manifest.version !== expected.version || compareVersion(manifest.version, expected.currentVersion) <= 0) {
    throw new Error('更新包版本与目标发布不匹配或不是更新版本');
  }
  const required = [manifest.entry, manifest.node && manifest.node.entry, manifest.panel && manifest.panel.html,
    'main.js', 'panel.js', 'panel.html', 'node/worker.cjs', ...(expected.required || [])];
  for (const name of required) {
    if (!safePath(name) || !files.has(name)) throw new Error('更新包缺少或非法入口：' + name);
  }
  return manifest;
}

// spawn() may return a child and emit ENOENT/EACCES asynchronously.
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { child.removeListener('spawn', onSpawn); reject(error); };
    const onSpawn = () => { child.removeListener('error', onError); resolve(child); };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

// ---------- 生成的脚本 ----------

// PowerShell 单引号字符串里再转义单引号，路径带空格/引号也不会被截断。
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 生成「等旧进程退出 → 备份 → 覆盖 → 清理」这段 PowerShell。
 * syncScript/nodeExe 旧 opts 兼容接收但不执行；宿主安装记录只能由原生导入确认。
 *
 * 为什么必须交给独立脚本：Windows 上正在运行的 .js 被进程锁着，本进程覆盖自己
 * 一定 EBUSY／EPERM。脚本里的 Wait-Process 等到 worker 真退出后才动文件，
 * 之后由 Cindy 重新拉起（实测约 24 秒）。
 *
 * 只有成功才清理。失败保留所有诊断；result.json 在每个破坏性阶段前持久化，
 * 被中断的 copying/rolling_back 不能被读者误当成成功。
 * installationPipe/ownershipPipe 分别传 pipeName(INSTALL_DIR, 'install') 与
 * pipeName(DATA_DIR, 'data')，退出后按 install → data 取得 FIRST_PIPE_INSTANCE。
 * 两个 pipe 必须同时提供，且 latestPointer 必须在持锁后确认当前 attempt，
 * 不能用 ownershipPath 绕过。旧调用方可用无指针文件锁，
 * 但重启 worker 也必须遵守该锁，不得在安装器持锁期间 boot/读写安装目录。
 * waitTimeoutMs/pollIntervalMs 仅为可信调用方 opts，不能取自远端发布信息。
 */
function buildApplyScript(opts) {
  const { root, stage, backup, pkg, oldPid } = opts;
  const attemptDir = opts.attemptDir || join(dirname(stage), 'attempt-' + randomUUID());
  const ownershipPath = opts.ownershipPath || join(dirname(stage), 'install.lock');
  const bounded = (value, fallback, max) => Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), max) : fallback;
  const waitMs = bounded(opts.waitTimeoutMs, 60000, 300000);
  const pollMs = bounded(opts.pollIntervalMs, 100, 1000);
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$root = ${psQuote(root)}`,
    `$stage = ${psQuote(stage)}`,
    `$backup = ${psQuote(backup)}`,
    `$pkg = ${psQuote(pkg)}`,
    `$oldPid = ${Number.isSafeInteger(oldPid) && oldPid > 0 ? oldPid : 0}`,
    `$attempt = ${psQuote(attemptDir)}`,
    `$latestPointer = ${psQuote(opts.latestPointer || '')}`,
    `$ownership = ${psQuote(ownershipPath)}`,
    `$installationPipe = ${psQuote(opts.installationPipe || '')}`,
    `$ownershipPipe = ${psQuote(opts.ownershipPipe || '')}`,
    `New-Item -ItemType Directory -Path $attempt -Force | Out-Null`,
    `$result = [ordered]@{ schemaVersion = 1; status = 'not_started'; phase = 'waiting'; root = $root; stage = $stage; backup = $backup; pkg = $pkg; error = $null; rollbackError = $null; hostReceipt = 'requires_host_install'; hostReceiptMessage = 'Use Cindy native import to confirm the host installation record; replacing files does not update the host receipt.'; cleanupError = $null; updatedAt = $null }`,
    `function Save-Result {`,
    `  $result.updatedAt = [DateTime]::UtcNow.ToString('o')`,
    `  $json = $result | ConvertTo-Json -Depth 5`,
    `  [IO.File]::WriteAllText((Join-Path $attempt 'result.json.tmp'), $json)`,
    `  Move-Item -LiteralPath (Join-Path $attempt 'result.json.tmp') -Destination (Join-Path $attempt 'result.json') -Force`,
    `  Add-Content -LiteralPath (Join-Path $attempt 'install.log') -Value $json`,
    `}`,
    // Never overwrite/delete host trust, including nested or differently cased names.
    `function Copy-InstallFiles($source, $destination) {`,
    `  New-Item -ItemType Directory -Path $destination -Force | Out-Null`,
    `  Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -ine '.cindy-trust.json' } | ForEach-Object {`,
    `    if ($_.PSIsContainer) { Copy-InstallFiles $_.FullName (Join-Path $destination $_.Name) }`,
    `    else { Copy-Item -LiteralPath $_.FullName -Destination $destination -Force }`,
    `  }`,
    `}`,
    `function Remove-InstallFiles($directory) {`,
    `  Get-ChildItem -LiteralPath $directory -Force | Where-Object { $_.Name -ine '.cindy-trust.json' } | ForEach-Object {`,
    `    if ($_.PSIsContainer) {`,
    `      Remove-InstallFiles $_.FullName`,
    `      if (@(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0) { Remove-Item -LiteralPath $_.FullName -Force }`,
    `    } else { Remove-Item -LiteralPath $_.FullName -Force }`,
    `  }`,
    `}`,
    `$lock = $null`,
    `$installationLock = $null`,
    `$copyStarted = $false`,
    `Save-Result`,
    `try {`,
    // Both handles are released by the OS on interruption. Never unlink a lock pathname.
    // Obtain pipe ownership AFTER the old worker exits (it holds the pipe until exit).
    `  if (!!$installationPipe -ne !!$ownershipPipe) { throw 'Both installationPipe and ownershipPipe are required; refusing installation' }`,
    `  if (!$installationPipe -and !$ownershipPipe) { $lock = [IO.File]::Open($ownership, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }`,
    `  if ($oldPid -le 0) { throw 'Invalid old worker PID; refusing installation' }`,
    `  $timer = [Diagnostics.Stopwatch]::StartNew()`,
    `  while (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {`,
    `    if ($timer.ElapsedMilliseconds -ge ${waitMs}) { throw 'Old worker is still running; installation not started' }`,
    `    Start-Sleep -Milliseconds ${pollMs}`,
    `  }`,
    // No backup deletion/copy is permitted until the process has actually disappeared.
    `  if ($ownershipPipe) {`,
    `    Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `using Microsoft.Win32.SafeHandles;`,
    `public static class BridgeInstallOwnership {`,
    `  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]`,
    `  public static extern SafeFileHandle CreateNamedPipeW(string name, uint mode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, IntPtr security);`,
    `}`,
    `'@`,
    `    $installationLock = [BridgeInstallOwnership]::CreateNamedPipeW($installationPipe, 0x00080003, 0, 1, 0, 0, 0, [IntPtr]::Zero)`,
    `    if ($installationLock.IsInvalid) { throw 'INSTALL_DIR ownership unavailable; refusing installation' }`,
    `    $lock = [BridgeInstallOwnership]::CreateNamedPipeW($ownershipPipe, 0x00080003, 0, 1, 0, 0, 0, [IntPtr]::Zero)`,
    `    if ($lock.IsInvalid) { throw 'DATA_DIR ownership unavailable; refusing installation' }`,
    `  }`,
    // Fence late installers while both scopes are held; never touch root on rejection.
    `  if ($ownershipPipe -and [string]::IsNullOrWhiteSpace($latestPointer)) { throw 'Stale installer: latestPointer is required; refusing installation' }`,
    `  if ($latestPointer) {`,
    `    try { $latest = [IO.File]::ReadAllText($latestPointer) | ConvertFrom-Json }`,
    `    catch { throw 'Stale installer: latest pointer missing or invalid; refusing installation' }`,
    `    if ($latest.attempt -isnot [string] -or ![string]::Equals($latest.attempt, (Split-Path -Leaf $attempt), [StringComparison]::Ordinal)) { throw 'Stale installer: attempt is no longer current; refusing installation' }`,
    `  }`,
    `  $result.phase = 'backup'; Save-Result`,
    `  if (Test-Path -LiteralPath $backup) { throw 'Backup already exists; refusing to overwrite recovery data' }`,
    `  Copy-Item -LiteralPath $root -Destination $backup -Recurse -Force`,
    `  $result.status = 'in_progress'; $result.phase = 'copying'; Save-Result`,
    `  $copyStarted = $true`,
    `  Copy-InstallFiles $stage $root`,
    `  $result.status = 'success'; $result.phase = 'complete'; Save-Result`,
    `} catch {`,
    `  $failure = $_`,
    `  $result.error = $_.ToString()`,
    `  if ($copyStarted) {`,
    `    $result.status = 'in_progress'; $result.phase = 'rolling_back'; Save-Result`,
    `    try {`,
    `      Remove-InstallFiles $root`,
    `      Copy-InstallFiles $backup $root`,
    `      $result.status = 'rollback_succeeded'`,
    `    } catch { $result.status = 'rollback_failed'; $result.rollbackError = $_.ToString() }`,
    `  } else { $result.status = 'not_started' }`,
    `  $result.phase = 'failed'; Save-Result`,
    `  if ($result.rollbackError) { throw "Install failed: $($result.error); rollback failed: $($result.rollbackError)" }`,
    `  throw $failure`,
    `} finally {`,
    `  try {`,
    `    if ($result.status -eq 'success') {`,
    `      try {`,
    `        foreach ($path in @($stage, $pkg)) {`,
    `          if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }`,
    `        }`,
    `        if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force }`,
    `      } catch { $result.cleanupError = $_.ToString(); Save-Result; throw }`,
    `    }`,
    `  } finally {`,
    `    try { if ($null -ne $lock) { $lock.Dispose() } }`,
    `    finally { if ($null -ne $installationLock) { $installationLock.Dispose() } }`,
    `  }`,
    `}`,
  ].join('\r\n');
}

module.exports = {
  versionParts,
  compareVersion,
  sha256Hex,
  parseDigest,
  verifyDigest,
  readZipEntries,
  validatePackage,
  waitForSpawn,
  extractZipTo,
  psQuote,
  buildApplyScript,
};
