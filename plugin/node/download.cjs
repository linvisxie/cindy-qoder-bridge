'use strict';

const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function fail(message) { throw new Error(`Release download: ${message}`); }
function component(value) {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded === '.' || decoded === '..' || /[/\\%\x00-\x20\x7f]/.test(decoded)) fail('unsafe path component');
  return decoded;
}

// Inspect the original spelling before URL can normalize dot segments or :443.
function trustedURL(raw) {
  if (typeof raw !== 'string' || /[\\\x00-\x20\x7f]/.test(raw)) fail('unsafe URL');
  const match = /^https:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?$/i.exec(raw);
  if (!match || !HOSTS.has(match[1].toLowerCase())) fail('untrusted HTTPS host or authority');
  for (const part of match[2].split('/').slice(1)) {
    if (part) component(part);
  }
  return new URL(raw);
}

function initialURL(asset, repo, version) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) fail('invalid owner/repo');
  const [owner, repository] = repo.split('/');
  if (owner.includes('--') || repository === '.' || repository === '..') fail('invalid owner/repository');
  if (typeof version !== 'string' || !/^[vV]?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) fail('invalid version');
  if (!asset || typeof asset.name !== 'string' || component(asset.name) !== asset.name) fail('invalid asset name');
  const raw = asset.url === undefined ? asset.browser_download_url : asset.url;
  const url = trustedURL(raw);
  const parts = url.pathname.split('/').slice(1).map(component);
  if (url.hostname !== 'github.com' || raw.includes('?') || parts.length !== 6 ||
      parts[0] !== owner || parts[1] !== repository || parts[2] !== 'releases' || parts[3] !== 'download' ||
      parts[4].replace(/^v/i, '') !== version.replace(/^v/i, '') || parts[5] !== asset.name) {
    fail('URL does not match repository, release version and asset name');
  }
  return url;
}

function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}
function aborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Release download aborted');
}
function withSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason || new Error('Release download aborted'));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}

/** Public GitHub assets only. Returns a bounded Buffer; integrity verification remains the caller's job. */
async function downloadReleaseAsset(asset, { repo, version, fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  let url = initialURL(asset, repo, version);
  if (typeof fetchImpl !== 'function') fail('fetch unavailable');
  for (let hop = 0; ; hop++) {
    aborted(signal);
    const pending = Promise.resolve(fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/octet-stream' }, signal,
    }));
    // A custom fetch may settle after abort; do not leave its body open.
    pending.then(res => { if (signal?.aborted) cancel(res.body); }, () => {});
    const response = await withSignal(pending, signal);
    let reader;
    try {
      aborted(signal);
      if (REDIRECTS.has(response.status)) {
        if (hop >= MAX_REDIRECTS) fail('too many redirects');
        // GitHub release redirects are absolute; do not normalize relative traversal.
        url = trustedURL(response.headers.get('location'));
        continue;
      }
      if (response.status !== 200) fail(`unexpected HTTP ${response.status}`);
      const length = response.headers.get('content-length');
      let expected;
      if (length !== null) {
        if (!/^\d+$/.test(length)) fail('invalid Content-Length');
        expected = Number(length);
        if (!Number.isSafeInteger(expected) || expected > MAX_DOWNLOAD_BYTES) fail('Content-Length exceeds limit');
      }
      if (!response.body || typeof response.body.getReader !== 'function') fail('missing readable body');
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        aborted(signal);
        const { done, value } = await withSignal(reader.read(), signal);
        aborted(signal);
        if (done) break;
        if (!(value instanceof Uint8Array)) fail('invalid body chunk');
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES || (expected !== undefined && total > expected)) fail('body exceeds size limit');
        chunks.push(Buffer.from(value));
      }
      if (expected !== undefined && total !== expected) fail('Content-Length mismatch');
      return Buffer.concat(chunks, total);
    } finally {
      cancel(reader || response.body);
      if (reader) { try { reader.releaseLock(); } catch {} }
    }
  }
}

module.exports = { downloadReleaseAsset, MAX_DOWNLOAD_BYTES, MAX_REDIRECTS };
