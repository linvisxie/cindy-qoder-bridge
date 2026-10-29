// 0.1.9 七项体验补齐的离线验收：日志落盘、本地用量账本、状态新字段、错误码人话。
// 真起 worker（独立端口 + 临时数据目录），全程走真 HTTP。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 47981;
const WORKER = path.join(__dirname, '..', 'plugin', 'node', 'worker.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}${extra !== undefined ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  got=' + extra : ''}`); }
}

function request(method, p, body, token) {
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
      timeout: 90000,
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

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-features-'));
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, CINDY_QODER_DATA: dataDir, CINDY_QODER_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stderr.on('data', (c) => logs.push(String(c)));
  child.stdout.on('data', () => {});

  let health = null;
  for (let i = 0; i < 160; i++) {
    const r = await request('GET', '/healthz');
    if (r.status === 200) { health = JSON.parse(r.text); break; }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!health) {
    console.log('FAIL：worker 没起来\n' + logs.join('').slice(-2000));
    child.kill();
    process.exit(1);
  }

  console.log('\n--- 状态对象新字段 ---');
  ok('healthz 带 usage', health.usage !== undefined, typeof health.usage);
  ok('healthz 带 checkin', health.checkin !== undefined, JSON.stringify(health.checkin).slice(0, 120));
  ok('healthz 带 localUsage', health.localUsage !== undefined && health.localUsage.today !== undefined);
  ok('healthz 带 logFile', typeof health.logFile === 'string' && health.logFile.endsWith('bridge.log'), health.logFile);
  ok('checkin 带下次开轮时间', Number.isFinite(Number(health.checkin.nextAt)), new Date(health.checkin.nextAt).toISOString());
  ok('额度重置/会员到期字段存在（可为空）', 'resetAt' in (health.usage || {}) || 'expiresAt' in (health.usage || {}));

  console.log('\n--- 日志落盘 ---');
  const logPath = path.join(dataDir, 'bridge.log');
  ok('bridge.log 已创建', fs.existsSync(logPath), logPath);
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  ok('日志有内容', logText.length > 0, logText.length + ' 字节');
  ok('日志行带 ISO 时间戳', /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[qoder-bridge\]/m.test(logText), (logText.split('\n')[0] || '').slice(0, 60));
  ok('日志里有监听得端口记录', /已在 127\.0\.0\.1:\d+ 监听/.test(logText));

  console.log('\n--- 模型倍率与档位 ---');
  const modelsRes = await request('GET', '/v1/models', undefined, health.token);
  const models = (JSON.parse(modelsRes.text).data) || [];
  ok('/v1/models 可用', modelsRes.status === 200 && models.length > 0, models.length + ' 个');
  const withFactor = models.filter((m) => m.price_factor !== undefined);
  ok('每个模型都带 price_factor', withFactor.length === models.length, withFactor.length + '/' + models.length);
  const labelHasFactor = models.filter((m) => /· (免费|x[\d.]+)/.test(m.name || ''));
  ok('name 里带倍率或「免费」', labelHasFactor.length === models.length, (models[0] || {}).name);
  const withEffort = models.filter((m) => Array.isArray(m.reasoning?.supported_efforts) && m.reasoning.supported_efforts.length > 0);
  ok('推理模型带档位列表', withEffort.length > 0, withEffort.length + ' 个带档位');

  console.log('\n--- 本地用量账本 ---');
  const target = models.find((m) => (m.reasoning?.supported_efforts || []).length > 0) || models[0];
  const chat = await request('POST', '/v1/chat/completions', {
    model: target.id,
    messages: [{ role: 'user', content: '只回两个字：收到' }],
    max_tokens: 16,
  }, health.token);
  ok('真打一次 chat 成功', chat.status === 200, chat.status);

  await new Promise((r) => setTimeout(r, 400));
  const after = JSON.parse((await request('GET', '/healthz')).text);
  ok('usage.json 已生成', fs.existsSync(path.join(dataDir, 'usage.json')));
  ok('今日请求数被记账', after.localUsage.today.requests >= 1, JSON.stringify(after.localUsage.today));
  ok('今日模型明细里有这个模型', Boolean(after.localUsage.today.models?.[target.id]) || Boolean(after.localUsage.week.byModel?.[target.id]),
    JSON.stringify(after.localUsage.week.byModel || {}).slice(0, 120));

  console.log('\n--- 错误码人话 ---');
  // 未知模型 id：Qoder 上游会自己兜底成默认模型，所以这里只要求不炸、不 500
  const bad = await request('POST', '/v1/chat/completions', {
    model: 'this-model-does-not-exist-xyz',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
  }, health.token);
  ok('未知模型不会 500 崩掉', bad.status !== 500, bad.status);
  let badBody = {};
  try { badBody = JSON.parse(bad.text); } catch {}
  if (badBody?.error?.message) {
    ok('上报的错误是中文人话', /[\u4e00-\u9fa5]/.test(badBody.error.message), badBody.error.message.slice(0, 80));
  } else {
    ok('未知模型被上游兜底成正常回复', bad.status === 200, bad.status);
  }

  // 鉴权失败这条路必须是中文人话
  const noTok = await request('POST', '/v1/chat/completions', {
    model: target.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
  });
  ok('无 token 回 401', noTok.status === 401, noTok.status);
  let noTokBody = {};
  try { noTokBody = JSON.parse(noTok.text); } catch {}
  ok('401 的提示是中文', /[\u4e00-\u9fa5]/.test(noTokBody?.error?.message || ''), noTokBody?.error?.message);

  // 上游错误帧的人工化映射：直接按 worker 的映射表校对（同一份规则文件里）
  const src = fs.readFileSync(WORKER, 'utf8');
  ok('映射表覆盖登录失效', /Qoder 登录失效了/.test(src));
  ok('映射表覆盖每日账单上限', /每日账单上限|账单上限/.test(src));
  ok('映射表覆盖排队', /排队/.test(src));
  ok('映射表覆盖连不上', /连不上 Qoder/.test(src));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  child.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch((e) => {
  console.log('FAIL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
