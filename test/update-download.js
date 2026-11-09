'use strict';
// Offline only: every request uses a local mock, never global fetch or GitHub.
const assert = require('node:assert/strict');
const { downloadReleaseAsset, MAX_DOWNLOAD_BYTES, MAX_REDIRECTS } = require('../plugin/node/download.cjs');
const repo = 'example/bridge';
const version = '1.2.3';
const start = `https://github.com/${repo}/releases/download/v${version}/bridge.cindy`;
const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?sig=abc%2F123';
const asset = { name: 'bridge.cindy', url: start };
let checks = 0;
function response(status = 200, headers = {}, chunks = [Buffer.from('abc')], readError) {
  const state = { cancelled: 0, released: 0, reads: 0 };
  const reader = {
    async read() {
      state.reads++;
      if (readError) throw readError;
      return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
    },
    cancel() { state.cancelled++; return Promise.resolve(); },
    releaseLock() { state.released++; },
  };
  return {
    status, state,
    headers: new Headers(headers),
    body: { getReader: () => reader, cancel: () => reader.cancel() },
  };
}
function mock(responses, signal) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { Accept: 'application/octet-stream' });
    assert.equal(options.signal, signal);
    assert.ok(responses.length, 'unexpected fetch');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { fetch, calls };
}
async function rejectURL(url, overrides = {}) {
  const m = mock([]);
  await assert.rejects(downloadReleaseAsset({ ...asset, url }, { repo, version, fetch: m.fetch, ...overrides }));
  assert.equal(m.calls.length, 0, url);
  checks++;
}
async function main() {
  for (const tag of ['1.2.3', 'v1.2.3', 'V1.2.3', '%761.2.3']) {
    const r = response(200, { 'content-length': '3' });
    const m = mock([r]);
    const result = await downloadReleaseAsset({ ...asset, url: start.replace('v1.2.3', tag) }, { repo, version: 'v1.2.3', fetch: m.fetch });
    assert.ok(Buffer.isBuffer(result));
    assert.equal(result.toString(), 'abc');
    assert.equal(r.state.released, 1);
    checks++;
  }
  const overrideRepo = 'another-owner/custom.repo';
  const overrideSignal = new AbortController().signal;
  const override = mock([response(302, { location: cdn }), response()], overrideSignal);
  assert.equal((await downloadReleaseAsset({ ...asset, url: start.replace(repo, overrideRepo) }, {
    repo: overrideRepo, version, fetch: override.fetch, signal: overrideSignal,
  })).toString(), 'abc');
  assert.equal(override.calls.length, 2);
  checks++;
  const alternate = mock([response()]);
  assert.equal((await downloadReleaseAsset({ name: asset.name, browser_download_url: start }, { repo, version, fetch: alternate.fetch })).toString(), 'abc');
  checks++;
  for (const url of [
    start.replace('https:', 'http:'), start.replace('github.com', 'localhost'),
    start.replace('github.com', 'github.com.evil.test'), start.replace('github.com', 'evilgithub.com'),
    start.replace('github.com', 'github.com@evil.test'), start.replace('github.com', 'user@github.com'),
    start.replace('github.com', 'user:pass@github.com'), start.replace('github.com', 'github.com:443'),
    start.replace('github.com', 'github.com:8443'), start.replace('github.com', '127.0.0.1'),
    start.replace('github.com', 'github.com.'), start.replace('github.com', '%67ithub.com'),
    start.replace('/example/', '/other/'), start.replace('/bridge/releases/', '/other/releases/'),
    start.replace('v1.2.3', 'v1.2.4'), start.replace('bridge.cindy', 'other.cindy'),
    start.replace('/releases/', '/archive/'), start + '/extra', start + '?token=secret', start + '?', start + '#fragment',
    start.replace('/releases/', '/x/../releases/'), start.replace('/releases/', '/%2e%2e/releases/'),
    start.replace('/releases/', '/%252e%252e/releases/'), start.replace('bridge.cindy', '..%2fbridge.cindy'),
    start.replace('bridge.cindy', '%5cbridge.cindy'), start.replace('bridge.cindy', '%00bridge.cindy'),
    start.replace('bridge.cindy', '%ZZ'), start.replace('https://', 'https:\\\\'), '\n' + start,
    start.replace('github.com', 'release-assets.githubusercontent.com'),
  ]) await rejectURL(url);
  for (const badRepo of ['../bridge', 'example/../bridge', 'https://evil.test/x', 'example/bridge?x', 'example/.', 'example/..', '-example/bridge', 'ex--ample/bridge', 'example/']) {
    await rejectURL(start, { repo: badRepo });
  }
  for (const badVersion of ['', 'latest', '../1.2.3', '1.2.3/other']) await rejectURL(start, { version: badVersion });
  for (const name of ['..', '.', '../bridge.cindy', '%2e%2e', 'a\\b', 'a\nb']) {
    const m = mock([]);
    await assert.rejects(downloadReleaseAsset({ ...asset, name }, { repo, version, fetch: m.fetch }));
    assert.equal(m.calls.length, 0);
    checks++;
  }
  for (const status of [301, 302, 303, 307, 308]) {
    const first = response(status, { location: cdn });
    const second = response(302, { location: 'https://objects.githubusercontent.com/releases/file' });
    const m = mock([first, second, response(200, {}, [Buffer.from('a'), Buffer.from('bc')])]);
    assert.equal((await downloadReleaseAsset(asset, { repo, version, fetch: m.fetch })).toString(), 'abc');
    assert.equal(m.calls.length, 3);
    assert.equal(first.state.cancelled, 1);
    assert.equal(second.state.cancelled, 1);
    checks++;
  }
  for (const location of [
    'https://evil.test/file', 'https://release-assets.githubusercontent.com.evil.test/file',
    'https://objects.githubusercontent.com.evil.test/file', 'http://objects.githubusercontent.com/file',
    'https://localhost/file', 'https://127.0.0.1/file', 'https://[::1]/file',
    'https://user@objects.githubusercontent.com/file', 'https://objects.githubusercontent.com:443/file',
    'https://objects.githubusercontent.com:8443/file', 'https://objects.githubusercontent.com/a/%2e%2e/file',
    'https://objects.githubusercontent.com/a/../file', 'https://objects.githubusercontent.com/%252e%252e/file',
    'https://objects.githubusercontent.com/a%2fb', 'https://objects.githubusercontent.com/a%5cb',
    'https://objects.githubusercontent.com/a#fragment', '//objects.githubusercontent.com/file', '/relative/file', '',
  ]) {
    // Reject malicious targets even when reached after a trusted CDN hop.
    const bad = response(302, { location });
    const m = mock([response(302, { location: cdn }), bad]);
    await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: m.fetch }));
    assert.equal(m.calls.length, 2);
    assert.equal(bad.state.cancelled, 1);
    checks++;
  }
  const redirects = Array.from({ length: MAX_REDIRECTS + 1 }, () => response(302, { location: cdn }));
  const loop = mock([...redirects]);
  await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: loop.fetch }), /too many redirects/);
  assert.equal(loop.calls.length, MAX_REDIRECTS + 1);
  assert.ok(redirects.every(r => r.state.cancelled === 1));
  checks++;
  for (const r of [response(302), response(404), response(206), response(204)]) {
    const m = mock([r]);
    await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: m.fetch }));
    assert.equal(r.state.cancelled, 1);
    checks++;
  }
  for (const length of [String(MAX_DOWNLOAD_BYTES + 1), '9007199254740992', '-1', '3.0', 'invalid', '2', '4']) {
    const r = response(200, { 'content-length': length });
    await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: mock([r]).fetch }));
    assert.equal(r.state.cancelled, 1);
    if (!['2', '4'].includes(length)) assert.equal(r.state.reads, 0);
    checks++;
  }
  const block = Buffer.alloc(1024 * 1024);
  const oversized = response(200, {}, Array(33).fill(block));
  await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: mock([oversized]).fetch }), /size limit/);
  assert.equal(oversized.state.cancelled, 1);
  assert.equal(oversized.state.released, 1);
  checks++;
  const exact = response(200, { 'content-length': String(MAX_DOWNLOAD_BYTES) }, Array(32).fill(block));
  assert.equal((await downloadReleaseAsset(asset, { repo, version, fetch: mock([exact]).fetch })).length, MAX_DOWNLOAD_BYTES);
  checks++;
  const empty = response(200, { 'content-length': '0' }, []);
  assert.equal((await downloadReleaseAsset(asset, { repo, version, fetch: mock([empty]).fetch })).length, 0);
  checks++;
  const broken = response(200, {}, [], new Error('stream failed'));
  await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: mock([broken]).fetch }), /stream failed/);
  assert.equal(broken.state.cancelled, 1);
  checks++;
  await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: mock([new Error('network failed')]).fetch }), /network failed/);
  checks++;
  const pre = new AbortController();
  pre.abort(new Error('pre-abort'));
  const never = mock([], pre.signal);
  await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: never.fetch, signal: pre.signal }), /pre-abort/);
  assert.equal(never.calls.length, 0);
  checks++;
  const midway = new AbortController();
  const redirect = response(302, { location: cdn });
  const mid = mock([() => { midway.abort(new Error('redirect abort')); return redirect; }], midway.signal);
  await assert.rejects(downloadReleaseAsset(asset, { repo, version, fetch: mid.fetch, signal: midway.signal }), /redirect abort/);
  assert.equal(mid.calls.length, 1);
  assert.ok(redirect.state.cancelled >= 1);
  checks++;
  const streaming = new AbortController();
  const stalled = response();
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  stalled.body.getReader = () => ({
    read() { entered(); return new Promise(() => {}); },
    cancel: stalled.body.cancel, releaseLock() { stalled.state.released++; },
  });
  const downloading = downloadReleaseAsset(asset, { repo, version, fetch: mock([stalled], streaming.signal).fetch, signal: streaming.signal });
  await reading;
  streaming.abort(new Error('stream abort'));
  await assert.rejects(downloading, /stream abort/);
  assert.equal(stalled.state.cancelled, 1);
  assert.equal(stalled.state.released, 1);
  checks++;
  const fetching = new AbortController();
  let finish;
  const late = response();
  const inFlight = downloadReleaseAsset(asset, { repo, version, signal: fetching.signal, fetch: () => new Promise(resolve => { finish = resolve; }) });
  fetching.abort(new Error('fetch abort'));
  await assert.rejects(inFlight, /fetch abort/);
  finish(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.state.cancelled, 1);
  checks++;
  console.log(`update-download: ${checks} offline checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
