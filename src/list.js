// 账号列表的纯逻辑：额度健康度 / 搜索 / 筛选 / 排序 / 分桶 / 合计
// 不依赖 DOM，便于单独测试。

/** 健康度分级（也是列表里的展示顺序，越靠前越"可用"） */
// gift 不再是健康等级：它与 ok/low 是两个正交维度（有礼物 & 额度状态）。
// 有礼物额度 = 正交筛选 chip（summarize.counts.gift / filterAccounts 特判）+ 行内徽标，
// 否则 Weekend Build 全量发放后 gift 桶会吞掉额度充足组。
export const HEALTH_ORDER = ["ok", "low", "flowed", "dead", "pending", "auth", "fail", "unknown"];

/** 剩余额度低于该百分比视为"紧张" */
export const LOW_THRESHOLD = 20;

/** 新号"成功但空"的宽限窗口：窗口内按「待激活」处理，不判死 */
export const PENDING_WINDOW_MS = 30 * 60 * 1000;

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
  // 过期套餐只是留档、额度不可用：只统计未过期套餐。
  // d.items 是后端「全部套餐（含过期）平铺」，礼物批量到期后过期残留会把
  // 不可用额度算成「还有剩余」（实测 75% 来自过期池），不能直接用。
  if (Array.isArray(d.plans)) {
    for (const p of livePlans(q)) {
      push(p.percent_used);
      for (const it of p.items || []) push(it.percent_used);
    }
    if (!pcts.length) push(d.percent_used);
  } else {
    // 旧数据：只有平铺 items / 总览数字
    push(d.percent_used);
    for (const it of d.items || []) push(it.percent_used);
  }
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
/** 模型名匹配：兼容 "GLM-5.3-Flash"（总览条目）与 "5.3-Flash"（套餐明细条目）两种命名 */
export function modelKeyMatch(nameLower, key) {
  if (!key) return false;
  if (nameLower.includes(key)) return true;
  const nk = nameLower.replace(/^glm-/, "");
  const kk = key.replace(/^glm-/, "");
  return nk === kk;
}

export function modelRemainingPct(q, model) {
  const key = String(model || "").trim().toLowerCase();
  if (!key) return null;
  const d = q?.data;
  if (!d) return null;
  const pcts = [];
  const consider = (it) => {
    if (!it || typeof it.name !== "string") return;
    if (!modelKeyMatch(it.name.toLowerCase(), key)) return;
    const p = Number(it.percent_used);
    if (isFinite(p)) { pcts.push(p); return; }
    const total = Number(it.total);
    const used = Number(it.used);
    if (isFinite(total) && total > 0 && isFinite(used)) pcts.push((used / total) * 100);
  };
  // 过期套餐池不可用，不参与判定（plans 缺失的旧数据才回退平铺 items）
  if (Array.isArray(d.plans)) {
    for (const p of livePlans(q)) for (const it of p.items || []) consider(it);
  } else {
    for (const it of d.items || []) consider(it);
  }
  if (!pcts.length) return null;
  const bestUsed = Math.min(...pcts);
  return Math.max(0, Math.min(100, 100 - bestUsed));
}

function itemKindOf(it) {
  if (it.kind) return it.kind;
  if (it.name.includes("提示次数")) return "prompt_count";
  if (it.name.includes("使用时长")) return "duration";
  return "raw";
}

/** 套餐是否已过期（后端 expired 标记：status != active 或 ends_at 已过服务器时间） */
export function planExpired(p) {
  return p?.expired === true;
}

/** 账号在用的套餐：排除过期套餐（过期桶只是留档，额度不可用） */
function livePlans(q) {
  return (q?.data?.plans || []).filter((p) => !planExpired(p));
}

/** 套餐分类：优先用后端 gift 标记（entitlements 全部 one_time = 礼物/赠送），旧数据回退名字启发式 */
export function planIsGift(p) {
  if (p?.gift === true) return true;
  if (p?.gift === false) return false;
  const tier = String(p?.tier_code || p?.tier || "").toLowerCase();
  const name = String(p?.name || "").toLowerCase();
  if (["max", "pro", "lite", "start"].includes(tier)) return false;
  if (tier === "trial") return true;
  return /gift|promo|weekend|taste|experience|activity|体验|礼包|global build/.test(name);
}

/** 按套餐类别计算关注模型剩余：wantGift=true 只看礼物/赠送类套餐 */
function modelPctInPlans(q, model, wantGift) {  const key = String(model || "").trim().toLowerCase();
  if (!key) return null;
  const d = q?.data;
  if (!d) return null;
  const pcts = [];
  const consider = (it) => {
    if (!it || typeof it.name !== "string") return;
    if (!modelKeyMatch(it.name.toLowerCase(), key)) return;
    const p = Number(it.percent_used);
    if (isFinite(p)) { pcts.push(p); return; }
    const total = Number(it.total);
    const used = Number(it.used);
    if (isFinite(total) && total > 0 && isFinite(used)) pcts.push((used / total) * 100);
  };
  for (const p of livePlans(q)) {
    if (planIsGift(p) !== wantGift) continue;
    for (const it of p.items || []) consider(it);
  }
  if (!pcts.length) return null;
  const bestUsed = Math.min(...pcts);
  return Math.max(0, Math.min(100, 100 - bestUsed));
}

export function modelRemainingPctDetailed(q, model) {
  return {
    gift: modelPctInPlans(q, model, true),
    regular: modelPctInPlans(q, model, false),
  };
}

/**
 * entitlement_id → {gift, giftKind, expireMs}：给客户端日志的余额池做礼物/常规分类。
 * 日志里的池只有 id 没有套餐归属，且两个礼物和 Start 的池同名（都叫 GLM-5.3-Flash），
 * 只能靠 HTTP 套餐数据里的 entitlement_id 建映射；未入库的 id 由调用方按常规（保守）处理。
 */
export function entitlementGiftMap(q) {
  const map = {};
  const d = q?.data;
  if (!d) return map;
  for (const p of livePlans(q)) {
    const gift = planIsGift(p) === true;
    const kind = gift ? giftKindOfPlan(p) : null;
    const txt = String(p?.expire || "");
    let expireMs = null;
    if (txt) {
      const hasTime = txt.length >= 16;
      const ms = new Date(hasTime ? txt.replace(" ", "T") : txt + "T23:59:59").getTime();
      if (isFinite(ms)) expireMs = ms;
    }
    for (const it of p.items || []) {
      const id = String(it?.entitlement_id || "").trim();
      if (id) map[id] = { gift, giftKind: kind, expireMs };
    }
  }
  return map;
}

/**
 * 礼物套餐细分（用户要求按活动名分组）：Weekend Build / Global Build，
 * 其它活动名回退 generic "gift"。过期套餐不算。
 */
export function giftKindOfPlan(p) {
  if (!planIsGift(p) || planExpired(p)) return null;
  const n = String(p?.name || "").toLowerCase();
  if (n.includes("weekend")) return "weekend";
  if (n.includes("global")) return "global";
  return "gift";
}

/** 流转用：关注模型之外、剩余额度最高的其它模型（仅统计额度池/模型条目） */
export function bestOtherModel(q, model) {
  const key = String(model || "").trim().toLowerCase();
  if (!key) return null; // 未设置关注模型时不流转
  const d = q?.data;
  if (!d) return null;
  const best = new Map();
  const consider = (it) => {
    if (!it || typeof it.name !== "string") return;
    if (itemKindOf(it) !== "raw") return;
    const nameLower = it.name.toLowerCase();
    if (modelKeyMatch(nameLower, key)) return;
    const p = Number(it.percent_used);
    const used = isFinite(p) ? p
      : (isFinite(Number(it.total)) && Number(it.total) > 0 && isFinite(Number(it.used)))
        ? (Number(it.used) / Number(it.total)) * 100
        : null;
    if (used == null) return;
    const cur = best.get(nameLower);
    if (!cur || used < cur.used) best.set(nameLower, { name: it.name, used });
  };
  // 流转目标只看未过期套餐：过期池不可用，不能当作「其它模型还有额度」的依据
  if (Array.isArray(d.plans)) {
    for (const p of livePlans(q)) for (const it of p.items || []) consider(it);
  } else {
    for (const it of d.items || []) consider(it);
  }
  let out = null;
  for (const b of best.values()) {
    const pct = Math.max(0, Math.min(100, 100 - b.used));
    if (!out || pct > out.pct) out = { name: b.name, pct };
  }
  return out;
}

/**
 * 额度条纯逻辑：官方（ZCode 3.14+）额度面板以“剩余”为基准（如 9.7% = 还剩 9.7%）。
 * 视觉方向与配色：剩余段锚定左侧（绿），消耗后从右侧向左侧减退（黄=已用从右往左生长）；
 * 剩余 ≤ low%（快用尽）时剩余段转红；完全用尽整条黄（已用色铺满）。
 * 入参仍是后端 QuotaItem.percent_used（已用%），出参全部转为剩余：
 * - rem: 精确剩余百分比；w: 取整后的剩余，颜色分支与条宽共用这一个舍入值（0% 标签不得撞色误导）
 * - txt: 条内标签；剩余 <10% 时保留一位小数（“还剩 0.4%”不能被舍入成 0% 误导成耗尽）
 * - segs: 条形分段（左→右），kind: green(剩余充足)/red(剩余紧张)/yellow(已用)
 */
export function quotaBarParts(usedPct, low = LOW_THRESHOLD) {
  const n = Number(usedPct);
  if (usedPct == null || !isFinite(n)) return { rem: null, w: null, txt: "--", segs: [] };
  const used = Math.min(100, Math.max(0, n));
  const rem = 100 - used;
  const w = Math.round(rem);
  const txt = (rem > 0 && rem < 10 ? (rem >= 0.05 ? rem.toFixed(1) : "0") : String(w)) + "%";
  let segs;
  if (w >= 100) segs = [{ width: 100, kind: "green" }];
  else if (w <= 0) segs = [{ width: 100, kind: "yellow" }];
  else segs = [{ width: w, kind: rem <= low ? "red" : "green" }, { width: 100 - w, kind: "yellow" }];
  return { rem, w, txt, segs };
}

/**
 * 账号健康度：以额度为主，额度查不到时回退到快照信号。
 * 传了 model 时优先用该模型的额度，modelMatched 表示是否命中。
 * opts.giftFirst: 优先判定礼物/赠送类套餐额度，礼物耗尽才回落常规套餐。
 * opts.modelFallback: 关注模型耗尽时流转到剩余最高的其它模型（如 GLM-5.3）。
 * 返回 { level, remainingPct, modelMatched, modelName }
 */
export function healthOf(acct, quota, isAuthErr, model, opts = {}) {
  let mp = modelRemainingPct(quota, model);
  let modelName = mp != null ? (model || null) : null;
  let fallback = false;
  // 额度紧张的分界 = 用户的自动切换阈值（分组与切换行为一致），未传时用 20
  const thr = Number(opts.threshold ?? LOW_THRESHOLD);
  // 礼物优先：礼物套餐还有额度就只看礼物套餐；全部用尽才回落常规套餐。
  // 若两个类别在套餐层都匹配不上（数据命名差异），保留原有的全源判定不被破坏。
  if (mp != null && opts.giftFirst) {
    const det = modelRemainingPctDetailed(quota, model);
    if (det.gift != null || det.regular != null) {
      mp = det.gift != null && det.gift > 0 ? det.gift : (det.regular != null ? det.regular : det.gift);
    }
  }
  // 关注模型的原始百分比（礼物优先调整后、流转前）——自适应刷新频率用它
  const focusPct = mp;
  // 流转：关注模型在所有套餐里都耗尽时，改用其它剩余最高的模型参与判定。
  // 未设置关注模型时不流转（否则所有账号都会被误判成“关注模型耗尽”）。
  if (opts.modelFallback && model && (mp == null || mp <= 0)) {
    const alt = bestOtherModel(quota, model);
    if (alt && alt.pct > 0) {
      mp = alt.pct;
      modelName = alt.name;
      fallback = true;
    }
  }
  const pct = mp != null ? mp : quotaRemainingPct(quota);
  // 有礼物额度的账号单独成组（展示用：提醒还有礼物可消耗）；过期套餐不算礼物额度
  const giftKinds = [...new Set(
    livePlans(quota)
      .filter((p) => p.gift === true && Number(p.remaining ?? 1) > 0)
      .map(giftKindOfPlan)
      .filter(Boolean),
  )];
  const hasGift = giftKinds.length > 0;
  // 鉴权失效永远优先（token 过期等，旧数据不可信）
  if (quota?.err && isAuthErr && isAuthErr(quota)) {
    return { level: "auth", remainingPct: pct, modelMatched: mp != null, modelName, fallback, hasGift, giftKinds, focusPct };
  }
  // 确定性判死：服务器明确返回无套餐（balances/plans 全空且业务码成功），或套餐全部已过期。
  // 这不是查询失败——刷新永远不会“恢复”，剩余按 0 处理让自动切换能触发切走。
  // 例外：刚入库的新号（created_at 在宽限窗口内）拿到「成功但空」时，多半是服务端
  // 还没发放/激活套餐（官方客户端靠启动心跳触发），先按「待激活」单独成组，
  // 既不误报 0% 耗尽，也不会被自动切换当成"没额度的号"。
  const plans = quota?.data?.plans || [];
  const definiteEmpty = quota?.data?.is_empty === true;
  if (definiteEmpty && quota?.data?.source === "snapshot_empty") {
    const created = Date.parse(String(acct?.created_at || "").replace(" ", "T"));
    const fresh = Number.isFinite(created) && Date.now() - created < Number(opts.pendingWindow ?? PENDING_WINDOW_MS);
    if (fresh) {
      return { level: "pending", remainingPct: null, modelMatched: false, modelName: null, fallback: false, hasGift, giftKinds, focusPct: null };
    }
  }
  const allExpired = plans.length > 0 && plans.every(planExpired);
  if (definiteEmpty || allExpired) {
    return { level: "dead", remainingPct: 0, modelMatched: mp != null, modelName, fallback, hasGift: false, giftKinds: [], focusPct: 0 };
  }
  if (pct != null) {
    // 流转账号单独一档：关注模型已耗尽但其它模型仍可用，组名直接表达主状态
    const lv = fallback ? "flowed" : pct <= 0 ? "dead" : pct <= thr ? "low" : "ok";
    return { level: lv, remainingPct: pct <= 0 ? 0 : pct, modelMatched: mp != null, modelName, fallback, hasGift, giftKinds, focusPct };
  }
  // 没有任何额度数据时才用错误/回退信号（避免刷新失败把账号闪进失败分组）
  if (quota?.err) return { level: "fail", remainingPct: null, modelMatched: false, modelName: null, fallback: false, hasGift, giftKinds, focusPct: null };
  if (acct?.has_user_info === false) return { level: "auth", remainingPct: null, modelMatched: false, modelName: null, fallback: false, hasGift, giftKinds, focusPct: null };
  return { level: "unknown", remainingPct: null, modelMatched: false, modelName: null, fallback: false, hasGift, giftKinds, focusPct: null };
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
      if (health.startsWith("gift:")) {
        if (!h?.giftKinds?.includes(health.slice(5))) return false;
      } else if (!h || h.level !== health) {
        return false;
      }
    }
    return matchesSearch(a, search);
  });
}

/**
 * 排序。
 * quota: 健康度分级优先（充足→…→待查询），同级按剩余额度降序
 * name / created / updated: 文本或时间序
 */
export function sortAccounts(accounts, sort, healthMap, localeTag = "zh-CN", opts = {}) {
  const arr = [...(accounts || [])];
  // dir：正序(1)/倒序(-1)，作用于主排序键（分层的置顶/无数据沉底规则不翻转）
  const d = opts.dir === -1 ? -1 : 1;
  const keyOf = opts.keyOf || (() => -1);
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
      return arr.sort((a, b) => d * byName(a, b));
    case "updated":
      return arr.sort((a, b) => d * String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || byName(a, b));
    case "created":
      return arr.sort((a, b) => d * String(a.created_at || "").localeCompare(String(b.created_at || "")) || byName(a, b));
    case "focus":
    case "gift":
      return arr.sort((a, b) => d * (keyOf(b) - keyOf(a)) || byName(a, b));
    case "quota":
    default: {
      // 分层排序：
      // 0 = 使用中且判定额度仍在阈值上（正常使用中，置顶）
      // 1 = 普通账号（判定来自关注模型/总览），按判定额度降序
      // 2 = 流转账号（关注模型耗尽、判定来自其它模型），永远排在普通账号之后
      // 使用中的账号一旦判定额度 ≤ 阈值（紧张/耗尽），不再置顶，按判定额度落入 1 层自然靠后
      const thr = Number(opts.threshold ?? 10);
      const tierOf = (a) => {
        const h = healthMap?.get(a.id) || {};
        if (a.is_active && h.remainingPct != null && h.remainingPct > thr) return 0;
        return h.fallback ? 2 : 1;
      };
      const noData = (a) => (pctOf(a) < 0 ? 1 : 0);
      return arr.sort(
        (a, b) =>
          tierOf(a) - tierOf(b)
          || noData(a) - noData(b)
          || d * (pctOf(b) - pctOf(a))
          || rankOf(a) - rankOf(b)
          || byName(a, b),
      );
    }
  }
}

/**
 * 分组：按健康度分桶（自定义分组已移除）。
 * 返回 [{ key, label, kind: 'health', items: [] }]，顺序按 HEALTH_ORDER。
 */
export function bucketAccounts(accounts, { localeTag = "zh-CN", healthLabel = () => "" } = {}, healthMap) {
  const buckets = new Map();
  for (const a of accounts) {
    const h = healthMap?.get(a.id)?.level || "unknown";
    const key = `h:${h}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: healthLabel(h),
        kind: "health",
        items: [],
      });
    }
    buckets.get(key).items.push(a);
  }
  return HEALTH_ORDER.map((lv) => buckets.get(`h:${lv}`)).filter(Boolean);
}

/**
 * 合计：各健康度计数 + 平均剩余额度百分比（仅统计已拿到额度的账号，单位无关）。
 */
export function summarize(accounts, healthMap) {
  const counts = { "gift:weekend": 0, "gift:global": 0, ok: 0, low: 0, flowed: 0, dead: 0, pending: 0, auth: 0, fail: 0, unknown: 0 };
  let pctSum = 0;
  let pctCount = 0;
  for (const a of accounts || []) {
    const h = healthMap?.get(a.id);
    const lv = h?.level || "unknown";
    if (counts[lv] == null) counts.unknown++;
    else counts[lv]++;
    // 礼物是正交维度：按活动细分独立计数（同号两类都领则两边都进），不占健康等级
    for (const k of h?.giftKinds || []) counts[`gift:${k}`] = (counts[`gift:${k}`] ?? 0) + 1;
    if (h?.remainingPct != null) {
      pctSum += h.remainingPct;
      pctCount++;
    }
  }
  return { counts, avgRemainingPct: pctCount ? pctSum / pctCount : null, known: pctCount };
}
