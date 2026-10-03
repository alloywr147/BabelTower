"use strict";
// Steam 库 / 游戏安装路径发现 —— 桥与构建工具共用单一实现。
//
// 2026-10-03 玩家反馈「桥漏查 D 盘游戏日志」:旧代码把 console.log 候选写死成两条
// (F:\SteamLibrary 与 C:\Program Files (x86)\Steam),Steam 库装在 D:/E:/G: 或装在
// C:\D\steam 这种自定义路径的用户,桥永远 `fs.existsSync` 不到 → tail 起不来 →
// BTIPC 上行全断,mod 静默不工作。
//
// 正确顺序:显式配置/环境变量 → Steam 注册表安装路径 → <steam>/config/libraryfolders.vdf
// 里的【全部】库(Steam 会把每个盘的库都登记在这里)→ 拼相对路径。
// 调用方再补自己的老写死路径作最后兜底。
//
// 设计要求:**绝不抛异常**(桥启动路径上,任何一处注册表/vdf 解析炸了都不该带走桥);
// reg 查询带 timeout,失败静默降级为默认路径。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function uniq(list) {
  const out = [];
  const seen = {};
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v) continue;
    // 归一化只用于判重:大小写、斜杠、结尾斜杠都算同一条
    const k = String(v).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(String(v));
  }
  return out;
}

// Steam 客户端安装根目录(注册表优先;读不到时退回常见默认位置)
function steamRoots() {
  const out = [];
  if (process.platform === "win32") {
    const queries = [
      ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
      ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
      ["HKCU\\SOFTWARE\\Valve\\Steam", "SteamPath"],
    ];
    for (let i = 0; i < queries.length; i++) {
      try {
        const q = queries[i];
        const r = execFileSync("reg", ["query", q[0], "/v", q[1]], {
          windowsHide: true, encoding: "utf8", timeout: 4000,
        });
        const m = /REG_SZ\s+(.+)$/m.exec(String(r));
        if (m) out.push(m[1].trim());
      } catch (e) { /* 该键不存在/无权限:跳过 */ }
    }
  }
  out.push("C:\\Program Files (x86)\\Steam");
  out.push("C:\\Program Files\\Steam");
  try {
    if (process.env["ProgramFiles(x86)"]) out.push(path.join(process.env["ProgramFiles(x86)"], "Steam"));
    if (process.env.ProgramFiles) out.push(path.join(process.env.ProgramFiles, "Steam"));
  } catch (e) {}
  return uniq(out);
}

// 解析 libraryfolders.vdf:新格式 `"path" "X:\Lib"`,旧格式 `"2" "X:\Lib"`。
// 值里的 `\\` 是 VDF 转义,要还原成单反斜杠;只接受盘符/UNC 开头,免得把
// contentstatsid 之类纯数字 id 当成路径。
function libraryPathsFromVdf(vdfPath) {
  const out = [];
  try {
    if (!fs.existsSync(vdfPath)) return out;
    const txt = fs.readFileSync(vdfPath, "utf8");
    const re = /"(?:path|\d+)"\s*"((?:[A-Za-z]:|\\\\)[^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const p = m[1].replace(/\\\\/g, "\\");
      if (fs.existsSync(p)) out.push(p);
    }
  } catch (e) {}
  return out;
}

// Steam 库根目录 = Steam 安装目录本身 + libraryfolders.vdf 登记的所有库
function steamLibraries() {
  const out = [];
  const roots = steamRoots();
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    // 注册表里有、盘上没有(Steam 卸载/挪库)的根不进候选,免得每次都要靠调用方 existsSync
    try {
      if (!fs.existsSync(root)) continue;
    } catch (e) {
      continue;
    }
    out.push(root);
    // 新位置 config\libraryfolders.vdf,老位置 steamapps\libraryfolders.vdf,两个都试
    out.push.apply(out, libraryPathsFromVdf(path.join(root, "config", "libraryfolders.vdf")));
    out.push.apply(out, libraryPathsFromVdf(path.join(root, "steamapps", "libraryfolders.vdf")));
  }
  return uniq(out);
}

// 各 Steam 库下的游戏根目录(不含调用方自己的环境变量/写死路径)
function gameRoots(gameFolder) {
  const rel = "steamapps/common/" + gameFolder;
  return steamLibraries().map(function (lib) {
    return path.join(lib, rel);
  });
}

// 游戏内某个文件的候选路径。headExtra 放在最前(显式配置 > 自动发现),
// 避免旧安装目录残留时把新路径挤掉。
function gameFileCandidates(gameFolder, relInsideGameRoot, headExtra) {
  const out = [];
  (headExtra || []).forEach(function (p) { if (p) out.push(p); });
  gameRoots(gameFolder).forEach(function (root) { out.push(path.join(root, relInsideGameRoot)); });
  return uniq(out);
}

module.exports = {
  uniq: uniq,
  steamRoots: steamRoots,
  libraryPathsFromVdf: libraryPathsFromVdf,
  steamLibraries: steamLibraries,
  gameRoots: gameRoots,
  gameFileCandidates: gameFileCandidates,
};
