// 离线测试:BTIPC CRC-16/CCITT-FALSE(core/btipc/crc16.js)
// 跑法: node tests/btipc/crc.test.js   或   node --test "tests/**/*.test.js"
"use strict";
const { crc16, crc16Hex } = require("../../core/btipc/crc16.js");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS |", label); }
  else { fail++; console.log("  FAIL |", label); }
}

// ---------- §12.1 标准向量 ----------
console.log("--- CCITT-FALSE 标准向量 ---");
ok(crc16(Buffer.from("123456789", "ascii")) === 0x29b1, 'check("123456789") = 0x29B1');
ok(crc16(Buffer.alloc(0)) === 0xffff, "空输入 = 0xFFFF(仅 init)");
ok(crc16Hex(Buffer.from("123456789", "ascii")) === "29b1", 'crc16Hex = "29b1"(4 位小写)');

// ---------- 参考实现互检 ----------
// 独立写法:逐位反馈式(输入位 XOR 进 bit15 再移位归约)——与 crc16.js 的
// 逐字节(XOR 高字节 + 8 次移位)结构不同,互检位序(MSB first)与移位方向。
// 注:“init 前置成位串再长除”的写法是另一种 CRC 定义,与 CCITT-FALSE 不等价,勿用。
function refCrc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) {
      crc ^= ((b >> i) & 1) << 15;
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

console.log("--- 与独立参考实现互检 ---");
const cases = {
  "空": Buffer.alloc(0),
  "单字节 0x00": Buffer.from([0x00]),
  "单字节 0xFF": Buffer.from([0xff]),
  "全 0 x16": Buffer.alloc(16, 0),
  "全 0xFF x16": Buffer.alloc(16, 0xff),
  "递增 0..255": Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  "中文 UTF-8": Buffer.from("你好,BabelTower — Hello BTIPC", "utf8"),
  "check 向量": Buffer.from("123456789", "ascii"),
};
for (const [label, buf] of Object.entries(cases)) {
  ok(crc16(buf) === refCrc16(buf), `互检 ${label}(${buf.length}B)`);
}

// ---------- 输入类型容忍 ----------
ok(crc16([0x31, 0x32]) === crc16(Buffer.from("12", "ascii")), "number[] 与 Buffer 同结果");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
