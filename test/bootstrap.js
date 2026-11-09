'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');

// No test process (including children) can discover a real user profile.
const isChild = process.argv[2] === '--bootstrap-child';
const profile = isChild ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bootstrap-profile-'));
const savedEnv = {};
for (const key of isChild ? [] : ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) {
  savedEnv[key] = process.env[key];
  process.env[key] = path.join(profile, key);
  fs.mkdirSync(process.env[key]);
}
const { bootstrap } = require('../plugin/node/bootstrap.cjs');

if (process.argv[2] === '--bootstrap-child') {
  process.once('message', async () => {
    try {
      await bootstrap({ installDir: process.argv[3], dataDir: process.argv[4], loadWorker(owners) {
        assert.equal(globalThis.__CINDY_BRIDGE_OWNERSHIP, owners);
        owners.installation.assertHeld(); owners.data.assertHeld();
        process.send({ loaded: true });
      } });
    } catch (error) {
      process.send({ loaded: false, error: error.message });
      process.disconnect();
    }
  });
} else {
  const test = require('node:test');
  const { acquireOwnership } = require('../plugin/node/ownership.cjs');
  const children = new Set();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bootstrap-'));
  const supported = { skip: !['win32', 'linux'].includes(process.platform), timeout: 30000 };
  const dir = name => path.join(root, name);
  test.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit'); child.kill(); await exit;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function release(owners) {
    await owners.data.release(); await owners.installation.release();
    if (globalThis.__CINDY_BRIDGE_OWNERSHIP === owners) delete globalThis.__CINDY_BRIDGE_OWNERSHIP;
  }
  function childBoot(installDir, dataDir) {
    const child = fork(__filename, ['--bootstrap-child', installDir, dataDir], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.add(child);
    const exit = once(child, 'exit');
    const result = once(child, 'message').then(([message]) => ({ child, message, exit }));
    child.send('boot');
    return result;
  }

  test('bootstrap loads recovery then worker only after install and data locks; failures release in reverse order', async () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../plugin/node/bootstrap.cjs'), 'utf8');
    for (const failure of [null, 'install', 'data', 'recovery', 'worker']) {
      const events = [];
      const handles = {};
      const context = vm.createContext({
        __dirname, __filename: path.join(__dirname, '../plugin/node/bootstrap.cjs'), module: { exports: {} }, process,
        require(id) {
          if (id === './ownership.cjs') return { async acquireOwnership(directory, scope) {
            events.push(scope);
            if (failure === scope) throw new Error(failure);
            return handles[scope] = { async release() {
              events.push(`release-${scope}`);
              // A failed data release must not prevent installation release.
              if (failure === 'worker' && scope === 'data') throw new Error('release');
            } };
          } };
          if (id === './update-status.cjs') {
            events.push('require-recovery');
            assert.ok(handles.install && handles.data);
            return {
              updateDirectory(installDir) {
                assert.equal(installDir, dir('vm-install'));
                return 'fixture-install-journal';
              },
              assertRecoverable(updateDir) {
                assert.equal(updateDir, 'fixture-install-journal');
                events.push('recovery');
                if (failure === 'recovery') throw new Error(failure);
              },
            };
          }
          if (id.endsWith('worker.cjs')) {
            events.push('worker');
            assert.equal(context.__CINDY_BRIDGE_OWNERSHIP.installation, handles.install);
            assert.equal(context.__CINDY_BRIDGE_OWNERSHIP.data, handles.data);
            if (failure === 'worker') throw new Error(failure);
            return {};
          }
          return require(id);
        },
      });
      vm.runInContext(source, context);
      const done = context.module.exports.bootstrap({ installDir: dir('vm-install'), dataDir: dir('vm-data') });
      if (failure) {
        await assert.rejects(done, new RegExp(failure));
        assert.equal(context.__CINDY_BRIDGE_OWNERSHIP, undefined);
      } else await done;
      const prefix = ['install', 'data', 'require-recovery', 'recovery', 'worker'];
      const expected = failure === 'install' ? ['install']
        : failure === 'data' ? ['install', 'data', 'release-install']
        : failure === 'recovery' ? [...prefix.slice(0, 4), 'release-data', 'release-install']
        : failure === 'worker' ? [...prefix, 'release-data', 'release-install'] : prefix;
      assert.deepEqual(events, expected);
    }
  });

  for (const mode of ['host', 'legacy-argv', 'global-only', 'plain-require']) {
    test(`real child entry: ${mode}`, supported, async () => {
      const installDir = dir(`entry-${mode}`);
      const nodeDir = path.join(installDir, 'node');
      const dataDir = dir(`entry-data-${mode}`);
      fs.mkdirSync(nodeDir, { recursive: true });
      for (const name of ['bootstrap.cjs', 'ownership.cjs', 'update-status.cjs']) {
        fs.copyFileSync(path.join(__dirname, '../plugin/node', name), path.join(nodeDir, name));
      }
      fs.writeFileSync(path.join(installDir, 'ghost.json'), JSON.stringify({ id: 'qoder-bridge' }));
      // This is the only worker the child can load: no production business code.
      fs.writeFileSync(path.join(nodeDir, 'worker.cjs'), `
        const assert = require('node:assert/strict');
        assert.deepEqual(process.argv, globalThis.__FIXTURE_ARGV__);
        const owners = globalThis.__CINDY_BRIDGE_OWNERSHIP;
        owners.installation.assertHeld(); owners.data.assertHeld();
        (async () => {
          await owners.data.release(); await owners.installation.release();
          process.stdout.write('ready\\n');
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `);
      const host = path.join(installDir, 'host.cjs');
      fs.writeFileSync(host, `
        const assert = require('node:assert/strict');
        const { createRequire } = require('node:module');
        const entryPath = process.argv[2];
        const mode = process.argv[3];
        if (mode === 'host' || mode === 'global-only') {
          Object.defineProperty(globalThis, '__CINDY_NODE__', {
            value: Object.freeze({}), configurable: false, writable: false,
          });
        }
        if (mode === 'global-only' || mode === 'plain-require') process.argv[2] = '--not-entry';
        globalThis.__FIXTURE_ARGV__ = process.argv.slice();
        const requireFromWorker = createRequire(__filename);
        assert.equal(typeof requireFromWorker(entryPath).bootstrap, 'function');
        if (mode === 'plain-require') setImmediate(() => {
          assert.equal(globalThis.__CINDY_BRIDGE_OWNERSHIP, undefined);
          process.stdout.write('imported\\n');
        });
      `);
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        require('node:child_process').execFile(process.execPath, [host, path.join(nodeDir, 'bootstrap.cjs'), mode], {
          env: { ...process.env, CINDY_QODER_DATA: dataDir, CINDY_TRAE_DATA: dataDir },
          timeout: 10000, windowsHide: true,
        }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      });
      assert.equal(stdout, mode === 'plain-require' ? 'imported\n' : 'ready\n');
      assert.equal(stderr, '');
    });
  }

  test('same install with different data is rejected before loadWorker', supported, async () => {
    const first = await childBoot(dir('shared-install'), dir('data-a'));
    assert.equal(first.message.loaded, true);
    try {
      const denied = await childBoot(dir('shared-install'), dir('data-b'));
      assert.equal(denied.message.loaded, false);
      assert.match(denied.message.error, /INSTALL_DIR ownership unavailable/);
      await denied.exit;
    } finally { first.child.kill(); await first.exit; }
  });

  test('same data with different install is rejected and releases the newly acquired install lock', supported, async () => {
    const first = await childBoot(dir('install-a'), dir('shared-data'));
    assert.equal(first.message.loaded, true);
    try {
      const denied = await childBoot(dir('install-b'), dir('shared-data'));
      assert.equal(denied.message.loaded, false);
      assert.match(denied.message.error, /DATA_DIR ownership unavailable/);
      await denied.exit;
      const owner = await acquireOwnership(dir('install-b'), 'install');
      await owner.release();
    } finally { first.child.kill(); await first.exit; }
  });

  test('interrupted or unreadable journal blocks worker and releases both locks', supported, async () => {
    const installDir = dir('journal-install'); const dataDir = dir('journal-data');
    const update = require('../plugin/node/update-status.cjs').updateDirectory(installDir);
    const attempt = 'attempt-abcd';
    fs.mkdirSync(path.join(update, attempt), { recursive: true });
    fs.writeFileSync(path.join(update, 'latest-attempt.json'), JSON.stringify({ attempt }));
    for (const result of [
      { status: 'in_progress', phase: 'copying' },
      { status: 'in_progress', phase: 'rolling_back' },
      { status: 'rollback_failed' }, null,
    ]) {
      fs.writeFileSync(path.join(update, attempt, 'result.json'), result ? JSON.stringify({ schemaVersion: 1, ...result }) : '{');
      let loaded = false;
      await assert.rejects(bootstrap({ installDir, dataDir, loadWorker() { loaded = true; } }), /中断/);
      assert.equal(loaded, false);
      assert.equal(globalThis.__CINDY_BRIDGE_OWNERSHIP, undefined);
      const installation = await acquireOwnership(installDir, 'install');
      const data = await acquireOwnership(dataDir, 'data');
      await release({ installation, data });
    }
  });

  test('changing DATA_DIR cannot bypass an interrupted installation journal and releases both locks', supported, async () => {
    const journal = require('../plugin/node/update-status.cjs');
    const installDir = dir('switch-install');
    const dataA = dir('switch-data-a'); const dataB = dir('switch-data-b');
    // Record the interrupted copy while A owns this installation and its data.
    const owners = await bootstrap({ installDir, dataDir: dataA, loadWorker(handles) {
      handles.installation.assertHeld(); handles.data.assertHeld();
      const attemptDir = journal.begin(journal.updateDirectory(installDir), 'attempt-abcd');
      journal.writeResult(attemptDir, { status: 'in_progress', phase: 'copying' });
    } });
    await release(owners);
    let loaded = false;
    await assert.rejects(bootstrap({ installDir, dataDir: dataB, loadWorker() { loaded = true; } }), /中断/);
    assert.equal(loaded, false);
    assert.equal(globalThis.__CINDY_BRIDGE_OWNERSHIP, undefined);
    const installation = await acquireOwnership(installDir, 'install');
    const data = await acquireOwnership(dataB, 'data');
    await release({ installation, data });
  });

  test('worker failure releases both locks; successful injection receives held global handles', supported, async () => {
    const options = { installDir: dir('throw-install'), dataDir: dir('throw-data') };
    await assert.rejects(bootstrap({ ...options, loadWorker() { throw new Error('fixture worker failure'); } }), /fixture worker failure/);
    assert.equal(globalThis.__CINDY_BRIDGE_OWNERSHIP, undefined);
    let loaded = false;
    const owners = await bootstrap({ ...options, loadWorker(handles) {
      loaded = true;
      assert.equal(globalThis.__CINDY_BRIDGE_OWNERSHIP, handles);
      handles.installation.assertHeld(); handles.data.assertHeld();
    } });
    try { assert.equal(loaded, true); } finally { await release(owners); }
  });

  test('child crash releases both kernel locks without stale-file cleanup', supported, async () => {
    const options = { installDir: dir('crash-install'), dataDir: dir('crash-data') };
    const child = await childBoot(options.installDir, options.dataDir);
    assert.equal(child.message.loaded, true);
    child.child.kill('SIGKILL'); await child.exit;
    const owners = await bootstrap({ ...options, loadWorker() {} });
    await release(owners);
  });
}
