import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, toast, openPwModal, openConfirmModal, openProviderModal, installDelegation, dismissSplash } from "./ui.js";
import { ic } from "./icons.js";
import { init, t, has, lang, localeTag, stripErr, errCode } from "./i18n.js";
import { HEALTH_ORDER, healthOf, filterAccounts, sortAccounts, bucketAccounts, summarize, modelKeyMatch, quotaBarParts } from "./list.js";

const $app = document.getElementById("app");
let state = null;
let renaming = null;
let busy = false;
let appVer = "";
let acctQuota = {};
let claimable = {};
let claimAllRunning = false;
let claimAllState = { running: false, done: 0, total: 0 };
const REFRESH_CLAIM_COOLDOWN_MS = 60_000;
let refreshClaim = { running: false, done: 0, total: 0, cooldownUntil: 0 };
let refreshTicker = null;

const AUTO_CLAIM_INTERVAL_MS = 10 * 60 * 1000;
// 干净收尾（本轮无可领礼物）后的重查间隔：礼物品只在新号入库/活动发放时出现，
// 无需高频轮询；新号入库会主动清冷却触发领取
const AUTO_CLAIM_RECHECK_MS = 30 * 60 * 1000;
const AUTO_CLAIM_TICK_MS = 60 * 1000;
const AUTO_CLAIM_FIRST_DELAY_MS = 2 * 60 * 1000;
const AUTO_CLAIM_WAIT_MS = 45_000;
const AUTO_CLAIM_PER_ACCOUNT_CAP = 5;
const AUTO_CLAIM_ACCT_GAP_MS = 5_000;
const AUTO_ABORT_WAIT_MS = 90_000;
let autoClaimRunning = false;
let autoClaimCooldown = {};
let autoAbortRequested = false;
let claimActive = false;
let lastAutoRound = null;
let autoToggleBusy = false;

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
  hideInfo: savedPrefs.hideInfo === true,
  qhOpen: false,
  qhTab: "",
  modelCustom: false,
  selected: new Set(),
  expanded: new Set(),
  collapsedSections: new Set(),
};

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

// 紧凑行展开后，鼠标离开且无交互超过该时长自动收起（悬停期间暂停计时）
const EXPAND_AUTO_COLLAPSE_MS = 8000;
const expandAt = new Map();function expandTouch(id) {
  if (ui.expanded.has(id)) expandAt.set(id, Date.now());
}
function autoCollapseTick() {
  if (!ui.expanded.size) return;
  const now = Date.now();
  let changed = false;
  for (const id of [...ui.expanded]) {
    const el = $app.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (el && el.matches(":hover")) { expandAt.set(id, now); continue; }
    if (now - (expandAt.get(id) || 0) >= EXPAND_AUTO_COLLAPSE_MS) {
      ui.expanded.delete(id);
      expandAt.delete(id);
      changed = true;
    }
  }
  if (changed) render();
}

let quotaSweep = { running: false, phase: "quota", eligibility: false, done: 0, total: 0, cancel: false };
// 领取资格刷新很重，节流到至少 10 分钟一次，避免触发风控
const ELIGIBILITY_MIN_GAP_MS = 10 * 60 * 1000;
let lastEligibilityAt = 0;
function canRefreshEligibility() {
  return Date.now() - lastEligibilityAt >= ELIGIBILITY_MIN_GAP_MS
    && !refreshClaim.running && !claimAllRunning && !autoClaimRunning && !claimActive;
}
// 顶部「刷新」按钮当前应显示的提示（资格阶段 / 额度阶段）
function refreshAllTitle() {
  if (!quotaSweep.running) return t("btn.refreshAllTitle");
  if (quotaSweep.phase === "elig") return t("btn.refreshAllRunningElig", { done: refreshClaim.done, total: refreshClaim.total });
  return t("btn.refreshAllRunning", { done: quotaSweep.done, total: quotaSweep.total });
}
function refreshAllBadge() {
  if (!quotaSweep.running) return "";
  const n = quotaSweep.phase === "elig" ? refreshClaim.done : quotaSweep.done;
  return n > 0 ? `<span class="tb-badge">${n}</span>` : "";
}

// 低额度自动切换
const AUTO_SWITCH_CHECK_MS = 60 * 1000;
const AUTO_SWITCH_COOLDOWN_MS = 5 * 60 * 1000;
let autoSwitchRunning = false;
let lastAutoSwitchAt = 0;
let autoSwitchNote = "";

function autoSwitchTitle(s) {
  const bits = [t("as.label"), t("as.threshold", { pct: s?.auto_switch_threshold ?? 10 })];
  const m = String(s?.auto_switch_model || "").trim();
  if (m) bits.push(t("as.model", { model: m }));
  if (autoSwitchRunning) bits.push(t("as.switching"));
  else if (autoSwitchNote) bits.push(autoSwitchNote);
  if (s?.zcode_running && !s?.hot_switch) bits.push(t("as.needHot"));
  return esc(bits.join(" · "));
}

function savePrefs() {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ sort: ui.sort, sortDir: ui.sortDir, density: ui.density, hideInfo: ui.hideInfo }));
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
      for (const it of p.items || []) {
        if (it.name && modelKeyMatch(it.name.toLowerCase(), key)) sum += Number(it.remaining ?? 0);
      }
    }
    return sum;
  }
  let sum = 0;
  for (const p of plans) {
    if (p.gift !== true) continue;
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
    threshold: Number(state?.auto_switch_threshold ?? 10),
  };
  const map = new Map();
  for (const a of state?.accounts || []) map.set(a.id, healthOf(a, acctQuota[a.id], isAuthErr, model, opts));
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
        <input class="auto-switch-thr" type="number" min="1" max="90" step="1" value="${state?.auto_switch_threshold ?? 10}" change="actions.stSetThreshold(event)">
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
    <div class="tog-row">
      <div class="tog-info"><div class="tog-label">${t("st.modelFallback")}</div><div class="tog-desc">${t("st.modelFallbackDesc")}</div></div>
      <button class="toggle${state?.auto_switch_model_fallback ? " on" : ""}" role="switch" aria-checked="${!!state?.auto_switch_model_fallback}" aria-label="${esc(t("st.modelFallback"))}" click="actions.stToggle('modelFallback')"><span class="knob"></span></button>
    </div>
    <div class="st-note">${models.length ? t("st.modelDesc", { n: models.length }) : t("st.modelNone")}</div>
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

      <div class="st-sec">${t("st.secBehavior")}</div>
      ${stToggle("autostart", t("s.autostart"), t("s.autostartDesc"), !!autostartOn)}
      ${stToggle("launch", t("s.launchAfter"), t("s.launchAfterDesc"), !!s.launch_after_switch)}
      ${stToggle("tray", t("s.closeTray"), t("s.closeTrayDesc"), !!s.close_to_tray)}
      ${stToggle("hot", t("s.hotSwitch"), t("s.hotSwitchDesc"), !!s.hot_switch)}
      ${stToggle("grouped", t("s.grouped"), t("s.groupedDesc"), s.grouped !== false)}

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
function visibleAccounts() {
  const hm = healthMapOf();
  const list = sortAccounts(
    filterAccounts(state?.accounts || [], { search: ui.search, health: ui.health }, hm),
    ui.sort, hm, localeTag(),
    { threshold: Number(state?.auto_switch_threshold ?? 10), dir: ui.sortDir, keyOf: (a) => sortKeyValue(a, ui.sort) },
  );
  return { list, hm };
}

/** 分组视图：自定义分组优先，未分组按"额度健康度"分桶 */
function groupedListHtml(accounts, rowHtml, healthMap) {
  const buckets = bucketAccounts(accounts, { localeTag: localeTag(), healthLabel }, healthMap);
  return buckets.map((b) => {
    const collapsed = ui.collapsedSections.has(b.key);
    return `
    <section class="grp-sec${collapsed ? " collapsed" : ""}" data-sec="${esc(b.key)}">
      <button class="grp-head" click="actions.toggleSection(event)" aria-expanded="${collapsed ? "false" : "true"}">
        <span class="grp-chev">${ic("chevDown", 13)}</span>
        <span class="grp-title">${esc(b.label)}</span>
        <span class="grp-num">${t("grp.count", { count: b.items.length })}</span>
      </button>
      ${collapsed ? "" : `<div class="grp-body">${b.items.map(rowHtml).join("")}</div>`}
    </section>`;
  }).join("");
}

function chipsHtml(sum) {
  // gift 是正交筛选维度（计数来自 hasGift），永远排在最前
  const levels = ["all", ...["gift", ...HEALTH_ORDER].filter((lv) => lv === ui.health || sum.counts[lv] > 0)];
  return `<div class="chips" role="group" aria-label="${esc(t("list.filterLabel"))}">` +
    levels.map((lv) => {
      const on = ui.health === lv;
      const n = lv === "all" ? (state?.accounts || []).length : sum.counts[lv];
      const label = lv === "all" ? t("list.filterAll") : healthLabel(lv);
      return `<button class="chip${lv === "all" ? "" : " " + lv}${on ? " on" : ""}" aria-pressed="${on}" click="actions.setHealth('${lv}')">${esc(label)}<span class="chip-n">${n}</span></button>`;
    }).join("") + `</div>`;
}

function summaryHtml(sum) {
  const avg = sum.avgRemainingPct == null ? "—" : Math.round(sum.avgRemainingPct) + "%";
  const m = focusModel();
  // 流转显示：活跃账号判定已流转到其它模型时，展示实际生效的模型
  const activeId = state?.active_account_id;
  const ah = activeId ? healthMapOf().get(activeId) : null;
  const eff = m && ah?.fallback && ah?.modelName ? ah.modelName : m;
  const base = t("list.summary", { n: (state?.accounts || []).length, avg });
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
    for (const p of q.data.plans || []) {
      for (const it of p.items || []) {
        if (itemKind(it) !== "raw") continue;
        const name = String(it.name || "?");
        const agg = per.get(name) || { name, remaining: 0, total: 0, sources: [] };
        agg.remaining += it.remaining ?? 0;
        agg.total += it.total ?? 0;
        agg.sources.push({ account: a.name, remaining: it.remaining ?? 0, total: it.total ?? 0 });
        per.set(name, agg);
      }
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
const MODEL_COLORS = ["#e8a33d", "#6aa9e0", "#b48be8", "#e08aa0", "#62c370"];
function modelColor(name) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return MODEL_COLORS[h % MODEL_COLORS.length];
}

function quotaPanelHtml(tot) {
  if (!ui.qhOpen || !tot) return "";
  // Tab 切换模型：账号多时不用滚动很久才能看到另一个模型
  const activeTab = tot.models.some((x) => x.name === ui.qhTab) ? ui.qhTab : (tot.focus?.name || tot.models[0]?.name || "");
  const tabs = tot.models.map((m) => {
    const on = m.name === activeTab;
    return `<button class="qhd-tab${on ? " on" : ""}" style="color:${modelColor(m.name)}" click="actions.setQhTab('${esc(m.name)}')">${esc(m.name)}</button>`;
  }).join("");
  let body = "";
  const x = tot.models.find((m) => m.name === activeTab);
  if (x) {
    // 面板百分比同样以“剩余”为基准（对齐官方），红段=已用、黄/绿段=剩余
    const pct = x.total > 0 ? Math.max(0, Math.min(100, Math.round((x.remaining / x.total) * 100))) : 0;
    const rows = x.sources.map((src) => {
      // 与行内额度条同一套语义：剩余绿（紧张红）锚左、已用黄从右往左生长
      const parts = quotaBarParts(src.total > 0 ? (1 - src.remaining / src.total) * 100 : null);
      const bar = parts.segs.map((s) => `<i style="width:${s.width}%;background:${BAR_SEG_COLOR[s.kind]}"></i>`).join("");
      return `<div class="qhd-row">
        <span class="qhd-acct" title="${esc(src.account)}">${esc(src.account)}</span>
        <span class="qhd-num">${esc(fmtTokens(src.remaining))}/${esc(fmtTokens(src.total))}</span>
        <span class="qhd-bar">${bar}</span>
        <span class="qhd-pct">${esc(parts.txt)}</span>
      </div>`;
    }).join("");
    body = `<div class="qhd-sec-head">
        <span class="qhd-model" style="color:${modelColor(x.name)}">${esc(x.name)}</span>
        <span class="qhd-sum">${esc(fmtTokens(x.remaining))}/${esc(fmtTokens(x.total))} · ${pct}%</span>
      </div>
      <div class="qhd-thead"><span>${t("list.qhColAcct")}</span><span>${t("list.qhColLeft")}</span><span></span><span>${t("list.qhColUsed")}</span></div>
      ${rows}`;
  } else {
    body = `<div class="qh-empty">${esc(t("list.qhEmpty"))}</div>`;
  }
  return `<div class="qh-panel" data-qh-pop>
    <div class="qh-head">
      <div>
        <div class="qh-title">${esc(t("list.qhBtn"))}</div>
        <div class="qh-sub">${esc(t("list.qhPopTitle", { n: tot.accounts }))}</div>
      </div>
      <button class="icon-btn sm qh-close" click="actions.toggleQhDetail()" aria-label="close">${ic("x", 14)}</button>
    </div>
    <div class="qhd-tabs">${tabs}</div>
    <div class="qhd-body" data-qh-scroll>${body}</div>
  </div>`;
}

function bulkBarHtml() {
  const n = selectedIds().length;
  if (!n) return "";
  return `<div class="bulk-bar">
    <span class="bulk-n">${esc(t("list.selected", { n }))}</span>
    <span class="lh-sp"></span>
    <button class="btn-ghost danger has-ic" click="actions.askBulkDelete()">${ic("x", 13)} ${t("list.bulkDelete")}</button>
    <button class="btn-ghost" click="actions.clearSelection()">${t("list.clearSel")}</button>
  </div>`;
}

function listHeadHtml(s, sum, visible) {
  const allOn = visible.length > 0 && visible.every((a) => ui.selected.has(a.id));
  const qt = quotaTotals();
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
          <button class="vs-opt${s.grouped ? "" : " on"}" aria-pressed="${!s.grouped}" click="actions.setGrouped(false)">${t("grp.flat")}</button>
          <button class="vs-opt${s.grouped ? " on" : ""}" aria-pressed="${!!s.grouped}" click="actions.setGrouped(true)">${t("grp.grouped")}</button>
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
        <div class="view-seg" role="group" aria-label="${esc(t("list.densityLabel"))}">
          <button class="vs-opt${ui.density === "compact" ? " on" : ""}" aria-pressed="${ui.density === "compact"}" click="actions.setDensity('compact')">${t("list.density.compact")}</button>
          <button class="vs-opt${ui.density === "detail" ? " on" : ""}" aria-pressed="${ui.density === "detail"}" click="actions.setDensity('detail')">${t("list.density.detail")}</button>
        </div>
      </div>
      ${bulkBarHtml()}
    </div>`;
}

async function refresh() {
  state = await invoke("get_state");
  if (state?.language) init(state.language);
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

async function loadAcctQuota(id) {
  const cur = acctQuota[id] || {};
  // busy 超时保护：一次请求异常卡住后，超过 20s 允许重新拉取，避免手动刷新永远静默失效
  if (cur.busy && Date.now() - (cur.busyAt || 0) < 20000) return;
  // 保留旧数据只标记 busy：健康度/分组在刷新期间不变，避免条目闪回“待查询额度”
  acctQuota[id] = { ...cur, busy: true, busyAt: Date.now() };
  if (!uiLocked()) render();
  try {
    const data = await invoke("get_account_quota", { id });
    acctQuota[id] = { data, err: null, code: null, busy: false };
  } catch (e) {
    // 失败时也保留旧数据展示，错误信息进明细区；没旧数据才回落到错误态
    acctQuota[id] = { data: cur.data || null, err: stripErr(e), code: errCode(e), busy: false };
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
      // 清冷却尽快进入自动领取，领完才有额度可查
      autoClaimCooldown[r.id] = 0;
      setTimeout(() => autoClaimTick(), 4000);
    });
  },

  async rename(id) {
    renaming = id; render();
    const input = document.querySelector(`.row[data-id="${id}"] .rename-input`);
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

  setSortDir() {
    ui.sortDir = ui.sortDir === -1 ? 1 : -1;
    savePrefs();
    render();
  },

  async setGrouped(on) {
    if (!!state?.grouped === !!on) return;
    await guard(async () => {
      await invoke("set_behavior", { grouped: on });
      await refresh(); render();
    });
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
    ui.health = (lv === "gift" || HEALTH_ORDER.includes(lv)) ? lv : "all";
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
    expandAt.clear();
    savePrefs();
    render();
  },

  toggleHideInfo() {
    ui.hideInfo = !ui.hideInfo;
    savePrefs();
    render();
  },

  toggleRow(ev) {
    const id = ev?.target?.closest?.(".row")?.dataset?.id;
    if (!id) return;
    if (ui.expanded.has(id)) {
      ui.expanded.delete(id);
      expandAt.delete(id);
    } else {
      ui.expanded.add(id);
      expandAt.set(id, Date.now());
    }
    render();
  },

  toggleSelect(id) {
    if (ui.selected.has(id)) ui.selected.delete(id);
    else ui.selected.add(id);
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

  /** 刷新额度（顺带按节流刷新领取资格）；再点一次 = 停止 */
  async refreshAll(quotaOnly) {
    if (quotaSweep.running) {
      quotaSweep.cancel = true;
      return;
    }
    const ids = (state?.accounts || []).map((a) => a.id);
    if (!ids.length) return;
    const withElig = !quotaOnly && canRefreshEligibility();
    if (withElig) lastEligibilityAt = Date.now();
    quotaSweep = { running: true, phase: withElig ? "elig" : "quota", eligibility: withElig, done: 0, total: ids.length, cancel: false };
    render();
    let cancelled = false;
    try {
      if (withElig) {
        await actions.refreshClaim();
        quotaSweep.phase = "quota";
      }
      for (const id of ids) {
        if (quotaSweep.cancel) { cancelled = true; break; }
        await loadAcctQuota(id);
        quotaSweep.done++;
        if (!isTyping()) render();
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      const done = quotaSweep.done;
      const elig = quotaSweep.eligibility;
      cancelled = cancelled || quotaSweep.cancel;
      quotaSweep = { running: false, phase: "quota", eligibility: false, done: 0, total: 0, cancel: false };
      if (cancelled) toast(t("list.toastSweepCancelled", { n: done }));
      else toast(elig ? t("list.toastRefreshAllBoth", { n: done }) : t("list.toastSweepDone", { n: done }));
      render();
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
      onYes: () => actions.doDelete(id),
    });
  },

  async doDelete(id) {
    await guard(async () => {
      await invoke("delete_account", { id });
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
      ui.expanded.delete(id);
      await refresh();
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
      }
      ui.expanded.delete(id);
      await refresh(); render();
      pokeAccount(id);
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
        openPwModal({ mode: "import", files: sealed, preErrors, onDone: (rep) => actions.stFinishImport(rep) });
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
      if (report.errors.length) parts.push(t("s.importFailed", { count: report.errors.length }));
      toast(parts[0], report.errors.length ? "err" : "ok", parts.slice(1).join(t("common.listSep")));
    }
    refresh().then(() => { render(); syncSettingsModal(); }).catch(() => {});
  },

  async openGitHub() {
    try { await invoke("open_external", { url: "https://github.com/pjpv/zcode-switch" }); }
    catch (e) { toast(stripErr(e), "err"); }
  },
  acctQuota(id) {
    const dueAt = quotaDue[id];
    loadAcctQuota(id).then(() => {
      if (quotaDue[id] === dueAt) scheduleNext(id);
      // 手动刷新的是当前账号且额度已低于阈值 → 立即尝试切换
      if (state?.auto_switch && state?.accounts?.some((a) => a.id === id && a.is_active)) {
        autoSwitchTick(true);
      }
    });
  },

  async copyApiKey(id) {
    try {
      const r = await invoke("account_api_key", { id });
      if (!r?.apiKey) { toast(t("list.apiKeyNone"), "warn"); return; }
      // 铸造失败 = 拿到的是 JWT 兜底，拿去 paas/v4 必 401：不复制，把原因亮出来
      if (r?.mintError) { toast(`${t("list.apiKeyMintFail")}\n${stripErr(r.mintError)}`, "err"); return; }
      if (await copyText(r.apiKey)) toast(`${t("list.apiKeyCopied")}（${r.label || "?"}）`);
      else toast(t("list.copyFail"), "err");
    } catch (e) { toast(stripErr(e), "err"); }
  },

  openTwoApi() { openTwoApiModal(); },

  /** 悬浮按钮：滚动定位到当前使用的账号 */
  locateActive() {
    const row = document.querySelector(".row.active");
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    // 当前账号被筛选/搜索过滤掉了：清空筛选再定位
    if (ui.search || ui.health !== "all") {
      ui.search = "";
      ui.health = "all";
      render(true);
      requestAnimationFrame(() => document.querySelector(".row.active")?.scrollIntoView({ behavior: "smooth", block: "center" }));
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
      await invoke("set_two_api", {
        on: !!state?.two_api_on,
        port: Number.isFinite(raw) && raw > 0 ? raw : 8117,
        account: state?.two_api_account || null,
        models: models || null,
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

  async claim(id) {
    if (claimActive || claimAllRunning || refreshClaim.running) { toast(t("m.claimBusy"), "warn"); return; }
    const plans = claimable[id]?.plans || [];
    const plan = plans[0];
    if (!plan) { toast(t("m.noClaimable"), "warn"); return; }
    claimActive = true;
    try {
      await invoke("claim_start", { id, planId: plan.plan_id });
      toast(t("m.claimVerify", { name: plan.name || plan.plan_id }), "ok", t("m.claimVerifyDetail"));
      const r = await waitForClaimResult(id);
      if (!r) toast(t("m.claimTimeout"), "warn");
      else pokeAccount(id);
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      claimActive = false;
    }
  },

  async claimAll() {
    const ids = (state?.accounts || [])
      .map((a) => a.id)
      .filter((id) => (claimable[id]?.plans || []).length > 0);
    if (!ids.length) { toast(t("m.noClaimableAccounts"), "warn"); return; }
    if (claimActive || claimAllRunning || refreshClaim.running) return;
    claimAllRunning = true;
    claimActive = true;
    claimAllState = { running: true, done: 0, total: ids.length };
    render();
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        claimAllState.done = i;
        if (!isTyping()) render();
        const plan = claimable[id].plans[0];
        const name = state.accounts.find((a) => a.id === id)?.name || id;
        try {
          await invoke("claim_start", { id, planId: plan.plan_id });
        } catch (e) {
          toast(t("m.claimAccountErr", { name, err: stripErr(e) }), "err");
          continue;
        }
        const r = await waitForClaimResult(id, 120000);
        if (!r) {
          toast(t("m.claimAcctTimeout", { name }), "warn");
          await invoke("claim_cancel").catch(() => {});
        } else pokeAccount(id);
        if (i < ids.length - 1) await new Promise((res) => setTimeout(res, 1200));
      }
    } finally {
      claimAllRunning = false;
      claimActive = false;
      claimAllState = { running: false, done: 0, total: 0 };
      render();
    }
  },

  async refreshClaim() {
    const ids = (state?.accounts || []).map((a) => a.id);
    if (!ids.length) return;
    const now = Date.now();
    if (refreshClaim.running || claimAllRunning || (claimActive && !autoClaimRunning)) return;
    if (now < refreshClaim.cooldownUntil) {
      toast(t("btn.refreshClaimCooldownTitle", { n: Math.ceil((refreshClaim.cooldownUntil - now) / 1000) }), "warn");
      return;
    }
    refreshClaim = { running: true, done: 0, total: ids.length, cooldownUntil: 0 };
    startRefreshTicker();
    if (autoClaimRunning) {
      autoAbortRequested = true;
      const deadline = Date.now() + AUTO_ABORT_WAIT_MS;
      while (autoClaimRunning && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 300));
      }
      if (autoClaimRunning) {
        refreshClaim.running = false;
        refreshClaim.cooldownUntil = Date.now() + REFRESH_CLAIM_COOLDOWN_MS;
        toast(t("m.claimBusy"), "warn");
        setTimeout(stopRefreshTickerIfIdle, 1100);
        return;
      }
    }
    let okCount = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const name = state.accounts.find((a) => a.id === id)?.name || id;
        refreshClaim.done = i + 1;
        claimable[id] = { plans: claimable[id]?.plans || [], busy: true };
        if (!uiLocked()) render();
        try {
          const r = await invoke("claim_refresh", { id });
          claimable[id] = { plans: r.plans || [], err: null, busy: false };
          if ((r.plans || []).length) okCount++;
          if (r.activationError) toast(t("m.refreshClaimAcctErr", { name, err: stripErr(r.activationError) }), "warn");
        } catch (e) {
          claimable[id] = { plans: claimable[id]?.plans || [], err: String(e), busy: false };
          toast(t("m.refreshClaimAcctErr", { name, err: stripErr(e) }), "err");
        }
        scheduleNext(id);
        if (!uiLocked()) render();
        if (i < ids.length - 1) await new Promise((res) => setTimeout(res, 5000));
      }
    } finally {
      refreshClaim.running = false;
      refreshClaim.cooldownUntil = Date.now() + REFRESH_CLAIM_COOLDOWN_MS;
      if (!uiLocked()) render();
      setTimeout(stopRefreshTickerIfIdle, 1100);
    }
    toast(t("m.refreshClaimDone", { n: ids.length, k: okCount }), "ok");
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
        toast(t("as.on"), "ok", t("as.onDetail", { pct: state?.auto_switch_threshold ?? 10 }));
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
    if (next && (autoClaimRunning || claimActive || claimAllRunning || refreshClaim.running)) {
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
        if (Date.now() - (lastAutoRound?.at ?? 0) > REFRESH_CLAIM_COOLDOWN_MS) autoClaimTick();
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

function startRefreshTicker() {
  if (refreshTicker) return;
  refreshTicker = setInterval(() => {
    if (!uiLocked()) render();
    stopRefreshTickerIfIdle();
  }, 1000);
}
function stopRefreshTickerIfIdle() {
  const cooling = Date.now() < refreshClaim.cooldownUntil;
  if (!refreshClaim.running && !cooling && refreshTicker) {
    clearInterval(refreshTicker); refreshTicker = null; if (!uiLocked()) render();
  }
}

function autoClaimCooldownFor(r) {
  const now = Date.now();
  if (r.code === 1005 && r.nextAt) return r.nextAt;
  if (Number.isFinite(r.code) && r.code >= 1000) return now + 60 * 60 * 1000;
  if (r.code === "interactive") return now + 60 * 60 * 1000;
  return now + AUTO_CLAIM_INTERVAL_MS;
}

async function autoClaimTick() {
  if (!state?.auto_claim || autoClaimRunning) return;
  if (claimActive || claimAllRunning || refreshClaim.running) return;
  const ids = (state.accounts || [])
    .map((a) => a.id)
    .filter((id) => (autoClaimCooldown[id] ?? 0) <= Date.now());
  if (!ids.length) {
    if ((state.accounts || []).some((a) => (claimable[a.id]?.plans || []).length > 0)) {
      lastAutoRound = { at: Date.now(), claimed: 0, skipped: 0, cooldownAll: true };
    }
    return;
  }
  autoClaimRunning = true; claimActive = true; autoAbortRequested = false;
  let roundClaimed = 0, roundSkipped = 0;
  if (!uiLocked()) render();
  try {
    for (const id of ids) {
      if (!state?.auto_claim || autoAbortRequested) break;
      if (!(state.accounts || []).some((a) => a.id === id)) continue;
      let gotAny = false;
      let failed = false;
      claimable[id] = { ...(claimable[id] || {}), busy: true };
      try {
        const r = await invoke("claim_refresh", { id });
        claimable[id] = { plans: r.plans || [], err: null, busy: false };
      } catch (e) {
        claimable[id] = { plans: claimable[id]?.plans || [], err: String(e), busy: false };
        autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
        roundSkipped++;
        continue;
      }
      if (!uiLocked()) render();
      let attempts = 0;
      let progressed = true;
      while (progressed && attempts < AUTO_CLAIM_PER_ACCOUNT_CAP) {
        if (autoAbortRequested) break;
        attempts++;
        progressed = false;
        const plan = claimable[id]?.plans?.[0];
        if (!plan) break;
        try {
          await invoke("claim_start", { id, planId: plan.plan_id, auto: true });
        } catch (e) {
          await invoke("claim_cancel").catch(() => {});
          autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
          failed = true;
          break;
        }
        const r = await waitForClaimResult(id, AUTO_CLAIM_WAIT_MS);
        if (!r) {
          await invoke("claim_cancel").catch(() => {});
          autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
          failed = true;
          break;
        }
        if (r.ok === false) {
          autoClaimCooldown[id] = autoClaimCooldownFor(r);
          failed = true;
          break;
        }
        gotAny = true; roundClaimed++;
        // 领取成功：上游需要几分钟发放套餐余额，主动触发额度刷新能最早看到数据
        pokeAccount(id);
        await awaitClaimPreviewFresh(id);
        if (!uiLocked()) render();
        progressed = true;
        await new Promise((res) => setTimeout(res, 1200));
      }
      if (!gotAny && (claimable[id]?.plans || []).length) roundSkipped++;
      // 统一收尾冷却：有失败走失败时已设的冷却；领完/无可领 → 30 分钟后再查。
      // 不设冷却的话每轮都会把所有无 pending 的账号重复刷一遍领奖接口
      if (!failed) {
        const remaining = (claimable[id]?.plans || []).length;
        autoClaimCooldown[id] = Date.now() + (remaining === 0 ? AUTO_CLAIM_RECHECK_MS : AUTO_CLAIM_INTERVAL_MS);
      }
      await new Promise((res) => setTimeout(res, AUTO_CLAIM_ACCT_GAP_MS));
    }
  } finally {
    autoClaimRunning = false; claimActive = false;
    if (state?.auto_claim) lastAutoRound = { at: Date.now(), claimed: roundClaimed, skipped: roundSkipped };
    if (!uiLocked()) render();
  }
}

// 额度状态色：剩余=绿（快用尽转红）、已用=黄、完全用尽=整条黄
const BAR_GREEN = "#62c370", BAR_RED = "#e0566a", BAR_YELLOW = "#e6c84a";
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
  const rem = it.total != null && it.remaining != null ? `${fmtTokens(it.remaining)}/${fmtTokens(it.total)}` : "";
  // 对齐官方完整模型名（show_name 本就是 GLM-5.3-Flash 这类全称）
  return `
  <div class="q-win mini">
    <span class="q-win-label" title="${esc(it.name)}">${esc(it.name)}</span>
    ${quotaBarHtml(it.percent_used)}
    <span class="q-win-reset">${esc(rem)}</span>
  </div>`;
}

const TIER_RANK = { max: 0, pro: 1, lite: 2, start: 3, trial: 4, other: 9 };

/** 套餐等级归一：有 tier_code 时以它为准，否则回退到名称文本 */
function tierKind(tier, code) {
  const c = String(code || "").trim().toLowerCase();
  if (c === "max" || c === "pro" || c === "lite" || c === "start" || c === "trial") return c;
  const s = String(tier || "").toLowerCase();
  if (s.includes("max")) return "max";
  if (s.includes("pro")) return "pro";
  if (s.includes("lite")) return "lite";
  if (s.includes("start")) return "start";
  if (s.includes("trial") || String(tier || "").includes("体验")) return "trial";
  return "other";
}

function tierChipHtml(tier, code) {
  const kind = tierKind(tier, code);
  const label = kind === "max" ? "Max"
    : kind === "pro" ? "Pro"
      : kind === "lite" ? "Lite"
        : kind === "start" ? "Start"
          : kind === "trial" ? t("q.trial")
            : (tier || t("q.other"));
  const cls = kind === "other" ? "other" : kind === "start" ? "trial" : kind;
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
function claimStripHtml(id) {
  const c = claimable[id];
  const plan = c?.plans?.[0];
  if (!plan) return "";
  const grants = grantLabel(plan);
  const label = plan.name || plan.plan_id;
  return `
  <div class="claim-strip" title="${esc(plan.description || label)}">
    ${ic("gift", 15)}
    <span class="claim-name">${esc(label)}</span>
    ${grants ? `<span class="claim-grants">${esc(grants)}</span>` : ""}
    <button class="btn-claim has-ic" click="actions.claim('${id}')" ${claimAllRunning || refreshClaim.running || claimActive || autoClaimRunning ? "disabled" : ""}>${ic("gift", 13)} ${t("btn.claim")}</button>
  </div>`;
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

/** 明细区是否已经有内容（有的话行内就不再重复显示额度小条） */
function hasQuotaDetail(id) {
  const q = acctQuota[id];
  if (q?.busy || q?.err) return true;
  const d = q?.data;
  if (!d) return false;
  if ((d.plans || []).length >= 2) return true;
  if ((d.items || []).length) return true;
  return d.percent_used != null;
}

function planGroupHtml(p, omitTier = false) {
  const label = p.tier_code === "other" && !p.pid ? t("q.other") : (p.name || p.tier || "");
  const exp = expireInfo(p.expire);
  return `
  <div class="plan-grp">
    <div class="pg-head">
      ${p.tier && !omitTier ? tierChipHtml(p.tier, p.tier_code) : ""}
      <span class="pg-name" title="${esc(label)}">${esc(label)}</span>
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

/** 行内额度区：可领条永远显示；额度明细按展开状态决定 */
function quotaSlotInner(id, showDetail) {
  return `${claimStripHtml(id)}${showDetail ? quotaDetailHtml(id) : ""}`;
}
function quotaSlotHtml(id, showDetail) {
  const inner = quotaSlotInner(id, showDetail);
  if (!inner) return "";
  return `<div class="row-quota-slot" data-quota-slot>${inner}</div>`;
}

function captureScroll() {
  const list = $app.querySelector(".list");
  if (!list || list.scrollTop === 0) return null;
  const listTop = list.getBoundingClientRect().top;
  for (const row of list.querySelectorAll(".row[data-id]")) {
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
  const row = list.querySelector(`.row[data-id="${CSS.escape(cap.id)}"]`);
  if (row) {
    const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = delta - cap.offset;
  } else {
    list.scrollTop = cap.scrollTop;
  }
}

let lastRenderSig = "";
let lastQuotaSig = "";
let lastProgressSig = "";
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
    ui.search, ui.health, ui.sort, ui.sortDir, ui.density, ui.hideInfo, ui.qhOpen, ui.qhTab, renaming,
    appVer, autoSwitchRunning, autoClaimRunning, claimActive, busy,
  ]);
}
function renderProgressSig() {
  return JSON.stringify([quotaSweep, refreshClaim, claimAllState, [...twoUsageMap.entries()]]);
}

function giftBtnHtml(claimableCount) {
  return `<button class="icon-btn tb-btn tb-gift${claimAllState.running ? " running" : ""}" data-gift-btn click="actions.claimAll()" ${claimAllRunning || refreshClaim.running || autoClaimRunning ? "disabled" : ""}
      aria-label="${t("btn.claimAll")}" title="${claimAllState.running
        ? esc(t("btn.claimAllRunning", { done: claimAllState.done, total: claimAllState.total }))
        : esc(t("btn.claimAllTitle"))}${claimableCount > 1 ? ` (${claimableCount})` : ""}">
      ${ic("gift", 17)}${claimAllState.running
        ? `<span class="tb-badge">${claimAllState.done}/${claimAllState.total}</span>`
        : claimableCount > 1 ? `<span class="tb-badge">${claimableCount}</span>` : ""}
    </button>`;
}

// ---------- 额度统计模态（设置弹窗同款交互：body 挂载 / Esc / 点外关闭） ----------

let quotaModalEl = null;
let qhOnKey = null;

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
  const tpl = document.createElement("template");
  tpl.innerHTML = quotaPanelHtml(quotaTotals()).trim();
  const node = tpl.content.firstElementChild;
  if (!node) return;
  const nsc = node.querySelector("[data-qh-scroll]");
  if (nsc) nsc.scrollTop = st;
  pop.replaceWith(node);
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
  const claimableCount = (state?.accounts || []).filter((a) => (claimable[a.id]?.plans || []).length > 0).length;
  if (claimableCount > 0 || claimAllState.running) {
    replace("[data-gift-btn]", giftBtnHtml(claimableCount));
  }
  for (const a of state?.accounts || []) {
    const row = $app.querySelector(`.row[data-id="${CSS.escape(a.id)}"]`);
    if (!row) continue;
    const usage = twoUsageMap.get(a.id) || 0;
    const cur = row.querySelector("[data-usage]");
    if (!usage) { if (cur) cur.remove(); continue; }
    const html = `<span class="row-usage" data-usage title="${esc(t("list.usageTitle"))}">${usage > 999 ? (usage / 1000).toFixed(1) + "k" : usage}</span>`;
    if (!cur) row.insertAdjacentHTML("afterbegin", html);
    else {
      const wantText = usage > 999 ? (usage / 1000).toFixed(1) + "k" : String(usage);
      if (cur.textContent !== wantText) cur.outerHTML = html;
    }
  }
}

/** 结构未变、仅额度数据变化时的精准补丁：只就地更新额度相关 DOM，宽度/滚动零扰动 */
function patchQuotaDom() {
  const { list: visible, hm } = visibleAccounts();
  const sum = summarize(state?.accounts || [], hm);
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
    const row = $app.querySelector(`.row[data-id="${CSS.escape(a.id)}"]`);
    if (!row) continue;
    const h = hm.get(a.id) || { level: "unknown", remainingPct: null };
    const dot = row.querySelector(".hdot");
    if (dot) {
      const tpl = document.createElement("template");
      tpl.innerHTML = healthDotHtml(h).trim();
      const node = tpl.content.firstElementChild;
      if (node) dot.replaceWith(node);
    }
    const q = acctQuota[a.id];
    const exp = expireInfo(q?.data?.plan_expire);
    const slim = row.classList.contains("slim");
    const info = row.querySelector(".row-info");
    if (info) {
      const expSoon = slim && exp?.warn
        ? `<span class="meta-chip warn" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(expSoonLabel(exp))}</span>`
        : "";
      const showChip = slim || !hasQuotaDetail(a.id);
      info.innerHTML = expSoon + (showChip ? quotaChipHtml(a.id, h) : "");
    }
    const slot = row.querySelector("[data-quota-slot]");
    if (slot) slot.innerHTML = quotaSlotInner(a.id, !slim);
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
      if (qs !== lastQuotaSig || ps !== lastProgressSig) {
        lastQuotaSig = qs;
        lastProgressSig = ps;
        patchQuotaDom();
        patchProgressDom();
      }
      return;
    }
    // 批量操作（全量刷新/领取）期间合并重渲染，最多 500ms 一次，避免连续重建掉帧
    if (quotaSweep?.running || refreshClaim?.running || claimAllRunning || autoClaimRunning) {
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
  const sum = summarize(s.accounts, healthMap);

  const rowHtml = (a) => {
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
    const ident = [a.identity?.username, a.identity?.email]
      .filter(Boolean)
      .filter((x) => x.trim().toLowerCase() !== nm)
      .join(" · ");
    const q = acctQuota[a.id];
    let meta = "";
    if (!a.has_config) meta += `<span class="meta-chip warn" title="${esc(t("q.noCfg"))}">${esc(t("q.noCfgShort"))}</span>`;
    const exp = expireInfo(q?.data?.plan_expire);
    if (exp) {
      meta += `<span class="meta-chip${exp.warn ? " warn" : ""}" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(t("q.validUntilShort", { date: exp.text }))}</span>`;
    }
    // 名称本身就是邮箱/手机号时不再重复展示
    if (ident && ident.toLowerCase() !== String(a.name || "").trim().toLowerCase()) {
      meta += ui.hideInfo
        ? `<span class="meta-id masked">${esc(t("list.hidden"))}</span>`
        : `<span class="meta-id" title="${esc(ident)}">${esc(ident)}</span>`;
    }
    const checked = ui.selected.has(a.id);
    const slim = ui.density === "compact" && !ui.expanded.has(a.id);
    // 详细（或已展开）且明细区有内容时，行内不再重复展示额度小条
    const showChip = slim || !hasQuotaDetail(a.id);
    // 紧凑模式隐藏了 meta，这里只把“快到期”单独顶出来，避免漏看
    const expSoon = slim && exp?.warn
      ? `<span class="meta-chip warn" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(expSoonLabel(exp))}</span>`
      : "";
    // 无名账号回退：先试身份信息（邮箱/用户名），再兜底“未命名”
    const baseName = nameText(a);
    const displayName = (baseName && baseName.trim())
      || (ident ? (ui.hideInfo && looksSecret(ident) ? t("list.hidden") : ident) : "")
      || t("list.unnamed");
    // 2API 累计请求数（左上角小计数，0 不显示）
    const usage = twoUsageMap.get(a.id) || 0;
    const usageBadge = usage
      ? `<span class="row-usage" data-usage title="${esc(t("list.usageTitle"))}">${usage > 999 ? (usage / 1000).toFixed(1) + "k" : usage}</span>`
      : "";
    return `
    <div class="row${isActive ? " active" : ""}${checked ? " picked" : ""}${slim ? " slim" : ""}" data-id="${a.id}">
      ${usageBadge}
      <div class="row-top">
        <span class="rchk" role="checkbox" aria-checked="${checked}" title="${esc(t("list.selectHint"))}" click="actions.toggleSelect('${a.id}')">${ic("check", 11)}</span>
        ${healthDotHtml(h)}
        ${slim ? "" : `<span class="notch" style="background:${notchColor(a.id)}"></span>`}
        <div class="row-main"${ui.density === "compact" ? ` click="actions.toggleRow(event)" title="${esc(slim ? t("list.expandTitle") : t("list.collapseTitle"))}"` : ""}>
          <div class="row-name">${ui.density === "compact" ? `<span class="row-chev${slim ? "" : " open"}">${ic("chevDown", 12)}</span>` : ""}${tierBadgeFor(a.id)}${giftBadgeFor(a.id)}<span class="rn-text" title="${esc(displayName)}">${esc(displayName)}</span>${isActive ? `<span class="tag-use">${t("btn.inUse")}</span>` : ""}${a.has_user_info === false ? `<span class="tag-relogin" title="${esc(t("btn.reloginTitle"))}">${t("btn.relogin")}</span>` : ""}</div>
          <div class="row-meta">${meta}</div>
        </div>
        <div class="row-info">${expSoon}${showChip ? quotaChipHtml(a.id, h) : ""}</div>
        <div class="row-actions">
          <span class="row-tools">
            <button class="icon-btn" title="${t("btn.copyKey")}" aria-label="${t("btn.copyKey")}" click="actions.copyApiKey('${a.id}')">${ic("copy", 15)}</button>
            <button class="icon-btn" title="${t("btn.refreshQuota")}" aria-label="${t("btn.refreshQuota")}" click="actions.acctQuota('${a.id}')">${ic("refresh", 15)}</button>
            <button class="icon-btn" title="${t("btn.rename")}" aria-label="${t("btn.rename")}" click="actions.rename('${a.id}')">${ic("pen", 15)}</button>
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
        : visible.map(rowHtml).join("");

  const claimableCount = s.accounts.filter((a) => (claimable[a.id]?.plans || []).length > 0).length;

  $app.innerHTML = `
    <header class="topbar">
      <div class="wordmark">Z·SWITCH${appVer ? ` <span class="ver">v${esc(appVer)}</span>` : ""}</div>
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
    ${active ? `<button class="fab-locate" title="${t("list.locateActive")}" aria-label="${t("list.locateActive")}" click="actions.locateActive()">${ic("target", 20)}</button>` : ""}
  `;
  restoreScroll(scrollCap);
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
  } else {
    const bits = [];
    const now = p.serverTime || Date.now();
    if (p.startsAt && p.startsAt > now) bits.push(t("m.claimStartsAt", { time: new Date(p.startsAt).toLocaleString(localeTag(), { hour12: false }) }));
    if (p.endsAt) bits.push(t("m.claimEndsAt", { time: new Date(p.endsAt).toLocaleString(localeTag(), { hour12: false }) }));
    toast(t("m.claimOk", { name: p.accountName, plan: p.planName }), "ok", bits.join(t("common.listSep")));
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

const SWEEP_PERIOD = 5 * 60 * 1000;
// 阶梯式刷新：当前使用中的账号用短周期，加速自动切换的响应；其余账号维持长周期
const SWEEP_PERIOD_ACTIVE = 45 * 1000;
const SWEEP_JITTER = 0.2;
const TICK_MS = 8000;
let quotaDue = {};
let ticking = false;

function scheduleNext(id, base = Date.now()) {
  const jitter = 1 + (Math.random() * 2 - 1) * SWEEP_JITTER;
  let period = SWEEP_PERIOD;
  if (state?.accounts?.some((a) => a.id === id && a.is_active)) {
    // 活跃账号自适应频率：看关注模型的原始百分比（流转后判定高不代表关注模型没耗尽），
    // 越接近切换阈值刷新越勤——每日重置等额度恢复能第一时间发现并切回
    period = SWEEP_PERIOD_ACTIVE;
    const thr = Number(state?.auto_switch_threshold ?? 10);
    const h = healthMapOf().get(id);
    const fp = h?.focusPct;
    if (fp != null) {
      if (fp <= thr) period = 8 * 1000;                         // 关注模型已耗尽：高频盯防（等重置/等待其它账号变化）
      else if (fp <= thr * 2) period = 12 * 1000;               // 逼近阈值：加密
      else period = 20 * 1000;                                  // 活跃账号整体提速：正在消耗的就是它，45s 太钝
    }
  }
  quotaDue[id] = base + Math.round(period * jitter);
}
function enrollAccounts() {
  const live = new Set((state?.accounts || []).map((a) => a.id));
  for (const id of live) if (!(id in quotaDue)) quotaDue[id] = Date.now();
  for (const id of Object.keys(quotaDue)) if (!live.has(id)) delete quotaDue[id];
}
function pokeAccount(id) { if (id) quotaDue[id] = Date.now(); }

/** 低额度自动切换：当前账号剩余额度低于阈值时，切到剩余最多的账号 */
async function autoSwitchTick(manual = false) {
  autoSwitchNote = "";
  const s = state;
  if (!s?.auto_switch || autoSwitchRunning || busy) return;
  if (!(s.accounts || []).length) return;
  if (quotaSweep.running || refreshClaim.running || claimAllRunning || autoClaimRunning || claimActive) return;
  // 手动刷新是显式触发，跳过冷却；定时巡检仍受冷却约束，避免来回切换
  const active = s.accounts.find((a) => a.is_active);
  if (!active) return;
  const hm = healthMapOf();
  const cur = hm.get(active.id);
  if (!cur || cur.remainingPct == null) return;
  const thr = Number(s.auto_switch_threshold ?? 10);

  // 候选池：其它账号中判定额度 > 阈值 且 非鉴权失效/查询失败
  const pool = s.accounts
    .filter((a) => a.id !== active.id)
    .map((a) => ({ a, h: hm.get(a.id) }))
    .filter((x) => x.h && x.h.level !== "auth" && x.h.level !== "fail")
    .filter((x) => x.h?.remainingPct != null && x.h.remainingPct >= thr);
  // 关注模型仍有额度的账号优先；流转账号（判定来自其它模型）只做兜底
  const focusCands = pool.filter((x) => x.h.modelMatched && !x.h.fallback);
  const flowCands = pool.filter((x) => x.h.fallback);

  // 触发判定：
  // - 当前账号非流转：判定额度 ≤ 阈值 → 触发
  // - 当前账号已流转（关注模型在所有套餐耗尽，判定来自其它模型）：
  //     其它账号还有关注模型额度 → 立即触发（Flash 优先，不能赖在 5.3 上）
  //     否则当前账号的流转判定额度 ≤ 阈值（5.3 也快没了）→ 触发
  const focusCandExists = focusCands.length > 0;
  const shouldSwitch = cur.fallback
    ? (focusCandExists || cur.remainingPct <= thr)
    : cur.remainingPct <= thr;
  if (!shouldSwitch) {
    // 让“为什么不切”对用户可见：关注模型全场耗尽时已流转其它模型，暂无更优目标
    if (cur.fallback) autoSwitchNote = t("as.noteFlowed", { model: cur.modelName || "", pct: Math.round(cur.remainingPct) });
    return;
  }

  // 冷却豁免：紧急情况（当前账号关注模型已耗尽且有关注模型候选）不受 5 分钟冷却限制，
  // 否则刚切过去的号 Flash 烧完后要干等 5 分钟
  const emergency = cur.fallback && focusCandExists;
  if (!manual && !emergency && Date.now() - lastAutoSwitchAt < AUTO_SWITCH_COOLDOWN_MS) return;

  // 目标池：关注模型候选优先；关注模型全面耗尽时才轮到流转候选
  const targetPool = focusCandExists ? focusCands : flowCands;
  if (!targetPool.length) {
    autoSwitchNote = t("as.noteNoCand");
    return;
  }
  // 候选排序：额度高者优先；礼物/套餐临期的账号再插队，尽快把赠送额度用掉
  const giftSoon = (a) => (acctQuota[a.id]?.data?.plans || []).some((p) => expireInfo(p.expire)?.warn);
  const best = targetPool
    .map((x) => ({ ...x, gift: giftSoon(x.a) ? 1 : 0 }))
    .sort((x, y) => (y.gift - x.gift) || (y.h.remainingPct - x.h.remainingPct))[0];
  if (!best) return;
  // ZCode 运行中且未开热切换：不自动强杀客户端，只在提示里说明
  if (s.zcode_running && !s.hot_switch) {
    autoSwitchNote = t("as.needHot");
    if (!isTyping()) render();
    return;
  }
  autoSwitchRunning = true;
  if (!isTyping()) render();
  try {
    const r = await invoke("switch_to", { id: best.a.id, force: false, restart: s.launch_after_switch });
    lastAutoSwitchAt = Date.now();
    ui.expanded.delete(best.a.id);
    const bits = [];
    if (r?.hot) bits.push(t("m.bitHot"));
    if (r?.launched) bits.push(t("m.bitLaunched"));
    if (r?.preserved_as) bits.push(t("m.bitPreserved", { name: r.preserved_as }));
    toast(t("as.toast", { from: active.name, to: r?.name || best.a.name, pct: Math.round(cur.remainingPct) }), "ok", bits.join(t("common.listSep")));
    await refresh();
    pokeAccount(best.a.id);
  } catch (e) {
    lastAutoSwitchAt = Date.now();
    toast(t("as.fail", { err: stripErr(e) }), "warn");
  } finally {
    autoSwitchRunning = false;
    if (!uiLocked()) render();
  }
}

async function sweepTick() {
  if (ticking || quotaSweep.running) return;
  enrollAccounts();
  const now = Date.now();
  const due = (state?.accounts || []).find(
    (a) => (quotaDue[a.id] ?? Infinity) <= now && !acctQuota[a.id]?.busy && !claimable[a.id]?.busy,
  );
  if (!due) return;
  ticking = true;
  const dueAt = quotaDue[due.id];
  try {
    await loadAcctQuota(due.id);
    if (quotaDue[due.id] === dueAt) scheduleNext(due.id);
    if (!uiLocked()) render();
  } finally {
    ticking = false;
  }
}

(async () => {
  try {
    appVer = await invoke("app_version").catch(() => "");
    await refresh();
    render();
    await invoke("reveal_main");
    setTimeout(dismissSplash, 350);
    enrollAccounts();
    sweepTick();
    // 启动时把额度拉全（健康度 / 筛选 / 排序都依赖它）
    setTimeout(() => { if (!quotaSweep.running) actions.refreshAll(true); }, 900);
    setInterval(() => {
      Promise.all([
        invoke("get_state"),
        invoke("two_api_status").catch(() => null),
      ]).then(([s, st]) => {
        state = s;
        if (s?.language) init(s.language);
        enrollAccounts();
        if (st?.usage) twoUsageMap = new Map(Object.entries(st.usage));
        if (!uiLocked()) render();
      }).catch(() => {});
    }, 5000);
    setInterval(sweepTick, TICK_MS);
    setInterval(autoSwitchTick, AUTO_SWITCH_CHECK_MS);
    setInterval(autoCollapseTick, 1000);
    // 行内任何点击都算“有操作”，刷新自动收起倒计时
    $app.addEventListener("click", (e) => {
      const row = e.target?.closest?.(".row");
      if (row?.dataset?.id) expandTouch(row.dataset.id);
    });
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
