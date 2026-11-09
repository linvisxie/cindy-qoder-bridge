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

// SHA256 必须存在，size 只能作为附加校验
const r3 = updater.verifyDigest(bytes, undefined, bytes.length);
eq(r3.ok, false, '无 digest 即使 size 一致也拒绝');

const r4 = updater.verifyDigest(bytes, undefined, bytes.length + 100);
eq(r4.ok, false, '无 digest 但 size 不符时拒绝');
truthy(/digest/.test(r4.reason || ''), '无 digest 时说明缺少必需的摘要');

const r5 = updater.verifyDigest(bytes, undefined, undefined);
eq(r5.ok, false, '两者都没有时拒绝（fail-closed，不零校验安装）');
truthy(/digest/.test(r5.reason || ''), '双缺失拒绝理由说明需要 digest');
eq(updater.verifyDigest(bytes, 'sha256:' + goodHex, bytes.length + 1).ok, false, 'SHA256 一致但 size 不符仍拒绝');
eq(updater.verifyDigest(bytes, 'sha256:ab', bytes.length).ok, false, 'SHA256 必须为 64 位');

// digest 给了但格式坏了也不能静默降级成只看大小
const r7 = updater.verifyDigest(bytes, 'sha256:ZZZ-not-hex!!', bytes.length);
eq(r7.ok, false, 'digest 格式非法时拒绝（不降级为 size 校验）');

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

// Host trust is never package-owned: reject a matching path segment at any depth/case.
const packageManifest = { id: 'test', schemaVersion: 3, version: '2.0.0', entry: 'main.js', node: { entry: 'node/worker.cjs' }, panel: { html: 'panel.html' } };
const packageEntries = [
  { name: 'ghost.json', data: Buffer.from(JSON.stringify(packageManifest)) },
  ...['main.js', 'panel.js', 'panel.html', 'node/worker.cjs'].map(name => ({ name, data: Buffer.from('safe') })),
];
const expectedPackage = { id: 'test', version: '2.0.0', currentVersion: '1.0.0' };
eq(updater.validatePackage(packageEntries, expectedPackage).id, 'test', '合法包仍可通过清单校验');
for (const name of ['.cindy-trust.json', '.CINDY-TRUST.JSON', 'node/.CiNdY-TrUsT.JsOn', 'nested/.cindy-trust.json/child']) {
  let rejected = false;
  try { updater.validatePackage([...packageEntries, { name, data: Buffer.from('hostile') }], expectedPackage); }
  catch (error) { rejected = /路径/.test(error.message); }
  truthy(rejected, `拒绝宿主信任路径段：${name}`);
}

console.log('\n=== 第 4 组：PowerShell 脚本生成 ===');

const sample = updater.buildApplyScript({
  root: "C:\\some dir\\qoder-bridge",
  stage: "C:\\some dir\\stage",
  backup: "C:\\some dir\\qoder-bridge.bak-0.1.15",
  pkg: "C:\\some dir\\pkg.cindy",
  syncScript: "C:\\some dir\\sync-snapshot.cjs",
  nodeExe: "C:\\Program Files\\nodejs\\node.exe",
  oldPid: 12345,
  latestPointer: 'C:\\some dir\\bridge.updates\\latest-attempt.json',
  installationPipe: '\\\\.\\pipe\\test-install',
  ownershipPipe: '\\\\.\\pipe\\test-data',
});

truthy(sample.includes("$ErrorActionPreference = 'Stop'"), '脚本设置了 ErrorActionPreference=Stop');
truthy(/while \(Get-Process -Id \$oldPid/.test(sample), '轮询旧进程直到退出');
truthy(sample.includes('$oldPid = 12345'), '脚本里 $oldPid 被赋成调用方的 pid');
truthy(sample.includes('$timer.ElapsedMilliseconds -ge 60000'), '等待有 60 秒超时兜底');
truthy(sample.indexOf('while (Get-Process') < sample.indexOf('Copy-Item -LiteralPath $root'), '等待退出后才备份');
truthy(sample.includes('Copy-Item -LiteralPath $root -Destination $backup -Recurse -Force'), '覆盖前会备份安装目录');
truthy(sample.includes('Copy-InstallFiles $stage $root') && sample.includes('Copy-Item -LiteralPath $_.FullName -Destination $destination -Force'), '按字面路径递归覆盖安装文件');
truthy(sample.includes("Where-Object { $_.Name -ine '.cindy-trust.json' }") && sample.includes('Remove-InstallFiles $root') && sample.includes('Copy-InstallFiles $backup $root'), '复制和回滚逐层跳过宿主信任文件（不区分大小写）');
truthy(!/\$sync|\$nodeExe|sync-snapshot|node\.exe|ghost-install-state/.test(sample), '兼容旧 opts 但不生成 Node 执行或宿主记录读写');
truthy(sample.includes("hostReceipt = 'requires_host_install'") && sample.includes('Use Cindy native import to confirm the host installation record'), '结果明确要求原生导入确认宿主安装记录');
truthy(sample.includes("if ($result.status -eq 'success')"), '只有成功才清理');
truthy(sample.includes('foreach ($path in @($stage, $pkg))'), '清理仅包含暂存目录和下载包，不含备份或旧 sync 路径');
truthy(sample.includes('Remove-Item -LiteralPath $PSCommandPath -Force'), '成功时删除安装脚本自身');
truthy(sample.includes("$result.phase = 'rolling_back'; Save-Result"), '回滚前持久化阶段');
truthy(sample.includes("$result.status = 'rollback_failed'; $result.rollbackError"), '回滚失败保留独立诊断');
const installAcquire = sample.indexOf('$installationLock = [BridgeInstallOwnership]::CreateNamedPipeW');
const dataAcquire = sample.indexOf('$lock = [BridgeInstallOwnership]::CreateNamedPipeW');
truthy(sample.indexOf('while (Get-Process') < installAcquire && installAcquire < dataAcquire && dataAcquire < sample.indexOf("$result.phase = 'backup'"), '旧进程完全退出后按 install → data 取得两锁，之后才能备份');
const fence = sample.indexOf('$latest = [IO.File]::ReadAllText($latestPointer)');
truthy(dataAcquire < fence && fence < sample.indexOf("$result.phase = 'backup'"), '持有双 pipe 后、备份前读取 latest attempt 指针');
truthy(sample.includes('[string]::IsNullOrWhiteSpace($latestPointer)') && sample.includes('latestPointer is required'), '生产双 pipe 必须提供 latestPointer');
truthy(sample.includes('$latest.attempt -isnot [string]') && sample.includes('[StringComparison]::Ordinal') && sample.includes('(Split-Path -Leaf $attempt)'), '指针必须是字符串并与 attempt 叶名精确匹配');
truthy(sample.includes('latest pointer missing or invalid; refusing installation'), '指针缺失或坏 JSON 时 fail closed');
truthy(sample.includes('if ($installationLock.IsInvalid)') && sample.includes('if ($lock.IsInvalid)'), '任一 pipe 不可用都拒绝安装');
truthy(sample.includes('if (!!$installationPipe -ne !!$ownershipPipe)') && sample.includes('if (!$installationPipe -and !$ownershipPipe)'), '只允许完整双 pipe 或纯旧文件锁，不能降级绕过');
truthy(sample.lastIndexOf('Save-Result') < sample.indexOf('$lock.Dispose()') && sample.indexOf('$lock.Dispose()') < sample.indexOf('$installationLock.Dispose()'), '持锁至结果写入和清理完成，finally 按 data → install 释放');

// 单引号转义：路径里带 ' 也不能让脚本被截断
const tricky = updater.buildApplyScript({
  root: "C:\\it's a dir\\bridge",
  stage: 's', backup: 'b', pkg: 'p', syncScript: 'y', nodeExe: 'n', oldPid: 1,
});
truthy(tricky.includes("'C:\\it''s a dir\\bridge'"), "路径里的单引号被正确转义成 ''");


console.log('\n=== 第 5 组：两份 update.cjs 必须一致 ===');

// 两个仓库的这份文件应当逐字相同（跟 adapters.cjs 同一个约定，见 HANDOFF 第 2 节）。
//
// 这里不靠人记得设环境变量 —— 默认就去同级目录里找另一个仓库的 update.cjs。
// 目录布局是 <父目录>\qoderbridge开源\ 与 <父目录>\traebridge\，所以从
// <仓库>/test/ 往上两层就是父目录，扫一遍它的子目录即可。
// UPDATE_TWIN 仍然可用，用于仓库不在同一父目录下的情况（比如单独 clone）。
const REPO_ROOT = join(__dirname, '..');
const mine = readFileSync(join(REPO_ROOT, 'plugin', 'node', 'update.cjs'), 'utf8');

function findTwin() {
  if (process.env.UPDATE_TWIN) return { path: process.env.UPDATE_TWIN, source: 'UPDATE_TWIN' };
  const parent = join(REPO_ROOT, '..');
  let entries = [];
  try { entries = require('node:fs').readdirSync(parent, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = join(parent, e.name, 'plugin', 'node', 'update.cjs');
    // 跳过自己（自己那份比上来必然相等，不属于「双仓库」校验）
    if (join(parent, e.name) === REPO_ROOT) continue;
    if (existsSync(cand)) return { path: cand, source: `同级仓库 ${e.name}` };
  }
  return undefined;
}

const twinFile = findTwin();
if (!twinFile) {
  skip('找不到同级仓库的 update.cjs（可设 UPDATE_TWIN 指定路径），跳过双仓库一致性断言');
} else {
  const twin = readFileSync(twinFile.path, 'utf8');
  if (mine === twin) {
    ok(`与另一个仓库的 update.cjs 逐字相同（${twinFile.source}）`);
  } else {
    // 不一致时给出具体差异行，光说「不一样」等于没说。
    const a = mine.split('\n');
    const b = twin.split('\n');
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) diffs.push(`第 ${i + 1} 行：本仓库 ${JSON.stringify(a[i])} ≠ 对方 ${JSON.stringify(b[i])}`);
      if (diffs.length >= 5) { diffs.push('……（还有更多差异）'); break; }
    }
    bad(`与另一个仓库的 update.cjs 不一致（${twinFile.source}）—— 两份必须逐字相同，改一处就得改两处`);
    for (const d of diffs) console.log('      ' + d);
  }
}

// adapters.cjs 允许 2 行注释差异（约定好的），所以只校验「除注释外是否同构」：
// 去掉空行和以 // 开头的行后比较，两边应当完全一致。这条能抳住「只改了一边」的失误。
const adaptersMine = readFileSync(join(REPO_ROOT, 'plugin', 'node', 'adapters.cjs'), 'utf8');
function stripComments(src) {
  return src.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'))
    .join('\n');
}
if (twinFile) {
  const adaptersTwinPath = join(require('node:path').dirname(twinFile.path), 'adapters.cjs');
  if (existsSync(adaptersTwinPath)) {
    const adaptersTwin = readFileSync(adaptersTwinPath, 'utf8');
    eq(stripComments(adaptersMine) === stripComments(adaptersTwin), true,
      'adapters.cjs 除注释外与另一仓库一致（只允许注释不同）');
  } else {
    skip('同级仓库没有 adapters.cjs，跳过适配层一致性断言');
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败${skips.length ? `，${skips.length} 跳过` : ''}`);
for (const s of skips) console.log('  跳过：' + s);
process.exit(fail === 0 ? 0 : 1);
