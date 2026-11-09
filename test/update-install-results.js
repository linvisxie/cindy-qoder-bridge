'use strict';
// Windows-only, real PowerShell + isolated temporary files; never touches an installed plugin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildApplyScript, psQuote, verifyDigest, sha256Hex } = require('../plugin/node/update.cjs');
const bytes = Buffer.from('verified');
for (const digest of [undefined, null, '', ' ', 'bad', 'sha256:ab', 'sha256:' + 'a'.repeat(65), 'sha256:' + 'z'.repeat(64), 'md5:' + 'a'.repeat(64)]) {
  assert.equal(verifyDigest(bytes, digest, bytes.length).ok, false, String(digest));
}
assert.equal(verifyDigest(bytes, 'SHA256:' + sha256Hex(bytes).toUpperCase(), bytes.length).ok, true);
assert.equal(verifyDigest(bytes, 'sha256:' + sha256Hex(bytes), bytes.length + 1).ok, false);
assert.equal(verifyDigest(bytes, 'sha256:' + 'a'.repeat(64), bytes.length).ok, false);
if (process.platform !== 'win32') {
  console.log('digest checks passed; Windows PowerShell integration skipped on non-Windows');
  process.exit(0);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-update-tests-'));
for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) {
  process.env[key] = path.join(temp, key);
  fs.mkdirSync(process.env[key]);
}
const { pipeName, acquireOwnership } = require('../plugin/node/ownership.cjs');
const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
function run(file) {
  return spawnSync('powershell.exe', [...psArgs, '-File', file], { encoding: 'utf8', timeout: 20000 });
}
function setup(name, oldPid) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  const opts = Object.fromEntries(['root', 'stage', 'backup', 'pkg', 'syncScript', 'attemptDir', 'ownershipPath'].map(k => [k, path.join(dir, k)]));
  Object.assign(opts, { nodeExe: process.execPath, oldPid, waitTimeoutMs: 200, pollIntervalMs: 20, latestPointer: path.join(dir, 'latest-attempt.json') });
  fs.writeFileSync(opts.latestPointer, JSON.stringify({ attempt: path.basename(opts.attemptDir) }));
  fs.mkdirSync(opts.root);
  fs.mkdirSync(opts.stage);
  fs.writeFileSync(path.join(opts.root, 'old.txt'), 'old');
  fs.writeFileSync(path.join(opts.stage, 'a.txt'), 'new');
  fs.writeFileSync(path.join(opts.stage, 'b.txt'), 'new-b');
  fs.writeFileSync(opts.pkg, 'package');
  const file = path.join(dir, 'apply.ps1');
  fs.writeFileSync(file, buildApplyScript(opts));
  return { opts, file, result: () => JSON.parse(fs.readFileSync(path.join(opts.attemptDir, 'result.json'), 'utf8')) };
}
const trustBytes = Buffer.from('\ufeff{ "host": "trusted", "keep": true }\r\n\t', 'utf8');
function seedTrust(t) {
  const relative = ['.cindy-trust.json', path.join('nested', '.CiNdY-TrUsT.JsOn')];
  for (const rel of relative) {
    for (const base of [t.opts.root, t.opts.stage]) fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(t.opts.root, rel), trustBytes);
    // Deliberately bypass validatePackage to exercise the installer's defense in depth.
    fs.writeFileSync(path.join(t.opts.stage, rel), 'malicious replacement');
  }
  return relative.map(rel => path.join(t.opts.root, rel));
}
function assertTrust(files) {
  for (const file of files) assert.deepEqual(fs.readFileSync(file), trustBytes, file);
}
function wrapper(t, locks) {
  const file = path.join(path.dirname(t.file), 'fault.ps1');
  fs.writeFileSync(file, `$ErrorActionPreference = 'Stop'\n` + locks.map(([p, share], i) => `$l${i} = [IO.File]::Open(${psQuote(p)}, 'Open', 'Read', '${share}')`).join('\n') + `\ntry { & ${psQuote(t.file)} } finally {\n` + locks.map((_, i) => `$l${i}.Dispose()`).join('\n') + '\n}');
  return file;
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for test installer');
}
(async () => {
  // Do not retain an exited child's PID: Windows can recycle it into a later
  // PowerShell process during this suite. Use an int32-valid absent sentinel,
  // verified before testing; production still waits on the real worker PID.
  const exitedPid = 2147483647;
  const absent = spawnSync('powershell.exe', [...psArgs, '-Command', `if (Get-Process -Id ${exitedPid} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`], { timeout: 10000 });
  assert.equal(absent.status, 0, 'test sentinel PID must be absent');
  const waiting = setup('worker-still-live', process.pid);
  assert.notEqual(run(waiting.file).status, 0);
  assert.equal(waiting.result().status, 'not_started');
  assert.match(waiting.result().error, /still running/);
  assert.equal(fs.existsSync(waiting.opts.backup), false);
  assert.equal(fs.readFileSync(path.join(waiting.opts.root, 'old.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(waiting.opts.stage), true);
  assert.equal(waiting.result().hostReceipt, 'requires_host_install');
  for (const p of [waiting.opts.pkg, waiting.file, path.join(waiting.opts.attemptDir, 'install.log')]) assert.ok(fs.existsSync(p), p);

  const rollback = setup('copy-failed', exitedPid);
  const rollbackTrust = seedTrust(rollback);
  // Read-only shared handles also detect deletion/rewrite of byte-identical backup trust.
  assert.notEqual(run(wrapper(rollback, [[path.join(rollback.opts.stage, 'b.txt'), 'None'], ...rollbackTrust.map(p => [p, 'Read'])])).status, 0);
  assert.equal(rollback.result().status, 'rollback_succeeded');
  assertTrust(rollbackTrust);
  assert.deepEqual(fs.readdirSync(rollback.opts.root).sort(), ['.cindy-trust.json', 'nested', 'old.txt']);
  assert.equal(fs.readFileSync(path.join(rollback.opts.root, 'old.txt'), 'utf8'), 'old');
  assert.equal(rollback.result().hostReceipt, 'requires_host_install');
  for (const p of [rollback.opts.stage, rollback.opts.backup, rollback.opts.pkg, rollback.file, path.join(rollback.opts.attemptDir, 'install.log')]) assert.ok(fs.existsSync(p), p);

  const broken = setup('rollback-failed', exitedPid);
  assert.notEqual(run(wrapper(broken, [[path.join(broken.opts.stage, 'b.txt'), 'None'], [path.join(broken.opts.root, 'old.txt'), 'Read']])).status, 0);
  assert.equal(broken.result().status, 'rollback_failed');
  assert.ok(broken.result().error);
  assert.ok(broken.result().rollbackError);
  for (const p of [broken.opts.stage, broken.opts.backup, broken.opts.pkg, path.join(broken.opts.attemptDir, 'install.log'), broken.file]) assert.ok(fs.existsSync(p), p);

  const success = setup('success', exitedPid);
  const successTrust = seedTrust(success);
  const syncMarker = path.join(path.dirname(success.file), 'sync-ran');
  // Legacy opts must be ignored even when they name a valid executable/script.
  fs.writeFileSync(success.opts.syncScript, `require('node:fs').writeFileSync(${JSON.stringify(syncMarker)}, 'unsafe'); process.exit(9);`);
  const ok = run(wrapper(success, successTrust.map(p => [p, 'Read'])));
  assert.equal(ok.status, 0, ok.stderr);
  assertTrust(successTrust);
  assert.equal(success.result().status, 'success');
  assert.equal(fs.readFileSync(path.join(success.opts.root, 'b.txt'), 'utf8'), 'new-b');
  assert.equal(success.result().hostReceipt, 'requires_host_install');
  assert.match(success.result().hostReceiptMessage, /Cindy native import to confirm the host installation record/);
  assert.equal(fs.existsSync(syncMarker), false);
  assert.equal(fs.existsSync(path.join(success.opts.attemptDir, 'sync.log')), false);
  assert.equal(fs.readFileSync(path.join(success.opts.backup, 'old.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(success.opts.syncScript), true, 'ignored legacy path is not deleted');
  for (const p of [success.opts.stage, success.opts.pkg, success.file]) assert.equal(fs.existsSync(p), false, p);

  // Interrupt only our test installer while waiting. The OS must release its lock,
  // but preserve the unfinished attempt for the next worker/status reader.
  const interrupted = setup('interrupted', process.pid);
  fs.writeFileSync(interrupted.file, buildApplyScript({ ...interrupted.opts, waitTimeoutMs: 15000 }));
  const installer = spawn('powershell.exe', [...psArgs, '-File', interrupted.file], { stdio: 'ignore' });
  try {
    await waitFor(() => fs.existsSync(interrupted.opts.ownershipPath));
    // A cooperative restarted worker/second installer cannot acquire the same lock.
    const contender = setup('restart-contender', exitedPid);
    fs.writeFileSync(contender.file, buildApplyScript({ ...contender.opts, ownershipPath: interrupted.opts.ownershipPath }));
    assert.notEqual(run(contender.file).status, 0);
    assert.equal(contender.result().status, 'not_started');
    assert.equal(fs.existsSync(contender.opts.backup), false);
  } finally {
    const stopped = new Promise(resolve => installer.once('exit', resolve));
    installer.kill();
    await stopped;
  }
  assert.equal(interrupted.result().phase, 'waiting');
  const restart = setup('restart-after-interruption', exitedPid);
  fs.writeFileSync(restart.file, buildApplyScript({ ...restart.opts, ownershipPath: interrupted.opts.ownershipPath, latestPointer: undefined }));
  const restarted = run(restart.file);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restart.result().status, 'success');
  // Same installation, different data: install ownership must protect every byte.
  const shared = setup('same-install-different-data', exitedPid);
  seedTrust(shared);
  const dataA = path.join(temp, 'data-a');
  const dataB = path.join(temp, 'data-b');
  const pipes = { installationPipe: pipeName(shared.opts.root, 'install'), ownershipPipe: pipeName(dataB, 'data') };
  fs.writeFileSync(shared.file, buildApplyScript({ ...shared.opts, ...pipes }));
  function snapshot(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      const file = path.join(directory, entry.name);
      return [entry.name, entry.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('hex')];
    });
  }
  // A late installer must not overwrite B, even after both ownership locks become free.
  const late = setup('late-installer', exitedPid);
  const lateTrust = seedTrust(late);
  late.opts.attemptDir = path.join(path.dirname(late.file), 'A');
  fs.mkdirSync(path.join(path.dirname(late.file), 'B'));
  const lateOpts = { ...late.opts, installationPipe: pipeName(late.opts.root, 'install'), ownershipPipe: pipeName(path.join(temp, 'late-data'), 'data') };
  const lateRoot = snapshot(late.opts.root);
  const lateStage = snapshot(late.opts.stage);
  for (const pointer of [JSON.stringify({ attempt: 'B' }), JSON.stringify({ attempt: 'a' }), JSON.stringify({ attempt: ['A'] }), '{broken', null, 'no-option']) {
    if (pointer === null) fs.rmSync(late.opts.latestPointer);
    else if (pointer !== 'no-option') fs.writeFileSync(late.opts.latestPointer, pointer);
    fs.writeFileSync(late.file, buildApplyScript({ ...lateOpts, latestPointer: pointer === 'no-option' ? undefined : late.opts.latestPointer }));
    assert.notEqual(run(late.file).status, 0);
    assert.equal(late.result().status, 'not_started');
    assert.match(late.result().error, /Stale installer/);
    assert.deepEqual(snapshot(late.opts.root), lateRoot);
    assert.deepEqual(snapshot(late.opts.stage), lateStage);
    assertTrust(lateTrust);
    assert.equal(fs.existsSync(late.opts.backup), false);
    for (const p of [late.opts.pkg, late.file, path.join(late.opts.attemptDir, 'result.json'), path.join(late.opts.attemptDir, 'install.log')]) assert.ok(fs.existsSync(p), p);
    for (const [directory, scope] of [[late.opts.root, 'install'], [path.join(temp, 'late-data'), 'data']]) {
      const probe = await acquireOwnership(directory, scope);
      await probe.release();
    }
  }
  fs.writeFileSync(late.opts.latestPointer, JSON.stringify({ attempt: 'A' }));
  fs.writeFileSync(late.file, buildApplyScript(lateOpts));
  const lateAllowed = run(late.file);
  assert.equal(lateAllowed.status, 0, lateAllowed.stderr);
  assert.equal(late.result().status, 'success');
  assertTrust(lateTrust);
  const original = snapshot(shared.opts.root);
  const installOwner = await acquireOwnership(shared.opts.root, 'install');
  const dataOwnerA = await acquireOwnership(dataA, 'data');
  try {
    assert.notEqual(run(shared.file).status, 0);
    assert.match(shared.result().error, /INSTALL_DIR ownership unavailable/);
    assert.deepEqual(snapshot(shared.opts.root), original);
    assert.equal(fs.existsSync(shared.opts.backup), false);
  } finally {
    await dataOwnerA.release();
    await installOwner.release();
  }
  // Failure of the second lock must release the first, even with legacy opts set.
  const dataOwnerB = await acquireOwnership(dataB, 'data');
  try {
    assert.notEqual(run(shared.file).status, 0);
    assert.match(shared.result().error, /DATA_DIR ownership unavailable/);
    assert.deepEqual(snapshot(shared.opts.root), original);
    assert.equal(fs.existsSync(shared.opts.backup), false);
    const probe = await acquireOwnership(shared.opts.root, 'install');
    await probe.release();
  } finally { await dataOwnerB.release(); }
  const installed = run(shared.file);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(shared.result().status, 'success');
  assert.equal(fs.readFileSync(path.join(shared.opts.root, 'b.txt'), 'utf8'), 'new-b');
  for (const scope of ['install', 'data']) {
    const probe = await acquireOwnership(scope === 'install' ? shared.opts.root : dataB, scope);
    await probe.release();
  }
  // A partial pair must not fall back to the supplied legacy file lock.
  for (const key of ['installationPipe', 'ownershipPipe']) {
    const partial = setup('partial-' + key, exitedPid);
    fs.writeFileSync(partial.file, buildApplyScript({ ...partial.opts, [key]: pipes[key] }));
    assert.notEqual(run(partial.file).status, 0);
    assert.match(partial.result().error, /Both installationPipe and ownershipPipe/);
    assert.equal(fs.existsSync(partial.opts.backup), false);
    assert.equal(fs.existsSync(partial.opts.ownershipPath), false);
  }
  // Same FIRST_PIPE_INSTANCE protocol as ownership.cjs, tested in both directions.
  const net = require('node:net');
  const pipe = '\\\\.\\pipe\\bridge-installer-test-' + require('node:crypto').randomUUID();
  const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const owner = net.createServer();
  await listen(owner);
  const pipeBlocked = setup('pipe-worker-wins', exitedPid);
  fs.writeFileSync(pipeBlocked.file, buildApplyScript({ ...pipeBlocked.opts, installationPipe: pipeName(pipeBlocked.opts.root, 'install'), ownershipPipe: pipe }));
  assert.notEqual(run(pipeBlocked.file).status, 0);
  assert.equal(pipeBlocked.result().status, 'not_started');
  assert.equal(fs.existsSync(pipeBlocked.opts.backup), false);
  await new Promise(resolve => owner.close(resolve));
  const pipeHeld = setup('pipe-installer-wins', exitedPid);
  // Test-only mid-copy pause: mutate a real temporary install, then interrupt.
  fs.writeFileSync(pipeHeld.file, buildApplyScript({ ...pipeHeld.opts, installationPipe: pipeName(pipeHeld.opts.root, 'install'), ownershipPipe: pipe }).replace('$copyStarted = $true', `$copyStarted = $true; Copy-Item -LiteralPath ${psQuote(path.join(pipeHeld.opts.stage, 'a.txt'))} -Destination $root -Force; Start-Sleep -Seconds 15`));
  const pipeInstaller = spawn('powershell.exe', [...psArgs, '-File', pipeHeld.file], { stdio: 'ignore' });
  try {
    await waitFor(() => {
      try { return pipeHeld.result().phase === 'copying' && fs.existsSync(path.join(pipeHeld.opts.root, 'a.txt')); } catch { return false; }
    });
    const newWorker = net.createServer();
    await assert.rejects(listen(newWorker));
    await assert.rejects(acquireOwnership(pipeHeld.opts.root, 'install'));
  } finally {
    const stopped = new Promise(resolve => pipeInstaller.once('exit', resolve));
    pipeInstaller.kill();
    await stopped;
  }
  const installAfterCrash = await acquireOwnership(pipeHeld.opts.root, 'install');
  await installAfterCrash.release();
  const afterCrash = net.createServer();
  await listen(afterCrash);
  await new Promise(resolve => afterCrash.close(resolve));
  assert.equal(pipeHeld.result().status, 'in_progress');
  assert.equal(pipeHeld.result().phase, 'copying');
  assert.equal(fs.readFileSync(path.join(pipeHeld.opts.root, 'a.txt'), 'utf8'), 'new');
  for (const p of [pipeHeld.opts.stage, pipeHeld.opts.backup, pipeHeld.opts.pkg]) assert.ok(fs.existsSync(p), p);
  console.log('digest + Windows wait/copy/rollback/cleanup/interruption/ownership tests passed');
})().then(() => fs.rmSync(temp, { recursive: true, force: true }), error => {
  console.error('Failure diagnostics retained at ' + temp);
  console.error(error);
  process.exitCode = 1;
});
