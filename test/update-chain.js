// 自更新链路的离线回归：版本比较、digest 校验、zip 解包、脚本生成。
//
// 全程不联网、不碰上游额度 —— 这些函数本来就是纯的，只是以前藏在 worker.cjs 里
// （一 require 就 boot）没法测。抽到 node/update.cjs 之后就都能锁死了。
'use strict';

const { join } = require('node:path');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');

const updater = require('../plugin/node/update.cjs');
const { readZipEntries } = require('./_unzip.cjs');

let pass = 0;
let fail = 0;
const skips = [];

function ok(msg) { pass++; console.log('  \u2713 ' + msg); }
function bad(msg) { fail++; console.log('  \u2717 ' + msg); }
function skip(msg) { skips.push(msg); console.log('  - ' + msg); }
function eq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
function truthy(v, msg) { if (v) ok(msg); else bad(msg); }

console.log('\n=== 第 1 组：版本比较 ===');

// 逐段比较，缺的段按 0：0.1.15 > 0.1.9（字符串比会得出反向结论，这是最容易写错的一条）
eq(updater.compareVersion('0.1.15', '0.1.9') > 0, true, '0.1.15 比 0.1.9 新（按段比，不是按字符串比）');
eq(updater.compareVersion('0.1.9', '0.1.15') < 0, true, '0.1.9 比 0.1.15 旧');
eq(updater.compareVersion('0.1.7', '0.1.7'), 0, '同版本返回 0');
eq(updater.compareVersion('v0.1.7', '0.1.7'), 0, '前缀 v 不影响比较');
eq(updater.compareVersion('1.0.0', '0.9.9') > 0, true, '主版本号优先');
eq(updater.compareVersion('0.2.0', '0.1.99') > 0, true, '次版本号优先于修订号');
eq(updater.compareVersion('0.1', '0.1.0'), 0, '缺段按 0 补齐');
eq(updater.compareVersion('0.1.1', '0.1') > 0, true, '多一段非零则更新');

// 解析器本身
eq(JSON.stringify(updater.versionParts('v0.1.15')), '[0,1,15]', 'versionParts 能剥 v 前缀');
eq(JSON.stringify(updater.versionParts('')), '[0]', 'versionParts 对空串返回 [0]');

console.log('\n=== 第 2 组：digest 校验 ===');

const bytes = Buffer.from('this is the .cindy package payload', 'utf8');
const goodHex = updater.sha256Hex(bytes);

eq(updater.parseDigest('sha256:' + goodHex).hex, goodHex, 'parseDigest 认得 sha256 前缀');
eq(updater.parseDigest('SHA256:' + goodHex.toUpperCase()).alg, 'sha256', 'parseDigest 对大小写不敏感');
eq(updater.parseDigest('not-a-digest'), undefined, 'parseDigest 对乱串返回 undefined');
eq(updater.parseDigest(undefined), undefined, 'parseDigest 对 undefined 返回 undefined');

const r1 = updater.verifyDigest(bytes, 'sha256:' + goodHex, bytes.length);
eq(r1.ok, true, 'digest 一致时通过');
eq(r1.skipped, undefined, 'digest 一致时不算跳过');

const r2 = updater.verifyDigest(bytes, 'sha256:' + '0'.repeat(64), bytes.length);
eq(r2.ok, false, 'digest 不一致时拒绝');
truthy(/sha256 与发布记录不符/.test(r2.reason || ''), '拒绝理由说清了是哈希不符');
truthy(/安装目录未改动/.test(r2.reason || ''), '拒绝理由承诺安装目录未改动');

// 没有 digest 时退回按 size 校验
const r3 = updater.verifyDigest(bytes, undefined, bytes.length);
eq(r3.ok, true, '无 digest 但 size 一致时通过');

const r4 = updater.verifyDigest(bytes, undefined, bytes.length + 100);
eq(r4.ok, false, '无 digest 但 size 不符时拒绝');
truthy(/被截断/.test(r4.reason || ''), 'size 不符时提示可能被截断');

const r5 = updater.verifyDigest(bytes, undefined, undefined);
eq(r5.ok, true, '两者都没有时放行');
eq(r5.skipped, true, '两者都没有时标记 skipped，让调用方记日志');

// 不认识的算法不能静默放行
const r6 = updater.verifyDigest(bytes, 'md5:abc123', bytes.length);
eq(r6.ok, false, '不认识的 digest 算法拒绝（不静默放行）');

console.log('\n=== 第 3 组：zip 解包 ===');

// 用真实的 dist 包验一遍：自动找仓库里唯一的 .cindy 文件，
// 这样两个仓库的这份测试可以保持逐字相同（不写死包名）。
function findDistPackage() {
  const dir = join(__dirname, '..', 'dist');
  if (!existsSync(dir)) return undefined;
  const hits = require('node:fs').readdirSync(dir).filter((f) => f.endsWith('.cindy'));
  return hits.length === 1 ? join(dir, hits[0]) : undefined;
}

const distPkg = findDistPackage();
if (distPkg) {
  const buf = readFileSync(distPkg);
  const a = updater.readZipEntries(buf).map((e) => `${e.name}:${e.data.length}`);
  const b = readZipEntries(buf).map((e) => `${e.name}:${e.data.length}`);
  eq(JSON.stringify(a), JSON.stringify(b), 'worker 内那份解包与 test/_unzip.cjs 结果一致');

  const tmp = mkdtempSync(join(os.tmpdir(), 'cindy-zip-'));
  try {
    const names = updater.extractZipTo(buf, tmp);
    truthy(names.includes('ghost.json'), '解出的包根有 ghost.json');
    truthy(existsSync(join(tmp, 'ghost.json')), 'ghost.json 真的落到磁盘上了');
    const m = JSON.parse(readFileSync(join(tmp, 'ghost.json'), 'utf8'));
    truthy(typeof m.version === 'string' && m.version.length > 0, '解出的 ghost.json 有版本号');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  skip('dist 包里没有唯一的 .cindy，跳过真实包解包断言');
}

// 路径穿越必须拒绝
function buildTinyZip(name) {
  // 手工构造一个只含单条目的 zip，用来测不安全路径。
  const zlib = require('node:zlib');
  const data = Buffer.from('x');
  const deflated = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(deflated.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42);

  const cdOffset = local.length + nameBuf.length + deflated.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBuf.length, 12); end.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, nameBuf, deflated, cd, nameBuf, end]);
}

let threw = false;
try {
  const evil = buildTinyZip('../../evil.txt');
  const tmp2 = mkdtempSync(join(os.tmpdir(), 'cindy-evil-'));
  try { updater.extractZipTo(evil, tmp2); } finally { rmSync(tmp2, { recursive: true, force: true }); }
} catch (e) {
  threw = /不安全路径/.test(e.message);
}
truthy(threw, '含 ../ 的条目被拒绝（zip slip 防护）');

console.log('\n=== 第 4 组：PowerShell 脚本生成 ===');

const sample = updater.buildApplyScript({
  root: "C:\\some dir\\qoder-bridge",
  stage: "C:\\some dir\\stage",
  backup: "C:\\some dir\\qoder-bridge.bak-0.1.15",
  pkg: "C:\\some dir\\pkg.cindy",
  syncScript: "C:\\some dir\\sync-snapshot.cjs",
  nodeExe: "C:\\Program Files\\nodejs\\node.exe",
  oldPid: 12345,
});

truthy(sample.includes("$ErrorActionPreference = 'Stop'"), '脚本设置了 ErrorActionPreference=Stop');
truthy(/Wait-Process -Id \$oldPid/.test(sample), 'Wait-Process 用的是 $oldPid 变量');
truthy(sample.includes('$oldPid = 12345'), '脚本里 $oldPid 被赋成调用方的 pid');
truthy(sample.includes("-Timeout 60"), '等待有 60 秒超时兜底');
truthy(/Copy-Item \$root \$backup/.test(sample), '覆盖前会备份安装目录');
truthy(sample.includes("Join-Path $stage '*'"), '会把暂存目录内容覆盖进安装目录');
truthy(/\$sync/.test(sample) && /& \$nodeExe \$sync/.test(sample), '装完会调用快照同步脚本');
truthy(sample.includes('finally'), '清理放在 finally 里（中途抛错也会清理）');
truthy(/\$stage\) \{ Remove-Item \$stage/.test(sample), 'finally 里会删暂存目录');
truthy(/\$pkg\) \{ Remove-Item \$pkg/.test(sample), 'finally 里会删下载下来的包');

// 单引号转义：路径里带 ' 也不能让脚本被截断
const tricky = updater.buildApplyScript({
  root: "C:\\it's a dir\\bridge",
  stage: 's', backup: 'b', pkg: 'p', syncScript: 'y', nodeExe: 'n', oldPid: 1,
});
truthy(tricky.includes("'C:\\it''s a dir\\bridge'"), "路径里的单引号被正确转义成 ''");

// 同步脚本：owner 目录从安装位置反推，不写死本机路径
const sync = updater.buildSnapshotSyncScript({
  installDir: 'C:\\Users\\x\\AppData\\Roaming\\CindyGlobal\\owners\\abc\\cindy-brain\\_ns\\_root\\qoder-bridge',
  pkgPath: 'C:\\Users\\x\\AppData\\Roaming\\CindyGlobal\\qoder-bridge\\update\\pkg.cindy',
});
truthy(sync.includes('plugin-instances.v2.json'), '同步脚本会更新 plugin-instances.v2.json');
truthy(sync.includes("'..', '..', '..', '..'"), 'owner 目录从安装位置反推');
truthy(!/[A-Za-z]:\\\\Users\\\\linvisxie/.test(sync.replace(/\\\\/g, '\\')), '同步脚本里没有写死本机路径');
truthy(sync.includes('packageSha256'), '同步脚本会写 packageSha256');
truthy(sync.includes('receiptRevision'), '同步脚本会写 receiptRevision');
truthy(sync.includes('_ns') && sync.includes('.json'), '同步脚本会更新清单快照');
// 生成的脚本里应当是字面量 \n（反斜杠 + n 两个字符），不是真换行。
// 用 fromCharCode 拼，避免多层转义数错。
const EXPECTED_NL_ESCAPE = "+ '" + String.fromCharCode(92) + "n'";
truthy(sync.includes(EXPECTED_NL_ESCAPE), '写 JSON 时补了结尾换行');
// 生成的脚本自身必须是合法 JS
try {
  new Function(sync.replace(/^\s*'use strict';/m, ''));
  ok('生成的同步脚本能被解析（语法合法）');
} catch (e) {
  bad('生成的同步脚本语法非法：' + e.message);
}

console.log('\n=== 第 5 组：两份 update.cjs 必须一致 ===');

// 两个仓库的这份文件应当逐字相同（跟 adapters.cjs 同一个约定）
const mine = readFileSync(join(__dirname, '..', 'plugin', 'node', 'update.cjs'), 'utf8');
if (process.env.UPDATE_TWIN) {
  const twin = readFileSync(process.env.UPDATE_TWIN, 'utf8');
  eq(mine === twin, true, '与另一个仓库的 update.cjs 逐字相同');
} else {
  skip('未设置 UPDATE_TWIN，跳过双仓库一致性断言');
}

console.log(`\n结果：${pass} 通过，${fail} 失败${skips.length ? `，${skips.length} 跳过` : ''}`);
for (const s of skips) console.log('  跳过：' + s);
process.exit(fail === 0 ? 0 : 1);
