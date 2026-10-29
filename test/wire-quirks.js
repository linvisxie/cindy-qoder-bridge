// 覆盖 Cindy 侧两个「线上怪癖」：
// 1) 供应商 Base URL 带 /v1，经 anthropic-compat-proxy 后会拼成 /v1/v1/messages；
// 2) 上下文 ≥1M 时 Cindy 把模型 id 编成 `qfmodel[1m]` 发给上游。
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const http = require('node:http');

const WORKER = join(__dirname, '..', 'plugin', 'node', 'worker.cjs');
const PORT = 47961;
// 默认用免费模型；想换：node test/wire-quirks.js <模型 id>
const MODEL = process.argv[2] || 'qfmodel';
const dir = mkdtempSync(join(os.tmpdir(), 'qoder-wire-'));
writeFileSync(join(dir, 'state.json'), JSON.stringify({ port: PORT }));
const child = spawn(process.execPath, [WORKER], {
  env: { ...process.env, CINDY_QODER_DATA: dir, CINDY_QODER_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = ''; const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[worker] ' + d.toString()));
let seq = 0;
function rpc(method) {
  return new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
  });
}
function post(port, path, token, body) {
  return new Promise((r) => {
    const d = JSON.stringify(body);
    const q = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-length': Buffer.byteLength(d) },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r({ status: res.statusCode, body: b })); });
    q.on('error', (e) => r({ status: 0, body: e.message }));
    q.end(d);
  });
}
const checks = [];
function check(name, ok, got) { checks.push([name, ok, got]); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  → ' + JSON.stringify(got).slice(0, 200))); }

(async () => {
  const st = await rpc('qoder/status');
  const inner = st.result && st.result.result ? st.result.result : st.result;
  const port = inner.port, token = inner.token;
  check('worker 起来了', inner.ok !== false && !!port, port);

  // ---- 1. 重复 /v1 路径折叠 ----
  const msg = { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
  const a = await post(port, '/v1/messages', token, msg);
  check('/v1/messages 正常 200', a.status === 200, a.status);
  const b = await post(port, '/v1/v1/messages', token, msg);
  check('/v1/v1/messages 折叠后 200', b.status === 200, { status: b.status, body: b.body.slice(0, 120) });
  check('/v1/v1/messages 回的是 Anthropic 事件', /message_start/.test(b.body), b.body.slice(0, 80));
  const c = await post(port, '/v1/v1/v1/responses', token, { model: MODEL, input: 'hi', max_output_tokens: 16 });
  check('/v1/v1/v1/responses 也折叠', c.status === 200, c.status);
  const d = await post(port, '/v1/v1/models', null, {});
  check('/v1/v1/models 折叠到 models（GET 才允许，POST 应 404）', d.status === 404, d.status);

  // ---- 2. 模型 id 的 [1m] 后缀 ----
  const e1 = await post(port, '/v1/chat/completions', token, { model: MODEL + '[1m]', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  check('chat 带 [1m] 后缀能识别模型', e1.status === 200, { status: e1.status, body: e1.body.slice(0, 160) });
  const e2 = await post(port, '/v1/messages', token, { model: MODEL + '[1m]', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  check('messages 带 [1m] 后缀能识别模型', e2.status === 200, { status: e2.status, body: e2.body.slice(0, 160) });
  const e3 = await post(port, '/v1/responses', token, { model: MODEL + '[1m]', input: 'hi', max_output_tokens: 16 });
  check('responses 带 [1m] 后缀能识别模型', e3.status === 200, { status: e3.status, body: e3.body.slice(0, 160) });
  const e4 = await post(port, '/v1/chat/completions', token, { model: MODEL.toUpperCase() + '[1M]', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  check('后缀大小写混写也不炸（不要求 200，只要不是 500）', e4.status !== 500, e4.status);

  child.kill();
  const bad = checks.filter((x) => !x[1]).length;
  console.log('\n结果：' + (checks.length - bad) + ' 通过，' + bad + ' 失败');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('崩了：', e); child.kill(); process.exit(1); });
