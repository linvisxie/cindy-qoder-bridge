#!/usr/bin/env node
// 版本一致性检查：ghost.json / package.json / CHANGELOG / 传入的 tag 必须互相说得通。
//
// 这条检查放在 CI 的 static 阶段，也在 release 工作流里再跑一次 ——
// 免得「改了 ghost.json 忘了 package.json」这种低级错误混进正式版。
//
// 用法：
//   node .github/scripts/check-version.cjs                # 只查仓库内部一致性
//   node .github/scripts/check-version.cjs --tag v0.1.19  # 再校验 tag 与清单版本对应
'use strict';

const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..', '..');
const ghost = JSON.parse(readFileSync(join(ROOT, 'plugin', 'ghost.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'));
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;

const problems = [];
const notes = [];

function require_(cond, message) {
  if (!cond) problems.push(message);
}

// SemVer：接受 1.2.3，也接受带预发布的 1.2.3-beta.1。
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

require_(SEMVER.test(ghost.version), 'ghost.json 的 version 不是合法 SemVer：' + ghost.version);
require_(SEMVER.test(pkg.version), 'package.json 的 version 不是合法 SemVer：' + pkg.version);
require_(ghost.version === pkg.version,
  'ghost.json (' + ghost.version + ') 与 package.json (' + pkg.version + ') 版本不一致');

// CHANGELOG 必须有当前版本的独立小节。发布说明从那里来，不能凭空生成。
//
// 不用「把版本号拼进正则」的做法：版本号来自文件内容，拼进正则就要求调用方
// 正确转义反斜杠与其它元字符，漏一个就是一个 ReDoS / 误匹配的入口（CodeQL 会报）。
// 这里改成按行切分后精确比较，版本号只是字符串，不参与正则语法。
const changelogLines = changelog.split(/\r?\n/);
const headingIndex = changelogLines.findIndex((line) => line.trim() === '## ' + ghost.version);
require_(headingIndex >= 0, 'CHANGELOG.md 缺少 "## ' + ghost.version + '" 小节');

// 版本号只允许往上走：不许比最近发布的小。
// 这里不查 GitHub，只查 CHANGELOG 里出现过的最高版本，离线也能用。
const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
if (versions.length) {
  const numeric = (v) => v.split('-')[0].split('.').map(Number);
  const compare = (a, b) => {
    const [a1, a2, a3] = numeric(a); const [b1, b2, b3] = numeric(b);
    return a1 - b1 || a2 - b2 || a3 - b3;
  };
  const highest = versions.reduce((max, v) => (compare(v, max) > 0 ? v : max), versions[0]);
  require_(compare(highest, ghost.version) === 0,
    'CHANGELOG 里最高版本是 ' + highest + '，但清单写的是 ' + ghost.version
    + '（版本号只能往上走，且必须有自己的小节）');
  notes.push('CHANGELOG 里共 ' + versions.length + ' 个版本小节，当前 ' + ghost.version);
}

if (tag !== undefined) {
  require_(typeof tag === 'string' && tag.length > 0, '--tag 后面没有给值');
  if (tag) {
    require_(tag === 'v' + ghost.version,
      'tag (' + tag + ') 与清单版本不匹配，必须是 v' + ghost.version);
  }
}

// releaseNotes 为空会让安装页一片空白，也不该发布。
require_(typeof ghost.releaseNotes === 'string' && ghost.releaseNotes.trim().length > 0,
  'ghost.json 的 releaseNotes 为空');

for (const n of notes) console.log(n);

if (problems.length) {
  for (const p of problems) console.error('::error::' + p);
  process.exit(1);
}

console.log('版本检查通过：' + ghost.version + (tag ? '（tag ' + tag + '）' : ''));
