// 低额度自动切换的纯决策逻辑（不依赖 DOM / Tauri，可单独测试）。
//
// 设计要点（与旧实现的关键差异）：
// 1) 触发从「事后越线」改为「事前预测」：除了 剩余% ≤ 阈值，还看 剩余时间(ETA) ≤ 安全余量。
//    百分比阈值在小额度池上只有几十秒余量、在大额度池上又过于保守；ETA 是尺度无关的。
// 2) ETA 用「最快枯竭的那个池」算（悲观），百分比触发仍沿用「最宽松的池」（乐观，保持旧行为不突变）。
//    这样既不会过早切换，又能在真正会阻塞会话的池耗尽前留出提前量。
// 3) 判定必须看数据新鲜度：陈旧样本不再当真值用，而是要求先刷新（action:"refresh"）。
// 4) 无候选时不放弃：降级切「还有额度的最好账号」，并把降级原因暴露给用户。

import { planExpired, planIsGift, giftKindOfPlan, modelKeyMatch } from "./list.js";

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

/** 未过期礼物/常规池的分类元数据：kind（weekend/global/其它礼物）+ 到期时间戳（临期优先排序用） */
function planExpireMs(s) {
  const txt = String(s || "");
  if (!txt) return null;
  const hasTime = txt.length >= 16;
  const ms = new Date(hasTime ? txt.replace(" ", "T") : txt + "T23:59:59").getTime();
  return isFinite(ms) ? ms : null;
}

/**
 * 把一组额度项汇总成判定用的池统计。
 * best = 最宽松的池（乐观，用于百分比阈值触发，保持旧行为）
 * worst = 最快枯竭的池（悲观，用于 ETA 提前量）
 * 条目可带 gift（true=礼物/赠送池，false=常规池）与 giftKind/expireMs（礼物细分与到期）：
 * 额外给出礼物/常规两个口径的拆分（giftPct/giftTokens/regPct/regTokens），
 * 以及礼物侧的细分（giftKinds）与最早到期（giftExpireMs），「优先消耗礼物套餐」判定用。
 * @returns {{count,bestPct,worstPct,worstName,bestTokens,worstTokens,totalTokens,
 *            giftPct,giftTokens,regPct,regTokens,giftKinds,giftExpireMs}}
 */
export function summarizePools(list) {
  const rows = [];
  for (const it of list || []) {
    if (!it || typeof it.name !== "string") continue;
    const pct = pctOf(it);
    if (pct == null) continue;
    const t = Number(it.total);
    rows.push({
      name: it.name,
      pct,
      tokens: tokensOf(it),
      total: t != null && isFinite(t) && t > 0 ? t : null,
      gift: it.gift === true ? true : it.gift === false ? false : null,
      giftKind: it.giftKind ?? null,
      expireMs: it.expireMs ?? null,
    });
  }
  if (!rows.length) return null;
  let best = rows[0];
  let worst = rows[0];
  let tokenRows = 0;
  let totalTokens = 0;
  let giftPct = null;
  let giftTokens = 0;
  let regPct = null;
  let regTokens = 0;
  let hasGift = false;
  let hasReg = false;
  let giftExpireMs = null;
  let giftTotalSum = 0;
  let regTotalSum = 0;
  const giftKinds = new Set();
  for (const r of rows) {
    if (r.pct > best.pct) best = r;
    if (r.pct < worst.pct) worst = r;
    const tk = r.tokens != null && isFinite(r.tokens) ? r.tokens : 0;
    if (r.tokens != null && isFinite(r.tokens)) {
      tokenRows++;
      totalTokens += r.tokens;
    }
    if (r.gift === true) {
      hasGift = true;
      giftTokens += tk;
      if (r.total != null) giftTotalSum += r.total;
      if (giftPct == null || r.pct > giftPct) giftPct = r.pct;
      if (r.expireMs != null && (giftExpireMs == null || r.expireMs < giftExpireMs)) giftExpireMs = r.expireMs;
      if (r.giftKind) giftKinds.add(r.giftKind);
    } else if (r.gift === false) {
      hasReg = true;
      regTokens += tk;
      if (r.total != null) regTotalSum += r.total;
      if (regPct == null || r.pct > regPct) regPct = r.pct;
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
    giftPct: hasGift ? giftPct : null,
    giftTokens: hasGift ? giftTokens : null,
    giftTotal: hasGift && giftTotalSum > 0 ? giftTotalSum : null,
    regPct: hasReg ? regPct : null,
    regTokens: hasReg ? regTokens : null,
    regTotal: hasReg && regTotalSum > 0 ? regTotalSum : null,
    giftKinds: hasGift ? [...giftKinds] : [],
    giftExpireMs: hasGift ? giftExpireMs : null,
  };
}

/**
 * 礼物优先判定基准：礼物池还有剩余 → 按礼物池口径判定（pct/token 都取礼物侧）；
 * 礼物全部用尽 → 回落常规池口径；连分类都没有（旧数据/未映射）→ 原样透传。
 */
export function giftFirstBasis(st) {
  if (!st) return null;
  if (st.giftTokens != null && st.giftTokens > 0) {
    // 阈值规模折算：礼物池的切换线 = 常规池在同阈值下会留下的绝对余量。
    // 15% 对 5M 常规池留 75 万，对 1 亿礼物池也该只留 75 万（0.75%）而不是 1500 万——
    // 否则切走时浪费的比一个常规号的满额还多。
    const scale = st.regTotal > 0 && st.giftTotal > 0 ? Math.min(1, st.regTotal / st.giftTotal) : 1;
    return {
      pct: st.giftPct ?? st.bestPct,
      tokens: st.giftTokens,
      basis: "gift",
      thrScale: scale,
      giftKinds: st.giftKinds ?? [],
      giftExpireMs: st.giftExpireMs ?? null,
    };
  }
  if (st.regTokens != null) {
    return { pct: st.regPct ?? st.bestPct, tokens: st.regTokens, basis: "reg", thrScale: 1, giftKinds: [], giftExpireMs: null };
  }
  return { pct: st.bestPct, tokens: st.totalTokens ?? null, basis: "all", thrScale: 1, giftKinds: [], giftExpireMs: null };
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
  const collect = (arr, meta = null) => {
    for (const it of arr || []) {
      if (!it || typeof it.name !== "string") continue;
      if (kindOf(it) !== "raw") continue;
      all.push(meta ? { ...it, ...meta } : it);
    }
  };
  // 只收未过期套餐的池：d.items 是后端「全部套餐（含过期）平铺」，直接收会
  // 1) 与 livePlans 重复计数（token 聚合 ×2）2) 把过期礼物残留灌成可用额度
  // （实测 bestPct 75% 来自过期池）。旧数据没有 plans 数组时才回退平铺 items。
  // 条目附带礼物分类元数据（gift/giftKind/expireMs），「优先消耗礼物套餐」判定用。
  if (Array.isArray(d.plans)) {
    for (const p of livePlans(q)) {
      const gift = planIsGift(p);
      collect(p.items, {
        gift,
        giftKind: gift ? giftKindOfPlan(p) : null,
        expireMs: planExpireMs(p.expire),
      });
    }
  } else {
    collect(d.items);
  }
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

/** 客户端日志信号里的池（[{show_name,total,used,remaining}]）→ 与 poolStats 同形状。
 * entGift：entitlement_id → {gift, giftKind, expireMs}（由 HTTP 套餐数据构建），
 * 日志池本身不带套餐归属，礼物优先判定靠它分类；未映射的池按常规（保守）处理。 */
export function poolStatsFromSignals(pools, model, entGift = null) {
  const list = [];
  for (const p of pools || []) {
    const name = String(p?.show_name || p?.name || "").trim();
    if (!name) continue;
    const total = Number(p?.total);
    const remaining = Number(p?.remaining);
    const m = entGift ? entGift[String(p?.entitlement_id || "").trim()] : null;
    list.push({
      name,
      total: isFinite(total) && total > 0 ? total : null,
      remaining: isFinite(remaining) ? remaining : null,
      percent_used: isFinite(total) && total > 0 && isFinite(remaining) ? 100 - (remaining / total) * 100 : null,
      gift: m ? m.gift === true : null,
      giftKind: m?.giftKind ?? null,
      expireMs: m?.expireMs ?? null,
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
 * totalTokens = 该模型全部匹配池的剩余之和（与 poolsRate 同口径，跨池变动更稳）；
 * model = 采样时的口径模型——口径变化（跟随模型切换）后旧序列不可比，调用方应重开采样 */
export function sampleFrom(stats, at, model = null) {
  if (!stats) return null;
  return {
    at,
    model: model == null ? null : String(model),
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

/** 由采样历史得到当前账号的 ETA（token 优先，退化到百分比）。
 * 注意：百分比基准下 worstPct ≤ 0 表示「最紧的池已经耗尽/过期」（比如用完的礼物池），
 * 不是「马上要耗尽」——返回 null 交给零值/百分比触发去判定，
 * 否则一个常驻 0% 的池会让账号永远 etaSec=0、陷入伪紧急切换（审计实证过 pct 98% 却 eta 0）。 */
export function etaOf(hist) {
  if (!Array.isArray(hist) || !hist.length) return null;
  const last = hist[hist.length - 1];
  if (last.totalTokens != null && isFinite(last.totalTokens)) {
    const r = burnRate(hist, "totalTokens");
    const eta = etaSeconds(last.totalTokens, r);
    if (eta != null) return { sec: eta, basis: "tokens", rate: r, remaining: last.totalTokens };
  }
  if (last.worstPct != null && isFinite(last.worstPct) && last.worstPct > 0) {
    const r = burnRate(hist, "worstPct");
    const eta = etaSeconds(last.worstPct, r);
    if (eta != null) return { sec: eta, basis: "pct", rate: r, remaining: last.worstPct };
  }
  return null;
}

/**
 * 候选排序：非流转优先（关注模型还有额度的账号先选）→ 有礼物额度的账号插队 →
 * 礼物层内按「礼物顺序」配置（auto=越临期越优先 / 指定 weekend|global 优先）→ 绝对余量降序。
 * 同优先级内：全员都有同口径聚合 token（tokens）时按绝对余量降序——百分比在
 * 「最宽池大小不同」的账号之间是伪量纲（90%×450万 不如 50%×4000万）；
 * 有缺失就整体回退百分比，保证比较器全序一致。
 * avoid：最近切出过的账号（防 A→B→A 乒乓）；若排除后为空则忽略它。
 * @param {Array} cands [{id,name,pct,tokens,gift,giftKinds,giftExpireMs,flowed,fallback,modelMatched,level,ageMs}]
 */
export function rankTargets(cands, opts = AS_DEFAULTS) {
  const thr = Number(opts.threshold ?? AS_DEFAULTS.threshold);
  const avoid = opts.avoid instanceof Set ? opts.avoid : new Set(opts.avoid || []);
  const giftOrder = String(opts.giftOrder || "auto");
  const usable = (cands || []).filter(
    (c) => c && c.pct != null && isFinite(c.pct) && c.level !== "auth" && c.level !== "fail",
  );
  const candThr = (c) => (c.thr != null && isFinite(c.thr) ? c.thr : thr);
  const alive = usable.filter((c) => c.pct > 0);
  const ok = alive.filter((c) => c.pct >= candThr(c));
  const order = ok.length ? ok : alive;
  const flowed = (c) => (c.flowed || c.fallback ? 1 : 0);
  // 礼物层内排序键：auto=最早到期的礼物先烧（毫秒，缺失排最后）；指定礼物=持有该礼物的在前
  const giftKey = (c) => {
    if (!c.gift) return 0;
    if (giftOrder === "weekend" || giftOrder === "global") {
      return (c.giftKinds || []).includes(giftOrder) ? 0 : 1;
    }
    return c.giftExpireMs != null ? c.giftExpireMs : Number.MAX_SAFE_INTEGER;
  };
  const byTokens = order.length > 1 && order.every((c) => c.tokens != null && isFinite(c.tokens));
  const sizeKey = (c) => (byTokens ? c.tokens : c.pct);
  const sorted = order
    .slice()
    .sort(
      (a, b) =>
        flowed(a) - flowed(b)
        || (b.gift ? 1 : 0) - (a.gift ? 1 : 0)
        || (a.gift && b.gift ? giftKey(a) - giftKey(b) : 0)
        || sizeKey(b) - sizeKey(a),
    );
  const fresh = sorted.filter((c) => !avoid.has(c.id));
  const ranked = fresh.length ? fresh : sorted;
  return { ranked, degraded: !ok.length && alive.length > 0 };
}

/**
 * 纯决策：要不要切、切哪一类目标、什么原因。
 * 网络相关的「切换前预校验」由调用方按 ranked 顺序做（本函数不做 IO）。
 *
 * cur.hardDown：调用方判定「额度查询连续失败且样本已陈旧」的硬故障
 * （无套餐 500 / 鉴权失效 / 持续风控——数据永远刷不新）。此时旧样本是谎言，
 * 比较基准视为已耗尽：否则「目标必须严格更好」会被旧数据的高百分比永远卡死。
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

  const hardDown = !!cur?.hardDown;
  const planDown = !!cur?.planUnavailable;
  const pctRaw = cur?.pct == null || !isFinite(cur.pct) ? null : cur.pct;
  const pct = hardDown ? -1 : pctRaw;
  const etaSec = cur?.etaSec != null && isFinite(cur.etaSec) ? cur.etaSec : null;
  // 礼物优先时 cur 带规模折算后的阈值（thr），常规口径回落全局阈值
  const curThr = cur?.thr != null && isFinite(cur.thr) ? cur.thr : thr;

  // 数据新鲜度：陈旧样本不当真值，先要求刷新
  // （例外：「计划不可用」是客户端自己的硬信号、hardDown 是连续刷新失败的硬信号，
  //   都不需要百分比也能判定）
  if (pctRaw == null && !planDown && !hardDown) {
    return cur?.stale ? { action: "refresh", reason: "stale" } : { action: "wait", reason: "noData" };
  }

  const auth = cur?.level === "auth";
  const zero = pct != null && pct <= 0;
  const etaHit = etaSec != null && etaSec <= opts.marginSec;
  const pctHit = pct != null && pct <= curThr;
  const trigger = hardDown || planDown || zero || pctHit || etaHit || auth;
  if (!trigger) {
    // 陈旧但还判定为安全 → 依然要求刷新一次（避免用旧数当"安全"证据）
    if (cur?.stale && pctRaw != null) return { action: "refresh", reason: "staleSafe", etaSec };
    return { action: "none", reason: "ok", etaSec };
  }
  const reason = hardDown ? "hardDown" : planDown ? "planDown" : auth ? "auth" : zero ? "zero" : etaHit ? "eta" : "pct";
  // 紧急 = 预测式 / 硬信号：不受冷却限制（否则刚切过去就烧完的号要干等）
  const emergency = reason !== "pct";
  if (!manual && !emergency && now - lastSwitchAt < opts.cooldownMs) {
    return { action: "wait", reason: "cooldown", etaSec };
  }

  const { ranked, degraded } = rankTargets(input.candidates, opts);
  if (!ranked.length) return { action: "wait", reason: "noCand", emergency, etaSec };

  const best = ranked[0];
  const gain = pct == null ? Infinity : best.pct - pct;
  // 目标必须严格更好，绝不把好号换掉。
  // 双方都有同口径聚合 token 时按绝对余量比——百分比在「最宽池大小不同」的
  // 账号之间是伪量纲（实测会「弃 1200 万换 450 万」）；不可比才回退百分比口径。
  // hardDown 时旧 token 一并作废（curTokens=null → 走百分比基准 -1）。
  const curTokens = !hardDown && cur?.tokens != null && isFinite(cur.tokens) ? cur.tokens : null;
  const bestTokens = best?.tokens != null && isFinite(best.tokens) ? best.tokens : null;
  const byTokens = curTokens != null && bestTokens != null;
  if (!manual) {
    if (byTokens ? bestTokens <= curTokens : best.pct <= pct) {
      return { action: "wait", reason: "noImprove", ranked, etaSec };
    }
    if (!byTokens) {
      if (degraded) {
        if (gain < Math.max(3, pct * 0.5)) return { action: "wait", reason: "noImprove", ranked, etaSec };
      } else if (!emergency && gain < Number(opts.minImprove ?? 0)) {
        return { action: "wait", reason: "noImprove", ranked, etaSec };
      }
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
