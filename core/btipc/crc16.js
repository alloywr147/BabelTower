// BTIPC v1 — CRC-16/CCITT-FALSE(规格:docs/btipc-v1.md §3.2 / §12.1)
// poly 0x1021,init 0xFFFF,不反转,无 xorout;check 向量 "123456789" -> 0x29B1
// 桥端唯一实现源;游戏侧(Panorama JS)内联同算法副本,两侧行为必须逐字节一致。
"use strict";

/**
 * 计算 CRC-16/CCITT-FALSE。
 * @param {Buffer|Uint8Array|number[]} bytes
 * @returns {number} 0..0xFFFF
 */
function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * 4 位小写 hex — REQ 行 crc= 字段的规范形式。
 * 桥端接受大小写皆可,一律按数值比对(§14.1)。
 * @param {Buffer|Uint8Array|number[]} bytes
 * @returns {string}
 */
function crc16Hex(bytes) {
  return crc16(bytes).toString(16).padStart(4, "0");
}

module.exports = { crc16, crc16Hex };
