#!/usr/bin/env node
// 从 CHANGELOG.md 抽当前版本的正文，生成 Release 说明。
//
// 不做自动总结、不调任何 AI —— 说明文字就是维护者写进 CHANGELOG 的那一段，
// 只补上安装方式与版本信息。这样发布说明与仓库里的记录永远一致。
//
// 用法：node .github/scripts/release-notes.cjs --version 0.1.20 --output release-notes.md
'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const version = arg('--version');
const output = arg('--output');
if (!version || !output) {
  console.error('用法：node .github/scripts/release-notes.cjs --version x.y.z --output file.md');
  process.exit(2);
}

const ghost = JSON.parse(readFileSync(join(ROOT, 'plugin', 'ghost.json'), 'utf8'));
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'));

if (ghost.version !== version) {
  console.error('::error::--version ' + version + ' 与 ghost.json 的 ' + ghost.version + ' 不一致');
  process.exit(1);
}

// 抓 ## <version> 到下一个 ## 之间的正文。
const escaped = version.replace(/\./g, '\\.');
const re = new RegExp('^## ' + escaped + '\\s*$', 'm');
const m = re.exec(changelog);
if (!m) {
  console.error('::error::CHANGELOG.md 里找不到 ## ' + version + ' 小节');
  process.exit(1);
}
const start = m.index + m[0].length;
const rest = changelog.slice(start);
const next = /^## /m.exec(rest);
let body = (next ? rest.slice(0, next.index) : rest).trim().replace(/\\n?-{3,}\\s*$/, '').trim();

// 去掉正文开头的日期标题行（形如 **2026-11-04** · 标题），标题留着自用。
let title = '';
const headLines = body.split('\n').slice(0, 3).join('\n');
const titleMatch = /^\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[·:]\s*(.+)$/m.exec(headLines);
if (titleMatch) {
  title = titleMatch[2].trim();
  body = body.replace(titleMatch[0], '').trim();
}

const pkgName = pkg.name + '.cindy';
const repo = arg('--repo') || process.env.GITHUB_REPOSITORY || (ghost.author || 'linvisxie') + '/' + pkg.name;
const lines = [];
lines.push(body);
lines.push('');
lines.push('---');
lines.push('');
lines.push('### 安装');
lines.push('');
lines.push('下载下方 ' + pkgName + '，在 Cindy 里安装这个包；也可以从插件面板的「检查更新」直接升级。');
lines.push('');
lines.push('### 版本信息');
lines.push('');
lines.push('| 项目 | 值 |');
lines.push('| --- | --- |');
lines.push('| 版本 | ' + version + ' |');
lines.push('| 插件 ID | ' + ghost.id + ' |');
lines.push('| 最低 Cindy 版本 | ' + (ghost.minCindyVersion || '未声明') + ' |');
lines.push('| Node 要求 | ' + ((pkg.engines && pkg.engines.node) || '未声明') + ' |');
lines.push('| 平台 | ' + (Array.isArray(pkg.os) ? pkg.os.join(', ') : '未声明') + ' |');
lines.push('');
lines.push('### 校验');
lines.push('');
lines.push('下载后可用 SHA256SUMS.txt 核对包完整性：');
lines.push('');
lines.push('```');
lines.push('Get-FileHash .\\' + pkgName + ' -Algorithm SHA256');
lines.push('```');
lines.push('');
lines.push('完整改动见 [CHANGELOG.md](https://github.com/' + repo + '/blob/main/CHANGELOG.md)。');

writeFileSync(output, lines.join('\n') + '\n', 'utf8');
console.log('已生成 ' + output + (title ? '（' + title + '）' : ''));
