"use strict";
// btipc05 离线 E2E:TRQ op 通道(设置面板 保存/测试 + 开机读配置)三连。
// 手法与 btipc_trq_e2e.js 相同:向 console.log 尾部写 TRQ 行(桥 tail 认为是游戏),
// 再 HTTP 查询 /btipc/dl 逐帧收响应解码 —— 不碰游戏、不碰面板通道。
// 跑法: node scripts/btipc_op_e2e.js
const fs = require("node:fs");
const http = require("node:http");

const { crc16 } = require("../core/btipc/crc16.js");
const { decode, fromBits } = require("../core/btipc/framer.js");

const HOST = "127.0.0.1";
const PORT = 8791;
const LOG = "F:/SteamLibrary/steamapps/common/Deadlock/game/citadel/console.log";
const T_CLOSE_MS = Number(process.env.BT_CLOSE_MS || 600);
const MAX_ROUNDS = 200;

function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: pathAndQuery }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(new Error("timeout")); });
  });
}

function trqLine(win, id, text) {
  const bytes = Buffer.from(text, "utf8");
  const crc = ("0000" + crc16(bytes).toString(16)).slice(-4);
  return "BTIPC TRQ w=" + win + " id=" + ("0000" + id.toString(16)).slice(-4) +
    " len=" + bytes.length + " crc=" + crc + " b64=" + bytes.toString("base64");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollFrame(win, r) {
  const bits = new Array(128).fill(0);
  await Promise.all(
    Array.from({ length: 128 }, async (_, p) => {
      try {
        const res = await get("/btipc/dl?w=" + win + "&r=" + r + "&p=" + p + "&t=ope2e-" + r + "-" + p);
        if (res.status === 200) bits[p] = 1;
      } catch (e) { /* 404/drop = 位 0 */ }
    })
  );
  return decode(fromBits(bits));
}

async function runOnce(label, text) {
  const win = ("000000" + Math.floor(Math.random() * 0xffffff).toString(16)).slice(-6); // §14.1 WIN_RE: 6 位 hex
  const id = Math.floor(Math.random() * 65536);
  fs.appendFileSync(LOG, "\n10/02 10:00:00 [PanoramaScript] [LCT] " + trqLine(win, id, text) + "\n", "utf8");
  console.log("[" + label + "] TRQ w=" + win + " id=" + ("0000" + id.toString(16)) + " payload=" + JSON.stringify(text.slice(0, 80)));

  const t0 = Date.now();
  const parts = {};
  let busyRounds = 0;
  for (let r = 1; r <= MAX_ROUNDS; r += 1) {
    await sleep(T_CLOSE_MS);
    const d = await pollFrame(win, r);
    if (!d.ok || d.id !== id) continue;
    if (!d.valid) { busyRounds += 1; continue; }
    if (parts[d.seq] === undefined) parts[d.seq] = d.payload;
    if (d.end) {
      let max = -1;
      for (const k in parts) { const n = parseInt(k, 10); if (n > max) max = n; }
      const bufs = [];
      for (let i = 0; i <= max; i += 1) bufs.push(parts[i]);
      const out = Buffer.concat(bufs).toString("utf8");
      const dt = Date.now() - t0;
      console.log("[" + label + "] DONE busy=" + busyRounds + " out=" + JSON.stringify(out.slice(0, 200)) + " dt=" + dt + "ms");
      return { ok: true, out: out, dt: dt };
    }
  }
  console.log("[" + label + "] TIMEOUT after " + MAX_ROUNDS + " rounds");
  return { ok: false, out: "", dt: -1 };
}

(async function () {
  console.log("=== btipc05 op E2E: config 读 / config 写 / test ===\n");
  const a = await runOnce("cfg-read", "op=config\n{}");
  console.log("");
  const b = await runOnce("cfg-write", "op=config\n" + JSON.stringify({ config: { chatLog: { enabled: true } } }));
  console.log("");
  const c = await runOnce("test", "op=test;tm=11000\n{}");
  console.log("\n=== 汇总 ===");

  let pass = 0;
  const check = (label, cond, why) => {
    console.log(label + ": " + (cond ? "PASS" : "FAIL " + why));
    if (cond) pass += 1;
  };
  let jA = null, jB = null, jC = null;
  try { jA = JSON.parse(a.out); } catch (e) {}
  try { jB = JSON.parse(b.out); } catch (e) {}
  try { jC = JSON.parse(c.out); } catch (e) {}

  check("cfg-read", a.ok && jA && jA.ok === true && jA.config && jA.config.ui !== undefined,
    "期望 {ok:true,config:{ui,...}} got=" + JSON.stringify(a.out.slice(0, 120)));
  check("cfg-write", b.ok && jB && jB.ok === true && jB.config && typeof jB.config.chatLog === "object",
    "期望 {ok:true,config:{chatLog:{enabled:true},...}} got=" + JSON.stringify(b.out.slice(0, 120)));
  check("cfg-write 语义", jB && jB.config && jB.config.chatLog && jB.config.chatLog.enabled === true,
    "chatLog.enabled 应为 true");
  check("test", c.ok && jC && jC.ok === true && typeof jC.translation === "string" && jC.translation.length > 0,
    "期望 {ok:true,translation:\"...\"} got=" + JSON.stringify(c.out.slice(0, 120)));
  console.log("\nRESULT: " + pass + " / 4");
  process.exit(pass === 4 ? 0 : 1);
})().catch((e) => { console.error("E2E crash: " + (e && e.stack)); process.exit(1); });
