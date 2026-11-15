// Qoder 桥 · 面板脚本
// 必须是外挂文件：Cindy 的 CSP 同源但不放行内联 <script>，写在 panel.html 里不会执行。
// 面板无 preload 桥，只有同源 fetch + BroadcastChannel 两条通路。
(() => {
  const $ = (id) => document.getElementById(id);
  const GHOST_ID = 'qoder-bridge';
  const CHANNEL = 'qoder-bridge-panel';
  // 唤醒地址必须用协议头 cindy-ghost://，不是 /wake 路径
  const WAKE_URL = 'cindy-ghost://' + GHOST_ID + '/wake';

  const fmtPrice = (p) => (p === 0 ? '免费' : (p === undefined || p === null ? '' : 'x' + p));
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    const n = Number(ms);
    if (!ms || !Number.isFinite(n)) return '—';
    const d = new Date(n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtLeft(ms) {
    const n = Number(ms);
    if (!ms || !Number.isFinite(n)) return '';
    const diff = n - Date.now();
    if (diff <= 0) return '已到点';
    const m = Math.round(diff / 60000);
    if (m < 60) return `${m} 分钟后`;
    const h = Math.floor(m / 60);
    return `${h} 小时 ${m % 60} 分后`;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let channel = null;
  try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }

  // 面板自己生成的 reqId 不能与电子脑的 seen 集合冲突：带独立前缀
  const pending = new Map();

  if (channel) {
    channel.onmessage = (event) => {
      const d = event && event.data;
      if (!d || d.__brain !== true) return;
      const resolve = pending.get(d.reqId);
      if (!resolve) return;
      pending.delete(d.reqId);
      resolve(d.value);
    };
  }

  /**
   * 递活给电子脑：先 /wake 叫醒，再按 reqId 每 400ms 重发，直到收到回执。
   * 电子脑侧按 reqId 去重，重复投递无害。
   */
  async function ask(type, timeoutMs = 12000) {
    if (!channel) return { error: '面板不支持 BroadcastChannel' };
    const reqId = type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let timer, resend;
    const p = new Promise((resolve) => pending.set(reqId, resolve));
    const payload = { __panel: true, reqId, type };
    const send = () => { try { channel.postMessage(payload); } catch {} };
    try {
      const timeout = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); });
      // 唤醒失败或挂起也不能阻塞 RPC 的超时与按钮恢复。
      Promise.resolve().then(() => fetch(WAKE_URL)).catch(() => {});
      resend = setInterval(send, 400);
      send();
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
      clearInterval(resend);
      pending.delete(reqId);
    }
  }

  function render(st) {
    if (!st || st.error) {
      $('dot').className = 'dot err';
      $('title').textContent = 'Qoder 桥 · 连接失败';
      if (st && st.error) { $('err').hidden = false; $('err').textContent = st.error; }
      return;
    }
    const signedIn = st.signedIn === true;
    $('dot').className = 'dot ' + (signedIn ? 'ok' : 'err');
    $('title').textContent = 'Qoder 桥';
    $('user').textContent = st.user || (signedIn ? '(已登录)' : '未登录');
    $('modelCount').textContent = (st.modelCount || 0) + ' 个';
    $('port').textContent = st.port || '—';

    const q = st.quota;
    // 额度是旧值时明确标出来，别让「上一次的数字」冒充「现在的数字」。
    const stale = q && q.stale ? '（旧值）' : '';
    if (q && typeof q.total === 'number' && q.total > 0) {
      $('quota').textContent = `已用 ${q.used} / ${q.total}（${Math.round(q.used / q.total * 100)}%）${stale}`;
    } else {
      $('quota').textContent = ((q && q.note) ? q.note : '—') + stale;
    }

    renderUpdate(st);
    if (st.lastError) { $('err').hidden = false; $('err').textContent = st.lastError; }
    else $('err').hidden = true;

    const usage = st.usage || {};
    const resets = (q && q.resetAt) || usage.resetAt;
    const expires = (q && q.expiresAt) || usage.expiresAt;
    // Qoder 的用量接口只给会员到期日，没有额度重置时间（字段里压根没有这个键），
    // 所以这里如实说「接口没给」，不要编一个日期出来。
    $('resetAt').textContent = resets
      ? `${fmtTime(resets)}（${fmtLeft(resets)}）`
      : (usage.at ? 'Qoder 接口没给' : '—');
    $('expiresAt').textContent = expires ? fmtTime(expires) : (usage.at ? 'Qoder 接口没给' : '—');

    const ck = st.checkin || {};
    const chip = $('ckState');
    if (ck.claimable) {
      chip.className = 'chip warn';
      chip.textContent = `可领 ${ck.amount || 100} ${ck.kind === 'CREDITS' ? 'Credits' : (ck.kind || 'Credits')}`;
    } else if (ck.todayCheckedIn) {
      chip.className = 'chip ok';
      chip.textContent = '今天已签';
    } else if (ck.error) {
      chip.className = 'chip';
      chip.textContent = '读取失败';
    } else {
      chip.className = 'chip';
      chip.textContent = '暂无活动';
    }
    $('ckNext').textContent = ck.nextAt ? `${fmtTime(ck.nextAt)}（${fmtLeft(ck.nextAt)}）` : '—';

    const today = st.localUsage && st.localUsage.today;
    $('localUsage').textContent = today && today.requests > 0
      ? `今日 ${today.requests} 次 · ${today.tokens} tokens · 折算 ${Math.round(today.weighted)}`
      : '今天还没用过';

    if (st.baseUrl) $('baseUrl').textContent = st.baseUrl;
    if (st.token) $('token').textContent = st.token;

    const list = st.models || [];
    $('mcount').textContent = list.length ? `（${list.length}）` : '';
    $('models').innerHTML = list.length
      ? list.map((m) => {
        const eff = Array.isArray(m.effortLevels) && m.effortLevels.length
          ? `<span class="eff">档位 ${esc(m.effortLevels.join('/'))}</span>` : '';
        return `<div class="m"><span class="id">${esc(m.id)}</span>
          <span class="meta">${esc(m.name || '')} <span class="lab">${esc(fmtPrice(m.priceFactor))} · ${Math.round((m.contextWindow || 1000000) / 1000)}K</span> ${eff}</span></div>`;
      }).join('')
      : '<div class="hint">还没有模型。确认 Qoder CN 客户端已登录，然后点上面的「刷新」。</div>';
  }

  async function load() {
    const st = await ask('status');
    if (st === null) {
      $('dot').className = 'dot warn';
      $('title').textContent = 'Qoder 桥 · 未响应';
      $('models').innerHTML = '<div class="hint">插件还没起来。稍等几秒会自动重试，或点「刷新登录态与模型」。</div>';
      return;
    }
    render(st);
  }

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    btn.disabled = true; btn.textContent = '刷新中…';
    render(await ask('refresh', 30000));
    btn.disabled = false; btn.textContent = '刷新登录态与模型';
  });

  $('copy').addEventListener('click', async () => {
    const ep = await ask('endpoint');
    const btn = $('copy');
    if (!ep || !ep.baseUrl) { btn.textContent = '读不到配置'; setTimeout(() => { btn.textContent = '复制配置'; }, 1500); return; }
    const text = '协议：OpenAI Compatible / Chat Completions\nBase URL：' + ep.baseUrl + '\nAPI Key：' + ep.token;
    try { await navigator.clipboard.writeText(text); btn.textContent = '已复制'; }
    catch { btn.textContent = '复制失败'; }
    setTimeout(() => { btn.textContent = '复制配置'; }, 1500);
  });

  $('checkin').addEventListener('click', async () => {
    const btn = $('checkin');
    btn.disabled = true; btn.textContent = '签到中…';
    const r = await ask('checkin', 30000);
    if (r && r.status) render(r.status);
    btn.textContent = r && r.message ? r.message : (r && r.error) ? ('失败：' + r.error) : '看不到结果';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '立即签到'; load(); }, 2500);
  });

  // 单一处理器：原生确认等待不是失败，也不是安装完成。
  let updateMode = 'check', targetVersion = '', runningVersion = '';
  let updateBusy = false, updateSnapshot = '', checkedLatest = false;
  function updateMessage(text) {
    $('updateMsg').hidden = false;
    $('updateMsg').textContent = text;
  }
  function updateButton() {
    $('checkUpdate').textContent = updateMode === 'retry' ? '重新打开安装确认'
      : updateMode === 'install' ? '安装 ' + targetVersion : '检查更新';
  }
  function versionAtLeast(current, target) {
    if (!current || !target) return false;
    if (current === target) return true;
    const parse = (v) => /^v?\d+(\.\d+)*$/.test(v) ? v.replace(/^v/, '').split('.').map(Number) : null;
    const a = parse(current), b = parse(target);
    if (!a || !b) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return true;
  }
  function renderUpdate(st) {
    const native = st.updateResult || {};
    const snapshot = JSON.stringify([st.version, native.state, native.status, native.targetVersion,
      native.message, native.error, native.resultPath]);
    if (updateBusy || snapshot === updateSnapshot) return;
    updateSnapshot = snapshot;
    runningVersion = st.version || runningVersion;
    // 「已最新」只能由检查确认，保留到下次主动操作；轮询（包括迟到的旧版本）不能覆盖。
    if (checkedLatest) return;
    const target = targetVersion || (native.state ? native.targetVersion : '');
    // 完成必须达到本轮目标；旧 attempt 的 completed 不能清掉更高的待安装目标。
    if (target && versionAtLeast(st.version, target)) {
      targetVersion = '';
      updateMode = 'check';
      updateMessage('安装完成，当前运行版本 ' + st.version);
    } else if (native.state && native.state !== 'completed'
      && (!targetVersion || !native.targetVersion || native.targetVersion === targetVersion)) {
      targetVersion = target || '';
      updateMode = 'retry';
      const fallback = native.state === 'preparing' ? '正在准备原生安装确认。'
        : native.state === 'open_failed' ? '打开原生安装确认失败，可重试。'
        : native.state === 'awaiting_confirmation' ? '正在等待 Cindy 原生安装确认；若已取消，可重新打开安装确认。'
        : '尚未确认安装完成，可重新打开安装确认。';
      updateMessage((targetVersion ? '目标版本 ' + targetVersion + '：' : '') + (native.message || fallback));
    } else if (!native.state && native.status && !targetVersion) {
      // 旧安装日志仅作诊断，不是原生完成凭据，也不能覆盖本轮待安装目标。
      updateMessage('旧版更新记录（' + native.status + '）：'
        + (native.message || native.error || native.resultPath || '暂无诊断信息'));
    }
    updateButton();
  }
  $('checkUpdate').addEventListener('click', async () => {
    if (updateBusy) return;
    const btn = $('checkUpdate');
    const apply = updateMode !== 'check';
    updateBusy = true;
    checkedLatest = false;
    btn.disabled = true;
    btn.textContent = apply ? '正在打开原生安装确认…' : '检查中…';
    updateMessage(apply ? '正在准备 Cindy 原生安装确认…' : '正在检查更新…');
    try {
      const r = await ask(apply ? 'applyUpdate' : 'checkUpdate', apply ? 120000 : 30000);
      if (!r || r.error) throw new Error((r && r.error) || '请求超时，没有响应');
      if (apply) {
        // apply 可能重新检查到了比之前 check 更新的版本，兼容旧 worker 的 latest 字段。
        targetVersion = r.latest || r.targetVersion || targetVersion;
        if (r.status === 'up_to_date') {
          targetVersion = ''; updateMode = 'check'; checkedLatest = true;
          updateMessage('已是最新版本（' + (r.current || runningVersion || '当前') + '）');
        } else if (r.status === 'awaiting_confirmation' || r.installRequested) {
          updateMode = 'retry';
          updateMessage((targetVersion ? '目标版本 ' + targetVersion + '：' : '')
            + (r.message || '正在等待 Cindy 原生安装确认；若已取消，可重新打开安装确认。'));
        } else {
          updateMode = 'retry';
          updateMessage(r.message || '尚未确认安装完成，可重新打开安装确认。');
        }
      } else if (!r.hasUpdate) {
        targetVersion = ''; updateMode = 'check'; checkedLatest = true;
        updateMessage('已是最新版本（' + (r.current || '当前') + '）');
      } else {
        targetVersion = r.latest || r.targetVersion; updateMode = 'install';
        updateMessage('发现新版本 ' + targetVersion + '（当前 ' + r.current + '），点「安装 ' + targetVersion + '」将打开 Cindy 原生安装确认，请在 Cindy 中确认安装。');
      }
    } catch (e) {
      updateMode = apply ? 'retry' : 'check';
      updateMessage((apply ? '打开安装确认失败：' : '检查失败：') + (e.message || String(e)) + '，可重试。');
    } finally {
      updateBusy = false;
      btn.disabled = false;
      updateButton();
    }
  });

  load();
  setInterval(load, 15000);
})();
