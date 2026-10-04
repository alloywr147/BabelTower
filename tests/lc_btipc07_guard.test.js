// 离线测试:btipc07 游戏侧接线护栏(health / gamenames / quickchat 迁 BTIPC)
// 跑法: node tests/lc_btipc07_guard.test.js
//
// 这些是"改动会静默失效"的接线点 —— 真车要十几分钟才能复现,离线先钉死:
//   ① 三个数据接口必须折进 op=config(信封白名单冻结,改 op 名会被 transport 拒);
//   ② health 回声成功必须真的更新状态并触发同步(老代码早退,三个触发器从没执行过);
//   ③ 分片必须让位给翻译队列(单槽,不让位会把翻译卡死十几秒);
//   ④ 打包必须带上差分基线(否则玩家侧永远走全量,十几分钟)。
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0, skipped = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS |", label); }
  else { fail++; console.log("  FAIL |", label); }
}
function skip(label) { skipped++; console.log("  SKIP |", label); }

const ROOT = path.join(__dirname, "..");
const LC = path.join(ROOT, "mod", "panorama", "scripts", "lingua_chat.js");
const BRIDGE = path.join(ROOT, "core", "bridge_server.js");
const PKG = path.join(ROOT, "scripts", "package_release.ps1");
const TRANSPORT = path.join(ROOT, "core", "btipc", "transport.js");

if (!fs.existsSync(LC) || !fs.existsSync(BRIDGE)) {
  skip("lingua_chat.js / bridge_server.js");
  console.log("RESULT: PASS " + pass + " / FAIL " + fail + " / SKIP " + skipped);
  process.exit(0);
}
const lc = fs.readFileSync(LC, "utf8");
const bridge = fs.readFileSync(BRIDGE, "utf8");

// ---------- ① 信封折叠:三个 op 必须走 op=config 的 "get" 字段 ----------
console.log("--- 信封折叠(core/btipc 信封白名单冻结,新语义只能进 body) ---");
ok(/const BTIPC_GET_OPS = \{ health: 1, gamenames: 1, quickchat: 1 \};/.test(lc),
  "BTIPC_GET_OPS 覆盖 health / gamenames / quickchat");
ok(/enqueueBridge\(isGet \? "config" : op, data, done, isGet\)/.test(lc),
  "bridgePost 把 get 折进 op=config");
ok(/enqueueBridge\(op, data, done, isRead\)/.test(lc) || /done, isRead\);/.test(lc),
  "bridgePost 透传 isRead");
ok(/function enqueueBridge\(op, data, done, isRead\)/.test(lc), "enqueueBridge 带 isRead 形参");
ok(/read: !!isRead/.test(lc), "job.read 记录在 job 上");
ok(/const isRead = !!job\.read \|\|/.test(lc),
  "outgoingViaBtipc 用 job.read 决定 50s 读死线(get 应答可能比分片还大)");
// 折进 config 后,原有三个 viaBtipc 判定点不用改;钉住它们仍然只认 config/test
ok(/\(job\.kind === "bridge" && \(job\.op === "config" \|\| job\.op === "test"\)\)/.test(lc),
  "viaBtipc 判定点保持 config|test(get 已折叠,不该出现新 op 名)");
ok(!/job\.op === "health"|job\.op === "gamenames"|job\.op === "quickchat"/.test(lc),
  "没有把 health/gamenames/quickchat 当独立 op 塞进信封(会被 transport 白名单拒)");

console.log("--- 桥端 get 分发 ---");
ok(/if \(obj && typeof obj\.get === "string"\) return runBtipcGet\(obj\);/.test(bridge),
  "runBtipcOp config 分支优先处理 get");
ok(/if \(obj\.config\)/.test(bridge), "配置写分支仍在(与 get 互斥)");
ok(/syncData\.syncGet\(kind, current, readSyncBaseline\(kind\), clientFp, o\.off, o\.lim, expect\)/.test(bridge),
  "runBtipcGet 委托给纯函数 syncGet");
ok(/LCT_GAMENAMES_PAIRS/.test(bridge) && /LCT_QUICKCHAT_FALLBACK_TEMPLATES/.test(bridge),
  "桥读两种客户端基线做 delta");
ok(/namesFingerprint\(data\)/.test(bridge), "gamenames 基线指纹由桥重算(与打包同口径)");

// ---------- ② health:回声成功必须真的上线并触发同步 ----------
console.log("--- healthCheck:回声成功 -> 上线 + 触发同步 ---");
ok(/\.then\(function \(\) \{ onBridgeAlive\("btipc echo"\); \}\)/.test(lc),
  "BTIPC 回声成功调用 onBridgeAlive");
ok(/function onBridgeAlive\(src\)/.test(lc), "onBridgeAlive 已定义");
ok(/function onBridgeDown\(\)/.test(lc), "onBridgeDown 已定义(判红前给宽限)");
const aliveBody = lc.slice(lc.indexOf("function onBridgeAlive(src)"), lc.indexOf("function onBridgeDown()"));
ok(/setBridgeStatus\(t\("bridgeOnline"\)/.test(aliveBody), "上线时更新状态栏(老代码永远停在初始值)");
ok(/syncGameNames\(function \(\) \{ State\.gamenamesLoading = false; \}\)/.test(aliveBody),
  "onBridgeAlive 触发 gamenames 同步");
ok(/syncQuickChat\(function \(\) \{ State\.quickchatLoading = false; \}\)/.test(aliveBody),
  "onBridgeAlive 触发 quickchat 同步");
ok(/State\.cfgSynced && !State\.cfgSyncing/.test(aliveBody), "onBridgeAlive 补触发配置同步");
ok(/if \(freshH \|\| State\.btipcActive\) return;/.test(lc),
  "新鲜期/传输在途不判死(避免同步分片期间误报离线)");
ok(/onBridgeDown\(\);\s*\n\s*return;\s*\n\s*\}/.test(lc), "非新鲜期调用 onBridgeDown 判红");

// ---------- ③ 分片必须让位给翻译队列 ----------
console.log("--- 分片让位(单槽队列,不让位会卡死翻译) ---");
ok(/const SYNC_LIM_BYTES = (\d+);/.test(lc), "SYNC_LIM_BYTES 已定义");
const limM = lc.match(/const SYNC_LIM_BYTES = (\d+);/);
if (limM) {
  const lim = parseInt(limM[1], 10);
  ok(lim > 0 && lim <= 140,
    "片长 " + lim + "B <= 140B(90B≈9 帧≈7s,必须低于出站 15s 排队丢弃线)");
}
const pullBody = lc.slice(lc.indexOf("const pull = function (off, acc, chunks, exp)"), lc.indexOf("pull(null, \"\", 0, null);"));
ok(/State\.queue\.length > 0 \|\| State\.activeRequests > 0/.test(pullBody), "下一片前等队列排空");
ok(/\$\.Schedule\(0\.3, again\);/.test(pullBody) && /\$\.Schedule\(1\.0, again\);/.test(pullBody),
  "片间用 $.Schedule 延迟(不是同步自旋)");
ok(/const SYNC_MAX_CHUNKS = \d+;/.test(lc), "有分片预算护栏 SYNC_MAX_CHUNKS");
ok(/const SYNC_MAX_TRIES = \d+;/.test(lc), "有重试上限 SYNC_MAX_TRIES(桥回错时不刷屏)");
ok(/body\.exp = exp/.test(pullBody), "分片回传 exp,让桥发现配置中途被重建");
ok(/body\.lim = SYNC_LIM_BYTES/.test(pullBody), "分片带上 lim 字节预算");
ok(/body\.fp = localFp \|\| ""|fp: localFp \|\| ""/.test(pullBody),
  "fp 恒为客户端本地指纹(握手与分片一致,桥才能算出同一份载荷)");

// ---------- ④ 三个函数不再走死通道 ----------
console.log("--- 不再依赖已死的 HTTP 通道 ---");
const gnStart = lc.indexOf("function syncGameNames(callback)");
const gnBlock = gnStart >= 0 ? lc.slice(gnStart, gnStart + 3000) : "";
const qcStart = lc.indexOf("function syncQuickChat(callback)");
const qcEnd = lc.indexOf("function leftoverEnglish(text)");
const qcBlock = qcStart >= 0 ? lc.slice(qcStart, qcEnd > qcStart ? qcEnd : qcStart + 4000) : "";
ok(gnStart >= 0 && !/httpGetJson/.test(gnBlock), "syncGameNames 不再用 httpGetJson($.AsyncWebRequest 已死)");
ok(qcStart >= 0 && !/httpGetJson/.test(qcBlock), "syncQuickChat 不再用 httpGetJson");
ok(/syncViaBtipc\(\s*\n\s*"gamenames"/.test(lc), "syncGameNames 走 syncViaBtipc");
ok(/syncViaBtipc\(\s*\n\s*"quickchat"/.test(lc), "syncQuickChat 走 syncViaBtipc");
ok(/function applyNamesPayload\(text, res\)/.test(lc), "applyNamesPayload 存在(delta 与全量共用)");
ok(/State\.gamenamesMap = map;/.test(lc), "名单副本留存(delta 施加基准)");

// ---------- ⑤ 打包基线 ----------
console.log("--- 打包基线(缺了玩家侧只能全量) ---");
const pairsPath = path.join(ROOT, "mod", "panorama", "scripts", "lingua_chat_gamenames_pairs_fallback.js");
ok(fs.existsSync(pairsPath), "lingua_chat_gamenames_pairs_fallback.js 已生成");
if (fs.existsSync(pairsPath)) {
  const src = fs.readFileSync(pairsPath, "utf8");
  ok(/LCT_GAMENAMES_PAIRS_FP = "fnv1a-[0-9a-f]{8}";/.test(src), "烘焙了指纹 LCT_GAMENAMES_PAIRS_FP");
  ok(/LCT_GAMENAMES_PAIRS = \{/.test(src), "烘焙了配对名单 LCT_GAMENAMES_PAIRS");
}
for (const xml of ["chat.xml", "hudchat.xml"]) {
  const p = path.join(ROOT, "mod", "panorama", "layout", xml);
  if (!fs.existsSync(p)) { skip(xml); continue; }
  const s = fs.readFileSync(p, "utf8");
  ok(/lingua_chat_gamenames_pairs_fallback\.vjs_c/.test(s), xml + " include 配对名单");
  const iPairs = s.indexOf("lingua_chat_gamenames_pairs_fallback.vjs_c");
  const iMain = s.indexOf("scripts/lingua_chat.vjs_c");
  ok(iPairs > 0 && iMain > iPairs, xml + " 配对名单先于 lingua_chat 加载");
}
if (fs.existsSync(PKG)) {
  const pkg = fs.readFileSync(PKG, "utf8");
  ok(/"sync_data\.js"/.test(pkg), "package_release 必需 core 清单含 sync_data.js");
  ok(/lingua_chat_gamenames_pairs_fallback\.js/.test(pkg) && /lingua_chat_quickchat_fallback\.js/.test(pkg),
    "package_release 随包带两份差分基线");
} else {
  skip("package_release.ps1");
}

// ---------- ⑥ 冻结面没被动 ----------
console.log("--- 冻结面(core/btipc 协议不许动) ---");
if (fs.existsSync(TRANSPORT)) {
  const t = fs.readFileSync(TRANSPORT, "utf8");
  ok(/config\s*\|\s*test/.test(t) || /"config".*"test"/.test(t),
    "TRQ 信封白名单仍是 op=config|test(新语义靠 body,不靠 op 名)");
} else {
  skip("core/btipc/transport.js");
}
ok(/require\("\.\/sync_data\.js"\)/.test(bridge), "bridge 引入 sync_data");
ok(/\.\/sync_data\.js"\]/.test(bridge), "sync_data 进入模块完整性自检(_m 列表缺了就起不来)");

// ---------- ⑦ 启动即装配 ----------
console.log("--- 启动装配 ---");
ok(/function initBakedGameNames\(\)/.test(lc), "initBakedGameNames 已定义");
ok(/initBakedGameNames\(\); \/\/ btipc07/.test(lc), "boot() 调用 initBakedGameNames");
ok(/State\.gamenamesFp = LCT_GAMENAMES_PAIRS_FP;/.test(lc), "本地指纹取自烘焙值(握手用)");
ok(/gamenamesFp: null/.test(lc), "State.gamenamesFp 已声明");

// ---------- ⑧ 2026-10-04 07:00 实车复盘的两处修补 ----------
console.log("--- 实车复盘:配置同步防重入 + 零传输留痕 ---");
// 实车当晚 boot() 与 onBridgeAlive() 各起一个 config 同步循环,单槽队列被白占 85s,
// 把 gamenames/quickchat 握手挤到 07:01:27 才开始。
ok(/if \(State\.cfgSyncing\) \{/.test(lc), "syncBridgeConfig 在途时直接返回(不并行第二个循环)");
ok(/State\.cfgSyncWaiters\.push\(callback\)/.test(lc), "在途时把 callback 挂到等待列,不丢事件");
ok(/State\.cfgSyncing = true;\s*\n\s*let attempts = 0;/.test(lc), "cfgSyncing 由 syncBridgeConfig 自管(boot 未置位也不漏)");
ok(!/State\.cfgSyncing = true;\s*\n\s*syncBridgeConfig/.test(lc), "onBridgeAlive 不再手动置 cfgSyncing(会与自管打架)");
ok(/State\.cfgSyncing = false;\s*\n\s*if \(callback\) callback\(\);/.test(lc), "finish() 统一复位并回调等待列");
// 零传输是常态路径,不落日志就只能靠桥端 out=110B 反推(实车当时就是这么确认的)
ok(/gamenames sync: fingerprint match, no transfer/.test(lc), "gamenames 零传输成功有日志");
ok(/quickchat sync: fingerprint match, no transfer/.test(lc), "quickchat 零传输成功有日志");
ok(/gamenames sync applied: /.test(lc), "gamenames 有数据时有 applied 日志(delta/full)");
ok(/quickchat templates /.test(lc), "quickchat 有数据时有 adopted 日志");

// ---------- ⑨ 缺陷 A(2026-10-04 07:23 实车):死线必须 Date.now() 锚定 ----------
// 实测 config 首读 msg=REQ_TIMEOUT 50000ms 却 dt=20278ms —— 单发 $.Schedule(50)
// 在「加载进对局」的窗口里 21 秒就触发,把本该成功的读打死(白烧一次,配置就绪 48s)。
console.log("--- 缺陷 A:BTIPC 死线不许再用单发 $.Schedule(大 N) ---");
ok(/function afterRealMs\(/.test(lc), "存在 Date.now() 锚定的 afterRealMs");
ok(/nowMs\(\) >= at/.test(lc), "到点判定用 nowMs(),不是调度时长");
ok(/BTIPC_DEADLINE_POLL_SEC/.test(lc), "轮询步长常量存在");
ok(!/\$\.Schedule\(timeoutMs \/ 1000,/.test(lc), "请求死线不再单发 $.Schedule(timeoutMs/1000)");
ok(!/\$\.Schedule\(\(timeoutMs \+ 2000\) \/ 1000,/.test(lc), "deadman 不再单发(否则比死线长却更早触发,等于 A 换地方复发)");
ok(/afterRealMs\(timeoutMs, function/.test(lc), "请求死线已接线到 afterRealMs");
ok(/afterRealMs\(timeoutMs \+ 2000, function/.test(lc), "deadman 已接线到 afterRealMs");
ok(/return State\.btipcActive === st/.test(lc), "死线 alive 守卫等价于旧的 btipcActive !== st");
ok(/alive && !alive\(\)/.test(lc), "afterRealMs 支持 alive 提前停轮询");

console.log("RESULT: PASS " + pass + " / FAIL " + fail + " / SKIP " + skipped);
process.exit(fail > 0 ? 1 : 0);
