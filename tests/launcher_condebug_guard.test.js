// 回归护栏:-condebug 是 BTIPC 上行的硬前提,启动器/文档/桥端兜底三处都不许丢。
// 教训来源:2026-10-03 玩家反馈"启动器缺少 -condebug" —— 游戏不带该参数就不写
// game/citadel/console.log,而 6726 后 AsyncWebRequest 被移除、面板 SetURL 导航也失效,
// console.log tail 成了游戏→桥的【唯一】上行通路;缺参 = mod 装了完全没反应(静默失败)。
// 本机 Steam 日志铁证:gameprocess_log 的 cmdline 只有 `-steam -console`(无 -condebug),
// 带参的那次是 `steam://run/1422450//-condebug -exec autoexec` → 参数必须显式传。
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

// ---- 1. 启动器显式传参 ----
const bat = read("StartDeadlock.bat");
check("StartDeadlock.bat 用 steam://run/<appid>//<args>/ 传 -condebug",
  /steam:\/\/run\/1422450\/\/-condebug/.test(bat));
// 只看真正执行的 start 行:bat 里注释还会提到 rungameid(解释为什么不用它),
// 那种说明性文本不该算违规,否则护栏会把"讲清楚理由"本身判死。
check("启动行不使用没有传参位置的 rungameid",
  !bat.split(/\r?\n/).some(l => /^\s*start\b.*rungameid/i.test(l)));
check("bat 自带 -condebug 必要性注释", /-condebug is MANDATORY/.test(bat));
// 文件头要求:纯 ASCII(bat 里出现 CJK 在某些 codepage 下会乱码甚至吞行)
check("bat 保持纯 ASCII(文件头约定)", !/[^\x00-\x7F]/.test(bat));

// ---- 2. 桥端兜底告警 ----
const bridge = read("core/bridge_server.js");
check("桥端有 -condebug 缺失判定(CONDEBUG_WARN_MS)", /const CONDEBUG_WARN_MS = \d+/.test(bridge));
check("桥端告警给出 Steam 启动选项修复步骤", /缺少 -condebug 启动参数/.test(bridge) &&
  /启动选项/.test(bridge));
check("每次游戏启动只判一次(不刷屏)", /condebugChecked = true/.test(bridge));
check("判据:console.log 必须晚于本次游戏启动(mtime)", /mtimeMs >= condebugGameAt/.test(bridge));
check("游戏退出后重置,下次启动重新判",
  /if \(!gameProcessSeen\) \{ condebugGameAt = 0; condebugChecked = false; return; \}/.test(bridge));

// ---- 3. 文档必须讲清楚(否则玩家从 Steam 直接启动照样踩) ----
check("README 安装步骤含 -condebug", /-condebug/.test(read("README.md")));
check("development 冒烟清单含 console.log 校验", /condebug/.test(read("docs/development.md")) &&
  /console\.log found/.test(read("docs/development.md")));
check("architecture 记录 ① 上行硬依赖 -condebug",
  /上行硬依赖 `-condebug`/.test(read("docs/architecture.md")));
// 包内《安装使用说明.txt》是玩家唯一必读文档 —— 2026-10-04 按用户要求补上:
// 10-03 玩家反馈就是从 Steam 直接启动游戏、教程里没提这个参数才踩的坑。
const tut = read("安装使用说明.txt");
check("安装教程含 -condebug 必做步骤", /-condebug/.test(tut) && /启动选项/.test(tut));
check("安装教程说明为什么必做(不设会静默失效)", /console\.log/.test(tut) && /静默失效/.test(tut));
check("安装教程给出判据 console.log found", /console\.log found/.test(tut));

console.log("\nRESULT: PASS " + pass + " / FAIL " + fail);
process.exit(fail ? 1 : 0);
