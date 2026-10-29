// 离线清单校验器：按 Cindy 宿主里读到的校验规则，对 ghost.json 做静态检查。
// 这不是官方 Forge 校验器，只是把 asar 里能读到的硬规则抄成可复现的检查。
// 用法：node scripts/verify-manifest.cjs
'use strict';

const { readFileSync, existsSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = join(__dirname, '..');
const errors = [];
const warns = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warns.push(msg); }

// ---- 从宿主 asar 抄下来的常量 ----
const KNOWN_TOP_LEVEL = new Set([
  'routineEvents', 'schemaVersion', 'id', 'name', 'version', 'releaseNotes',
  'minCindyVersion', 'author', 'locales', 'description', 'whenToUse', 'icon',
  'kind', 'entry', 'launch', 'agent', 'node', 'settingsHtml', 'settingsHeight',
  'showTaskPreferences', 'slots', 'card', 'mail', 'mailReader', 'tools', 'cindy',
  'model', 'subscribe', 'network', 'command', 'keywords', 'panel', 'mainView',
  'taskView', 'preview', 'skill', 'manual', 'setup', 'notify', 'badge', 'confirm',
  'fs', 'library', 'deviceSync', 'sessionContext', 'pick', 'workspace', 'iosSimulator',
]);
const BOOL_CAPS = ['notify', 'badge', 'confirm', 'fs', 'library', 'deviceSync', 'sessionContext', 'pick', 'workspace', 'iosSimulator'];
const NODE_PROTOCOLS = ['json-rpc-stdio', 'mcp-stdio'];
const NODE_LIFECYCLES = ['on-demand', 'resident'];
const PANEL_POSITIONS = ['left', 'right', 'top', 'bottom', 'tab'];
const GHOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MANIFEST_MAX_BYTES = 256 * 1024;

// ---- 读取 ----
const manifestPath = join(ROOT, 'ghost.json');
if (!existsSync(manifestPath)) {
  console.error('ghost.json 不存在');
  process.exit(1);
}
const rawBytes = statSync(manifestPath).size;
if (rawBytes > MANIFEST_MAX_BYTES) err(`ghost.json 超过 ${MANIFEST_MAX_BYTES} 字节（实际 ${rawBytes}）`);

let m;
try {
  m = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error('ghost.json 不是合法 JSON：' + e.message);
  process.exit(1);
}

// ---- 顶层 ----
for (const k of Object.keys(m)) {
  if (!KNOWN_TOP_LEVEL.has(k)) err(`未知的顶层字段：${k}`);
}

if (m.schemaVersion !== 2 && m.schemaVersion !== 3) {
  err(`schemaVersion 必须是 2 或 3，得到 ${JSON.stringify(m.schemaVersion)}`);
}
if (m.schemaVersion === 3) {
  if (m.minCindyVersion === undefined) err('schemaVersion 3 必须声明 minCindyVersion');
  if (m.slots !== undefined) err('schemaVersion 3 不再支持 slots');
  for (const k of BOOL_CAPS) {
    if (m[k] !== undefined && m[k] !== true) err(`${k} 出现时必须是 true，不需要时请省略`);
  }
}

if (typeof m.id !== 'string' || !GHOST_ID_RE.test(m.id)) {
  err(`id 必须是 1–32 位小写字母/数字/连字符：${JSON.stringify(m.id)}`);
}
if (typeof m.name !== 'string' || m.name.length === 0) err('name 必填');
if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) err(`version 必须是 SemVer：${JSON.stringify(m.version)}`);
if (m.description !== undefined) {
  if (typeof m.description !== 'string' || m.description.length < 1 || m.description.length > 300) {
    err('description 必须是 1–300 字');
  }
}
if (m.whenToUse !== undefined) {
  if (typeof m.whenToUse !== 'string' || m.whenToUse.length < 1 || m.whenToUse.length > 300) {
    err(`whenToUse 必须是 1–300 字（实际 ${m.whenToUse?.length}）`);
  }
}

// ---- 入口文件 ----
function checkFile(rel, hint) {
  if (typeof rel !== 'string' || rel.length === 0) { err(`${hint} 必须是非空字符串`); return false; }
  const abs = resolve(ROOT, rel);
  if (!abs.startsWith(resolve(ROOT))) { err(`${hint} 不能逃出包根：${rel}`); return false; }
  if (!existsSync(abs)) { err(`${hint} 指向的文件不存在：${rel}`); return false; }
  return true;
}

if (m.entry !== undefined) {
  checkFile(m.entry, 'entry');
  if (m.entry === 'ghost.json') err('entry 不能是 ghost.json');
}

// ---- node ----
if (m.node !== undefined) {
  const n = m.node;
  if (!n || typeof n !== 'object' || Array.isArray(n)) err('node 必须是对象');
  else {
    if (!checkFile(n.entry, 'node.entry')) { /* 已记错 */ }
    if (typeof n.entry === 'string' && !/\.(c?js)$/i.test(n.entry)) err('node.entry 必须是 CommonJS .js / .cjs');
    if (typeof n.entry === 'string' && typeof m.entry === 'string' && n.entry.toLowerCase() === m.entry.toLowerCase()) {
      err('node.entry 不能与浏览器沙箱 entry 使用同一个文件');
    }
    if (!NODE_PROTOCOLS.includes(n.protocol)) err(`node.protocol 必须是 ${NODE_PROTOCOLS.join(' / ')}`);
    if (n.lifecycle !== undefined && !NODE_LIFECYCLES.includes(n.lifecycle)) err(`node.lifecycle 必须是 ${NODE_LIFECYCLES.join(' / ')}`);
    if (n.idleTimeoutSeconds !== undefined) {
      if (!Number.isInteger(n.idleTimeoutSeconds) || n.idleTimeoutSeconds < 30 || n.idleTimeoutSeconds > 3600) {
        err('node.idleTimeoutSeconds 必须是 30–3600 的整数');
      }
      if (n.lifecycle === 'resident') err('node.lifecycle 为 resident 时不能再声明 idleTimeoutSeconds');
    }
    const ALLOWED = new Set(['entry', 'protocol', 'lifecycle', 'idleTimeoutSeconds', 'entries', 'childSpawn', 'secretBindings']);
    for (const k of Object.keys(n)) if (!ALLOWED.has(k)) err(`node 不接受字段 ${k}`);
  }
}

// ---- tools ----
if (m.tools !== undefined) {
  if (!Array.isArray(m.tools) || m.tools.length === 0 || m.tools.length > 16) {
    err('tools 必须是 1–16 项的数组');
  } else {
    const seen = new Set();
    for (const [i, t] of m.tools.entries()) {
      if (!t || typeof t !== 'object') { err(`tools[${i}] 必须是对象`); continue; }
      if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) err(`tools[${i}].name 不合法：${JSON.stringify(t.name)}`);
      if (seen.has(t.name)) err(`tools 含重名工具 ${t.name}`);
      seen.add(t.name);
      if (typeof t.description !== 'string' || t.description.trim().length === 0 || t.description.length > 1024) {
        err(`tools[${i}].description 必须是 1–1024 字符非空字符串`);
      }
      if (t.parameters !== undefined) {
        if (typeof t.parameters !== 'object' || Array.isArray(t.parameters)) err(`tools[${i}].parameters 必须是对象`);
        else if (JSON.stringify(t.parameters).length > 16384) err(`tools[${i}].parameters 超过 16KB`);
      }
    }
  }
}

// ---- command ----
if (m.command !== undefined) {
  if (typeof m.command !== 'string' || m.command.length === 0 || m.command.length > 32 || /[\s/]/.test(m.command)) {
    err('command 必须是 1–32 字符、不含空白与 "/" 的字符串');
  }
  if (m.tools === undefined) err('声明了 command 但没有 tools');
}

// ---- panel ----
if (m.panel !== undefined) {
  if (!m.panel || typeof m.panel !== 'object') err('panel 必须是对象');
  else {
    if (m.panel.position !== undefined && !PANEL_POSITIONS.includes(m.panel.position)) {
      err(`panel.position 必须是 ${PANEL_POSITIONS.join(' / ')}`);
    }
    if (m.panel.position === 'tab') {
      if (m.panel.minWidth !== undefined) err('position:"tab" 时不能声明 minWidth');
      if (m.panel.defaultFraction !== undefined) err('position:"tab" 时不能声明 defaultFraction');
      if (m.panel.systemButtons !== undefined) err('position:"tab" 时不能声明 systemButtons');
    }
    checkFile(m.panel.html, 'panel.html');
    if (typeof m.panel.title !== 'string' || m.panel.title.length === 0) err('panel.title 必填');
  }
}

// ---- 声明了 node 却没声明 tools/panel 能力，提示一下 ----
if (m.node !== undefined && m.tools === undefined && m.panel === undefined && m.mainView === undefined) {
  warn('声明了 node 但没有任何可见入口（tools/panel/mainView），用户将看不到这个插件在做什么');
}

// ---- 输出 ----
console.log(`checking ${manifestPath}  (${rawBytes} B)`);
if (warns.length) {
  console.log('\n警告：');
  for (const w of warns) console.log('  ! ' + w);
}
if (errors.length) {
  console.log('\n错误：');
  for (const e of errors) console.log('  x ' + e);
  console.log(`\nFAIL：${errors.length} 个错误`);
  process.exit(1);
}
console.log(`\nPASS：0 个错误，${warns.length} 个警告`);
