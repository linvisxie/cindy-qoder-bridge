'use strict';

// 工具调用专项冒烟：Anthropic tool_use 与 Responses function_call 两条下行链路。
// 上游是否真回 tool_calls 取决于模型，所以这里只断言「给了工具、链路不炸、形状合法」，
// 如果模型真调了工具，再额外断言参数能解析成 JSON。

const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const WORKER = join(__dirname, '..', 'plugin', 'node', 'worker.cjs');
const MODEL = process.argv[2] || 'qfmodel';

const dir = mkdtempSync(join(os.tmpdir(), 'qoder-tools-'));
writeFileSync(join(dir, 'state.json'), JSON.stringify({ port: 47952 }));

const child = spawn(process.execPath, [WORKER], {
  env: { ...process.env, CINDY_QODER_DATA: dir, CINDY_QODER_PORT: '47952' },
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
function rpc(method) {
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 90000);
  });
}
function unwrap(msg) {
  const o = msg.result;
  if (!o) throw new Error('空回包');
  if (o.ok === false) throw new Error(o.message || 'worker 失败');
  return o.result !== undefined ? o.result : o;
}
function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const t = block.trim();
    if (!t) continue;
    let evt = null;
    const dl = [];
    for (const line of t.split('\n')) {
      if (line.startsWith('event: ')) evt = line.slice(7).trim();
      else if (line.startsWith('data: ')) dl.push(line.slice(6));
    }
    if (!dl.length) continue;
    let data;
    try { data = JSON.parse(dl.join('\n')); } catch { data = dl.join('\n'); }
    out.push({ event: evt, data });
  }
  return out;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  → ' + String(detail).slice(0, 200) : ''}`);
}

const WEATHER = {
  name: 'get_weather',
  description: '查询指定城市的天气',
  input_schema: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
};
const WEATHER_RESP = {
  type: 'function', name: 'get_weather',
  description: '查询指定城市的天气',
  parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
};

(async () => {
  try {
    const st = unwrap(await rpc('qoder/boot'));
    const base = 'http://127.0.0.1:' + st.port;
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token };

    // ---- Anthropic 工具 = 数组形式 ----
    let r = await fetch(base + '/v1/messages', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: MODEL, max_tokens: 256, stream: true, tools: [WEATHER],
        messages: [{ role: 'user', content: '北京今天天气怎么样？用工具查。' }],
      }),
    });
    check('Anthropic 带工具请求 200', r.status === 200, r.status);
    let evts = parseSse(await r.text());
    let starts = evts.filter((e) => e.event === 'content_block_start' && e.data.content_block
      && e.data.content_block.type === 'tool_use');
    let stop = evts.find((e) => e.event === 'message_delta');
    if (starts.length) {
      check('模型真的调了工具（Anthropic）', true, starts.map((s) => s.data.content_block.name).join(','));
      const args = evts.filter((e) => e.event === 'content_block_delta' && e.data.delta && e.data.delta.type === 'input_json_delta')
        .map((e) => e.data.delta.partial_json).join('');
      let parsed = null;
      try { parsed = JSON.parse(args || '{}'); } catch {}
      check('input_json_delta 累积后是合法 JSON', parsed !== null, args);
      check('stop_reason 是 tool_use', stop && stop.data.delta.stop_reason === 'tool_use',
        stop && stop.data.delta && stop.data.delta.stop_reason);
      check('tool_use 块有 id 与 name', starts[0].data.content_block.id && starts[0].data.content_block.name,
        starts[0].data.content_block.id + ' / ' + starts[0].data.content_block.name);
    } else {
      check('模型没调工具但链路未炸（Anthropic）', stop !== undefined, stop && stop.data.delta.stop_reason);
    }

    // ---- Anthropic 工具结果回灌（上一轮的 tool_use 结果喂回去）----
    if (starts.length) {
      const tu = starts[0].data.content_block;
      r = await fetch(base + '/v1/messages', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          model: MODEL, max_tokens: 128, stream: false, tools: [WEATHER],
          messages: [
            { role: 'user', content: '北京今天天气怎么样？用工具查。' },
            { role: 'assistant', content: [{ type: 'tool_use', id: tu.id, name: tu.name, input: { city: '北京' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '晴，18℃' }] },
          ],
        }),
      });
      const m2 = await r.json().catch(() => null);
      check('tool_result 回灌后拿到回答', m2 && m2.type === 'message'
        && Array.isArray(m2.content) && m2.content.some((c) => c.type === 'text' && c.text),
        m2 && m2.content && JSON.stringify(m2.content).slice(0, 150));
    }

    // ---- Responses 工具 ----
    r = await fetch(base + '/v1/responses', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: MODEL, stream: true, max_output_tokens: 256, tools: [WEATHER_RESP],
        input: [{ role: 'user', content: [{ type: 'input_text', text: '上海今天天气怎么样？用工具查。' }] }],
      }),
    });
    check('Responses 带工具请求 200', r.status === 200, r.status);
    evts = parseSse(await r.text());
    const fcAdded = evts.filter((e) => e.event === 'response.output_item.added' && e.data.item && e.data.item.type === 'function_call');
    if (fcAdded.length) {
      check('模型真的调了工具（Responses）', true, fcAdded.map((e) => e.data.item.name).join(','));
      const done = evts.find((e) => e.event === 'response.completed');
      const fcs = done && done.data.response && done.data.response.output
        ? done.data.response.output.filter((o) => o.type === 'function_call') : [];
      check('completed 里含 function_call', fcs.length > 0, fcs.length);
      let parsed = null;
      try { parsed = JSON.parse((fcs[0] && fcs[0].arguments) || '{}'); } catch {}
      check('function_call.arguments 是合法 JSON', parsed !== null, fcs[0] && fcs[0].arguments);
      check('function_call 有 call_id', !!(fcs[0] && fcs[0].call_id), fcs[0] && fcs[0].call_id);
    } else {
      const done = evts.find((e) => e.event === 'response.completed');
      check('模型没调工具但链路未炸（Responses）', done !== undefined, done && done.data.response && done.data.response.status);
    }

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

