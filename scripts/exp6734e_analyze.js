#!/usr/bin/env node
"use strict";
// ============================================================
// exp6734e_analyze.js — exp6734-E 多值符号判别分析
//
// 用法: node scripts/exp6734e_analyze.js [logs/bridge.log] [--json]
//
// 输入: 游戏侧 exp6734E: 行(ROUND SHOT / LOADED code=.. dt=.. FAST|LATE /
//       DUP / ROUND END loaded=../13 missed=..) + 服务端 EIT id=.. code=.. 落底行
// 输出: 每状态码一行的可判别性矩阵(到达率/DT 分位/速度分布/静默率/重复)
//
// 判定标准(与 docs/ipc-downlink-benchmark-6734D.md §11 一致):
//   2xx  → 期望 FAST LOADED ≈ 100%(基线)
//   3xx  → 期望 LOADED(LATE ≈ >800ms,重定向二次请求);若静默 = 引擎不跟随
//   4xx/5xx → LOADED(FAST,错误体被当图解码失败后仍触发?)或静默
//   只要某码的行为与 200 的分布**无重叠**(静默率或 dt 分布明显分离),它就是可判别符号
// ============================================================

const fs = require("fs");

const CODES = [200, 201, 204, 206, 301, 302, 304, 307, 400, 401, 403, 404, 500];

function percentile(values, q) {
  if (!values || !values.length) return null;
  const arr = values.slice().sort(function (a, b) { return a - b; });
  return arr[Math.max(0, Math.min(arr.length - 1, Math.ceil(q * arr.length) - 1))];
}

function parseGameEvent(payload) {
  let m;
  if ((m = payload.match(/^START v\S+ run=(\d+) codes=\S+ rounds=(\d+)$/))) {
    return { type: "start", run: m[1], rounds: +m[2] };
  }
  if ((m = payload.match(/^ROUND n=(\d+) r=(\d+) SHOT t=(\d+)$/))) {
    return { type: "shot", run: m[1], r: +m[2] };
  }
  if ((m = payload.match(/^LOADED n=(\d+) r=(\d+) code=(\d+) dt=(\d+) (FAST|LATE)$/))) {
    return { type: "loaded", run: m[1], r: +m[2], code: +m[3], dt: +m[4], speed: m[5] };
  }
  if ((m = payload.match(/^DUP n=(\d+) r=(\d+) code=(\d+)$/))) {
    return { type: "dup", run: m[1], r: +m[2], code: +m[3] };
  }
  if ((m = payload.match(/^ROUND n=(\d+) r=(\d+) END loaded=(\d+)\/13 missed=(\S+)$/))) {
    return { type: "roundEnd", run: m[1], r: +m[2], loaded: +m[3], missed: m[4] };
  }
  if (/^ALL DONE/.test(payload)) return { type: "allDone" };
  return null;
}

function parseLog(text) {
  const st = {
    run: null, rounds: 0, allDone: false, unknown: 0,
    shots: {},                      // r -> true
    loaded: [],                     // {r, code, dt, speed}
    dups: {},                       // code -> count
    missedRounds: []                // {r, missed}
  };
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i].replace(/[\r\n]+$/, "");
    const gi = ln.indexOf("exp6734E: ");
    if (gi >= 0) {
      const ev = parseGameEvent(ln.slice(gi + 10));
      if (!ev) { st.unknown += 1; continue; }
      if (ev.type === "start") {
        // 新 run 开始: 重置聚合(分析器只报最近一次 run,避免跨 run 混算)
        st.run = ev.run; st.rounds = ev.rounds;
        st.shots = {}; st.loaded = []; st.dups = {}; st.missedRounds = [];
        st.allDone = false;
      }
      else if (ev.type === "shot") st.shots[ev.r] = true;
      else if (ev.type === "loaded") st.loaded.push(ev);
      else if (ev.type === "dup") st.dups[ev.code] = (st.dups[ev.code] || 0) + 1;
      else if (ev.type === "roundEnd") st.missedRounds.push(ev);
      else if (ev.type === "allDone") st.allDone = true;
      continue;
    }
    // 服务端落底仅用于人工核对(EIT 行),本分析器主口径是游戏侧行为
  }
  return st;
}

function aggregate(st) {
  const shots = Object.keys(st.shots).length;
  const rows = [];
  for (let i = 0; i < CODES.length; i += 1) {
    const code = CODES[i];
    const hits = st.loaded.filter(function (x) { return x.code === code; });
    const dts = hits.map(function (x) { return x.dt; });
    const fast = hits.filter(function (x) { return x.speed === "FAST"; }).length;
    const late = hits.filter(function (x) { return x.speed === "LATE"; }).length;
    const silent = shots - hits.length;
    rows.push({
      code: code,
      loaded: hits.length, of: shots,
      rate: shots ? Math.round(hits.length * 100 / shots) : 0,
      dtP50: percentile(dts, 0.5),
      dtP95: percentile(dts, 0.95),
      dtMax: dts.length ? Math.max.apply(null, dts) : null,
      fast: fast, late: late, silent: silent,
      dup: st.dups[code] || 0
    });
  }
  return { rows: rows, shots: shots, meta: st };
}

function distinguishability(rows, shots) {
  const out = [];
  const base = rows.filter(function (r) { return r.code === 200; })[0];
  if (!base || !shots) return ["样本不足"];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    // 与 200 的可分性: 静默 / 全LATE / 与200同形 / 混合
    if (r.loaded === 0) { out.push(r.code + ": 静默(0 loaded) — 与 200 完全可分 ✓"); continue; }
    if (r.fast === 0 && r.late > 0) {
      out.push(r.code + ": 全 LATE — 与 200 的 FAST 可分 ✓");
    } else if (r.late === 0 && r.fast > 0) {
      out.push(r.code + ": 与 200 同为 FAST 且到达率相近 — 不可分 ✗(与 200 同符号)");
    } else {
      out.push(r.code + ": 混合(FAST " + r.fast + "/LATE " + r.late + ") — 需人工判读分布");
    }
  }
  return out;
}

function fmt(v, w) {
  const s = v === null || v === undefined ? "-" : String(v);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function rfmt(v, w) {
  const s = v === null || v === undefined ? "-" : String(v);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function formatTable(rows) {
  const out = [];
  out.push(fmt("Code", 6) + rfmt("Loaded", 9) + rfmt("Rate%", 6) +
    rfmt("P50", 7) + rfmt("P95", 7) + rfmt("Max", 7) +
    rfmt("FAST", 6) + rfmt("LATE", 6) + rfmt("Silent", 7) + rfmt("Dup", 5));
  out.push("-".repeat(70));
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    out.push(fmt(r.code, 6) +
      rfmt(r.loaded + "/" + r.of, 9) + rfmt(r.rate, 6) +
      rfmt(r.dtP50, 7) + rfmt(r.dtP95, 7) + rfmt(r.dtMax, 7) +
      rfmt(r.fast, 6) + rfmt(r.late, 6) + rfmt(r.silent, 7) + rfmt(r.dup, 5));
  }
  return out.join("\n");
}

function main(argv) {
  const flags = argv.filter(function (a) { return a.indexOf("--") === 0; });
  const args = argv.filter(function (a) { return a.indexOf("--") !== 0; });
  const file = args[0] || "logs/bridge.log";
  const asJson = flags.indexOf("--json") >= 0;

  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { console.error("exp6734E: 读不到日志 " + file + " — " + e.message); process.exit(1); }

  const st = parseLog(text);
  const agg = aggregate(st);
  const shots = Object.keys(st.shots).length;
  if (!shots) {
    console.error("exp6734E: 日志里没有 exp6734E 数据;游戏内聊天输入 /bt6734e 触发。");
    process.exit(1);
  }
  if (asJson) { console.log(JSON.stringify({ run: st.run, rounds: st.rounds, allDone: st.allDone, shots: shots, rows: agg.rows }, null, 2)); return; }

  console.log("exp6734-E 多值符号判别 — " + file);
  console.log("run=" + st.run + " 轮数=" + shots + "/" + st.rounds +
    " 状态=" + (st.allDone ? "ALL DONE" : "未完(可能仍在跑/中断)") +
    (st.unknown ? " | 未识别行: " + st.unknown : ""));
  console.log("");
  console.log(formatTable(agg.rows));
  console.log("");
  console.log("可判别性(与 200 基线对比):");
  distinguishability(agg.rows, shots).forEach(function (l) { console.log("  " + l); });
  console.log("");
  console.log("口径: Loaded=该码 ImageLoaded 次数/总轮数;P50/P95/Max=dt(ms);");
  console.log("      FAST=<800ms / LATE=≥800ms(重定向二次请求特征);Silent=轮数-Loaded(12s 超时内未到)。");
  const missedAny = st.missedRounds.filter(function (m) { return m.missed !== "-"; });
  if (missedAny.length) {
    console.log("有缺失轮 " + missedAny.length + " 个(ROUND END missed=..),配合上表 Silent 列解读。");
  }
}

module.exports = { parseGameEvent, parseLog, aggregate, formatTable, distinguishability, percentile };

if (require.main === module) {
  main(process.argv.slice(2));
}
