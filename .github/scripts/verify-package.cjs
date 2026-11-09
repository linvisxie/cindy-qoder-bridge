#!/usr/bin/env node
// 发布前产物校验：证明这个 .cindy 能装、装的是这个提交、且没夹带私货。
//
// 只读 + 只写 artifacts/ 下的报告，不碰构建产物本身。
// 用法：node .github/scripts/verify-package.cjs --package dist/xxx.cindy [--expect-version 0.1.19]
'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = resolve(__dirname, '..', '..');
const ARTIFACTS = join(ROOT, 'artifacts');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const pkgPath = arg('--package');
const expectVersion = arg('--expect-version');
if (!pkgPath) {
  console.error('用法：node .github/scripts/verify-package.cjs --package <file.cindy> [--expect-version x.y.z]');
  process.exit(2);
}
if (!existsSync(pkgPath)) {
  console.error('找不到产物：' + pkgPath);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'ghost.json'), 'utf8'));
const pkgJson = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'));

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && !cond ? '  -> ' + detail : ''));
}

// ---- 1. 版本一致性：ghost.json / package.json / 标签 ----
console.log('版本一致性');
check('ghost.json 与 package.json 的版本一致', manifest.version === pkgJson.version,
  manifest.version + ' vs ' + pkgJson.version);
if (expectVersion) {
  check('清单版本等于期望版本', manifest.version === expectVersion,
    '清单 ' + manifest.version + '，期望 ' + expectVersion);
}

// ---- 2. 产物摘要与大小 ----
const buf = readFileSync(pkgPath);
const sha256 = createHash('sha256').update(buf).digest('hex');
console.log('\n产物');
console.log('  文件：' + basename(pkgPath));
console.log('  大小：' + buf.length + ' 字节');
console.log('  sha256：' + sha256);
check('产物非空', buf.length > 0, buf.length);

// ---- 3. 解包内容必须与打包清单完全一致 ----
const unzip = require(join(ROOT, 'test', '_unzip.cjs'));
console.log('\n包内容');
let entries;
try {
  entries = unzip.readZipEntries(buf);
  check('zip 结构可解析', true, entries.length + ' 个条目');
} catch (e) {
  check('zip 结构可解析', false, e.message);
  entries = [];
}

const names = entries.map((e) => e.name.replace(/\\/g, '/')).sort();

// 期望清单从仓库实际结构推导，不写死文件名：
//   - plugin/ 根下的所有文件（ghost.json / main.js / panel.html / panel.js ...）
//   - plugin/node/ 下所有 .cjs（两个仓库文件数不同：trae 多一个 trae.cjs）
//   - 许可证三件套（MIT 要求随包分发）
// plugin/ 下新增了要随包分发的文件却没进清单时，这里会报「缺文件」—— 那正是要提醒的事。
// package.json 不随包分发（它只服务于仓库里的 npm run），所以排除。
const referenced = new Set(['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']);
for (const f of readdirSync(join(ROOT, 'plugin'), { withFileTypes: true })) {
  if (!f.isFile()) continue;
  if (f.name === 'package.json') continue;
  referenced.add(f.name);
}
for (const f of readdirSync(join(ROOT, 'plugin', 'node'))) {
  if (f.endsWith('.cjs')) referenced.add('node/' + f);
}

const missing = [...referenced].filter((n) => !names.includes(n));
const extra = names.filter((n) => !referenced.has(n));
check('包内没有缺文件', missing.length === 0, missing.join(', '));
check('包内没有多余文件', extra.length === 0, extra.join(', '));

const ghostEntry = entries.find((e) => e.name.replace(/\\/g, '/') === 'ghost.json');
let packedManifest;
try {
  packedManifest = JSON.parse(ghostEntry.data.toString('utf8'));
  check('包内 ghost.json 是合法 JSON', true);
} catch (e) {
  check('包内 ghost.json 是合法 JSON', false, e.message);
  packedManifest = null;
}

if (packedManifest) {
  check('包内清单版本与仓库一致', packedManifest.version === manifest.version,
    packedManifest.version + ' vs ' + manifest.version);
  check('包内清单 id 与仓库一致', packedManifest.id === manifest.id,
    packedManifest.id + ' vs ' + manifest.id);
  check('包内清单声明了 minCindyVersion', typeof packedManifest.minCindyVersion === 'string',
    packedManifest.minCindyVersion);
}

// ---- 4. 源码与包内容逐字一致：证明包就是这个提交打的 ----
// 比对对象是 git 里的 blob，不是工作区文件。
// 差别很实在：工作区可能被编辑器存成 CRLF，产物就会比提交内容多几个字节；
// 只对工作区会让这种包「验过」，可它在别的机器上重打不出来。
console.log('\n源码一致性');

const { spawnSync } = require('node:child_process');
function gitBlob(rel) {
  const r = spawnSync('git', ['cat-file', 'blob', 'HEAD:' + rel], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) return undefined;
  return r.stdout;
}
const hasGit = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, windowsHide: true }).status === 0;
if (!hasGit) {
  console.log('  --   当前目录不是 git 仓库，退化为比对工作区文件');
}
const packagedByRepoPath = {
  'ghost.json': 'plugin/ghost.json',
  'main.js': 'plugin/main.js',
  'panel.html': 'plugin/panel.html',
  'panel.js': 'plugin/panel.js',
  'node/bootstrap.cjs': 'plugin/node/bootstrap.cjs',
  'node/worker.cjs': 'plugin/node/worker.cjs',
  'node/adapters.cjs': 'plugin/node/adapters.cjs',
  'node/update.cjs': 'plugin/node/update.cjs',
  'node/ownership.cjs': 'plugin/node/ownership.cjs',
  'node/download.cjs': 'plugin/node/download.cjs',
  'node/update-status.cjs': 'plugin/node/update-status.cjs',
  'node/trae.cjs': 'plugin/node/trae.cjs',
  'LICENSE': 'LICENSE',
  'NOTICE': 'NOTICE',
  'THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md',
};
if (manifest.node && manifest.node.entry) {
  packagedByRepoPath[manifest.node.entry] = 'plugin/' + manifest.node.entry;
}

let drift = [];
for (const e of entries) {
  const rel = e.name.replace(/\\/g, '/');
  const repoRel = packagedByRepoPath[rel];
  if (!repoRel) { drift.push(rel + '（没有源码映射）'); continue; }
  const source = hasGit ? gitBlob(repoRel) : readFileSync(join(ROOT, repoRel));
  if (!source) { drift.push(rel + '（不在 HEAD 里）'); continue; }
  if (!source.equals(e.data)) {
    const hint = source.length !== e.data.length
      ? '（字节数 ' + e.data.length + ' vs ' + source.length + '，常见原因是工作区被存成了 CRLF）'
      : '（内容不同）';
    drift.push(rel + hint);
  }
}
check('包内每个文件都与 HEAD 里的内容逐字一致', drift.length === 0, drift.join('; '));

// ---- 5. 不许夹带凭证与开发机私有文件 ----
console.log('\n干净度');
const secretPatterns = [
  { name: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub 细粒度 Token', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS 访问键', re: /AKIA[0-9A-Z]{16}/ },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '本机用户目录路径', re: /[A-Za-z]:\\\\Users\\\\[A-Za-z0-9._-]+/ },
  { name: '硬编码 Bearer 长串', re: /Bearer\s+[A-Za-z0-9_\-]{40,}/ },
];
const secretHits = [];
for (const e of entries) {
  const text = e.data.toString('utf8');
  for (const p of secretPatterns) {
    if (p.re.test(text)) secretHits.push(e.name + ' -> ' + p.name);
  }
}
check('包内没有凭证样式的字符串', secretHits.length === 0, secretHits.join('; '));
check('包内没有 node_modules', names.every((n) => !n.startsWith('node_modules/')), names.join(', '));

// ---- 6. 可安装性：包内 worker 能起、能答 healthz ----
// 这一步只证明"能启动"，不证明"能登录"，所以不需要任何账号。
console.log('\n可安装性（不带登录态）');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');

const work = mkdtempSync(join(os.tmpdir(), 'verify-pkg-'));
let child;
let bootOk = false;
let bootDetail = '';

(async () => {
  try {
    unzip.extractZip(pkgPath, work);
    const entry = manifest.node && manifest.node.entry ? manifest.node.entry : 'node/worker.cjs';
    const port = 47899;
    const dataDir = join(work, '_data');
    mkdirSync(dataDir, { recursive: true });

    child = spawn(process.execPath, [join(work, entry)], {
      cwd: work,
      env: {
        ...process.env,
        CINDY_QODER_DATA: dataDir,
        CINDY_QODER_PORT: String(port),
        CINDY_TRAE_DATA: dataDir,
        CINDY_TRAE_PORT: String(port),
        APPDATA: dataDir,
        LOCALAPPDATA: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const j = await res.json();
          bootOk = j && j.ok === true && typeof j.port === 'number';
          bootDetail = JSON.stringify(j);
          break;
        }
      } catch { /* 还没起来 */ }
    }
    if (!bootOk && !bootDetail) bootDetail = stderr.slice(-400) || '启动超时';
  } catch (e) {
    bootDetail = e.message;
  } finally {
    if (child) { try { child.kill(); } catch {} }
    check('包内 worker 能启动并回 /healthz', bootOk, bootDetail);
    try { rmSync(work, { recursive: true, force: true }); } catch {}

    const failed = checks.filter((c) => !c.ok);
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'package-verification.json'), JSON.stringify({
      package: basename(pkgPath),
      size: buf.length,
      sha256,
      version: manifest.version,
      id: manifest.id,
      files: names,
      checks,
      ok: failed.length === 0,
    }, null, 2) + '\n', 'utf8');
    writeFileSync(join(ARTIFACTS, 'SHA256SUMS.txt'), sha256 + '  ' + basename(pkgPath) + '\n', 'utf8');

    console.log('\n' + (failed.length === 0 ? '全部通过：' : '失败 ' + failed.length + ' 项：')
      + checks.length + ' 项检查');
    process.exit(failed.length === 0 ? 0 : 1);
  }
})();
