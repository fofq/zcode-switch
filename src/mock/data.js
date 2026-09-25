// 纯浏览器预览用的拟真数据集（形状与 src-tauri 各命令返回值一一对应）。
// 只在无 Tauri 后端的 dev 环境被 src/mock/tauri-mock.js 引用，不进生产包。

const DAY = 86_400_000;
const now = Date.now();
const dateStr = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const timeStr = (ms) => `${dateStr(ms)} 23:59:59`;

/** 额度池条目（quota.rs QuotaItem） */
function pool(name, total, usedPct, extra = {}) {
  const used = Math.round(total * (usedPct / 100));
  return { name, total, used, remaining: total - used, percent_used: usedPct, unit: "tokens", ...extra };
}
/** 常规套餐（PlanSlot） */
function plan(name, tier, tierCode, expireInDays, items, extra = {}) {
  return {
    pid: `pl-${Math.abs(hash(name + tier)).toString(36)}`,
    tier, tier_code: tierCode, name,
    expire: expireInDays == null ? null : timeStr(now + expireInDays * DAY),
    gift: false, expired: false, items, ...extra,
  };
}
/** 礼物套餐 */
function giftPlan(name, kind, expireInDays, items) {
  return {
    ...plan(name, "Gift", "trial", expireInDays, items, { gift: true }),
    pid: `gift-${kind}-${Math.abs(hash(name)).toString(36)}`,
  };
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return h;
}
/** 账号（store.rs AccountSummary） */
function acct(id, name, opts = {}) {
  return {
    id, name,
    created_at: opts.created || "2026-08-01 10:00:00",
    updated_at: opts.updated || "2026-09-25 22:10:00",
    is_active: !!opts.active,
    has_config: opts.hasConfig !== false,
    has_user_info: opts.hasUserInfo !== false,
    identity: {
      provider: "zai",
      username: opts.username ?? name,
      display_name: opts.displayName ?? null,
      email: opts.email ?? null,
      user_id: `u-${id}`,
    },
    group: null,
  };
}

const F = "GLM-5.3-Flash";   // 关注模型（焦点池）
const M = "GLM-5.3";         // 流转目标
const L = "GLM-4.7";         // 次要模型

// —— 逐账号额度数据（get_account_quota 返回的 QuotaOverview）——
const quotas = {
  "acct-01": {
    plans: [
      plan("Start Plan", "Start", "start", 21, [
        pool(F, 120_000_000, 33),
        pool(M, 40_000_000, 25),
      ]),
      giftPlan("Weekend Build 礼包", "weekend", 2, [pool(F, 12_000_000, 60)]),
      giftPlan("Global Build 活动包", "global", 9, [pool(F, 50_000_000, 8), pool(L, 20_000_000, 4)]),
    ],
    windows: [{ name: "提示次数（每 5 小时）", total: 120, used: 44, percent_used: 37, kind: "prompt_count", window: "hours:5", reset: "03:12" }],
  },
  "acct-02": { plans: [plan("Start Plan", "Start", "start", 14, [pool(F, 120_000_000, 45), pool(M, 40_000_000, 30)])] },
  "acct-03": { plans: [plan("Start Plan", "Start", "start", 6, [pool(F, 120_000_000, 88)])] },
  "acct-04": { plans: [plan("Start Plan", "Start", "start", 30, [pool(F, 120_000_000, 20), pool(L, 30_000_000, 10)])] },
  "acct-05": { plans: [plan("Start Plan", "Start", "start", 3, [pool(F, 120_000_000, 92)])] },
  "acct-06": { plans: [plan("Start Plan", "Start", "start", 18, [pool(F, 120_000_000, 55)])] },
  "acct-07": { plans: [plan("Start Plan", "Start", "start", 11, [pool(F, 120_000_000, 67)])] },
  "acct-08": { plans: [giftPlan("Weekend Build 礼包", "weekend", 2, [pool(F, 30_000_000, 30)])] },
  "acct-09": {
    plans: [
      giftPlan("Global Build 活动包", "global", 9, [pool(F, 80_000_000, 12), pool(L, 40_000_000, 5)]),
      plan("Lite Plan", "Lite", "lite", 25, [pool(M, 60_000_000, 22)]),
    ],
  },
  "acct-10": {
    // 流转：关注模型在所有套餐里耗尽，仅 GLM-5.3 有量
    plans: [
      { ...plan("Start Plan", "Start", "start", -1, [pool(F, 120_000_000, 100)]), expired: true },
      plan("Pro Plan", "Pro", "pro", 16, [pool(M, 200_000_000, 40)]),
    ],
  },
  "acct-11": { plans: [], items: [], is_empty: true, source: "api" },
  "acct-12": {
    plans: [
      { ...plan("Weekend Build 礼包", "Gift", "trial", -2, [pool(F, 12_000_000, 100)]), gift: true, expired: true },
      { ...plan("Start Plan", "Start", "start", -4, [pool(F, 120_000_000, 100)]), expired: true },
    ],
  },
  "acct-13": { plans: [], items: [], is_empty: true, source: "snapshot_empty" },
  "acct-14": { plans: [plan("Start Plan", "Start", "start", 8, [pool(F, 120_000_000, 70)])] },
  "acct-15": { plans: [plan("Start Plan", "Start", "start", 40, [pool(F, 120_000_000, 15)])] },
};

function overview(id) {
  const q = quotas[id] || { plans: [] };
  return {
    total: null, used: null, remaining: null, percent_used: null,
    plan_tier: null, plan_expire: null,
    is_empty: q.is_empty ?? false,
    source: q.source ?? "api",
    items: [...(q.windows || []), ...(q.items || [])],
    refreshed_at: Math.floor(now / 1000) - 60,
    plans: q.plans || [],
  };
}

// —— 账号列表（get_state）——
let accounts;
function buildAccounts() {
  accounts = [
    acct("acct-01", "主力号", { active: true, username: "main_dev", email: "main.dev@qq.com", displayName: "主力号" }),
    acct("acct-02", "zhang.dev@mail.com", { username: "zhangdev", email: "zhang.dev@mail.com" }),
    acct("acct-03", "备用-03", { username: "backup03" }),
    acct("acct-04", "1", { username: "num01", email: "num01@163.com" }),
    acct("acct-05", "2", { username: "num02" }),
    acct("acct-06", "10", { username: "num10" }),
    acct("acct-07", "12", { username: "num12" }),
    acct("acct-08", "周礼-小号", { username: "gift_wk", email: "gift.wk@gmail.com" }),
    acct("acct-09", "全球Build-A", { username: "global_a" }),
    acct("acct-10", "流转-5.3顶上", { username: "flow53" }),
    acct("acct-11", "耗尽-等周礼", { username: "empty01", updated: "2026-09-20 09:00:00" }),
    acct("acct-12", "耗尽-全过期", { username: "expired01", updated: "2026-09-18 09:00:00" }),
    acct("acct-13", "新号-待激活", {
      username: "fresh01", created: new Date(now - 5 * 60_000).toISOString().slice(0, 19).replace("T", " "),
      updated: new Date(now - 5 * 60_000).toISOString().slice(0, 19).replace("T", " "),
    }),
    acct("acct-14", "掉登录-重登", { hasUserInfo: false, username: "stale01" }),
    acct("acct-15", "风控-停靠", { username: "frozen01" }),
  ];
  // 切换账号时同步活跃标记，并把列表挂回 state（get_state 直接序列化 mockState）
  accounts.forEach((a) => { a.is_active = a.id === state.active_account_id; });
  state.accounts = accounts;
}

const state = {
  zcode_running: true,
  live_exists: true,
  live_logged_in: true,
  live_hash: "h-mock-1",
  active_account_id: "acct-01",
  live_identity: { provider: "zai", username: "main_dev", display_name: "主力号", email: "main.dev@qq.com", user_id: "u-acct-01" },
  accounts: [],
  zcode_path: "C:\\Program Files\\ZCode\\ZCode.exe",
  zcode_path_ok: true,
  store_dir: "C:\\Users\\demo\\AppData\\Roaming\\zcode-switch",
  launch_after_switch: true,
  close_to_tray: true,
  hot_switch: true,
  auto_claim: true,
  grouped: false,
  oauth_browser: true,
  auto_switch: true,
  auto_switch_threshold: 15,
  auto_switch_model: F,
  auto_switch_gift_first: true,
  auto_switch_gift_order: "auto",
  auto_switch_model_fallback: true,
  auth_proxy_on: false,
  auth_proxy_url: null,
  language: "zh",
  two_api_on: true,
  two_api_port: 8117,
  two_api_account: null,
  two_api_token: "zsw-mock-token-0123456789abcdef",
  two_api_models: "glm-5.3-flash, glm-4.7-flash, glm-4.6v-flash",
};
buildAccounts();

// —— 真实用量（usage_stats；daily 为本次新增的逐日序列）——
// 7 天 × 3 模型，手工拟真：Flash 为主力、周中切换日 GLM-5.3 抬升、今天只过了半天
const daily = [
  { date: dateStr(now - 6 * DAY), models: [["GLM-5.3-Flash", 61, 46_200_000], ["GLM-5.3", 12, 12_400_000], ["glm-4.7-flash", 4, 2_100_000]] },
  { date: dateStr(now - 5 * DAY), models: [["GLM-5.3-Flash", 44, 38_600_000], ["GLM-5.3", 19, 18_900_000], ["glm-4.7-flash", 3, 1_300_000]] },
  { date: dateStr(now - 4 * DAY), models: [["GLM-5.3-Flash", 68, 52_300_000], ["GLM-5.3", 9, 9_100_000], ["glm-4.7-flash", 5, 3_000_000]] },
  { date: dateStr(now - 3 * DAY), models: [["GLM-5.3-Flash", 18, 21_400_000], ["GLM-5.3", 38, 24_600_000], ["glm-4.7-flash", 3, 2_000_000]] },
  { date: dateStr(now - 2 * DAY), models: [["GLM-5.3-Flash", 57, 44_100_000], ["GLM-5.3", 13, 11_200_000], ["glm-4.7-flash", 2, 1_500_000]] },
  { date: dateStr(now - 1 * DAY), models: [["GLM-5.3-Flash", 71, 58_000_000], ["GLM-5.3", 15, 14_300_000], ["glm-4.7-flash", 4, 2_600_000]] },
  { date: dateStr(now), models: [["GLM-5.3-Flash", 24, 12_400_000], ["GLM-5.3", 9, 8_600_000], ["glm-4.7-flash", 2, 1_200_000]] },
];
const usageData = (() => {
  const dayRows = daily.map((d) => d.models.map(([model, requests, total]) => ({ model, requests, input: Math.round(total * 0.72), output: total - Math.round(total * 0.72), total })));
  const today = dayRows[dayRows.length - 1];
  const week = Object.values(dayRows.flat().reduce((acc, r) => {
    const a = (acc[r.model] ||= { model: r.model, requests: 0, input: 0, output: 0, total: 0 });
    a.requests += r.requests; a.input += r.input; a.output += r.output; a.total += r.total;
    return acc;
  }, {})).sort((a, b) => b.total - a.total);
  return {
    today, week,
    daily: daily.map((d, i) => ({ date: d.date, requests: dayRows[i].reduce((s, r) => s + r.requests, 0), total: dayRows[i].reduce((s, r) => s + r.total, 0), models: dayRows[i] })),
    today_total: today.reduce((s, r) => s + r.total, 0),
    week_total: week.reduce((s, r) => s + r.total, 0),
    today_requests: today.reduce((s, r) => s + r.requests, 0),
    db_missing: false,
  };
})();

const twoUsage = { "acct-01": 812, "acct-02": 301, "acct-04": 96, "acct-09": 42 };

const claimPlans = {
  "acct-05": [{ plan_id: "wk-2026-39", name: "Weekend Build 礼包", description: "周末活动赠送", grant_items: [{ name: F, units: 12_000_000, period: "one_time" }] }],
  "acct-11": [{ plan_id: "wk-2026-39", name: "Weekend Build 礼包", description: "周末活动赠送", grant_items: [{ name: F, units: 12_000_000, period: "one_time" }] }],
  "acct-13": [{ plan_id: "start-trial", name: "Start Plan 体验", description: "新号首次登录赠送", grant_items: [{ name: F, units: 20_000_000, period: "monthly" }] }],
};

export const mockState = state;
export const mockAccounts = () => accounts;
export const mockQuota = overview;
export const mockUsage = () => usageData;
export const mockClaimPlans = (id) => claimPlans[id] || [];
export const mockTwoUsage = () => ({ ...twoUsage });
/** 领取成功后给对应账号补一份礼物套餐额度（让预览的领取闭环可见） */
export function applyClaimedGift(id) {
  const q = (quotas[id] ||= { plans: [] });
  if (q.plans.some((p) => p.gift && !p.expired)) return;
  q.plans.push(giftPlan("Weekend Build 礼包", "weekend", 2, [pool(F, 12_000_000, 0)]));
}
