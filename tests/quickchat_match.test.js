// 离线测试:快捷语音模板匹配器 + 匹配缓存(同文本双通道只走查一次)
// 语料加载与匹配逻辑以 core/quickchat_match.js 为唯一实现源;
// 客户端副本(lingua_chat.js)与其同步——改匹配逻辑时三处同步(客户端/core/本测试)。
// 跑法: node tests/quickchat_match.test.js
"use strict";
const qc = require("../core/quickchat_match.js");
const { matchesQuickTemplate, clearMatchCache, getWalkCount, resetWalkCount, getCorpusSizes } = qc;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS |", label); }
  else { fail++; console.log("  FAIL |", label); }
}
function expectSkip(text) {
  ok(matchesQuickTemplate(text) === true, "skip   | " + text);
}
function expectTrans(text) {
  ok(matchesQuickTemplate(text) === false, "trans  | " + text);
}

const sizes = getCorpusSizes();
console.log("templates:", sizes.templates, "| names:", sizes.names);
ok(sizes.templates >= 200, "fallback corpus >= 200");

// ===== 语料同步清缓存(setCorpora 语义) =====
qc.setCorpora(null, null); // 相同语料重灌:验证不崩 + 缓存清空(通过走查计数复归观察)
resetWalkCount();
clearMatchCache();

console.log("--- 快捷语音渲染结果:现值应 skip,已消失的旧形态应 trans ---");
// 2026-10-03 对账 6726 后 citadel_main loc(逐条实测,与 2026-09-17 取证形态已不同):
//   citadel_chatwheel_message_missing_hero = "不见了" / "is missing"  ← 英雄名参数已删
//   ping_ability_ready = "{s:param_1}好了!"   ping_ability_on_cooldown = "{s:param_1}正在冷却"
//   "我看到 / I see / 还要冷却 / 准备就绪 / for 6s" 五种旧渲染在当前 loc 中已不存在
//   凡游戏不再产生的形态,一律按真人文本送翻译(见 §16.7 同口径:语料以游戏实际产出为准)
expectSkip("不见了");
expectSkip("不见了！！！");                 // 叠标点(HUD 实车取证形态;剥尾后同键)
expectSkip("is missing");
expectSkip("疗伤幽灵正在冷却");             // ping_ability_on_cooldown 现值
expectSkip("Restorative Locket is on cooldown");
expectSkip("遥控夜枭好了！");               // ping_ability_ready 现值
expectSkip("Venator的大招好了");            // 带参数族仍在:{s:param_1}的大招好了
expectTrans("Venator不见了");              // 旧英雄名前缀形态,游戏已不再产生
expectTrans("Venator不见了！！！");
expectTrans("我看到 McGinnis");             // loc 中已无 "我看到/I see" 词条
expectTrans("I see McGinnis");
expectTrans("McGinnis is Missing");         // missing_hero 无参后,属真人可打文本

// 2026-10-02 游戏更新取证(当前 citadel_main loc + 实车 dump):
//   路名 黄路→约克(值静态,渲染=值,零参数歧义)
expectSkip("我们一起推约克");        // 旧:我们去推进黄路吧(ping_push_yellow 改值)
expectSkip("防守分路！");
expectSkip("约克需要支援！");        // 旧:黄路需要帮助！(Help_yellow 改值,语料存去尾标点)
expectTrans("Mo & Krill不见了");          // 与上同族:英雄名前缀形态已不再产生
expectTrans("Lady Geist is Missing");     // 多词英文名,现属真人可打文本
expectSkip("小 心");                     // 渲染空格不稳定
expectTrans("灰爪不见了");                // 中文英雄名前缀,同 missing_hero 无参

console.log("--- 真人消息(应全部 translate) ---");
expectTrans("撤退吧兄弟");
expectTrans("攻击中路");
expectTrans("他们去中路了");
expectTrans("小心对面隐身");
expectTrans("gg wp");
expectTrans("loot mid now");
expectTrans("Venator 不见了吗？");       // 疑问语气,非模板
expectTrans("我们推进黄路吧好不好");     // 模板后带内容
expectTrans("join our party please");
expectTrans("123456");
expectTrans("他也不见了");               // CJK 参数不允许,防误杀
expectTrans("人不见了！！");
// 2026-10-02 取证:ping_enemy_has_item 旧值 "小心！{p1}有{p2}" 已改 "有{p2}"(zh),
// 旧渲染形态不再由游戏产生 → 属真人输入。新 zh 渲染固定段仅 1 字("有"),
// 过筛策略(≥2 字)拒绝收录 → 该轮盘消息由结构判定(Ping/PingLabel)兜底,模板层刻意不接。
expectTrans("小心！McGinnis有灵能涌动");

console.log("--- 匹配缓存:同文本双通道只走查一次 ---");
// 2026-10-02:输入从 "Venator不见了" 换为路名模板 —— missing_hero 参数已被 6726 删掉(2026-10-03 对账 citadel_main loc 确认),
// 缓存测试与该组解耦,选零参数零歧义的静态值模板(推送约克,高频轮盘)
clearMatchCache();
resetWalkCount();
const first = matchesQuickTemplate("推进约克");
const second = matchesQuickTemplate("推进约克");       // 同通道第二次(缓存命中)
const third = matchesQuickTemplate("推进约克！！！");   // 叠标点变体(剥尾后同键,也命中缓存)
const fourth = matchesQuickTemplate("推进约克！");      // 另一变体
ok(first === true && second === true && third === true && fourth === true, "缓存后结果一致(4 次调用全 true)");
ok(getWalkCount() === 1, "同文本+叠标点变体只走查 1 次(实际 " + getWalkCount() + ")");

resetWalkCount();
matchesQuickTemplate("撤退吧兄弟");
matchesQuickTemplate("撤退吧兄弟 ");        // 尾空格归一化同键
matchesQuickTemplate(" 撤退吧兄弟");        // 头空格同理
ok(getWalkCount() === 1, "负结果也缓存:trans 判定同文本只走查 1 次(实际 " + getWalkCount() + ")");

resetWalkCount();
matchesQuickTemplate("");
matchesQuickTemplate(null);
matchesQuickTemplate("   ");
ok(getWalkCount() === 0, "空/null/纯空白文本不走查不入缓存");
// 注:单字符无守卫——生产链路中 shouldSkip 的 length<2 守卫先行,永远到不了匹配器
matchesQuickTemplate("A");
ok(getWalkCount() === 1, "单字符照常走查(上游 shouldSkip 已挡,不会到这)");

console.log("--- 新族过筛(2026-09-17 复审):高频手打短语已剔除语料,必须可翻 ---");
expectTrans("抱歉");
expectTrans("抱歉！");
expectTrans("sorry");
expectTrans("Sorry!");
expectTrans("不客气");
expectTrans("You're Welcome");
expectTrans("有什么计划？");
expectTrans("What's the plan");
expectTrans("有治疗");
expectTrans("请治疗");
expectTrans("需要治疗");
expectTrans("Heal Please");
expectTrans("去商店");
expectTrans("去商店！");
expectTrans("Going to Shop");

console.log("--- 新族保留项:Bot 播报/长句轮盘仍应 skip ---");
expectSkip("推进滑索");
expectSkip("Pushing Zipline");
expectSkip("攻击 1 级");
expectSkip("防守基地");
expectSkip("Attacking Lane");
expectSkip("推进约克");                // 2026-10-02:旧 推进黄路(路名改名,值静态)
expectSkip("Push York");             // 英文值曾带 </span> 残留,生成侧已剥 HTML 标签
expectSkip("帮我护送灵瓮");
expectSkip("Help me deliver the urn");
// 2026-10-03:can_heal 现值 = "我可以治疗你"(6726 loc 已删英雄名参数),裸值仍 skip;
// 带英雄名的旧形态不再由游戏产生 → 转真人文本
expectSkip("我可以治疗你");
expectTrans("我可以治疗你，Graves");

console.log("--- 缓存上限:超限整体清空(正确性不受影响) ---");
clearMatchCache();
resetWalkCount();
const LIMIT = 500; // 与 core/quickchat_match.js MATCH_CACHE_LIMIT 同步
let mutated = 0;
for (let i = 0; i < LIMIT + 10; i++) {
  if (matchesQuickTemplate("loot mid now " + i)) mutated++;
}
ok(mutated === 0, "灌 " + (LIMIT + 10) + " 条未命中文本:全部正确 trans(无串扰)");
ok(getWalkCount() === LIMIT + 10, "上限清空后仍逐条走查(实际 " + getWalkCount() + ")");
clearMatchCache();
resetWalkCount();
ok(matchesQuickTemplate("推进约克") === true, "清空后高频模板仍正确命中");
ok(getWalkCount() === 1, "清空后重新走查 1 次");

console.log("RESULT: PASS " + pass + " / FAIL " + fail);
process.exit(fail > 0 ? 1 : 0);
