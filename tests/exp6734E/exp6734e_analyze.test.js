"use strict";
// exp6734-E 分析器单测 — 合成日志验证:
//   ① 指标行解析(含 CRLF) ② 每码聚合(到达率/分位/FAST-LATE/静默/DUP)
//   ③ 可判别性判定(静默码/全LATE码/与200同形码/混合码) ④ 容错
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  parseGameEvent, parseLog, aggregate, formatTable, distinguishability, percentile
} = require(path.join(__dirname, "..", "..", "scripts", "exp6734e_analyze.js"));

// 合成 4 轮: 200 全 FAST;301 全 LATE;404 全静默;500 与 200 同形(全 FAST);
//            201 混合(2 FAST + 2 LATE);401 部分静默(一半)
const ROUNDS = 4;
const lines = [];
lines.push("exp6734E: START v1.0.7-6726-exp6734E run=777777 codes=200/201/204/206/301/302/304/307/400/401/403/404/500 rounds=4");
for (let r = 1; r <= ROUNDS; r += 1) {
  lines.push("exp6734E: ROUND n=777777 r=" + r + " SHOT t=1000");
  lines.push("exp6734E: LOADED n=777777 r=" + r + " code=200 dt=120 FAST");
  lines.push("exp6734E: LOADED n=777777 r=" + r + " code=301 dt=1500 LATE");
  lines.push("exp6734E: LOADED n=777777 r=" + r + " code=500 dt=130 FAST");
  if (r <= 2) lines.push("exp6734E: LOADED n=777777 r=" + r + " code=201 dt=140 FAST");
  else lines.push("exp6734E: LOADED n=777777 r=" + r + " code=201 dt=1600 LATE");
  if (r % 2 === 0) lines.push("exp6734E: LOADED n=777777 r=" + r + " code=401 dt=150 FAST");
  lines.push("exp6734E: DUP n=777777 r=" + r + " code=200");
  // ROUND END 的 missed 串: 404 永远缺;401 奇数轮缺
  const missed = r % 2 === 0 ? "404" : "404/401";
  lines.push("exp6734E: ROUND n=777777 r=" + r + " END loaded=" + (13 - missed.split("/").length) + "/13 missed=" + missed);
}
lines.push("exp6734E: ALL DONE — 取数: node scripts/exp6734e_analyze.js logs/bridge.log");
lines.push("exp6734E: 乱写的行");
lines.push("[2026-10-02 01:00:00] [info] EIT id=BTE0 round=1 code=200");
lines.push("");

test("percentile: 最近秩", () => {
  assert.strictEqual(percentile([1, 2, 3, 4], 0.5), 2);
  assert.strictEqual(percentile([1, 2, 3, 4], 0.95), 4);
  assert.strictEqual(percentile([], 0.5), null);
});

test("parseGameEvent: 各类行", () => {
  const l = parseGameEvent("LOADED n=123 r=2 code=302 dt=950 LATE");
  assert.deepStrictEqual(l, { type: "loaded", run: "123", r: 2, code: 302, dt: 950, speed: "LATE" });
  const e = parseGameEvent("ROUND n=123 r=2 END loaded=11/13 missed=404/500");
  assert.strictEqual(e.type, "roundEnd");
  assert.strictEqual(e.missed, "404/500");
  assert.strictEqual(parseGameEvent("??"), null);
});

test("parseLog + aggregate: 聚合正确", () => {
  const st = parseLog(lines.join("\r\n")); // CRLF 容错
  assert.strictEqual(st.allDone, true);
  assert.strictEqual(st.unknown, 1);
  const agg = aggregate(st);
  assert.strictEqual(agg.shots, 4);
  const byCode = {};
  agg.rows.forEach(function (r) { byCode[r.code] = r; });

  assert.strictEqual(byCode[200].loaded, 4);
  assert.strictEqual(byCode[200].fast, 4);
  assert.strictEqual(byCode[200].dup, 4);
  assert.strictEqual(byCode[200].dtP50, 120);
  assert.strictEqual(byCode[200].silent, 0);

  assert.strictEqual(byCode[301].loaded, 4);
  assert.strictEqual(byCode[301].late, 4);
  assert.strictEqual(byCode[301].dtP50, 1500);

  assert.strictEqual(byCode[404].loaded, 0);
  assert.strictEqual(byCode[404].silent, 4);

  assert.strictEqual(byCode[500].fast, 4);
  assert.strictEqual(byCode[500].late, 0);

  assert.strictEqual(byCode[201].fast, 2);
  assert.strictEqual(byCode[201].late, 2);

  assert.strictEqual(byCode[401].loaded, 2);
  assert.strictEqual(byCode[401].silent, 2);
});

test("distinguishability: 四类判定", () => {
  const agg = aggregate(parseLog(lines.join("\r\n")));
  const msgs = distinguishability(agg.rows, agg.shots).join("\n");
  assert.match(msgs, /201: 混合/, "201 FAST/LATE 各半 → 混合");
  assert.match(msgs, /404: 静默/, "404 全静默 → 可分");
  assert.match(msgs, /500: 与 200 同为 FAST/, "500 与 200 同形 → 同符号");
  assert.match(msgs, /301: 全 LATE/, "301 全 LATE → 可分");
});

test("formatTable: 表头/行", () => {
  const agg = aggregate(parseLog(lines.join("\r\n")));
  const tbl = formatTable(agg.rows);
  assert.match(tbl, /Code/);
  assert.match(tbl, /Silent/);
  assert.match(tbl, /404/);
});

test("容错: 空日志", () => {
  const st = parseLog("");
  const agg = aggregate(st);
  assert.strictEqual(agg.shots, 0);
  agg.rows.forEach(function (r) { assert.strictEqual(r.loaded, 0); });
  assert.strictEqual(distinguishability(agg.rows, 0).join(""), "样本不足");
});
