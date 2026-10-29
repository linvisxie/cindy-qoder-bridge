// Qoder 桥 · 电子脑（浏览器沙箱）
// 职责：把 AI 工具调用和面板请求转给 Node worker。
// 这一层没有文件系统、没有 Node、没有通用网络直连。
'use strict';

const GHOST_ID = 'qoder-bridge';
const CHANNEL = 'qoder-bridge-panel';

let lastStatus = null;
const seen = new Set();

/**
 * cindy.node.request 的返回值是**两层**的：
 *   { ok:true, result: { ok:true, result: <worker 真正返回的东西> } }
 * 外层是主机的 invoke 信封，内层是 worker 自己写的 JSON-RPC result。
 * 少解一层，面板拿到的就是信封本身 —— signedIn/modelCount/port 全是 undefined，
 * 于是显示「未登录 / 0 个 / —」。这里统一剥到底。
 */
function unwrap(res) {
  let cur = res;
  for (let depth = 0; depth < 4; depth++) {
    if (!cur || typeof cur !== 'object') return cur;
    if (cur.ok === false) throw new Error(cur.message || 'Node worker 返回失败');
    if (cur.ok === true && Object.prototype.hasOwnProperty.call(cur, 'result')) {
      cur = cur.result;
      continue;
    }
    return cur;
  }
  return cur;
}

async function callWorker(method, callId) {
  const res = await cindy.node.request({
    method,
    params: {},
    // 工具调用内带上 callId，让主机把这次 Node 请求绑定到当前在途调用；
    // 面板触发的请求没有 callId，走独立 RPC 生命周期（文档允许）。
    ...(callId ? { callId, cancelWithCall: true } : {}),
  });
  return unwrap(res);
}

async function getStatus(force, callId) {
  if (!force && lastStatus && Date.now() - lastStatus.at < 5000) return lastStatus.value;
  const value = await callWorker('qoder/status', callId);
  lastStatus = { at: Date.now(), value };
  return value;
}

function hintFor(st) {
  if (!st.signedIn) return '未登录。请先在 Qoder CN 客户端登录，再点「刷新」。';
  return '';
}

function fmtTime(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- AI 工具调用 ----------

cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  const ok = (result) => cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result });
  const fail = (message, errorCode) => cindy.send({
    type: 'tool-result', callId: msg.callId, ok: false,
    ...(errorCode ? { errorCode } : {}), message,
  });

  try {
    if (msg.tool === 'qoder_status') {
      const st = await getStatus(true, msg.callId);
      const lines = [];
      if (st.signedIn) {
        lines.push(`Qoder 桥：正常运行（127.0.0.1:${st.port}）`);
        lines.push(`账号：${st.user || '(未知)'}`);
        lines.push(`模型：${st.modelCount} 个`);
        const q = st.quota;
        if (q && typeof q.total === 'number' && q.total > 0) {
          lines.push(`额度：已用 ${q.used} / ${q.total}，剩余 ${q.remaining}`);
        } else if (q && q.note) {
          lines.push(`额度：${q.note}`);
        }
        const u = st.usage || {};
        const resets = (q && q.resetAt) || u.resetAt;
        const expires = (q && q.expiresAt) || u.expiresAt;
        if (resets) lines.push(`额度重置：${fmtTime(resets)}`);
        else if (u.at) lines.push('额度重置：Qoder 接口没给');
        if (expires) lines.push(`会员到期：${fmtTime(expires)}`);
        const ck = st.checkin;
        if (ck && ck.active === false) {
          lines.push(`签到：暂时没有活动${ck.nextAt ? `，下次 ${fmtTime(ck.nextAt)} 再看` : ''}`);
        } else if (ck) {
          if (ck.claimable) {
            lines.push(`签到：还没签，可领 ${ck.amount || 100} ${ck.kind === 'CREDITS' ? 'Credits' : (ck.kind || 'Credits')}（每天 10:00 换新）`);
          } else if (ck.todayCheckedIn) {
            lines.push(`签到：今天已签过${ck.nextAt ? `，下次 ${fmtTime(ck.nextAt)}` : ''}`);
          } else {
            lines.push('签到：暂时没有可领的活动');
          }
        }
        const lu = st.localUsage?.today;
        if (lu && lu.requests > 0) {
          lines.push(`今日用量：${lu.requests} 次请求，${lu.tokens} tokens（折算 ${Math.round(lu.weighted)}）`);
        }
        if (st.lastError) lines.push(`注意：${st.lastError}`);
      } else {
        lines.push('Qoder 桥：未登录。');
        lines.push(st.hint || hintFor(st));
      }
      ok({ text: lines.join('\n') });
      return;
    }

    if (msg.tool === 'qoder_endpoint') {
      const ep = await callWorker('qoder/endpoint', msg.callId);
      if (!ep.ok) { fail(ep.message || '读不到端点信息'); return; }
      const text = [
        '在 Cindy 里配置一次就能长期使用：',
        '',
        '设置 → 模型 → 添加自定义供应商',
        '  显示名：Qoder',
        '  协议：OpenAI Compatible / Chat Completions',
        `  Base URL：${ep.baseUrl}`,
        `  API Key：${ep.token}`,
        '',
        '然后在供应商下逐个「添加模型 ID」，上下文窗口填 1000000，勾选视觉输入：',
        ...ep.models.map((m) => `  ${m.id}（${m.name}）`),
      ].join('\n');
      ok({ text });
      return;
    }

    if (msg.tool === 'qoder_refresh') {
      const st = await callWorker('qoder/refresh', msg.callId);
      lastStatus = null;
      ok({
        text: st.signedIn
          ? `已刷新：${st.user || '(已登录)'}，${st.modelCount} 个模型可用，端口 ${st.port}。`
          : `刷新后仍未读到登录态。${st.hint || hintFor(st)}`,
      });
      return;
    }

    if (msg.tool === 'qoder_checkin') {
      const r = await callWorker('qoder/checkin', msg.callId);
      lastStatus = null;
      const st = r.status || {};
      const ck = st.checkin || {};
      const lines = [r.message || (r.claimed ? '签到成功' : '没有签到')];
      if (r.amount) lines.push(`本次领取：${r.amount} Credits`);
      if (ck.todayCheckedIn || r.claimed) lines.push(`签到状态：今天已签${ck.nextAt ? `，下次 ${fmtTime(ck.nextAt)}` : ''}`);
      const q = st.quota;
      if (q && typeof q.total === 'number' && q.total > 0) lines.push(`额度：已用 ${q.used} / ${q.total}，剩余 ${q.remaining}`);
      ok({ text: lines.join('\n') });
      return;
    }

    fail(`未知工具：${msg.tool}`);
  } catch (e) {
    fail(`Qoder 桥内部错误：${e && e.message ? e.message : String(e)}。可在插件面板查看状态。`);
  }
});

// ---------- 面板请求（BroadcastChannel） ----------

let channel;
try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }

if (channel) {
  channel.onmessage = async (event) => {
    const data = event && event.data;
    if (!data || data.__panel !== true || typeof data.reqId !== 'string') return;
    if (seen.has(data.reqId)) return;          // 面板会重发，按 reqId 去重
    seen.add(data.reqId);
    // 只淘汰最早的那条，别一次清空：清空后旧 reqId 再重发会被当成新请求，
    // 对签到这种有副作用的动作就是重复提交（靠上游幂等兜着，但没必要赌）。
    while (seen.size > 200) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }

    const send = (value) => {
      try { channel.postMessage({ __brain: true, reqId: data.reqId, value }); } catch {}
    };

    try {
      if (data.type === 'status') {
        send(await getStatus(false));
      } else if (data.type === 'refresh') {
        const st = await callWorker('qoder/refresh');
        lastStatus = null;
        send(st);
      } else if (data.type === 'endpoint') {
        send(await callWorker('qoder/endpoint'));
      } else if (data.type === 'checkin') {
        const r = await callWorker('qoder/checkin');
        lastStatus = null;
        send(r);
      } else {
        send(null);
      }
    } catch (e) {
      send({ error: e && e.message ? e.message : String(e) });
    }
  };
}
