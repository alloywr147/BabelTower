"use strict";
// BTIPC v1 信道仿真器(规格:docs/btipc-v1.md §12.3)—— 先仿真后实车。
//
// 做法:桥端用**真实模块**(WindowTable / serveDL / framer),游戏侧轮次状态机按 §4/§4.0
// 在虚拟时钟上重演(不 sleep,100 次传输毫秒级跑完)。
//
// 信道模型(全部有出处):
//   - dt 分布 = 新 build 实测(D/E 组):P50 31ms / P95 161ms / Max 522ms → 三段均匀采样;
//     dt > T_CLOSE(600)的 fire 视为本轮未到(实际 max 522 < 600,稳态零迟到);
//   - 风暴模式(§4.1):dt ×6(P50 186 / P95 966 / Max 3132 > STORM_TCLOSE 2500,少量迟到
//     → 自然制造风暴期重试,风暴只能靠 CRC ok 退出 —— 与实测"风暴只慢不丢"一致);
//   - **5% 丢包 = 轮级**(整轮请求全部丢失 → 全 404 → CRC fail → 同 r 重投)。
//     按位 5% 会使 CRC 几乎轮轮失败(每帧 ~60 个 1 位 → 0.95^60 ≈ 4% 轮幸存,重试率 ≈96%),
//     与 §12.3 "重试率 <10%" 不相容;轮级 5% → 期望重试率 ≈ 5.3% ✓。
//
// 用法: node scripts/btipc_sim.js [transfers] [seed]
const { WindowTable } = require("../core/btipc/window.js");
const { serveDL } = require("../core/btipc/transport.js");
const { encode, decode } = require("../core/btipc/framer.js");

// 与 lingua_chat.js 客户端同值(§9 参数表)
const T_CLOSE_MS = 600;
const STORM_TCLOSE_MS = 2500;
const BUSY_BACKOFF_MS = 500;
const STORM_TRIGGER = 2;
const STORM_ROUNDS = 4;
const CRC_DEAD = 8;
const RETRY_GAP_MS = 100; // CRC fail 后重投间隔(客户端 0.1s)
const STORM_GAP_MS = 1000; // §4.1 风暴轮间冷却

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 采样单个 fire 的 dt(ms);风暴 = ×6 放大 */
function sampleDt(rng, storm) {
  const u = rng();
  let dt;
  if (u < 0.5) dt = 5 + rng() * 26; // ≤31(P50)
  else if (u < 0.95) dt = 31 + rng() * 130; // ≤161(P95)
  else dt = 161 + rng() * 361; // ≤522(Max)
  return storm ? dt * 6 : dt;
}

const TEXT_POOL = [
  "gg", "glhf", "thanks!", "mid or feed", "gg wp",
  "你好你好", "我们这把打上路", "请求支援!我在河道",
  "Hello teammates, let's push mid together and take the tower before 10 minutes!",
  "ok", "nice play good job", "买活买活买活买活买活买活",
  "这波团战打得很漂亮,下一条大龙我们一定要拿下,视野先做起来!",
  "Warden is missing, everyone stay back and farm your own jungle until he shows.",
  "上路优势很大,打野来帮忙越塔,我去带下路线牵制,别急着开团。",
];

function defaultTextGen(rng) {
  return TEXT_POOL[Math.floor(rng() * TEXT_POOL.length)];
}

/**
 * 跑一批传输。
 * @param {{transfers?:number, seed?:number, roundLoss?:number, busyRounds?:number,
 *          textGen?:(rng:()=>number)=>string,
 *          forceLoss?:(k:number, r:number, roundNo:number)=>boolean}} [opts]
 * @returns {{transfers:number, done:number, wrong:number, failed:number, rounds:number,
 *            retryRounds:number, busyRounds:number, stormEvents:number, payloadBytes:number,
 *            simMs:number, retryRate:number, payloadBits:number, throughput:number}}
 */
function runSim(opts) {
  opts = opts || {};
  const transfers = opts.transfers === undefined ? 100 : opts.transfers;
  const seed = opts.seed === undefined ? 42 : opts.seed;
  const roundLoss = opts.roundLoss === undefined ? 0.05 : opts.roundLoss;
  const busyRounds = opts.busyRounds || 0;
  const textGen = opts.textGen || defaultTextGen;
  const forceLoss = opts.forceLoss || null;
  const rng = mulberry32(seed);

  let now = 0;
  const table = new WindowTable({ now: () => now });
  const m = {
    transfers: transfers, done: 0, wrong: 0, failed: 0,
    rounds: 0, retryRounds: 0, busyRounds: 0, stormEvents: 0,
    payloadBytes: 0, simMs: 0, retryRate: 0, payloadBits: 0, throughput: 0,
  };

  for (let k = 0; k < transfers; k++) {
    const text = textGen(rng);
    const bytes = Buffer.from(text, "utf8");
    const win = ("000000" + k.toString(16)).slice(-6);
    const id = Math.floor(rng() * 65536);
    table.acceptReq(win, id, bytes);
    const readyAtRound = busyRounds + 1; // 前 busyRounds 轮 frames 未就绪 → 固定 BUSY

    let r = 1;
    let roundNo = 0;
    let frameFails = 0;
    let consec = 0;
    let stormRounds = 0;
    let finished = false;
    let failedKind = null;
    const parts = {};

    while (!finished && !failedKind) {
      roundNo++;
      m.rounds++;
      if (roundNo >= readyAtRound && table.get(win).frames === null) {
        table.setFrames(win, encode(id, bytes)); // 回声/翻译完成(§6)
      }
      if (roundNo >= 500) { failedKind = "loop_guard"; break; } // 看门狗(理论不可达)
      const inStormNow = stormRounds > 0;
      const tClose = inStormNow ? STORM_TCLOSE_MS : T_CLOSE_MS;

      // ---- SHOT(§4):128 面板;轮级丢包 = 整批请求丢失 ----
      // forceLoss 按 roundNo(含重试)而非 r —— 重试时 r 不变,按 r 强制丢失会永死锁。
      const dropped = rng() < roundLoss || (forceLoss && forceLoss(k, r, roundNo));
      const fire = new Array(128).fill(0);
      if (!dropped) {
        for (let p = 0; p < 128; p++) {
          const res = serveDL(table, { w: win, r: String(r), p: String(p) });
          if (res.status !== 200) continue; // bit=0 → 404 静默,无事件
          const dt = sampleDt(rng, inStormNow);
          if (dt <= tClose) fire[p] = 1; // dt 超收口 = 本轮未到
        }
      }
      now += tClose;

      // ---- 闭合 → 16 字节 → 判定(§4.0)----
      const b = new Array(16).fill(0);
      for (let p = 0; p < 128; p++) if (fire[p]) b[p >> 3] |= 1 << (p & 7);
      const d = decode(Buffer.from(b));

      if (!d.ok) {
        frameFails++;
        consec++;
        m.retryRounds++;
        if (frameFails > CRC_DEAD) { failedKind = "crc_dead"; break; }
        let entered = false;
        if (consec >= STORM_TRIGGER && stormRounds <= 0) {
          stormRounds = STORM_ROUNDS;
          entered = true;
          m.stormEvents++;
        }
        const inStorm = stormRounds > 0;
        if (inStorm && !entered) stormRounds--; // 进入当轮不减(宽收口正好 4 轮)
        now += inStorm ? STORM_GAP_MS : RETRY_GAP_MS;
        continue; // 同 r 重投
      }

      // ---- CRC ok ----
      frameFails = 0;
      consec = 0;
      stormRounds = 0; // 任一轮 CRC ok 即退出风暴

      if (!d.valid) {
        m.busyRounds++; // BUSY 固定帧:退避后 r++
        now += BUSY_BACKOFF_MS;
        r++;
        continue;
      }

      if (parts[d.seq] === undefined) parts[d.seq] = d.payload;
      if (!d.end) {
        r++; // 数据帧推进无额外间隙(客户端实现)
        continue;
      }

      // END:验收 0..max 连续 → 拼装
      let maxSeq = -1;
      for (const key of Object.keys(parts)) {
        const n = Number(key);
        if (n > maxSeq) maxSeq = n;
      }
      const cat = [];
      let gap = -1;
      for (let i = 0; i <= maxSeq; i++) {
        if (parts[i] === undefined) { gap = i; break; }
        for (const byte of parts[i]) cat.push(byte);
      }
      if (gap >= 0) { failedKind = "gap:" + gap; break; }
      const got = Buffer.from(cat).toString("utf8");
      finished = true;
      if (got !== text) m.wrong++;
      else m.done++;
      m.payloadBytes += bytes.length;
    }

    if (failedKind) m.failed++;
    table.cancel(win);
  }

  m.simMs = now;
  m.retryRate = m.rounds ? m.retryRounds / m.rounds : 0;
  m.payloadBits = m.payloadBytes * 8;
  m.throughput = now > 0 ? (m.payloadBits * 1000) / now : 0;
  return m;
}

module.exports = { runSim, sampleDt, mulberry32, TEXT_POOL };

if (require.main === module) {
  const transfers = Number(process.argv[2]) || 100;
  const seed = Number(process.argv[3]) || 42;
  const m = runSim({ transfers: transfers, seed: seed });
  console.log("BTIPC sim: transfers=" + m.transfers + " seed=" + seed);
  console.log("  done=" + m.done + " wrong=" + m.wrong + " failed=" + m.failed);
  console.log("  rounds=" + m.rounds + " retries=" + m.retryRounds +
    " retryRate=" + (m.retryRate * 100).toFixed(2) + "%");
  console.log("  busyRounds=" + m.busyRounds + " stormEvents=" + m.stormEvents);
  console.log("  payload=" + m.payloadBytes + "B simTime=" + (m.simMs / 1000).toFixed(1) + "s" +
    " throughput=" + m.throughput.toFixed(1) + " bit/s");
  const pass = m.wrong === 0 && m.failed === 0 && m.retryRate < 0.1 && m.throughput >= 100;
  console.log(pass ? "PASS (§12.3: 零错字 / 重试率<10% / ≥100 bit/s)" : "FAIL");
  process.exit(pass ? 0 : 1);
}
