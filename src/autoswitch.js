// 低额度自动切换的纯决策逻辑（不依赖 DOM / Tauri，可单独测试）。
//
// 设计要点（与旧实现的关键差异）：
// 1) 触发从「事后越线」改为「事前预测」：除了 剩余% ≤ 阈值，还看 剩余时间(ETA) ≤ 安全余量。
//    百分比阈值在小额度池上只有几十秒余量、在大额度池上又过于保守；ETA 是尺度无关的。
// 2) ETA 用「最快枯竭的那个池」算（悲观），百分比触发仍沿用「最宽松的池」（乐观，保持旧行为不突变）。
//    这样既不会过早切换，又能在真正会阻塞会话的池耗尽前留出提前量。
// 3) 判定必须看数据新鲜度：陈旧样本不再当真值用，而是要求先刷新（action:"refresh"）。
// 4) 无候选时不放弃：降级切「还有额度的最好账号」，并把降级原因暴露给用户。

import { planExpired, modelKeyMatch } from "./list.js";

/** 决策参数默认值（main.js 按运行期轮询间隔覆盖 marginSec） */
export const AS_DEFAULTS = {
  /** 百分比阈值（剩余%），兜底触发条件 */
  threshold: 15,
  /** 安全余量（秒）：ETA 低于它就提前切 */
  marginSec: 120,
  /** 非紧急切换的冷却（毫秒）——避免来回横跳 */
  cooldownMs: 120 * 1000,
  /** 百分比触发时，目标至少要比当前高出的百分点（默认 0：主要靠「必须达标 + 严格更好」防横跳，留作调节旋钮） */
  minImprove: 0,
  /** 当前账号样本最大年龄（毫秒）：超龄不判定，先刷新 */
  activeStaleMs: 45 * 1000,
  /** 候选样本最大年龄（毫秒）：超龄先做切换前预校验 */
  targetFreshMs: 120 * 1000,
  /** 刚切完的保护窗（毫秒）：防止重复触发 */
  hardGraceMs: 20 * 1000,
  /** 单次决策最多做几次候选预校验（网络开销上限） */
  maxPreflight: 2,
};

/** 额度池条目分类：只保留「额度池/模型」条目，跳过 提示次数 / 使用时长 这类窗口 */
function kindOf(it) {
  if (it?.kind) return it.kind;
  const n = String(it?.name || "");
  if (n.includes("提示次数")) return "prompt_count";
  if (n.includes("使用时长")) return "duration";
  return "raw";
}

/** 未过期套餐（过期套餐只是留档，额度不可用） */
function livePlans(q) {
  return (q?.data?.plans || []).filter((p) => !planExpired(p));
}

function pctOf(item) {
  const p = Number(item?.percent_used);
  if (item?.percent_used != null && isFinite(p)) return Math.max(0, Math.min(100, 100 - p));
  const total = Number(item?.total);
  const used = Number(item?.used);
  if (isFinite(total) && total > 0 && isFinite(used)) return Math.max(0, Math.min(100, (1 - used / total) * 100));
  if (isFinite(Number(item?.remaining)) && isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, (Number(item.remaining) / total) * 100));
  }
  return null;
}

function tokensOf(item) {
  const rem = Number(item?.remaining);
  if (item?.remaining != null && isFinite(rem)) return rem;
  const total = Number(item?.total);
  const used = Number(item?.used);
  if (isFinite(total) && total > 0 && isFinite(used)) return total - used;
  return null;
}

/**
 * 把一组额度项汇总成判定用的池统计。
 * best = 最宽松的池（乐观，用于百分比阈值触发，保持旧行为）
 * worst = 最快枯竭的池（悲观，用于 ETA 提前量）
 */
export function summarizePools(list) {
  const rows = [];
  for (const it of list || []) {
    if (!it || typeof it.name !== "string") continue;
    const pct = pctOf(it);
    if (pct == null) continue;
    rows.push({ name: it.name, pct, tokens: tokensOf(it) });
  }
  if (!rows.length) return null;
  let best = rows[0];
  let worst = rows[0];
  let tokenRows = 0;
  let totalTokens = 0;
  for (const r of rows) {
    if (r.pct > best.pct) best = r;
    if (r.pct < worst.pct) worst = r;
    if (r.tokens != null && isFinite(r.tokens)) {
      tokenRows++;
      totalTokens += r.tokens;
    }
  }
  return {
    count: rows.length,
    bestPct: best.pct,
    worstPct: worst.pct,
    worstName: worst.name,
    bestTokens: best.tokens != null && isFinite(best.tokens) ? best.tokens : null,
    worstTokens: worst.tokens != null && isFinite(worst.tokens) ? worst.tokens : null,
    totalTokens: tokenRows ? totalTokens : null,
  };
}

/**
 * 从后端 QuotaOverview 取池统计。
 * model 命中不到任何条目时返回 matched:false，调用方按旧行为回退到「全部池的最宽松值」。
 */
export function poolStats(q, model) {
  const d = q?.data;
  if (!d) return null;
  const key = String(model || "").trim().toLowerCase();
  const all = [];
  const collect = (arr) => {
    for (const it of arr || []) {
      if (!it || typeof it.name !== "string") continue;
      if (kindOf(it) !== "raw") continue;
      all.push(it);
    }
  };
  collect(d.items);
  for (const p of livePlans(q)) collect(p.items);
  // 极端情况：没有 items，只有计划级数字
  if (!all.length) {
    for (const p of livePlans(q)) {
      if (p && p.name && (p.percent_used != null || p.total != null)) all.push(p);
    }
  }
  if (!all.length) return null;
  const matched = key ? all.filter((it) => modelKeyMatch(it.name.toLowerCase(), key)) : [];
  const useMatched = matched.length > 0;
  const s = summarizePools(useMatched ? matched : all);
  if (!s) return null;
  return { ...s, matched: useMatched && !!key, model: key || null, scope: useMatched ? "focus" : "all" };
}

/** 客户端日志信号里的池（[{show_name,total,used,remaining}]）→ 与 poolStats 同形状 */
export function poolStatsFromSignals(pools, model) {
  const list = [];
  for (const p of pools || []) {
    const name = String(p?.show_name || p?.name || "").trim();
    if (!name) continue;
    const total = Number(p?.total);
    const remaining = Number(p?.remaining);
    list.push({
      name,
      total: isFinite(total) && total > 0 ? total : null,
      remaining: isFinite(remaining) ? remaining : null,
      percent_used: isFinite(total) && total > 0 && isFinite(remaining) ? 100 - (remaining / total) * 100 : null,
    });
  }
  if (!list.length) return null;
  const key = String(model || "").trim().toLowerCase();
  const matched = key ? list.filter((it) => modelKeyMatch(it.name.toLowerCase(), key)) : [];
  const useMatched = matched.length > 0;
  const s = summarizePools(useMatched ? matched : list);
  if (!s) return null;
  return { ...s, matched: useMatched && !!key, model: key || null, scope: useMatched ? "focus" : "all" };
}

/** 采样点：用于算消耗速率（烧速）。
 * totalTokens = 该模型全部匹配池的剩余之和（与 poolsRate 同口径，跨池变动更稳） */
export function sampleFrom(stats, at) {
  if (!stats) return null;
  return {
    at,
    bestPct: stats.bestPct,
    worstPct: stats.worstPct,
    bestTokens: stats.bestTokens ?? null,
    worstTokens: stats.worstTokens ?? null,
    totalTokens: stats.totalTokens ?? null,
  };
}

/**
 * 直接用客户端日志的「前后两个余额快照」算速率（不依赖本地采样）。
 * 只统计两个快照里都存在的 entitlement（新发放/过期的池不参与，避免把补发当成负消耗）。
 * @returns {{rate:number, dtSec:number, remaining:number}|null} rate 单位 token/秒
 */
export function poolsRate(prevPools, prevAt, curPools, curAt, model) {
  if (!Array.isArray(prevPools) || !prevPools.length || !Array.isArray(curPools) || !curPools.length) return null;
  const dtSec = (Number(curAt) - Number(prevAt)) / 1000;
  if (!isFinite(dtSec) || dtSec < 20) return null;
  const key = String(model || "").trim().toLowerCase();
  const pick = (arr) => {
    const m = new Map();
    for (const p of arr || []) {
      const name = String(p?.show_name || p?.name || "").trim();
      if (!name) continue;
      if (key && !modelKeyMatch(name.toLowerCase(), key)) continue;
      const rem = Number(p?.remaining);
      if (!isFinite(rem)) continue;
      m.set(String(p?.entitlement_id || name), rem);
    }
    return m;
  };
  const a = pick(prevPools);
  const b = pick(curPools);
  let sumA = 0;
  let sumB = 0;
  let n = 0;
  for (const [id, remB] of b) {
    if (!a.has(id)) continue;
    sumA += a.get(id);
    sumB += remB;
    n++;
  }
  if (!n) return null;
  if (sumA <= sumB) return { rate: 0, dtSec, remaining: sumB };
  return { rate: (sumA - sumB) / dtSec, dtSec, remaining: sumB };
}

const HIST_MAX = 12;
const HIST_KEEP_MS = 10 * 60 * 1000;

/** 采样环形缓冲：按时间升序，超出窗口/条数就丢弃最旧的 */
export function pushSample(hist, s, max = HIST_MAX) {
  const arr = Array.isArray(hist) ? hist.slice() : [];
  if (s && s.at) {
    arr.push(s);
    arr.sort((a, b) => a.at - b.at);
  }
  const cutoff = (arr.length ? arr[arr.length - 1].at : Date.now()) - HIST_KEEP_MS;
  const out = arr.filter((x) => x.at >= cutoff);
  return out.slice(-max);
}

/** 最近一次「非零变化」的速率：单位/秒（正数表示在减少）。dt 太小或数据不单调时返回 0 */
export function burnRate(hist, field = "worstTokens", minDtMs = 20000) {
  if (!Array.isArray(hist) || hist.length < 2) return 0;
  const now = hist[hist.length - 1];
  if (now[field] == null || !isFinite(now[field])) return 0;
  // 从最新往回找第一个「值更大且时间差足够」的采样点
  for (let i = hist.length - 2; i >= 0; i--) {
    const old = hist[i];
    if (old[field] == null || !isFinite(old[field])) continue;
    const dt = now.at - old.at;
    if (dt < minDtMs) continue;
    if (old[field] <= now[field]) continue; // 期间有补发/重置，不可比
    return (old[field] - now[field]) / (dt / 1000);
  }
  return 0;
}

/** 剩余时间（秒）；速率无效时返回 null（表示算不出，不做提前触发） */
export function etaSeconds(remaining, rate) {
  if (remaining == null || !isFinite(remaining) || remaining <= 0) return 0;
  if (!rate || !isFinite(rate) || rate <= 0) return null;
  return remaining / rate;
}

/** 由采样历史得到当前账号的 ETA（token 优先，退化到百分比） */
export function etaOf(hist) {
  if (!Array.isArray(hist) || !hist.length) return null;
  const last = hist[hist.length - 1];
  if (last.totalTokens != null && isFinite(last.totalTokens)) {
    const r = burnRate(hist, "totalTokens");
    const eta = etaSeconds(last.totalTokens, r);
    if (eta != null) return { sec: eta, basis: "tokens", rate: r, remaining: last.totalTokens };
  }
  if (last.worstPct != null && isFinite(last.worstPct)) {
    const r = burnRate(hist, "worstPct");
    const eta = etaSeconds(last.worstPct, r);
    if (eta != null) return { sec: eta, basis: "pct", rate: r, remaining: last.worstPct };
  }
  return null;
}

/**
 * 候选排序：非流转优先（关注模型还有额度的账号先选）→ 礼物/临期插队 → 剩余降序。
 * avoid：最近切出过的账号（防 A→B→A 乒乓）；若排除后为空则忽略它。
 * @param {Array} cands [{id,name,pct,gift,flowed,fallback,modelMatched,level,ageMs}]
 */
export function rankTargets(cands, opts = AS_DEFAULTS) {
  const thr = Number(opts.threshold ?? AS_DEFAULTS.threshold);
  const avoid = opts.avoid instanceof Set ? opts.avoid : new Set(opts.avoid || []);
  const usable = (cands || []).filter(
    (c) => c && c.pct != null && isFinite(c.pct) && c.level !== "auth" && c.level !== "fail",
  );
  const alive = usable.filter((c) => c.pct > 0);
  const ok = alive.filter((c) => c.pct >= thr);
  const order = ok.length ? ok : alive;
  const flowed = (c) => (c.flowed || c.fallback ? 1 : 0);
  const sorted = order
    .slice()
    .sort(
      (a, b) =>
        flowed(a) - flowed(b) || (b.gift ? 1 : 0) - (a.gift ? 1 : 0) || b.pct - a.pct,
    );
  const fresh = sorted.filter((c) => !avoid.has(c.id));
  const ranked = fresh.length ? fresh : sorted;
  return { ranked, degraded: !ok.length && alive.length > 0 };
}

/**
 * 纯决策：要不要切、切哪一类目标、什么原因。
 * 网络相关的「切换前预校验」由调用方按 ranked 顺序做（本函数不做 IO）。
 *
 * @returns {{action:"none"|"wait"|"refresh"|"switch", reason:string, emergency?:boolean,
 *            degrade?:boolean, target?:object, ranked?:object[], etaSec?:number|null}}
 */
export function evaluate(input) {
  const opts = { ...AS_DEFAULTS, ...(input.opts || {}) };
  const { now, active, cur, manual } = input;
  const lastSwitchAt = Number(input.lastSwitchAt || 0);
  const thr = Number(opts.threshold);
  if (!active) return { action: "none", reason: "noActive" };

  // 刚切完的保护窗：任何路径都不允许立刻再切
  if (!manual && now - lastSwitchAt < opts.hardGraceMs) return { action: "wait", reason: "hardGrace" };

  const pct = cur?.pct == null || !isFinite(cur.pct) ? null : cur.pct;
  const planDown = !!cur?.planUnavailable;
  const etaSec = cur?.etaSec != null && isFinite(cur.etaSec) ? cur.etaSec : null;

  // 数据新鲜度：陈旧样本不当真值，先要求刷新
  // （唯一例外：「计划不可用」是客户端自己的硬信号，不需要百分比也能判定）
  if (pct == null && !planDown) {
    return cur?.stale ? { action: "refresh", reason: "stale" } : { action: "wait", reason: "noData" };
  }

  const auth = cur?.level === "auth";
  const zero = pct != null && pct <= 0;
  const etaHit = etaSec != null && etaSec <= opts.marginSec;
  const pctHit = pct != null && pct <= thr;
  const trigger = planDown || zero || pctHit || etaHit || auth;
  if (!trigger) {
    // 陈旧但还判定为安全 → 依然要求刷新一次（避免用旧数当"安全"证据）
    if (cur?.stale && pct != null) return { action: "refresh", reason: "staleSafe", etaSec };
    return { action: "none", reason: "ok", etaSec };
  }
  const reason = planDown ? "planDown" : auth ? "auth" : zero ? "zero" : etaHit ? "eta" : "pct";
  // 紧急 = 预测式 / 硬信号：不受冷却限制（否则刚切过去就烧完的号要干等）
  const emergency = reason !== "pct";
  if (!manual && !emergency && now - lastSwitchAt < opts.cooldownMs) {
    return { action: "wait", reason: "cooldown", etaSec };
  }

  const { ranked, degraded } = rankTargets(input.candidates, opts);
  if (!ranked.length) return { action: "wait", reason: "noCand", emergency, etaSec };

  const best = ranked[0];
  const gain = pct == null ? Infinity : best.pct - pct;
  // 目标必须严格更好，绝不把好号换掉；降级路径（无达标候选）要求相对改善更明显
  if (!manual) {
    if (best.pct <= pct) return { action: "wait", reason: "noImprove", ranked, etaSec };
    if (degraded) {
      if (gain < Math.max(3, pct * 0.5)) return { action: "wait", reason: "noImprove", ranked, etaSec };
    } else if (!emergency && gain < Number(opts.minImprove ?? 0)) {
      return { action: "wait", reason: "noImprove", ranked, etaSec };
    }
  }
  // 降级切换（没有达标候选）不受冷却豁免：最多每 cooldownMs 降级一次，避免在低位账号之间横跳
  const effEmergency = emergency && !degraded;
  if (!manual && !effEmergency && now - lastSwitchAt < opts.cooldownMs) {
    return { action: "wait", reason: "cooldown", ranked, etaSec };
  }

  return { action: "switch", reason, emergency: effEmergency, degrade: degraded, target: best, ranked, etaSec };
}

/** ETA 的人类可读文案（供 tooltip 用；无 i18n 依赖） */
export function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return null;
  if (sec <= 0) return "0s";
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}min`;
  return `${(sec / 3600).toFixed(1)}h`;
}
