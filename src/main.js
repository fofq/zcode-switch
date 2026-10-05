import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, toast, openPwModal, openConfirmModal, openProviderModal, installDelegation, dismissSplash } from "./ui.js";
import { ic } from "./icons.js";
import { init, t, has, lang, localeTag, stripErr, errCode } from "./i18n.js";
import { HEALTH_ORDER, healthOf, filterAccounts, sortAccounts, bucketAccounts, summarize, modelKeyMatch, quotaBarParts, planExpired, planIsGift, PENDING_WINDOW_MS, entitlementGiftMap } from "./list.js";
import { AS_DEFAULTS, poolStats, poolStatsFromSignals, poolsRate, sampleFrom, pushSample, etaOf, evaluate, fmtEta, giftFirstBasis } from "./autoswitch.js";

// 纯浏览器预览：无 Tauri 后端（普通浏览器开 dev server）时注入 mock IPC 再继续启动；
// 生产构建里 import.meta.env.DEV 为 false，整段会被剔除，Tauri 真机零影响
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  await import("./mock/tauri-mock.js");
}

const $app = document.getElementById("app");
let state = null;
let renaming = null;
let busy = false;
let appVer = "";
let acctQuota = {};
let claimable = {};
let claimAllRunning = false;
let claimAllAbort = false;
let claimAllState = { running: false, done: 0, total: 0 };

const AUTO_CLAIM_INTERVAL_MS = 10 * 60 * 1000;
// 干净收尾（本轮无可领礼物）后的重查间隔：礼物品只在新号入库/活动发放时出现，
// 无需高频轮询；新号入库会主动清冷却触发领取
const AUTO_CLAIM_RECHECK_MS = 30 * 60 * 1000;
const AUTO_CLAIM_TICK_MS = 60 * 1000;
const AUTO_CLAIM_FIRST_DELAY_MS = 2 * 60 * 1000;
const AUTO_CLAIM_WAIT_MS = 45_000;
const AUTO_CLAIM_PER_ACCOUNT_CAP = 5;
const AUTO_CLAIM_ACCT_GAP_MS = 12_000;
// 单轮最多处理的账号数：冷启动/冷却对齐时不至于一轮打穿全部账号，
// 余下的交给下一个 60s tick（autoClaimRunning 串行化）
const AUTO_CLAIM_ROUND_CAP = 25;
// 连续空手（无可领礼包）轮数 → 冷却 30min 翻倍至 4h 封顶
let autoClaimEmptyRounds = {};
// 连续领取失败轮数 → 失败冷却同样翻倍至 24h 封顶：持续失败的领取多半是
// 号被标记/资格问题，每 30min 重试只会加固风控画像
let autoClaimFailRounds = {};
// 自动风控冻结：领取链路吃到 HTTP 层风控信号（405/unusual activity 等）**首次即冻结**
// （不参与自动切换、停止领取），3h 冷却到期后随轮次探测复测：提交成功/额度恢复即
// 解冻，再吃风控信号顺延停靠。手动冻结不参与 b/c) 额度证据机自动解冻（提交成功探测一视同仁，见 claim://result 监听）
const AUTO_FROZEN_KEY = "zsw-auto-frozen";
let autoFrozenAt = (() => {
  try { return JSON.parse(localStorage.getItem(AUTO_FROZEN_KEY) || "{}"); }
  catch { return {}; }
})();
function saveAutoFrozen() {
  try { localStorage.setItem(AUTO_FROZEN_KEY, JSON.stringify(autoFrozenAt)); } catch { /* 忽略 */ }
}
let autoRiskStreak = {};
let autoRiskLastAt = {};
function riskInText(text) {
  return /HTTP (?:405|429)\b|unusual activity|blocked/i.test(String(text || ""));
}
// 手动操作（单账号领取/手动刷新/一键领取）抢占自动轮时置位：轮次就地收尾，
// 手动完成后由后续 tick 接续余下账号（tick 开始时复位）
let autoClaimPaused = false;
let autoClaimRunning = false;
// 停靠冷却持久化：只落盘「停靠级」写入（风控停靠/手动冻结/升级确认/验证码停靠），
// 短退避（30min/10min/翻倍退避/空手节奏）不落盘——重启丢失无碍，避免短退避被重启固化。
// 恢复只取 >now 的绝对到期时刻：重启不提前也不推迟冷却到期（「冷却必到期」语义不变）
const CLAIM_COOLDOWN_KEY = "zsw-claim-cooldown-v1";
let autoClaimCooldown = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(CLAIM_COOLDOWN_KEY) || "{}");
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw || {}).filter(([, v]) => Number(v) > now));
  } catch { return {}; }
})();
function saveClaimCooldown() {
  try { localStorage.setItem(CLAIM_COOLDOWN_KEY, JSON.stringify(autoClaimCooldown)); } catch { /* 忽略 */ }
}
let autoAbortRequested = false;
let claimActive = false;
let lastAutoRound = null;
let autoToggleBusy = false;

// ===== 礼物账本与分层（事件驱动领取） =====
// 实证模型（2026-09-27）：Global Build（1亿/号）每号一生一次，报价未领期间一直挂在
// preview；周礼（3亿）全员有资格、按期领一次。可领报价只存在于 billing/preview——
// 客户端日志/余额都看不到，因此快检集合要小而准：当前号+新号快轮询，老号靠空手证词
// 一次性降级，新实例开闸由「级联」把未持有者错峰排进轮次。
// 账本：每号每礼物族记录已领实例（led.global=领过即终身免快检；led._inst=见过的实例）
const CLAIM_LEDGER_KEY = "zsw-claim-ledger-v1";
let claimLedger = (() => {
  try { return JSON.parse(localStorage.getItem(CLAIM_LEDGER_KEY) || "{}"); }
  catch { return {}; }
})();
function saveClaimLedger() {
  try { localStorage.setItem(CLAIM_LEDGER_KEY, JSON.stringify(claimLedger)); } catch { /* 忽略 */ }
}
function giftFamilyKey(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("global build")) return "global";
  if (n.includes("weekend")) return "weekend";
  if (n.includes("trust build")) return "trust";
  if (n.includes("start plan")) return "start";
  return `other:${String(name || "").trim()}`;
}
function markClaimedPlan(id, planName, planId) {
  if (!id || !planId) return;
  const fam = giftFamilyKey(planName);
  const led = (claimLedger[id] = claimLedger[id] || {});
  if (led[fam] === planId) return;
  led[fam] = planId;
  saveClaimLedger();
}
// 分层：0=当前账号 1=新号(<48h)/GlobalBuild未证词 2=有额度 3=其余(含用尽)。
// 有额度与否跟资格无关（满额老号也不可见），但决定请求预算的先后
const CLAIM_NEW_MS = 48 * 3600e3;
/** 新入库：建号 48h 内（与领取分层的新号口径一致）。新入库却始终无额度/停留在
 *  待激活，多半是激活或领取风控被拦——行内「新入库」tag 是给用户的目视诊断信号 */
function isNewEnrolled(a) {
  const c = Date.parse(String(a?.created_at || "").replace(" ", "T"));
  return Number.isFinite(c) && Date.now() - c < CLAIM_NEW_MS;
}
const CLAIM_T0_POLL_MS = 12 * 60e3;
const CLAIM_T1_CAP_MS = 30 * 60e3;
const CLAIM_T2_CAP_MS = 2 * 3600e3;
function claimTierOf(id) {
  if (id === state?.active_account_id) return 0;
  const a = (state?.accounts || []).find((x) => x.id === id);
  const created = Date.parse(String(a?.created_at || "").replace(" ", "T")) || 0;
  if (created && Date.now() - created < CLAIM_NEW_MS) return 1;
  const led = claimLedger[id] || {};
  if (!led.global && !led.globalEmpty) return 1;
  const h = healthMapOf().get(id);
  if (h && (h.level === "ok" || h.level === "low")) return 2;
  return 3;
}
function claimTierCapMs(tier) {
  if (tier === 0) return CLAIM_T0_POLL_MS;
  if (tier === 1) return CLAIM_T1_CAP_MS;
  if (tier === 2) return CLAIM_T2_CAP_MS;
  return Infinity; // T3 沿用 30min→4h 退避封顶
}
// 入库/切号触发的紧急检查：激活上报走 180s 快槽（区别于例行轮询的 4h 槽）
let claimUrgent = {};
// 切号/入库后统一入口：清冷却 + 稍后 tick（轮次忙则下个 tick 以 T0 优先接续）
function armClaimCheck(id) {
  if (!id || isArchived(id)) return; // 归档号不主动领取
  claimUrgent[id] = true;
  autoClaimCooldown[id] = 0;
  saveClaimCooldown(); // 清零也落盘：入库/切号的紧急检查不能在重启后复活成旧停靠
  setTimeout(() => autoClaimTick(), 4000);
}
// 新实例登记：plan_id 首次出现（preview/balance/客户端日志任一来源）→ 级联一次：
// 所有未持有该实例的账号错峰排入领取轮。global 族按「领过即出列」、其余族按实例比对；
// 冻结号（手动=风控代位/自动）均参与——新礼物到账正是停靠号的复测/恢复路径，
// 节奏仍由领取冷却/风控顺延统一节流。级联只铺冷却，顺序/限速仍由分层轮次统一控制。
// 过期/非生效实例只登记不级联（否则每次余额刷新都会重复触发）
function notePlanInstances(list) {
  const inst = (claimLedger._inst = claimLedger._inst || {});
  let added = null;
  for (const it of list || []) {
    const pid = String(it?.planId || it?.plan_id || "").trim();
    if (!pid || inst[pid]) continue;
    inst[pid] = Date.now();
    const live = it.expired != null ? !it.expired
      : it.status != null && it.status !== "" ? String(it.status).toLowerCase() === "active"
        : true;
    (added ||= []).push([pid, it.name || "", live]);
  }
  if (added?.length) {
    saveClaimLedger();
    for (const [pid, pname, live] of added) {
      if (live) scheduleGiftCascade(pid, pname);
    }
  }
}
let pendingCascade = null;
// 自动领取关闭期间登记的新实例：开启（或启动加载完配置）后补一次级联
function flushPendingCascade() {
  if (pendingCascade && state?.auto_claim) {
    const p = pendingCascade;
    pendingCascade = null;
    scheduleGiftCascade(p.planId, p.planName);
  }
}
function scheduleGiftCascade(planId, planName) {
  const fam = giftFamilyKey(planName);
  if (fam === "start") return; // 基础套餐不是「礼物期」：新号由入库钩子负责
  if (!state?.auto_claim) { pendingCascade = { planId, planName }; return; }
  const now = Date.now();
  let n = 0;
  for (const a of state?.accounts || []) {
    const id = a.id;
    if (isArchived(id)) continue; // 归档号不级联（用户决定停靠，不参与任何自动领取）
    const led = claimLedger[id] || {};
    if (fam === "global" ? led.global : led[fam] === planId) continue;
    // 错峰铺开（20s×序号±抖动）：级联只让账号「变为可调」，不做对齐风暴
    const stagger = n * 20_000 + Math.round(Math.random() * 20_000);
    autoClaimCooldown[id] = Math.min(autoClaimCooldown[id] ?? Infinity, now + stagger);
    n++;
  }
  if (n > 0) {
    toast(t("m.cascadeStart", { name: planDisplayName(planName || planId), n }), "ok");
    setTimeout(() => autoClaimTick(), 3000);
  }
}

const NOTCH_COLORS = ["var(--notch-1)", "var(--notch-2)", "var(--notch-3)", "var(--notch-4)", "var(--notch-5)", "var(--notch-6)"];
function notchColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return NOTCH_COLORS[h % NOTCH_COLORS.length];
}

function fmtNum(v) {
  if (v == null) return t("q.unknown");
  const n = Number(v);
  if (!isFinite(n)) return t("q.unknown");
  if (lang() === "zh") {
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + " 万";
    return n.toLocaleString(localeTag(), { maximumFractionDigits: 2 });
  }
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return n.toLocaleString(localeTag(), { maximumFractionDigits: 2 });
}
function idLabel(id) {
  if (!id) return null;
  return id.display_name || id.username || id.email || null;
}

// ---------- 列表视图状态（搜索 / 筛选 / 排序 / 密度 / 选择） ----------

const UI_PREFS_KEY = "zsw-list-prefs";
const SORTS = ["quota", "focus", "gift", "name", "created", "updated"];

function loadPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "null");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
const savedPrefs = loadPrefs();

const ui = {
  search: "",
  health: "all",
  sort: SORTS.includes(savedPrefs.sort) ? savedPrefs.sort : "quota",
  sortDir: savedPrefs.sortDir === -1 ? -1 : 1,
  density: savedPrefs.density === "detail" ? "detail" : "compact",
  // 视图模式：flat=平铺列表 / card=卡片网格（分组沿用 s.grouped，与二者正交组合时以分组优先）
  view: savedPrefs.view === "card" ? "card" : "flat",
  // 强调色主题：amber=琥珀(默认) / teal=苍青 / mono=墨石
  theme: ["amber", "teal", "mono"].includes(savedPrefs.theme) ? savedPrefs.theme : "amber",
  hideInfo: savedPrefs.hideInfo === true,
  qhOpen: false,
  qhTab: "",
  modelCustom: false,
  selected: new Set(),
  // Shift 范围选择的锚点（上一次普通点选的行）；会话内有效，不持久化
  lastCheckedId: null,
  expanded: new Set(),
  collapsedSections: new Set(),
};

/** 应用主题：html[data-theme] 驱动 CSS 变量；默认主题不挂属性 */
function applyTheme(theme) {
  ui.theme = ["teal", "mono"].includes(theme) ? theme : "amber";
  if (ui.theme === "amber") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = ui.theme;
}
applyTheme(ui.theme);

// 剪贴板：优先 navigator.clipboard，失败回退 execCommand（webview 环境兜底）
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

let quotaSweep = { running: false, phase: "quota", eligibility: false, done: 0, total: 0, cancel: false };
// 顶部「刷新」按钮当前应显示的提示（资格阶段 / 额度阶段）
function refreshAllTitle() {
  if (!quotaSweep.running) return t("btn.refreshAllTitle");
  return t("btn.refreshAllRunning", { done: quotaSweep.done, total: quotaSweep.total });
}
function refreshAllBadge() {
  if (!quotaSweep.running) return "";
  const n = quotaSweep.done;
  return n > 0 ? `<span class="tb-badge">${n}</span>` : "";
}

// 低额度自动切换
const AUTO_SWITCH_CHECK_MS = 60 * 1000;
// 冷却只用于「非紧急」切换（百分比越线）：2 分钟。预测式(ETA)/硬信号触发不受冷却限制，
// 改为用 hardGrace（刚切完的保护窗）+ 「目标必须严格更好」防横跳
const AUTO_SWITCH_COOLDOWN_MS = 2 * 60 * 1000;
// 体验：无操作一段时间后视图自动定位到在用账号（任何交互重置计时）
const AUTO_LOCATE_IDLE_MS = 10 * 1000;
let lastUserActionAt = Date.now();

let autoSwitchRunning = false;
// 决策/执行重入锁：预校验会 await 网络，期间事件/定时器/loadAcctQuota 都会再次进入决策，
// 不上锁会出现「两个并发切换」。autoSwitchRunning 只表达「正在切换」给 UI 看。
let switchLock = false;
let lastAutoSwitchAt = 0;
let autoSwitchNote = "";
let lastHotWarnAt = 0;

// ---- 客户端日志信号（zsignals）：秒级、零额外请求 ----
// liveSignals 只在「当前登录账号」上可信（日志是客户端自己的），候选号一律用 HTTP 数据
let liveSignals = null;
// 快照新鲜窗口：实测客户端在活跃时约每 15s 记一条余额（p50=15.4s），忙时也可能 1-2 分钟才一条；
// 超过窗口就丢给 HTTP 轮询（另一条路径），不会用陈旧快照做判断
const SIGNALS_FRESH_MS = 180 * 1000;
// 每个账号最近一排 HTTP 样本（算烧速）+ 最近一次成功采样时间（算新鲜度）
let quotaHist = {};
let quotaSampleAt = {};
let quotaForceAt = {};
// 连续额度查询失败计数（成功清零）：无套餐 500 / 鉴权失效这类确定性故障下，
// 样本永远刷不新，决策不能永远停在「先刷新」——连续失败按硬信号处理
let quotaFailStreak = {};
// 空快照抖动计数：上游间歇性返回「成功但空」时，快速非 quick 复查的已试次数
let quotaFlapRetry = {};
/** 连续失败 N 次后的重试间隔：6s 起指数退避，上限 30 分钟 */
function failBackoffMs(streak) {
  const shift = Math.min(Math.max((streak || 1) - 1, 0), 9);
  return Math.min(6000 * (2 ** shift), 30 * 60 * 1000);
}
// 重活窗口里被要求「尽快重查」的账号（窗口结束后补一轮）
const staleWant = new Set();
// 最近切出过的账号（防 A→B→A 乒乓），10 分钟滚动
let recentFrom = new Map();
// 自动切换审计环（事件时间/原因/目标/耗时），同时落盘到后端日志
const AS_AUDIT_MAX = 60;
let asAudit = [];

function asAuditPush(kind, data) {
  const e = { at: Date.now(), kind, ...data };
  asAudit.push(e);
  if (asAudit.length > AS_AUDIT_MAX) asAudit.splice(0, asAudit.length - AS_AUDIT_MAX);
  try { console.info("[as-audit]", kind, JSON.stringify(data)); } catch { /* 忽略 */ }
  invoke("auto_switch_log", { event: kind, detail: JSON.stringify(data) }).catch(() => {});
  return e;
}
function asAuditLast() {
  return asAudit.length ? asAudit[asAudit.length - 1] : null;
}

// ---- 热切连击（X-Device-Mid 隔离提醒）----
// 客户端 deviceMid 进程内单次读取：热切链上所有账号的客户端 billing 请求都带最初号的
// 设备身份，直到一次冷切换恢复隔离（工具自身查询用每号独立 mid，不受影响）
const HOT_STREAK_KEY = "zsw-hot-streak";
let hotStreak = Number(localStorage.getItem(HOT_STREAK_KEY) || 0) || 0;
function noteHotSwitch() {
  hotStreak++;
  try { localStorage.setItem(HOT_STREAK_KEY, String(hotStreak)); } catch { /* 忽略 */ }
  if (hotStreak >= 12 && hotStreak % 12 === 0) {
    toast(t("m.hotStreakToast", { n: hotStreak }), "warn", t("m.hotStreakDetail"));
  }
}
function resetHotStreak() {
  if (hotStreak === 0) return;
  hotStreak = 0;
  try { localStorage.setItem(HOT_STREAK_KEY, "0"); } catch { /* 忽略 */ }
}

// ---- 热切后验与后置检查（docs/hot-switch-hardening.md）----
// 后验：客户端日志出现「切换之后」的余额行且池签名变化 = 新号已生效；
// 签名相同 = 弱确认（两个号池恰好同值）；超时无新行 = unknown（客户端空闲没查余额，不代表失败）。
// 注意不能用 entitlement_id 匹配——Start Plan 的 ent_2_0817_* 是全舰队共用模板 id。
let hotVerify = null; // { id, at, preSig, done }
function poolsSig(pools) {
  return (pools || [])
    .map((p) => `${String(p?.show_name || p?.name || "").trim()}=${Number(p?.remaining) || 0}`)
    .sort()
    .join("|");
}
/** 热切成功后调度：后置检查（8s：凭据复核/二次对齐/重物化）+ 生效后验（≤120s）。
 *  后置检查必须确认目标仍是当前在用号才执行：8s 窗口内若又切了一次，
 *  迟到的检查会把 live 凭据重写回旧目标（它无法区分「被客户端覆盖」和「已切走」）。 */
let hotPostTimer = null;
function scheduleHotFollowUp(id) {
  hotVerify = { id, at: Date.now(), preSig: poolsSig(liveSignals?.pools), done: false };
  if (hotPostTimer) clearTimeout(hotPostTimer);
  hotPostTimer = setTimeout(() => {
    hotPostTimer = null;
    if (state?.active_account_id !== id) return;
    invoke("hot_switch_post_check", { id })
      .then((r) => asAuditPush("hot-post", { id, credsResynced: !!r?.creds_resynced, realigned: !!r?.realigned }))
      .catch(() => {});
  }, 8000);
}
function checkHotVerify() {
  if (!hotVerify || hotVerify.done) return;
  const at = Number(liveSignals?.pools_at_ms) || 0;
  if (!at || at <= hotVerify.at + 1000) {
    if (Date.now() - hotVerify.at > 120 * 1000) {
      hotVerify.done = true;
      asAuditPush("hot-verify", { id: hotVerify.id, result: "unknown", note: "idle" });
    }
    return;
  }
  hotVerify.done = true;
  const sig = poolsSig(liveSignals?.pools);
  const result = sig !== hotVerify.preSig ? "applied" : "same-sig";
  asAuditPush("hot-verify", { id: hotVerify.id, result, ageSec: Math.max(1, Math.round((at - hotVerify.at) / 1000)) });
}
/** 设置弹窗里的诊断行：数据源 / 跟随模型 / 剩余时间 / 最近一次决策 */
function autoSwitchDiagLine() {
  const bits = [];
  bits.push(signalsTrusted() ? t("st.sigLog", { age: Math.max(1, Math.round(poolsAgeMs() / 1000)) }) : t("st.sigApi"));
  if (!focusModel()) {
    const m = modelSignal();
    if (m) bits.push(t("st.sigFollow", { model: m }));
  }
  const eta = logStats()?.etaSec ?? apiEta(activeAccount()?.id);
  if (eta != null && eta <= 24 * 3600) bits.push(t("as.eta", { eta: fmtEta(eta) }));
  const last = asAuditLast();
  if (last) bits.push(t("st.sigLast", { kind: last.kind, sec: Math.max(0, Math.round((Date.now() - last.at) / 1000)) }));
  return bits.join(" · ");
}
/** 余额快照的数据年龄（用日志里的时间戳，而不是收到时间：客户端闲时日志会停） */
function poolsAgeMs() {
  const at = Number(liveSignals?.pools_at_ms) || 0;
  return at ? Math.max(0, Date.now() - at) : Infinity;
}
function signalsFresh(ms = SIGNALS_FRESH_MS) {
  return !!liveSignals?.available && poolsAgeMs() < ms;
}
/** 只信任「属于当前登录账号」的余额快照：
 * 1) 快照要够新鲜（客户端闲时日志会停，超窗口就交给 HTTP 轮询）；
 * 2) 切换之后产生的快照才可信（旧账号的余额不能拿来判新账号）。 */
function signalsTrusted() {
  if (!signalsFresh()) return false;
  const at = Number(liveSignals?.pools_at_ms) || 0;
  if (!at) return false;
  if (lastAutoSwitchAt && at <= lastAutoSwitchAt + 1000) return false;
  return true;
}
/** 「计划不可用」信号自己的新鲜度/归属门禁（plan_available 是独立字段）：
 *  余额快照可信而 plan 信号是上一个账号残留的旧判定时，绝不能拿它触发紧急切换。 */
function planSignalUsable() {
  if (liveSignals?.plan_available !== false) return false;
  const at = Number(liveSignals?.plan_at_ms) || 0;
  if (!at || Date.now() - at > SIGNALS_FRESH_MS) return false;
  if (lastAutoSwitchAt && at <= lastAutoSwitchAt + 1000) return false;
  return true;
}
/** 客户端最近在用的模型（用于「未设置关注模型」时跟随真实消耗） */
function modelSignal() {
  const at = Number(liveSignals?.model_at_ms) || 0;
  if (at && Date.now() - at < 30 * 60 * 1000 && liveSignals?.model) return String(liveSignals.model);
  return null;
}
/** 关注模型：未设置时跟随客户端实际在用模型（日志给的 modelId） */
function effectiveFocusModel() {
  const m = focusModel();
  if (m) return m;
  return signalsTrusted() ? (modelSignal() || "") : "";
}
function activeAccount() {
  return (state?.accounts || []).find((a) => a.is_active) || null;
}
/**
 * 当前账号的「日志口径」判定：
 * bestPct 沿用乐观语义（该模型最宽松的池，避免过早切）；
 * etaSec 用「该模型所有池剩余之和 / 合计速率」——尺度无关，不看百分比深浅。
 */
function logStats() {
  if (!signalsTrusted()) return null;
  const model = effectiveFocusModel();
  const pools = Array.isArray(liveSignals.pools) ? liveSignals.pools : [];
  const at = Number(liveSignals.pools_at_ms) || Date.now();
  if (!pools.length) {
    // 客户端明确返回「一个额度池都没有」= 无套餐/全过期。
    // 新号宽限窗口内不误判（套餐还没发放，官方客户端靠启动心跳触发发放）。
    const a = activeAccount();
    const created = Date.parse(String(a?.created_at || "").replace(" ", "T"));
    if (Number.isFinite(created) && Date.now() - created < PENDING_WINDOW_MS) return null;
    return {
      empty: true, count: 0, bestPct: 0, worstPct: 0, bestTokens: 0, worstTokens: 0, totalTokens: 0,
      worstName: null, matched: false, model: model || null, scope: "all",
      rate: null, etaSec: 0, at, planUnavailable: true,
    };
  }
  // 礼物优先：日志池本身不带套餐归属，用 HTTP 数据里的 entitlement_id 映射分类
  const entGift = giftFirstOn() ? entitlementGiftMap(acctQuota[activeAccount()?.id]) : null;
  const st = poolStatsFromSignals(pools, model, entGift);
  if (!st) return null;
  // 烧速的前后两个快照必须同属一次登录：prev 早于最近一次切换 = 跨账号差分
  // （不同账号的同名 entitlement 拼一起会算出垃圾速率），宁可这轮不算
  const prevAt = Number(liveSignals.prev_at_ms) || 0;
  const rate = prevAt > lastAutoSwitchAt + 1000
    ? poolsRate(liveSignals.prev_pools, prevAt, pools, at, model)
    : null;
  // ETA 用「该模型全部池的剩余之和 / 合计速率」：与 poolsRate 同口径，池变动（补发/过期）不会把速率算歪
  let etaSec = null;
  if (rate && st.totalTokens != null && st.totalTokens > 0 && rate.rate > 0) etaSec = st.totalTokens / rate.rate;
  // 礼物优先：ETA 按礼物池口径（服务端先扣礼物，聚合烧速≈礼物烧速），
  // 否则礼物见底时会被常规池的大分母拖住、切晚了
  if (giftFirstOn() && st.giftTokens != null && st.giftTokens > 0 && rate && rate.rate > 0) {
    etaSec = st.giftTokens / rate.rate;
  }
  // plan 信号用自己的新鲜窗口：余额可信而 plan 是旧账号残留时不得触发
  return { ...st, rate, etaSec, at, planUnavailable: planSignalUsable() };
}
/** 该账号 HTTP 口径的池统计（与旧行为一致：命中关注模型则只看该模型） */
function apiStats(id, model = effectiveFocusModel()) {
  return poolStats(acctQuota[id], model);
}
/** HTTP 口径的 ETA（本地样本序列算烧速；日志不可用时才有意义） */
function apiEta(id) {
  const e = etaOf(quotaHist[id]);
  return e ? e.sec : null;
}
/** 活跃账号当前的刷新周期（毫秒）：用于推导安全余量 */
let activeSweepMs = AS_DEFAULTS.marginSec * 1000;
function marginSec() {
  return Math.max(AS_DEFAULTS.marginSec, Math.round((activeSweepMs * 2) / 1000) + 30);
}
function pruneRecentFrom() {
  const cut = Date.now() - 10 * 60 * 1000;
  for (const [id, ts] of recentFrom) if (ts < cut) recentFrom.delete(id);
}
function levelOf(pct, thr) {
  if (pct == null) return "unknown";
  if (pct <= 0) return "dead";
  return pct <= thr ? "low" : "ok";
}
function noteChanged(next) {
  if (next === autoSwitchNote) return;
  autoSwitchNote = next;
  if (!uiLocked()) render();
}

/** 无操作 AUTO_LOCATE_IDLE_MS 后，视图自动定位到在用账号：
 *  只在当前筛选/分组包含它、且它不在可视区时才滚动（scrollIntoView nearest 本身就近乎无操作）；
 *  被筛选掉/分组收起时不定位。 */
function autoLocateTick() {
  if (Date.now() - lastUserActionAt < AUTO_LOCATE_IDLE_MS) return;
  if (isTyping()) return;
  const activeId = state?.active_account_id;
  if (!activeId) return;
  const el = document.querySelector(`.row[data-id="${activeId}"]`);
  if (!el) return;
  const listEl = el.closest(".list");
  const r = el.getBoundingClientRect();
  const lr = (listEl || document.documentElement).getBoundingClientRect();
  if (r.top >= lr.top && r.bottom <= lr.bottom) return; // 已在可视区
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function autoSwitchTitle(s) {
  const bits = [t("as.label"), t("as.threshold", { pct: s?.auto_switch_threshold ?? 15 })];
  const m = String(s?.auto_switch_model || "").trim();
  if (m) bits.push(t("as.model", { model: m }));
  else {
    const fm = modelSignal();
    if (fm && signalsTrusted()) bits.push(t("as.modelFollow", { model: fm }));
  }
  const st = logStats();
  const eta = st?.etaSec ?? apiEta(activeAccount()?.id);
  if (eta != null && eta <= 3600) bits.push(t("as.eta", { eta: fmtEta(eta) }));
  bits.push(signalsTrusted() ? t("as.srcLog", { age: Math.max(1, Math.round(poolsAgeMs() / 1000)) }) : t("as.srcApi"));
  if (hotStreak >= 6) bits.push(t("as.hotStreak", { n: hotStreak }));
  if (autoSwitchRunning) bits.push(t("as.switching"));
  else if (autoSwitchNote) bits.push(autoSwitchNote);
  if (s?.zcode_running && !s?.hot_switch) bits.push(t("as.needHot"));
  return esc(bits.join(" · "));
}

function savePrefs() {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ sort: ui.sort, sortDir: ui.sortDir, density: ui.density, hideInfo: ui.hideInfo, view: ui.view, theme: ui.theme }));
  } catch { /* 忽略 */ }
}

function isTyping() {
  const el = document.activeElement;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function acctGroup(a) {
  return String(a?.group || "").trim();
}

// 看起来像邮箱/手机号的名称，在“隐藏账号信息”时也一并打码
function looksSecret(s) {
  const v = String(s || "");
  return v.includes("@") || /^\+?[\d][\d\s-]{6,}$/.test(v);
}
function nameText(a) {
  return ui.hideInfo && looksSecret(a.name) ? "••••••" : a.name;
}

// 额度查询的鉴权类错误由后端带上语言无关的错误码（见 quota.rs 的 coded()）
const AUTH_CODES = new Set(["token_expired", "token_biz401", "token_http401", "quota_no_token"]);
function isAuthErr(q) {
  return !!q?.code && AUTH_CODES.has(q.code);
}

const HEALTH_PREFIX = "grp.health.";
/** 扩展排序维度的取值：关注模型剩余量 / 礼物剩余量（token 数，从 items 聚合）
 *  注意：计划级 p.remaining 经常为 null，真实额度都在 p.items[].remaining 上 */
function sortKeyValue(a, sort) {
  if (sort !== "focus" && sort !== "gift") return null;
  const plans = acctQuota[a.id]?.data?.plans || [];
  if (sort === "focus") {
    const key = focusModel().trim().toLowerCase();
    if (!key) return -1;
    let sum = 0;
    for (const p of plans) {
      if (planExpired(p)) continue;
      for (const it of p.items || []) {
        if (it.name && modelKeyMatch(it.name.toLowerCase(), key)) sum += Number(it.remaining ?? 0);
      }
    }
    return sum;
  }
  let sum = 0;
  for (const p of plans) {
    if (p.gift !== true || planExpired(p)) continue;
    if (p.remaining != null) sum += Number(p.remaining);
    else for (const it of p.items || []) sum += Number(it.remaining ?? 0);
  }
  return sum;
}
const SORT_PREFIX = "list.sort.";
function healthLabel(level) {
  return t(HEALTH_PREFIX + level);
}
function healthMapOf() {
  const model = state?.auto_switch_model || "";
  const opts = {
    giftFirst: !!state?.auto_switch_gift_first,
    modelFallback: !!state?.auto_switch_model_fallback,
    threshold: Number(state?.auto_switch_threshold ?? 15),
  };
  const map = new Map();
  // 活跃账号的接口数据可能已经一分钟没刷（日志模式下 API 放慢了），但日志是秒级的：
  // 列表/分组也跟着日志走，否则会出现「面板显示 40%、实际已 3%」的误导
  const lg = logStats();
  for (const a of state?.accounts || []) {
    let h = healthOf(a, acctQuota[a.id], isAuthErr, model, opts);
    if (lg && a.is_active && lg.bestPct != null && h.level !== "auth" && h.level !== "fail") {
      const pct = lg.bestPct;
      if (h.remainingPct == null || Math.abs(h.remainingPct - pct) > 0.5) {
        h = { ...h, remainingPct: pct, level: levelOf(pct, opts.threshold), modelMatched: true, modelName: lg.worstName || h.modelName, fromLog: true };
      }
    }
    // 冻结叠加：自动冻结一律进「已冻结」组（bd1f591：风控停靠含停止领取，撞墙号
    // 必须能在冻结组盘点）；手动冻结遮「有额度/状态未定」的号（用户确认的风控嫌疑），
    // 但底层正常耗尽（套餐到期/额度自然耗尽，非风控撞墙）回归额度耗尽组——
    // 10-02 定案：正常耗尽不因手动冻结改组，冻结组只收「风控嫌疑」的号
    if (isFrozen(a.id) && (autoFrozenAt[a.id] || h.level !== "dead")) h = { ...h, level: "frozen" };
    map.set(a.id, h);
  }
  return map;
}
function focusModel() {
  return String(state?.auto_switch_model || "").trim();
}
function pctLabel(h) {
  if (h.remainingPct == null) return t("list.pctUnknown");
  const m = focusModel();
  if (h.modelName) return t("list.modelPct", { model: h.modelName, pct: Math.round(h.remainingPct) });
  if (m && h.modelMatched) return t("list.modelPct", { model: m, pct: Math.round(h.remainingPct) });
  return t("list.pctLeft", { pct: Math.round(h.remainingPct) });
}
// 紧凑行额度小条用的短文案：不带模型名（模型名进 tooltip 和明细区）
function pctShortLabel(h) {
  if (h.remainingPct == null) return t("list.pctUnknown");
  return t("list.pctLeft", { pct: Math.round(h.remainingPct) });
}
function healthDotHtml(h) {
  const p = h.remainingPct == null ? "" : " · " + pctLabel(h);
  return `<span class="hdot ${h.level}" title="${esc(healthLabel(h.level) + p)}"></span>`;
}
// 紧凑行的额度小条（剩余比例）
function quotaChipHtml(id, h) {
  const q = acctQuota[id];
  const pct = h.remainingPct;
  const w = pct == null ? 0 : Math.round(pct);
  const txt = q?.busy && !q?.data ? t("list.querying") : pctShortLabel(h);
  return `<div class="rq ${h.level}" title="${esc(healthLabel(h.level) + (pct == null ? "" : " · " + pctLabel(h)))}">
      <span class="rq-bar"><i style="width:${w}%"></i></span>
      <span class="rq-pct">${esc(txt)}</span>
    </div>`;
}
// 紧凑行的临期提示：空间有限只留“今日到期 / 09-17 到期”，完整时间放 title
function expSoonLabel(exp) {
  const day = String(exp.text).slice(0, 10);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (day === todayStr) return t("list.expToday");
  return t("list.expShort", { date: day.slice(5) });
}
/** 从已读到的额度数据里汇总可用模型（只取“额度池/模型”条目，跳过 提示次数/使用时长 这类窗口） */
function detectedModels() {
  const set = new Set();
  const collect = (items) => {
    for (const it of items || []) {
      if (!it || typeof it.name !== "string") continue;
      if (itemKind(it) !== "raw") continue;
      const n = it.name.trim();
      if (n) set.add(n);
    }
  };
  for (const id of Object.keys(acctQuota)) {
    const d = acctQuota[id]?.data;
    if (!d) continue;
    collect(d.items);
    for (const p of d.plans || []) collect(p.items);
  }
  return [...set].sort((a, b) => a.localeCompare(b, localeTag(), { sensitivity: "base" }));
}

// ---------- 设置弹窗（工具栏齿轮打开；替掉原来的独立设置窗口） ----------

let settingsModalEl = null;
let stOnKey = null;
let autostartOn = false;

function stToggle(key, label, desc, on, extra) {
  return `
  <div class="tog-row">
    <div class="tog-info"><div class="tog-label">${esc(label)}</div><div class="tog-desc">${esc(desc)}</div></div>
    <button class="toggle${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" click="actions.stToggle('${key}')"><span class="knob"></span></button>
  </div>${extra || ""}`;
}

function stAutoSwitchExtra() {
  const cur = focusModel();
  const models = detectedModels();
  const isCustom = ui.modelCustom || (!!cur && !models.includes(cur)) || !models.length;
  const opts = [
    `<option value=""${!cur ? " selected" : ""}>${esc(t("st.modelAll"))}</option>`,
    ...models.map((m) => `<option value="${esc(m)}"${m === cur ? " selected" : ""}>${esc(m)}</option>`),
    `<option value="__custom__"${isCustom ? " selected" : ""}>${esc(t("st.modelCustom"))}</option>`,
  ].join("");
  return `
  <div class="st-sub">
    <div class="st-row">
      <div class="st-lab">${t("s.autoSwitchThr")}</div>
      <div class="st-ctl">
        <input class="auto-switch-thr" type="number" min="1" max="90" step="1" value="${state?.auto_switch_threshold ?? 15}" change="actions.stSetThreshold(event)">
        <span class="thr-pct">%</span>
      </div>
    </div>
    <div class="st-row">
      <div class="st-lab">${t("st.model")}</div>
      <div class="st-ctl">
        <select class="st-model" aria-label="${esc(t("st.model"))}" change="actions.stSetModel(event)">${opts}</select>
        ${isCustom ? `<input class="focus-model" type="text" maxlength="40" placeholder="${esc(t("s.focusModelPh"))}" value="${esc(models.includes(cur) ? "" : cur)}" change="actions.stSetModelCustom(event)">` : ""}
      </div>
    </div>
    <div class="tog-row">
      <div class="tog-info"><div class="tog-label">${t("st.giftFirst")}</div><div class="tog-desc">${t("st.giftFirstDesc")}</div></div>
      <button class="toggle${state?.auto_switch_gift_first ? " on" : ""}" role="switch" aria-checked="${!!state?.auto_switch_gift_first}" aria-label="${esc(t("st.giftFirst"))}" click="actions.stToggle('giftFirst')"><span class="knob"></span></button>
    </div>
    <div class="st-row">
      <div class="st-lab">${t("st.giftOrder")}</div>
      <div class="st-ctl">
        <div class="lang-seg${state?.auto_switch_gift_first ? "" : " dim"}" role="radiogroup" aria-label="${esc(t("st.giftOrder"))}">
          ${[["auto", "st.giftOrderAuto"], ["weekend", "st.giftOrderWeekend"], ["global", "st.giftOrderGlobal"]].map(([v, k]) =>
            `<button class="lang-opt${giftOrderPref() === v ? " on" : ""}" role="radio" aria-checked="${giftOrderPref() === v}" click="actions.stGiftOrder('${v}')">${esc(t(k))}</button>`).join("")}
        </div>
      </div>
    </div>
    <div class="tog-row">
      <div class="tog-info"><div class="tog-label">${t("st.modelFallback")}</div><div class="tog-desc">${t("st.modelFallbackDesc")}</div></div>
      <button class="toggle${state?.auto_switch_model_fallback ? " on" : ""}" role="switch" aria-checked="${!!state?.auto_switch_model_fallback}" aria-label="${esc(t("st.modelFallback"))}" click="actions.stToggle('modelFallback')"><span class="knob"></span></button>
    </div>
    <div class="st-note">${models.length ? t("st.modelDesc", { n: models.length }) : t("st.modelNone")}</div>
    <div class="st-note st-sig">${esc(autoSwitchDiagLine())}</div>
  </div>`;
}

function settingsFormHtml() {
  const s = state;
  return `
  <div class="st-panel" role="dialog" aria-modal="true" aria-label="${esc(t("s.title"))}">
    <div class="st-head">
      <span class="st-title">${ic("sliders", 16)} ${t("s.title")}</span>
      <button class="icon-btn st-close" click="actions.closeSettings()" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${ic("x", 15)}</button>
    </div>
    <div class="st-body">
      <div class="st-sec">${t("st.secAuto")}</div>
      ${stToggle("autoClaim", t("btn.autoClaim"), t("st.autoClaimDesc"), !!s.auto_claim)}
      ${stToggle("autoSwitch", t("as.label"), t("st.autoSwitchDesc"), !!s.auto_switch, stAutoSwitchExtra())}
      <div class="st-row">
        <div class="st-lab" title="${esc(t("st.autoArchiveDeadDesc"))}">${t("st.autoArchiveDead")}</div>
        <div class="st-ctl">
          <div class="lang-seg" role="radiogroup" aria-label="${esc(t("st.autoArchiveDead"))}">
            ${[["0", "st.aaOff"], ["1", "st.aa1h"], ["24", "st.aa24h"], ["72", "st.aa3d"]].map(([v, k]) =>
              `<button class="lang-opt${Number(s.auto_archive_dead_hours ?? 0) === Number(v) ? " on" : ""}" role="radio" aria-checked="${Number(s.auto_archive_dead_hours ?? 0) === Number(v)}" click="actions.stAutoArchive('dead', '${v}')">${esc(t(k))}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="st-row">
        <div class="st-lab" title="${esc(t("st.autoArchiveAgeDesc"))}">${t("st.autoArchiveAge")}</div>
        <div class="st-ctl">
          <div class="lang-seg" role="radiogroup" aria-label="${esc(t("st.autoArchiveAge"))}">
            ${[["0", "st.aaOff"], ["5", "st.aa5d"], ["7", "st.aa7d"], ["10", "st.aa10d"]].map(([v, k]) =>
              `<button class="lang-opt${Number(s.auto_archive_age_days ?? 0) === Number(v) ? " on" : ""}" role="radio" aria-checked="${Number(s.auto_archive_age_days ?? 0) === Number(v)}" click="actions.stAutoArchive('age', '${v}')">${esc(t(k))}</button>`).join("")}
          </div>
        </div>
      </div>

      <div class="st-sec">${t("st.secBehavior")}</div>
      ${stToggle("autostart", t("s.autostart"), t("s.autostartDesc"), !!autostartOn)}
      ${stToggle("launch", t("s.launchAfter"), t("s.launchAfterDesc"), !!s.launch_after_switch)}
      ${stToggle("tray", t("s.closeTray"), t("s.closeTrayDesc"), !!s.close_to_tray)}
      ${stToggle("hot", t("s.hotSwitch"), t("s.hotSwitchDesc"), !!s.hot_switch)}
      ${stToggle("grouped", t("s.grouped"), t("s.groupedDesc"), s.grouped !== false)}

      <div class="st-sec">${t("s.appearance")}</div>
      <div class="st-row">
        <div class="st-lab">${t("s.theme")}</div>
        <div class="st-ctl">
          <div class="lang-seg" role="radiogroup" aria-label="${esc(t("s.theme"))}">
            ${[["amber", "s.themeAmber"], ["teal", "s.themeTeal"], ["mono", "s.themeMono"]].map(([v, k]) =>
              `<button class="lang-opt${ui.theme === v ? " on" : ""}" role="radio" aria-checked="${ui.theme === v}" click="actions.stSetTheme('${v}')">${esc(t(k))}</button>`).join("")}
          </div>
        </div>
      </div>

      <div class="st-sec">${t("s.authLabel")}</div>
      ${stToggle("oauthBrowser", t("s.oauthBrowser"), t("s.oauthBrowserDesc"), s.oauth_browser !== false)}
      ${stToggle("proxy", t("s.proxyToggle"), t("s.proxyToggleDesc"), !!s.auth_proxy_on)}
      <div class="st-row">
        <div class="st-ctl wide">
          <input class="st-input proxy" type="text" value="${esc(s.auth_proxy_url || "")}" placeholder="${esc(t("s.proxyPh"))}" keydown="onProxyKey(event)">
          <button class="btn-ghost" click="actions.stSaveProxy()">${t("common.save")}</button>
        </div>
      </div>

      <div class="st-sec">${t("s.libLabel")}</div>
      <div class="st-row">
        <div class="st-ctl">
          <button class="btn-ghost has-ic" click="actions.stImport()">${ic("import", 14)} ${t("s.importBtn")}</button>
          <button class="btn-ghost has-ic" click="actions.stExportAll()" ${s.accounts.length ? "" : "disabled"}>${ic("exportAll", 14)} ${t("s.exportAllBtn")}</button>
        </div>
      </div>

      <div class="st-sec">${t("s.langLabel")}</div>
      <div class="st-row">
        <div class="lang-seg" role="radiogroup" aria-label="${esc(t("s.langLabel"))}">
          <button class="lang-opt${lang() === "zh" ? " on" : ""}" role="radio" aria-checked="${lang() === "zh"}" click="actions.stSetLang('zh')">${t("s.langZh")}</button>
          <button class="lang-opt${lang() === "en" ? " on" : ""}" role="radio" aria-checked="${lang() === "en"}" click="actions.stSetLang('en')">${t("s.langEn")}</button>
        </div>
      </div>

      <div class="st-sec">${t("s.pathLabel")}</div>
      <div class="st-row">
        <div class="st-ctl wide">
          <input class="st-input path" type="text" value="${esc(s.zcode_path)}" placeholder="C:\\Program Files\\ZCode\\ZCode.exe" keydown="onPathKey(event)">
          <button class="btn-ghost" click="actions.stBrowsePath()">${t("s.browse")}</button>
          <button class="btn-ghost" click="actions.stSavePath()">${t("common.save")}</button>
        </div>
      </div>

      <div class="st-hint">${t("s.hint")}</div>
      <div class="gh-row">
        <a class="gh-link" href="https://github.com/pjpv/zcode-switch" target="_blank" rel="noopener" click="actions.openGitHub()">${t("s.githubLink")}</a>
        ${appVer ? `<span class="ver">v${esc(appVer)}</span>` : ""}
      </div>
    </div>
  </div>`;
}

function syncSettingsModal() {
  if (!settingsModalEl) return;
  settingsModalEl.innerHTML = settingsFormHtml();
}

function closeSettingsModal() {
  document.querySelector(".st-mask")?.remove();
  settingsModalEl = null;
  if (stOnKey) {
    document.removeEventListener("keydown", stOnKey);
    stOnKey = null;
  }
}

async function openSettingsModal() {
  closeSettingsModal();
  autostartOn = await invoke("autostart_status").catch(() => false);
  const mask = document.createElement("div");
  mask.className = "st-mask pv-mask";
  mask.innerHTML = settingsFormHtml();
  document.body.appendChild(mask);
  settingsModalEl = mask;
  stOnKey = (e) => { if (e.key === "Escape") closeSettingsModal(); };
  document.addEventListener("keydown", stOnKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) closeSettingsModal(); });
}

// ---------- 2API 服务弹窗（工具栏插头按钮打开） ----------

// 站方标注长期免费的模型，始终并入 /v1/models（docs.z.ai/guides/overview/pricing）
const FREE_MODELS = ["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"];

let twoApiModalEl = null;
let twoStatusTimer = null;
let twoOnKey = null;
let twoShowToken = false;
let twoLastStatus = null;
let twoUsageMap = new Map();

function twoStatusHtml() {
  const on = !!state?.two_api_on;
  const st = twoLastStatus || {};
  const run = !!st.running;
  const port = st.port || state?.two_api_port || 8117;
  const last = st.last_request_at
    ? new Date(st.last_request_at * 1000).toLocaleTimeString(localeTag(), { hour12: false })
    : "—";
  return `<div class="two-status"><span class="status-dot ${run ? "run" : "off"}"></span>
    <span class="two-state">${run ? esc(t("two.statusOn")) : esc(t("two.statusOff"))}</span>
    <span class="two-meta">127.0.0.1:${port}</span>
    <span class="two-meta">${esc(t("two.requests", { n: st.requests || 0 }))}</span>
    <span class="two-meta">${esc(t("two.errors", { n: st.errors || 0 }))}</span>
    <span class="two-meta">${esc(t("two.lastAt", { time: last }))}</span>
  </div>`;
}

function twoSnippet(name, st) {
  const base = `http://127.0.0.1:${st.two_api_port || 8117}`;
  const token = st.two_api_token || "<your-token>";
  const model = String(st.two_api_models || "").split(",")[0].trim() || "glm-5.3-flash";
  switch (name) {
    case "claude":
      return [
        `export ANTHROPIC_BASE_URL=${base}`,
        `export ANTHROPIC_AUTH_TOKEN=${token}`,
        `claude`,
      ].join("\n");
    case "codex":
      return [
        `export ZSW_API_KEY=${token}`,
        ``,
        `# ~/.codex/config.toml`,
        `model = "${model}"`,
        `model_provider = "zsw"`,
        ``,
        `[model_providers.zsw]`,
        `name = "zsw"`,
        `base_url = "${base}/v1"`,
        `wire_api = "chat"`,
        `env_key = "ZSW_API_KEY"`,
      ].join("\n");
    case "opencode":
      return JSON.stringify({
        provider: {
          zsw: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${base}/v1`, apiKey: token },
            models: { [model]: {} },
          },
        },
      }, null, 2);
    case "pi":
      return [
        `# pi 自定义 OpenAI 兼容模型`,
        `baseUrl = ${base}/v1`,
        `apiKey = ${token}`,
        `model = ${model}`,
      ].join("\n");
    default:
      return "";
  }
}

  /** 默认模型列表：套餐模型（本地额度实测，小写化）+ 官方免费模型 */
  function autoModelList() {
    const set = new Map();
    for (const m of detectedModels()) {
      const k = m.toLowerCase();
      if (!set.has(k)) set.set(k, k);
    }
    for (const m of FREE_MODELS) {
      if (!set.has(m)) set.set(m, m);
    }
    return [...set.values()].join(", ");
  }

  function twoApiFormHtml() {
  const st = state || {};
  const on = !!st.two_api_on;
  const port = st.two_api_port || 8117;
  const base = `http://127.0.0.1:${port}`;
  const token = st.two_api_token || "";
  const tokenShown = !token ? t("two.tokenEmpty") : twoShowToken ? token : token.slice(0, 10) + "••••••••";
  const acctOpts = [
    `<option value=""${!st.two_api_account ? " selected" : ""}>${esc(t("two.accountFollow"))}</option>`,
    ...(st.accounts || []).map((a) => `<option value="${esc(a.id)}"${st.two_api_account === a.id ? " selected" : ""}>${esc(a.name)}</option>`),
  ].join("");
  const epRow = (path, note) => `
    <div class="two-ep"><code>${base}${path}</code><span class="two-ep-note">${esc(note)}</span>
      <button class="icon-btn" title="${esc(t("two.copied"))}" click="actions.twoCopyEndpoint('${path}')">${ic("copy", 13)}</button>
    </div>`;
  const snippetBtn = (key, label) => `
    <details class="two-sn"><summary>${esc(label)}</summary>
      <pre>${esc(twoSnippet(key, st))}</pre>
      <button class="btn-ghost has-ic" click="actions.twoCopySnippet('${key}')">${ic("copy", 13)} ${esc(t("two.copySnippet"))}</button>
    </details>`;
  return `
  <div class="st-panel" role="dialog" aria-modal="true" aria-label="${esc(t("two.title"))}">
    <div class="st-head">
      <span class="st-title">${ic("plug", 16)} ${t("two.title")}</span>
      <button class="icon-btn st-close" click="actions.closeTwoApi()" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${ic("x", 15)}</button>
    </div>
    <div class="st-body">
      ${twoStatusHtml()}
      <div class="tog-row">
        <div class="tog-info"><div class="tog-label">${t("two.on")}</div><div class="tog-desc">${t("two.onDesc")}</div></div>
        <button class="toggle${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${esc(t("two.on"))}" click="actions.twoToggle()"><span class="knob"></span></button>
      </div>

      <div class="st-sec">${t("two.secConfig")}</div>
      <div class="two-cfg-grid">
        <label class="two-cfg"><span>${t("two.port")}</span>
          <input class="two-input two-port" type="number" min="1024" max="65535" value="${port}">
        </label>
        <label class="two-cfg"><span>${t("two.account")}</span>
          <select class="two-input two-account" change="actions.twoSetAccount(event)">${acctOpts}</select>
        </label>
        <label class="two-cfg wide"><span>${t("two.models")}</span>
          <span class="two-models-row">
            <input class="two-input two-models" type="text" value="${esc(st.two_api_models || autoModelList())}" placeholder="${esc(autoModelList())}">
            <button class="btn-ghost has-ic" click="actions.twoDetectModels()" title="${esc(t("two.detectModelsTitle"))}">${ic("refresh", 13)} ${t("two.detectModels")}</button>
          </span>
        </label>
        <label class="two-cfg wide"><span>${t("two.proxy")}</span>
          <input class="two-input two-proxy" type="text" value="${esc(st.two_api_proxy_url || "")}" placeholder="${esc(t("two.proxyHint"))}">
        </label>
        <div class="two-cfg-actions">
          <span class="two-test-result"></span>
          <button class="btn-ghost has-ic" click="actions.twoTest()">${ic("bolt", 14)} ${t("two.test")}</button>
          <button class="btn-ghost" click="actions.twoSaveConfig()">${t("common.save")}</button>
        </div>
      </div>

      <div class="st-sec">${t("two.secToken")}</div>
      <div class="two-token">
        <code class="two-token-val">${esc(tokenShown)}</code>
        <button class="icon-btn" title="${t("two.showToken")}" click="actions.twoToggleTokenShow()">${ic(twoShowToken ? "eyeOff" : "eye", 14)}</button>
        <button class="icon-btn" title="${t("two.tokenCopy")}" click="actions.twoCopyToken()">${ic("copy", 14)}</button>
        <button class="btn-ghost" click="actions.twoRegenToken()">${t("two.tokenRegen")}</button>
      </div>

      <div class="st-sec">${t("two.secEndpoints")}</div>
      ${epRow("/v1/messages", t("two.epAnthropic"))}
      ${epRow("/v1/chat/completions", t("two.epOpenai"))}

      <div class="st-sec">${t("two.secSnippets")}</div>
      ${snippetBtn("claude", t("two.snippetClaude"))}
      ${snippetBtn("codex", t("two.snippetCodex"))}
      ${snippetBtn("opencode", t("two.snippetOpencode"))}
      ${snippetBtn("pi", t("two.snippetPi"))}
      <div class="st-hint">${t("two.hint")}</div>
    </div>
  </div>`;
}

function syncTwoApiModal() {
  if (!twoApiModalEl) return;
  twoApiModalEl.innerHTML = twoApiFormHtml();
}

function closeTwoApiModal() {
  document.querySelectorAll(".two-mask").forEach((m) => m.remove());
  twoApiModalEl = null;
  if (twoOnKey) {
    document.removeEventListener("keydown", twoOnKey);
    twoOnKey = null;
  }
  if (twoStatusTimer) {
    clearInterval(twoStatusTimer);
    twoStatusTimer = null;
  }
}

async function openTwoApiModal() {
  closeTwoApiModal();
  twoLastStatus = await invoke("two_api_status").catch(() => null);
  const mask = document.createElement("div");
  mask.className = "st-mask two-mask pv-mask";
  mask.innerHTML = twoApiFormHtml();
  document.body.appendChild(mask);
  twoApiModalEl = mask;
  twoOnKey = (e) => { if (e.key === "Escape") closeTwoApiModal(); };
  document.addEventListener("keydown", twoOnKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) closeTwoApiModal(); });
  twoStatusTimer = setInterval(async () => {
    if (!twoApiModalEl) return;
    twoLastStatus = await invoke("two_api_status").catch(() => null);
    const old = twoApiModalEl.querySelector(".two-status");
    if (old) old.outerHTML = twoStatusHtml();
  }, 2000);
}

function selectedIds() {
  const all = new Set((state?.accounts || []).map((a) => a.id));
  return [...ui.selected].filter((id) => all.has(id));
}
/** 展示层：当前筛选包含在用账号时把它排到最前（平铺视图用；不改底层排序） */
function pinActiveFirst(list) {
  const activeId = state?.active_account_id;
  if (!activeId) return list;
  const i = (list || []).findIndex((a) => a.id === activeId);
  if (i <= 0) return list;
  const arr = list.slice();
  arr.unshift(...arr.splice(i, 1));
  return arr;
}

function visibleAccounts() {
  const hm = healthMapOf();
  const list = sortAccounts(
    // list.js 的注入约定是「收账号对象」，这里包一层转成 id 判定
    filterAccounts(state?.accounts || [], { search: ui.search, health: ui.health }, hm, { isArchived: (a) => isArchived(a.id) }),
    ui.sort, hm, localeTag(),
    { threshold: Number(state?.auto_switch_threshold ?? 15), dir: ui.sortDir, keyOf: (a) => sortKeyValue(a, ui.sort) },
  );
  return { list, hm };
}

/** 分组视图：自定义分组优先，未分组按"额度健康度"分桶 */
function groupedListHtml(accounts, rowHtml, healthMap) {
  // 归档号在归档视图里独立成组（停靠是用户决定，不混进额度健康度桶）
  const buckets = bucketAccounts(accounts, { localeTag: localeTag(), healthLabel }, healthMap,
    { isArchived: (a) => isArchived(a.id), archivedLabel: t("list.filterArchived") });
  // 体验：当前分组/筛选包含在用账号时，它所在分组提到最前、组内排第一；
  // 不在当前筛选里就不动（不会把在用账号塞进所有分组）
  const activeId = state?.active_account_id;
  const bi = activeId ? buckets.findIndex((b) => b.items.some((a) => a.id === activeId)) : -1;
  if (bi > 0) buckets.unshift(...buckets.splice(bi, 1));
  if (bi >= 0) {
    const items = buckets[0].items;
    const ii = items.findIndex((a) => a.id === activeId);
    if (ii > 0) items.unshift(...items.splice(ii, 1));
  }
  let seq = 0; // 序号跨分组连续，跟随当前排序/筛选的展示顺序
  return buckets.map((b) => {
    const collapsed = ui.collapsedSections.has(b.key);
    const items = collapsed ? b.items : b.items.map((a) => ({ a, n: ++seq }));
    const body = collapsed
      ? ""
      : `<div class="grp-body">${items.map(({ a, n }) => rowHtml(a, n)).join("")}</div>`;
    return `
    <section class="grp-sec${collapsed ? " collapsed" : ""}" data-sec="${esc(b.key)}">
      <button class="grp-head" click="actions.toggleSection(event)" aria-expanded="${collapsed ? "false" : "true"}">
        <span class="grp-chev">${ic("chevDown", 13)}</span>
        <span class="grp-title">${esc(b.label)}</span>
        <span class="grp-num">${t("grp.count", { count: b.items.length })}</span>
      </button>
      ${body}
    </section>`;
  }).join("");
}

const GIFT_CHIPS = [["gift:weekend", "grp.health.giftWeekend"], ["gift:global", "grp.health.giftGlobal"], ["gift:trust", "grp.health.giftTrust"]];

function chipsHtml(sum) {
  // 礼物是正交筛选维度，按活动细分（Weekend/Global Build），永远排在最前；归档是停靠维度，随其后
  const giftLv = GIFT_CHIPS.map(([lv]) => lv);
  const levels = ["all", ...[...giftLv, "archived", ...HEALTH_ORDER].filter((lv) => lv === ui.health || (sum.counts[lv] ?? 0) > 0)];
  return `<div class="chips" role="group" aria-label="${esc(t("list.filterLabel"))}">` +
    levels.map((lv) => {
      const on = ui.health === lv;
      const n = lv === "all" ? (state?.accounts || []).length : sum.counts[lv];
      const giftChip = GIFT_CHIPS.find(([k]) => k === lv);
      const label = lv === "all" ? t("list.filterAll")
        : lv === "archived" ? t("list.filterArchived")
        : giftChip ? t(giftChip[1]) : healthLabel(lv);
      // 冻结筛选的雪花用白色 SVG 图标（与礼物的 🎁 同为「符号先行」，但纯白）
      const icon = lv === "frozen" ? `<span class="snow-ic">${ic("snow", 12)}</span>`
        : lv === "archived" ? `<span class="snow-ic">${ic("box", 12)}</span>` : "";
      return `<button class="chip${lv === "all" ? "" : " " + lv}${on ? " on" : ""}" aria-pressed="${on}" click="actions.setHealth('${lv}')">${icon}${esc(label)}<span class="chip-n">${n}</span></button>`;
    }).join("") + `</div>`;
}

function summaryHtml(sum) {
  const avg = sum.avgRemainingPct == null ? "—" : Math.round(sum.avgRemainingPct) + "%";
  const m = focusModel();
  // 流转显示：活跃账号判定已流转到其它模型时，展示实际生效的模型
  const activeId = state?.active_account_id;
  const hm = healthMapOf();
  const ah = activeId ? hm.get(activeId) : null;
  const eff = m && ah?.fallback && ah?.modelName ? ah.modelName : m;
  // 实际可用 = 总账号 − 冻结（手动+风控）− 归档 − 耗尽（dead）。dead 含每日窗口当天用完的号
  // （跨午夜服务端恢复即自动回流）；冻结/归档旗下的 dead 已由前两项扣过，health 门不会重复计
  const total = (state?.accounts || []).length;
  const parked = (state?.accounts || []).filter((a) => {
    if (isArchived(a.id) || isFrozen(a.id)) return true;
    return hm.get(a.id)?.level === "dead";
  }).length;
  const base = t("list.summary", { n: total, usable: Math.max(0, total - parked), avg });
  const label = eff ? t(eff !== m ? "list.focusModelFlow" : "list.focusModel", { model: eff }) : "";
  return `<span class="lh-sum">${esc(label ? base + " · " + label : base)}</span>`;
}

/** 全库额度汇总：按模型聚合所有已刷新账号的余额（仅 token 类额度） */
function quotaTotals() {
  const key = focusModel().toLowerCase();
  const per = new Map();
  let accounts = 0;
  for (const a of state?.accounts || []) {
    const q = acctQuota[a.id];
    if (!q?.data || q.busy || q.err) continue;
    accounts++;
    // 每账号每模型聚合一行（此前礼物/常规池各占一行，同账号重复出现两次）；
    // 过期套餐的池不可用，不计入（上一期耗尽的 Global Build 会虚增总量）
    const byModel = new Map();
    for (const p of q.data.plans || []) {
      if (planExpired(p)) continue;
      const gift = planIsGift(p);
      for (const it of p.items || []) {
        if (itemKind(it) !== "raw") continue;
        const name = String(it.name || "?");
        let acc = byModel.get(name);
        if (!acc) {
          acc = { remaining: 0, total: 0, giftRemaining: 0, giftTotal: 0, regRemaining: 0, regTotal: 0 };
          byModel.set(name, acc);
        }
        acc.remaining += it.remaining ?? 0;
        acc.total += it.total ?? 0;
        if (gift) { acc.giftRemaining += it.remaining ?? 0; acc.giftTotal += it.total ?? 0; }
        else { acc.regRemaining += it.remaining ?? 0; acc.regTotal += it.total ?? 0; }
      }
    }
    for (const [name, acc] of byModel) {
      const agg = per.get(name) || { name, remaining: 0, total: 0, giftRemaining: 0, sources: [] };
      agg.remaining += acc.remaining;
      agg.total += acc.total;
      agg.giftRemaining += acc.giftRemaining;
      agg.sources.push({
        account: a.name, remaining: acc.remaining, total: acc.total,
        giftRemaining: acc.giftRemaining, giftTotal: acc.giftTotal,
        regRemaining: acc.regRemaining, regTotal: acc.regTotal,
      });
      per.set(name, agg);
    }
  }
  const models = [...per.values()].sort((x, y) => y.remaining - x.remaining);
  for (const m of models) m.sources.sort((x, y) => y.remaining - x.remaining);
  const focus = key ? models.find((x) => modelKeyMatch(x.name.toLowerCase(), key)) || null : null;
  return {
    focus,
    models,
    accounts,
    all: {
      remaining: models.reduce((s, x) => s + x.remaining, 0),
      total: models.reduce((s, x) => s + x.total, 0),
    },
  };
}

function quotaHeadChipHtml(tot) {
  if (!tot || !tot.accounts) return "";
  // 定宽纯按钮：具体数字全部进统计面板，避免 chip 宽度随数值抖动
  return `<button class="qh-chip${ui.qhOpen ? " on" : ""}" data-qh-chip title="${esc(t("list.qhTitle"))}" click="actions.toggleQhDetail()">${esc(t("list.qhBtn"))}</button>`;
}

// 模型专属颜色：按模型名稳定散列取色（标题/Tab 标识用，不参与额度状态色）
const MODEL_COLORS = ["#a9834f", "#5f7d99", "#8672a0", "#a06a72", "#6a9480"];
function modelColor(name) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return MODEL_COLORS[h % MODEL_COLORS.length];
}

// 统计页 Tab：额度池（按模型汇总） / 用量趋势（CLI 本地库真实用量）
const QH_TAB_POOLS = "__pools__";
const QH_TAB_USAGE = "__usage__";
// 额度池 Tab 里被展开（看按账号拆分）的模型
const qhExpanded = new Set();

/** KPI 行：关注模型剩余 / 全模型剩余 / 今日消耗 / N 天消耗（数字等宽字体，来源不同分色） */
function quotaKpisHtml(tot) {
  const f = tot.focus;
  const u = usageData;
  const dayAvg = u ? Math.round(u.week_total / usageDays) : null;
  const val = (v) => (v == null ? "…" : esc(fmtTokens(v)));
  const card = (label, value, sub) => `
    <div class="qhp-kpi">
      <span class="qhp-kpi-label">${esc(label)}</span>
      <span class="qhp-kpi-val">${value}</span>
      <span class="qhp-kpi-sub">${esc(sub)}</span>
    </div>`;
  return `<div class="qhp-kpis">
    ${card(t("list.qhpKpiFocus"), f ? val(f.remaining) : "—", f ? f.name : t("list.qhpKpiFocusNone"))}
    ${card(t("list.qhpKpiAll"), val(tot.all.remaining), t("list.qhpKpiAllSub", { n: tot.models.length }))}
    ${card(t("list.qhpKpiToday"), u ? val(u.today_total) : "…", u ? t("list.qhpKpiTodaySub", { n: u.today_requests }) : t("list.qhUsageLoading"))}
    ${card(t("list.qhpKpiWin", { n: usageDays }), u ? val(u.week_total) : "…", u ? t("list.qhpKpiWeekSub", { v: fmtTokens(dayAvg) }) : t("list.qhUsageLoading"))}
  </div>`;
}

/** 额度池 Tab：每模型一行「礼/常堆叠」水平条 + 直接标注（点击行展开按账号拆分）。
 *  无图例设计：段色即语义——琥珀=礼物池、绿=常规池（与主列表「剩余=绿」同语）、
 *  深底=已消耗；模型名文本仍按模型着色保持身份识别 */
function poolsTabHtml(tot) {
  if (!tot.models.length) return `<div class="qh-empty">${esc(t("list.qhEmpty"))}</div>`;
  const rows = tot.models.map((m) => {
    const color = modelColor(m.name);
    const remPct = m.total > 0 ? Math.max(0, Math.min(100, (m.remaining / m.total) * 100)) : 0;
    // 剩余内部再按 礼物/常规 拆两段（琥珀=礼物、绿=常规，色即语义无需图例）
    const giftPct = m.remaining > 0 ? Math.max(0, Math.min(remPct, (m.giftRemaining / m.total) * 100)) : 0;
    const regPct = Math.max(0, remPct - giftPct);
    const open = qhExpanded.has(m.name);
    const srcs = m.sources.map((src) => {
      const pct = src.total > 0 ? Math.max(0, Math.min(100, (src.remaining / src.total) * 100)) : 0;
      // 与模型行同一套视觉语言：琥珀=礼物池、绿=常规池、深底=已消耗
      //（礼物/常规拆分数值聚合时已带在 src 上）
      const giftPct = src.remaining > 0 && src.giftRemaining > 0
        ? Math.max(0, Math.min(pct, (src.giftRemaining / src.total) * 100)) : 0;
      const regPct = Math.max(0, pct - giftPct);
      const segs = [
        giftPct > 0 ? `<i class="gift" style="width:${giftPct}%"></i>` : "",
        regPct > 0 ? `<i class="reg" style="width:${regPct}%"></i>` : "",
      ].join("");
      const detail = []
        .concat(src.giftTotal > 0 ? [`${t("list.qhGift")} ${fmtTokens(src.giftRemaining)}/${fmtTokens(src.giftTotal)}`] : [])
        .concat(src.regTotal > 0 ? [`${t("list.qhReg")} ${fmtTokens(src.regRemaining)}/${fmtTokens(src.regTotal)}`] : [])
        .join(" · ");
      return `<div class="qhp-arow" title="${esc(detail)}">
        <span class="qhp-aname">${esc(src.account)}</span>
        <span class="qhp-atrack">${segs}</span>
        <span class="qhp-aval">${esc(fmtTokens(src.remaining))}<span class="of">/${esc(fmtTokens(src.total))}</span></span>
      </div>`;
    }).join("");
    return `<div class="qhp-mrow${open ? " open" : ""}">
      <button class="qhp-mhead" aria-expanded="${open}" click="actions.toggleQhModel('${esc(m.name)}')">
        <span class="qhp-mname" style="color:${color}">${esc(m.name)}<span class="qhp-chev">${ic("chevDown", 11)}</span></span>
        <span class="qhp-mtrack">
          ${giftPct > 0 ? `<i class="gift" style="width:${giftPct}%"></i>` : ""}
          ${regPct > 0 ? `<i class="reg" style="width:${regPct}%"></i>` : ""}
        </span>
        <span class="qhp-mval">${esc(fmtTokens(m.remaining))}<span class="of">/${esc(fmtTokens(m.total))}</span></span>
        <span class="qhp-mpct">${Math.round(remPct)}%</span>
      </button>
      ${open && srcs ? `<div class="qhp-arows">${srcs}</div>` : ""}
    </div>`;
  }).join("");
  return `<div class="qhp-sec">${esc(t("list.qhpSecPools"))}</div>${rows}`;
}

/** y 轴取整到「好看」的刻度（1/1.2/1.5/2/2.5/3/4/5/6/8/10 × 10^k） */
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * p >= v) return m * p;
  }
  return 10 * p;
}

/** 近 N 天用量堆叠柱状图（手绘 SVG，FT/Economist 风格：少网格、直接标注、今天高亮） */
function trendChartHtml(daily) {
  if (!Array.isArray(daily) || !daily.length) return `<div class="qh-empty">${esc(t("list.qhpNoDaily"))}</div>`;
  const W = 640, H = 208;
  const padL = 50, padR = 6, padT = 10, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const days = daily.slice(-(usageDays >= 30 ? 31 : 8));
  const totals = days.map((d) => (d.models || []).reduce((s, m) => s + (m.total || 0), 0) || d.total || 0);
  const maxV = niceCeil(Math.max(...totals, 1));
  const y = (v) => padT + ih - (v / maxV) * ih;
  const n = days.length;
  const step = iw / n;
  const bw = Math.min(38, step * 0.52);
  // 长窗口下 x 轴标签稀疏化：每 5 根 + 今天，避免 30 个日期互相压字
  const labelEvery = n > 16 ? 5 : 1;
  const grid = [maxV, maxV / 2].map((v) => `
    <line class="grid" x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}"/>
    <text class="ylab" x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${esc(fmtTokens(v))}</text>`).join("");
  const axis = `<line class="axis" x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}"/>
    <text class="ylab" x="${padL - 6}" y="${y(0) + 3}" text-anchor="end">0</text>`;
  let bars = "", labels = "";
  days.forEach((d, i) => {
    const isToday = i === n - 1;
    const x = padL + i * step + (step - bw) / 2;
    const modelRows = d.models || [];
    const tip = `${d.date} · ${fmtTokens(totals[i] || 0)}\n` +
      modelRows.map((m) => `${m.model} ${fmtTokens(m.total)} (${m.requests})`).join("\n");
    // 自底向上堆叠
    let acc = 0;
    const segs = modelRows.map((m) => {
      const h = (m.total || 0) / maxV * ih;
      const rect = h > 0
        ? `<rect class="seg" x="${x}" y="${y(acc + (m.total || 0))}" width="${bw}" height="${Math.max(h, 0.8)}" fill="${modelColor(m.model)}"><title>${esc(tip)}</title></rect>`
        : "";
      acc += m.total || 0;
      return rect;
    }).join("");
    bars += `<g class="day${isToday ? " today" : ""}">${segs}</g>`;
    const showLab = isToday || i % labelEvery === 0;
    const lab = d.date.length >= 10 ? d.date.slice(5).replace("-", "/") : d.date;
    if (showLab) labels += `<text class="xlab${isToday ? " today" : ""}" x="${x + bw / 2}" y="${H - 7}" text-anchor="middle">${esc(lab)}</text>`;
  });
  return `<svg class="qhp-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("list.qhpSecTrend"))}">${grid}${axis}${bars}${labels}</svg>`;
}

/** 用量趋势 Tab：N 天堆叠柱状图 + 模型明细表（今日/近 N 天/占比），窗口 7/30 可切 */
function usageTabHtml() {
  const u = usageData;
  if (!u) return `<div class="qh-empty">${esc(t("list.qhUsageLoading"))}</div>`;
  if (u.db_missing || (!u.today.length && !u.week.length)) return `<div class="qh-empty">${esc(t("list.qhUsageEmpty"))}</div>`;
  const win = usageDays;
  const winTab = (n) => `<button class="qhd-tab${win === n ? " on" : ""}" click="actions.setUsageDays(${n})">${esc(t("list.qhUsageWin", { n }))}</button>`;
  const weekMax = Math.max(...u.week.map((w) => w.total), 1);
  const rows = u.week.map((w) => {
    const t0 = u.today.find((x) => x.model === w.model);
    const share = (w.total / weekMax) * 100;
    return `<div class="qhp-urow">
      <span class="qhp-uname" style="color:${modelColor(w.model)}" title="${esc(w.model)}">${esc(w.model)}</span>
      <span class="qhp-unum">${esc(fmtTokens(t0?.total || 0))}<small>${esc(t("list.qhpKpiTodaySub", { n: t0?.requests || 0 }))}</small></span>
      <span class="qhp-unum">${esc(fmtTokens(w.total))}</span>
      <span class="qhp-ushare"><i style="width:${share}%;background:${modelColor(w.model)};opacity:.8"></i></span>
    </div>`;
  }).join("");
  return `
    <div class="qhp-sec-h"><span class="qhp-sec">${esc(t("list.qhpSecTrend"))}</span><span class="qh-win">${winTab(7)}${winTab(30)}</span></div>
    <div class="qhp-trend-wrap">${trendChartHtml(u.daily)}</div>
    <div class="qhp-sec">${esc(t("list.qhpSecModels"))}</div>
    <div class="qhp-uhead"><span>${esc(t("list.qhUsageModel"))}</span><span>${esc(t("list.qhUsageToday"))}</span><span>${esc(t("list.qhUsageWin", { n: win }))}</span><span>${esc(t("list.qhpColShare"))}</span></div>
    ${rows}`;
}

function quotaPanelHtml(tot) {
  if (!ui.qhOpen || !tot) return "";
  // 老会话残留的模型名 Tab 一律回落到额度池
  const tab = ui.qhTab === QH_TAB_USAGE ? QH_TAB_USAGE : QH_TAB_POOLS;
  const body = tab === QH_TAB_USAGE ? usageTabHtml() : poolsTabHtml(tot);
  return `<div class="qh-panel" data-qh-pop>
    <div class="qh-head">
      <div>
        <div class="qh-title">${esc(t("list.qhBtn"))}</div>
        <div class="qh-sub">${esc(t("list.qhPopTitle", { n: tot.accounts }))}</div>
      </div>
      <button class="icon-btn sm qh-close" click="actions.toggleQhDetail()" aria-label="close">${ic("x", 14)}</button>
    </div>
    ${quotaKpisHtml(tot)}
    <div class="qhd-tabs">
      <button class="qhd-tab${tab === QH_TAB_POOLS ? " on" : ""}" click="actions.setQhTab('${QH_TAB_POOLS}')">${esc(t("list.qhpTabPools"))}</button>
      <button class="qhd-tab${tab === QH_TAB_USAGE ? " on" : ""}" click="actions.setQhTab('${QH_TAB_USAGE}')">${esc(t("list.qhUsageTab"))}</button>
    </div>
    <div class="qhd-body" data-qh-scroll>${body}</div>
    <div class="qh-foot">${esc(tab === QH_TAB_USAGE ? t("list.qhUsageNote") : t("list.qhpExpandHint"))}</div>
  </div>`;
}

function bulkBarHtml() {
  const ids = selectedIds();
  const n = ids.length;
  if (!n) return "";
  const allFrozen = ids.every((id) => isFrozen(id));
  const allArchived = ids.every((id) => isArchived(id));
  return `<div class="bulk-bar">
    <span class="bulk-n">${esc(t("list.selected", { n }))}</span>
    <span class="lh-sp"></span>
    <button class="btn-ghost has-ic" click="actions.doBulkFreeze(${allFrozen ? "false" : "true"})">${ic("snow", 13)} ${allFrozen ? t("list.bulkUnfreeze") : t("list.bulkFreeze")}</button>
    <button class="btn-ghost has-ic" click="actions.doBulkArchive(${allArchived ? "false" : "true"})">${ic("box", 13)} ${allArchived ? t("list.bulkUnarchive") : t("list.bulkArchive")}</button>
    <button class="btn-ghost danger has-ic" click="actions.askBulkDelete()">${ic("x", 13)} ${t("list.bulkDelete")}</button>
    <button class="btn-ghost" click="actions.clearSelection()">${t("list.clearSel")}</button>
  </div>`;
}

function listHeadHtml(s, sum, visible) {
  const allOn = visible.length > 0 && visible.every((a) => ui.selected.has(a.id));
  const qt = quotaTotals();
  const viewName = s.grouped ? "grouped" : ui.view;
  return `
    <div class="list-head">
      <div class="lh-row">
        <div class="search-box">
          <span class="search-ic">${ic("search", 14)}</span>
          <input class="search-input" type="text" value="${esc(ui.search)}" placeholder="${esc(t("list.searchPh"))}"
            input="actions.setSearch(event)" aria-label="${esc(t("list.searchPh"))}">
          ${ui.search ? `<button class="search-clear" title="${esc(t("list.clearSearch"))}" click="actions.setSearch('')">${ic("x", 12)}</button>` : ""}
        </div>
        <div class="view-seg" role="group" aria-label="${esc(t("grp.viewLabel"))}">
          ${[["flat", "grp.flat"], ["card", "grp.card"], ["grouped", "grp.grouped"]].map(([v, key]) =>
            `<button class="vs-opt${viewName === v ? " on" : ""}" aria-pressed="${viewName === v}" click="${v === "grouped" ? "actions.setGrouped(true)" : `actions.setView('${v}')`}">${t(key)}</button>`).join("")}
        </div>
      </div>
      <div class="lh-row">${chipsHtml(sum)}</div>
      <div class="lh-row lh-tools">
        ${summaryHtml(sum)}
        ${quotaHeadChipHtml(qt)}
        <span class="lh-sp"></span>
        <button class="sel-all" title="${esc(t("list.selectAllVisible"))}" click="actions.selectAllVisible()">
          <span class="rchk sm${allOn ? " on" : ""}" aria-hidden="true">${ic("check", 11)}</span>${t("list.selectAll")}
        </button>
        <button class="icon-btn sm" title="${esc(ui.hideInfo ? t("list.showInfo") : t("list.hideInfo"))}" aria-pressed="${ui.hideInfo}" click="actions.toggleHideInfo()">${ic(ui.hideInfo ? "eyeOff" : "eye", 14)}</button>
        <select class="mini-sel" change="actions.setSort(event)" aria-label="${esc(t("list.sortLabel"))}">
          ${SORTS.map((v) => `<option value="${v}"${ui.sort === v ? " selected" : ""}>${esc(t(SORT_PREFIX + v))}</option>`).join("")}
        </select>
        <button class="icon-btn sm" title="${t("list.sortDirTitle")}" aria-label="${t("list.sortDirTitle")}" click="actions.setSortDir()">${ic(ui.sortDir === -1 ? "arrowUp" : "arrowDown", 13)}</button>
        ${viewName === "card" ? "" : `
        <div class="view-seg" role="group" aria-label="${esc(t("list.densityLabel"))}">
          <button class="vs-opt${ui.density === "compact" ? " on" : ""}" aria-pressed="${ui.density === "compact"}" click="actions.setDensity('compact')">${t("list.density.compact")}</button>
          <button class="vs-opt${ui.density === "detail" ? " on" : ""}" aria-pressed="${ui.density === "detail"}" click="actions.setDensity('detail')">${t("list.density.detail")}</button>
        </div>`}
      </div>
      ${bulkBarHtml()}
    </div>`;
}

async function refresh() {
  state = await invoke("get_state");
  if (state?.language) init(state.language);
  flushPendingCascade();
}

function uiLocked() {
  return renaming !== null || isTyping();
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (e) {
    toast(stripErr(e), "err");
  } finally {
    busy = false;
  }
}

async function loadAcctQuota(id, opts = {}) {
  const cur = acctQuota[id] || {};
  // busy 超时保护：一次请求异常卡住后，超过 20s 允许重新拉取，避免手动刷新永远静默失效
  // force=true（自动切换前的预校验）时不因 busy 跳过，否则预校验会变成空操作
  if (!opts.force && cur.busy && Date.now() - (cur.busyAt || 0) < 20000) return;
  // 保留旧数据只标记 busy：健康度/分组在刷新期间不变，避免条目闪回“待查询额度”
  acctQuota[id] = { ...cur, busy: true, busyAt: Date.now() };
  if (!uiLocked()) render();
  try {
    // quick（批量刷新/扫库）：后端不因“成功但空”而 sleep 2.5s 重查——
    // 50 个空号就是 +125s，首次刷新会被拖到几分钟；心跳照发，前端按「待激活」短周期复查
    const data = await invoke("get_account_quota", { id, quick: !!opts.quick });
    // 套餐结构防抖：偶发解析抖动会返回“无 plans 只有裸 items”的降级概览，
    // 让明细在 完整套餐组/裸池条 之间来回跳变。套餐不会凭空消失（只会带
    // expired 标记留存），沿用上次的 plans 结构即可。
    if (cur.data?.plans?.length && data && !data.plans?.length && data.is_empty !== true) {
      data.plans = cur.data.plans;
    }
    // 空快照防抖：上游对部分账号的 billing/balance 在「满额」与「成功但空」之间抖动
    // （套餐可见性跟随激活心跳，服务端间歇性返回空快照）。空概览有三种形态：
    // source="snapshot_empty"（快照渠道标记）/ source=""（balance 路径）/ 多渠道拼接，
    // 因此只认 is_empty 这个跨形态稳定的标志。一次空快照不得推翻已见过的真实额度——
    // 保留旧数据展示并补一次非 quick 复查（后端非 quick 路径会补激活心跳 + 2.5s 重查，
    // 可见性即恢复）。快速复查封顶 3 次后转 ~30min 慢复查，期间绝不把「曾有过额度」的
    // 号判死：76 号 hardDown 误切、重启后新号掉进额度耗尽分组，都是这条路径的受害者。
    const emptySnap = data?.is_empty === true;
    const hasRem = (x) => Number(x?.remaining ?? 0) > 0 || (x?.items || []).some((i) => Number(i.remaining ?? 0) > 0);
    const prevHadQuota = (cur.data?.plans || []).some(hasRem) || hasRem(cur.data);
    if (emptySnap && prevHadQuota) {
      const tries = (quotaFlapRetry[id] = (quotaFlapRetry[id] || 0) + 1);
      if (tries <= 3 && !isArchived(id)) {
        setTimeout(() => { loadAcctQuota(id, { force: true }).finally(() => scheduleNext(id)); }, 2500 + Math.random() * 3000);
      } else if (!isArchived(id)) {
        quotaDue[id] = Date.now() + 25 * 60e3 + Math.random() * 10 * 60e3;
      }
      // 数据面不变：保留旧数据并清掉 entry 时挂上的 busy（否则 20s 内 sweep 全部跳过
      // 该号）；不更新采样/缓存脏标记（缓存里保留真实额度）
      acctQuota[id] = { ...cur, busy: false };
      if (!uiLocked()) render();
      return;
    }
    quotaFlapRetry[id] = 0;
    acctQuota[id] = { data, err: null, code: null, busy: false };
    // 自动冻结号的解冻证据记账：确定耗尽立即解除 / 健康与空数据双计数（见 noteFrozenQuotaSeen）
    noteFrozenQuotaSeen(id, data);
    // 恢复反馈：此前数据面是空快照（曾被毒化/抖动，多为启动恢复场景）而现在拿到
    // 真实额度 → 明确告知。百分比在数据落位后取口径值
    if (cur.data?.is_empty === true && hasRem(data)) {
      const pct = Math.round(pctPairOf(id).pct ?? 0);
      setTimeout(() => toast(t("m.quotaRecovered", { name: accountName(id), pct }), "ok"), 0);
    }
    quotaFailStreak[id] = 0;
    // balance 的 plans（已生效套餐）登记实例：本号刚领到的新期 id 首现 → 级联其他未持有者；
    // 过期历史实例只登记不级联
    if (data?.plans?.length) {
      notePlanInstances(data.plans.filter((p) => p.pid).map((p) => ({ planId: p.pid, name: p.name || "", expired: !!p.expired })));
    }
    // 采样入队（算烧速/ETA 用）；失败时刻意不刷新样本时间，让“陈旧 → 先刷新”的门禁生效
    quotaSampleAt[id] = Date.now();
    const st = apiStats(id);
    if (st) {
      // 采样带上口径模型：口径变化（跟随模型切换）后旧序列不可比，直接重开——
      // 跨模型差分会算出垃圾烧速（审计里 pct 98% 却 etaSec=0 的伪紧急切换即源于此）
      const m = effectiveFocusModel() || "";
      const hist = quotaHist[id];
      const base = Array.isArray(hist) && hist.length && (hist[hist.length - 1].model || "") === m ? hist : [];
      quotaHist[id] = pushSample(base, sampleFrom(st, Date.now(), m));
    }
    // 采样更新完再落盘：缓存里的 t/hist 与 data 同拍（先落盘会把时间戳/样本滞后一个周期）
    markQuotaCacheDirty();
    flushQuotaCache();
  } catch (e) {
    // 失败时也保留旧数据展示，错误信息进明细区；没旧数据才回落到错误态
    acctQuota[id] = { data: cur.data || null, err: stripErr(e), code: errCode(e), busy: false };
    quotaFailStreak[id] = (quotaFailStreak[id] || 0) + 1;
    // 解冻证据要求「连续」刷新：失败一次就双计数清零
    if (autoFrozenAt[id]) { autoUnfreezeHits[id] = 0; autoUnfreezeEmpty[id] = 0; }
    // 拉取失败（429/3012/网络）→ 指数退避（6s → 12s → 24s → …上限 30 分钟；成功清零），
    // 持续失败的账号不再以 6s 频率轰炸接口；活跃号 hardDown 只需连续 2 次失败，仍可在 ~20s 内触发
    // 归档号不排自动重试（手动刷新是它唯一的拉取来源）
    if (!isArchived(id)) quotaDue[id] = Date.now() + failBackoffMs(quotaFailStreak[id]);
  }
  if (!uiLocked()) render();
  // 任意账号的额度数据更新 → 立即跑一次切换判定（目标账号拿到额度/当前账号耗尽都能秒级反应）
  if (state?.auto_switch) {
    autoSwitchTick(false);
  }
}

async function loadClaimPreview(id) {
  const cur = claimable[id] || {};
  if (cur.busy) return;
  claimable[id] = { plans: cur.plans || [], busy: true };
  try {
    const plans = await invoke("claim_preview", { id });
    claimable[id] = { plans: plans || [], err: null, busy: false };
  } catch (e) {
    claimable[id] = { plans: cur.plans || [], err: String(e), busy: false };
  }
}

let claimWaiter = null;
function waitForClaimResult(accountId, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; claimWaiter = null; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), timeoutMs);
    claimWaiter = { accountId, finish };
  });
}

// claim_start「报价已撤」载荷：后端重新 preview 发现目标 plan 不在时，
// 把最新报价以 {gone, plans} JSON 随错误带回——调用方就地把 claimable 校准成真，
// 礼盒图标免刷新自愈（礼包跨期轮换后不再「点一次错一次」），也不必再发第三次 preview
function claimGonePayload(e) {
  const s = String(e || "");
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v.gone === "string" && Array.isArray(v.plans) ? v : null;
  } catch { return null; }
}

// 手动操作抢占自动领取轮：立即终结进行中的等待、取消挂起领取、
// 唤醒轮内账号间隙睡眠，轮次毫秒级就地收尾（finally 释放 autoClaimRunning）；
// 被抢占账号 90s 后即可重试，余下账号由后续 tick 接续。手动领取/手动刷新完成后自动恢复。
let autoGapWake = null;
function autoClaimGapSleep(ms) {
  return new Promise((res) => {
    const t = setTimeout(() => { autoGapWake = null; res(); }, ms);
    autoGapWake = () => { clearTimeout(t); res(); };
  });
}
function preemptAutoClaim() {
  autoAbortRequested = true;
  autoClaimPaused = true;
  const w = claimWaiter;
  if (w) w.finish({ ok: false, code: "preempted", accountId: w.accountId, accountName: accountName(w.accountId) });
  autoGapWake?.(); // 立即唤醒账号间隙睡眠，抢占不再等最长 12s+
  return invoke("claim_cancel").catch(() => {});
}
async function waitAutoClaimWindDown(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (autoClaimRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !autoClaimRunning;
}

async function awaitClaimPreviewFresh(id) {
  claimable[id] = { ...(claimable[id] || {}), busy: true };
  try {
    const plans = await invoke("claim_preview", { id });
    claimable[id] = { plans: plans || [], err: null, busy: false };
  } catch (e) {
    claimable[id] = { plans: claimable[id]?.plans || [], err: String(e), busy: false };
  }
}

const accountName = (id) => (state?.accounts || []).find((a) => a.id === id)?.name || id;

function autoPillTitle(s) {
  const bits = [t("btn.autoClaimTitle")];
  if (autoClaimRunning) bits.push(t(s.auto_claim ? "m.autoClaimRound" : "m.autoClaimStopping"));
  if (lastAutoRound) {
    const d = new Date(lastAutoRound.at);
    const time = d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString(localeTag(), { hour12: false })
      : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toLocaleTimeString(localeTag(), { hour12: false })}`;
    bits.push(t("m.autoClaimLast", { time, claimed: lastAutoRound.claimed, skipped: lastAutoRound.skipped }));
    if (lastAutoRound.cooldownAll) bits.push(t("m.autoClaimCooldownAll"));
  }
  return esc(bits.join(" · "));
}

const actions = {
  async refresh() { await refresh(); render(); },

  async capture() {
    await guard(async () => {
      const r = await invoke("capture_current", { name: null });
      toast(t("m.toastSaved", { name: r.name }), "ok", t("m.toastSavedDetail"));
      await refresh(); render();
      enrollAccounts();
      // 新账号入库：稍等 ZCode 落盘凭据后立刻拉额度（立即拉可能与写盘竞争）
      setTimeout(() => loadAcctQuota(r.id), 1500);
      // 新号上游还没有任何套餐（Start Plan 余额行跟着首次领取事件一起发放），
      // urgent 检查尽快进入自动领取（激活走 180s 快槽），领完才有额度可查
      armClaimCheck(r.id);
    });
  },

  async rename(id) {
    renaming = id; render();
    // 行与卡片两种容器：统一按 data-id 找输入框（卡片视图点击名字进入重命名时同样聚焦）
    const input = document.querySelector(`[data-id="${id}"] .rename-input`);
    if (input) { input.focus(); input.select(); }
  },

  async doRename(id) {
    const input = document.querySelector(`.row[data-id="${id}"] .rename-input`);
    const name = (input?.value || "").trim();
    if (!name) return;
    window.__renameSaving = true;
    clearTimeout(window.__renameBlurTimer);
    await guard(async () => {
      const r = await invoke("rename_account", { id, name });
      toast(t("m.toastRenamed", { name: r.name }));
      renaming = null;
      await refresh(); render();
    }).finally(() => { window.__renameSaving = false; });
  },

  cancelRename() { renaming = null; render(); },

  deferCancelRename(id) {
    clearTimeout(window.__renameBlurTimer);
    window.__renameBlurTimer = setTimeout(() => {
      if (renaming === id && !window.__renameSaving) actions.cancelRename();
    }, 180);
  },

  toggleQhDetail() {
    if (ui.qhOpen || quotaModalEl) closeQuotaModal(); else openQuotaModal();
    render();
  },

  setQhTab(name) {
    ui.qhTab = name;
    refreshQuotaModal();
  },

  /** 用量趋势窗口切换（7/30 天）：立即读取中，取回后重渲染 */
  async setUsageDays(n) {
    const next = Number(n) >= 30 ? 30 : 7;
    if (usageDays === next) return;
    usageDays = next;
    usageData = null;
    refreshQuotaModal();
    await loadUsageStats();
  },

  /** 统计页「额度池」：展开/收起某模型的按账号拆分 */
  toggleQhModel(name) {
    if (qhExpanded.has(name)) qhExpanded.delete(name);
    else qhExpanded.add(name);
    refreshQuotaModal();
  },

  setSortDir() {
    ui.sortDir = ui.sortDir === -1 ? 1 : -1;
    savePrefs();
    render();
  },

  /** 卡片即切换：点卡片 = askSwitch；在用账号点卡片无效 */
  cardSwitch(id) {
    if (state?.accounts?.some((a) => a.id === id && a.is_active)) return;
    actions.askSwitch(id);
  },

  /** 空操作：占位阻断事件冒泡到卡片级 click（如卡片工具条容器） */
  noop() {},

  async setGrouped(on) {
    if (!!state?.grouped === !!on) return;
    await guard(async () => {
      await invoke("set_behavior", { grouped: on });
      await refresh(); render();
    });
  },

  /** 视图切换（平铺/卡片/分组）：平铺与卡片是列表形态，分组沿用后端 grouped 开关 */
  async setView(v) {
    const view = v === "card" ? "card" : "flat";
    if (ui.view !== view) { ui.view = view; savePrefs(); }
    if (state?.grouped) {
      await guard(async () => {
        await invoke("set_behavior", { grouped: false });
        await refresh(); render();
      });
    } else render();
  },

  /** 强调色主题：html[data-theme] 即时生效，偏好落 localStorage */
  stSetTheme(v) {
    applyTheme(v);
    savePrefs();
    syncSettingsModal();
  },

  toggleSection(ev) {
    const key = ev?.target?.closest?.(".grp-sec")?.dataset?.sec;
    if (!key) return;
    if (ui.collapsedSections.has(key)) ui.collapsedSections.delete(key);
    else ui.collapsedSections.add(key);
    render();
  },

  setSearch(ev) {
    const el = ev?.target;
    ui.search = String(el?.value ?? "");
    window.__searchPos = el && el.selectionStart != null ? el.selectionStart : ui.search.length;
    render();
  },

  setHealth(lv) {
    ui.health = (lv === "archived" || lv.startsWith("gift:") || HEALTH_ORDER.includes(lv)) ? lv : "all";
    render();
  },

  setSort(ev) {
    const v = String(ev?.target?.value || "");
    ui.sort = SORTS.includes(v) ? v : "quota";
    savePrefs();
    render();
  },

  setDensity(v) {
    ui.density = v === "detail" ? "detail" : "compact";
    ui.expanded.clear();
    savePrefs();
    render();
  },

  toggleHideInfo() {
    ui.hideInfo = !ui.hideInfo;
    savePrefs();
    render();
  },

  toggleRow(ev) {
    const id = ev?.target?.closest?.(".row, .card")?.dataset?.id;
    if (!id) return;
    if (ui.expanded.has(id)) ui.expanded.delete(id);
    else ui.expanded.add(id);
    render();
  },

  toggleSelect(id, event) {
    // Shift 联动：以上一次点选的行（锚点）为起点，把可见列表中的区间统一成本行的目标状态；
    // shift 点击不移动锚点。锚点失效（筛选/视图变化后不在可见列表）时退化为普通点选
    const shift = !!event?.shiftKey;
    if (shift && ui.lastCheckedId && ui.lastCheckedId !== id) {
      const visible = visibleAccounts().list.map((a) => a.id);
      const i1 = visible.indexOf(ui.lastCheckedId);
      const i2 = visible.indexOf(id);
      if (i1 >= 0 && i2 >= 0) {
        const setTo = !ui.selected.has(id);
        for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) {
          if (setTo) ui.selected.add(visible[i]);
          else ui.selected.delete(visible[i]);
        }
        render();
        return;
      }
    }
    if (ui.selected.has(id)) ui.selected.delete(id);
    else ui.selected.add(id);
    ui.lastCheckedId = id;
    render();
  },

  selectAllVisible() {
    const { list } = visibleAccounts();
    const allOn = list.length > 0 && list.every((a) => ui.selected.has(a.id));
    for (const a of list) {
      if (allOn) ui.selected.delete(a.id);
      else ui.selected.add(a.id);
    }
    render();
  },

  clearSelection() {
    ui.selected.clear();
    render();
  },

  clearFilters() {
    ui.search = "";
    ui.health = "all";
    render();
  },

  askBulkDelete() {
    const ids = selectedIds();
    if (!ids.length) return;
    openConfirmModal({
      kind: "danger",
      icon: "x",
      title: t("list.bulkDeleteTitle", { n: ids.length }),
      desc: t("list.bulkDeleteDesc"),
      yesLabel: t("common.delete"),
      onYes: () => actions.doBulkDelete(ids),
    });
  },

  /** 批量冻结/解冻：冻结的账号不参与自动切换（手动切换不受影响） */
  doBulkFreeze(freeze) {
    const ids = selectedIds();
    if (!ids.length) return;
    for (const id of ids) {
      if (freeze) {
        // 显式批量冻结把自动冻结「提升」为手动冻结：用户拍板的停靠必须由用户解除，
        // 不得被自动解冻路径（额度恢复/耗尽坐实）绕过
        if (autoFrozenAt[id]) {
          delete autoFrozenAt[id];
          delete autoUnfreezeHits[id];
          delete autoUnfreezeEmpty[id];
        }
        frozenIds.add(id);
        // 手动冻结 = 风控冻结代位（用户弥补风控不及时）：与自动冻结同轨「停靠含停止领取」
        delete claimUrgent[id];
        autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
          Date.now() + autoClaimGap(3 * 60 * 60 * 1000));
      } else {
        frozenIds.delete(id);
        delete autoFrozenAt[id];
        autoRiskStreak[id] = 0;
        delete autoClaimCooldown[id];
        delete autoUnfreezeHits[id];
        delete autoUnfreezeEmpty[id];
      }
    }
    if (ids.length) { saveFrozen(); saveAutoFrozen(); saveClaimCooldown(); }
    toast(t(freeze ? "list.toastBulkFrozen" : "list.toastBulkUnfrozen", { n: ids.length }), "ok", t("m.frozenDetail"));
    render();
    // 冻结在用账号 = 明确要求切走：立即触发自动切换
    if (freeze && state?.auto_switch && ids.some((id) => state?.accounts?.some((a) => a.id === id && a.is_active))) {
      kickSwitchNow();
    }
  },

  /** 批量归档/取消归档：与单个归档同语义（不自动刷新/领取/切换，手动保留）。
   *  批量归档含在用号时同样触发立即切换；取消归档清领取冷却让其尽快回轮。
   *  操作后清空选中集：归档/取消归档都会让账号离开当前视图，残留选中会让
   *  「归档/取消归档」按钮翻转成反向操作，看着像误触发 */
  doBulkArchive(archive) {
    const ids = selectedIds();
    if (!ids.length) return;
    for (const id of ids) {
      if (archive) archivedIds.add(id);
      else {
        archivedIds.delete(id);
        delete autoClaimCooldown[id];
      }
    }
    saveArchived();
    ui.selected.clear();
    ui.lastCheckedId = null;
    toast(t(archive ? "list.toastBulkArchived" : "list.toastBulkUnarchived", { n: ids.length }), "ok",
      t(archive ? "m.archivedDetail" : "m.unarchivedDetail"));
    render();
    if (archive && state?.auto_switch && ids.some((id) => state?.accounts?.some((a) => a.id === id && a.is_active))) {
      noteChanged(t("as.noteArchivedActive"));
      kickSwitchNow();
    }
  },

  async doBulkDelete(ids) {
    await guard(async () => {
      let ok = 0;
      for (const id of ids) {
        try { await invoke("delete_account", { id }); ok++; } catch { /* 单个失败不阻断 */ }
      }
      for (const id of ids) ui.selected.delete(id);
      toast(t("list.toastBulkDeleted", { n: ok }), ok === ids.length ? "ok" : "warn");
      await refresh(); render();
    });
  },

  /** 刷新额度（纯额度扫描；领取资格刷新只属于自动领取轮，避免同窗口双倍请求）；再点一次 = 停止 */
  async refreshAll() {
    if (quotaSweep.running) {
      quotaSweep.cancel = true;
      return;
    }
    const ids = (state?.accounts || []).filter((a) => !isArchived(a.id)).map((a) => a.id);
    if (!ids.length) return;
    // 当前使用中的账号优先刷新：全库刷新一个周期很久，而决定“要不要切”的正是活跃账号
    const act = (state?.accounts || []).find((a) => a.is_active);
    const order = act ? [act.id, ...ids.filter((i) => i !== act.id)] : ids;
    quotaSweep = { running: true, done: 0, total: ids.length, cancel: false };
    // 恢复计数基线：刷新前数据面为空/无数据的账号，刷新后拿到真实额度即计入「恢复」
    const wasEmpty = new Set(
      ids.filter((id) => {
        const q = acctQuota[id];
        return !q?.data || q.data.is_empty === true || !!q.err;
      }),
    );
    render();
    let cancelled = false;
    try {
      for (const id of order) {
        if (quotaSweep.cancel) { cancelled = true; break; }
        await loadAcctQuota(id, { quick: true });
        quotaSweep.done++;
        if (!isTyping()) render();
        // 批量刷新限速：每账号 1.2s±40%。一次全量 = 76 × 2-3 个上游请求，
        // 旧的 200ms 节奏会在 ~30s 内堆出 150+ 请求，直接触发风控
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
      }
    } finally {
      const done = quotaSweep.done;
      cancelled = cancelled || quotaSweep.cancel;
      quotaSweep = { running: false, done: 0, total: 0, cancel: false };
      // 刷新效果可见：多少个「空数据/判死」的账号这次拿到了真实额度
      let recovered = 0;
      for (const id of wasEmpty) {
        const q = acctQuota[id];
        if (q?.data && q.data.is_empty !== true) recovered++;
      }
      if (cancelled) toast(t("list.toastSweepCancelled", { n: done }));
      else toast(t("list.toastSweepDone", { n: done }) + (recovered > 0 ? t("list.toastSweepRecovered", { m: recovered }) : ""));
      render();
      // 刷新期间被要求重查的账号（拿不到数据/太旧）：窗口一结束补一轮，不再卡在「陈旧」没人管
      drainStaleWant();
      if (!cancelled) sweepTick();
      if (state?.auto_switch) autoSwitchTick(true);
    }
  },

  async delete(id) {
    const a = state?.accounts.find((x) => x.id === id);
    if (!a) return;
    openConfirmModal({
      kind: "danger",
      icon: "x",
      title: t("m.deleteTitle", { name: a.name }),
      desc: t("m.deleteDesc"),
      yesLabel: t("common.delete"),
      // 确认即关弹窗：删除可能被后台长操作（持全局锁的网络调用等）短暂阻塞，
      // 结果用 toast 反馈，UI 不停留在删除确认上
      fireAndForget: true,
      onYes: () => actions.doDelete(id),
    });
  },

  async doDelete(id) {
    await guard(async () => {
      await invoke("delete_account", { id });
      // 会话内状态一并清掉：否则该号残留在额度缓存/采样/队列里，
      // 且持久化缓存会把已删除的号一直带下去（下次启动又出现）
      delete acctQuota[id]; delete quotaHist[id]; delete quotaSampleAt[id];
      delete quotaDue[id]; delete quotaFailStreak[id]; delete quotaForceAt[id];
      delete autoClaimCooldown[id]; delete autoClaimEmptyRounds[id]; delete autoClaimFailRounds[id]; delete autoFrozenAt[id]; delete autoRiskStreak[id]; delete autoRiskLastAt[id]; delete autoUnfreezeHits[id]; delete autoUnfreezeEmpty[id]; delete claimable[id];
      // 冻结/归档集合与停靠冷却是 localStorage 持久化的：不删会让已删号的 id 永久残留
      frozenIds.delete(id); saveFrozen();
      archivedIds.delete(id); saveArchived();
      saveClaimCooldown();
      ui.selected.delete(id); ui.expanded.delete(id);
      markQuotaCacheDirty(); flushQuotaCache(true);
      toast(t("m.toastDeleted"));
      await refresh(); render();
    });
  },

  askSwitch(id) {
    if (state.zcode_running && !state.hot_switch) {
      const a = state.accounts.find((x) => x.id === id);
      if (!a) return;
      openConfirmModal({
        kind: "warn",
        icon: "swap",
        title: t("m.switchTitle", { name: a.name }),
        desc: `<span class="warn-line">${t("m.switchDesc", { restart: t(state.launch_after_switch ? "m.switchRestartYes" : "m.switchRestartNo") })}</span>`,
        yesLabel: t("m.switchYes"),
        onYes: () => actions.doSwitch(id, true),
      });
    } else {
      actions.doSwitch(id, false);
    }
  },

  /** 行内快捷「强制重启」：关闭并重新打开 ZCode（活跃账号也可用，等于对当前账号重启应用配置） */
  askColdSwitch(id) {
    const a = state.accounts.find((x) => x.id === id);
    if (!a) return;
    const isActive = !!a.is_active;
    openConfirmModal({
      kind: "warn",
      icon: "restart",
      title: isActive ? t("m.coldRestartTitle") : t("m.coldSwitchTitle", { name: a.name }),
      desc: t("m.coldSwitchDesc"),
      yesLabel: t("m.coldSwitchYes"),
      onYes: () => actions.doColdSwitch(id),
    });
  },

  async doColdSwitch(id) {
    await guard(async () => {
      // force=true：目标已是活跃账号也重新落盘应用（等效对当前账号重启 ZCode）
      const r = await invoke("switch_to", { id, force: true, restart: true, hot: false });
      if (r.already_active) {
        const bits = [];
        if (r.killed) bits.push(t("m.bitKilled"));
        if (r.launched) bits.push(t("m.bitLaunched"));
        toast(t("m.toastAlready", { name: r.name }), "ok", bits.join(t("common.listSep")));
        return;
      }
      const bits = [];
      if (r.killed) bits.push(t("m.bitKilled"));
      if (r.launched) bits.push(t("m.bitLaunched"));
      if (r.config_stale) bits.push(t("m.bitConfigStale"));
      toast(t("m.toastSwitched", { name: r.name }), r.config_stale ? "warn" : "ok", bits.join(t("common.listSep")));
      // 同 doSwitch：手动冷切也要作废切换前的日志信号；客户端重启 = 设备身份恢复隔离
      lastAutoSwitchAt = Date.now();
      resetHotStreak();
      ui.expanded.delete(id);
      await refresh();
      pokeAccount(id);
      armClaimCheck(id); // 冷切同样是「切换完成」事件：新当前账号立即检查领取
      if (!uiLocked()) render();
    });
  },

  async doSwitch(id, force) {
    await guard(async () => {
      const restart = state.launch_after_switch;
      const r = await invoke("switch_to", { id, force, restart });
      if (r.already_active) {
        const bits = [];
        if (r.killed) bits.push(t("m.bitKilled"));
        if (r.launched) bits.push(t("m.bitLaunched"));
        toast(t("m.toastAlready", { name: r.name }), "ok", bits.join(t("common.listSep")));
      } else {
        const bits = [];
        if (r.hot) bits.push(t("m.bitHot"));
        if (r.killed) bits.push(t("m.bitKilled"));
        if (r.preserved_as) bits.push(t("m.bitPreserved", { name: r.preserved_as }));
        if (r.launched) bits.push(t("m.bitLaunched"));
        if (r.config_stale) bits.push(t("m.bitConfigStale"));
        toast(t("m.toastSwitched", { name: r.name }), r.config_stale ? "warn" : "ok", bits.join(t("common.listSep")));
        // 手动切换同样要作废切换前的日志信号（旧账号余额不得拿来判新账号）
        // 并进入短保护窗，否则最长 3 分钟内决策都拿着上一个账号的快照
        lastAutoSwitchAt = Date.now();
        if (r?.hot) noteHotSwitch();
      }
      ui.expanded.delete(id);
      await refresh(); render();
      pokeAccount(id);
      // 当前使用中的账号优先：切到谁就立刻给谁做一次领取检查（T0 层语义）
      armClaimCheck(id);
      if (r?.hot) scheduleHotFollowUp(id);
    });
  },

  async updateFromLive(id) {
    await guard(async () => {
      const r = await invoke("update_account_from_live", { id });
      toast(t("m.toastSynced", { name: r.name }), "ok", t("m.toastSyncedDetail"));
      await refresh(); render();
    });
  },

  async exportOne(id) {
    await guard(async () => {
      const p = await invoke("export_pick_path", { id });
      if (!p.picked) { toast(t("m.exportCanceled")); return; }
      openPwModal({ mode: "export", id, path: p.path, name: p.name });
    });
  },

  async launch() {
    await guard(async () => {
      await invoke("launch_zcode");
      toast(t("m.launching"));
      setTimeout(() => actions.refresh(), 2500);
    });
  },

  askKill() {
    openConfirmModal({
      kind: "danger",
      icon: "power",
      title: t("m.killTitle"),
      yesLabel: t("m.killYes"),
      onYes: () => actions.doKill(),
    });
  },

  async doKill() {
    await guard(async () => {
      await invoke("kill_zcode");
      toast(t("m.toastKilled"));
      await refresh(); render();
    });
  },

  openSettings() {
    return openSettingsModal().catch((e) => {
      console.warn("settings modal failed:", e);
      toast(stripErr(e), "err");
    });
  },

  async applySetting(patch, msg) {
    await guard(async () => {
      await invoke("set_behavior", patch);
      await refresh();
      render();
      syncSettingsModal();
      if (msg) toast(msg);
    });
  },

  async stToggle(key) {
    const s = state;
    if (key === "autostart") {
      await guard(async () => {
        autostartOn = await invoke("autostart_set", { enable: !autostartOn }).catch(() => autostartOn);
        syncSettingsModal();
        toast(autostartOn ? t("s.autostartOnToast") : t("s.autostartOffToast"));
      });
      return;
    }
    if (key === "proxy") { await actions.stToggleProxy(); return; }
    // 两个自动化开关共用工具栏那套逻辑（含立即开跑 / 轮次提示）
    if (key === "autoClaim") { await actions.toggleAutoClaim(); return; }
    if (key === "autoSwitch") { await actions.toggleAutoSwitch(); return; }
    const map = {
      launch: ["launchAfterSwitch", "launch_after_switch"],
      tray: ["closeToTray", "close_to_tray"],
      hot: ["hotSwitch", "hot_switch"],
      grouped: ["grouped", "grouped"],
      oauthBrowser: ["oauthBrowser", "oauth_browser"],
      giftFirst: ["autoSwitchGiftFirst", "auto_switch_gift_first"],
      modelFallback: ["autoSwitchModelFallback", "auto_switch_model_fallback"],
    };
    const hit = map[key];
    if (!hit) return;
    const [param, field] = hit;
    const prev = !!s?.[field];
    const next = !prev;
    if (s) s[field] = next;
    render();
    syncSettingsModal();
    try {
      await invoke("set_behavior", { [param]: next });
      await refresh();
      render();
      syncSettingsModal();
    } catch (e) {
      if (s) s[field] = prev;
      render();
      syncSettingsModal();
      toast(stripErr(e), "err");
    }
  },

  /** 礼物消耗顺序：auto=临期优先 / weekend=先 Weekend Build / global=先 Global Build */
  async stGiftOrder(v) {
    const order = v === "weekend" || v === "global" ? v : "auto";
    const prev = state?.auto_switch_gift_order || "auto";
    if (order === prev) return;
    if (state) state.auto_switch_gift_order = order;
    render();
    syncSettingsModal();
    try {
      await invoke("set_behavior", { autoSwitchGiftOrder: order });
      await refresh();
      render();
      syncSettingsModal();
    } catch (e) {
      if (state) state.auto_switch_gift_order = prev;
      render();
      syncSettingsModal();
      toast(stripErr(e), "err");
    }
  },

  /** 自动归档阈值（小时/天，0=关）：乐观更新 + set_behavior，失败回滚 */
  async stAutoArchive(kind, v) {
    const n = Math.max(0, Number(v) || 0);
    const field = kind === "dead" ? "auto_archive_dead_hours" : "auto_archive_age_days";
    const param = kind === "dead" ? "autoArchiveDeadHours" : "autoArchiveAgeDays";
    const prev = Number(state?.[field] ?? 0);
    if (n === prev) return;
    if (state) state[field] = n;
    render();
    syncSettingsModal();
    try {
      await invoke("set_behavior", { [param]: n });
      await refresh();
      render();
      syncSettingsModal();
      if (n > 0) autoArchiveTick(); // 阈值收紧后立即评估一轮
    } catch (e) {
      if (state) state[field] = prev;
      render();
      syncSettingsModal();
      toast(stripErr(e), "err");
    }
  },

  async stToggleProxy() {
    const input = document.querySelector(".st-panel .st-input.proxy");
    const url = (input?.value || "").trim() || state?.auth_proxy_url || null;
    await guard(async () => {
      try {
        await invoke("set_auth_proxy", { on: !state?.auth_proxy_on, url });
        await refresh(); render(); syncSettingsModal();
        toast(state.auth_proxy_on ? t("s.proxyOnToast") : t("s.proxyOffToast"), "ok", t("s.proxyOnDetail"));
      } catch (e) { toast(stripErr(e), "err"); }
    });
  },

  async stSaveProxy() {
    const input = document.querySelector(".st-panel .st-input.proxy");
    if (!input) return;
    await guard(async () => {
      try {
        await invoke("set_auth_proxy", { on: !!state?.auth_proxy_on, url: input.value.trim() });
        await refresh(); render(); syncSettingsModal();
        toast(t("s.proxySaved"), "ok", state.auth_proxy_on ? t("s.proxySavedOn") : t("s.proxySavedOff"));
      } catch (e) { toast(stripErr(e), "err"); }
    });
  },

  async stSetThreshold(ev) {
    const raw = Number(ev?.target?.value);
    if (!isFinite(raw)) { syncSettingsModal(); return; }
    const v = Math.max(1, Math.min(90, Math.round(raw)));
    await actions.applySetting({ autoSwitchThreshold: v });
  },

  async stSetModel(ev) {
    const v = String(ev?.target?.value || "");
    if (v === "__custom__") {
      ui.modelCustom = true;
      syncSettingsModal();
      document.querySelector(".st-panel .focus-model")?.focus();
      return;
    }
    ui.modelCustom = false;
    await actions.applySetting(
      { autoSwitchModel: v },
      v ? t("s.focusModelSaved", { model: v }) : t("s.focusModelCleared"),
    );
  },

  async stSetModelCustom(ev) {
    const v = String(ev?.target?.value || "").trim();
    ui.modelCustom = true;
    await actions.applySetting(
      { autoSwitchModel: v },
      v ? t("s.focusModelSaved", { model: v }) : t("s.focusModelCleared"),
    );
  },

  async stSetLang(l) {
    if (l === lang()) return;
    await guard(async () => {
      await invoke("set_language", { lang: l });
      await refresh(); render(); syncSettingsModal();
    });
  },

  async stBrowsePath() {
    await guard(async () => {
      const r = await invoke("pick_zcode_path");
      if (!r.picked) return;
      await invoke("set_zcode_path", { path: r.path });
      toast(t("s.pathUpdated"));
      await refresh(); render(); syncSettingsModal();
    });
  },

  async stSavePath() {
    const input = document.querySelector(".st-panel .st-input.path");
    if (!input) return;
    const v = input.value.trim();
    await guard(async () => {
      await invoke("set_zcode_path", { path: v });
      toast(v ? t("s.pathUpdated") : t("s.pathAuto"));
      await refresh(); render(); syncSettingsModal();
    });
  },

  async stExportAll() {
    await guard(async () => {
      const p = await invoke("export_all_pick_path");
      if (!p.picked) { toast(t("m.exportCanceled")); return; }
      openPwModal({ mode: "exportAll", path: p.path, count: p.count, onDone: () => actions.refresh() });
    });
  },

  async stImport() {
    await guard(async () => {
      const p = await invoke("import_pick_files");
      if (!p.picked) return;
      const sealed = p.sealed || [];
      const preErrors = p.errors || [];
      if (sealed.length) {
        const allPlain = p.plainCount === sealed.length;
        openPwModal({ mode: "import", files: sealed, preErrors, allPlain, onDone: (rep) => actions.stFinishImport(rep) });
        return;
      }
      actions.stFinishImport({ added: [], skipped: [], errors: preErrors });
    });
  },

  stFinishImport(report) {
    if (report.added.length === 0 && report.skipped.length === 0) {
      toast(t("s.importNone"), "err", report.errors.join(t("common.listSep")) || undefined);
    } else {
      const parts = [];
      if (report.added.length) parts.push(t("s.importAdded", { count: report.added.length, names: report.added.join(t("common.listSep")) }));
      if (report.skipped.length) parts.push(t("s.importSkipped", { count: report.skipped.length }));
      if (report.provider_config_restored) parts.push(t("s.importProvRestored"));
      if (report.errors.length) parts.push(t("s.importFailed", { count: report.errors.length }));
      toast(parts[0], report.errors.length ? "err" : "ok", parts.slice(1).join(t("common.listSep")));
    }
    refresh().then(() => { render(); syncSettingsModal(); }).catch(() => {});
  },

  async openGitHub() {
    try { await invoke("open_external", { url: "https://github.com/pjpv/zcode-switch" }); }
    catch (e) { toast(stripErr(e), "err"); }
  },
  /** 手动冻结/解冻：冻结的账号单独分组，绝不参与自动切换（手动切换不受影响）。
   *  对自动冻结（风控停靠）的号点击冻结 = 升级为手动——用户拍板的停靠不被
   *  自动解冻路径（探测/耗尽坐实）绕过，与批量冻结同语义；再次点击才解冻 */
  toggleFreeze(id) {
    const autoOnly = isFrozen(id) && !!autoFrozenAt[id];
    if (autoOnly) {
      delete autoFrozenAt[id];
      delete autoUnfreezeHits[id];
      delete autoUnfreezeEmpty[id];
      // 升级 = 用户确认风控停靠：重新拉满 3h 探测窗口（max 不缩短既有冷却）
      delete claimUrgent[id];
      autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
        Date.now() + autoClaimGap(3 * 60 * 60 * 1000));
      saveAutoFrozen();
      // frozenIds 不动：从「系统停靠」原地变为「用户停靠」
    } else {
      toggleFrozen(id);
      // 解冻 = 重新入轮换：清干净自动冻结标记/风控计数/探测冷却，避免残留导致
      // 此后无法再次自动冻结、或旧冷却压住新状态
      if (!isFrozen(id)) {
        delete autoFrozenAt[id];
        autoRiskStreak[id] = 0;
        delete autoClaimCooldown[id];
        delete autoUnfreezeHits[id];
        delete autoUnfreezeEmpty[id];
        saveAutoFrozen();
      } else {
        // 手动冻结 = 风控冻结代位（弥补风控不及时）：与自动冻结同轨「停靠含停止领取」——
        // 写入 3h 探测冷却，到期后随轮复测；撞墙顺延（noteClaimRisk）与提交成功解冻同轨
        delete claimUrgent[id];
        autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
          Date.now() + autoClaimGap(3 * 60 * 60 * 1000));
      }
    }
    // 单号冻结/升级/解冻统一在此落盘停靠冷却（覆盖上方三分支的写入与删除）
    saveClaimCooldown();
    render();
    const name = accountName(id);
    const frozen = isFrozen(id);
    toast(t(autoOnly ? "m.frozenUpgradeToast" : frozen ? "m.frozenToast" : "m.unfrozenToast", { name }), "ok",
      t(autoOnly ? "m.frozenUpgradeDetail" : "m.frozenDetail"));
    // 冻结在用账号 = 明确要求切走：立即触发自动切换（manual 绕过冷却与保护窗）。
    // tick 撞上瞬态守卫（切换锁/在飞切换）时由 kickSwitchNow 重试，保证「立即」语义
    if (frozen && state?.auto_switch && state?.accounts?.some((a) => a.id === id && a.is_active)) {
      noteChanged(t("as.noteFrozenActive"));
      kickSwitchNow();
    }
  },

  /** 归档/取消归档：归档 = 彻底停靠——不自动刷新额度、不参与自动领取/级联/一键领取、
   *  不作为自动切换候选；只保留手动刷新与手动领取（随时可手动看一眼有没有新礼物）。
   *  归档在用账号 = 明确要求切走，立即触发自动切换（与冻结同路径） */
  toggleArchive(id) {
    const wasActive = state?.accounts?.some((a) => a.id === id && a.is_active);
    toggleArchived(id);
    if (!isArchived(id)) {
      // 取消归档 = 重新入轮：立刻安排一次额度刷新，领取冷却清零让轮次尽快接续
      pokeAccount(id);
      delete autoClaimCooldown[id];
      saveClaimCooldown(); // 清零落盘：防重启复活归档前旧停靠
    } else {
      // 归档后账号离开当前视图：同步清掉选中与锚点，避免残留选中翻转批量按钮
      ui.selected.delete(id);
      if (ui.lastCheckedId === id) ui.lastCheckedId = null;
    }
    render();
    const name = accountName(id);
    const arch = isArchived(id);
    toast(t(arch ? "m.archivedToast" : "m.unarchivedToast", { name }), "ok",
      t(arch ? "m.archivedDetail" : "m.unarchivedDetail"));
    if (arch && wasActive && state?.auto_switch) {
      noteChanged(t("as.noteArchivedActive"));
      kickSwitchNow();
    }
  },

  acctQuota(id) {
    const dueAt = quotaDue[id];
    // 恢复场景（此前数据面是空快照）由 loadAcctQuota 里的 m.quotaRecovered 提示，这里不重复
    const wasEmpty = acctQuota[id]?.data?.is_empty === true;
    // 刷新泵正在刷同号（busy 保护窗内）：点击必须给反馈，且不得继续往下走——
    // 否则 loadAcctQuota 静默返回后，下面的提示会把旧数据当「已刷新」报出来
    if (acctQuota[id]?.busy && Date.now() - (acctQuota[id].busyAt || 0) < 20000) {
      toast(t("m.refreshInFlight", { name: accountName(id) }));
      return;
    }
    loadAcctQuota(id).then(() => {
      if (quotaDue[id] === dueAt) scheduleNext(id);
      // 手动刷新的是当前账号且额度已低于阈值 → 立即尝试切换
      if (state?.auto_switch && state?.accounts?.some((a) => a.id === id && a.is_active)) {
        autoSwitchTick(true);
      }
      // 手动刷新必须有反馈：成功报口径剩余、空数据/失败单独说明
      //（sweep 周期刷新走 loadAcctQuota，不经过这里，不会刷屏）
      const q = acctQuota[id];
      if (!q || q.busy) return; // 请求被吞/又有新请求在飞：不拿旧数据冒充结果
      if (q?.err) { toast(t("m.quotaRefreshFail", { name: accountName(id), err: stripErr(q.err) }), "warn"); return; }
      if (wasEmpty) return;
      if (q?.data?.is_empty === true) { toast(t("m.quotaRefreshEmpty", { name: accountName(id) }), "warn"); return; }
      const pct = pctPairOf(id).pct;
      if (pct != null) toast(t("m.quotaRefreshed", { name: accountName(id), pct: Math.round(pct) }), "ok");
    });
  },

  /** 悬浮按钮：回到列表顶部 */
  scrollListTop() {
    const list = $app.querySelector(".list");
    if (!list) return;
    list.scrollTo({ top: 0, behavior: "smooth" });
  },

  async copyApiKey(id) {
    try {
      const r = await invoke("account_api_key", { id });
      if (!r?.apiKey) { toast(t("list.apiKeyNone"), "warn"); return; }
      // 铸造失败 = 拿到的是 JWT 兜底，拿去 paas/v4 必 401：不复制，把原因亮出来
      if (r?.mintError) {
        let msg = `${t("list.apiKeyMintFail")}\n${stripErr(r.mintError)}`;
        if (r.provider === "bigmodel") msg += `\n${t("list.apiKeyMintBigmodelHint")}`;
        toast(msg, "err");
        return;
      }
      if (await copyText(r.apiKey)) toast(`${t("list.apiKeyCopied")}（${r.label || "?"}）\n${t("list.apiKeyCopiedHint")}`);
      else toast(t("list.copyFail"), "err");
    } catch (e) { toast(stripErr(e), "err"); }
  },

  openTwoApi() { openTwoApiModal(); },

  /** 悬浮按钮：滚动定位到当前使用的账号 */
  locateActive() {
    const row = document.querySelector(".row.active, .card.active");
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    // 当前账号被筛选/搜索过滤掉了：清空筛选再定位
    if (ui.search || ui.health !== "all") {
      ui.search = "";
      ui.health = "all";
      render(true);
      requestAnimationFrame(() => document.querySelector(".row.active, .card.active")?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }
    toast(t("list.locateMissing"), "warn");
  },

  closeTwoApi() { closeTwoApiModal(); },

  closeSettings() { closeSettingsModal(); },

  /** 模型列表一键填充：套餐模型（本地实测，统一小写）+ 官方免费模型；大小写不敏感去重 */
  twoDetectModels() {
    const input = twoApiModalEl?.querySelector(".two-models");
    if (!input) return;
    const set = new Map();
    for (const m of detectedModels()) {
      const k = m.toLowerCase();
      if (!set.has(k)) set.set(k, k);
    }
    for (const m of FREE_MODELS) {
      if (!set.has(m)) set.set(m, m);
    }
    input.value = [...set.values()].join(", ");
    toast(t("two.detected", { n: set.size }));
  },

  /** 连通性测试：本地服务 + 免费模型 E2E 实测（走真实上游转发），内联两行结果 + toast */
  async twoTest() {
    const el = twoApiModalEl?.querySelector(".two-test-result");
    if (el) { el.textContent = t("two.testRunning"); el.className = "two-test-result running"; }
    try {
      const r = await invoke("two_api_test");
      twoLastStatus = await invoke("two_api_status").catch(() => null);
      const old = twoApiModalEl?.querySelector(".two-status");
      if (old) old.outerHTML = twoStatusHtml();
      const localLine = r?.localOk
        ? `✓ ${t("two.tLocal")} ${r.localMs}ms`
        : `✕ ${t("two.tLocal")}：${r?.error || "unknown"}`;
      const upLine = r?.e2eOk
        ? `✓ ${t("two.tUpstream")} ${r.e2eMs}ms`
        : `✕ ${t("two.tUpstream")}：${r?.error || "unknown"}`;
      if (el) {
        el.textContent = `${localLine}\n${upLine}`;
        el.className = `two-test-result ${r?.ok ? "ok" : "err"}`;
      }
      toast(r?.ok ? `${localLine} · ${upLine}` : `${localLine} | ${upLine}`, r?.ok ? "ok" : "err");
    } catch (e) {
      if (el) { el.textContent = `✕ ${stripErr(e)}`; el.className = "two-test-result err"; }
      toast(stripErr(e), "err");
    }
  },

  /** 一键复制所有账号的 API Key（名称 + key 逐行；JWT 兜底行带标记，避免误拿去 paas/v4） */
  async copyAllKeys() {
    try {
      const rows = await invoke("all_account_api_keys");
      const lines = (rows || []).filter((r) => r.hasKey)
        .map((r) => `${r.name}  ${r.apiKey}${r.kind === "jwt" ? "  " + t("list.apiKeyJwtTag") : ""}`);
      if (!lines.length) { toast(t("list.apiKeyNone"), "warn"); return; }
      const ok = await copyText(lines.join("\n"));
      toast(ok ? t("list.apiKeysCopied", { n: lines.length }) : t("list.copyFail"), ok ? "ok" : "err");
    } catch (e) { toast(stripErr(e), "err"); }
  },

  async twoToggle() {
    try {
      await invoke("set_two_api", {
        on: !state?.two_api_on,
        port: state?.two_api_port || 8117,
        account: state?.two_api_account || null,
        models: state?.two_api_models || null,
        proxyUrl: state?.two_api_proxy_url || null,
      });
      await refresh();
      syncTwoApiModal();
      render();
    } catch (e) { toast(stripErr(e), "err"); }
  },

  async twoSaveConfig() {
    try {
      const raw = Number(document.querySelector(".two-port")?.value);
      const models = (document.querySelector(".two-models")?.value || "").trim() || autoModelList();
      const proxyUrl = (document.querySelector(".two-proxy")?.value || "").trim() || null;
      await invoke("set_two_api", {
        on: !!state?.two_api_on,
        port: Number.isFinite(raw) && raw > 0 ? raw : 8117,
        account: state?.two_api_account || null,
        models: models || null,
        proxyUrl,
      });
      await refresh();
      syncTwoApiModal();
      toast(t("two.saved"));
    } catch (e) { toast(stripErr(e), "err"); }
  },

  async twoSetAccount(ev) {
    const v = ev?.target?.value || "";
    try {
      await invoke("set_two_api", {
        on: !!state?.two_api_on,
        port: state?.two_api_port || 8117,
        account: v || null,
        models: state?.two_api_models || null,
        proxyUrl: state?.two_api_proxy_url || null,
      });
      await refresh();
      syncTwoApiModal();
    } catch (e) { toast(stripErr(e), "err"); }
  },

  twoToggleTokenShow() {
    twoShowToken = !twoShowToken;
    syncTwoApiModal();
  },

  async twoCopyToken() {
    const token = state?.two_api_token || "";
    if (!token) { toast(t("two.tokenEmpty"), "warn"); return; }
    const ok = await copyText(token);
    toast(ok ? t("two.copied") : t("list.copyFail"), ok ? "ok" : "err");
  },

  async twoCopyEndpoint(path) {
    const ok = await copyText(`http://127.0.0.1:${state?.two_api_port || 8117}${path}`);
    toast(ok ? t("two.copied") : t("list.copyFail"), ok ? "ok" : "err");
  },

  async twoCopySnippet(name) {
    const ok = await copyText(twoSnippet(name, state || {}));
    toast(ok ? t("two.copied") : t("list.copyFail"), ok ? "ok" : "err");
  },

  async twoRegenToken() {
    try {
      await invoke("regen_two_api_token");
      await refresh();
      twoShowToken = true;
      syncTwoApiModal();
      toast(t("two.tokenRegenDone"));
    } catch (e) { toast(stripErr(e), "err"); }
  },

  async addAccount() {
    let providers;
    try { providers = await invoke("oauth_providers"); }
    catch (e) { toast(stripErr(e), "err"); return; }
    const inBrowser = state?.oauth_browser !== false;
    openProviderModal({
      providers,
      browser: inBrowser,
      onPick: async (id, inBrowser) => {
        try {
          const r = await invoke("oauth_begin", { provider: id, browser: !!inBrowser });
          if (r?.browser) toast(t("m.loginBrowserOpened"), "ok", t("m.loginBrowserDetail"));
          else toast(t("m.loginWindowOpened"), "ok", t("m.loginWindowDetail"));
        } catch (e) {
          toast(stripErr(e), "err");
        }
      },
    });
  },

  async queryGift(id) {
    // 手动礼物查询：与自动轮的单号查询完全同轨（claim_refresh = 激活上报 + preview），
    // 仅触发方式不同；urgent 走 180s 快槽（同为用户主动操作，同入库/切号紧急检查）。
    // 不受冻结/冷却限制（主动行为），风控信号同样记账（撞墙顺延/首次即冻结）
    if (claimable[id]?.busy) return;
    claimable[id] = { ...(claimable[id] || {}), busy: true };
    try {
      const r = await invoke("claim_refresh", { id, urgent: true });
      claimable[id] = { plans: r.plans || [], err: null, busy: false };
      // 同自动轮：激活上报被上游拒绝 = 该号正被风控盯上，实时记账
      if (r.activationError && riskInText(stripErr(r.activationError))) noteClaimRisk(id);
      // preview 结果喂给实例登记：新 plan_id 首现 → 级联未持有者
      notePlanInstances((r.plans || []).map((p) => ({ planId: p.plan_id, name: p.name })));
    } catch (e) {
      claimable[id] = { plans: claimable[id]?.plans || [], err: String(e), busy: false };
      if (riskInText(stripErr(e))) noteClaimRisk(id);
      else autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
        Date.now() + autoClaimGap(AUTO_CLAIM_INTERVAL_MS));
    }
    if (!uiLocked()) render();
    const c = claimable[id] || {};
    if (c.err) { toast(stripErr(c.err), "err"); return; }
    const plans = c.plans || [];
    if (!plans.length) { toast(t("m.giftQueryNone")); return; }
    const names = plans.map((p) => planDisplayName(p.name || p.plan_id)).join(t("common.listSep"));
    toast(t("m.giftQueryDone", { n: plans.length }), "ok", names);
  },

  async claim(id) {
    // 自动领取轮进行中：允许手动抢占（轮次就地收尾、稍后自动续跑余下账号）；
    // 一键领取批处理与资格刷新仍互斥
    if (claimAllRunning) { toast(t("m.claimBusy"), "warn"); return; }
    if (claimActive && !autoClaimRunning) return;
    const plans = claimable[id]?.plans || [];
    const plan = plans[0];
    if (!plan) { toast(t("m.noClaimable"), "warn"); return; }
    const preemptRound = autoClaimRunning;
    if (preemptRound) {
      await preemptAutoClaim();
      if (!(await waitAutoClaimWindDown())) return; // 极端未收尾：放弃本次手动领取
    }
    claimActive = true;
    try {
      await invoke("claim_start", { id, planId: plan.plan_id });
      toast(t("m.claimVerify", { name: planDisplayName(plan.name || plan.plan_id) }), "ok", t("m.claimVerifyDetail"));
      const r = await waitForClaimResult(id);
      if (!r) toast(t("m.claimTimeout"), "warn");
      else pokeAccount(id);
    } catch (e) {
      const gone = claimGonePayload(e);
      if (gone) {
        // 报价已撤：用后端带回的最新 preview 就地校准（换期新实例可能就在其中），图标随之修正
        claimable[id] = { plans: gone.plans, err: null, busy: false };
        render();
        toast(gone.gone, "err");
      } else {
        if (riskInText(stripErr(e))) noteClaimRisk(id);
        toast(stripErr(e), "err");
        // 手动节奏下的单次复核：1002「活动已结束」这类服务端确定性拒绝后，死图标立刻消失
        awaitClaimPreviewFresh(id).then(() => { if (!uiLocked()) render(); });
      }
    } finally {
      claimActive = false;
      // 被抢占的自动轮：手动领取结束后尽快续跑余下账号
      if (preemptRound) setTimeout(() => autoClaimTick(), 2500);
    }
  },

  async claimAll() {
    // 批处理进行中：再点一次 = 停止（当前账号完成后收尾）
    if (claimAllState.running) {
      claimAllAbort = true;
      toast(t("m.claimAllStopping"), "warn");
      return;
    }
    const ids = accountsNewFirst(
      (state?.accounts || [])
        .map((a) => a.id)
        .filter((id) => !isArchived(id) && (claimable[id]?.plans || []).length > 0),
    ).sort((x, y) => claimTierOf(x) - claimTierOf(y)); // 同自动轮：当前号优先，同层内新号优先
    if (!ids.length) { toast(t("m.noClaimableAccounts"), "warn"); return; }
    if (claimActive && !autoClaimRunning) return;
    const preemptRound = autoClaimRunning;
    if (preemptRound) {
      await preemptAutoClaim();
      if (!(await waitAutoClaimWindDown())) return;
    }
    claimAllRunning = true;
    claimActive = true;
    claimAllAbort = false;
    claimAllState = { running: true, done: 0, total: ids.length };
    render();
    let stopped = false;
    let riskFails = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        if (claimAllAbort) { stopped = true; break; }
        const id = ids[i];
        claimAllState.done = i;
        if (!isTyping()) render();
        const plan = claimable[id].plans[0];
        const name = state.accounts.find((a) => a.id === id)?.name || id;
        try {
          await invoke("claim_start", { id, planId: plan.plan_id });
        } catch (e) {
          const gone = claimGonePayload(e);
          if (gone) {
            // 报价已撤：就地校准、静默出列——跨期僵尸报价一次批处理全部清干净，
            // 不逐号弹「已不可领取」刷屏，也不进失败冷却（号本身没问题）
            claimable[id] = { plans: gone.plans, err: null, busy: false };
            continue;
          }
          if (riskInText(stripErr(e))) noteClaimRisk(id);
          toast(t("m.claimAccountErr", { name, err: stripErr(e) }), "err");
          // 单账号失败：该号进入冷却，批次继续（一个号的问题不代表其他号）
          autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
            Date.now() + autoClaimGap(AUTO_CLAIM_FAIL_MIN_MS));
          continue;
        }
        const r = await waitForClaimResult(id, 120000);
        if (!r) {
          toast(t("m.claimAcctTimeout", { name }), "warn");
          await invoke("claim_cancel").catch(() => {});
          autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
            Date.now() + autoClaimGap(AUTO_CLAIM_FAIL_MIN_MS));
          continue;
        }
        if (r.ok === false) {
          // 单账号失败 ≠ 其他账号也会失败：该号进入冷却（风控信号则冻结数小时），
          // 批次继续但降速
          autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0, autoClaimCooldownFor(r));
          if (claimFailureRisk(r)) {
            // 同自动轮（G7 残余补全）：claim://result 的 noteClaimRisk 刚写入的顺延停靠不得被固定 3h 覆盖
            autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
              Date.now() + autoClaimGap(3 * 60 * 60 * 1000));
            saveClaimCooldown(); // 批处理风控停靠落盘：重启后不提前撞墙
            autoClaimSlowUntil = Date.now() + 5 * 60 * 1000;
            riskFails++;
            // 风控失败累积（≥3）：暂停批处理——剩余账号保持冷却，
            // 由后续自动轮分批重试（一次打完只会加重 IP 画像）
            if (riskFails >= 3) {
              toast(t("m.claimAllRiskPaused", { n: riskFails }), "err");
              break;
            }
          }
          continue;
        }
        pokeAccount(id);
        if (i < ids.length - 1) await new Promise((res) => setTimeout(res,
          (1200 + Math.random() * 1200) * (Date.now() < autoClaimSlowUntil ? 2.5 : 1)));
      }
    } finally {
      const done = claimAllState.done;
      const total = claimAllState.total;
      claimAllRunning = false;
      claimActive = false;
      claimAllState = { running: false, done: 0, total: 0 };
      render();
      if (stopped) toast(t("m.claimAllStopped", { done, total }), "warn");
      if (preemptRound) setTimeout(() => autoClaimTick(), 2500);
    }
  },

  async toggleAutoSwitch() {
    const prev = !!state?.auto_switch;
    const next = !prev;
    // 点击即翻转（乐观更新），再写后端；失败回滚
    if (state) state.auto_switch = next;
    render();
    syncSettingsModal();
    try {
      await invoke("set_behavior", { autoSwitch: next });
      await refresh();
      render();
      syncSettingsModal();
      if (next) {
        toast(t("as.on"), "ok", t("as.onDetail", { pct: state?.auto_switch_threshold ?? 15 }));
        setTimeout(autoSwitchTick, 1200);
      } else {
        autoSwitchNote = "";
        toast(t("as.off"));
      }
    } catch (e) {
      if (state) state.auto_switch = prev;
      render();
      syncSettingsModal();
      toast(stripErr(e), "err");
    }
  },

  async toggleAutoClaim() {
    if (autoToggleBusy) return;
    const prev = !!state?.auto_claim;
    const next = !prev;
    if (next && (autoClaimRunning || claimActive || claimAllRunning)) {
      toast(t("m.claimBusy"), "warn");
      return;
    }
    autoToggleBusy = true;
    // 点击即翻转（乐观更新），再写后端；失败回滚
    if (state) state.auto_claim = next;
    render();
    syncSettingsModal();
    try {
      await invoke("set_behavior", { autoClaim: next });
      await refresh();
      render();
      syncSettingsModal();
      if (state.auto_claim) {
        toast(t("m.autoClaimOn"), "ok", t("m.autoClaimOnDetail"));
        flushPendingCascade(); // 关闭期间登记的新礼物期：开启即补级联
        autoClaimTick(); // 开启即检测一轮（轮内冷却/退避自行控速）
      } else {
        lastAutoRound = null;
      }
    } catch (e) {
      if (state) state.auto_claim = prev;
      render();
      syncSettingsModal();
      toast(stripErr(e), "err");
    } finally {
      autoToggleBusy = false;
    }
  },
};

// 新入库账号排前：新号礼包好领、资格激活收益最高（自动轮与手动批处理共用）
function accountsNewFirst(ids) {
  const createdAt = (id) => {
    const a = (state?.accounts || []).find((x) => x.id === id);
    return Date.parse(String(a?.created_at || "").replace(" ", "T")) || 0;
  };
  return [...ids].sort((x, y) => createdAt(y) - createdAt(x));
}
// 风控降速：出现风控信号后 5 分钟内，轮内/批内账号间隙放大 2.5 倍
let autoClaimSlowUntil = 0;
// 冷却去相位：+0~50% 上偏抖动。76 个账号若在同一轮同时进入冷却，到期会同时对齐，
// 形成每 10/30 分钟一次的请求风暴（今天日志 12:00 的 54 次/2min 爆发即此形态）
function autoClaimGap(ms) {
  return Math.round(ms * (1 + Math.random() * 0.5));
}
// 领取失败的冷却下限：30 分钟。上游拒绝后的快速重试只会加固风控画像
const AUTO_CLAIM_FAIL_MIN_MS = 30 * 60 * 1000;
// 风控信号判定：状态码白名单只收 405（上游 WAF 对 claim 端点的封锁形态，
// 见全局领取熔断注释）与 429（限流），词面 unusual activity/blocked 为主力网
// ——观察到的 405 文案「request has been blocked due to unusual activity」三者
// 全中不会漏；401 已移出风控口径，5xx/404 等其余状态码走普通失败退避
// （claim_refresh 抛错 30min、claim_start 抛错翻倍封顶 4h），瞬时服务器故障
// 不再「首信号即冻结」。白名单命中后继续打只会让整个 IP 画像恶化，
// 必须立即熔断而不是换号继续
function claimFailureRisk(r) {
  return r.ok === false && riskInText(r.message);
}

/** 风控信号记账：领取链路的明确封锁/限流信号（HTTP 405/429 白名单或
 *  unusual activity/blocked 词面；401 已移出口径、随 5xx/404 走普通退避）
 *  **首次信号即自动冻结**——旧逻辑要求 24h 内连续 2 次 + 有额度，实践中几乎
 *  无法触发（提交 405 后冷却 3h 起、第二次信号至少滞后 3 小时；新号领首个
 *  礼包时额度数据为 null 被额度门直接放行，87/88/86 三个号各吃一次 405 后
 *  再无人冻结，09-29/30 实证）。复测语义：冷却（3h±50%）到期后随领取轮探测
 *  ——提交成功即解冻（claim://result ok）；再吃风控信号 → 走本函数顺延停靠。
 *  手动冻结不介入（用户拍板）；额度门已删除——风控停靠的语义包含「停止领取」，
 *  对无额度号同样成立（防抖与解冻出路见 noteFrozenQuotaSeen 注释）。 */
function noteClaimRisk(id) {
  const now = Date.now();
  // 全局熔断统一在此喂给：本函数全部调用点都经 riskInText/claimFailureRisk 门禁
  // （手动查询/单领/claimAll/自动轮/claim://result），三分支都是已确认的真实撞墙
  // ——手动来源的撞墙同样加固 IP 画像、预示自动轮即将撞墙（「同轨」未竟部分）；
  // 同时修复原「result 风控失败被轮内与 claim://result 监听各计 1 次」的双喂，
  // 15min≥4 阈值恢复「4 个独立信号」的设计语义
  noteFleetRiskFail();
  // 手动冻结 = 风控冻结代位：复测撞墙同样顺延停靠；不夺取所有权、
  // 不记 streak——b/c) 证据机不盘点手动冻结，streak 只是它的观测计数
  if (isFrozen(id) && !autoFrozenAt[id]) {
    autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
      now + autoClaimGap(3 * 60 * 60 * 1000));
    saveClaimCooldown();
    // 撞墙顺延的可观测反馈（现象二暴露面）：与「已自动冻结/风控解除」toast 同风格。
    // 参数只读刚写入的冷却值（恒为数），accountName/localeTag/t 均安全调用不抛异常，
    // 不会短路本分支已完成的记账与调用方逻辑；不夺所有权、不记 streak
    toast(t("m.dockExtendedToast", { name: accountName(id), time: new Date(autoClaimCooldown[id]).toLocaleString(localeTag(), { hour12: false }) }), "warn", t("m.dockExtendedDetail"));
    return;
  }
  // 信号时间窗：超过 24h 的旧信号不累计（streak 现仅作观测计数，冻结不再依赖它）
  if ((autoRiskLastAt[id] ?? 0) < now - 24 * 3600e3) autoRiskStreak[id] = 0;
  autoRiskLastAt[id] = now;
  autoRiskStreak[id] = (autoRiskStreak[id] || 0) + 1;
  if (autoFrozenAt[id]) { // 顺延停靠：只延长不缩短——本函数自身写入恒 ≤4.5h，外来更长退避（1005 nextAt/失败翻倍）原样保留，不被风控信号压短
    autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
      now + autoClaimGap(3 * 60 * 60 * 1000));
    saveClaimCooldown();
    return;
  }
  frozenIds.add(id);
  autoFrozenAt[id] = now;
  autoClaimCooldown[id] = now + autoClaimGap(3 * 60 * 60 * 1000);
  saveFrozen(); saveAutoFrozen(); saveClaimCooldown();
  toast(t("m.autoFrozenToast", { name: accountName(id) }), "warn", t("m.autoFrozenDetail"));
  render();
}

/** 探测通过（提交成功 / 额度恢复 / 额度耗尽坐实）→ 自动解冻恢复 */
function autoUnfreeze(id, reason = "probe") {
  if (!isFrozen(id)) return;
  const wasAuto = !!autoFrozenAt[id];
  delete autoFrozenAt[id];
  autoRiskStreak[id] = 0;
  delete autoUnfreezeHits[id];
  delete autoUnfreezeEmpty[id];
  frozenIds.delete(id);
  saveFrozen(); saveAutoFrozen();
  toast(t("m.autoUnfrozenToast", { name: accountName(id) }), "ok",
    wasAuto ? t(reason === "exhausted" ? "m.autoUnfrozenExhausted" : "m.autoUnfrozenDetail") : t("m.manualUnfrozenDetail"));
  pokeAccount(id);
  render();
}

// 自动冻结的解冻证据（状态机不允许吸收态：任何冻结号都必须有出路）——
// a) 领取提交成功（claim://result，原有的探测通过路径）；
// b) 额度恢复：冻结满 2h 后连续 3 次成功刷新都带可用额度（风控解除的旁证；
//    5min 刷新节奏下 ≈ 冻结后 2h15m，兑现「数小时后自动探测，恢复即解冻」）；
// c) 无可用额度坐实：冻结满 6h 且连续 3 次刷新都无可用额度（65 号这类查不出
//    有效额度数据的退化号）→ 坐实没额度解除。
// 【已删除】旧 c')「数据面确定判死（definiteDeadData）单次即解」：风控停靠的语义
//    已扩展到「停止领取」，对无额度号同样成立；死数据 ≠ 风控解除——否则刚吃 405
//    冻结的号会在下一次额度刷新（读到空/死）被当场放行，再 405 再冻，抖动不止
//    （G8）。解冻出路仍有 a/b/c 三条 + 手动升级/解冻，无吸收态。
//    解冻刻意不清领取冷却：冷却必到期且级联可用 min() 下拉，不是吸收态；
//    风控证据未必完全洗白，保留领取端节流更稳。
// 手动冻结不受 b/c) 影响（用户决定停靠，标记保留），仅分组显示归位（见 healthMapOf）。
const AUTO_UNFREEZE_MIN_MS = 2 * 60 * 60 * 1000;
const AUTO_UNFREEZE_EMPTY_MS = 6 * 60 * 60 * 1000;
const AUTO_UNFREEZE_HITS = 3;
let autoUnfreezeHits = {};
let autoUnfreezeEmpty = {};
function hasLiveQuota(data) {
  if (!data || data.is_empty === true) return false;
  const plans = (data.plans || []).filter((p) => !planExpired(p));
  if (plans.some((p) => Number(p.remaining ?? 0) > 0)) return true;
  const pools = plans.length ? plans.flatMap((p) => p.items || []) : (data.items || []);
  return pools.some((it) => Number(it?.remaining ?? 0) > 0);
}
function noteFrozenQuotaSeen(id, data) {
  if (!autoFrozenAt[id]) return; // 手动冻结/未冻结：不介入
  const live = hasLiveQuota(data);
  const healthy = (autoUnfreezeHits[id] = live ? (autoUnfreezeHits[id] || 0) + 1 : 0);
  const empty = (autoUnfreezeEmpty[id] = live ? 0 : (autoUnfreezeEmpty[id] || 0) + 1);
  const frozenFor = Date.now() - autoFrozenAt[id];
  if (healthy >= AUTO_UNFREEZE_HITS && frozenFor >= AUTO_UNFREEZE_MIN_MS) { autoUnfreeze(id); return; }
  if (empty >= AUTO_UNFREEZE_HITS && frozenFor >= AUTO_UNFREEZE_EMPTY_MS) autoUnfreeze(id, "exhausted");
}

// 全局领取熔断：405「unusual activity」是上游 WAF 对 billing/claim 提交端点的
// 常态化形态（实测按时间窗放行——0928 实例全天 11 成/60 败，成功集中在
// 01/12/14 点的 5 连发；与共享 Agent 无关，改前构建同败法）。窗口关闭期间
// 逐号撞墙只会白烧验证码、加固 IP 画像，还会让账号吃满 2 次信号被自动冻结。
// 15 分钟窗内累计 ≥4 次风控失败 → 整轮暂停（15/30/60min 指数拉长），
// 暂停期间 autoClaimTick 不起轮；任意一次领取成功即复位。
const CLAIM_RISK_BURST_WINDOW = 15 * 60 * 1000;
const CLAIM_RISK_BURST_N = 4;
let claimRiskBurst = 0;
let claimRiskBurstAt = 0;
let claimPauseStreak = 0;
let claimPauseUntil = 0;
function noteFleetRiskFail() {
  const now = Date.now();
  if (now - claimRiskBurstAt > CLAIM_RISK_BURST_WINDOW) claimRiskBurst = 0;
  claimRiskBurstAt = now;
  claimRiskBurst++;
  if (claimRiskBurst >= CLAIM_RISK_BURST_N) {
    claimPauseStreak++;
    const pause = Math.min(CLAIM_RISK_BURST_WINDOW * 2 ** Math.min(claimPauseStreak - 1, 2), 60 * 60 * 1000);
    claimPauseUntil = Math.max(claimPauseUntil, now + pause);
    claimRiskBurst = 0;
    toast(t("m.claimRiskPaused", { min: Math.round(pause / 60e3) }), "warn", t("m.claimRiskPausedDetail"));
  }
}
function noteFleetRiskOk() {
  claimRiskBurst = 0;
  claimPauseStreak = 0;
}
function autoClaimCooldownFor(r) {
  const now = Date.now();
  if (r.code === 1005 && r.nextAt) return Math.max(r.nextAt, now + AUTO_CLAIM_FAIL_MIN_MS);
  if (Number.isFinite(r.code) && r.code >= 1000) return now + 60 * 60 * 1000 + autoClaimGap(10 * 60 * 1000);
  if (r.code === "interactive") return now + 60 * 60 * 1000 + autoClaimGap(10 * 60 * 1000);
  // 被手动操作抢占的账号：短冷却，手动领取结束后优先续跑
  if (r.code === "preempted") return now + 90 * 1000;
  return now + autoClaimGap(AUTO_CLAIM_FAIL_MIN_MS);
}

async function autoClaimTick() {
  if (!state?.auto_claim || autoClaimRunning) return;
  if (claimActive || claimAllRunning) return;
  // 风控熔断期：不起轮（报价未领期间一直挂在 preview，暂停不丢单）
  if (Date.now() < claimPauseUntil) return;
  // 分层优先（0当前 → 1新号/GlobalBuild未证词 → 2有额度 → 3其余）：排序稳定，
  // 同层内保持新号优先；由于轮询决定「谁先发现礼物」，资格顺序必须盖过冷却到期顺序
  const ids = accountsNewFirst(
    (state.accounts || [])
      .map((a) => a.id)
      .filter((id) => !isArchived(id) && (autoClaimCooldown[id] ?? 0) <= Date.now()),
  ).sort((x, y) => claimTierOf(x) - claimTierOf(y)).slice(0, AUTO_CLAIM_ROUND_CAP);
  if (!ids.length) {
    if ((state.accounts || []).some((a) => !isArchived(a.id) && (claimable[a.id]?.plans || []).length > 0)) {
      lastAutoRound = { at: Date.now(), claimed: 0, skipped: 0, cooldownAll: true };
    }
    return;
  }
  autoClaimRunning = true; claimActive = true; autoAbortRequested = false; autoClaimPaused = false;
  let roundClaimed = 0, roundSkipped = 0;
  if (!uiLocked()) render();
  try {
    for (const id of ids) {
      if (!state?.auto_claim || autoAbortRequested || autoClaimPaused) break;
      if (!(state.accounts || []).some((a) => a.id === id)) continue;
      let gotAny = false;
      let failed = false;
      claimable[id] = { ...(claimable[id] || {}), busy: true };
      const urgent = !!claimUrgent[id];
      delete claimUrgent[id];
      try {
        const r = await invoke("claim_refresh", { id, urgent });
        claimable[id] = { plans: r.plans || [], err: null, busy: false };
        // 事件上报（activation POST）的风控响应同样实时记账：
        // 上游在 event/report 上返回拒绝码/HTTP 错误 = 该号已被风控盯上，
        // 与领取失败共用同一套记账口径（首信号即冻结；熔断在 noteClaimRisk 内统一喂给）
        if (r.activationError && riskInText(stripErr(r.activationError))) noteClaimRisk(id);
        // preview 结果喂给实例登记：新 plan_id 首现 → 级联未持有者
        notePlanInstances((r.plans || []).map((p) => ({ planId: p.plan_id, name: p.name })));
      } catch (e) {
        claimable[id] = { plans: claimable[id]?.plans || [], err: String(e), busy: false };
        if (riskInText(stripErr(e))) noteClaimRisk(id);
        // G7 同款：30min 例行退避不得覆盖 noteClaimRisk 刚写入的 3h 停靠冷却
        autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
          Date.now() + autoClaimGap(AUTO_CLAIM_INTERVAL_MS));
        roundSkipped++;
        continue;
      }
      if (!uiLocked()) render();
      let attempts = 0;
      let progressed = true;
      while (progressed && attempts < AUTO_CLAIM_PER_ACCOUNT_CAP) {
        if (autoAbortRequested || autoClaimPaused) break;
        attempts++;
        progressed = false;
        const plan = claimable[id]?.plans?.[0];
        if (!plan) break;
        try {
          await invoke("claim_start", { id, planId: plan.plan_id, auto: true });
          // 手动操作抢占：claim_start 刚挂上的 pending 立即撤销，避免与新手动领取争抢全局槽位
          if (autoAbortRequested || autoClaimPaused) {
            await invoke("claim_cancel").catch(() => {});
            break;
          }
        } catch (e) {
          const gone = claimGonePayload(e);
          if (gone) {
            // 报价在轮内 preview 与 claim_start 之间被上游撤掉：就地校准，不计失败
            // 不升级冷却（号本身没问题，最新报价交给下一轮按正常节奏接续）
            claimable[id] = { plans: gone.plans, err: null, busy: false };
            break;
          }
          if (riskInText(stripErr(e))) noteClaimRisk(id);
          await invoke("claim_cancel").catch(() => {});
          // 抛错（405 风控拦截等）与提交失败同谱升级：30min→2^n 封顶 4h，
          // 写死 10min 会让被拦账号反复撞墙、两轮就吃满风控信号被冻结
          const streak = (autoClaimFailRounds[id] = (autoClaimFailRounds[id] || 0) + 1);
          // 取 max（含既有冷却）：风控冻结刚写入的 3h 探测冷却不得被这里的
          // 30min 退避覆盖（G7），否则刚停靠的号 ~30min 就被重新推上撞墙位
          autoClaimCooldown[id] = Math.max(
            autoClaimCooldown[id] ?? 0,
            Date.now() + autoClaimGap(AUTO_CLAIM_INTERVAL_MS),
            Date.now() + autoClaimGap(AUTO_CLAIM_FAIL_MIN_MS * (2 ** Math.min(streak - 1, 3))),
          );
          failed = true;
          break;
        }
        const r = await waitForClaimResult(id, AUTO_CLAIM_WAIT_MS);
        if (!r) {
          await invoke("claim_cancel").catch(() => {});
          autoClaimCooldown[id] = Date.now() + autoClaimGap(AUTO_CLAIM_INTERVAL_MS);
          failed = true;
          break;
        }
        if (r.ok === false) {
          // 失败递增退避：基础冷却（1005 nextAt/30min 下限）、既有冷却 与 翻倍退避 取大者
          const streak = (autoClaimFailRounds[id] = (autoClaimFailRounds[id] || 0) + 1);
          const escalate = Date.now() + autoClaimGap(AUTO_CLAIM_FAIL_MIN_MS * (2 ** Math.min(streak - 1, 3)));
          autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0, autoClaimCooldownFor(r), escalate);
          // 风控信号：只冻结该账号数小时（几小时后自动分批重试），轮次继续
          // 但整体降速——一个号 405 不代表其他号也有问题，整轮停止过度保守。
          // 取 max 含既有冷却（G7 残余补全）：同一事件 claim://result 监听器已让
          // noteClaimRisk 写入 3h~4.5h 顺延停靠，不得被这里的固定 3h 覆盖；
          // 对照无需同改的直接赋值——上方轮内超时 10min 与 captcha://interactive 1h：
          // 二者非风控信号、不涉 noteClaimRisk，不存在覆盖更长停靠值的路径
          if (claimFailureRisk(r)) {
            autoClaimCooldown[id] = Math.max(autoClaimCooldown[id] ?? 0,
              Date.now() + autoClaimGap(3 * 60 * 60 * 1000));
            autoClaimSlowUntil = Date.now() + 5 * 60 * 1000;
          }
          failed = true;
          break;
        }
        gotAny = true; roundClaimed++;
        noteFleetRiskOk();
        // 领取成功：上游需要几分钟发放套餐余额，主动触发额度刷新能最早看到数据
        pokeAccount(id);
        await awaitClaimPreviewFresh(id);
        if (!uiLocked()) render();
        progressed = true;
        await new Promise((res) => setTimeout(res, 1200));
      }
      if (gotAny) { autoClaimEmptyRounds[id] = 0; autoClaimFailRounds[id] = 0; }
      if (!gotAny && (claimable[id]?.plans || []).length) roundSkipped++;
      // 统一收尾冷却（带去相位抖动）：有失败走失败时已设的冷却；
      // 连续空手的账号按层封顶渐进退避——T0 当前号 12min（在用号随时可能上架新礼物）、
      // T1 新号 30min、T2 有额度 2h、T3 其余 30min→4h 原样。快检集合恒小：
      // 绝大多数老号空手一次就拿到「无资格/已领」证词，从快检层永久退出
      if (!failed) {
        const remaining = (claimable[id]?.plans || []).length;
        if (remaining === 0) {
          const streak = (autoClaimEmptyRounds[id] = (autoClaimEmptyRounds[id] || 0) + 1);
          const cap = claimTierCapMs(claimTierOf(id));
          autoClaimCooldown[id] = Date.now() + Math.min(
            autoClaimGap(AUTO_CLAIM_RECHECK_MS * (2 ** Math.min(streak - 1, 3))),
            autoClaimGap(cap),
          );
          // 空手证词：非当前、非新号、未领过 Global Build 的账号首次空手 → 记账降级。
          // 资格规则若变，级联/安全网仍会重新覆盖到它
          const a = (state?.accounts || []).find((x) => x.id === id);
          const created = Date.parse(String(a?.created_at || "").replace(" ", "T")) || 0;
          const isNew = created && Date.now() - created < CLAIM_NEW_MS;
          if (id !== state?.active_account_id && !isNew && !claimLedger[id]?.global) {
            claimLedger[id] = { ...(claimLedger[id] || {}), globalEmpty: Date.now() };
            saveClaimLedger();
          }
        } else {
          autoClaimCooldown[id] = Date.now() + autoClaimGap(AUTO_CLAIM_INTERVAL_MS);
        }
      }
      // 轮内账号间隙 12s±50%（风控信号后 5 分钟内 ×2.5）：一轮 76 账号从 ~6 分钟
      // 摊到 ~15 分钟，领取端点（activation/preview/submit）的顺序扫账号节奏减半
      // ——同 IP 顺序轮询多账号本身即风控信号，间距是最有效的压降手段
      await autoClaimGapSleep(
        AUTO_CLAIM_ACCT_GAP_MS * (1 + Math.random() * 0.5) * (Date.now() < autoClaimSlowUntil ? 2.5 : 1));
    }
  } finally {
    autoClaimRunning = false; claimActive = false;
    if (state?.auto_claim) lastAutoRound = { at: Date.now(), claimed: roundClaimed, skipped: roundSkipped };
    if (!uiLocked()) render();
  }
}

// 额度状态色：剩余=绿（快用尽转红）、已用=黄、完全用尽=整条黄
const BAR_GREEN = "#7fa886", BAR_RED = "#c4766f", BAR_YELLOW = "#b3a269";
const BAR_SEG_COLOR = { green: BAR_GREEN, red: BAR_RED, yellow: BAR_YELLOW };

// 条内标签以“剩余”为基准（对齐官方 3.14 额度面板的 9.7% 剩余语义）：
// 视觉不变——红段宽=已用、黄/绿段宽=剩余，标签从“已用%”翻转为“剩余%”
function quotaBarHtml(pct) {
  const p = quotaBarParts(pct);
  const body = p.segs
    .map((s) => `<span class="qb-seg" style="width:${s.width}%;background:${BAR_SEG_COLOR[s.kind]}"></span>`)
    .join("");
  return `<div class="qbar">${body}<span class="qbar-pct in-fill">${p.txt}</span></div>`;
}

function itemKind(it) {
  if (it.kind) return it.kind;
  if (it.name.includes("提示次数")) return "prompt_count";
  if (it.name.includes("使用时长")) return "duration";
  return "raw";
}
function windowLabel(it) {
  if (it.window) {
    if (it.window.startsWith("hours:")) return t("q.win.hours", { n: it.window.slice(6) });
    return has(`q.win.${it.window}`) ? t(`q.win.${it.window}`) : it.window;
  }
  const m = it.name.match(/[（(]每\s*([^）)]+)[）)]/);
  if (m) return "每" + m[1].replace(/^每/, "");
  if (itemKind(it) === "duration") return t("q.monthlyShort");
  if (itemKind(it) === "prompt_count") return t("q.countShort");
  return it.name;
}
function resetLabel(it) {
  if (it.reset) return t("q.resets", { time: it.reset });
  return it.period_end || "";
}

function winRowHtml(it, cls = "") {
  return `
  <div class="q-win${cls}">
    <span class="q-win-label">${esc(windowLabel(it))}</span>
    ${quotaBarHtml(it.percent_used)}
    <span class="q-win-reset" title="${esc(resetLabel(it))}">${it.reset || it.period_end ? esc(resetLabel(it)) : ""}</span>
  </div>`;
}

function fmtTokens(n) {
  if (n == null) return "";
  if (lang() === "zh") {
    if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 1) + "亿";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
  }
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(Math.round(n));
}
function balRowHtml(it) {
  const rem = it.total != null && it.remaining != null
    // 剩余段带 .rem 钩子（卡片内按健康度着色），总量段保持灰
    ? `<b class="rem">${esc(fmtTokens(it.remaining))}</b><span class="tot">/${esc(fmtTokens(it.total))}</span>`
    : "";
  // 对齐官方完整模型名（show_name 本就是 GLM-5.3-Flash 这类全称）
  return `
  <div class="q-win mini">
    <span class="q-win-label" title="${esc(it.name)}">${esc(it.name)}</span>
    ${quotaBarHtml(it.percent_used)}
    <span class="q-win-reset">${rem}</span>
  </div>`;
}

const TIER_RANK = { max: 0, pro: 1, lite: 2, start: 3, trial: 4, trust: 5, other: 9 };

/** 套餐等级归一：有 tier_code 时以它为准，否则回退到名称文本 */
function tierKind(tier, code) {
  const c = String(code || "").trim().toLowerCase();
  if (c === "max" || c === "pro" || c === "lite" || c === "start" || c === "trial" || c === "trust") return c;
  const s = String(tier || "").toLowerCase();
  if (s.includes("max")) return "max";
  if (s.includes("pro")) return "pro";
  if (s.includes("lite")) return "lite";
  if (s.includes("start")) return "start";
  if (s.includes("trust")) return "trust";
  if (s.includes("trial") || String(tier || "").includes("体验")) return "trial";
  return "other";
}

function tierChipHtml(tier, code) {
  const kind = tierKind(tier, code);
  const label = kind === "max" ? "Max"
    : kind === "pro" ? "Pro"
      : kind === "lite" ? "Lite"
        : kind === "start" ? "Start"
          : kind === "trust" ? "Trust Build"
            : kind === "trial" ? t("q.trial")
              : (tier || t("q.other"));
  const cls = kind === "other" ? "other" : kind === "start" || kind === "trust" ? "trial" : kind;
  return `<span class="tier-b ${cls}">${esc(label)}</span>`;
}

/** 行内套餐标签：同一等级只显示一次（Start Plan 常有多个 plan 条目），按等级从高到低 */
function giftBadgeFor(id) {
  const h = healthMapOf().get(id);
  return h?.hasGift ? `<span class="gift-badge" title="${esc(healthLabel("gift"))}">${ic("gift", 12)}</span>` : "";
}

function tierBadgeFor(id) {
  const q = acctQuota[id];
  if (!q?.data) return "";
  const plans = q.data.plans || [];
  const list = plans.length
    ? plans.map((p) => [p.tier, p.tier_code])
    : (q.data.plan_tier ? [[q.data.plan_tier, null]] : []);
  if (!list.length) return q.data.is_empty ? "" : `<span class="tier-b free">Free</span>`;
  const seen = new Map();
  for (const [tier, code] of list) {
    const kind = tierKind(tier, code);
    if (!seen.has(kind)) seen.set(kind, tier);
  }
  return [...seen.entries()]
    .sort((a, b) => (TIER_RANK[a[0]] ?? 9) - (TIER_RANK[b[0]] ?? 9))
    .slice(0, 2)
    .map(([kind, tier]) => tierChipHtml(tier, kind))
    .join("");
}

function grantLabel(plan) {
  const items = plan.grant_items || [];
  if (items.length) {
    const g = items[0];
    return t("q.grant", {
      name: g.name,
      amount: fmtTokens(g.units),
      period: t(`q.period.${g.period}`, {}) === `q.period.${g.period}` ? g.period : t(`q.period.${g.period}`, {}),
    });
  }
  return (plan.grants || [])[0] || "";
}
/** 领取迷你按钮：一个 🎁 图标（点击效果与「领取」一致），详情进 tooltip；
 *  渲染在固定槽位（卡片底行 / 列表工具条），出现与消失都不引起布局位移 */
function claimMiniBtnHtml(id) {
  const c = claimable[id];
  const plan = c?.plans?.[0];
  if (!plan) return "";
  const grants = grantLabel(plan);
  const label = planDisplayName(plan.name || plan.plan_id);
  const tip = [label, grants, plan.description].filter(Boolean).join(" · ");
  return `<button class="card-claim" title="${esc(`${t("btn.claim")} · ${tip}`)}" aria-label="${esc(t("btn.claim"))}"
    click="actions.claim('${id}')" ${claimAllRunning || (claimActive && !autoClaimRunning) ? "disabled" : ""}>${ic("gift", 15)}</button>`;
}

function slotRowsHtml(items) {
  const list = items || [];
  const isWin = (it) => itemKind(it) !== "raw";
  const wins = list.filter(isWin);
  const best = new Map();
  for (const it of list) {
    if (isWin(it)) continue;
    const cur = best.get(it.name);
    if (!cur || (it.total || 0) > (cur.total || 0)) best.set(it.name, it);
  }
  const pools = [...best.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
  return [
    ...wins.map((it) => winRowHtml(it, " mini")),
    ...pools.map(balRowHtml),
  ].join("");
}

function expireInfo(s) {
  if (!s) return null;
  const hasTime = s.length >= 16;
  const ms = new Date(hasTime ? s.replace(" ", "T") : s + "T23:59:59") - Date.now();
  if (isNaN(ms)) return { text: s, soon: false, warn: false };
  const soon = ms <= 5 * 86400000;
  const warn = ms <= 7 * 86400000;
  return { text: soon && hasTime ? s : s.slice(0, 10), soon, warn };
}

/** 套餐展示名：去掉中文后缀（礼包/活动包/体验包/包），只保留英文主体（Weekend Build 等） */
function planDisplayName(name) {
  return String(name || "").replace(/\s*(礼包|活动包|体验包|赠送包|包)\s*$/g, "").trim();
}

function planGroupHtml(p, omitTier = false) {
  const label = p.tier_code === "other" && !p.pid ? t("q.other") : planDisplayName(p.name || p.tier || "");
  const expiredTag = planExpired(p) ? `<span class="plan-expired">${esc(t("list.planExpired"))}</span>` : "";
  const exp = expireInfo(p.expire);
  return `
  <div class="plan-grp${planExpired(p) ? " expired" : ""}">
    <div class="pg-head">
      ${p.tier && !omitTier ? tierChipHtml(p.tier, p.tier_code) : ""}
      <span class="pg-name" title="${esc(label)}">${esc(label)}</span>${expiredTag}
      ${exp ? `<span class="pg-exp${exp.warn ? " warn-line" : ""}" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(t("q.validUntilShort", { date: exp.text }))}</span>` : ""}
    </div>
    ${slotRowsHtml(p.items)}
  </div>`;
}

function quotaDetailHtml(id) {
  const q = acctQuota[id];
  // 刷新中但已有旧数据：继续渲染旧数据，避免展开明细塌缩成一行导致高度/宽度抖动
  if (q?.busy && !q?.data) return `<span class="aq-loading">${t("q.loading")}</span>`;
  if (q?.err) {
    const msg = q.err.length > 46 ? q.err.slice(0, 46) + "…" : q.err;
    return `<span class="aq-err">${esc(msg)}</span>`;
  }
  if (!q?.data) return "";
  const plans = q.data.plans || [];
  if (plans.length) {
    // 按套餐分组：容量差异悬殊（1亿 vs 5M）时任何单条堆叠都会误导，分开各画各的最保真
    const kinds = new Set(plans.map((p) => tierKind(p.tier, p.tier_code)));
    return plans.map((p) => planGroupHtml(p, kinds.size === 1)).join("");
  }
  const items = q.data.items || [];
  const wins = items.filter((it) => itemKind(it) === "prompt_count");
  if (wins.length) return wins.map((it) => winRowHtml(it, " mini")).join("");
  if (items.length) return slotRowsHtml(items);
  // 没有明细项时用总览兜底，避免展开后一片空白
  if (q.data.percent_used != null) {
    return winRowHtml({ name: q.data.plan_tier || t("q.other"), percent_used: q.data.percent_used, window: "cycle" }, " mini");
  }
  return `<span class="aq-loading">${t("q.other")}</span>`;
}

/** 行内额度区：只含额度明细（领取按钮在固定槽位，见 claimMiniBtnHtml） */
function quotaSlotInner(id, showDetail) {
  return `${showDetail ? quotaDetailHtml(id) : ""}`;
}
function quotaSlotHtml(id, showDetail) {
  const inner = quotaSlotInner(id, showDetail);
  if (!inner) return "";
  return `<div class="row-quota-slot" data-quota-slot>${inner}</div>`;
}
/** 卡片收起态的「主额度条」：与 chip 同语义——关注模型的最好池优先，流转/耗尽回落到全场最好池 */
function cardPrimaryPoolHtml(id) {
  const d = acctQuota[id]?.data;
  if (!d) return "";
  const key = String(focusModel() || "").trim().toLowerCase();
  const pools = [];
  for (const p of d.plans || []) {
    if (planExpired(p)) continue;
    for (const it of p.items || []) {
      if (itemKind(it) !== "raw") continue;
      const used = Number(it.percent_used);
      pools.push({
        it,
        rem: isFinite(used) ? 100 - used : -1,
        focus: key ? modelKeyMatch(String(it.name || "").toLowerCase(), key) : false,
      });
    }
  }
  const pick = (list) => list.reduce((b, x) => (!b || x.rem > b.rem ? x : b), null);
  // 顺序：关注模型且有余量（正常号，与 chip 的“剩 x%”同池）→ 全场有余量（流转号）→ 兜底（耗尽号画 0% 条）
  const hit = pick(pools.filter((x) => x.focus && x.rem > 0)) || pick(pools.filter((x) => x.rem > 0)) || pick(pools);
  if (hit) return balRowHtml(hit.it);
  if ((d.items || []).length) {
    const win = d.items.find((it) => itemKind(it) === "prompt_count");
    if (win) return winRowHtml(win, " mini");
  }
  if (d.percent_used != null) return winRowHtml({ name: d.plan_tier || t("q.other"), percent_used: d.percent_used, window: "cycle" }, " mini");
  return "";
}

/** 卡片额度区：收起=主额度条；展开=完整明细；busy 无旧数据给一行“查询中” */
function cardQuotaSlotHtml(id) {
  if (ui.expanded.has(id)) {
    return `<div class="row-quota-slot card-quota" data-quota-slot>${quotaSlotInner(id, true)}</div>`;
  }
  const q = acctQuota[id];
  const loading = q?.busy && !q?.data ? `<span class="aq-loading">${t("q.loading")}</span>` : "";
  const body = `${loading}${cardPrimaryPoolHtml(id)}`;
  if (!body) return `<div class="card-quota-empty" data-quota-slot></div>`;
  const lv = healthMapOf().get(id)?.level || "unknown";
  return `<div class="row-quota-slot card-quota lv-${lv}" data-quota-slot>${body}</div>`;
}

function captureScroll() {
  const list = $app.querySelector(".list");
  if (!list || list.scrollTop === 0) return null;
  const listTop = list.getBoundingClientRect().top;
  for (const row of list.querySelectorAll(".row[data-id], .card[data-id]")) {
    if (row.getBoundingClientRect().bottom > listTop) {
      return { id: row.dataset.id, offset: row.getBoundingClientRect().top - listTop, scrollTop: list.scrollTop };
    }
  }
  return null;
}
function restoreScroll(cap) {
  if (!cap) return;
  const list = $app.querySelector(".list");
  if (!list) return;
  const row = list.querySelector(`.row[data-id="${CSS.escape(cap.id)}"], .card[data-id="${CSS.escape(cap.id)}"]`);
  if (row) {
    const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = delta - cap.offset;
  } else {
    list.scrollTop = cap.scrollTop;
  }
}

// 「回到顶部」悬浮按钮：只在列表滚下去之后出现（列表内部滚动，不在窗口上）
function syncTopFab() {
  const btn = $app.querySelector("[data-fab-top]");
  if (!btn) return;
  const list = $app.querySelector(".list");
  const top = list ? list.scrollTop : 0;
  btn.classList.toggle("show", top > 200);
}

let lastRenderSig = "";
let lastQuotaSig = "";
let lastProgressSig = "";
let lastBucketSig = "";
/** 分组/排序布局签名（可见账号 → 所在分组 + 展示顺序）。
 *  就地补丁只更新额度 DOM，不会把行挪到正确的分组里、也不会重排；
 *  一旦归属或顺序变了就必须整表重建，否则刷新完额度变了、行还留在旧分组/旧位置，
 *  要等到下一次结构变化才归位。 */
function renderBucketSig() {
  const { list, hm } = visibleAccounts();
  return list.map((a) => `${a.id}:${hm.get(a.id)?.level || "unknown"}`).join(",");
}
function renderQuotaSig() {
  // 额度数据用轻量摘要（busy/错误/refreshed_at），避免每次渲染全量序列化大对象
  const qsig = Object.keys(acctQuota).map((k) => {
    const q = acctQuota[k];
    if (!q) return `${k}:0`;
    const mark = q.busy ? "b" : q.err ? "e" : (q.data?.refreshed_at ?? "x");
    return `${k}:${mark}`;
  }).join("|");
  const csig = Object.keys(claimable).map((k) => `${k}:${claimable[k]?.busy ? "b" : ""}${claimable[k]?.plans?.length ?? 0}`).join("|");
  return qsig + "" + csig;
}
function renderSignature() {
  // 进度对象（批量刷新/领取计数）与 2API 用量计数不进结构签名：
  // 它们高频变化，若混进来会把“结构未变”的判定打穿、退化回整表重建（宽度抖动元凶）
  return JSON.stringify([
    state, autoSwitchNote, twoLastStatus,
    [...ui.expanded], [...ui.selected], [...ui.collapsedSections],
    ui.search, ui.health, ui.sort, ui.sortDir, ui.density, ui.hideInfo, ui.qhOpen, ui.qhTab, renaming, ui.view,
    appVer, autoSwitchRunning, autoClaimRunning, claimActive, busy,
  ]);
}
function renderProgressSig() {
  return JSON.stringify([quotaSweep, claimAllState, [...twoUsageMap.entries()]]);
}

function giftBtnHtml(claimableCount) {
  return `<button class="icon-btn tb-btn tb-gift${claimAllState.running ? " running" : ""}" data-gift-btn click="actions.claimAll()" ${claimAllRunning || (claimActive && !autoClaimRunning) ? "disabled" : ""}
      aria-label="${t("btn.claimAll")}" title="${claimAllState.running
        ? esc(t("btn.claimAllRunning", { done: claimAllState.done, total: claimAllState.total }) + " · " + t("btn.claimAllStopHint"))
        : esc(t("btn.claimAllTitle"))}${claimableCount > 1 ? ` (${claimableCount})` : ""}">
      ${ic("gift", 17)}${claimAllState.running
        ? `<span class="tb-badge">${claimAllState.done}/${claimAllState.total}</span>`
        : claimableCount > 1 ? `<span class="tb-badge">${claimableCount}</span>` : ""}
    </button>`;
}

// ---------- 额度统计模态（设置弹窗同款交互：body 挂载 / Esc / 点外关闭） ----------

let quotaModalEl = null;
let qhOnKey = null;
// 真实用量（ZCode CLI 本地库，请求完成后落库）：打开面板时读取
let usageData = null;
let usageLoading = false;
// 用量统计窗口：默认 7 天，面板内可切 30 天（后端 SQLite 索引查询，30 天毫秒级）
let usageDays = 7;
async function loadUsageStats() {
  if (usageLoading) return;
  usageLoading = true;
  try {
    usageData = await invoke("usage_stats", { days: usageDays });
  } catch { usageData = null; }
  usageLoading = false;
  if (ui.qhOpen) refreshQuotaModal();
}

function closeQuotaModal() {
  if (quotaModalEl) { quotaModalEl.remove(); quotaModalEl = null; }
  if (qhOnKey) { document.removeEventListener("keydown", qhOnKey); qhOnKey = null; }
  ui.qhOpen = false;
}

function openQuotaModal() {
  closeQuotaModal();
  // 防御：清掉任何残留面板，保证全局只有一个实例
  document.querySelectorAll(".qh-panel").forEach((n) => n.remove());
  ui.qhOpen = true;
  const mask = document.createElement("div");
  mask.className = "st-mask pv-mask";
  // quotaPanelHtml 自身已返回 .qh-panel，不再额外包裹（否则出现双层错位面板）
  mask.innerHTML = quotaPanelHtml(quotaTotals());
  document.body.appendChild(mask);
  quotaModalEl = mask;
  loadUsageStats();
  const close = () => { closeQuotaModal(); render(); };
  qhOnKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", qhOnKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
}

/** 面板打开期间的局部刷新：重建面板内容但保持滚动位置（Tab 切换 / 额度数据更新共用） */
function refreshQuotaModal() {
  if (!ui.qhOpen) { closeQuotaModal(); return; }
  const pop = document.querySelector("[data-qh-pop]");
  if (!pop) return;
  const sc = pop.querySelector("[data-qh-scroll]");
  const st = sc ? sc.scrollTop : 0;
  const mask = pop.parentElement; // 遮罩层：面板高于视口时的滚动容器
  const mst = mask ? mask.scrollTop : 0;
  const tpl = document.createElement("template");
  tpl.innerHTML = quotaPanelHtml(quotaTotals()).trim();
  const node = tpl.content.firstElementChild;
  if (!node) return;
  pop.replaceWith(node);
  // 滚动恢复必须在节点入 DOM 之后：对游离元素赋 scrollTop 是空操作，
  // 会导致每次额度更新后弹窗滚动位置被重置回顶部
  const nsc = node.querySelector("[data-qh-scroll]");
  if (nsc) nsc.scrollTop = st;
  if (mask && mask.isConnected) mask.scrollTop = mst;
}

/** 进度/用量类就地补丁：批量刷新计数、礼物按钮徽标、行内 2API 用量 */
function patchProgressDom() {
  const replace = (sel, html) => {
    const el = $app.querySelector(sel);
    if (!el) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild;
    if (node) el.replaceWith(node);
  };
  if ((state?.accounts || []).length) {
    replace("[data-sweep-btn]", `<button class="icon-btn tb-btn tb-refresh${quotaSweep.running ? " running" : ""}" data-sweep-btn click="actions.refreshAll()"
        aria-label="${t("btn.refreshAll")}" title="${esc(refreshAllTitle())}">
        ${ic("refresh", 17)}${refreshAllBadge()}
      </button>`);
  }
  const claimableCount = (state?.accounts || []).filter((a) => !isArchived(a.id) && (claimable[a.id]?.plans || []).length > 0).length;
  if (claimableCount > 0 || claimAllState.running) {
    replace("[data-gift-btn]", giftBtnHtml(claimableCount));
  }
}

/** 结构未变、仅额度数据变化时的精准补丁：只就地更新额度相关 DOM，宽度/滚动零扰动 */
function patchQuotaDom() {
  const { list: visible, hm } = visibleAccounts();
  const sum = summarize(state?.accounts || [], hm, { isArchived: (a) => isArchived(a.id) });
  const replace = (sel, html) => {
    const el = $app.querySelector(sel);
    if (!el) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild;
    if (node) el.replaceWith(node);
  };
  replace(".lh-sum", summaryHtml(sum));
  replace(".chips", chipsHtml(sum));
  const qt = quotaTotals();
  replace("[data-qh-chip]", quotaHeadChipHtml(qt));
  if (ui.qhOpen || quotaModalEl) refreshQuotaModal();
  for (const a of visible) {
    const node = $app.querySelector(`.row[data-id="${CSS.escape(a.id)}"], .card[data-id="${CSS.escape(a.id)}"]`);
    if (!node) continue;
    const isCard = node.classList.contains("card");
    const h = hm.get(a.id) || { level: "unknown", remainingPct: null };
    const dot = node.querySelector(".hdot");
    if (dot) {
      const tpl = document.createElement("template");
      tpl.innerHTML = healthDotHtml(h).trim();
      const n = tpl.content.firstElementChild;
      if (n) dot.replaceWith(n);
    }
    const q = acctQuota[a.id];
    const slim = !isCard && node.classList.contains("slim");
    const info = node.querySelector(".row-info");
    if (info) {
      // 快到期徽章已移入名称行（row-name），此处只刷额度小条
      const showChip = isCard || slim;
      info.innerHTML = showChip ? quotaChipHtml(a.id, h) : "";
    }
    const slot = node.querySelector("[data-quota-slot]");
    if (slot) {
      // 卡片与列表行的槽位结构不同：卡片走 cardQuotaSlotHtml（收起=主额度条），
      // 列表行走 quotaSlotInner（完整套餐组）——统一会用卡片的裸池条补丁列表行，
      // 造成密度切换/额度更新时明细退化成裸条的布局错乱
      const fresh = isCard
        ? cardQuotaSlotHtml(a.id)
        : (quotaSlotInner(a.id, !slim)
            ? `<div class="row-quota-slot" data-quota-slot>${quotaSlotInner(a.id, !slim)}</div>`
            : "");
      if (!fresh) { slot.remove(); }
      else if (fresh !== slot.outerHTML) slot.outerHTML = fresh;
    }
    const cs = node.querySelector("[data-claim-slot]");
    if (cs) {
      const btn = claimMiniBtnHtml(a.id);
      if (cs.innerHTML !== btn) cs.innerHTML = btn;
    }
  }
}
// 滚动期间延迟重渲染：列表在滚动时被全量重建会造成掉帧
let scrollDeferUntil = 0;
let scrollRenderQueued = false;
let scrollDeferTimer = null;
let lastBulkRender = 0;
let bulkRenderQueued = false;
let bulkRenderTimer = null;
function scheduleBulkRender() {
  if (bulkRenderTimer) return;
  bulkRenderTimer = setTimeout(() => {
    bulkRenderTimer = null;
    if (bulkRenderQueued) {
      bulkRenderQueued = false;
      render();
    }
  }, 520);
}
function scheduleDeferredRender() {
  if (scrollDeferTimer) return;
  scrollDeferTimer = setTimeout(() => {
    scrollDeferTimer = null;
    if (scrollRenderQueued) {
      scrollRenderQueued = false;
      render();
    }
  }, 420);
}
function render(force = false) {
  // 轮询驱动的重渲染：状态指纹未变则跳过全量重建（避免高度抖动/滚动条漂移）
  if (!force) {
    if (Date.now() < scrollDeferUntil) {
      scrollRenderQueued = true;
      scheduleDeferredRender();
      return;
    }
    const sig = renderSignature();
    if (sig === lastRenderSig) {
      // 结构没变、只有额度/进度/用量数据在动：不整表重建，就地补丁对应 DOM
      const qs = renderQuotaSig();
      const ps = renderProgressSig();
      const bs = renderBucketSig();
      const regroup = bs !== lastBucketSig;
      if (qs !== lastQuotaSig || ps !== lastProgressSig) {
        lastQuotaSig = qs;
        lastProgressSig = ps;
        if (!regroup) {
          patchQuotaDom();
          patchProgressDom();
          return;
        }
        // 分组归属变了：下面整表重建（顺带也会把额度 DOM 一起铺上）
      } else if (!regroup) {
        return;
      }
    }
    // 批量操作（全量刷新/领取）期间合并重渲染，最多 500ms 一次，避免连续重建掉帧
    if (quotaSweep?.running || claimAllRunning || autoClaimRunning) {
      const now = Date.now();
      if (now - lastBulkRender < 500) {
        bulkRenderQueued = true;
        scheduleBulkRender();
        return;
      }
      lastBulkRender = now;
    }
    lastRenderSig = sig;
    lastQuotaSig = renderQuotaSig();
    lastProgressSig = renderProgressSig();
    lastBucketSig = renderBucketSig();
  }
  const scrollCap = captureScroll();
  if (!state) {
    $app.innerHTML = `<div class="loading">LOADING</div>`;
    return;
  }
  const s = state;
  // 清理已删除账号残留的展开态
  for (const id of [...ui.expanded]) {
    if (!s.accounts.some((a) => a.id === id)) ui.expanded.delete(id);
  }
  const active = s.accounts.find((a) => a.is_active) || null;
  const unsaved = s.live_logged_in && !active;

  const dotCls = s.zcode_running ? "run" : s.live_logged_in ? "" : "off";
  const statusText = s.zcode_running
    ? t("m.status.running")
    : s.live_logged_in
      ? unsaved ? t("m.status.unsaved") : t("m.status.safe")
      : t("m.status.loggedOut");

  const { list: visible, hm: healthMap } = visibleAccounts();
  const sum = summarize(s.accounts, healthMap, { isArchived: (a) => isArchived(a.id) });

  const rowHtml = (a, seq) => {
    const h = healthMap.get(a.id) || { level: "unknown", remainingPct: null };
    const isActive = a.is_active;
    if (renaming === a.id) {      return `
      <div class="row${isActive ? " active" : ""}" data-id="${a.id}">
        <span class="notch" style="background:${notchColor(a.id)}"></span>
        <div class="row-main">
          <input class="rename-input" value="${esc(a.name)}" maxlength="40"
            keydown="onRenameKey(event,'${a.id}')" blur="actions.deferCancelRename('${a.id}')">
          <div class="row-meta">${t("btn.renameMeta")}</div>
        </div>
        <div class="row-actions">
          <button class="btn-ghost" style="padding:4px 10px" click="actions.doRename('${a.id}')">${t("common.save")}</button>
          <button class="btn-ghost" style="padding:4px 10px" click="actions.cancelRename()">${t("common.cancel")}</button>
        </div>
      </div>`;
    }
    // 身份信息与账号名去重：用户名与账号名相同时不再在 meta 行重复展示
    const nm = String(a.name || "").trim().toLowerCase();
    // 身份信息只显示邮箱（无邮箱回退用户名），不再拼「名称 · 邮箱」
    const ident = [a.identity?.email, a.identity?.username]
      .filter(Boolean)
      .map((x) => x.trim())
      .filter((x) => x.toLowerCase() !== nm)[0] || "";
    const q = acctQuota[a.id];
    let meta = "";
    if (!a.has_config) meta += `<span class="meta-chip warn" title="${esc(t("q.noCfg"))}">${esc(t("q.noCfgShort"))}</span>`;
    // 到期徽章不再放列表行 meta：详细模式明细区每个套餐已自带完整到期时间，
    // 行级徽章是重复设计；紧凑模式 meta 整行隐藏，快到期仍由下方 expSoon 顶出
    const exp = expireInfo(q?.data?.plan_expire);
    // 名称本身就是邮箱/手机号时不再重复展示
    if (ident && ident.toLowerCase() !== String(a.name || "").trim().toLowerCase()) {
      meta += ui.hideInfo
        ? `<span class="meta-id masked">${esc(t("list.hidden"))}</span>`
        : `<span class="meta-id" title="${esc(ident)}">${esc(ident)}</span>`;
    }
    const checked = ui.selected.has(a.id);
    const slim = ui.density === "compact" && !ui.expanded.has(a.id);
    // 额度小条仅紧凑（slim）行显示：详细模式明细区已有完整套餐组，同屏即设计混用
    const showChip = slim;
    // 紧凑模式隐藏了 meta；快到期徽章放进名称行右侧——不再与额度小条同区挤压
    const expSoon = slim && exp?.warn
      ? `<span class="meta-chip warn" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(expSoonLabel(exp))}</span>`
      : "";
    // 无名账号回退：先试身份信息（邮箱/用户名），再兜底“未命名”
    const baseName = nameText(a);
    const displayName = (baseName && baseName.trim())
      || (ident ? (ui.hideInfo && looksSecret(ident) ? t("list.hidden") : ident) : "")
      || t("list.unnamed");
    const seqBadge = seq != null ? `<span class="row-seq" title="${esc(t("list.seqTitle"))}">${seq}</span>` : "";
    return `
    <div class="row${isActive ? " active" : ""}${checked ? " picked" : ""}${slim ? " slim" : ""}${isArchived(a.id) ? " archived" : ""}" data-id="${a.id}">
      <div class="row-top">
        ${seqBadge}
        <span class="rchk" role="checkbox" aria-checked="${checked}" title="${esc(t("list.selectHint"))}" click="actions.toggleSelect('${a.id}', event)">${ic("check", 11)}</span>
        ${healthDotHtml(h)}
        ${slim ? "" : `<span class="notch" style="background:${notchColor(a.id)}"></span>`}
        <div class="row-main"${ui.density === "compact" ? ` click="actions.toggleRow(event)" title="${esc(slim ? t("list.expandTitle") : t("list.collapseTitle"))}"` : ""}>
          <div class="row-name">${ui.density === "compact" ? `<span class="row-chev${slim ? "" : " open"}">${ic("chevDown", 12)}</span>` : ""}${tierBadgeFor(a.id)}<span class="rn-text" title="${esc(displayName)} · ${t("btn.rename")}" click="actions.rename('${a.id}')">${giftBadgeFor(a.id)}${esc(displayName)}</span>${isNewEnrolled(a) ? `<span class="tag-new" title="${esc(t("m.tagNewTitle"))}">${t("list.newTag")}</span>` : ""}${isFrozen(a.id) && autoFrozenAt[a.id] ? `<span class="tag-risk" title="${esc(t("m.tagRiskTitle"))}">${t("list.riskTag")}</span>` : ""}${isFrozen(a.id) && !autoFrozenAt[a.id] ? `<span class="tag-dock" title="${esc(t("m.tagDockTitle"))}">${t("list.dockTag")}</span>` : ""}${isArchived(a.id) ? `<span class="tag-arch" title="${esc(t("m.archivedDetail"))}">${t("list.archivedTag")}</span>` : ""}${a.has_user_info === false ? `<span class="tag-relogin" title="${esc(t("btn.reloginTitle"))}">${t("btn.relogin")}</span>` : ""}${expSoon}</div>
          <div class="row-meta">${meta}</div>
        </div>
        <div class="row-info">${showChip ? quotaChipHtml(a.id, h) : ""}</div>
        <div class="row-actions">
          <span class="row-tools">
            <span class="claim-slot" data-claim-slot></span>
            <button class="icon-btn" title="${t("btn.copyKey")}" aria-label="${t("btn.copyKey")}" click="actions.copyApiKey('${a.id}')">${ic("copy", 15)}</button>
            <button class="icon-btn${isFrozen(a.id) ? " on" : ""}" title="${isFrozen(a.id) ? (autoFrozenAt[a.id] ? t("btn.freezeUpgrade") : t("btn.unfreeze")) : t("btn.freeze")}" aria-label="${isFrozen(a.id) ? (autoFrozenAt[a.id] ? t("btn.freezeUpgrade") : t("btn.unfreeze")) : t("btn.freeze")}" click="actions.toggleFreeze('${a.id}')">${ic("snow", 15)}</button>
            <button class="icon-btn${isArchived(a.id) ? " on" : ""}" title="${isArchived(a.id) ? t("btn.unarchive") : t("btn.archive")}" aria-label="${isArchived(a.id) ? t("btn.unarchive") : t("btn.archive")}" click="actions.toggleArchive('${a.id}')">${ic("box", 15)}</button>
            <button class="icon-btn${acctQuota[a.id]?.busy ? " spinning" : ""}" title="${t("btn.refreshQuota")}" aria-label="${t("btn.refreshQuota")}" click="actions.acctQuota('${a.id}')">${ic("refresh", 15)}</button>
            <button class="icon-btn${claimable[a.id]?.busy ? " spinning" : ""}" title="${t("btn.giftQuery")}" aria-label="${t("btn.giftQuery")}" click="actions.queryGift('${a.id}')">${ic("search", 15)}</button>
            <button class="icon-btn" title="${t("btn.export")}" aria-label="${t("btn.export")}" click="actions.exportOne('${a.id}')">${ic("export", 15)}</button>
            <button class="icon-btn${isActive ? " on" : ""}" title="${t("btn.coldSwitch")}" aria-label="${t("btn.coldSwitch")}" click="actions.askColdSwitch('${a.id}')">${ic("power", 15)}</button>
            <button class="icon-btn danger" title="${t("btn.delete")}" aria-label="${t("btn.delete")}" click="actions.delete('${a.id}')">${ic("x", 15)}</button>
          </span>
          <button class="btn-switch has-ic" click="actions.askSwitch('${a.id}')" ${isActive ? "disabled" : ""}>
            ${isActive ? ic("check", 14) + " " + t("btn.current") : ic("swap", 14) + " " + t("btn.switch")}
          </button>
        </div>
      </div>
      ${quotaSlotHtml(a.id, !slim)}
    </div>`;
  };

  // ---- 卡片视图：结构固定（两行头部 + 模型条 + 底行），任何状态下各元素位置一致 ----
  const cardRowHtml = (a, seq) => {
    const h = healthMap.get(a.id) || { level: "unknown", remainingPct: null };
    const isActive = a.is_active;
    if (renaming === a.id) {
      return `
      <div class="card${isActive ? " active" : ""}" data-id="${a.id}">
        <div class="card-head">
          <div class="card-id">
            <input class="rename-input" value="${esc(a.name)}" maxlength="40" style="max-width:none"
              keydown="onRenameKey(event,'${a.id}')" blur="actions.deferCancelRename('${a.id}')">
            <div class="row-meta">${t("btn.renameMeta")}</div>
          </div>
        </div>
        <div class="card-foot">
          <button class="btn-ghost" style="padding:4px 10px" click="actions.doRename('${a.id}')">${t("common.save")}</button>
          <span style="flex:1"></span>
          <button class="btn-ghost" style="padding:4px 10px" click="actions.cancelRename()">${t("common.cancel")}</button>
        </div>
      </div>`;
    }
    const nm = String(a.name || "").trim().toLowerCase();
    // 身份信息只显示邮箱（无邮箱回退用户名），不再拼「名称 · 邮箱」
    const ident = [a.identity?.email, a.identity?.username]
      .filter(Boolean)
      .map((x) => x.trim())
      .filter((x) => x.toLowerCase() !== nm)[0] || "";
    const q = acctQuota[a.id];
    // meta 行固定一行：档位/礼物徽标 + 状态徽标在前，身份信息殿后（溢出省略）
    // 到期徽章不放这里——卡片头部一行放不下会被截断，挪到 card-foot-info 槽
    let meta = `${tierBadgeFor(a.id)}`;
    if (a.has_user_info === false) meta += `<span class="tag-relogin" title="${esc(t("btn.reloginTitle"))}">${t("btn.relogin")}</span>`;
    if (!a.has_config) meta += `<span class="meta-chip warn" title="${esc(t("q.noCfg"))}">${esc(t("q.noCfgShort"))}</span>`;
    const exp = expireInfo(q?.data?.plan_expire);
    if (ident && ident.toLowerCase() !== nm) {
      meta += ui.hideInfo
        ? `<span class="meta-id masked">${esc(t("list.hidden"))}</span>`
        : `<span class="meta-id" title="${esc(ident)}">${esc(ident)}</span>`;
    }
    const checked = ui.selected.has(a.id);
    const expanded = ui.expanded.has(a.id);
    const baseName = nameText(a);
    const displayName = (baseName && baseName.trim())
      || (ident ? (ui.hideInfo && looksSecret(ident) ? t("list.hidden") : ident) : "")
      || t("list.unnamed");
    // 卡片即切换按钮：点击卡片 = askSwitch（在用账号由 cardSwitch 忽略）；
    // 头部固定两行：名称行（序号+名称+使用中）/ 徽标行，模型条位置恒定。
    return `
    <div class="card${isActive ? " active" : ""}${checked ? " picked" : ""}${expanded ? " expanded" : ""}${isArchived(a.id) ? " archived" : ""}" data-id="${a.id}"
      ${isActive ? "" : `click="actions.cardSwitch('${a.id}')"`} title="${isActive ? "" : esc(t("btn.switch"))}">
      <span class="notch" style="background:${notchColor(a.id)}"></span>
      <div class="card-head">
        <div class="card-id">
          <div class="row-name">${seq != null ? `<span class="card-seq" title="${esc(t("list.seqTitle"))}">${seq}</span>` : ""}${giftBadgeFor(a.id)}<span class="rn-text" title="${esc(displayName)} · ${t("btn.rename")}" click="actions.rename('${a.id}')">${esc(displayName)}</span>${isNewEnrolled(a) ? `<span class="tag-new" title="${esc(t("m.tagNewTitle"))}">${t("list.newTag")}</span>` : ""}${isFrozen(a.id) && autoFrozenAt[a.id] ? `<span class="tag-risk" title="${esc(t("m.tagRiskTitle"))}">${t("list.riskTag")}</span>` : ""}${isFrozen(a.id) && !autoFrozenAt[a.id] ? `<span class="tag-dock" title="${esc(t("m.tagDockTitle"))}">${t("list.dockTag")}</span>` : ""}${isArchived(a.id) ? `<span class="tag-arch" title="${esc(t("m.archivedDetail"))}">${t("list.archivedTag")}</span>` : ""}</div>
          <div class="row-meta">${meta}</div>
        </div>
        <span class="card-side">
          <span class="rchk" role="checkbox" aria-checked="${checked}" title="${esc(t("list.selectHint"))}" click="actions.toggleSelect('${a.id}', event)">${ic("check", 11)}</span>
          <!-- 卡片头部不再放「剩 N%」小条：与下方模型条重复，健康度色落在模型条的数字上 -->
          <button class="card-expand" title="${esc(expanded ? t("list.collapseTitle") : t("list.expandTitle"))}" aria-label="${esc(expanded ? t("list.collapseTitle") : t("list.expandTitle"))}" click="actions.toggleRow(event)">${ic("chevDown", 13)}</button>
        </span>
      </div>
      ${cardQuotaSlotHtml(a.id)}
      <div class="card-foot">
        <span class="card-foot-info">${exp ? `<span class="meta-chip${exp.warn ? " warn" : ""}" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(t("q.validUntilShort", { date: exp.text }))}</span>` : ""}</span>
        <span class="claim-slot" data-claim-slot></span>
        <span class="card-tools" click="actions.noop()">
          <button class="icon-btn sm" title="${t("btn.copyKey")}" aria-label="${t("btn.copyKey")}" click="actions.copyApiKey('${a.id}')">${ic("copy", 14)}</button>
          <button class="icon-btn sm${isFrozen(a.id) ? " on" : ""}" title="${isFrozen(a.id) ? (autoFrozenAt[a.id] ? t("btn.freezeUpgrade") : t("btn.unfreeze")) : t("btn.freeze")}" aria-label="${isFrozen(a.id) ? (autoFrozenAt[a.id] ? t("btn.freezeUpgrade") : t("btn.unfreeze")) : t("btn.freeze")}" click="actions.toggleFreeze('${a.id}')">${ic("snow", 14)}</button>
          <button class="icon-btn sm${isArchived(a.id) ? " on" : ""}" title="${isArchived(a.id) ? t("btn.unarchive") : t("btn.archive")}" aria-label="${isArchived(a.id) ? t("btn.unarchive") : t("btn.archive")}" click="actions.toggleArchive('${a.id}')">${ic("box", 14)}</button>
          <button class="icon-btn sm${acctQuota[a.id]?.busy ? " spinning" : ""}" title="${t("btn.refreshQuota")}" aria-label="${t("btn.refreshQuota")}" click="actions.acctQuota('${a.id}')">${ic("refresh", 14)}</button>
          <button class="icon-btn sm${claimable[a.id]?.busy ? " spinning" : ""}" title="${t("btn.giftQuery")}" aria-label="${t("btn.giftQuery")}" click="actions.queryGift('${a.id}')">${ic("search", 14)}</button>
          <button class="icon-btn sm" title="${t("btn.export")}" aria-label="${t("btn.export")}" click="actions.exportOne('${a.id}')">${ic("export", 14)}</button>
          <button class="icon-btn sm${isActive ? " on" : ""}" title="${t("btn.coldSwitch")}" aria-label="${t("btn.coldSwitch")}" click="actions.askColdSwitch('${a.id}')">${ic("power", 14)}</button>
          <button class="icon-btn sm danger" title="${t("btn.delete")}" aria-label="${t("btn.delete")}" click="actions.delete('${a.id}')">${ic("x", 14)}</button>
        </span>
      </div>
    </div>`;
  };

  const listHtml = s.accounts.length === 0
    ? `<div class="empty">
         <div class="glyph">${ic("empty", 34)}</div>
         ${t("m.emptyTitle")}<br>
         ${t("m.emptyBody")}
       </div>`
    : visible.length === 0
      ? `<div class="empty">
           <div class="glyph">${ic("search", 34)}</div>
           ${t("list.noMatch")}<br>
           <button class="btn-ghost" style="margin-top:10px" click="actions.clearFilters()">${t("list.clearFilters")}</button>
         </div>`
      : s.grouped
        ? groupedListHtml(visible, rowHtml, healthMap)
        : ui.view === "card"
          ? `<div class="card-grid">${pinActiveFirst(visible).map((a, i) => cardRowHtml(a, i + 1)).join("")}</div>`
          : pinActiveFirst(visible).map((a, i) => rowHtml(a, i + 1)).join("");

  const claimableCount = s.accounts.filter((a) => !isArchived(a.id) && (claimable[a.id]?.plans || []).length > 0).length;

  $app.innerHTML = `
    <header class="topbar">
      <div class="wordmark">Z·SWITCH${appVer ? ` <span class="ver">v${esc(appVer)}</span>` : ""}${window.__ZSW_MOCK__ ? `<span class="ver mock-badge">PREVIEW</span>` : ""}</div>
      <div class="top-right">
        <div class="top-status${unsaved ? " unsaved" : ""}">
          <span class="status-dot ${dotCls}"></span>
          <span class="status-text">${esc(statusText)}</span>
        </div>
      </div>
    </header>

    <section class="toolbar">
      <div class="tb-group">
        <button class="icon-btn tb-btn tb-capture${unsaved ? " attention" : ""}" click="actions.capture()" ${!s.live_logged_in || active ? "disabled" : ""}
          aria-label="${t("btn.saveLogin")}" title="${active ? esc(t("m.saveLoginDisabledTitle", { name: active.name })) : t("btn.saveLogin")}">
          ${ic("capture", 17)}
        </button>
        <button class="icon-btn tb-btn tb-add" click="actions.addAccount()" aria-label="${t("btn.addAccount")}" title="${t("btn.addAccountTitle")}">${ic("userPlus", 17)}</button>
      </div>
      <span class="tb-sep"></span>
      <div class="tb-group">
        ${(claimableCount > 0 || claimAllState.running) ? giftBtnHtml(claimableCount) : ""}
        <button class="icon-btn tb-btn tb-autoclaim${s.auto_claim ? " on" : ""}${autoClaimRunning ? " running" : ""}"
          role="switch" aria-checked="${s.auto_claim}" aria-label="${t("btn.autoClaim")}"
          title="${autoPillTitle(s)}" click="actions.toggleAutoClaim()">
          ${ic("giftRepeat", 17)}
        </button>
        <button class="icon-btn tb-btn tb-autoswitch${s.auto_switch ? " on" : ""}${autoSwitchRunning ? " running" : ""}"
          role="switch" aria-checked="${s.auto_switch}" aria-label="${t("as.label")}"
          title="${autoSwitchTitle(s)}" click="actions.toggleAutoSwitch()">
          ${ic("bolt", 17)}
        </button>
        ${(s.accounts.length > 0)
          ? `<button class="icon-btn tb-btn tb-refresh${quotaSweep.running ? " running" : ""}" data-sweep-btn click="actions.refreshAll()"
              aria-label="${t("btn.refreshAll")}" title="${esc(refreshAllTitle())}">
              ${ic("refresh", 17)}${refreshAllBadge()}
            </button>`
          : ""}
      </div>
      <span class="tb-sep"></span>
      <div class="tb-group">
        ${s.zcode_running
          ? `<button class="icon-btn tb-btn danger tb-kill" click="actions.askKill()" aria-label="${t("btn.killZcode")}" title="${t("btn.killZcode")}">${ic("power", 17)}</button>`
          : `<button class="icon-btn tb-btn tb-launch" click="actions.launch()" ${s.zcode_path_ok ? "" : "disabled"} aria-label="${t("btn.launchZcode")}" title="${t("btn.launchZcode")}">${ic("play", 16)}</button>`}
        <button class="icon-btn tb-btn tb-twoapi${s.two_api_on ? " on" : ""}" click="actions.openTwoApi()"
          aria-label="${t("two.title")}" title="${t("two.title")}">${ic("plug", 17)}</button>
        ${(s.accounts.length > 0)
          ? `<button class="icon-btn tb-btn tb-copyall" click="actions.copyAllKeys()"
              aria-label="${t("btn.copyAllKeys")}" title="${t("btn.copyAllKeys")}">${ic("copy", 17)}</button>`
          : ""}
        <button class="icon-btn tb-btn tb-settings" click="actions.openSettings()" aria-label="${t("common.settings")}" title="${t("common.settings")}">${ic("sliders", 17)}</button>
      </div>
    </section>

    ${listHeadHtml(s, sum, visible)}

    <main class="list">${listHtml}</main>
    ${(s.accounts.length || active) ? `<div class="fabs">
      ${s.accounts.length ? `<button class="fab fab-top" data-fab-top title="${t("list.backToTop")}" aria-label="${t("list.backToTop")}" click="actions.scrollListTop()">${ic("arrowUp", 17)}</button>` : ""}
      ${active ? `<button class="fab fab-locate" title="${t("list.locateActive")}" aria-label="${t("list.locateActive")}" click="actions.locateActive()">${ic("target", 17)}</button>` : ""}
    </div>` : ""}
  `;
  restoreScroll(scrollCap);
  syncTopFab();
  const pos = window.__searchPos;
  window.__searchPos = null;
  if (pos != null) {
    const box = $app.querySelector(".search-input");
    if (box) {
      box.focus();
      try { box.setSelectionRange(pos, pos); } catch { /* 忽略 */ }
    }
  }
}

window.actions = actions;
// DEV 预览调试钩子（生产构建剔除）：读取领取/刷新守卫的实时状态
if (import.meta.env.DEV) {
  window.__zswDebug = {
    get autoClaimRunning() { return autoClaimRunning; },
    get claimActive() { return claimActive; },
    get claimAllRunning() { return claimAllRunning; },
    get autoClaimPaused() { return autoClaimPaused; },
    get autoAbortRequested() { return autoAbortRequested; },
    get cooldowns() { return { ...autoClaimCooldown }; },
    get emptyRounds() { return { ...autoClaimEmptyRounds }; },
    clearCooldowns() { for (const k of Object.keys(autoClaimCooldown)) delete autoClaimCooldown[k]; },
    tick: () => autoClaimTick(),
  };
}
window.onProxyKey = (e) => { if (e.key === "Enter") actions.stSaveProxy(); };
window.onPathKey = (e) => { if (e.key === "Enter") actions.stSavePath(); };
window.onRenameKey = (e, id) => {
  if (e.key === "Enter") actions.doRename(id);
  if (e.key === "Escape") actions.cancelRename();
};
installDelegation();
// 任意滚动（含 .list 内部滚动容器，scroll 事件不冒泡所以用捕获）期间推迟重渲染
document.addEventListener("scroll", () => {
  scrollDeferUntil = Date.now() + 400;
  syncTopFab();
  scheduleDeferredRender();
}, { capture: true, passive: true });

listen("tray-action", (ev) => {
  const p = ev.payload || {};
  if (p.action === "capture" && p.ok) toast(t("m.toastSaved", { name: p.result.name }));
  else if (!p.ok && p.error) toast(p.error, "err");
  refresh().then(() => { if (!uiLocked()) { render(); enrollAccounts(); } }).catch(() => {});
});

listen("claim://result", (ev) => {
  const p = ev.payload || {};
  if (claimWaiter && claimWaiter.accountId === p.accountId) claimWaiter.finish(p);
  if (p.ok === false) {
    let msg = p.message || t("m.unknownErr");
    if (p.code === 1005 && p.nextAt) {
      msg += t("m.claimNextAt", { time: new Date(p.nextAt).toLocaleString(localeTag(), { hour12: false }) });
    }
    toast(t("m.claimFailed", { name: p.accountName, msg }), "err");
    if (claimFailureRisk(p)) noteClaimRisk(p.accountId); // 风控信号记账（首信号即冻结；熔断喂给在 noteClaimRisk 内统一）
  } else {
    noteFleetRiskOk();
    autoRiskStreak[p.accountId] = 0; // 领取成功：风控怀疑清零
    if (isFrozen(p.accountId)) autoUnfreeze(p.accountId); // 探测通过 → 解冻（手动/自动一视同仁）
    // 礼物账本：领到的实例记账（global 族终身免快检；weekend 族按期比对）
    markClaimedPlan(p.accountId, p.planName, p.planId);
    const bits = [];
    const now = p.serverTime || Date.now();
    if (p.startsAt && p.startsAt > now) bits.push(t("m.claimStartsAt", { time: new Date(p.startsAt).toLocaleString(localeTag(), { hour12: false }) }));
    if (p.endsAt) bits.push(t("m.claimEndsAt", { time: new Date(p.endsAt).toLocaleString(localeTag(), { hour12: false }) }));
    toast(t("m.claimOk", { name: p.accountName, plan: planDisplayName(p.planName) }), "ok", bits.join(t("common.listSep")));
  }
  if (p.accountId) {
    loadAcctQuota(p.accountId);
    if (!autoClaimRunning) {
      loadClaimPreview(p.accountId).then(() => { if (!uiLocked()) render(); });
    }
    scheduleNext(p.accountId);
  }
});

listen("captcha://interactive", () => {
  if (!autoClaimRunning || !claimWaiter) return;
  const id = claimWaiter.accountId;
  invoke("claim_cancel").catch(() => {});
  autoClaimCooldown[id] = Date.now() + 60 * 60 * 1000;
  saveClaimCooldown(); // 验证码停靠 1h 落盘：重启后不提前撞验证码
  toast(t("m.autoClaimInteractive", { name: accountName(id) }), "warn", t("m.autoClaimInteractiveDetail"));
  claimWaiter.finish({ ok: false, code: "interactive" });
});

listen("oauth://done", (ev) => {
  const p = ev.payload || {};
  if (p.ok === false) {
    if (p.soft) {
      toast(t("m.oauthSoft", { err: p.error || t("m.unknownErr") }), "warn", t("m.oauthSoftDetail"));
      return;
    }
    toast(t("m.oauthFail", { err: p.error || t("m.unknownErr") }), "err");
    return;
  }
  if (p.duplicate) {
    toast(t("m.oauthDup", { name: p.name }), "warn", t("m.oauthDupDetail"));
    return;
  }
  toast(t("m.oauthOk", { name: p.name }), "ok", t("m.oauthOkDetail"));
  refresh().then(() => { if (!uiLocked()) { render(); enrollAccounts(); } }).catch(() => {});
});

listen("state-changed", () => {
  refresh().then(() => { if (!uiLocked()) render(); }).catch(() => {});
});

// ===== 客户端日志信号（zsignals）：事件驱动 + 5s 兜底轮询 =====
// 后端 1s 一次跟随客户端日志，解析到新余额/计划状态/请求边界就推事件；没推到也能兜底拉起决策。
let signalsPoolsAt = 0;
let signalsModelAt = 0;
let signalsPlansAt = 0;
function applySignals(sig) {
  if (!sig || typeof sig !== "object") return false;
  liveSignals = sig;
  const at = Number(sig.pools_at_ms) || 0;
  const mAt = Number(sig.model_at_ms) || 0;
  // 余额载荷的 plans（已生效套餐）：plan_id 首现 = 新礼物到账/新一期开闸 → 实例登记触发级联
  const pAt = Number(sig.plans_at_ms) || 0;
  if (pAt !== signalsPlansAt) {
    signalsPlansAt = pAt;
    if (Array.isArray(sig.plans)) {
      notePlanInstances(sig.plans.map((p) => ({ planId: p.plan_id, name: p.name, status: p.status })));
    }
  }
  if (at === signalsPoolsAt && mAt === signalsModelAt) return false;
  signalsPoolsAt = at;
  signalsModelAt = mAt;
  return true;
}
async function pullSignals() {
  try {
    const changed = applySignals(await invoke("live_signals"));
    checkHotVerify();
    if (changed && state?.auto_switch) autoSwitchTick(false);
  } catch { /* 后端没有该命令（旧版）时静默回落到 HTTP 轮询 */ }
}
listen("zsignals", () => { pullSignals(); });

// 任何交互都重置「无操作」计时（滚动条拖动只发 scroll，所以 scroll 也要监听）
["wheel", "touchstart", "mousedown", "keydown"].forEach((ev) =>
  window.addEventListener(ev, () => { lastUserActionAt = Date.now(); }, { passive: true }));
document.addEventListener("scroll", () => { lastUserActionAt = Date.now(); }, { capture: true, passive: true });

const SWEEP_PERIOD = 5 * 60 * 1000;
// 活跃账号的周期由 scheduleNext 按「剩余时间(ETA) / 阈值」自适应（5s–15s，不加抖动）；
// 其余账号维持长周期长尾刷新
const SWEEP_JITTER = 0.2;
// 耗尽号（0 剩余/无套餐/全过期）的复查周期：无可消耗额度，长周期即可——
// 周礼/Global Build 发放后一次刷新就会回到正常轮换；领取由 autoClaim 独立负责（每分钟轮询，与此无关）
const SWEEP_PERIOD_DEAD = 90 * 60 * 1000;
const SWEEP_JITTER_DEAD = 0.33;
const SWEEP_CONCURRENCY = 4;   // 刷新并发上限
const SWEEP_PUMP_MS = 1200;    // 泵间隔：请求起点之间至少错开 1.2s（略微间隔防突发），并行压缩总时长
let sweepInFlight = 0;         // 当前在飞的刷新数（泵以此限流）
// 手动冻结：被冻结的账号单独分组，即使有额度也不会被自动切换选中
//（部分账号被风控标记后换 IP 也无法解除，用户手动停靠）。手动切换不受影响。
const FROZEN_KEY = "zsw-frozen-ids";
let frozenIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(FROZEN_KEY) || "[]")); }
  catch { return new Set(); }
})();
function saveFrozen() {
  try { localStorage.setItem(FROZEN_KEY, JSON.stringify([...frozenIds])); } catch { /* 忽略 */ }
}
function isFrozen(id) { return frozenIds.has(id); }
function toggleFrozen(id) {
  if (frozenIds.has(id)) frozenIds.delete(id); else frozenIds.add(id);
  saveFrozen();
}

// 归档：彻底停靠的账号——不自动刷新额度、不参与自动领取/级联/一键领取、不作为自动切换候选。
// 只保留手动刷新与手动领取（用户随时可以手动看一眼有没有新礼物）。比冻结更静：
// 冻结号仍随轮次刷新额度并参与领取探测（解冻证据需要），归档号完全不发起任何自动请求。
const ARCHIVED_KEY = "zsw-archived-ids";
let archivedIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(ARCHIVED_KEY) || "[]")); }
  catch { return new Set(); }
})();
function saveArchived() {
  try { localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...archivedIds])); } catch { /* 忽略 */ }
}
function isArchived(id) { return archivedIds.has(id); }
function toggleArchived(id) {
  if (archivedIds.has(id)) archivedIds.delete(id); else archivedIds.add(id);
  saveArchived();
}

// ---- 自动归档规则 ----
// 耗尽时长追踪（持久化）：账号进入「额度耗尽」的时刻，规则开启后从该时刻起算；
// 数据面恢复（重新拿到额度/待激活）即清除。规则关闭时不追踪，开启时以当下为起点。
const DEAD_SINCE_KEY = "zsw-dead-since-v1";
let deadSince = (() => {
  try { return JSON.parse(localStorage.getItem(DEAD_SINCE_KEY) || "{}"); }
  catch { return {}; }
})();
function saveDeadSince() {
  try { localStorage.setItem(DEAD_SINCE_KEY, JSON.stringify(deadSince)); } catch { /* 忽略 */ }
}
// 「确定无未来额度」口径（比健康度 dead 更严）：整号空（is_empty）或全部套餐已过期。
// 健康度的 dead 还包含「每日窗口当天用完」（pct<=0 但套餐未到期）——那类号跨午夜
// 就由服务端重置恢复，不能作为归档依据（否则 1 小时规则会在晚间误归档还有数天
// 有效期的号；多套餐场景同理：部分套餐到期、部分未到期 → 不是 dead 也不满足本口径）
const noFutureQuota = (id) => {
  const q = acctQuota[id];
  const data = q?.data;
  if (!data || q.busy || q.err) return false;
  if (data.is_empty === true) return true;
  const plans = data.plans || [];
  return plans.length > 0 && plans.every((p) => planExpired(p));
};
function autoArchiveTick() {
  const deadH = Number(state?.auto_archive_dead_hours ?? 0);
  const ageD = Number(state?.auto_archive_age_days ?? 0);
  const now = Date.now();
  let tracking = false;
  for (const a of state?.accounts || []) {
    if (isArchived(a.id)) { if (deadSince[a.id]) { delete deadSince[a.id]; tracking = true; } continue; }
    if (deadH <= 0) break; // deadSince 只为耗尽规则服务
    // 在用号与冻结号（手动=用户拍板、自动=风控停靠）不自动归档：语义都是可恢复的
    // 探测，不是退役；自动冻结号的出路由 b/c) 证据机与提交成功探测裁决。
    // 注意：冻结前积累的 deadSince 保留不清（上方只清归档号），c) 解冻后若 deadH
    // 已满，号会在当轮 autoArchiveTick 被归档——解冻即恢复归档射程
    if (a.is_active || isFrozen(a.id)) continue;
    // 新入库宽限（建号 48h 内）：套餐可能尚未发放或激活被拦——这是要「看见」的
    // 诊断态（新入库 tag），不是耗尽；这类号由建号超期规则兜底
    const createdTs = Date.parse(String(a.created_at || "").replace(" ", "T"));
    if (Number.isFinite(createdTs) && now - createdTs < CLAIM_NEW_MS) continue;
    if (noFutureQuota(a.id)) {
      if (!deadSince[a.id]) { deadSince[a.id] = now; tracking = true; }
    } else if (deadSince[a.id]) {
      // 只有拿到「有未来额度」的真实数据才清时钟：启动加载期/查询中的 unknown 态
      // 不算恢复（否则每次重启都会把耗尽时钟清零，24h 规则永远等不满）
      const q = acctQuota[a.id];
      if (q?.data && !q.busy && !q.err) { delete deadSince[a.id]; tracking = true; }
    }
  }
  if (tracking) saveDeadSince();
  if (deadH <= 0 && ageD <= 0) return;
  const hits = [];
  for (const a of state?.accounts || []) {
    if (isArchived(a.id) || a.is_active) continue;
    if (isFrozen(a.id)) continue;
    if (ageD > 0) {
      const created = Date.parse(String(a.created_at || "").replace(" ", "T"));
      if (isFinite(created) && now - created >= ageD * 86_400e3) { hits.push([a.id, "age"]); continue; }
    }
    if (deadH > 0 && deadSince[a.id] && now - deadSince[a.id] >= deadH * 3_600e3) {
      hits.push([a.id, "dead"]);
    }
  }
  if (!hits.length) return;
  for (const [id] of hits) archivedIds.add(id);
  saveArchived();
  const names = hits.map(([id]) => accountName(id)).slice(0, 3).join(t("common.listSep"));
  toast(t("m.autoArchivedToast", { n: hits.length }), "ok",
    t("m.autoArchivedDetail", { names }) + t("m.autoArchivedHint"));
  render();
}

// 额度状态持久化：重启不丢「上次已知额度/烧速样本」，启动按优先级补刷而不是全量同时打接口
const QUOTA_CACHE_KEY = "zsw-quota-cache-v1";
let quotaCacheDirty = false;
let quotaCacheLastFlush = 0;
function markQuotaCacheDirty() { quotaCacheDirty = true; }
function flushQuotaCache(force = false) {
  if (!quotaCacheDirty && !force) return;
  const now = Date.now();
  if (!force && now - quotaCacheLastFlush < 20 * 1000) return;
  quotaCacheLastFlush = now;
  quotaCacheDirty = false;
  try {
    const out = {};
    const snaps = {};
    for (const [id, q] of Object.entries(acctQuota)) {
      if (!q?.data || q.err) continue;
      out[id] = { t: quotaSampleAt[id] || now, data: q.data, hist: (quotaHist[id] || []).slice(-8) };
      // 后端快照只要 t+data（2API 配额感知选号消费），不拖 hist
      snaps[id] = { t: out[id].t, data: q.data };
    }
    localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(out));
    // 复用同一节流：推给后端原子落盘（quota-snapshots.json），2API 选号做配额感知
    // 排除用；失败静默——后端不在/旧版不该污染控制台，下次脏了再推
    if (Object.keys(snaps).length) {
      invoke("push_quota_snapshots", { snapshots: snaps }).catch(() => {});
    }
  } catch { /* 存储不可用则退化为无缓存（冷启动全量刷新） */ }
}
function loadQuotaCache() {
  try {
    const raw = localStorage.getItem(QUOTA_CACHE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const live = new Set((state?.accounts || []).map((a) => a.id));
    const now = Date.now();
    let n = 0;
    for (const [id, e] of Object.entries(parsed || {})) {
      if (!live.has(id) || !e?.data) continue;
      acctQuota[id] = { data: e.data, err: null, code: null, busy: false };
      quotaSampleAt[id] = Number(e.t) || now;
      if (Array.isArray(e.hist) && e.hist.length) quotaHist[id] = e.hist;
      n++;
    }
    return n;
  } catch { return 0; }
}
/** 启动种子：按优先级铺开首刷时间（活跃号立即 → 待定 → 有额度 → 耗尽号最晚），避免全量同时打接口 */
function seedStartupDue() {
  const now = Date.now();
  const hm = healthMapOf();
  const activeId = state?.active_account_id;
  const g = { first: [], pending: [], mid: [], dead: [] };
  for (const a of state?.accounts || []) {
    if (isArchived(a.id)) continue; // 归档号不进自动刷新铺排
    if (a.id === activeId) { g.first.push(a.id); continue; }
    const lv = hm.get(a.id)?.level || "unknown";
    if (lv === "dead") g.dead.push(a.id);
    else if (lv === "pending" || lv === "auth" || lv === "fail") g.pending.push(a.id);
    else g.mid.push(a.id);
  }
  const put = (ids, lo, hi) => ids.forEach((id) => { quotaDue[id] = now + lo + Math.random() * (hi - lo); });
  put(g.first, 0, 2000);
  put(g.pending, 5000, 30000);
  put(g.mid, 15000, 150000);              // 最近有额度的：前 2.5 分钟内错开铺开
  put(g.dead, 5 * 60000, 90 * 60000);     // 耗尽号：延续其 60-120 分钟节奏
}
const TICK_MS = 8000;
let quotaDue = {};

function scheduleNext(id, base = Date.now()) {
  // 归档号不排自动刷新（手动刷新照常，但刷完不自动续期）
  if (isArchived(id)) { quotaDue[id] = Infinity; return; }
  const h = healthMapOf().get(id);
  const isActive = state?.accounts?.some((a) => a.id === id && a.is_active);
  if (isActive) {
    const thr = Number(state?.auto_switch_threshold ?? 15);
    const pct = pctPairOf(id).pct ?? h?.remainingPct ?? null;
    const lg = logStats();
    const eta = lg?.etaSec ?? apiEta(id);
    let period;
    // 有日志信号时 API 只做兵底：日志已经是秒级，再高频打接口只会把接口挤慢、招风控
    // （实测：客户端自己的 billing 调用从 81ms 涨到 642ms，机器已处于被限流状态）
    if (lg) period = eta != null && eta <= 300 ? 30 * 1000 : 60 * 1000;
    else if (h?.level === "dead") period = 30 * 1000;             // 判死：靠领取/到期定点刷新翻状态
    else if (eta != null && eta <= 180) period = 6 * 1000;          // 预测式：3 分钟内烧完
    else if (eta != null && eta <= 600) period = 10 * 1000;
    else if (pct != null && pct <= thr) period = 6 * 1000;
    else if (pct != null && pct <= thr * 2) period = 10 * 1000;
    else period = 15 * 1000;
    activeSweepMs = period;
    quotaDue[id] = base + period;   // 活跃账号不加抖动：响应要可预期
    return;
  }
  // 待激活（成功但空）：心跳补发后服务端可能马上就发套餐，90s 复查一次即可
  if (h?.level === "pending") {
    quotaDue[id] = base + 90 * 1000;
    return;
  }
  // 耗尽号：大幅拉长复查周期（60-120 分钟）——几十个死号按 5 分钟刷是纯风控负担；
  // 新礼物（周礼/Global Build）发放后下一次刷新即恢复 normal 轮换。
  // 自动冻结的耗尽号因冻结叠加 level=frozen、落入下方 5min 档——那是 b/c) 解冻
  // 证据机的数据源，有意为之；正常耗尽（含手动冻结的）保持本 90min 节奏
  if (h?.level === "dead") {
    const j = 1 + (Math.random() * 2 - 1) * SWEEP_JITTER_DEAD;
    quotaDue[id] = base + Math.round(SWEEP_PERIOD_DEAD * j);
    return;
  }
  const jitter = 1 + (Math.random() * 2 - 1) * SWEEP_JITTER;
  quotaDue[id] = base + Math.round(SWEEP_PERIOD * jitter);
}
function enrollAccounts() {
  const live = new Set((state?.accounts || []).map((a) => a.id));
  for (const id of live) if (!(id in quotaDue)) quotaDue[id] = Date.now();
  for (const id of Object.keys(quotaDue)) if (!live.has(id)) delete quotaDue[id];
}
function pokeAccount(id) { if (id) quotaDue[id] = Date.now(); }

/** 「关注模型」与「全部池」两个口径的合并：返回用于判定的 pct、聚合剩余 token、是否已流转。
 *  tokens 与 pct 同口径：命中关注模型 → 该模型全部池剩余合计；未命中 → 全部池合计。
 *  跨账号比较用它当绝对量纲（百分比在「最宽池大小不同」的账号之间不可比）。
 *  gf=礼物优先：礼物池还有剩余时，pct/token/礼物细分都取礼物侧口径——
 *  当前号礼物见底要提前切（而不是被常规池的 100% 掩盖），候选优先选还有礼物的号。 */
function pctPair(focus, all, gf = false) {
  const fPct = focus?.matched ? focus.bestPct : null;
  const aPct = all?.bestPct ?? null;
  const flowed = !!(focus?.matched && (fPct ?? 0) <= 0 && (aPct ?? 0) > 0);
  let pct = fPct != null && fPct > 0 ? fPct : aPct;
  let tokens = focus?.matched
    ? (focus.totalTokens ?? null)
    : (all?.totalTokens ?? focus?.totalTokens ?? null);
  let giftBasis = false;
  let giftKinds = [];
  let giftExpireMs = null;
  let thrScale = 1;
  if (gf) {
    const b = giftFirstBasis(focus?.matched ? focus : (all ?? focus));
    if (b) {
      giftBasis = b.basis === "gift";
      giftKinds = b.giftKinds ?? [];
      giftExpireMs = b.giftExpireMs ?? null;
      thrScale = b.thrScale ?? 1;
      if (b.pct != null) pct = b.pct;
      if (b.tokens != null) tokens = b.tokens;
    }
  }
  return { pct, flowed, tokens, giftBasis, giftKinds, giftExpireMs, thrScale };
}
/** 某账号的判定口径（API） */
function pctPairOf(id, model = effectiveFocusModel(), gf = giftFirstOn()) {
  const q = acctQuota[id];
  return pctPair(poolStats(q, model), poolStats(q, ""), gf);
}
/** 礼物优先开关（设置里「优先消耗礼物套餐」，默认开启） */
function giftFirstOn() {
  return !!state?.auto_switch_gift_first;
}
/** 礼物消耗顺序：auto=临期优先 / weekend / global */
function giftOrderPref() {
  const v = String(state?.auto_switch_gift_order || "auto");
  return v === "weekend" || v === "global" ? v : "auto";
}
/** 数据过期 → 让 sweep 下一 tick 立刻重拉（节流，避免风控） */
function forceRefresh(id) {
  const now = Date.now();
  if (now - (quotaForceAt[id] || 0) < 10 * 1000) return;
  quotaForceAt[id] = now;
  // 重活窗口（全库刷新/领取）里 sweepTick 是停用的，poke 出去没人执行；先记账，窗口结束补一轮
  if (heavyWindow()) {
    staleWant.add(id);
    return;
  }
  quotaDue[id] = now;
  asAuditPush("refresh", { id, reason: "stale" });
}
/** 大规模压额度/资格接口的窗口。注意：autoClaim/claimAll 用的是领取接口而非额度接口，
 *  且 autoClaim 的循环几乎常驻——把它们算进来会让重活窗口≈永远为真，
 *  直接饿死切换的预校验（09-25 实测 43 次 preflight-fail 全部 tried=0） */
function heavyWindow() {
  return !!quotaSweep.running;
}
/** 把重活窗口里记下的「待补刷」账号排进去（限量，避免窗口一结束就一次冲 50 个） */
function drainStaleWant(max = 3) {
  if (!staleWant.size) return 0;
  let n = 0;
  for (const id of [...staleWant]) {
    if (n >= max) break;
    staleWant.delete(id);
    quotaDue[id] = Date.now();
    n++;
  }
  if (n) asAuditPush("refresh-queued", { n, left: staleWant.size });
  return n;
}
function noteForDecision(d) {
  const eta = d.etaSec != null ? fmtEta(d.etaSec) : null;
  let note = "";
  switch (d.reason) {
    case "stale": note = t("as.noteStale"); break;
    case "staleSafe": note = t("as.noteStaleSafe"); break;
    case "noData": note = t("as.noteNoData"); break;
    case "cooldown": note = t("as.noteCooldown"); break;
    case "noCand": note = t("as.noteNoCand"); break;
    case "noImprove": note = t("as.noteNoImprove"); break;
    default: note = "";
  }
  if (eta && d.etaSec <= 1800) {
    const e = t("as.eta", { eta });
    note = note ? `${note} · ${e}` : e;
  }
  noteChanged(note);
}

/**
 * 低额度自动切换。
 *
 * 相比旧实现的关键差异：
 * 1) 双触发：剩余% ≤ 阈值（兜底）+ 剩余时间(ETA) ≤ 安全余量（预测式，能提前几分钟行动）；
 * 2) 数据新鲜度参与判定：陈旧样本不当真值，改为“先刷新”；
 * 3) 不再被“全库刷新 / 领取中”整段拦停——那些只影响能不能取新样本，不影响用最近可信样本做决策；
 * 4) 切换前对陈旧候选做预校验（本次刷新失败 = 不可用）；无达标候选时降级切“还有额度的最好账号”；
 * 5) 审计：事件原因/目标/耗时落环 + 后端日志，调参不再凭感觉；
 * 6) 硬故障：额度查询连续失败且样本陈旧（无套餐 500 / token 失效）按 hardDown 硬信号处理，
 *    不再无限停在「先刷新」——那是礼物批量到期日「切不动/切进死号」的根源。
 */
async function autoSwitchTick(manual = false) {
  const s = state;
  // 返回值 = tick 是否真正起跑。false 只出现在瞬态守卫（切换锁/在飞切换/守卫忙碌）
  // 或自动切换已关闭——前者是「冻结当前号立即切」这类手动意图需要重试的信号
  if (!s?.auto_switch || switchLock || autoSwitchRunning || busy) return false;
  if (!(s.accounts || []).length) return true;
  const active = activeAccount();
  if (!active) return true;
  const thr = Number(s.auto_switch_threshold ?? 15);
  const model = effectiveFocusModel();
  const now = Date.now();

  // 当前账号：优先客户端日志（秒级），但与 HTTP 样本比「谁更新用谁」
  // —— 日志虽然普遍更早（活跃时 p50 15s），但忙时也可能 1-2 分钟才一条，那时 HTTP 快车道反而更新
  const gf = giftFirstOn();
  const apFocus = poolStats(acctQuota[active.id], model);
  const apAll = poolStats(acctQuota[active.id], "");
  const ap = pctPair(apFocus, apAll, gf);
  const sampleAt = quotaSampleAt[active.id] || 0;
  const ageMs = sampleAt ? now - sampleAt : Infinity;
  const lgStrict = logStats();                       // 已按新鲜窗口过滤
  const lgAgeMs = poolsAgeMs();
  let useLog = !!lgStrict;
  if (useLog && ageMs < lgAgeMs - 30 * 1000) useLog = false;         // HTTP 明显更新 → 用 HTTP
  if (!useLog && lgStrict && ageMs > AS_DEFAULTS.activeStaleMs) useLog = true; // HTTP 已过期 → 仍用日志
  const lg = useLog ? lgStrict : null;
  const sampleSrc = lg ? "log" : "api";
  const hm = healthMapOf();
  let cur;
  if (lg) {
    // 礼物优先：判定基准取礼物池（还有礼物时按礼物的 pct/token/ETA 判，
    // 不被常规池的满血掩盖）；礼物耗尽自动回落常规口径
    const b = gf ? giftFirstBasis(lg) : null;
    const curPct = b && b.pct != null ? b.pct : lg.bestPct;
    cur = {
      pct: curPct, etaSec: lg.etaSec, level: levelOf(curPct, thr),
      tokens: b && b.tokens != null ? b.tokens : (lg.totalTokens ?? null),
      thr: thr * (b?.thrScale ?? 1),
      ageMs: Math.max(0, now - (lg.at || now)), stale: false,
      planUnavailable: !!lg.planUnavailable, source: sampleSrc,
    };
  } else {
    // 硬信号二选一即视为「当前号确定不可用」：
    // a) 额度查询连续失败（≥2 次）且样本陈旧——无套餐 500 / token 失效 / 持续风控，数据永远刷不新；
    // b) 刷新成功但数据面判死（is_empty「业务成功但空」/ 套餐全部过期）——此时 pct 必然为空，
    //    否则只会落进 wait noData 死寂，永远不切（这正是礼物批量到期后的形态）。
    const dataDead = hm.get(active.id)?.level === "dead";
    const hardDown = dataDead
      || (ageMs > AS_DEFAULTS.activeStaleMs && (quotaFailStreak[active.id] || 0) >= 2);
    cur = {
      pct: ap.pct, etaSec: apiEta(active.id), level: levelOf(ap.pct, thr),
      tokens: ap.tokens ?? null,
      thr: thr * (ap.thrScale ?? 1),
      ageMs, stale: ageMs > AS_DEFAULTS.activeStaleMs, source: sampleSrc, hardDown,
    };
  }
  if (!lg && ap.flowed) cur.flowed = true;

  // 在用账号被手动冻结/归档：用户明确要求切走 → 按硬故障处理，
  // 旧额度/烧速作废，立即切到最佳非停靠候选（manual 绕过冷却与保护窗）
  if (isFrozen(active.id) || isArchived(active.id)) {
    cur.hardDown = true;
    cur.pct = null;
    cur.tokens = null;
  }

  // 候选：其它账号（关注模型口径优先，流转账号只能做兜底）
  pruneRecentFrom();
  const cands = [];
  for (const a of s.accounts) {
    if (a.id === active.id) continue;
    const h = hm.get(a.id);
    if (h && (h.level === "auth" || h.level === "fail")) continue;
    // 手动冻结/归档的账号绝不作为自动切换目标（即使有额度）；手动切换不受影响
    if (isFrozen(a.id) || isArchived(a.id)) continue;
    // 最近一次额度查询失败（业务码500无套餐/鉴权/限流）：旧数据不得作为切换依据，
    // 否则会顶着过期前缓存的高百分比被选中/通过预校验；等下次成功拉到数据再回池
    if (acctQuota[a.id]?.err) continue;
    const pair = pctPairOf(a.id, model);
    if (pair.pct == null) continue;
    const cs = quotaSampleAt[a.id] || 0;
    cands.push({
      id: a.id, name: a.name, pct: pair.pct, tokens: pair.tokens ?? null, flowed: pair.flowed,
      level: h?.level || "unknown",
      // gift = 判定基准是礼物池（还留着礼物额度）→ 排序插队；礼物顺序按设置（auto=临期优先）
      gift: pair.giftBasis,
      giftKinds: pair.giftKinds ?? [],
      giftExpireMs: pair.giftExpireMs ?? null,
      // 礼物口径的规模折算阈值（常规口径 = 全局阈值）
      thr: thr * (pair.thrScale ?? 1),
      fallback: pair.flowed, modelMatched: !!h?.modelMatched,
      ageMs: cs ? now - cs : Infinity,
    });
  }
  // 当前账号“已流转”（关注模型全场耗尽、只是靠其它模型顶着）时，只要还有账号留着关注模型额度，
  // 就把它当成已经耗尽来处理（立即切，不等百分比）——否则会在 5.3 上一直赖着
  const hasFocusCand = cands.some((c) => !c.flowed && c.pct >= (c.thr ?? thr));
  if (cur.flowed && hasFocusCand) cur = { ...cur, pct: 0, level: "dead" };

  const d = evaluate({
    now, active, cur, candidates: cands, lastSwitchAt: lastAutoSwitchAt, manual,
    opts: {
      ...AS_DEFAULTS,
      threshold: thr,
      marginSec: marginSec(),
      cooldownMs: AUTO_SWITCH_COOLDOWN_MS,
      giftOrder: gf ? giftOrderPref() : "auto",
      avoid: [...recentFrom.keys()],
    },
  });

  if (d.action === "none") {
    // 让“为什么不切”可见：关注模型全场耗尽、只是靠其它模型顶着，且没有更优目标
    if (cur.flowed && !hasFocusCand && cur.pct != null) {
      noteChanged(t("as.noteFlowed", { model: modelSignal() || model || "", pct: Math.round(cur.pct) }));
    } else {
      noteChanged("");
    }
    return true;
  }
  if (d.action === "refresh") { noteForDecision(d); forceRefresh(active.id); return true; }
  if (d.action === "wait") { noteForDecision(d); return true; }
  await doAutoSwitch(d, active, cur, lg);
  return true;
}

/** 手动意图的立即切换（冻结/归档在用账号 = 明确要求切走）：tick 被瞬态守卫吞掉时
 *  短间隔重试（切换锁/在飞切换/守卫忙碌都会在秒级释放），最长 ~10s；
 *  意图取消（解冻/取消归档/关自动切换）即停。tick 真正起跑后由其自身决策收尾 */
function kickSwitchNow() {
  let tries = 0;
  const kick = () => {
    if (!state?.auto_switch) return;
    if (autoSwitchTick(true)) return;
    if (++tries <= 20) setTimeout(kick, 500);
  };
  kick();
}

/** 执行切换：先对陈旧候选做预校验，再热切，最后记审计 */
async function doAutoSwitch(d, active, cur, lg) {
  const s = state;
  const thr = Number(s.auto_switch_threshold ?? 15);
  const started = Date.now();
  const heavy = heavyWindow();
  // 重活窗口（全库刷新/领取）里不额外发预校验请求；同样不拿超过 5 分钟的旧数据冒险
  const ageLimit = heavy ? 5 * 60 * 1000 : AS_DEFAULTS.targetFreshMs;
  switchLock = true;                 // 从预校验开始上锁（见 switchLock 定义）
  try {
    let target = null;
    let preflights = 0;
    for (const c of d.ranked || []) {
      // 切换瞬间的硬闸：候选评估与真正切换之间隔着预校验（秒级），期间用户冻结/
      // 归档了该号就必须跳过——「停靠的号绝不接收自动切换」不依赖评估时刻的快照
      if (isFrozen(c.id) || isArchived(c.id)) {
        asAuditPush("skip-parked", { id: c.id, reason: isFrozen(c.id) ? "frozen" : "archived" });
        continue;
      }
      if (c.ageMs > ageLimit) {
        // 重活窗口也保底 1 次预校验（只够榜首）：彻底禁用会让切换在窗口期完全饿死
        if (preflights >= (heavy ? 1 : AS_DEFAULTS.maxPreflight)) continue;
        preflights++;
        await loadAcctQuota(c.id, { force: true, quick: true });
        // 本次刷新仍失败（网络/风控/业务码500无套餐）→ 该候选视为不可用。
        // 必须先查 err 再读数：失败路径会保留旧数据，直接读 pct 等于拿过期前的
        // 高百分比给死号放行（礼物批量到期日就是这么切进死号的）
        if (acctQuota[c.id]?.err) continue;
        const fresh = pctPairOf(c.id);
        // 刷不到（网络/风控/无数据）→ 该候选视为不可用，绝不拿旧数据当依据切过去
        c.pct = fresh.pct;
        c.flowed = fresh.flowed;
        c.tokens = fresh.tokens ?? null;
        c.thr = thr * (fresh.thrScale ?? 1);
        c.ageMs = 0;
        if (c.pct == null) continue;
      }
      const cThr = c.thr != null && isFinite(c.thr) ? c.thr : thr;
      const okPct = d.degrade ? c.pct > 0 : c.pct >= cThr;
      // 与 evaluate 同口径：双方 token 可比按绝对余量比，否则按百分比；
      // hardDown 时当前号的旧百分比/旧 token 一律作废（基准视为耗尽）
      const curTokens = d.reason === "hardDown" ? null : (cur.tokens ?? null);
      const comparable = curTokens != null && c.tokens != null && isFinite(c.tokens);
      const better = cur.pct == null || d.reason === "hardDown"
        || (comparable ? c.tokens > curTokens : c.pct > cur.pct);
      if (okPct && better) { target = c; break; }
    }
    if (!target) {
      asAuditPush("preflight-fail", { from: active.id, tried: preflights, want: d.ranked?.length || 0 });
      noteChanged(t("as.noteCandStale"));
      return;
    }
    if (s.zcode_running && !s.hot_switch) {
      noteChanged(t("as.needHot"));
      if (Date.now() - lastHotWarnAt > 10 * 60 * 1000) {
        lastHotWarnAt = Date.now();
        toast(t("as.needHotToast"), "warn", t("as.needHotDesc"));
        asAuditPush("blocked-need-hot", { from: active.id, to: target.id });
      }
      return;
    }
    const best = target;
    autoSwitchRunning = true;
    if (!isTyping()) render();
    try {
      const r = await invoke("switch_to", { id: best.id, force: false, restart: s.launch_after_switch });
      lastAutoSwitchAt = Date.now();
      recentFrom.set(active.id, Date.now());
      ui.expanded.delete(best.id);
      // 落地复核：极端竞态下（切换在飞时该号被冻结/归档）立即再切走，不停靠在用户拍板的号上
      if (isFrozen(best.id) || isArchived(best.id)) {
        asAuditPush("switch-parked-undo", { to: best.id });
        setTimeout(() => kickSwitchNow(), 300);
      }
      const bits = [];
      if (r?.hot) bits.push(t("m.bitHot"));
      if (r?.launched) bits.push(t("m.bitLaunched"));
      if (r?.preserved_as) bits.push(t("m.bitPreserved", { name: r.preserved_as }));
      // hardDown 下 cur.pct 是过期前的旧值，展示为「额度未知」而不是拿谎言凑数
      const pctShown = d.reason === "hardDown" ? null : cur.pct;
      const pct = pctShown == null ? "?" : Math.round(pctShown);
      const head = d.degrade
        ? t("as.toastDegrade", { from: active.name, to: r?.name || best.name, pct })
        : t("as.toast", { from: active.name, to: r?.name || best.name, pct });
      toast(head, "ok", bits.join(t("common.listSep")));
      asAuditPush("switch", {
        from: active.id, to: best.id, reason: d.reason, degrade: !!d.degrade,
        pct: pctShown == null ? null : Math.round(pctShown * 10) / 10,
        curTokens: cur.tokens ?? null, toTokens: best.tokens ?? null,
        etaSec: d.etaSec == null ? null : Math.round(d.etaSec),
        src: lg ? "log" : "api", hot: !!r?.hot, preflight: preflights, ms: Date.now() - started,
      });
      await refresh();
      pokeAccount(best.id);
      armClaimCheck(best.id); // 自动切换同样触发新当前账号的领取检查（T0 优先）
      if (r?.hot) { scheduleHotFollowUp(best.id); noteHotSwitch(); }
    } catch (e) {
      // 失败也计一次冷却：只当“抑制器”（否则 ETA 触发会每轮重试），不阻塞后续成功路径
      lastAutoSwitchAt = Date.now();
      toast(t("as.fail", { err: stripErr(e) }), "warn");
      asAuditPush("switch-fail", { from: active.id, to: best.id, err: stripErr(e), ms: Date.now() - started });
    }
  } finally {
    autoSwitchRunning = false;
    switchLock = false;
    if (!uiLocked()) render();
  }
}

// 套餐有效期定点刷新：有效期刚跨过的账号立刻刷一次（跨过时刻的 10 分钟窗口内，按有效期时间戳去重）
const expiryRefreshDone = new Map();
function expiryRefreshTick() {
  const now = Date.now();
  for (const a of state?.accounts || []) {
    if (acctQuota[a.id]?.busy || isArchived(a.id)) continue;
    for (const p of acctQuota[a.id]?.data?.plans || []) {
      const txt = String(p.expire || "");
      if (!txt) continue;
      const hasTime = txt.length >= 16;
      const ms = new Date(hasTime ? txt.replace(" ", "T") : txt + "T23:59:59").getTime();
      if (!isFinite(ms) || ms > now || now - ms > 10 * 60000) continue;
      if (expiryRefreshDone.get(a.id) === ms) continue;
      expiryRefreshDone.set(a.id, ms);
      quotaDue[a.id] = now;
      break;
    }
  }
}

/** 刷新泵：并发上限 SWEEP_CONCURRENCY，每 SWEEP_PUMP_MS 最多起一个请求——
 *  起点天然错开（略微间隔防突发），并行在飞压短 70+ 账号整库扫描的总时长 */
function pumpSweep() {
  if (quotaSweep.running) return;
  if (sweepInFlight >= SWEEP_CONCURRENCY) return;
  const now = Date.now();
  const due = (state?.accounts || []).filter(
    (a) => (quotaDue[a.id] ?? Infinity) <= now && !acctQuota[a.id]?.busy && !claimable[a.id]?.busy && !isArchived(a.id),
  );
  if (!due.length) return;
  due.sort((x, y) => (quotaDue[x.id] ?? 0) - (quotaDue[y.id] ?? 0));
  // 在用账号永远最优先（决定“要不要切”的判定数据就是它）
  const activeIdx = due.findIndex((a) => a.is_active);
  const acc = activeIdx >= 0 ? due[activeIdx] : due[0];
  const id = acc.id;
  const dueAt = quotaDue[id];
  sweepInFlight++;
  loadAcctQuota(id, { quick: true }).finally(() => {
    sweepInFlight--;
    // 手动刷新/紧急需求可能在拉取期间又 poke 过：仅当 due 没被别人动过才按周期重排
    if (quotaDue[id] === dueAt) scheduleNext(id);
    flushQuotaCache();
  });
  // 刷新后即时切换：loadAcctQuota 每次成功拉到数据都会自己跑一次判定（见其内部）
}
async function sweepTick() {
  if (quotaSweep.running) return;
  enrollAccounts();
  expiryRefreshTick();
  drainStaleWant();
  pumpSweep();
}

(async () => {
  try {
    appVer = await invoke("app_version").catch(() => "");
    await refresh();
    // 启动恢复：读入上次会话的「已知额度/烧速样本」（在首帧渲染前，避免闪「待查询额度」），
    // 再按优先级铺开首刷——活跃号立即、有额度号前 2.5 分钟错开、耗尽号延续 60-120 分钟节奏
    // （不停刷：礼物发放时刻并不固定）。冷启动无缓存才退回旧的全量刷新
    const seeded = loadQuotaCache();
    enrollAccounts();
    if (seeded > 0) seedStartupDue();
    // 缓存里以「成功但空」收尾的账号：套餐可见性抖动的受害者（billing/balance 间歇
    // 返回空快照，等一次激活心跳才恢复）。启动即补非 quick 验证（后端会补心跳 +
    // 2.5s 重查），不等 dead 分组 5-90 分钟的首刷——这就是「重启后要手动刷新才恢复」的根因
    let flapVerifyIdx = 0;
    for (const [id, q] of Object.entries(acctQuota)) {
      if (q?.data?.is_empty === true) {
        setTimeout(() => { loadAcctQuota(id, { force: true }).finally(() => scheduleNext(id)); }, 3000 + flapVerifyIdx * 2500);
        flapVerifyIdx++;
      }
    }
    render();
    await invoke("reveal_main");
    setTimeout(dismissSplash, 350);
    sweepTick();
    setInterval(pumpSweep, SWEEP_PUMP_MS);
    setInterval(autoLocateTick, 2000);
    if (seeded === 0) {
      // 冷启动：没有任何缓存可恢复，全量刷一遍建立基线（健康度/筛选/排序都依赖它）
      setTimeout(() => { if (!quotaSweep.running) actions.refreshAll(true); }, 900);
    }
    setInterval(() => {
      Promise.all([
        invoke("get_state"),
        invoke("two_api_status").catch(() => null),
        invoke("live_signals").catch(() => null),
      ]).then(([s, st, sig]) => {
        state = s;
        if (s?.language) init(s.language);
        enrollAccounts();
        if (st?.usage) twoUsageMap = new Map(Object.entries(st.usage));
        // 兜底：即使事件丢了，也能用 5s 轮询发现新余额并立即判定（纯本地状态读取，不耗风控）
        const sigChanged = applySignals(sig);
        checkHotVerify();
        if (sigChanged && s?.auto_switch) autoSwitchTick(false);
        if (!uiLocked()) render();
      }).catch(() => {});
    }, 5000);
    setInterval(sweepTick, TICK_MS);
    setInterval(autoArchiveTick, 60 * 1000);
    setInterval(() => flushQuotaCache(), 30 * 1000);
    window.addEventListener("pagehide", () => flushQuotaCache(true));
    window.addEventListener("beforeunload", () => flushQuotaCache(true));
    setInterval(autoSwitchTick, AUTO_SWITCH_CHECK_MS);
    setTimeout(autoClaimTick, AUTO_CLAIM_FIRST_DELAY_MS);
    // 周期兜底：新号入库/活动发放后最迟 1 分钟进入领取；
    // 全部账号都在冷却中时空转（零请求）
    setInterval(autoClaimTick, AUTO_CLAIM_TICK_MS);
  } catch (e) {
    $app.innerHTML = `<div class="loading" style="color:var(--red)">${t("common.loadFail", { e: esc(stripErr(e)) })}</div>`;
    invoke("reveal_main").catch(() => {});
    dismissSplash();
  }
})();
