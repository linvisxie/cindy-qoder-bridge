// 0.1.9 七项体验补齐的离线验收：日志落盘、本地用量账本、状态新字段、错误码人话。
// 真起 worker（独立端口 + 临时数据目录），全程走真 HTTP。
//
// 0.1.10 起 /healthz 只剩最小集（ok / port / modelCount），完整状态改到带鉴权的
// GET /status。预置一次性随机 token，只以带鉴权的 /status 确认本次 worker 就绪。
// 这是完全隔离的离线测试，禁止登录态和任何 live 模型请求。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const net = require('node:net');
const { randomBytes } = require('node:crypto');

let PORT;
const WORKER = path.join(__dirname, '..', 'plugin', 'node', 'bootstrap.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}${extra !== undefined ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  got=' + extra : ''}`); }
}
function skip(name, why) {
  console.log(`  --   ${name}（跳过：${why}）`);
}

function request(method, p, body, token, timeout = 90000) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        host: '127.0.0.1',
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); } catch { return {}; }
}

async function reservePort() {
  const requested = process.env.FEATURES_PORT === undefined ? 0 : Number(process.env.FEATURES_PORT);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error('Invalid FEATURES_PORT');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-features-'));
  const dataDir = path.join(root, 'data');
  const token = randomBytes(32).toString('hex');
  let child;
  let stopped;
  let ended = false;
  let childFailure;
  const assertAlive = () => {
    if (childFailure) throw new Error(childFailure);
    if (ended) throw new Error('worker exited unexpectedly');
  };
  try {
  PORT = await reservePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(XDG_|APPDATA$|LOCALAPPDATA$|USERPROFILE$|HOME$|HOMEDRIVE$|HOMEPATH$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  }
  const dirs = {
    APPDATA: 'roaming', LOCALAPPDATA: 'local', USERPROFILE: 'home', HOME: 'home',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'share', XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'run',
    XDG_CONFIG_DIRS: 'config-dirs', XDG_DATA_DIRS: 'data-dirs',
    TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp',
  };
  for (const [key, dir] of Object.entries(dirs)) {
    env[key] = path.join(root, dir);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.HOMEDRIVE = path.parse(env.HOME).root.replace(/[\\/]$/, '');
  env.HOMEPATH = env.HOME.slice(env.HOMEDRIVE.length);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ token }), { mode: 0o600 });
  Object.assign(env, { CINDY_QODER_DATA: dataDir, CINDY_QODER_PORT: String(PORT) });
  child = spawn(process.execPath, [WORKER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  stopped = new Promise((resolve) => {
    child.once('error', (err) => { childFailure = `worker startup failed: ${err.message}`; ended = true; resolve(); });
    child.once('exit', (code, signal) => {
      childFailure = `worker exited: code=${code}, signal=${signal}`;
      ended = true;
      resolve();
    });
  });
  // Never print worker output: authenticated status (and diagnostics) may contain tokens.
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});

  let ready = false;
  for (let i = 0; i < 160; i++) {
    assertAlive();
    const r = await request('GET', '/status', undefined, token, 1500);
    assertAlive();
    if (r.status === 200) {
      const s = JSON.parse(r.text);
      if (s.token !== token || s.port !== PORT || s.logFile !== path.join(dataDir, 'bridge.log')) {
        throw new Error('Authenticated status does not identify our worker');
      }
      if (s.signedIn !== false) throw new Error('Offline isolation failed: worker is signed in');
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('worker startup timed out (no authenticated status from our worker)');
  const healthRes = await request('GET', '/healthz');
  const health = JSON.parse(healthRes.text);

  console.log('\n--- /healthz 最小集（不泄露本地 Token）---');
  ok('healthz 只有 ok/port/modelCount', JSON.stringify(Object.keys(health).sort()) === '["modelCount","ok","port"]', JSON.stringify(Object.keys(health)));
  ok('healthz 不带 token', health.token === undefined);
  ok('healthz 不带用户账号', health.user === undefined);
  ok('portIsOurs 需要的三个字段都在', health.ok === true && typeof health.port === 'number' && 'modelCount' in health);

  ok('state.json 保留本次随机本地 token', readState(dataDir).token === token);

  console.log('\n--- /status 需要鉴权 ---');
  const anon = await request('GET', '/status');
  ok('无 token 打 /status 回 401', anon.status === 401, anon.status);
  let anonBody = {};
  try { anonBody = JSON.parse(anon.text); } catch {}
  ok('401 的提示是中文', /[\u4e00-\u9fa5]/.test(anonBody?.error?.message || ''), anonBody?.error?.message);

  const statusRes = await request('GET', '/status', undefined, token);
  ok('带 token 打 /status 回 200', statusRes.status === 200, statusRes.status);
  let status = {};
  try { status = JSON.parse(statusRes.text); } catch {}
  if (status.signedIn !== false) throw new Error('Offline isolation failed: worker is signed in');
  ok('离线测试未登录（禁止 live 模型请求）', status.signedIn === false);
  ok('/v1/status 也能取到完整状态', (await request('GET', '/v1/status', undefined, token)).status === 200);

  console.log('\n--- 状态对象新字段 ---');
  ok('status 带 usage', status.usage !== undefined, typeof status.usage);
  ok('status 带 checkin', status.checkin !== undefined, JSON.stringify(status.checkin).slice(0, 120));
  ok('status 带 localUsage', status.localUsage !== undefined && status.localUsage.today !== undefined);
  ok('status 带 logFile', typeof status.logFile === 'string' && status.logFile.endsWith('bridge.log'), status.logFile);
  ok('checkin 带下次开轮时间', Number.isFinite(Number(status.checkin.nextAt)), new Date(status.checkin.nextAt).toISOString());
  // 未登录时 refreshUsage 走的是 error 分支，只写 { at, error }，压根没有这两个键，
  // 所以只能在登录态下硬断言，否则离线跑测试必挂（issue #8）。
  skip('额度重置/会员到期字段存在（可为空）', '离线测试禁止登录/上游请求');

  console.log('\n--- 日志落盘 ---');
  const logPath = path.join(dataDir, 'bridge.log');
  ok('bridge.log 已创建', fs.existsSync(logPath), logPath);
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  ok('日志有内容', logText.length > 0, logText.length + ' 字节');
  ok('日志行带 ISO 时间戳', /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[qoder-bridge\]/m.test(logText), (logText.split('\n')[0] || '').slice(0, 60));
  ok('日志里有监听得端口记录', /已在 127\.0\.0\.1:\d+ 监听/.test(logText));

  console.log('\n--- 模型倍率与档位 ---');
  const modelsRes = await request('GET', '/v1/models', undefined, token);
  let models = [];
  try { models = (JSON.parse(modelsRes.text).data) || []; } catch {}
  // 200 是接口能用，跟登没登录无关，硬断言；有模型才继续（issue #8）。
  ok('/v1/models 可用', modelsRes.status === 200, modelsRes.status);
  if (!models.length) {
    skip('模型列表非空', '/v1/models 返回 0 个（多半是没登录 Qoder）');
    skip('倍率/档位相关断言', '/v1/models 空（多半是没登录 Qoder）');
  } else {
    const withFactor = models.filter((m) => m.price_factor !== undefined);
    ok('每个模型都带 price_factor', withFactor.length === models.length, withFactor.length + '/' + models.length);
    const labelHasFactor = models.filter((m) => /· (免费|x[\d.]+)/.test(m.name || ''));
    ok('name 里带倍率或「免费」', labelHasFactor.length === models.length, (models[0] || {}).name);
    const withEffort = models.filter((m) => Array.isArray(m.reasoning?.supported_efforts) && m.reasoning.supported_efforts.length > 0);
    ok('推理模型带档位列表', withEffort.length > 0, withEffort.length + ' 个带档位');
  }

  const target = models.find((m) => (m.reasoning?.supported_efforts || []).length > 0) || models[0];
  console.log('\n--- 离线模式：0 upstream，禁止 live 模型请求 ---');
  skip('真实 chat / 上游兜底 / 请求记账', '此测试只允许离线验收，不存在 live 分支');
  ok('离线账本没有模型请求', status.localUsage.today.requests === 0, status.localUsage.today.requests);

  console.log('\n--- 未登录也能验的输入校验 ---');
  // 鉴权失败这条路必须是中文人话
  const noTok = await request('POST', '/v1/chat/completions', {
    model: target ? target.id : 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
  });
  ok('无 token 回 401', noTok.status === 401, noTok.status);
  let noTokBody = {};
  try { noTokBody = JSON.parse(noTok.text); } catch {}
  ok('401 的提示是中文', /[\u4e00-\u9fa5]/.test(noTokBody?.error?.message || ''), noTokBody?.error?.message);

  // 畸形请求体：以前一律 500，现在应是 400
  const broken = await request('POST', '/v1/chat/completions', undefined, token);
  ok('空 body 打 chat 回 400 而不是 500', broken.status === 400, broken.status);

  // 三条协议对畸形 tool 输入都该在查登录态之前回 400（issue #3）
  const malformed = [
    ['chat', '/v1/chat/completions', { model: 'auto', messages: [{ role: 'tool', content: 'x' }] }],
    ['anthropic', '/v1/messages', { model: 'auto', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }],
    ['responses', '/v1/responses', { model: 'auto', input: [{ type: 'function_call_output', output: 'x' }] }],
  ];
  for (const [name, p, body] of malformed) {
    const r = await request('POST', p, body, token);
    ok(`${name} 畸形 tool 输入回 400`, r.status === 400, r.status);
    let b = {};
    try { b = JSON.parse(r.text); } catch {}
    ok(`${name} 的报错说明了哪里不对`, /请求格式不对/.test(b?.error?.message || ''), (b?.error?.message || '').slice(0, 60));
  }

  // 上游错误帧的人工化映射：直接按 worker 的映射表校对（同一份规则文件里）
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'node', 'worker.cjs'), 'utf8');
  ok('映射表覆盖登录失效', /Qoder 登录失效了/.test(src));
  ok('映射表覆盖每日账单上限', /每日账单上限|账单上限/.test(src));
  ok('映射表覆盖排队', /排队/.test(src));
  ok('映射表覆盖连不上', /连不上 Qoder/.test(src));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  assertAlive();
  process.exitCode = fail ? 1 : 0;
  } finally {
    // Only terminate the ChildProcess we spawned; never inspect/kill a port owner.
    if (child && !ended) {
      child.kill();
      let timer;
      await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (!ended) {
        child.kill('SIGKILL');
        await stopped;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.log('FAIL: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
