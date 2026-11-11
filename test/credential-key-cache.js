// Offline only: VM bootstrap owners, temporary profiles and synthetic keys/tokens.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const keyA = Buffer.alloc(32, 17);
const keyB = Buffer.alloc(32, 29);
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-key-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'fixture-app');
  fs.mkdirSync(appDir);
  const file = path.resolve(__dirname, '../plugin/node/worker.cjs');
  const baseRequire = createRequire(file);
  const calls = [];
  let active = 0, maxActive = 0, now = 10000, authReads = 0, throwNext = false;
  class Clock extends Date { static now() { return now; } }
  const owner = () => ({ held: true, assertHeld() { assert.equal(this.held, true); } });
  const forbidden = () => { throw new Error('offline test forbids network, real processes and timers'); };
  const ctx = vm.createContext({
    __CINDY_BRIDGE_OWNERSHIP: { installation: owner(), data: owner() },
    Buffer, URL, TextDecoder, AbortController, AbortSignal, Date: Clock,
    __dirname: path.dirname(file), setTimeout: forbidden, clearTimeout: forbidden,
    process: { env: { APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, CINDY_QODER_DATA: path.join(root, 'bridge') }, platform: 'win32', arch: process.arch, stderr: { write() {} } },
    fetch: forbidden,
    require(id) {
      if (id === './update-status.cjs') return { ...baseRequire(id), updateDirectory: () => path.join(root, 'update') };
      if (id === 'node:child_process') return {
        execFileSync: forbidden, spawn: forbidden,
        execFile(command, args, options, callback) {
          assert.equal(command, 'powershell.exe');
          assert.equal(options.env.QODER_APP_DIR, appDir);
          assert.ok(args.includes('-EncodedCommand'));
          if (throwNext) { throwNext = false; calls.push({ thrown: true }); throw new Error('fixture synchronous spawn failure'); }
          active++; maxActive = Math.max(maxActive, active);
          let done = false;
          calls.push({ finish(error = null, key = keyA, stdout) {
            assert.equal(done, false); done = true; active--;
            callback(error, stdout ?? `${key.toString('base64')}\r\n`);
          } });
        },
      };
      if (id === 'node:fs') return { ...fs, readFileSync(p, ...args) {
        if (String(p).endsWith('auth.v1.dat')) {
          assert.equal(path.dirname(String(p)), appDir, 'never read a real auth file');
          authReads++;
        }
        return fs.readFileSync(p, ...args);
      } };
      return baseRequire(id);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8').split('// JSON-RPC over stdio')[0], ctx, { filename: file });
  ctx.fixtureDir = appDir;
  const run = source => vm.runInContext(source, ctx);
  run("region={id:'fixture',appNames:['fixture-app']}");
  const state = value => fs.writeFileSync(path.join(appDir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: `fixture-${value}` } }));
  state('a');
  function auth(key, token) {
    const nonce = Buffer.alloc(12, 23);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const plain = JSON.stringify({ token, user: { id: 'fixture-user' }, expiresAt: new Date(now + 60000).toISOString() });
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    fs.writeFileSync(path.join(appDir, 'auth.v1.dat'), Buffer.concat([Buffer.from('v10'), nonce, encrypted, cipher.getAuthTag()]));
  }
  return {
    calls, run, state, auth, get: () => run('oscryptKeyFor(fixtureDir)'),
    burst: () => Array.from({ length: 20 }, () => run('oscryptKeyFor(fixtureDir)')),
    advance(ms) { now += ms; }, throwNext() { throwNext = true; },
    get maxActive() { return maxActive; }, get active() { return active; }, get authReads() { return authReads; },
  };
}

function allKeys(values, key) {
  for (const value of values) assert.deepEqual(value, key);
}

test('20 cold readers share one process; unchanged cached identity spawns zero new processes', async t => {
  const f = fixture(t);
  const readers = f.burst(); await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].finish();
  allKeys(await Promise.all(readers), keyA);
  allKeys(await Promise.all(f.burst()), keyA);
  assert.equal(f.calls.length, 1);
  assert.equal(f.maxActive, 1);
  assert.equal(f.run('keyInflight.size'), 0);
});

test('20 failed readers share one process; cooldown suppresses retries then permits recovery', async t => {
  const f = fixture(t);
  const readers = f.burst(); await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].finish(new Error('fixture DPAPI failure'));
  allKeys(await Promise.all(readers), undefined);
  allKeys(await Promise.all(f.burst()), undefined);
  f.state('b'); // Cooldown is per appDir, not per identity.
  f.advance(999);
  allKeys(await Promise.all(f.burst()), undefined);
  assert.equal(f.calls.length, 1);
  f.advance(1);
  const recovered = f.burst(); await flush();
  assert.equal(f.calls.length, 2);
  f.calls[1].finish(null, keyB);
  allKeys(await Promise.all(recovered), keyB);
  assert.equal(f.maxActive, 1);
  assert.equal(f.run('keyRetryAfter.size'), 0);
});

test('identity switches while waiting: serialize refresh, reject old result, keep new generation inflight', async t => {
  const f = fixture(t);
  const first = f.burst(); await flush();
  f.state('b');
  const second = f.burst(); await flush();
  assert.equal(f.calls.length, 1, 'identity change must not start another process while old one runs');
  f.calls[0].finish(null, keyA); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.run('keyCache.size'), 0, 'old result must not be cached against new identity');
  assert.equal(f.run('keyInflight.size'), 1);
  const third = f.burst(); await flush();
  assert.equal(f.calls.length, 2, 'old cleanup must not clear the new inflight generation');
  f.calls[1].finish(null, keyB);
  allKeys(await Promise.all([...first, ...second, ...third]), keyB);
  assert.equal(f.maxActive, 1);
});

test('persistent identity churn terminates each call with temporary failure, without concurrent spawns', async t => {
  const f = fixture(t);
  const readers = f.burst(); await flush();
  for (let i = 0; i < 3; i++) {
    assert.equal(f.calls.length, i + 1);
    f.state(`churn-${i}`);
    f.calls[i].finish(); await flush();
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.active, 0);
  allKeys(await Promise.all(readers), undefined);
  assert.equal(f.maxActive, 1);
  assert.equal(f.run('keyInflight.size'), 0);
  const next = f.get(); await flush();
  assert.equal(f.calls.length, 4, 'later read can retry after churn stops');
  f.calls[3].finish(null, keyB);
  assert.deepEqual(await next, keyB);
});

test('warm credential reads auth every time; key rotation failure preserves old key and credential but never decrypts with stale key', async t => {
  const f = fixture(t);
  f.auth(keyA, 'fixture-token-a');
  const first = f.run('refreshCredential(false)'); await flush();
  f.calls[0].finish();
  assert.equal((await first).token, 'fixture-token-a');
  f.auth(keyA, 'fixture-token-b');
  assert.equal((await f.run('refreshCredential(false)')).token, 'fixture-token-b');
  assert.equal(f.calls.length, 1, 'warm identity uses cached key without spawning');
  assert.equal(f.authReads, 2, 'no credential TTL fast path');
  f.state('b');
  // Encrypt with old key deliberately: reusing a stale key would incorrectly accept this token.
  f.auth(keyA, 'fixture-stale-key-must-not-be-used');
  const failed = f.run('refreshCredential(false)'); await flush();
  f.calls[1].finish(new Error('fixture DPAPI failure'));
  assert.equal((await failed).token, 'fixture-token-b');
  assert.deepEqual(f.run('keyCache.get(fixtureDir).key'), keyA, 'retain previous key for its own identity');
  assert.equal((await f.run('loadCredential(region)')).status, 'temporary');
  assert.equal(f.calls.length, 2);
  f.advance(1000); f.auth(keyB, 'fixture-token-c');
  const recovered = f.run('refreshCredential(false)'); await flush();
  f.calls[2].finish(null, keyB);
  assert.equal((await recovered).token, 'fixture-token-c');
  assert.equal(f.authReads, 5);
});

test('invalid key output and synchronous spawn errors also cool down and release inflight', async t => {
  for (const mode of ['invalid', 'throw']) {
    const f = fixture(t);
    if (mode === 'throw') f.throwNext();
    const readers = f.burst(); await flush();
    if (mode === 'invalid') f.calls[0].finish(null, keyA, 'fixture-not-a-32-byte-key');
    allKeys(await Promise.all(readers), undefined);
    allKeys(await Promise.all(f.burst()), undefined);
    assert.equal(f.calls.length, 1);
    assert.equal(f.run('keyInflight.size'), 0);
    f.advance(1000);
    const next = f.get(); await flush();
    f.calls[1].finish();
    assert.deepEqual(await next, keyA);
  }
});
