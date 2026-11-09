'use strict';
const fs = require('node:fs');
const { join } = require('node:path');
const { canonicalDirectory } = require('./ownership.cjs');

// Installation-scoped and outside the replaceable directory: changing DATA_DIR
// or rolling back runtime files must not hide an interrupted installation.
function updateDirectory(installDir) { return canonicalDirectory(installDir) + '.updates'; }

// This marker is plugin-owned. Never read-modify-write Cindy's installation receipts.
function writeResult(attemptDir, result) {
  fs.mkdirSync(attemptDir, { recursive: true });
  const file = join(attemptDir, 'result.json');
  const tmp = file + '.worker.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, ...result, updatedAt: new Date().toISOString() }, null, 2));
  try { fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

function readLatest(updateDir) {
  const pointer = join(updateDir, 'latest-attempt.json');
  try {
    let pointerText;
    try { pointerText = fs.readFileSync(pointer, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const id = JSON.parse(pointerText).attempt;
    if (typeof id !== 'string' || !/^attempt-[a-f0-9-]+$/.test(id)) throw new Error('Invalid update attempt');
    const resultPath = join(updateDir, id, 'result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (result.schemaVersion !== 1 || !['preparing', 'handed_off', 'in_progress', 'success',
      'rollback_succeeded', 'rollback_failed', 'not_started'].includes(result.status)) throw new Error('Invalid update result');
    const labels = {
      preparing: '更新包准备中', handed_off: '已交接安装器，等待最终结果',
      in_progress: '安装或回滚进行中；尚未确认完成', success: '运行文件更新成功',
      rollback_succeeded: '安装失败，已回滚旧文件', rollback_failed: '安装失败且回滚失败，请原生导入完整包恢复',
      not_started: '更新未开始或已停止，原安装目录未被覆盖',
    };
    const message = `${labels[result.status] || '更新状态未知'}。诊断：${resultPath}`
      + (result.hostReceipt === 'requires_host_install' ? '；Cindy 安装记录需原生导入完整包刷新。' : '');
    return { ...result, resultPath, message };
  } catch (error) {
    // An unreadable journal is not evidence of a successfully installed directory.
    return { status: 'unknown', phase: 'unreadable', resultPath: pointer,
      error: `更新结果无法读取：${error.message}` };
  }
}

function begin(updateDir, id, details = {}) {
  const previous = assertRecoverable(updateDir); // Never hide an unresolved destructive attempt.
  if (previous?.status === 'handed_off') {
    throw new Error('上次安装器已交接但尚未确认结果，不能创建新更新；请先检查安装日志。');
  }
  if (!/^attempt-[a-f0-9-]+$/.test(id)) throw new Error('Invalid update attempt');
  const attemptDir = join(updateDir, id);
  writeResult(attemptDir, { status: 'preparing', phase: 'download', ...details });
  const pointer = join(updateDir, 'latest-attempt.json');
  fs.writeFileSync(pointer + '.tmp', JSON.stringify({ attempt: id }));
  fs.renameSync(pointer + '.tmp', pointer);
  return attemptDir;
}

function assertRecoverable(updateDir) {
  const result = readLatest(updateDir);
  if (result && (result.status === 'unknown' || result.status === 'rollback_failed'
      || result.status === 'in_progress')) {
    throw new Error(`上次更新或回滚中断，已停止启动，避免运行新旧混合代码。请通过 Cindy 原生导入完整安装包恢复，确认导入成功后停用插件，将 ${join(updateDir, 'latest-attempt.json')} 重命名保留，再启用。诊断：${result.resultPath}`);
  }
  return result;
}
module.exports = { begin, writeResult, readLatest, assertRecoverable, updateDirectory };
