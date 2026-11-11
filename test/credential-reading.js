// Synthetic encrypted fixtures only: no real Qoder profile, DPAPI or upstream.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const key = Buffer.alloc(32, 17);
const dirs = [];
test.after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-read-contract-')); dirs.push(dir);
  const file = path.resolve(__dirname, '../plugin/node/worker.cjs');
  const baseRequire = createRequire(file);
  let blocked = false;
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const owner = () => ({ held: true, assertHeld() { assert.equal(this.held, true); } });
  const ctx = vm.createContext({
    __CINDY_BRIDGE_OWNERSHIP: { installation: owner(), data: owner() },
    Buffer, URL, TextDecoder, AbortController, AbortSignal, Date: Clock, __dirname: path.dirname(file), setTimeout, clearTimeout,
    process: { env: { APPDATA: dir, LOCALAPPDATA: dir, USERPROFILE: dir, HOME: dir, CINDY_QODER_DATA: path.join(dir, 'bridge') }, platform: process.platform, arch: process.arch, stderr: { write() {} } },
    fetch() { throw new Error('test must not contact upstream'); },
    require(id) {
      if (id === './update-status.cjs') return { ...baseRequire(id), updateDirectory: () => path.join(dir, 'update') };
      if (id === 'node:fs') return { ...fs, readFileSync(file, ...args) {
        if (blocked && String(file).endsWith('auth.v1.dat')) { const e = new Error('busy'); e.code = 'EACCES'; throw e; }
        return fs.readFileSync(file, ...args);
      } };
      return baseRequire(id);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8').split('// JSON-RPC over stdio')[0], ctx, { filename: file });
  ctx.root = dir; ctx.fixtureKey = key;
  const run = source => vm.runInContext(source, ctx);
  run(`appDataRoot=()=>root;oscryptKeyFor=async()=>fixtureKey;region={id:'fixture',appNames:['first','second']};`);
  function write(app, value, raw = false) {
    const appDir = path.join(dir, app); fs.mkdirSync(appDir, { recursive: true });
    const nonce = Buffer.alloc(12, 23);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(raw ? value : JSON.stringify(value)), cipher.final()]);
    fs.writeFileSync(path.join(appDir, 'auth.v1.dat'), Buffer.concat([Buffer.from('v10'), nonce, encrypted, cipher.getAuthTag()]));
  }
  function valid(token = 'fixture-token') { return { token, user: { id: 'fixture-user' }, expiresAt: new Date(now + 60000).toISOString() }; }
  return { dir, ctx, run, write, valid, block(value) { blocked = value; }, advance(ms) { now += ms; } };
}

test('all candidates absent clears even nonforced stale cache; missing candidate never hides a valid candidate', async () => {
  const f = fixture();
  f.write('second', f.valid());
  assert.equal((await f.run('loadCredential(region)')).status, 'valid');
  assert.equal((await f.run('refreshCredential(true)')).token, 'fixture-token');
  fs.unlinkSync(path.join(f.dir, 'second/auth.v1.dat'));
  assert.equal(await f.run('refreshCredential(false)'), undefined, 'logout/removal must invalidate a warm credential immediately');
});

test('warm nonforced reads observe replacement and explicit logout without waiting for a TTL', async () => {
  const f = fixture(); f.write('first', f.valid('ticket-a'));
  assert.equal((await f.run('refreshCredential(true)')).token, 'ticket-a');
  f.write('first', f.valid('ticket-b'));
  assert.equal((await f.run('refreshCredential(false)')).token, 'ticket-b');
  f.write('first', { token: null });
  assert.equal(await f.run('refreshCredential(false)'), undefined);
  f.write('first', f.valid('ticket-c'));
  assert.equal((await f.run('refreshCredential(false)')).token, 'ticket-c');
});

test('forced IO, decrypt, key and JSON failures retain old credential and evaluate expiresAt at current time', async () => {
  const f = fixture(); f.write('first', f.valid());
  await f.run('refreshCredential(true)');
  f.block(true);
  assert.equal((await f.run('refreshCredential(true)')).token, 'fixture-token');
  f.advance(61000);
  assert.equal((await f.run('refreshCredential(false)')).expired, true, 'cache fast path must reevaluate expiry');
  assert.equal((await f.run('refreshCredential(true)')).expired, true, 'IO failure must reevaluate expiry');
  f.block(false);
  fs.writeFileSync(path.join(f.dir, 'first/auth.v1.dat'), 'partial ciphertext');
  assert.equal((await f.run('refreshCredential(true)')).token, 'fixture-token');
  f.write('first', '{partial JSON', true);
  assert.equal((await f.run('refreshCredential(true)')).token, 'fixture-token');
  f.write('first', {}); // unknown/partial schema is not an explicit logout
  assert.equal((await f.run('refreshCredential(true)')).token, 'fixture-token');
  f.run('oscryptKeyFor=async()=>undefined');
  assert.equal((await f.run('refreshCredential(true)')).token, 'fixture-token');
});

test('explicit synthetic logout clears; valid candidate wins over logout or corrupt candidate; uncertainty prevents clearing', async () => {
  const f = fixture(); f.write('first', f.valid()); await f.run('refreshCredential(true)');
  f.write('first', { token: '' });
  assert.equal((await f.run('loadCredential(region)')).status, 'logged-out');
  assert.equal(await f.run('refreshCredential(true)'), undefined);
  f.write('second', f.valid('second-token'));
  assert.equal((await f.run('refreshCredential(true)')).token, 'second-token');
  f.write('first', '{bad', true);
  assert.equal((await f.run('refreshCredential(true)')).token, 'second-token');
  f.write('second', { token: null });
  assert.equal((await f.run('loadCredential(region)')).status, 'temporary');
  assert.equal((await f.run('refreshCredential(true)')).token, 'second-token');
  fs.unlinkSync(path.join(f.dir, 'first/auth.v1.dat'));
  assert.equal(await f.run('refreshCredential(true)'), undefined);
});

test('PR generation protection: older valid read cannot resurrect after newer absence; older absence cannot erase newer valid read', async () => {
  for (const oldValid of [true, false]) {
    const f = fixture();
    let release;
    f.ctx.delayed = new Promise(resolve => { release = resolve; });
    f.run('loadCredential=()=>delayed');
    const old = f.run('refreshCredential(true)');
    f.run(`loadCredential=async()=>${oldValid ? "({status:'absent'})" : "({status:'valid',credential:{token:'new',expiresAt:0}})"}`);
    await f.run('refreshCredential(true)');
    release(oldValid ? { status: 'valid', credential: { token: 'old', expiresAt: 0 } } : { status: 'absent' });
    await old;
    assert.equal(f.run('credential?.token'), oldValid ? undefined : 'new');
  }
});
