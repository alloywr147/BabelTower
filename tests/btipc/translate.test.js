"use strict";
// ⑥ 翻译链接入的离线验收(不碰游戏/网络):
//   1) TRQ 命令解析:等长于 REQ,不额外占用 §9 J1 的 1000 字节行预算;
//   2) echo / translate 两条路径严格隔离(BUSY 空窗、异步 setFrames、空 END 帧语义);
//   3) 协议零改动:未新增任何位段,framer 编解码字节级不变。
// 跑法: node --test "tests/**/*.test.js"
const test = require("node:test");
const assert = require("node:assert");

const { parseGameLine, REQ_MAX_PAYLOAD, serveDL } = require("../../core/btipc/transport.js");
const { WindowTable } = require("../../core/btipc/window.js");
const { encode, decode, busyFrame, buildFrame, FRAME_BYTES } = require("../../core/btipc/framer.js");
const { crc16 } = require("../../core/btipc/crc16.js");

const PREFIX = "[PanoramaScript] [LCT] BTIPC ";

function reqLine(verb, text, win = "f3a1c2", id = 0x00c8) {
  const bytes = Buffer.from(text, "utf8");
  const crc = ("0000" + crc16(bytes).toString(16)).slice(-4);
  return PREFIX + verb + " w=" + win + " id=" + ("0000" + id.toString(16)).slice(-4) +
    " len=" + bytes.length + " crc=" + crc + " b64=" + bytes.toString("base64");
}

// ---------- 1) TRQ 命令解析 ----------

test("TRQ 行可解析且标记 translate=true", () => {
  const p = parseGameLine(reqLine("TRQ", "hello can you push mid"));
  assert.ok(p.ok, "TRQ 应可解析");
  assert.strictEqual(p.cmd, "TRQ");
  assert.strictEqual(p.translate, true);
  assert.strictEqual(p.payload.toString("utf8"), "hello can you push mid");
});

test("REQ 行仍为回声语义(translate=false)", () => {
  const p = parseGameLine(reqLine("REQ", "Hello BTIPC"));
  assert.ok(p.ok);
  assert.strictEqual(p.cmd, "REQ");
  assert.strictEqual(p.translate, false, "echo 路径不得被翻译语义污染");
});

test("TRQ 与 REQ 行长完全相等 —— 不额外占用 J1 行预算", () => {
  const texts = ["Hello BTIPC", "你好啊队友们我们这把打上路", "x"];
  for (const t of texts) {
    assert.strictEqual(reqLine("TRQ", t).length, reqLine("REQ", t).length,
      "TRQ/REQ 行长应逐字节相等");
  }
  // 最坏行(680B payload)仍在 1000 字符内
  const worst = Buffer.from("汉".repeat(Math.floor(REQ_MAX_PAYLOAD / 3)), "utf8");
  const worstTrq = PREFIX + "TRQ w=f3a1c2 id=00c8 len=" + worst.length +
    " crc=" + ("0000" + crc16(worst).toString(16)).slice(-4) + " b64=" + worst.toString("base64");
  assert.ok(worstTrq.length <= 1000, "最坏 TRQ 行 " + worstTrq.length + " 字符 ≤ 1000");
  assert.ok(parseGameLine(worstTrq).ok, "最坏 TRQ 行可解析");
});

test("TRQ 沿用 REQ 的全部 §14.1 校验", () => {
  // 坏 CRC
  const bad = reqLine("TRQ", "hello").replace(/crc=[0-9a-f]{4}/, "crc=0000");
  assert.strictEqual(parseGameLine(bad).ok, false, "TRQ 必须同样拒收坏 CRC");
  // 非法 windowId
  const badWin = reqLine("TRQ", "hello").replace("w=f3a1c2", "w=ZZZZZZ");
  assert.strictEqual(parseGameLine(badWin).ok, false, "TRQ 必须同样校验 windowId");
  // 未知命令词仍拒收
  const badVerb = reqLine("XXX", "hello");
  assert.strictEqual(parseGameLine(badVerb).reason, "unknown_cmd");
});

// ---------- 2) echo / translate 路径隔离 ----------

test("翻译窗在 setFrames 前一律返回 BUSY,不锚定 frameStartRound", () => {
  const table = new WindowTable();
  table.acceptReq("aabbcc", 0x1234, Buffer.from("hello"));
  // frames=null → BUSY,且不锚定 round(这样首个 DATA poll 才会锚定)
  // BUSY 固定帧的位由 CRC 决定,p=0 可能是 0 位(→404),故只验语义字段。
  const id = table.get("aabbcc").id;
  const bf = decode(busyFrame(id));
  assert.ok(bf.ok && bf.valid === false, "BUSY 帧应可解且 VALID=0");
  for (const r of [1, 2, 5, 9]) {
    const out = serveDL(table, { w: "aabbcc", r: String(r), p: "0" });
    assert.strictEqual(out.busy, true, "r=" + r + " 应为 BUSY");
    assert.strictEqual(out.idx, -1, "BUSY 时不应计算帧号");
    // 位必须与 BUSY 固定帧的对应位逐位一致(§3.1 LSB first)
    assert.strictEqual(out.bit, (busyFrame(id)[0] >> 0) & 1, "BUSY 位应与固定帧一致");
  }
  assert.strictEqual(table.get("aabbcc").frameStartRound, null, "BUSY 期间不得锚定 frameStartRound");
});

test("setFrames 后首个 DATA poll 锚定 round,BUSY 期间消耗的 r 不影响帧号", () => {
  const table = new WindowTable();
  const id = 0x1234;
  table.acceptReq("aabbcc", id, Buffer.from("hello"));
  // 翻译期间客户端反复同 r 轮询(§⑥:BUSY 不 r++)
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(serveDL(table, { w: "aabbcc", r: "1", p: "0" }).busy, true);
  }
  // 翻译完成 → setFrames;客户端仍在 r=1
  assert.strictEqual(table.setFrames("aabbcc", encode(id, "你好")), true);
  const first = serveDL(table, { w: "aabbcc", r: "1", p: "0" });
  assert.strictEqual(first.busy, false);
  assert.strictEqual(first.idx, 0, "首个 DATA poll 锚定 r=1 → idx 0");
  assert.strictEqual(serveDL(table, { w: "aabbcc", r: "2", p: "0" }).idx, 1);
});

test("翻译失败用空 END 帧:协议合法、可解出空串", () => {
  const id = 0x4321;
  const frames = encode(id, ""); // 失败信号:空 END(len=0)
  assert.strictEqual(frames.length, 1, "空串 = 单帧");
  const d = decode(frames[0]);
  assert.ok(d.ok, "空 END 帧必须 CRC 合法");
  assert.strictEqual(d.valid, true, "仍是合法 DATA 帧(非 BUSY)");
  assert.strictEqual(d.end, true, "必须带 END");
  assert.strictEqual(d.len, 0, "len=0");
  const text = Buffer.concat([decode(frames[0]).payload]).toString("utf8");
  assert.strictEqual(text, "", "重组结果为空串 → 上层判 translate_error");
});

test("回声模式不因空串被判失败(协议层无差别,判定在 API 层)", () => {
  // 同一空 END 帧在 echo 模式是合法回声 —— 故 framer 层不做任何 translate 语义,
  // 判定完全由 lingua_chat.js 的 st.translate 门控。
  const frames = encode(0x0001, "");
  assert.ok(decode(frames[0]).ok && decode(frames[0]).end);
});

// ---------- 3) 协议零改动 ----------

test("⑥ 未新增任何位段:BUSY 帧与 DATA 帧布局不变", () => {
  const bf = busyFrame(0x00c8);
  assert.strictEqual(bf.length, FRAME_BYTES);
  const db = decode(bf);
  assert.ok(db.ok && db.valid === false && db.seq === 0 && db.len === 0,
    "BUSY 帧形状不变(§3.2 冻结)");
  // 构造帧各字段仍可独立设定,证明位段分配未变
  const f = buildFrame({ seq: 5, id: 0xbeef, end: true, valid: true, payload: Buffer.from("abc") });
  const d = decode(f);
  assert.strictEqual(d.seq, 5);
  assert.strictEqual(d.id, 0xbeef);
  assert.strictEqual(d.end, true);
  assert.strictEqual(d.len, 3);
  assert.strictEqual(d.payload.toString("utf8"), "abc");
});

test("译文超 seq7 上限时 encode 抛错(而非静默截断)", () => {
  assert.throws(() => encode(1, Buffer.alloc(1281)), /超出 seq7 上限/);
  assert.strictEqual(encode(1, Buffer.alloc(1280)).length, 128);
});
