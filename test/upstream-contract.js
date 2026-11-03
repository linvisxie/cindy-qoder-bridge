// 上游契约回归：这七条是代码审查（issue #1）里指出的受控缺陷，全部离线可跑。
// 每个用例只喂假的 upstream chunk 流，不联网、不需要登录态。
'use strict';

const adapters = require('../plugin/node/adapters.cjs');

let pass = 0;
let fail = 0;
const skips = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}   ${detail === undefined ? '' : detail}`); }
}
function skip(name, why) { skips.push(`${name}（${why}）`); }

// ---------- 假流与假 res ----------

function fakeStream(chunks) {
  let i = 0;
  return {
    first: chunks.length ? { done: false, value: chunks[0] } : { done: true, value: undefined },
    iterator: {
      next: async () => {
        i += 1;
        return i < chunks.length ? { done: false, value: chunks[i] } : { done: true, value: undefined };
      },
    },
  };
}

function fakeRes() {
  const events = [];
  return {
    events,
    writeHead() {},
    write(s) {
      for (const block of String(s).split('\n\n')) {
        const line = block.trim();
        if (!line) continue;
        const ev = {};
        for (const l of line.split('\n')) {
          if (l.startsWith('event: ')) ev.type = l.slice(7);
          else if (l.startsWith('data: ')) {
            try { ev.data = JSON.parse(l.slice(6)); } catch { ev.data = l.slice(6); }
          }
        }
        events.push(ev);
      }
      return true;
    },
    end() {},
  };
}

const OPTS = { model: 'deepseek-v4.1-flash', inputTokens: 7 };

function textOnly() {
  return [{ choices: [{ delta: { content: '半截回答' }, finish_reason: null }] }];
}
function withFinish() {
  return [
    { choices: [{ delta: { content: '完整回答' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5 } },
  ];
}
// A/B 交错分片：首帧各带 id+name+半截 args，次帧只带 args 增量（name 是空串）
function interleaved() {
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{"x":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"y":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '1}' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: '', arguments: '2}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function sseEvents(res, type) { return res.events.filter((e) => e.type === type); }

(async () => {
  console.log('--- 第 1 项：并行工具调用不能被拆坏 ---');
  {
    const res = fakeRes();
    const s = fakeStream(interleaved());
    await adapters.writeAnthropicStream(res, s.first, s.iterator, { ...OPTS });
    const starts = sseEvents(res, 'content_block_start').filter((e) => e.data.content_block.type === 'tool_use');
    ok('并行工具：只开 2 个 tool_use 块', starts.length === 2, `实际 ${starts.length}`);
    ok('并行工具：两个块都有名字', starts.every((e) => e.data.content_block.name), starts.map((e) => e.data.content_block.name).join(','));
    const args = new Map();
    for (const e of sseEvents(res, 'content_block_delta')) {
      const d = e.data.delta;
      if (d.type !== 'input_json_delta') continue;
      args.set(e.data.index, (args.get(e.data.index) || '') + d.partial_json);
    }
    const all = [...args.values()];
    ok('并行工具：参数各自拼成合法 JSON', all.length === 2 && all.every((a) => {
      try { JSON.parse(a); return true; } catch { return false; }
    }), JSON.stringify(all));
    const delta = sseEvents(res, 'message_delta')[0];
    ok('并行工具：stop_reason 是 tool_use', delta && delta.data.delta.stop_reason === 'tool_use', delta && delta.data.delta.stop_reason);
  }
  {
    const res = fakeRes();
    const s = fakeStream(interleaved());
    const msg = await adapters.anthropicMessage(s.first, s.iterator, { ...OPTS });
    const tools = msg.content.filter((c) => c.type === 'tool_use');
    ok('并行工具（非流）：2 个 tool_use', tools.length === 2, tools.length);
    ok('并行工具（非流）：input 都是对象', tools.every((t) => t.input && typeof t.input === 'object'));
  }

  console.log('--- 第 2 项：缺结束信号的 EOF 必须报截断 ---');
  for (const [label, fn] of [['Anthropic 流', 'anthropicStream'], ['Responses 流', 'responsesStream']]) {
    const res = fakeRes();
    const s = fakeStream(textOnly());
    if (fn === 'anthropicStream') await adapters.writeAnthropicStream(res, s.first, s.iterator, { ...OPTS });
    else await adapters.writeResponsesStream(res, s.first, s.iterator, { ...OPTS });
    const errEvent = res.events.filter((e) => e.type === 'error' || e.type === 'response.failed');
    ok(`${label}：EOF 无结束信号 → 报错`, errEvent.length === 1, errEvent.length);
  }
  for (const [label, fn] of [['Anthropic 非流', adapters.anthropicMessage], ['Responses 非流', adapters.responsesMessage]]) {
    const s = fakeStream(textOnly());
    let threw = false;
    try { await fn(s.first, s.iterator, { ...OPTS }); } catch (e) { threw = /结束信号/.test(e.message); }
    ok(`${label}：EOF 无结束信号 → 抛截断`, threw);
  }
  for (const [label, fn] of [['Anthropic 非流', adapters.anthropicMessage], ['Responses 非流', adapters.responsesMessage]]) {
    const s = fakeStream(withFinish());
    let threw = false;
    try { await fn(s.first, s.iterator, { ...OPTS }); } catch { threw = true; }
    ok(`${label}：有结束信号 → 正常返回`, !threw);
  }

  console.log('--- 第 4 项：真实 usage 要回传给记账层 ---');
  {
    const s = fakeStream(withFinish());
    const opts = { ...OPTS };
    await adapters.anthropicMessage(s.first, s.iterator, opts);
    ok('Anthropic 非流回传 usage', opts.usage && opts.usage.completion_tokens === 5, JSON.stringify(opts.usage));
  }
  {
    const s = fakeStream(withFinish());
    const opts = { ...OPTS };
    await adapters.responsesMessage(s.first, s.iterator, opts);
    ok('Responses 非流回传 usage', opts.usage && opts.usage.completion_tokens === 5, JSON.stringify(opts.usage));
  }
  {
    const res = fakeRes();
    const s = fakeStream(withFinish());
    const opts = { ...OPTS };
    await adapters.writeAnthropicStream(res, s.first, s.iterator, opts);
    ok('Anthropic 流回传 usage', opts.usage && opts.usage.completion_tokens === 5, JSON.stringify(opts.usage));
  }
  {
    const res = fakeRes();
    const s = fakeStream(withFinish());
    const opts = { ...OPTS };
    await adapters.writeResponsesStream(res, s.first, s.iterator, opts);
    ok('Responses 流回传 usage', opts.usage && opts.usage.completion_tokens === 5, JSON.stringify(opts.usage));
  }

  console.log('--- 第 6 项：包里必须带许可与第三方声明（由 e2e-package 校验，这里只记位置） ---');
  skip('打包清单含 LICENSE / NOTICE / THIRD-PARTY-NOTICES.md', '见 test/e2e-package.js');

  console.log(`\n结果：${pass} 通过，${fail} 失败，${skips.length} 跳过`);
  if (skips.length) for (const s of skips) console.log(`  跳过：${s}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身崩了：', e);
  process.exit(1);
});
