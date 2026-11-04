#!/usr/bin/env node
// 双仓库共享文件的漂移检查。
//
// 两个桥共享同一套 CI 骨架与两个核心文件。它们分别住在两个仓库里，
// 没有 submodule、没有额外仓库 —— 只是逐字相同的副本。
// 这个脚本证明副本还是一样的；不一样就失败，并指出到底哪几行不同。
//
// adapters.cjs 例外：它允许注释不同（约定好的），所以只比较去掉注释后的代码。
//
// 用法：
//   node .github/scripts/shared-check.cjs                     # 同级目录自动找另一个仓库
//   node .github/scripts/shared-check.cjs --twin <仓库根目录>
//
// 找不到另一个仓库时只打警告、不失败 —— 单独 clone 时不该红。
//
// --soft（或环境变量 DRIFT_SOFT=1）用于 push 到 main 的场景：
// 两个仓库是「依次合并」的，先合并的那个仓库在另一个仓库跟上之前，副本必然不一致。
// 那段窗口是预期的，不该把 main 判红并一直挂着（另一仓合并后本仓没有 push，不会自动重跑）。
// 所以 main 上只报告、不失败；PR 上仍然严格失败，因为那正是「改一处忘了改另一处」的拦截点。
'use strict';

const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');

const ROOT = resolve(__dirname, '..', '..');

// 必须逐字相同的文件。
const SHARED_EXACT = [
  '.github/scripts/ci-run.cjs',
  '.github/scripts/check-version.cjs',
  '.github/scripts/verify-package.cjs',
  '.github/scripts/release-notes.cjs',
  '.github/scripts/package-name.cjs',
  '.github/scripts/release-plan.cjs',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'plugin/node/update.cjs',
];

// 只要求「去掉注释与空行后」相同的文件。
const SHARED_CODE = ['plugin/node/adapters.cjs'];

function findTwin() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--twin');
  if (i >= 0 && args[i + 1]) return resolve(args[i + 1]);

  const parent = dirname(ROOT);
  let entries = [];
  try { entries = readdirSync(parent, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = join(parent, e.name);
    if (cand === ROOT) continue;
    if (existsSync(join(cand, 'plugin', 'ghost.json'))) return cand;
  }
  return undefined;
}

function stripComments(src) {
  return src.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'))
    .join('\n');
}

function firstDiffs(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      out.push('第 ' + (i + 1) + ' 行：本仓库 ' + JSON.stringify(la[i]) + ' != 对方 ' + JSON.stringify(lb[i]));
    }
    if (out.length >= 5) { out.push('……（还有更多差异）'); break; }
  }
  return out;
}

const soft = process.argv.includes('--soft') || process.env.DRIFT_SOFT === '1';

const twin = findTwin();
if (!twin) {
  console.log('::warning::找不到同级仓库，跳过共享文件漂移检查（可用 --twin 指定路径）');
  process.exit(0);
}

const ghost = JSON.parse(readFileSync(join(ROOT, 'plugin', 'ghost.json'), 'utf8'));
const twinGhost = JSON.parse(readFileSync(join(twin, 'plugin', 'ghost.json'), 'utf8'));
if (twinGhost.id === ghost.id) {
  console.error('::error::--twin 指向的是本插件自己（' + ghost.id + '），请指向另一个仓库');
  process.exit(2);
}

console.log('本仓库：' + ghost.id + '    对比对象：' + twinGhost.id + '（' + twin + '）');

const problems = [];
let same = 0;
let skipped = 0;

for (const rel of SHARED_EXACT) {
  const a = join(ROOT, rel);
  const b = join(twin, rel);
  if (!existsSync(b)) { skipped++; console.log('  跳过  ' + rel + '（另一个仓库还没有这个文件）'); continue; }
  const sa = readFileSync(a, 'utf8');
  const sb = readFileSync(b, 'utf8');
  if (sa === sb) { same++; console.log('  一致  ' + rel); continue; }
  problems.push(rel + '：内容不同\n      ' + firstDiffs(sa, sb).join('\n      '));
}

for (const rel of SHARED_CODE) {
  const a = join(ROOT, rel);
  const b = join(twin, rel);
  if (!existsSync(b)) { skipped++; console.log('  跳过  ' + rel + '（另一个仓库还没有这个文件）'); continue; }
  if (stripComments(readFileSync(a, 'utf8')) === stripComments(readFileSync(b, 'utf8'))) {
    same++; console.log('  一致  ' + rel + '（忽略注释）');
    continue;
  }
  problems.push(rel + '：去掉注释后的代码不同');
}

if (problems.length) {
  const note = soft
    ? '::warning::共享文件漂移（main 分支仅提示，不判红） - '
    : '::error::共享文件漂移 - ';
  for (const p of problems) console.error(note + p);
  if (soft) {
    console.error('这些文件必须在两个仓库里保持同构：改一处就得改两处。');
    console.error('当前在 main 上，只做提示：两个仓库可能是依次合并的，等另一仓跟上后即可恢复一致。');
    process.exit(0);
  }
  console.error('这些文件必须在两个仓库里保持同构：改一处就得改两处。');
  process.exit(1);
}

console.log('共享文件检查通过：' + same + ' 个一致' + (skipped ? '，' + skipped + ' 个跳过（对方还没有）' : ''));
