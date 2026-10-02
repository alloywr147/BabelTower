"use strict";
// 回归:2026-10-02 实车 /bt6736 20 连发出现 4 次 crc_dead。
// 根因:END_GC_MS=10s < 客户端最长重试跨度(≈34s)→ 桥在客户端仍在重试时删窗,
//       之后 128 面板全 404 → 全零位 → CRC 必败 → 走到 frameFails=9 报 crc_dead。
// 本文件把「END_GC_MS > 客户端最坏重试跨度」钉成不变量,防止回退到 10s。
// 跑法: node --test "tests/**/*.test.js"
const test = require("node:test");
const assert = require("node:assert");

const { WindowTable, WINDOW_TTL_MS, END_GC_MS } = require("../../core/btipc/window.js");

// 客户端常量(mod/panorama/scripts/lingua_chat.js §4/§9,勿单方面改一侧)
const T_HARD_MS = 12000;
const STORM_TCLOSE_MS = 2500;
const STORM_COOLDOWN_MS = 1000; // 风暴期轮间冷却
const CRC_DEAD = 8; // frameFails > 8 才死,即最多 9 次同帧尝试

/** 客户端在单帧上可能耗掉的最坏时间 */
function worstCaseRetrySpanMs() {
  return T_HARD_MS + CRC_DEAD * (STORM_TCLOSE_MS + STORM_COOLDOWN_MS);
}

test("END_GC_MS 必须大于客户端最长重试跨度", () => {
  const worst = worstCaseRetrySpanMs();
  assert.ok(
    END_GC_MS > worst,
    "END_GC_MS=" + END_GC_MS + " 必须 > 客户端最坏重试跨度 " + worst + "ms,否则窗口会在重试途中被删"
  );
});

test("END_GC_MS 小于 TTL,END 帧先于兜底 TTL 被回收", () => {
  assert.ok(END_GC_MS < WINDOW_TTL_MS, "END_GC_MS 应小于 TTL,END 路径才是主回收手段");
});

test("END 帧首次被服务后,窗口在最坏重试跨度内仍然存活", () => {
  let now = 1000000;
  const table = new WindowTable({ now: () => now });
  table.acceptReq("abc123", 0x1234, Buffer.from("Hello BTIPC"));
  table.setFrames("abc123", [{ f: 1 }]);

  // 模拟 END 帧在 r=1 首次被服务(serveDL 内部会记 endServedAt)
  const tr = table.get("abc123");
  tr.endServedAt = now;

  // 客户端仍在同帧重试的最坏时长内,GC 不能删掉它
  now += worstCaseRetrySpanMs() - 1;
  assert.strictEqual(table.gc(), 0, "最坏重试跨度内窗口被误删");
  assert.ok(table.get("abc123"), "窗口应仍存在");

  // 超过 END_GC_MS 后才允许回收
  now = tr.endServedAt + END_GC_MS;
  assert.strictEqual(table.gc(), 1, "超过 END_GC_MS 后应被回收");
  assert.strictEqual(table.get("abc123"), null);
});

test("无 END 记录时由 TTL 兜底,不会提前误删在途窗口", () => {
  let now = 2000000;
  const table = new WindowTable({ now: () => now });
  table.acceptReq("def456", 0x4321, Buffer.from("Hello BTIPC"));

  now += WINDOW_TTL_MS - 1;
  assert.strictEqual(table.gc(), 0, "TTL 内不应被删");
  now += 2;
  assert.strictEqual(table.gc(), 1, "超 TTL 应被删");
});