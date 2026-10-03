// gb_add_update2.js — 发布 1.0.7 更新日志: UMM 设置联动 + 指纹丢失根治
// 2026-10-03: 1.0.6 这个号 9/25 已被 GameBanana 用掉(README L12 即证据),本脚本随之改为 1.0.7。
// 用法: node gb_add_update2.js
const puppeteer = require("puppeteer-core");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = "F:\\BabelTower\\config\\gb_browser_profile";
const COOKIES_FILE = "F:\\BabelTower\\config\\gamebanana_cookies.txt";
const UPDATES_URL = "https://gamebanana.com/mods/updates/700107";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TITLE = "1.0.7 本地桥与通信层更新：新增 BTIPC 模块，请整包升级（含 HUD 气泡修复）";
const VERSION = "1.0.7";

const CHANGELOG = [
  ["Feature", "本地桥与通信层(本版主要改动):新增 core/btipc/ 四个模块,bridge_server.js 由 37,809B 增至 57,524B;出站翻译、入站聊天翻译、配置读写全部改走 BTIPC 信道,替代 6726 版本后失效的 SetURL 导航。规格 docs/btipc-v1.md 已冻结。"],
  ["Bugfix", "必须整包解压覆盖,勿只导入 pak:游戏侧三类任务优先走 BTIPC,旧桥没有 /btipc/dl 端点会让它们超时后按原文发送,配置操作返回 ok:false。"],
  ["Bugfix", "次要修复——HUD 顶栏气泡不挂译文:顶栏是统一模板,PingStyleIcon 等常驻槽位被递归匹配误判成快捷语音,导致译文永远挂不上;现要求 quick 有文本侧佐证才跳过,聊天/大厅行行为一字不变。"],
  ["Feature", "沿用 1.0.6:游戏内 UMM 设置窗口出现「巴别塔」标签页,10 项常用设置直接改,即时生效并双向持久化;不装 UMM 完全不影响本 mod。"],
];

const BLURB = "本版的主要改动在**本地桥与通信层**:新增 core/btipc/ 四个模块(BTIPC v1),出站翻译、入站聊天翻译、配置读写全部改走这条新信道,替代 6726 版本后失效的 SetURL 导航。因此必须整包解压覆盖、勿只导入 pak —— 只导 pak 会让翻译链路超时后按原文发送。次要修复:HUD 顶栏气泡此前因快捷语音误判而不挂译文,现已修复。安装(3 步):解压 zip → Mod Manager 导入 pak01_dir.vpk → powershell -ExecutionPolicy Bypass -File scripts\\autostart.ps1 -Action Install,然后游戏内 /tr → 测试 → 保存。详细说明见包内《安装使用说明.txt》。";

async function loadCookies(page) {
  if (!fs.existsSync(COOKIES_FILE)) return;
  const raw = fs.readFileSync(COOKIES_FILE, "utf8").trim();
  if (!raw) return;
  const pairs = raw.split(";").map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("=");
    return { name: s.slice(0, i), value: s.slice(i + 1) };
  });
  const merged = new Map();
  pairs.forEach(p => merged.set(p.name, p.value));
  const cookies = [...merged.entries()].map(([name, value]) => ({
    name, value, domain: ".gamebanana.com", path: "/",
    httpOnly: name === "sess", secure: true,
  }));
  if (cookies.length) {
    await page.setCookie(...cookies);
    console.log("COOKIES LOADED:", cookies.map(c => c.name).join(", "));
  }
}

async function setInput(page, selector, value) {
  return page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: "not found: " + sel };
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, now: el.value };
  }, { sel: selector, val: value });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, userDataDir: PROFILE, headless: false,
    // 2026-10-03: 填完第 4 条 changelog 后 Runtime.callFunctionOn 默认 180s 超时,
    // 走不到提交那步(条目未创建)。放长到 10 分钟。
    protocolTimeout: 600000,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--ignore-certificate-errors", "--no-proxy-server"],
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
  await loadCookies(page);

  await page.goto(UPDATES_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(6000);
  const modalOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /add update/i.test((b.innerText || "").trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  console.log("MODAL OPENED:", modalOpened);
  if (!modalOpened) { await browser.close(); process.exit(1); }
  await sleep(8000);

  console.log("TITLE FILL:", JSON.stringify(await setInput(page, "#_sName", TITLE)));
  console.log("VERSION FILL:", JSON.stringify(await setInput(page, "#_sVersion", VERSION)));
  await sleep(1500);

  for (let i = 0; i < CHANGELOG.length; i++) {
    const clicked = await page.evaluate(() => {
      const cluster = [...document.querySelectorAll(".Cluster")].find(c => /Add Entry/.test(c.innerText));
      if (!cluster) return false;
      const btn = [...cluster.querySelectorAll("button")].find(b => /Add Entry/.test(b.innerText || ""));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) { console.log("ADD ENTRY FAILED at", i); break; }
    await sleep(600);
    const [type, text] = CHANGELOG[i];
    const filled = await page.evaluate(({ t, txt }) => {
      const rows = [...document.querySelectorAll(".ChangelogInput")];
      const row = rows[rows.length - 1];
      if (!row) return { ok: false };
      const input = row.querySelector("input[type=text]");
      const select = row.querySelector("select");
      if (!input || !select) return { ok: false };
      const sp = Object.getPrototypeOf(select);
      const sdesc = Object.getOwnPropertyDescriptor(sp, "value");
      if (sdesc && sdesc.set) sdesc.set.call(select, t);
      else select.value = t;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const ip = Object.getPrototypeOf(input);
      const idesc = Object.getOwnPropertyDescriptor(ip, "value");
      if (idesc && idesc.set) idesc.set.call(input, txt);
      else input.value = txt;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, type: select.value, len: input.value.length };
    }, { t: type, txt: text });
    console.log(`  entry ${i + 1} [${type}]:`, JSON.stringify(filled));
    await sleep(500);
  }

  console.log("BLURB STEP...");
  const pm = await page.$(".ProseMirror");
  console.log("  ProseMirror found:", !!pm);
  if (pm) {
    await pm.click();
    await sleep(800);
    await page.keyboard.type(BLURB, { delay: 0 });
    await sleep(1500);
    const blurbLen = await page.evaluate(() => {
      const el = document.querySelector(".ProseMirror");
      return el ? (el.innerText || "").length : -1;
    });
    console.log("  BLURB LEN:", blurbLen, "/", BLURB.length);
  }

  // 勾选要发布的文件:严格优先 107(本版),106/105 只作兜底。
  // 原实现 .find() 返回 DOM 中先出现者,而 babeltower-105-win64.zip 仍在列表里
  // 且常排在本版之前 → 会误勾 1.0.5 的包(9/25 那条 1.0.6 就是这么绑错的);
  // 另有已勾选状态未检查、再点会反勾的风险。
  const fileChecked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("input[type=checkbox]")];
    const labelOf = (b) => ((b.closest(".RadioCheckWrapper") || {}).innerText || "");
    const cands = boxes.filter((b) => /babeltower-10[567]-win64/i.test(labelOf(b)));
    const target = cands.find((b) => /babeltower-107-win64/i.test(labelOf(b))) || cands[0];
    if (!target) return { ok: false, total: boxes.length, cands: cands.length };
    const label = labelOf(target).replace(/\s+/g, " ").trim().slice(0, 60);
    if (!target.checked) target.click();
    return { ok: true, id: target.id, label: label, already: target.checked };
  });
  console.log("FILE CHECK:", JSON.stringify(fileChecked));
  await sleep(1000);

  const submit = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button, input[type=submit]")].find(b => {
      const t = (b.innerText || b.value || "").trim();
      return /^save$|^submit$|^publish$|^post update$/i.test(t);
    });
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true, text: (btn.innerText || btn.value || "").trim() };
  });
  console.log("SUBMIT:", JSON.stringify(submit));

  await sleep(12000);
  console.log("AFTER URL:", await page.url());
  const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300));
  console.log("BODY:", body);

  const cookies = await page.cookies("https://gamebanana.com");
  const keep = ["sess", "rmc", "cf_clearance"];
  const parts = cookies.filter(c => keep.includes(c.name)).map(c => c.name + "=" + c.value);
  if (parts.length) fs.writeFileSync(COOKIES_FILE, parts.join("; "));

  await browser.close();
  console.log("DONE");
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });