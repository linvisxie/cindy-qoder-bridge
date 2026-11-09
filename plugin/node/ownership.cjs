'use strict';

const { realpathSync } = require('node:fs');
const { resolve, dirname, basename, join } = require('node:path');
const { createHash } = require('node:crypto');
const net = require('node:net');

// Resolve existing ancestors too: an as-yet uncreated directory below a junction
// must have the same identity as its eventual realpath. No lock-file or mkdir IO.
function canonicalDirectory(directory) {
  let path = resolve(directory);
  const tail = [];
  for (;;) {
    try {
      path = realpathSync.native(path);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      tail.unshift(basename(path));
      path = parent;
    }
  }
  path = join(path, ...tail);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function pipeName(directory, scope = 'data') {
  if (!/^[a-z][a-z0-9-]*$/.test(scope)) throw new Error('Invalid ownership scope');
  const hash = createHash('sha256').update(canonicalDirectory(directory)).digest('hex');
  // Linux CI can exercise the same exclusivity invariant with an abstract Unix
  // socket: kernel-owned and released on crash, with no stale filesystem entry.
  if (process.platform === 'linux') return `\0cindy-bridge-${scope}-${hash}`;
  return `\\\\.\\pipe\\cindy-bridge-${scope}-${hash}`;
}

// libuv's Windows pipe bind creates its first handle with
// FILE_FLAG_FIRST_PIPE_INSTANCE. Unlike an ordinary connectable pipe instance,
// a second Node listener cannot bind this name (covered by subprocess tests).
// The kernel releases the handle on crash; stale files/PIDs cannot block it.
async function acquireOwnership(directory, scope = 'data') {
  const label = scope === 'install' ? 'INSTALL_DIR' : 'DATA_DIR';
  if (!['win32', 'linux'].includes(process.platform)) throw new Error(`${label} ownership requires Windows named pipes (or Linux abstract sockets for offline CI)`);
  const name = pipeName(directory, scope);
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener('listening', ready);
      const failure = new Error(`${label} ownership unavailable (${error.code || 'pipe error'}): ${directory}`);
      failure.code = error.code;
      reject(failure);
    };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(name);
  });
  return {
    get held() { return server.listening; },
    assertHeld() { if (!server.listening) throw new Error(`${label} ownership lost`); },
    // Call only after all writers have stopped. Workers hold this until exit.
    release() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

module.exports = { canonicalDirectory, pipeName, acquireOwnership };
