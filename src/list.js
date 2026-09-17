// 账号列表的纯逻辑：额度健康度 / 搜索 / 筛选 / 排序 / 分桶 / 合计
// 不依赖 DOM，便于单独测试。

/** 健康度分级（也是列表里的展示顺序，越靠前越"可用"） */
export const HEALTH_ORDER = ["ok", "low", "dead", "auth", "fail", "unknown"];

/** 剩余额度低于该百分比视为"紧张" */
export const LOW_THRESHOLD = 20;

/**
 * 从 QuotaOverview 计算"剩余额度百分比"（0-100，100 = 完全没用）。
 * 多套餐 / 多窗口时取"最好的那个"（只要有一份还能用，账号就还能用）。
 */
export function quotaRemainingPct(q) {
  const d = q?.data;
  if (!d) return null;
  const pcts = [];
  const push = (v) => {
    const n = Number(v);
    if (v != null && isFinite(n)) pcts.push(n);
  };
  push(d.percent_used);
  for (const p of d.plans || []) push(p.percent_used);
  for (const it of d.items || []) push(it.percent_used);
  if (!pcts.length && d.total != null && d.used != null && d.total > 0) {
    push((d.used / d.total) * 100);
  }
  if (!pcts.length) return null;
  const bestUsed = Math.min(...pcts);
  return Math.max(0, Math.min(100, 100 - bestUsed));
}

/**
 * 关注模型（可选）：只统计名称命中该模型的额度项（不区分大小写，子串匹配）。
 * 命中 → 返回该模型的剩余百分比；未命中 → null（调用方回退到总额度）。
 */
export function modelRemainingPct(q, model) {
  const key = String(model || "").trim().toLowerCase();
  if (!key) return null;
  const d = q?.data;
  if (!d) return null;
  const pcts = [];
  const consider = (it) => {
    if (!it || typeof it.name !== "string") return;
    if (!it.name.toLowerCase().includes(key)) return;
    const p = Number(it.percent_used);
    if (isFinite(p)) { pcts.push(p); return; }
    const total = Number(it.total);
    const used = Number(it.used);
    if (isFinite(total) && total > 0 && isFinite(used)) pcts.push((used / total) * 100);
  };
  for (const it of d.items || []) consider(it);
  for (const p of d.plans || []) for (const it of p.items || []) consider(it);
  if (!pcts.length) return null;
  const bestUsed = Math.min(...pcts);
  return Math.max(0, Math.min(100, 100 - bestUsed));
}

/**
 * 账号健康度：以额度为主，额度查不到时回退到快照信号。
 * 传了 model 时优先用该模型的额度，modelMatched 表示是否命中。
 * 返回 { level, remainingPct, modelMatched }
 */
export function healthOf(acct, quota, isAuthErr, model) {
  if (quota?.err) {
    return { level: isAuthErr && isAuthErr(quota) ? "auth" : "fail", remainingPct: null, modelMatched: false };
  }
  const mp = modelRemainingPct(quota, model);
  const pct = mp != null ? mp : quotaRemainingPct(quota);
  if (pct != null) {
    if (pct <= 0) return { level: "dead", remainingPct: 0, modelMatched: mp != null };
    if (pct <= LOW_THRESHOLD) return { level: "low", remainingPct: pct, modelMatched: mp != null };
    return { level: "ok", remainingPct: pct, modelMatched: mp != null };
  }
  // 没有额度数据时的回退信号
  if (acct?.has_user_info === false) return { level: "auth", remainingPct: null, modelMatched: false };
  return { level: "unknown", remainingPct: null, modelMatched: false };
}

/** 搜索匹配：名称 / 用户名 / 邮箱 / 分组 / 提供方 */
export function matchesSearch(acct, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const id = acct?.identity || {};
  const hay = [acct?.name, id.username, id.email, id.display_name, acct?.group]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/**
 * 搜索 + 健康度筛选。
 * @param healthMap Map<id, {level, remainingPct}>
 */
export function filterAccounts(accounts, { search = "", health = "all" } = {}, healthMap) {
  return (accounts || []).filter((a) => {
    if (health !== "all") {
      const h = healthMap?.get(a.id);
      if (!h || h.level !== health) return false;
    }
    return matchesSearch(a, search);
  });
}

/**
 * 排序。
 * quota: 健康度分级优先（充足→…→待查询），同级按剩余额度降序
 * name / created / updated: 文本或时间序
 */
export function sortAccounts(accounts, sort, healthMap, localeTag = "zh-CN") {
  const arr = [...(accounts || [])];
  const pctOf = (a) => {
    const p = healthMap?.get(a.id)?.remainingPct;
    return p == null ? -1 : p;
  };
  const rankOf = (a) => {
    const lv = healthMap?.get(a.id)?.level || "unknown";
    const i = HEALTH_ORDER.indexOf(lv);
    return i < 0 ? HEALTH_ORDER.length : i;
  };
  const byName = (a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), localeTag, { sensitivity: "base" });
  switch (sort) {
    case "name":
      return arr.sort(byName);
    case "updated":
      return arr.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || byName(a, b));
    case "created":
      return arr.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || byName(a, b));
    case "quota":
    default:
      return arr.sort((a, b) => rankOf(a) - rankOf(b) || pctOf(b) - pctOf(a) || byName(a, b));
  }
}

/**
 * 分组：自定义分组优先，未分组的按健康度分桶。
 * 返回 [{ key, label, kind: 'group'|'health', items: [] }]，顺序：
 *   自定义分组（按名称） → 健康度桶（HEALTH_ORDER）
 */
export function bucketAccounts(accounts, { localeTag = "zh-CN", healthLabel = () => "" } = {}, healthMap) {
  const buckets = new Map();
  for (const a of accounts) {
    const g = String(a.group || "").trim();
    const h = healthMap?.get(a.id)?.level || "unknown";
    const key = g ? `g:${g}` : `h:${h}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: g || healthLabel(h),
        kind: g ? "group" : "health",
        items: [],
      });
    }
    buckets.get(key).items.push(a);
  }
  const custom = [...buckets.values()]
    .filter((b) => b.kind === "group")
    .sort((x, y) => x.label.localeCompare(y.label, localeTag, { sensitivity: "base" }));
  const health = HEALTH_ORDER.map((lv) => buckets.get(`h:${lv}`)).filter(Boolean);
  return [...custom, ...health];
}

/**
 * 合计：各健康度计数 + 平均剩余额度百分比（仅统计已拿到额度的账号，单位无关）。
 */
export function summarize(accounts, healthMap) {
  const counts = { ok: 0, low: 0, dead: 0, auth: 0, fail: 0, unknown: 0 };
  let pctSum = 0;
  let pctCount = 0;
  for (const a of accounts || []) {
    const h = healthMap?.get(a.id);
    const lv = h?.level || "unknown";
    if (counts[lv] == null) counts.unknown++;
    else counts[lv]++;
    if (h?.remainingPct != null) {
      pctSum += h.remainingPct;
      pctCount++;
    }
  }
  return { counts, avgRemainingPct: pctCount ? pctSum / pctCount : null, known: pctCount };
}
