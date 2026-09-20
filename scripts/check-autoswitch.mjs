#!/usr/bin/env node
// 自动切换决策逻辑的自检（纯函数，不依赖 Tauri / DOM）。
// 覆盖：池统计（乐观/悲观）、烧速与 ETA、触发路径（阈值/预测/硬信号）、
//       降级切号、冷却与保护窗、陈旧数据刷新、候选排序。
import {
  poolStats,
  poolStatsFromSignals,
  summarizePools,
  sampleFrom,
  pushSample,
  burnRate,
  etaSeconds,
  etaOf,
  poolsRate,
  rankTargets,
  evaluate,
  fmtEta,
  AS_DEFAULTS,
} from "../src/autoswitch.js";

let failed = 0;
let passed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.error(`  ✗ ${msg}`);
}
function eq(got, want, msg) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  ok(g === w, `${msg}（期望 ${w}，实际 ${g}）`);
}

// ---------- fixture：真实结构（取自本机 .tmpdiag 额度响应） ----------
const quotaTwoModels = {
  data: {
    is_empty: false,
    items: [
      { name: "GLM-5.3", percent_used: 0, total: 3000000, used: 0, remaining: 3000000 },
      { name: "GLM-5.3-Flash", percent_used: 91.61716, total: 5000000, used: 4580858, remaining: 419142 },
    ],
    plans: [
      { gift: true, name: "ZCode Global Build", items: [] },
      {
        gift: false,
        name: "ZCode Start Plan",
        items: [
          { name: "GLM-5.3", percent_used: 0, total: 3000000, used: 0, remaining: 3000000 },
          { name: "GLM-5.3-Flash", percent_used: 91.61716, total: 5000000, used: 4580858, remaining: 419142 },
        ],
      },
    ],
  },
};

// 1. 关注模型命中：取该模型自己的池（乐观 best=worst，因为只有一个匹配条目）
const s1 = poolStats(quotaTwoModels, "GLM-5.3-Flash");
ok(s1 && s1.matched === true, "poolStats 命中关注模型");
ok(Math.abs(s1.bestPct - 8.38284) < 0.01, `Flash 剩余应为 8.38%，实际 ${s1.bestPct}`);
eq(s1.worstTokens, 419142, "Flash 剩余 token 数");
// 关键：不能因为 GLM-5.3 是 100% 就把账号判成充足
ok(s1.bestPct < 10, "关注模型的池不被其它模型的新鲜池掩盖");

// 2. 关注模型未命中 → 回退全部池（与旧行为一致）
const s2 = poolStats(quotaTwoModels, "GLM-4.7");
eq(s2.matched, false, "未命中时 matched=false");
eq(s2.scope, "all", "未命中时 scope=all");
eq(s2.bestPct, 100, "未命中时回退最宽松池（乐观，旧行为）");

// 3. 无 items 只有计划级数字 → 兜底可用
const quotaPlanOnly = { data: { plans: [{ name: "P", percent_used: 80, total: 100, used: 80 }] } };
const s3 = poolStats(quotaPlanOnly, "");
eq(Math.round(s3.bestPct), 20, "计划级兜底 pct");

// 4. 悲观/乐观分离：两个池一快一慢
const s4 = summarizePools([
  { name: "A", percent_used: 95, total: 1000, used: 950, remaining: 50 },
  { name: "B", percent_used: 10, total: 1000, used: 100, remaining: 900 },
]);
eq(Math.round(s4.bestPct), 90, "bestPct 取最宽松");
eq(Math.round(s4.worstPct), 5, "worstPct 取最紧");
eq(s4.worstTokens, 50, "worstTokens 取最紧池");

// 5. 客户端日志信号 → 池统计（用日志里的真实数字）
const sig = poolStatsFromSignals(
  [
    { entitlement_id: "ent_2_0817_glm_5p3", show_name: "GLM-5.3", total: 3000000, remaining: 3000000 },
    { entitlement_id: "ent_2_0817_glm_5p3f", show_name: "GLM-5.3-Flash", total: 5000000, remaining: 180535 },
  ],
  "GLM-5.3-Flash",
);
ok(sig && sig.matched, "日志信号命中关注模型");
ok(Math.abs(sig.bestPct - 3.6107) < 0.01, `日志信号 Flash 剩余 3.61%，实际 ${sig.bestPct}`);
eq(sig.worstTokens, 180535, "日志信号剩余 token");

// 6. 烧速与 ETA：用真实日志序列
const t0 = 1_000_000;
let hist = [];
hist = pushSample(hist, sampleFrom(poolStatsFromSignals([
  { show_name: "GLM-5.3-Flash", total: 5000000, remaining: 2843432 },
], "GLM-5.3-Flash"), t0));
hist = pushSample(hist, sampleFrom(poolStatsFromSignals([
  { show_name: "GLM-5.3-Flash", total: 5000000, remaining: 1179775 },
], "GLM-5.3-Flash"), t0 + 169_000));
eq(hist.length, 2, "采样入队");
const rate = burnRate(hist, "totalTokens");
ok(Math.abs(rate - 9853) < 300, `烧速≈9.85K tok/s，实际 ${Math.round(rate)}`);
const eta = etaOf(hist);
ok(eta && eta.basis === "tokens", "ETA 走 token 基准");
ok(Math.abs(eta.sec - 119.7) < 10, `ETA≈120s，实际 ${Math.round(eta.sec)}s`);

// 6b. 直接用日志的前后两个快照算速率（含新发放池的干扰：新池 id 不在前快照里 → 不参与）
const pr = poolsRate(
  [
    { entitlement_id: "A", show_name: "GLM-5.3-Flash", total: 5000000, remaining: 2843432 },
    { entitlement_id: "B", show_name: "GLM-5.3", total: 3000000, remaining: 3000000 },
  ],
  t0,
  [
    { entitlement_id: "A", show_name: "GLM-5.3-Flash", total: 5000000, remaining: 1179775 },
    { entitlement_id: "C", show_name: "GLM-5.3-Flash", total: 5000000, remaining: 4530659 },
    { entitlement_id: "B", show_name: "GLM-5.3", total: 3000000, remaining: 3000000 },
  ],
  t0 + 169_000,
  "GLM-5.3-Flash",
);
ok(pr && Math.abs(pr.rate - 9853) < 300, `poolsRate≈9.85K tok/s，实际 ${pr ? Math.round(pr.rate) : "null"}`);
eq(pr.remaining, 1179775, "poolsRate 只用两快照共有的池求和");
eq(poolsRate([], t0, [], t0 + 60000, ""), null, "空快照不算速率");
eq(poolsRate([{ entitlement_id: "A", remaining: 1 }], t0, [{ entitlement_id: "A", remaining: 2 }], t0 + 5_000, ""), null, "间隔太短不算速率");

// 7. 补发/重置不可比（剩余变多时不算负速率）
let h2 = [sampleFrom({ bestPct: 1, worstPct: 1, bestTokens: 100, worstTokens: 100, totalTokens: 100 }, t0),
          sampleFrom({ bestPct: 90, worstPct: 90, bestTokens: 9000, worstTokens: 9000, totalTokens: 9000 }, t0 + 60_000)];
eq(burnRate(h2, "totalTokens"), 0, "补发后不产生负速率");

// 8. dt 太小不估速率
let h3 = [sampleFrom({ bestPct: 50, worstPct: 50, totalTokens: 5000 }, t0),
          sampleFrom({ bestPct: 49, worstPct: 49, totalTokens: 4900 }, t0 + 5000)];
eq(burnRate(h3, "totalTokens"), 0, "采样间隔过短不算速率");
eq(etaSeconds(0, 10), 0, "剩余为 0 → ETA 0");
eq(etaSeconds(1000, 0), null, "速率为 0 → ETA 未知");

// ---------- evaluate：决策矩阵 ----------
const base = {
  now: 2_000_000,
  opts: { ...AS_DEFAULTS, threshold: 15, marginSec: 120, cooldownMs: 120_000 },
  active: { id: "A", name: "A号" },
  lastSwitchAt: 0,
  manual: false,
};
const cand = (id, pct, extra = {}) => ({ id, name: id, pct, gift: false, level: "ok", ageMs: 1000, ...extra });

// 8.1 ETA 提前触发（剩余 25% 但 60s 内烧完 → 提前切，且不受冷却限制）
const r81 = evaluate({
  ...base,
  lastSwitchAt: base.now - 30_000, // 冷却中
  cur: { pct: 25, etaSec: 60, level: "ok", ageMs: 1000 },
  candidates: [cand("B", 80)],
});
eq(r81.action, "switch", "ETA 命中 → 提前切换");
eq(r81.reason, "eta", "原因=eta");
eq(r81.emergency, true, "预测式触发视为紧急（豁免冷却）");

// 8.2 百分比命中，候选充足
const r82 = evaluate({ ...base, cur: { pct: 12, etaSec: null, level: "low", ageMs: 1000 }, candidates: [cand("B", 60)] });
eq(r82.action, "switch", "阈值命中 → 切换");
eq(r82.reason, "pct", "原因=pct");
eq(r82.target.id, "B", "目标=B");
eq(r82.degrade, false, "候选充足不降级");

// 8.3 无 ≥阈值候选 → 降级切「还有额度」的最好账号
const r83 = evaluate({ ...base, cur: { pct: 5, etaSec: null, level: "low", ageMs: 1000 }, candidates: [cand("B", 8), cand("C", 3)] });
eq(r83.action, "switch", "无达标候选时仍切（降级）");
eq(r83.degrade, true, "标记降级");
eq(r83.target.id, "B", "降级取剩余最高");

// 8.4 全部为 0 / 鉴权失效 → 不切（无可切目标）
const r84 = evaluate({
  ...base,
  cur: { pct: 0, etaSec: 0, level: "dead", ageMs: 1000 },
  candidates: [cand("B", 0), cand("C", 0, { level: "auth" })],
});
eq(r84.action, "wait", "无可切目标时不切");
eq(r84.reason, "noCand", "原因=noCand");

// 8.5 冷却生效（百分比路径 + 无紧急信号）
const r85 = evaluate({ ...base, lastSwitchAt: base.now - 30_000, cur: { pct: 10, etaSec: null, level: "low", ageMs: 1000 }, candidates: [cand("B", 60)] });
eq(r85.action, "wait", "冷却期内不切");
eq(r85.reason, "cooldown", "原因=cooldown");

// 8.6 保护窗：刚切完 5s，即使预测式也不切
const r86 = evaluate({ ...base, lastSwitchAt: base.now - 5_000, cur: { pct: 25, etaSec: 10, level: "ok", ageMs: 500 }, candidates: [cand("B", 90)] });
eq(r86.action, "wait", "保护窗内不切");
eq(r86.reason, "hardGrace", "原因=hardGrace");

// 8.7 陈旧 + 无百分比 → 要求刷新（不拿旧数据当真值）
const r87 = evaluate({ ...base, cur: { pct: null, etaSec: null, level: "unknown", ageMs: 5 * 60_000, stale: true }, candidates: [cand("B", 90)] });
eq(r87.action, "refresh", "陈旧无数据 → 先刷新");
eq(r87.reason, "stale", "原因=stale");

// 8.8 陈旧但看似安全 → 也要刷新一次
const r88 = evaluate({ ...base, cur: { pct: 70, etaSec: 9999, level: "ok", ageMs: 5 * 60_000, stale: true }, candidates: [cand("B", 90)] });
eq(r88.action, "refresh", "陈旧安全样本也要刷新");
eq(r88.reason, "staleSafe", "原因=staleSafe");

// 8.9 客户端硬信号：计划不可用（hasActiveStartPlan=false）→ 立即切
const r89 = evaluate({ ...base, cur: { pct: null, planUnavailable: true, level: "dead", ageMs: 2000 }, candidates: [cand("B", 40)] });
eq(r89.action, "switch", "计划不可用 → 立即切");
eq(r89.reason, "planDown", "原因=planDown");

// 8.10 降级路径：不达标且改善不够（相对）→ 不切
const r810 = evaluate({
  ...base,
  opts: { ...base.opts, threshold: 20 },
  cur: { pct: 14, etaSec: null, level: "low", ageMs: 1000 },
  candidates: [cand("B", 16)],
});
eq(r810.action, "wait", "降级路径改善不足不切");
eq(r810.reason, "noImprove", "原因=noImprove");

// 8.10b 目标不比当前好 → 绝不切
const r810b = evaluate({ ...base, cur: { pct: 14, etaSec: null, level: "low", ageMs: 1000 }, candidates: [cand("B", 13), cand("C", 12)] });
eq(r810b.action, "wait", "目标更差时不切");

// 8.10c 降级切换不受紧急豁免：受冷却限制
const r810c = evaluate({
  ...base,
  lastSwitchAt: base.now - 30_000,
  cur: { pct: 4, etaSec: null, level: "low", ageMs: 1000 },
  candidates: [cand("B", 9)],
});
eq(r810c.action, "wait", "降级切换受冷却约束");
eq(r810c.reason, "cooldown", "降级路径冷却原因");

// 8.10d avoid：最近切出过的账号不选（防乒乓）
const r810d = evaluate({
  ...base,
  opts: { ...base.opts, avoid: ["B"] },
  cur: { pct: 5, etaSec: null, level: "low", ageMs: 1000 },
  candidates: [cand("B", 90), cand("C", 40)],
});
eq(r810d.target.id, "C", "avoid 名单内的账号不选");

// 8.11 manual（手动刷新后触发）豁免冷却与改善门槛
const r811 = evaluate({ ...base, manual: true, lastSwitchAt: base.now - 1000, cur: { pct: 14, etaSec: null, level: "low", ageMs: 0 }, candidates: [cand("B", 16)] });
eq(r811.action, "switch", "manual 豁免冷却/改善门槛");

// 8.12 排序：礼物/临期插队
const rt = rankTargets([cand("B", 50), cand("C", 40, { gift: true })], { threshold: 15 });
eq(rt.ranked[0].id, "C", "临期礼物账号插队");
eq(rt.degraded, false, "有达标候选不算降级");

// 8.13 展示用 ETA 文案
eq(fmtEta(45), "45s", "fmtEta 秒");
eq(fmtEta(600), "10min", "fmtEta 分");
eq(fmtEta(null), null, "fmtEta 无值");

if (failed) {
  console.error(`\n✗ 自动切换决策自检失败：${failed} 项（通过 ${passed}）`);
  process.exit(1);
}
console.log(`✓ 自动切换决策自检 OK（${passed} 项）`);
