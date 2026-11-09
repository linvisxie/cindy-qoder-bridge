'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const ownership = require('../plugin/node/ownership.cjs');

if (process.argv[2] === '--ownership-child') {
  process.once('message', async () => {
    try {
      const owner = await ownership.acquireOwnership(process.argv[3], process.argv[4]);
      process.send({ held: owner.held });
      process.once('message', async () => { await owner.release(); process.disconnect(); });
    } catch (error) { process.send({ held: false, code: error.code }); process.disconnect(); }
  });
} else {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const children = new Set();
  const directories = [];
  const supported = { skip: !['win32', 'linux'].includes(process.platform), timeout: 30000 };
  const savedEnv = {};
  function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ownership-')); directories.push(dir); return dir; }
  const profile = temp();
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(profile, key);
    fs.mkdirSync(process.env[key]);
  }
  test.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  function contender(dir, scope = 'data') {
    const child = fork(__filename, ['--ownership-child', dir, scope], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.add(child);
    const exit = once(child, 'exit');
    const result = once(child, 'message').then(([message]) => ({ child, message, exit }));
    child.send('acquire');
    return result;
  }
  async function stop(entry, crash = false) {
    if (crash) entry.child.kill('SIGKILL'); else entry.child.send('release');
    await entry.exit;
  }

  for (const scope of ['install', 'data']) {
    test(`${scope}: kernel exclusivity across simultaneous children and automatic crash release`, supported, async () => {
      const dir = temp();
      const candidates = await Promise.all(Array.from({ length: 8 }, () => contender(dir, scope)));
      const winners = candidates.filter(c => c.message.held);
      assert.equal(winners.length, 1, 'FIRST_PIPE_INSTANCE / abstract socket permits exactly one owner');
      for (const c of candidates.filter(c => !c.message.held)) {
        assert.match(c.message.code, /EADDRINUSE|EACCES/); await c.exit;
      }
      const late = await contender(dir, scope); assert.equal(late.message.held, false); await late.exit;
      await stop(winners[0], true);
      const replacement = await contender(dir, scope); assert.equal(replacement.message.held, true); await stop(replacement);
      const afterRelease = await contender(dir, scope); assert.equal(afterRelease.message.held, true); await stop(afterRelease);
    });
  }

  test('scope separates install and data locks on the same canonical directory', supported, async () => {
    const dir = temp();
    assert.notEqual(ownership.pipeName(dir, 'install'), ownership.pipeName(dir, 'data'));
    assert.equal(ownership.pipeName(dir), ownership.pipeName(dir, 'data'));
    assert.throws(() => ownership.pipeName(dir, 'invalid/scope'), /Invalid ownership scope/);
    const install = await ownership.acquireOwnership(dir, 'install');
    const data = await ownership.acquireOwnership(dir, 'data');
    try {
      install.assertHeld(); data.assertHeld();
      await assert.rejects(ownership.acquireOwnership(dir, 'install'), /INSTALL_DIR ownership unavailable/);
      await assert.rejects(ownership.acquireOwnership(dir, 'data'), /DATA_DIR ownership unavailable/);
    } finally { await data.release(); await install.release(); }
    assert.equal(install.held, false); assert.equal(data.held, false);
    assert.throws(() => install.assertHeld(), /INSTALL_DIR ownership lost/);
    assert.throws(() => data.assertHeld(), /DATA_DIR ownership lost/);
  });

  test('canonical aliases and uncreated descendants share identity without lock-file IO', supported, async () => {
    const root = temp(); const dir = path.join(root, 'data'); fs.mkdirSync(dir);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(dir, '.ownership.lock'), 'stale dead pid 999999');
    const aliases = [alias, path.join(alias, '..', 'alias')];
    if (process.platform === 'win32') aliases.push(dir.toUpperCase());
    for (const scope of ['install', 'data']) {
      const owner = await contender(dir, scope); assert.equal(owner.message.held, true);
      for (const candidate of aliases) {
        assert.equal(ownership.pipeName(candidate, scope), ownership.pipeName(dir, scope));
        const denied = await contender(candidate, scope); assert.equal(denied.message.held, false); await denied.exit;
      }
      const other = await contender(path.join(root, 'uncreated'), scope);
      assert.equal(other.message.held, true); assert.equal(fs.existsSync(path.join(root, 'uncreated')), false);
      await stop(other); await stop(owner, true);
      const recovered = await contender(alias, scope); assert.equal(recovered.message.held, true); await stop(recovered);
      assert.equal(ownership.pipeName(path.join(alias, 'new'), scope), ownership.pipeName(path.join(dir, 'new'), scope));
    }
  });
}
