#!/usr/bin/env node
// exp6734-B 结果分析:分位数 / 成功率 / 丢失 / 乱序
'use strict';
const fs = require('fs');
const path = require('path');

const LOG = process.argv[2] || 'F:/BabelTower/logs/bridge.log';
const text = fs.readFileSync(LOG, 'utf8');
const lines = text.split(/\r?\n/);

// ---- 游戏侧:LOADED id=BTBITn dt=X (需带 round 上文) ----
const loaded = []; // {round, id, idx, dt}
const shots = [];  // {round, t0}
const dones = [];  // {round, loaded, min, max}
let curRound = 0;
const roundMap = {}; // bridge.log 时间戳行 -> round (SHOT 行确定 round)

for (const ln of lines) {
  if (!ln.includes('exp6734B')) continue;
  let m = ln.match(/ROUND=(\d+) SHOT t=(\d+)/);
  if (m) {
    curRound = +m[1];
    shots.push({ round: curRound, t0: +m[2], raw: ln });
    // 用日志行本身作为键,LOADED 行在 SHOT 之后、DONE 之前同一逻辑窗口
    continue;
  }
  m = ln.match(/ROUND=(\d+) DONE loaded=(\d+)\/(\d+) min=(\d+) max=(\d+) t0=(\d+)/);
  if (m) {
    dones.push({ round: +m[1], loaded: +m[2], expect: +m[3], min: +m[4], max: +m[5], t0: +m[6] });
    continue;
  }
  m = ln.match(/LOADED id=BTBIT(\d+) dt=(\d+)/);
  if (m) {
    loaded.push({ round: curRound, idx: +m[1], dt: +m[2] });
  }
}

// ---- 服务端:BIT id=BTBITn round=m ----
const srv = [];
for (const ln of lines) {
  const m = ln.match(/BIT id=BTBIT(\d+) round=(\d+)/);
  if (m) srv.push({ idx: +m[1], round: +m[2], raw: ln });
}
// 排除自检 round=0
const srvRun = srv.filter(s => s.round >= 1);

// ---- 分位数 ----
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const dts = loaded.map(l => l.dt).sort((a, b) => a - b);
const sum = dts.reduce((a, b) => a + b, 0);

// ---- 逐轮统计 ----
const rounds = [...new Set(loaded.map(l => l.round))].sort((a, b) => a - b);
const roundRows = [];
for (const r of rounds) {
  const items = loaded.filter(l => l.round === r);
  const d = items.map(i => i.dt).sort((a, b) => a - b);
  const srvN = srvRun.filter(s => s.round === r).length;
  roundRows.push({
    round: r,
    n: items.length,
    p50: pct(d, 0.5),
    p95: pct(d, 0.95),
    max: d[d.length - 1],
    srv: srvN,
  });
}

// ---- 丢失:游戏侧上报 vs 服务端落底 (按 round+idx 配对) ----
const gameKeys = new Set(loaded.map(l => `${l.round}:${l.idx}`));
const srvKeys = new Set(srvRun.map(s => `${s.round}:${s.idx}`));
const gameOnly = [...gameKeys].filter(k => !srvKeys.has(k));
const srvOnly = [...srvKeys].filter(k => !gameKeys.has(k));

// 服务端重复
const srvDup = [];
{
  const seen = new Map();
  for (const s of srvRun) {
    const k = `${s.round}:${s.idx}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) srvDup.push({ k, n });
}

// ---- 乱序:服务端落底顺序中 round 递增性 + 同轮内 idx 序 ----
// 1) 跨轮回退(后轮先于前轮落底)
let roundBack = 0;
{
  let last = 0;
  for (const s of srvRun) {
    if (s.round < last) roundBack++;
    last = Math.max(last, s.round);
  }
}
// 2) 游戏侧 LOADED 上报顺序:同轮内 idx 乱序对数
let idxInversions = 0;
for (const r of rounds) {
  const items = loaded.filter(l => l.round === r);
  for (let i = 1; i < items.length; i++) {
    if (items[i].idx < items[i - 1].idx) idxInversions++;
  }
}
// 3) 服务端同轮内 idx 逆序对
let srvIdxInversions = 0;
for (const r of rounds) {
  const items = srvRun.filter(s => s.round === r);
  for (let i = 1; i < items.length; i++) {
    if (items[i].idx < items[i - 1].idx) srvIdxInversions++;
  }
}

// ---- 轮间隔 (SHOT t0 差) ----
const gaps = [];
for (let i = 1; i < shots.length; i++) gaps.push(shots[i].t0 - shots[i - 1].t0);

const out = {
  game: {
    rounds: rounds.length,
    shots: shots.length,
    dones: dones.length,
    loadedTotal: loaded.length,
    allDonesFull: dones.every(d => d.loaded === d.expect),
    dones,
  },
  server: {
    runTotal: srvRun.length,
    selfTestExcluded: srv.length - srvRun.length,
  },
  latency: {
    n: dts.length,
    min: dts[0],
    p50: pct(dts, 0.5),
    p90: pct(dts, 0.9),
    p95: pct(dts, 0.95),
    p99: pct(dts, 0.99),
    max: dts[dts.length - 1],
    mean: +(sum / dts.length).toFixed(2),
  },
  reconcile: {
    gameOnlyCount: gameOnly.length,
    gameOnlySample: gameOnly.slice(0, 10),
    srvOnlyCount: srvOnly.length,
    srvOnlySample: srvOnly.slice(0, 10),
    srvDupCount: srvDup.length,
    srvDupSample: srvDup.slice(0, 10),
  },
  ordering: {
    roundBack,
    idxInversions,
    srvIdxInversions,
  },
  pacing: {
    gapMin: gaps.length ? Math.min(...gaps) : null,
    gapMax: gaps.length ? Math.max(...gaps) : null,
    gapMean: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : null,
  },
  rounds: roundRows,
};

console.log(JSON.stringify(out, null, 2));
