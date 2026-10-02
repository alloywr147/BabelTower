// BTIPC v1 framer — 文本/字节 ↔ 16 字节帧(规格:docs/btipc-v1.md §3)
//   B0: bit7=END,  bit0..6=seq(0..127)
//   B1..B2: request_id(大端)
//   B3: bit7=VALID, bit0..6=LEN(0..10)
//   B4..B5: CRC-16/CCITT-FALSE(大端)
//   B6..B15: payload(LEN 不足补 0x00)
// CRC 覆盖 = B0..B3 + B6..B15(固定 14 字节,含 0x00 填充),不含 CRC 自身(§3.2)。
"use strict";
const { crc16 } = require("./crc16.js");

const FRAME_BYTES = 16;
const HEADER_BYTES = 4; // B0..B3
const CRC_BYTES = 2; // B4..B5
const PAYLOAD_MAX = 10; // B6..B15
const SEQ_MAX_FRAMES = 128; // seq 7 bit → 单消息最多 128 帧 = 1280B

/** CRC 输入 = B0..B3 + B6..B15(14 字节) */
function crcInputOf(frame) {
  const input = Buffer.alloc(FRAME_BYTES - CRC_BYTES); // 14B
  frame.copy(input, 0, 0, HEADER_BYTES); // B0..B3
  frame.copy(input, HEADER_BYTES, HEADER_BYTES + CRC_BYTES, FRAME_BYTES); // B6..B15
  return input;
}

/** 帧 CRC(重算值;与 B4..B5 比对即校验) */
function frameCrc(frame) {
  return crc16(crcInputOf(frame));
}

function toBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(data); // Uint8Array / number[]
}

/**
 * 构造 16 字节帧(字段不合法直接 throw,禁止静默截断)。
 * @param {{seq:number,id:number,end:boolean,valid:boolean,payload?:Buffer|Uint8Array|number[]|null}} o
 * @returns {Buffer}
 */
function buildFrame({ seq, id, end, valid, payload }) {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0x7f) throw new RangeError("seq 必须 0..127");
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new RangeError("id 必须 0..65535");
  const bytes = valid && payload ? toBuf(payload) : null;
  const len = bytes ? bytes.length : 0;
  if (len > PAYLOAD_MAX) throw new RangeError("payload 必须 ≤10B");
  const frame = Buffer.alloc(FRAME_BYTES);
  frame[0] = (end ? 0x80 : 0) | seq;
  frame.writeUInt16BE(id, 1);
  frame[3] = (valid ? 0x80 : 0) | len;
  if (len) bytes.copy(frame, HEADER_BYTES + CRC_BYTES, 0, len);
  frame.writeUInt16BE(frameCrc(frame), HEADER_BYTES);
  return frame;
}

/**
 * BUSY 固定帧(§3.2,冻结不随机):seq=0、END=0、id 保留、VALID=0、LEN=0、payload 全 0,CRC 照算。
 * 游戏侧只判 VALID=0 即退避,不跑重组逻辑。
 * @param {number} id request_id
 * @returns {Buffer}
 */
function busyFrame(id) {
  return buildFrame({ seq: 0, id, end: false, valid: false, payload: null });
}

/**
 * 消息 → 帧序列(每帧 payload ≤10B,末帧 END=1;空消息 = 单帧 len=0+END)。
 * @param {number} id request_id
 * @param {Buffer|Uint8Array|string|number[]} data UTF-8 文本或字节
 * @returns {Buffer[]}
 */
function encode(id, data) {
  const bytes = toBuf(data);
  const n = Math.max(1, Math.ceil(bytes.length / PAYLOAD_MAX));
  if (n > SEQ_MAX_FRAMES) {
    throw new RangeError(`消息 ${bytes.length}B 超出 seq7 上限(${SEQ_MAX_FRAMES * PAYLOAD_MAX}B)`);
  }
  const frames = [];
  for (let i = 0; i < n; i++) {
    const chunk = bytes.subarray(i * PAYLOAD_MAX, Math.min(bytes.length, (i + 1) * PAYLOAD_MAX));
    frames.push(buildFrame({ seq: i, id, end: i === n - 1, valid: true, payload: chunk }));
  }
  return frames;
}

/**
 * 16 字节 → 帧字段。CRC 或格式不合法返回 {ok:false,reason}——**绝不返回半可信数据**。
 * @param {Buffer|Uint8Array} frame
 * @returns {{ok:boolean,reason?:string,valid?:boolean,seq?:number,end?:boolean,id?:number,len?:number,payload?:Buffer}}
 */
function decode(frame) {
  const f = toBuf(frame);
  if (f.length !== FRAME_BYTES) return { ok: false, reason: "size" };
  const got = f.readUInt16BE(HEADER_BYTES);
  const calc = frameCrc(f);
  if (got !== calc) return { ok: false, reason: "crc", calc, got };
  const valid = (f[3] & 0x80) !== 0;
  const len = f[3] & 0x7f;
  if (len > PAYLOAD_MAX) return { ok: false, reason: "format" };
  if (!valid) {
    // BUSY 固定格式:B0=0(seq0,END0)、B3=0(VALID0,LEN0)、payload 全 0(§3.2)
    if (f[0] !== 0 || f[3] !== 0 || f.subarray(HEADER_BYTES + CRC_BYTES).some((b) => b !== 0)) {
      return { ok: false, reason: "format" };
    }
  }
  return {
    ok: true,
    valid,
    seq: f[0] & 0x7f,
    end: (f[0] & 0x80) !== 0,
    id: f.readUInt16BE(1),
    len,
    payload: Buffer.from(f.subarray(HEADER_BYTES + CRC_BYTES, HEADER_BYTES + CRC_BYTES + len)),
  };
}

/**
 * 消息重组器:按 seq 收帧、END 验收连续性;重复帧/END 重放幂等。
 * 用法:每轮闭合 CRC 通过后喂一次原始 16 字节。
 */
class Assembler {
  constructor() {
    this.parts = new Map(); // seq -> Buffer
    this.done = null; // { bytes, text } | null
  }

  /**
   * @param {Buffer|Uint8Array} frame 原始 16 字节帧
   * @returns {{ok:boolean,reason?:string,missing?:number,busy?:boolean,done?:boolean,text?:string,bytes?:Buffer}}
   */
  add(frame) {
    const d = decode(frame);
    if (!d.ok) return { ok: false, reason: d.reason };
    if (!d.valid) return { ok: true, busy: true, done: false };
    if (this.done) return { ok: true, busy: false, done: true, text: this.done.text, bytes: this.done.bytes };
    if (!this.parts.has(d.seq)) this.parts.set(d.seq, Buffer.from(d.payload));
    if (!d.end) return { ok: true, busy: false, done: false };
    // END 到达:验收 seq 连续 0..max(缺帧 = 此前有 CRC fail 漏喂,gap 拒收走重试)
    const seqs = [...this.parts.keys()].sort((a, b) => a - b);
    const max = seqs[seqs.length - 1];
    for (let i = 0; i <= max; i++) {
      if (!this.parts.has(i)) return { ok: false, reason: "gap", missing: i };
    }
    const bufs = [];
    for (let i = 0; i <= max; i++) bufs.push(this.parts.get(i));
    const bytes = Buffer.concat(bufs);
    this.done = { bytes, text: bytes.toString("utf8") };
    return { ok: true, busy: false, done: true, text: this.done.text, bytes };
  }
}

/**
 * 16 字节帧 → 128 位数组;panel p = byte[p>>3] 的 bit(p&7),LSB first(§3.1/§3.3)。
 * @param {Buffer|Uint8Array} frame
 * @returns {number[]} 长度 128,元素 0/1
 */
function bitsOf(frame) {
  const f = toBuf(frame);
  if (f.length !== FRAME_BYTES) throw new RangeError("需要 16 字节帧");
  const bits = new Array(FRAME_BYTES * 8);
  for (let p = 0; p < bits.length; p++) bits[p] = (f[p >> 3] >> (p & 7)) & 1;
  return bits;
}

/**
 * 128 位 → 16 字节(游戏侧收集 fires 后还原帧字节,再走 decode 校验 CRC)。
 * @param {number[]} bits 长度 128
 * @returns {Buffer}
 */
function fromBits(bits) {
  if (!bits || bits.length !== FRAME_BYTES * 8) throw new RangeError("需要 128 位");
  const f = Buffer.alloc(FRAME_BYTES);
  for (let p = 0; p < bits.length; p++) if (bits[p]) f[p >> 3] |= 1 << (p & 7);
  return f;
}

module.exports = {
  FRAME_BYTES,
  HEADER_BYTES,
  CRC_BYTES,
  PAYLOAD_MAX,
  SEQ_MAX_FRAMES,
  crcInputOf,
  frameCrc,
  buildFrame,
  busyFrame,
  encode,
  decode,
  Assembler,
  bitsOf,
  fromBits,
};
