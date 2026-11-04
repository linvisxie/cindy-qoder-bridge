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

// ---------- 错误状态只写不清（2026-11-04 线上看到的那条红字） ----------
// 现象：worker 启动时后台补额度失败一次，之后即使刷新成功，「额度读取失败」仍永久挂在
// 面板和状态文本上。原因是 lastError 只有赋值、从没清空。
// 这里钉住的是：成功刷新必须按来源清掉自己的失败，且不同来源互不误清。
// qoder 的额度走真实 fetch（openApiGet），所以注入全局 fetch 就能控制成败。
{
  // 假响应必须和真实 Response 一样：text() 是**函数**，openApiGet 会 await 它。
  const okBody = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ qoderUsage: { userQuota: { total: 2000, used: 743 } } }) });
  const failRes = () => ({ ok: false, status: 500, text: async () => '', json: null });

  function quotaWorker(state) {
    const w = worker();
    w.run(`token='local-test';refreshCredential=async()=>({token:'fixture'});
      globalThis.__mode = ${JSON.stringify(state.mode)};
      globalThis.__okBody = ${okBody.toString()};
      globalThis.__failRes = ${failRes.toString()};`);
    w.ctx.fetch = async () => (w.run('__mode') === 'fail' ? w.run('__failRes()') : w.run('__okBody()'));
    return w;
  }

  test('a later successful usage refresh clears the earlier usage error', async () => {
    const w = quotaWorker({ mode: 'fail' });
    await w.run("refreshUsage(true)");
    assert.match(w.run('lastErrorText()'), /额度读取失败/);
    w.run("__mode='ok'");
    await w.run("refreshUsage(true)");
    assert.equal(w.run('lastErrorText()'), '');
    assert.equal((await w.run('buildStatus()')).lastError, '');
  });

  test('a successful model refresh does not clear a usage error, and vice versa', async () => {
    const w = quotaWorker({ mode: 'fail' });
    await w.run("refreshUsage(true)");
    assert.match(w.run('lastErrorText()'), /额度读取失败/);
    w.run("setError('models','模型目录刷新失败：boom')");
    w.run("setError('usage',null)");                       // 只清额度那条
    assert.match(w.run('lastErrorText()'), /模型目录刷新失败/);
    assert.equal(Boolean(w.run('errors.usage')), false);
    assert.equal(Boolean(w.run('errors.models')), true);
  });

  test('the error text says how long ago it happened', async () => {
    const w = worker();
    w.run("setError('usage','额度读取失败：fetch failed')");
    assert.match(w.run('lastErrorText()'), /秒前/);
    w.run("errors.usage.at = Date.now() - 5 * 60 * 1000");
    assert.match(w.run('lastErrorText()'), /5 分钟前/);
    w.run("errors.usage.at = Date.now() - 3 * 3600 * 1000");
    assert.match(w.run('lastErrorText()'), /3 小时前/);
  });

  test('stale quota is flagged so an old number cannot pass for the current one', async () => {
    const w = quotaWorker({ mode: 'ok' });
    await w.run("refreshUsage(true)");
    assert.equal((await w.run('buildStatus()')).quotaStale, false);
    w.run("__mode='fail'");
    await w.run("refreshUsage(true)");
    assert.equal((await w.run('buildStatus()')).quotaStale, true);
  });
}

// ---------- 缓存与推理明细被写死成 0（2026-11-04 面板命中率恒为 0%） ----------
// 现象：Cindy 里缓存读/写恒 0、命中率 0%，看着像上游没缓存。实际是适配层把
// prompt_tokens_details.cached_tokens 和 completion_tokens_details.reasoning_tokens
// 写死了，上游真值被丢掉。实测上游给的是 cached=1792 / prompt=2034。
{
  const adapters = require('../plugin/node/adapters.cjs');
  const UPSTREAM = {
    prompt_tokens: 2034, completion_tokens: 11,
    prompt_tokens_details: { cached_tokens: 1792 },
    completion_tokens_details: { reasoning_tokens: 9 },
  };

  test('responses usage passes upstream cached and reasoning tokens through', () => {
    const u = adapters.responsesUsage(UPSTREAM, 0);
    assert.equal(u.input_tokens, 2034);
    assert.equal(u.input_tokens_details.cached_tokens, 1792);
    assert.equal(u.output_tokens_details.reasoning_tokens, 9);
    assert.equal(u.total_tokens, 2045);
  });

  // ---- Anthropic usage 的 input_tokens 语义 ----
  //
  // OpenAI 的 prompt_tokens 是「输入总量」，**包含**命中缓存的部分；
  // Anthropic 的 input_tokens 是「没走缓存的部分」。Cindy 算命中率用
  //   read / (input_tokens + read + write)
  // 如果把 prompt_tokens 直接当 input_tokens 发，缓存 token 会在分子分母各算一次。
  // 实测 2355/2361（真实 99.75%）会被算成 49.94%——这正是「读有值、命中率却很低」的元凶。

  test('anthropic input_tokens excludes the cached part (no double counting)', () => {
    const u = adapters.anthropicUsage(UPSTREAM, 0);
    // UPSTREAM: prompt_tokens=2034, cached_tokens=1792
    assert.equal(u.input_tokens, 2034 - 1792);
    assert.equal(u.output_tokens, 11);
    assert.equal(u.cache_read_input_tokens, 1792);
  });

  test('anthropic hit rate computed the way Cindy does matches the real one', () => {
    // 复现实测到的数字：prompt=2361, read=2355
    const usage = { prompt_tokens: 2361, completion_tokens: 18, prompt_tokens_details: { cached_tokens: 2355 } };
    const u = adapters.anthropicUsage(usage, 0);
    const cindyRate = u.cache_read_input_tokens / (u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens);
    const realRate = 2355 / 2361;
    assert.equal(Number(cindyRate.toFixed(4)), Number(realRate.toFixed(4)));
    // 旧写法会得到 49.94%，钉死这个数防止回退
    assert.notEqual(Number((cindyRate * 100).toFixed(2)), 49.94);
  });

  test('anthropic subtracts cache write as well as cache read', () => {
    const withWrite = {
      prompt_tokens: 2034, completion_tokens: 11,
      prompt_tokens_details: { cached_tokens: 1792, cache_write_tokens: 240 },
    };
    const au = adapters.anthropicUsage(withWrite, 0);
    assert.equal(au.input_tokens, 2034 - 1792 - 240);
    assert.equal(au.cache_read_input_tokens, 1792);
    assert.equal(au.cache_creation_input_tokens, 240);
  });

  test('anthropic input_tokens never goes negative', () => {
    // 上游计价口径边界上偶尔 cached + write 会略大于 prompt
    const odd = { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 40 } };
    assert.equal(adapters.anthropicUsage(odd, 0).input_tokens, 0);
  });

  test('anthropic always emits both cache fields so Cindy sees usage as complete', () => {
    // Cindy 用 hasOwnProperty 检查四个字段，缺一个就 complete=false，
    // 那一轮会被当成未结算，连命中率都不显示。
    const bare = { prompt_tokens: 100, completion_tokens: 5 };
    const a = adapters.anthropicUsage(bare, 0);
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      assert.ok(Object.prototype.hasOwnProperty.call(a, k), 'anthropic usage 缺字段: ' + k);
    }
    assert.equal(a.cache_read_input_tokens, 0);
    assert.equal(a.cache_creation_input_tokens, 0);
  });

  test('responses keeps prompt_tokens as input_tokens (different semantics)', () => {
    // Responses 这边 Cindy 把 input_tokens 当总量、明细另放 input_tokens_details，
    // 所以**不能**减，减了反而少算。
    const u = adapters.responsesUsage(UPSTREAM, 0);
    assert.equal(u.input_tokens, 2034);
    assert.equal(u.input_tokens_details.cached_tokens, 1792);
    assert.equal(u.output_tokens_details.reasoning_tokens, 9);
  });

  test('missing cache detail falls back to 0 instead of undefined', () => {
    const bare = { prompt_tokens: 100, completion_tokens: 5 };
    assert.equal(adapters.responsesUsage(bare, 0).input_tokens_details.cached_tokens, 0);
    assert.equal(adapters.responsesUsage(bare, 0).output_tokens_details.reasoning_tokens, 0);
    assert.deepEqual(adapters.census(null), { cached: 0, written: 0, reasoning: 0 });
  });

  test('cache write tokens are carried through to both protocols', () => {
    const withWrite = {
      prompt_tokens: 2034, completion_tokens: 11,
      prompt_tokens_details: { cached_tokens: 1792, cache_write_tokens: 240 },
      completion_tokens_details: { reasoning_tokens: 9 },
    };
    const ru = adapters.responsesUsage(withWrite, 0);
    assert.equal(ru.input_tokens_details.cached_tokens, 1792);
    assert.equal(ru.input_tokens_details.cache_write_tokens, 240);
    const au = adapters.anthropicUsage(withWrite, 0);
    assert.equal(au.cache_read_input_tokens, 1792);
    assert.equal(au.cache_creation_input_tokens, 240);
  });

  test('cache_creation_tokens is accepted as an alias', () => {
    const alias = { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_creation_tokens: 80 } };
    assert.equal(adapters.census(alias).written, 80);
    const noWrite = { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } };
    assert.equal(adapters.census(noWrite).written, 0);
    // responses 侧没写就不编一个字段出来
    assert.equal(adapters.responsesUsage(noWrite, 0).input_tokens_details.cache_write_tokens, undefined);
  });

  test('a real zero cache hit stays zero and is not treated as missing', () => {
    const noHit = {
      prompt_tokens: 50, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
    assert.equal(adapters.responsesUsage(noHit, 0).input_tokens_details.cached_tokens, 0);
    assert.equal(adapters.anthropicUsage(noHit, 0).cache_read_input_tokens, 0);
  });

}

// Third review: malformed successful HTTP responses must preserve the last quota.
for (const bad of ['not JSON', '{}', '{"code":"TOKEN_EXPIRED"}', '{"success":false}']) {
  test(`invalid quota payload preserves old value: ${bad}`, async () => {
    const w = worker();
    w.run("refreshCredential=async()=>({token:'fixture'})");
    const good = IS_TRAE ? {usage_summary:{total_amount:2000,consumed_amount:743}} : {userQuota:{total:2000,used:743}};
    let body=JSON.stringify(good);
    const fake=async()=>new Response(body,{status:200});
    const original=global.fetch;
    try {
      if(IS_TRAE) global.fetch=fake; else w.ctx.fetch=fake;
      await w.run('refreshUsage(true)'); assert.equal(w.run('lastQuota.total'),2000);assert.equal(w.run('lastQuota.used'),743);
      w.run("setError('models','model failure')");
      body=bad;await w.run('refreshUsage(true)');
      assert.equal(w.run('lastQuota.total'),2000);assert.equal(w.run('lastQuota.used'),743);assert.equal(w.run('lastQuota.stale'),true);assert.ok(w.run('errors.usage'));
      body=JSON.stringify(good);await w.run('refreshUsage(true)');
      assert.equal(Boolean(w.run('lastQuota.stale')),false);assert.equal(Boolean(w.run('errors.usage')),false);assert.ok(w.run('errors.models'));
    } finally {global.fetch=original;}
  });
}
test('explicit zero quota remains a successful response',async()=>{
 const w=worker();w.run("refreshCredential=async()=>({token:'fixture'})");const original=global.fetch;
 const fake=async()=>new Response(JSON.stringify(IS_TRAE?{usage_summary:{total_amount:0,consumed_amount:0}}:{userQuota:{total:0,used:0}}));
 try{if(IS_TRAE)global.fetch=fake;else w.ctx.fetch=fake;await w.run('refreshUsage(true)');assert.equal(w.run('lastQuota.total'),0);assert.equal(Boolean(w.run('errors.usage')),false);}finally{global.fetch=original;}
});
if(!IS_TRAE)test('invalid presentation falls back to a valid legacy quota',async()=>{
 const w=worker();w.run("refreshCredential=async()=>({token:'fixture'})");let calls=0;
 w.ctx.fetch=async()=>new Response(JSON.stringify(++calls===1?{code:'TOKEN_EXPIRED'}:{userQuota:{total:2000,used:800}}));
 await w.run('refreshUsage(true)');assert.equal(calls,2);assert.equal(w.run('lastQuota.used'),800);assert.equal(w.run('lastUsage.source'),'quota/usage');
});
if(IS_TRAE){
 for(const reason of ['no-auth-key','not-found'])test(`automatic credential refresh clears ${reason} without renewing`,async()=>{
  let missing=false,calls=0;
  const w=worker({trae:{readTraeCredential:()=>missing?{ok:false,reason}:{ok:true,credential:{token:'A',refreshToken:'R',expiresAtMs:Date.now()+3600000},identity:{}},refreshAccessToken:async()=>{calls++;throw Error('must not renew');}}});
  await w.run('refreshCredential(true)');missing=true;w.run('credentialAt=0;credential.expiresAtMs=1');
  assert.equal(await w.run('refreshCredential(false)'),undefined);assert.equal(calls,0);assert.equal(w.run('identity'),undefined);
 });
 test('automatic logout invalidates an in-flight renewal',async()=>{
  let missing=false,finish;
  const w=worker({trae:{readTraeCredential:()=>missing?{ok:false,reason:'no-auth-key'}:{ok:true,credential:{token:'A',refreshToken:'R',expiresAtMs:Date.now()+3600000},identity:{}},refreshAccessToken:()=>new Promise(r=>{finish=r})}});
  await w.run('refreshCredential(true)');const pending=w.run("renewCredential('test')");missing=true;w.run('credentialAt=0');await w.run('refreshCredential(false)');finish({token:'late',expiresAtMs:Date.now()+3600000});assert.equal(await pending,false);assert.equal(w.run('credential'),undefined);
 });
 test('temporary read failure retains an unexpired credential',async()=>{
  let broken=false;
  const w=worker({trae:{readTraeCredential:()=>broken?{ok:false,reason:'decrypt-failed'}:{ok:true,credential:{token:'A',expiresAtMs:Date.now()+3600000},identity:{}}}});
  await w.run('refreshCredential(true)');broken=true;w.run('credentialAt=0');assert.equal((await w.run('refreshCredential(false)')).token,'A');
 });
}
