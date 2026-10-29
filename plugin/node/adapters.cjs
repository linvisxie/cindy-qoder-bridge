'use strict';

// Anthropic Messages 与 OpenAI Responses 两种上行协议的适配层。
//
// 设计：两边都先翻译成「OpenAI chat 形状」，交给 worker.cjs 里已有的
// toQoderMessages / toQoderTools / streamChat 走同一条上游链路，
// 再把上游吐出的 OpenAI chunk 翻回各自协议的响应。
//
// 为什么需要这个：Cindy 的 acceptsWireProtocol(l,n) 规定
//   pi          → 任意协议
//   claude-code → 只能 anthropic-messages
//   codex       → 只能 openai-responses
// 所以只提供 /v1/chat/completions 时，只有 pi 引擎能用。

const { randomBytes } = require('node:crypto');

const ANTHROPIC_STOP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.text === 'string') out += b.text;
  }
  return out;
}

function safeJson(s) {
  if (typeof s !== 'string' || !s.trim()) return {};
  try { return JSON.parse(s); } catch {
    // 以前这里直接回 {}：模型吐了半个 JSON（被 max_tokens 截断、或自己写坏了），
    // 到了客户端就被当成「这个工具就是空参调用」，工具照空参执行，错得毫无痕迹。
    // 现在把原文留在 input 里，至少调用方 / 日志能看出上游给的是什么。
    return { __unparsed_arguments: s };
  }
}

/** 粗估 token 数，只给 /v1/messages/count_tokens 用。 */
function estimateTokens(messages) {
  let chars = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) chars += textOf(m.content).length;
    if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        chars += ((c.function && c.function.name) || '').length;
        chars += ((c.function && c.function.arguments) || '').length;
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 3.5));
}

// ---------- 上行：Anthropic → chat ----------

function anthropicRequestToChat(body) {
  const messages = [];
  const sys = body && body.system;
  const sysText = typeof sys === 'string'
    ? sys
    : Array.isArray(sys) ? sys.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '';
  if (sysText) messages.push({ role: 'system', content: sysText });

  for (const m of Array.isArray(body && body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') { messages.push({ role: 'system', content: textOf(m.content) }); continue; }

    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }];

    if (m.role === 'assistant') {
      let text = '';
      const calls = [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') text += b.text;
        else if (b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
          calls.push({
            id: typeof b.id === 'string' && b.id ? b.id : 'call_' + randomBytes(8).toString('hex'),
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
        // thinking / redacted_thinking 块不回灌上游
      }
      const msg = { role: 'assistant', content: text };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
      continue;
    }

    // user：可能同时含 tool_result、文本和图片
    const toolResults = [];
    const parts = [];
    let hasImage = false;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        // 缺 tool_use_id 的 tool_result 没法对应到任何 tool_call，以前这里静默丢掉，
        // 结果模型看到的是「工具结果凭空消失」。宁可 400 让调用方看出来。
        if (typeof b.tool_use_id !== 'string' || !b.tool_use_id) {
          throw new Error('tool_result 块缺少 tool_use_id');
        }
        toolResults.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: textOf(b.content),
        });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: typeof b.text === 'string' ? b.text : '' });
      } else if (b.type === 'image') {
        const src = b.source || {};
        if (src.type === 'base64' && typeof src.data === 'string' && src.data) {
          hasImage = true;
          parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } });
        } else if (src.type === 'url' && typeof src.url === 'string' && src.url) {
          hasImage = true;
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    // tool 结果必须紧跟带 tool_calls 的 assistant，放在用户文本之前
    for (const tr of toolResults) if (tr.tool_call_id) messages.push(tr);
    if (parts.length) {
      messages.push({ role: 'user', content: hasImage ? parts : parts.map((p) => p.text || '').join('') });
    }
  }

  const tools = Array.isArray(body && body.tools)
    ? body.tools
      .filter((t) => t && typeof t.name === 'string' && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: t.input_schema && typeof t.input_schema === 'object'
            ? t.input_schema
            : { type: 'object', properties: {} },
        },
      }))
    : [];

  return {
    model: body && typeof body.model === 'string' ? body.model : '',
    messages,
    tools,
    maxTokens: Number.isSafeInteger(body && body.max_tokens) ? body.max_tokens : undefined,
    stream: !(body && body.stream === false),
    thinking: !!(body && body.thinking && body.thinking.type === 'enabled'),
  };
}

// ---------- 下行：chat chunk → Anthropic SSE ----------

async function writeAnthropicStream(res, first, iterator, opts) {
  const id = 'msg_' + randomBytes(12).toString('hex');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);

  send({
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model: opts.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: opts.inputTokens || 0, output_tokens: 0 },
    },
  });

  let nextIndex = 0;
  let textIndex = null;
  let thinkIndex = null;
  const toolIndex = new Map();
  const tools = new Map();
  let finish = 'stop';
  let usage;

  const close = (i) => send({ type: 'content_block_stop', index: i });
  // 关掉所有还开着的块。以前只关 text/thinking，工具块留着不关：
  // 上游如果先吐工具、又吐出文本，就会在 tool_use 块还是打开状态时开始新的 text 块，
  // Anthropic 的事件顺序要求每个块 start→…→stop 完整闭合，否则 SDK 会报解析错。
  const closeTools = () => {
    for (const [key, idx] of toolIndex) {
      close(idx);
      toolIndex.delete(key);
    }
  };
  const closeOpen = () => {
    if (textIndex !== null) { close(textIndex); textIndex = null; }
    if (thinkIndex !== null) { close(thinkIndex); thinkIndex = null; }
    closeTools();
  };

  try {
    for (let s = first; !s.done; s = await iterator.next()) {
      const c = s.value;
      if (c && c.usage) usage = c.usage;
      const ch = c && c.choices && c.choices[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      if (typeof ch.finish_reason === 'string') finish = ch.finish_reason;

      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        if (thinkIndex === null) {
          thinkIndex = nextIndex++;
          send({ type: 'content_block_start', index: thinkIndex, content_block: { type: 'thinking', thinking: '' } });
        }
        send({ type: 'content_block_delta', index: thinkIndex, delta: { type: 'thinking_delta', thinking: reasoning } });
      }

      if (typeof d.content === 'string' && d.content) {
        if (thinkIndex !== null) { close(thinkIndex); thinkIndex = null; }
        // 文本比工具晚到时，先把开着的工具块闭合，再开文本块
        if (toolIndex.size) closeTools();
        if (textIndex === null) {
          textIndex = nextIndex++;
          send({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        send({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: d.content } });
      }

      if (Array.isArray(d.tool_calls)) {
        for (const t of d.tool_calls) {
          const key = t.index ?? 0;
          if (!toolIndex.has(key)) {
            closeOpen();
            const idx = nextIndex++;
            toolIndex.set(key, idx);
            const block = {
              id: (t.id && String(t.id)) || 'toolu_' + randomBytes(10).toString('hex'),
              name: (t.function && t.function.name) || '',
              args: '',
            };
            tools.set(idx, block);
            send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          }
          const idx = toolIndex.get(key);
          const block = tools.get(idx);
          if (t.id) block.id = String(t.id);
          if (t.function && typeof t.function.name === 'string' && t.function.name) block.name = t.function.name;
          if (t.function && typeof t.function.arguments === 'string' && t.function.arguments) {
            block.args += t.function.arguments;
            send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
          }
        }
      }
    }

    closeOpen();

    send({
      type: 'message_delta',
      delta: { stop_reason: ANTHROPIC_STOP[finish] || 'end_turn', stop_sequence: null },
      usage: { output_tokens: (usage && usage.completion_tokens) || 0 },
    });
    send({ type: 'message_stop' });
    res.end();
  } catch (e) {
    send({ type: 'error', error: { type: 'api_error', message: e.message } });
    res.end();
  }
}

async function anthropicMessage(first, iterator, opts) {
  let text = '';
  let thinking = '';
  const calls = new Map();
  let finish = 'stop';
  let usage;

  for (let s = first; !s.done; s = await iterator.next()) {
    const c = s.value;
    if (c && c.usage) usage = c.usage;
    const ch = c && c.choices && c.choices[0];
    if (!ch) continue;
    const d = ch.delta || ch.message || {};
    if (typeof ch.finish_reason === 'string') finish = ch.finish_reason;
    if (typeof d.content === 'string') text += d.content;
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === 'string') thinking += r;
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const key = t.index ?? 0;
        const cur = calls.get(key) || { id: '', name: '', args: '' };
        if (t.id) cur.id = String(t.id);
        if (t.function && typeof t.function.name === 'string' && t.function.name) cur.name = t.function.name;
        if (t.function && typeof t.function.arguments === 'string') cur.args += t.function.arguments;
        calls.set(key, cur);
      }
    }
  }

  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  for (const c of calls.values()) {
    content.push({
      type: 'tool_use',
      id: c.id || 'toolu_' + randomBytes(10).toString('hex'),
      name: c.name,
      input: safeJson(c.args),
    });
  }

  return {
    id: 'msg_' + randomBytes(12).toString('hex'),
    type: 'message',
    role: 'assistant',
    model: opts.model,
    content,
    stop_reason: ANTHROPIC_STOP[finish] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: opts.inputTokens || 0, output_tokens: (usage && usage.completion_tokens) || 0 },
  };
}

// ---------- 上行：OpenAI Responses → chat ----------

function responsesRequestToChat(body) {
  const messages = [];
  if (body && typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const pushCall = (call) => {
    let last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.__assistant) {
      last = { role: 'assistant', content: '', tool_calls: [], __assistant: true };
      messages.push(last);
    }
    last.tool_calls.push({
      id: typeof call.call_id === 'string' && call.call_id ? call.call_id
        : (typeof call.id === 'string' && call.id ? call.id : 'call_' + randomBytes(8).toString('hex')),
      type: 'function',
      function: {
        name: typeof call.name === 'string' ? call.name : '',
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
      },
    });
  };

  const pushMessage = (role, content) => {
    const parts = [];
    let hasImage = false;
    if (typeof content === 'string') { parts.push({ type: 'text', text: content }); }
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'input_image' || b.type === 'image_url') {
          const url = typeof b.image_url === 'string' ? b.image_url
            : (b.image_url && typeof b.image_url.url === 'string' ? b.image_url.url
              : (typeof b.url === 'string' ? b.url : undefined));
          if (url) { hasImage = true; parts.push({ type: 'image_url', image_url: { url } }); }
        } else if (typeof b.text === 'string') {
          parts.push({ type: 'text', text: b.text });
        }
      }
    }
    if (!parts.length) return;
    messages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: hasImage ? parts : parts.map((p) => p.text || '').join(''),
      ...(role === 'assistant' ? { __assistant: true } : {}),
    });
  };

  const input = body && body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'reasoning') continue;
      if (item.type === 'function_call') { pushCall(item); continue; }
      if (item.type === 'function_call_output') {
        // 缺 call_id 的输出对不上任何一次工具调用，以前传空串下去，
        // 直到 worker 的 toQoderMessages 才报「tool 结果缺 tool_call_id」，指不到真因。
        if (typeof item.call_id !== 'string' || !item.call_id) {
          throw new Error('function_call_output 缺少 call_id');
        }
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : textOf(item.output),
        });
        continue;
      }
      const role = typeof item.role === 'string' ? item.role : (item.type === 'message' ? 'user' : undefined);
      if (!role) continue;
      if (role === 'system' || role === 'developer') { messages.push({ role: 'system', content: textOf(item.content) }); continue; }
      pushMessage(role, item.content);
    }
  }

  const tools = Array.isArray(body && body.tools)
    ? body.tools
      .filter((t) => t && t.type === 'function' && typeof t.name === 'string' && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
        },
      }))
    : [];

  const effort = body && body.reasoning && typeof body.reasoning.effort === 'string' ? body.reasoning.effort : undefined;

  return {
    model: body && typeof body.model === 'string' ? body.model : '',
    messages,
    tools,
    maxTokens: Number.isSafeInteger(body && body.max_output_tokens) ? body.max_output_tokens : undefined,
    stream: !(body && body.stream === false),
    reasoningEffort: effort,
  };
}

// ---------- 下行：chat chunk → OpenAI Responses SSE ----------

// 上游的 finish_reason 以前被算出来就扔了，所有响应一律报 completed。
// 后果：被 max_tokens 截断的半截回答，在客户端看起来是「正常说完的」，
// 调工具的会被当成模型自己不想调了，读代码的会以为文件就这么长。
// 这里按 OpenAI Responses 的语义映射：length → incomplete，content_filter → failed。
function responsesStatusOf(finish) {
  if (finish === 'length') {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  }
  if (finish === 'content_filter') {
    return { status: 'failed', error: { code: 'content_filter', message: '上游按内容策略截断了这次回答' } };
  }
  return { status: 'completed' };
}

function responsesUsage(usage, inputTokens) {
  const out = (usage && usage.completion_tokens) || 0;
  const inp = (usage && usage.prompt_tokens) || inputTokens || 0;
  return {
    input_tokens: inp,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: out,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inp + out,
  };
}

async function writeResponsesStream(res, first, iterator, opts) {
  const id = 'resp_' + randomBytes(12).toString('hex');
  const createdAt = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);

  const base = () => ({
    id, object: 'response', created_at: createdAt, model: opts.model,
    status: 'in_progress', output: [], usage: null,
  });
  send({ type: 'response.created', response: base() });
  send({ type: 'response.in_progress', response: base() });

  const msgItemId = 'msg_' + randomBytes(12).toString('hex');
  let nextIndex = 0;
  let msgIndex = null;
  let msgAdded = false;
  let text = '';
  const callIndex = new Map();
  const calls = new Map();
  let finish = 'stop';
  let usage;

  const ensureMessage = () => {
    if (msgAdded) return;
    msgAdded = true;
    msgIndex = nextIndex++;
    send({ type: 'response.output_item.added', output_index: msgIndex, item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send({ type: 'response.content_part.added', item_id: msgItemId, output_index: msgIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };

  try {
    for (let s = first; !s.done; s = await iterator.next()) {
      const c = s.value;
      if (c && c.usage) usage = c.usage;
      const ch = c && c.choices && c.choices[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      if (typeof ch.finish_reason === 'string') finish = ch.finish_reason;

      if (typeof d.content === 'string' && d.content) {
        ensureMessage();
        text += d.content;
        send({ type: 'response.output_text.delta', item_id: msgItemId, output_index: msgIndex, content_index: 0, delta: d.content });
      }

      if (Array.isArray(d.tool_calls)) {
        for (const t of d.tool_calls) {
          const key = t.index ?? 0;
          if (!callIndex.has(key)) {
            const idx = nextIndex++;
            callIndex.set(key, idx);
            const item = {
              id: 'fc_' + randomBytes(10).toString('hex'),
              callId: (t.id && String(t.id)) || 'call_' + randomBytes(8).toString('hex'),
              name: (t.function && t.function.name) || '',
              args: '',
            };
            calls.set(idx, item);
            send({
              type: 'response.output_item.added',
              output_index: idx,
              item: { id: item.id, type: 'function_call', status: 'in_progress', call_id: item.callId, name: item.name, arguments: '' },
            });
          }
          const idx = callIndex.get(key);
          const item = calls.get(idx);
          if (t.id) item.callId = String(t.id);
          if (t.function && typeof t.function.name === 'string' && t.function.name) item.name = t.function.name;
          if (t.function && typeof t.function.arguments === 'string' && t.function.arguments) {
            item.args += t.function.arguments;
            send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: idx, delta: t.function.arguments });
          }
        }
      }
    }

    const state = responsesStatusOf(finish);
    // 子项（message / function_call）的状态跟随整体：截断了就不该标 completed
    const itemStatus = state.status === 'completed' ? 'completed' : 'incomplete';
    const output = [];
    if (msgAdded) {
      send({ type: 'response.output_text.done', item_id: msgItemId, output_index: msgIndex, content_index: 0, text });
      send({ type: 'response.content_part.done', item_id: msgItemId, output_index: msgIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      const item = { id: msgItemId, type: 'message', status: itemStatus, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
      send({ type: 'response.output_item.done', output_index: msgIndex, item });
      output.push({ index: msgIndex, item });
    }
    for (const [idx, item] of calls) {
      send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: idx, arguments: item.args });
      const done = { id: item.id, type: 'function_call', status: itemStatus, call_id: item.callId, name: item.name, arguments: item.args };
      send({ type: 'response.output_item.done', output_index: idx, item: done });
      output.push({ index: idx, item: done });
    }

    const completed = {
      id, object: 'response', created_at: createdAt, model: opts.model,
      ...state,
      output: output.sort((a, b) => a.index - b.index).map((o) => o.item),
      usage: responsesUsage(usage, opts.inputTokens),
    };
    // 截断发 incomplete、内容策略发 failed，正常才发 completed
    send({ type: `response.${state.status}`, response: completed });
    res.end();
  } catch (e) {
    send({ type: 'response.failed', response: { ...base(), status: 'failed', error: { code: 'upstream_error', message: e.message } } });
    res.end();
  }
}

async function responsesMessage(first, iterator, opts) {
  let text = '';
  const calls = new Map();
  let finish = 'stop';
  let usage;

  for (let s = first; !s.done; s = await iterator.next()) {
    const c = s.value;
    if (c && c.usage) usage = c.usage;
    const ch = c && c.choices && c.choices[0];
    if (!ch) continue;
    const d = ch.delta || ch.message || {};
    if (typeof ch.finish_reason === 'string') finish = ch.finish_reason;
    if (typeof d.content === 'string') text += d.content;
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const key = t.index ?? 0;
        const cur = calls.get(key) || { id: '', callId: '', name: '', args: '' };
        if (t.id) cur.callId = String(t.id);
        if (t.function && typeof t.function.name === 'string' && t.function.name) cur.name = t.function.name;
        if (t.function && typeof t.function.arguments === 'string') cur.args += t.function.arguments;
        calls.set(key, cur);
      }
    }
  }

  const state = responsesStatusOf(finish);
  const itemStatus = state.status === 'completed' ? 'completed' : 'incomplete';
  const output = [];
  if (text) {
    output.push({
      id: 'msg_' + randomBytes(12).toString('hex'),
      type: 'message', status: itemStatus, role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const c of calls.values()) {
    output.push({
      id: 'fc_' + randomBytes(10).toString('hex'),
      type: 'function_call', status: itemStatus,
      call_id: c.callId || 'call_' + randomBytes(8).toString('hex'),
      name: c.name, arguments: c.args,
    });
  }

  return {
    id: 'resp_' + randomBytes(12).toString('hex'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: opts.model,
    ...state,
    output,
    usage: responsesUsage(usage, opts.inputTokens),
  };
}

module.exports = {
  anthropicRequestToChat,
  writeAnthropicStream,
  anthropicMessage,
  responsesRequestToChat,
  writeResponsesStream,
  responsesMessage,
  estimateTokens,
};
