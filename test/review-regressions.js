// 第二轮复审的行为回归。只用临时目录、假凭据/上游与假安装器，不联网、不换票、不覆盖插件。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const updater = require('../plugin/node/update.cjs');
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/ghost.json')));
const IS_TRAE = MANIFEST.id === 'trae-bridge';
const temporary = [];
test.after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });

function worker(options = {}) {
  const file = path.join(ROOT, 'plugin/node/worker.cjs');
  const baseRequire = createRequire(file);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bridge-review-'));
  temporary.push(dir);
  const launches = [], exits = [];
  const ctx = vm.createContext({
    __dirname: path.dirname(file), Buffer, URL, TextDecoder, AbortController, AbortSignal,
    require(id) {
      if (id === './trae.cjs' && options.trae) return options.trae;
      if (id === 'node:child_process') return {
        ...baseRequire(id),
        spawn() {
          const child = new EventEmitter(); child.unref = () => {};
          launches.push(child);
          queueMicrotask(() => child.emit(options.spawnError ? 'error' : 'spawn', options.spawnError));
          return child;
        },
      };
      return baseRequire(id);
    },
    process: {
      env: { ...process.env, CINDY_QODER_DATA: dir, CINDY_TRAE_DATA: dir },
      stderr: { write() {} }, platform: process.platform, arch: process.arch,
      pid: process.pid, execPath: process.execPath, exit() { throw new Error('test must not exit worker'); },
    },
    setTimeout(fn, ms) { if (ms === 800) { exits.push(fn); return 0; } return setTimeout(fn, ms); },
    clearTimeout,
  });
  // Retain the real implementation, omit resident boot and stdio event registration.
  vm.runInContext(fs.readFileSync(file, 'utf8').split('// JSON-RPC over stdio')[0], ctx, { filename: file });
  return { ctx, dir, launches, exits, run: (source) => vm.runInContext(source, ctx) };
}

async function request(w, route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = route;
  req.headers = { host: '127.0.0.1', authorization: 'Bearer local-test' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = Object.assign(new EventEmitter(), {
    text: '', writeHead(status) { this.status = status; this.headersSent = true; },
    write(chunk) { this.text += chunk; return true; }, end(chunk = '') { this.text += chunk; this.writableEnded = true; },
  });
  w.ctx.req = req; w.ctx.res = res;
  await w.run('handle(req,res)');
  return res;
}

for (const input of [123, 0]) for (const route of ['/v1/messages', '/v1/responses']) for (const stream of [false, true]) {
  test(`usage ${route} stream=${stream} actual input=${input}`, async () => {
    const w = worker();
    w.run(`token='local-test';models=[{key:'test',name:'Test'}];refreshCredential=async()=>({token:'fixture'});
      streamChat=async function*(){yield{choices:[{delta:{content:'hi'},finish_reason:'stop'}],usage:{prompt_tokens:${input},completion_tokens:45,total_tokens:${input + 45}}};}`);
    const body = route.endsWith('messages')
      ? { model: 'test', messages: [{ role: 'user', content: 'Hi' }], stream }
      : { model: 'test', input: 'Hi', stream };
    const res = await request(w, route, body);
    assert.equal(res.status, 200);
    const book = JSON.parse(fs.readFileSync(path.join(w.dir, 'usage.json')));
    const stats = Object.values(book.days)[0].models.test;
    assert.equal(stats.in, input); assert.equal(stats.out, 45);
    if (!stream) assert.equal(JSON.parse(res.text).usage.input_tokens, input);
    if (stream && route.endsWith('messages')) {
      const events = res.text.split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
      assert.equal(events.find(e => e.type === 'message_delta').usage.input_tokens, input);
    }
  });
}

const validManifest = { ...MANIFEST, version: '99.0.0' };
function entries(manifest = validManifest) {
  return ['ghost.json', 'main.js', 'panel.js', 'panel.html', 'node/worker.cjs', 'node/adapters.cjs', 'node/update.cjs', ...(IS_TRAE ? ['node/trae.cjs'] : [])]
    .map(name => ({ name, data: Buffer.from(name === 'ghost.json' ? JSON.stringify(manifest) : 'fixture') }));
}
const expected = { id: MANIFEST.id, version: '99.0.0', currentVersion: MANIFEST.version, required: ['node/adapters.cjs', 'node/update.cjs', ...(IS_TRAE ? ['node/trae.cjs'] : [])] };
// Small ZIP writer for controlled updater fixtures (stored entries, valid CRC).
function zip(list) {
  const local = [], central = []; let offset = 0;
  for (const { name, data } of list) {
    const n = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt32LE(crc,14);
    h.writeUInt32LE(data.length,18); h.writeUInt32LE(data.length,22); h.writeUInt16LE(n.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt32LE(crc,16);
    c.writeUInt32LE(data.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(n.length,28); c.writeUInt32LE(offset,42);
    local.push(h,n,data); central.push(c,n); offset += h.length+n.length+data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(list.length,8);
  end.writeUInt16LE(list.length,10); end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}
function prepareUpdate(w, list) {
  const bytes = zip(list); w.ctx.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes });
  w.ctx.asset = { name: 'fixture.cindy', url: 'https://invalid.example/fixture', size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') };
  w.run(`checkUpdate=async()=>({current:'${MANIFEST.version}',latest:'99.0.0',hasUpdate:true,asset})`);
}

test('valid package belongs to this plugin', () => { assert.equal(updater.validatePackage(entries(), expected).id, MANIFEST.id); });
for (const [label, alter] of [
  ['wrong id', () => entries({ ...validManifest, id: 'another-plugin' })],
  ['wrong version', () => entries({ ...validManifest, version: '0.0.1' })],
  ['non-JSON manifest', () => entries().map(e => e.name === 'ghost.json' ? { ...e, data: Buffer.from('not JSON') } : e)],
  ['missing main', () => entries().filter(e => e.name !== 'main.js')],
  ['missing worker', () => entries().filter(e => e.name !== 'node/worker.cjs')],
  ['invalid declared entry', () => entries({ ...validManifest, entry: '../outside.js' })],
]) {
  test(`updater refuses ${label} before launching installer`, async () => {
    const w = worker(); prepareUpdate(w, alter());
    await assert.rejects(w.run('applyUpdate()'));
    assert.equal(w.launches.length, 0); assert.equal(w.exits.length, 0);
  });
}
for (const code of ['ENOENT', 'EACCES']) test(`installer ${code} leaves worker running and cleans staging`, async () => {
  const w = worker({ spawnError: Object.assign(new Error(code), { code }) }); prepareUpdate(w, entries());
  await assert.rejects(w.run('applyUpdate()'), new RegExp(code));
  assert.equal(w.launches.length, 1); assert.equal(w.exits.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), []);
});
test('successful spawn schedules exit only after start and uses fresh staging', async () => {
  const w = worker(); prepareUpdate(w, entries());
  const first = await w.run('applyUpdate()'), second = await w.run('applyUpdate()');
  assert.equal(first.applied, true); assert.equal(w.exits.length, 2);
  assert.notEqual(first.scriptPath, second.scriptPath);
});
test('release selection uses exact plugin package name', async () => {
  const w = worker();
  w.ctx.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.0', assets: [
    { name: 'unrelated.cindy', browser_download_url: 'wrong' },
    { name: IS_TRAE ? 'trae-cindy-bridge.cindy' : 'cindy-qoder-bridge.cindy', browser_download_url: 'right' },
  ] }) });
  assert.equal((await w.run('checkUpdate()')).asset.url, 'right');
});

if (IS_TRAE) {
  const future = () => Date.now() + 3600000;
  test('renewed credential survives force refresh and cache expiry; login changes and logout still work', async () => {
    let disk = { token: 'old', refreshToken: 'R0', expiresAtMs: 1, userId: 'A' }, calls = 0;
    const w = worker({ trae: {
      readTraeCredential: () => disk ? { ok: true, credential: { ...disk }, identity: { storagePath: 'same-storage' } } : { ok: false },
      async refreshAccessToken(c) { calls++; assert.equal(c.refreshToken, 'R0'); assert.equal(calls, 1); return { token: 'new', refreshToken: 'R1', expiresAtMs: future() }; },
    } });
    await w.run('refreshCredential(true)'); await w.run('refreshCredential(true)');
    w.run('credentialAt=0'); await w.run('refreshCredential(false)');
    assert.equal(w.run('credential.token'), 'new'); assert.equal(w.run('credential.refreshToken'), 'R1'); assert.equal(calls, 1);
    disk = { token: 'disk-new', refreshToken: 'R2', expiresAtMs: future(), userId: 'A' };
    await w.run('refreshCredential(true)'); assert.equal(w.run('credential.token'), 'disk-new');
    disk = { token: 'B', refreshToken: 'RB', expiresAtMs: future(), userId: 'B' };
    await w.run('refreshCredential(true)'); assert.equal(w.run('credential.userId'), 'B');
    disk = null; await w.run('refreshCredential(true)'); assert.equal(w.run('credential'), undefined);
  });
  test('late renewal cannot overwrite a different login', async () => {
    let disk = { token: 'A', refreshToken: 'RA', expiresAtMs: future(), userId: 'A' }, finish;
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { ...disk }, identity: { storagePath: 'same-storage' } }),
      refreshAccessToken: () => new Promise(resolve => { finish = resolve; }),
    } });
    await w.run('refreshCredential(true)'); const pending = w.run("renewCredential('fixture')");
    disk = { token: 'B', refreshToken: 'RB', expiresAtMs: future(), userId: 'B' }; await w.run('refreshCredential(true)');
    finish({ token: 'late-A', refreshToken: 'RA2', expiresAtMs: future() });
    assert.equal(await pending, false); assert.equal(w.run('credential.token'), 'B');
  });
  test('same-generation concurrent renewals share one exchange', async () => {
    let finish, calls = 0;
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { token: 'A', refreshToken: 'RA', expiresAtMs: future() }, identity: {} }),
      refreshAccessToken: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    } });
    await w.run('refreshCredential(true)'); const a = w.run("renewCredential('a')"), b = w.run("renewCredential('b')");
    finish({ token: 'new', refreshToken: 'R2', expiresAtMs: future() }); await Promise.all([a, b]);
    assert.equal(calls, 1); assert.equal(w.run('credential.token'), 'new');
  });
}
