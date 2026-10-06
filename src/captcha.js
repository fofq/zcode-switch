
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { init, t, lang, stripErr } from "./i18n.js";

const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const TRACELESS_TIMEOUT = 8000;

const $text = document.getElementById("cap-text");
const $detail = document.getElementById("cap-detail");
const $dot = document.getElementById("cap-dot");
const $btn = document.getElementById("cap-btn");

function status(text, tone = "run") {
  $text.textContent = text;
  $dot.className = "cap-dot" + (tone === "ok" ? " ok" : tone === "err" ? " err" : "");
}

function detail(text) {
  $detail.textContent = text || "";
}

document.addEventListener("securitypolicyviolation", (e) => {
  detail(t("c.cspBlocked", { directive: e.violatedDirective, uri: String(e.blockedURI).slice(0, 70) }));
});

const notifyStuck = () => {
  emit("captcha://interactive").catch(() => {});
  // 窗口可能以隐藏形态起步（手动领取/2API 网关兜底）：无感失败需要人工介入时
  // 请求后端真正弹窗（后端按「自动轮」门控，自动轮静默忽略）；失败静默
  invoke("captcha_show").catch(() => {});
};

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (typeof window.initAliyunCaptcha === "function") return resolve();
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(t("c.sdkFail")));
    document.head.appendChild(s);
  });
}

let submitted = false;
let region = null;
let tracelessTimer = 0;

async function run() {
  try {
    const st = await invoke("get_state");
    if (st?.language) init(st.language);
  } catch { }
  document.title = t("c.title");
  $btn.textContent = t("c.btn");
  document.querySelector(".cap-foot").textContent = t("c.foot");
  status(t("c.preparing"));

  let cfg;
  try {
    cfg = await invoke("claim_captcha_config");
  } catch (e) {
    notifyStuck();
    status(t("c.cfgFail"), "err");
    detail(stripErr(e));
    return;
  }
  if (!cfg.enabled || !cfg.scene_id) {
    notifyStuck();
    status(t("c.cfgUnavailable"), "err");
    detail(t("c.cfgUnavailableDetail"));
    return;
  }
  region = cfg.region || null;
  try {
    await loadSdk();
  } catch (e) {
    notifyStuck();
    status(e.message || t("c.sdkFail"), "err");
    return;
  }

  window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };

  status(t("c.traceless"));

  const submit = async (param) => {
    if (submitted || !param || !param.trim()) return;
    submitted = true;
    clearTimeout(tracelessTimer);
    status(t("c.passed"));
    // 统一路由：有待领奖 → 页内直发 claim（验证码通过的真实 Chromium 传输直接过
    // WAF；ureq 的传输指纹已被上游机器级封锁 405）；否则 → 2API 套餐路由的验证码桥接
    let ctx = null;
    try { ctx = await invoke("claim_context"); } catch { ctx = null; }
    if (ctx?.planId && ctx.jwt) {
      let result;
      try {
        const uuid = crypto.randomUUID
          ? crypto.randomUUID()
          : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
              const r = (Math.random() * 16) | 0;
              return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
            });
        const resp = await fetch("https://zcode.z.ai/api/v1/zcode-plan/billing/claim", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer " + ctx.jwt,
            "x-device-mid": ctx.mid,
            "x-request-id": uuid,
            "x-aliyun-captcha-verify-param": param,
            ...(region ? { "x-aliyun-captcha-verify-region": region } : {}),
          },
          body: JSON.stringify({ plan_id: ctx.planId }),
        });
        const body = await resp.text();
        result = { status: resp.status, body };
      } catch (e) {
        // 页内 fetch 抛错（断网/CSP 拦截等）：status 0 = 传输层失败，后端按 code:-1 落账
        result = { status: 0, body: String(e) };
      }
      invoke("claim_result", result).catch(() => {});
      return;
    }
    invoke("captcha_submit", { param, region }).catch((e) => {
      status(t("c.claimReqFail"), "err");
      detail(stripErr(e));
    });
  };

  const interactive = (why) => {
    notifyStuck();
    clearTimeout(tracelessTimer);
    status(t("c.interactive"));
    $btn.hidden = false;
    $btn.focus();
    if (why) detail(typeof why === "string" ? why.slice(0, 120) : JSON.stringify(why).slice(0, 120));
  };

  try {
    window.initAliyunCaptcha({
      SceneId: cfg.scene_id,
      mode: "popup",
      language: lang() === "en" ? "en" : "zh-CN",
      showErrorTip: false,
      element: "#cap-holder",
      button: "#cap-btn",
      getInstance: (instance) => {
        if (typeof instance.startTracelessVerification === "function") {
          instance.startTracelessVerification();
          tracelessTimer = setTimeout(interactive, TRACELESS_TIMEOUT);
        } else {
          interactive();
        }
      },
      success: (param) => submit(typeof param === "string" ? param : param?.captchaVerifyParam),
      fail: (p) => interactive(p),
      onError: (p) => interactive(p),
    });
  } catch (e) {
    notifyStuck();
    status(t("c.initFail"), "err");
    detail(String(e));
  }
}

$btn.addEventListener("click", () => {
  if (!$btn.hidden) status(t("c.inPopup"));
});

run();
