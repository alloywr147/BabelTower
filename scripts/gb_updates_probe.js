// gb_updates_probe.js — 只读列出 GameBanana mod 的更新日志条目(发布后验证用)
// 场景: gb_add_update2.js 提交后只回吐页面导航文本,无法证明条目真的创建成功;
//       本脚本读 /mods/updates/:id 列出条目标题/版本/时间,用于核对。
// 用法: node scripts/gb_updates_probe.js [要找的关键词]   默认 1.0.6
const puppeteer = require("puppeteer-core");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = "F:\\BabelTower\\config\\gb_browser_profile";
const UPDATES_URL = "https://gamebanana.com/mods/updates/700107";
const KEY = (process.argv[2] || "1.0.6").toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    userDataDir: PROFILE,
    headless: false,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--ignore-certificate-errors", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.goto(UPDATES_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(8000);

    const dump = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const lines = body
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter((l) => l);
      // 条目卡片常见结构:标题 + Version + 时间戳;退而求其次抓含 "v" 版本串的行
      const versionish = lines.filter((l) => /\b\d+\.\d+\.\d+\b|^\d+\.\d+$/.test(l));
      const chlog = lines.filter((l) => /^(Feature|Improvement|Bugfix|Note|Warning)\b/.test(l));
      const hasAddBtn = !![...document.querySelectorAll("button")].find((b) => /add update/i.test(b.innerText || ""));
      // 逐条正文锚点:核对本次 5 条 changelog + blurb 是否真的落页
      const markers = {
        title: "UMM 设置窗口联动",
        entry1: "10 项常用设置",
        entry2: "中文界面",
        entry3: "双向持久化",
        entry4: "quickchat 模板指纹",
        entry5_note: "机密不走广播通道",
        entry5_alt: "回退服务商",
        blurb: "本地桥无变化",
        file: "babeltower-106-win64",
      };
      const hit = {};
      for (const k in markers) hit[k] = body.indexOf(markers[k]) >= 0;
      return { total: lines.length, versionish: versionish.slice(0, 40), chlog: chlog.slice(0, 30), hasAddBtn, markers: hit, head: lines.slice(0, 12) };
    });

    console.log("HAS 'Add Update' BUTTON:", dump.hasAddBtn, "(登录态佐证)");
    console.log("--- 正文锚点逐条核对 ---");
    let missing = [];
    for (const k in dump.markers) {
      const v = dump.markers[k];
      console.log("  " + (v ? "OK  " : "MISS") + " | " + k);
      if (!v) missing.push(k);
    }
    console.log("--- 版本串行 ---");
    dump.versionish.forEach((l) => console.log("  " + l));
    console.log("--- changelog 类型行 ---");
    dump.chlog.forEach((l) => console.log("  " + l.slice(0, 150)));

    const hay = JSON.stringify(dump).toLowerCase();
    console.log("---- 判定 ----");
    console.log("  含 [" + KEY + "]:", hay.includes(KEY));
    console.log("  含 changelog 类型:", dump.chlog.length > 0);
    if (dump.chlog.length > 0 && missing.length === 0) console.log("  => PUBLISH_OK (5 条 changelog + blurb + 文件全部落页)");
    else if (dump.chlog.length > 0) console.log("  => PUBLISH_PARTIAL,缺: " + missing.join(", "));
    else console.log("  => 未能证实,请人工打开页面确认");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
