'use strict';

// Responses 的状态映射（issue #8 现象 2）的离线单元测试。
// 不需要登录 Qoder、不开 worker、不联网：直接喂假的 chat chunk 给 adapters 的两个出口，
// 检查顶层 status / incomplete_details 与每个 output 子项的 status 是否自洽。
//
// 为什么这样断言：OpenAI Responses 的 output 项（message / function_call）status 只有
// in_progress | completed | incomplete 三个取值，没有 failed —— failed 只属于顶层 Response。
// 所以「整体被内容策略掐断」应该是顶层 incomplete + incomplete_details.reason: content_filter，
// 子项跟着 incomplete；只有上游直接报错、压根没产出时才是 response.failed。
// 用法：node test/responses-status.js

const adapters = require('../plugin/node/adapters.cjs');

const results = [];
function check(name, cond, got) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  got=' + JSON.stringify(got).slice(0, 200)}`);
}

// 把一串 chat chunk 包成 writeResponsesStream / responsesMessage 要的 first + iterator 形状
function fakeStream(chunks) {
  let i = 0;
  const first = { done: chunks.length === 0, value: chunks[0] };
  return {
    first,
    iterator: {
      next: async () => {
        i += 1;
        return i < chunks.length ? { done: false, value: chunks[i] } : { done: true, value: undefined };
      },
    },
  };
}

function chunk(delta, finish) {
  return { choices: [{ delta, finish_reason: finish || null }], usage: { prompt_tokens: 7, completion_tokens: 5 } };
}

function fakeRes() {
  const events = [];
  return {
    events,
    writeHead() {},
    write(raw) {
      // 每块形如 "event: xxx\ndata: {...}\n\n"
      const evt = /event: ([^\n]+)/.exec(raw);
      const data = /\ndata: ([^\n]+)/.exec(raw);
      events.push({ type: evt ? evt[1] : '', data: data ? JSON.parse(data[1]) : null });
      return true;
    },
    end() {},
  };
}

const OPTS = { model: 'qfmodel', inputTokens: 7 };

async function nonStreaming(finish, chunks) {
  const s = fakeStream(chunks);
  return adapters.responsesMessage(s.first, s.iterator, OPTS);
}

async function streaming(finish, chunks) {
  const s = fakeStream(chunks);
  const res = fakeRes();
  await adapters.writeResponsesStream(res, s.first, s.iterator, OPTS);
  return res.events;
}

function lastEventOf(events, type) {
  const hit = events.filter((e) => e.type === type);
  return hit.length ? hit[hit.length - 1].data : null;
}

(async () => {
  // ---- 非流式 ----
  console.log('--- Responses 非流式 ---');
  let r = await nonStreaming('stop', [chunk({ content: '你好' }, 'stop')]);
  check('正常结束：顶层 completed', r.status === 'completed', r.status);
  check('正常结束：子项 completed', r.output[0] && r.output[0].status === 'completed', r.output[0] && r.output[0].status);
  check('正常结束：不带 incomplete_details', r.incomplete_details === undefined, r.incomplete_details);

  r = await nonStreaming('length', [chunk({ content: '半截' }, 'length')]);
  check('截断：顶层 incomplete', r.status === 'incomplete', r.status);
  check('截断：reason=max_output_tokens', r.incomplete_details && r.incomplete_details.reason === 'max_output_tokens', r.incomplete_details);
  check('截断：子项 incomplete', r.output[0] && r.output[0].status === 'incomplete', r.output[0] && r.output[0].status);

  r = await nonStreaming('content_filter', [chunk({ content: '被掐' }, 'content_filter')]);
  check('内容策略：顶层 incomplete（不是 failed）', r.status === 'incomplete', r.status);
  check('内容策略：reason=content_filter', r.incomplete_details && r.incomplete_details.reason === 'content_filter', r.incomplete_details);
  check('内容策略：子项 message 也 incomplete（不是 failed）', r.output[0] && r.output[0].status === 'incomplete', r.output[0] && r.output[0].status);
  check('内容策略：子项 status 只用合法枚举', r.output.every((it) => ['in_progress', 'completed', 'incomplete'].includes(it.status)),
    r.output.map((it) => it.status));

  // 带 tool call 的场景：子项是 function_call
  const toolChunks = [{
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"p":1}' } }] },
      finish_reason: 'content_filter',
    }],
    usage: { prompt_tokens: 7, completion_tokens: 5 },
  }];
  r = await nonStreaming('content_filter', toolChunks);
  const fc = r.output.find((it) => it.type === 'function_call');
  check('内容策略：function_call 子项 incomplete', fc && fc.status === 'incomplete', fc && fc.status);
  check('内容策略：tool_calls 的 args 原样保留', fc && fc.arguments === '{"p":1}', fc && fc.arguments);

  // ---- 流式 ----
  console.log('\n--- Responses 流式 ---');
  let evts = await streaming('content_filter', [chunk({ content: '被掐' }, 'content_filter')]);
  const types = evts.map((e) => e.type);
  check('流式：发的终止事件是 response.incomplete', types.includes('response.incomplete'), types.slice(-3));
  check('流式：不再发 response.failed', !types.includes('response.failed'), types.slice(-3));

  const itemDone = lastEventOf(evts, 'response.output_item.done');
  check('流式：output_item.done 的 item.status=incomplete', itemDone && itemDone.item && itemDone.item.status === 'incomplete',
    itemDone && itemDone.item && itemDone.item.status);

  const term = lastEventOf(evts, 'response.incomplete');
  check('流式：终止事件里顶层 status=incomplete', term && term.response && term.response.status === 'incomplete', term && term.response && term.response.status);
  check('流式：终止事件里带 reason=content_filter',
    term && term.response && term.response.incomplete_details && term.response.incomplete_details.reason === 'content_filter',
    term && term.response && term.response.incomplete_details);
  check('流式：终止事件里 output 子项也是 incomplete',
    term && term.response && Array.isArray(term.response.output)
      && term.response.output.every((it) => it.status === 'incomplete'),
    term && term.response && (term.response.output || []).map((it) => it.status));

  evts = await streaming('stop', [chunk({ content: '好' }, 'stop')]);
  check('流式：正常结束仍发 response.completed', evts.some((e) => e.type === 'response.completed'), evts.map((e) => e.type).slice(-3));

  const bad = results.filter((x) => !x.ok).length;
  console.log(`\n结果：${results.length - bad} 通过，${bad} 失败`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
