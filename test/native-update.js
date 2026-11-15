'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const native = require('../plugin/node/native-update.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-update-'));
const packagePath = path.join(root, "中文 空格 O'Brien.cindy");
const hostExe = path.join(root, 'Cindy.exe');
const bytes = Buffer.from('offline package fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(packagePath, bytes);
// execFile is always injected: this fixture is never executed.
fs.writeFileSync(hostExe, 'offline host fixture');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const details = { state: 'awaiting_confirmation', targetVersion: '1.2.3', fromVersion: '1.2.2',
  packagePath, sha256 };
const windows = { skip: process.platform !== 'win32' };
function dataDir(name) { return path.join(root, name); }
function request(overrides = {}) {
  return native.launchImport({ packagePath, sha256, hostExe,
    execFile: () => { throw new Error('unexpected launch'); }, ...overrides });
}

test('atomic plugin journal: pending stays pending on old version, new runtime completes without rewriting', windows, () => {
  const dir = dataDir('pending');
  native.writeStatus(dir, details);
  const file = path.join(dir, 'native-update.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(before).schemaVersion, 1);
  assert.equal(JSON.parse(before).status, undefined);
  assert.deepEqual(fs.readdirSync(dir), ['native-update.json']);
  for (const current of ['1.2.1', '1.2.2']) {
    const result = native.readStatus(dir, current);
    assert.equal(result.state, 'awaiting_confirmation');
    assert.match(result.message, /尚未安装.*确认后自动完成.*取消可重试/);
  }
  for (const current of ['1.2.3', '1.2.4', '1.10.0']) {
    const result = native.readStatus(dir, current);
    assert.equal(result.state, 'completed');
    assert.match(result.message, new RegExp(`安装完成，当前运行版本 ${current}`));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('preparing and open_failed explicitly do not claim completion', windows, () => {
  for (const state of ['preparing', 'open_failed']) {
    const dir = dataDir(state);
    native.writeStatus(dir, { ...details, state, error: 'offline diagnostic' });
    const result = native.readStatus(dir, '1.2.2');
    assert.equal(result.state, state);
    assert.match(result.message, state === 'preparing' ? /下载.*准备.*尚未安装/ : /失败.*尚未安装.*重试/);
  }
});
test('bad or missing journal fails closed even when runtime is newer', windows, () => {
  const dir = dataDir('bad'); fs.mkdirSync(dir);
  const file = path.join(dir, 'native-update.json');
  assert.equal(native.readStatus(dir, '9.0.0'), null);
  for (const value of ['{broken', 'null', JSON.stringify({ ...details, schemaVersion: 2 }),
    JSON.stringify({ ...details, schemaVersion: 1, targetVersion: '1.2.3-beta' }),
    JSON.stringify({ ...details, schemaVersion: 1, state: 'unknown' }),
    JSON.stringify({ ...details, schemaVersion: 1, sha256: 'bad' }),
    JSON.stringify({ ...details, schemaVersion: 1, packagePath: 'relative.cindy' })]) {
    fs.writeFileSync(file, value);
    assert.equal(native.readStatus(dir, '9.0.0').state, 'unknown');
    assert.equal(fs.readFileSync(file, 'utf8'), value);
  }
  native.writeStatus(dir, { ...details, state: 'completed' });
  assert.equal(native.readStatus(dir, '1.2.2').state, 'awaiting_confirmation');
  for (const current of ['v1.2.3', '1.2.3-beta', '', null, '9007199254740992.0']) {
    assert.equal(native.readStatus(dir, current).state, 'unknown');
  }
  assert.throws(() => native.writeStatus(dir, { ...details, targetVersion: '1.2.3-beta' }), /格式无效/);
});
test('journal rename failure preserves previous complete record and removes temporary file', windows, () => {
  const dir = dataDir('atomic'); native.writeStatus(dir, details);
  const before = fs.readFileSync(path.join(dir, 'native-update.json'), 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('offline rename failure'); };
  try { assert.throws(() => native.writeStatus(dir, { ...details, state: 'preparing' }), /rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(dir, 'native-update.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['native-update.json']);
});
test('verified public same-exe open is encoded, injection-safe, and resolves only after launcher exits', windows, async () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const snapshot = fs.readFileSync(packagePath);
  let callback; let settled = false; let called = false;
  try {
    const promise = request({ sha256: sha256.toUpperCase(), execFile(exe, args, options, done) {
      called = true; callback = done;
      assert.equal(exe, 'powershell.exe');
      assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /Start-Process -FilePath \$env:CINDY_NATIVE_UPDATE_HOST/);
      assert.match(script, /-ArgumentList \('\"' \+ \$env:CINDY_NATIVE_UPDATE_PACKAGE \+ '\"'\)/);
      assert.ok(!script.includes(packagePath));
      assert.ok(!script.includes(hostExe));
      assert.doesNotMatch(script, /selfinstall|Copy-Item|Move-Item|Remove-Item|Wait-Process|Stop-Process|Invoke-Expression|-Wait\b|\.js\b/i);
      assert.equal(options.env.CINDY_NATIVE_UPDATE_HOST, hostExe);
      assert.equal(options.env.CINDY_NATIVE_UPDATE_PACKAGE, packagePath);
      assert.ok(Object.keys(options.env).every((key) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
      assert.equal(options.detached, undefined);
      assert.equal(options.shell, undefined);
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout > 0 && options.timeout <= 30000);
    } });
    promise.then(() => { settled = true; });
    // Wait for local file IO, never a real GUI or network request.
    while (!called) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    callback(null, '', '');
    assert.deepEqual(await promise, { installRequested: true });
    assert.deepEqual(fs.readFileSync(packagePath), snapshot);
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});
test('bad hashes, paths and non-Cindy runtimes never launch', windows, async () => {
  for (const overrides of [
    { sha256: '0'.repeat(64) }, { sha256: 'sha256:' + sha256 }, { sha256: 'invalid' },
    { packagePath: 'relative.cindy' }, { packagePath: '\\relative.cindy' },
    { packagePath: packagePath + '.zip' }, { packagePath: path.join(root, 'missing.cindy') },
    ...['"', '\0', '\n', '\r'].map((bad) => ({ packagePath: path.join(root, bad + '.cindy') })),
    { hostExe: process.execPath }, { hostExe: path.join(root, 'electron.exe') },
    { hostExe: path.join(root, 'missing', 'Cindy.exe') }, { hostExe: 'Cindy.exe' },
    ...['"', '\0', '\n', '\r'].map((bad) => ({ hostExe: path.join(root, bad, 'Cindy.exe') })),
  ]) {
    let calls = 0;
    await assert.rejects(request({ ...overrides, execFile() { calls++; } }));
    assert.equal(calls, 0);
  }
  await assert.rejects(native.launchImport({ packagePath, sha256, execFile() { assert.fail('default Node runtime must not launch'); } }), /Cindy.exe/);
});
test('launcher exit errors, ENOENT, timeouts and synchronous errors are friendly failures', windows, async () => {
  for (const [error, pattern] of [
    [Object.assign(new Error('exit'), { code: 1 }), /启动失败/],
    [Object.assign(new Error('missing'), { code: 'ENOENT' }), /找不到 PowerShell/],
    [Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }), /启动超时/],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), /启动超时/],
  ]) {
    await assert.rejects(request({ execFile(exe, args, options, done) { done(error); } }), pattern);
  }
  await assert.rejects(request({ execFile() { throw new Error('sync spawn error'); } }), /无法打开.*尚未安装/);
});
test('module never invokes old installer, exits worker, or writes host installation records', () => {
  const source = fs.readFileSync(path.join(__dirname, '../plugin/node/native-update.cjs'), 'utf8');
  assert.doesNotMatch(source, /process\.exit\s*\(|\.unref\s*\(|buildApplyScript|extractZipTo|selfinstall|plugin-instances|\.cindy-trust|copyFile|setTimeout|setInterval/);
});
test('non-Windows launch fails closed', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(request(), /仅支持 Windows/);
});
