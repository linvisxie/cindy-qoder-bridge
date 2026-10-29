// 离线验收：panel.js 在模拟 DOM + 模拟电子脑下能否把状态渲染出来。
// 不碰 Cindy，只证明「脚本能跑、字段能填、请求能被应答」这条链是通的。
// 数据用真实 worker 的 qoder/status 结果，避免拿假字段自娱自乐。
'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const WORKER = join(ROOT, 'plugin', 'node', 'worker.cjs');
const PANEL_JS = join(ROOT, 'plugin', 'panel.js');

// ---------- 1. 拿真实 status ----------
function askWorker(method, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    // 0.1.7 起端口咬死 PREFERRED_PORT，测试必须给独立数据目录与端口，否则会去抢真身占着的 47821
    const child = spawn(process.execPath, [WORKER], { env: { ...process.env, CINDY_QODER_DATA: mkdtempSync(join(os.tmpdir(), 'qoder-e2e-')), CINDY_QODER_PORT: '47971' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker 超时')); }, timeoutMs);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1) continue;
        clearTimeout(timer);
        child.kill();
        if (msg.error) reject(new Error(msg.error.message || 'worker 报错'));
        // worker 的回包是双层的：{jsonrpc,id,result:{ok:true,result:<真实值>}}
        else {
          const outer = msg.result;
          if (outer && outer.ok === false) reject(new Error(outer.message || 'worker 返回失败'));
          else resolve(outer && outer.result !== undefined ? outer.result : outer);
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) + '\n');
  });
}

// ---------- 2. 极简 DOM ----------
function makeDom(ids) {
  const store = new Map();
  for (const id of ids) store.set(id, { id, textContent: '', innerHTML: '', className: '', hidden: false, disabled: false, listeners: {} });
  const doc = {
    getElementById: (id) => store.get(id) || null,
  };
  return { doc, store };
}

function makeElement(id) {
  return {
    id, textContent: '', innerHTML: '', className: '', hidden: false, disabled: false,
    addEventListener(type, fn) { this[type] = fn; },
  };
}

(async () => {
  const status = await askWorker('qoder/status');
  console.log('worker status: signedIn=%s user=%s models=%d port=%s',
    status.signedIn, status.user, status.modelCount, status.port);

  const el = {};
  const elements = ['dot', 'title', 'user', 'modelCount', 'quota', 'port', 'err',
    'baseUrl', 'token', 'mcount', 'models', 'refresh', 'copy',
    'resetAt', 'expiresAt', 'ckState', 'ckNext', 'localUsage', 'checkin'];
  for (const id of elements) el[id] = makeElement(id);

  const document = { getElementById: (id) => el[id] || null };

  // 模拟 BroadcastChannel 的另一端 = 电子脑（真实 main.js 的应答语义）
  const bus = [];
  class FakeChannel {
    constructor(name) { this.name = name; this.peer = null; bus.push(this); }
    postMessage(data) {
      // 面板 → 电子脑：模拟 main.js 的 reqId 去重 + 异步应答
      if (data && data.__panel === true) {
        setTimeout(() => {
          let value;
          if (data.type === 'status') value = status;
          else if (data.type === 'endpoint') {
            value = { ok: true, baseUrl: status.baseUrl, token: status.token, models: status.models };
          } else value = null;
          this.onmessage({ data: { __brain: true, reqId: data.reqId, value } });
        }, 30);
      }
    }
    set onmessage(fn) { this._onmessage = fn; }
    get onmessage() { return this._onmessage; }
  }

  const fetches = [];
  const sandbox = {
    document,
    BroadcastChannel: FakeChannel,
    fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({ state: 'running' }) }; },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    console,
  };

  const code = readFileSync(PANEL_JS, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'panel.js' });

  // 等 load() 完成
  await new Promise((r) => setTimeout(r, 600));

  const checks = [];
  const expect = (name, got, want) => {
    const pass = typeof want === 'function' ? want(got) : got === want;
    checks.push({ name, pass, got });
  };

  expect('唤醒 fetch 打到 cindy-ghost://qoder-bridge/wake', fetches[0], 'cindy-ghost://qoder-bridge/wake');
  expect('标题', el.title.textContent, 'Qoder 桥');
  // 未登录的机器上（没有 Qoder CN 客户端）账号/模型这些全空，逐项硬断言只会误报。
  // 这里把「必须依赖登录态」的几项在未登录时降级成跳过，而不是判失败（issue #7）。
  const signedIn = status.signedIn === true;
  const guarded = (name, got, want) => {
    if (!signedIn) { console.log(`SKIP  ${name}（未登录 Qoder，跳过）`); return; }
    expect(name, got, want);
  };
  guarded('账号', el.user.textContent, status.user);
  guarded('模型数', el.modelCount.textContent, status.modelCount + ' 个');
  guarded('额度含已用', el.quota.textContent, (v) => /已用 \d+ \/ \d+/.test(v));
  const firstModelId = (status.models && status.models[0] && status.models[0].id) || '';
  guarded('模型列表已渲染（不再显示「正在叫醒插件」）', el.models.innerHTML,
    (v) => firstModelId !== '' && v.includes(firstModelId) && !v.includes('正在叫醒'));
  guarded('BaseURL 已填', el.baseUrl.textContent, status.baseUrl);
  guarded('Token 已填', el.token.textContent, status.token);
  expect('端口', el.port.textContent, (v) => String(v) === String(status.port));
  expect('绿灯', el.dot.className, 'dot ok');

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  got=' + JSON.stringify(c.got).slice(0, 120)}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
