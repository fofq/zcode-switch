import { sortAccounts, healthOf, filterAccounts } from "../src/list.js";

// ---- mock 数据构造 ----
let seq = 0;
const mkAccount = (name) => ({ id: `id-${seq++}`, name, is_active: false, updated_at: "2026-09-19 10:00", created_at: "2026-09-19 10:00" });
const mkPlan = (name, gift, total, used) => ({
  name, gift, expire: "2026-09-19 09:00",
  items: [{ name: "GLM-5.3-Flash", total, used, remaining: total - used, percent_used: (used / total) * 100, unit: "token" }],
});
const mkPlan53 = (total, used) => ({
  name: "ZCode Start Plan", gift: false, expire: "2026-09-19 23:59",
  items: [{ name: "GLM-5.3", total, used, remaining: total - used, percent_used: (used / total) * 100, unit: "token" }],
});
const mkQuota = (plans) => ({ data: { plans, items: [], refreshed_at: 1 } });

const accounts = ["A-1亿满", "B-3亿满", "C-1亿半", "D-无数据", "E-纯5M"].map(mkAccount);
const [A, B, C, D, E] = accounts;
const quotas = {
  [A.id]: mkQuota([mkPlan("ZCode Global Build", true, 1e8, 0)]),                       // 1亿 全新
  [B.id]: mkQuota([mkPlan("ZCode Weekend Build", true, 3e8, 0)]),                     // 3亿 全新
  [C.id]: mkQuota([mkPlan("ZCode Global Build", true, 1e8, 5e7)]),                    // 1亿 用一半
  [D.id]: null,                                                                        // 无数据
  [E.id]: mkQuota([mkPlan("ZCode Start Plan", false, 5e6, 0), mkPlan53(3e6, 0)]),     // 纯订阅 5M
};
const opts = { giftFirst: true, modelFallback: true, threshold: 10 };

// 健康图（模拟 main.js healthMapOf）
const healthMap = new Map();
for (const a of accounts) {
  const h = healthOf(a, quotas[a.id], null, "GLM-5.3-Flash", opts);
  healthMap.set(a.id, h);
}
console.log("--- 健康判定 ---");
for (const a of accounts) {
  const h = healthMap.get(a.id);
  console.log(`${a.name.padEnd(8)} lv=${h.level.padEnd(7)} pct=${h.remainingPct == null ? "null" : h.remainingPct.toFixed(1)} focusPct=${h.focusPct == null ? "null" : h.focusPct.toFixed(1)} gift=${h.hasGift}`);
}

// keyOf：模拟 main.js 的 sortKeyValue（focus = 绝对剩余量）
const keyOf = (a, sort) => {
  if (sort !== "focus" && sort !== "gift") return null;
  const h = healthMap.get(a.id) || {};
  if (sort === "focus") {
    let sum = 0;
    for (const p of quotas[a.id]?.data?.plans || []) {
      for (const it of p.items || []) {
        if (it.name === "GLM-5.3-Flash") sum += Number(it.remaining ?? 0);
      }
    }
    return sum;
  }
  let sum = 0;
  for (const p of quotas[a.id]?.data?.plans || []) {
    if (p.gift !== true) continue;
    if (p.remaining != null) sum += Number(p.remaining);
    else for (const it of p.items || []) sum += Number(it.remaining ?? 0);
  }
  return sum;
};

const names = (arr) => arr.map((a) => a.name).join(" > ");
let pass = 0, fail = 0;
const check = (label, cond, got) => { if (cond) { pass++; console.log("PASS", label); } else { fail++; console.log("FAIL", label, "| got:", got); } };

// 1. quota 正序/倒序
const q1 = sortAccounts(accounts, "quota", healthMap, "zh-CN", { threshold: 10, dir: 1, keyOf: (a) => keyOf(a, "quota") });
const q2 = sortAccounts(accounts, "quota", healthMap, "zh-CN", { threshold: 10, dir: -1, keyOf: (a) => keyOf(a, "quota") });
console.log("\nquota  desc:", names(q1));
console.log("quota  asc :", names(q2));
check("quota desc：活跃号(置顶)外按剩余%降序", names(q1).startsWith("E-纯5M") ? false : true, names(q1));
check("quota asc 与 desc 顺序翻转", JSON.stringify(q1.map(a=>a.id)) !== JSON.stringify(q2.map(a=>a.id)));
check("quota asc：C(50%) 应排在 A(100%) 前", q2.findIndex(x=>x.name==="C-1亿半") < q2.findIndex(x=>x.name==="A-1亿满"), names(q2));
check("quota 两方向：无数据 D 都在最后", q1[q1.length-1].name === "D-无数据" && q2[q2.length-1].name === "D-无数据");

// 2. focus 排序（绝对剩余量）—— 必须与 quota 不同（B 3亿 > A 1亿，pct 相同）
const f1 = sortAccounts(accounts, "focus", healthMap, "zh-CN", { threshold: 10, dir: 1, keyOf: (a) => keyOf(a, "focus") });
const f2 = sortAccounts(accounts, "focus", healthMap, "zh-CN", { threshold: 10, dir: -1, keyOf: (a) => keyOf(a, "focus") });
console.log("\nfocus  desc:", names(f1));
console.log("focus  asc :", names(f2));
check("focus desc：B(3亿) > A(1亿) > C(0.5亿)", f1.findIndex(x=>x.name==="B-3亿满") < f1.findIndex(x=>x.name==="A-1亿满") && f1.findIndex(x=>x.name==="A-1亿满") < f1.findIndex(x=>x.name==="C-1亿半"), names(f1));
check("focus desc/asc 翻转", JSON.stringify(f1.map(a=>a.id)) !== JSON.stringify(f2.map(a=>a.id)));
check("focus 与 quota 排序结果不同（区分度）", JSON.stringify(f1.map(a=>a.id)) !== JSON.stringify(q1.map(a=>a.id)));

// 3. gift 排序（礼物剩余量；C 的礼物剩一半，E 无礼物）
const g1 = sortAccounts(accounts, "gift", healthMap, "zh-CN", { threshold: 10, dir: 1, keyOf: (a) => keyOf(a, "gift") });
const g2 = sortAccounts(accounts, "gift", healthMap, "zh-CN", { threshold: 10, dir: -1, keyOf: (a) => keyOf(a, "gift") });
console.log("\ngift   desc:", names(g1));
console.log("gift   asc :", names(g2));
check("gift desc：B(3亿) > A(1亿) > C(0.5亿) > E(0)", g1.findIndex(x=>x.name==="B-3亿满") < g1.findIndex(x=>x.name==="A-1亿满") && g1.findIndex(x=>x.name==="A-1亿满") < g1.findIndex(x=>x.name==="C-1亿半") && g1.findIndex(x=>x.name==="C-1亿半") < g1.findIndex(x=>x.name==="E-纯5M"), names(g1));
check("gift asc 翻转", JSON.stringify(g1.map(a=>a.id)) !== JSON.stringify(g2.map(a=>a.id)));

// 4. chip 筛选
const giftOnly = filterAccounts(accounts, { health: "gift" }, healthMap);
check("仅显示🎁礼物额度：只含 A/B/C 三个礼物号（D 无数据、E 无礼物被排除）", giftOnly.length === 3 && !giftOnly.find(x=>x.name==="E-纯5M") && !giftOnly.find(x=>x.name==="D-无数据"), names(giftOnly));

// 5. 组合：礼物 chip + focus 倒序
const combo = sortAccounts(filterAccounts(accounts, { health: "gift" }, healthMap), "focus", healthMap, "zh-CN", { threshold: 10, dir: 1, keyOf: (a) => keyOf(a, "focus") });
check("组合：礼物号按 Flash 剩余量降序 B>A>C", names(combo).startsWith("B-3亿满 > A-1亿满 > C-1亿半"), names(combo));

// 6. name 正倒序
const n1 = sortAccounts(accounts, "name", healthMap, "zh-CN", { dir: 1 });
const n2 = sortAccounts(accounts, "name", healthMap, "zh-CN", { dir: -1 });
check("name 正倒序翻转", JSON.stringify(n1.map(a=>a.id)) !== JSON.stringify(n2.map(a=>a.id)));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
