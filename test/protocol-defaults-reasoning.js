'use strict';
// Offline only: real adapters + worker routing in an isolated VM, no resident boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const adapters = require('../plugin/node/adapters.cjs');
const root = path.resolve(__dirname, '..');
const chunk = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason }] });
const end = (finish = 'stop') => chunk({}, finish);
const tool = (index, args, id) => ({ tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(id ? { name: 'tool_' + index } : {}), arguments: args } }] });
function response() {
  return Object.assign(new EventEmitter(), {
    text: '', writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    write(s) { this.text += s; return true; }, end(s = '') { this.text += s; this.writableEnded = true; },
  });
}
function events(res) {
  return res.text.split('\n').filter(s => s.startsWith('data: ') && s !== 'data: [DONE]').map(s => JSON.parse(s.slice(6)));
}
async function convert(chunks, stream, failure) {
  async function* source() { yield* chunks; if (failure) throw failure; }
  const iterator = source(), first = await iterator.next(), opts = { model: 'fixture' };
  if (!stream) return adapters.responsesMessage(first, iterator, opts);
  const res = response();
  await adapters.writeResponsesStream(res, first, iterator, opts);
  return events(res);
}
function completed(result, stream) {
  return stream ? result.find(e => /^response\.(completed|incomplete)$/.test(e.type)).response : result;
}
for (const stream of [false, true]) {
  test(`Responses reasoning only / multiple deltas / nullish fallback stream=${stream}`, async () => {
    const result = await convert([
      chunk({ reasoning_content: 'one', reasoning: 'not-selected' }),
      chunk({ reasoning_content: null, reasoning: 'two' }),
      chunk({ reasoning_content: '', reasoning: 'not-selected' }), end(),
    ], stream);
    const value = completed(result, stream);
    assert.equal(value.status, 'completed');
    assert.equal(value.output.length, 1);
    assert.equal(value.output[0].type, 'reasoning');
    assert.equal(value.output[0].status, 'completed');
    assert.deepEqual(value.output[0].summary, [{ type: 'summary_text', text: 'onetwo' }]);
    assert.equal(value.usage.output_tokens_details.reasoning_tokens, 0);
    if (stream) {
      const rs = result.filter(e => e.type.startsWith('response.reasoning_summary_'));
      assert.deepEqual(rs.map(e => e.type), [
        'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
        'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
        'response.reasoning_summary_part.done',
      ]);
      assert.ok(rs.every(e => e.item_id === value.output[0].id && e.output_index === 0 && e.summary_index === 0));
      assert.equal(rs[3].text, 'onetwo');
      assert.deepEqual(rs[4].part, value.output[0].summary[0]);
      assert.equal(result.filter(e => e.type === 'response.output_item.done').length, 1);
    }
  });
  for (const firstType of ['reasoning', 'message', 'function_call']) {
    test(`Responses interleaved first=${firstType} stream=${stream}`, async () => {
      const starts = { reasoning: chunk({ reasoning: 'r1' }), message: chunk({ content: 't1' }), function_call: chunk(tool(7, '{', 'call_a')) };
      const order = [firstType, ...Object.keys(starts).filter(t => t !== firstType)];
      const chunks = order.map(t => starts[t]);
      chunks.push(chunk(tool(2, '{}', 'call_b')), chunk({ reasoning_content: 'r2', content: 't2' }), chunk(tool(7, '}')), {
        ...end('tool_calls'), usage: { prompt_tokens: 9, completion_tokens: 11, completion_tokens_details: { reasoning_tokens: 4 } },
      });
      const result = await convert(chunks, stream), value = completed(result, stream);
      assert.deepEqual(value.output.map(i => i.type), [...order, 'function_call']);
      assert.equal(value.output.find(i => i.type === 'reasoning').summary[0].text, 'r1r2');
      assert.equal(value.output.find(i => i.type === 'message').content[0].text, 't1t2');
      assert.deepEqual(value.output.filter(i => i.type === 'function_call').map(i => i.arguments), ['{}', '{}']);
      assert.equal(value.usage.output_tokens_details.reasoning_tokens, 4);
      if (stream) {
        const added = result.filter(e => e.type === 'response.output_item.added');
        assert.deepEqual(added.map(e => e.output_index), [0, 1, 2, 3]);
        assert.deepEqual(added.map(e => e.item.id), value.output.map(i => i.id));
        const done = result.filter(e => e.type === 'response.output_item.done');
        assert.equal(new Set(done.map(e => e.output_index)).size, 4);
        for (const e of done) assert.deepEqual(e.item, value.output[e.output_index]);
      }
    });
  }
  test(`Responses missing/empty/nonstring reasoning adds no item stream=${stream}`, async () => {
    for (const delta of [{}, { reasoning: '' }, { reasoning_content: 42, reasoning: 'not-selected' }]) {
      const result = await convert([chunk(delta), chunk({ content: 'hi' }), end()], stream);
      assert.deepEqual(completed(result, stream).output.map(i => i.type), ['message']);
      if (stream) assert.ok(!result.some(e => e.type.startsWith('response.reasoning_')));
    }
  });
  test(`Responses length marks all items incomplete stream=${stream}`, async () => {
    const result = await convert([chunk({ reasoning: 'r', content: 't', ...tool(0, '{', 'a') }), end('length')], stream);
    const value = completed(result, stream);
    assert.equal(value.status, 'incomplete');
    assert.deepEqual(value.incomplete_details, { reason: 'max_output_tokens' });
    assert.deepEqual(value.output.map(i => i.status), ['incomplete', 'incomplete', 'incomplete']);
  });
  test(`Responses midstream error/truncation never reports success stream=${stream}`, async () => {
    for (const failure of [undefined, new Error('fixture error')]) {
      const chunks = [chunk({ reasoning: 'partial' })];
      if (!stream) { await assert.rejects(convert(chunks, false, failure), /fixture error|完整/); continue; }
      const result = await convert(chunks, true, failure);
      assert.equal(result.at(-1).type, 'response.failed');
      assert.ok(!result.some(e => /\.(completed|incomplete|done)$/.test(e.type)));
    }
  });
}

test('request translators default to JSON; only literal true opts into SSE', () => {
  for (const translate of [adapters.anthropicRequestToChat, adapters.responsesRequestToChat]) {
    for (const stream of [undefined, false, true, null, 1, 'true']) {
      assert.equal(translate(stream === undefined ? {} : { stream }).stream, stream === true);
    }
  }
});

async function request(w, route, stream) {
  const body = { model: 'fixture', max_tokens: 100,
    ...(route.endsWith('responses') ? { input: 'Hi' } : { messages: [{ role: 'user', content: 'Hi' }] }),
    ...(stream === undefined ? {} : { stream }) };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', url: route, headers: { host: '127.0.0.1', authorization: 'Bearer local-test' }, socket: { remoteAddress: '127.0.0.1' } });
  const res = response(); w.ctx.req = req; w.ctx.res = res;
  await w.run('handle(req,res)');
  return res;
}

function worker() {
  const file = path.join(root, 'plugin/node/worker.cjs'), baseRequire = createRequire(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-defaults-'));
  const owner = { held: true, assertHeld() {} };
  const requests = [];
  const ctx = vm.createContext({
    __CINDY_BRIDGE_OWNERSHIP: { installation: owner, data: owner },
    __dirname: path.dirname(file), Buffer, URL, TextDecoder, AbortController, AbortSignal,
    fetch: async () => { throw new Error('unexpected fetch: offline fixture'); },
    require: baseRequire,
    process: { env: { APPDATA: dir, LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir, CINDY_QODER_DATA: dir, CINDY_TRAE_DATA: dir },
      platform: process.platform, arch: process.arch, pid: process.pid, execPath: process.execPath,
      stderr: { write() {} }, exit() { throw new Error('unexpected exit'); } },
    setTimeout, clearTimeout, requests,
  });
  const run = source => vm.runInContext(source, ctx);
  try {
    run(fs.readFileSync(file, 'utf8').split('// JSON-RPC over stdio')[0]);
    run('globalThis.fixtureOriginalStreamChat=streamChat');
    run(`token='local-test';models=[{key:'fixture',name:'Fixture'}];refreshCredential=async()=>({token:'fixture'});
      streamChat=async function*(cred,request){requests.push(request);
        if(request.stream === false) throw Error('downstream false leaked upstream');
        yield {choices:[{delta:{reasoning_content:'r',content:'first'},finish_reason:null}]};
        yield {choices:[{delta:{content:'second'},finish_reason:'stop'}]};
      };`);
    return { ctx, run, requests, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}
for (const route of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
  for (const stream of [undefined, false, true]) {
    test(`real worker ${route} stream=${stream}`, async () => {
      const w = worker();
      try {
        const body = { model: 'fixture', max_tokens: 100, ...(route.endsWith('responses') ? { input: 'Hi' } : { messages: [{ role: 'user', content: 'Hi' }] }), ...(stream === undefined ? {} : { stream }) };
        const req = Readable.from([Buffer.from(JSON.stringify(body))]);
        Object.assign(req, { method: 'POST', url: route, headers: { host: '127.0.0.1', authorization: 'Bearer local-test' }, socket: { remoteAddress: '127.0.0.1' } });
        const res = response(); w.ctx.req = req; w.ctx.res = res;
        await w.run('handle(req,res)');
        assert.equal(res.status, 200, res.text);
        const type = res.headers['Content-Type'] || res.headers['content-type'];
        assert.match(type, stream === true ? /^text\/event-stream/ : /^application\/json/);
        assert.equal(w.requests.length, 1);
        assert.notEqual(w.requests[0].stream, false);
        // Exercise the actual upstream serializer, not a guessed stream flag on the worker request.
        if (fs.existsSync(path.join(root, 'plugin/node/trae.cjs'))) {
          const trae = require('../plugin/node/trae.cjs');
          assert.equal(trae.prepareSoloBody(w.requests[0]).stream, true);
        } else {
          let upstreamBody;
          w.ctx.fetch = async (_url, options) => {
            upstreamBody = JSON.parse(Buffer.from(options.body).toString());
            throw new Error('fixture upstream intercepted');
          };
          w.run('encodeBody=bytes=>bytes;authHeaders=()=>({})');
          w.ctx.fixtureRequest = w.requests[0];
          await assert.rejects(w.run("fixtureOriginalStreamChat({token:'fixture'},fixtureRequest).next()"), /fixture upstream intercepted/);
          assert.equal(upstreamBody.stream, true);
        }
        if (stream !== true) {
          const value = JSON.parse(res.text);
          const text = route.endsWith('completions') ? value.choices[0].message.content : route.endsWith('messages') ? value.content.find(i => i.type === 'text').text : value.output.find(i => i.type === 'message').content[0].text;
          assert.equal(text, 'firstsecond');
          if (route.endsWith('completions')) assert.equal(value.choices[0].message.reasoning_content, 'r');
          if (route.endsWith('responses')) assert.equal(value.output.find(i => i.type === 'reasoning').summary[0].text, 'r');
        } else assert.ok(events(res).length > 1);
      } finally { w.dispose(); }
    });
  }
}

for (const stream of [undefined, false]) {
  test(`Chat reasoning-only aggregation stream=${stream}`, async () => {
    const w = worker();
    try {
      w.run(`streamChat=async function*(){
        yield {choices:[{delta:{reasoning_content:'one',reasoning:'ignored'}}]};
        yield {choices:[{delta:{reasoning_content:null,reasoning:'two'}}]};
        yield {choices:[{delta:{reasoning_content:42,reasoning:'ignored'}}]};
        yield {choices:[{delta:{},finish_reason:'stop'}]};
      }`);
      const res = await request(w, '/v1/chat/completions', stream);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(JSON.parse(res.text).choices[0].message, { role: 'assistant', content: '', reasoning_content: 'onetwo' });
    } finally { w.dispose(); }
  });
}

// Qoder-specific: retain the real streamChat SSE parser and all downstream adapters.
if (!fs.existsSync(path.join(root, 'plugin/node/trae.cjs'))) {
  for (const ending of ['done-only', 'bare-eof', 'length', 'content_filter', 'stop']) {
    for (const route of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
      for (const stream of [false, true]) {
        test(`Qoder actual SSE parser ${ending} ${route} stream=${stream}`, async () => {
          const w = worker();
          let fetches = 0;
          try {
            const frames = [chunk({ reasoning_content: 'r', content: 'hello' })];
            if (!['done-only', 'bare-eof'].includes(ending)) frames.push(end(ending));
            const wire = frames.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('')
              + (ending === 'bare-eof' ? '' : 'data: [DONE]\n\n');
            w.ctx.fetch = async (_url, options) => {
              fetches++;
              assert.equal(JSON.parse(Buffer.from(options.body).toString()).stream, true);
              // Fragment in the middle of SSE lines/JSON as a real network reader can.
              let offset = 0;
              return { ok: true, body: new ReadableStream({
                pull(controller) {
                  if (offset >= wire.length) { controller.close(); return; }
                  controller.enqueue(Buffer.from(wire.slice(offset, offset + 9)));
                  offset += 9;
                },
              }) };
            };
            w.run('streamChat=fixtureOriginalStreamChat;encodeBody=bytes=>bytes;authHeaders=()=>({})');
            const res = await request(w, route, stream);
            assert.equal(fetches, 1);
            if (ending === 'bare-eof') {
              await assert.rejects(w.run(`(async()=>{
                for await (const c of fixtureOriginalStreamChat({token:'fixture'}, {model:'fixture',messages:[]})) {}
              })()`), e => e.status === 502 && e.upstreamCode === 'upstream_truncated');
              if (!stream) {
                assert.equal(res.status, 502, res.text);
                assert.ok(JSON.parse(res.text).error);
              } else {
                const ev = events(res);
                assert.ok(ev.some(e => e.error || e.type === 'error' || e.type === 'response.failed'), res.text);
                assert.ok(!ev.some(e => ['message_stop', 'response.completed', 'response.incomplete'].includes(e.type)));
                assert.ok(!ev.some(e => e.choices?.some(c => typeof c.finish_reason === 'string')));
              }
            } else {
              assert.equal(res.status, 200, res.text);
              const finish = ending === 'done-only' ? 'stop' : ending;
              if (route.endsWith('completions')) {
                const choices = stream ? events(res).flatMap(e => e.choices || []) : JSON.parse(res.text).choices;
                assert.deepEqual(choices.filter(c => typeof c.finish_reason === 'string').map(c => c.finish_reason), [finish]);
              } else if (route.endsWith('messages')) {
                const value = stream ? events(res).find(e => e.type === 'message_delta').delta : JSON.parse(res.text);
                assert.equal(value.stop_reason, finish === 'length' ? 'max_tokens' : 'end_turn');
                if (stream) assert.ok(events(res).some(e => e.type === 'message_stop'));
              } else {
                const value = stream ? completed(events(res), true) : JSON.parse(res.text);
                const incomplete = ['length', 'content_filter'].includes(finish);
                assert.equal(value.status, incomplete ? 'incomplete' : 'completed');
                assert.ok(value.output.every(i => i.status === value.status));
                if (incomplete) assert.equal(value.incomplete_details.reason, finish === 'length' ? 'max_output_tokens' : 'content_filter');
                assert.equal(value.output.find(i => i.type === 'reasoning').summary[0].text, 'r');
              }
            }
          } finally { w.dispose(); }
        });
      }
    }
  }
}
