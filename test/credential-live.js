// Manual Windows acceptance only. Never included in offline CI; never contacts upstream.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const HELP = `Manual real-Windows credential acceptance (no HTTP/upstream/GUI automation).
node test/credential-live.js --app-data <real APPDATA directory> --allow-live-auth-mutation
  [--deadline-seconds 900] [--report <external JSON path>]
Requires an initially signed-in, unexpired Qoder CN profile and real Windows DPAPI.
Watch stdout or atomically replaced --report JSON. At await-client-logout, sign out
in Qoder; at await-client-login, sign in again. Do not restart this harness.
Then it temporarily renames the real auth file, restores it without overwriting
client-created files, and tests AES key rotation ONLY on a temporary profile copy.
No real Local State or Windows DPAPI master key is changed. Expiry uses VM Date only.
Reports contain stage/booleans, never credentials. A retained encrypted backup is
reported by its unique path and must be recovered manually; never print its content.
Deadline is finite (default 15 minutes); SIGINT/SIGTERM attempt synchronous recovery.
SIGKILL/power loss cannot be recovered automatically. No live run occurs on --help
or without explicit authorization. Exit 0=all passed, 1=failed, 2=arguments/refusal.
`;

function options(argv) {
  if (argv.includes('--help')) { process.stdout.write(HELP); return; }
  const o = { seconds: 900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-live-auth-mutation') o.allow = true;
    else if (['--app-data', '--report', '--deadline-seconds'].includes(a)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('arguments');
      if (a === '--app-data') o.appData = value;
      if (a === '--report') o.report = value;
      if (a === '--deadline-seconds') o.seconds = Number(value);
    } else throw new Error('arguments');
  }
  // Deliberately before ANY profile access, temp creation, or VM loading.
  if (!o.allow || !o.appData || !path.isAbsolute(o.appData) ||
      !Number.isFinite(o.seconds) || o.seconds < 1 || o.seconds > 3600) throw new Error('arguments');
  if (process.platform !== 'win32') throw new Error('windows-required');
  o.appData = path.resolve(o.appData);
  if (o.report) {
    o.report = path.resolve(o.report);
    const relative = path.relative(o.appData, o.report);
    if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('arguments');
    // Never replace an existing file, including a credential or a symlink.
    if (fs.existsSync(o.report)) throw new Error('report-must-not-exist');
  }
  return o;
}

async function live(o) {
  const report = { stage: 'starting', ok: false, results: {},
    scope: { realClientLogoutLogin: true, realAuthRenameDeletion: true,
      realCredentialCopyWindowsDpapiRotation: true, windowsMasterKeyRotation: false,
      naturalClientKeyRotation: false, upstreamRequests: false } };
  let temp, auth, backup, statePath, stateDigest, ctx, timer, finishing = false;
  let clock = Date.now();
  const end = clock + o.seconds * 1000;
  const children = new Set();
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  function emit(stage) {
    report.stage = stage;
    const text = JSON.stringify(report) + '\n';
    process.stdout.write(text);
    if (o.report) {
      const staging = o.report + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(staging, text, { flag: 'wx', mode: 0o600 });
        fs.renameSync(staging, o.report);
      } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
    }
  }
  function check(value, name) {
    report.results[name] = !!value;
    if (!value) throw new Error(name);
  }
  function guard() { if (Date.now() >= end) throw new Error('deadline'); }
  const run = source => { guard(); return vm.runInContext(source, ctx, { timeout: 5000 }); };
  function restore() {
    if (!backup) return;
    if (fs.existsSync(auth)) {
      report.results.realAuthRestoredWithoutOverwrite = false;
      report.backupRetained = backup;
      return;
    }
    // Exclusive hard-link publication prevents even a racing client write from
    // being overwritten (rename alone on Windows can replace a destination).
    // The backup is the original encrypted inode, never a plaintext credential.
    fs.linkSync(backup, auth);
    fs.unlinkSync(backup);
    backup = undefined;
    report.results.realAuthRestoredWithoutOverwrite = true;
  }
  function finish(reason) {
    if (finishing) return;
    finishing = true;
    clearTimeout(timer);
    for (const child of children) child.kill();
    try { restore(); } catch {
      report.results.realAuthRestoredWithoutOverwrite = false;
      report.backupRetained = backup;
    }
    try { report.results.realLocalStateByteUnchanged = !!stateDigest && hash(fs.readFileSync(statePath)) === stateDigest; }
    catch { report.results.realLocalStateByteUnchanged = false; }
    try { if (temp) fs.rmSync(temp, { recursive: true, force: true }); report.results.tempRemoved = true; }
    catch { report.results.tempRemoved = false; }
    report.ok = reason === 'complete' && !report.backupRetained && Object.values(report.results).every(v => v === true);
    try { emit(report.ok ? 'complete' : reason === 'complete' ? 'failed-cleanup' : reason); }
    catch { report.ok = false; process.stderr.write('Report write failed (details suppressed).\n'); }
    process.exitCode = report.ok ? 0 : 1;
  }
  const stop = signal => { finish(signal); process.exit(1); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  timer = setTimeout(() => stop('deadline'), o.seconds * 1000);
  try {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credential-live-'));
    const file = path.resolve(__dirname, '../plugin/node/worker.cjs');
    const source = fs.readFileSync(file, 'utf8');
    check(source.includes('// JSON-RPC over stdio'), 'productionPrefixFound');
    const baseRequire = createRequire(file);
    const owner = () => ({ held: true, assertHeld() {} });
    class Clock extends Date { static now() { return clock; } }
    ctx = vm.createContext({
      __CINDY_BRIDGE_OWNERSHIP: { installation: owner(), data: owner() },
      Buffer, URL, TextDecoder, AbortController, AbortSignal, Date: Clock,
      __dirname: path.dirname(file), setTimeout, clearTimeout,
      process: { env: { ...process.env, APPDATA: o.appData, CINDY_QODER_DATA: path.join(temp, 'bridge') },
        platform: process.platform, arch: process.arch, stderr: { write() {} } },
      require: baseRequire,
      fetch() { throw new Error('UPSTREAM_FORBIDDEN'); },
    });
    vm.runInContext(source.split('// JSON-RPC over stdio')[0], ctx, { filename: file, timeout: 5000 });
    const appNames = run('region.appNames');
    check(appNames.length === 1, 'singleRealProfile');
    const app = appNames[0];
    const appDir = path.join(o.appData, app);
    auth = path.join(appDir, 'auth.v1.dat');
    statePath = path.join(appDir, 'Local State');
    stateDigest = hash(fs.readFileSync(statePath));
    let initial = await run('loadCredential(region)');
    check(initial.status === 'valid' && !initial.credential.expired && initial.credential.expiresAt > clock, 'initialRealDpapiValidUnexpired');
    await run('refreshCredential(true)');
    check(run('!!credential && !credential.expired'), 'initialSameVmCache');
    initial = undefined;
    emit('await-client-logout');
    async function waitFor(predicate) {
      for (;;) {
        guard(); clock = Date.now();
        const value = await run('loadCredential(region)');
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    await waitFor(v => v.status === 'absent' || v.status === 'logged-out');
    check(await run('refreshCredential(false)') === undefined && run('credential === undefined'), 'realClientLogoutClearsOldCache');
    emit('await-client-login');
    await waitFor(v => v.status === 'valid' && !v.credential.expired && v.credential.expiresAt > clock);
    await run('refreshCredential(false)');
    check(run('!!credential && !credential.expired'), 'realClientReloginValid');
    stateDigest = hash(fs.readFileSync(statePath));
    emit('real-auth-rename-deletion');
    guard();
    const backupPath = auth + '.credential-live-' + crypto.randomUUID() + '.backup';
    fs.renameSync(auth, backupPath);
    backup = backupPath;
    try {
      check((await run('loadCredential(region)')).status === 'absent', 'realDeletionAbsent');
      check(await run('refreshCredential(false)') === undefined && run('credential === undefined'), 'realDeletionClearsCache');
    } finally { restore(); }
    check(!backup, 'realAuthRestoredWithoutOverwrite');
    await run('refreshCredential(true)');
    check(run('!!credential && !credential.expired'), 'realDeletionRestoredValid');
    emit('copy-windows-dpapi-key-rotation');
    const copyDir = path.join(temp, app);
    fs.mkdirSync(copyDir);
    fs.copyFileSync(auth, path.join(copyDir, 'auth.v1.dat'));
    fs.copyFileSync(statePath, path.join(copyDir, 'Local State'));
    ctx.copyRoot = temp;
    run('appDataRoot = () => copyRoot');
    const old = await run('refreshCredential(true)');
    check(!!old && !old.expired, 'copyOldKeyValid');
    ctx.copyDir = copyDir;
    const oldKey = await run('oscryptKeyFor(copyDir)');
    const blob = fs.readFileSync(path.join(copyDir, 'auth.v1.dat'));
    ctx.rotationBlob = blob; ctx.rotationKey = oldKey;
    const plain = run('decryptOscrypt(rotationBlob, rotationKey)');
    check(typeof plain === 'string', 'copyRealPayloadDecrypted');
    // Actual temporary IO/decrypt failure: no reader/DPAPI stub and no real mutation.
    fs.writeFileSync(path.join(copyDir, 'auth.v1.dat'), Buffer.from('partial'));
    const retained = await run('refreshCredential(true)');
    check(!!retained && retained.token === old.token, 'copyForcedRefreshRetainsCacheOnTemporaryFailure');
    fs.writeFileSync(path.join(copyDir, 'auth.v1.dat'), blob);
    const newKey = crypto.randomBytes(32);
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String([Console]::In.ReadLine()); $p=[Security.Cryptography.ProtectedData]::Protect($k,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))`;
    const protectedKey = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let out = '', oversized = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error('dpapi-protect-timeout')); }, Math.min(20000, Math.max(1, end - Date.now())));
      child.stdout.on('data', chunk => { out += chunk; if (out.length > 65536) { oversized = true; child.kill(); } });
      child.stderr.resume(); // Never forward PowerShell output/errors.
      child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timeout); children.delete(child); reject(new Error('dpapi-protect')); });
      child.once('close', code => {
        clearTimeout(timeout); children.delete(child);
        if (code !== 0 || oversized || !/^[A-Za-z0-9+/=]+$/.test(out.trim())) reject(new Error('dpapi-protect'));
        else resolve(Buffer.from(out.trim(), 'base64'));
      });
      child.stdin.end(newKey.toString('base64') + '\n');
    });
    guard();
    const state = JSON.parse(fs.readFileSync(path.join(copyDir, 'Local State'), 'utf8'));
    state.os_crypt.encrypted_key = Buffer.concat([Buffer.from('DPAPI'), protectedKey]).toString('base64');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', newKey, nonce);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    fs.writeFileSync(path.join(copyDir, 'Local State'), JSON.stringify(state));
    fs.writeFileSync(path.join(copyDir, 'auth.v1.dat'), Buffer.concat([Buffer.from('v10'), nonce, encrypted, cipher.getAuthTag()]));
    const rotated = await run('refreshCredential(true)');
    // refresh alone could mask decryption failure by retaining old credentials.
    const reread = await run('loadCredential(region)');
    check(reread.status === 'valid' && !!rotated && rotated.token === old.token && reread.credential.token === old.token, 'copyRotatedKeyValidSameToken');
    ctx.newKey = newKey;
    check(run('keyCache.get(copyDir).key.equals(newKey)'), 'copyOscryptKeyCacheInvalidated');
    clock = rotated.expiresAt + 1;
    check(Number.isFinite(clock) && rotated.expiresAt > 0, 'copyExpiryAvailable');
    check((await run('refreshCredential(false)')).expired === true, 'vmOnlyExpired');
    clock = Date.now();
    ctx.realRoot = o.appData;
    run('appDataRoot = () => realRoot');
    const finalRead = await run('loadCredential(region)');
    check(finalRead.status === 'valid' && !finalRead.credential.expired, 'finalRealProfileReadValid');
    const finalCached = await run('refreshCredential(false)');
    check(!!finalCached && !finalCached.expired && finalCached.token === finalRead.credential.token, 'finalRealProfileValid');
    newKey.fill(0);
    finish('complete');
  } catch {
    // No exception messages/stacks: they may contain profile data or child output.
    finish(Date.now() >= end ? 'deadline' : 'failed-at-' + report.stage);
  } finally {
    if (!finishing) finish('failed');
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

let opts;
try { opts = options(process.argv.slice(2)); }
catch { process.stderr.write('Refused: explicit --app-data and --allow-live-auth-mutation required on Windows; report must be new and outside APPDATA. See --help.\n'); process.exitCode = 2; }
if (opts) live(opts).catch(() => { process.stderr.write('Harness failed (details suppressed).\n'); process.exitCode = 1; });
