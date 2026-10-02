#!/usr/bin/env node
"use strict";
// ============================================================
// exp6734d_analyze.js — exp6734-D Bridge→Panorama 下行吞吐基准分析
//
// 用法:
//   node scripts/exp6734d_analyze.js [logs/bridge.log] [--json] [--only=<cfg,cfg>]
//
// 输入: bridge.log(游戏侧经 console.log 尾随的 exp6734D: 指标行 + 桥侧 BIT c=.. 落底行)
// 输出: 每配置一行的汇总表(P50..MAX 分位 / Loss / Dup / Reorder / TMO / 双口径 bit/s)
//
// 口径定义(与 docs/ipc-downlink-benchmark-6734D.md 一致):
//   分位数     = 最近秩 nearest-rank(排序后取 ceil(q*n) 项,1 起)
//   bit P50..  = 单 bit 延迟(SetImage 轮起点 → 该面板 ImageLoaded 的 dt)
//   W-P50..    = 字完成时间 word(轮起点 → 本轮最后一个 bit 到齐;TIMEOUT 轮 = 截止时刻)
//   Loss       = Σ lost(TIMEOUT 轮的未到 bit)
//   Dup        = 游戏侧 DUP 行 + 服务端同 (cfg,round,id) 重复落底
//   Reo        = 轮内相邻到达逆序对数(arrival 序中 idx 变小的次数)
//   bit/s(word)= 中位数: 每轮 loaded_bits / word_seconds(瞬时字吞吐)
//   bit/s(sus) = 全程: Σ bits / (首拍 → 末轮完成 的墙钟跨度)(含轮间空档,可持续吞吐)
// ============================================================

const fs = require("fs");

// ---------- 分位数(最近秩) ----------
function percentile(values, q) {
  if (!values || !values.length) return null;
  const arr = values.slice().sort(function (a, b) { return a - b; });
  const idx = Math.max(0, Math.min(arr.length - 1, Math.ceil(q * arr.length) - 1));
  return arr[idx];
}

function round1(x) {
  return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 10) / 10;
}

// ---------- 解析:游戏侧 exp6734D: 行 ----------
// 返回事件对象或 null(非本实验行/不认识的行)
function parseGameEvent(payload) {
  let m;
  if (/^START /.test(payload)) return { type: "start", raw: payload };
  if (/^ABORT/.test(payload)) return { type: "abort", raw: payload };
  if (/^ALL DONE/.test(payload)) return { type: "allDone", raw: payload };
  if ((m = payload.match(/^CFG (\S+) START n=(\d+) win=(\d+) rounds=(\d+) idx=(\d+)\/(\d+)$/))) {
    return { type: "cfgStart", cfg: m[1], n: +m[2], win: +m[3], rounds: +m[4] };
  }
  if ((m = payload.match(/^CFG (\S+) DONE rounds=(\d+) idx=(\d+)\/(\d+)$/))) {
    return { type: "cfgDone", cfg: m[1] };
  }
  if ((m = payload.match(/^ROUND n=(\S+) r=(\d+) SHOT t=(\d+)$/))) {
    return { type: "shot", cfg: m[1], r: +m[2], t: +m[3] };
  }
  if ((m = payload.match(/^ROUND n=(\S+) r=(\d+) (DONE|TIMEOUT) loaded=(\d+)\/(\d+) word=(\d+) first=(-?\d+) last=(-?\d+) min=(-?\d+) max=(-?\d+) lost=(\d+) seqs=(\d+)$/))) {
    return {
      type: "roundEnd", cfg: m[1], r: +m[2], label: m[3],
      loaded: +m[4], n: +m[5], word: +m[6],
      first: +m[7], last: +m[8], min: +m[9], max: +m[10], lost: +m[11], seqs: +m[12]
    };
  }
  if ((m = payload.match(/^WIN n=(\S+) r=(\d+) k=(\d+)\/(\d+) SHOT (\d+)\.\.(\d+) t=(\d+)$/))) {
    return { type: "winShot", cfg: m[1], r: +m[2], k: +m[3], kN: +m[4], from: +m[5], to: +m[6], t: +m[7] };
  }
  if ((m = payload.match(/^WIN n=(\S+) r=(\d+) k=(\d+)\/(\d+) DONE dt=(\d+)$/))) {
    return { type: "winDone", cfg: m[1], r: +m[2], k: +m[3], dt: +m[5] };
  }
  if ((m = payload.match(/^WIN n=(\S+) r=(\d+) k=(\d+)\/(\d+) STALL loaded=(\d+)\/(\d+)$/))) {
    return { type: "winStall", cfg: m[1], r: +m[2], k: +m[3] };
  }
  if ((m = payload.match(/^LOADED n=(\S+) r=(\d+) i=(\d+) dt=(\d+) seq=(\d+)$/))) {
    return { type: "loaded", cfg: m[1], r: +m[2], i: +m[3], dt: +m[4], seq: +m[5] };
  }
  if ((m = payload.match(/^DUP n=(\S+) r=(\d+) i=(\d+) dt=(\d+)$/))) {
    return { type: "dup", cfg: m[1], r: +m[2], i: +m[3] };
  }
  if ((m = payload.match(/^STALE n=(\S+) r=(\d+) i=(\d+) dt=(\d+)$/))) {
    return { type: "stale", cfg: m[1], r: +m[2], i: +m[3] };
  }
  return null;
}

function newState() {
  return {
    rounds: {},          // key "<cfg>#<r>" -> round 对象
    cfgOrder: [],        // 配置出现顺序(字符串原样, 含 @run)
    cfgMeta: {},         // cfg -> {n, win, rounds} 来自 CFG START
    server: {},          // cfg -> "r#i" -> 次数(落底重复 = 次数-1)
    start: false, allDone: false, abort: false,
    unknown: 0
  };
}

function ensureRound(st, cfg, r) {
  const key = cfg + "#" + r;
  if (!st.rounds[key]) {
    st.rounds[key] = {
      cfg: cfg, r: r, shot: null, label: null, loaded: 0, n: 0, word: null,
      lost: null, seqs: null, arrivals: [], dups: 0, winStalls: 0, winDones: 0
    };
    if (st.cfgOrder.indexOf(cfg) < 0) st.cfgOrder.push(cfg);
  }
  return st.rounds[key];
}

// 整段日志 → 状态
function parseLog(text) {
  const st = newState();
  const lines = String(text).split("\n");
  for (let li = 0; li < lines.length; li += 1) {
    const ln = lines[li].replace(/[\r\n]+$/, ""); // bridge.log 可能是 CRLF,尾部 \r 会破坏 $ 锚点
    // 游戏侧
    const gi = ln.indexOf("exp6734D: ");
    if (gi >= 0) {
      const ev = parseGameEvent(ln.slice(gi + 10));
      if (!ev) { st.unknown += 1; continue; }
      applyEvent(st, ev);
      continue;
    }
    // 服务端落底(新格式 BIT c=.. id=BTD.. round=..;旧 BIT id=BTBIT.. 属 6734-B,忽略)
    const bi = ln.indexOf("BIT c=");
    if (bi >= 0) {
      const m = ln.slice(bi).match(/^BIT c=(\S+) id=BTD(\d+) round=(\d+)/);
      if (m) {
        const cfg = m[1];
        const key = m[3] + "#" + m[2];
        if (!st.server[cfg]) st.server[cfg] = {};
        st.server[cfg][key] = (st.server[cfg][key] || 0) + 1;
        if (st.cfgOrder.indexOf(cfg) < 0) st.cfgOrder.push(cfg);
      }
    }
  }
  return st;
}

function applyEvent(st, ev) {
  switch (ev.type) {
    case "start": st.start = true; break;
    case "allDone": st.allDone = true; break;
    case "abort": st.abort = true; break;
    case "cfgStart":
      st.cfgMeta[ev.cfg] = { n: ev.n, win: ev.win, rounds: ev.rounds };
      if (st.cfgOrder.indexOf(ev.cfg) < 0) st.cfgOrder.push(ev.cfg);
      break;
    case "shot": ensureRound(st, ev.cfg, ev.r).shot = ev.t; break;
    case "roundEnd": {
      const rd = ensureRound(st, ev.cfg, ev.r);
      rd.label = ev.label; rd.loaded = ev.loaded; rd.n = ev.n; rd.word = ev.word;
      rd.first = ev.first; rd.last = ev.last; rd.min = ev.min; rd.max = ev.max;
      rd.lost = ev.lost; rd.seqs = ev.seqs;
      break;
    }
    case "winShot": ensureRound(st, ev.cfg, ev.r); break;
    case "winDone": { const rd = ensureRound(st, ev.cfg, ev.r); rd.winDones += 1; break; }
    case "winStall": { const rd = ensureRound(st, ev.cfg, ev.r); rd.winStalls += 1; break; }
    case "loaded": ensureRound(st, ev.cfg, ev.r).arrivals.push({ i: ev.i, dt: ev.dt, seq: ev.seq }); break;
    case "dup": ensureRound(st, ev.cfg, ev.r).dups += 1; break;
    case "stale": break;
    default: break;
  }
}

// ---------- 聚合:每配置一行 ----------
function aggregate(st) {
  const rows = [];
  const cfgs = st.cfgOrder.slice();
  for (let ci = 0; ci < cfgs.length; ci += 1) {
    const cfg = cfgs[ci];
    const meta = st.cfgMeta[cfg] || null;
    const keys = Object.keys(st.rounds).filter(function (k) { return k.lastIndexOf(cfg + "#", 0) === 0; });
    const rounds = keys.map(function (k) { return st.rounds[k]; })
      .sort(function (a, b) { return a.r - b.r; });
    if (!rounds.length) continue;

    const panels = meta ? meta.n : (rounds[0].n || 0);
    const win = meta ? meta.win : 1;
    const expRounds = meta ? meta.rounds : rounds.length;

    // 位延迟
    const bitDts = [];
    let bits = 0, loss = 0, dupGame = 0, winStalls = 0, tmo = 0, done = 0;
    let reo = 0, reoPairs = 0;
    const words = [];
    const gameKeys = {};
    let firstShot = null, lastEnd = null;
    let wordBps = [];

    for (let i = 0; i < rounds.length; i += 1) {
      const rd = rounds[i];
      for (let a = 0; a < rd.arrivals.length; a += 1) {
        bitDts.push(rd.arrivals[a].dt);
        gameKeys[rd.r + "#" + rd.arrivals[a].i] = true;
      }
      bits += rd.loaded;
      dupGame += rd.dups;
      winStalls += rd.winStalls;
      if (rd.label === "TIMEOUT") tmo += 1;
      else if (rd.label === "DONE") done += 1;
      if (rd.lost !== null) loss += rd.lost;
      if (rd.word !== null && rd.word > 0) {
        words.push(rd.word);
        wordBps.push(rd.loaded * 1000 / rd.word);
      }
      if (rd.shot !== null && rd.word !== null) {
        if (firstShot === null || rd.shot < firstShot) firstShot = rd.shot;
        const end = rd.shot + rd.word;
        if (lastEnd === null || end > lastEnd) lastEnd = end;
      }
      // 轮内相邻到达逆序(idx 变小 = 乱序到达)
      for (let a = 1; a < rd.arrivals.length; a += 1) {
        reoPairs += 1;
        if (rd.arrivals[a].i < rd.arrivals[a - 1].i) reo += 1;
      }
    }

    // 服务端对账
    const srv = st.server[cfg] || {};
    const srvKeys = Object.keys(srv);
    let dupSrv = 0;
    for (let i = 0; i < srvKeys.length; i += 1) if (srv[srvKeys[i]] > 1) dupSrv += srv[srvKeys[i]] - 1;
    let gameOnly = 0, srvOnly = 0;
    const gameKeyList = Object.keys(gameKeys);
    for (let i = 0; i < gameKeyList.length; i += 1) if (!srv[gameKeyList[i]]) gameOnly += 1;
    for (let i = 0; i < srvKeys.length; i += 1) if (!gameKeys[srvKeys[i]]) srvOnly += 1;

    // 吞吐
    const bpsWord = wordBps.length ? percentile(wordBps, 0.5) : null;
    let bpsSus = null;
    if (firstShot !== null && lastEnd !== null && lastEnd > firstShot) {
      bpsSus = bits * 1000 / (lastEnd - firstShot);
    }

    // cfg 解析: "64@123456" / "256w64@123456"
    let base = cfg, run = "-", mBase;
    const at = cfg.lastIndexOf("@");
    if (at >= 0) { base = cfg.slice(0, at); run = cfg.slice(at + 1); }
    let pPanels = panels, pWin = win;
    if ((mBase = base.match(/^(\d+)w(\d+)$/))) { pPanels = +mBase[1]; pWin = +mBase[2]; }
    else if (/^\d+$/.test(base)) pPanels = +base;

    rows.push({
      cfg: cfg, base: base, run: run, panels: pPanels, win: pWin,
      rounds: rounds.length, expRounds: expRounds,
      bits: bits, expected: expRounds * panels,
      bitP50: round1(percentile(bitDts, 0.5)),
      bitP90: round1(percentile(bitDts, 0.9)),
      bitP95: round1(percentile(bitDts, 0.95)),
      bitP99: round1(percentile(bitDts, 0.99)),
      bitMax: bitDts.length ? Math.max.apply(null, bitDts) : null,
      wordP50: round1(percentile(words, 0.5)),
      wordP95: round1(percentile(words, 0.95)),
      wordP99: round1(percentile(words, 0.99)),
      wordMax: words.length ? Math.max.apply(null, words) : null,
      loss: loss, dup: dupGame, dupSrv: dupSrv,
      reo: reo, reoPct: reoPairs ? round1(reo * 100 / reoPairs) : 0,
      staleNote: winStalls, tmo: tmo, done: done,
      gameOnly: gameOnly, srvOnly: srvOnly,
      bpsWord: round1(bpsWord), bpsSus: round1(bpsSus)
    });
  }
  // 排序: 矩阵(按面板数)在前,窗口组在后;同面板数按窗口
  rows.sort(function (a, b) {
    if (a.panels !== b.panels) return a.panels - b.panels;
    return a.win - b.win;
  });
  return rows;
}

// ---------- 表格输出 ----------
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
  out.push(
    fmt("Cfg", 14) + rfmt("Rds", 5) + rfmt("Bits", 11) +
    rfmt("P50", 8) + rfmt("P90", 8) + rfmt("P95", 8) + rfmt("P99", 9) + rfmt("Max", 9) +
    rfmt("W-P50", 9) + rfmt("W-P95", 9) + rfmt("W-Max", 9) +
    rfmt("Loss", 6) + rfmt("Dup", 5) + rfmt("Reo%", 6) + rfmt("TMO", 5) +
    rfmt("b/s(word)", 10) + rfmt("b/s(sus)", 10)
  );
  out.push("-".repeat(160));
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    out.push(
      fmt(r.cfg, 14) +
      rfmt(r.rounds + "/" + r.expRounds, 5) +
      rfmt(r.bits + (r.bits !== r.expected ? "/" + r.expected : ""), 11) +
      rfmt(r.bitP50, 8) + rfmt(r.bitP90, 8) + rfmt(r.bitP95, 8) + rfmt(r.bitP99, 9) + rfmt(r.bitMax, 9) +
      rfmt(r.wordP50, 9) + rfmt(r.wordP95, 9) + rfmt(r.wordMax, 9) +
      rfmt(r.loss, 6) + rfmt(r.dup + (r.dupSrv ? "+" + r.dupSrv + "s" : ""), 5) +
      rfmt(r.reoPct, 6) + rfmt(r.tmo, 5) +
      rfmt(r.bpsWord, 10) + rfmt(r.bpsSus, 10)
    );
  }
  return out.join("\n");
}

// ---------- CLI ----------
function main(argv) {
  const flags = argv.filter(function (a) { return a.indexOf("--") === 0; });
  const args = argv.filter(function (a) { return a.indexOf("--") !== 0; });
  const file = args[0] || "logs/bridge.log";
  const asJson = flags.indexOf("--json") >= 0;
  let only = null;
  for (let i = 0; i < flags.length; i += 1) {
    const m = flags[i].match(/^--only=(.+)$/);
    if (m) only = m[1].split(",");
  }

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.error("exp6734D: 读不到日志 " + file + " — " + e.message);
    process.exit(1);
  }

  const st = parseLog(text);
  let rows = aggregate(st);
  if (only) rows = rows.filter(function (r) { return only.indexOf(r.cfg) >= 0; });

  if (!rows.length) {
    console.error("exp6734D: 日志里没有 exp6734D 数据(" + file + ");游戏内聊天输入 /bt6734d 触发。");
    process.exit(1);
  }

  const meta = {
    file: file,
    runs: Array.from(new Set(rows.map(function (r) { return r.run; }))),
    allDone: st.allDone,
    aborted: st.abort,
    unknownLines: st.unknown
  };

  if (asJson) {
    console.log(JSON.stringify({ meta: meta, rows: rows }, null, 2));
    return;
  }

  console.log("exp6734-D 下行吞吐基准 — " + file);
  console.log("runs: " + meta.runs.join(", ") +
    " | 状态: " + (st.allDone ? "ALL DONE" : st.abort ? "ABORTED" : "未见 ALL DONE(可能仍在跑/中断)") +
    (st.unknown ? " | 未识别行: " + st.unknown : ""));
  console.log("");
  console.log(formatTable(rows));
  console.log("");
  console.log("口径: 分位=最近秩;P50..Max=单 bit dt(ms);W-*=轮字完成 word(ms,含 TIMEOUT 轮);");
  console.log("      Reo%=轮内相邻到达逆序对占比;Dup 列 = 游戏DUP+服务端重复(+Ns);");
  console.log("      b/s(word)=每轮 bits/word 中位;b/s(sus)=总 bits/首末墙钟(含轮间隔)。");
  const bad = rows.filter(function (r) { return r.gameOnly || r.srvOnly; });
  if (bad.length) {
    console.log("对账告警: " + bad.map(function (r) {
      return r.cfg + "(gameOnly=" + r.gameOnly + ",srvOnly=" + r.srvOnly + ")";
    }).join(" "));
  }
}

module.exports = { percentile, parseGameEvent, parseLog, applyEvent, aggregate, formatTable, newState };

if (require.main === module) {
  main(process.argv.slice(2)); // 跳过 node 与脚本路径
}
