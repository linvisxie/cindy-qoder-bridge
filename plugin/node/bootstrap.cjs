'use strict';

// Stable entry point: no business modules may be loaded before both OS locks.
const { join, resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { acquireOwnership } = require('./ownership.cjs');

// loadWorker is injectable for isolated tests; production requires in this process.
// Preserve process.argv, including Cindy's [electron, host bootstrap, entryPath].
async function bootstrap({ installDir = resolve(__dirname, '..'), dataDir, loadWorker } = {}) {
  let installation;
  let data;
  let owners;
  try {
    installation = await acquireOwnership(installDir, 'install');
    if (!dataDir) {
      const { id } = JSON.parse(readFileSync(join(installDir, 'ghost.json'), 'utf8'));
      const env = { 'qoder-bridge': 'CINDY_QODER_DATA', 'trae-bridge': 'CINDY_TRAE_DATA' }[id];
      if (!env) throw new Error('Unsupported bridge installation');
      dataDir = process.env[env] || join(homedir(), 'AppData', 'Roaming', 'CindyGlobal', id);
    }
    data = await acquireOwnership(dataDir, 'data');
    // Even the recovery module is loaded only after both ownership locks.
    const journal = require('./update-status.cjs');
    journal.assertRecoverable(journal.updateDirectory(installDir));
    owners = { installation, data };
    globalThis.__CINDY_BRIDGE_OWNERSHIP = owners;
    await (loadWorker || (() => require(join(installDir, 'node', 'worker.cjs'))))(owners);
    return owners;
  } catch (error) {
    if (owners && globalThis.__CINDY_BRIDGE_OWNERSHIP === owners) delete globalThis.__CINDY_BRIDGE_OWNERSHIP;
    // Reverse order, and always attempt both releases even if one fails.
    for (const owner of [data, installation]) {
      if (owner) { try { await owner.release(); } catch {} }
    }
    throw error;
  }
}

module.exports = { bootstrap };
// Cindy requires entryPath rather than making it require.main. Older hosts only
// identify the entry via argv[2]; an ordinary library require must remain inert.
if (require.main === module || globalThis.__CINDY_NODE__
    || (process.argv[2] && resolve(process.argv[2]) === __filename)) {
  bootstrap().catch(error => {
    process.stderr.write(`[cindy-bridge] ${error.message}\n`);
    process.exitCode = 1;
  });
}
