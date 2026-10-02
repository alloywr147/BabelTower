// Contributor: Thirt927 (https://github.com/Thirt927/BabelTower), merged 2026-08-13 under GPL-3.0
// Babel Tower - 本地翻译桥服务器
//
// 职责(只做翻译相关的事,不做通用代理):
//   1. 为游戏内隐藏 HTML 面板提供桥页面(/bridge)
//      - 页面在同源下调用 /api/v1/* ,再把结果写回 document.title 供 Panorama 轮询读取
//   2. 提供受限 API:
//      - POST /api/v1/translate  翻译一段文本
//      - POST /api/v1/test       用当前配置测试连通性
//      - GET  /api/v1/config     读取配置(apiKey 打码)
//      - POST /api/v1/config     保存配置(支持打码回传)
//      - GET  /api/v1/health     健康检查
//
// 安全原则:
//   - 只监听 127.0.0.1,不对外暴露
//   - 没有任意 URL 代理能力(与通用 /proxy 方案不同)
//   - Provider 请求目标由配置/代码限定(allowlist 思路)
//   - 请求体大小限制 64KB
//   - 日志不输出 apiKey
//
// 用法: node bridge_server.js   (默认端口 8791,可用 config.json 修改)
"use strict";

// ---------- 启动期崩溃兜底(必须最先注册) ----------
// 2026-09-20 教训: require 阶段崩溃(发布包漏 loc_parser.js/quickchat.js)发生在本文件
// 剩余部分执行之前,console 输出随窗口关闭消失,用户侧表现为"窗口开几秒就挂"且无日志。
// 兜底必须落盘到 logs/bridge.log,让用户能拿到可反馈的错误现场。
const _crashFs = require("fs");
const _crashPath = require("path");
function _crashLogFilePath() {
  return _crashPath.join(__dirname, "..", "logs", "bridge.log");
}
function writeCrashLog(kind, err) {
  try {
    const logPath = _crashLogFilePath();
    _crashFs.mkdirSync(_crashPath.dirname(logPath), { recursive: true });
    const stamp = new Date().toString();
    _crashFs.appendFileSync(
      logPath,
      "[" + stamp + "] [crash] " + kind + ": " + (err && err.stack ? err.stack : String(err)) + "\n",
      "utf8"
    );
  } catch (e) {
    // 日志都写不进去时(磁盘/权限)只能放弃,不能因此再抛
  }
}
process.on("uncaughtException", function (err) {
  writeCrashLog("uncaughtException", err);
  console.error("[LCT] 发生未捕获错误,日志已写入 logs\\bridge.log,请将该文件反馈给开发者。");
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
process.on("unhandledRejection", function (err) {
  writeCrashLog("unhandledRejection", err);
});

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
// 打包/安装完整性自检: 缺任一必需内部模块立即给出可读错误并退出,
// 避免 "Cannot find module" 原始堆栈吓用户(且现在的 uncaughtException 会把堆栈落盘)。
for (const _m of ["./config", "./providers/registry", "./dictionary", "./name_protect", "./quickchat", "./loc_parser.js"]) {
  try { require(_m); } catch (e) {
    console.error("[LCT] 安装不完整: 加载 " + _m + " 失败。请重新解压完整安装包,不要手动删除 core 内任何文件。");
    writeCrashLog("module-load-failed", e);
    process.exit(1);
  }
}

const configStore = require("./config");
const providerRegistry = require("./providers/registry");
const dictionary = require("./dictionary");
const nameProtect = require("./name_protect");
const quickchat = require("./quickchat");
// ---------- BTIPC v1(规格 docs/btipc-v1.md)----------
// 窗口表(§6 状态机/§14.2 隔离)+ console.log tail 的 REQ/TRQ/CAN 解析(§14.1 校验,非法静默 drop 只记 WARN)。
// 两条传输路径完全分离,共用同一套帧/窗口/重试核心:
//   REQ(③/⑤)回声 conformance —— 同步 setFrames(原文),/bt6736 走这条,不碰翻译 API。
//   TRQ(⑥)翻译            —— 先建窗(frames=null → BUSY),翻译完成后异步 setFrames。
// 翻译层只见 BTIPC 的 window/frames,不见 Image panel、200/404、round、CRC、STORM。
const btipcWin = require("./btipc/window.js");
const btipcXfer = require("./btipc/transport.js");
const btipcFramer = require("./btipc/framer.js");
const btipcTable = new btipcWin.WindowTable();

// 翻译失败时的信号:空 END 帧(len=0)。协议零改动(§3 无新位段),客户端 translate 模式下
// 收到空串即判定 translate_error。回声模式不做此判定 —— "" 是合法回声。
const btipcTrqInflight = new Set();

function onBtipcGameLine(line) {
  const parsed = btipcXfer.parseGameLine(line);
  if (!parsed.ok) {
    if (parsed.skip) return; // 普通 [LCT] 行,与 BTIPC 无关
    log("warn", "BTIPC drop (" + parsed.reason + ")"); // §14.1:静默 drop + 一行 WARN
    return;
  }
  if (parsed.cmd === "REQ") {
    const tr = btipcTable.acceptReq(parsed.win, parsed.id, parsed.payload);
    try {
      tr.frames = btipcFramer.encode(parsed.id, parsed.payload);
      log("info", "BTIPC REQ w=" + parsed.win + " id=" + parsed.id + " len=" + parsed.len + " echo frames=" + tr.frames.length);
    } catch (e) {
      log("warn", "BTIPC encode failed: " + e.message);
    }
  } else if (parsed.cmd === "TRQ") {
    onBtipcTranslateReq(parsed);
  } else if (parsed.cmd === "CAN") {
    btipcTrqInflight.delete(parsed.win);
    btipcTable.cancel(parsed.win);
    log("info", "BTIPC CAN w=" + parsed.win);
  }
}

// ⑥ 翻译请求:窗口先存在(frames=null → 客户端拿 BUSY),数据帧后填充。
// 翻译耗时(100ms~8s/超时)完全落在窗口等待期,不污染 BTIPC 传输状态机。
async function onBtipcTranslateReq(parsed) {
  const win = parsed.win;
  const text = parsed.payload.toString("utf8");
  const tReq = Date.now();
  // acceptReq 建窗;frames 保持 null → serveDL 返 BUSY。setFrames 失败(窗口已 GC)时静默丢弃。
  const tr = btipcTable.acceptReq(win, parsed.id, parsed.payload);
  tr.translate = true;
  btipcTrqInflight.add(win);
  log("info", "BTIPC TRQ w=" + win + " id=" + parsed.id + " len=" + parsed.len +
      " text=" + JSON.stringify(text.slice(0, 60)) + " (BUSY until translated)");

  let out = null;
  let errMsg = null;
  try {
    const cfg = configStore.load();
    const result = await runTranslate(cfg, { text: text });
    out = String(result.translation == null ? "" : result.translation);
    // 缓存非词典命中结果 + 自适应学习(与 /api/v1/translate 同语义)
    if (result && !result.viaDictionary && !result.viaCache) {
      const tl = cfg.defaults.targetLanguage || "zh-Hans";
      transCacheSet(result._protectedText || text, tl, result.translation, result.detectedLanguage);
      dictionary.record(result._protectedText || text, tl, result.translation, result.detectedLanguage);
    }
  } catch (e) {
    errMsg = (e && e.message) || String(e);
  }

  btipcTrqInflight.delete(win);
  const dt = Date.now() - tReq;
  let frames;
  try {
    // 失败也 setFrames:空 END 帧让客户端走到 Promise 结算,而不是耗到 REQ_TIMEOUT。
    frames = btipcFramer.encode(parsed.id, out == null ? "" : out);
  } catch (e) {
    log("warn", "BTIPC TRQ encode failed w=" + win + ": " + e.message);
    return; // 留在 BUSY,由客户端 REQ_TIMEOUT 兜底
  }
  if (!btipcTable.setFrames(win, frames)) {
    log("info", "BTIPC TRQ w=" + win + " dropped: window gone (GC/CAN)");
    return;
  }
  if (errMsg !== null) {
    log("warn", "BTIPC TRQ w=" + win + " translate failed after " + dt + "ms: " + errMsg.slice(0, 120) +
        " -> empty END frame (client rejects as translate_error)");
  } else {
    log("info", "BTIPC TRQ w=" + win + " ok dt=" + dt + "ms out=" + out.length + "B frames=" + frames.length);
  }
}

// 窗口 GC(§6):END 帧服务后 10s,或 60s 无活动
setInterval(function () {
  const n = btipcTable.gc();
  if (n > 0) log("info", "BTIPC GC removed=" + n + " remain=" + btipcTable.size());
}, 10000);
// 首次运行生成词典文件;桥启动后自动落盘高频词(自适应学习)
// (顶部 for 循环已逐个 require 过五个模块,这里直接拿句柄用,不重复 require)
dictionary.ensureFile();
dictionary.startAutoFlush();
nameProtect.load();
nameProtect.watchLocalization();
// 快捷语音模板:启动时从游戏本地化生成(失败不阻塞桥启动,客户端用兑底语料)
// 2026-09-17 v3:原始模板字典(免正则),客户端 token 走查匹配
try {
  const qcBuilt = quickchat.build();
  if (qcBuilt.ok) {
    // 唯一写入口 core/quickchat.js writeBridgeConfig(fingerprint 随写随传,漏写 = 客户端握手永远告警)
    const qcPath = quickchat.writeBridgeConfig(qcBuilt);
    console.log("[quickchat] templates generated:", qcBuilt.count, "keys, fingerprint:", qcBuilt.fingerprint);
  } else {
    console.log("[quickchat] templates build failed (client fallback in effect):", qcBuilt.error);
  }
} catch (e) {
  console.log("[quickchat] templates build error (non-fatal):", e.message);
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 4000; // 单条聊天文本长度上限

// ---------- 翻译结果缓存(同文本二次秒回,避免重复走 Bing) ----------
// 聊天场景重复度高(gg/glhf/thanks 等高频短语),缓存命中直接返回,零网络开销。
const TRANS_CACHE_LIMIT = 1000;
const TRANS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟,覆盖多局短时间内的重复聊天
const transCache = new Map(); // key: text + target -> { translation, detectedLanguage, ts }

function cacheKey(text, target) {
  const normalizedText = String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
  return normalizedText.slice(0, 200) + "\x00" + String(target || "").toLowerCase();
}

function transCacheGet(text, target) {
  const key = cacheKey(text, target);
  const hit = transCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TRANS_CACHE_TTL_MS) {
    transCache.delete(key);
    return null;
  }
  return hit;
}

function transCacheSet(text, target, translation, detectedLanguage) {
  if (transCache.size >= TRANS_CACHE_LIMIT) {
    const oldestKey = transCache.keys().next().value;
    if (oldestKey !== undefined) transCache.delete(oldestKey);
  }
  transCache.set(cacheKey(text, target), {
    translation: translation,
    detectedLanguage: detectedLanguage,
    ts: Date.now(),
  });
}

// ---------- 日志(可选落盘,绝不含 apiKey) ----------
let activeConfig = null;

// 本地时间戳(2026-09-17:由 UTC toISOString 改为本地时区。
// UTC 时间戳比文件时间慢 8 小时,排查问题时会误判日志时段)
function pad2(n) { return n < 10 ? "0" + n : String(n); }
function localTimestamp() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function log(level, msg) {
  const ts = localTimestamp();
  const line = "[" + ts + "] [" + level + "] " + msg;
  // 任何日志都不允许包含 apiKey;调用方自行保证
  console.log(line);
  try {
    if (activeConfig && activeConfig.logFile) {
      fs.appendFileSync(path.resolve(__dirname, "..", activeConfig.logFile), line + "\n", "utf8");
    }
  } catch (e) {}
}

// ---------- 进程监视:记录游戏开关状态;桥常驻,不随游戏退出 ----------
// 2026-08-12 修复(0.1.3-beta.5):原逻辑游戏退出后 process.exit(0) 自杀,
// 导致"关游戏再开就没桥"。改为常驻:游戏退出后桥保持运行,下次游戏启动直接可用。
// 2026-08-13 合并 Thirt927 贡献:tasklist 偶发失败/空输出跳过本轮;
// 游戏"消失"需连续确认 WATCH_CONFIRM_MISSES 次(约 6 秒)才判定退出(仍不自杀)。
const WATCH_INTERVAL_MS = 2000;
const WATCH_CONFIRM_MISSES = 3;
let gameProcessSeen = false;
let watchMissCount = 0;
let watchTimer = null;

function checkGameProcess() {
  const gameExe = String((activeConfig && activeConfig.watchGameExe) || "deadlock.exe").toLowerCase();
  execFile(
    "tasklist",
    ["/FI", "IMAGENAME eq " + gameExe, "/FO", "CSV", "/NH"],
    { windowsHide: true },
    function (err, stdout) {
      if (err) {
        // tasklist 执行失败(系统繁忙/被杀软拦截):跳过本轮,不改变状态,避免误判
        if (!process.exitCode) watchTimer = setTimeout(checkGameProcess, WATCH_INTERVAL_MS);
        return;
      }
      const running = String(stdout || "").toLowerCase().indexOf(gameExe) !== -1;
      if (running) {
        if (!gameProcessSeen) {
          log("info", "检测到 " + gameExe + " 运行,监视其退出(需连续 " + WATCH_CONFIRM_MISSES + " 次未检测到才记录退出)");
        }
        gameProcessSeen = true;
        watchMissCount = 0;
      } else if (gameProcessSeen) {
        watchMissCount += 1;
        if (watchMissCount >= WATCH_CONFIRM_MISSES) {
          // 桥常驻:游戏退出后桥保持运行,等待下次游戏启动
          log("info", gameExe + " 已退出,桥保持运行(等待下次游戏启动)");
          gameProcessSeen = false;
          watchMissCount = 0;
        } else {
          log("info", "未检测到 " + gameExe + " (" + watchMissCount + "/" + WATCH_CONFIRM_MISSES + "),等待确认...");
        }
      }
      if (!process.exitCode) watchTimer = setTimeout(checkGameProcess, WATCH_INTERVAL_MS);
    }
  );
}

function startGameWatch() {
  if (process.argv.indexOf("--no-watch") !== -1) return;
  if (activeConfig && activeConfig.watchGame === false) return;
  checkGameProcess();
}

// ---------- GitHub 新版本检测 ----------
// 启动时不阻塞、异步请求 GitHub releases/latest,与本地 VERSION 比较。
// 仅使用 Node 内置 https 模块;任何失败都降级为"无更新"而非抛错。
// GitHub 对未带 User-Agent 的请求返回 403,故必须设置。
const GITHUB_API_URL = "https://api.github.com/repos/c1375rick/BabelTower/releases/latest";
const GITHUB_REPO_URL = "https://github.com/c1375rick/BabelTower";
const VERSION_CHECK_TIMEOUT_MS = 5000;

// 语义化版本比较:返回 -1(a<b) / 0(相等) / 1(a>b)
// 处理 v 前缀、beta 后缀(1.0.0-beta.2 > 1.0.0-beta > 1.0.0)
function compareVersions(a, b) {
  const strip = (s) => String(s || "").replace(/^v/i, "");
  const pa = strip(a).split(".");
  const pb = strip(b).split(".");
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i++) {
    const na = pa[i] || "0";
    const nb = pb[i] || "0";
    const da = parseInt(na, 10);
    const db = parseInt(nb, 10);
    if (!isNaN(da) && !isNaN(db)) {
      if (da !== db) return da < db ? -1 : 1;
    } else {
      const cmp = na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
    }
  }
  return 0;
}

function readLocalVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  } catch (e) {
    return null;
  }
}

// 请求 GitHub releases/latest;成功返回 { ok:true, latestVersion, releaseUrl },失败返回 { ok:false, error }
function fetchGitHubRelease() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = https.get(
        GITHUB_API_URL,
        {
          headers: {
            "User-Agent": "BabelTower/1.0",
            "Accept": "application/vnd.github+json",
          },
          timeout: VERSION_CHECK_TIMEOUT_MS,
        },
        (resp) => {
          let data = "";
          resp.setEncoding("utf8");
          resp.on("data", (c) => { data += c; });
          resp.on("end", () => {
            try {
              if (resp.statusCode !== 200) {
                finish({ ok: false, error: "github_api_status_" + resp.statusCode });
                return;
              }
              const json = JSON.parse(data);
              const tag = json.tag_name;
              if (!tag) {
                finish({ ok: false, error: "no_tag_in_response" });
                return;
              }
              finish({
                ok: true,
                latestVersion: String(tag).replace(/^v/i, ""),
                releaseUrl: json.html_url || (GITHUB_REPO_URL + "/releases/" + tag),
              });
            } catch (e) {
              finish({ ok: false, error: "parse_error: " + (e && e.message ? e.message : String(e)) });
            }
          });
        }
      );
    } catch (e) {
      finish({ ok: false, error: (e && e.message ? e.message : String(e)) });
      return;
    }
    req.on("timeout", () => {
      try { req.destroy(new Error("timeout")); } catch (e) {}
      finish({ ok: false, error: "request_timeout" });
    });
    req.on("error", (e) => {
      finish({ ok: false, error: (e && e.message ? e.message : String(e)) });
    });
  });
}

// 汇总:返回 version-check 端点与启动检测共用的结果对象
async function doVersionCheck() {
  const currentVersion = readLocalVersion();
  const gh = await fetchGitHubRelease();
  if (!gh.ok) {
    return { ok: true, currentVersion: currentVersion, hasUpdate: false, error: gh.error };
  }
  const latest = gh.latestVersion;
  return {
    ok: true,
    currentVersion: currentVersion,
    latestVersion: latest,
    hasUpdate: !!currentVersion && !!latest && compareVersions(latest, currentVersion) > 0,
    releaseUrl: gh.releaseUrl,
  };
}

// 缓存版本检测结果:health 端点直接返回,不每次查 GitHub
let cachedVersionInfo = null;
const VERSION_CHECK_REFRESH_MS = 30 * 60 * 1000; // 30 分钟刷新一次

function refreshVersionCache() {
  doVersionCheck()
    .then((r) => {
      cachedVersionInfo = r;
      if (r && r.ok && r.hasUpdate) {
        log("info", "发现新版本: " + r.currentVersion + " -> " + r.latestVersion +
          " (" + (r.releaseUrl || GITHUB_REPO_URL + "/releases") + ")");
      }
    })
    .catch(() => {});
}

// 启动时检测一次,之后每 30 分钟刷新
function startVersionCheckOnBoot() {
  refreshVersionCache();
  setInterval(refreshVersionCache, VERSION_CHECK_REFRESH_MS);
}

// ---------- 请求体解析 ----------
function readBody(req, onDone) {
  let raw = "";
  let size = 0;
  let tooBig = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooBig = true;
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on("end", () => {
    if (tooBig) {
      onDone(new Error("body_too_large"));
      return;
    }
    onDone(null, raw);
  });
  req.on("error", (e) => onDone(e));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (e) {
    return null;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(body);
}

// ---------- 聊天日志(按比赛 ID 划分) ----------
// ---------- 聊天日志轮转与清理 ----------
// 单文件写入上限: 超过则把当前 .jsonl 整体重命名为带时间戳的备份,
// 后续写入落到全新文件(标准日志滚动思路, 不丢任何已写内容)。
const CHAT_LOG_MAX_BYTES = 5 * 1024 * 1024;        // 5MB
const CHAT_LOG_ROTATE_KEEP_DAYS = 7;              // 轮转备份(*.jsonl.rotated)保留 7 天
const CHAT_LOG_CLEANUP_DAYS = 30;                // 启动时清理: 活动日志(*.jsonl)超 30 天删除
const CHAT_LOG_ROTATED_SUFFIX = ".jsonl.rotated"; // 轮转备份后缀(前面再拼时间戳)

// 轮转: 若当前 <matchId>.jsonl 超过 CHAT_LOG_MAX_BYTES, 整体重命名为
// <matchId>.<时间戳>.jsonl.rotated, 后续 appendFileSync 会重新创建空的 .jsonl。
// 已写入的内容全部保留在备份里, 不影响 API 返回值(written=本次写入行数)。
function rotateChatLogIfNeeded(dir, matchId) {
  const file = path.join(dir, matchId + ".jsonl");
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return; } // 文件不存在则无需轮转
  if (!stat.isFile() || stat.size <= CHAT_LOG_MAX_BYTES) return;
  // 时间戳精确到秒并替换文件系统非法字符(: .), 避免同秒多次轮转互相覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rotated = path.join(dir, matchId + "." + stamp + CHAT_LOG_ROTATED_SUFFIX);
  try {
    fs.renameSync(file, rotated);
    log("info", "chat log rotated: " + path.basename(file) + " (" + stat.size + " bytes) -> " + path.basename(rotated));
  } catch (e) {
    // 轮转失败不致命: 下次写入仍会触发, 不影响本次日志记录
    log("warn", "chat log rotate failed: " + (e && e.message ? e.message : String(e)));
  }
}

// 启动清理: 扫描日志目录, 删除超龄文件(只处理聊天日志相关文件, 不碰其他)。
//   活动日志 (*.jsonl)            超 CHAT_LOG_CLEANUP_DAYS   (30) 天 -> 删除
//   轮转备份 (*.jsonl.rotated)    超 CHAT_LOG_ROTATE_KEEP_DAYS (7) 天 -> 删除
function cleanupOldChatLogs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    if (!stat.isFile()) continue;
    let maxAgeDays = 0;
    if (name.endsWith(CHAT_LOG_ROTATED_SUFFIX)) {
      maxAgeDays = CHAT_LOG_ROTATE_KEEP_DAYS;
    } else if (name.endsWith(".jsonl")) {
      maxAgeDays = CHAT_LOG_CLEANUP_DAYS;
    } else {
      continue; // 不碰无关文件
    }
    const ageMs = now - stat.mtimeMs;
    if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
      try {
        fs.unlinkSync(full);
        log("info", "chat log cleaned (>" + maxAgeDays + "d): " + name);
      } catch (e) {
        log("warn", "chat log cleanup failed: " + name + " " + (e && e.message ? e.message : String(e)));
      }
    }
  }
}

function safeMatchId(id) {
  // 只保留字母数字与 - _ . 防止路径穿越
  return String(id || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "unknown";
}

function appendChatLog(cfg, body) {
  const matchId = safeMatchId(body.matchId || (body.lines && body.lines[0] && body.lines[0].matchId) || "");
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return 0;
  const dir = path.resolve(__dirname, "..", String((cfg.chatLog && cfg.chatLog.dir) || "logs/chat"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, matchId + ".jsonl");
  const out = [];
  for (const ln of lines) {
    out.push(JSON.stringify({
      t: String(ln.t || new Date().toISOString()),
      matchId: matchId,
      sender: String(ln.sender || ""),
      hero: String(ln.hero || ""),
      heroId: String(ln.heroId || ""),
      steamid: String(ln.steamid || ""),
      channel: String(ln.channel || ""),
      isOwn: !!ln.isOwn,
      text: String(ln.text || "").slice(0, 2000),
    }));
  }
  fs.appendFileSync(file, out.join("\n") + "\n", "utf8");
  // 写入后检查单文件大小, 超 5MB 则滚动(重命名旧文件为带时间戳备份)
  rotateChatLogIfNeeded(dir, matchId);
  return out.length;
}

// ---------- 翻译执行 ----------
async function runTranslate(cfg, payload) {
  const provider = providerRegistry.getProvider(payload.provider || cfg.provider);
  if (!provider) {
    throw Object.assign(new Error("未知翻译服务商: " + (payload.provider || cfg.provider)), { status: 400 });
  }
  const text = String(payload.text || "").trim();
  if (!text) throw Object.assign(new Error("空文本"), { status: 400 });
  if (text.length > MAX_TEXT_CHARS) throw Object.assign(new Error("文本过长"), { status: 400 });

  // 词典直译优先:短词/常用语不走在线翻译,结果稳定(修复 gg 等短词译文=原文的抖动)
  const dictHit = dictionary.lookup(text, payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans");
  if (dictHit) return dictHit;

  // 英雄/物品名占位符保护:翻译前把游戏专有名词换成 {{GAME_i}},翻译后还原为目标语言译名,
  // 避免被 API 意译/乱译(holliday 等不在客户端硬编码名单里的英雄也能被覆盖)。
  // 数据来自游戏本地化(285 条全量),由 name_protect 监听游戏更新自动刷新。
  const alreadyProtected = /LCTPH\d/.test(text);
  const protected0 = alreadyProtected ? { text: text, nameMap: null } : nameProtect.protect(text);
  const nameMap = protected0.nameMap;
  const textForTranslate = protected0.text;
  const toZh = (payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans").toLowerCase().startsWith("zh");
  const restoreBack = (translation) => nameMap ? nameProtect.restore(translation, nameMap, toZh) : translation;

  // 缓存命中:同文本直接返回上次结果(词典未覆盖的长句/短语重复出现时,零网络延迟)
  const targetLang = payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans";
  const cached = transCacheGet(textForTranslate, targetLang);
  if (cached) {
    log("info", "cache hit: " + String(textForTranslate).slice(0, 60).replace(/\s+/g, " "));
    return { translation: restoreBack(cached.translation), detectedLanguage: cached.detectedLanguage, viaCache: true };
  }

  const providerCfg = (cfg[provider.id] || {});
  const baseOpts = {
    sourceLanguage: payload.sourceLanguage || cfg.defaults.sourceLanguage || "auto",
    targetLanguage: payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans",
    timeoutMs: Number(payload.timeoutMs) || cfg.timeoutMs,
  };
  const errors = [];
  try {
    const result = await provider.translate(textForTranslate, Object.assign({}, baseOpts, {
      apiKey: providerCfg.apiKey,
      region: providerCfg.region,
      endpoint: providerCfg.endpoint,
      baseUrl: providerCfg.baseUrl,
      model: providerCfg.model,
    }));
    return Object.assign(result, { provider: provider.id, translation: restoreBack(result.translation), _protectedText: textForTranslate });
  } catch (e) {
    errors.push(provider.id + ": " + (e && e.message ? e.message : String(e)));
  }

  // 回退链:按配置依次尝试备用服务商(只尝试已配置 Key 的,避免连环失败浪费时间)
  const fallbacks = Array.isArray(cfg.fallbackProviders) ? cfg.fallbackProviders : [];
  for (const pid of fallbacks) {
    if (pid === provider.id) continue;
    const fb = providerRegistry.getProvider(pid);
    if (!fb) continue;
    const fc = (cfg[pid] || {});
    // 需要 Key 的服务商没配 Key 就跳过
    if (pid !== "bing" && !fc.apiKey) continue;
    try {
      const fbResult = await fb.translate(text, Object.assign({}, baseOpts, {
        apiKey: fc.apiKey,
        region: fc.region,
        endpoint: fc.endpoint,
        baseUrl: fc.baseUrl,
        model: fc.model,
      }));
      log("info", "fallback -> " + pid + " (primary " + provider.id + " failed: " + (errors[0] || "").slice(0, 80) + ")");
      return Object.assign(fbResult, { provider: pid, viaFallback: true, translation: restoreBack(fbResult.translation), _protectedText: textForTranslate });
    } catch (e2) {
      errors.push(pid + ": " + (e2 && e2.message ? e2.message : String(e2)));
    }
  }

  const last = new Error(errors.join(" | "));
  last.status = 502;
  throw last;
}

// ---------- 桥页面(供游戏内隐藏 HTML 面板加载) ----------
function bridgePage(query) {
  const id = String(query.get("id") || "x");
  const op = String(query.get("op") || "translate");
  const safeId = JSON.stringify(id);

  // 页面 JS:同源调用受限 API,结果写回 document.title(前缀 LCT + 请求 id)。
  // Panorama 侧轮询 panel.title 读取,按 id 前缀匹配响应。
  return [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>lct-bridge</title></head><body>",
    "<script>",
    "(function(){",
    "var id=" + safeId + ";",
    "var q=new URLSearchParams(location.search);",
    "var op='" + String(op).replace(/[^a-z]/g, "") + "';",
    "var done=false;",
    "function out(p){var s='LCT'+id+JSON.stringify(p);",
    "try{document.title=s;}catch(e){}",
    "try{location.hash='#'+encodeURIComponent(s);}catch(e){}",
    "}",
    "try{document.title='lct-alive';}catch(e){}",
    "var t=Math.max(Number(q.get('timeoutMs'))||8000,8000);",
    "setTimeout(function(){if(!done){done=true;out({ok:false,error:'bridge_timeout'});}},t);",
    "var req={operation:op,text:q.get('text')||'',sourceLanguage:q.get('source')||'auto',targetLanguage:q.get('target')||'zh-Hans',timeoutMs:Number(q.get('timeoutMs'))||undefined};",
    "var d=q.get('d');if(d){try{req=JSON.parse(d);}catch(e){}}",
    "var path='/api/v1/'+(op==='translate'?'translate':op);",
    "var fetchOpts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req)};",
    "if(op==='health'){fetchOpts={method:'GET'};}",
    "fetch(path,fetchOpts)",
    ".then(function(r){return r.json();})",
    ".then(function(j){if(done)return;done=true;out(j);})",
    ".catch(function(e){if(done)return;done=true;out({ok:false,error:String(e)});});",
    "})();",
    "</script></body></html>",
  ].join("");
}

// ---------- API 路由 ----------
// GET 兼容:游戏侧 $.AsyncWebRequest 只能发 GET,请求体通过 ?d=<JSON> 传递;
// 无 d 时 translate/test 用 query 参数(text/source/target/provider)构造。
function bodyFromRequest(url, bodyObj) {
  if (bodyObj) return bodyObj;
  const d = url.searchParams.get("d");
  if (d) {
    try { return JSON.parse(d); } catch (e) {}
  }
  if (url.pathname === "/api/v1/translate") {
    return {
      text: url.searchParams.get("text") || "",
      sourceLanguage: url.searchParams.get("source") || "auto",
      targetLanguage: url.searchParams.get("target") || "zh-Hans",
      provider: url.searchParams.get("provider") || undefined,
      timeoutMs: Number(url.searchParams.get("timeoutMs")) || undefined,
    };
  }
  return null;
}

async function handleApi(req, res, url, bodyObj) {
  const p = url.pathname;

  if (p === "/api/v1/log" && (req.method === "POST" || req.method === "GET")) {
    bodyObj = bodyFromRequest(url, bodyObj);
    if (!bodyObj) return sendJson(res, 400, { ok: false, error: "bad_json" });
    const cfgL = configStore.load();
    if (!(cfgL.chatLog && cfgL.chatLog.enabled)) return sendJson(res, 200, { ok: true, skipped: "chat_log_disabled" });
    try {
      const n = appendChatLog(cfgL, bodyObj);
      sendJson(res, 200, { ok: true, written: n });
    } catch (e) {
      log("warn", "chat log write failed: " + (e && e.message ? e.message : String(e)));
      sendJson(res, 500, { ok: false, error: "chat_log_write_failed" });
    }
    return;
  }

  if (p === "/api/v1/health") {
    const cfgH = configStore.load();
    const healthResp = {
      ok: true,
      name: "Babel Tower Bridge",
      version: readLocalVersion() || "unknown",
      provider: cfgH.provider,
      providers: providerRegistry.listProviders(),
      fallbackProviders: Array.isArray(cfgH.fallbackProviders) ? cfgH.fallbackProviders : [],
      chatLog: Object.assign({ enabled: true, dir: "logs/chat" }, cfgH.chatLog || {}),
    };
    // 有缓存的版本检测结果时附带更新信息(游戏面板据此显示更新提示)
    if (cachedVersionInfo && cachedVersionInfo.ok && cachedVersionInfo.hasUpdate) {
      healthResp.updateInfo = {
        hasUpdate: true,
        currentVersion: cachedVersionInfo.currentVersion,
        latestVersion: cachedVersionInfo.latestVersion,
        releaseUrl: cachedVersionInfo.releaseUrl || GITHUB_REPO_URL + "/releases",
      };
    }
    sendJson(res, 200, healthResp);
    return;
  }

  if (p === "/api/v1/gamenames") {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const gamenamesPath = path.join(__dirname, "..", "config", "gamenames.json");
    try {
      const data = JSON.parse(fs.readFileSync(gamenamesPath, "utf8"));
      sendJson(res, 200, { ok: true, count: Object.keys(data).length, names: data });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: "gamenames_not_found" });
    }
    return;
  }

  if (p === "/api/v1/quickchat") {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const quickchatPath = path.join(__dirname, "..", "config", "quickchat.json");
    try {
      const data = JSON.parse(fs.readFileSync(quickchatPath, "utf8"));
      // v3(2026-09-17): 原始模板数组(免正则,客户端分段比对);兼容读取旧 v2 patterns 字段
      let templates = [];
      if (Array.isArray(data.templates)) {
        templates = data.templates;
      } else if (data.templates && typeof data.templates === "object") {
        for (const k of Object.keys(data.templates)) {
          for (const t of data.templates[k]) templates.push(t);
        }
      } else if (Array.isArray(data.patterns)) {
        templates = data.patterns; // 旧版桥配置尚持 v2 时,发正则串无意义,但不至于报错
      }
      // fingerprint(内容指纹)透传:客户端 syncQuickChat 与兑底指纹比对,防"模板变了 version 忘 bump"
      sendJson(res, 200, { ok: true, version: data.version || 3, fingerprint: data.fingerprint || null, count: templates.length, templates: templates });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: "quickchat_not_found" });
    }
    return;
  }

  if (p === "/api/v1/translate" && (req.method === "POST" || req.method === "GET")) {
    bodyObj = bodyFromRequest(url, bodyObj);
    if (!bodyObj || !String(bodyObj.text || "").trim()) return sendJson(res, 400, { ok: false, error: "bad_json" });
    const cfg = configStore.load();
    try {
      const result = await runTranslate(cfg, bodyObj);
      // 缓存非词典命中结果(词典结果本身零延迟,无需缓存;缓存命中已直接返回)
      if (result && !result.viaDictionary && !result.viaCache) {
        transCacheSet(
          result._protectedText || String(bodyObj.text || "").trim(),
          bodyObj.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans",
          result.translation,
          result.detectedLanguage
        );
      }
      // 自适应学习:每次成功翻译都记录(含缓存命中——缓存命中同样是"该文本又出现一次"),
      // 高频词(同一译文 >= 3 次)自动固化进词典。词典内部会跳过已在表内的词。
      if (result && !result.viaDictionary) {
        dictionary.record(
          String(bodyObj.text || "").trim(),
          bodyObj.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans",
          result.translation,
          result.detectedLanguage
        );
      }
      log("info", "translate ok: " + String(bodyObj.text || "").slice(0, 60).replace(/\s+/g, " ") + " [target=" + (bodyObj.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans") + "]");
      sendJson(res, 200, {
        ok: true,
        translation: result.translation,
        detectedLanguage: result.detectedLanguage,
      });
    } catch (e) {
      log("warn", "translate failed: " + (e && e.message ? e.message : String(e)));
      sendJson(res, e && e.status ? e.status : 502, { ok: false, error: (e && e.message) || "unknown_error" });
    }
    return;
  }

  if (p === "/api/v1/test" && (req.method === "POST" || req.method === "GET")) {
    const cfg = configStore.load();
    const tBody = bodyFromRequest(url, bodyObj);
    try {
      const result = await runTranslate(cfg, {
        text: (tBody && tBody.text) || "hello",
        targetLanguage: (tBody && tBody.targetLanguage) || "zh-Hans",
        sourceLanguage: (tBody && tBody.sourceLanguage) || "auto",
      });
      log("info", "test ok");
      sendJson(res, 200, { ok: true, translation: result.translation, message: "连接成功" });
    } catch (e) {
      log("warn", "test failed: " + (e && e.message ? e.message : String(e)));
      sendJson(res, 200, { ok: false, error: (e && e.message) || "unknown_error" });
    }
    return;
  }

  if (p === "/api/v1/config") {
    if (req.method === "GET") {
      // GET + d 参数:游戏侧 AsyncWebRequest 保存配置(读配置保持无 d)
      const d = url.searchParams.get("d");
      if (d) {
        let saveBody = null;
        try { saveBody = JSON.parse(d); } catch (e) {}
        if (saveBody && saveBody.config) {
          const current = configStore.load();
          const next = configStore.applyMaskedUpdate(current, saveBody.config || {});
          configStore.save(next);
          log("info", "config saved (GET)");
          // 保存响应最小化:游戏侧只读 res.ok;但保持带精简 config 以兼容加载分支
          sendJson(res, 200, { ok: true, config: configStore.maskCompact(next) });
          return;
        }
      }
      // 读取用精简 mask:完整 mask 约 700 字符会超出 title 通道(约 512)上限,
      // 导致游戏侧 JSON 解析失败(2026-08-14 保存失效根因)
      sendJson(res, 200, { ok: true, config: configStore.maskCompact(configStore.load()) });
      return;
    }
    if (req.method === "POST") {
      if (!bodyObj) return sendJson(res, 400, { ok: false, error: "bad_json" });
      const current = configStore.load();
      const next = configStore.applyMaskedUpdate(current, bodyObj.config || {});
      configStore.save(next);
      // body 带 config = 保存;不带 = 加载(面板通道下两者都走 POST)。
      // 统一回精简 config(约 366 字符,远低于 title 通道 ~512 上限;2026-08-14 保存失效根因)
      if (bodyObj.config) log("info", "config saved");
      sendJson(res, 200, { ok: true, config: configStore.maskCompact(next) });
      return;
    }
  }

  if (p === "/api/v1/version-check") {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    doVersionCheck()
      .then((r) => sendJson(res, 200, r))
      .catch((e) => sendJson(res, 200, {
        ok: true,
        currentVersion: readLocalVersion(),
        hasUpdate: false,
        error: (e && e.message ? e.message : String(e)),
      }));
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

// ---------- 服务器(双回环监听) ----------
// 同一个请求处理器创建两个 http.Server:一个绑 IPv4 回环(127.0.0.1),一个绑 IPv6 回环(::1)。
// 原因:游戏客户端用 BRIDGE_HOST="localhost",而 Windows 上 localhost 优先解析为 IPv6 回环 ::1;
// 若只绑 127.0.0.1,游戏连 localhost 会落到 ::1 被拒 => bridgeUp 永远 false => 面板显示"未运行"。
// 双回环后无论 localhost 解析到哪个都连得上,且两者均不暴露到局域网。
// ---------- EXP-6726g:最小 PNG 编码器(尺寸编码信道的回传载体) ----------
// RGB 真8位,单 IDAT,filter 全 0;尺寸即数据(游戏侧读面板固有宽高解码)
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function pngCrc(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makeRgbPng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((w * 3 + 1) * h); // 每行前置 filter byte 0
  const idat = require("zlib").deflateSync(raw, { level: 1 });
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

const requestHandler = (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch (e) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }

  // EXP6729: 图片响应状态码差分 — 200/404/500/204 验证 ImageLoaded 是否只在成功时触发。
  // 若触发与状态码相关 = 响应状态即入站位元通道(事件驱动,J4 天然异步)。
  if (url.pathname === "/probe_img") {
    const code = parseInt(url.searchParams.get("code"), 10) || 200;
    const n = url.searchParams.get("n") || "-";
    log("info", "PROBE-IMG code=" + code + " n=" + n);
    res.statusCode = (code >= 200 && code < 600) ? code : 200;
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (code === 204) { res.end(); return; }
    if (code >= 200 && code < 300) {
      res.setHeader("Content-Type", "image/png");
      res.end(makeRgbPng(1, 1));
    } else {
      res.setHeader("Content-Type", "text/plain");
      res.end("error " + code);
    }
    return;
  }

  // EXP6734-B/D: 位元延迟端点 — 固定 200 PNG,逐条落底(服务端视角算丢失/乱序;
  // URL 带 round 参数保证每轮唯一,无跨轮缓存;6734-D 增带 c=<cfg>@<run> 按配置分组,
  // 无 c 时保持旧格式 BIT id=.. round=.. (6734-B 分析器兼容)
  if (url.pathname === "/probe_bit") {
    const bitId = url.searchParams.get("id") || "-";
    const bitRound = url.searchParams.get("round") || "-";
    const bitCfg = url.searchParams.get("c") || "-";
    if (bitCfg === "-") log("info", "BIT id=" + bitId + " round=" + bitRound);
    else log("info", "BIT c=" + bitCfg + " id=" + bitId + " round=" + bitRound);
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(makeRgbPng(1, 1));
    return;
  }

  // EXP6734-E: 多值符号判别实验 —— 一个 Image 面板能否承载 >1 bit?
  // 状态机: 2xx(200/201/204/206)→空 PNG=200;3xx(301/302/304/307)→302 到 /rdata?f=E<code>;
  // 4xx(400/401/403/404)→对应 statusCode+短 HTML;5xx(500/503)→同上。
  // 每符号每轮仅首次落底,服务端无状态;判读只看游戏侧行为差异(loaded / loaded-late / 静默)。
  if (url.pathname === "/probe_e") {
    const eId = url.searchParams.get("id") || "-";
    const eRound = url.searchParams.get("round") || "-";
    const eCode = parseInt(url.searchParams.get("code") || "0", 10) || 0;
    log("info", "EIT id=" + eId + " round=" + eRound + " code=" + eCode);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    if (eCode >= 200 && eCode < 300) {
      res.statusCode = eCode;
      res.setHeader("Content-Type", "image/png");
      res.end(makeRgbPng(1, 1));
    } else if (eCode >= 300 && eCode < 400) {
      res.statusCode = eCode;
      res.setHeader("Location", "/rdata?f=E" + eCode + "&o=E" + eCode);
      res.setHeader("Content-Type", "text/html");
      res.end("<html><body>302</body></html>");
    } else if (eCode >= 400) {
      res.statusCode = eCode;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<html><body>E" + eCode + "</body></html>");
    } else {
      // code=0 兜底: 与 200 同形(防手滑打错 code 时把样本误判为 2xx)
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/png");
      res.end(makeRgbPng(1, 1));
    }
    return;
  }

  // EXP6733: 302 重定向高带宽入站实验。
  // /redir302?o=<原标记>&f=<最终标记> -> 302 Location=/rdata?f=<最终标记>
  // /rdata 到达 = 引擎跟随了重定向;若 ImageLoaded 回读到 f 标记 = 最终 URL 可读 = 文本入站成立。
  if (url.pathname === "/redir302") {
    const o = url.searchParams.get("o") || "";
    const f = url.searchParams.get("f") || "";
    log("info", "PROBE-REDIR o=" + o + " f=" + f);
    res.statusCode = 302;
    res.setHeader("Location", "/rdata?f=" + encodeURIComponent(f));
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return;
  }
  if (url.pathname === "/rdata") {
    const f = url.searchParams.get("f") || "";
    log("info", "PROBE-RDATA f=" + f + " (engine FOLLOWED the redirect)");
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(makeRgbPng(1, 1));
    return;
  }

  // EXP6727: 探针信标路由 — Panorama Image.SetImage("/probe?seq=..&d=..") 到达即记录。
  // 双重用途: ① 验证 Image 出站通道仍活; ② 把诊断结果(console.log 同步双路上报)回传落盘。
  if (url.pathname === "/probe") {
    const seq = url.searchParams.get("seq") || "-";
    const part = url.searchParams.get("p") || "";
    const data = url.searchParams.get("d") || "";
    log("info", "PROBE seq=" + seq + (part ? " p=" + part : "") + " " + data);
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(makeRgbPng(1, 1));
    return;
  }

  // EXP-6726g:尺寸回读探针 — 固定 133x77 RGB PNG,验证 Image 面板固有尺寸可经 actuallayoutwidth 读回
  if (url.pathname === "/dim.png") {
    log("info", "IMG-HIT id=" + (url.searchParams.get("id") || "?") + " dim-route");
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(makeRgbPng(133, 77));
    return;
  }

  // EXP-6726f:图片通道探针 — 游戏 Image 面板 SetImage(http://...) 的请求是否到达桥。
  // 到达即记 IMG-HIT 日志(带 id 参数区分探测来源);返回 1x1 透明 PNG + 禁缓存。
  if (url.pathname === "/test.png") {
    log("info", "IMG-HIT id=" + (url.searchParams.get("id") || "?") + " (Image panel request REACHED bridge)");
    const PNG1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(PNG1x1);
    return;
  }

  // BTIPC v1 下行(规格 docs/btipc-v1.md §3.1/§6):每面板一位 —— 位=1 → 200 PNG,位=0 → 404。
  // 帧号只由轮号现算 idx = r - frameStartRound(§4.0 幂等),未知窗口 → 404。
  if (url.pathname === "/btipc/dl") {
    const out = btipcXfer.serveDL(btipcTable, {
      w: url.searchParams.get("w") || "",
      r: url.searchParams.get("r") || "",
      p: url.searchParams.get("p") || "",
      t: url.searchParams.get("t") || "",
    });
    res.statusCode = out.status;
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (out.status === 200) {
      res.setHeader("Content-Type", "image/png");
      res.end(makeRgbPng(1, 1));
    } else {
      res.end();
    }
    return;
  }

  if (url.pathname === "/bridge") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(bridgePage(url.searchParams));
    return;
  }

  if (url.pathname.indexOf("/api/v1/") === 0) {
    readBody(req, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: "body_too_large" });
      const bodyObj = req.method === "POST" ? parseJson(raw) : null;
      handleApi(req, res, url, bodyObj).catch((e) => {
        log("error", "api crash: " + (e && e.stack ? e.stack : String(e)));
        sendJson(res, 500, { ok: false, error: "internal_error" });
      });
    });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
};

const cfg = configStore.load();
activeConfig = cfg;
const PORT = Number(cfg.port) || 8791;
const HOST_V4 = "127.0.0.1";
const HOST_V6 = "::1";

// 启动清理: 删除 logs/chat 中超 30 天的活动日志 / 超 7 天的轮转备份
(() => {
  const dir = path.resolve(__dirname, "..", String((cfg.chatLog && cfg.chatLog.dir) || "logs/chat"));
  cleanupOldChatLogs(dir);
})();

startGameWatch();
startVersionCheckOnBoot();
startGameLogTail();

// ---------- EXP6727: 游戏 console.log 尾随(B 通道) ----------
// 链路: Panorama $.Msg / ConsoleCommand("echo ...") -> 游戏 console.log(-condebug)
//      -> 桥轮询尾随 -> logs/bridge.log(命中 gameLogMarkers 的行)。
// 这是已证实的出站信道(console.log 实测有 [PanoramaScript] [LCT] 行),
// 用于: ① 自动采集游戏内诊断探针结果; ② 评估 B 通道作为长期出站方案的吞吐/截断/编码表现。
// 设计要点:
//   - 游戏通常在桥之后启动,文件不存在时静默重试(每秒),找到后才开始尾随;
//   - 游戏重启会截断/轮转文件(size < pos -> 归零重来);
//   - 行过滤靠 marker([LCT] / BT_),防引擎日志刷屏;命中行的后续行(同批最多 3 行)
//     作为多行消息续行一并转发(测 B6 换行完整性);
function startGameLogTail() {
  if (cfg.gameLogTail === false) return;
  const markers = Array.isArray(cfg.gameLogMarkers) && cfg.gameLogMarkers.length
    ? cfg.gameLogMarkers
    : ["[LCT]", "BT_"];
  const candidates = [];
  if (cfg.gameLogPath) candidates.push(cfg.gameLogPath);
  candidates.push("F:/SteamLibrary/steamapps/common/Deadlock/game/citadel/console.log");
  candidates.push("C:/Program Files (x86)/Steam/steamapps/common/Deadlock/game/citadel/console.log");

  let foundPath = null;
  let filePos = 0;
  let partial = "";

  function emit(line) {
    if (line.length > 4000) line = line.slice(0, 4000) + "...<truncated>";
    log("game", line.replace(/\r$/, ""));
  }

  setInterval(function () {
    try {
      if (!foundPath) {
        for (let i = 0; i < candidates.length; i += 1) {
          const c = candidates[i];
          try {
            if (c && fs.existsSync(c)) { foundPath = c; break; }
          } catch (e) {}
        }
        if (!foundPath) return;
        partial = "";
        // 从文件末尾开始: 只采集启动后的新行,不重放历史会话(否则旧 [LCT] 行混入难分辨)
        try { filePos = fs.statSync(foundPath).size; } catch (e) { filePos = 0; }
        log("info", "game console.log found: " + foundPath + " (tail started at pos " + filePos + ", markers: " + markers.join(", ") + ")");
      }
      let st;
      try { st = fs.statSync(foundPath); } catch (e) { return; }
      if (st.size < filePos) { filePos = 0; partial = ""; } // 游戏重启截断/轮转
      if (st.size === filePos) return;
      const len = st.size - filePos;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(foundPath, "r");
      fs.readSync(fd, buf, 0, len, filePos);
      fs.closeSync(fd);
      filePos = st.size;
      let text = partial + buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) { partial = text; return; }
      partial = text.slice(lastNl + 1);
      text = text.slice(0, lastNl);
      const lines = text.split(/\r?\n/);
      let contBudget = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        let hit = false;
        for (let m = 0; m < markers.length; m += 1) {
          if (line.indexOf(markers[m]) !== -1) { hit = true; break; }
        }
        if (hit) {
          emit(line);
          onBtipcGameLine(line); // BTIPC REQ/CAN(非 BTIPC 行在解析内静默忽略)
          contBudget = 3; // 命中行之后同批的后续行视作多行消息续行
        } else if (contBudget > 0) {
          contBudget -= 1;
          emit("  (cont) " + line);
        }
      }
    } catch (e) {
      // 尾随失败不能影响桥本体
    }
  }, 1000);
}

// 端口被占用 = 已有实例在运行,静默退出(与启动器/开机自启场景兼容)。
// 两台 server 都 EADDRINUSE 才说明确有实例在跑;单台绑定失败(如该回环未启用)忽略。
let listenErrors = 0;
function onServerError(e) {
  if (e && e.code === "EADDRINUSE") {
    listenErrors += 1;
    if (listenErrors >= 2) process.exit(0);
    return;
  }
  log("error", "server error: " + ((e && e.message) || String(e)));
  process.exit(1);
}

function makeServer(host) {
  const s = http.createServer(requestHandler);
  s.on("error", onServerError);
  s.listen(PORT, host, () => {
    log("info", "Babel Tower bridge listening on http://" + host + ":" + PORT);
    log("info", "provider: " + cfg.provider + ", target: " + cfg.defaults.targetLanguage + " (key set: " + (!!(cfg.microsoft && cfg.microsoft.apiKey)) + ")");
  });
  return s;
}

// 先绑 IPv4,再绑 IPv6(任一成功即可服务;两者都成功则双栈可达)
makeServer(HOST_V4);
makeServer(HOST_V6);
