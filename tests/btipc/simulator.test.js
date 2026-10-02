// 离线测试:BTIPC 信道仿真验收(规格 docs/btipc-v1.md §12.3)
// 跑法: node tests/btipc/simulator.test.js   或   node --test "tests/**/*.test.js"
"use strict";
const path = require("node:path");
const { runSim } = require("../../scripts/btipc_sim.js");
const { crc16 } = require("../../core/btipc/crc16.js");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS |", label); }
  else { fail++; console.log("  FAIL |", label); }
}

// ---- 守卫:全 404(16 字节全 0)绝不能被误判为 BUSY ----
// BUSY 帧的 CRC 字段非 0;仅当 crc16(14×0x00)===0 时全 0 帧才可能通过 CRC → 必须钉死不为 0。
console.log("--- 守卫 ---");
ok(crc16(Buffer.alloc(14, 0)) !== 0x0000, "crc16(14×00) ≠ 0(全 404 轮 → CRC fail 而非误判 BUSY)");

// ---- §12.3 主基准:100 次传输,5% 轮级丢包 ----
console.log("--- §12.3 主基准(seed=42)---");
const m = runSim({ transfers: 100, seed: 42, roundLoss: 0.05 });
console.log("    [stats] done=" + m.done + " wrong=" + m.wrong + " failed=" + m.failed +
  " rounds=" + m.rounds + " retries=" + m.retryRounds +
  " retryRate=" + (m.retryRate * 100).toFixed(2) + "%" +
  " simTime=" + (m.simMs / 1000).toFixed(1) + "s" +
  " throughput=" + m.throughput.toFixed(1) + " bit/s" +
  " stormEvents=" + m.stormEvents);
ok(m.done === 100, "100 次传输全部完成(" + m.done + "/100)");
ok(m.wrong === 0, "零错字(" + m.wrong + ")");
ok(m.failed === 0, "零失败(" + m.failed + ")");
ok(m.retryRate < 0.1, "重试率 <10%(" + (m.retryRate * 100).toFixed(2) + "%)");
ok(m.throughput >= 100, "载荷吞吐 ≥100 bit/s(" + m.throughput.toFixed(1) + ")");

// ---- 多 seed 稳定性(防单 seed 侥幸)----
console.log("--- 多 seed 稳定性 ---");
let allClean = true;
for (const seed of [1, 7, 1234, 99991]) {
  const r = runSim({ transfers: 30, seed: seed, roundLoss: 0.05 });
  if (r.wrong !== 0 || r.failed !== 0) {
    allClean = false;
    console.log("    seed=" + seed + " wrong=" + r.wrong + " failed=" + r.failed);
  }
}
ok(allClean, "4 个 seed × 30 传输:零错字零失败");

// ---- 风暴演练:前 2 轮强制丢失 → 必然触发风暴,最终 DONE(§12.3/§4.1)----
console.log("--- 风暴演练(强制连丢 2 轮)---");
const st = runSim({
  transfers: 10, seed: 42, roundLoss: 0.05,
  forceLoss: (k, r, roundNo) => roundNo <= 2, // 每个传输前 2 次尝试连丢 → consec=2 → STORM
});
console.log("    [stats] done=" + st.done + " wrong=" + st.wrong + " failed=" + st.failed +
  " stormEvents=" + st.stormEvents + " retryRate=" + (st.retryRate * 100).toFixed(1) + "%");
ok(st.stormEvents >= 10, "风暴必然触发(10/10 传输," + st.stormEvents + " 次)");
ok(st.done === 10 && st.wrong === 0 && st.failed === 0, "风暴期 10/10 最终 DONE 且零错字");

// ---- BUSY 阶段:前 6 轮 frames 未就绪(模拟翻译耗时)----
console.log("--- BUSY 阶段(前 6 轮未就绪)---");
const bs = runSim({ transfers: 20, seed: 42, roundLoss: 0.05, busyRounds: 6 });
console.log("    [stats] done=" + bs.done + " wrong=" + bs.wrong + " failed=" + bs.failed +
  " busyRounds=" + bs.busyRounds);
ok(bs.busyRounds >= 96, "BUSY 轮被正确识别(" + bs.busyRounds + " ≥ 96;5% 随机丢包会把部分 BUSY 轮打成 CRC fail)");
ok(bs.done === 20 && bs.wrong === 0 && bs.failed === 0, "BUSY 退避后 20/20 完成且零错字");

// ---- 边界文本:空 / 单字节 / 680B 满载 ----
console.log("--- 边界文本 ---");
const edgeTexts = ["", "a", "汉".repeat(Math.floor(680 / 3))];
let edgeOk = true;
for (const t of edgeTexts) {
  const r = runSim({
    transfers: 5, seed: 7, roundLoss: 0.05,
    textGen: () => t,
  });
  if (r.done !== 5 || r.wrong !== 0 || r.failed !== 0) {
    edgeOk = false;
    console.log("    len=" + Buffer.byteLength(t) + "B done=" + r.done + " wrong=" + r.wrong + " failed=" + r.failed);
  }
}
ok(edgeOk, "空/1B/680B 满载 ×5 全部正确");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
