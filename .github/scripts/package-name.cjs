#!/usr/bin/env node
// 打印项目的分发产物名（package.json 的 name + .cindy）。
//
// 单独做成脚本，是为了让工作流不用在 PowerShell 双引号里写含 $ 的正则 ——
// 那会被 PowerShell 当变量展开，写完还看不出来。
//
// 用法：node .github/scripts/package-name.cjs
'use strict';

const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'));

if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  console.error('::error::plugin/package.json 缺少 name');
  process.exit(1);
}

process.stdout.write(pkg.name + '.cindy');
