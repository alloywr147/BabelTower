"use strict";
// exp6734-D 分析器单测 — 合成 bridge.log 片段,验证:
//   ① 游戏侧指标行解析(含 CRLF 容错、未知行计数) ② 最近秩分位
//   ③ 丢失/重复/乱序 ④ 服务端对账(gameOnly/srvOnly/dupSrv, 旧 BIT 格式忽略)
//   ⑤ 双口径 bit/s ⑥ 窗口配置(256w64)解析 ⑦ 表格输出
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  percentile, parseGameEvent, parseLog, aggregate, formatTable
} = require(path.join(__dirname, "..", "..", "scripts", "exp6734d_analyze.js"));

const SYN = [
  "random noise line",
  "exp6734D: START v1.0.7-6726-exp6734D run=111111 plan=4,256w64 panels=256/256 (new=256)",
  "exp6734D: CFG 4@111111 START n=4 win=1 rounds=2 idx=1/2",
  "exp6734D: ROUND n=4@111111 r=1 SHOT t=1000",
  "exp6734D: WIN n=4@111111 r=1 k=1/1 SHOT 0..3 t=1000",
  "exp6734D: LOADED n=4@111111 r=1 i=0 dt=100 seq=1",
  "exp6734D: LOADED n=4@111111 r=1 i=2 dt=150 seq=2",
  "exp6734D: LOADED n=4@111111 r=1 i=1 dt=180 seq=3",
  "exp6734D: LOADED n=4@111111 r=1 i=3 dt=200 seq=4",
  "exp6734D: DUP n=4@111111 r=1 i=0 dt=250",
  "exp6734D: ROUND n=4@111111 r=1 DONE loaded=4/4 word=200 first=100 last=200 min=100 max=200 lost=0 seqs=4",
  "exp6734D: ROUND n=4@111111 r=2 SHOT t=3000",
  "exp6734D: LOADED n=4@111111 r=2 i=0 dt=120 seq=1",
  "exp6734D: LOADED n=4@111111 r=2 i=1 dt=130 seq=2",
  "exp6734D: LOADED n=4@111111 r=2 i=2 dt=140 seq=3",
  "exp6734D: ROUND n=4@111111 r=2 TIMEOUT loaded=3/4 word=12000 first=120 last=140 min=120 max=140 lost=1 seqs=3",
  "exp6734D: CFG 4@111111 DONE rounds=2 idx=1/2",
  "exp6734D: CFG 256w64@111111 START n=256 win=64 rounds=10 idx=2/2",
  "exp6734D: ROUND n=256w64@111111 r=1 SHOT t=5000",
  "exp6734D: WIN n=256w64@111111 r=1 k=1/4 SHOT 0..63 t=5000",
  "exp6734D: LOADED n=256w64@111111 r=1 i=0 dt=50 seq=1",
  "exp6734D: LOADED n=256w64@111111 r=1 i=1 dt=60 seq=2",
  "exp6734D: ROUND n=256w64@111111 r=1 TIMEOUT loaded=2/256 word=12000 first=50 last=60 min=50 max=60 lost=254 seqs=2",
  "exp6734D: ALL DONE — 全部配置完成;取数: node scripts/exp6734d_analyze.js logs/bridge.log",
  "exp6734D: 参数无效 \"zz\" — 用法: /bt6734d",
  "[2026-10-01 00:00:00] info: BIT c=4@111111 id=BTD0 round=1",
  "[2026-10-01 00:00:00] info: BIT c=4@111111 id=BTD0 round=1",
  "[2026-10-01 00:00:00] info: BIT c=4@111111 id=BTD3 round=2",
  "[2026-10-01 00:00:00] info: BIT id=BTBIT7 round=1",
  ""
].join("\r\n"); // 故意 CRLF:验证尾部 \\r 不破坏 $ 锚点

test("percentile: 最近秩 nearest-rank", () => {
  assert.strictEqual(percentile([1, 2, 3, 4], 0.5), 2);
  assert.strictEqual(percentile([1, 2, 3, 4], 0.95), 4);
  assert.strictEqual(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.strictEqual(percentile([], 0.5), null);
  assert.strictEqual(percentile(null, 0.5), null);
  assert.strictEqual(percentile([7], 0.99), 7);
});

test("parseGameEvent: 各类指标行", () => {
  assert.deepStrictEqual(
    parseGameEvent("LOADED n=16@1 r=2 i=3 dt=44 seq=5"),
    { type: "loaded", cfg: "16@1", r: 2, i: 3, dt: 44, seq: 5 }
  );
  const end = parseGameEvent("ROUND n=64@9 r=3 DONE loaded=64/64 word=310 first=50 last=310 min=50 max=310 lost=0 seqs=64");
  assert.strictEqual(end.type, "roundEnd");
  assert.strictEqual(end.label, "DONE");
  assert.strictEqual(end.n, 64);
  assert.strictEqual(end.word, 310);
  const shot = parseGameEvent("ROUND n=256w64@9 r=1 SHOT t=1759000000000");
  assert.strictEqual(shot.type, "shot");
  assert.strictEqual(shot.cfg, "256w64@9");
  assert.strictEqual(parseGameEvent("乱七八糟"), null);
});

test("parseLog + aggregate: 分位/丢失/重复/乱序/对账/吞吐", () => {
  const st = parseLog(SYN);
  assert.strictEqual(st.allDone, true, "ALL DONE 应被识别");
  assert.strictEqual(st.unknown, 1, "未知 exp6734D 行应计数");

  const rows = aggregate(st);
  assert.strictEqual(rows.length, 2, "应有两个配置行");
  assert.strictEqual(rows[0].cfg, "4@111111", "按面板数排序,小配置在前");

  // ---- 配置 A: 4 面板矩阵 ----
  const a = rows[0];
  assert.strictEqual(a.panels, 4);
  assert.strictEqual(a.win, 1);
  assert.strictEqual(a.run, "111111");
  assert.strictEqual(a.rounds, 2);
  assert.strictEqual(a.expRounds, 2);
  assert.strictEqual(a.bits, 7);
  assert.strictEqual(a.expected, 8);
  // 位延迟 [100,120,130,140,150,180,200]
  assert.strictEqual(a.bitP50, 140);
  assert.strictEqual(a.bitP90, 200);
  assert.strictEqual(a.bitP95, 200);
  assert.strictEqual(a.bitP99, 200);
  assert.strictEqual(a.bitMax, 200);
  // 字完成 [200, 12000]
  assert.strictEqual(a.wordP50, 200);
  assert.strictEqual(a.wordP95, 12000);
  assert.strictEqual(a.wordMax, 12000);
  assert.strictEqual(a.loss, 1);
  assert.strictEqual(a.dup, 1, "游戏侧 DUP 行");
  assert.strictEqual(a.dupSrv, 1, "服务端同 (cfg,round,id) 重复");
  assert.strictEqual(a.tmo, 1);
  assert.strictEqual(a.done, 1);
  // 乱序: 轮1 到达序 [0,2,1,3] 一个逆序对;轮2 [0,1,2] 无 → 1/5 = 20%
  assert.strictEqual(a.reo, 1);
  assert.strictEqual(a.reoPct, 20);
  // 对账: 服务端只有 1#0 ×2 和 2#3;游戏有 1#0,1#1,1#2,1#3,2#0,2#1,2#2
  assert.strictEqual(a.gameOnly, 6);
  assert.strictEqual(a.srvOnly, 1);
  // 吞吐: bpsWord = median([4*1000/200, 3*1000/12000]) = median([20, 0.25]) = 0.25 → round1 = 0.3
  assert.strictEqual(a.bpsWord, 0.3);
  // bpsSus = 7 bits / (15000-1000) ms = 0.5
  assert.strictEqual(a.bpsSus, 0.5);

  // ---- 配置 B: 256 帧 / 窗口 64 ----
  const b = rows[1];
  assert.strictEqual(b.cfg, "256w64@111111");
  assert.strictEqual(b.panels, 256);
  assert.strictEqual(b.win, 64);
  assert.strictEqual(b.expRounds, 10);
  assert.strictEqual(b.bits, 2);
  assert.strictEqual(b.loss, 254);
  assert.strictEqual(b.tmo, 1);
  assert.strictEqual(b.bitP50, 50);
  assert.strictEqual(b.bitP95, 60);
  assert.strictEqual(b.gameOnly, 2, "服务端无该配置落底");
  assert.strictEqual(b.srvOnly, 0);
  assert.strictEqual(b.reoPct, 0);
  // 旧格式 BIT id=BTBIT7 不得混入(否则 gameOnly 会变)
});

test("formatTable: 表头与行输出", () => {
  const rows = aggregate(parseLog(SYN));
  const tbl = formatTable(rows);
  assert.match(tbl, /Cfg/);
  assert.match(tbl, /b\/s\(sus\)/);
  assert.match(tbl, /4@111111/);
  assert.match(tbl, /256w64@111111/);
  assert.match(tbl, /20/, "Reo% 20 应出现");
});

test("容错: 空日志/纯噪声不抛异常", () => {
  assert.deepStrictEqual(aggregate(parseLog("")), []);
  assert.deepStrictEqual(aggregate(parseLog("hello\r\nworld\r\n")), []);
  assert.strictEqual(parseGameEvent(""), null);
});
