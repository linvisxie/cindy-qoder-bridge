// 自更新链路的纯函数：版本比较、digest 校验、zip 解包、替换脚本生成。
//
// 为什么单独抽一个文件：worker.cjs 一被 require 就会 boot()（起 HTTP 服务、读凭据），
// 测试里没法直接拿到它的内部函数。而这一段的逻辑（版本比较、完整性校验、解包、
// PowerShell 脚本拼装、清单快照同步）全部可以离线验证，不该只能靠「真装一次试试」。
//
// 两个仓库（cindy-qoder-bridge / trae-cindy-bridge）的这份文件**逐字相同**，
// 跟 adapters.cjs 一样：改一处必须改两处。
'use strict';

const zlib = require('node:zlib');
const { join, dirname } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');

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
 * 没有 digest 时退回按 size 校验；digest 给了但格式解析不了、或两个都没给，
 * 一律拒绝安装（fail-closed）：更新是最高风险动作，不能存在「零完整性
 * 信息也装」或「坏 digest 静默降级成只看大小」的路径。
 */
function verifyDigest(buf, digest, size) {
  const parsed = parseDigest(digest);
  if (!parsed && digest != null && String(digest).trim() !== '') {
    return {
      ok: false,
      reason: `发布记录里的 digest 格式无法解析（期望 sha256:<十六进制>），已放弃安装，安装目录未改动。`,
    };
  }
  if (parsed) {
    if (parsed.alg !== 'sha256') {
      return { ok: false, reason: `发布记录里的 digest 用的是不认识的算法 ${parsed.alg}，只支持 sha256` };
    }
    const actual = sha256Hex(buf);
    if (actual === parsed.hex) return { ok: true, expected: parsed.hex, actual };
    return {
      ok: false,
      expected: parsed.hex,
      actual,
      reason: `下载包的 sha256 与发布记录不符（期望 ${parsed.hex.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）。包可能在下载中被截断或被替换，已放弃安装，安装目录未改动。`,
    };
  }
  if (typeof size === 'number' && size > 0) {
    if (buf.length === size) return { ok: true, size };
    return {
      ok: false,
      reason: `下载包大小 ${buf.length} 字节与发布记录的 ${size} 字节不符（大概率被截断），已放弃安装，安装目录未改动。`,
    };
  }
  return {
    ok: false,
    reason: '发布记录既没给 digest 也没给大小，无法校验下载包的完整性，已放弃安装，安装目录未改动。',
  };
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
    return value.split('/').every((part) => part && part !== '.' && part !== '..');
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
 * 生成「等旧进程退出 → 备份 → 覆盖 → 同步清单快照 → 清理」这段 PowerShell。
 *
 * 为什么必须交给独立脚本：Windows 上正在运行的 .js 被进程锁着，本进程覆盖自己
 * 一定 EBUSY／EPERM。脚本里的 Wait-Process 等到 worker 真退出后才动文件，
 * 之后由 Cindy 重新拉起（实测约 24 秒）。
 *
 * 清理放在 finally 里：中途抛错（$ErrorActionPreference='Stop'）也要把暂存目录和
 * 下载下来的 .cindy 删掉，否则反复失败会一直往 update/ 里堆。
 */
function buildApplyScript(opts) {
  const { root, stage, backup, pkg, syncScript, nodeExe, oldPid } = opts;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$root = ${psQuote(root)}`,
    `$stage = ${psQuote(stage)}`,
    `$backup = ${psQuote(backup)}`,
    `$pkg = ${psQuote(pkg)}`,
    `$sync = ${psQuote(syncScript)}`,
    `$nodeExe = ${psQuote(nodeExe)}`,
    `$oldPid = ${Number(oldPid) || 0}`,
    `try {`,
    `  try { Wait-Process -Id $oldPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}`,
    `  Start-Sleep -Milliseconds 300`,
    // 备份每次都刷新：同版本重试时沿用上次的旧备份，回滚点会比预期更老。
    `  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }`,
    `  Copy-Item $root $backup -Recurse -Force`,
    // 覆盖或同步中途失败就从备份还原，别把新旧混杂的目录留给用户手工收拾。
    `  try {`,
    `    Copy-Item (Join-Path $stage '*') $root -Recurse -Force`,
    // 清单快照必须在删掉 $pkg 之前同步（它要算这个包的 sha256）；同步本身仍是尽力而为，不触发回滚。
    `    if ((Test-Path $sync) -and (Test-Path $nodeExe)) { try { & $nodeExe $sync } catch {} }`,
    `  } catch {`,
    `    try {`,
    `      Get-ChildItem $root -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Copy-Item (Join-Path $backup '*') $root -Recurse -Force`,
    `    } catch {}`,
    `    throw`,
    `  }`,
    `} finally {`,
    `  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }`,
    `  if (Test-Path $pkg) { Remove-Item $pkg -Force -ErrorAction SilentlyContinue }`,
    `  if (Test-Path $sync) { Remove-Item $sync -Force -ErrorAction SilentlyContinue }`,
    `  if ($PSCommandPath) { Remove-Item $PSCommandPath -Force -ErrorAction SilentlyContinue }`,
    `}`,
  ].join('\r\n');
}

/**
 * 生成「同步 Cindy 自己的插件清单缓存」那段 node 脚本。
 *
 * 背景：Cindy 的「插件管理」页读的是 ghost-install-state 下的清单快照
 * （_ns/_root/<id>.json 的 manifest + plugin-instances.v2.json 的 packageSha256），
 * 不是运行中的 ghost.json。自更新只覆盖运行文件的话，管理页会停在旧版本
 * ——「代码是新的、管理页还写老版本、Tools 还是旧的」。
 *
 * owner 目录从安装位置反推（安装目录固定是 <owner>/cindy-brain/_ns/_root/<id>），
 * 不写死任何本机路径；快照文件不存在时安静跳过（开发目录直接跑 worker 的情况）。
 */
function buildSnapshotSyncScript(opts) {
  const { installDir, pkgPath } = opts;
  const J = (v) => JSON.stringify(v);
  return `// 由桥插件自更新脚本生成，装完后同步 Cindy 的插件清单缓存。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INSTALL = ${J(installDir)};
const PKG = ${J(pkgPath)};
const OWNER = path.resolve(INSTALL, '..', '..', '..', '..');
const STATE = path.join(OWNER, 'ghost-install-state', 'plugin-instances.v2.json');

const out = [];
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(INSTALL, 'ghost.json'), 'utf8'));
  const id = manifest.id;
  const cacheFile = path.join(OWNER, 'ghost-install-state', '_ns', '_root', id + '.json');
  const sha = fs.existsSync(PKG) ? crypto.createHash('sha256').update(fs.readFileSync(PKG)).digest('hex') : undefined;
  const revision = crypto.randomUUID();

  if (fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache.revision = revision;
    cache.manifest = manifest;
    if (sha) cache.packageSha256 = sha;
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\\n');
    out.push('清单快照 → v' + manifest.version);
  } else {
    out.push('没有清单快照，跳过');
  }

  if (fs.existsSync(STATE)) {
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const inst = state.instances && state.instances['_root__' + id];
    if (inst) {
      inst.receiptRevision = revision;
      if (sha) inst.packageSha256 = sha;
      fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\\n');
      out.push('plugin-instances → receiptRevision=' + revision);
    }
  }
} catch (e) {
  out.push('同步清单快照失败：' + (e && e.message ? e.message : String(e)));
}
console.log(out.join('；'));
`;
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
  buildSnapshotSyncScript,
};
