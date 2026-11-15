'use strict';
// Plugin-owned journal only. The caller already owns DATA_DIR; no installer/lock/timer lives here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { compareVersion } = require('./update.cjs');
const childProcess = require('node:child_process');

function version(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value)
    && value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}
function absolutePath(value) {
  return typeof value === 'string' && !/["\0\r\n]/.test(value)
    && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value));
}
function packagePathOK(value) {
  return absolutePath(value) && /\.cindy$/i.test(value);
}
function hashOK(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }
function validate(record) {
  if (!record || record.schemaVersion !== 1
      || !['preparing', 'awaiting_confirmation', 'open_failed', 'completed'].includes(record.state)
      || !version(record.targetVersion) || !version(record.fromVersion)
      || !packagePathOK(record.packagePath) || !hashOK(record.sha256)
      || (record.error !== undefined && typeof record.error !== 'string')) {
    throw new Error('更新记录格式无效');
  }
  return record;
}
function writeStatus(dataDir, details) {
  const record = validate({ schemaVersion: 1, state: details.state,
    targetVersion: details.targetVersion, fromVersion: details.fromVersion,
    packagePath: details.packagePath, sha256: details.sha256,
    ...(details.error === undefined ? {} : { error: details.error }) });
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'native-update.json');
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  return record;
}
function readStatus(dataDir, runningVersion) {
  try {
    const record = validate(JSON.parse(fs.readFileSync(path.join(dataDir, 'native-update.json'), 'utf8')));
    if (!version(runningVersion)) throw new Error('当前运行版本无效');
    if (compareVersion(runningVersion, record.targetVersion) >= 0) {
      return { ...record, state: 'completed', message: `安装完成，当前运行版本 ${runningVersion}。` };
    }
    const messages = {
      preparing: '正在下载并准备更新包，尚未安装。',
      awaiting_confirmation: '已打开Cindy原生安装确认，尚未安装，确认后自动完成；取消可重试。',
      open_failed: '打开Cindy原生安装确认失败，尚未安装，请重试。',
      completed: '当前运行版本尚未达到目标版本，尚未确认安装完成；请确认原生安装，取消可重试。',
    };
    return { ...record, state: record.state === 'completed' ? 'awaiting_confirmation' : record.state,
      message: messages[record.state] + (record.error ? ` 原因：${record.error}` : '') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { state: 'unknown', message: '更新状态未知，尚未确认安装完成，请重新检查或重试。', error: error.message };
  }
}

// Public Windows file-open contract: the SAME Cindy.exe receives exactly one .cindy argument.
// Paths are data in the environment, never interpolated into PowerShell source.
const OPEN_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  Start-Process -FilePath $env:CINDY_NATIVE_UPDATE_HOST -ArgumentList ('"' + $env:CINDY_NATIVE_UPDATE_PACKAGE + '"') -ErrorAction Stop | Out-Null`,
  '  exit 0',
  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
].join('\r\n');

async function launchImport({ packagePath, sha256, hostExe = process.execPath, execFile = childProcess.execFile }) {
  if (process.platform !== 'win32') throw new Error('原生更新确认仅支持 Windows。');
  if (!packagePathOK(packagePath)) throw new Error('更新包必须是安全的 .cindy 绝对路径（不含双引号、NUL 或换行）。');
  if (!hashOK(sha256)) throw new Error('更新包 sha256 必须为 64 位十六进制。');
  if (!absolutePath(hostExe) || path.win32.basename(hostExe).toLowerCase() !== 'cindy.exe') {
    throw new Error('必须使用实际的 Cindy.exe 打开更新包，不能使用 node 或 electron。');
  }
  let bytes;
  try { bytes = await fs.promises.readFile(packagePath); }
  catch (error) { throw new Error(`无法读取更新包，尚未打开安装确认：${error.message}`); }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256.toLowerCase()) {
    throw new Error('更新包 sha256 不匹配，已停止，尚未打开安装确认。');
  }
  try {
    if (!(await fs.promises.stat(hostExe)).isFile()) throw new Error('不是可执行文件');
  } catch (error) { throw new Error(`实际 Cindy.exe 不可用：${error.message}`); }
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  env.CINDY_NATIVE_UPDATE_HOST = hostExe;
  env.CINDY_NATIVE_UPDATE_PACKAGE = packagePath;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(OPEN_COMMAND, 'utf16le').toString('base64')];
  return new Promise((resolve, reject) => {
    const done = (error) => {
      if (!error) { resolve({ installRequested: true }); return; }
      const reason = error.killed || error.code === 'ETIMEDOUT' ? '启动超时'
        : error.code === 'ENOENT' ? '找不到 PowerShell 启动程序'
          : `启动失败（${error.code || error.message || '未知错误'}）`;
      reject(new Error(`无法打开Cindy原生安装确认：${reason}；尚未安装，请重试。`));
    };
    try { execFile('powershell.exe', args, { env, windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 }, done); }
    catch (error) { done(error); }
  });
}

module.exports = { writeStatus, readStatus, launchImport };
