'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const status = require('../plugin/node/update-status.cjs');
const dirs = [];
function fixture() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-journal-')); dirs.push(p); return p; }
test.after(() => { for (const p of dirs) fs.rmSync(p, { recursive: true, force: true }); });

test('missing update journal is a clean initial installation', () => {
  assert.equal(status.readLatest(fixture()), null);
  assert.equal(status.assertRecoverable(fixture()), null);
});
test('handoff is distinguishable from install success and carries a receipt warning', () => {
  const root = fixture(); const p = status.begin(root, 'attempt-abc', { version: '2.0.0' });
  status.writeResult(p, { status: 'handed_off', phase: 'waiting', hostReceipt: 'requires_host_install' });
  const record = status.readLatest(root);
  assert.equal(record.status, 'handed_off');
  assert.match(record.message, /等待最终结果/);
  assert.match(record.message, /原生导入/);
  assert.doesNotThrow(() => status.assertRecoverable(root));
});
for (const [state, phase] of [['in_progress', 'copying'], ['in_progress', 'rolling_back'], ['in_progress', 'invalid-phase'], ['rollback_failed', 'failed']]) {
  test(`startup refuses mixed code after ${state}/${phase}`, () => {
    const root = fixture(); const p = status.begin(root, 'attempt-abc');
    status.writeResult(p, { status: state, phase });
    assert.throws(() => status.assertRecoverable(root), /停止启动/);
  });
}
for (const state of ['success', 'not_started', 'rollback_succeeded']) {
  test(`startup accepts a settled ${state}`, () => {
    const root = fixture(); const p = status.begin(root, 'attempt-abc');
    status.writeResult(p, { status: state, phase: 'complete' });
    assert.equal(status.assertRecoverable(root).status, state);
  });
}
test('an invalid or unreadable journal cannot silently become success', () => {
  const root = fixture(); const p = status.begin(root, 'attempt-abc');
  fs.writeFileSync(path.join(p, 'result.json'), '{broken');
  assert.equal(status.readLatest(root).status, 'unknown');
  assert.throws(() => status.assertRecoverable(root), /停止启动/);
  fs.writeFileSync(path.join(root, 'latest-attempt.json'), JSON.stringify({ attempt: '../outside' }));
  assert.equal(status.readLatest(root).status, 'unknown');
});
test('journal read uses the open result, not a separate filesystem precheck', () => {
  const root = fixture(); status.begin(root, 'attempt-abc');
  const original = fs.statSync;
  fs.statSync = () => { throw new Error('unexpected TOCTOU precheck'); };
  try { assert.equal(status.readLatest(root).status, 'preparing'); }
  finally { fs.statSync = original; }
});
test('a pending handoff cannot be superseded by a new attempt', () => {
  const root = fixture(); const p = status.begin(root, 'attempt-abc');
  status.writeResult(p, { status: 'handed_off', phase: 'waiting' });
  const pointer = fs.readFileSync(path.join(root, 'latest-attempt.json'), 'utf8');
  assert.throws(() => status.begin(root, 'attempt-def'), /尚未确认/);
  assert.equal(fs.readFileSync(path.join(root, 'latest-attempt.json'), 'utf8'), pointer);
});
test('recovery journal is installation-scoped and outside rollback files', () => {
  const root = fixture(); const install = path.join(root, 'plugin');
  fs.mkdirSync(install);
  const dir = status.updateDirectory(install);
  assert.equal(path.dirname(dir), require('../plugin/node/ownership.cjs').canonicalDirectory(path.dirname(install)));
  assert.equal(dir.toLowerCase(), (fs.realpathSync.native(install) + '.updates').toLowerCase());
  assert.equal(status.updateDirectory(path.join(install, '.')), dir);
});
test('a new attempt cannot hide an unresolved destructive journal', () => {
  const root = fixture(); const p = status.begin(root, 'attempt-abc');
  status.writeResult(p, { status: 'in_progress', phase: 'copying' });
  const pointer = fs.readFileSync(path.join(root, 'latest-attempt.json'), 'utf8');
  assert.throws(() => status.begin(root, 'attempt-def'), /停止启动/);
  assert.equal(fs.readFileSync(path.join(root, 'latest-attempt.json'), 'utf8'), pointer);
  assert.equal(status.readLatest(root).phase, 'copying');
});
