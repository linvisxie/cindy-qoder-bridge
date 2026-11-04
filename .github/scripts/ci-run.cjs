#!/usr/bin/env node
// CI 测试编排器：按 test/ci-config.json 的分类逐个跑 test/*.js，汇总结果，
// 写 JUnit 报告与 GitHub Step Summary。
//
// 这份文件在两个仓库里逐字相同，由 shared-check.cjs 对比另一仓库的副本。
// 只放「怎么跑」和「怎么报」，测试本身不在 CI 里重写。
//
// 三条硬规矩：
// 1. 不伪装：需要真实登录态的脚本只列进 live，CI 报「未运行」，不报「通过」。
// 2. 不吞日志：每个脚本的完整输出都落到 artifacts/ci-logs/，同时回显在步骤日志里。
// 3. 不只看退出码：脚本自己打了失败项却 exit 0，同样判失败。
'use strict';

const { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = resolve(__dirname, '..', '..');
const ARTIFACTS = join(ROOT, 'artifacts');
const LOGS = join(ARTIFACTS, 'ci-logs');

function fail(message) {
  console.error('错误：' + message);
  process.exit(2);
}

const configPath = join(ROOT, 'test', 'ci-config.json');
if (!existsSync(configPath)) fail('缺少 test/ci-config.json');
const CONFIG = JSON.parse(readFileSync(configPath, 'utf8'));

let mode = 'offline';
let only = '';
let group = '';
let list = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--mode') mode = process.argv[++i];
  else if (a === '--only') only = process.argv[++i];
  else if (a === '--group') group = process.argv[++i];
  else if (a === '--list') list = true;
  else fail('不认识的参数 ' + a);
}
if (mode !== 'offline' && mode !== 'live') fail('--mode 只能是 offline 或 live');

const entries = CONFIG[mode];
if (!Array.isArray(entries)) fail('test/ci-config.json 里没有 ' + mode + ' 数组');

// 分类完整性：新增测试必须显式归到 offline 或 live，不能悄悄漏跑。
const discovered = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .map((f) => f.slice(0, -3))
  .sort();
const classified = new Set([...CONFIG.offline, ...CONFIG.live].map((e) => e.script));
const unclassified = discovered.filter((s) => !classified.has(s));
const missing = [...classified].filter((s) => !discovered.includes(s));
if (unclassified.length || missing.length) {
  fail('测试分类与 test/ 目录不一致。未分类：' + (unclassified.join(', ') || '无')
    + '；不存在的分类项：' + (missing.join(', ') || '无')
    + '。请在 test/ci-config.json 的 offline 或 live 里登记。');
}

if (list) {
  const include = entries.map((e) => ({ script: e.script, group: e.group || 'default', timeout: e.timeout || 180 }));
  process.stdout.write('matrix=' + JSON.stringify({ include }) + '\n');
  process.exit(0);
}

let selected = entries;
if (group) selected = selected.filter((e) => e.group === group);
if (only) selected = selected.filter((e) => e.script === only);
if (!selected.length) fail('没有匹配的测试：' + (only || group));

function parseCounts(text) {
  const found = { passed: null, failed: null, total: null, skipped: null };

  const assign = (passed, failed, total, skipped) => {
    found.passed = passed; found.failed = failed; found.total = total;
    if (skipped !== null && skipped !== undefined) found.skipped = skipped;
  };

  for (const m of text.matchAll(/结果[：:]\s*(\d+)\s*通过[，,]\s*(\d+)\s*失败(?:[，,]\s*(\d+)\s*跳过)?/g)) {
    assign(+m[1], +m[2], +m[1] + +m[2] + (m[3] ? +m[3] : 0), m[3] ? +m[3] : null);
  }
  for (const m of text.matchAll(/^\s*(\d+)\s*通过\s+(\d+)\s*失败\s*$/gm)) {
    assign(+m[1], +m[2], +m[1] + +m[2], null);
  }
  for (const m of text.matchAll(/^\s*(\d+)\/(\d+)\s*通过\s*$/gm)) {
    assign(+m[1], +m[2] - +m[1], +m[2], null);
  }

  const pass = text.match(/^\u2139 pass (\d+)$/m);
  const failCount = text.match(/^\u2139 fail (\d+)$/m);
  if (pass && failCount) {
    const tests = text.match(/^\u2139 tests (\d+)$/m);
    const skipped = text.match(/^\u2139 skipped (\d+)$/m);
    assign(+pass[1], +failCount[1], tests ? +tests[1] : +pass[1] + +failCount[1],
      skipped ? +skipped[1] : null);
  }

  return found;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Windows 上只杀父进程会留下占着端口的 worker，必须整棵树杀。
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

function runOne(entry) {
  const started = Date.now();
  const scriptPath = join(ROOT, 'test', entry.script + '.js');
  const timeoutMs = (entry.timeout || 180) * 1000;

  return new Promise((resolveRun) => {
    const chunks = [];
    let timedOut = false;

    console.log('');
    console.log('::group::' + entry.script + '  (node test/' + entry.script + '.js)');

    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const onData = (buf) => {
      chunks.push(buf);
      process.stdout.write(buf);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      console.log('');
      console.log('::endgroup::');

      const output = Buffer.concat(chunks).toString('utf8');
      const counts = parseCounts(output);
      const durationMs = Date.now() - started;

      let status = 'passed';
      let reason = '';
      if (timedOut) {
        status = 'failed';
        reason = '超时（' + (timeoutMs / 1000) + ' 秒）后被强制结束';
      } else if (code !== 0) {
        status = 'failed';
        reason = '退出码 ' + code + (signal ? '（信号 ' + signal + '）' : '');
      } else if (counts.failed !== null && counts.failed > 0) {
        status = 'failed';
        reason = '脚本报告 ' + counts.failed + ' 项失败，但退出码是 0（脚本自身的缺陷，需要修）';
      }

      mkdirSync(LOGS, { recursive: true });
      writeFileSync(join(LOGS, entry.script + '.log'), output, 'utf8');

      resolveRun({
        name: entry.script,
        status,
        reason,
        exitCode: code,
        timedOut,
        durationMs,
        ...counts,
        log: 'artifacts/ci-logs/' + entry.script + '.log',
      });
    });
  });
}

function writeJUnit(results, modeName) {
  const totalTests = results.reduce((n, r) => n + (r.total === null ? 1 : r.total), 0);
  const totalFailures = results.reduce((n, r) => n + (r.failed === null ? (r.status === 'failed' ? 1 : 0) : r.failed), 0);
  const totalTime = results.reduce((n, r) => n + r.durationMs, 0) / 1000;

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push('<testsuites name="' + escapeXml(modeName) + '" tests="' + totalTests
    + '" failures="' + totalFailures + '" time="' + totalTime.toFixed(3) + '">');

  for (const r of results) {
    const tests = r.total === null ? 1 : r.total;
    const failures = r.failed === null ? (r.status === 'failed' ? 1 : 0) : r.failed;
    lines.push('  <testsuite name="' + escapeXml(r.name) + '" tests="' + tests
      + '" failures="' + failures + '" time="' + (r.durationMs / 1000).toFixed(3) + '">');
    lines.push('    <testcase name="' + escapeXml(r.name) + '" classname="test.'
      + escapeXml(r.name) + '" time="' + (r.durationMs / 1000).toFixed(3) + '">');
    if (r.status === 'failed') {
      lines.push('      <failure message="' + escapeXml(r.reason || '失败') + '">'
        + escapeXml('详见 artifacts/ci-logs/' + r.name + '.log') + '</failure>');
    }
    lines.push('    </testcase>');
    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, 'junit-' + modeName + '.xml'), lines.join('\n') + '\n', 'utf8');
}

function writeSummary(results, notRun, modeName) {
  const lines = [];
  lines.push('### ' + (modeName === 'offline' ? '离线测试' : '联网测试') + '结果');
  lines.push('');
  lines.push('| 脚本 | 结果 | 通过 | 失败 | 跳过 | 耗时 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const status = r.status === 'passed' ? '通过' : '失败';
    lines.push('| ' + r.name + ' | ' + status + ' | '
      + (r.passed === null ? '-' : r.passed) + ' | '
      + (r.failed === null ? '-' : r.failed) + ' | '
      + (r.skipped === null ? '-' : r.skipped) + ' | '
      + (r.durationMs / 1000).toFixed(1) + 's |');
  }
  if (notRun.length) {
    lines.push('');
    lines.push('### 未在 CI 运行的测试');
    lines.push('');
    lines.push('这些脚本需要真实的 Qoder/Trae CN 登录态与真实上游，托管 Runner 上无法运行。**它们没有被标记为通过，只是没有跑。**');
    lines.push('');
    lines.push('| 脚本 | 原因 |');
    lines.push('| --- | --- |');
    for (const n of notRun) lines.push('| ' + n.script + ' | ' + (n.why || '需要真实登录态') + ' |');
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, 'summary-' + modeName + '.md'), lines.join('\n') + '\n', 'utf8');
  if (summaryPath) writeFileSync(summaryPath, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'a' });
}

(async () => {
  if (mode === 'live') {
    console.log('::warning::live 组需要本机已登录 Qoder/Trae CN 与真实上游，只在开发机手动跑，不要放进托管 Runner。');
  }

  const results = [];
  for (const entry of selected) {
    results.push(await runOne(entry));
  }

  const notRun = mode === 'offline'
    ? CONFIG.live.map((e) => ({ script: e.script, why: e.why }))
    : [];

  writeJUnit(results, mode);
  writeSummary(results, notRun, mode);

  mkdirSync(ARTIFACTS, { recursive: true });
  const ok = results.every((r) => r.status === 'passed');
  writeFileSync(join(ARTIFACTS, 'ci-results-' + mode + '.json'), JSON.stringify({
    mode, ok, generatedAt: new Date().toISOString(), tests: results, notRun,
  }, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('===== ' + mode + ' 汇总 =====');
  for (const r of results) {
    console.log((r.status === 'passed' ? '  通过  ' : '  失败  ') + r.name
      + '  ' + (r.durationMs / 1000).toFixed(1) + 's'
      + (r.passed === null ? '' : '  (' + r.passed + ' 通过'
        + (r.failed ? ' / ' + r.failed + ' 失败' : '') + ')')
      + (r.reason ? '  <- ' + r.reason : ''));
  }
  console.log('  共 ' + results.length + ' 个脚本，失败 ' + results.filter((r) => r.status !== 'passed').length + ' 个');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('编排器异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
