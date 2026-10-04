// 回归护栏:锁死 btipc05c 修过的两处【结构性】破坏 —— 这类 bug 靠功能测试抓不到
// (05b 实车才暴露:语法合法、离线全绿,但 config 整块掉进 if(test) 内 → payload=undefined)。
// 教训来源:2026-10-03 btipc05b 假绿 —— 编辑时丢了一个 `} else {`,
// 结果 op=config dispatch THREW ×23、op=test 被覆盖成 op=config,实车 34 连败链。
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "mod", "panorama", "scripts", "lingua_chat.js");
const src = fs.readFileSync(SRC, "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
}

// ---- 1. op 分支的 if/else 结构完整 ----
// 定位 `if (job.op === "test")`,要求它与 `payload = "op=config` 之间存在配对的 `} else {`
const ifTestIdx = src.indexOf('if (job.op === "test")');
check("找到 op=test 分支", ifTestIdx > 0, "idx=" + ifTestIdx);

const configPayloadIdx = src.indexOf('payload = "op=config\\n" + raw');
check("找到 op=config payload 赋值", configPayloadIdx > ifTestIdx && configPayloadIdx > 0,
  "ifIdx=" + ifTestIdx + " cfgIdx=" + configPayloadIdx);

const between = ifTestIdx > 0 && configPayloadIdx > ifTestIdx
  ? src.slice(ifTestIdx, configPayloadIdx) : "";
// else 必须开在 test 分支的收尾处:出现 `}` 后跟 `else {`
const elseIdx = between.indexOf("} else {");
check("test 分支后存在 `} else {`(config 走独立分支)", elseIdx >= 0,
  "缺失 → config 会掉进 if(test) 块内,payload 停在 undefined → btipcUtf8Bytes(undefined).length 抛 dispatch THREW");

// test 的 payload 必须在 else 之前(否则会被 config 赋值覆盖 → 测试按钮发 op=config)
const testPayloadIdx = src.indexOf('payload = "op=test;tm="');
check("test payload 在 else 之前(不被 config 覆盖)",
  testPayloadIdx > ifTestIdx && testPayloadIdx < configPayloadIdx && elseIdx >= 0,
  "testIdx=" + testPayloadIdx + " elseIdx=" + elseIdx + " cfgIdx=" + configPayloadIdx);

// ---- 2. 读/写死线分离 ----
const rd = src.match(/isRead \? (\d{5}) : (\d{4})/);
check("读死线 ≥50s / 写死线 =8s", !!rd && Number(rd[1]) >= 50000 && Number(rd[2]) === 8000,
  rd ? "got " + rd[1] + "/" + rd[2] + "(05c 实车:成功那读 30.2s,另一次卡在 35s 只到 seq=22/38)"
     : "缺失 → 读应答 38 帧≈24s 必超 8s(实车 34 连败根因)");
// op 忙等窗必须同步跟随读死线,否则 op 等到窗口就掉旧通道 → 读死线白设
const bw = src.match(/busyMs = isOp \? (\d+) : 12000/);
check("op 忙等窗 ≥ 52s(跟随读死线)", !!bw && Number(bw[1]) >= 52000,
  bw ? "busyMs=" + bw[1] : "未匹配到 busyMs isOp 三元");

// ---- 3. pumpQueue 让位必 break(否则原地自旋刷洪水)----
const pumpIdx = src.indexOf("function pumpQueue()");
check("找到 pumpQueue", pumpIdx > 0, "idx=" + pumpIdx);
// 函数体按花括号配对取,不能用固定窗口:2026-10-04 缺陷 B 给 pumpQueue 加了
// try/catch + 注释,pumpQueue 变长后固定 900 字符窗口把 _btipcDeferred 挤出去
// → 探针误报(被查的性质其实一直都在)。取不到就退回放大窗口兜底。
let pumpBody = "";
if (pumpIdx > 0) {
  let d = 0;
  for (let i = src.indexOf("{", pumpIdx); i > 0 && i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") d += 1;
    else if (ch === "}") {
      d -= 1;
      if (d === 0) { pumpBody = src.slice(pumpIdx, i + 1); break; }
    }
  }
}
if (!/_btipcDeferred/.test(pumpBody)) pumpBody = src.slice(pumpIdx, pumpIdx + 4000);
check("pumpQueue 消费 _btipcDeferred 并 break(防原地自旋)",
  /_btipcDeferred/.test(pumpBody) && /break;/.test(pumpBody),
  "缺失 → while 把 unshift 回队首的同一 job 再 shift 出来打转," +
  "重投次数 <1ms 打满并挂等量延迟泵(05b 实车:单秒 74 行 requeue 洪水 → 桥 tail 迟 7~24s → 回声超时 → CRC 风暴)");
check("busy 分支置 _btipcDeferred = true", /_btipcDeferred = true/.test(src));

// ---- 4. 版本标 / 前缀常量 ----
const ver = (src.match(/const VERSION = "([^"]+)"/) || [])[1] || "";
// 版本号 = 当前开发版(与 lingua_chat.js 的 const VERSION 必须同步,升版时两处一起改);
// 发布时若需与 Release 标签对齐,改完发包后要把这里和 VERSION 一并推到下一开发版,
// 玩家日志 `loaded vX.Y.Z-…` 才始终能和 Release/GB 页面对上号。
check("VERSION 已升版(含 btipc 标)", /1\.0\.7-6726-btipc\d/.test(ver), "got=" + ver);
check("BTIPC 面板前缀 BTIPCD(6 字符,与探针隔离)",
  /BTIPC_PANEL_PREFIX = "BTIPCD"/.test(src));

console.log("\nRESULT: PASS " + pass + " / FAIL " + fail);
process.exit(fail ? 1 : 0);
