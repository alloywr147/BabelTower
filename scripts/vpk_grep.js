// 在 Source2 VPK 里按字符串找文件: node scripts/vpk_grep.js <pak_dir.vpk> <needle> [pathPrefix]
const fs = require('fs');

const [, , dirVpk, needle, prefix] = process.argv;
if (!dirVpk || !needle) {
  console.error('usage: node scripts/vpk_grep.js <pak_dir.vpk> <needle> [pathPrefix]');
  process.exit(2);
}
const b = fs.readFileSync(dirVpk);
if (b.readUInt32LE(0) !== 0x55aa1234) { console.error('bad signature'); process.exit(1); }
const treeSize = b.readUInt32LE(8);
const HDR = 28;
const treeEnd = HDR + treeSize;
const dec = new TextDecoder('utf8');
const arcCache = new Map();

let p = HDR;
function cstr() {
  const z = b.indexOf(0, p);
  if (z < 0) { p = b.length; return ''; }
  const s = dec.decode(b.subarray(p, z));
  p = z + 1;
  return s;
}

// 只读该条目需要的字节(不整档载入,避免 33GB 内存)
function readSlice(arc, off, len) {
  if (arc === 0x7fff) {
    const base = HDR + treeSize;
    if (off + len > b.length - base) return null;
    return b.subarray(base + off, base + off + len);
  }
  const fp = dirVpk.replace(/_dir\.vpk$/i, '_' + String(arc).padStart(3, '0') + '.vpk');
  let fd = arcCache.get(fp);
  if (fd === undefined) {
    try { fd = fs.openSync(fp, 'r'); } catch (e) { fd = null; }
    arcCache.set(fp, fd);
  }
  if (fd === null) return null;
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, 12 + off);
    return n === len ? buf : null;
  } catch (e) {
    return null;
  }
}

const hits = [];
let scanned = 0;
outer: while (p < treeEnd) {
  const ext = cstr();
  if (ext === '') break;
  while (p < treeEnd) {
    const path = cstr();
    if (path === '') break;
    while (p < treeEnd) {
      const name = cstr();
      if (name === '') break;
      const crc = b.readUInt32LE(p);
      const arcA = b.readUInt16LE(p + 4);
      const arcB = b.readUInt16LE(p + 6);
      const off = b.readUInt32LE(p + 8);
      const len = b.readUInt32LE(p + 12);
      p += 18;
      const full = path + '/' + name + '.' + ext;
      if (prefix && !full.startsWith(prefix)) continue;
      if (len === 0 || len > 40 * 1024 * 1024) continue;
      scanned++;
      // 档案号有两个候选(条目字段里 u16 x2),不猜,三个都试,任一命中即算
      let hit = false;
      for (const arc of [arcA, arcB, 0x7fff]) {
        const buf = readSlice(arc, off, len);
        if (buf && buf.includes(needle)) { hit = true; break; }
      }
      if (hit) hits.push(full + '  (' + len + 'B)');
    }
  }
}
console.log('scanned ' + scanned + ' files under "' + (prefix || '*') + '"');
console.log('=== contains "' + needle + '" (' + hits.length + ') ===');
console.log(hits.join('\n'));
