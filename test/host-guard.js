// Host 守卫回归：只放行 loopback，但不该依赖“带端口”。
//
// 踩过的坑：Cindy 的 anthropic-compat-proxy 转发时把 Host 改成
//   host: actualTarget.hostname        // proxy.mjs，不带端口
// 于是后端收到的 Host 是 "127.0.0.1"（没有 :47821）。
// 旧的 hostOk 只认 "127.0.0.1:" 前缀 —— claude-code 引擎一律 403 Host 必须是 loopback。
//
// 本测试直接起真 worker，用不同 Host 头打 /healthz（不需要 token），
// 断言 loopback 的各种写法都放行、非 loopback 一律 403。

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const WORKER = path.join(__dirname, '..', 'plugin', 'node', 'worker.cjs');
const PORT = Number(process.env.HOST_GUARD_PORT || 47955);

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

function request(hostHeader) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/healthz',
      method: 'GET',
      headers: hostHeader === null ? {} : { host: hostHeader },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-hostguard-'));
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, CINDY_QODER_DATA: dataDir, CINDY_QODER_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});

  // 等端口起来
  let up = false;
  for (let i = 0; i < 120; i++) {
    const r = await request('127.0.0.1:' + PORT);
    if (r.status === 200) { up = true; break; }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!up) {
    console.log('FAIL：worker 没起来');
    child.kill();
    process.exit(1);
  }

  // 必须放行的（Cindy 的代理会用不带端口的形式）
  const allow = [
    '127.0.0.1',
    '127.0.0.1:' + PORT,
    'localhost',
    'localhost:' + PORT,
    '[::1]',
    '[::1]:' + PORT,
    '::1',
    '127.0.0.2',
  ];
  // 必须拒绝的
  const deny = [
    'example.com',
    'evil.com:' + PORT,
    '10.0.0.1:' + PORT,
    '192.168.1.10',
    '127.0.0.1.evil.com',
  ];

  for (const h of allow) {
    const r = await request(h);
    check('放行 Host=' + h, r.status === 200, 'got ' + r.status + ' ' + (r.body || r.error || '').slice(0, 80));
  }
  for (const h of deny) {
    const r = await request(h);
    check('拒绝 Host=' + h, r.status === 403, 'got ' + r.status);
  }

  child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}

  console.log('\n' + pass + ' 通过 ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
