'use strict';

// 三条协议路由的实机冒烟：真的起 worker，真的向上游要一次回复。
// 用法：node test/smoke-protocols.js [模型 id]
// 默认用 qfmodel（免费、快）。只验证协议形状，不校验模型说了什么。

const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const WORKER = join(__dirname, '..', 'plugin', 'node', 'worker.cjs');
const MODEL = process.argv[2] || 'qfmodel';

const dir = mkdtempSync(join(os.tmpdir(), 'qoder-smoke-'));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'state.json'), JSON.stringify({ port: 47951 }));

const child = spawn(process.execPath, [WORKER], {
  // 0.1.7 起端口咬死 PREFERRED_PORT，测试必须显式指定，否则会去抢真身占着的 47821
  env: { ...process.env, CINDY_QODER_DATA: dir, CINDY_QODER_PORT: '47951' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[worker] ' + d.toString()));

let seq = 0;
function rpc(method, params) {
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('rpc timeout: ' + method)); } }, 60000);
  });
}

function unwrap(msg) {
  const outer = msg.result;
  if (!outer) throw new Error('空回包');
  if (outer.ok === false) throw new Error(outer.message || 'worker 失败');
  return outer.result !== undefined ? outer.result : outer;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + String(detail).slice(0, 160) : ''}`);
}

function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const t = block.trim();
    if (!t) continue;
    let evt = null;
    const dataLines = [];
    for (const line of t.split('\n')) {
      if (line.startsWith('event: ')) evt = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    out.push({ event: evt, data });
  }
  return out;
}

(async () => {
  try {
    const boot = await rpc('qoder/boot', {});
    const st = unwrap(boot);
    check('worker 起来了并已登录', st.signedIn === true, st.user);
    const base = 'http://127.0.0.1:' + st.port;
    const token = st.token;
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

    // ---- Anthropic /v1/messages（流式）----
    let r = await fetch(base + '/v1/messages', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: MODEL, max_tokens: 64, stream: true,
        system: '用一句话回答。',
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      }),
    });
    check('POST /v1/messages 200', r.status === 200, r.status);
    let text = await r.text();
    let evts = parseSse(text);
    const types = evts.map((e) => e.event);
    check('message_start 在首位', types[0] === 'message_start', types[0]);
    check('有 message_stop', types.includes('message_stop'));
    check('有 content_block_delta 文本', evts.some((e) => e.event === 'content_block_delta' && e.data.delta
      && (typeof e.data.delta.text === 'string' || typeof e.data.delta.thinking === 'string')));
    check('stop_reason 合法', evts.some((e) => e.event === 'message_delta'
      && ['end_turn', 'max_tokens', 'tool_use'].includes(e.data.delta && e.data.delta.stop_reason)),
      (evts.find((e) => e.event === 'message_delta') || {}).data
        && JSON.stringify(evts.find((e) => e.event === 'message_delta').data.delta));

    // ---- Anthropic /v1/messages（非流式）----
    r = await fetch(base + '/v1/messages', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: MODEL, max_tokens: 64, stream: false,
        messages: [{ role: 'user', content: '说一句你好' }],
      }),
    });
    const msg = await r.json().catch(() => null);
    check('POST /v1/messages stream=false 返回 message', msg && msg.type === 'message', msg && msg.type);
    check('非流式 content 是非空数组', msg && Array.isArray(msg.content) && msg.content.length > 0,
      msg && msg.content && msg.content.length);

    // ---- Anthropic count_tokens ----
    r = await fetch(base + '/v1/messages/count_tokens', {
      method: 'POST', headers: H,
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '一二三四五六七八九十' }] }),
    });
    const ct = await r.json().catch(() => null);
    check('count_tokens 返回正整数', ct && Number.isInteger(ct.input_tokens) && ct.input_tokens > 0,
      ct && ct.input_tokens);

    // ---- Responses /v1/responses（流式）----
    r = await fetch(base + '/v1/responses', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: MODEL, stream: true, max_output_tokens: 64,
        instructions: '用一句话回答。',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
      }),
    });
    check('POST /v1/responses 200', r.status === 200, r.status);
    text = await r.text();
    evts = parseSse(text);
    const rtypes = evts.map((e) => e.event);
    check('response.created 在首位', rtypes[0] === 'response.created', rtypes[0]);
    check('有 response.completed', rtypes.includes('response.completed'));
    check('有 output_text.delta 或 reasoning', evts.some((e) => e.event === 'response.output_text.delta'));
    const done = evts.find((e) => e.event === 'response.completed');
    check('completed.response.status=completed', done && done.data.response && done.data.response.status === 'completed');
    check('completed 有 usage.total_tokens', done && done.data.response && done.data.response.usage
      && Number.isInteger(done.data.response.usage.total_tokens));

    // ---- Responses 非流式 ----
    r = await fetch(base + '/v1/responses', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: MODEL, stream: false, max_output_tokens: 64,
        input: '说一句你好',
      }),
    });
    const resp = await r.json().catch(() => null);
    check('POST /v1/responses stream=false 返回 response', resp && resp.object === 'response', resp && resp.object);
    check('非流式 output 是数组', resp && Array.isArray(resp.output), resp && resp.output && resp.output.length);

    // ---- 鉴权仍生效 ----
    r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('/v1/messages 无 token 401', r.status === 401, r.status);
    r = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('/v1/responses 无 token 401', r.status === 401, r.status);

    const bad = results.filter((x) => !x.ok);
    console.log(`\n${results.length - bad.length} 通过 ${bad.length} 失败`);
    process.exitCode = bad.length ? 1 : 0;
  } catch (e) {
    console.error('冒烟异常：', e.message);
    process.exitCode = 1;
  } finally {
    child.stdin.end();
    setTimeout(() => { try { child.kill(); } catch {} }, 200);
  }
})();
