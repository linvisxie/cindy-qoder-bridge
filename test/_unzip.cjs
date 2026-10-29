// 极简 zip 读取器：只做「把 zip 解到目录」这一件事，纯 Node 内置模块。
// 用它取代 PowerShell 的 Expand-Archive，让测试在 Windows / macOS / Linux 上行为一致。
'use strict';

const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, dirname, sep } = require('node:path');
const zlib = require('node:zlib');

// 在中央目录里找文件条目。返回 [{ name, data }]
function readZipEntries(buf) {
  // 从尾部找 End of Central Directory 签名 0x06054b50（后面可能跟注释，最多 65535）
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录条目签名不对 @' + off);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地文件头签名不对：' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);

    out.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// 解到 targetDir，返回解出的相对路径列表。会拒绝绝对路径与 .. 穿越。
function extractZip(zipPath, targetDir) {
  const entries = readZipEntries(readFileSync(zipPath));
  const names = [];
  for (const e of entries) {
    const rel = e.name.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('包里有不安全的路径：' + e.name);
    const dest = join(targetDir, rel.split('/').join(sep));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
    names.push(rel);
  }
  return names;
}

module.exports = { readZipEntries, extractZip };
