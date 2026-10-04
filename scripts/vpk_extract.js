// 从 Source2 VPK 抠单个文件: node scripts/vpk_extract.js <pakXX_dir.vpk> <panorama/layout/chat.xml> [out]
const fs = require('fs');

const [, , dirVpk, want, out] = process.argv;
if (!dirVpk || !want) {
  console.error('usage: node scripts/vpk_extract.js <pak_dir.vpk> <path/in/vpk> [out]');
  process.exit(2);
}

const b = fs.readFileSync(dirVpk);
if (b.readUInt32LE(0) !== 0x55aa1234) { console.error('bad signature'); process.exit(1); }
const ver = b.readUInt32LE(4);
const treeSize = b.readUInt32LE(8);
const HDR = 28;
const treeEnd = HDR + treeSize;
console.log(`vpk v${ver} treeSize=${treeSize} fileLen=${b.length}`);

const dec = new TextDecoder('utf8');
let p = HDR;
function cstr() {
  const z = b.indexOf(0, p);
  if (z < 0) { p = b.length; return ''; }
  const s = dec.decode(b.subarray(p, z));
  p = z + 1;
  return s;
}

const norm = want.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const wantNameRaw = norm.slice(norm.lastIndexOf('/') + 1);
const wantPath = norm.slice(0, norm.lastIndexOf('/'));
const dot = wantNameRaw.lastIndexOf('.');
const wantExt = dot >= 0 ? wantNameRaw.slice(dot + 1) : '';
const wantName = dot >= 0 ? wantNameRaw.slice(0, dot) : wantNameRaw;

let hit = null;
outer: while (p < treeEnd) {
  const ext = cstr();
  if (ext === '') break;
  while (p < treeEnd) {
    const path = cstr();
    if (path === '') break;
    while (p < treeEnd) {
      const name = cstr();
      if (name === '') break; // 列表终止符,后面没有条目
      const crc = b.readUInt32LE(p);
      const arcA = b.readUInt16LE(p + 4);   // Source2: crc(4) + u16 + u16 arc + u32 off + u32 len
      const arcB = b.readUInt16LE(p + 6);
      const off = b.readUInt32LE(p + 8);
      const len = b.readUInt32LE(p + 12);
      p += 18;
      if (ext === wantExt && path === wantPath && name === wantName) {
        hit = { crc, arcs: [arcA, arcB], off, len };
        break outer;
      }
    }
  }
}

if (!hit) { console.error('NOT FOUND: ' + want); process.exit(1); }
console.log(`found offset=${hit.off} len=${hit.len} crc=0x${hit.crc.toString(16)} arcCands=${hit.arcs.join('/')}`);

const candidates = [...new Set([...hit.arcs, 0x7fff])];
const forcedArc = process.argv.find(a => a.startsWith('--arc='));
let data = null;
let bestScore = -1;
for (const arc of candidates) {
  try {
    let buf = null;
    if (arc === 0x7fff) {
      const base = HDR + treeSize;
      if (hit.off + hit.len > b.length - base) continue;
      buf = b.subarray(base + hit.off, base + hit.off + hit.len);
    } else {
      const arcPath = dirVpk.replace(/_dir\.vpk$/i, '_' + String(arc).padStart(3, '0') + '.vpk');
      if (!fs.existsSync(arcPath)) continue;
      const fd = fs.openSync(arcPath, 'r');
      if (hit.off + hit.len > fs.fstatSync(fd).size - 12) { fs.closeSync(fd); continue; }
      buf = Buffer.allocUnsafe(hit.len);
      const n = fs.readSync(fd, buf, 0, hit.len, 12 + hit.off);
      fs.closeSync(fd);
      if (n !== hit.len) continue;
    }
    // 打分:可打印比例(编译资源头部含大量可读串,选错档案基本是乱码)
    let pr = 0;
    for (let k = 0; k < buf.length; k++) { const c = buf[k]; if (c >= 32 && c < 127) pr++; }
    pr = pr / buf.length;
    console.log('  cand arc=' + arc + ' printable=' + (pr * 100).toFixed(1) + '% head=' +
      JSON.stringify(buf.subarray(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.')));
    if (forcedArc && !forcedArc.endsWith('=' + arc)) continue;
    if (pr > bestScore) { bestScore = pr; data = buf; console.log('    -> selected'); }
  } catch (e) { /* try next */ }
}
if (!data) { console.error('could not resolve archive'); process.exit(1); }

const head = data.subarray(0, 40).toString('utf8').replace(/[\r\n]+/g, ' ');
console.log('head: ' + head);
console.log('has TargetHeroImage: ' + data.includes('TargetHeroImage'));

if (out) {
  fs.writeFileSync(out, data);
  console.log(`written ${out}  ${data.length}B`);
}
