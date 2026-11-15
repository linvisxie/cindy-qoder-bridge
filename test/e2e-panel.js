// 完全离线：真实 main.js + panel.js，虚拟 BroadcastChannel、时钟与 DOM fixtures。
// 不启动 worker、不读取本机账号、不访问 GUI 或上游。
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const root = join(__dirname, '..');
const mainCode = readFileSync(join(root, 'plugin/main.js'), 'utf8');
const panelCode = readFileSync(join(root, 'plugin/panel.js'), 'utf8');
const html = readFileSync(join(root, 'plugin/panel.html'), 'utf8');
const identity = /const GHOST_ID = '([^']+)'/.exec(mainCode)[1];
const name = identity.split('-')[0];
const title = name === 'qoder' ? 'Qoder 桥' : 'Trae 桥';
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture() {
  let now = 100000, nextId = 1, hostHandler;
  const timers = new Map(), channels = [], calls = [], fetches = [], results = [];
  const el = {};
  for (const [, id] of panelCode.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(html.includes('id="' + id + '"'), 'HTML declares ' + id);
    el[id] = { textContent: '', innerHTML: '', hidden: false, disabled: false, className: '', listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  }
  const state = {
    status: { signedIn: true, user: 'fixture', accountName: 'fixture', region: 'cn', modelCount: 1,
      models: [{ id: 'fixture-model', name: 'Fixture' }], port: 47971, version: '1.0.0',
      quota: { total: 100, used: 10 }, token: 'fixture-token-not-a-secret', baseUrl: 'http://fixture/v1' },
    check: { hasUpdate: true, current: '1.0.0', latest: '1.1.0' },
    apply: { applied: false, installRequested: true, status: 'awaiting_confirmation',
      targetVersion: '1.1.0', message: '正在等待 Cindy 原生安装确认。' },
    fail: '', hang: '', wakeHang: false,
  };
  const timer = (fn, ms, repeat) => {
    const id = nextId++; timers.set(id, { fn, at: now + ms, repeat }); return id;
  };
  class Channel {
    constructor(channelName) { this.name = channelName; channels.push(this); }
    postMessage(data) {
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        Promise.resolve().then(() => peer.onmessage?.({ data }));
      }
    }
  }
  class ClockDate extends Date { static now() { return now; } }
  const common = { console, Date: ClockDate, BroadcastChannel: Channel,
    setTimeout: (fn, ms) => timer(fn, ms, 0), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: (id) => timers.delete(id) };
  const cindy = {
    onHostMessage: (fn) => { hostHandler = fn; }, send: (r) => results.push(r),
    node: { request: async ({ method }) => {
      const action = method.split('/')[1]; calls.push(action);
      if (state.hang === action) return new Promise(() => {});
      if (state.fail === action) throw new Error('fixture error');
      const value = action === 'status' || action === 'refresh' ? state.status
        : action === 'checkUpdate' ? state.check : action === 'applyUpdate' ? state.apply : {};
      return { ok: true, result: { ok: true, result: JSON.parse(JSON.stringify(value)) } };
    } },
  };
  vm.runInNewContext(mainCode, { ...common, cindy }, { filename: 'main.js' });
  vm.runInNewContext(panelCode, { ...common, document: { getElementById: (id) => el[id] },
    fetch: (url) => { fetches.push(url); return state.wakeHang ? new Promise(() => {}) : Promise.resolve({ ok: true }); },
    navigator: { clipboard: { writeText: async () => {} } } }, { filename: 'panel.js' });
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      let entry;
      for (const item of timers) if (item[1].at <= end && (!entry || item[1].at < entry[1].at)) entry = item;
      if (!entry) break;
      const [id, t] = entry; now = t.at;
      if (t.repeat) t.at += t.repeat; else timers.delete(id);
      t.fn(); await settle();
    }
    now = end; await settle();
  };
  const click = async () => {
    for (const fn of el.checkUpdate.listeners.click) fn();
    await settle();
  };
  return { state, el, calls, fetches, results, advance, click,
    tool: async (action) => { await hostHandler({ type: 'tool-call', tool: name + '_update', args: { action }, callId: 'fixture-call' }); } };
}

(async () => {
  const f = fixture(); await settle();
  const { state, el } = f;
  const msg = () => el.updateMsg.textContent;
  const button = () => el.checkUpdate.textContent;
  assert.equal(f.fetches[0], 'cindy-ghost://' + identity + '/wake');
  assert.equal(el.title.textContent, title);
  assert.equal(el.port.textContent, 47971);
  assert.ok(el.models.innerHTML.includes('fixture-model'));
  assert.equal(el.checkUpdate.listeners.click.length, 1, 'one click handler');
  await f.click();
  assert.equal(button(), '安装 1.1.0');
  assert.match(msg(), /当前 1.0.0/); assert.match(msg(), /Cindy 原生安装确认/);
  const found = msg(); await f.advance(15000); assert.equal(msg(), found, 'unchanged polling preserves explicit check');
  await f.click();
  assert.match(msg(), /等待.*原生安装确认/);
  assert.equal(button(), '重新打开安装确认'); assert.equal(el.checkUpdate.disabled, false);
  assert.doesNotMatch(msg(), /已是最新|安装完成|安装失败/);
  state.status.updateResult = { state: 'awaiting_confirmation', targetVersion: '1.1.0', message: state.apply.message };
  await f.advance(15000); assert.match(msg(), /等待/);
  // 取消后无需 reload，可再次明确请求；一次点击只有一个 apply RPC。
  const before = f.calls.filter((x) => x === 'applyUpdate').length;
  await f.click();
  assert.equal(f.calls.filter((x) => x === 'applyUpdate').length, before + 1);
  state.status.version = '1.1.0';
  state.status.updateResult = { state: 'completed', targetVersion: '1.1.0', message: '完成' };
  await f.advance(15000);
  assert.equal(msg(), '安装完成，当前运行版本 1.1.0'); assert.equal(button(), '检查更新');
  state.check = { hasUpdate: false, current: '1.1.0', latest: '1.1.0' };
  await f.click(); assert.equal(msg(), '已是最新版本（1.1.0）');
  await f.advance(15000); assert.equal(msg(), '已是最新版本（1.1.0）');
  state.status.updateResult = { state: 'awaiting_confirmation', targetVersion: '1.1.0', message: '旧等待反馈' };
  await f.advance(15000); assert.equal(msg(), '已是最新版本（1.1.0）', 'changed stale native feedback cannot regress latest');
  state.status.updateResult.state = 'completed';
  await f.advance(15000); assert.equal(msg(), '已是最新版本（1.1.0）');
  state.status.version = '1.0.0'; // 迟到的旧 status 也不能冲掉明确检查结果。
  await f.advance(15000); assert.equal(msg(), '已是最新版本（1.1.0）');
  await f.tool('apply'); assert.match(f.results.at(-1).result.text, /等待/);
  delete state.apply.message;
  await f.tool('apply'); assert.match(f.results.at(-1).result.text, /等待.*原生安装确认/);
  state.check.hasUpdate = true;
  await f.tool('check'); assert.match(f.results.at(-1).result.text, /原生安装确认/);
  state.check.hasUpdate = false;
  await f.tool('check'); assert.match(f.results.at(-1).result.text, /已是最新/);

  const g = fixture(); await settle();
  g.state.fail = 'checkUpdate'; await g.click();
  assert.equal(g.el.checkUpdate.disabled, false); assert.match(g.el.updateMsg.textContent, /检查失败/);
  g.state.fail = ''; await g.click();
  g.state.fail = 'applyUpdate'; await g.click();
  assert.equal(g.el.checkUpdate.disabled, false); assert.equal(g.el.checkUpdate.textContent, '重新打开安装确认');
  assert.match(g.el.updateMsg.textContent, /打开安装确认失败/);
  g.state.fail = ''; g.state.hang = 'applyUpdate'; g.state.wakeHang = true;
  await g.click(); await g.click(); // 合成重复点击也必须被 busy guard 拦截。
  const count = g.calls.filter((x) => x === 'applyUpdate').length;
  await g.advance(120001);
  assert.equal(g.calls.filter((x) => x === 'applyUpdate').length, count, 'resends deduplicated by real main.js');
  assert.equal(g.el.checkUpdate.disabled, false); assert.match(g.el.updateMsg.textContent, /超时/);
  g.state.hang = ''; g.state.wakeHang = false;
  await g.click(); assert.match(g.el.updateMsg.textContent, /等待/);

  // 旧 host 没有运行版本字段时，即使 native 声称 completed 也不能误报已运行新版。
  const h = fixture(); delete h.state.status.version; await settle();
  await h.click(); await h.click();
  h.state.status.updateResult = { state: 'completed', targetVersion: '1.1.0', message: '完成' };
  await h.advance(15000); assert.doesNotMatch(h.el.updateMsg.textContent, /安装完成|已是最新/);
  h.state.status.version = '1.2.0';
  h.state.status.updateResult.state = 'awaiting_confirmation';
  await h.advance(15000);
  assert.equal(h.el.updateMsg.textContent, '安装完成，当前运行版本 1.2.0', 'running version >= target is sufficient');
  // apply 的最新目标高于 check；旧 attempt 的完成/等待回包不能清除或降低本轮目标。
  const k = fixture(); await settle(); await k.click();
  k.state.apply = { applied: false, installRequested: true, status: 'awaiting_confirmation', latest: '1.2.0' };
  await k.click();
  assert.match(k.el.updateMsg.textContent, /目标版本 1.2.0/);
  const waiting = k.el.updateMsg.textContent;
  k.state.status.version = '1.1.0';
  for (const phase of ['completed', 'awaiting_confirmation']) {
    k.state.status.updateResult = { state: phase, targetVersion: '1.1.0', message: '旧目标 1.1.0' };
    await k.advance(15000);
    assert.equal(k.el.updateMsg.textContent, waiting);
    assert.equal(k.el.checkUpdate.textContent, '重新打开安装确认');
  }
  await k.click(); assert.match(k.el.updateMsg.textContent, /目标版本 1.2.0/);
  k.state.status.version = '1.2.0';
  await k.advance(15000);
  assert.equal(k.el.updateMsg.textContent, '安装完成，当前运行版本 1.2.0');
  k.state.check = { hasUpdate: false, current: '1.2.0', latest: '1.2.0' };
  await k.click(); await k.advance(15000);
  assert.equal(k.el.updateMsg.textContent, '已是最新版本（1.2.0）');
  k.state.status.updateResult.state = 'completed'; await k.advance(15000);
  assert.equal(k.el.updateMsg.textContent, '已是最新版本（1.2.0）');
  // 下一次主动 check/apply 必须刷新目标，同时支持新接口 targetVersion 字段。
  k.state.check = { hasUpdate: true, current: '1.2.0', latest: '1.3.0' };
  await k.click(); assert.equal(k.el.checkUpdate.textContent, '安装 1.3.0');
  k.state.apply = { applied: false, installRequested: true, status: 'awaiting_confirmation', targetVersion: '1.4.0' };
  await k.click(); assert.match(k.el.updateMsg.textContent, /目标版本 1.4.0/);
  k.state.status.version = '1.3.0';
  k.state.status.updateResult = { state: 'completed', targetVersion: '1.3.0' };
  await k.advance(15000); assert.match(k.el.updateMsg.textContent, /目标版本 1.4.0/);
  k.state.status.version = '1.4.0'; await k.advance(15000);
  assert.equal(k.el.updateMsg.textContent, '安装完成，当前运行版本 1.4.0');

  // 无原生记录时仍显示 legacy 诊断；旧状态不是当前运行版本的安装凭据。
  const legacy = fixture(); await settle();
  legacy.state.status.updateResult = { status: 'handed_off', targetVersion: '1.0.0',
    message: '已交接安装器，等待最终结果。诊断：C:/fixture/updates/result.json；Cindy 安装记录需原生导入完整包刷新。' };
  await legacy.advance(15000);
  assert.match(legacy.el.updateMsg.textContent, /handed_off/);
  assert.match(legacy.el.updateMsg.textContent, /C:\/fixture\/updates\/result.json/);
  assert.match(legacy.el.updateMsg.textContent, /需原生导入完整包刷新/);
  assert.equal(legacy.el.checkUpdate.textContent, '检查更新');
  // 仅 status 改变也必须重新渲染标签，不能只比较 message。
  legacy.state.status.updateResult.status = 'success'; await legacy.advance(15000);
  assert.match(legacy.el.updateMsg.textContent, /旧版更新记录（success）/);
  assert.doesNotMatch(legacy.el.updateMsg.textContent, /安装完成，当前运行版本|已是最新版本/);
  await legacy.click(); await legacy.click();
  const activeMessage = legacy.el.updateMsg.textContent;
  for (const status of ['handed_off', 'success']) {
    legacy.state.status.updateResult = { status, targetVersion: '1.0.0', message: '旧安装器日志' };
    await legacy.advance(15000);
    assert.equal(legacy.el.updateMsg.textContent, activeMessage);
    assert.equal(legacy.el.checkUpdate.textContent, '重新打开安装确认');
  }
  legacy.state.status.version = '1.1.0'; await legacy.advance(15000);
  assert.equal(legacy.el.updateMsg.textContent, '安装完成，当前运行版本 1.1.0');
  legacy.state.check = { hasUpdate: false, current: '1.1.0', latest: '1.1.0' };
  await legacy.click();
  for (const status of ['handed_off', 'success']) {
    legacy.state.status.updateResult = { status, message: '旧安装器日志：C:/fixture/updates/result.json' };
    await legacy.advance(15000);
    assert.equal(legacy.el.updateMsg.textContent, '已是最新版本（1.1.0）');
  }

  const j = fixture(); await settle();
  j.state.hang = 'checkUpdate'; await j.click(); await j.advance(30001);
  assert.equal(j.el.checkUpdate.disabled, false); assert.match(j.el.updateMsg.textContent, /检查失败.*超时/);
  j.state.hang = ''; await j.click(); await j.click();
  for (const phase of ['preparing', 'open_failed', 'unknown']) {
    j.state.status.updateResult = { state: phase, targetVersion: '1.1.0' };
    await j.advance(15000);
    assert.equal(j.el.checkUpdate.disabled, false);
    assert.equal(j.el.checkUpdate.textContent, '重新打开安装确认');
    assert.doesNotMatch(j.el.updateMsg.textContent, /^安装完成|已是最新/);
  }
  j.state.apply = { applied: false, status: 'up_to_date', current: '1.1.0', message: '已是最新版本' };
  await j.click(); assert.equal(j.el.updateMsg.textContent, '已是最新版本（1.1.0）');
  assert.equal(j.el.checkUpdate.textContent, '检查更新');
  console.log('PASS ' + identity + ': offline native update lifecycle, retry, timeout, deduplication and tool messages');
})().catch((e) => { console.error(e); process.exitCode = 1; });
