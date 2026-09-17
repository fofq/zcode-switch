import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, toast, openPwModal, openConfirmModal, openProviderModal, openGroupModal, installDelegation, dismissSplash } from "./ui.js";
import { ic } from "./icons.js";
import { init, t, has, lang, localeTag, stripErr, errCode } from "./i18n.js";
import { HEALTH_ORDER, healthOf, filterAccounts, sortAccounts, bucketAccounts, summarize } from "./list.js";

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
const SORTS = ["quota", "name", "created", "updated"];

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
  density: savedPrefs.density === "detail" ? "detail" : "compact",
  hideInfo: savedPrefs.hideInfo === true,
  modelCustom: false,
  selected: new Set(),
  expanded: new Set(),
  collapsedSections: new Set(),
};
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
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ sort: ui.sort, density: ui.density, hideInfo: ui.hideInfo }));
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
const SORT_PREFIX = "list.sort.";
function healthLabel(level) {
  return t(HEALTH_PREFIX + level);
}
function healthMapOf() {
  const model = state?.auto_switch_model || "";
  const map = new Map();
  for (const a of state?.accounts || []) map.set(a.id, healthOf(a, acctQuota[a.id], isAuthErr, model));
  return map;
}
function focusModel() {
  return String(state?.auto_switch_model || "").trim();
}
function pctLabel(h) {
  if (h.remainingPct == null) return t("list.pctUnknown");
  const m = focusModel();
  if (m && h.modelMatched) return t("list.modelPct", { model: m, pct: Math.round(h.remainingPct) });
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
  const txt = q?.busy && !q?.data ? t("list.querying") : pctLabel(h);
  return `<div class="rq ${h.level}" title="${esc(healthLabel(h.level) + (pct == null ? "" : " · " + pctLabel(h)))}">
      <span class="rq-bar"><i style="width:${w}%"></i></span>
      <span class="rq-pct">${esc(txt)}</span>
    </div>`;
}
function groupTagHtml(a) {
  const g = acctGroup(a);
  if (!g) return "";
  return `<span class="tag-grp" title="${esc(t("grp.tagTitle", { group: g }))}">${ic("folder", 11)} ${esc(g)}</span>`;
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
    <div class="st-note">${models.length ? t("st.modelDesc", { n: models.length }) : t("st.modelNone")}</div>
  </div>`;
}

function settingsFormHtml() {
  const s = state;
  return `
  <div class="st-panel" role="dialog" aria-modal="true" aria-label="${esc(t("s.title"))}">
    <div class="st-head">
      <span class="st-title">${ic("sliders", 16)} ${t("s.title")}</span>
      <button class="icon-btn st-close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${ic("x", 15)}</button>
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
}

async function openSettingsModal() {
  closeSettingsModal();
  autostartOn = await invoke("autostart_status").catch(() => false);
  const mask = document.createElement("div");
  mask.className = "st-mask pv-mask";
  mask.innerHTML = settingsFormHtml();
  document.body.appendChild(mask);
  settingsModalEl = mask;
  const onKey = (e) => { if (e.key === "Escape") closeSettingsModal(); };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) { closeSettingsModal(); document.removeEventListener("keydown", onKey); } });
  mask.querySelector(".st-close").addEventListener("click", closeSettingsModal);
}

function customGroups(accounts) {
  const set = new Set();
  for (const a of accounts) {
    const g = acctGroup(a);
    if (g) set.add(g);
  }
  return [...set].sort((x, y) => x.localeCompare(y, localeTag(), { sensitivity: "base" }));
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
  const levels = ["all", ...HEALTH_ORDER.filter((lv) => lv === ui.health || sum.counts[lv] > 0)];
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
  const base = t("list.summary", { n: (state?.accounts || []).length, avg });
  return `<span class="lh-sum">${esc(m ? base + " · " + t("list.focusModel", { model: m }) : base)}</span>`;
}

function bulkBarHtml() {
  const n = selectedIds().length;
  if (!n) return "";
  return `<div class="bulk-bar">
    <span class="bulk-n">${esc(t("list.selected", { n }))}</span>
    <span class="lh-sp"></span>
    <button class="btn-ghost has-ic" click="actions.askBulkGroup()">${ic("folder", 13)} ${t("list.bulkGroup")}</button>
    <button class="btn-ghost danger has-ic" click="actions.askBulkDelete()">${ic("x", 13)} ${t("list.bulkDelete")}</button>
    <button class="btn-ghost" click="actions.clearSelection()">${t("list.clearSel")}</button>
  </div>`;
}

function listHeadHtml(s, sum, visible) {
  const allOn = visible.length > 0 && visible.every((a) => ui.selected.has(a.id));
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
        <span class="lh-sp"></span>
        <button class="sel-all" title="${esc(t("list.selectAllVisible"))}" click="actions.selectAllVisible()">
          <span class="rchk sm${allOn ? " on" : ""}" aria-hidden="true">${ic("check", 11)}</span>${t("list.selectAll")}
        </button>
        <button class="icon-btn sm" title="${esc(ui.hideInfo ? t("list.showInfo") : t("list.hideInfo"))}" aria-pressed="${ui.hideInfo}" click="actions.toggleHideInfo()">${ic(ui.hideInfo ? "eyeOff" : "eye", 14)}</button>
        <select class="mini-sel" change="actions.setSort(event)" aria-label="${esc(t("list.sortLabel"))}">
          ${SORTS.map((v) => `<option value="${v}"${ui.sort === v ? " selected" : ""}>${esc(t(SORT_PREFIX + v))}</option>`).join("")}
        </select>
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
  if (cur.busy) return;
  acctQuota[id] = { busy: true };
  if (!uiLocked()) render();
  try {
    const data = await invoke("get_account_quota", { id });
    acctQuota[id] = { data, err: null, busy: false };
  } catch (e) {
    acctQuota[id] = { data: null, err: stripErr(e), code: errCode(e), busy: false };
  }
  if (!uiLocked()) render();
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
    ui.health = HEALTH_ORDER.includes(lv) ? lv : "all";
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
    const id = ev?.target?.closest?.(".row")?.dataset?.id;
    if (!id) return;
    if (ui.expanded.has(id)) ui.expanded.delete(id);
    else ui.expanded.add(id);
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

  askBulkGroup() {
    const ids = selectedIds();
    if (!ids.length) return;
    openGroupModal({
      name: t("list.bulkGroupName", { n: ids.length }),
      current: "",
      groups: customGroups(state?.accounts || []),
      onPick: (g) => actions.doBulkGroup(ids, g),
      onCreate: (g) => actions.doBulkGroup(ids, g),
    });
  },

  async doBulkGroup(ids, group) {
    const next = String(group || "").trim();
    await guard(async () => {
      let ok = 0;
      for (const id of ids) {
        try { await invoke("set_account_group", { id, group: next || null }); ok++; } catch { /* 单个失败不阻断 */ }
      }
      if (next) toast(t("grp.toastBulkGrouped", { n: ok, group: next }), "ok");
      else toast(t("grp.toastBulkUngrouped", { n: ok }));
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
      if (state?.auto_switch) autoSwitchTick();
    }
  },

  setGroup(id) {
    const a = state?.accounts.find((x) => x.id === id);
    if (!a) return;
    openGroupModal({
      name: a.name,
      current: acctGroup(a),
      groups: customGroups(state?.accounts || []),
      onPick: (g) => actions.applyGroup(id, g),
      onCreate: (g) => actions.applyGroup(id, g),
    });
  },

  async applyGroup(id, group) {
    const a = state?.accounts.find((x) => x.id === id);
    const next = String(group || "").trim();
    if (next === acctGroup(a)) return;
    await guard(async () => {
      const r = await invoke("set_account_group", { id, group: next || null });
      const applied = acctGroup(r);
      if (applied) toast(t("grp.toastGrouped", { name: a?.name, group: applied }), "ok");
      else toast(t("grp.toastUngrouped", { name: a?.name }));
      await refresh(); render();
    });
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

  async doSwitch(id, force) {
    await guard(async () => {
      const restart = state.launch_after_switch;
      const r = await invoke("switch_to", { id, force, restart });
      if (r.already_active) {
        toast(t("m.toastAlready", { name: r.name }), "ok");
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
    });
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
        }
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
          break;
        }
        const r = await waitForClaimResult(id, AUTO_CLAIM_WAIT_MS);
        if (!r) {
          await invoke("claim_cancel").catch(() => {});
          autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
          break;
        }
        if (r.ok === false) {
          autoClaimCooldown[id] = autoClaimCooldownFor(r);
          break;
        }
        gotAny = true; roundClaimed++;
        await awaitClaimPreviewFresh(id);
        if (!uiLocked()) render();
        progressed = true;
        await new Promise((res) => setTimeout(res, 1200));
      }
      if (!gotAny && (claimable[id]?.plans || []).length) roundSkipped++;
      await new Promise((res) => setTimeout(res, AUTO_CLAIM_ACCT_GAP_MS));
    }
  } finally {
    autoClaimRunning = false; claimActive = false;
    if (state?.auto_claim) lastAutoRound = { at: Date.now(), claimed: roundClaimed, skipped: roundSkipped };
    if (!uiLocked()) render();
  }
}

function quotaBarHtml(pct) {
  const used = pct == null ? null : Math.min(100, Math.max(0, pct));
  const remaining = used == null ? null : 100 - used;
  const danger = used != null && used >= 90 ? " danger" : used != null && used >= 70 ? " warn" : "";
  const txt = remaining == null ? "--" : remaining.toFixed(0) + "%";
  const txtCls = (remaining ?? 100) >= 58 ? " in-fill" : "";
  return `<div class="qbar${danger}"><div class="qbar-fill" style="width:${remaining ?? 100}%"></div><span class="qbar-pct${txtCls}">${txt}</span></div>`;
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
  const label = it.name.replace(/^GLM-?/i, "");
  return `
  <div class="q-win mini">
    <span class="q-win-label" title="${esc(it.name)}">${esc(label)}</span>
    ${quotaBarHtml(it.percent_used)}
    <span class="q-win-reset">${esc(rem)}</span>
  </div>`;
}

function tierChipHtml(tier, code) {
  const c = String(code || "").toLowerCase();
  const s = String(tier || "").toLowerCase();
  let label, cls;
  if (c === "max" || (!c && s.includes("max"))) { label = "Max"; cls = "max"; }
  else if (c === "pro" || (!c && s.includes("pro"))) { label = "Pro"; cls = "pro"; }
  else if (c === "lite" || (!c && s.includes("lite"))) { label = "Lite"; cls = "lite"; }
  else if (c === "start") { label = "Start"; cls = "trial"; }
  else if (c === "trial" || (!c && (s.includes("trial") || String(tier || "").includes("体验")))) { label = t("q.trial"); cls = "trial"; }
  else { label = tier; cls = "other"; }
  return `<span class="tier-b ${cls}">${esc(label)}</span>`;
}
function tierBadgeFor(id) {
  const q = acctQuota[id];
  if (!q?.data) return "";
  const plans = q.data.plans || [];
  const pairs = plans.map((p) => [p.tier, p.tier_code]);
  const list = (pairs.length ? pairs : q.data.plan_tier ? [[q.data.plan_tier, null]] : []).slice(0, 2);
  if (!list.length) return `<span class="tier-b free">Free</span>`;
  return list.map(([tier, code]) => tierChipHtml(tier, code)).join("");
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

function planGroupHtml(p) {
  const label = p.tier_code === "other" && !p.pid ? t("q.other") : (p.name || p.tier || "");
  const exp = expireInfo(p.expire);
  return `
  <div class="plan-grp">
    <div class="pg-head">
      ${p.tier ? tierChipHtml(p.tier, p.tier_code) : ""}
      <span class="pg-name" title="${esc(label)}">${esc(label)}</span>
      ${exp ? `<span class="pg-exp${exp.warn ? " warn-line" : ""}" title="${esc(t("q.validUntil", { date: exp.text }))}">${esc(t("q.validUntilShort", { date: exp.text }))}</span>` : ""}
    </div>
    ${slotRowsHtml(p.items)}
  </div>`;
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

function quotaDetailHtml(id) {
  const q = acctQuota[id];
  if (q?.busy) return `<span class="aq-loading">${t("q.loading")}</span>`;
  if (q?.err) {
    const msg = q.err.length > 46 ? q.err.slice(0, 46) + "…" : q.err;
    return `<span class="aq-err">${esc(msg)}</span>`;
  }
  if (!q?.data) return "";
  const plans = q.data.plans || [];
  if (plans.length >= 2) return plans.map(planGroupHtml).join("");
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
function quotaSlotHtml(id, showDetail) {
  const strip = claimStripHtml(id);
  const inner = showDetail ? quotaDetailHtml(id) : "";
  if (!strip && !inner) return "";
  return `<div class="row-quota-slot">${strip}${inner}</div>`;
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

function render() {
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
    const ident = [a.identity?.username, a.identity?.email].filter(Boolean).join(" · ");
    const q = acctQuota[a.id];
    let meta = "";
    if (!a.has_config) meta += `<span class="no-cfg">${t("q.noCfg")}</span>`;
    const exp = expireInfo(q?.data?.plan_expire);
    if (exp) {
        meta += `<span class="${exp.warn ? "warn-line" : ""}">${esc(t("q.validUntil", { date: exp.text }))}</span>`;
    }
    if (ident) meta += `${meta ? " · " : ""}${ui.hideInfo ? `<span class="masked">${esc(t("list.hidden"))}</span>` : esc(ident)}`;
    const checked = ui.selected.has(a.id);
    const slim = ui.density === "compact" && !ui.expanded.has(a.id);
    // 详细（或已展开）且明细区有内容时，行内不再重复展示额度小条
    const showChip = slim || !hasQuotaDetail(a.id);
    return `
    <div class="row${isActive ? " active" : ""}${checked ? " picked" : ""}${slim ? " slim" : ""}" data-id="${a.id}">
      <div class="row-top">
        <span class="rchk" role="checkbox" aria-checked="${checked}" title="${esc(t("list.selectHint"))}" click="actions.toggleSelect('${a.id}')">${ic("check", 11)}</span>
        ${healthDotHtml(h)}
        ${slim ? "" : `<span class="notch" style="background:${notchColor(a.id)}"></span>`}
        <div class="row-main"${ui.density === "compact" ? ` click="actions.toggleRow(event)" title="${esc(slim ? t("list.expandTitle") : t("list.collapseTitle"))}"` : ""}>
          <div class="row-name">${ui.density === "compact" ? `<span class="row-chev${slim ? "" : " open"}">${ic("chevDown", 12)}</span>` : ""}${esc(nameText(a))}${groupTagHtml(a)}${tierBadgeFor(a.id)}${isActive ? `<span class="tag-use">${t("btn.inUse")}</span>` : ""}${a.has_user_info === false ? `<span class="tag-relogin" title="${esc(t("btn.reloginTitle"))}">${t("btn.relogin")}</span>` : ""}</div>
          <div class="row-meta">${meta}</div>
        </div>
        ${showChip ? quotaChipHtml(a.id, h) : ""}
        <div class="row-actions">
          <button class="icon-btn" title="${t("btn.group")}" aria-label="${t("btn.group")}" click="actions.setGroup('${a.id}')">${ic("folder", 15)}</button>
          <button class="icon-btn" title="${t("btn.refreshQuota")}" aria-label="${t("btn.refreshQuota")}" click="actions.acctQuota('${a.id}')">${ic("refresh", 15)}</button>
          <button class="icon-btn" title="${t("btn.rename")}" aria-label="${t("btn.rename")}" click="actions.rename('${a.id}')">${ic("pen", 15)}</button>
          <button class="icon-btn" title="${t("btn.export")}" aria-label="${t("btn.export")}" click="actions.exportOne('${a.id}')">${ic("export", 15)}</button>
          <button class="icon-btn danger" title="${t("btn.delete")}" aria-label="${t("btn.delete")}" click="actions.delete('${a.id}')">${ic("x", 15)}</button>
          <button class="btn-switch has-ic" click="actions.askSwitch('${a.id}')" ${isActive ? "disabled" : ""}>
            ${isActive ? t("btn.current") : ic("swap", 14) + " " + t("btn.switch")}
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
        <button class="icon-btn tb-btn tb-primary${unsaved ? " attention" : ""}" click="actions.capture()" ${!s.live_logged_in || active ? "disabled" : ""}
          aria-label="${t("btn.saveLogin")}" title="${active ? esc(t("m.saveLoginDisabledTitle", { name: active.name })) : t("btn.saveLogin")}">
          ${ic("capture", 17)}
        </button>
        <button class="icon-btn tb-btn" click="actions.addAccount()" aria-label="${t("btn.addAccount")}" title="${t("btn.addAccountTitle")}">${ic("userPlus", 17)}</button>
      </div>
      <span class="tb-sep"></span>
      <div class="tb-group">
        ${(claimableCount > 0 || claimAllState.running)
          ? `<button class="icon-btn tb-btn${claimAllState.running ? " running" : ""}" click="actions.claimAll()" ${claimAllRunning || refreshClaim.running || autoClaimRunning ? "disabled" : ""}
              aria-label="${t("btn.claimAll")}" title="${claimAllState.running
                ? esc(t("btn.claimAllRunning", { done: claimAllState.done, total: claimAllState.total }))
                : esc(t("btn.claimAllTitle"))}${claimableCount > 1 ? ` (${claimableCount})` : ""}">
              ${ic("gift", 17)}${claimAllState.running
                ? `<span class="tb-badge">${claimAllState.done}/${claimAllState.total}</span>`
                : claimableCount > 1 ? `<span class="tb-badge">${claimableCount}</span>` : ""}
            </button>`
          : ""}
        <button class="icon-btn tb-btn${s.auto_claim ? " on" : ""}${autoClaimRunning ? " running" : ""}"
          role="switch" aria-checked="${s.auto_claim}" aria-label="${t("btn.autoClaim")}"
          title="${autoPillTitle(s)}" click="actions.toggleAutoClaim()">
          ${ic("giftRepeat", 17)}
        </button>
        <button class="icon-btn tb-btn${s.auto_switch ? " on" : ""}${autoSwitchRunning ? " running" : ""}"
          role="switch" aria-checked="${s.auto_switch}" aria-label="${t("as.label")}"
          title="${autoSwitchTitle(s)}" click="actions.toggleAutoSwitch()">
          ${ic("bolt", 17)}
        </button>
        ${(s.accounts.length > 0)
          ? `<button class="icon-btn tb-btn${quotaSweep.running ? " running" : ""}" click="actions.refreshAll()"
              aria-label="${t("btn.refreshAll")}" title="${esc(refreshAllTitle())}">
              ${ic("refresh", 17)}${refreshAllBadge()}
            </button>`
          : ""}
      </div>
      <span class="tb-sep"></span>
      <div class="tb-group">
        ${s.zcode_running
          ? `<button class="icon-btn tb-btn danger" click="actions.askKill()" aria-label="${t("btn.killZcode")}" title="${t("btn.killZcode")}">${ic("power", 17)}</button>`
          : `<button class="icon-btn tb-btn" click="actions.launch()" ${s.zcode_path_ok ? "" : "disabled"} aria-label="${t("btn.launchZcode")}" title="${t("btn.launchZcode")}">${ic("play", 16)}</button>`}
        <button class="icon-btn tb-btn" click="actions.openSettings()" aria-label="${t("common.settings")}" title="${t("common.settings")}">${ic("sliders", 17)}</button>
      </div>
    </section>

    ${listHeadHtml(s, sum, visible)}

    <main class="list">${listHtml}</main>
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
const SWEEP_JITTER = 0.2;
const TICK_MS = 8000;
let quotaDue = {};
let ticking = false;

function scheduleNext(id, base = Date.now()) {
  const jitter = 1 + (Math.random() * 2 - 1) * SWEEP_JITTER;
  quotaDue[id] = base + Math.round(SWEEP_PERIOD * jitter);
}
function enrollAccounts() {
  const live = new Set((state?.accounts || []).map((a) => a.id));
  for (const id of live) if (!(id in quotaDue)) quotaDue[id] = Date.now();
  for (const id of Object.keys(quotaDue)) if (!live.has(id)) delete quotaDue[id];
}
function pokeAccount(id) { if (id) quotaDue[id] = Date.now(); }

/** 低额度自动切换：当前账号剩余额度低于阈值时，切到剩余最多的账号 */
async function autoSwitchTick() {
  autoSwitchNote = "";
  const s = state;
  if (!s?.auto_switch || autoSwitchRunning || busy) return;
  if (!(s.accounts || []).length) return;
  if (quotaSweep.running || refreshClaim.running || claimAllRunning || autoClaimRunning || claimActive) return;
  if (Date.now() - lastAutoSwitchAt < AUTO_SWITCH_COOLDOWN_MS) return;
  const active = s.accounts.find((a) => a.is_active);
  if (!active) return;
  const hm = healthMapOf();
  const cur = hm.get(active.id);
  const thr = Number(s.auto_switch_threshold ?? 10);
  if (!cur || cur.remainingPct == null) return;
  if (cur.remainingPct > thr) return;
  const cands = s.accounts
    .filter((a) => a.id !== active.id)
    .map((a) => ({ a, h: hm.get(a.id) }))
    .filter((x) => x.h?.remainingPct != null && x.h.remainingPct > thr);
  // 关注模型时，优先在「确实有该模型额度」的账号里挑
  const withModel = cands.filter((x) => x.h.modelMatched);
  const best = (withModel.length ? withModel : cands)
    .sort((x, y) => y.h.remainingPct - x.h.remainingPct)[0];
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
      invoke("get_state").then((s) => { state = s; if (s?.language) init(s.language); enrollAccounts(); if (!uiLocked()) render(); }).catch(() => {});
    }, 5000);
    setInterval(sweepTick, TICK_MS);
    setInterval(autoSwitchTick, AUTO_SWITCH_CHECK_MS);
    setTimeout(autoClaimTick, AUTO_CLAIM_FIRST_DELAY_MS);
    setInterval(autoClaimTick, AUTO_CLAIM_INTERVAL_MS);
  } catch (e) {
    $app.innerHTML = `<div class="loading" style="color:var(--red)">${t("common.loadFail", { e: esc(stripErr(e)) })}</div>`;
    invoke("reveal_main").catch(() => {});
    dismissSplash();
  }
})();
