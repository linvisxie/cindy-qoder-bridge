// 打 .cindy 包（zip）。Cindy 的 .cindy 就是 zip，ghost.json 在根部。
// 不用第三方 zip 库：用 Node 内置 zlib 自己写最小 zip writer，避免新增依赖。
'use strict';

const { createWriteStream, readFileSync, readdirSync, statSync, mkdirSync } = require('node:fs');
const { join, dirname, relative, sep } = require('node:path');
const zlib = require('node:zlib');

const SRC = join(__dirname, '..');
const OUT_DIR = join(__dirname, '..', '..', 'dist');
const OUT = join(OUT_DIR, 'cindy-qoder-bridge.cindy');

// 要打进包的文件（顺序固定，保证可复现）
const FILES = [
  'ghost.json',
  'main.js',
  'panel.html',
  'panel.js',
  'node/worker.cjs',
  'node/adapters.cjs',
];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  // 固定时间戳，保证同样输入产出同样字节
  const fixed = new Date('2026-10-29T00:00:00Z');
  const { time, date } = dosTime(fixed);

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

function main() {
  // 包体自检：manifest 能否解析、入口文件是否存在
  const manifest = JSON.parse(readFileSync(join(SRC, 'ghost.json'), 'utf8'));
  if (manifest.schemaVersion !== 3) throw new Error('schemaVersion 必须是 3');
  if (!manifest.minCindyVersion) throw new Error('schemaVersion 3 必须声明 minCindyVersion');
  if (manifest.node && !FILES.includes(manifest.node.entry)) throw new Error('node.entry 不在打包清单里');
  if (manifest.entry && !FILES.includes(manifest.entry)) throw new Error('entry 不在打包清单里');
  if (manifest.panel && !FILES.includes(manifest.panel.html)) throw new Error('panel.html 不在打包清单里');

  const entries = [];
  for (const rel of FILES) {
    const abs = join(SRC, rel);
    if (!statSync(abs).isFile()) throw new Error(`不是文件：${rel}`);
    entries.push({ name: rel, data: readFileSync(abs) });
  }

  const zip = buildZip(entries);
  mkdirSync(OUT_DIR, { recursive: true });
  const fs = require('node:fs');
  fs.writeFileSync(OUT, zip);

  console.log(`已生成 ${OUT}`);
  console.log(`大小 ${zip.length} 字节，${entries.length} 个文件：`);
  for (const e of entries) console.log(`  ${e.name}  ${e.data.length} B`);
}

main();
