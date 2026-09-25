// 纯浏览器预览垫片：在无 Tauri 后端的环境里模拟 window.__TAURI_INTERNALS__，
// 让 src/main.js 原封不动地跑在普通浏览器里。仅 dev 生效（main.js 顶部有 DEV 守卫，
// 生产构建会被整段剔除），所有数据来自 ./data.js 的拟真数据集。
import {
  mockAccounts, mockQuota, mockState, mockUsage, mockClaimPlans, mockTwoUsage, applyClaimedGift,
} from "./data.js";

const handlers = new Map(); // eventName -> Set<cb>
let cbSeq = 1;
const callbacks = new Map(); // id -> cb

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function emit(event, payload) {
  for (const cb of handlers.get(event) || []) {
    try { cb({ event, id: -1, payload }); } catch (e) { console.warn("[mock] handler error", event, e); }
  }
}

function fakeKey(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "sk-";
  for (let i = 0; i < 46; i++) { h = (h * 1103515245 + 12345) >>> 0; out += chars[h % chars.length]; }
  return out;
}

let autostartOn = false;
let twoStats = { requests: 1284, errors: 6, last_request_at: Math.floor(Date.now() / 1000) - 90 };

// 各命令的 mock 实现；返回 null/对象都行，未列出的命令回退为 null 并告警
const commands = {
  async app_version() { return "1.6.0-preview"; },
  async reveal_main() { return null; },

  async get_state() { return JSON.parse(JSON.stringify(mockState)); },

  async get_account_quota({ id }) {
    await delay(220 + Math.random() * 260);
    return mockQuota(id);
  },

  async claim_preview({ id }) { return mockClaimPlans(id); },
  async claim_refresh({ id }) { return { plans: mockClaimPlans(id), activated: false, activation_error: null }; },

  async claim_start({ id }) {
    const acc = mockAccounts().find((a) => a.id === id);
    const plan = mockClaimPlans(id)[0];
    setTimeout(() => {
      if (plan) applyClaimedGift(id);
      emit("claim://result", {
        ok: true, accountId: id, accountName: acc?.name || id,
        planName: plan?.name || "Start Plan", serverTime: Date.now(),
      });
    }, 1600);
    return null;
  },
  async claim_cancel() { return null; },
  async claim_captcha_config() { return { required: false }; },
  async captcha_submit() { return { ok: true }; },

  async switch_to({ id }) {
    const acc = mockAccounts().find((a) => a.id === id);
    if (acc) {
      mockState.active_account_id = id;
      mockState.live_logged_in = true;
      for (const a of mockAccounts()) a.is_active = a.id === id;
    }
    await delay(400);
    return { switched: true, already_active: false, name: acc?.name || id, preserved_as: null, killed: false, launched: true, hot: false, config_stale: false };
  },

  async rename_account({ id, name }) {
    const acc = mockAccounts().find((a) => a.id === id);
    if (acc) acc.name = name;
    return { name };
  },

  async delete_account({ id }) {
    const i = mockAccounts().findIndex((a) => a.id === id);
    if (i >= 0) mockAccounts().splice(i, 1);
    if (mockState.active_account_id === id) { mockState.active_account_id = null; mockState.live_logged_in = false; }
    return null;
  },

  async update_account_from_live({ id }) {
    const acc = mockAccounts().find((a) => a.id === id);
    return { name: acc?.name || id };
  },

  // set_behavior 的参数都是可选字段：把驼峰参数映射回 state 的 snake_case
  async set_behavior(patch = {}) {
    const map = {
      grouped: "grouped", launchAfterSwitch: "launch_after_switch", closeToTray: "close_to_tray",
      hotSwitch: "hot_switch", oauthBrowser: "oauth_browser",
      autoSwitch: "auto_switch", autoClaim: "auto_claim",
      autoSwitchThreshold: "auto_switch_threshold", autoSwitchModel: "auto_switch_model",
      autoSwitchGiftFirst: "auto_switch_gift_first", autoSwitchGiftOrder: "auto_switch_gift_order",
      autoSwitchModelFallback: "auto_switch_model_fallback",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k in map) mockState[map[k]] = v;
    }
    return null;
  },

  async set_language({ lang }) { mockState.language = lang === "en" ? "en" : "zh"; return null; },
  async set_auth_proxy({ on, url }) { mockState.auth_proxy_on = !!on; mockState.auth_proxy_url = url ?? mockState.auth_proxy_url; return null; },
  async set_zcode_path() { return null; },
  async pick_zcode_path() { return { picked: false, path: "" }; },

  async autostart_status() { return autostartOn; },
  async autostart_set({ enable }) { autostartOn = !!enable; return autostartOn; },

  async capture_current() {
    const name = `捕获-${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    mockAccounts().unshift({
      id: `acct-new-${Date.now()}`, name, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      is_active: false, has_config: true, has_user_info: true,
      identity: { provider: "zai", username: name, display_name: null, email: null, user_id: `u-${name}` }, group: null,
    });
    return { id: mockAccounts()[0].id, name };
  },

  async oauth_providers() { return [{ id: "zai", display: "z.ai" }, { id: "bigmodel", display: "BigModel 智谱" }]; },
  async oauth_begin() { return { browser: true }; },

  async account_api_key({ id }) {
    await delay(300);
    const acc = mockAccounts().find((a) => a.id === id);
    return { apiKey: fakeKey(id), label: "GLM-5.3-Flash", provider: "zai", kind: "api" };
  },
  async all_account_api_keys() {
    return mockAccounts().map((a) => ({ id: a.id, name: a.name, apiKey: fakeKey(a.id), hasKey: true, kind: "api" }));
  },

  async export_pick_path({ id }) {
    const acc = mockAccounts().find((a) => a.id === id);
    return { picked: true, path: `C:\\Users\\demo\\Downloads\\${acc?.name || id}.zsw.json`, name: acc?.name || id };
  },
  async export_all_pick_path() { return { picked: true, path: "C:\\Users\\demo\\Downloads\\zcode-accounts.zsw.json", count: mockAccounts().length }; },
  async export_finalize({ path }) { return { path, count: 1 }; },
  async export_all_finalize({ path }) { return { path, count: mockAccounts().length }; },
  async import_pick_files() { return { picked: false, sealed: [], plainCount: 0, errors: [] }; },
  async import_sealed() { return { added: [], skipped: [], errors: [] }; },

  async usage_stats() { await delay(200); return mockUsage(); },

  async two_api_status() {
    twoStats.last_request_at = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 120);
    twoStats.requests += Math.random() < 0.3 ? 1 : 0;
    return { running: mockState.two_api_on, port: mockState.two_api_port, ...twoStats, usage: mockTwoUsage() };
  },
  async set_two_api({ on }) { mockState.two_api_on = !!on; return null; },
  async regen_two_api_token() { mockState.two_api_token = `zsw-mock-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`; return null; },
  async two_api_test() { await delay(500); return { ok: true, localOk: true, localMs: 12, e2eOk: true, e2eMs: 233 }; },

  async live_signals() {
    const at = Date.now() - 20_000;
    const prevAt = Date.now() - 35_000;
    const pools = [
      { name: "GLM-5.3-Flash", total: 120_000_000, used: 80_300_000, remaining: 39_700_000, percent_used: 66.9, entitlement_id: "ent-1", expires_at: null },
      { name: "GLM-5.3-Flash", total: 12_000_000, used: 7_200_000, remaining: 4_800_000, percent_used: 60, entitlement_id: "gift-weekend-1", expires_at: Math.floor(Date.now() / 1000) + 2 * 86_400 },
    ];
    return {
      available: true, log_path: "C:\\Users\\demo\\.zcode\\cli\\logs\\session.log", log_at_ms: Date.now() - 8_000,
      pools, pools_at_ms: at, prev_pools: pools.map((p) => ({ ...p, remaining: p.remaining + 900_000 })), prev_at_ms: prevAt,
      plan_available: true, plan_at_ms: at, model: "GLM-5.3-Flash", model_at_ms: at, provider: "zai",
      last_request_at_ms: Date.now() - 4_000, last_applied_at_ms: null, requests: 233, parse_errors: 0,
    };
  },

  async auto_switch_log() { return null; },
  async open_external({ url }) { window.open(url, "_blank"); return null; },
  async kill_zcode() { mockState.zcode_running = false; return null; },
  async launch_zcode() { mockState.zcode_running = true; return null; },
};

// —— Tauri IPC 表面 ——

// event.js 的 listen/once：transformCallback 登记回调，invoke('plugin:event|listen') 返回事件 id
window.__TAURI_INTERNALS__ = {
  transformCallback(cb, once = false) {
    const id = cbSeq++;
    callbacks.set(id, { cb, once });
    return id;
  },
  async invoke(cmd, args = {}) {
    // 事件插件协议：登记/注销监听
    if (cmd === "plugin:event|listen") {
      const entry = callbacks.get(args.handler);
      if (entry) {
        if (!handlers.has(args.event)) handlers.set(args.event, new Set());
        handlers.get(args.event).add(entry.cb);
      }
      return cbSeq++; // eventId
    }
    if (cmd === "plugin:event|unlisten") {
      // event.js 只给了 eventId，这里按引用清不干净也无妨（预览环境常驻）
      return null;
    }
    const fn = commands[cmd];
    if (!fn) {
      console.warn(`[mock] 未实现的命令: ${cmd}`, args);
      return null;
    }
    return fn(args);
  },
};

// event.js _unlisten 会先调这个
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener() { /* 预览环境：监听常驻即可 */ },
};

// 预览标识：主界面右上角显示 PREVIEW 徽标；预置一个默认冻结号让停靠分组可见
window.__ZSW_MOCK__ = true;
window.__MOCK_EMIT__ = emit;
try {
  if (!localStorage.getItem("zsw-frozen-ids")) localStorage.setItem("zsw-frozen-ids", JSON.stringify(["acct-15"]));
  localStorage.removeItem("zsw-quota-cache-v1");
} catch { /* 隐私模式等场景忽略 */ }

console.info("[mock] Tauri IPC 垫片已就绪（纯浏览器预览模式）");
